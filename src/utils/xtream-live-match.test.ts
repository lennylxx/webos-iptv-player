import { describe, expect, it } from 'vitest';
import {
  createXtreamLiveStreamIdResolver,
  createXtreamStreamLocationPrefilter,
} from './xtream-live-match';

describe('createXtreamLiveStreamIdResolver', () => {
  const resolveStreamId = createXtreamLiveStreamIdResolver([
    { streamId: '101', directSource: '' },
    { streamId: '102', directSource: '' },
    { streamId: '103', directSource: 'https://host/token/c?x=1&token=old' },
  ]);

  it('matches standard, explicit-query, and direct-source Live identities', () => {
    expect(resolveStreamId('http://host/live/u1/p1/101.ts')).toBe('101');
    expect(resolveStreamId('http://host/u1/p1/101')).toBe('101');
    expect(resolveStreamId('http://host/play?stream_id=102')).toBe('102');
    expect(resolveStreamId('http://host/play?stream=102')).toBe('102');
    expect(resolveStreamId('https://host/token/c?token=new&x=1')).toBe('103');
  });

  it('does not infer identity from arbitrary paths or generic id parameters', () => {
    expect(resolveStreamId('http://host/vod/u1/p1/101.mkv')).toBe('');
    expect(resolveStreamId('http://host/proxy/live/101.ts')).toBe('');
    expect(resolveStreamId('http://host/play?id=101')).toBe('');
    expect(resolveStreamId('not a url')).toBe('');
  });

  it('matches standard Live paths relative to a path-prefixed portal', () => {
    const prefixed = createXtreamLiveStreamIdResolver([
      { streamId: '101', directSource: '' },
    ], 'http://host/panel');

    expect(prefixed('http://host/panel/live/u1/p1/101.ts')).toBe('101');
    expect(prefixed('http://host/live/u1/p1/101.ts')).toBe('101');
    expect(prefixed('https://cdn/live/u1/p1/101.ts')).toBe('101');
  });

  it('rejects query-id collisions on explicit VOD routes', () => {
    expect(resolveStreamId('http://host/movie/u1/p1/201.mp4?stream_id=101')).toBe('');
    expect(resolveStreamId('http://host/series/u1/p1/201.mkv?stream=102')).toBe('');
    expect(resolveStreamId('http://host/vod/u1/p1/201.mkv?stream_id=101')).toBe('');
  });

  it('keeps an authoritative direct source even when its path resembles VOD', () => {
    const direct = createXtreamLiveStreamIdResolver([
      {
        streamId: '201',
        directSource: 'https://host/movie/u1/p1/live.ts?token=old',
      },
    ]);

    expect(direct('https://host/movie/u1/p1/live.ts?token=new')).toBe('201');
  });

  it('does not use an ambiguous normalized direct source', () => {
    const ambiguous = createXtreamLiveStreamIdResolver([
      { streamId: '201', directSource: 'https://host/play?token=a' },
      { streamId: '202', directSource: 'https://host/play?token=b' },
    ]);

    expect(ambiguous('https://host/play?token=c')).toBe('');
    expect(ambiguous('https://host/play?token=a')).toBe('201');
  });

  it('does not choose arbitrarily between duplicate exact direct sources', () => {
    const ambiguous = createXtreamLiveStreamIdResolver([
      { streamId: '201', directSource: 'https://host/play' },
      { streamId: '202', directSource: 'https://host/play' },
    ]);

    expect(ambiguous('https://host/play')).toBe('');
  });
});

describe('createXtreamStreamLocationPrefilter', () => {
  it('rejects only canonical movie and series paths', () => {
    const shouldParse = createXtreamStreamLocationPrefilter([], 'host/panel');

    expect(shouldParse('http://host/panel/movie/u1/p1/201.mp4')).toBe(false);
    expect(shouldParse('http://host/panel/series/u1/p1/301.mkv')).toBe(false);
    expect(shouldParse('http://host/proxy/movie/u1/p1/202.mp4')).toBe(true);
    expect(shouldParse('http://host/panel/vod/u1/p1/203.mkv')).toBe(false);
    expect(shouldParse('http://host/panel/movie/u1/p1/204')).toBe(true);
    expect(shouldParse('not a url')).toBe(true);
  });

  it('keeps entries whose base path already holds a kind segment', () => {
    const shouldParse = createXtreamStreamLocationPrefilter([], 'host/movie');

    expect(shouldParse('http://host/movie/series/u1/p1/301.mkv')).toBe(true);
    expect(shouldParse('http://host/other/series/u1/p1/301.mkv')).toBe(true);
    expect(shouldParse('http://host/series/u1/p1/301.mkv')).toBe(false);
  });

  it('keeps entries whose host is named like a kind segment', () => {
    const shouldParse = createXtreamStreamLocationPrefilter([]);

    expect(shouldParse('http://movie/movie/u1/p1/201.mp4')).toBe(true);
    expect(shouldParse('https://vod/series/u1/p1/301.mkv')).toBe(true);
    expect(shouldParse('http://host/series/u1/p1/301.mkv')).toBe(false);
  });

  it('keeps authoritative direct sources for the post filter', () => {
    const shouldParse = createXtreamStreamLocationPrefilter([{
      streamId: '201',
      directSource: 'https://host/movie/u1/p1/201.ts?token=old',
    }]);

    expect(shouldParse('https://host/movie/u1/p1/201.ts?token=new')).toBe(true);
  });

  it('rejects an ambiguous normalized direct source', () => {
    const shouldParse = createXtreamStreamLocationPrefilter([
      {
        streamId: '201',
        directSource: 'https://host/movie/u1/p1/201.ts?token=a',
      },
      {
        streamId: '202',
        directSource: 'https://host/movie/u1/p1/201.ts?token=b',
      },
    ]);

    expect(shouldParse('https://host/movie/u1/p1/201.ts?token=a')).toBe(true);
    expect(shouldParse('https://host/movie/u1/p1/201.ts?token=c')).toBe(false);
  });
});
