import { CONFIG } from '../config';
import { DEFAULT_THEME, DEFAULT_OVERLAY, DEFAULT_TEXT_SIZE, isValidTextSize, type OverlayStyle, type TextSize } from '../config/themes';
import type { AudioPref, CatchupProgressEntry, Channel, ChannelCustomization, EpgSource, PlaylistEntry, RecentlyWatchedLiveEntry, Reminder, ResumeEntry, ResumeKind, SubtitlePref, TzMode, WatchlistEntry, WatchlistKind } from '../types';
import type { OnlineSubtitleConfig, PickedOnlineSub } from './subtitle-search/types';
import { channelKey } from '../utils/channel';
import { genPlaylistId } from '../utils/playlist-id';
import { createLogger } from '../utils/logger';
import { isLocalePreference, type LocalePreference } from '../i18n';

const log = createLogger('Storage');

const PREFIX = CONFIG.STORAGE_PREFIX;

// Versioned playlist cache schema. Bump when its channel or EPG-source shape
// changes so an older payload is treated as a miss and re-fetched.
const CACHE_VERSION = 3;

interface StreamMimeEntry {
  mime: string;
  updatedAt: number;
}

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
    log.warn(`quota hit writing '${key}' — evicting playlist cache`);
    evictCache();
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      log.error(`write of '${key}' still failed after eviction — dropping`);
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
    const list = get<PlaylistEntry[]>('playlists', []);
    // A legacy entry predates the stable id; backfill one and persist so it
    // sticks (a fresh random id on every read would defeat the purpose).
    let changed = false;
    for (const pl of list) {
      if (!pl.id) { pl.id = genPlaylistId(); changed = true; }
    }
    if (changed) set('playlists', list);
    return list;
  },
  setPlaylists(playlists: PlaylistEntry[]): void {
    const previous = get<PlaylistEntry[]>('playlists', []);
    if (JSON.stringify(previous) === JSON.stringify(playlists)) return;
    if (set('playlists', playlists)) evictCache();
  },

  getStreamMime(routeKey: string): string | null {
    if (!routeKey) return null;
    const entries = get<Record<string, StreamMimeEntry>>('stream_mimes', {});
    const entry = entries[routeKey];
    if (!entry || typeof entry.mime !== 'string' || !Number.isFinite(entry.updatedAt)) return null;
    if (Date.now() - entry.updatedAt > CONFIG.PLAYER.STREAM_MIME_CACHE_TTL) {
      delete entries[routeKey];
      set('stream_mimes', entries);
      return null;
    }
    return entry.mime;
  },
  setStreamMime(routeKey: string, mime: string): void {
    if (!routeKey || !mime) return;
    const entries = get<Record<string, StreamMimeEntry>>('stream_mimes', {});
    entries[routeKey] = { mime, updatedAt: Date.now() };
    set('stream_mimes', entries);
  },

  getEpgUrl(): string {
    return get<string>('epg_url', '');
  },
  setEpgUrl(url: string): void {
    set('epg_url', url);
  },

  getReminders(): Reminder[] {
    return get<Reminder[]>('reminders', []);
  },
  setReminders(list: Reminder[]): void {
    set('reminders', list);
  },

  getLastChannel(): number {
    return get<number>('last_channel', 0);
  },
  setLastChannel(index: number): void {
    set('last_channel', index);
  },

  // Companion to last_channel: the channelKey survives a reorder or a provider
  // reshuffle, where the index does not. The index stays as the fallback for an
  // install that predates this key.
  getLastChannelKey(): string {
    return get<string>('last_channel_key', '');
  },
  setLastChannelKey(key: string): void {
    set('last_channel_key', key);
  },
  getLastChannelStreamKey(): string {
    return get<string>('last_channel_stream_key', '');
  },
  setLastChannelStreamKey(key: string): void {
    set('last_channel_stream_key', key);
  },

  getChannelCustomization(): ChannelCustomization | null {
    const data = get<ChannelCustomization | null>('channel_custom', null);
    if (!data || data.version !== CONFIG.CHANNEL_CUSTOMIZATION_VERSION) return null;
    return data;
  },
  setChannelCustomization(data: ChannelCustomization): void {
    set('channel_custom', data);
  },
  clearChannelCustomization(): void {
    remove('channel_custom');
  },

  // Reveal hidden channels in the normal lists (dimmed), for recovery.
  getShowHiddenChannels(): boolean {
    return get<boolean>('show_hidden_channels', false);
  },
  setShowHiddenChannels(val: boolean): void {
    set('show_hidden_channels', val);
  },

  getRecentlyWatchedLive(): RecentlyWatchedLiveEntry[] {
    return get<RecentlyWatchedLiveEntry[]>('recently_watched_live', [])
      .filter(entry => !!entry.channelKey && Number.isFinite(entry.updatedAt))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  touchRecentlyWatchedLive(chKey: string, now?: number): void {
    if (!chKey) return;
    const entries = this.getRecentlyWatchedLive().filter(entry => entry.channelKey !== chKey);
    entries.unshift({ channelKey: chKey, updatedAt: now ?? Date.now() });
    set('recently_watched_live', entries.slice(0, CONFIG.RECENTLY_WATCHED.MAX_LIVE_ENTRIES));
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

  getLocalePreference(): LocalePreference {
    const locale = get<unknown>('locale', 'system');
    return isLocalePreference(locale) ? locale : 'system';
  },
  setLocalePreference(locale: LocalePreference): void {
    set('locale', locale);
  },

  // Selected color theme id (see src/config/themes.ts). Default = Midnight.
  getTheme(): string {
    return get<string>('theme', DEFAULT_THEME);
  },
  setTheme(id: string): void {
    set('theme', id);
  },

  // App-wide text size (see src/config/themes.ts). Default = default (100%).
  getTextSize(): TextSize {
    const size = get<unknown>('text_size', DEFAULT_TEXT_SIZE);
    return isValidTextSize(size as string) ? (size as TextSize) : DEFAULT_TEXT_SIZE;
  },
  setTextSize(size: TextSize): void {
    set('text_size', size);
  },

  // Player overlay glass style (see src/config/themes.ts). Default = dark-glass.
  getOverlayStyle(): OverlayStyle {
    return get<OverlayStyle>('overlay_style', DEFAULT_OVERLAY);
  },
  setOverlayStyle(style: OverlayStyle): void {
    set('overlay_style', style);
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

  // Preferred subtitle per channel (keyed by channelKey). Absent = follow the
  // stream's default (forced subtitle, else off); a stored `off` keeps them off.
  getSubtitlePref(channelId: string): SubtitlePref | null {
    if (!channelId) return null;
    return get<Record<string, SubtitlePref>>('subtitle_prefs', {})[channelId] ?? null;
  },
  setSubtitlePref(channelId: string, pref: SubtitlePref): void {
    if (!channelId) return;
    const all = get<Record<string, SubtitlePref>>('subtitle_prefs', {});
    all[channelId] = pref;
    set('subtitle_prefs', all);
  },

  // Per-stream subtitle timing offset in seconds (keyed by channelPrefKey, same as the
  // subtitle pref). Absent or 0 = no shift.
  getSubtitleOffset(channelId: string): number {
    if (!channelId) return 0;
    return get<Record<string, number>>('subtitle_offsets', {})[channelId] ?? 0;
  },
  setSubtitleOffset(channelId: string, seconds: number): void {
    if (!channelId) return;
    const all = get<Record<string, number>>('subtitle_offsets', {});
    if (seconds) all[channelId] = seconds; else delete all[channelId];
    set('subtitle_offsets', all);
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

  getCachedPlaylist(): { channels: Channel[]; epgSources: EpgSource[] } | null {
    const data = get<{ version?: number; channels: Channel[]; epgSources?: EpgSource[]; timestamp: number } | null>('cached_playlist', null);
    if (!data || data.version !== CACHE_VERSION) return null;
    if (Date.now() - data.timestamp > CONFIG.PLAYLIST_REFRESH_INTERVAL) return null;
    if (!data.channels || data.channels.length === 0) return null;
    return { channels: data.channels, epgSources: data.epgSources ?? [] };
  },
  setCachedPlaylist(channels: Channel[], epgSources: EpgSource[] = []): void {
    if (!channels.length) return;
    set('cached_playlist', { version: CACHE_VERSION, channels, epgSources, timestamp: Date.now() });
  },

  // Resume points, one localStorage map keyed `${accountId}|${kind}|${itemId}`.
  getResume(accountId: string, kind: ResumeKind, itemId: string): ResumeEntry | null {
    return get<Record<string, ResumeEntry>>('resume', {})[`${accountId}|${kind}|${itemId}`] ?? null;
  },
  setResume(entry: ResumeEntry): void {
    const all = get<Record<string, ResumeEntry>>('resume', {});
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    const finished = entry.duration > 0 && entry.position >= entry.duration - CONFIG.XTREAM.RESUME_FINISH_PAD;
    if (finished || entry.position < CONFIG.XTREAM.RESUME_MIN_SECS) {
      delete all[key];
    } else {
      all[key] = entry;
    }
    set('resume', all);
  },
  getResumeList(accountId: string): ResumeEntry[] {
    const all = get<Record<string, ResumeEntry>>('resume', {});
    return Object.keys(all)
      .map((k) => all[k])
      .filter((e) => e.accountId === accountId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  clearResume(accountId: string, kind: ResumeKind, itemId: string): void {
    const all = get<Record<string, ResumeEntry>>('resume', {});
    delete all[`${accountId}|${kind}|${itemId}`];
    set('resume', all);
  },

  // Which Xtream account drives Movies / Series / Search. Null = pick the first.
  getSelectedXtreamAccountId(): string | null {
    return get<string | null>('selectedXtream', null);
  },
  setSelectedXtreamAccountId(id: string): void {
    set('selectedXtream', id);
  },

  getWatchlist(accountId: string, kind: WatchlistKind): WatchlistEntry[] {
    const all = get<Record<string, WatchlistEntry>>('watchlist', {});
    return Object.keys(all)
      .map((key) => all[key])
      .filter((entry) => entry.accountId === accountId && entry.kind === kind)
      .sort((a, b) => b.addedAt - a.addedAt);
  },
  isWatchlisted(accountId: string, kind: WatchlistKind, itemId: string): boolean {
    return this.getWatchlist(accountId, kind).some((entry) => entry.itemId === itemId);
  },
  toggleWatchlist(entry: WatchlistEntry): boolean {
    const all = get<Record<string, WatchlistEntry>>('watchlist', {});
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    if (all[key]) {
      delete all[key];
      set('watchlist', all);
      return false;
    }

    all[key] = entry;
    const scoped = Object.keys(all)
      .map((itemKey) => ({ key: itemKey, entry: all[itemKey] }))
      .filter((item) => item.entry.accountId === entry.accountId && item.entry.kind === entry.kind)
      .sort((a, b) => b.entry.addedAt - a.entry.addedAt);
    for (const item of scoped.slice(CONFIG.XTREAM.WATCHLIST_MAX_ITEMS)) delete all[item.key];
    set('watchlist', all);
    return true;
  },
  removeWatchlist(accountId: string, kind: WatchlistKind, itemId: string): void {
    const all = get<Record<string, WatchlistEntry>>('watchlist', {});
    delete all[`${accountId}|${kind}|${itemId}`];
    set('watchlist', all);
  },
  clearWatchlist(accountId: string): void {
    const all = get<Record<string, WatchlistEntry>>('watchlist', {});
    for (const key of Object.keys(all)) {
      if (all[key].accountId === accountId) delete all[key];
    }
    set('watchlist', all);
  },

  getOnlineSubtitleConfig(): OnlineSubtitleConfig {
    const s = get<Partial<OnlineSubtitleConfig>>('online_subtitles', {});
    return {
      preferredLanguage: s.preferredLanguage ?? '',
      subdl: { apiKey: s.subdl?.apiKey ?? '' },
      assrt: { apiKey: s.assrt?.apiKey ?? '' },
      opensubtitles: {
        apiKey: s.opensubtitles?.apiKey ?? '',
        username: s.opensubtitles?.username ?? '',
        password: s.opensubtitles?.password ?? '',
        token: s.opensubtitles?.token ?? '',
        tokenTs: s.opensubtitles?.tokenTs ?? 0,
      },
    };
  },
  setOnlineSubtitleConfig(cfg: OnlineSubtitleConfig): void {
    set('online_subtitles', cfg);
  },

  getPickedOnlineSub(accountId: string, kind: ResumeKind, itemId: string): PickedOnlineSub | null {
    return get<Record<string, PickedOnlineSub>>('online_sub_picks', {})[`${accountId}|${kind}|${itemId}`] ?? null;
  },
  setPickedOnlineSub(accountId: string, kind: ResumeKind, itemId: string, pick: PickedOnlineSub): void {
    const all = get<Record<string, PickedOnlineSub>>('online_sub_picks', {});
    all[`${accountId}|${kind}|${itemId}`] = pick;
    set('online_sub_picks', all);
  },

  // Catch-up progress, one entry per programme per channel.
  // Keyed `${channelKey}|${progStart}` inside a single 'catchup_progress' map.
  // Each stored blob extends CatchupProgressEntry with a pre-computed expiresAt
  // so the prune sweep never needs per-entry catchupDays.
  getCatchupProgress(chKey: string, progStart: number, now?: number): CatchupProgressEntry | null {
    const n = now ?? Date.now();
    const all = get<Record<string, CatchupProgressEntry & { expiresAt: number }>>('catchup_progress', {});
    let pruned = false;
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) { delete all[k]; pruned = true; }
    }
    if (pruned) set('catchup_progress', all);
    const stored = all[`${chKey}|${progStart}`];
    if (!stored) return null;
    const { expiresAt: _x, ...entry } = stored;
    return entry;
  },

  setCatchupProgress(entry: CatchupProgressEntry, catchupDays: number, now?: number): void {
    const n = now ?? Date.now();
    const effDays = catchupDays > 0 ? catchupDays : CONFIG.CATCHUP.FALLBACK_RETENTION_DAYS;
    const all = get<Record<string, CatchupProgressEntry & { expiresAt: number }>>('catchup_progress', {});
    // Prune expired entries on every write so the map does not grow forever.
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) delete all[k];
    }
    const key = `${entry.channelKey}|${entry.progStart}`;
    if (!entry.completed && entry.position < CONFIG.CATCHUP.RESUME_MIN_SECS) {
      delete all[key];
    } else {
      const expiresAt = entry.progEnd + effDays * 86400 * 1000;
      // Do not persist entries that are already expired at compute time (dead-on-arrival).
      if (expiresAt > n) {
        all[key] = { ...entry, expiresAt };
      } else {
        delete all[key];
      }
    }
    set('catchup_progress', all);
  },

  clearCatchupProgress(chKey: string, progStart: number): void {
    const all = get<Record<string, CatchupProgressEntry & { expiresAt: number }>>('catchup_progress', {});
    delete all[`${chKey}|${progStart}`];
    set('catchup_progress', all);
  },

  getCatchupProgressList(chKey: string, now?: number): CatchupProgressEntry[] {
    const n = now ?? Date.now();
    const all = get<Record<string, CatchupProgressEntry & { expiresAt: number }>>('catchup_progress', {});
    let pruned = false;
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) { delete all[k]; pruned = true; }
    }
    if (pruned) set('catchup_progress', all);
    const prefix = `${chKey}|`;
    const result: CatchupProgressEntry[] = [];
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) {
        const { expiresAt: _x, ...entry } = all[k];
        result.push(entry);
      }
    }
    return result;
  },

  getAllCatchupProgress(now?: number): CatchupProgressEntry[] {
    const n = now ?? Date.now();
    const all = get<Record<string, CatchupProgressEntry & { expiresAt: number }>>('catchup_progress', {});
    let pruned = false;
    const result: CatchupProgressEntry[] = [];
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) {
        delete all[k];
        pruned = true;
        continue;
      }
      const { expiresAt: _x, ...entry } = all[k];
      result.push(entry);
    }
    if (pruned) set('catchup_progress', all);
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  clearRecentlyWatched(): void {
    remove('recently_watched_live');
    remove('catchup_progress');
  },

};
