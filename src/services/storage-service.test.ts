// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel } from '../types';
import { StorageService } from './storage-service';
import { channelKey } from '../utils/channel';

const ch = (over: Partial<Channel>): Channel => ({
  id: '', name: '', logo: '', group: '', url: '', extras: null,
  playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
});

describe('StorageService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty playlist list by default', () => {
    expect(StorageService.getPlaylists()).toEqual([]);
  });

  it('round-trips playlists and backfills a stable id for legacy entries', () => {
    StorageService.setPlaylists([{ id: 'keep', name: 'A', url: 'http://a' }]);
    expect(StorageService.getPlaylists()).toEqual([{ id: 'keep', name: 'A', url: 'http://a' }]);

    // A playlist saved before stable ids existed (no id field) gets one
    // backfilled and persisted, so a second read returns the same id.
    StorageService.set('playlists', [{ name: 'B', url: 'http://b' }]);
    const got = StorageService.getPlaylists();
    expect(got).toEqual([{ name: 'B', url: 'http://b', id: expect.any(String) }]);
    expect(StorageService.getPlaylists()[0].id).toBe(got[0].id);
  });

  it('defaults the EPG url to an empty string and round-trips it', () => {
    expect(StorageService.getEpgUrl()).toBe('');
    StorageService.setEpgUrl('http://epg/guide.xml');
    expect(StorageService.getEpgUrl()).toBe('http://epg/guide.xml');
  });

  it('stores playlist cache EPG sources and invalidates the URL-only schema', () => {
    const channels = [ch({ id: 'a', name: 'Alpha', url: 'http://host/a', playlistIds: ['p1'] })];
    StorageService.set('cached_playlist', {
      version: 1,
      channels,
      epgUrls: ['http://host/epg.xml'],
      timestamp: Date.now(),
    });
    expect(StorageService.getCachedPlaylist()).toBeNull();

    const epgSources = [{ url: 'http://host/epg.xml', playlistIds: ['p1'], kind: 'm3u' as const }];
    StorageService.setCachedPlaylist(channels, epgSources);
    expect(StorageService.getCachedPlaylist()).toEqual({ channels, epgSources });
  });

  it('defaults the theme to midnight and round-trips a selection', () => {
    expect(StorageService.getTheme()).toBe('midnight');
    StorageService.setTheme('arctic');
    expect(StorageService.getTheme()).toBe('arctic');
  });

  it('defaults the overlay style to dark and round-trips a selection', () => {
    expect(StorageService.getOverlayStyle()).toBe('dark');
    StorageService.setOverlayStyle('frosted');
    expect(StorageService.getOverlayStyle()).toBe('frosted');
  });

  it('defaults reminders to an empty array and round-trips them', () => {
    expect(StorageService.getReminders()).toEqual([]);
    const list = [{ channelKey: 'k1', channelName: 'Chan A', title: 'Alpha', startMs: 100, stopMs: 200 }];
    StorageService.setReminders(list);
    expect(StorageService.getReminders()).toEqual(list);
  });

  it('toggles a favorite on and off, returning the new state', () => {
    expect(StorageService.getFavorites()).toEqual([]);
    expect(StorageService.toggleFavorite('chan-1')).toBe(true);
    expect(StorageService.getFavorites()).toContain('chan-1');
    expect(StorageService.toggleFavorite('chan-1')).toBe(false);
    expect(StorageService.getFavorites()).not.toContain('chan-1');
  });

  it('namespaces keys with the configured storage prefix', () => {
    StorageService.setEpgUrl('http://epg/x.xml');
    const prefixed = Object.keys(localStorage).filter(k => k.startsWith('iptv_'));
    expect(prefixed.length).toBeGreaterThan(0);
  });

  describe('favorite key migration', () => {
    it('re-keys legacy favorites (id||name) to channelKey, then is idempotent', () => {
      StorageService.setFavorites(['fav1', 'fav2']); // legacy keys
      const channels = [ch({ id: 'fav1', url: 'http://host/a' }), ch({ name: 'fav2', url: 'http://host/b' })];
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual([channelKey(channels[0]), channelKey(channels[1])]);

      // A second call must not touch favorites again (flag set).
      StorageService.setFavorites(['untouched']);
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual(['untouched']);
    });

    it('waits for channels before migrating (and does not set the flag)', () => {
      StorageService.setFavorites(['fav1']);
      StorageService.migrateFavoriteKeys([]); // no channels yet → no-op
      expect(StorageService.getFavorites()).toEqual(['fav1']);

      const channels = [ch({ id: 'fav1', url: 'http://host/a' })];
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual([channelKey(channels[0])]);
    });

    it('drops a legacy favorite whose channel is no longer present', () => {
      StorageService.setFavorites(['gone']);
      StorageService.migrateFavoriteKeys([ch({ id: 'fav1', url: 'http://host/a' })]);
      expect(StorageService.getFavorites()).toEqual([]);
    });
  });

  describe('audio preferences', () => {
    it('returns null when no choice is saved for a channel', () => {
      expect(StorageService.getAudioPref('ch1')).toBeNull();
    });

    it('remembers a choice per channel without bleeding across channels', () => {
      StorageService.setAudioPref('ch1', { name: 'Track 1', lang: 'l1' });
      StorageService.setAudioPref('ch2', { name: 'Track 2', lang: 'l2' });
      expect(StorageService.getAudioPref('ch1')).toEqual({ name: 'Track 1', lang: 'l1' });
      expect(StorageService.getAudioPref('ch2')).toEqual({ name: 'Track 2', lang: 'l2' });
      expect(StorageService.getAudioPref('ch3')).toBeNull();
    });

    it('persists through localStorage (survives a reload)', () => {
      StorageService.setAudioPref('ch1', { name: 'Track 2', lang: 'l1' });
      // A fresh read goes back to localStorage — no in-memory cache.
      expect(StorageService.getAudioPref('ch1')).toEqual({ name: 'Track 2', lang: 'l1' });
      expect(localStorage.getItem('iptv_audio_prefs')).toContain('Track 2');
    });

    it('ignores an empty channel id', () => {
      StorageService.setAudioPref('', { name: 'Track 1', lang: 'l1' });
      expect(StorageService.getAudioPref('')).toBeNull();
      expect(localStorage.getItem('iptv_audio_prefs')).toBeNull();
    });
  });

  describe('subtitle preferences', () => {
    it('returns null when no choice is saved for a channel', () => {
      expect(StorageService.getSubtitlePref('ch1')).toBeNull();
    });

    it('remembers a choice per channel, including an explicit off, without bleeding', () => {
      StorageService.setSubtitlePref('ch1', { off: false, name: 'Track 1', lang: 'l1' });
      StorageService.setSubtitlePref('ch2', { off: true, name: '', lang: '' });
      expect(StorageService.getSubtitlePref('ch1')).toEqual({ off: false, name: 'Track 1', lang: 'l1' });
      expect(StorageService.getSubtitlePref('ch2')).toEqual({ off: true, name: '', lang: '' });
      expect(StorageService.getSubtitlePref('ch3')).toBeNull();
    });

    it('persists through localStorage (survives a reload)', () => {
      StorageService.setSubtitlePref('ch1', { off: false, name: 'Track 2', lang: 'l1' });
      expect(StorageService.getSubtitlePref('ch1')).toEqual({ off: false, name: 'Track 2', lang: 'l1' });
      expect(localStorage.getItem('iptv_subtitle_prefs')).toContain('Track 2');
    });

    it('ignores an empty channel id', () => {
      StorageService.setSubtitlePref('', { off: true, name: '', lang: '' });
      expect(StorageService.getSubtitlePref('')).toBeNull();
      expect(localStorage.getItem('iptv_subtitle_prefs')).toBeNull();
    });
  });

  describe('subtitle offsets', () => {
    it('defaults to 0 for an unknown key', () => {
      expect(StorageService.getSubtitleOffset('ch1')).toBe(0);
    });
    it('round-trips per key and evicts a zero', () => {
      StorageService.setSubtitleOffset('ch1', 1.25);
      StorageService.setSubtitleOffset('ch2', -0.5);
      expect(StorageService.getSubtitleOffset('ch1')).toBe(1.25);
      expect(StorageService.getSubtitleOffset('ch2')).toBe(-0.5);
      StorageService.setSubtitleOffset('ch1', 0);
      expect(StorageService.getSubtitleOffset('ch1')).toBe(0);
      expect(localStorage.getItem('iptv_subtitle_offsets')).not.toContain('ch1');
    });
    it('ignores an empty key', () => {
      StorageService.setSubtitleOffset('', 2);
      expect(StorageService.getSubtitleOffset('')).toBe(0);
    });
  });
});

import type { CatchupProgressEntry, ResumeEntry, WatchlistEntry } from '../types';

const resume = (over: Partial<ResumeEntry>): ResumeEntry => ({
  accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4',
  position: 100, duration: 6000, updatedAt: 1000, ...over,
});

describe('selected Xtream account id', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to null when unset', () => {
    expect(StorageService.getSelectedXtreamAccountId()).toBe(null);
  });

  it('round-trips a stored id', () => {
    StorageService.setSelectedXtreamAccountId('a2');
    expect(StorageService.getSelectedXtreamAccountId()).toBe('a2');
  });
});

const watchlist = (over: Partial<WatchlistEntry> = {}): WatchlistEntry => ({
  accountId: 'x1',
  kind: 'vod',
  itemId: '10',
  name: 'Movie One',
  poster: 'http://host/a',
  rating: '',
  categoryId: '1',
  containerExtension: 'mp4',
  addedAt: 1000,
  ...over,
});

describe('StorageService Watchlist store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('toggles entries and lists them newest first', () => {
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '10', addedAt: 1000 }))).toBe(true);
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '11', addedAt: 2000 }))).toBe(true);
    expect(StorageService.getWatchlist('x1', 'vod').map((entry) => entry.itemId)).toEqual(['11', '10']);
    expect(StorageService.isWatchlisted('x1', 'vod', '10')).toBe(true);

    expect(StorageService.toggleWatchlist(watchlist({ itemId: '10', addedAt: 3000 }))).toBe(false);
    expect(StorageService.isWatchlisted('x1', 'vod', '10')).toBe(false);
  });

  it('removes one completed item without affecting the rest', () => {
    StorageService.toggleWatchlist(watchlist({ itemId: '10' }));
    StorageService.toggleWatchlist(watchlist({ itemId: '11' }));
    StorageService.removeWatchlist('x1', 'vod', '10');
    expect(StorageService.getWatchlist('x1', 'vod').map((entry) => entry.itemId)).toEqual(['11']);
  });

  it('isolates accounts and content types', () => {
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'vod', itemId: 'same' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'series', itemId: 'same' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x2', kind: 'vod', itemId: 'same' }));

    expect(StorageService.getWatchlist('x1', 'vod')).toHaveLength(1);
    expect(StorageService.getWatchlist('x1', 'series')).toHaveLength(1);
    expect(StorageService.getWatchlist('x2', 'vod')).toHaveLength(1);
  });

  it('caps each account and content type at 200 entries', () => {
    for (let i = 0; i < 205; i++) {
      StorageService.toggleWatchlist(watchlist({ itemId: String(i), addedAt: i }));
    }
    const entries = StorageService.getWatchlist('x1', 'vod');
    expect(entries).toHaveLength(200);
    expect(entries[0].itemId).toBe('204');
    expect(entries[199].itemId).toBe('5');
  });

  it('clears both content types for one account only', () => {
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'vod' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'series' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x2', kind: 'vod' }));

    StorageService.clearWatchlist('x1');
    expect(StorageService.getWatchlist('x1', 'vod')).toEqual([]);
    expect(StorageService.getWatchlist('x1', 'series')).toEqual([]);
    expect(StorageService.getWatchlist('x2', 'vod')).toHaveLength(1);
  });
});

describe('StorageService resume store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a resume entry keyed by account + kind + item', () => {
    StorageService.setResume(resume({}));
    expect(StorageService.getResume('x1', 'vod', '10')?.position).toBe(100);
    // Different account / kind / item are distinct keys.
    expect(StorageService.getResume('x2', 'vod', '10')).toBeNull();
    expect(StorageService.getResume('x1', 'episode', '10')).toBeNull();
    expect(StorageService.getResume('x1', 'vod', '11')).toBeNull();
  });

  it('clears a finished entry (near the end) instead of storing it', () => {
    StorageService.setResume(resume({ position: 100 }));
    StorageService.setResume(resume({ position: 5990, duration: 6000 })); // within RESUME_FINISH_PAD
    expect(StorageService.getResume('x1', 'vod', '10')).toBeNull();
  });

  it('does not store a position below RESUME_MIN_SECS, and clears an existing one', () => {
    StorageService.setResume(resume({ position: 5 }));
    expect(StorageService.getResume('x1', 'vod', '10')).toBeNull();
    // An existing resume point rewound below the threshold is cleared.
    StorageService.setResume(resume({ position: 100 }));
    StorageService.setResume(resume({ position: 5 }));
    expect(StorageService.getResume('x1', 'vod', '10')).toBeNull();
  });

  it('lists an account\'s entries newest first and clears on demand', () => {
    StorageService.setResume(resume({ itemId: '10', updatedAt: 1000 }));
    StorageService.setResume(resume({ itemId: '11', updatedAt: 2000 }));
    StorageService.setResume(resume({ accountId: 'x2', itemId: '12', updatedAt: 3000 }));
    const list = StorageService.getResumeList('x1');
    expect(list.map((e) => e.itemId)).toEqual(['11', '10']);
    StorageService.clearResume('x1', 'vod', '11');
    expect(StorageService.getResumeList('x1').map((e) => e.itemId)).toEqual(['10']);
  });

  it('stores and reads a picked online subtitle', () => {
    StorageService.setPickedOnlineSub('acc', 'vod', 'm1', { providerId: 'subdl', id: '9', name: 'Alpha', lang: 'l1', format: 'srt' });
    expect(StorageService.getPickedOnlineSub('acc', 'vod', 'm1')).toMatchObject({ id: '9', format: 'srt' });
    expect(StorageService.getPickedOnlineSub('acc', 'vod', 'zzz')).toBeNull();
  });
});

describe('StorageService recently watched live store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores newest entries first and moves a repeated channel to the front', () => {
    StorageService.touchRecentlyWatchedLive('ch1', 1000);
    StorageService.touchRecentlyWatchedLive('ch2', 2000);
    StorageService.touchRecentlyWatchedLive('ch1', 3000);
    expect(StorageService.getRecentlyWatchedLive()).toEqual([
      { channelKey: 'ch1', updatedAt: 3000 },
      { channelKey: 'ch2', updatedAt: 2000 },
    ]);
  });

  it('caps the stored live history', () => {
    for (let i = 0; i < 35; i++) {
      StorageService.touchRecentlyWatchedLive(`ch${String(i)}`, i);
    }
    const entries = StorageService.getRecentlyWatchedLive();
    expect(entries).toHaveLength(30);
    expect(entries[0].channelKey).toBe('ch34');
    expect(entries[29].channelKey).toBe('ch5');
  });

  it('ignores an empty channel key', () => {
    StorageService.touchRecentlyWatchedLive('', 1000);
    expect(StorageService.getRecentlyWatchedLive()).toEqual([]);
  });

  it('retries after evicting only the playlist cache on a quota error', () => {
    StorageService.set('cached_playlist', { value: 'cache' });
    const original = Storage.prototype.setItem;
    let rejected = false;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (!rejected && key === 'iptv_recently_watched_live') {
        rejected = true;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    });
    try {
      StorageService.touchRecentlyWatchedLive('ch1', 1000);
      expect(StorageService.getRecentlyWatchedLive()).toEqual([
        { channelKey: 'ch1', updatedAt: 1000 },
      ]);
      expect(localStorage.getItem('iptv_cached_playlist')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('StorageService catchup progress store', () => {
  beforeEach(() => { localStorage.clear(); });

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  // Arbitrary fixed epoch so tests do not depend on real time.
  const baseNow = 1_700_000_000_000;

  const mkEntry = (over: Partial<CatchupProgressEntry> = {}): CatchupProgressEntry => ({
    channelKey: 'ck1',
    progStart: baseNow - HOUR,
    progEnd: baseNow + HOUR,
    position: 60,
    duration: 3600,
    updatedAt: baseNow,
    completed: false,
    ...over,
  });

  it('returns null when no entry exists', () => {
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow)).toBeNull();
  });

  it('round-trips a catchup progress entry', () => {
    StorageService.setCatchupProgress(mkEntry({ title: 'Program Alpha', description: 'Summary', icon: 'http://host/a' }), 7, baseNow);
    const got = StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow);
    expect(got).not.toBeNull();
    expect(got!.position).toBe(60);
    expect(got!.completed).toBe(false);
    expect(got).toMatchObject({ title: 'Program Alpha', description: 'Summary', icon: 'http://host/a' });
  });

  it('isolates entries by channelKey', () => {
    StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck1' }), 7, baseNow);
    expect(StorageService.getCatchupProgress('ck2', baseNow - HOUR, baseNow)).toBeNull();
  });

  it('isolates entries by progStart', () => {
    StorageService.setCatchupProgress(mkEntry(), 7, baseNow);
    expect(StorageService.getCatchupProgress('ck1', baseNow - 2 * HOUR, baseNow)).toBeNull();
  });

  it('does not store when position is below the minimum resume threshold', () => {
    StorageService.setCatchupProgress(mkEntry({ position: 14 }), 7, baseNow);
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow)).toBeNull();
  });

  it('clears an existing entry when position drops below the minimum resume threshold', () => {
    StorageService.setCatchupProgress(mkEntry({ position: 60 }), 7, baseNow);
    StorageService.setCatchupProgress(mkEntry({ position: 5 }), 7, baseNow);
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow)).toBeNull();
  });

  it('retains a completed entry rather than clearing it', () => {
    StorageService.setCatchupProgress(mkEntry({ position: 3570, completed: true }), 7, baseNow);
    const got = StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow);
    expect(got).not.toBeNull();
    expect(got!.completed).toBe(true);
  });

  it('does not auto-clear a near-end entry that is not yet marked completed', () => {
    // Unlike Xtream resume, catch-up never auto-clears near the end.
    StorageService.setCatchupProgress(mkEntry({ position: 3590, duration: 3600, completed: false }), 7, baseNow);
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow)).not.toBeNull();
  });

  it('clears one entry explicitly without touching others', () => {
    StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck1' }), 7, baseNow);
    StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck2' }), 7, baseNow);
    StorageService.clearCatchupProgress('ck1', baseNow - HOUR);
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, baseNow)).toBeNull();
    expect(StorageService.getCatchupProgress('ck2', baseNow - HOUR, baseNow)).not.toBeNull();
  });

  it('expires an entry at progEnd + catchupDays', () => {
    const progEnd = baseNow + HOUR;
    StorageService.setCatchupProgress(mkEntry({ progEnd }), 3, baseNow);
    // One ms before expiry: still valid.
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, progEnd + 3 * DAY - 1)).not.toBeNull();
    // One ms past expiry: null.
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, progEnd + 3 * DAY + 1)).toBeNull();
  });

  it('uses 7-day fallback retention when catchupDays is 0', () => {
    const progEnd = baseNow + HOUR;
    StorageService.setCatchupProgress(mkEntry({ progEnd }), 0, baseNow);
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, progEnd + 7 * DAY - 1)).not.toBeNull();
    expect(StorageService.getCatchupProgress('ck1', baseNow - HOUR, progEnd + 7 * DAY + 1)).toBeNull();
  });

  it('prunes expired entries from storage during a set so storage does not grow forever', () => {
    const progEnd = baseNow + HOUR;
    const storeKey = `ck1|${baseNow - HOUR}`;
    StorageService.setCatchupProgress(mkEntry({ progEnd }), 1, baseNow);
    expect(JSON.parse(localStorage.getItem('iptv_catchup_progress')!)).toHaveProperty(storeKey);
    // Writing another entry after ck1's expiry (progEnd + 1 day) prunes ck1.
    const afterExpiry = progEnd + DAY + 1;
    StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck2', progEnd: baseNow + 30 * DAY }), 7, afterExpiry);
    expect(JSON.parse(localStorage.getItem('iptv_catchup_progress')!)).not.toHaveProperty(storeKey);
  });

  it('prunes expired entries from storage during a get so storage does not grow forever', () => {
    const progEnd = baseNow + HOUR;
    const storeKey = `ck1|${baseNow - HOUR}`;
    StorageService.setCatchupProgress(mkEntry({ progEnd }), 1, baseNow);
    expect(JSON.parse(localStorage.getItem('iptv_catchup_progress')!)).toHaveProperty(storeKey);
    const afterExpiry = progEnd + DAY + 1;
    // Reading any key triggers pruning of all expired entries.
    StorageService.getCatchupProgress('ck2', baseNow, afterExpiry);
    expect(JSON.parse(localStorage.getItem('iptv_catchup_progress')!)).not.toHaveProperty(storeKey);
  });

  it('does not persist an already-expired entry (dead-on-arrival check)', () => {
    // An entry whose progEnd + catchupDays is already in the past at compute time
    // must not be stored. This can happen when progEnd is far in the past or
    // catchupDays is 0 (using the fallback) and progEnd + fallback < now.
    const veryOldProgEnd = baseNow - 30 * DAY;
    StorageService.setCatchupProgress(mkEntry({ progEnd: veryOldProgEnd }), 0, baseNow);
    // The entry should not exist in storage (check raw storage, not through
    // getCatchupProgress which prunes). With progEnd in the past and 7-day fallback,
    // expiresAt is already <= now, so it must not be written at all.
    const storeKey = `ck1|${baseNow - HOUR}`;
    const raw = JSON.parse(localStorage.getItem('iptv_catchup_progress') ?? '{}');
    expect(raw).not.toHaveProperty(storeKey);
  });

  describe('getCatchupProgressList', () => {
    it('returns all non-expired entries for the given channel key', () => {
      StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck1', progStart: baseNow - 2 * HOUR }), 7, baseNow);
      StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck1', progStart: baseNow - 3 * HOUR }), 7, baseNow);
      StorageService.setCatchupProgress(mkEntry({ channelKey: 'ck2', progStart: baseNow - HOUR }), 7, baseNow);
      const list = StorageService.getCatchupProgressList('ck1', baseNow);
      expect(list).toHaveLength(2);
      expect(list.every(e => e.channelKey === 'ck1')).toBe(true);
    });

    it('returns an empty array when no entries exist', () => {
      expect(StorageService.getCatchupProgressList('ck1', baseNow)).toEqual([]);
    });

    it('excludes expired entries', () => {
      const progEnd = baseNow + HOUR;
      StorageService.setCatchupProgress(mkEntry({ progEnd }), 1, baseNow);
      const afterExpiry = progEnd + DAY + 1;
      expect(StorageService.getCatchupProgressList('ck1', afterExpiry)).toEqual([]);
    });

    it('prunes expired entries from storage', () => {
      const progEnd = baseNow + HOUR;
      StorageService.setCatchupProgress(mkEntry({ progEnd }), 1, baseNow);
      const storeKey = `ck1|${baseNow - HOUR}`;
      const afterExpiry = progEnd + DAY + 1;
      StorageService.getCatchupProgressList('ck1', afterExpiry);
      const stored = JSON.parse(localStorage.getItem('iptv_catchup_progress') ?? '{}');
      expect(stored).not.toHaveProperty(storeKey);
    });

    it('does not write to storage when nothing is pruned', () => {
      StorageService.setCatchupProgress(mkEntry(), 7, baseNow);
      const spy = vi.spyOn(Storage.prototype, 'setItem');
      StorageService.getCatchupProgressList('ck1', baseNow);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('strips the internal expiresAt field from returned entries', () => {
      StorageService.setCatchupProgress(mkEntry(), 7, baseNow);
      const list = StorageService.getCatchupProgressList('ck1', baseNow);
      expect(list).toHaveLength(1);
      expect((list[0] as any).expiresAt).toBeUndefined();
    });
  });

  describe('getAllCatchupProgress', () => {
    it('returns every non-expired entry newest first and prunes expired data', () => {
      StorageService.setCatchupProgress(mkEntry({
        channelKey: 'ck1',
        progEnd: baseNow + HOUR,
        updatedAt: baseNow,
      }), 1, baseNow);
      StorageService.setCatchupProgress(mkEntry({
        channelKey: 'ck2',
        progStart: baseNow,
        progEnd: baseNow + 30 * DAY,
        updatedAt: baseNow + 1,
      }), 7, baseNow);

      const afterExpiry = baseNow + HOUR + DAY + 1;
      expect(StorageService.getAllCatchupProgress(afterExpiry).map(entry => entry.channelKey))
        .toEqual(['ck2']);
      const stored = JSON.parse(localStorage.getItem('iptv_catchup_progress') ?? '{}');
      expect(Object.keys(stored).every(key => key.startsWith('ck2|'))).toBe(true);
    });

    it('keeps legacy entries without display snapshots readable', () => {
      StorageService.setCatchupProgress(mkEntry(), 7, baseNow);
      expect(StorageService.getAllCatchupProgress(baseNow)[0]).not.toHaveProperty('title');
    });
  });

  it('clears live and Catch-up history without touching VOD resume or Favorites', () => {
    StorageService.touchRecentlyWatchedLive('ch1', baseNow);
    StorageService.setCatchupProgress(mkEntry(), 7, baseNow);
    StorageService.setResume(resume({}));
    StorageService.setFavorites(['ch1']);

    StorageService.clearRecentlyWatched();

    expect(StorageService.getRecentlyWatchedLive()).toEqual([]);
    expect(StorageService.getAllCatchupProgress(baseNow)).toEqual([]);
    expect(StorageService.getResume('x1', 'vod', '10')).not.toBeNull();
    expect(StorageService.getFavorites()).toEqual(['ch1']);
  });
});
