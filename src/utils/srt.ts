import { parseWebVTT, type VttCue, type VttCueSettings } from './webvtt';

// Convert SubRip (SRT) text to WebVTT so `parseWebVTT` can consume it. SRT differs
// only in the ",mmm" fraction separator and the missing WEBVTT header; its numeric
// sequence lines are valid WebVTT cue identifiers, so they pass through untouched.
// Commas are converted only on timing lines, leaving commas in the cue text intact.
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => (line.includes('-->') ? line.replace(/,/g, '.') : line))
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

// An SRT position tag, {\an1}–{\an9}: the numeric keypad's layout.
const AN_TAG = /\{\\an([1-9])\}/g;

// {\an7}–{\an9} sit at the top, {\an4}–{\an6} in the middle, the rest at the
// bottom; the keypad's left and right columns align the text to that side.
function anPosition(n: number): VttCueSettings | undefined {
  const s: VttCueSettings = {};
  if (n >= 7) {
    s.line = 0;
    s.snapToLines = true;
  } else if (n >= 4) {
    s.line = 50;
    s.snapToLines = false;
    s.lineAlign = 'center';
  }
  const column = (n - 1) % 3;
  if (column === 0) s.align = 'left';
  else if (column === 2) s.align = 'right';
  return Object.keys(s).length ? s : undefined;
}

// Moves a cue's {\anN} tag into its positioning; the first tag wins, and none stays in the text.
function srtCue(cue: VttCue): VttCue {
  AN_TAG.lastIndex = 0;
  const tag = AN_TAG.exec(cue.text);
  if (!tag) return cue;
  // A tag on a line of its own leaves no empty line behind.
  const text = cue.text.replace(AN_TAG, '').replace(/^\n+|\n+$/g, '');
  const settings = anPosition(Number(tag[1]));
  return settings ? { ...cue, text, settings: { ...cue.settings, ...settings } } : { ...cue, text };
}

// Parse a sidecar subtitle file (WebVTT or SRT) to cues. WebVTT is fed straight to
// the parser; anything else is treated as SRT and converted first.
export function parseSubtitleFile(text: string): VttCue[] {
  if (/^\uFEFF?WEBVTT/.test(text)) return parseWebVTT(text).cues;
  return parseWebVTT(srtToVtt(text)).cues.map(srtCue);
}
