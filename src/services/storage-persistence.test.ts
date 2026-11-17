// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type {
  CatchupProgressEntry,
  ParentalControlConfig,
  ChannelCustomization,
  Reminder,
  ResumeEntry,
  WatchlistEntry,
} from '../types';
import { loadUserRecords } from './idb-user-data';
import { StorageService } from './storage-service';

describe('StorageService IndexedDB migration', () => {
  it('moves growing collections out of localStorage and persists record updates', async () => {
    const reminder: Reminder = {
      channelKey: 'ch1',
      channelName: 'Alpha',
      title: 'Program Alpha',
      startMs: 1_000,
      stopMs: 2_000,
    };
    const customization: ChannelCustomization = {
      version: 1,
      overrides: { ch1: { name: 'Bravo', hidden: true } },
      order: ['ch1'],
      groupOrder: ['Group Alpha'],
      groupOverrides: { 'Group Alpha': { name: 'Group Bravo' } },
      customGroups: ['Group Bravo'],
    };
    const resume: ResumeEntry = {
      accountId: 'x1',
      kind: 'vod',
      itemId: '10',
      name: 'Movie Alpha',
      poster: 'http://host/a',
      ext: 'mp4',
      position: 120,
      duration: 3_600,
      updatedAt: 3_000,
    };
    const watch: WatchlistEntry = {
      accountId: 'x1',
      kind: 'vod',
      itemId: '10',
      name: 'Movie Alpha',
      poster: 'http://host/a',
      rating: '8',
      categoryId: '1',
      addedAt: 4_000,
    };
    const catchup: CatchupProgressEntry & { expiresAt: number } = {
      channelKey: 'ch1',
      progStart: 5_000,
      progEnd: 6_000,
      position: 60,
      duration: 300,
      updatedAt: 5_500,
      completed: false,
      expiresAt: Date.now() + 86_400_000,
    };

    localStorage.setItem('iptv_favorites', JSON.stringify(['ch1']));
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Playlist Alpha', url: 'http://host/a' },
    ]));
    localStorage.setItem('iptv_reminders', JSON.stringify([reminder]));
    localStorage.setItem('iptv_channel_custom', JSON.stringify(customization));
    localStorage.setItem('iptv_audio_prefs', JSON.stringify({
      ch1: { name: 'Track 1', lang: 'l1' },
    }));
    localStorage.setItem('iptv_subtitle_prefs', JSON.stringify({
      ch1: { off: false, name: 'Track 2', lang: 'l2' },
    }));
    localStorage.setItem('iptv_subtitle_offsets', JSON.stringify({ ch1: 1.5 }));
    localStorage.setItem('iptv_aspect_ratios', JSON.stringify({ ch1: 'zoom' }));
    localStorage.setItem('iptv_resume', JSON.stringify({ 'x1|vod|10': resume }));
    localStorage.setItem('iptv_watchlist', JSON.stringify({ 'x1|vod|10': watch }));
    localStorage.setItem('iptv_online_sub_picks', JSON.stringify({
      'x1|vod|10': {
        providerId: 'subdl',
        id: 'sub1',
        name: 'Track 1',
        lang: 'l1',
        format: 'srt',
      },
    }));
    localStorage.setItem('iptv_catchup_progress', JSON.stringify({
      'ch1|5000': catchup,
    }));
    localStorage.setItem('iptv_recently_watched_live', JSON.stringify([
      { channelKey: 'ch1', updatedAt: 7_000 },
    ]));

    await StorageService.init();

    expect(StorageService.getFavorites()).toEqual(['ch1']);
    expect(StorageService.getReminders()).toEqual([reminder]);
    expect(StorageService.getChannelCustomization()).toEqual(customization);
    expect(StorageService.getAudioPref('ch1')).toEqual({ name: 'Track 1', lang: 'l1' });
    expect(StorageService.getSubtitlePref('ch1')).toEqual({
      off: false,
      name: 'Track 2',
      lang: 'l2',
    });
    expect(StorageService.getSubtitleOffset('ch1')).toBe(1.5);
    expect(StorageService.getAspectRatio('ch1')).toBe('zoom');
    expect(StorageService.getResume('x1', 'vod', '10')).toEqual(resume);
    expect(StorageService.getWatchlist('x1', 'vod')).toEqual([watch]);
    expect(StorageService.getCatchupProgress('ch1', 5_000)).toEqual({
      channelKey: 'ch1',
      progStart: 5_000,
      progEnd: 6_000,
      position: 60,
      duration: 300,
      updatedAt: 5_500,
      completed: false,
    });
    expect(StorageService.getRecentlyWatchedLive()).toEqual([
      { channelKey: 'ch1', updatedAt: 7_000 },
    ]);

    for (const key of [
      'favorites',
      'reminders',
      'channel_custom',
      'audio_prefs',
      'subtitle_prefs',
      'subtitle_offsets',
      'aspect_ratios',
      'resume',
      'watchlist',
      'online_sub_picks',
      'catchup_progress',
      'recently_watched_live',
    ]) {
      expect(localStorage.getItem(`iptv_${key}`)).toBeNull();
    }

    StorageService.toggleFavorite('ch2');
    StorageService.clearResume('x1', 'vod', '10');
    await StorageService.flush();

    const favorites = await loadUserRecords<string>('favorites');
    const progress = await loadUserRecords('playback-progress');
    expect(favorites.map(item => item.value).sort()).toEqual(['ch1', 'ch2']);
    expect(progress.some(item => item.key === 'resume:x1|vod|10')).toBe(false);
    expect(progress.some(item => item.key === 'catchup:ch1|5000')).toBe(true);

    const originalPut = IDBObjectStore.prototype.put;
    let failNextFavoriteWrite = true;
    IDBObjectStore.prototype.put = function (
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest<IDBValidKey> {
      if (failNextFavoriteWrite && this.name === 'favorites') {
        failNextFavoriteWrite = false;
        throw new DOMException('transient write failure', 'UnknownError');
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };
    try {
      StorageService.toggleFavorite('ch3');
      await StorageService.flush();
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect((await loadUserRecords<string>('favorites')).map(item => item.value).sort())
      .toEqual(['ch1', 'ch2', 'ch3']);

    localStorage.setItem('iptv_favorites', JSON.stringify(['ch4']));
    vi.resetModules();
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let failNextFavoriteRead = true;
    IDBObjectStore.prototype.getAll = function (
      query?: IDBValidKey | IDBKeyRange | null,
      count?: number,
    ): IDBRequest<unknown[]> {
      if (failNextFavoriteRead && this.name === 'favorites') {
        failNextFavoriteRead = false;
        throw new DOMException('transient read failure', 'UnknownError');
      }
      if (count !== undefined) return originalGetAll.call(this, query, count);
      if (query !== undefined) return originalGetAll.call(this, query);
      return originalGetAll.call(this);
    };
    try {
      const { StorageService: FailedStorageService } = await import('./storage-service');
      await FailedStorageService.init();
      expect(FailedStorageService.getFavorites()).toEqual(['ch4']);
      expect(localStorage.getItem('iptv_favorites')).not.toBeNull();
    } finally {
      IDBObjectStore.prototype.getAll = originalGetAll;
    }

    vi.resetModules();
    const { StorageService: RecoveredStorageService } = await import('./storage-service');
    await RecoveredStorageService.init();
    expect(RecoveredStorageService.getFavorites().sort()).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
    expect(localStorage.getItem('iptv_favorites')).toBeNull();

    await RecoveredStorageService.clearUserData();
    expect(await loadUserRecords('favorites')).toEqual([]);
    expect(await loadUserRecords('playback-progress')).toEqual([]);
    expect(StorageService.getPlaylists()).toEqual([
      { id: 'p1', name: 'Playlist Alpha', url: 'http://host/a' },
    ]);
  });

  it('keeps a parental config saved while IndexedDB was unavailable', async () => {
    const config = (enabled: boolean): ParentalControlConfig => ({
      version: 1,
      enabled,
      pin: null,
      concealMode: 'show-locked',
      unlockDuration: 'once',
      groupRules: { g1: 'protect' },
      approvedSources: [],
      itemRules: {},
    });
    vi.resetModules();
    const { StorageService: Stored } = await import('./storage-service');
    await Stored.init();
    Stored.setParentalControl(config(false));
    await Stored.flush();

    // Without a fallback record the stored config survives the next launch.
    vi.resetModules();
    const { StorageService: Relaunched } = await import('./storage-service');
    await Relaunched.init();
    expect(Relaunched.getParentalControl()).toEqual(config(false));

    localStorage.setItem('iptv_parental_control', JSON.stringify(config(true)));
    vi.resetModules();
    const { StorageService: Recovered } = await import('./storage-service');
    await Recovered.init();
    expect(Recovered.getParentalControl()).toEqual(config(true));
    expect(localStorage.getItem('iptv_parental_control')).toBeNull();
    expect((await loadUserRecords<ParentalControlConfig>('parental-control'))[0]?.value)
      .toEqual(config(true));
  });
  it('persists Live category snapshots and prunes them with their accounts', async () => {
    const snapshot = (id: string) => ({
      knownIds: ['c1', id],
      announcedIds: [id],
      counts: { c1: 2, [id]: 1 },
    });
    const xtream = (id: string) => ({
      id, name: id, url: 'http://host/a', source: 'xtream' as const,
      xtream: { username: 'u1', password: 'p1' },
    });
    localStorage.clear();
    vi.resetModules();
    const { StorageService: Stored } = await import('./storage-service');
    await Stored.init();
    Stored.setPlaylists([xtream('x1'), xtream('x2'), xtream('x3')]);
    Stored.setLiveCategorySnapshot('x1', snapshot('c2'));
    Stored.setLiveCategorySnapshot('x2', snapshot('c3'));
    Stored.setLiveCategorySnapshot('x3', snapshot('c4'));
    const returned = Stored.getLiveCategorySnapshot('x1')!;
    returned.knownIds.push('c9');
    expect(Stored.getLiveCategorySnapshot('x1')).toEqual(snapshot('c2'));
    await Stored.flush();

    vi.resetModules();
    const { StorageService: Relaunched } = await import('./storage-service');
    await Relaunched.init();
    expect(Relaunched.getLiveCategorySnapshot('x1')).toEqual(snapshot('c2'));
    expect(Relaunched.getLiveCategorySnapshot('x2')).toEqual(snapshot('c3'));

    // x2 is removed and x3 turns into a plain M3U source.
    Relaunched.setPlaylists([
      xtream('x1'),
      { id: 'x3', name: 'x3', url: 'http://host/a', source: 'url' },
    ]);
    expect(Relaunched.getLiveCategorySnapshot('x1')).toEqual(snapshot('c2'));
    expect(Relaunched.getLiveCategorySnapshot('x2')).toBeNull();
    expect(Relaunched.getLiveCategorySnapshot('x3')).toBeNull();
    await Relaunched.flush();

    const keys = (await loadUserRecords('channel-state'))
      .map(item => item.key)
      .filter(key => key.startsWith('live-categories:'));
    expect(keys).toEqual(['live-categories:x1']);

    vi.resetModules();
    const { StorageService: Pruned } = await import('./storage-service');
    await Pruned.init();
    expect(Pruned.getLiveCategorySnapshot('x1')).toEqual(snapshot('c2'));
    expect(Pruned.getLiveCategorySnapshot('x2')).toBeNull();
    await Pruned.clearUserData();
  });

  const resumeEntry = (over: Partial<ResumeEntry>): ResumeEntry => ({
    accountId: 'x1', kind: 'vod', itemId: 'm0', name: 'Movie Alpha', poster: '',
    ext: 'mp4', position: 100, duration: 6_000, updatedAt: 1_000, ...over,
  });
  const resumeKeys = async () => (await loadUserRecords('playback-progress'))
    .map(item => item.key)
    .filter(key => key.startsWith('resume:'))
    .sort();

  it('trims over-cap resume scopes at startup and persists only the evictions', async () => {
    localStorage.clear();
    vi.resetModules();
    const { StorageService: Seeded } = await import('./storage-service');
    await Seeded.init();
    await Seeded.clearUserData();
    await Seeded.init();
    const records = [];
    for (let i = 0; i < 53; i++) {
      const entry = resumeEntry({ itemId: `m${i}`, updatedAt: 1_000 + i });
      records.push({ key: `resume:x1|vod|m${i}`, value: entry, updatedAt: entry.updatedAt });
    }
    const episode = resumeEntry({ kind: 'episode', itemId: 'e0', updatedAt: 1 });
    records.push({ key: 'resume:x1|episode|e0', value: episode, updatedAt: 1 });
    const { applyUserChanges } = await import('./idb-user-data');
    await applyUserChanges('playback-progress', records);

    vi.resetModules();
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put');
    try {
      const { StorageService: Relaunched } = await import('./storage-service');
      await Relaunched.init();
      expect(Relaunched.getResumeList('x1').filter(e => e.kind === 'vod')).toHaveLength(50);
      expect(Relaunched.getResume('x1', 'vod', 'm2')).toBeNull();
      expect(Relaunched.getResume('x1', 'vod', 'm3')).not.toBeNull();
      expect(Relaunched.getResume('x1', 'episode', 'e0')).not.toBeNull();
      await Relaunched.flush();
      expect(putSpy.mock.contexts.some(store =>
        (store as IDBObjectStore).name === 'playback-progress')).toBe(false);
    } finally {
      putSpy.mockRestore();
    }
    const keys = await resumeKeys();
    expect(keys).toHaveLength(51);
    expect(keys).not.toContain('resume:x1|vod|m0');
    expect(keys).not.toContain('resume:x1|vod|m2');
    expect(keys).toContain('resume:x1|episode|e0');

    vi.resetModules();
    const { StorageService: Cleared } = await import('./storage-service');
    await Cleared.clearUserData();
  });

  it('persists watched and hidden marks and drops a mark with neither flag', async () => {
    localStorage.clear();
    vi.resetModules();
    const { StorageService: First } = await import('./storage-service');
    await First.init();
    await First.clearUserData();
    await First.init();
    First.setResume(resumeEntry({ itemId: 'm1', position: 5990, duration: 6000 }));
    // A duration this short (a growing EVENT playlist) can't tell the end.
    First.setResume(resumeEntry({ itemId: 'm3', position: 5, duration: 10 }));
    First.setCatalogMark('x1', 'series', 's1', { hidden: true });
    First.setCatalogMark('x1', 'vod', 'm2', { watched: true });
    First.setCatalogMark('x1', 'vod', 'm2', { watched: false });
    First.setCatalogMarks('x1', 'episode', ['e1', 'e2', 'e3'], { watched: true });
    First.setCatalogMarks('x1', 'episode', ['e2'], { watched: false });
    await First.flush();

    vi.resetModules();
    const { StorageService: Relaunched } = await import('./storage-service');
    await Relaunched.init();
    expect(Relaunched.isWatched('x1', 'vod', 'm1')).toBe(true);
    expect(Relaunched.catalogMarkIds('x1', 'series', 'hidden')).toEqual(new Set(['s1']));
    expect(Relaunched.getCatalogMark('x1', 'vod', 'm2')).toBeNull();
    expect(Relaunched.isWatched('x1', 'vod', 'm3')).toBe(false);
    const keys = (await loadUserRecords('playback-progress')).map(item => item.key)
      .filter(key => key.startsWith('mark:'));
    expect(keys.sort()).toEqual(['mark:x1|episode|e1', 'mark:x1|episode|e3', 'mark:x1|series|s1', 'mark:x1|vod|m1']);
    expect(Relaunched.catalogMarkIds('x1', 'episode', 'watched')).toEqual(new Set(['e1', 'e3']));
    await Relaunched.clearUserData();
  });

  it('moves marks saved while IndexedDB was unavailable into it', async () => {
    localStorage.clear();
    vi.resetModules();
    const { StorageService: First } = await import('./storage-service');
    await First.init();
    await First.clearUserData();
    localStorage.setItem('iptv_catalog_marks', JSON.stringify({
      'x1|vod|m9': { accountId: 'x1', kind: 'vod', itemId: 'm9', watched: true, updatedAt: 1 },
    }));
    vi.resetModules();
    const { StorageService: Relaunched } = await import('./storage-service');
    await Relaunched.init();
    expect(Relaunched.isWatched('x1', 'vod', 'm9')).toBe(true);
    expect(localStorage.getItem('iptv_catalog_marks')).toBeNull();
    const keys = (await loadUserRecords('playback-progress')).map(item => item.key);
    expect(keys).toContain('mark:x1|vod|m9');
    await Relaunched.clearUserData();
  });

  it('adds fallback marks to the ones IndexedDB already holds', async () => {
    localStorage.clear();
    vi.resetModules();
    const { StorageService: First } = await import('./storage-service');
    await First.init();
    await First.clearUserData();
    await First.init();
    First.setCatalogMark('x1', 'vod', 'm1', { watched: true });
    await First.flush();
    localStorage.setItem('iptv_catalog_marks', JSON.stringify({
      'x1|series|s2': { accountId: 'x1', kind: 'series', itemId: 's2', hidden: true, updatedAt: 2 },
    }));
    vi.resetModules();
    const { StorageService: Relaunched } = await import('./storage-service');
    await Relaunched.init();
    expect(Relaunched.isWatched('x1', 'vod', 'm1')).toBe(true);
    expect(Relaunched.isHidden('x1', 'series', 's2')).toBe(true);
    const keys = (await loadUserRecords('playback-progress')).map(item => item.key)
      .filter(key => key.startsWith('mark:'));
    expect(keys.sort()).toEqual(['mark:x1|series|s2', 'mark:x1|vod|m1']);
    await Relaunched.clearUserData();
  });

  it('persists resume evictions, list clears, and a refused Watchlist add', async () => {
    localStorage.clear();
    vi.resetModules();
    const { StorageService: Stored } = await import('./storage-service');
    await Stored.init();
    await Stored.clearUserData();
    await Stored.init();
    for (let i = 0; i < 51; i++) {
      Stored.setResume(resumeEntry({ itemId: `m${i}`, updatedAt: 1_000 + i }));
    }
    Stored.setResume(resumeEntry({ kind: 'episode', itemId: 'e0' }));
    Stored.setResume(resumeEntry({ accountId: 'x2', itemId: 'm0' }));
    await Stored.flush();
    let keys = await resumeKeys();
    expect(keys).toHaveLength(52);
    expect(keys).not.toContain('resume:x1|vod|m0');

    Stored.clearResumeList('x1', 'vod');
    await Stored.flush();
    expect(await resumeKeys()).toEqual(['resume:x1|episode|e0', 'resume:x2|vod|m0']);
    Stored.clearResumeList('x1');
    await Stored.flush();
    keys = await resumeKeys();
    expect(keys).toEqual(['resume:x2|vod|m0']);

    const watch = (itemId: string, addedAt: number): WatchlistEntry => ({
      accountId: 'x1', kind: 'vod', itemId, name: 'Movie Alpha', poster: '',
      rating: '', categoryId: '1', addedAt,
    });
    for (let i = 0; i < 200; i++) expect(Stored.toggleWatchlist(watch(`w${i}`, i))).toBe('added');
    expect(Stored.toggleWatchlist(watch('new', 9_000))).toBe('full');
    Stored.toggleWatchlist({ ...watch('s1', 1), kind: 'series' });
    Stored.clearWatchlist('x1', 'series');
    await Stored.flush();
    const watchKeys = (await loadUserRecords('watchlist')).map(item => item.key);
    expect(watchKeys).toHaveLength(200);
    expect(watchKeys).not.toContain('watch:x1|vod|new');
    expect(watchKeys).not.toContain('watch:x1|series|s1');
    await Stored.clearUserData();
  });
});
