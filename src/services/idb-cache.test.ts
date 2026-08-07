// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import {
  clearAllCachedData,
  getCacheUsage,
  getCachedCatalog,
  getCachedEpg,
  getCachedPlaylist,
  getCachedSubtitle,
  setCachedCatalog,
  setCachedEpg,
  setCachedPlaylist,
  setCachedSubtitle,
} from './idb-cache';
import {
  openPersistenceDb,
  requestResult,
  SUBTITLE_STORE,
  transactionDone,
} from './idb-database';

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

describe('idb-cache subtitle cache', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllCachedData();
  });

  it('uses the next schema version after the published v3 database', async () => {
    expect((await openPersistenceDb())?.version).toBe(4);
  });

  it('round-trips a cached subtitle', async () => {
    await setCachedSubtitle('subdl:1', 'WEBVTT\n\nhi');
    expect(await getCachedSubtitle('subdl:1')).toContain('hi');
    expect(await getCachedSubtitle('missing')).toBeNull();
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

    await clearAllCachedData();

    expect(await getCachedEpg('http://host/epg')).toBeNull();
    expect(await getCachedCatalog('x1|categories')).toBeNull();
    expect(await getCachedSubtitle('subdl:2')).toBeNull();
  });

  it('stores parsed playlists outside localStorage', async () => {
    const channels = [channel('ch1')];
    const sources = [{ url: 'http://host/epg', playlistIds: ['p1'], kind: 'm3u' as const }];

    expect(await setCachedPlaylist(channels, sources)).toBe(true);

    expect(await getCachedPlaylist()).toEqual({ channels, epgSources: sources });
    expect(localStorage.getItem('iptv_cached_playlist')).toBeNull();
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

  it('migrates a valid legacy playlist only after IndexedDB accepts it', async () => {
    const channels = [channel('ch1')];
    localStorage.setItem('iptv_cached_playlist', JSON.stringify({
      version: 2,
      channels,
      epgSources: [],
      timestamp: Date.now(),
    }));

    expect(await getCachedPlaylist()).toEqual({ channels, epgSources: [] });
    expect(localStorage.getItem('iptv_cached_playlist')).toBeNull();
    expect(await getCachedPlaylist()).toEqual({ channels, epgSources: [] });
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
});
