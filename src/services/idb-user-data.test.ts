import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyUserChanges,
  clearAllUserData,
  flushUserDataWrites,
  loadAllUserRecords,
  loadUserRecords,
  restoreFallbackRecords,
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
    expect(records['parental-control']).toEqual([]);
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

  it('adds and updates fallback records without deleting any', async () => {
    await applyUserChanges('channel-state', [
      { key: 'audio:ch1', value: { name: 'Track 1' } },
      { key: 'audio:ch2', value: { name: 'Track 1' } },
      { key: 'subtitle:ch1', value: { off: true } },
    ]);

    await restoreFallbackRecords([{
      key: 'audio_prefs',
      storeName: 'channel-state',
      records: [
        { key: 'audio:ch1', value: { name: 'Track 2' } },
        { key: 'audio:ch3', value: { name: 'Track 3' } },
      ],
    }]);

    expect(await loadUserRecords('channel-state')).toEqual(expect.arrayContaining([
      { key: 'audio:ch1', value: { name: 'Track 2' } },
      { key: 'audio:ch2', value: { name: 'Track 1' } },
      { key: 'audio:ch3', value: { name: 'Track 3' } },
      { key: 'subtitle:ch1', value: { off: true } },
    ]));
  });
});
