import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyUserChanges,
  clearAllUserData,
  flushUserDataWrites,
  loadAllUserRecords,
  loadMigrationMarkers,
  loadUserRecords,
  migrateUserRecordSets,
} from './idb-user-data';

describe('IndexedDB user-data write barrier', () => {
  beforeEach(async () => {
    await clearAllUserData();
  });

  it('waits for queued writes before resolving', async () => {
    void applyUserChanges('favorites', [{ key: 'favorite:ch1', value: 'ch1' }]);

    await flushUserDataWrites();

    expect(await loadUserRecords('favorites')).toEqual([
      { key: 'favorite:ch1', value: 'ch1' },
    ]);
  });

  it('loads every user-data store through one snapshot', async () => {
    await applyUserChanges('favorites', [{ key: 'favorite:ch1', value: 'ch1' }]);
    await applyUserChanges('watchlist', [{
      key: 'watch:x1|movie|1',
      value: { accountId: 'x1', kind: 'movie', itemId: '1' },
    }]);

    const records = await loadAllUserRecords();

    expect(records.favorites).toHaveLength(1);
    expect(records.watchlist).toHaveLength(1);
    expect(records.reminders).toEqual([]);
  });

  it('rejects once when a queued write failed', async () => {
    const failed = applyUserChanges('favorites', [{
      key: 'favorite:bad',
      value: () => 'not cloneable',
    }]);
    await expect(failed).rejects.toBeTruthy();

    await expect(flushUserDataWrites()).rejects.toBeTruthy();
    await expect(flushUserDataWrites()).resolves.toBeUndefined();
  });

  it('replaces one migrated namespace without deleting sibling state', async () => {
    await applyUserChanges('channel-state', [
      { key: 'audio:old', value: { name: 'Track 1' } },
      { key: 'subtitle:ch1', value: { off: true } },
    ]);

    await migrateUserRecordSets([{
      legacyKey: 'audio_prefs',
      storeName: 'channel-state',
      records: [{ key: 'audio:new', value: { name: 'Track 2' } }],
      replacePrefix: 'audio:',
      replaceExisting: true,
    }]);

    expect(await loadUserRecords('channel-state')).toEqual(expect.arrayContaining([
      { key: 'audio:new', value: { name: 'Track 2' } },
      { key: 'subtitle:ch1', value: { off: true } },
    ]));
    expect((await loadUserRecords('channel-state')).some(item => item.key === 'audio:old'))
      .toBe(false);
  });

  it('loads all completed migration markers in one batch', async () => {
    await migrateUserRecordSets([
      {
        legacyKey: 'favorites',
        storeName: 'favorites',
        records: [],
        replacePrefix: null,
        replaceExisting: true,
      },
      {
        legacyKey: 'watchlist',
        storeName: 'watchlist',
        records: [],
        replacePrefix: null,
        replaceExisting: true,
      },
    ]);

    expect(await loadMigrationMarkers()).toEqual(new Set(['favorites', 'watchlist']));
  });
});
