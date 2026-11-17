import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCatchupUrl,
  catchupNeedsId,
  catchupNeedsIdUncached,
  catchupPlan,
  expandCatchupTemplate,
  expandLiveUrl,
  hasCatchup,
  type CatchupRequest,
} from './catchup-url';

// 2026-01-02 03:04:05 UTC, an hour-long program, watched 2 hours after it began.
const START = Date.UTC(2026, 0, 2, 3, 4, 5) / 1000;
const END = START + 3600;
const NOW = START + 7200;

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  // UTC+2 with no daylight saving, so local date parts differ from UTC ones.
  process.env.TZ = 'Etc/GMT-2';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function build(overrides: Partial<CatchupRequest>): string | null {
  return buildCatchupUrl({
    liveUrl: 'http://host/ch1/index.m3u8',
    type: '',
    source: '',
    start: START,
    end: END,
    now: NOW,
    ...overrides,
  });
}

function expand(template: string, extra: { catchupId?: string; channelId?: string } = {}): string {
  return expandCatchupTemplate(template, {
    start: START,
    end: END,
    now: NOW,
    catchupId: extra.catchupId ?? '',
    channelId: extra.channelId ?? '',
  });
}

describe('catch-up types', () => {
  it('default uses catchup-source as the whole URL', () => {
    expect(build({ type: 'default', source: 'http://host/a?s={utc}&e={utcend}' }))
      .toBe(`http://host/a?s=${START}&e=${END}`);
  });

  it('a source without a type is a template, as before', () => {
    expect(build({ source: 'http://host/a/{utc}' })).toBe(`http://host/a/${START}`);
  });

  it('default without a usable source falls back to shift', () => {
    expect(build({ type: 'default', liveUrl: 'http://host/a.ts' }))
      .toBe(`http://host/a.ts?utc=${START}&lutc=${NOW}`);
    expect(build({ type: 'default', source: 'nopath', liveUrl: 'http://host/a.ts' }))
      .toBe(`http://host/a.ts?utc=${START}&lutc=${NOW}`);
  });

  it('append adds catchup-source to the live URL with the right separator', () => {
    expect(build({ type: 'append', source: '?utc={utc}', liveUrl: 'http://host/a.ts' }))
      .toBe(`http://host/a.ts?utc=${START}`);
    expect(build({ type: 'append', source: '&utc={utc}', liveUrl: 'http://host/a.ts' }))
      .toBe(`http://host/a.ts?utc=${START}`);
    expect(build({ type: 'append', source: '?utc={utc}', liveUrl: 'http://host/a.ts?token=t1' }))
      .toBe(`http://host/a.ts?token=t1&utc=${START}`);
    expect(build({ type: 'append', source: '&utc={utc}', liveUrl: 'http://host/a.ts?token=t1' }))
      .toBe(`http://host/a.ts?token=t1&utc=${START}`);
    expect(build({ type: 'append', source: '/archive/{utc}', liveUrl: 'http://host/a' }))
      .toBe(`http://host/a/archive/${START}`);
  });

  it('append without a source has no catch-up', () => {
    expect(build({ type: 'append' })).toBeNull();
  });

  it('shift, archive, and timeshift add their query parameters', () => {
    expect(build({ type: 'shift', liveUrl: 'http://host/a.m3u8' }))
      .toBe(`http://host/a.m3u8?utc=${START}&lutc=${NOW}`);
    expect(build({ type: 'shift', liveUrl: 'http://host/a.m3u8?token=t1#f' }))
      .toBe(`http://host/a.m3u8?token=t1&utc=${START}&lutc=${NOW}#f`);
    expect(build({ type: 'archive', liveUrl: 'http://host/a.m3u8' }))
      .toBe(`http://host/a.m3u8?archive=${START}&archive_end=${END}`);
    expect(build({ type: 'timeshift', liveUrl: 'http://host/a.m3u8?x=1' }))
      .toBe(`http://host/a.m3u8?x=1&timeshift=${START}&timenow=${NOW}`);
  });

  it('a plain source replaces the live URL that the rule rewrites', () => {
    expect(build({ type: 'shift', source: 'http://host/b.m3u8', liveUrl: 'http://host/a.m3u8' }))
      .toBe(`http://host/b.m3u8?utc=${START}&lutc=${NOW}`);
  });

  it('a source with variables is used as a template for any type', () => {
    expect(build({ type: 'flussonic', source: 'http://host/ch1/archive-{utc}-3600.m3u8?token=t1' }))
      .toBe(`http://host/ch1/archive-${START}-3600.m3u8?token=t1`);
  });

  it('flussonic-hls plays the fixed-window archive playlist of the same name', () => {
    expect(build({ type: 'flussonic-hls', liveUrl: 'http://host/ch1/index.m3u8?token=t1' }))
      .toBe(`http://host/ch1/index-${START}-3600.m3u8?token=t1`);
    expect(build({ type: 'flussonic-hls', liveUrl: 'http://host/ch1/video.m3u8' }))
      .toBe(`http://host/ch1/video-${START}-3600.m3u8`);
    expect(build({ type: 'flussonic-hls', liveUrl: 'http://host/ch1/mono.m3u8' }))
      .toBe(`http://host/ch1/mono-${START}-3600.m3u8`);
  });

  it('derives no Flussonic archive from a URL without a Flussonic file', () => {
    for (const liveUrl of ['http://host/live/ch1', 'http://host/ch1/', 'http://host/live/ch1?token=t1']) {
      expect(build({ type: 'flussonic', liveUrl })).toBeNull();
      expect(build({ type: 'flussonic-hls', liveUrl })).toBeNull();
      expect(build({ type: 'fs', liveUrl })).toBeNull();
      expect(hasCatchup({ url: liveUrl, catchup: 'flussonic', catchupSource: '' })).toBe(false);
    }
    expect(hasCatchup({
      url: 'http://host/live/ch1', catchup: 'flussonic', catchupSource: 'http://host/a/{utc}',
    })).toBe(true);
    expect(build({
      type: 'flussonic', liveUrl: 'http://host/live/ch1', source: 'http://host/ch1/mono.m3u8',
    })).toBe(`http://host/ch1/mono-${START}-3600.m3u8`);
  });

  it('flussonic-dash and flussonic-ts play the fixed-window archive file', () => {
    expect(build({ type: 'flussonic-dash', liveUrl: 'http://host/ch1/index.mpd' }))
      .toBe(`http://host/ch1/archive-${START}-3600.mpd`);
    expect(build({ type: 'flussonic-ts', liveUrl: 'http://host/ch1/mpegts?token=t1#f' }))
      .toBe(`http://host/ch1/archive-${START}-3600.ts?token=t1#f`);
    expect(build({ type: 'fs', liveUrl: 'http://host/ch1/mpegts' }))
      .toBe(`http://host/ch1/archive-${START}-3600.ts`);
  });

  it('flussonic picks the variant from the stream URL', () => {
    expect(build({ type: 'flussonic', liveUrl: 'http://host/ch1/index.mpd' }))
      .toBe(`http://host/ch1/archive-${START}-3600.mpd`);
    expect(build({ type: 'Flussonic', liveUrl: 'http://host/ch1/live.ts' }))
      .toBe(`http://host/ch1/archive-${START}-3600.ts`);
    expect(build({ type: 'flussonic', liveUrl: 'http://host/ch1/index.m3u8' }))
      .toBe(`http://host/ch1/index-${START}-3600.m3u8`);
  });

  it('flussonic plays an MPEG-TS live URL as the TS archive', () => {
    expect(build({ type: 'flussonic', liveUrl: 'http://host/ch1/mpegts?token=t1' }))
      .toBe(`http://host/ch1/archive-${START}-3600.ts?token=t1`);
  });

  it('reads whether a full template ends with the program from its variables', () => {
    const bounded = (type: string, source: string) =>
      catchupPlan(type, source, 'http://host/ch1/index.m3u8')?.bounded;
    expect(bounded('default', 'http://host/ch1/index.m3u8?utc={utc}&lutc={lutc}')).toBe(false);
    expect(bounded('default', 'http://host/ch1/a-${start}.m3u8')).toBe(false);
    expect(bounded('default', 'http://host/a?t={Y}{m}{d}{H}{M}')).toBe(false);
    expect(bounded('default', 'http://host/a?s={utc}&e={utcend}')).toBe(true);
    expect(bounded('default', 'http://host/a?s={utc}&d={duration:60}')).toBe(true);
    expect(bounded('default', 'http://host/a?s=${start-hour}&e=${end-hour}')).toBe(true);
    expect(bounded('default', 'http://host/a?s={start_iso}&e={end_iso}')).toBe(true);
    expect(bounded('default', 'http://host/a?s={utc}&m=${durmin}')).toBe(true);
    expect(bounded('default', 'http://host/a?s={utc}{{shift:end:+5m}}')).toBe(true);
    expect(bounded('append', '?utc={utc}&lutc={lutc}')).toBe(false);
    expect(bounded('shift', 'http://host/ch1/index.m3u8?utc={utc}&lutc={lutc}')).toBe(false);
    expect(bounded('shift', 'http://host/ch1/index.m3u8?utc={utc}&end={utcend}')).toBe(true);
    expect(bounded('vod', 'http://host/v/{catchup-id}')).toBe(true);
  });

  it('reports which plans end with the program', () => {
    const bounded = (type: string, liveUrl = 'http://host/ch1/index.m3u8', source = '') =>
      catchupPlan(type, source, liveUrl)?.bounded;
    expect(bounded('default', undefined, 'http://host/a/{utc}-{duration}')).toBe(true);
    expect(bounded('append', undefined, '?utc={utc}&end={utcend}')).toBe(true);
    expect(bounded('vod')).toBe(true);
    expect(bounded('flussonic')).toBe(true);
    expect(bounded('flussonic', 'http://host/ch1/index.mpd')).toBe(true);
    expect(bounded('shift')).toBe(false);
    expect(bounded('archive')).toBe(false);
    expect(bounded('timeshift')).toBe(false);
    expect(bounded('default')).toBe(false);
    expect(bounded('fs', 'http://host/ch1/mpegts')).toBe(true);
    expect(bounded('flussonic', 'http://host/ch1/mpegts')).toBe(true);
  });

  it('vod plays catchup-source, or the program catchup-id', () => {
    expect(build({ type: 'vod', source: 'http://host/vod/{catchup-id}', catchupId: 'p1' }))
      .toBe('http://host/vod/p1');
    expect(build({ type: 'vod', catchupId: 'http://host/vod/p2' })).toBe('http://host/vod/p2');
    expect(build({ type: 'vod' })).toBeNull();
  });

  it('builds nothing when the result is not an absolute URL', () => {
    expect(build({ type: 'vod', catchupId: 'p1' })).toBeNull();
    expect(build({ type: 'vod', source: '/vod/{catchup-id}', catchupId: 'p1' })).toBeNull();
    expect(build({ type: 'vod', catchupId: 'rtsp://host/p1' })).toBe('rtsp://host/p1');
  });

  it('builds nothing when the template needs a catchup-id it lacks', () => {
    expect(build({ type: 'vod', source: 'http://host/vod/{catchup-id}' })).toBeNull();
    expect(build({ type: 'default', source: 'http://host/a/${catchup-id}?s={utc}' })).toBeNull();
    expect(build({ type: 'default', source: 'http://host/a/{catchup-id}', catchupId: 'p1' }))
      .toBe('http://host/a/p1');
  });

  it('an unknown type with a source is a template; without one, nothing', () => {
    expect(catchupPlan('custom', 'http://host/a/{utc}', 'http://host/live')?.unknownType).toBe(true);
    expect(build({ type: 'custom', source: 'http://host/a/{utc}' })).toBe(`http://host/a/${START}`);
    expect(build({ type: 'custom' })).toBeNull();
    expect(catchupPlan('', 'http://host/a/{utc}', 'http://host/live')?.unknownType).toBe(false);
  });

  it('applies catchup-correction hours to every time', () => {
    expect(build({ type: 'default', source: 'http://host/a?s={utc}&n={lutc}&d={duration}', correctionHours: -1.5 }))
      .toBe(`http://host/a?s=${START - 5400}&n=${NOW - 5400}&d=3600`);
  });
});

describe('hasCatchup', () => {
  it('needs a source, or a type that builds from the stream URL', () => {
    const url = 'http://host/a.m3u8';
    expect(hasCatchup({ url, catchup: '', catchupSource: '' })).toBe(false);
    expect(hasCatchup({ url })).toBe(false);
    expect(hasCatchup({ url, catchup: '', catchupSource: 'http://host/a/{utc}' })).toBe(true);
    for (const type of ['default', 'shift', 'archive', 'timeshift', 'flussonic', 'flussonic-hls', 'fs', 'vod']) {
      expect(hasCatchup({ url, catchup: type, catchupSource: '' })).toBe(true);
    }
    for (const type of ['append', 'xc', 'xtream', 'custom']) {
      expect(hasCatchup({ url, catchup: type, catchupSource: '' })).toBe(false);
    }
    expect(hasCatchup({ url, catchup: 'vod', catchupSource: 'http://host/vod/{catchup-id}' }))
      .toBe(true);
  });
});

describe('hasCatchup and buildCatchupUrl agree', () => {
  it('offers catch-up only where a URL can be built', () => {
    const cases: Array<{ url: string; catchup: string; catchupSource: string; catchupId?: string }> = [
      { url: 'http://host/live/ch1', catchup: 'flussonic', catchupSource: 'http://host/live/ch1' },
      { url: 'http://host/live/ch1', catchup: 'flussonic', catchupSource: 'http://host/ch1/index.m3u8' },
      { url: 'http://host/a.ts', catchup: 'custom', catchupSource: '' },
      { url: 'http://host/a.ts', catchup: 'custom', catchupSource: 'http://host/a/{utc}' },
      { url: 'http://host/a.ts', catchup: 'append', catchupSource: '' },
      { url: 'http://host/a.ts', catchup: 'append', catchupSource: '?utc={utc}' },
      { url: 'http://host/a.ts', catchup: 'vod', catchupSource: '', catchupId: 'http://host/v/p1' },
      { url: 'http://host/a.ts', catchup: 'default', catchupSource: 'nopath' },
      { url: 'udp://@239.0.0.1:1234', catchup: 'fs', catchupSource: '' },
    ];
    for (const item of cases) {
      const built = build({ liveUrl: item.url, type: item.catchup, source: item.catchupSource, catchupId: item.catchupId });
      expect([item, hasCatchup(item)]).toEqual([item, built !== null]);
    }
  });

  it('follows a change to the channel after an earlier answer', () => {
    const channel = { url: 'http://host/live/ch1', catchup: 'flussonic', catchupSource: 'http://host/live/ch1' };
    expect(hasCatchup(channel)).toBe(false);
    channel.catchupSource = 'http://host/ch1/mono.m3u8';
    expect(hasCatchup(channel)).toBe(true);
  });
});

describe('catchupNeedsId', () => {
  it('is true only when the channel builds its URL from the program catch-up id', () => {
    const url = 'http://host/a.m3u8';
    expect(catchupNeedsId({ url, catchup: 'vod', catchupSource: '' })).toBe(true);
    expect(catchupNeedsId({ url, catchup: 'vod', catchupSource: 'http://host/vod/${catchup-id}' })).toBe(true);
    expect(catchupNeedsId({ url, catchup: 'vod', catchupSource: 'http://host/vod?s={utc}' })).toBe(false);
    expect(catchupNeedsId({ url, catchup: 'default', catchupSource: 'http://host/a/{catchup-id}' })).toBe(true);
    expect(catchupNeedsId({ url, catchup: 'append', catchupSource: '&id={catchup-id}' })).toBe(true);
    expect(catchupNeedsId({ url, catchup: 'shift', catchupSource: '' })).toBe(false);
    expect(catchupNeedsId({ url, catchup: '', catchupSource: '' })).toBe(false);
  });

  it('reads the variable name in any case, with or without the memo', () => {
    const channel = { url: 'http://host/a.m3u8', catchup: 'default', catchupSource: 'http://host/x/{CATCHUP-ID}.m3u8' };
    expect(catchupNeedsIdUncached(channel)).toBe(true);
    expect(catchupNeedsId(channel)).toBe(true);
  });
});

describe('expandCatchupTemplate', () => {
  it('replaces every occurrence of each variable', () => {
    expect(expand('{utc}/{utc}/${start}/${start}')).toBe(`${START}/${START}/${START}/${START}`);
  });

  it('fills the unix-time variables', () => {
    expect(expand('{utc}|${start}|{utcend}|${end}|{lutc}|${now}|${timestamp}|{current_utc}'))
      .toBe([START, START, END, END, NOW, NOW, NOW, NOW].join('|'));
  });

  it('fills duration, offset, and their divisors', () => {
    expect(expand('{duration}|${duration}|{duration:60}|{duration:3600}|${durmin}'))
      .toBe('3600|3600|60|1|60');
    expect(expand('${offset}|{offset:60}|{offset:10}')).toBe('7200|120|720');
    expect(expand('{duration:0}|{duration:1.5}|{offset:0}|{offset:x}')).toBe('3600|3600|7200|7200');
  });

  it('fills local date parts, case-sensitively', () => {
    expect(expand('{Y}-{m}-{d}T{H}:{M}:{S}')).toBe('2026-01-02T05:04:05');
    expect(expand('${start-year}${start-mon}${start-day}${start-hour}${start-min}${start-sec}'))
      .toBe('20260102050405');
    expect(expand('${end-hour}:${end-min}')).toBe('06:04');
  });

  it('formats a time variable with a date format argument', () => {
    expect(expand('{utc:YmdHM}|${end:Ymd-H-M}|{lutc:Y/m/d}'))
      .toBe('202601020504|20260102-06-04|2026/01/02');
  });

  it('fills the ISO variables in UTC', () => {
    expect(expand('{start_iso}|{end_iso}|{now_iso}'))
      .toBe('2026-01-02T03:04:05Z|2026-01-02T04:04:05Z|2026-01-02T05:04:05Z');
  });

  it('shifts a single variable', () => {
    expect(expand('{utc:-5m}|${start:+1h}|{utcend:+10m}|{start_iso:-30m}|{utc:90}|{utc:1d}'))
      .toBe([
        START - 300,
        START + 3600,
        END + 600,
        '2026-01-02T02:34:05Z',
        START + 90,
        START + 86400,
      ].join('|'));
    expect(expand('${start-hour:+1h}')).toBe('06');
  });

  it('shifts the whole URL with one shift command', () => {
    expect(expand('http://host/a?s={utc}&d={duration}{{shift:start:-5m}}'))
      .toBe(`http://host/a?s=${START - 300}&d=3900`);
    expect(expand('{{shift:end:+10m}}http://host/a?e={utcend}{{shift:start:-5m}}'))
      .toBe(`http://host/a?e=${END + 600}`);
  });

  it('fills catchup-id and channel-id, and keeps unknown variables', () => {
    expect(expand('{catchup-id}|${catchup-id}|{channel-id}|{token}|{x}', {
      catchupId: 'p1',
      channelId: 'ch1',
    })).toBe('p1|p1|ch1|{token}|{x}');
  });

  it('matches names case-insensitively', () => {
    expect(expand('{UTC}|${Start}|{LUTC}')).toBe(`${START}|${START}|${NOW}`);
  });
});

describe('expandLiveUrl', () => {
  it('fills only the current-time variables', () => {
    expect(expandLiveUrl('http://host/a?n={lutc}&t=${timestamp}&s={utc}', NOW))
      .toBe(`http://host/a?n=${NOW}&t=${NOW}&s={utc}`);
    expect(expandLiveUrl('http://host/a?d=${now:Ymd}', NOW)).toBe('http://host/a?d=20260102');
    expect(expandLiveUrl('http://host/a', NOW)).toBe('http://host/a');
  });
});
