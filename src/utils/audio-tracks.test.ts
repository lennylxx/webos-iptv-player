import { describe, it, expect } from 'vitest';
import type { AudioOption } from '../types';
import {
  audioLabel,
  hlsAudioOptions,
  nativeAudioOptions,
  chooseAudioIndex,
  isPrefMatch,
  parseAudioRenditions,
  mergeManifestNames,
  mapLunaAudio,
} from './audio-tracks';

const opt = (over: Partial<AudioOption>): AudioOption => ({
  index: 0, name: '', lang: '', isDefault: false, active: false, ...over,
});

// Build a native AudioTrackList-like object (the DOM type is absent in node tests).
const nativeList = (tracks: Array<{ label?: string; language?: string; enabled?: boolean }>): AudioTrackList => {
  const list: Record<number | string, unknown> = { length: tracks.length };
  tracks.forEach((t, i) => {
    list[i] = { label: t.label ?? '', language: t.language ?? '', enabled: !!t.enabled, id: '', kind: '' };
  });
  return list as unknown as AudioTrackList;
};

describe('audioLabel', () => {
  it('prefers name, then language, then a positional fallback', () => {
    expect(audioLabel(opt({ index: 0, name: 'Track 1', lang: 'l1' }))).toBe('Track 1');
    expect(audioLabel(opt({ index: 1, name: '', lang: 'l2' }))).toBe('l2');
    expect(audioLabel(opt({ index: 2, name: '', lang: '' }))).toBe('Audio 3');
  });
});

describe('hlsAudioOptions', () => {
  it('normalizes name/lang/default and marks the current index active', () => {
    const opts = hlsAudioOptions(
      [{ name: 'Track 1', lang: 'l1', default: true }, { name: 'Track 2', lang: 'l2' }],
      1,
    );
    expect(opts).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, active: true },
    ]);
  });

  it('coerces missing fields to empty strings / false', () => {
    expect(hlsAudioOptions([{}], -1)).toEqual([
      { index: 0, name: '', lang: '', isDefault: false, active: false },
    ]);
  });
});

describe('nativeAudioOptions', () => {
  it('maps label→name, language→lang, enabled→isDefault+active', () => {
    const opts = nativeAudioOptions(nativeList([
      { label: 'Track 1', language: 'l1', enabled: true },
      { label: 'Track 2', language: 'l2', enabled: false },
    ]));
    expect(opts).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, active: true },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, active: false },
    ]);
  });

  it("treats 'und' language as empty", () => {
    expect(nativeAudioOptions(nativeList([{ label: 'Track 1', language: 'und' }]))[0].lang).toBe('');
  });
});

describe('chooseAudioIndex', () => {
  const opts = [
    opt({ index: 0, name: 'Track 1', lang: 'l1', isDefault: true }),
    opt({ index: 1, name: 'Track 2', lang: 'l2' }),
    opt({ index: 2, name: 'Track 3', lang: 'l3' }),
  ];

  it('returns -1 for no options', () => {
    expect(chooseAudioIndex([], null)).toBe(-1);
  });

  it('falls back to the default track when no pref is saved', () => {
    expect(chooseAudioIndex(opts, null)).toBe(0);
  });

  it('falls back to the first track when nothing is marked default', () => {
    const noDefault = opts.map(o => ({ ...o, isDefault: false }));
    expect(chooseAudioIndex(noDefault, null)).toBe(0);
  });

  it('matches a saved pref by name, case-insensitively', () => {
    expect(chooseAudioIndex(opts, { name: 'track 2', lang: '' })).toBe(1);
  });

  it('matches by language when the name does not match', () => {
    expect(chooseAudioIndex(opts, { name: 'gone', lang: 'l3' })).toBe(2);
  });

  it('prefers a name match over a language match', () => {
    const collide = [
      opt({ index: 0, name: 'Track 1', lang: 'shared' }),
      opt({ index: 1, name: 'Track 2', lang: 'shared' }),
    ];
    expect(chooseAudioIndex(collide, { name: 'Track 2', lang: 'shared' })).toBe(1);
  });

  it('falls back to the default when the pref matches nothing', () => {
    expect(chooseAudioIndex(opts, { name: 'gone', lang: 'gone' })).toBe(0);
  });

  // ISO 639 folding needs real codes; Luna saves ger/deu where a manifest says de.
  it('matches a 3-letter saved language against a 2-letter track, and back', () => {
    const two = [opt({ index: 0, lang: 'en', isDefault: true }), opt({ index: 1, lang: 'de' })];
    const three = [opt({ index: 0, lang: 'eng', isDefault: true }), opt({ index: 1, lang: 'ger' })];
    expect(chooseAudioIndex(two, { name: '', lang: 'ger' })).toBe(1);
    expect(chooseAudioIndex(three, { name: '', lang: 'de' })).toBe(1);
  });

  it('prefers an exact language over a folded one and keeps regional codes exact', () => {
    const both = [opt({ index: 0, lang: 'deu', isDefault: true }), opt({ index: 1, lang: 'de' })];
    expect(chooseAudioIndex(both, { name: '', lang: 'de' })).toBe(1);
    const regional = [opt({ index: 0, lang: 'en', isDefault: true }), opt({ index: 1, lang: 'de-AT' })];
    expect(chooseAudioIndex(regional, { name: '', lang: 'de' })).toBe(0);
  });
});

describe('isPrefMatch', () => {
  const o = opt({ index: 1, name: 'Track 2', lang: 'l2' });

  it('is false without a pref or option', () => {
    expect(isPrefMatch(o, null)).toBe(false);
    expect(isPrefMatch(undefined, { name: 'Track 2', lang: 'l2' })).toBe(false);
  });

  it('matches by name or language, case-insensitively', () => {
    expect(isPrefMatch(o, { name: 'track 2', lang: '' })).toBe(true);
    expect(isPrefMatch(o, { name: '', lang: 'L2' })).toBe(true);
  });

  it('matches a folded 3-letter language in either direction', () => {
    expect(isPrefMatch(opt({ index: 0, lang: 'de' }), { name: '', lang: 'ger' })).toBe(true);
    expect(isPrefMatch(opt({ index: 0, lang: 'deu' }), { name: '', lang: 'de' })).toBe(true);
    expect(isPrefMatch(opt({ index: 0, lang: 'en' }), { name: '', lang: 'ger' })).toBe(false);
  });

  it('does not count two empty fields as a match', () => {
    expect(isPrefMatch(opt({ index: 0, name: '', lang: '' }), { name: '', lang: '' })).toBe(false);
  });
});

describe('parseAudioRenditions', () => {
  it('parses TYPE=AUDIO renditions in order with name/lang/default', () => {
    const m = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES,AUTOSELECT=YES',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="l2",DEFAULT=NO',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
      'v1.m3u8',
    ].join('\n');
    expect(parseAudioRenditions(m)).toEqual([
      { name: 'Track 1', lang: 'l1', isDefault: true },
      { name: 'Track 2', lang: 'l2', isDefault: false },
    ]);
  });

  it('ignores non-audio media and dedupes renditions repeated per quality tier', () => {
    const m = [
      '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Track 9",LANGUAGE="l9"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",NAME="Track 1",LANGUAGE="l1"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="lo",NAME="Track 2",LANGUAGE="l2"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="Track 1",LANGUAGE="l1"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="hi",NAME="Track 2",LANGUAGE="l2"',
    ].join('\n');
    expect(parseAudioRenditions(m).map(r => r.name)).toEqual(['Track 1', 'Track 2']);
  });

  it('anchors attributes so LANGUAGE does not match ASSOC-LANGUAGE', () => {
    const m = '#EXT-X-MEDIA:TYPE=AUDIO,NAME="Track 1",ASSOC-LANGUAGE="zz",LANGUAGE="l1"';
    expect(parseAudioRenditions(m)[0].lang).toBe('l1');
  });

  it('returns [] when there are no audio renditions', () => {
    expect(parseAudioRenditions('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8')).toEqual([]);
  });
});

describe('mergeManifestNames', () => {
  const opts = [
    opt({ index: 0, name: '', lang: 'l1', isDefault: true, active: true }),
    opt({ index: 1, name: '', lang: '' }),
  ];

  it('overlays names/langs by index when counts match', () => {
    const merged = mergeManifestNames(opts, [
      { name: 'Track 1', lang: 'l1', isDefault: true },
      { name: 'Track 2', lang: 'l2', isDefault: false },
    ]);
    expect(merged.map(o => o.name)).toEqual(['Track 1', 'Track 2']);
    expect(merged[1].lang).toBe('l2');
    expect(merged[0].active).toBe(true); // native live state preserved
  });

  it('leaves options untouched when counts differ (collapsed native list)', () => {
    expect(mergeManifestNames(opts, [{ name: 'Track 1', lang: 'l1', isDefault: true }])).toBe(opts);
  });

  it('keeps the native value when a manifest field is empty', () => {
    const merged = mergeManifestNames(opts, [
      { name: '', lang: '', isDefault: false },
      { name: 'Track 2', lang: '', isDefault: false },
    ]);
    expect(merged[0].lang).toBe('l1'); // native lang kept
  });
});

describe('mapLunaAudio', () => {
  const rendition = (name: string, lang: string) => ({ name, lang, isDefault: false });

  it('pairs by language, in order among same-language renditions', () => {
    const manifest = [rendition('Track 1', 'l1'), rendition('Track 2', 'l2'), rendition('Track 3', 'l1')];
    expect(mapLunaAudio([{ language: 'l2' }, { language: 'l1' }, { language: 'l1' }], manifest)).toEqual({
      renditions: [manifest[1], manifest[0], manifest[2]],
      naming: 'manifest',
    });
  });

  it('folds a 3-letter UMS code onto the manifest\'s 2-letter one', () => {
    const manifest = [rendition('Track 1', 'de'), rendition('Track 2', '')];
    expect(mapLunaAudio([{ language: 'ger' }, { language: 'und' }], manifest).naming).toBe('manifest');
  });

  it('pairs by position when UMS lists no languages', () => {
    const manifest = [rendition('Track 1', 'l1'), rendition('Track 2', 'l2')];
    expect(mapLunaAudio([{ language: '' }, { language: '' }], manifest)).toEqual({
      renditions: manifest,
      naming: 'order',
    });
    expect(mapLunaAudio([{ language: '' }], manifest).naming).toBe('count_mismatch');
    expect(mapLunaAudio([{ language: 'l2' }, { language: '' }], manifest).naming).toBe('lang_mismatch');
  });

  it('gives up when the lists cannot pair one-to-one', () => {
    expect(mapLunaAudio([{ language: 'l1' }], []).naming).toBe('no_manifest');
    expect(mapLunaAudio([{ language: 'l1' }], [rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]))
      .toEqual({ renditions: null, naming: 'count_mismatch' });
    expect(mapLunaAudio([{ language: 'l1' }, { language: 'l1' }],
      [rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]).naming).toBe('lang_mismatch');
  });
});
