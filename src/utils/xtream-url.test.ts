import { describe, it, expect } from 'vitest';
import {
  normalizeXtreamBaseUrl,
  xtreamPlaylistUrl,
  xtreamEpgUrl,
  xtreamPlayerApi,
  xtreamLiveUrl,
  xtreamVodUrl,
  xtreamEpisodeUrl,
  xtreamCatchupSource,
  xtreamCatchupFallbackSource,
  xtreamCatchupSources,
  xtreamCredentialsFromLiveUrl,
  xtreamLiveStreamId,
  formatXtreamCatchupStart,
  normalizeXtreamLiveOutputPreference,
  resolveXtreamLiveOutput,
} from './xtream-url';

const creds = { baseUrl: 'http://host:8080', username: 'u1', password: 'p1' };

describe('normalizeXtreamBaseUrl', () => {
  it('keeps a full scheme+host+port', () => {
    expect(normalizeXtreamBaseUrl('http://host:8080')).toBe('http://host:8080');
  });

  it('defaults a missing scheme to http', () => {
    expect(normalizeXtreamBaseUrl('host:8080')).toBe('http://host:8080');
  });

  it('preserves an https scheme', () => {
    expect(normalizeXtreamBaseUrl('https://host:8080')).toBe('https://host:8080');
  });

  it('keeps a host with no port', () => {
    expect(normalizeXtreamBaseUrl('http://host')).toBe('http://host');
  });

  it('strips a trailing slash', () => {
    expect(normalizeXtreamBaseUrl('http://host:8080/')).toBe('http://host:8080');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeXtreamBaseUrl('  host:8080  ')).toBe('http://host:8080');
  });
});

describe('xtreamPlaylistUrl', () => {
  it('builds get.php with m3u_plus + ts output', () => {
    expect(xtreamPlaylistUrl(creds)).toBe(
      'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts',
    );
  });

  it('requests HLS output when selected', () => {
    const url = new URL(xtreamPlaylistUrl(creds, 'm3u8'));
    expect(url.searchParams.get('output')).toBe('m3u8');
  });

  it('normalizes a scheme-less, trailing-slash base', () => {
    expect(xtreamPlaylistUrl({ ...creds, baseUrl: 'host:8080/' })).toBe(
      'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts',
    );
  });

  it('handles a base with no port', () => {
    expect(xtreamPlaylistUrl({ ...creds, baseUrl: 'http://host' })).toBe(
      'http://host/get.php?username=u1&password=p1&type=m3u_plus&output=ts',
    );
  });

  describe('resolveXtreamLiveOutput', () => {
    it('normalizes missing and invalid stored preferences to TS', () => {
      expect(normalizeXtreamLiveOutputPreference(undefined)).toBe('ts');
      expect(normalizeXtreamLiveOutputPreference('other')).toBe('ts');
    });

    it('honors explicit preferences', () => {
      expect(resolveXtreamLiveOutput('ts', ['m3u8'])).toBe('ts');
      expect(resolveXtreamLiveOutput('m3u8', [])).toBe('m3u8');
    });

    it('uses advertised HLS for auto and otherwise falls back to TS', () => {
      expect(resolveXtreamLiveOutput('auto', ['ts', 'm3u8'])).toBe('m3u8');
      expect(resolveXtreamLiveOutput('auto', ['ts'])).toBe('ts');
      expect(resolveXtreamLiveOutput(undefined, ['m3u8'])).toBe('ts');
    });
  });

  it('url-encodes credentials with reserved characters', () => {
    expect(xtreamPlaylistUrl({ ...creds, username: 'u/1', password: 'p&1' })).toBe(
      'http://host:8080/get.php?username=u%2F1&password=p%261&type=m3u_plus&output=ts',
    );
  });
});

describe('xtreamEpgUrl', () => {
  it('builds xmltv.php with credentials', () => {
    expect(xtreamEpgUrl(creds)).toBe('http://host:8080/xmltv.php?username=u1&password=p1');
  });
});

describe('xtreamPlayerApi', () => {
  it('builds the base player_api.php call with no action', () => {
    expect(xtreamPlayerApi(creds)).toBe('http://host:8080/player_api.php?username=u1&password=p1');
  });

  it('appends an action', () => {
    expect(xtreamPlayerApi(creds, 'get_vod_streams')).toBe(
      'http://host:8080/player_api.php?username=u1&password=p1&action=get_vod_streams',
    );
  });

  it('appends extra params after the action', () => {
    expect(xtreamPlayerApi(creds, 'get_vod_streams', { category_id: 5 })).toBe(
      'http://host:8080/player_api.php?username=u1&password=p1&action=get_vod_streams&category_id=5',
    );
  });
});

describe('xtreamVodUrl', () => {
  it('builds /movie/{user}/{pass}/{id}.{ext} on the normalized base', () => {
    expect(xtreamVodUrl(creds, '10', 'mp4')).toBe('http://host:8080/movie/u1/p1/10.mp4');
  });

  describe('xtreamLiveUrl', () => {
    it('builds the selected live stream format', () => {
      expect(xtreamLiveUrl(creds, '10', 'ts'))
        .toBe('http://host:8080/live/u1/p1/10.ts');
      expect(xtreamLiveUrl(creds, '10', 'm3u8'))
        .toBe('http://host:8080/live/u1/p1/10.m3u8');
    });

    it('URL-encodes credentials and the stream id', () => {
      expect(xtreamLiveUrl(
        { baseUrl: 'http://host', username: 'u 1', password: 'p/1' },
        'a/b',
        'ts',
      )).toBe('http://host/live/u%201/p%2F1/a%2Fb.ts');
    });
  });
  it('normalizes a bare host and strips a trailing slash', () => {
    expect(xtreamVodUrl({ baseUrl: 'host:8080/', username: 'u1', password: 'p1' }, '10', 'mkv'))
      .toBe('http://host:8080/movie/u1/p1/10.mkv');
  });
  it('URL-encodes credentials', () => {
    expect(xtreamVodUrl({ baseUrl: 'http://host', username: 'a b', password: 'p/1' }, '5', 'mp4'))
      .toBe('http://host/movie/a%20b/p%2F1/5.mp4');
  });
});

describe('xtreamEpisodeUrl', () => {
  it('builds /series/{user}/{pass}/{id}.{ext} on the normalized base', () => {
    expect(xtreamEpisodeUrl(creds, '42', 'mkv')).toBe('http://host:8080/series/u1/p1/42.mkv');
  });
});

describe('Xtream catch-up URLs', () => {
  it('recovers credentials and output from standard live URLs', () => {
    expect(xtreamCredentialsFromLiveUrl('http://host:8080/live/u%201/p%2F1/42.m3u8'))
      .toEqual({
        credentials: {
          baseUrl: 'http://host:8080',
          username: 'u 1',
          password: 'p/1',
        },
        streamId: '42',
        output: 'm3u8',
      });
    expect(xtreamCredentialsFromLiveUrl('http://host/u1/p1/43'))
      .toMatchObject({ streamId: '43', output: 'ts' });
  });

  it('does not infer credentials from unrelated or query-based URLs', () => {
    expect(xtreamCredentialsFromLiveUrl('http://host/proxy/play/42.ts')).toBeNull();
    expect(xtreamCredentialsFromLiveUrl('http://host/play?stream_id=42')).toBeNull();
    expect(xtreamCredentialsFromLiveUrl('not a url')).toBeNull();
  });

  it('builds the bounded TS-first catch-up candidate sequence', () => {
    expect(xtreamCatchupSources(creds, '42', 'ts')).toEqual([
      { kind: 'path-ts', url: 'http://host:8080/timeshift/u1/p1/{duration}/{start}/42.ts' },
      { kind: 'path-bare', url: 'http://host:8080/timeshift/u1/p1/{duration}/{start}/42' },
      { kind: 'path-hls', url: 'http://host:8080/timeshift/u1/p1/{duration}/{start}/42.m3u8' },
      {
        kind: 'legacy-ts',
        url: 'http://host:8080/streaming/timeshift.php?username=u1&password=p1'
          + '&stream=42&start={start}&duration={duration}&extension=ts',
      },
      {
        kind: 'legacy-bare',
        url: 'http://host:8080/streaming/timeshift.php?username=u1&password=p1'
          + '&stream=42&start={start}&duration={duration}',
      },
      {
        kind: 'legacy-hls',
        url: 'http://host:8080/streaming/timeshift.php?username=u1&password=p1'
          + '&stream=42&start={start}&duration={duration}&extension=m3u8',
      },
    ]);
  });

  it('puts HLS candidates first when HLS is selected', () => {
    expect(xtreamCatchupSources(creds, '42', 'm3u8').map(source => source.kind))
      .toEqual([
        'path-hls',
        'path-bare',
        'path-ts',
        'legacy-hls',
        'legacy-bare',
        'legacy-ts',
      ]);
  });

  it('builds a timeshift template with encoded credentials', () => {
    expect(xtreamCatchupSource(
      { baseUrl: 'http://host', username: 'u 1', password: 'p/1' },
      '42',
    )).toBe('http://host/timeshift/u%201/p%2F1/{duration}/{start}/42.ts');
  });

  it('builds the legacy PHP fallback template with encoded parameters', () => {
    expect(xtreamCatchupFallbackSource(
      { baseUrl: 'http://host', username: 'u 1', password: 'p&1' },
      '42',
    )).toBe(
      'http://host/streaming/timeshift.php?username=u%201&password=p%261&stream=42' +
      '&start={start}&duration={duration}&extension=ts',
    );
  });

  it('extracts ids from standard and query-based live URLs', () => {
    expect(xtreamLiveStreamId('http://host/live/u1/p1/42.ts')).toBe('42');
    expect(xtreamLiveStreamId('http://host/u1/p1/43.m3u8')).toBe('43');
    expect(xtreamLiveStreamId('http://host/play?stream_id=44')).toBe('44');
    expect(xtreamLiveStreamId('http://host/play?stream=45')).toBe('45');
    expect(xtreamLiveStreamId('http://host/play?id=46', new Set(['46']))).toBe('46');
    expect(xtreamLiveStreamId('http://host/play?id=46', new Set(['47']))).toBe('');
    expect(xtreamLiveStreamId('http://host/live/u1/p1/47.ts?stream_id=99')).toBe('47');
    expect(xtreamLiveStreamId('http://host/movie/u1/p1/42.mp4')).toBe('');
    expect(xtreamLiveStreamId('not a url')).toBe('');
  });

  it('formats UTC catch-up time when no provider clock is available', () => {
    expect(formatXtreamCatchupStart(Date.UTC(2026, 6, 21, 19, 30) / 1000))
      .toBe('2026-07-21:19-30');
  });

  it('formats catch-up time in the provider timezone', () => {
    expect(formatXtreamCatchupStart(
      Date.UTC(2026, 6, 21, 19, 30) / 1000,
      'America/New_York',
    )).toBe('2026-07-21:15-30');
  });

  it('uses the provider offset when its timezone is invalid', () => {
    expect(formatXtreamCatchupStart(
      Date.UTC(2026, 6, 21, 19, 30) / 1000,
      'Invalid/Zone',
      120,
    )).toBe('2026-07-21:21-30');
  });
});
