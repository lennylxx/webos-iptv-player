// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type {
  CatchupProgressEntry,
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
});
