import { CONFIG } from '../config';
import type { AudioPref, Channel, PlaylistEntry, TzMode } from '../types';
import { channelKey } from '../utils/channel';

const PREFIX = CONFIG.STORAGE_PREFIX;

function get<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function set(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    evictCache();
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}

function remove(key: string): void {
  localStorage.removeItem(PREFIX + key);
}

function evictCache(): void {
  remove('cached_playlist');
}

export const StorageService = {
  get,
  set,
  remove,

  getPlaylists(): PlaylistEntry[] {
    return get<PlaylistEntry[]>('playlists', []);
  },
  setPlaylists(playlists: PlaylistEntry[]): void {
    set('playlists', playlists);
  },

  getEpgUrl(): string {
    return get<string>('epg_url', '');
  },
  setEpgUrl(url: string): void {
    set('epg_url', url);
  },

  getLastChannel(): number {
    return get<number>('last_channel', 0);
  },
  setLastChannel(index: number): void {
    set('last_channel', index);
  },

  getFavorites(): string[] {
    return get<string[]>('favorites', []);
  },
  setFavorites(favs: string[]): void {
    set('favorites', favs);
  },

  toggleFavorite(channelId: string): boolean {
    const favs = this.getFavorites();
    const idx = favs.indexOf(channelId);
    if (idx >= 0) {
      favs.splice(idx, 1);
    } else {
      favs.push(channelId);
    }
    this.setFavorites(favs);
    return idx < 0; // true = added
  },

  // Favorites were originally keyed by `id || name`; re-key them once to the
  // per-stream channelKey. Needs the loaded channels to map old keys to URLs, so
  // it no-ops (without marking done) until channels are available.
  //
  // TODO(cleanup, post-1.2.0): one-time migration. A couple of releases after the
  // one that ships it, delete this method, its two PlaylistService call sites, and
  // its tests. (The `fav_url_keyed` flag then just lingers harmlessly in storage.)
  migrateFavoriteKeys(channels: Channel[]): void {
    if (get<boolean>('fav_url_keyed', false)) return;
    if (!channels.length) return;
    const old = new Set(this.getFavorites());
    if (old.size) {
      const migrated = channels
        .filter(ch => old.has(ch.id || ch.name))
        .map(ch => channelKey(ch));
      this.setFavorites([...new Set(migrated)]);
    }
    set('fav_url_keyed', true);
  },

  getAutoPlay(): boolean {
    return get<boolean>('auto_play', false);
  },
  setAutoPlay(val: boolean): void {
    set('auto_play', val);
  },

  // Preferred audio track per channel (keyed by channelKey). Absent = follow the stream's default.
  getAudioPref(channelId: string): AudioPref | null {
    if (!channelId) return null;
    return get<Record<string, AudioPref>>('audio_prefs', {})[channelId] ?? null;
  },
  setAudioPref(channelId: string, pref: AudioPref): void {
    if (!channelId) return;
    const all = get<Record<string, AudioPref>>('audio_prefs', {});
    all[channelId] = pref;
    set('audio_prefs', all);
  },

  // 'device' = the device's timezone (default), 'feed' = the EPG feed's timezone.
  getTzMode(): TzMode {
    return get<TzMode>('tz_mode', 'device');
  },
  setTzMode(mode: TzMode): void {
    set('tz_mode', mode);
  },

  // Last-known feed UTC offset (minutes), captured from the EPG feed so
  // feed-time display works before the EPG has reloaded.
  getEpgTzOffset(): number | null {
    return get<number | null>('epg_tz_offset', null);
  },
  setEpgTzOffset(min: number): void {
    set('epg_tz_offset', min);
  },

  getCachedPlaylist(): { channels: Channel[]; epgUrls: string[] } | null {
    const data = get<{ channels: Channel[]; epgUrls?: string[]; timestamp: number } | null>('cached_playlist', null);
    if (!data || Date.now() - data.timestamp > CONFIG.PLAYLIST_REFRESH_INTERVAL) return null;
    if (!data.channels || data.channels.length === 0) return null;
    return { channels: data.channels, epgUrls: data.epgUrls ?? [] };
  },
  setCachedPlaylist(channels: Channel[], epgUrls: string[] = []): void {
    if (!channels.length) return;
    set('cached_playlist', { channels, epgUrls, timestamp: Date.now() });
  },

};
