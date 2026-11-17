import {
  openPersistenceDb,
  requestResult,
  transactionDone,
  USER_DATA_STORES,
  USER_META_STORE,
  type UserDataStore,
} from './idb-database';
import { createLogger } from '../utils/logger';

const log = createLogger('UserDataStorage');

export interface UserDataRecord<T = unknown> {
  key: string;
  value: T;
  scope?: string;
  updatedAt?: number;
  expiresAt?: number;
}

let writeChain: Promise<void> = Promise.resolve();
let writeFailure: unknown = null;

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const result = writeChain.then(operation, operation);
  writeChain = result.then(
    () => {},
    (err) => { writeFailure = err; },
  );
  return result;
}

export async function flushUserDataWrites(): Promise<void> {
  await writeChain;
  if (writeFailure !== null) {
    const err = writeFailure;
    writeFailure = null;
    throw err;
  }
}

export async function loadUserRecords<T = unknown>(
  storeName: UserDataStore,
): Promise<UserDataRecord<T>[]> {
  await writeChain;
  const db = await openPersistenceDb();
  if (!db) {
    log.warn(
      'User data storage is unavailable',
      'event=persistence.user.unavailable',
      'operation=read',
      `store=${storeName}`,
    );
    return [];
  }
  try {
    const tx = db.transaction(storeName, 'readonly');
    return await requestResult(tx.objectStore(storeName).getAll()) as UserDataRecord<T>[];
  } catch (err) {
    log.error(
      'User data read failed',
      'event=persistence.user.read.failed',
      'operation=read',
      `store=${storeName}`,
      err,
    );
    throw err;
  }
}

export async function loadAllUserRecords(): Promise<
Record<UserDataStore, UserDataRecord[]>
> {
  await writeChain;
  const db = await openPersistenceDb();
  if (!db) {
    log.warn(
      'User data storage is unavailable',
      'event=persistence.user.unavailable',
      'operation=read_all',
    );
    return {
      favorites: [],
      reminders: [],
      'channel-state': [],
      watchlist: [],
      'playback-progress': [],
      'recently-watched': [],
      'online-sub-picks': [],
      'parental-control': [],
    };
  }
  try {
    const tx = db.transaction(USER_DATA_STORES, 'readonly');
    const records = await Promise.all(USER_DATA_STORES.map(async (storeName) => [
      storeName,
      await requestResult(tx.objectStore(storeName).getAll()) as UserDataRecord[],
    ] as const));
    const result = {} as Record<UserDataStore, UserDataRecord[]>;
    for (const [storeName, items] of records) result[storeName] = items;
    return result;
  } catch (err) {
    log.error(
      'User data read failed',
      'event=persistence.user.read.failed',
      'operation=read_all',
      err,
    );
    throw err;
  }
}

// Records saved to localStorage while IndexedDB was unavailable. They have
// no complete baseline, so they add or update records but never delete one.
export interface FallbackRecordSet {
  key: string;
  storeName: UserDataStore;
  records: UserDataRecord[];
}

export function restoreFallbackRecords(sets: FallbackRecordSet[]): Promise<void> {
  if (!sets.length) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=restore_fallback',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const tx = db.transaction([...new Set(sets.map(item => item.storeName))], 'readwrite');
      for (const set of sets) {
        const store = tx.objectStore(set.storeName);
        for (const record of set.records) store.put(record);
      }
      await transactionDone(tx);
      log.info(
        'Fallback user data restored',
        'event=persistence.user.fallback.restored',
        `datasets=${sets.length}`,
        `records=${sets.reduce((count, item) => count + item.records.length, 0)}`,
      );
    } catch (err) {
      log.error(
        'Fallback user data restore failed',
        'event=persistence.user.fallback.failed',
        `keys=${sets.map(item => item.key).join(',')}`,
        err,
      );
      throw err;
    }
  });
}

export function applyUserChanges(
  storeName: UserDataStore,
  puts: UserDataRecord[],
  deletes: string[] = [],
): Promise<void> {
  if (!puts.length && !deletes.length) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=write',
        `store=${storeName}`,
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const key of deletes) store.delete(key);
      for (const record of puts) store.put(record);
      await transactionDone(tx);
    } catch (err) {
      log.error(
        'User data write failed',
        'event=persistence.user.write.failed',
        'operation=write',
        `store=${storeName}`,
        err,
      );
      throw err;
    }
  });
}

export function replaceAllUserData(
  records: Partial<Record<UserDataStore, UserDataRecord[]>>,
): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=recover',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const tx = db.transaction(USER_DATA_STORES, 'readwrite');
      for (const storeName of USER_DATA_STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
        for (const item of records[storeName] ?? []) store.put(item);
      }
      await transactionDone(tx);
    } catch (err) {
      log.error(
        'User data recovery write failed',
        'event=persistence.user.write.failed',
        'operation=recover',
        err,
      );
      throw err;
    }
  });
}

export function clearAllUserData(): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=clear',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const tx = db.transaction([...USER_DATA_STORES, USER_META_STORE], 'readwrite');
      for (const storeName of USER_DATA_STORES) tx.objectStore(storeName).clear();
      tx.objectStore(USER_META_STORE).clear();
      await transactionDone(tx);
      writeFailure = null;
      log.info(
        'User data clear completed',
        'event=persistence.user.clear.completed',
        'operation=clear',
        'scope=all',
      );
    } catch (err) {
      log.error(
        'User data clear failed',
        'event=persistence.user.clear.failed',
        'operation=clear',
        'scope=all',
        err,
      );
      throw err;
    }
  });
}
