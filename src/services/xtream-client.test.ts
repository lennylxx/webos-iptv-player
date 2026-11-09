import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { fetchTextMock } = vi.hoisted(() => ({ fetchTextMock: vi.fn() }));
vi.mock('../utils/fetch-helper', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/fetch-helper')>(),
  fetchLimitedText: fetchTextMock,
}));

const { runWorkerTaskMock, retained } = vi.hoisted(() => ({ runWorkerTaskMock: vi.fn(), retained: { count: 0 } }));
vi.mock('../workers/app-worker-client', () => ({
  runAppWorkerTask: runWorkerTaskMock,
  retainAppWorker: () => {
    retained.count++;
    let held = true;
    return () => {
      if (held) retained.count--;
      held = false;
    };
  },
}));

import { FetchTextError } from '../utils/fetch-helper';
import { CONFIG } from '../config';
import { createXtreamClient, loadLiveStreamsCatalog } from './xtream-client';
import { heldRecord, releaseHeldRecord } from './held-records';

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
  it('lists live categories', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { category_id: 1, category_name: 'Alpha', parent_id: 0 },
      { category_name: 'missing id' },
    ]));
    expect(await createXtreamClient(creds).getLiveCategories()).toEqual([
      { id: '1', name: 'Alpha', parentId: '0' },
    ]);
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_live_categories'),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it('normalizes archive flags and retention days', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      {
        stream_id: 10,
        name: 'Alpha',
        stream_icon: 'http://host/a.png',
        epg_channel_id: 'epg-1',
        category_id: 2,
        direct_source: 'http://host/direct/10',
        tv_archive: 1,
        tv_archive_duration: '7',
      },
      { stream_id: '11', tv_archive: '0', tv_archive_duration: 0 },
      { tv_archive: 1, tv_archive_duration: 3 },
    ]));
    expect(await createXtreamClient(creds).getLiveStreams()).toEqual([
      {
        streamId: '10',
        name: 'Alpha',
        icon: 'http://host/a.png',
        epgChannelId: 'epg-1',
        categoryId: '2',
        categoryIds: ['2'],
        directSource: 'http://host/direct/10',
        archive: true,
        archiveDurationDays: 7,
      },
      {
        streamId: '11',
        name: '',
        icon: '',
        epgChannelId: '',
        categoryId: '',
        categoryIds: [],
        directSource: '',
        archive: false,
        archiveDurationDays: 0,
      },
    ]);
    expect(fetchTextMock).toHaveBeenCalledWith(
      expect.stringContaining('action=get_live_streams'),
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
  });

  it('merges category_ids with category_id for multi-category streams', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { stream_id: 1, category_id: '3', category_ids: [3, 4, '', 4] },
      { stream_id: 2, category_ids: [5] },
      { stream_id: 3, category_id: '6', category_ids: 'bad' },
    ]));
    const streams = await createXtreamClient(creds).getLiveStreams();
    expect(streams.map(stream => stream.categoryIds)).toEqual([['3', '4'], ['5'], ['6']]);
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

  it('distinguishes an empty Live catalog from an unavailable endpoint', async () => {
    fetchTextMock.mockResolvedValueOnce('[]');
    expect(await createXtreamClient(creds).getLiveStreamsResult()).toEqual({
      available: true,
      streams: [],
    });

    fetchTextMock.mockResolvedValueOnce('<html>nope</html>');
    expect(await createXtreamClient(creds).getLiveStreamsResult()).toEqual({
      available: false,
      streams: [],
    });
  });
});

describe('Xtream Live catalog in the app worker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses the catalog off the UI thread when a worker is available', async () => {
    vi.stubGlobal('Worker', class {});
    runWorkerTaskMock.mockResolvedValueOnce({ available: true, streams: [] });
    expect(await createXtreamClient(creds).getLiveStreamsResult()).toEqual({
      available: true,
      streams: [],
    });
    expect(runWorkerTaskMock).toHaveBeenCalledWith('xtream.live-streams', expect.objectContaining({
      url: expect.stringContaining('action=get_live_streams'),
    }));
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('falls back to this thread when the worker fails', async () => {
    vi.stubGlobal('Worker', class {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWorkerTaskMock.mockRejectedValueOnce(new Error('worker crashed'));
    fetchTextMock.mockResolvedValueOnce('[{"stream_id":1,"name":"ch1"}]');
    const result = await createXtreamClient(creds).getLiveStreamsResult();
    expect(result.available).toBe(true);
    expect(result.streams).toHaveLength(1);
    expect(fetchTextMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Xtream]',
      'Xtream live catalog worker failed',
      'event=xtream.live_catalog.worker_failed',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('keeps a request failure the worker reports without refetching', async () => {
    vi.stubGlobal('Worker', class {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runWorkerTaskMock.mockResolvedValueOnce({ available: false, streams: [], failure: 'invalid_json' });
    expect(await createXtreamClient(creds).getLiveStreamsResult())
      .toEqual({ available: false, streams: [] });
    expect(fetchTextMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns a failure code instead of throwing in the worker', async () => {
    const request = { url: 'http://host/a', timeout: 1000, maxBytes: 1000 };
    fetchTextMock.mockResolvedValueOnce('<html>nope</html>');
    expect(await loadLiveStreamsCatalog(request))
      .toEqual({ available: false, streams: [], failure: 'invalid_json' });
    fetchTextMock.mockResolvedValueOnce('[{"stream_id":1,"name":"ch1"}]');
    const loaded = await loadLiveStreamsCatalog(request);
    expect(loaded.available).toBe(true);
    expect(loaded.streams).toHaveLength(1);
    expect(loaded.failure).toBeUndefined();
  });
});

describe('whole Xtream catalog in the app worker', () => {
  const item = { accountId: 'x1', streamId: '1', categoryId: '1' };
  function holdStream() {
    let finish: (response: object) => void = () => {};
    runWorkerTaskMock.mockImplementation((task: string, _payload: unknown, onChunk?: (chunk: object) => void) => {
      if (task !== 'xtream.catalog-stream') return Promise.resolve();
      return new Promise((resolve) => {
        finish = (response) => {
          onChunk?.({ kind: 'vod', items: [item] });
          resolve(response);
        };
      });
    });
    return {
      finish: () => finish({ items: 1, inputBytes: 1, elapsedMs: 1, held: { token: 'h1', bytes: 10 } }),
    };
  }
  const tasks = () => runWorkerTaskMock.mock.calls.map(call => call[0] as string);

  it('shares one load between callers asking at once', async () => {
    const stream = holdStream();
    const client = createXtreamClient(creds);
    const first = client.getAllVodStreams(['1']);
    const second = client.getAllVodStreams(['1']);
    stream.finish();
    const list = await first;
    expect(list).toEqual([item]);
    expect(await second).toBe(list);
    expect(heldRecord(list)?.bytes).toBe(10);
    expect(tasks()).toEqual(['xtream.catalog-stream']);
  });

  it('keeps the worker running while it holds a list for the page', async () => {
    vi.useFakeTimers();
    try {
      const base = retained.count;
      const client = createXtreamClient(creds);
      let stream = holdStream();
      let load = client.getAllVodStreams(['1']);
      stream.finish();
      const cached = await load;
      expect(retained.count).toBe(base + 1);
      releaseHeldRecord(cached);
      expect(retained.count).toBe(base);

      stream = holdStream();
      load = client.getAllVodStreams(['2']);
      stream.finish();
      const forgotten = await load;
      expect(retained.count).toBe(base + 1);
      vi.advanceTimersByTime(CONFIG.XTREAM.HELD_LIST_MS);
      expect(retained.count).toBe(base);
      expect(heldRecord(forgotten)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the list a load held when every caller canceled it first', async () => {
    const stream = holdStream();
    const a = new AbortController();
    const load = createXtreamClient(creds).getAllVodStreams(['1'], a.signal);
    a.abort();
    await expect(load).rejects.toMatchObject({ code: 'cancelled' });
    stream.finish();
    await vi.waitFor(() => expect(runWorkerTaskMock).toHaveBeenLastCalledWith('cache.release-held', { token: 'h1' }));
  });

  it('cancels the worker load once every caller has aborted', async () => {
    holdStream();
    const client = createXtreamClient(creds);
    const a = new AbortController();
    const b = new AbortController();
    const first = client.getAllVodStreams(['1'], a.signal);
    const second = client.getAllVodStreams(['1'], b.signal);
    a.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    expect(tasks()).toEqual(['xtream.catalog-stream']);
    b.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    const token = (runWorkerTaskMock.mock.calls[0][1] as { token: string }).token;
    expect(runWorkerTaskMock).toHaveBeenLastCalledWith('xtream.catalog-stream.cancel', { token });
  });

  it('starts a new load after a canceled one', async () => {
    const stream = holdStream();
    const client = createXtreamClient(creds);
    const a = new AbortController();
    const first = client.getAllVodStreams(['1'], a.signal);
    a.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const second = client.getAllVodStreams(['1']);
    stream.finish();
    expect(await second).toEqual([item]);
    expect(tasks().filter(task => task === 'xtream.catalog-stream')).toHaveLength(2);
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

  it('falls back to the historical get_simple_date_table spelling', async () => {
    fetchTextMock
      .mockResolvedValueOnce(JSON.stringify({ server_info: {} }))
      .mockResolvedValueOnce(JSON.stringify({
        epg_listings: [
          { start_timestamp: 100, stop_timestamp: 200, has_archive: 1 },
        ],
      }));

    expect(await createXtreamClient(creds).getArchiveListings('101')).toEqual([
      { start: 100, stop: 200, hasArchive: true },
    ]);
    expect(fetchTextMock.mock.calls.map(([url]) => new URL(url).searchParams.get('action')))
      .toEqual(['get_simple_data_table', 'get_simple_date_table']);
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

  describe('VOD sort metadata', () => {
    const vodRow = (extra: Record<string, unknown>, id = 10) => ({
      stream_id: id, name: `Movie ${id}`, category_id: '1', ...extra,
    });
    const mapOne = async (extra: Record<string, unknown>) => {
      fetchTextMock.mockResolvedValue(JSON.stringify([vodRow(extra)]));
      const [item] = await createXtreamClient(creds).getVodStreams('1');
      return { addedAt: item.addedAt, year: item.year, keys: Object.keys(item) };
    };

    it('converts Unix-second and millisecond added values to milliseconds', async () => {
      expect((await mapOne({ added: '1700000000' })).addedAt).toBe(1700000000000);
      expect((await mapOne({ added: 1700000000 })).addedAt).toBe(1700000000000);
      expect((await mapOne({ added: ' 1700000000 ' })).addedAt).toBe(1700000000000);
      expect((await mapOne({ added: '1700000000123' })).addedAt).toBe(1700000000123);
    });

    it('parses ISO-like added dates', async () => {
      expect((await mapOne({ added: '2023-05-01' })).addedAt).toBe(Date.parse('2023-05-01'));
      expect((await mapOne({ added: '2023-05-01T10:20:30Z' })).addedAt)
        .toBe(Date.UTC(2023, 4, 1, 10, 20, 30));
    });

    it('omits invalid or non-positive added values', async () => {
      for (const added of ['', '   ', '0', '-5', 'abc', '2023-13-45', null, {}, true]) {
        const mapped = await mapOne({ added });
        expect(mapped.addedAt).toBeUndefined();
        expect(mapped.keys).not.toContain('addedAt');
      }
    });

    it('does not use last_modified for VOD added time', async () => {
      expect((await mapOne({ last_modified: '1700000000' })).addedAt).toBeUndefined();
    });

    it('reads the year from year and release-date aliases in order', async () => {
      expect((await mapOne({ year: '2020' })).year).toBe(2020);
      expect((await mapOne({ year: 2019 })).year).toBe(2019);
      expect((await mapOne({ releaseDate: '2018-03-04' })).year).toBe(2018);
      expect((await mapOne({ release_date: '2017/01/02' })).year).toBe(2017);
      expect((await mapOne({ releasedate: '2016' })).year).toBe(2016);
      expect((await mapOne({ year: '2021', releaseDate: '2010-01-01' })).year).toBe(2021);
    });

    it('falls back to a later alias when an earlier one is unusable', async () => {
      expect((await mapOne({ year: '', releaseDate: '2015-06-07' })).year).toBe(2015);
      expect((await mapOne({ year: 'N/A', release_date: '2014-01-01' })).year).toBe(2014);
      expect((await mapOne({ year: '0000', releasedate: '2013' })).year).toBe(2013);
    });

    it('omits malformed years', async () => {
      for (const year of ['', '0000', '20', '20201', 'May 2020', '07/05/2020', null, {}]) {
        const mapped = await mapOne({ year });
        expect(mapped.year).toBeUndefined();
        expect(mapped.keys).not.toContain('year');
      }
    });

    it('maps each list item independently without detail requests', async () => {
      fetchTextMock.mockResolvedValue(JSON.stringify([
        vodRow({ added: '1700000000', year: '2020' }, 1),
        vodRow({}, 2),
      ]));
      const items = await createXtreamClient(creds).getVodStreams('1');
      expect(fetchTextMock).toHaveBeenCalledTimes(1);
      expect(items.map(item => [item.addedAt, item.year]))
        .toEqual([[1700000000000, 2020], [undefined, undefined]]);
    });
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

  it.each([{ user_info: { auth: 0 } }, [{ error: 'unavailable' }], null])(
    'rejects catalog error objects and malformed arrays instead of treating them as empty (%j)',
    async payload => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fetchTextMock.mockResolvedValue(JSON.stringify(payload));
        const client = createXtreamClient(creds);
        await expect(client.getVodCategories()).rejects.toMatchObject({ code: 'request_failed' });
        await expect(client.getVodStreams('1')).rejects.toMatchObject({ code: 'request_failed' });
        await expect(client.getSeriesCategories()).rejects.toMatchObject({ code: 'request_failed' });
        await expect(client.getSeries('1')).rejects.toMatchObject({ code: 'request_failed' });
        expect(warn).toHaveBeenCalledWith(
          '[Xtream]',
          'Xtream request failed',
          'event=xtream.request.failed',
          'endpoint=get_vod_streams',
          'code=request_failed',
          'timeoutMs=30000',
          `limitBytes=${CONFIG.XTREAM.CATALOG_MAX_BYTES}`,
        );
        fetchTextMock.mockResolvedValue('[]');
        expect(await client.getVodStreams('1')).toEqual([]);
        expect(await client.getSeries('1')).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    },
  );

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
      info: {
        tmdb_id: '27205',
        imdb_id: 'tt1375666',
        releasedate: '2010-07-16',
        plot: 'p',
        subtitles: [],
      },
      movie_data: {},
    }));
    const info = await createXtreamClient(creds).getVodInfo('10');
    expect(info).toMatchObject({
      tmdbId: '27205',
      imdbId: '1375666',
      year: 2010,
    });
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

  it('maps series added time from added, falling back to last_modified', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify([
      { series_id: 1, name: 'S1', category_id: '2', added: '1600000000', last_modified: '1700000000' },
      { series_id: 2, name: 'S2', category_id: '2', last_modified: '1700000000' },
      { series_id: 3, name: 'S3', category_id: '2', added: 'bad', last_modified: '1700000001' },
      { series_id: 4, name: 'S4', category_id: '2', added: '', last_modified: '' },
      { series_id: 5, name: 'S5', category_id: '2', year: '2011', releaseDate: '2010-01-01' },
      { series_id: 6, name: 'S6', category_id: '2', release_date: '2012-02-03' },
    ]));
    const items = await createXtreamClient(creds).getSeries('2');
    expect(items.map(item => [item.seriesId, item.addedAt, item.year])).toEqual([
      ['1', 1600000000000, undefined],
      ['2', 1700000000000, undefined],
      ['3', 1700000001000, undefined],
      ['4', undefined, undefined],
      ['5', undefined, 2011],
      ['6', undefined, 2012],
    ]);
    expect(Object.keys(items[3])).not.toContain('addedAt');
  });

  it('parses series info into sorted seasons + episodesBySeason', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      info: {
        plot: 'Series plot',
        cast: 'Actor 1',
        director: 'Director 1',
        genre: 'Drama',
        releaseDate: '2021-02-03',
        episode_run_time: [45],
        cover: 'http://host/series.png',
        rating: '8.4',
        imdb_id: 'tt1234567',
        tmdb_id: '7654',
      },
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
    expect(info).toMatchObject({
      plot: 'Series plot',
      cast: 'Actor 1',
      director: 'Director 1',
      genre: 'Drama',
      releaseDate: '2021-02-03',
      episodeRunTimeMins: 45,
      poster: 'http://host/series.png',
      rating: '8.4',
      imdbId: '1234567',
      tmdbId: '7654',
      year: 2021,
    });
    expect(info!.seasons).toEqual([1, 2]);
    expect(info!.episodesBySeason[1]).toEqual([{
      id: '101', title: 'S1E1', season: 1, episode: 1, containerExtension: 'mp4',
      durationSecs: 1000, plot: 'p1', poster: 'http://host/1.png', subtitles: [],
    }]);
    expect(info!.episodesBySeason[2][0].id).toBe('201');
  });

  it('uses non-empty series metadata aliases and a direct year', async () => {
    fetchTextMock.mockResolvedValue(JSON.stringify({
      info: {
        releaseDate: '',
        release_date: '',
        cover: '',
        movie_image: '',
        cover_big: 'http://host/series-big.png',
        rating: '',
        rating_5based: '4.2',
        imdb_id: '',
        imdb: 'tt1234567',
        tmdb_id: '',
        tmdb: '7654',
        year: '2022',
      },
    }));
    const info = await createXtreamClient(creds).getSeriesInfo('7');
    expect(info).toMatchObject({
      releaseDate: '',
      poster: 'http://host/series-big.png',
      rating: '4.2',
      imdbId: '1234567',
      tmdbId: '7654',
      year: 2022,
    });
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
    expect(info).toEqual({
      plot: '',
      cast: '',
      director: '',
      genre: '',
      releaseDate: '',
      episodeRunTimeMins: 0,
      poster: '',
      rating: '',
      imdbId: '',
      tmdbId: '',
      year: 0,
      seasons: [],
      episodesBySeason: {},
    });
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
