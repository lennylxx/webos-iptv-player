import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fetchTextMock } = vi.hoisted(() => ({ fetchTextMock: vi.fn() }));
vi.mock('../utils/fetch-helper', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/fetch-helper')>(),
  fetchLimitedText: fetchTextMock,
}));

import { FetchTextError } from '../utils/fetch-helper';
import { CONFIG } from '../config';
import { createXtreamClient } from './xtream-client';

const creds = { baseUrl: 'http://host:8080', username: 'u1', password: 'p1' };

beforeEach(() => vi.clearAllMocks());

describe('XtreamClient.getAccountInfo', () => {
  it('queries the base player_api.php endpoint (no action)', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ user_info: { auth: 1 } }));
    await createXtreamClient(creds).getAccountInfo();
    expect(fetchTextMock).toHaveBeenCalledWith(
      'http://host:8080/player_api.php?username=u1&password=p1',
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it('parses an active account', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      user_info: {
        auth: 1,
        status: 'Active',
        exp_date: '1700000000',
        max_connections: '2',
        active_cons: '1',
      },
    }));
    expect(await createXtreamClient(creds).getAccountInfo()).toEqual({
      auth: true,
      status: 'Active',
      expiresAt: 1700000000,
      maxConnections: 2,
      activeConnections: 1,
      allowedOutputFormats: [],
    });
  });

  // Mirrors the authentic XUI.one player_api.php payload: a fat object with a
  // string/int type mix (auth + active_cons are ints; exp_date/max_connections
  // are strings) and many sibling fields we must ignore. Identifiers stay
  // synthetic per the repo convention.
  it('parses an authentic full payload (int active_cons, extra fields ignored)', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      user_info: {
        username: 'u1', password: 'p1', message: 'Welcome',
        auth: 1, status: 'Active', exp_date: '1700000000', is_trial: '0',
        active_cons: 0, created_at: '1690000000', max_connections: '5',
        allowed_output_formats: ['ts', 'm3u8', 'rtmp'],
      },
      server_info: { url: 'host', port: '8080', timezone: 'UTC' },
    }));
    expect(await createXtreamClient(creds).getAccountInfo()).toEqual({
      auth: true,
      status: 'Active',
      expiresAt: 1700000000,
      maxConnections: 5,
      activeConnections: 0,
      allowedOutputFormats: ['ts', 'm3u8', 'rtmp'],
    });
  });

  it('filters invalid output format entries', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      user_info: { auth: 1, allowed_output_formats: ['ts', 1, null, 'm3u8'] },
    }));
    expect((await createXtreamClient(creds).getAccountInfo())?.allowedOutputFormats)
      .toEqual(['ts', 'm3u8']);
  });

  it('reports auth:0 as a failed login (not null)', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ user_info: { auth: 0 } }));
    const info = await createXtreamClient(creds).getAccountInfo();
    expect(info).not.toBeNull();
    expect(info!.auth).toBe(false);
  });

  it('treats a null exp_date as unlimited', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      user_info: { auth: 1, status: 'Active', exp_date: null, max_connections: '1', active_cons: '0' },
    }));
    const info = await createXtreamClient(creds).getAccountInfo();
    expect(info!.expiresAt).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    fetchTextMock.mockResolvedValue('<html>not json</html>');
    expect(await createXtreamClient(creds).getAccountInfo()).toBeNull();
  });

  it('returns null when user_info is missing', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ server_info: {} }));
    expect(await createXtreamClient(creds).getAccountInfo()).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchTextMock.mockRejectedValue(new Error('timeout'));
    expect(await createXtreamClient(creds).getAccountInfo()).toBeNull();
  });
});

describe('XtreamClient live archive metadata', () => {
  it('normalizes archive flags and retention days', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { stream_id: 10, tv_archive: 1, tv_archive_duration: '7' },
      { stream_id: '11', tv_archive: '0', tv_archive_duration: 0 },
      { tv_archive: 1, tv_archive_duration: 3 },
    ]));
    expect(await createXtreamClient(creds).getLiveStreams()).toEqual([
      { streamId: '10', archive: true, archiveDurationDays: 7 },
      { streamId: '11', archive: false, archiveDurationDays: 0 },
    ]);
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_live_streams'),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it('reads the provider timezone and derives its fixed-offset fallback', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      server_info: {
        timezone: 'Etc/GMT-2',
        timestamp_now: 1784665800,
        time_now: '2026-07-21 22:30:00',
      },
    }));
    expect(await createXtreamClient(creds).getServerClock()).toEqual({
      timeZone: 'Etc/GMT-2',
      offsetMinutes: 120,
    });
  });

  it('returns safe empty values when archive endpoints fail', async () => {
    fetchTextMock.mockResolvedValue('<html>nope</html>');
    expect(await createXtreamClient(creds).getLiveStreams()).toEqual([]);
    expect(await createXtreamClient(creds).getServerClock()).toBeNull();
  });
});

describe('XtreamClient program archive listings', () => {
  it('parses timestamps and explicit has_archive flags', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      epg_listings: [
        { start_timestamp: '1709978400', stop_timestamp: '1709982000', has_archive: 1 },
        { start_timestamp: 1709982000, stop_timestamp: 1709985600, has_archive: '0' },
        { start_timestamp: '1709985600', stop_timestamp: '1709989200' },
      ],
    }));
    expect(await createXtreamClient(creds).getArchiveListings('101')).toEqual([
      { start: 1709978400, stop: 1709982000, hasArchive: true },
      { start: 1709982000, stop: 1709985600, hasArchive: false },
      { start: 1709985600, stop: 1709989200, hasArchive: null },
    ]);
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/action=get_simple_data_table.*stream_id=101/),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it('drops malformed time ranges', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      epg_listings: [
        { start_timestamp: 0, stop_timestamp: 1, has_archive: 1 },
        { start_timestamp: 100, stop_timestamp: 100, has_archive: 1 },
        { start_timestamp: 100, stop_timestamp: 200, has_archive: 1 },
      ],
    }));
    expect(await createXtreamClient(creds).getArchiveListings('101')).toEqual([
      { start: 100, stop: 200, hasArchive: true },
    ]);
  });

  it('returns null when the endpoint is unsupported or malformed', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ server_info: {} }));
    expect(await createXtreamClient(creds).getArchiveListings('101')).toBeNull();
    fetchTextMock.mockResolvedValue('<html>nope</html>');
    expect(await createXtreamClient(creds).getArchiveListings('101')).toBeNull();
  });
});

describe('XtreamClient VOD', () => {
  it('lists VOD categories, dropping entries with no id', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { category_id: '1', category_name: 'Cat A' },
      { category_name: 'no id' },
    ]));
    const cats = await createXtreamClient(creds).getVodCategories();
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_vod_categories'),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(cats).toEqual([{ id: '1', name: 'Cat A' }]);
  });

  it('maps VOD streams and stamps the accountId', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { stream_id: 10, name: 'Movie One', stream_icon: 'http://host/a.png',
        rating: '7.5', category_id: '1', container_extension: 'mp4' },
    ]));
    const items = await createXtreamClient(creds, 'acc1').getVodStreams('1');
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/action=get_vod_streams.*category_id=1/),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(items).toEqual([{
      accountId: 'acc1', streamId: '10', name: 'Movie One', poster: 'http://host/a.png',
      rating: '7.5', categoryId: '1', containerExtension: 'mp4',
    }]);
  });

  it('getVodStreams with no category omits the category_id param', async () => {
    fetchTextMock.mockResolvedValue('[]');
    await createXtreamClient(creds).getVodStreams();
    const noCatUrl = fetchTextMock.mock.calls[fetchTextMock.mock.calls.length - 1][0];
    expect(noCatUrl).toContain('action=get_vod_streams');
    expect(noCatUrl).not.toContain('category_id');
  });

  it('parses VOD info, tolerating alternate field names', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      info: { plot: 'A plot', cast: 'Actor', director: 'Dir', genre: 'Drama',
        release_date: '2020-01-01', duration_secs: 5400, cover_big: 'http://host/p.png' },
      movie_data: { stream_id: 10 },
    }));
    const info = await createXtreamClient(creds).getVodInfo('10');
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/action=get_vod_info.*vod_id=10/),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(info).toEqual({
      plot: 'A plot', cast: 'Actor', director: 'Dir', genre: 'Drama',
      releaseDate: '2020-01-01', durationSecs: 5400, poster: 'http://host/p.png', subtitles: [],
      imdbId: '', tmdbId: '', year: 2020,
    });
  });

  it('classifies malformed catalog JSON instead of returning an empty catalog', async () => {
    fetchTextMock.mockResolvedValue('<html>not json</html>');
    await expect(createXtreamClient(creds).getVodCategories())
      .rejects.toMatchObject({ code: 'invalid_json' });
    await expect(createXtreamClient(creds).getVodStreams())
      .rejects.toMatchObject({ code: 'invalid_json' });
    await expect(createXtreamClient(creds).getVodInfo('10'))
      .rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('bounds catalog responses and forwards cancellation', async () => {
    const controller = new AbortController();
    fetchTextMock.mockResolvedValue('[]');

    await createXtreamClient(creds).getVodStreams('1', controller.signal);

    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_vod_streams'),
      CONFIG.XTREAM.CATALOG_MAX_BYTES,
      expect.any(Number),
      controller.signal,
    );
  });

  it('classifies oversized and cancelled catalog requests', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchTextMock.mockRejectedValueOnce(
      new FetchTextError('too_large', 'Response exceeds limit'),
    );
    await expect(createXtreamClient(creds).getVodStreams())
      .rejects.toMatchObject({ code: 'too_large' });
    expect(warn).toHaveBeenCalledWith(
      '[Xtream]',
      'Xtream request failed',
      'event=xtream.request.failed',
      'endpoint=get_vod_streams',
      'code=too_large',
      'timeoutMs=30000',
      `limitBytes=${CONFIG.XTREAM.CATALOG_MAX_BYTES}`,
    );

    warn.mockClear();
    fetchTextMock.mockRejectedValueOnce(
      new FetchTextError('aborted', 'Request was cancelled'),
    );
    await expect(createXtreamClient(creds).getVodStreams())
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses VOD sidecar subtitles, keeping only http(s)-URL entries', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      info: {
        plot: 'p',
        subtitles: [
          { subtitle_id: '1', title: 'Track 1', language: 'l1', url: 'http://host/a.srt' },
          { subtitle_id: '2', title: 'Track 2', language: 'l2', url: 'https://host/b.vtt' },
          { subtitle_id: '3', title: 'Track 3', language: 'l3', url: 'ftp://host/c' }, // non-http → dropped
          { subtitle_id: '4', title: 'Track 4', language: 'l4' },                      // no url → dropped
        ],
      },
      movie_data: { stream_id: 10 },
    }));
    const info = await createXtreamClient(creds).getVodInfo('10');
    expect(info!.subtitles).toEqual([
      { id: '1', name: 'Track 1', lang: 'l1', url: 'http://host/a.srt' },
      { id: '2', name: 'Track 2', lang: 'l2', url: 'https://host/b.vtt' },
    ]);
  });

  it('defaults VOD subtitles to [] when the field is absent', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ info: { plot: 'p' }, movie_data: {} }));
    expect((await createXtreamClient(creds).getVodInfo('10'))!.subtitles).toEqual([]);
  });

  it('parses tmdb/imdb/year from get_vod_info', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      info: { tmdb_id: '27205', imdb_id: 'tt1375666', releasedate: '2010-07-16', plot: 'p', subtitles: [] },
      movie_data: {},
    }));
    const info = await createXtreamClient(creds).getVodInfo('10');
    expect(info).toMatchObject({ tmdbId: '27205', imdbId: '1375666', year: 2010 });
  });
});

describe('XtreamClient Series', () => {
  it('lists series categories, dropping entries with no id', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { category_id: '2', category_name: 'Cat B' },
      { category_name: 'no id' },
    ]));
    const cats = await createXtreamClient(creds).getSeriesCategories();
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_series_categories'),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(cats).toEqual([{ id: '2', name: 'Cat B' }]);
  });

  it('maps series and stamps the accountId', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { series_id: 7, name: 'Series One', cover: 'http://host/c.png', rating: '8', category_id: '2' },
    ]));
    const items = await createXtreamClient(creds, 'acc1').getSeries('2');
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/action=get_series.*category_id=2/),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(items).toEqual([{
      accountId: 'acc1', seriesId: '7', name: 'Series One', poster: 'http://host/c.png',
      rating: '8', categoryId: '2',
    }]);
  });

  it('parses series info into sorted seasons + episodesBySeason', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      seasons: [],
      episodes: {
        '2': [{ id: '201', title: 'S2E1', episode_num: 1, container_extension: 'mkv',
          info: { duration_secs: 1200, plot: 'p2', movie_image: 'http://host/2.png' } }],
        '1': [{ id: '101', title: 'S1E1', episode_num: 1, container_extension: 'mp4',
          info: { duration_secs: 1000, plot: 'p1', movie_image: 'http://host/1.png' } }],
      },
    }));
    const info = await createXtreamClient(creds).getSeriesInfo('7');
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/action=get_series_info.*series_id=7/),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(info!.seasons).toEqual([1, 2]);
    expect(info!.episodesBySeason[1]).toEqual([{
      id: '101', title: 'S1E1', season: 1, episode: 1, containerExtension: 'mp4',
      durationSecs: 1000, plot: 'p1', poster: 'http://host/1.png', subtitles: [],
    }]);
    expect(info!.episodesBySeason[2][0].id).toBe('201');
  });

  it('classifies malformed series JSON instead of returning an empty catalog', async () => {
    fetchTextMock.mockResolvedValue('nope');
    await expect(createXtreamClient(creds).getSeriesCategories())
      .rejects.toMatchObject({ code: 'invalid_json' });
    await expect(createXtreamClient(creds).getSeries())
      .rejects.toMatchObject({ code: 'invalid_json' });
    await expect(createXtreamClient(creds).getSeriesInfo('7'))
      .rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('getSeriesInfo returns empty seasons when episodes is absent', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({ info: { name: 'x' } }));
    const info = await createXtreamClient(creds).getSeriesInfo('7');
    expect(info).toEqual({ seasons: [], episodesBySeason: {} });
  });

  it('parses per-episode sidecar subtitles from the episode info block', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      episodes: {
        '1': [{ id: '101', title: 'S1E1', episode_num: 1, container_extension: 'mkv',
          info: {
            duration_secs: 1000, plot: 'p', movie_image: 'http://host/1.png',
            subtitles: [{ subtitle_id: '1', title: 'Track 1', language: 'l1', url: 'http://host/e.srt' }],
          } }],
      },
    }));
    const info = await createXtreamClient(creds).getSeriesInfo('7');
    expect(info!.episodesBySeason[1][0].subtitles).toEqual([
      { id: '1', name: 'Track 1', lang: 'l1', url: 'http://host/e.srt' },
    ]);
  });
});
