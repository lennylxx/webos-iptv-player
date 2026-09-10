import 'fake-indexeddb/auto';
import { forceCloseDatabase } from 'fake-indexeddb';
import { describe, it, expect } from 'vitest';
import { openPersistenceDb, USER_META_STORE } from './idb-database';

// A trivial read that fails with "The database connection is closing" if the
// caller is holding a stale, already-closed connection.
async function probe(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(USER_META_STORE, 'readonly');
  tx.objectStore(USER_META_STORE).getAll();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

describe('openPersistenceDb reconnection', () => {
  it('reconnects after the connection is closed unexpectedly', async () => {
    const first = await openPersistenceDb();
    expect(first).not.toBeNull();
    await probe(first!);

    // Simulate webOS/the browser closing the connection out from under the
    // app (not something this code requested) — the exact failure mode that
    // left every read/write hitting "The database connection is closing"
    // until the app was relaunched.
    forceCloseDatabase(first!);

    const second = await openPersistenceDb();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The new connection actually works — this is what a stale cached
    // connection would fail at.
    await expect(probe(second!)).resolves.toBeUndefined();
  });
});
