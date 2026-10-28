import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { PlaylistEntry } from '../types';
import type { CatalogListState } from './idb-cache';

const { clientMock, cacheStore, cacheState } = vi.hoisted(() => ({
  clientMock: {
    getVodCategories: vi.fn(),
    getVodStreams: vi.fn(),
    getVodInfo: vi.fn(),
    getSeriesCategories: vi.fn(),
    getSeries: vi.fn(),
    getSeriesInfo: vi.fn(),
  },
  cacheStore: new Map<string, {
    key: string;
    timestamp: number;
    data: unknown;
    state?: CatalogListState;
  }>(),
  cacheState: { generation: 0 },
}));

vi.mock('./storage-service', () => ({
  StorageService: {
    getXtreamCatalogRefreshIntervalMs: vi.fn(() => 6 * 60 * 60 * 1000),
  },
}));

vi.mock('./xtream-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xtream-client')>(),
  createXtreamClient: () => clientMock,
}));
vi.mock('./idb-cache', () => ({
  catalogCacheGeneration: vi.fn(() => cacheState.generation),
  getCachedCatalog: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  getCachedCatalogMetadata: vi.fn(async (key: string) => {
    const entry = cacheStore.get(key);
    return entry ? { timestamp: entry.timestamp, ...(entry.state ? { state: entry.state } : {}) } : null;
  }),
  setCachedCatalog: vi.fn(async (
    key: string,
    data: unknown,
    _ttl?: number | null,
    state?: CatalogListState,
  ) => {
    cacheStore.set(key, { key, timestamp: Date.now(), data, ...(state ? { state } : {}) });
  }),
  setCachedCatalogState: vi.fn(async (key: string, timestamp: number, state: CatalogListState) => {
    const entry = cacheStore.get(key);
    if (!entry || entry.timestamp !== timestamp) return false;
    cacheStore.set(key, { ...entry, state });
    return true;
  }),
}));

import {
  getSearchCatalogExpiresAt,
  loadAllSeries,
  loadAllVodStreams,
  loadSeries,
  loadSeriesCategories,
  loadSeriesInfo,
  loadVodCategories,
  loadVodInfo,
  onCatalogListRefreshed,
  onCatalogListWritten,
  loadVodStreams,
} from './xtream-catalog';
import { getCachedCatalog, setCachedCatalog, setCachedCatalogState } from './idb-cache';
import { CONFIG } from '../config';
import { XtreamRequestError } from './xtream-client';
import { StorageService } from './storage-service';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};

// The panel refused its unfiltered lists recently, so they load by category.
function loadByCategory(): void {
  for (const resource of ['vod_all', 'series_all']) {
    const key = `x1|${resource}_by_category`;
    cacheStore.set(key, { key, timestamp: Date.now(), data: { reason: 'too_large' } });
  }
}

// Background refreshes chain a few promises; a macrotask drains them all.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  cacheStore.clear();
  cacheState.generation = 0;
  vi.clearAllMocks();
  vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs)
    .mockReturnValue(CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
  clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
  clientMock.getSeriesCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
});

describe('xtream-catalog', () => {
  it('uses the oldest whole-catalog timestamp for Search memory expiry without reading payloads', async () => {
    const oldest = Date.now() - 2 * 60 * 60 * 1000;
    cacheStore.set('x1|vod_all', {
      key: 'x1|vod_all',
      timestamp: oldest,
      data: [],
    });
    cacheStore.set('x1|series_all', {
      key: 'x1|series_all',
      timestamp: Date.now() - 60 * 60 * 1000,
      data: [],
    });

    expect(await getSearchCatalogExpiresAt('x1'))
      .toBe(oldest + CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
    expect(getCachedCatalog).not.toHaveBeenCalled();
  });

  it('fetches on a cold cache and writes the result under an account-scoped key', async () => {
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadVodCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_categories',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('evaluates freshness against the configured catalog interval', async () => {
    vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs)
      .mockReturnValue(12 * 60 * 60 * 1000);
    const cached = [{ id: '1', name: 'Cached' }];
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: Date.now() - 8 * 60 * 60 * 1000,
      data: cached,
    });

    expect(await loadVodCategories(account)).toEqual(cached);
    expect(clientMock.getVodCategories).not.toHaveBeenCalled();
  });

  it('returns fresh cache without calling the client', async () => {
    cacheStore.set('x1|vod_streams-v2|1', { key: 'x1|vod_streams-v2|1', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadVodStreams(account, '1');
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('ignores VOD and series lists cached under the pre-sort-metadata keys', async () => {
    const legacyTimestamp = Date.now();
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: legacyTimestamp, data: [{ accountId: 'x1', streamId: 'old' }] });
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: legacyTimestamp, data: [{ accountId: 'x1', seriesId: 'old' }] });
    const movies = [{ accountId: 'x1', streamId: '10', addedAt: 1000, year: 2020 }];
    const series = [{ accountId: 'x1', seriesId: 's1', addedAt: 2000 }];
    clientMock.getVodStreams.mockResolvedValue(movies);
    clientMock.getSeries.mockResolvedValue(series);

    expect(await loadVodStreams(account, '1')).toEqual(movies);
    expect(await loadSeries(account, '1')).toEqual(series);
    expect(cacheStore.get('x1|vod_streams-v2|1')?.data).toEqual(movies);
    expect(cacheStore.get('x1|series-v2|1')?.data).toEqual(series);
    expect(cacheStore.get('x1|vod_streams|1')?.data).toEqual([{ accountId: 'x1', streamId: 'old' }]);
  });

  it('logs versioned list keys under their plain resource name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series-v2|1', { key: 'x1|series-v2|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockRejectedValue(new XtreamRequestError('request_failed', 'down'));
    await loadSeries(account, '1');
    await settle();
    expect(warn).toHaveBeenCalledWith(
      '[Catalog]', expect.any(String), 'event=xtream.catalog.stale', 'resource=series',
      'reason=request_failed', 'items=1', expect.anything(),
    );
    warn.mockRestore();
  });

  it('serves a stale list at once and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    let release!: () => void;
    clientMock.getVodCategories.mockImplementation(() => new Promise(resolve => {
      release = () => resolve([{ id: '1', name: 'Cat A' }]);
    }));

    expect(await loadVodCategories(account)).toEqual([{ id: 'old', name: 'Old' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).not.toHaveBeenCalled();

    release();
    await settle();
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_categories',
      [{ id: '1', name: 'Cat A' }],
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
    expect(await loadVodCategories(account)).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
  });

  it('notifies refresh listeners once a background refresh replaces a list', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const listener = vi.fn();
    const stop = onCatalogListRefreshed(listener);

    await loadVodCategories(account);
    await settle();
    stop();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('x1|vod_categories');
  });

  it('notifies write listeners for a cold fetch and a background refresh, not a cache hit', async () => {
    const listener = vi.fn();
    const stop = onCatalogListWritten(listener);
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10', name: 'Movie One' }]);
    await loadAllVodStreams(account);
    expect(listener.mock.calls).toEqual([['x1|vod_all']]);

    await loadAllVodStreams(account);
    expect(listener).toHaveBeenCalledTimes(1);

    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ id: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: '20', name: 'Series One' }]);
    await loadAllSeries(account);
    await settle();
    stop();
    expect(listener.mock.calls).toEqual([['x1|vod_all'], ['x1|series_all']]);
  });

  it('shares one background refresh per key and detaches it from the caller signal', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_streams-v2|1', { key: 'x1|vod_streams-v2|1', timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10' }]);
    const controller = new AbortController();

    await Promise.all([
      loadVodStreams(account, '1', controller.signal),
      loadVodStreams(account, '1'),
    ]);
    controller.abort();
    await settle();

    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(1);
    expect(clientMock.getVodStreams).toHaveBeenCalledWith('1', undefined);
    expect(cacheStore.get('x1|vod_streams-v2|1')?.data).toEqual([{ accountId: 'x1', streamId: '10' }]);
  });

  it('drops a background refresh that finishes after the catalog cache was cleared', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    let release!: () => void;
    clientMock.getVodCategories.mockImplementation(() => new Promise(resolve => {
      release = () => resolve([{ id: '1', name: 'Cat A' }]);
    }));

    await loadVodCategories(account);
    cacheState.generation++;
    cacheStore.clear();
    release();
    await settle();

    expect(setCachedCatalog).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
  });

  it('runs at most two background refreshes at a time and queues the rest', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    for (const id of ['1', '2', '3']) {
      cacheStore.set(`x1|vod_streams-v2|${id}`, { key: `x1|vod_streams-v2|${id}`, timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    }
    const releases = new Map<string, () => void>();
    clientMock.getVodStreams.mockImplementation((id: string) => new Promise(resolve => {
      releases.set(id, () => resolve([{ accountId: 'x1', streamId: `new${id}` }]));
    }));

    await Promise.all(['1', '2', '3'].map(id => loadVodStreams(account, id)));
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual(['1', '2']);

    releases.get('1')!();
    await settle();
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);

    releases.get('2')!();
    releases.get('3')!();
    await settle();
    expect(cacheStore.get('x1|vod_streams-v2|3')?.data).toEqual([{ accountId: 'x1', streamId: 'new3' }]);
  });

  it('skips a queued background refresh once the catalog cache is cleared', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    for (const id of ['1', '2', '3']) {
      cacheStore.set(`x1|vod_streams-v2|${id}`, { key: `x1|vod_streams-v2|${id}`, timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    }
    const releases: Array<() => void> = [];
    clientMock.getVodStreams.mockImplementation(() => new Promise(resolve => {
      releases.push(() => resolve([]));
    }));

    await Promise.all(['1', '2', '3'].map(id => loadVodStreams(account, id)));
    cacheState.generation++;
    releases.forEach(release => release());
    await settle();

    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(2);
  });

  it('clears the stale VOD category when a background refresh succeeds with an empty list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_streams-v2|1', { key: 'x1|vod_streams-v2|1', timestamp: stale, data: [{ accountId: 'x1', streamId: '10' }] });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadVodStreams(account, '1');
    await settle();
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_streams-v2|1', [], CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
    expect(cacheStore.get('x1|vod_streams-v2|1')?.data).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to stale VOD info when a stale re-fetch returns null', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    const info = { plot: 'old', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 };
    cacheStore.set('x1|vod_info|10', { key: 'x1|vod_info|10', timestamp: stale, data: info });
    clientMock.getVodInfo.mockResolvedValue(null);
    expect(await loadVodInfo(account, '10')).toEqual(info);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('caches VOD info and skips the write on a null response', async () => {
    clientMock.getVodInfo.mockResolvedValueOnce({ plot: 'p', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const ok = await loadVodInfo(account, '10');
    expect(ok?.plot).toBe('p');
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_info|10',
      ok,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );

    clientMock.getVodInfo.mockResolvedValueOnce(null);
    (setCachedCatalog as unknown as { mockClear: () => void }).mockClear();
    expect(await loadVodInfo(account, '11')).toBeNull();
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('reads through getCachedCatalog before fetching', async () => {
    clientMock.getVodCategories.mockResolvedValue([]);
    await loadVodCategories(account);
    expect(getCachedCatalog).toHaveBeenCalledWith('x1|vod_categories');
  });

  it('keeps stale data after a failed background refresh but surfaces cold-cache failures', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: stale,
      data: [{ id: 'old', name: 'Old' }],
    });
    clientMock.getVodCategories.mockRejectedValue(new XtreamRequestError(
      'too_large',
      'Xtream response exceeded its size limit',
    ));

    await expect(loadVodCategories(account)).resolves.toEqual([{ id: 'old', name: 'Old' }]);
    await settle();
    expect(cacheStore.get('x1|vod_categories')?.data).toEqual([{ id: 'old', name: 'Old' }]);
    cacheStore.clear();
    await expect(loadVodCategories(account)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('propagates cancellation and never writes the cancelled response', async () => {
    const controller = new AbortController();
    clientMock.getVodCategories.mockImplementation(async (signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return [{ id: '1', name: 'Cat A' }];
    });

    await expect(loadVodCategories(account, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('does not serve stale data to a cancelled caller', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: stale,
      data: [{ id: 'old', name: 'Old' }],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(loadVodCategories(account, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(clientMock.getVodCategories).not.toHaveBeenCalled();
  });
});

describe('xtream-catalog series', () => {
  const info = { seasons: [1], episodesBySeason: { 1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 0, plot: '', poster: '' }] } };

  it('fetches series categories on a cold cache and writes an account-scoped key', async () => {
    clientMock.getSeriesCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadSeriesCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getSeriesCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_categories',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
  });

  it('returns a fresh series list without calling the client', async () => {
    cacheStore.set('x1|series-v2|1', { key: 'x1|series-v2|1', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadSeries(account, '1');
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('serves a stale series list and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series-v2|1', { key: 'x1|series-v2|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1' }]);
    expect(await loadSeries(account, '1')).toEqual([{ accountId: 'x1', seriesId: 'old' }]);
    await settle();
    expect(clientMock.getSeries).toHaveBeenCalledWith('1', undefined);
    expect(await loadSeries(account, '1')).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
  });

  it('clears the stale series category when a background refresh succeeds with an empty list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series-v2|1', { key: 'x1|series-v2|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadSeries(account, '1');
    await settle();
    warn.mockRestore();
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series-v2|1', [], CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );
    expect(cacheStore.get('x1|series-v2|1')?.data).toEqual([]);
  });

  it('caches series info and skips the write on a null response', async () => {
    clientMock.getSeriesInfo.mockResolvedValueOnce(info);
    const ok = await loadSeriesInfo(account, 's1');
    expect(ok?.seasons).toEqual([1]);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_info|s1',
      ok,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    );

    clientMock.getSeriesInfo.mockResolvedValueOnce(null);
    (setCachedCatalog as unknown as { mockClear: () => void }).mockClear();
    expect(await loadSeriesInfo(account, 's2')).toBeNull();
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('reads through getCachedCatalog before fetching series info', async () => {
    clientMock.getSeriesInfo.mockResolvedValue(info);
    await loadSeriesInfo(account, 's1');
    expect(getCachedCatalog).toHaveBeenCalledWith('x1|series_info|s1');
  });

  it('falls back to stale series info when a stale re-fetch returns null', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_info|s1', { key: 'x1|series_info|s1', timestamp: stale, data: info });
    clientMock.getSeriesInfo.mockResolvedValue(null);
    expect(await loadSeriesInfo(account, 's1')).toEqual(info);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });
});

describe('xtream-catalog whole-catalog (search)', () => {
  // These request sequences are written for two request slots.
  const slots = CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY;
  afterEach(() => {
    (CONFIG.XTREAM as { CATALOG_LOAD_CONCURRENCY: number }).CATALOG_LOAD_CONCURRENCY = slots;
  });
  beforeEach(() => {
    (CONFIG.XTREAM as { CATALOG_LOAD_CONCURRENCY: number }).CATALOG_LOAD_CONCURRENCY = 2;
  });

  describe.each([
    {
      resource: 'vod_all',
      load: loadAllVodStreams,
      categories: clientMock.getVodCategories,
      items: clientMock.getVodStreams,
      idKey: 'streamId',
      categoryKey: 'vod_categories',
      itemKey: 'vod_streams-v2',
    },
    {
      resource: 'series_all',
      load: loadAllSeries,
      categories: clientMock.getSeriesCategories,
      items: clientMock.getSeries,
      idKey: 'seriesId',
      categoryKey: 'series_categories',
      itemKey: 'series-v2',
    },
  ])('$resource category partitions', ({ resource, load, categories, items, idKey, categoryKey, itemKey }) => {
    const failure = new XtreamRequestError('too_large', 'Response exceeds limit');
    const first = { accountId: 'x1', [idKey]: '10', name: 'Item One', categoryId: '1' };
    const second = { accountId: 'x1', [idKey]: '20', name: 'Item Two', categoryId: '2' };
    const third = { accountId: 'x1', [idKey]: '30', name: 'Item Three', categoryId: '3' };
    const key = `x1|${resource}`;
    const partitionKey = (id: string) => `x1|${itemKey}|${id}`;

    beforeEach(() => {
      loadByCategory();
      categories.mockResolvedValue([
        { id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }, { id: '3', name: 'Cat C' },
      ]);
      items.mockImplementation(async (categoryId?: string) => {
        if (categoryId === undefined) throw failure;
        return categoryId === '1' ? [first] : categoryId === '2' ? [second] : [third];
      });
    });

    it('loads two categories at a time and preserves snapshot order despite out-of-order completion', async () => {
      const controller = new AbortController();
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      items.mockImplementationOnce(() => new Promise(resolve => {
        releaseFirst = () => resolve([first]);
      })).mockImplementationOnce(() => new Promise(resolve => {
        releaseSecond = () => resolve([first, second]);
      }));

      const pending = load(account, controller.signal).then(
        data => ({ data }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(2));
      const requestSignal = categories.mock.calls[0][0] as AbortSignal;
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(cacheStore.has(key)).toBe(false);
      releaseSecond();
      await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(3));
      expect(cacheStore.has(key)).toBe(false);
      releaseFirst();

      expect(await pending).toEqual({ data: [first, second, third] });
      expect(items.mock.calls).toEqual([
        ['1', requestSignal],
        ['2', requestSignal],
        ['3', requestSignal],
      ]);
      expect(cacheStore.get(key)).toMatchObject({
        data: [first, second, third], state: { complete: true },
      });
      expect(cacheStore.get(partitionKey('1'))?.data).toEqual([first]);

      expect(await load(account)).toEqual([first, second, third]);
      expect(items).toHaveBeenCalledTimes(3);
    });

    it('continues after a category fails and marks the available snapshot incomplete', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      items.mockImplementation(async (categoryId?: string) => {
        if (categoryId === undefined || categoryId === '1') throw failure;
        return categoryId === '2' ? [second] : [third];
      });

      expect(await load(account)).toEqual([second, third]);
      expect(items.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);
      expect(cacheStore.has(partitionKey('1'))).toBe(false);
      expect(cacheStore.get(partitionKey('2'))?.data).toEqual([second]);
      expect(cacheStore.get(key)).toMatchObject({
        data: [second, third],
        state: { complete: false, refreshAfter: expect.any(Number) },
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[Catalog]',
        'Catalog is incomplete; failed partitions will be retried',
        'event=xtream.catalog.partial',
        `resource=${resource}`,
        'categories=3',
        'failed=1',
        'stale=0',
        'missing=1',
        'categoryListFailed=false',
        'deferred=0',
        'budgetExhausted=false',
      );
      warn.mockRestore();
    });

    it('retains a failed category cache while refreshing the other categories', async () => {
      const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
      cacheStore.set(partitionKey('1'), { key: partitionKey('1'), timestamp: stale, data: [first] });
      items.mockRejectedValueOnce(failure);

      expect(await load(account)).toEqual([first, second, third]);
      expect(cacheStore.get(partitionKey('1'))?.timestamp).toBe(stale);
      expect(cacheStore.get(key)?.state?.complete).toBe(false);
    });

    it('retains a failed category from the previous whole snapshot when its partition was evicted', async () => {
      const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
      cacheStore.set(key, { key, timestamp: stale, data: [first] });
      items.mockRejectedValueOnce(failure);
      const listener = vi.fn();
      const stop = onCatalogListRefreshed(listener);

      expect(await load(account)).toEqual([first]);
      await settle();
      stop();

      expect(cacheStore.get(key)?.data).toEqual([first, second, third]);
      expect(cacheStore.get(key)?.state?.complete).toBe(false);
      expect(listener).toHaveBeenCalledExactlyOnceWith(key);
    });

    it('retries only the failed category after the partial snapshot retry delay', async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      items.mockRejectedValueOnce(failure);
      expect(await load(account)).toEqual([second, third]);
      const state = cacheStore.get(key)?.state;
      expect(state?.refreshAfter).toBeGreaterThan(now);
      expect(state?.refreshAfter).toBeLessThan(now + CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
      const other = resource === 'vod_all' ? 'series_all' : 'vod_all';
      cacheStore.set(`x1|${other}`, { key: `x1|${other}`, timestamp: now, data: [] });
      expect(await getSearchCatalogExpiresAt('x1')).toBe(state?.refreshAfter);

      expect(await load(account)).toEqual([second, third]);
      expect(items).toHaveBeenCalledTimes(3);
      clock.mockReturnValue(state!.refreshAfter);
      expect(await load(account)).toEqual([second, third]);
      await settle();

      expect(items.mock.calls.map(call => call[0])).toEqual(['1', '2', '3', '1']);
      expect(categories).toHaveBeenCalledTimes(1);
      expect(cacheStore.get(key)).toMatchObject({
        data: [first, second, third], state: { complete: true },
      });
      expect(await getSearchCatalogExpiresAt('x1'))
        .toBe(now + CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
      clock.mockRestore();
    });

    it('uses fresh category and item partitions without requesting them again', async () => {
      cacheStore.set(`x1|${categoryKey}`, {
        key: `x1|${categoryKey}`, timestamp: Date.now(), data: [{ id: '1', name: 'Cat A' }],
      });
      cacheStore.set(partitionKey('1'), { key: partitionKey('1'), timestamp: Date.now(), data: [first] });

      expect(await load(account)).toEqual([first]);
      expect(categories).not.toHaveBeenCalled();
      expect(items).not.toHaveBeenCalled();
    });

    it('propagates failure when no category has any available data', async () => {
      items.mockRejectedValue(failure);

      await expect(load(account)).rejects.toBe(failure);
      expect(items).toHaveBeenCalledTimes(3);
      expect(cacheStore.has(key)).toBe(false);
    });

    it('propagates a cold category-list failure without requesting items', async () => {
      categories.mockRejectedValueOnce(failure);

      await expect(load(account)).rejects.toBe(failure);
      expect(items).not.toHaveBeenCalled();
      expect(cacheStore.has(key)).toBe(false);
    });

    it('rejects a cold empty category list without caching it and retries on the next category load', async () => {
      categories.mockResolvedValueOnce([]);

      await expect(load(account)).rejects.toMatchObject({ code: 'request_failed' });
      expect(items).not.toHaveBeenCalled();
      expect(cacheStore.has(`x1|${categoryKey}`)).toBe(false);
      expect(cacheStore.has(key)).toBe(false);

      const loadCategories = resource === 'vod_all' ? loadVodCategories : loadSeriesCategories;
      expect(await loadCategories(account)).toEqual([
        { id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }, { id: '3', name: 'Cat C' },
      ]);
      expect(categories).toHaveBeenCalledTimes(2);
      expect(await load(account)).toEqual([first, second, third]);
      expect(cacheStore.get(key)?.state?.complete).toBe(true);
      expect(categories).toHaveBeenCalledTimes(2);
    });

    it('uses a stale category list on failure but schedules another category-list refresh', async () => {
      const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
      cacheStore.set(`x1|${categoryKey}`, {
        key: `x1|${categoryKey}`, timestamp: stale, data: [{ id: '1', name: 'Cat A' }],
      });
      categories.mockRejectedValueOnce(failure);

      expect(await load(account)).toEqual([first]);
      expect(cacheStore.get(`x1|${categoryKey}`)?.timestamp).toBe(stale);
      expect(cacheStore.get(key)?.state?.complete).toBe(false);
    });

    it('caches successful empty categories and does not repeatedly load them', async () => {
      categories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
      items.mockResolvedValue([]);

      expect(await load(account)).toEqual([]);
      expect(cacheStore.get(partitionKey('1'))?.data).toEqual([]);
      expect(cacheStore.get(key)).toMatchObject({ data: [], state: { complete: true } });
      expect(await load(account)).toEqual([]);
      expect(items).toHaveBeenCalledTimes(1);
    });

    it('clears a category that becomes empty without retaining its removed items', async () => {
      const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
      cacheStore.set(partitionKey('1'), { key: partitionKey('1'), timestamp: stale, data: [first] });
      items.mockResolvedValueOnce([]);

      expect(await load(account)).toEqual([second, third]);
      expect(cacheStore.get(partitionKey('1'))?.data).toEqual([]);
      expect(cacheStore.get(key)?.state?.complete).toBe(true);
    });

    it('updates retry state without rewriting or announcing an unchanged snapshot', async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await load(account);
        const oldTimestamp = now - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
        const snapshot = cacheStore.get(key)!;
        cacheStore.set(key, {
          ...snapshot,
          timestamp: oldTimestamp,
          state: { complete: false, refreshAfter: now - 1 },
        });
        cacheStore.set(partitionKey('1'), { key: partitionKey('1'), timestamp: oldTimestamp, data: [first] });
        items.mockClear().mockRejectedValueOnce(failure);
        vi.mocked(setCachedCatalog).mockClear();
        const written = vi.fn();
        const refreshed = vi.fn();
        const stopWrite = onCatalogListWritten(written);
        const stopRefresh = onCatalogListRefreshed(refreshed);
        try {
          expect(await load(account)).toEqual([first, second, third]);
          await settle();

          expect(setCachedCatalog).not.toHaveBeenCalled();
          expect(setCachedCatalogState).toHaveBeenCalledWith(
            key, oldTimestamp, expect.objectContaining({ complete: false }),
            CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
          );
          expect(cacheStore.get(key)?.timestamp).toBe(oldTimestamp);
          expect(written).not.toHaveBeenCalled();
          expect(refreshed).toHaveBeenCalledExactlyOnceWith(key, false);
          expect(await load(account)).toEqual([first, second, third]);
          await settle();
          expect(items).toHaveBeenCalledTimes(1);

          clock.mockReturnValue(cacheStore.get(key)!.state!.refreshAfter);
          expect(await load(account)).toEqual([first, second, third]);
          await settle();
          expect(cacheStore.get(key)).toMatchObject({
            timestamp: oldTimestamp, state: { complete: true },
          });
          expect(setCachedCatalog).not.toHaveBeenCalledWith(
            key, expect.anything(), expect.anything(), expect.anything(),
          );
          expect(refreshed).toHaveBeenLastCalledWith(key, false);
          expect(await load(account)).toEqual([first, second, third]);
          await settle();
          expect(items).toHaveBeenCalledTimes(2);
        } finally {
          stopWrite();
          stopRefresh();
        }
      } finally {
        clock.mockRestore();
      }
    });

    it('renews unchanged catalog metadata using the configured refresh interval', async () => {
      const interval = 24 * 60 * 60 * 1000;
      vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs).mockReturnValue(interval);
      await load(account);
      const snapshot = cacheStore.get(key)!;
      cacheStore.set(key, {
        ...snapshot, state: { complete: false, refreshAfter: Date.now() - 1 },
      });

      expect(await load(account)).toEqual([first, second, third]);
      await settle();

      expect(setCachedCatalogState).toHaveBeenCalledWith(
        key, snapshot.timestamp, expect.objectContaining({ complete: true }), interval,
      );
      expect(items).toHaveBeenCalledTimes(3);
    });

    it('migrates an unchanged legacy snapshot once before using metadata-only retries', async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const old = now - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
        cacheStore.set(key, { key, timestamp: old, data: [first, second, third] });
        cacheStore.set(`x1|${categoryKey}`, {
          key: `x1|${categoryKey}`, timestamp: now,
          data: ['1', '2', '3'].map(id => ({ id, name: `Cat ${id}` })),
        });
        cacheStore.set(partitionKey('1'), { key: partitionKey('1'), timestamp: old, data: [first] });
        cacheStore.set(partitionKey('2'), { key: partitionKey('2'), timestamp: now, data: [second] });
        cacheStore.set(partitionKey('3'), { key: partitionKey('3'), timestamp: now, data: [third] });
        items.mockRejectedValue(failure);

        expect(await load(account)).toEqual([first, second, third]);
        await settle();
        expect(vi.mocked(setCachedCatalog).mock.calls.filter(([writtenKey]) => writtenKey === key))
          .toHaveLength(1);
        expect(cacheStore.get(key)).toMatchObject({
          timestamp: now, state: { complete: false },
        });

        clock.mockReturnValue(cacheStore.get(key)!.state!.refreshAfter);
        await load(account);
        await settle();
        expect(vi.mocked(setCachedCatalog).mock.calls.filter(([writtenKey]) => writtenKey === key))
          .toHaveLength(1);
        expect(setCachedCatalogState).toHaveBeenCalledWith(
          key, now, expect.objectContaining({ complete: false }),
          CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
        );
      } finally {
        clock.mockRestore();
      }
    });

    it('requests duplicate category IDs only once', async () => {
      categories.mockResolvedValue([{ id: '1', name: 'Cat A' }, { id: '1', name: 'Cat A' }]);

      expect(await load(account)).toEqual([first]);
      expect(items).toHaveBeenCalledTimes(1);
    });

    it('keeps successful partitions but stops and does not publish a cancelled snapshot', async () => {
      const controller = new AbortController();
      const active = CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY;
      const ids = Array.from({ length: active + 3 }, (_, index) => String(index + 1));
      categories.mockResolvedValue(ids.map(id => ({ id, name: `Cat ${id}` })));
      items.mockImplementation((id: string, signal: AbortSignal) => {
        if (id === '1') return Promise.resolve([first]);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(
            new XtreamRequestError('cancelled', 'Request was cancelled'),
          ));
        });
      });
      const pending = expect(load(account, controller.signal))
        .rejects.toMatchObject({ code: 'cancelled' });
      await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(active + 1));
      expect(cacheStore.get(partitionKey('1'))?.data).toEqual([first]);
      controller.abort();
      await pending;

      expect(items.mock.calls.map(call => call[0])).toEqual(ids.slice(0, active + 1));
      expect(cacheStore.has(partitionKey('2'))).toBe(false);
      expect(cacheStore.has(key)).toBe(false);
    });

    it('aborts slow requests at the round budget and resumes with unattempted categories', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        categories.mockResolvedValue(['1', '2', '3', '4', '5'].map(id => ({ id, name: `Cat ${id}` })));
        items.mockImplementation((id: string, signal: AbortSignal) => {
          if (id === '1') return Promise.resolve([first]);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
              new XtreamRequestError('cancelled', 'Request was cancelled'),
            ));
          });
        });
        const pending = load(account);
        await vi.advanceTimersByTimeAsync(0);
        expect(items.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);

        await vi.advanceTimersByTimeAsync(CONFIG.XTREAM.CATALOG_LOAD_BUDGET_MS - 1);
        expect(cacheStore.has(key)).toBe(false);
        expect((items.mock.calls[1][1] as AbortSignal).aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual([first]);
        expect(items.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);
        expect(cacheStore.get(key)?.state?.complete).toBe(false);
        expect(cacheStore.get(`x1|${resource}_cursor`)?.data).toEqual({ nextCategory: '4' });
        expect(warn).toHaveBeenCalledWith(
          '[Catalog]',
          'Catalog is incomplete; failed partitions will be retried',
          'event=xtream.catalog.partial',
          `resource=${resource}`,
          'categories=5',
          'failed=4',
          'stale=0',
          'missing=4',
          'categoryListFailed=false',
          'deferred=4',
          'budgetExhausted=true',
        );

        items.mockClear().mockImplementation(async (id: string) => [
          { accountId: 'x1', [idKey]: `${id}0`, name: `Item ${id}`, categoryId: id },
        ]);
        await vi.advanceTimersByTimeAsync(CONFIG.XTREAM.CATALOG_RETRY_DELAY_MS);
        expect(await load(account)).toEqual([first]);
        await vi.advanceTimersByTimeAsync(0);

        expect(items.mock.calls.map(call => call[0])).toEqual(['4', '5', '2', '3']);
        expect(cacheStore.get(key)?.state?.complete).toBe(true);
        expect((cacheStore.get(key)?.data as Array<{ categoryId: string }>)
          .map(item => item.categoryId)).toEqual(['1', '2', '3', '4', '5']);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it('keeps stale data for both in-flight and unattempted categories at the budget deadline', async () => {
      vi.useFakeTimers();
      try {
        const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
        const old = ['2', '3', '4', '5'].map(id => ({
          accountId: 'x1', [idKey]: `${id}0`, name: `Old ${id}`, categoryId: id,
        }));
        for (const item of old) {
          cacheStore.set(partitionKey(item.categoryId), {
            key: partitionKey(item.categoryId), timestamp: stale, data: [item],
          });
        }
        categories.mockResolvedValue(['1', '2', '3', '4', '5'].map(id => ({ id, name: `Cat ${id}` })));
        items.mockImplementation((id: string, signal: AbortSignal) => {
          if (id === '1') return Promise.resolve([first]);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(
              new XtreamRequestError('cancelled', 'Request was cancelled'),
            ));
          });
        });

        const pending = load(account);
        await vi.advanceTimersByTimeAsync(CONFIG.XTREAM.CATALOG_LOAD_BUDGET_MS);

        expect(await pending).toEqual([first, ...old]);
        expect(items.mock.calls.map(call => call[0])).toEqual(['1', '2', '3']);
        for (const item of old) {
          expect(cacheStore.get(partitionKey(item.categoryId))?.timestamp).toBe(stale);
        }
        expect(cacheStore.get(key)?.state?.complete).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains its resume position when the budget expires with no usable category data', async () => {
      vi.useFakeTimers();
      try {
        items.mockImplementation((_id: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(
            new XtreamRequestError('cancelled', 'Request was cancelled'),
          ));
        }));
        const pending = expect(load(account)).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(0);
        expect(items).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(CONFIG.XTREAM.CATALOG_LOAD_BUDGET_MS);
        await pending;

        expect(cacheStore.has(key)).toBe(false);
        expect(cacheStore.get(`x1|${resource}_cursor`)?.data).toEqual({ nextCategory: '3' });
        items.mockClear().mockImplementation(async (id: string) => (
          id === '1' ? [first] : id === '2' ? [second] : [third]
        ));
        expect(await load(account)).toEqual([first, second, third]);
        expect(items.mock.calls.map(call => call[0])).toEqual(['3', '1', '2']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not repopulate partition caches after the catalog cache is cleared', async () => {
      items.mockImplementationOnce(async () => {
        cacheState.generation++;
        cacheStore.clear();
        return [first];
      });

      await expect(load(account)).rejects.toMatchObject({ code: 'cancelled' });
      expect(cacheStore.size).toBe(0);
      expect(items).toHaveBeenCalledTimes(1);
    });
  });

  it('limits category requests across concurrent movie and series loads', async () => {
    loadByCategory();
    const slots = CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY;
    const ids = Array.from({ length: slots + 1 }, (_, index) => String(index + 1));
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    for (const categories of [clientMock.getVodCategories, clientMock.getSeriesCategories]) {
      categories.mockResolvedValue(ids.map(id => ({ id, name: `Cat ${id}` })));
    }
    for (const [mock, idKey] of [
      [clientMock.getVodStreams, 'streamId'],
      [clientMock.getSeries, 'seriesId'],
    ] as const) {
      mock.mockImplementation((id: string) => new Promise(resolve => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve([{ accountId: 'x1', [idKey]: id, name: `Item ${id}`, categoryId: id }]);
        });
      }));
    }
    const pending = Promise.all([loadAllVodStreams(account), loadAllSeries(account)]);
    await settle();
    expect(releases).toHaveLength(slots);
    while (releases.length) {
      releases.splice(0).forEach(release => release());
      await settle();
    }
    const results = await pending;
    expect(results.map(result => result.length)).toEqual([ids.length, ids.length]);
    expect(peak).toBe(slots);
  });

  it('removes a cancelled catalog from the shared queue without cancelling the active catalog', async () => {
    loadByCategory();
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }]);
    const releases: Array<() => void> = [];
    clientMock.getVodStreams.mockImplementation((id: string) => new Promise(resolve => {
      releases.push(() => resolve([{ accountId: 'x1', streamId: id, name: `Item ${id}`, categoryId: id }]));
    }));
    const movies = loadAllVodStreams(account);
    await settle();
    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const cancelled = expect(loadAllSeries(account, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(clientMock.getSeries).not.toHaveBeenCalled();
    controller.abort();
    await cancelled;
    expect((clientMock.getVodStreams.mock.calls[0][1] as AbortSignal).aborted).toBe(false);

    releases.forEach(release => release());
    expect(await movies).toHaveLength(2);
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Item One', categoryId: '1' }]);
    expect(await loadAllSeries(account)).toHaveLength(1);
    expect(clientMock.getSeries).toHaveBeenCalledTimes(1);
  });

  it('fetches the whole VOD catalog in one request and writes the search snapshot', async () => {
    clientMock.getVodStreams.mockResolvedValue([
      { accountId: 'x1', streamId: '10', name: 'Movie One', categoryId: '1' },
      { accountId: 'x1', streamId: '10', name: 'Movie One', categoryId: '2' },
      { accountId: 'x1', streamId: '20', name: 'Movie Two', categoryId: '2' },
    ]);
    const out = await loadAllVodStreams(account);
    expect(out.map(item => item.streamId)).toEqual(['10', '20']);
    expect(clientMock.getVodStreams.mock.calls).toEqual([[undefined, undefined]]);
    expect(clientMock.getVodCategories).not.toHaveBeenCalled();
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|vod_all',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
      { complete: true, refreshAfter: expect.any(Number), freshSince: expect.any(Number) },
    );
  });

  it('loads by category after the whole list fails, and keeps doing so for a while', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    clientMock.getVodStreams.mockImplementation(async (categoryId?: string) => {
      if (categoryId === undefined) throw new XtreamRequestError('too_large', 'Response exceeds limit');
      return [{ accountId: 'x1', streamId: `${categoryId}0`, name: 'Movie', categoryId }];
    });
    expect(await loadAllVodStreams(account)).toEqual([
      { accountId: 'x1', streamId: '10', name: 'Movie', categoryId: '1' },
    ]);
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual([undefined, '1']);
    expect(info).toHaveBeenCalledWith(
      '[Catalog]',
      'Whole catalog request failed; loading by category',
      'event=xtream.catalog.by_category',
      'resource=vod_all',
      'reason=too_large',
    );

    cacheStore.delete('x1|vod_all');
    cacheStore.delete('x1|vod_streams-v2|1');
    clientMock.getVodStreams.mockClear();
    await loadAllVodStreams(account);
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual(['1']);

    const retryAt = Date.now() + CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS;
    const now = vi.spyOn(Date, 'now').mockReturnValue(retryAt);
    cacheStore.delete('x1|vod_all');
    clientMock.getVodStreams.mockClear();
    await loadAllVodStreams(account);
    expect(clientMock.getVodStreams.mock.calls[0][0]).toBeUndefined();
    now.mockRestore();
    info.mockRestore();
  });

  it('loads by category when the whole list comes back empty', async () => {
    clientMock.getVodStreams.mockImplementation(async (categoryId?: string) => (
      categoryId === undefined ? [] : [{ accountId: 'x1', streamId: '10', name: 'Movie', categoryId }]
    ));
    expect(await loadAllVodStreams(account)).toHaveLength(1);
    expect(clientMock.getVodStreams.mock.calls.map(call => call[0])).toEqual([undefined, '1']);
  });

  it('propagates cancellation of the whole-list request without falling back', async () => {
    const controller = new AbortController();
    clientMock.getVodStreams.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new XtreamRequestError('cancelled', 'Request was cancelled'));
    });
    await expect(loadAllVodStreams(account, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(1);
    expect(cacheStore.has('x1|vod_all_by_category')).toBe(false);
  });

  it('returns the fresh full VOD catalog without calling the client', async () => {
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('serves a stale full VOD catalog and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10' }]);
    expect(await loadAllVodStreams(account)).toEqual([{ accountId: 'x1', streamId: 'old' }]);
    await settle();
    expect(clientMock.getVodStreams).toHaveBeenCalledWith(undefined, undefined);
    expect(await loadAllVodStreams(account)).toEqual([{ accountId: 'x1', streamId: '10' }]);
  });

  it('clears a stale VOD snapshot after its category successfully becomes empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    const old = [{ accountId: 'x1', streamId: '10', categoryId: '1' }];
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: old });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadAllVodStreams(account);
    await settle();
    expect(out).toEqual(old);
    expect(cacheStore.get('x1|vod_all')).toMatchObject({
      data: [], state: { complete: true },
    });
    expect(cacheStore.get('x1|vod_streams-v2|1')?.data).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fetches the whole series catalog in one request and writes the search snapshot', async () => {
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(clientMock.getSeries.mock.calls).toEqual([[undefined, undefined]]);
    expect(setCachedCatalog).toHaveBeenCalledWith(
      'x1|series_all',
      out,
      CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
      { complete: true, refreshAfter: expect.any(Number), freshSince: expect.any(Number) },
    );
  });

  it('returns the fresh full series catalog without calling the client', async () => {
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('serves a stale full series catalog and refreshes it in the background', async () => {
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(await loadAllSeries(account)).toEqual([{ accountId: 'x1', seriesId: 'old' }]);
    await settle();
    expect(await loadAllSeries(account))
      .toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
  });

  it('clears a stale series snapshot after its category successfully becomes empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    const old = [{ accountId: 'x1', seriesId: 's1', categoryId: '1' }];
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: old });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadAllSeries(account);
    await settle();
    warn.mockRestore();
    expect(out).toEqual(old);
    expect(cacheStore.get('x1|series_all')).toMatchObject({
      data: [], state: { complete: true },
    });
    expect(cacheStore.get('x1|series-v2|1')?.data).toEqual([]);
  });
});
