// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Channel } from '../types';
import { CONFIG } from '../config';
import {
  cacheRecordRef,
  catalogCacheGeneration,
  clearAllCachedData,
  clearCachedCatalog,
  clearCachedEpg,
  clearCachedPlaylist,
  clearCachedStreamMimes,
  clearCachedChannelHealth,
  flushCacheWrites,
  getCacheUsage,
  getCachedCatalog,
  getCachedCatalogMetadata,
  getCachedEpg,
  getCachedPlaylist,
  getCachedStreamMime,
  getCachedChannelHealth,
  getCachedSubtitle,
  migrateLegacyStreamMimeCache,
  onPlaylistCacheWritten,
  reserveSearchIndex,
  settleSearchIndex,
  playlistCacheToken,
  scheduleCachedPlaylist,
  setCachedCatalog,
  setCachedCatalogState,
  setCachedEpg,
  setCachedPlaylist,
  setCachedStreamMime,
  setCachedChannelHealth,
  setCachedSubtitle,
} from './idb-cache';
import {
  CACHE_META_STORE,
  CATALOG_STORE,
  CHANNEL_HEALTH_STORE,
  openPersistenceDb,
  requestResult,
  SEARCH_INDEX_STORE,
  STREAM_MIME_STORE,
  SUBTITLE_STORE,
  transactionDone,
} from './idb-database';
import { cachedNameDocuments } from '../workers/search-cache-documents';
import { buildSourceIndex } from '../workers/search-source-index';
import { IdbSearchCacheReader } from '../workers/search-cache-reader';

const channel = (id: string): Channel => ({
  id,
  name: 'Alpha',
  logo: '',
  group: '',
  url: 'http://host/a',
  extras: null,
  playlistIds: ['p1'],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
});

describe('idb-cache', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllCachedData();
  });

  it('uses the next schema version after the published v3 database', async () => {
    const db = await openPersistenceDb();
    expect(db?.version).toBe(7);
    expect(db?.objectStoreNames.contains(STREAM_MIME_STORE)).toBe(true);
    expect(db?.objectStoreNames.contains('search-index-cache')).toBe(true);
  });

  it('stores channel health records separately and accounts for them', async () => {
    await setCachedChannelHealth({
      ch1: { status: 'healthy' },
      ch2: { status: 'suspect' },
    });
    await setCachedChannelHealth({ ch1: { status: 'unavailable' } });

    expect(await getCachedChannelHealth()).toEqual({
      ch1: { status: 'unavailable' },
      ch2: { status: 'suspect' },
    });
    expect((await getCacheUsage()).categories.health.entries).toBe(2);

    await clearCachedChannelHealth();
    expect(await getCachedChannelHealth()).toEqual({});
    expect((await getCacheUsage()).categories.health.entries).toBe(0);
  });

  it('treats a channel health cache read failure as an empty cache', async () => {
    const transaction = IDBDatabase.prototype.transaction;
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
    ) {
      if (storeNames === CHANNEL_HEALTH_STORE) throw new Error('read failed');
      return transaction.call(this, storeNames, mode);
    });

    try {
      expect(await getCachedChannelHealth()).toEqual({});
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it('round-trips a cached subtitle', async () => {
    await setCachedSubtitle('subdl:1', 'WEBVTT\n\nhi');
    expect(await getCachedSubtitle('subdl:1')).toContain('hi');
    expect(await getCachedSubtitle('missing')).toBeNull();
  });

  it('stores stream MIME probes in their cache store and expires them', async () => {
    await setCachedStreamMime('http://host/live', 'video/mp2t');
    expect(await getCachedStreamMime('http://host/live')).toBe('video/mp2t');
    expect((await getCacheUsage()).categories.catalog.entries).toBe(1);

    const db = await openPersistenceDb();
    expect(db).not.toBeNull();
    const readTx = db!.transaction(STREAM_MIME_STORE, 'readonly');
    const record = await requestResult(
      readTx.objectStore(STREAM_MIME_STORE).get('http://host/live'),
    );
    const writeTx = db!.transaction(STREAM_MIME_STORE, 'readwrite');
    writeTx.objectStore(STREAM_MIME_STORE).put({ ...record, expiresAt: Date.now() - 1 });
    await transactionDone(writeTx);

    expect(await getCachedStreamMime('http://host/live')).toBeNull();
    expect((await getCacheUsage()).categories.catalog.entries).toBe(0);
  });

  it('migrates legacy stream MIME probes and removes their localStorage key', async () => {
    localStorage.setItem('iptv_stream_mimes', JSON.stringify({
      'http://host/live': { mime: 'video/mp2t', updatedAt: Date.now() },
      'http://host/expired': { mime: 'video/mp2t', updatedAt: 0 },
    }));

    await migrateLegacyStreamMimeCache();

    expect(localStorage.getItem('iptv_stream_mimes')).toBeNull();
    expect(await getCachedStreamMime('http://host/live')).toBe('video/mp2t');
    expect(await getCachedStreamMime('http://host/expired')).toBeNull();
  });

  it('clears stream MIME records without clearing catalog records', async () => {
    await setCachedCatalog('x1|vod_categories', ['a']);
    await setCachedStreamMime('http://host/live', 'video/mp2t');

    await clearCachedStreamMimes();

    expect(await getCachedStreamMime('http://host/live')).toBeNull();
    expect(await getCachedCatalog('x1|vod_categories')).not.toBeNull();
    expect((await getCacheUsage()).categories.catalog.entries).toBe(1);
  });

  it('clears catalog records without clearing stream MIME records', async () => {
    await setCachedCatalog('x1|vod_categories', ['a']);
    await setCachedStreamMime('http://host/live', 'video/mp2t');

    await clearCachedCatalog();

    expect(await getCachedCatalog('x1|vod_categories')).toBeNull();
    expect(await getCachedStreamMime('http://host/live')).toBe('video/mp2t');
  });

  it('advances the catalog generation on every catalog clear', async () => {
    const before = catalogCacheGeneration();
    await clearCachedCatalog();
    expect(catalogCacheGeneration()).toBe(before + 1);
    await clearAllCachedData();
    expect(catalogCacheGeneration()).toBe(before + 2);
  });

  it('includes stream MIME records in the shared cache eviction pass', async () => {
    await setCachedStreamMime('http://host/live', 'video/mp2t');
    const storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 0, quota: 100 }) },
    });
    try {
      await setCachedCatalog('x1|vod_categories', ['a']);
    } finally {
      if (storageDescriptor) {
        Object.defineProperty(navigator, 'storage', storageDescriptor);
      } else {
        delete (navigator as Navigator & { storage?: StorageManager }).storage;
      }
    }

    expect(await getCachedStreamMime('http://host/live')).toBeNull();
    expect(await getCachedCatalog('x1|vod_categories')).not.toBeNull();
  });

  it('removes an expired subtitle instead of serving it', async () => {
    await setCachedSubtitle('subdl:expired', 'WEBVTT\n\nold');
    const db = await openPersistenceDb();
    expect(db).not.toBeNull();
    const readTx = db!.transaction(SUBTITLE_STORE, 'readonly');
    const record = await requestResult(readTx.objectStore(SUBTITLE_STORE).get('subdl:expired'));
    const writeTx = db!.transaction(SUBTITLE_STORE, 'readwrite');
    writeTx.objectStore(SUBTITLE_STORE).put({
      ...record,
      expiresAt: Date.now() - 1,
    });
    await transactionDone(writeTx);

    expect(await getCachedSubtitle('subdl:expired')).toBeNull();
    expect((await getCacheUsage()).categories.subtitle.entries).toBe(0);
  });

  it('clears every cache when resetting the app', async () => {
    await setCachedEpg('http://host/epg', { channels: {}, programmes: {} });
    await setCachedCatalog('x1|categories', ['a']);
    await setCachedSubtitle('subdl:2', 'WEBVTT\n\nhi');
    await setCachedChannelHealth({ ch1: { status: 'healthy' } });

    await clearAllCachedData();

    expect(await getCachedEpg('http://host/epg')).toBeNull();
    expect(await getCachedCatalog('x1|categories')).toBeNull();
    expect(await getCachedSubtitle('subdl:2')).toBeNull();
    expect(await getCachedChannelHealth()).toEqual({});
  });

  it('stores parsed playlists outside localStorage', async () => {
    const channels = [channel('ch1')];
    const sources = [{ url: 'http://host/epg', playlistIds: ['p1'], kind: 'm3u' as const }];

    expect(await setCachedPlaylist(channels, sources)).toBe(true);

    expect(await getCachedPlaylist()).toEqual({
      channels,
      epgSources: sources,
      timestamp: expect.any(Number),
    });
    expect(localStorage.getItem('iptv_cached_playlist')).toBeNull();
  });

  it('remembers which record a cached playlist or catalog came from', async () => {
    const channels = [channel('ch1')];
    expect(cacheRecordRef(channels)).toBeNull();
    await setCachedPlaylist(channels, [], 1234);
    expect(cacheRecordRef(channels)).toEqual({
      store: 'playlist-cache',
      key: 'combined-v3',
      timestamp: 1234,
    });
    const read = await getCachedPlaylist(null);
    expect(read?.channels).not.toBe(channels);
    expect(cacheRecordRef(read?.channels)).toEqual({
      store: 'playlist-cache',
      key: 'combined-v3',
      timestamp: 1234,
    });

    const items = [{ name: 'Alpha' }];
    await setCachedCatalog('x1|vod_all', items);
    const stored = cacheRecordRef(items);
    expect(stored).toMatchObject({ store: 'catalog-cache', key: 'x1|vod_all' });
    const catalog = await getCachedCatalog('x1|vod_all');
    expect(cacheRecordRef(catalog?.data)).toEqual({ ...stored, timestamp: catalog?.timestamp });
  });

  it('lets the search worker read the catalog records written here', async () => {
    const items = [{ name: 'Alpha' }, { name: 'Bravo' }];
    await setCachedCatalog('x1|vod_all', items);
    await flushCacheWrites();
    const record = cacheRecordRef(items)!;

    const raw = await new IdbSearchCacheReader(indexedDB).read(record, 1200);
    expect(cachedNameDocuments(buildSourceIndex(record, raw), {
      record,
      length: 2,
      selection: null,
      samples: { indices: [1], documents: [['Bravo']] },
    })).toEqual(['alpha', 'bravo']);
  });

  it('keeps partial catalog freshness separate from the worker record timestamp', async () => {
    const items = [{ name: 'Alpha' }];
    const state = { complete: false, refreshAfter: Date.now() + 60_000 };
    await setCachedCatalog('x1|vod_all', items, null, state);

    const cached = await getCachedCatalog('x1|vod_all');
    expect(cached?.state).toEqual(state);
    expect(cacheRecordRef(items)).toEqual({
      store: 'catalog-cache', key: 'x1|vod_all', timestamp: cached?.timestamp,
    });
    const record = cacheRecordRef(items)!;
    const raw = await new IdbSearchCacheReader(indexedDB).read(record, 1200);
    expect(cachedNameDocuments(buildSourceIndex(record, raw), {
      record,
      length: 1,
      selection: null,
      samples: { indices: [0], documents: [['Alpha']] },
    })).toEqual(['alpha']);
  });

  it('updates catalog retry metadata without writing the payload or changing its source version', async () => {
    const items = [{ name: 'Alpha' }];
    await setCachedCatalog('x1|vod_all', items, null, {
      complete: false, refreshAfter: Date.now() + 60_000,
    });
    const ref = cacheRecordRef(items)!;
    const state = { complete: false, refreshAfter: Date.now() + 120_000 };
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    try {
      expect(await setCachedCatalogState('x1|vod_all', ref.timestamp, state)).toBe(true);
      expect(await getCachedCatalog('x1|vod_all')).toMatchObject({
        timestamp: ref.timestamp, data: items, state,
      });
      expect(put.mock.calls.filter(([record], index) =>
        put.mock.contexts[index]?.name === CATALOG_STORE
        && (record as { key?: unknown }).key === 'x1|vod_all')).toHaveLength(0);
      expect(cacheRecordRef(items)).toEqual(ref);
    } finally {
      put.mockRestore();
    }
  });

  it('reads renewed catalog freshness without reading the catalog payload', async () => {
    const state = { complete: false, refreshAfter: Date.now() + 60_000 };
    const items = [{ name: 'Alpha' }];
    await setCachedCatalog('x1|vod_all', items, null, state);
    const timestamp = cacheRecordRef(items)!.timestamp;
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    try {
      expect(await getCachedCatalogMetadata('x1|vod_all')).toEqual({ timestamp, state });
      const renewed = { complete: true, refreshAfter: Date.now() + 60_000, freshSince: Date.now() };
      expect(await setCachedCatalogState('x1|vod_all', timestamp, renewed, null)).toBe(true);
      expect(await getCachedCatalogMetadata('x1|vod_all')).toEqual({ timestamp, state: renewed });
      expect(await getCachedCatalogMetadata('x1|missing')).toBeNull();
      expect(get.mock.calls.filter((_, index) => get.mock.contexts[index]?.name === CATALOG_STORE))
        .toHaveLength(0);
    } finally {
      get.mockRestore();
    }
    expect(await getCachedCatalog('x1|vod_all')).toMatchObject({ timestamp, state: { complete: true } });
  });

  it.each(['payload', 'metadata'] as const)('handles metadata read failure during a %s lookup', async mode => {
    const items = [{ name: 'Alpha' }];
    const state = { complete: false, refreshAfter: Date.now() + 60_000 };
    await setCachedCatalog('x1|vod_all', items, null, state);
    const timestamp = cacheRecordRef(items)!.timestamp;
    const error = new Error('metadata read failed');
    const get = IDBObjectStore.prototype.get;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore, key: IDBValidKey | IDBKeyRange,
    ) {
      if (this.name === CACHE_META_STORE && key === 'entry:catalog-cache:x1|vod_all') throw error;
      return get.call(this, key);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      if (mode === 'payload') {
        await expect(getCachedCatalog('x1|vod_all')).resolves.toMatchObject({
          timestamp, data: items, state,
        });
      } else {
        await expect(getCachedCatalogMetadata('x1|vod_all')).resolves.toBeNull();
      }
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[CacheStorage]', 'Catalog metadata read failed', 'event=xtream.cache.read.failed',
        'operation=read', 'category=catalog', 'reason=metadata', error,
      );
    } finally {
      getSpy.mockRestore();
      warn.mockRestore();
    }
  });

  it('backfills a legacy catalog version before using metadata-only freshness reads', async () => {
    await setCachedCatalog('x1|vod_all', [{ name: 'Alpha' }]);
    const db = (await openPersistenceDb())!;
    const read = db.transaction(CACHE_META_STORE, 'readonly');
    const legacy = await requestResult(
      read.objectStore(CACHE_META_STORE).get('entry:catalog-cache:x1|vod_all'),
    ) as Record<string, unknown>;
    const timestamp = legacy.timestamp;
    delete legacy.timestamp;
    const write = db.transaction(CACHE_META_STORE, 'readwrite');
    write.objectStore(CACHE_META_STORE).put(legacy);
    await transactionDone(write);

    expect(await getCachedCatalogMetadata('x1|vod_all')).toEqual({ timestamp });
    await new Promise(resolve => setTimeout(resolve, 0));
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    try {
      expect(await getCachedCatalogMetadata('x1|vod_all')).toEqual({ timestamp });
      expect(get.mock.calls.filter((_, index) => get.mock.contexts[index]?.name === CATALOG_STORE))
        .toHaveLength(0);
    } finally {
      get.mockRestore();
    }
  });

  it('reports a failed catalog metadata renewal without changing the existing state', async () => {
    const items = [{ name: 'Alpha' }];
    const state = { complete: false, refreshAfter: Date.now() + 60_000 };
    await setCachedCatalog('x1|vod_all', items, null, state);
    const timestamp = cacheRecordRef(items)!.timestamp;
    const transaction = IDBDatabase.prototype.transaction;
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
    ) {
      if (storeNames === CACHE_META_STORE && mode === 'readwrite') throw new Error('write failed');
      return transaction.call(this, storeNames, mode);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await setCachedCatalogState('x1|vod_all', timestamp, {
        complete: true, refreshAfter: Date.now() + 120_000,
      })).toBe(false);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[CacheStorage]', 'Catalog cache write failed', 'event=xtream.cache.write.failed',
        'operation=write', 'category=catalog', expect.any(Error),
      );
    } finally {
      transactionSpy.mockRestore();
      warn.mockRestore();
    }
    expect(await getCachedCatalogMetadata('x1|vod_all')).toEqual({ timestamp, state });
  });

  it('rejects stale catalog state updates after a replacement or cache clear', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const oldState = { complete: false, refreshAfter: 2000 };
      await setCachedCatalog('x1|vod_all', [{ name: 'Alpha' }], null, oldState);
      expect(await setCachedCatalogState('x1|vod_all', 1000, {
        complete: false, refreshAfter: 3000,
      })).toBe(true);
      clock.mockReturnValue(1001);
      const nextState = { complete: true, refreshAfter: 4000, freshSince: 1001 };
      await setCachedCatalog('x1|vod_all', [{ name: 'Bravo' }], null, nextState);

      expect(await setCachedCatalogState('x1|vod_all', 1000, oldState)).toBe(false);
      expect((await getCachedCatalog('x1|vod_all'))?.state).toEqual(nextState);
      await clearCachedCatalog();
      expect(await setCachedCatalogState('x1|vod_all', 1001, nextState)).toBe(false);
      expect((await getCacheUsage()).categories.catalog.entries).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a renewed catalog out of expired eviction without changing its payload version', async () => {
    const hour = 60 * 60 * 1000;
    const initial = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(initial);
    const storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    try {
      const items = [{ name: 'Alpha' }];
      await setCachedCatalog('x1|vod_all', items, hour, {
        complete: true, freshSince: initial, refreshAfter: initial + hour,
      });
      await setCachedCatalog('x1|expired', ['x'.repeat(8 * 1024 * 1024)], 2 * hour);
      const ref = cacheRecordRef(items)!;
      clock.mockReturnValue(initial + 7 * hour);
      const renewed = {
        complete: true, freshSince: Date.now(), refreshAfter: Date.now() + 24 * hour,
      };
      expect(await setCachedCatalogState('x1|vod_all', ref.timestamp, renewed, 24 * hour)).toBe(true);
      expect(await getCachedCatalog('x1|vod_all')).toMatchObject({
        timestamp: ref.timestamp, data: items, state: renewed,
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      const db = (await openPersistenceDb())!;
      const tx = db.transaction(CACHE_META_STORE, 'readonly');
      const metadata = await requestResult(
        tx.objectStore(CACHE_META_STORE).get('entry:catalog-cache:x1|vod_all'),
      );
      expect(metadata).toMatchObject({
        timestamp: ref.timestamp, expiresAt: renewed.refreshAfter,
      });

      const used = (await getCacheUsage()).total.bytes;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage: 0, quota: 2 * (used - 1024 * 1024) }) },
      });
      await setCachedCatalog('x1|vod_categories', [{ id: '1', name: 'Cat A' }]);

      expect(await getCachedCatalog('x1|expired')).toBeNull();
      expect(await getCachedCatalog('x1|vod_all')).toMatchObject({
        timestamp: ref.timestamp, data: items, state: renewed,
      });
    } finally {
      clock.mockRestore();
      if (storageDescriptor) Object.defineProperty(navigator, 'storage', storageDescriptor);
      else delete (navigator as Navigator & { storage?: StorageManager }).storage;
    }
  });

  it('evaluates playlist freshness against the current refresh interval', async () => {
    const channels = [channel('ch1')];
    const timestamp = Date.now() - 2 * 60 * 60 * 1000;
    await setCachedPlaylist(channels, [], timestamp, 24 * 60 * 60 * 1000);

    expect(await getCachedPlaylist(60 * 60 * 1000)).toBeNull();
    expect(await getCachedPlaylist(null)).toEqual({
      channels,
      epgSources: [],
      timestamp,
    });
  });

  it('defers playlist persistence until after worker idle termination', async () => {
    const frames: FrameRequestCallback[] = [];
    let delayedWrite: (() => void) | null = null;
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS) {
          delayedWrite = () => {
            if (typeof callback === 'function') callback(...args);
          };
          return 1;
        }
        return originalSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    );
    try {
      scheduleCachedPlaylist([channel('ch1')]);
      expect(await getCachedPlaylist()).toBeNull();

      frames.shift()?.(0);
      expect(await getCachedPlaylist()).toBeNull();

      frames.shift()?.(16);
      expect(await getCachedPlaylist()).toBeNull();
      expect(timer).toHaveBeenCalledWith(
        expect.any(Function),
        CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS,
      );

      delayedWrite?.();
      await flushCacheWrites();
      expect(await getCachedPlaylist()).not.toBeNull();
    } finally {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      timer.mockRestore();
    }
  });

  it('does not serve a parsed playlist after its source configuration changes', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Alpha', url: 'http://host/a' },
    ]));
    await setCachedPlaylist([channel('ch1')]);

    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p2', name: 'Bravo', url: 'http://host/b' },
    ]));

    expect(await getCachedPlaylist()).toBeNull();
  });

  it('binds a delayed playlist write to the configuration that produced it', async () => {
    const frames: FrameRequestCallback[] = [];
    let delayedWrite: (() => void) | null = null;
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS) {
          delayedWrite = () => {
            if (typeof callback === 'function') callback(...args);
          };
          return 1;
        }
        return originalSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    );
    try {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { id: 'p1', name: 'Alpha', url: 'http://host/a' },
      ]));
      scheduleCachedPlaylist([channel('ch1')]);
      frames.shift()?.(0);
      frames.shift()?.(16);

      localStorage.setItem('iptv_playlists', JSON.stringify([
        { id: 'p2', name: 'Bravo', url: 'http://host/b' },
      ]));
      delayedWrite?.();
      await flushCacheWrites();

      expect(await getCachedPlaylist()).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      timer.mockRestore();
    }
  });

  it('drops a refresh result whose sources changed while it was loading', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Alpha', url: 'http://host/a' },
    ]));
    const token = playlistCacheToken();
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p2', name: 'Bravo', url: 'http://host/b' },
    ]));

    scheduleCachedPlaylist([channel('ch1')], [], Date.now(), null, token);
    await flushCacheWrites();

    expect(await getCachedPlaylist(null)).toBeNull();
  });

  it.each([
    ['playlist cache', clearCachedPlaylist],
    ['all caches', clearAllCachedData],
  ])('drops a refresh result that was loading while clearing %s', async (_label, clear) => {
    const token = playlistCacheToken();
    await clear();

    scheduleCachedPlaylist([channel('ch1')], [], Date.now(), null, token);
    await flushCacheWrites();

    expect(await getCachedPlaylist(null)).toBeNull();
  });

  it.each([
    ['playlist cache', clearCachedPlaylist],
    ['all caches', clearAllCachedData],
  ])('does not restore a scheduled playlist after clearing %s', async (_label, clear) => {
    const frames: FrameRequestCallback[] = [];
    let delayedWrite: (() => void) | null = null;
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS) {
          delayedWrite = () => {
            if (typeof callback === 'function') callback(...args);
          };
          return 1;
        }
        return originalSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout,
    );
    try {
      scheduleCachedPlaylist([channel('ch1')]);
      frames.shift()?.(0);
      frames.shift()?.(16);

      await clear();
      delayedWrite?.();
      await flushCacheWrites();

      expect(await getCachedPlaylist()).toBeNull();
    } finally {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      timer.mockRestore();
    }
  });

  it('accounts for cache usage by category and resets it on clear', async () => {
    await Promise.all([
      setCachedPlaylist([channel('ch1')]),
      setCachedEpg('http://host/epg', { channels: {}, programmes: {} }),
      setCachedCatalog('x1|vod_categories', ['a']),
      setCachedSubtitle('subdl:3', 'WEBVTT\n\nhello'),
    ]);

    const usage = await getCacheUsage();
    expect(usage.total.bytes).toBeGreaterThan(0);
    expect(usage.total.entries).toBe(4);
    expect(usage.categories.playlist.entries).toBe(1);
    expect(usage.categories.epg.entries).toBe(1);
    expect(usage.categories.catalog.entries).toBe(1);
    expect(usage.categories.subtitle.entries).toBe(1);
    expect(usage.budgetBytes).toBe(384 * 1024 * 1024);

    await clearAllCachedData();
    expect((await getCacheUsage()).total).toEqual({ bytes: 0, entries: 0 });
  });

  it('accounts for serialized bytes without changing JSON sizing semantics', async () => {
    await setCachedCatalog('x1|sizing', {
      text: '\u0000"\\é😀',
      values: [true, false, null, undefined, 12.5, Number.NaN],
    });
    const db = await openPersistenceDb();
    expect(db).not.toBeNull();
    const tx = db!.transaction([CATALOG_STORE, CACHE_META_STORE], 'readonly');
    const record = await requestResult(tx.objectStore(CATALOG_STORE).get('x1|sizing')) as
      Record<string, unknown>;
    const meta = await requestResult(
      tx.objectStore(CACHE_META_STORE).get('entry:catalog-cache:x1|sizing'),
    ) as { byteSize: number };
    const expected = new TextEncoder().encode(JSON.stringify({
      ...record,
      byteSize: 0,
    })).byteLength;

    expect(meta.byteSize).toBe(expected);
  });

  it('updates cache accounting without reading the previous payload', async () => {
    await setCachedCatalog('x1|vod_all', Array.from({ length: 100 }, (_, index) => index));
    const transaction = IDBDatabase.prototype.transaction;
    const payloadReads: Array<{ stores: string | string[]; mode?: IDBTransactionMode }> = [];
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(
      function (
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
      ) {
        if (mode === 'readonly'
            && (storeNames === CATALOG_STORE
              || (Array.isArray(storeNames) && storeNames.includes(CATALOG_STORE)))) {
          payloadReads.push({ stores: storeNames, mode });
        }
        return transaction.call(this, storeNames, mode);
      },
    );

    try {
      await setCachedCatalog('x1|vod_all', Array.from({ length: 200 }, (_, index) => index));
    } finally {
      transactionSpy.mockRestore();
    }

    expect(payloadReads).toEqual([]);
    expect((await getCacheUsage()).categories.catalog.entries).toBe(1);
  });

  it('touches access metadata without rewriting a cached payload', async () => {
    await setCachedCatalog('x1|vod_all', Array.from({ length: 100 }, (_, index) => index));
    const db = await openPersistenceDb();
    expect(db).not.toBeNull();
    const beforeTx = db!.transaction(CATALOG_STORE, 'readonly');
    const before = await requestResult(beforeTx.objectStore(CATALOG_STORE).get('x1|vod_all'));

    expect(await getCachedCatalog('x1|vod_all')).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));

    const afterTx = db!.transaction([CATALOG_STORE, CACHE_META_STORE], 'readonly');
    const after = await requestResult(afterTx.objectStore(CATALOG_STORE).get('x1|vod_all'));
    const access = await requestResult(
      afterTx.objectStore(CACHE_META_STORE).get('entry:catalog-cache:x1|vod_all'),
    );
    expect(after).toEqual(before);
    expect(access).toMatchObject({
      store: CATALOG_STORE,
      key: 'x1|vod_all',
    });
  });

  // A whole movie list once evicted the channel list, so the next start
  // downloaded every channel again and the panel refused part of it.
  it('never evicts a live channel list to make room for other data', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    try {
      const channels = [channel('ch1')];
      expect(await setCachedPlaylist(channels)).toBe(true);
      await setCachedSubtitle('subdl:1', `WEBVTT\n\n${'x'.repeat(1024)}`);
      const used = (await getCacheUsage()).total.bytes;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage: 0, quota: 2 * (used + 512) }) },
      });

      await setCachedCatalog('x1|vod_all-v3', ['x'.repeat(4096)]);
      expect(await getCachedPlaylist()).toMatchObject({ channels });
      expect(await getCachedCatalog('x1|vod_all-v3')).toBeNull();
      // Everything but the channel list still gives way first.
      expect(await getCachedSubtitle('subdl:1')).toBeNull();
      expect(info).toHaveBeenCalledWith(
        '[CacheStorage]',
        'Cache write skipped to keep the channel list',
        'event=persistence.cache.write.skipped',
        'reason=budget',
        'category=catalog',
        expect.stringMatching(/^requiredBytes=\d+$/),
        expect.stringMatching(/^freedBytes=\d+$/),
      );

      // A new channel list may still replace the old one.
      const replacement = [channel('ch2'), channel('ch3')];
      expect(await setCachedPlaylist(replacement)).toBe(true);
      expect(await getCachedPlaylist()).toMatchObject({ channels: replacement });
    } finally {
      info.mockRestore();
      if (storageDescriptor) Object.defineProperty(navigator, 'storage', storageDescriptor);
      else delete (navigator as Navigator & { storage?: StorageManager }).storage;
    }
  });

  it('keeps accounting correct when pruning the record being updated', async () => {
    await setCachedSubtitle('subdl:4', 'WEBVTT\n\nold');
    const storageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 0, quota: 100 }) },
    });
    try {
      await setCachedSubtitle('subdl:4', 'WEBVTT\n\nreplacement');
    } finally {
      if (storageDescriptor) {
        Object.defineProperty(navigator, 'storage', storageDescriptor);
      } else {
        delete (navigator as Navigator & { storage?: StorageManager }).storage;
      }
    }

    const usage = await getCacheUsage();
    expect(usage.categories.subtitle.entries).toBe(1);
    expect(usage.total.entries).toBe(1);
  });

  describe('search index records', () => {
    const MiB = 1024 * 1024;
    const candidate = (key: string, bytes: number, timestamp = 1) => ({
      key: `catalog-cache|${key}|${String(timestamp)}|v1`,
      prefix: `catalog-cache|${key}|`,
      bytes,
    });

    async function seedSource(key: string, timestamp = 1): Promise<void> {
      const now = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
      try {
        await setCachedCatalog(key, [key], null);
      } finally {
        now.mockRestore();
      }
    }

    let sourceBytes = 0;
    beforeEach(async () => {
      await seedSource('x1|vod_all');
      await seedSource('x1|series_all');
      sourceBytes = (await getCacheUsage()).total.bytes;
    });

    async function withQuota<T>(quota: number, usage: number, run: () => Promise<T>): Promise<T> {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage, quota }) },
      });
      try {
        return await run();
      } finally {
        if (descriptor) Object.defineProperty(navigator, 'storage', descriptor);
        else delete (navigator as Navigator & { storage?: StorageManager }).storage;
      }
    }

    async function writeIndex(key: string, extra: Record<string, unknown> = {}): Promise<void> {
      const db = (await openPersistenceDb())!;
      const tx = db.transaction(SEARCH_INDEX_STORE, 'readwrite');
      tx.objectStore(SEARCH_INDEX_STORE).put({ key, text: 'alpha', ...extra });
      await transactionDone(tx);
    }

    async function storedIndexKeys(): Promise<string[]> {
      const db = (await openPersistenceDb())!;
      const tx = db.transaction(SEARCH_INDEX_STORE, 'readonly');
      return await requestResult(tx.objectStore(SEARCH_INDEX_STORE).getAllKeys()) as string[];
    }

    it('accounts for a reserved index in its own category', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', MiB));
      expect(reservation?.fields).toMatchObject({ cacheCategory: 'search', byteSize: MiB });
      await writeIndex(candidate('x1|vod_all', MiB).key, reservation!.fields);
      await settleSearchIndex(candidate('x1|vod_all', MiB).key, reservation!, true);

      const usage = await getCacheUsage();
      expect(usage.categories.search).toEqual({ bytes: MiB, entries: 1 });
      expect(usage.total).toEqual({ bytes: sourceBytes + MiB, entries: 3 });
      expect(await storedIndexKeys()).toEqual([candidate('x1|vod_all', MiB).key]);
    });

    it('skips an index larger than its share of the room left', async () => {
      // FALLBACK budget 384 MiB: 10% is 38.4 MiB.
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await reserveSearchIndex(candidate('x1|vod_all', 39 * MiB))).toBeNull();
      expect(info.mock.calls.map(call => call.join(' '))).toContainEqual(expect.stringContaining(
        `event=search.index.persist.skipped reason=budget bytes=${String(39 * MiB)} roomBytes=${String(384 * MiB - sourceBytes)}`,
      ));
      info.mockRestore();
      expect(await reserveSearchIndex(candidate('x1|vod_all', 38 * MiB))).not.toBeNull();
      // Reserved bytes shrink the room for the next index.
      expect(await reserveSearchIndex(candidate('x1|series_all', 35 * MiB))).toBeNull();
      expect((await getCacheUsage()).categories.search.entries).toBe(1);
    });

    it('measures the room against the origin quota as well', async () => {
      await withQuota(100 * MiB, 75 * MiB, async () => {
        // 80% of quota leaves 5 MiB; 10% of that is 0.5 MiB.
        expect(await reserveSearchIndex(candidate('x1|vod_all', MiB))).toBeNull();
        expect(await reserveSearchIndex(candidate('x1|vod_all', MiB / 4))).not.toBeNull();
      });
    });

    it('replaces the older index of the same source', async () => {
      const old = candidate('x1|vod_all', MiB);
      const reservation = await reserveSearchIndex(old);
      expect(reservation?.evicted).toBe(0);
      await writeIndex(old.key, reservation!.fields);
      await writeIndex('catalog-cache|x1|vod_all|untracked|v1');
      await writeIndex('catalog-cache|x1|series_all|0|v1');
      await seedSource('x1|vod_all', 2);

      expect((await reserveSearchIndex(candidate('x1|vod_all', 2 * MiB, 2)))?.evicted).toBe(1);

      // The older index is gone even when the new one does not fit.
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await reserveSearchIndex(candidate('x1|vod_all', 39 * MiB, 2))).toBeNull();
      expect(info.mock.calls.map(call => call.join(' '))).toContainEqual(expect.stringMatching(
        /event=search\.index\.persist\.skipped reason=budget bytes=\d+ roomBytes=\d+ evicted=1$/,
      ));
      info.mockRestore();
      expect(await storedIndexKeys()).toEqual(['catalog-cache|x1|series_all|0|v1']);
      expect((await getCacheUsage()).categories.search).toEqual({ bytes: 0, entries: 0 });
    });

    it('evicts index records before any source data', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', 8 * MiB));
      await writeIndex(candidate('x1|vod_all', 0).key, reservation!.fields);
      await setCachedStreamMime('http://host/live', 'video/mp2t');
      await setCachedSubtitle('subdl:1', 'WEBVTT\n\nkept');
      const used = (await getCacheUsage()).total.bytes;

      // A budget (half the quota) that fits everything but the index, with
      // room for the pruning margin.
      await withQuota(2 * (used - 2 * MiB), 0, async () => {
        await setCachedCatalog('x1|vod_categories', ['a']);
      });

      expect(await storedIndexKeys()).toEqual([]);
      expect((await getCacheUsage()).categories.search.entries).toBe(0);
      expect(await getCachedSubtitle('subdl:1')).toBe('WEBVTT\n\nkept');
      expect(await getCachedCatalog('x1|vod_categories')).not.toBeNull();
    });

    it('gives the room back when the write failed', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', MiB));
      await settleSearchIndex(candidate('x1|vod_all', MiB).key, reservation!, false);
      expect((await getCacheUsage()).categories.search).toEqual({ bytes: 0, entries: 0 });
    });

    it('removes an index whose write raced a cache clear', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', MiB));
      await clearAllCachedData();
      await writeIndex(candidate('x1|vod_all', MiB).key, reservation!.fields);
      await settleSearchIndex(candidate('x1|vod_all', MiB).key, reservation!, true);

      expect(await storedIndexKeys()).toEqual([]);
      expect((await getCacheUsage()).categories.search).toEqual({ bytes: 0, entries: 0 });
    });

    it('reserves nothing once a clear started after the request', async () => {
      const pending = reserveSearchIndex(candidate('x1|vod_all', MiB));
      const cleared = clearAllCachedData();
      // The reservation was queued first, so it lands before the clear wipes it.
      await pending;
      await cleared;
      expect((await getCacheUsage()).categories.search.entries).toBe(0);
      expect(await storedIndexKeys()).toEqual([]);
    });

    it('goes with its source store when that store is cleared', async () => {
      await setCachedEpg('http://host/e', { channels: {}, programmes: {} } as never, null, 1, null);
      const epg = {
        key: 'epg-cache|http://host/e|1|v1',
        prefix: 'epg-cache|http://host/e|',
        bytes: 2 * MiB,
      };
      for (const entry of [candidate('x1|vod_all', MiB), candidate('x1|series_all', MiB), epg]) {
        const reservation = await reserveSearchIndex(entry);
        await writeIndex(entry.key, reservation!.fields);
        await settleSearchIndex(entry.key, reservation!, true);
      }

      await clearCachedCatalog();
      expect(await storedIndexKeys()).toEqual([epg.key]);
      let usage = await getCacheUsage();
      expect(usage.categories.search).toEqual({ bytes: 2 * MiB, entries: 1 });
      expect(usage.categories.catalog.entries).toBe(0);
      expect(usage.total.entries).toBe(2);

      await clearCachedEpg();
      expect(await storedIndexKeys()).toEqual([]);
      usage = await getCacheUsage();
      expect(usage.categories.search).toEqual({ bytes: 0, entries: 0 });
      expect(usage.total).toEqual({ bytes: 0, entries: 0 });
    });

    it('removes an index whose write raced a clear of its source', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', MiB));
      await clearCachedCatalog();
      await writeIndex(candidate('x1|vod_all', MiB).key, reservation!.fields);
      await settleSearchIndex(candidate('x1|vod_all', MiB).key, reservation!, true);

      expect(await storedIndexKeys()).toEqual([]);
      expect((await getCacheUsage()).categories.search).toEqual({ bytes: 0, entries: 0 });
    });

    it('skips an index built from a record that was cleared or replaced', async () => {
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await seedSource('x1|vod_all', 2);
      expect(await reserveSearchIndex(candidate('x1|vod_all', MiB, 1))).toBeNull();
      await clearCachedCatalog();
      expect(await reserveSearchIndex(candidate('x1|series_all', MiB))).toBeNull();
      expect(info.mock.calls.map(call => call.join(' ')).filter(line =>
        line.includes('event=search.index.persist.skipped '))).toEqual([
        expect.stringMatching(/reason=source_changed bytes=\d+$/),
        expect.stringMatching(/reason=source_changed bytes=\d+$/),
      ]);
      info.mockRestore();
      expect((await getCacheUsage()).categories.search.entries).toBe(0);
    });

    it('is emptied by a full cache clear', async () => {
      const reservation = await reserveSearchIndex(candidate('x1|vod_all', MiB));
      await writeIndex(candidate('x1|vod_all', MiB).key, reservation!.fields);
      await clearAllCachedData();
      expect(await storedIndexKeys()).toEqual([]);
    });

    it('notifies listeners once a scheduled playlist write lands', async () => {
      const listener = vi.fn();
      const stop = onPlaylistCacheWritten(listener);
      try {
        await setCachedPlaylist([channel('ch1')], [], Date.now(), null);
        expect(listener).not.toHaveBeenCalled();
        vi.useFakeTimers();
        scheduleCachedPlaylist([channel('ch1')], [], Date.now(), null, playlistCacheToken());
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        await flushCacheWrites();
        await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      } finally {
        vi.useRealTimers();
        stop();
      }
    });
  });
});
