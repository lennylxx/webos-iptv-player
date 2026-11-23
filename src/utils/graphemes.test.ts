import { describe, it, expect } from 'vitest';
import { graphemeEnds } from './graphemes';

// The characters text splits into.
const chars = (text: string): string[] => {
  const ends = graphemeEnds(text);
  return ends.map((end, i) => text.slice(i ? ends[i - 1] : 0, end));
};

describe('graphemeEnds', () => {
  it('counts plain letters one by one', () => {
    expect(graphemeEnds('ab c')).toEqual([1, 2, 3, 4]);
    expect(graphemeEnds('')).toEqual([]);
  });

  it('keeps a surrogate pair whole', () => {
    expect(chars('🎬🎬a')).toEqual(['🎬', '🎬', 'a']);
  });

  it('keeps the two regional indicators of a flag together, and flags apart', () => {
    const flag = '\u{1F1FF}\u{1F1FF}';
    const other = '\u{1F1FF}\u{1F1FE}';
    expect(chars(`${flag}${other}x`)).toEqual([flag, other, 'x']);
  });

  it('keeps a ZWJ sequence together', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(chars(`${family}b`)).toEqual([family, 'b']);
  });

  it('keeps variation selectors and skin tones on their base', () => {
    expect(chars('\u2764\uFE0Fa\u2764\uFE0E')).toEqual(['\u2764\uFE0F', 'a', '\u2764\uFE0E']);
    expect(chars('\u{1F44B}\u{1F3FD}z')).toEqual(['\u{1F44B}\u{1F3FD}', 'z']);
  });

  it('keeps combining marks and a keycap on their base', () => {
    expect(chars('e\u0301\u0323x')).toEqual(['e\u0301\u0323', 'x']);
    expect(chars('a\u1AB0b\u20D0c\uFE20')).toEqual(['a\u1AB0', 'b\u20D0', 'c\uFE20']);
    expect(chars('1\uFE0F\u20E3#\u20E3')).toEqual(['1\uFE0F\u20E3', '#\u20E3']);
  });

  it('keeps a tag sequence on its flag', () => {
    const tags = '\u{1F3F4}\u{E0061}\u{E0062}\u{E0063}\u{E007F}';
    expect(chars(`${tags}!`)).toEqual([tags, '!']);
  });

  it('never ends inside a lone surrogate', () => {
    expect(chars('a\uD83Cb')).toEqual(['a', '\uD83C', 'b']);
  });
});
