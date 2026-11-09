import { DB_NAME, DB_VERSION } from '../services/idb-schema';

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
  value: CachedRecord;
}

// Failures that will not clear up while this worker lives.
const PERMANENT_OPEN_FAILURES = ['open_timeout', 'open_failed', 'version_mismatch'];

// The page owns the schema: this connection never creates or upgrades the
// database, and it closes as soon as the page asks for a version change.
export class IdbSearchCacheReader implements SearchCacheReader {
  private connection: Promise<IDBDatabase> | null = null;
  private unavailable = false;

  constructor(private readonly factory: IDBFactory | undefined) {}

  read(record: SearchCacheKey, timeoutMs: number): Promise<CachedRecord | null> {
    return this.run([record.store], 'readonly', timeoutMs, tx => tx.objectStore(record.store).get(record.key), (result) => {
      return result && typeof result === 'object' ? result as CachedRecord : null;
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

  /** Puts every value in one transaction, so all of them land or none does. */
  writeAll(writes: CacheWrite[], timeoutMs: number): Promise<void> {
    const stores = writes.map(write => write.store).filter((store, i, all) => all.indexOf(store) === i);
    return this.run(stores, 'readwrite', timeoutMs, (tx) => {
      let last: IDBRequest | null = null;
      for (const write of writes) last = tx.objectStore(write.store).put(write.value);
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
        let value: T;
        request.onsuccess = () => {
          value = map(request.result);
        };
        tx.oncomplete = () => {
          if (settle()) resolve(value);
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
