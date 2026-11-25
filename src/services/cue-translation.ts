// Splits SRT/WebVTT cue text for translation: only the words are sent, with
// <i>/<b>/<u> paired inside the cue as such and any other markup between them
// ({\an8}, <font>, <c.…>, <v …>, <lang>, inline timestamps) as <xN/>.
// Markup at the cue's edges never leaves the device; ruby readings are left out.

import type { VttCue } from '../utils/webvtt';
import { LEFTOVER_MARKER, reassemble, splitText, type Dialect, type Piece, type TextParts } from './subtitle-markers';
import type { TranslationCue } from './subtitle-translation';

// A WebVTT tag or inline timestamp, or an SRT {\…} override block.
const MARKUP = /<\/?(?:[a-zA-Z][^<>]*|\d[\d:.]*)>|\{\\[^{}]*\}/g;
// Ruby readings describe the source words, so a translation leaves them out.
const RUBY_TEXT = /<rt(?:[.\s][^<>]*)?>[\s\S]*?(?:<\/rt>|(?=<\/ruby>)|$)/gi;
const RUBY_TAG = /<\/?(?:ruby|rt)(?:[.\s][^<>]*)?>/gi;
const PLAIN = /^[^<{&]*$/;
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;
// Without a DOM (unit tests in Node), the entities subtitles use most.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f',
};
const named = new Map<string, string>();

// Any HTML named entity, as the WebVTT parser reads it.
function namedEntity(entity: string, name: string): string {
  let value = named.get(entity);
  if (value === undefined) {
    value = typeof DOMParser === 'function'
      ? new DOMParser().parseFromString(entity, 'text/html').documentElement.textContent ?? entity
      : ENTITIES[name] ?? entity;
    named.set(entity, value);
  }
  return value;
}

function decode(raw: string): string {
  return raw.replace(ENTITY, (entity: string, name: string) => {
    if (name[0] !== '#') return namedEntity(entity, name);
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  MARKUP.lastIndex = 0;
  for (let match = MARKUP.exec(text); match; match = MARKUP.exec(text)) {
    if (match.index > at) out.push({ kind: 'text', raw: text.slice(at, match.index) });
    out.push({ kind: 'block', raw: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', raw: text.slice(at) });
  return out;
}

// 'c' for <c.yellow>, '/v' for </v>; '' for a timestamp or a {\…} block.
function tagName(raw: string): string {
  const tag = /^<(\/?)([a-zA-Z][^\s.>]*)/.exec(raw);
  return tag ? tag[1] + tag[2].toLowerCase() : '';
}

// Pairs tags as the WebVTT parser does: an end tag closes the open tag on top
// when the names match and is ignored otherwise. Returns each paired tag's
// partner and how many tags are left unpaired.
function pairTags<T>(tags: readonly T[], nameOf: (tag: T) => string): { partner: Map<T, T>; unpaired: number } {
  const partner = new Map<T, T>();
  const open: Array<{ tag: T; name: string }> = [];
  let unpaired = 0;
  tags.forEach((tag) => {
    const name = nameOf(tag);
    if (!name) return;
    if (name[0] !== '/') open.push({ tag, name });
    else if (open.length && open[open.length - 1].name === name.slice(1)) {
      const top = open.pop()!;
      partner.set(top.tag, tag).set(tag, top.tag);
    } else unpaired++;
  });
  return { partner, unpaired: unpaired + open.length };
}

function unpairedIn(text: string): number {
  return pairTags(text.match(MARKUP) ?? [], tagName).unpaired;
}

function toggle(raw: string): string | null {
  const tag = /^<(\/?)([ibu])>$/i.exec(raw);
  return tag ? `<${tag[1]}${tag[2].toLowerCase()}>` : null;
}

// Dropping the inner markup also drops each edge tag whose partner was inside, so no tag is left open.
function bare(edge: readonly Piece[], middle: readonly Piece[], all: readonly Piece[]): string {
  const { partner } = pairTags(all.filter(piece => piece.kind === 'block'), piece => tagName(piece.raw));
  return edge.filter((piece) => {
    const other = partner.get(piece);
    return !other || middle.indexOf(other) < 0;
  }).map(piece => piece.raw).join('');
}

// Model text is plain words, escaped so it can never open a tag or an entity.
function clean(text: string): string {
  return text.replace(LEFTOVER_MARKER, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DIALECT: Dialect = {
  edgeStart: /^\s+/,
  edgeEnd: /\s+$/,
  visible: raw => decode(raw).trim() !== '',
  sendable: decode,
  toggle,
  bare,
  clean,
  // Cues color word by word more often than ASS lines do.
  maxMarkers: 8,
};

const PLAIN_PARTS: TextParts = { prefix: '', suffix: '', barePrefix: '', bareSuffix: '', markers: [] };

/** The cues of one SRT/WebVTT file as sent for translation, and their translated cue text. */
export class CueTranslationDoc {
  // Same timings; text is what is sent, '' for a cue with nothing to translate.
  readonly units: TranslationCue[];
  tagsDropped = 0;
  // null for a cue sent as it is.
  private parts: Array<TextParts | null>;
  private flattened: boolean[];
  private unpaired: number[] = [];
  private counted = new Set<number>();

  constructor(cues: readonly VttCue[]) {
    this.parts = [];
    this.flattened = [];
    this.units = cues.map((cue) => {
      // A cue without markup or entities goes out byte for byte as before, so its cached batch still matches.
      if (PLAIN.test(cue.text)) {
        this.parts.push(null);
        this.flattened.push(false);
        this.unpaired.push(0);
        return { start: cue.start, end: cue.end, text: cue.text };
      }
      const text = cue.text.replace(RUBY_TEXT, '').replace(RUBY_TAG, '');
      const split = splitText(pieces(text), DIALECT);
      this.parts.push(split);
      this.flattened.push(!!split?.flattened);
      this.unpaired.push(split ? unpairedIn(text) : 0);
      // Batches are planned on the cue as it was, so plain batches after it keep their cache.
      return { start: cue.start, end: cue.end, text: split ? split.sent : '', original: cue.text };
    });
  }

  /** The cue text for each translated unit. */
  texts(indices: readonly number[], translated: readonly string[]): string[] {
    return indices.map((index, k) => {
      // Markers the reply reordered must not open or close a tag the cue had paired.
      const result = reassemble(this.parts[index] ?? PLAIN_PARTS, translated[k], clean,
        text => unpairedIn(text) <= this.unpaired[index]);
      if (!this.counted.has(index) && (result.dropped || this.flattened[index])) {
        this.counted.add(index);
        this.tagsDropped++;
      }
      return result.text;
    });
  }
}
