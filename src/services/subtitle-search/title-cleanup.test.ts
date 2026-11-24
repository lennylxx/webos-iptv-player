import { describe, expect, it } from 'vitest';
import { cleanSearchTitle, workTitle } from './title-cleanup';

describe('cleanSearchTitle', () => {
  it.each([
    ['|EN| Alpha (2019) 4K MULTI', { title: 'Alpha', year: 2019 }],
    ['[FR] Bravo [2020] [HDR]', { title: 'Bravo', year: 2020 }],
    ['EN - Charlie 1080p HEVC', { title: 'Charlie', year: 0 }],
    ['UK: Delta | FHD', { title: 'Delta', year: 0 }],
    ['Alpha.Bravo.2018.1080p.WEB-DL.x264', { title: 'Alpha Bravo', year: 2018 }],
    ['(DE) Echo - Part 2 (2001)', { title: 'Echo - Part 2', year: 2001 }],
  ])('tidies %s', (name, expected) => {
    expect(cleanSearchTitle(name)).toEqual(expected);
  });

  it.each([
    ['Alpha |EN|', 'Alpha'],
    ['Bravo (1995) [FR]', 'Bravo'],
    ['[4K] Charlie (HDR, DV)', 'Charlie'],
    ['Alpha [EN] (2019)', 'Alpha'],
    ['Alpha (2019) [EN] HD', 'Alpha'],
    ['Alpha [FR] 4K', 'Alpha'],
    ['Alpha | FR', 'Alpha'],
    ['Alpha (2019) - EN', 'Alpha'],
  ])('drops trailing and bracketed tags from %s', (name, title) => {
    expect(cleanSearchTitle(name).title).toBe(title);
  });

  it.each([
    'QXZ: Alpha', 'ZVK: Bravo of the Charlie', 'KQX - Delta', 'THE - End', '[QRZ] 2',
    'SD Alpha Force', 'HD Bravo', 'Multi Charlie', 'Eng: Delta',
  ])('keeps title words that only look like tags: %s', (name) => {
    expect(cleanSearchTitle(name).title).toBe(name);
  });

  it('takes the last dotted year, keeping an earlier number in the title', () => {
    expect(cleanSearchTitle('Alpha.Bravo.2049.2017.1080p')).toEqual({ title: 'Alpha Bravo 2049', year: 2017 });
  });

  // A capital "IT:" is also a common Italian prefix; the prefix reading wins.
  it('reads a leading capital IT as a language tag', () => {
    expect(cleanSearchTitle('IT: Alpha Bravo').title).toBe('Alpha Bravo');
  });

  it('takes the year but keeps a title word that is also a release tag', () => {
    expect(cleanSearchTitle('Dual (2001)')).toEqual({ title: 'Dual', year: 2001 });
  });

  it('leaves a title alone, numbers and short words included', () => {
    expect(cleanSearchTitle('Alpha 2049')).toEqual({ title: 'Alpha 2049', year: 0 });
    expect(cleanSearchTitle('Up')).toEqual({ title: 'Up', year: 0 });
    expect(cleanSearchTitle('MI-5 Bravo')).toEqual({ title: 'MI-5 Bravo', year: 0 });
  });

  it('keeps the name when nothing else is left', () => {
    expect(cleanSearchTitle('4K')).toEqual({ title: '4K', year: 0 });
  });
});

describe('workTitle', () => {
  it('takes the series from an episode label', () => {
    expect(workTitle('Alpha — S1E2 — Bravo')).toBe('Alpha');
    expect(workTitle('Alpha — S10E20')).toBe('Alpha');
    expect(workTitle('Alpha')).toBe('Alpha');
  });
});
