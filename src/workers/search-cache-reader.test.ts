import { IDBDatabase as FakeIDBDatabase, IDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_STORE,
  DB_NAME,
  DB_VERSION,
  EPG_STORE,
  PLAYLIST_STORE,
  SEARCH_INDEX_STORE,
} from '../services/idb-schema';
import { IdbSearchCacheReader, SearchCacheError } from './search-cache-reader';

function openDb(
  factory: IDBFactory,
  version: number,
  stores: string[] = [PLAYLIST_STORE, CATALOG_STORE, EPG_STORE],
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of stores) {
        if (db.objectStoreNames.contains(store)) continue;
        db.createObjectStore(store, { keyPath: store === EPG_STORE ? 'url' : 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

function put(db: IDBDatabase, store: string, value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof SearchCacheError ? error.reason : String(error);
  }
  return 'resolved';
}

const TIMEOUT = 1200;
const REF = { store: PLAYLIST_STORE, key: 'k', timestamp: 1 };

interface StalledOpen {
  factory: IDBFactory;
  opens: () => number;
  succeed: () => void;
  transactions: StalledTransaction[];
  closes: () => number;
}

interface StalledTransaction {
  aborts: number;
  finish: (value: object) => void;
}

// An IDBFactory whose open request and transactions only progress on demand.
function stalledFactory(options: { throwOnOpen?: boolean } = {}): StalledOpen {
  let opens = 0;
  let closes = 0;
  const transactions: StalledTransaction[] = [];
  const request: Record<string, unknown> = {};
  const db = {
    version: DB_VERSION,
    objectStoreNames: { contains: () => true },
    close: () => { closes++; },
    transaction: () => {
      const tx: Record<string, unknown> = {};
      const get: Record<string, unknown> = {};
      const entry: StalledTransaction = {
        aborts: 0,
        finish: (value) => {
          get.result = value;
          (get.onsuccess as (() => void) | undefined)?.();
          (tx.oncomplete as (() => void) | undefined)?.();
        },
      };
      tx.objectStore = () => ({ get: () => get, getAll: () => ({ result: [] }) });
      tx.abort = () => { entry.aborts++; };
      transactions.push(entry);
      return tx;
    },
  };
  const factory = {
    open: () => {
      opens++;
      if (options.throwOnOpen) throw new Error('denied');
      return request;
    },
  } as unknown as IDBFactory;
  return {
    factory,
    opens: () => opens,
    succeed: () => {
      request.result = db;
      (request.onsuccess as (() => void) | undefined)?.();
    },
    transactions,
    closes: () => closes,
  };
}

describe('IdbSearchCacheReader', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads each record in its own single-store transaction', async () => {
    const factory = new IDBFactory();
    const db = await openDb(factory, DB_VERSION);
    await put(db, CATALOG_STORE, { key: 'a|vod_all', timestamp: 5, data: [{ name: 'Alpha' }] });
    await put(db, EPG_STORE, { url: 'http://host/a', timestamp: 6, data: { programmes: {} } });
    const transaction = vi.spyOn(FakeIDBDatabase.prototype, 'transaction');
    const reader = new IdbSearchCacheReader(factory);

    const catalog = await reader.read({ store: CATALOG_STORE, key: 'a|vod_all', timestamp: 5 }, TIMEOUT);
    const epg = await reader.read({ store: EPG_STORE, key: 'http://host/a', timestamp: 6 }, TIMEOUT);
    const missing = await reader.read({ store: PLAYLIST_STORE, key: 'missing', timestamp: 1 }, TIMEOUT);

    expect(catalog?.data).toEqual([{ name: 'Alpha' }]);
    expect(epg?.timestamp).toBe(6);
    expect(missing).toBeNull();
    expect(transaction.mock.calls.map(call => call[0]))
      .toEqual([CATALOG_STORE, EPG_STORE, PLAYLIST_STORE]);
    db.close();
  });

  it('gives up on a stalled read and ignores its late result', async () => {
    vi.useFakeTimers();
    const idb = stalledFactory();
    const reader = new IdbSearchCacheReader(idb.factory);
    const first = reason(reader.read(REF, TIMEOUT));
    idb.succeed();
    await vi.advanceTimersByTimeAsync(TIMEOUT);

    expect(await first).toBe('read_timeout');
    expect(idb.transactions[0].aborts).toBe(1);
    idb.transactions[0].finish({ key: 'k', timestamp: 1 });

    // The connection stays usable for the next read.
    const second = reader.read(REF, TIMEOUT);
    await vi.advanceTimersByTimeAsync(0);
    idb.transactions[1].finish({ key: 'k', timestamp: 2 });
    expect((await second)?.timestamp).toBe(2);
    expect(idb.opens()).toBe(1);
    expect(idb.closes()).toBe(0);
  });

  it('times a read out while the database is still opening', async () => {
    vi.useFakeTimers();
    const idb = stalledFactory();
    const reader = new IdbSearchCacheReader(idb.factory);
    const first = reason(reader.read(REF, TIMEOUT));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(await first).toBe('read_timeout');

    idb.succeed();
    const second = reader.read(REF, TIMEOUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(idb.transactions).toHaveLength(1);
    idb.transactions[0].finish({ key: 'k', timestamp: 1 });
    expect((await second)?.timestamp).toBe(1);
    expect(idb.opens()).toBe(1);
  });

  it('stops opening the database after an open timeout', async () => {
    vi.useFakeTimers();
    const idb = stalledFactory();
    const reader = new IdbSearchCacheReader(idb.factory);
    const first = reason(reader.read(REF, 10_000));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toBe('open_timeout');

    expect(await reason(reader.read(REF, TIMEOUT))).toBe('unavailable');
    expect(idb.opens()).toBe(1);
  });

  it('stops opening the database after an open failure', async () => {
    const idb = stalledFactory({ throwOnOpen: true });
    const reader = new IdbSearchCacheReader(idb.factory);

    expect(await reason(reader.read(REF, TIMEOUT))).toBe('open_failed');
    expect(await reason(reader.read(REF, TIMEOUT))).toBe('unavailable');
    expect(idb.opens()).toBe(1);
  });

  it('never creates the database', async () => {
    const factory = new IDBFactory();
    const reader = new IdbSearchCacheReader(factory);

    expect(await reason(reader.read(REF, TIMEOUT))).toBe('upgrade_needed');
    expect(await factory.databases()).toEqual([]);
  });

  it('refuses a database at another version and leaves it unchanged', async () => {
    const factory = new IDBFactory();
    const db = await openDb(factory, DB_VERSION - 1);
    db.close();
    const reader = new IdbSearchCacheReader(factory);

    expect(await reason(reader.read(REF, TIMEOUT))).toBe('version_mismatch');
    expect(await factory.databases()).toEqual([{ name: DB_NAME, version: DB_VERSION - 1 }]);
    const open = vi.spyOn(factory, 'open');
    expect(await reason(reader.read(REF, TIMEOUT))).toBe('unavailable');
    expect(open).not.toHaveBeenCalled();
  });

  it('reports a missing store', async () => {
    const factory = new IDBFactory();
    const db = await openDb(factory, DB_VERSION, [PLAYLIST_STORE]);
    const reader = new IdbSearchCacheReader(factory);

    expect(await reason(reader.read({ store: EPG_STORE, key: 'k', timestamp: 1 }, TIMEOUT)))
      .toBe('store_missing');
    db.close();
  });

  it('closes its connection so the page can upgrade the database', async () => {
    const factory = new IDBFactory();
    const page = await openDb(factory, DB_VERSION);
    page.onversionchange = () => page.close();
    await put(page, PLAYLIST_STORE, { key: 'k', timestamp: 1, data: { channels: [] } });
    const reader = new IdbSearchCacheReader(factory);
    expect(await reader.read(REF, TIMEOUT)).not.toBeNull();

    const upgraded = await openDb(factory, DB_VERSION + 1);
    expect(upgraded.version).toBe(DB_VERSION + 1);

    // The next read reconnects and refuses the newer schema.
    expect(await reason(reader.read(REF, TIMEOUT))).toBe('version_mismatch');
    expect(upgraded.version).toBe(DB_VERSION + 1);
    upgraded.close();
  });

  it('counts and writes search index records in their own store', async () => {
    const factory = new IDBFactory();
    const db = await openDb(factory, DB_VERSION, [PLAYLIST_STORE, SEARCH_INDEX_STORE]);
    const reader = new IdbSearchCacheReader(factory);
    const ref = { store: SEARCH_INDEX_STORE, key: 'i1' };

    expect(await reader.count(ref, TIMEOUT)).toBe(0);
    await reader.write(SEARCH_INDEX_STORE, { key: 'i1', ends: new Uint32Array([3]) }, TIMEOUT);
    expect(await reader.count(ref, TIMEOUT)).toBe(1);
    expect((await reader.read(ref, TIMEOUT))?.ends).toEqual(new Uint32Array([3]));
    db.close();
  });

  it('reports a write over quota without retrying', async () => {
    const factory = new IDBFactory();
    const db = await openDb(factory, DB_VERSION, [PLAYLIST_STORE, SEARCH_INDEX_STORE]);
    const put = vi.spyOn(FakeIDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const reader = new IdbSearchCacheReader(factory);

    expect(await reason(reader.write(SEARCH_INDEX_STORE, { key: 'i1' }, TIMEOUT)))
      .toBe('quota_exceeded');
    expect(put).toHaveBeenCalledTimes(1);
    put.mockRestore();
    expect(await reader.count({ store: SEARCH_INDEX_STORE, key: 'i1' }, TIMEOUT)).toBe(0);
    db.close();
  });

  it('fails without IndexedDB', async () => {
    const reader = new IdbSearchCacheReader(undefined);
    expect(await reason(reader.read(REF, TIMEOUT))).toBe('unavailable');
  });
});
