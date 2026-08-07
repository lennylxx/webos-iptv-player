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

// TODO: Remove this marker helper once all supported installs have upgraded to IndexedDB v4.
export async function hasMigration(legacyKey: string): Promise<boolean> {
  const db = await openPersistenceDb();
  if (!db) return false;
  try {
    const tx = db.transaction(USER_META_STORE, 'readonly');
    return !!await requestResult(tx.objectStore(USER_META_STORE).get(`migration:${legacyKey}`));
  } catch (err) {
    log.error(
      'Migration marker read failed',
      'event=persistence.user.migration.failed',
      'operation=read_marker',
      `key=${legacyKey}`,
      err,
    );
    throw err;
  }
}

export interface UserDataMigration {
  legacyKey: string;
  storeName: UserDataStore;
  records: UserDataRecord[];
  replacePrefix: string | null;
  replaceExisting: boolean;
}

// TODO: Remove this migration writer once all supported installs have upgraded to IndexedDB v4.
export function migrateUserRecordSets(migrations: UserDataMigration[]): Promise<void> {
  if (!migrations.length) return Promise.resolve();
  return enqueueWrite(async () => {
    const db = await openPersistenceDb();
    if (!db) {
      log.warn(
        'User data storage is unavailable',
        'event=persistence.user.unavailable',
        'operation=migrate',
      );
      throw new Error('IndexedDB unavailable');
    }
    try {
      const storeNames = [...new Set(migrations.map(item => item.storeName))];
      const existingKeys = new Map<UserDataStore, string[]>();
      const replacementStores = [...new Set(migrations
        .filter(item => item.replaceExisting)
        .map(item => item.storeName))];
      for (const storeName of replacementStores) {
        const readTx = db.transaction(storeName, 'readonly');
        const readDone = transactionDone(readTx);
        const keys = await requestResult(readTx.objectStore(storeName).getAllKeys());
        await readDone;
        existingKeys.set(storeName, keys.filter((key): key is string => typeof key === 'string'));
      }
      const tx = db.transaction([...storeNames, USER_META_STORE], 'readwrite');
      const meta = tx.objectStore(USER_META_STORE);
      for (const migration of migrations) {
        const store = tx.objectStore(migration.storeName);
        const keys = existingKeys.get(migration.storeName) ?? [];
        if (migration.replaceExisting) {
          for (const key of keys) {
            if (migration.replacePrefix === null || key.startsWith(migration.replacePrefix)) {
              store.delete(key);
            }
          }
        }
        for (const record of migration.records) store.put(record);
        meta.put({
          key: `migration:${migration.legacyKey}`,
          migratedAt: Date.now(),
        });
      }
      await transactionDone(tx);
      log.info(
        'User data migration completed',
        'event=persistence.user.migration.completed',
        `datasets=${migrations.length}`,
        `records=${migrations.reduce((count, item) => count + item.records.length, 0)}`,
      );
    } catch (err) {
      log.error(
        'User data migration failed',
        'event=persistence.user.migration.failed',
        'operation=migrate',
        `keys=${migrations.map(item => item.legacyKey).join(',')}`,
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
