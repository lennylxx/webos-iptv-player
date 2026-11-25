// Splits a subtitle's text into the words sent to the model and the markup kept
// around them, and puts a translation back together. Shared by ASS/SSA and
// SRT/WebVTT: an <i>/<b>/<u>/<s> toggle paired inside the line is sent as such,
// other markup between the words as <x1/>, <x2/>, …, and markup at the edges
// never leaves the device.

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

export interface SplitText extends TextParts {
  sent: string;
  // Line-internal styling dropped up front (heavy typesetting).
  flattened: boolean;
}

// 'kept' is drawn but never sent: ASS drawings.
export type Piece = { kind: 'text' | 'block' | 'kept'; raw: string };

export interface Dialect {
  // Whitespace and line breaks around the text stay where they are.
  edgeStart: RegExp;
  edgeEnd: RegExp;
  visible(raw: string): boolean;
  sendable(raw: string): string;
  // '<i>' or '</i>' for a block that only toggles a style, else null.
  toggle(raw: string): string | null;
  // The edge pieces without the styling the dropped inner blocks would have undone; `all` is every piece in order.
  bare(edge: readonly Piece[], middle: readonly Piece[], all: readonly Piece[]): string;
  // Model text made safe to put between the kept markup.
  clean(text: string): string;
  // More line-internal blocks than this are typesetting, sent as plain text.
  maxMarkers: number;
}

export const TOGGLE_LETTERS = ['i', 'b', 'u', 's'];
const MARKER = /<\/?[ibus]>|<x\d+\/>/g;
const ANY_MARKER = /<\/?[ibus]>|<x\d+\/>/;
export const LEFTOVER_MARKER = /<\s*\/?\s*(?:[ibus]|x\d*)\s*\/?\s*>/gi;

export function hasMarkers(text: string): boolean {
  return ANY_MARKER.test(text);
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
  return TOGGLE_LETTERS.map(letter => tokens.filter(token => token.replace('/', '') === `<${letter}>`).join('')).join('|');
}

/** What is sent of a text split into pieces, and what stays around it; null when it has no visible text. */
export function splitText(list: Piece[], dialect: Dialect): SplitText | null {
  const pieceToggle = (piece: Piece | undefined): string | null => (piece?.kind === 'block' ? dialect.toggle(piece.raw) : null);
  let first = -1;
  let last = -1;
  list.forEach((piece, k) => {
    if (piece.kind === 'text' && dialect.visible(piece.raw)) {
      if (first < 0) first = k;
      last = k;
    }
  });
  if (first < 0) return null;
  const before = list.slice(0, first);
  const after = list.slice(last + 1);
  const middle = list.slice(first, last + 1);
  const lead = dialect.edgeStart.exec(middle[0].raw)?.[0] ?? '';
  middle[0] = { kind: 'text', raw: middle[0].raw.slice(lead.length) };
  const tailPiece = middle[middle.length - 1];
  const trail = dialect.edgeEnd.exec(tailPiece.raw)?.[0] ?? '';
  middle[middle.length - 1] = { kind: 'text', raw: tailPiece.raw.slice(0, tailPiece.raw.length - trail.length) };
  // A toggle at the text's edge whose other half is inside the line travels with it.
  const inner = middle.map(pieceToggle);
  // One facing the other way stays where it is.
  const opening = pieceToggle(before[before.length - 1]);
  if (!lead && opening && opening[1] !== '/' && inner.indexOf(opposite(opening)) >= 0) middle.unshift(before.pop()!);
  const closing = pieceToggle(after[0]);
  if (!trail && closing && closing[1] === '/' && inner.indexOf(opposite(closing)) >= 0) middle.push(after.shift()!);
  // Consecutive blocks and kept runs between text runs travel as one marker.
  const runs: Array<{ text: string } | { raw: string; kept: boolean }> = [];
  middle.forEach((piece) => {
    const prev = runs[runs.length - 1];
    if (piece.kind === 'text') runs.push({ text: piece.raw });
    else if (prev && 'raw' in prev) {
      prev.raw += piece.raw;
      prev.kept = prev.kept || piece.kind === 'kept';
    } else runs.push({ raw: piece.raw, kept: piece.kind === 'kept' });
  });
  const flattened = runs.filter(run => 'raw' in run).length > dialect.maxMarkers;
  // Only a toggle with its other half in the line reads as <i>…</i>; a lone one is a kept block.
  const toggles = runs.map(run => ('raw' in run && !flattened ? dialect.toggle(run.raw) : null));
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
      sent += dialect.sendable(run.text);
      return;
    }
    // Heavy typesetting keeps only what is never sent.
    if (flattened && !run.kept) return;
    const token = paired.has(k) ? toggles[k]! : `<x${++generic}/>`;
    markers.push({ token, raw: run.raw });
    sent += token;
  });
  const barePrefix = dialect.bare(before, middle, list) + lead;
  const bareSuffix = trail + dialect.bare(after, middle, list);
  return {
    sent,
    prefix: flattened ? barePrefix : joined(before) + lead,
    suffix: flattened ? bareSuffix : trail + joined(after),
    barePrefix,
    bareSuffix,
    markers,
    flattened,
  };
}

export interface Reassembled {
  text: string;
  dropped: boolean;
}

/** The text for a translation, with each marker back as its markup; markers that don't add up drop the styling. */
export function reassemble(
  parts: TextParts,
  translated: string,
  clean: (text: string) => string,
  // Whether a rebuilt text with every marker in place still pairs its tags.
  balanced: (text: string) => boolean = () => true,
): Reassembled {
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
  const fallback = (): Reassembled => (markers.length
    ? { text: parts.barePrefix + clean(translated) + parts.bareSuffix, dropped: true }
    : { text: parts.prefix + clean(translated) + parts.suffix, dropped: false });
  if (!valid) return fallback();
  const used = new Map<string, number>();
  const split = translated.split(MARKER);
  let body = clean(split[0]);
  found.forEach((token, k) => {
    const n = used.get(token) ?? 0;
    used.set(token, n + 1);
    body += want.get(token)![n] + clean(split[k + 1]);
  });
  const text = parts.prefix + body + parts.suffix;
  return balanced(text) ? { text, dropped: false } : fallback();
}
