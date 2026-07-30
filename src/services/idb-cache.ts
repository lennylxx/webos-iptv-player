import type { ParsedEpg } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('IDB');
const DB_NAME = 'iptv';
const DB_VERSION = 3;
const EPG_STORE = 'epg-cache';
const CATALOG_STORE = 'catalog-cache';
const SUBTITLE_STORE = 'subtitle-cache';

export interface CachedEpgEntry {
  url: string;
  timestamp: number;
  data: ParsedEpg;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      log.warn('IndexedDB unavailable');
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EPG_STORE)) {
        db.createObjectStore(EPG_STORE, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        db.createObjectStore(CATALOG_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(SUBTITLE_STORE)) {
        db.createObjectStore(SUBTITLE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      log.warn('Open failed:', req.error);
      resolve(null);
    };
    req.onblocked = () => {
      log.warn('Open blocked');
      resolve(null);
    };
  });
  return dbPromise;
}

export async function getCachedEpg(url: string): Promise<CachedEpgEntry | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(EPG_STORE, 'readonly');
      const req = tx.objectStore(EPG_STORE).get(url);
      req.onsuccess = () => resolve((req.result as CachedEpgEntry | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch (err) {
      log.warn('Read failed:', err);
      resolve(null);
    }
  });
}

export async function setCachedEpg(url: string, data: ParsedEpg): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(EPG_STORE, 'readwrite');
      tx.objectStore(EPG_STORE).put({ url, timestamp: Date.now(), data } satisfies CachedEpgEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => { log.warn('Write failed:', tx.error); resolve(); };
      tx.onabort = () => { log.warn('Write aborted:', tx.error); resolve(); };
    } catch (err) {
      log.warn('Write failed:', err);
      resolve();
    }
  });
}

export async function clearCachedEpg(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(EPG_STORE, 'readwrite');
      tx.objectStore(EPG_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearAllCachedData(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([EPG_STORE, CATALOG_STORE, SUBTITLE_STORE], 'readwrite');
      tx.objectStore(EPG_STORE).clear();
      tx.objectStore(CATALOG_STORE).clear();
      tx.objectStore(SUBTITLE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Generic catalog cache: any JSON-serializable payload keyed by an arbitrary
// string (Xtream uses `${accountId}|action[|param]`). Freshness (TTL) is the
// caller's concern — this layer just stores the write timestamp.
export interface CachedCatalogEntry<T = unknown> {
  key: string;
  timestamp: number;
  data: T;
}

export async function getCachedCatalog<T = unknown>(key: string): Promise<CachedCatalogEntry<T> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CATALOG_STORE, 'readonly');
      const req = tx.objectStore(CATALOG_STORE).get(key);
      req.onsuccess = () => resolve((req.result as CachedCatalogEntry<T> | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch (err) {
      log.warn('Catalog read failed:', err);
      resolve(null);
    }
  });
}

export async function setCachedCatalog(key: string, data: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CATALOG_STORE, 'readwrite');
      tx.objectStore(CATALOG_STORE).put({ key, timestamp: Date.now(), data } satisfies CachedCatalogEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => { log.warn('Catalog write failed:', tx.error); resolve(); };
      tx.onabort = () => { log.warn('Catalog write aborted:', tx.error); resolve(); };
    } catch (err) {
      log.warn('Catalog write failed:', err);
      resolve();
    }
  });
}

export async function getCachedSubtitle(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SUBTITLE_STORE, 'readonly');
      const req = tx.objectStore(SUBTITLE_STORE).get(key);
      req.onsuccess = () => resolve((req.result as { text?: string } | undefined)?.text ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedSubtitle(key: string, text: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SUBTITLE_STORE, 'readwrite');
      tx.objectStore(SUBTITLE_STORE).put({ key, timestamp: Date.now(), text });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
