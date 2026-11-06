import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { HlsSubtitles, wallToMediaSeconds, newestPdt, oldestPdt, lowPercentile, cueKey, parseMediaPlaylist, pickVideoVariant, planSameTextMerges, isPermanentSubtitleFailure } from './hls-subtitles';

// Synthetic timeline mirroring a live HLS stream: media-time 0 maps to wall clock
// E0; 4s segments; the playhead trails the live edge. Numbers, no real stream.
const E0 = 1_000_000_000_000; // wall clock (epoch ms) at media 0
const SEG = 4;

describe('wallToMediaSeconds', () => {
  it('is a plain 1:1 map with no fudge offset', () => {
    const anchor = { media: 0, wallMs: E0 };
    expect(wallToMediaSeconds(anchor, E0)).toBe(0);
    expect(wallToMediaSeconds(anchor, E0 + 5000)).toBe(5);
    expect(wallToMediaSeconds(anchor, E0 - 5000)).toBe(-5);
  });

  it('places a cue at the playhead via the live-edge anchor', () => {
    // Video live edge at media 7896; playhead 9s behind it. Anchor pins seekable.end
    // to the newest subtitle segment's wall clock.
    const NOW = E0 + 9_999_000;
    const anchor = { media: 7896, wallMs: NOW, src: 'edge' };
    expect(wallToMediaSeconds(anchor, NOW)).toBe(7896);              // a live-edge cue lands at the edge
    expect(wallToMediaSeconds(anchor, NOW - 9000)).toBe(7887);       // content 9s back lands at the playhead
  });

  it('maps a cue onto the video timeline even when the subtitle feed has diverged', () => {
    // The subtitle feed is an independent live stream whose program time runs ~4200s
    // ahead of the video. Newest sub segment at sub-media 12112 (PDT = E0+12112s); a
    // cue at sub-media 12100. Video live edge is media 7896, playhead ~7887.
    const newestSubPdt = E0 + 12112 * 1000;
    const cueWall = E0 + 12100 * 1000;
    const anchor = { media: 7896, wallMs: newestSubPdt, src: 'edge' };
    expect(wallToMediaSeconds(anchor, cueWall)).toBe(7884);          // lands by the playhead
    // Regression: the old code placed media-clock cues at bare c.start = 12100 — on
    // the *subtitle* timeline, ~4200s past the video playhead, so they never showed.
    expect(12100).toBeGreaterThan(7884 + 4000);
  });

  it('absorbs a video/subtitle origin offset when getStartDate is available', () => {
    // getStartDate reports the video origin 3s after the subtitle origin (E0);
    // the cue shifts 3s earlier so it still matches the video frame.
    const anchor = { media: 0, wallMs: E0 + 3000, src: 'getStartDate' };
    const cueWall = E0 + 962 * 1000;
    expect(wallToMediaSeconds(anchor, cueWall)).toBe(959);
  });

  it('places a relative (X-TIMESTAMP-MAP) cue at segment-start + offset', () => {
    const anchor = { media: 0, wallMs: E0 };
    const segPdt = E0 + 1624 * 1000;     // a segment 1624s into the stream
    const cueOffset = 2.4;               // 2.4s past the segment's LOCAL anchor
    const cueWall = segPdt + cueOffset * 1000;
    expect(wallToMediaSeconds(anchor, cueWall)).toBeCloseTo(1626.4, 6);
  });
});

describe('cueKey', () => {
  const txt = '* Sirren *';

  it('gives the abutting halves of a boundary-straddling caption distinct keys', () => {
    // One caption clipped at a 16.000s segment boundary into two halves.
    const half1 = cueKey(E0 + 15720, E0 + 16000, txt); // 15.720 -> 16.000
    const half2 = cueKey(E0 + 16000, E0 + 16920, txt); // 16.000 -> 16.920
    expect(half1).not.toBe(half2); // both survive dedup -> caption shows for its full span
  });

  it('collapses a true re-add (identical text and timing)', () => {
    expect(cueKey(E0 + 16000, E0 + 16920, txt)).toBe(cueKey(E0 + 16000, E0 + 16920, txt));
  });

  it('regression: the old rounded-second key merged the two halves', () => {
    const oldKey = (wallMs: number) => Math.round(wallMs / 1000) + '|' + txt;
    expect(oldKey(E0 + 15720)).toBe(oldKey(E0 + 16000)); // collided -> half dropped (the bug)
  });
});

describe('parseMediaPlaylist', () => {
  it('carries PROGRAM-DATE-TIME forward across segments that omit the tag', () => {
    // Only the first segment is tagged; the rest must derive their PDT from EXTINF
    // (else they get pdtMs:null and are skipped → subtitles vanish after one segment).
    const pl = parseMediaPlaylist([
      '#EXTM3U',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
      '#EXTINF:4,', 's0.vtt',
      '#EXTINF:4,', 's1.vtt',
      '#EXTINF:2,', 's2.vtt',
    ].join('\n'));
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    expect(pl.segs.map(s => s.pdtMs)).toEqual([t0, t0 + 4000, t0 + 8000]);
    expect(pl.unsupported).toBeNull();
  });

  it('prefers an explicit PDT when present (every-segment-tagged stays exact)', () => {
    const pl = parseMediaPlaylist([
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z', '#EXTINF:4,', 's0.vtt',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10.000Z', '#EXTINF:4,', 's1.vtt', // jumps, not +4
    ].join('\n'));
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    expect(pl.segs.map(s => s.pdtMs)).toEqual([base, base + 10000]);
  });

  it('stops carrying PDT across EXT-X-DISCONTINUITY', () => {
    const pl = parseMediaPlaylist([
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z', '#EXTINF:4,', 's0.vtt',
      '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 's1.vtt', // no fresh PDT -> null, not a derived value
    ].join('\n'));
    expect(pl.segs[1].pdtMs).toBeNull();
  });

  it('flags fMP4 (EXT-X-MAP) and encrypted (EXT-X-KEY) renditions as unsupported', () => {
    expect(parseMediaPlaylist('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns0.mp4').unsupported).toBe('fmp4');
    expect(parseMediaPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns0.vtt').unsupported).toBe('encrypted');
    expect(parseMediaPlaylist('#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\ns0.vtt').unsupported).toBeNull();
  });
});

describe('newestPdt', () => {
  const seg = (pdtMs: number | null) => ({ uri: 'u', pdtMs });

  it('returns the largest PROGRAM-DATE-TIME (the live edge)', () => {
    expect(newestPdt([seg(E0), seg(E0 + 8 * SEG * 1000), seg(E0 + 4 * SEG * 1000)])).toBe(E0 + 8 * SEG * 1000);
  });

  it('ignores segments without a PDT', () => {
    expect(newestPdt([seg(null), seg(E0 + 4000), seg(null), seg(E0 + 12000)])).toBe(E0 + 12000);
  });

  it('is null when no segment carries a PDT', () => {
    expect(newestPdt([seg(null), seg(null)])).toBeNull();
  });
});

describe('oldestPdt', () => {
  const seg = (pdtMs: number | null) => ({ uri: 'u', pdtMs });

  it('returns the smallest PROGRAM-DATE-TIME (the window start)', () => {
    expect(oldestPdt([seg(E0 + 8000), seg(E0), seg(E0 + 4000)])).toBe(E0);
  });

  it('ignores segments without a PDT', () => {
    expect(oldestPdt([seg(null), seg(E0 + 12000), seg(null), seg(E0 + 4000)])).toBe(E0 + 4000);
  });

  it('is null when no segment carries a PDT', () => {
    expect(oldestPdt([seg(null), seg(null)])).toBeNull();
  });
});

describe('lowPercentile', () => {
  it('returns the value at the low percentile (nearest-rank)', () => {
    const s = [73918, 73919, 73920, 73921, 77920, 77920, 77920, 77922];
    expect(lowPercentile(s, 0.2)).toBe(73919); // 2nd-smallest of 8
  });

  it('p=0 is the min and p=1 is the max', () => {
    expect(lowPercentile([5, 1, 9, 3], 0)).toBe(1);
    expect(lowPercentile([5, 1, 9, 3], 1)).toBe(9);
  });

  it('handles a single sample', () => {
    expect(lowPercentile([42], 0.2)).toBe(42);
  });
});

describe('planSameTextMerges', () => {
  const cue = (text: string, startTime: number, endTime: number) => ({ text, startTime, endTime });

  it('merges a same-text run split across a small gap (the blink case)', () => {
    // "Mir ist so heiß" clamped into three segment-aligned cues with a 0.46s gap.
    const cues = [
      cue('Mir ist so heiss', 7196.0, 7197.54),
      cue('Mir ist so heiss', 7198.0, 7200.0),
      cue('Mir ist so heiss', 7200.0, 7200.74),
    ];
    expect(planSameTextMerges(cues, 1.0, 30)).toEqual([{ keep: 0, drop: [1, 2], end: 7200.74 }]);
  });

  it('merges an overlapping same-text pair (the doubled-line case)', () => {
    const cues = [cue('a', 10, 12.04), cue('a', 12.0, 13.96)];
    expect(planSameTextMerges(cues, 1.0, 30)).toEqual([{ keep: 0, drop: [1], end: 13.96 }]);
  });

  it('does not merge same text separated by more than the gap (distinct displays)', () => {
    // e.g. "* Musik *" re-shown 2.4s later — kept separate.
    const cues = [cue('* Musik *', 100, 101.5), cue('* Musik *', 103.9, 105)];
    expect(planSameTextMerges(cues, 1.0, 30)).toEqual([]);
  });

  it('does not merge adjacent different-text cues', () => {
    const cues = [cue('a', 10, 11), cue('b', 11, 12)];
    expect(planSameTextMerges(cues, 1.0, 30)).toEqual([]);
  });

  it('ignores cues older than the window tail', () => {
    const cues = [cue('a', 0, 1), cue('a', 1, 2), cue('z', 100, 101), cue('z', 101.2, 102)];
    expect(planSameTextMerges(cues, 1.0, 30)).toEqual([{ keep: 2, drop: [3], end: 102 }]);
  });
});

describe('pickVideoVariant', () => {
  it('returns the URI on the line after the first EXT-X-STREAM-INF', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Track 1",LANGUAGE="l1",URI="subs/l1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="subs"',
      'video/low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,SUBTITLES="subs"',
      'video/high.m3u8',
    ].join('\n');
    expect(pickVideoVariant(master)).toBe('video/low.m3u8');
  });

  it('skips comment lines between the tag and the URI', () => {
    const master = '#EXT-X-STREAM-INF:BANDWIDTH=800000\n# a comment\nvideo/v.m3u8';
    expect(pickVideoVariant(master)).toBe('video/v.m3u8');
  });

  it('returns null for a master with no video variant (bare media playlist)', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg0.ts';
    expect(pickVideoVariant(media)).toBeNull();
  });
});

describe('HlsSubtitles with an external clock', () => {
  const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="l1",LANGUAGE="l1",URI="s.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"',
    'v.m3u8',
  ].join('\n');
  const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
    '#EXTINF:4,', 's0.vtt',
    '#EXTINF:4,', 's1.vtt',
  ].join('\n');
  const CUE_VTT = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n00:00:01.000 --> 00:00:03.000\nAlpha\n';

  class FakeVTTCue {
    constructor(public startTime: number, public endTime: number, public text: string) {}
  }

  function fakeTrack() {
    const cues: FakeVTTCue[] = [];
    return {
      mode: 'disabled',
      cues,
      addCue: (cue: FakeVTTCue) => cues.push(cue),
      removeCue: (cue: FakeVTTCue) => { cues.splice(cues.indexOf(cue), 1); },
    };
  }

  function serve(files: Record<string, string | number>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = files[url];
      if (body === undefined) throw new TypeError('Failed to fetch');
      const status = typeof body === 'number' ? body : 200;
      return { ok: status === 200, status, url, text: async () => String(body) };
    }));
  }

  function placeholder() {
    const tracks = [fakeTrack(), fakeTrack()];
    const listeners: Array<() => void> = [];
    let added = 0;
    const video = {
      currentTime: 0.5,
      paused: false,
      seekable: { length: 0 },
      addTextTrack: () => tracks[added++],
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => {},
    };
    return { video: video as unknown as HTMLVideoElement, timeline: tracks[0], display: tracks[1], listeners };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('times live cues on the clock and shows them while current', async () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    serve({
      'http://host/a.m3u8': MASTER,
      'http://host/s.m3u8': PLAYLIST,
      'http://host/s0.vtt': 'WEBVTT\n',
      'http://host/s1.vtt': CUE_VTT,
    });
    const { video, timeline, display, listeners } = placeholder();
    let now = 500;
    const subs = new HlsSubtitles();

    await subs.start(video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => now });

    // Newest segment s1 (P0+4s, 4s) less 3 target durations pins clock 500 to
    // P0-4s, so its cue at P0+5s lands at 509 whatever the element's own time.
    expect(timeline.cues).toEqual([expect.objectContaining({ startTime: 509, endTime: 511, text: 'Alpha' })]);
    expect(display.cues).toEqual([]);
    now = 510;
    for (const listener of listeners) listener();
    expect(display.cues.map(cue => cue.text)).toEqual(['Alpha']);
    subs.stop();
    expect(display.cues).toEqual([]);
  });

  it('logs the subtitle rendition by index, never its playlist URL', async () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    serve({ 'http://host/a.m3u8': MASTER, 'http://host/s.m3u8': PLAYLIST });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    const subs = new HlsSubtitles();

    await subs.start(placeholder().video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => 500 });
    subs.stop();

    const line = logged.mock.calls.map(args => args.join(' '))
      .find(text => text.includes('subtitles on'));
    logged.mockRestore();
    expect(line).toContain('index=0');
    expect(line).not.toContain('host');
  });

  describe('anchoring', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      vi.stubGlobal('VTTCue', FakeVTTCue);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the first clock position before pinning cue timing', async () => {
      serve({
        'http://host/a.m3u8': MASTER,
        'http://host/s.m3u8': PLAYLIST,
        'http://host/s0.vtt': 'WEBVTT\n',
        'http://host/s1.vtt': CUE_VTT,
      });
      const { video, timeline } = placeholder();
      let now = NaN;
      const onAnchor = vi.fn();
      const subs = new HlsSubtitles();

      await subs.start(video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => now, onAnchor });
      expect(timeline.cues).toEqual([]);
      expect(onAnchor).not.toHaveBeenCalled();

      now = 500;
      await vi.advanceTimersByTimeAsync(2000);
      expect(timeline.cues).toEqual([expect.objectContaining({ startTime: 509, endTime: 511 })]);
      expect(onAnchor.mock.calls).toEqual([['clock-edge', 12]]);
      subs.stop();
    });

    it('reports a clock that never reports a position once', async () => {
      serve({ 'http://host/a.m3u8': MASTER, 'http://host/s.m3u8': PLAYLIST });
      const { video } = placeholder();
      const onClockWait = vi.fn();
      const subs = new HlsSubtitles();

      await subs.start(video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => NaN, onClockWait });
      await vi.advanceTimersByTimeAsync(8000);
      expect(onClockWait).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(8000);
      expect(onClockWait.mock.calls).toEqual([[10000]]);
      subs.stop();
    });

    it('keeps the pinned clock anchor when a seekable range appears', async () => {
      const files: Record<string, string> = {
        'http://host/a.m3u8': MASTER,
        'http://host/s.m3u8': PLAYLIST,
        'http://host/s0.vtt': 'WEBVTT\n',
        'http://host/s1.vtt': 'WEBVTT\n',
      };
      serve(files);
      const { video, timeline } = placeholder();
      const subs = new HlsSubtitles();
      await subs.start(video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => 500 });

      Object.assign(video, { seekable: { length: 1, start: () => 0, end: () => 1000 } });
      files['http://host/s.m3u8'] = `${PLAYLIST}\n#EXTINF:4,\ns2.vtt`;
      files['http://host/s2.vtt'] = CUE_VTT;
      await vi.advanceTimersByTimeAsync(2000);

      // s2 starts at P0+8s, so its cue at P0+9s stays on the clock mapping (513).
      expect(timeline.cues).toEqual([expect.objectContaining({ startTime: 513, endTime: 515 })]);
      subs.stop();
    });

    it('treats a refused segment as transient but still reports a refused playlist after it', async () => {
      const files: Record<string, string | number> = {
        'http://host/a.m3u8': MASTER,
        'http://host/s.m3u8': PLAYLIST,
        'http://host/s0.vtt': 404,
        'http://host/s1.vtt': 'WEBVTT\n',
      };
      serve(files);
      const { video } = placeholder();
      const onUnavailable = vi.fn();
      const subs = new HlsSubtitles();
      await subs.start(video, 'http://host/a.m3u8', { name: 'l1' }, { clock: () => 500, onUnavailable });
      expect(onUnavailable.mock.calls).toEqual([['segment_http_404']]);

      files['http://host/s.m3u8'] = 404;
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(onUnavailable.mock.calls).toEqual([['segment_http_404'], ['http_404']]);
      expect(isPermanentSubtitleFailure('segment_http_404')).toBe(false);
      expect(isPermanentSubtitleFailure('http_404')).toBe(true);
      subs.stop();
    });
  });

  it.each([
    ['a refused master', { 'http://host/a.m3u8': 403 }, 'http_403'],
    ['an unreachable master', {}, 'network'],
    ['a refused subtitle playlist', { 'http://host/a.m3u8': MASTER, 'http://host/s.m3u8': 403 }, 'http_403'],
    ['a playlist without dates', {
      'http://host/a.m3u8': MASTER,
      'http://host/s.m3u8': '#EXTM3U\n#EXTINF:4,\ns0.vtt',
    }, 'no_pdt'],
  ])('reports %s once', async (_name, files, reason) => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    serve(files);
    const { video, timeline } = placeholder();
    const onUnavailable = vi.fn();
    const subs = new HlsSubtitles();

    await subs.start(video, 'http://host/a.m3u8', undefined, { clock: () => 500, onUnavailable });
    subs.stop();

    expect(onUnavailable.mock.calls).toEqual([[reason]]);
    expect(timeline.cues).toEqual([]);
  });
});
