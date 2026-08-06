import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry } from '../types';

const { clientMock, cacheStore } = vi.hoisted(() => ({
  clientMock: {
    getVodCategories: vi.fn(),
    getVodStreams: vi.fn(),
    getVodInfo: vi.fn(),
    getSeriesCategories: vi.fn(),
    getSeries: vi.fn(),
    getSeriesInfo: vi.fn(),
  },
  cacheStore: new Map<string, { key: string; timestamp: number; data: unknown }>(),
}));

vi.mock('./xtream-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./xtream-client')>(),
  createXtreamClient: () => clientMock,
}));
vi.mock('./idb-cache', () => ({
  getCachedCatalog: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  setCachedCatalog: vi.fn(async (key: string, data: unknown) => {
    cacheStore.set(key, { key, timestamp: Date.now(), data });
  }),
}));

import { loadVodCategories, loadVodStreams, loadVodInfo, loadSeriesCategories, loadSeries, loadSeriesInfo, loadAllVodStreams, loadAllSeries } from './xtream-catalog';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import { CONFIG } from '../config';
import { XtreamRequestError } from './xtream-client';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};

beforeEach(() => {
  cacheStore.clear();
  vi.clearAllMocks();
});

describe('xtream-catalog', () => {
  it('fetches on a cold cache and writes the result under an account-scoped key', async () => {
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadVodCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|vod_categories', out);
  });

  it('returns fresh cache without calling the client', async () => {
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadVodStreams(account, '1');
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('re-fetches when the cached entry is stale', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|vod_categories', { key: 'x1|vod_categories', timestamp: stale, data: [{ id: 'old', name: 'Old' }] });
    clientMock.getVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadVodCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getVodCategories).toHaveBeenCalledTimes(1);
  });

  it('falls back to stale cache when a stale re-fetch returns empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|vod_streams|1', { key: 'x1|vod_streams|1', timestamp: stale, data: [{ accountId: 'x1', streamId: '10' }] });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadVodStreams(account, '1');
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled(); // an empty re-fetch must not overwrite the stale copy
    expect(warn).toHaveBeenCalledWith(
      '[Catalog]',
      'Catalog refresh was empty; serving stale data',
      'event=xtream.catalog.stale',
      'resource=vod_streams',
      'reason=empty',
      'items=1',
    );
    warn.mockRestore();
  });

  it('falls back to stale VOD info when a stale re-fetch returns null', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
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
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|vod_info|10', ok);

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

  it('serves stale data after a failed refresh but surfaces cold-cache failures', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
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

  it('does not turn cancellation into a stale-cache success', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|vod_categories', {
      key: 'x1|vod_categories',
      timestamp: stale,
      data: [{ id: 'old', name: 'Old' }],
    });
    clientMock.getVodCategories.mockRejectedValue(new XtreamRequestError(
      'cancelled',
      'Xtream request was cancelled',
    ));

    await expect(loadVodCategories(account)).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('xtream-catalog series', () => {
  const info = { seasons: [1], episodesBySeason: { 1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 0, plot: '', poster: '' }] } };

  it('fetches series categories on a cold cache and writes an account-scoped key', async () => {
    clientMock.getSeriesCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const out = await loadSeriesCategories(account);
    expect(out).toEqual([{ id: '1', name: 'Cat A' }]);
    expect(clientMock.getSeriesCategories).toHaveBeenCalledTimes(1);
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|series_categories', out);
  });

  it('returns a fresh series list without calling the client', async () => {
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadSeries(account, '1');
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('re-fetches series when the cached list is stale', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1' }]);
    const out = await loadSeries(account, '1');
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale series list when a re-fetch returns empty', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|series|1', { key: 'x1|series|1', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadSeries(account, '1');
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('caches series info and skips the write on a null response', async () => {
    clientMock.getSeriesInfo.mockResolvedValueOnce(info);
    const ok = await loadSeriesInfo(account, 's1');
    expect(ok?.seasons).toEqual([1]);
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|series_info|s1', ok);

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
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|series_info|s1', { key: 'x1|series_info|s1', timestamp: stale, data: info });
    clientMock.getSeriesInfo.mockResolvedValue(null);
    expect(await loadSeriesInfo(account, 's1')).toEqual(info);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });
});

describe('xtream-catalog whole-catalog (search)', () => {
  it('fetches the full VOD catalog with no category and writes vod_all', async () => {
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10', name: 'Movie One' }]);
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10', name: 'Movie One' }]);
    expect(clientMock.getVodStreams).toHaveBeenCalledWith(undefined, undefined);
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|vod_all', out);
  });

  it('returns the fresh full VOD catalog without calling the client', async () => {
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: Date.now(), data: [{ accountId: 'x1', streamId: '10' }] });
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).not.toHaveBeenCalled();
  });

  it('re-fetches the full VOD catalog when the cache is stale', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: [{ accountId: 'x1', streamId: 'old' }] });
    clientMock.getVodStreams.mockResolvedValue([{ accountId: 'x1', streamId: '10' }]);
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(clientMock.getVodStreams).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale full VOD catalog when a re-fetch returns empty', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|vod_all', { key: 'x1|vod_all', timestamp: stale, data: [{ accountId: 'x1', streamId: '10' }] });
    clientMock.getVodStreams.mockResolvedValue([]);
    const out = await loadAllVodStreams(account);
    expect(out).toEqual([{ accountId: 'x1', streamId: '10' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });

  it('fetches the full series catalog with no category and writes series_all', async () => {
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(clientMock.getSeries).toHaveBeenCalledWith(undefined, undefined);
    expect(setCachedCatalog).toHaveBeenCalledWith('x1|series_all', out);
  });

  it('returns the fresh full series catalog without calling the client', async () => {
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: Date.now(), data: [{ accountId: 'x1', seriesId: 's1' }] });
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(clientMock.getSeries).not.toHaveBeenCalled();
  });

  it('re-fetches the full series catalog when the cached entry is stale', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ accountId: 'x1', seriesId: 'old' }] });
    clientMock.getSeries.mockResolvedValue([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1', name: 'Series One' }]);
    expect(clientMock.getSeries).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale full series catalog when a re-fetch returns empty', async () => {
    const stale = Date.now() - CONFIG.XTREAM.CATALOG_TTL_MS - 1;
    cacheStore.set('x1|series_all', { key: 'x1|series_all', timestamp: stale, data: [{ accountId: 'x1', seriesId: 's1' }] });
    clientMock.getSeries.mockResolvedValue([]);
    const out = await loadAllSeries(account);
    expect(out).toEqual([{ accountId: 'x1', seriesId: 's1' }]);
    expect(setCachedCatalog).not.toHaveBeenCalled();
  });
});
