import { describe, it, expect } from 'vitest';
import {
  appendQuery,
  catchupTemplate,
  fillCatchupTemplate,
  flussonicCatchupSource,
  normalizeCatchupMode,
} from './catchup-url';

const times = { start: 1_700_000_000, end: 1_700_003_600, now: 1_700_010_000 };

function local(epochSeconds: number): Record<string, string> {
  const date = new Date(epochSeconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    Y: String(date.getFullYear()),
    m: pad(date.getMonth() + 1),
    d: pad(date.getDate()),
    H: pad(date.getHours()),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
  };
}

describe('normalizeCatchupMode', () => {
  it('lower-cases and folds the fs alias', () => {
    expect(normalizeCatchupMode(' Shift ')).toBe('shift');
    expect(normalizeCatchupMode('FS')).toBe('flussonic');
    expect(normalizeCatchupMode('')).toBe('');
  });
});

describe('appendQuery', () => {
  it('joins with ? or & as the URL needs', () => {
    expect(appendQuery('http://host/a.m3u8', 'utc=1')).toBe('http://host/a.m3u8?utc=1');
    expect(appendQuery('http://host/a.m3u8?k=v', 'utc=1')).toBe('http://host/a.m3u8?k=v&utc=1');
    expect(appendQuery('http://host/a.m3u8?k=v', '?utc=1')).toBe('http://host/a.m3u8?k=v&utc=1');
    expect(appendQuery('http://host/a.m3u8?', '&utc=1')).toBe('http://host/a.m3u8?utc=1');
  });

  it('keeps a fragment at the end', () => {
    expect(appendQuery('http://host/a.m3u8#x', 'utc=1')).toBe('http://host/a.m3u8?utc=1#x');
  });
});

describe('flussonicCatchupSource', () => {
  it('turns an HLS playlist into the fixed-window archive playlist', () => {
    expect(flussonicCatchupSource('http://host/ch1/mono.m3u8?k=v'))
      .toBe('http://host/ch1/mono-{utc}-{duration}.m3u8?k=v');
    expect(flussonicCatchupSource('https://host/ch1/index.m3u8'))
      .toBe('https://host/ch1/index-{utc}-{duration}.m3u8');
  });

  it('turns an MPEG-TS stream into the archive file', () => {
    expect(flussonicCatchupSource('http://host/ch1/mpegts?k=v'))
      .toBe('http://host/ch1/archive-{utc}-{duration}.ts?k=v');
  });

  it('returns nothing for a URL without a Flussonic shape', () => {
    expect(flussonicCatchupSource('http://host/ch1/stream.mp4')).toBe('');
    expect(flussonicCatchupSource('not a url')).toBe('');
  });
});

describe('catchupTemplate', () => {
  const url = 'http://host/ch1/mono.m3u8?k=v';

  it('appends the SIPTV query in shift mode', () => {
    expect(catchupTemplate('shift', url, '')).toBe(`${url}&utc={utc}&lutc={lutc}`);
  });

  it('appends the declared source in append mode', () => {
    expect(catchupTemplate('append', url, '&cutv={Y}-{m}-{d}')).toBe(`${url}&cutv={Y}-{m}-{d}`);
    expect(catchupTemplate('append', url, '')).toBe('');
  });

  it('derives the archive URL in flussonic mode', () => {
    expect(catchupTemplate('flussonic', url, '')).toBe('http://host/ch1/mono-{utc}-{duration}.m3u8?k=v');
  });

  it('keeps a declared source over a derived one', () => {
    expect(catchupTemplate('shift', url, 'http://host/c?t={utc}')).toBe('http://host/c?t={utc}');
    expect(catchupTemplate('flussonic', url, 'http://host/c?t={utc}')).toBe('http://host/c?t={utc}');
  });

  it('uses the declared source as is in default mode and without a mode', () => {
    expect(catchupTemplate('default', url, 'http://host/c?t={utc}')).toBe('http://host/c?t={utc}');
    expect(catchupTemplate('', url, '')).toBe('');
  });
});

describe('fillCatchupTemplate', () => {
  it('fills the epoch specifiers and their aliases', () => {
    expect(fillCatchupTemplate(
      'a={utc}&b=${start}&c={utcend}&d=${end}&e={lutc}&f=${now}&g=${timestamp}',
      times,
    )).toBe('a=1700000000&b=1700000000&c=1700003600&d=1700003600&e=1700010000&f=1700010000&g=1700010000');
  });

  it('fills every occurrence', () => {
    expect(fillCatchupTemplate('{utc}/{utc}', times)).toBe('1700000000/1700000000');
  });

  it('fills duration and offset with optional dividers', () => {
    expect(fillCatchupTemplate('{duration} ${duration} {duration:60}', times)).toBe('3600 3600 60');
    expect(fillCatchupTemplate('${offset} {offset:60}', times)).toBe('10000 166');
  });

  it('treats a zero divider as 1', () => {
    expect(fillCatchupTemplate('{duration:0}', times)).toBe('3600');
  });

  it('fills start date parts in local time', () => {
    const p = local(times.start);
    expect(fillCatchupTemplate('{Y}-{m}-{d}T{H}:{M}:{S}', times))
      .toBe(`${p.Y}-${p.m}-${p.d}T${p.H}:${p.M}:${p.S}`);
  });

  it('formats timestamp specifiers that carry a format string', () => {
    const s = local(times.start);
    const e = local(times.end);
    expect(fillCatchupTemplate('?start={utc:YmdHM}&end=${end:Ymd-H-M}', times))
      .toBe(`?start=${s.Y}${s.m}${s.d}${s.H}${s.M}&end=${e.Y}${e.m}${e.d}-${e.H}-${e.M}`);
  });

  it('leaves unknown placeholders alone', () => {
    expect(fillCatchupTemplate('{start}/{channel-id}/{x}', times)).toBe('{start}/{channel-id}/{x}');
  });

  it('writes a literal $ in the output only where the template has one', () => {
    expect(fillCatchupTemplate('p=$x&t=${start}', times)).toBe('p=$x&t=1700000000');
  });
});
