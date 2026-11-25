// Translates the visible dialogue text of an ASS/SSA file while keeping its
// styling: override blocks, drawings, and every byte before the Text field stay
// as they are, and only the text runs of Dialogue events are sent.

export interface AssUnit {
  start: number;
  end: number;
  // Sent text: '\n' for a line break, <i>…</i>-style toggles and <xN/> for kept blocks.
  text: string;
}

export interface Marker {
  token: string;
  raw: string;
}

export interface TextParts {
  // Kept verbatim around the translated text.
  prefix: string;
  suffix: string;
  // The same without style toggles, for a line whose inner styling is dropped.
  barePrefix: string;
  bareSuffix: string;
  markers: Marker[];
}

interface AssEvent extends TextParts {
  line: number;
  head: string;
  // Line-internal styling dropped up front (heavy typesetting).
  flattened: boolean;
  start: number;
  end: number;
}

// More line-internal blocks than this are typesetting, sent as plain text.
const MAX_MARKERS = 4;
const TOGGLES: Record<string, [string, string]> = {
  i: ['<i>', '</i>'],
  b: ['<b>', '</b>'],
  u: ['<u>', '</u>'],
  s: ['<s>', '</s>'],
};
const MARKER = /<\/?[ibus]>|<x\d+\/>/g;
const LEFTOVER_MARKER = /<\s*\/?\s*(?:[ibus]|x\d*)\s*\/?\s*>/gi;
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

type Piece = { kind: 'text' | 'block' | 'drawing'; raw: string };

// Text runs, override blocks, and drawing runs (\p1 until \p0, as libass draws them).
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let drawing = false;
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    const close = open < 0 ? -1 : text.indexOf('}', open);
    const end = close < 0 ? text.length : open;
    if (end > at) out.push({ kind: drawing ? 'drawing' : 'text', raw: text.slice(at, end) });
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
  const [on, off] = TOGGLES[inner[1]];
  return inner[2] === '1' ? on : off;
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
  const out = RESET.test(raw) ? Object.keys(TOGGLES).map(letter => `${letter}0`) : [];
  STYLE_TAG.lastIndex = 0;
  for (let match = STYLE_TAG.exec(raw); match; match = STYLE_TAG.exec(raw)) out.push(styleState(match[1], match[2]));
  return out;
}

function pieceToggle(piece: Piece | undefined): string | null {
  return piece?.kind === 'block' ? toggle(piece.raw) : null;
}

function opposite(token: string): string {
  return token[1] === '/' ? `<${token.slice(2)}` : `</${token.slice(1)}`;
}

function joined(list: readonly Piece[]): string {
  return list.map(piece => piece.raw).join('');
}

function letterOf(token: string): string {
  return token.replace(/[</>]/g, '');
}

// Each style's toggles in order, so an opening marker must still come before its closing one.
function toggleOrder(tokens: readonly string[]): string {
  return Object.keys(TOGGLES).map(letter => tokens.filter(token => token.replace('/', '') === `<${letter}>`).join('')).join('|');
}

// Model text can never open an override block or an escape.
function clean(text: string): string {
  return text.replace(LEFTOVER_MARKER, '').replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
}

export interface Reassembled {
  text: string;
  dropped: boolean;
}

/** The Text field for a translation, with each marker back as its block; markers that don't add up drop the styling. */
export function reassemble(parts: TextParts, translated: string): Reassembled {
  const { markers } = parts;
  const want = new Map<string, string[]>();
  markers.forEach((marker) => {
    const list = want.get(marker.token) ?? [];
    list.push(marker.raw);
    want.set(marker.token, list);
  });
  const found = translated.match(MARKER) ?? [];
  const counts = new Map<string, number>();
  found.forEach(token => counts.set(token, (counts.get(token) ?? 0) + 1));
  let valid = found.length === markers.length
    && toggleOrder(found) === toggleOrder(markers.map(marker => marker.token));
  want.forEach((list, token) => { if (counts.get(token) !== list.length) valid = false; });
  if (!valid) {
    if (!markers.length) return { text: parts.prefix + clean(translated) + parts.suffix, dropped: false };
    return { text: parts.barePrefix + clean(translated) + parts.bareSuffix, dropped: true };
  }
  const used = new Map<string, number>();
  const split = translated.split(MARKER);
  let body = clean(split[0]);
  found.forEach((token, k) => {
    const n = used.get(token) ?? 0;
    used.set(token, n + 1);
    body += want.get(token)![n] + clean(split[k + 1]);
  });
  return { text: parts.prefix + body + parts.suffix, dropped: false };
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
    const list = pieces(text);
    let first = -1;
    let last = -1;
    list.forEach((piece, k) => {
      if (piece.kind === 'text' && visible(piece.raw)) {
        if (first < 0) first = k;
        last = k;
      }
    });
    if (first < 0) return null;
    const hardSoftBreaks = /\\q2/.test(text);
    const before = list.slice(0, first);
    const after = list.slice(last + 1);
    const middle = list.slice(first, last + 1);
    const lead = EDGE_START.exec(middle[0].raw)?.[0] ?? '';
    middle[0] = { kind: 'text', raw: middle[0].raw.slice(lead.length) };
    const tailPiece = middle[middle.length - 1];
    const trail = EDGE_END.exec(tailPiece.raw)?.[0] ?? '';
    middle[middle.length - 1] = { kind: 'text', raw: tailPiece.raw.slice(0, tailPiece.raw.length - trail.length) };
    // A toggle at the text's edge whose other half is inside the line travels with it.
    const inner = middle.map(pieceToggle);
    // One facing the other way stays where it is.
    const opening = pieceToggle(before[before.length - 1]);
    if (!lead && opening && opening[1] !== '/' && inner.indexOf(opposite(opening)) >= 0) middle.unshift(before.pop()!);
    const closing = pieceToggle(after[0]);
    if (!trail && closing && closing[1] === '/' && inner.indexOf(opposite(closing)) >= 0) middle.push(after.shift()!);
    // Consecutive blocks and drawings between text runs travel as one marker.
    const runs: Array<{ text: string } | { raw: string; drawing: boolean }> = [];
    middle.forEach((piece) => {
      const prev = runs[runs.length - 1];
      if (piece.kind === 'text') runs.push({ text: piece.raw });
      else if (prev && 'raw' in prev) {
        prev.raw += piece.raw;
        prev.drawing = prev.drawing || piece.kind === 'drawing';
      } else runs.push({ raw: piece.raw, drawing: piece.kind === 'drawing' });
    });
    const keptBlocks = runs.filter(run => 'raw' in run).length;
    const flattened = keptBlocks > MAX_MARKERS;
    // Only a toggle with its other half in the line reads as <i>…</i>; a lone one is a kept block.
    const toggles = runs.map(run => ('raw' in run && !flattened ? toggle(run.raw) : null));
    const paired = new Set<number>();
    const open = new Map<string, number>();
    toggles.forEach((token, k) => {
      if (!token) return;
      const letter = letterOf(token);
      if (token[1] !== '/') open.set(letter, k);
      else if (open.has(letter)) {
        paired.add(open.get(letter)!).add(k);
        open.delete(letter);
      }
    });
    const markers: Marker[] = [];
    let sent = '';
    let generic = 0;
    runs.forEach((run, k) => {
      if ('text' in run) {
        sent += sendable(run.text, hardSoftBreaks);
        return;
      }
      // Heavy typesetting keeps only its drawings.
      if (flattened && !run.drawing) return;
      const token = paired.has(k) ? toggles[k]! : `<x${++generic}/>`;
      markers.push({ token, raw: run.raw });
      sent += token;
    });
    // Dropping the inner styling also drops an edge toggle turned on whose other half was
    // inside, even from a block that sets more than the toggle; one turned off stays.
    const innerStates = new Set<string>();
    middle.forEach((piece) => { if (piece.kind === 'block') styleStates(piece.raw).forEach(state => innerStates.add(state)); });
    const bare = (list: readonly Piece[]): string => list.map((piece) => {
      if (piece.kind !== 'block') return piece.raw;
      const kept = piece.raw.replace(STYLE_TAG, (tag: string, letter: string, value: string) =>
        styleState(letter, value) === `${letter}1` && innerStates.has(`${letter}0`) ? '' : tag);
      return kept === '{}' && piece.raw !== '{}' ? '' : kept;
    }).join('');
    const barePrefix = bare(before) + lead;
    const bareSuffix = trail + bare(after);
    const event: AssEvent = {
      line,
      head,
      prefix: flattened ? barePrefix : joined(before) + lead,
      suffix: flattened ? bareSuffix : trail + joined(after),
      barePrefix,
      bareSuffix,
      markers,
      flattened,
      start,
      end,
    };
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
