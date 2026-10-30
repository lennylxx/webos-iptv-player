// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel } from '../types';
import {
  NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS,
  LIVE_RECONNECT_ATTEMPT_OPTIONS,
  PLAYER_OSD_TIMEOUT_MS_OPTIONS,
  REFRESH_INTERVAL_HOUR_OPTIONS,
  StorageService,
  XTREAM_CATALOG_REFRESH_HOUR_OPTIONS,
} from './storage-service';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { CONFIG } from '../config';
import {
  clearAllCachedData,
  getCachedStreamMime,
  setCachedStreamMime,
} from './idb-cache';

const ch = (over: Partial<Channel>): Channel => ({
  id: '', name: '', logo: '', group: '', url: '', extras: null,
  playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
});

describe('StorageService', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllCachedData();
  });

  it('keeps whole-catalog refusals outside the evictable cache and drops expired ones', async () => {
    const start = 1_000_000;
    expect(StorageService.getWholeCatalogRefusedAt('x1|vod_all')).toBeNull();
    StorageService.setWholeCatalogRefusedAt('x1|vod_all', start);
    await clearAllCachedData();
    expect(StorageService.getWholeCatalogRefusedAt('x1|vod_all')).toBe(start);

    const later = start + CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS;
    StorageService.setWholeCatalogRefusedAt('x1|series_all', later);
    expect(StorageService.getWholeCatalogRefusedAt('x1|vod_all')).toBeNull();
    expect(StorageService.getWholeCatalogRefusedAt('x1|series_all')).toBe(later);
  });

  it('returns an empty playlist list by default', () => {
    expect(StorageService.getPlaylists()).toEqual([]);
  });

  it('validates and persists the live reconnect limit', () => {
    expect(StorageService.getLiveReconnectAttempts())
      .toBe(CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS);
    for (const attempts of LIVE_RECONNECT_ATTEMPT_OPTIONS) {
      StorageService.setLiveReconnectAttempts(attempts);
      expect(StorageService.getLiveReconnectAttempts()).toBe(attempts);
    }
    expect(() => StorageService.setLiveReconnectAttempts(6)).toThrow(RangeError);
    expect(() => StorageService.setLiveReconnectAttempts(NaN)).toThrow(RangeError);
    StorageService.set('live_reconnect_attempts', '5');
    expect(StorageService.getLiveReconnectAttempts())
      .toBe(CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS);
    StorageService.setLiveReconnectAttempts(5);
    StorageService.clearAll();
    expect(StorageService.getLiveReconnectAttempts())
      .toBe(CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS);
  });

  it('validates and persists OSD timeouts', () => {
    expect(StorageService.getNumberEntryOsdTimeoutMs())
      .toBe(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
    expect(StorageService.getPlayerOsdTimeoutMs())
      .toBe(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
    for (const timeout of NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS) {
      StorageService.setNumberEntryOsdTimeoutMs(timeout);
      expect(StorageService.getNumberEntryOsdTimeoutMs()).toBe(timeout);
    }
    for (const timeout of PLAYER_OSD_TIMEOUT_MS_OPTIONS) {
      StorageService.setPlayerOsdTimeoutMs(timeout);
      expect(StorageService.getPlayerOsdTimeoutMs()).toBe(timeout);
    }
    expect(() => StorageService.setNumberEntryOsdTimeoutMs(1100)).toThrow(RangeError);
    expect(() => StorageService.setPlayerOsdTimeoutMs(NaN)).toThrow(RangeError);
    StorageService.set('number_entry_osd_timeout_ms', '1800');
    StorageService.set('player_osd_timeout_ms', {});
    expect(StorageService.getNumberEntryOsdTimeoutMs())
      .toBe(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
    expect(StorageService.getPlayerOsdTimeoutMs())
      .toBe(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
  });

  it('validates and persists playlist and guide refresh intervals', () => {
    expect(StorageService.getPlaylistRefreshIntervalHours()).toBe(6);
    expect(StorageService.getEpgRefreshIntervalHours()).toBe(6);
    for (const hours of REFRESH_INTERVAL_HOUR_OPTIONS) {
      StorageService.setPlaylistRefreshIntervalHours(hours);
      StorageService.setEpgRefreshIntervalHours(hours);
      expect(StorageService.getPlaylistRefreshIntervalHours()).toBe(hours);
      expect(StorageService.getEpgRefreshIntervalHours()).toBe(hours);
      expect(StorageService.getPlaylistRefreshIntervalMs())
        .toBe(hours === 0 ? null : hours * 60 * 60 * 1000);
      expect(StorageService.getEpgRefreshIntervalMs())
        .toBe(hours === 0 ? null : hours * 60 * 60 * 1000);
    }
    expect(() => StorageService.setPlaylistRefreshIntervalHours(2)).toThrow(RangeError);
    expect(() => StorageService.setEpgRefreshIntervalHours(NaN)).toThrow(RangeError);
    StorageService.set('playlist_refresh_interval_hours', '12');
    StorageService.set('epg_refresh_interval_hours', {});
    expect(StorageService.getPlaylistRefreshIntervalHours()).toBe(6);
    expect(StorageService.getEpgRefreshIntervalHours()).toBe(6);
  });

  it('validates and persists the Xtream catalog refresh interval', () => {
    expect(StorageService.getXtreamCatalogRefreshIntervalHours()).toBe(6);
    for (const hours of XTREAM_CATALOG_REFRESH_HOUR_OPTIONS) {
      StorageService.setXtreamCatalogRefreshIntervalHours(hours);
      expect(StorageService.getXtreamCatalogRefreshIntervalHours()).toBe(hours);
      expect(StorageService.getXtreamCatalogRefreshIntervalMs())
        .toBe(hours * 60 * 60 * 1000);
    }
    expect(() => StorageService.setXtreamCatalogRefreshIntervalHours(0))
      .toThrow(RangeError);
    StorageService.set('xtream_catalog_refresh_interval_hours', '12');
    expect(StorageService.getXtreamCatalogRefreshIntervalHours()).toBe(6);
  });

  describe('catalog sort preferences', () => {
    it('defaults Movies and Series to server order without writing', () => {
      expect(StorageService.getCatalogSort('vod')).toEqual({ by: 'default', direction: 'asc' });
      expect(StorageService.getCatalogSort('series')).toEqual({ by: 'default', direction: 'asc' });
      expect(localStorage.getItem('iptv_catalog_sort_vod')).toBeNull();
      expect(localStorage.getItem('iptv_catalog_sort_series')).toBeNull();
    });

    it('persists every field and direction independently for Movies and Series', () => {
      for (const by of ['default', 'name', 'added', 'rating', 'year'] as const) {
        for (const direction of ['asc', 'desc'] as const) {
          expect(StorageService.setCatalogSort('vod', { by, direction })).toBe(true);
          expect(StorageService.getCatalogSort('vod')).toEqual({ by, direction });
        }
      }
      StorageService.setCatalogSort('vod', { by: 'rating', direction: 'asc' });
      StorageService.setCatalogSort('series', { by: 'name', direction: 'desc' });
      expect(StorageService.getCatalogSort('vod')).toEqual({ by: 'rating', direction: 'asc' });
      expect(StorageService.getCatalogSort('series')).toEqual({ by: 'name', direction: 'desc' });
      expect(JSON.parse(localStorage.getItem('iptv_catalog_sort_vod')!))
        .toEqual({ by: 'rating', direction: 'asc' });
    });

    it('is not scoped to the selected account', () => {
      StorageService.setSelectedXtreamAccountId('a1');
      StorageService.setCatalogSort('vod', { by: 'year', direction: 'desc' });
      StorageService.setSelectedXtreamAccountId('a2');
      expect(StorageService.getCatalogSort('vod')).toEqual({ by: 'year', direction: 'desc' });
    });

    it('stores only the field and direction', () => {
      const sort = { by: 'added', direction: 'asc', extra: 'x' } as unknown as Parameters<typeof StorageService.setCatalogSort>[1];
      StorageService.setCatalogSort('series', sort);
      expect(JSON.parse(localStorage.getItem('iptv_catalog_sort_series')!))
        .toEqual({ by: 'added', direction: 'asc' });
    });

    it('rejects invalid preferences without overwriting the saved one', () => {
      StorageService.setCatalogSort('vod', { by: 'name', direction: 'desc' });
      for (const sort of [
        { by: 'popularity', direction: 'asc' },
        { by: 'name', direction: 'up' },
        { by: null, direction: 'asc' },
      ]) {
        expect(() => StorageService.setCatalogSort(
          'vod', sort as unknown as Parameters<typeof StorageService.setCatalogSort>[1],
        )).toThrow(RangeError);
      }
      expect(StorageService.getCatalogSort('vod')).toEqual({ by: 'name', direction: 'desc' });
    });

    it('falls back to server order for malformed stored values', () => {
      const fallback = { by: 'default', direction: 'asc' };
      for (const raw of [
        'not json',
        JSON.stringify('name'),
        JSON.stringify(42),
        JSON.stringify(null),
        JSON.stringify([]),
        JSON.stringify({ by: 'name' }),
        JSON.stringify({ direction: 'desc' }),
        JSON.stringify({ by: 'popularity', direction: 'desc' }),
        JSON.stringify({ by: 'rating', direction: 'DESC' }),
        JSON.stringify({ by: 'Rating', direction: 'desc' }),
      ]) {
        localStorage.setItem('iptv_catalog_sort_vod', raw);
        expect(StorageService.getCatalogSort('vod')).toEqual(fallback);
      }
      localStorage.setItem('iptv_catalog_sort_series', JSON.stringify({ by: 'year', direction: 'asc', extra: 1 }));
      expect(StorageService.getCatalogSort('series')).toEqual({ by: 'year', direction: 'asc' });
    });

    it('reports a failed write and keeps the previous preference', () => {
      StorageService.setCatalogSort('vod', { by: 'name', direction: 'asc' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
      try {
        expect(StorageService.setCatalogSort('vod', { by: 'added', direction: 'desc' })).toBe(false);
      } finally {
        setItem.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
      expect(StorageService.getCatalogSort('vod')).toEqual({ by: 'name', direction: 'asc' });
    });

    it('falls back to server order when storage cannot be read', () => {
      StorageService.setCatalogSort('series', { by: 'rating', direction: 'desc' });
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      try {
        expect(StorageService.getCatalogSort('series')).toEqual({ by: 'default', direction: 'asc' });
      } finally {
        getItem.mockRestore();
      }
    });
  });

  it('defaults live preview to off without writing a preference', () => {
    expect(StorageService.getLivePreview()).toBe(false);
    expect(localStorage.getItem('iptv_live_preview')).toBeNull();
  });

  it('validates and persists the animation mode', () => {
    expect(StorageService.getAnimationMode()).toBe('reduced');
    StorageService.setAnimationMode('full');
    expect(StorageService.getAnimationMode()).toBe('full');
    StorageService.setAnimationMode('essential');
    expect(StorageService.getAnimationMode()).toBe('essential');
    expect(() => StorageService.setAnimationMode('invalid' as 'essential'))
      .toThrow(RangeError);
    StorageService.set('animation_mode', 'invalid');
    expect(StorageService.getAnimationMode()).toBe('reduced');
  });

  it('reports each source change with the list it replaced', () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    const handler = vi.fn();
    StorageService.setPlaylistsReplacedHandler(handler);
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    expect(handler).not.toHaveBeenCalled();
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/b' }]);
    expect(handler).toHaveBeenCalledWith(
      [{ id: 'p1', name: 'P1', url: 'http://host/a' }],
      [{ id: 'p1', name: 'P1', url: 'http://host/b' }],
    );
    StorageService.setPlaylistsReplacedHandler(() => {});
  });

  it('persists live preview on and off independently from autoplay and sources', () => {
    StorageService.setAutoPlay(true);
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    StorageService.setLivePreview(true);
    expect(localStorage.getItem('iptv_live_preview')).toBe('true');
    expect(StorageService.getLivePreview()).toBe(true);

    StorageService.setPlaylists([{ id: 'p2', name: 'P2', url: 'http://host/b' }]);
    StorageService.setAutoPlay(false);
    expect(StorageService.getLivePreview()).toBe(true);

    StorageService.setLivePreview(false);
    expect(localStorage.getItem('iptv_live_preview')).toBe('false');
    expect(StorageService.getLivePreview()).toBe(false);
    expect(StorageService.getAutoPlay()).toBe(false);
  });

  it.each(['null', '"true"', '1', '{}', 'invalid'])(
    'keeps live preview off for a malformed stored preference %s',
    (value) => {
      localStorage.setItem('iptv_live_preview', value);
      expect(StorageService.getLivePreview()).toBe(false);
    },
  );

  it('reads persisted live preview on upgrade and clears it on reset', () => {
    localStorage.setItem('iptv_live_preview', 'true');
    expect(StorageService.getLivePreview()).toBe(true);
    StorageService.clearAll();
    expect(StorageService.getLivePreview()).toBe(false);
  });

  it('clears all local storage when resetting the app', () => {
    StorageService.set('theme', 'light');
    localStorage.setItem('unrelated', 'value');

    StorageService.clearAll();

    expect(localStorage.length).toBe(0);
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

  it('invalidates the channel cache and probed stream MIMEs when playlist configuration changes', async () => {
    StorageService.set('cached_playlist', { legacy: true });
    await setCachedStreamMime('http://host/live', 'video/mp2t');
    StorageService.setPlaylists([{ id: 'p1', name: 'A', url: 'http://host/a' }]);
    expect(localStorage.getItem('iptv_cached_playlist')).toBeNull();
    // An account that switches live output keeps its route, so a stale probe
    // would otherwise pin the new format to the old container.
    await vi.waitFor(async () => {
      expect(await getCachedStreamMime('http://host/live')).toBeNull();
    });
  });

  it('defaults manual EPG sources to an empty list and round-trips them', () => {
    expect(StorageService.getManualEpgSources()).toEqual([]);
    StorageService.setManualEpgSources([
      { url: 'http://epg/guide.xml', playlistIds: [] },
    ]);
    expect(StorageService.getManualEpgSources()).toEqual([
      { url: 'http://epg/guide.xml', playlistIds: [] },
    ]);
  });

  it('migrates the legacy EPG URL and sanitizes manual EPG sources', () => {
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/legacy.xml'));
    expect(StorageService.getManualEpgSources()).toEqual([
      { url: 'http://host/legacy.xml', playlistIds: [] },
    ]);
    expect(localStorage.getItem('iptv_epg_url')).toBeNull();
    expect(localStorage.getItem('iptv_manual_epg_sources')).not.toBeNull();

    StorageService.setManualEpgSources([
      { url: ' http://host/a.xml ', playlistIds: ['p1', 'p1'] },
      { url: 'http://host/a.xml', playlistIds: ['p2'] },
      { url: 'http://host/b.xml', playlistIds: [] },
      { url: '', playlistIds: ['p3'] },
    ]);

    expect(StorageService.getManualEpgSources()).toEqual([
      { url: 'http://host/a.xml', playlistIds: ['p1', 'p2'] },
      { url: 'http://host/b.xml', playlistIds: [] },
    ]);
  });

  it('round-trips sanitized EPG source offsets and omits zero values', () => {
    StorageService.setEpgOffsets({
      'http://host/a': 30,
      'http://host/b': -90,
      'http://host/zero': 0,
      'http://host/high': 900,
    });

    expect(StorageService.getEpgOffsets()).toEqual({
      'http://host/a': 30,
      'http://host/b': -90,
      'http://host/high': CONFIG.EPG.OFFSET_MAX_MINUTES,
    });
  });

  it('keeps guide-off sources outside the playlist entries', () => {
    expect(StorageService.getGuideOffSources()).toEqual([]);
    const playlists = localStorage.getItem('iptv_playlists');
    StorageService.setGuideOffSources(['x1', '', 'x1', 'x2']);
    expect(StorageService.getGuideOffSources()).toEqual(['x1', 'x2']);
    expect(localStorage.getItem('iptv_playlists')).toBe(playlists);
    StorageService.set('guide_off_sources', [3, 'x3']);
    expect(StorageService.getGuideOffSources()).toEqual(['x3']);
  });

  it('ignores a malformed EPG offset map', () => {
    StorageService.set('epg_offsets', null);
    expect(StorageService.getEpgOffsets()).toEqual({});
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

  it('defaults to the system language and round-trips a locale preference', () => {
    expect(StorageService.getLocalePreference()).toBe('system');
    StorageService.setLocalePreference('zh-CN');
    expect(StorageService.getLocalePreference()).toBe('zh-CN');
  });

  it('ignores an unsupported stored locale', () => {
    StorageService.set('locale', 'l1');
    expect(StorageService.getLocalePreference()).toBe('system');
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
    StorageService.setManualEpgSources([
      { url: 'http://epg/x.xml', playlistIds: [] },
    ]);
    const prefixed = Object.keys(localStorage).filter(k => k.startsWith('iptv_'));
    expect(prefixed.length).toBeGreaterThan(0);
  });

  describe('favorite key migration', () => {
    it('re-keys legacy favorites (id||name) to channelKey, then is idempotent', () => {
      StorageService.setFavorites(['fav1', 'fav2']); // legacy keys
      const channels = [ch({ id: 'fav1', url: 'http://host/a' }), ch({ name: 'fav2', url: 'http://host/b' })];
      StorageService.migrateFavoriteKeys(channels);
      expect(StorageService.getFavorites()).toEqual([
        channelKey(channels[0]),
        channelKey(channels[1]),
      ]);

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

    it('migrates a unique query-stripped key to the query-aware stream key', () => {
      const channel = ch({ url: 'http://host/a?id=1' });
      StorageService.setFavorites([legacyChannelKey(channel)]);
      StorageService.set('fav_url_keyed', true);

      StorageService.migrateFavoriteKeys([channel]);

      expect(StorageService.getFavorites()).toEqual([channelKey(channel)]);
    });

    it('preserves every channel matched by an ambiguous query-stripped key', () => {
      const channels = [
        ch({ url: 'http://host/a?id=1' }),
        ch({ url: 'http://host/a?id=2' }),
      ];
      StorageService.setFavorites([legacyChannelKey(channels[0])]);
      StorageService.set('fav_url_keyed', true);

      StorageService.migrateFavoriteKeys(channels);

      expect(StorageService.getFavorites()).toEqual(channels.map(channelKey));
    });

    it('preserves already-migrated keys when the completion flag is missing', () => {
      const channel = ch({ url: 'http://host/a?id=1' });
      StorageService.setFavorites([channelKey(channel)]);
      StorageService.set('fav_url_keyed', true);

      StorageService.migrateFavoriteKeys([channel]);

      expect(StorageService.getFavorites()).toEqual([channelKey(channel)]);
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

    it('reads a legacy channel key without rewriting it', () => {
      StorageService.setAudioPref('old', { name: 'Track 1', lang: 'l1' });

      expect(StorageService.getAudioPref('new', 'old')).toEqual({ name: 'Track 1', lang: 'l1' });
      expect(JSON.parse(localStorage.getItem('iptv_audio_prefs') ?? '{}')).toEqual({
        old: { name: 'Track 1', lang: 'l1' },
      });
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

    it('prefers the current key and falls back to a legacy key without rewriting', () => {
      StorageService.setSubtitlePref('old', { off: true, name: '', lang: '' });
      expect(StorageService.getSubtitlePref('new', 'old')).toEqual({ off: true, name: '', lang: '' });

      StorageService.setSubtitlePref('new', { off: false, name: 'Track 1', lang: 'l1' });
      expect(StorageService.getSubtitlePref('new', 'old'))
        .toEqual({ off: false, name: 'Track 1', lang: 'l1' });
      expect(JSON.parse(localStorage.getItem('iptv_subtitle_prefs') ?? '{}')).toHaveProperty('old');
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
    it('prefers the current key and falls back to a legacy key without rewriting', () => {
      StorageService.setSubtitleOffset('old', 1.5);
      expect(StorageService.getSubtitleOffset('new', 'old')).toBe(1.5);

      StorageService.setSubtitleOffset('new', -0.5);
      expect(StorageService.getSubtitleOffset('new', 'old')).toBe(-0.5);
      expect(JSON.parse(localStorage.getItem('iptv_subtitle_offsets') ?? '{}')).toHaveProperty('old');
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

describe('StorageService search history', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the newest search first, trimmed', () => {
    StorageService.addSearchHistory(' Alpha ');
    StorageService.addSearchHistory('Bravo');
    expect(StorageService.getSearchHistory()).toEqual(['Bravo', 'Alpha']);
  });

  it('ignores a blank query', () => {
    StorageService.addSearchHistory('   ');
    expect(StorageService.getSearchHistory()).toEqual([]);
  });

  it('moves a repeated search to the front, ignoring case', () => {
    StorageService.addSearchHistory('Alpha');
    StorageService.addSearchHistory('Bravo');
    StorageService.addSearchHistory('alpha');
    expect(StorageService.getSearchHistory()).toEqual(['alpha', 'Bravo']);
  });

  it('evicts the oldest search past the cap', () => {
    const max = CONFIG.SEARCH.HISTORY_MAX_ENTRIES;
    for (let i = 0; i <= max; i++) StorageService.addSearchHistory(`q${i}`);
    const history = StorageService.getSearchHistory();
    expect(history).toHaveLength(max);
    expect(history[0]).toBe(`q${max}`);
    expect(history).not.toContain('q0');
  });

  it('clears every search', () => {
    StorageService.addSearchHistory('Alpha');
    StorageService.clearSearchHistory();
    expect(StorageService.getSearchHistory()).toEqual([]);
  });

  it('ignores a malformed stored value', () => {
    localStorage.setItem('iptv_search_history', JSON.stringify({ q: 'Alpha' }));
    expect(StorageService.getSearchHistory()).toEqual([]);
  });

  it('reports a failed clear instead of throwing', () => {
    StorageService.addSearchHistory('alpha');
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(StorageService.clearSearchHistory()).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(StorageService.getSearchHistory()).toEqual(['alpha']);
    expect(StorageService.clearSearchHistory()).toBe(true);
    expect(StorageService.getSearchHistory()).toEqual([]);
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
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '10', addedAt: 1000 }))).toBe('added');
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '11', addedAt: 2000 }))).toBe('added');
    expect(StorageService.getWatchlist('x1', 'vod').map((entry) => entry.itemId)).toEqual(['11', '10']);
    expect(StorageService.isWatchlisted('x1', 'vod', '10')).toBe(true);

    expect(StorageService.toggleWatchlist(watchlist({ itemId: '10', addedAt: 3000 }))).toBe('removed');
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

  it('refuses a new entry once an account and content type hold 200, keeping every saved one', () => {
    const max = CONFIG.XTREAM.WATCHLIST_MAX_ITEMS;
    for (let i = 0; i < max; i++) {
      expect(StorageService.toggleWatchlist(watchlist({ itemId: String(i), addedAt: i }))).toBe('added');
    }
    const before = StorageService.getWatchlist('x1', 'vod');

    expect(StorageService.toggleWatchlist(watchlist({ itemId: 'new', addedAt: 10_000 }))).toBe('full');
    expect(StorageService.getWatchlist('x1', 'vod')).toEqual(before);
    expect(StorageService.isWatchlisted('x1', 'vod', 'new')).toBe(false);

    // Other scopes still accept entries.
    expect(StorageService.toggleWatchlist(watchlist({ kind: 'series', itemId: 'new' }))).toBe('added');
    expect(StorageService.toggleWatchlist(watchlist({ accountId: 'x2', itemId: 'new' }))).toBe('added');

    // Removing still works at the cap and frees one slot.
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '0' }))).toBe('removed');
    expect(StorageService.toggleWatchlist(watchlist({ itemId: 'new', addedAt: 10_000 }))).toBe('added');
    expect(StorageService.getWatchlist('x1', 'vod')).toHaveLength(max);
  });

  it('keeps an over-cap stored Watchlist intact and only refuses additions', () => {
    const max = CONFIG.XTREAM.WATCHLIST_MAX_ITEMS;
    const stored: Record<string, WatchlistEntry> = {};
    for (let i = 0; i < max + 3; i++) {
      const entry = watchlist({ itemId: String(i), addedAt: i });
      stored[`x1|vod|${i}`] = entry;
    }
    localStorage.setItem('iptv_watchlist', JSON.stringify(stored));

    expect(StorageService.toggleWatchlist(watchlist({ itemId: 'new', addedAt: 10_000 }))).toBe('full');
    expect(StorageService.getWatchlist('x1', 'vod')).toHaveLength(max + 3);
    expect(StorageService.toggleWatchlist(watchlist({ itemId: '0' }))).toBe('removed');
    expect(StorageService.getWatchlist('x1', 'vod')).toHaveLength(max + 2);
    expect(StorageService.toggleWatchlist(watchlist({ itemId: 'new', addedAt: 10_000 }))).toBe('full');
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

  it('clears one content type for one account only', () => {
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'vod' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x1', kind: 'series' }));
    StorageService.toggleWatchlist(watchlist({ accountId: 'x2', kind: 'vod' }));

    StorageService.clearWatchlist('x1', 'vod');
    expect(StorageService.getWatchlist('x1', 'vod')).toEqual([]);
    expect(StorageService.getWatchlist('x1', 'series')).toHaveLength(1);
    expect(StorageService.getWatchlist('x2', 'vod')).toHaveLength(1);

    StorageService.clearWatchlist('x1', 'series');
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

  const ids = (accountId: string, kind: 'vod' | 'episode') =>
    StorageService.getResumeList(accountId).filter(e => e.kind === kind).map(e => e.itemId);

  it('keeps the newest 50 per account and kind, evicting the oldest', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    expect(max).toBe(50);
    for (let i = 0; i < max; i++) {
      StorageService.setResume(resume({ itemId: `m${i}`, updatedAt: 1000 + i }));
      StorageService.setResume(resume({ kind: 'episode', itemId: `e${i}`, updatedAt: 1000 + i }));
    }
    StorageService.setResume(resume({ accountId: 'x2', itemId: 'm0', updatedAt: 1 }));

    StorageService.setResume(resume({ itemId: 'm-new', updatedAt: 5000 }));
    expect(ids('x1', 'vod')).toHaveLength(max);
    expect(ids('x1', 'vod')[0]).toBe('m-new');
    expect(StorageService.getResume('x1', 'vod', 'm0')).toBeNull();
    expect(StorageService.getResume('x1', 'vod', 'm1')).not.toBeNull();
    // Episodes and other accounts are separate scopes.
    expect(ids('x1', 'episode')).toHaveLength(max);
    expect(StorageService.getResume('x1', 'episode', 'e0')).not.toBeNull();
    expect(StorageService.getResume('x2', 'vod', 'm0')).not.toBeNull();
  });

  it('updates an existing entry at the cap without evicting another', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    for (let i = 0; i < max; i++) {
      StorageService.setResume(resume({ itemId: `m${i}`, updatedAt: 1000 + i }));
    }
    StorageService.setResume(resume({ itemId: 'm0', position: 200, updatedAt: 9000 }));
    expect(ids('x1', 'vod')).toHaveLength(max);
    expect(ids('x1', 'vod')[0]).toBe('m0');
    expect(StorageService.getResume('x1', 'vod', 'm1')).not.toBeNull();
  });

  it('keeps the new write when it ties the oldest timestamps', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    for (let i = 0; i < max; i++) {
      StorageService.setResume(resume({ itemId: `m${i}`, updatedAt: 1000 }));
    }
    StorageService.setResume(resume({ itemId: 'zz-new', updatedAt: 1000 }));
    expect(ids('x1', 'vod')).toHaveLength(max);
    expect(StorageService.getResume('x1', 'vod', 'zz-new')).not.toBeNull();
  });

  it('does not count a finished or too-short write toward the cap', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    for (let i = 0; i < max; i++) {
      StorageService.setResume(resume({ itemId: `m${i}`, updatedAt: 1000 + i }));
    }
    StorageService.setResume(resume({ itemId: 'short', position: 5, updatedAt: 9000 }));
    StorageService.setResume(resume({ itemId: 'done', position: 5990, duration: 6000, updatedAt: 9000 }));
    expect(ids('x1', 'vod')).toHaveLength(max);
    expect(StorageService.getResume('x1', 'vod', 'm0')).not.toBeNull();
  });

  it('trims an over-cap stored scope on the next write to it', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    const stored: Record<string, ResumeEntry> = {};
    for (let i = 0; i < max + 5; i++) {
      stored[`x1|vod|m${i}`] = resume({ itemId: `m${i}`, updatedAt: 1000 + i });
    }
    localStorage.setItem('iptv_resume', JSON.stringify(stored));
    StorageService.setResume(resume({ itemId: 'm-new', updatedAt: 9000 }));
    expect(ids('x1', 'vod')).toHaveLength(max);
    expect(StorageService.getResume('x1', 'vod', 'm5')).toBeNull();
    expect(StorageService.getResume('x1', 'vod', 'm6')).not.toBeNull();
  });

  const seedOverCap = () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    const stored: Record<string, ResumeEntry> = {};
    for (let i = 0; i < max + 3; i++) {
      stored[`x1|vod|m${i}`] = resume({ itemId: `m${i}`, updatedAt: 1000 + i });
      stored[`x1|episode|e${i}`] = resume({ kind: 'episode', itemId: `e${i}`, updatedAt: 1000 + i });
    }
    stored['x2|vod|m0'] = resume({ accountId: 'x2', itemId: 'm0', updatedAt: 1 });
    localStorage.setItem('iptv_resume', JSON.stringify(stored));
  };
  const storedResumeKeys = () =>
    Object.keys(JSON.parse(localStorage.getItem('iptv_resume') ?? '{}') as object);

  it('trims and persists an over-cap stored list on read, writing only once', () => {
    const max = CONFIG.XTREAM.RESUME_MAX_ITEMS;
    seedOverCap();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      expect(StorageService.getResumeList('x1')).toHaveLength(max * 2);
      const keys = storedResumeKeys();
      expect(keys).toHaveLength(max * 2 + 1);
      expect(keys).not.toContain('x1|vod|m2');
      expect(keys).toContain('x1|vod|m3');
      expect(keys).not.toContain('x1|episode|e2');
      expect(keys).toContain('x2|vod|m0');
      expect(setItem).toHaveBeenCalledTimes(1);

      StorageService.getResumeList('x1');
      expect(StorageService.getResume('x1', 'vod', 'm3')).not.toBeNull();
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });

  it('trims an over-cap stored list before a single-item read returns an evicted entry', () => {
    seedOverCap();
    expect(StorageService.getResume('x1', 'vod', 'm0')).toBeNull();
    expect(storedResumeKeys()).not.toContain('x1|vod|m0');
  });

  it('trims the stored list when init falls back to localStorage', async () => {
    seedOverCap();
    vi.resetModules();
    vi.doMock('./idb-database', async (importOriginal) => ({
      ...await importOriginal<typeof import('./idb-database')>(),
      openPersistenceDb: () => Promise.resolve(null),
    }));
    try {
      const { StorageService: Fallback } = await import('./storage-service');
      await Fallback.init();
      const keys = storedResumeKeys();
      expect(keys).toHaveLength(CONFIG.XTREAM.RESUME_MAX_ITEMS * 2 + 1);
      expect(keys).not.toContain('x1|vod|m0');
    } finally {
      vi.doUnmock('./idb-database');
      vi.resetModules();
    }
  });

  it('clears one account\'s resume list, optionally by kind, leaving everything else', () => {
    StorageService.setResume(resume({ itemId: '10' }));
    StorageService.setResume(resume({ kind: 'episode', itemId: '20' }));
    StorageService.setResume(resume({ accountId: 'x2', itemId: '10' }));
    StorageService.toggleWatchlist(watchlist({ itemId: '10' }));
    StorageService.touchRecentlyWatchedLive('ch1', 1000);

    StorageService.clearResumeList('x1', 'vod');
    expect(ids('x1', 'vod')).toEqual([]);
    expect(ids('x1', 'episode')).toEqual(['20']);
    expect(ids('x2', 'vod')).toEqual(['10']);

    StorageService.setResume(resume({ itemId: '11' }));
    StorageService.clearResumeList('x1');
    expect(StorageService.getResumeList('x1')).toEqual([]);
    expect(ids('x2', 'vod')).toEqual(['10']);
    expect(StorageService.isWatchlisted('x1', 'vod', '10')).toBe(true);
    expect(StorageService.getRecentlyWatchedLive().map(e => e.channelKey)).toEqual(['ch1']);
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

  it('retries after evicting the derived caches on a quota error', () => {
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

  it('migrates catchup progress keys when an EPG offset changes', () => {
    const start = baseNow - HOUR;
    StorageService.setCatchupProgress(mkEntry({
      progStart: start,
      epgSourceUrl: 'http://host/epg.xml',
    }), 7, baseNow);

    StorageService.migrateCatchupEpgOffsets(
      {},
      { 'http://host/epg.xml': 30 },
      {},
    );

    expect(StorageService.getCatchupProgress('ck1', start, baseNow)).toBeNull();
    expect(StorageService.getCatchupProgress('ck1', start + 30 * 60_000, baseNow))
      .toMatchObject({
        progEnd: baseNow + HOUR + 30 * 60_000,
        epgSourceUrl: 'http://host/epg.xml',
      });
  });

  it('migrates legacy catchup progress using its channel source', () => {
    const start = baseNow - HOUR;
    StorageService.setCatchupProgress(mkEntry({ progStart: start }), 7, baseNow);

    StorageService.migrateCatchupEpgOffsets(
      { 'http://host/epg.xml': 60 },
      {},
      { ck1: 'http://host/epg.xml' },
    );

    expect(StorageService.getCatchupProgress('ck1', start - HOUR, baseNow))
      .toMatchObject({ epgSourceUrl: 'http://host/epg.xml' });
  });

  it('migrates adjacent catchup entries without overwriting either one', () => {
    const first = baseNow - 2 * HOUR;
    const second = baseNow - HOUR;
    StorageService.setCatchupProgress(mkEntry({
      progStart: first,
      progEnd: second,
      title: 'Alpha',
      epgSourceUrl: 'http://host/epg.xml',
    }), 7, baseNow);
    StorageService.setCatchupProgress(mkEntry({
      progStart: second,
      progEnd: baseNow,
      title: 'Bravo',
      epgSourceUrl: 'http://host/epg.xml',
    }), 7, baseNow);

    StorageService.migrateCatchupEpgOffsets(
      {},
      { 'http://host/epg.xml': 60 },
      {},
    );

    expect(StorageService.getCatchupProgress('ck1', second, baseNow)?.title).toBe('Alpha');
    expect(StorageService.getCatchupProgress('ck1', baseNow, baseNow)?.title).toBe('Bravo');
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

    it('reads a legacy key without rewriting and prefers current-key progress', () => {
      const progStart = baseNow - HOUR;
      StorageService.setCatchupProgress(
        mkEntry({ channelKey: 'old', progStart, position: 60 }),
        7,
        baseNow,
      );
      expect(StorageService.getCatchupProgressList('new', baseNow, 'old')[0]?.position).toBe(60);

      StorageService.setCatchupProgress(
        mkEntry({ channelKey: 'new', progStart, position: 120 }),
        7,
        baseNow,
      );
      const list = StorageService.getCatchupProgressList('new', baseNow, 'old');
      expect(list).toHaveLength(1);
      expect(list[0].position).toBe(120);
      expect(JSON.parse(localStorage.getItem('iptv_catchup_progress') ?? '{}'))
        .toHaveProperty(`old|${progStart}`);
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

describe('StorageService channel customization store', () => {
  beforeEach(() => localStorage.clear());

  const record = () => ({
    version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
    overrides: { k1: { hidden: true, name: 'Renamed' } },
    order: ['k1', 'k2'],
    groupOrder: ['News'],
    groupOverrides: { News: { name: 'Headlines' } },
    customGroups: ['Custom'],
  });

  it('round-trips the customization record', () => {
    StorageService.setChannelCustomization(record());
    expect(StorageService.getChannelCustomization()).toEqual(record());
  });

  it('returns null by default and after a clear', () => {
    expect(StorageService.getChannelCustomization()).toBeNull();
    StorageService.setChannelCustomization(record());
    StorageService.clearChannelCustomization();
    expect(StorageService.getChannelCustomization()).toBeNull();
  });

  it('ignores a record written by another version', () => {
    StorageService.setChannelCustomization({ ...record(), version: 99 });
    expect(StorageService.getChannelCustomization()).toBeNull();
  });

  it('round-trips the last channel keys and the show-hidden toggle', () => {
    expect(StorageService.getLastChannelKey()).toBe('');
    StorageService.setLastChannelKey('k1');
    expect(StorageService.getLastChannelKey()).toBe('k1');

    expect(StorageService.getShowHiddenChannels()).toBe(false);
    StorageService.setShowHiddenChannels(true);
    expect(StorageService.getShowHiddenChannels()).toBe(true);
  });
});

describe('StorageService Live category snapshots without IndexedDB', () => {
  const snap = { knownIds: ['c1', 'c2'], announcedIds: ['c2'], counts: { c1: 3, c2: 1 } };
  const xtream = (id: string) => ({
    id, name: id, url: 'http://host/a', source: 'xtream' as const,
    xtream: { username: 'u1', password: 'p1' },
  });

  beforeEach(() => {
    localStorage.clear();
    StorageService.setPlaylists([]);
  });

  it('returns null for an account without a snapshot', () => {
    expect(StorageService.getLiveCategorySnapshot('x1')).toBeNull();
  });

  it('round-trips a copy in the session fallback and ignores an empty id', () => {
    const written = { knownIds: ['c1'], announcedIds: [], counts: { c1: 3 } };
    StorageService.setLiveCategorySnapshot('x1', written);
    StorageService.setLiveCategorySnapshot('', written);
    written.knownIds.push('c9');
    StorageService.getLiveCategorySnapshot('x1')!.knownIds.push('c8');
    expect(StorageService.getLiveCategorySnapshot('x1')).toEqual({
      knownIds: ['c1'], announcedIds: [], counts: { c1: 3 },
    });
    expect(StorageService.getLiveCategorySnapshot('')).toBeNull();
  });

  it('prunes snapshots of removed and non-Xtream accounts on setPlaylists', () => {
    StorageService.setPlaylists([xtream('x1'), xtream('x2'), xtream('x3')]);
    for (const id of ['x1', 'x2', 'x3']) StorageService.setLiveCategorySnapshot(id, snap);

    StorageService.setPlaylists([
      xtream('x1'),
      { id: 'x2', name: 'x2', url: 'http://host/a', source: 'url' },
    ]);

    expect(StorageService.getLiveCategorySnapshot('x1')).toEqual(snap);
    expect(StorageService.getLiveCategorySnapshot('x2')).toBeNull();
    expect(StorageService.getLiveCategorySnapshot('x3')).toBeNull();
  });

  it('drops the snapshot when an account is re-pointed to another server or user', () => {
    StorageService.setPlaylists([xtream('x1'), xtream('x2'), xtream('x3')]);
    for (const id of ['x1', 'x2', 'x3']) StorageService.setLiveCategorySnapshot(id, snap);
    const [a, b, c] = [xtream('x1'), xtream('x2'), xtream('x3')];

    StorageService.setPlaylists([
      { ...a, name: 'Renamed' },
      { ...b, xtream: { ...b.xtream!, username: 'other' } },
      { ...c, url: 'http://host/b' },
    ]);

    expect(StorageService.getLiveCategorySnapshot('x1')).toEqual(snap);
    expect(StorageService.getLiveCategorySnapshot('x2')).toBeNull();
    expect(StorageService.getLiveCategorySnapshot('x3')).toBeNull();
  });
});
