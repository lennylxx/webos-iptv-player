// Translates the visible dialogue text of an ASS/SSA file while keeping its
// styling: override blocks, drawings, and every byte before the Text field stay
// as they are, and only the text runs of Dialogue events are sent.

import {
  LEFTOVER_MARKER,
  reassemble as reassembleWith,
  splitText,
  TOGGLE_LETTERS,
  type Dialect,
  type Piece,
  type Reassembled,
  type TextParts,
} from './subtitle-markers';

export type { Marker, TextParts } from './subtitle-markers';

export interface AssUnit {
  start: number;
  end: number;
  // Sent text: '\n' for a line break, <i>…</i>-style toggles and <xN/> for kept blocks.
  text: string;
}

interface AssEvent extends TextParts {
  line: number;
  head: string;
  flattened: boolean;
  start: number;
  end: number;
}

const KARAOKE = /\\(?:k[fot]?|K)\d/;
const DRAWING = /\\p(\d+(?:\.\d+)?)/g;
// Whitespace, \h, and line breaks around the text stay where they are.
const EDGE_START = /^(?:\s|\\[Nnh])+/;
const EDGE_END = /(?:\s|\\[Nnh])+$/;
// The sections assjs reads; it skips the rest ([Fonts], [Graphics], …), so a rebuild leaves them out.
const DRAWN_SECTION = /^\[(?:script info|v4\+? styles|events)\]$/i;

function parseTime(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length !== 3) return NaN;
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

// The 'Text' field's start: past as many commas as the fields before it.
function splitFields(body: string, count: number): string[] | null {
  const fields: string[] = [];
  let from = 0;
  for (let i = 0; i < count - 1; i++) {
    const comma = body.indexOf(',', from);
    if (comma < 0) return null;
    fields.push(body.slice(from, comma));
    from = comma + 1;
  }
  fields.push(body.slice(from));
  return fields;
}

// Text runs, override blocks, and drawing runs (\p1 until \p0, as libass draws them), kept unsent.
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let drawing = false;
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    const close = open < 0 ? -1 : text.indexOf('}', open);
    const end = close < 0 ? text.length : open;
    if (end > at) out.push({ kind: drawing ? 'kept' : 'text', raw: text.slice(at, end) });
    if (close < 0) break;
    const block = text.slice(open, close + 1);
    out.push({ kind: 'block', raw: block });
    DRAWING.lastIndex = 0;
    for (let match = DRAWING.exec(block); match; match = DRAWING.exec(block)) drawing = Number(match[1]) > 0;
    at = close + 1;
  }
  return out;
}

function visible(raw: string): boolean {
  return raw.replace(/\\[Nnh]/g, '').trim() !== '';
}

function sendable(raw: string, hardSoftBreaks: boolean): string {
  return raw
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, hardSoftBreaks ? '\n' : ' ')
    .replace(/\\h/g, ' ');
}

// A block that only toggles italic, bold, underline, or strikeout reads as HTML.
function toggle(raw: string): string | null {
  const inner = /^\{\\([ibus])([01]?)\}$/.exec(raw);
  if (!inner) return null;
  return inner[2] === '1' ? `<${inner[1]}>` : `</${inner[1]}>`;
}

// \i1, \b700, \u0, \s (back to the style), but not \iclip, \bord, \be, or \shad.
const STYLE_TAG = /\\([ibus])(\d*)(?=[\\}])/g;

// \r or \rStyle resets every style, but \rnd is another tag.
const RESET = /\\r(?!nd)/;

// 'i1' for on, 'i0' for off or back to the style.
// \b also takes a font weight, bold from 700.
function styleState(letter: string, value: string): string {
  const on = value === '1' || (letter === 'b' && Number(value) >= 700);
  return letter + (on ? '1' : '0');
}

function styleStates(raw: string): string[] {
  const out = RESET.test(raw) ? TOGGLE_LETTERS.map(letter => `${letter}0`) : [];
  STYLE_TAG.lastIndex = 0;
  for (let match = STYLE_TAG.exec(raw); match; match = STYLE_TAG.exec(raw)) out.push(styleState(match[1], match[2]));
  return out;
}

// Model text can never open an override block or an escape.
function clean(text: string): string {
  return text.replace(LEFTOVER_MARKER, '').replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
}

// Dropping the inner styling also drops an edge toggle turned on whose other half was
// inside, even from a block that sets more than the toggle; one turned off stays.
function bare(edge: readonly Piece[], middle: readonly Piece[]): string {
  const innerStates = new Set<string>();
  middle.forEach((piece) => { if (piece.kind === 'block') styleStates(piece.raw).forEach(state => innerStates.add(state)); });
  return edge.map((piece) => {
    if (piece.kind !== 'block') return piece.raw;
    const kept = piece.raw.replace(STYLE_TAG, (tag: string, letter: string, value: string) =>
      styleState(letter, value) === `${letter}1` && innerStates.has(`${letter}0`) ? '' : tag);
    return kept === '{}' && piece.raw !== '{}' ? '' : kept;
  }).join('');
}

const ASS_DIALECT: Omit<Dialect, 'sendable'> = {
  edgeStart: EDGE_START,
  edgeEnd: EDGE_END,
  visible,
  toggle,
  bare,
  clean,
  maxMarkers: 4,
};

/** The Text field for a translation, with each marker back as its block; markers that don't add up drop the styling. */
export function reassemble(parts: TextParts, translated: string): Reassembled {
  return reassembleWith(parts, translated, clean);
}

/**
 * One ASS/SSA file split into translation units: the distinct visible texts of
 * its Dialogue events, in time order. Translations are applied per unit, so
 * stacked layers and repeated signs read the same.
 */
export class AssTranslationDoc {
  units: AssUnit[] = [];
  skipped = 0;
  tagsDropped = 0;
  // The lines assjs reads, kept verbatim unless an event's text changes.
  private lines: string[] = [];
  private events: AssEvent[] = [];
  private out = new Map<number, string>();
  private byUnit: number[][] = [];

  private constructor() {}

  /** Null when the file has no Dialogue text to translate. */
  static parse(content: string): AssTranslationDoc | null {
    const doc = new AssTranslationDoc();
    return doc.read(content.split('\n')) ? doc : null;
  }

  /** A doc over the same parse with no translations applied yet. */
  fork(): AssTranslationDoc {
    const doc = new AssTranslationDoc();
    doc.units = this.units;
    doc.skipped = this.skipped;
    doc.lines = this.lines;
    doc.events = this.events;
    doc.byUnit = this.byUnit;
    return doc;
  }

  private read(source: readonly string[]): boolean {
    let inEvents = false;
    let drawn = true;
    let format: string[] | null = null;
    const byText = new Map<string, number>();
    for (let i = 0; i < source.length; i++) {
      const line = source[i].replace(/\r$/, '');
      const trimmed = line.replace(/^\uFEFF/, '').trim();
      if (/^\[.*\]$/.test(trimmed)) {
        drawn = DRAWN_SECTION.test(trimmed);
        inEvents = /^\[events\]$/i.test(trimmed);
      }
      if (!drawn) continue;
      this.lines.push(source[i]);
      if (!inEvents) continue;
      const fmt = /^format\s*:(.*)$/i.exec(trimmed);
      if (fmt) {
        format = fmt[1].split(',').map(field => field.trim().toLowerCase());
        continue;
      }
      const dialogue = /^(\s*dialogue\s*:\s*)(.*)$/i.exec(line);
      if (!dialogue || !format) continue;
      const fields = splitFields(dialogue[2], format.length);
      if (!fields || format[format.length - 1] !== 'text') continue;
      const text = fields[fields.length - 1];
      const head = line.slice(0, line.length - text.length);
      const start = parseTime(fields[format.indexOf('start')] ?? '');
      const end = parseTime(fields[format.indexOf('end')] ?? '');
      const split = start < end ? this.event(this.lines.length - 1, head, text, start, end) : null;
      if (!split) {
        this.skipped++;
        continue;
      }
      const { event, sent: key } = split;
      let unit = byText.get(key);
      if (unit === undefined) {
        unit = this.units.length;
        byText.set(key, unit);
        this.units.push({ start, end, text: key });
        this.byUnit.push([]);
      } else if (start < this.units[unit].start) {
        // A repeated line batches by its earliest showing; redraws check each event.
        this.units[unit].start = start;
        this.units[unit].end = end;
      }
      this.byUnit[unit].push(this.events.length);
      this.events.push(event);
    }
    // Typeset signs often sit apart from the dialogue; batches go in time order.
    const order = this.units.map((_, k) => k).sort((a, b) => this.units[a].start - this.units[b].start || a - b);
    this.units = order.map(k => this.units[k]);
    this.byUnit = order.map(k => this.byUnit[k]);
    return format !== null && this.units.length > 0;
  }

  // Splits a Text field into what stays and what is sent; null skips the event.
  private event(line: number, head: string, text: string, start: number, end: number): { event: AssEvent; sent: string } | null {
    if (KARAOKE.test(text)) return null;
    const hardSoftBreaks = /\\q2/.test(text);
    const split = splitText(pieces(text), { ...ASS_DIALECT, sendable: raw => sendable(raw, hardSoftBreaks) });
    if (!split) return null;
    const { sent, ...parts } = split;
    const event: AssEvent = { line, head, ...parts, start, end };
    return { event, sent };
  }

  /** Records the translations of these units for the next build. */
  apply(unitIndices: readonly number[], texts: readonly string[]): void {
    unitIndices.forEach((unit, k) => {
      const events = this.byUnit[unit];
      if (!events) return;
      events.forEach((index) => {
        const event = this.events[index];
        const result = reassemble(event, texts[k]);
        if (!this.out.has(index) && (result.dropped || event.flattened)) this.tagsDropped++;
        this.out.set(index, event.head + result.text);
      });
    });
  }

  /** Whether any event of these units shows within [from, to] seconds. */
  touches(unitIndices: readonly number[], from: number, to: number): boolean {
    return unitIndices.some(unit => (this.byUnit[unit] ?? []).some((index) => {
      const event = this.events[index];
      return event.start <= to && event.end >= from;
    }));
  }

  /** The file assjs draws, with every translated Text field in place; all else as it was. */
  build(): string {
    if (!this.out.size) return this.lines.join('\n');
    const lines = this.lines.slice();
    this.out.forEach((text, index) => {
      const line = this.events[index].line;
      lines[line] = /\r$/.test(lines[line]) ? `${text}\r` : text;
    });
    return lines.join('\n');
  }
}

// A redraw rebuilds the whole assjs instance (150–250 ms for 10k events in
// the Chromium 53 simulation), so translated batches are drawn soon only when
// they show near the playback position.
const NEAR_REDRAW_MS = 1000;
const FAR_REDRAW_MS = 60000;

export class RedrawThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private pending = false;
  private last = 0;

  constructor(private redraw: () => void) {}

  changed(near: boolean): void {
    this.pending = true;
    const now = Date.now();
    const wait = near ? NEAR_REDRAW_MS : Math.max(NEAR_REDRAW_MS, this.last + FAR_REDRAW_MS - now);
    if (this.timer && this.due <= now + wait) return;
    this.clear();
    this.due = now + wait;
    this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    this.clear();
    if (!this.pending) return;
    this.pending = false;
    this.last = Date.now();
    this.redraw();
  }

  cancel(): void {
    this.clear();
    this.pending = false;
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
