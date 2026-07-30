import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  clearAllCachedData,
  getCachedCatalog,
  getCachedEpg,
  getCachedSubtitle,
  setCachedCatalog,
  setCachedEpg,
  setCachedSubtitle,
} from './idb-cache';

describe('idb-cache subtitle cache', () => {
  it('round-trips a cached subtitle', async () => {
    await setCachedSubtitle('subdl:1', 'WEBVTT\n\nhi');
    expect(await getCachedSubtitle('subdl:1')).toContain('hi');
    expect(await getCachedSubtitle('missing')).toBeNull();
  });

  it('clears every cache when resetting the app', async () => {
    await setCachedEpg('http://host/epg', { channels: {}, programmes: {} });
    await setCachedCatalog('x1|categories', ['a']);
    await setCachedSubtitle('subdl:2', 'WEBVTT\n\nhi');

    await clearAllCachedData();

    expect(await getCachedEpg('http://host/epg')).toBeNull();
    expect(await getCachedCatalog('x1|categories')).toBeNull();
    expect(await getCachedSubtitle('subdl:2')).toBeNull();
  });
});
