import { describe, expect, it } from 'vitest';
import { clearAllCachedData, clearCachedEpg } from './idb-cache';
import { clearAllUserData } from './idb-user-data';

describe('IndexedDB unavailable clearing', () => {
  it('rejects user-data clearing instead of reporting false success', async () => {
    await expect(clearAllUserData()).rejects.toThrow('IndexedDB unavailable');
  });

  it('rejects cache clearing instead of reporting false success', async () => {
    await expect(clearCachedEpg()).rejects.toThrow('IndexedDB unavailable');
    await expect(clearAllCachedData()).rejects.toThrow('IndexedDB unavailable');
  });
});
