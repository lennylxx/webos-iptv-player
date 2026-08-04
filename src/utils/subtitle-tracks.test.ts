import { describe, it, expect } from 'vitest';
import type { SubtitleOption, ManifestSubtitle } from '../types';
import {
  subtitleLabel,
  languageName,
  hlsSubtitleOptions,
  manifestSubtitleOptions,
  chooseSubtitleIndex,
  isSubtitlePrefMatch,
  parseSubtitleRenditions,
  parseClosedCaptions,
  closedCaptionLabel,
  nativeSubtitleOptions,
} from './subtitle-tracks';

const opt = (over: Partial<SubtitleOption>): SubtitleOption => ({
  index: 0, name: '', lang: '', isDefault: false, isForced: false, active: false, ...over,
});

describe('subtitleLabel', () => {
  it('prefers name, then language, then a positional fallback', () => {
    expect(subtitleLabel(opt({ index: 0, name: 'Track 1', lang: 'l1' }))).toBe('Track 1');
    expect(subtitleLabel(opt({ index: 1, name: '', lang: 'l2' }))).toBe('l2'); // unmapped code → raw
    expect(subtitleLabel(opt({ index: 2, name: '', lang: '' }))).toBe('Subtitle 3');
  });

  it('maps a NAME-less track from its language code to an endonym', () => {
    // Real codes are required here — the feature is the code→name map.
    expect(subtitleLabel(opt({ index: 0, name: '', lang: 'de' }))).toBe('Deutsch');
    expect(subtitleLabel(opt({ index: 0, name: '', lang: 'EN' }))).toBe('English'); // case-insensitive
    expect(subtitleLabel(opt({ index: 0, name: '', lang: 'de-DE' }))).toBe('Deutsch'); // region subtag tolerated
    expect(subtitleLabel(opt({ index: 0, name: 'Deutsch', lang: 'de' }))).toBe('Deutsch'); // an explicit name still wins
  });
});

describe('languageName', () => {
  it('returns the endonym for a 2-letter code (iso-639-1)', () => {
    expect(languageName('de')).toBe('Deutsch');
    expect(languageName('en')).toBe('English');
    expect(languageName('zh')).toBe('中文'); // non-Latin script
  });

  it('folds 3-letter codes (iso-639-2 B and T) to the endonym', () => {
    expect(languageName('deu')).toBe('Deutsch'); // 639-2/T
    expect(languageName('ger')).toBe('Deutsch'); // 639-2/B
    expect(languageName('eng')).toBe('English');
  });

  it('tolerates case and a region subtag', () => {
    expect(languageName('EN')).toBe('English');
    expect(languageName('pt-BR')).toBe('Português');
  });

  it('falls back to the raw code when unknown', () => {
    expect(languageName('l1')).toBe('l1');
    expect(languageName('zzz')).toBe('zzz');
    expect(languageName('')).toBe('');
  });
});

describe('hlsSubtitleOptions', () => {
  it('normalizes name/lang/default/forced and marks the current index active', () => {
    const opts = hlsSubtitleOptions(
      [{ name: 'Track 1', lang: 'l1', default: true }, { name: 'Track 2', lang: 'l2', forced: true }],
      1,
    );
    expect(opts).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, isForced: false, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, isForced: true, active: true },
    ]);
  });

  it('coerces missing fields and treats -1 (off) as nothing active', () => {
    expect(hlsSubtitleOptions([{}], -1)).toEqual([
      { index: 0, name: '', lang: '', isDefault: false, isForced: false, active: false },
    ]);
  });
});

describe('manifestSubtitleOptions', () => {
  const manifest: ManifestSubtitle[] = [
    { name: 'Track 1', lang: 'l1', isDefault: true, isForced: false },
    { name: 'Track 2', lang: 'l2', isDefault: false, isForced: true },
  ];

  it('maps manifest renditions to options, marking the active index', () => {
    expect(manifestSubtitleOptions(manifest, 1)).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, isForced: false, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, isForced: true, active: true },
    ]);
  });

  it('marks none active when the index is -1 (off)', () => {
    expect(manifestSubtitleOptions(manifest, -1).some(o => o.active)).toBe(false);
  });
});

describe('chooseSubtitleIndex', () => {
  const opts = [
    opt({ index: 0, name: 'Track 1', lang: 'l1' }),
    opt({ index: 1, name: 'Track 2', lang: 'l2' }),
    opt({ index: 2, name: 'Track 3', lang: 'l3' }),
  ];

  it('defaults to off (-1) with no pref and nothing forced', () => {
    expect(chooseSubtitleIndex([], null)).toBe(-1);
    expect(chooseSubtitleIndex(opts, null)).toBe(-1);
  });

  it('defaults to the forced track when one is marked', () => {
    const forced = opts.map((o, i) => ({ ...o, isForced: i === 1 }));
    expect(chooseSubtitleIndex(forced, null)).toBe(1);
  });

  it('honors an explicit off pref, even over a forced track', () => {
    const forced = opts.map((o, i) => ({ ...o, isForced: i === 1 }));
    expect(chooseSubtitleIndex(forced, { off: true, name: '', lang: '' })).toBe(-1);
  });

  it('matches a saved pref by name, case-insensitively', () => {
    expect(chooseSubtitleIndex(opts, { off: false, name: 'track 2', lang: '' })).toBe(1);
  });

  it('matches by language when the name does not match', () => {
    expect(chooseSubtitleIndex(opts, { off: false, name: 'gone', lang: 'l3' })).toBe(2);
  });

  it('prefers a name match over a language match', () => {
    const collide = [
      opt({ index: 0, name: 'Track 1', lang: 'shared' }),
      opt({ index: 1, name: 'Track 2', lang: 'shared' }),
    ];
    expect(chooseSubtitleIndex(collide, { off: false, name: 'Track 2', lang: 'shared' })).toBe(1);
  });

  it('falls back to off when the pref matches nothing and nothing is forced', () => {
    expect(chooseSubtitleIndex(opts, { off: false, name: 'gone', lang: 'gone' })).toBe(-1);
  });
});

describe('isSubtitlePrefMatch', () => {
  const o = opt({ index: 1, name: 'Track 2', lang: 'l2' });

  it('is false without a pref or option, or when the pref is off', () => {
    expect(isSubtitlePrefMatch(o, null)).toBe(false);
    expect(isSubtitlePrefMatch(undefined, { off: false, name: 'Track 2', lang: 'l2' })).toBe(false);
    expect(isSubtitlePrefMatch(o, { off: true, name: '', lang: '' })).toBe(false);
  });

  it('matches by name or language, case-insensitively', () => {
    expect(isSubtitlePrefMatch(o, { off: false, name: 'track 2', lang: '' })).toBe(true);
    expect(isSubtitlePrefMatch(o, { off: false, name: '', lang: 'L2' })).toBe(true);
  });

  it('does not count two empty fields as a match', () => {
    expect(isSubtitlePrefMatch(opt({ name: '', lang: '' }), { off: false, name: '', lang: '' })).toBe(false);
  });
});

describe('parseSubtitleRenditions', () => {
  it('parses TYPE=SUBTITLES renditions in order with name/lang/default/forced', () => {
    const m = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES,FORCED=NO,URI="s1.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 2",LANGUAGE="l2",DEFAULT=NO,FORCED=YES,URI="s2.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="s"',
      'v1.m3u8',
    ].join('\n');
    expect(parseSubtitleRenditions(m)).toEqual([
      { name: 'Track 1', lang: 'l1', isDefault: true, isForced: false },
      { name: 'Track 2', lang: 'l2', isDefault: false, isForced: true },
    ]);
  });

  it('ignores non-subtitle media and dedupes renditions repeated per quality tier', () => {
    const m = [
      '#EXT-X-MEDIA:TYPE=AUDIO,NAME="Track 9",LANGUAGE="l9"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="lo",NAME="Track 1",LANGUAGE="l1"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="hi",NAME="Track 1",LANGUAGE="l1"',
    ].join('\n');
    expect(parseSubtitleRenditions(m).map(r => r.name)).toEqual(['Track 1']);
  });

  it('anchors attributes so LANGUAGE does not match ASSOC-LANGUAGE', () => {
    const m = '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Track 1",ASSOC-LANGUAGE="zz",LANGUAGE="l1"';
    expect(parseSubtitleRenditions(m)[0].lang).toBe('l1');
  });

  it('returns [] when there are no subtitle renditions', () => {
    expect(parseSubtitleRenditions('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8')).toEqual([]);
  });

  it('tolerates whitespace after attribute commas (does not drop the value)', () => {
    const m = '#EXT-X-MEDIA:TYPE=SUBTITLES, GROUP-ID="s", NAME="Track 1", LANGUAGE="l1"';
    expect(parseSubtitleRenditions(m)[0]).toMatchObject({ name: 'Track 1', lang: 'l1' });
  });
});

describe('parseClosedCaptions', () => {
  it('parses TYPE=CLOSED-CAPTIONS with name/lang/instream-id/default, in order', () => {
    const m = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="Track 1",LANGUAGE="l1",INSTREAM-ID="CC1",DEFAULT=YES',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="Track 2",LANGUAGE="l2",INSTREAM-ID="SERVICE1"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,CLOSED-CAPTIONS="cc"',
      'v1.m3u8',
    ].join('\n');
    expect(parseClosedCaptions(m)).toEqual([
      { name: 'Track 1', lang: 'l1', instreamId: 'CC1', isDefault: true },
      { name: 'Track 2', lang: 'l2', instreamId: 'SERVICE1', isDefault: false },
    ]);
  });

  it('ignores other media types and dedupes a declaration repeated per quality tier', () => {
    const m = [
      '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="Track 9",LANGUAGE="l9"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="lo",INSTREAM-ID="CC1"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="hi",INSTREAM-ID="CC1"',
    ].join('\n');
    expect(parseClosedCaptions(m).map(c => c.instreamId)).toEqual(['CC1']);
  });

  it('keeps distinct INSTREAM-IDs that share an empty name/lang', () => {
    const m = [
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,INSTREAM-ID="CC1"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,INSTREAM-ID="CC3"',
    ].join('\n');
    expect(parseClosedCaptions(m).map(c => c.instreamId)).toEqual(['CC1', 'CC3']);
  });

  it('returns [] when no closed captions are declared (and not for CLOSED-CAPTIONS=NONE)', () => {
    const m = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CLOSED-CAPTIONS=NONE\nv.m3u8';
    expect(parseClosedCaptions(m)).toEqual([]);
  });
});

describe('closedCaptionLabel', () => {
  it('tags the single declaration name so it stays distinct from a subtitle rendition', () => {
    expect(closedCaptionLabel([{ name: 'Track 1', lang: 'l1', instreamId: 'CC1', isDefault: true }]))
      .toBe('Track 1 [CC]');
  });

  it('stays distinguishable from a TYPE=SUBTITLES rendition sharing the same NAME', () => {
    const shared = 'Track 1';
    expect(closedCaptionLabel([{ name: shared, lang: 'l1', instreamId: 'CC1', isDefault: false }]))
      .not.toBe(subtitleLabel(opt({ index: 0, name: shared, lang: 'l1' })));
  });

  it('falls back to a generic label when unnamed or when several are declared', () => {
    expect(closedCaptionLabel([{ name: '', lang: '', instreamId: 'CC1', isDefault: false }]))
      .toBe('Closed Captions');
    expect(closedCaptionLabel([
      { name: 'Track 1', lang: 'l1', instreamId: 'CC1', isDefault: true },
      { name: 'Track 2', lang: 'l2', instreamId: 'CC3', isDefault: false },
    ])).toBe('Closed Captions');
  });
});

describe('nativeSubtitleOptions', () => {
  type FakeTrack = { kind: string; label: string; language: string; mode: TextTrackMode };
  const list = (...tracks: FakeTrack[]): TextTrackList => {
    const l = tracks.slice() as unknown as TextTrackList & FakeTrack[];
    Object.defineProperty(l, 'length', { value: tracks.length });
    return l;
  };

  it('maps native text tracks to options (name from label, active from mode)', () => {
    const opts = nativeSubtitleOptions(list(
      { kind: 'subtitles', label: 'Track 1', language: 'l1', mode: 'disabled' },
      { kind: 'subtitles', label: 'Track 2', language: 'l2', mode: 'showing' },
    ));
    expect(opts).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: false, isForced: false, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, isForced: false, active: true },
    ]);
  });

  it('keeps only subtitle/caption kinds but preserves their original index', () => {
    const opts = nativeSubtitleOptions(list(
      { kind: 'metadata', label: 'meta', language: '', mode: 'hidden' },
      { kind: 'subtitles', label: 'Track 1', language: 'l1', mode: 'disabled' },
      { kind: 'captions', label: 'Track 2', language: 'l2', mode: 'showing' },
    ));
    expect(opts.map((o) => [o.index, o.name])).toEqual([[1, 'Track 1'], [2, 'Track 2']]);
  });

  it('treats an "und" or empty language as no language', () => {
    const opts = nativeSubtitleOptions(list(
      { kind: 'subtitles', label: '', language: 'und', mode: 'disabled' },
      { kind: 'subtitles', label: '', language: '', mode: 'disabled' },
    ));
    expect(opts.map((o) => o.lang)).toEqual(['', '']);
  });
});

import { clampSubtitleOffset, formatSubtitleOffset } from './subtitle-tracks';

describe('clampSubtitleOffset', () => {
  it('quantizes to the 0.25s step', () => {
    expect(clampSubtitleOffset(0.3)).toBe(0.25);
    expect(clampSubtitleOffset(0.13)).toBe(0.25);
    expect(clampSubtitleOffset(-0.4)).toBe(-0.5);
  });
  it('clamps to +/-60s', () => {
    expect(clampSubtitleOffset(100)).toBe(60);
    expect(clampSubtitleOffset(-100)).toBe(-60);
  });
  it('returns 0 for non-finite input and normalizes -0', () => {
    expect(clampSubtitleOffset(NaN)).toBe(0);
    expect(Object.is(clampSubtitleOffset(-0.1), 0)).toBe(true);
  });
});

describe('formatSubtitleOffset', () => {
  it('formats with an ASCII sign and two decimals', () => {
    expect(formatSubtitleOffset(0)).toBe('0.00 s');
    expect(formatSubtitleOffset(0.25)).toBe('+0.25 s');
    expect(formatSubtitleOffset(-1.5)).toBe('-1.50 s');
  });
});

import { shiftForeignTrack } from './subtitle-tracks';

describe('shiftForeignTrack', () => {
  const track = (cues: Array<{ startTime: number; endTime: number }>) => ({ cues });

  it('shifts every cue by the offset from its original time (absolute, idempotent)', () => {
    const t = track([{ startTime: 5, endTime: 7 }, { startTime: 10, endTime: 12 }]);
    shiftForeignTrack(t, 2);
    expect(t.cues).toEqual([{ startTime: 7, endTime: 9 }, { startTime: 12, endTime: 14 }]);
    shiftForeignTrack(t, 2); // re-run does not accumulate
    expect(t.cues).toEqual([{ startTime: 7, endTime: 9 }, { startTime: 12, endTime: 14 }]);
    shiftForeignTrack(t, -1); // change is absolute from the captured base
    expect(t.cues).toEqual([{ startTime: 4, endTime: 6 }, { startTime: 9, endTime: 11 }]);
    shiftForeignTrack(t, 0);
    expect(t.cues).toEqual([{ startTime: 5, endTime: 7 }, { startTime: 10, endTime: 12 }]);
  });

  it('is a no-op for a null track or null cues', () => {
    expect(() => shiftForeignTrack(null, 3)).not.toThrow();
    expect(() => shiftForeignTrack({ cues: null }, 3)).not.toThrow();
  });
});
