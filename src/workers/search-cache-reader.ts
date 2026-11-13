import { DB_NAME, DB_VERSION, PLAYLIST_STORE } from '../services/idb-schema';
import {
  chunkedPlaylistWrites,
  joinPlaylistRecord,
  playlistChunkInfo,
  playlistChunkRange,
} from '../services/playlist-chunks';

const OPEN_TIMEOUT_MS = 5000;

export type CachedRecord = Record<string, unknown>;

/** One record of any store the Search worker reads. */
export interface SearchCacheKey {
  store: string;
  key: string;
}

export class SearchCacheError extends Error {
  constructor(readonly reason: string) {
    super(`Search cache access failed: ${reason}`);
    this.name = 'SearchCacheError';
  }
}

// Each call runs in its own single-store transaction and settles within
// `timeoutMs`. Only `write` ever opens a readwrite transaction.
export interface SearchCacheReader {
  read(record: SearchCacheKey, timeoutMs: number): Promise<CachedRecord | null>;
  count(record: SearchCacheKey, timeoutMs: number): Promise<number>;
  write(store: string, value: CachedRecord, timeoutMs: number): Promise<void>;
}

export interface CacheWrite {
  store: string;
  value?: CachedRecord;
  /** Deletes the keys in [lower, upper] before the puts after it. */
  deleteRange?: [string, string];
}

// Failures that will not clear up while this worker lives.
const PERMANENT_OPEN_FAILURES = ['open_timeout', 'open_failed', 'version_mismatch'];

// The page owns the schema: this connection never creates or upgrades the
// database, and it closes as soon as the page asks for a version change.
export class IdbSearchCacheReader implements SearchCacheReader {
  private connection: Promise<IDBDatabase> | null = null;
  private unavailable = false;

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly keyRange: typeof IDBKeyRange | undefined =
      typeof IDBKeyRange === 'undefined' ? undefined : IDBKeyRange,
  ) {}

  read(record: SearchCacheKey, timeoutMs: number): Promise<CachedRecord | null> {
    const chunked = record.store === PLAYLIST_STORE && !!this.keyRange;
    let chunks: IDBRequest | null = null;
    return this.run([record.store], 'readonly', timeoutMs, (tx) => {
      const store = tx.objectStore(record.store);
      const head = store.get(record.key);
      // A chunked playlist comes back whole, as the readers expect it.
      if (chunked) {
        const [lower, upper] = playlistChunkRange(record.key);
        chunks = store.getAll(this.keyRange!.bound(lower, upper));
      }
      return head;
    }, (result) => {
      if (!result || typeof result !== 'object') return null;
      const head = result as CachedRecord;
      if (!chunked || !playlistChunkInfo(head.data)) return head;
      const parts = chunks as IDBRequest | null;
      return parts && !parts.error ? joinPlaylistRecord(head, parts.result as unknown[]) : null;
    });
  }

  count(record: SearchCacheKey, timeoutMs: number): Promise<number> {
    return this.run([record.store], 'readonly', timeoutMs, tx => tx.objectStore(record.store).count(record.key), (result) => {
      return typeof result === 'number' ? result : 0;
    });
  }

  write(store: string, value: CachedRecord, timeoutMs: number): Promise<void> {
    return this.run([store], 'readwrite', timeoutMs, tx => tx.objectStore(store).put(value), () => undefined);
  }

  // TODO(cleanup, post-1.18.0): remove with migrateLegacyPlaylistCache.
  /**
   * Rewrites a playlist cached as one record as a head and chunks, in one
   * transaction so a newer write is never overwritten. The chunk count, or
   * null when the record is already chunked or gone.
   */
  migratePlaylist(key: string, keyPath: string, timeoutMs: number): Promise<number | null> {
    const keyRange = this.keyRange;
    if (!keyRange) return Promise.reject(new SearchCacheError('unavailable'));
    let chunks: number | null = null;
    return this.run([PLAYLIST_STORE], 'readwrite', timeoutMs, (tx) => {
      const store = tx.objectStore(PLAYLIST_STORE);
      const request = store.get(key);
      request.addEventListener('success', () => {
        const record = request.result as CachedRecord | undefined;
        const data = record?.data as { channels?: unknown } | undefined;
        if (!record || !Array.isArray(data?.channels) || playlistChunkInfo(data)) return;
        const writes = chunkedPlaylistWrites(PLAYLIST_STORE, record, keyPath);
        for (const write of writes) {
          if (write.deleteRange) store.delete(keyRange.bound(write.deleteRange[0], write.deleteRange[1]));
          if (write.value) store.put(write.value);
        }
        chunks = writes.length - 2;
      });
      return request;
    }, () => chunks);
  }

  /** Puts every value in one transaction, so all of them land or none does. */
  writeAll(writes: CacheWrite[], timeoutMs: number): Promise<void> {
    const stores = writes.map(write => write.store).filter((store, i, all) => all.indexOf(store) === i);
    return this.run(stores, 'readwrite', timeoutMs, (tx) => {
      let last: IDBRequest | null = null;
      for (const write of writes) {
        const store = tx.objectStore(write.store);
        if (write.deleteRange) {
          if (!this.keyRange) throw new Error('IDBKeyRange is unavailable');
          last = store.delete(this.keyRange.bound(write.deleteRange[0], write.deleteRange[1]));
        }
        if (write.value) last = store.put(write.value);
      }
      return last as IDBRequest;
    }, () => undefined);
  }

  private run<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    timeoutMs: number,
    issue: (tx: IDBTransaction) => IDBRequest,
    map: (result: unknown) => T,
  ): Promise<T> {
    if (this.unavailable || !this.factory) {
      return Promise.reject(new SearchCacheError('unavailable'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let tx: IDBTransaction | null = null;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      const fail = (reason: string): void => {
        if (settle()) reject(new SearchCacheError(reason));
      };
      // A result arriving after this is dropped with its aborted transaction;
      // a pending open keeps running and is reused by the next call.
      const timer = setTimeout(() => {
        if (!settle()) return;
        if (tx) {
          try {
            tx.abort();
          } catch {
            // Already finished.
          }
        }
        reject(new SearchCacheError(mode === 'readwrite' ? 'write_timeout' : 'read_timeout'));
      }, Math.max(0, timeoutMs));
      this.open().then((db) => {
        if (settled) return;
        if (!storeNames.length || storeNames.some(name => !db.objectStoreNames.contains(name))) {
          fail('store_missing');
          return;
        }
        let request: IDBRequest;
        try {
          tx = db.transaction(storeNames.length === 1 ? storeNames[0] : storeNames, mode);
          request = issue(tx);
        } catch (error) {
          if (!tx) this.forget(db);
          fail(isQuotaError(error) ? 'quota_exceeded' : 'transaction_failed');
          return;
        }
        let succeeded = false;
        request.onsuccess = () => {
          succeeded = true;
        };
        // Mapped once every request in the transaction has its result.
        tx.oncomplete = () => {
          if (!settle()) return;
          try {
            resolve(succeeded ? map(request.result) : undefined as T);
          } catch {
            reject(new SearchCacheError('record_invalid'));
          }
        };
        // A failed write aborts its transaction; a failed read only reports.
        if (mode !== 'readwrite') tx.onerror = (event) => event.preventDefault();
        const current = tx;
        tx.onabort = () => {
          if (settled) return;
          if (isQuotaError(current.error)) {
            fail('quota_exceeded');
            return;
          }
          if (mode !== 'readwrite') this.forget(db);
          fail(mode === 'readwrite' ? 'write_failed' : 'read_aborted');
        };
      }, (error: unknown) => {
        fail(error instanceof SearchCacheError ? error.reason : 'open_failed');
      });
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    const connection = openExisting(this.factory as IDBFactory, db => this.forget(db));
    this.connection = connection;
    connection.catch((error: unknown) => {
      if (this.connection === connection) this.connection = null;
      if (error instanceof SearchCacheError
          && PERMANENT_OPEN_FAILURES.indexOf(error.reason) >= 0) {
        this.unavailable = true;
      }
    });
    return connection;
  }

  private forget(db: IDBDatabase): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.then((current) => {
      if (current !== db || this.connection !== connection) return;
      this.connection = null;
      current.close();
    }, () => undefined);
  }
}

function openExisting(
  factory: IDBFactory,
  onClosed: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new SearchCacheError(reason));
    };
    const timer = setTimeout(() => fail('open_timeout'), OPEN_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME);
    } catch {
      fail('open_failed');
      return;
    }
    request.onupgradeneeded = () => {
      try {
        request.transaction?.abort();
      } catch {
        // The open request fails either way.
      }
      fail('upgrade_needed');
    };
    request.onblocked = () => fail('open_blocked');
    request.onerror = (event) => {
      event.preventDefault();
      fail('open_failed');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled || db.version !== DB_VERSION) {
        db.close();
        fail('version_mismatch');
        return;
      }
      db.onversionchange = () => {
        db.close();
        onClosed(db);
      };
      db.onclose = () => onClosed(db);
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
  });
}

function isQuotaError(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { name?: unknown }).name === 'QuotaExceededError';
}
