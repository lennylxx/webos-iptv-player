import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import type { PlaylistEntry } from '../types';
import type { CatalogListState } from './idb-cache';

const { clientMock, cacheStore, cacheState, refusedStore } = vi.hoisted(() => ({
  refusedStore: new Map<string, number>(),
  clientMock: {
    getVodCategories: vi.fn(),
    getVodStreams: vi.fn(),
    getVodInfo: vi.fn(),
    getSeriesCategories: vi.fn(),
    getSeries: vi.fn(),
    getSeriesInfo: vi.fn(),
    getVodCatalog: vi.fn(),
    getSeriesCatalog: vi.fn(),
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
    getWholeCatalogRefusedAt: vi.fn((key: string) => refusedStore.get(key) ?? null),
    setWholeCatalogRefusedAt: vi.fn((key: string, at: number) => { refusedStore.set(key, at); }),
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
  preloadSearchCatalog,
} from './xtream-catalog';
import { getCachedCatalog, setCachedCatalog, setCachedCatalogState } from './idb-cache';
import { CONFIG } from '../config';
import { XtreamRequestError } from './xtream-client';
import { StorageService } from './storage-service';
import { CatalogColumnsBuilder, type CatalogColumns } from './catalog-table';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};

function columnsOf(kind: 'vod' | 'series', ...rows: Array<[string, string]>): CatalogColumns {
  const builder = new CatalogColumnsBuilder(kind, 'x1');
  rows.forEach(([id, name], i) => builder.add({ id, name, poster: '', rating: '', categoryId: String(i + 1) }));
  return builder.build();
}

// The device cache often has no room for a whole catalog; writes then do nothing.
function skipCatalogWrites(): () => void {
  const original = vi.mocked(setCachedCatalog).getMockImplementation()!;
  vi.mocked(setCachedCatalog).mockImplementation(async () => undefined);
  return () => { vi.mocked(setCachedCatalog).mockImplementation(original); };
}

// Background refreshes chain a few promises; a macrotask drains them all.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  cacheStore.clear();
  refusedStore.clear();
  // A fresh generation per test drops catalogs a previous test kept in memory.
  cacheState.generation += 1000;
  vi.clearAllMocks();
  vi.mocked(StorageService.getXtreamCatalogRefreshIntervalMs)
    .mockReturnValue(CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS);
  clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
  clientMock.getSeriesCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
});

describe('xtream-catalog', () => {
  it('uses the oldest whole-catalog timestamp for Search memory expiry without reading payloads', async () => {
    const oldest = Date.now() - 2 * 60 * 60 * 1000;
    cacheStore.set('x1|vod_all-v3', {
      key: 'x1|vod_all-v3',
      timestamp: oldest,
      data: columnsOf('vod'),
    });
    cacheStore.set('x1|series_all-v3', {
      key: 'x1|series_all-v3',
      timestamp: Date.now() - 60 * 60 * 1000,
      data: columnsOf('series'),
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
    clientMock.getVodCatalog.mockResolvedValue(columnsOf('vod', ['10', 'Movie One']));
    await loadAllVodStreams(account);
    expect(listener.mock.calls).toEqual([['x1|vod_all-v3']]);

    await loadAllVodStreams(account);
    expect(listener).toHaveBeenCalledTimes(1);

    const stale = Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    cacheStore.set('x1|series_all-v3', { key: 'x1|series_all-v3', timestamp: stale, data: columnsOf('series', ['old', 'Old']) });
    clientMock.getSeriesCatalog.mockResolvedValue(columnsOf('series', ['20', 'Series One']));
    await loadAllSeries(account);
    await settle();
    stop();
    expect(listener.mock.calls).toEqual([['x1|vod_all-v3'], ['x1|series_all-v3']]);
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
  describe.each([
    { resource: 'vod_all', kind: 'vod' as const, load: loadAllVodStreams, fetch: clientMock.getVodCatalog, categories: clientMock.getVodCategories, idKey: 'streamId', key: 'x1|vod_all-v3' },
    { resource: 'series_all', kind: 'series' as const, load: loadAllSeries, fetch: clientMock.getSeriesCatalog, categories: clientMock.getSeriesCategories, idKey: 'seriesId', key: 'x1|series_all-v3' },
  ])('$resource', ({ resource, kind, load, fetch, categories, idKey, key }) => {
    const first = columnsOf(kind, ['10', 'Item One']);
    const both = columnsOf(kind, ['10', 'Item One'], ['20', 'Item Two']);
    const second = columnsOf(kind, ['20', 'Item Two']);
    const stale = () => Date.now() - CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS - 1;
    const ids = (table: { length: number; idAt: (index: number) => string }) =>
      Array.from({ length: table.length }, (_, i) => table.idAt(i));

    it('fetches the whole catalog in one request and writes it by column', async () => {
      fetch.mockResolvedValue(both);
      const table = await load(account);
      expect(ids(table)).toEqual(['10', '20']);
      expect(table.item(1)).toMatchObject({ accountId: 'x1', [idKey]: '20', name: 'Item Two', categoryId: '2' });
      expect(fetch.mock.calls).toEqual([[undefined]]);
      expect(categories).not.toHaveBeenCalled();
      expect(setCachedCatalog).toHaveBeenCalledWith(
        key,
        both,
        CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
        { complete: true, refreshAfter: expect.any(Number), freshSince: expect.any(Number) },
      );
    });

    it('returns a fresh catalog without calling the client', async () => {
      cacheStore.set(key, { key, timestamp: Date.now(), data: first });
      expect(ids(await load(account))).toEqual(['10']);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('ignores a list an older version stored as one object per title', async () => {
      cacheStore.set(key, { key, timestamp: Date.now(), data: [{ [idKey]: 'old', name: 'Old' }] });
      fetch.mockResolvedValue(first);
      expect(ids(await load(account))).toEqual(['10']);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('serves a stale catalog at once and refreshes it with one request', async () => {
      cacheStore.set(key, { key, timestamp: stale(), data: first });
      fetch.mockResolvedValue(second);
      expect(ids(await load(account))).toEqual(['10']);
      await settle();
      expect(fetch.mock.calls).toEqual([[undefined]]);
      expect(ids(await load(account))).toEqual(['20']);
    });

    // A large panel answered a failed whole list with hundreds of category
    // requests on every search, which got accounts blocked.
    it('does not load by category after the whole list fails, and waits before asking again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetch.mockRejectedValue(new XtreamRequestError('too_large', 'Response exceeds limit'));
      await expect(load(account)).rejects.toMatchObject({ code: 'too_large' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(categories).not.toHaveBeenCalled();
      expect(clientMock.getVodStreams).not.toHaveBeenCalled();
      expect(clientMock.getSeries).not.toHaveBeenCalled();
      expect(cacheStore.has(key)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[Catalog]',
        'Catalog list failed; it will be requested again later',
        'event=xtream.catalog.whole_failed',
        `resource=${resource}`,
        'reason=too_large',
        `retryMs=${CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS}`,
      );

      // The failure is kept outside the evictable cache, so a prune cannot
      // send the request again either.
      cacheStore.clear();
      fetch.mockClear();
      await expect(load(account)).rejects.toMatchObject({ code: 'request_failed' });
      expect(fetch).not.toHaveBeenCalled();

      const retryAt = Date.now() + CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS;
      const now = vi.spyOn(Date, 'now').mockReturnValue(retryAt);
      fetch.mockResolvedValue(first);
      expect(ids(await load(account))).toEqual(['10']);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(categories).not.toHaveBeenCalled();
      now.mockRestore();
      warn.mockRestore();
    });

    it('keeps the stale catalog when a refresh comes back empty', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      cacheStore.set(key, { key, timestamp: stale(), data: first });
      fetch.mockResolvedValue(columnsOf(kind));
      expect(ids(await load(account))).toEqual(['10']);
      await settle();
      expect(cacheStore.get(key)?.data).toBe(first);
      expect(refusedStore.has(`x1|${resource}`)).toBe(true);
      expect(categories).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('renews only the freshness of an unchanged catalog', async () => {
      const timestamp = stale();
      cacheStore.set(key, {
        key, timestamp, data: first,
        state: { complete: true, refreshAfter: Date.now() - 1, freshSince: timestamp },
      });
      fetch.mockResolvedValue(columnsOf(kind, ['10', 'Item One']));
      const refreshed = vi.fn();
      const stop = onCatalogListRefreshed(refreshed);
      try {
        await load(account);
        await settle();
        expect(setCachedCatalog).not.toHaveBeenCalled();
        expect(setCachedCatalogState).toHaveBeenCalledWith(
          key, timestamp, expect.objectContaining({ complete: true }),
          CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
        );
        expect(refreshed).toHaveBeenCalledExactlyOnceWith(key, false);
      } finally {
        stop();
      }
    });

    it('propagates cancellation without recording a failure', async () => {
      const controller = new AbortController();
      fetch.mockImplementation(() => {
        controller.abort();
        return Promise.reject(new XtreamRequestError('cancelled', 'Request was cancelled'));
      });
      await expect(load(account, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(refusedStore.has(`x1|${resource}`)).toBe(false);
    });
  });

  // The cache had no room for the lists next to the channel list, so every
  // Search open downloaded both of them again.
  it('serves a catalog the cache could not keep from memory until it expires', async () => {
    const restore = skipCatalogWrites();
    onTestFinished(restore);
    clientMock.getVodCatalog.mockResolvedValue(columnsOf('vod', ['10', 'Movie']));
    clientMock.getSeriesCatalog.mockResolvedValue(columnsOf('series', ['s1', 'Show']));
    const start = Date.now();
    await loadAllVodStreams(account);
    await loadAllSeries(account);
    expect((await loadAllVodStreams(account)).idAt(0)).toBe('10');
    expect((await loadAllSeries(account)).idAt(0)).toBe('s1');
    expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(1);
    expect(clientMock.getSeriesCatalog).toHaveBeenCalledTimes(1);
    const interval = CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
    expect(await getSearchCatalogExpiresAt('x1')).toBeGreaterThanOrEqual(start + interval);

    const now = vi.spyOn(Date, 'now').mockReturnValue(start + interval + 1);
    try {
      await loadAllVodStreams(account);
      expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('forgets a catalog kept in memory once the catalog cache is cleared', async () => {
    onTestFinished(skipCatalogWrites());
    clientMock.getVodCatalog.mockResolvedValue(columnsOf('vod', ['10', 'Movie']));
    await loadAllVodStreams(account);
    cacheState.generation++;
    await loadAllVodStreams(account);
    expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(2);
  });

  it('shares one download between the startup preload and a Search open', async () => {
    clientMock.getVodCatalog.mockResolvedValue(columnsOf('vod', ['10', 'Movie']));
    clientMock.getSeriesCatalog.mockResolvedValue(columnsOf('series', ['s1', 'Show']));
    const preload = preloadSearchCatalog(account);
    const [movies, series] = await Promise.all([loadAllVodStreams(account), loadAllSeries(account)]);
    await preload;
    expect([movies.length, series.length]).toEqual([1, 1]);
    expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(1);
    expect(clientMock.getSeriesCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps downloading after the Search that started it closes', async () => {
    let release = (): void => undefined;
    clientMock.getVodCatalog.mockImplementation(() => new Promise(resolve => {
      release = () => resolve(columnsOf('vod', ['10', 'Movie']));
    }));
    const controller = new AbortController();
    const closed = loadAllVodStreams(account, controller.signal);
    await settle();
    controller.abort();
    await expect(closed).rejects.toMatchObject({ code: 'cancelled' });
    release();
    expect((await loadAllVodStreams(account)).idAt(0)).toBe('10');
    expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(1);
    expect(refusedStore.size).toBe(0);
  });

  it('logs a failed preload without throwing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      clientMock.getVodCatalog.mockRejectedValue(new XtreamRequestError('http_error', 'HTTP 403'));
      clientMock.getSeriesCatalog.mockResolvedValue(columnsOf('series', ['s1', 'Show']));
      await expect(preloadSearchCatalog(account)).resolves.toBeUndefined();
      expect(info).toHaveBeenCalledWith(
        '[Catalog]',
        'Search catalog preload failed',
        'event=xtream.catalog.preload.failed',
        'reason=http_error',
      );
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('requests one unfiltered list at a time', async () => {
    let releaseMovies = (): void => undefined;
    clientMock.getVodCatalog.mockImplementation(() => new Promise(resolve => {
      releaseMovies = () => resolve(columnsOf('vod', ['10', 'Movie']));
    }));
    clientMock.getSeriesCatalog.mockResolvedValue(columnsOf('series', ['s1', 'Show']));
    const movies = loadAllVodStreams(account);
    const series = loadAllSeries(account);
    await settle();
    expect(clientMock.getVodCatalog).toHaveBeenCalledTimes(1);
    expect(clientMock.getSeriesCatalog).not.toHaveBeenCalled();

    releaseMovies();
    expect((await movies).length).toBe(1);
    expect((await series).length).toBe(1);
    expect(clientMock.getSeriesCatalog).toHaveBeenCalledTimes(1);
  });
});
