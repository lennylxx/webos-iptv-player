// Where text may be cut without splitting a character as it shows: a base
// with its combining marks, variation selectors, skin tones, keycap, and tag
// sequence; emoji joined by ZWJ; a flag's two regional indicators.
// Chromium 53 has no Intl.Segmenter, and truncation needs no more than this.

const ZWJ = 0x200d;

function isRegional(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function isExtender(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f)
    || (cp >= 0x1ab0 && cp <= 0x1aff)
    || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe20 && cp <= 0xfe2f)
    || (cp >= 0xfe00 && cp <= 0xfe0f)
    || (cp >= 0x1f3fb && cp <= 0x1f3ff)
    || (cp >= 0xe0020 && cp <= 0xe007f);
}

function codePointAt(text: string, i: number): number {
  const hi = text.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < text.length) {
    const lo = text.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
  }
  return hi;
}

const width = (cp: number): number => (cp > 0xffff ? 2 : 1);

// The end offset, in UTF-16 units, of each character in text.
export function graphemeEnds(text: string): number[] {
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    const base = codePointAt(text, i);
    i += width(base);
    if (isRegional(base) && i < text.length && isRegional(codePointAt(text, i))) {
      i += 2;
    }
    while (i < text.length) {
      const cp = codePointAt(text, i);
      if (isExtender(cp)) {
        i += width(cp);
      } else if (cp === ZWJ) {
        i += 1;
        if (i < text.length) i += width(codePointAt(text, i));
      } else {
        break;
      }
    }
    ends.push(i);
  }
  return ends;
}
