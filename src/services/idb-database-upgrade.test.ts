import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  CACHE_META_STORE,
  CACHE_STORES,
  cacheKeyPath,
  LLM_STORE,
  openPersistenceDb,
  PLAYLIST_STORE,
  requestResult,
  SEARCH_INDEX_STORE,
  USER_DATA_STORES,
  USER_META_STORE,
} from './idb-database';
import { DB_NAME } from './idb-schema';

// The v6 layout: every store except the search index and LLM caches.
function createV6(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 6);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of CACHE_STORES) {
        if (name === SEARCH_INDEX_STORE || name === LLM_STORE) continue;
        const store = db.createObjectStore(name, { keyPath: cacheKeyPath(name) });
        store.createIndex('expiresAt', 'expiresAt');
        store.createIndex('lastAccessedAt', 'lastAccessedAt');
      }
      db.createObjectStore(CACHE_META_STORE, { keyPath: 'category' });
      for (const name of USER_DATA_STORES) db.createObjectStore(name, { keyPath: 'key' });
      db.createObjectStore(USER_META_STORE, { keyPath: 'key' });
      const tx = req.transaction!;
      tx.objectStore(PLAYLIST_STORE).put({ key: 'combined', timestamp: 1, data: { channels: [] } });
      tx.objectStore('favorites').put({ key: 'ch1' });
      tx.objectStore(CACHE_META_STORE).put({ category: 'total', bytes: 10, entries: 1 });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

describe('persistence database upgrade to v8', () => {
  it('adds the search index and LLM caches and keeps existing records', async () => {
    await createV6();

    const db = (await openPersistenceDb())!;
    expect(db.version).toBe(8);
    expect(db.objectStoreNames.contains(SEARCH_INDEX_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(LLM_STORE)).toBe(true);
    const tx = db.transaction([SEARCH_INDEX_STORE, PLAYLIST_STORE, 'favorites', CACHE_META_STORE]);
    const search = tx.objectStore(SEARCH_INDEX_STORE);
    expect(search.keyPath).toBe('key');
    expect(Array.from(search.indexNames).sort()).toEqual(['expiresAt', 'lastAccessedAt']);
    expect(await requestResult(tx.objectStore(PLAYLIST_STORE).get('combined')))
      .toMatchObject({ timestamp: 1 });
    expect(await requestResult(tx.objectStore('favorites').get('ch1'))).toEqual({ key: 'ch1' });
    expect(await requestResult(tx.objectStore(CACHE_META_STORE).get('total')))
      .toMatchObject({ bytes: 10, entries: 1 });
  });
});
