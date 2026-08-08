import { CONFIG } from '../config';
import { DEFAULT_THEME, DEFAULT_OVERLAY, DEFAULT_TEXT_SIZE, isValidTextSize, type OverlayStyle, type TextSize } from '../config/themes';
import type { AudioPref, CatchupProgressEntry, Channel, ChannelCustomization, PlaylistEntry, RecentlyWatchedLiveEntry, Reminder, ResumeEntry, ResumeKind, SubtitlePref, TzMode, WatchlistEntry, WatchlistKind } from '../types';
import type { OnlineSubtitleConfig, PickedOnlineSub } from './subtitle-search/types';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { genPlaylistId } from '../utils/playlist-id';
import { createLogger } from '../utils/logger';
import { isLocalePreference, type LocalePreference } from '../i18n';
import {
  clearCachedPlaylist,
  clearCachedStreamMimes,
  migrateLegacyStreamMimeCache,
} from './idb-cache';
import { openPersistenceDb } from './idb-database';
import {
  applyUserChanges,
  clearAllUserData,
  flushUserDataWrites,
  loadMigrationMarkers,
  loadUserRecords,
  migrateUserRecordSets,
  replaceAllUserData,
  type UserDataRecord,
} from './idb-user-data';

const log = createLogger('StorageService');

const PREFIX = CONFIG.STORAGE_PREFIX;

type StoredCatchup = CatchupProgressEntry & { expiresAt: number };

interface UserDataState {
  favorites: string[];
  reminders: Reminder[];
  channelCustomization: ChannelCustomization | null;
  audioPrefs: Record<string, AudioPref>;
  subtitlePrefs: Record<string, SubtitlePref>;
  subtitleOffsets: Record<string, number>;
  resume: Record<string, ResumeEntry>;
  watchlist: Record<string, WatchlistEntry>;
  onlineSubPicks: Record<string, PickedOnlineSub>;
  catchupProgress: Record<string, StoredCatchup>;
  recentlyWatchedLive: RecentlyWatchedLiveEntry[];
}

let userData: UserDataState | null = null;
let userDataInitPromise: Promise<void> | null = null;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(key: string, value: unknown, extra: Partial<UserDataRecord> = {}): UserDataRecord {
  return { key, value, ...extra };
}

function persistUserChanges(
  store: Parameters<typeof applyUserChanges>[0],
  puts: UserDataRecord[],
  deletes: string[] = [],
): void {
  void applyUserChanges(store, puts, deletes).catch((err) => {
    log.error(
      'User data persistence failed',
      'event=persistence.user.write.failed',
      'operation=write',
      `store=${store}`,
      err,
    );
  });
}

function reminderKey(item: Reminder): string {
  return `reminder:${item.channelKey}|${item.startMs}`;
}

function resumeKey(entry: Pick<ResumeEntry, 'accountId' | 'kind' | 'itemId'>): string {
  return `resume:${entry.accountId}|${entry.kind}|${entry.itemId}`;
}

function watchlistKey(entry: Pick<WatchlistEntry, 'accountId' | 'kind' | 'itemId'>): string {
  return `watch:${entry.accountId}|${entry.kind}|${entry.itemId}`;
}

function catchupKey(entry: Pick<CatchupProgressEntry, 'channelKey' | 'progStart'>): string {
  return `catchup:${entry.channelKey}|${entry.progStart}`;
}

function pickedSubKey(accountId: string, kind: ResumeKind, itemId: string): string {
  return `pick:${accountId}|${kind}|${itemId}`;
}

function customizationRecords(data: ChannelCustomization): UserDataRecord[] {
  const records: UserDataRecord[] = [
    record('custom:meta', {
      version: data.version,
      order: data.order,
      groupOrder: data.groupOrder,
      customGroups: data.customGroups,
    }),
  ];
  for (const key of Object.keys(data.overrides)) {
    records.push(record(`custom:channel:${key}`, data.overrides[key]));
  }

  for (const key of Object.keys(data.groupOverrides)) {
    records.push(record(`custom:group:${key}`, data.groupOverrides[key]));
  }
  return records;
}

function allUserRecords(data: UserDataState): Parameters<typeof replaceAllUserData>[0] {
  return {
    favorites: data.favorites.map(item => record(`favorite:${item}`, item)),
    reminders: data.reminders.map(item =>
      record(reminderKey(item), item, { updatedAt: item.startMs })),
    'channel-state': [
      ...(data.channelCustomization ? customizationRecords(data.channelCustomization) : []),
      ...Object.keys(data.audioPrefs)
        .map(key => record(`audio:${key}`, data.audioPrefs[key])),
      ...Object.keys(data.subtitlePrefs)
        .map(key => record(`subtitle:${key}`, data.subtitlePrefs[key])),
      ...Object.keys(data.subtitleOffsets)
        .map(key => record(`offset:${key}`, data.subtitleOffsets[key])),
    ],
    watchlist: Object.keys(data.watchlist).map(key => {
      const entry = data.watchlist[key];
      return record(watchlistKey(entry), entry, {
        scope: `${entry.accountId}|${entry.kind}`,
        updatedAt: entry.addedAt,
      });
    }),
    'playback-progress': [
      ...Object.keys(data.resume).map(key => {
        const entry = data.resume[key];
        return record(resumeKey(entry), entry, { updatedAt: entry.updatedAt });
      }),
      ...Object.keys(data.catchupProgress).map(key => {
        const entry = data.catchupProgress[key];
        return record(catchupKey(entry), entry, {
          updatedAt: entry.updatedAt,
          expiresAt: entry.expiresAt,
        });
      }),
    ],
    'recently-watched': data.recentlyWatchedLive.map(entry =>
      record(`live:${entry.channelKey}`, entry, { updatedAt: entry.updatedAt })),
    'online-sub-picks': Object.keys(data.onlineSubPicks)
      .map(key => record(`pick:${key}`, data.onlineSubPicks[key])),
  };
}

function syncUserRecords(
  store: Parameters<typeof applyUserChanges>[0],
  previous: UserDataRecord[],
  next: UserDataRecord[],
): void {
  const nextKeys = new Set(next.map(item => item.key));
  persistUserChanges(
    store,
    next,
    previous.filter(item => !nextKeys.has(item.key)).map(item => item.key),
  );
}

// TODO: Remove this localStorage migration path once all supported installs use IndexedDB v4.
function legacyRecords(key: string, value: unknown): {
  store: Parameters<typeof applyUserChanges>[0];
  records: UserDataRecord[];
  replacePrefix: string | null;
} {
  switch (key) {
    case 'favorites':
      return {
        store: 'favorites',
        records: (value as string[]).map(item => record(`favorite:${item}`, item)),
        replacePrefix: null,
      };
    case 'reminders':
      return {
        store: 'reminders',
        records: (value as Reminder[]).map(item =>
          record(reminderKey(item), item, { updatedAt: item.startMs })),
        replacePrefix: null,
      };
    case 'channel_custom':
      return {
        store: 'channel-state',
        records: value ? customizationRecords(value as ChannelCustomization) : [],
        replacePrefix: 'custom:',
      };
    case 'audio_prefs':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, AudioPref>)
          .map(item => record(`audio:${item}`, (value as Record<string, AudioPref>)[item])),
        replacePrefix: 'audio:',
      };
    case 'subtitle_prefs':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, SubtitlePref>)
          .map(item => record(`subtitle:${item}`, (value as Record<string, SubtitlePref>)[item])),
        replacePrefix: 'subtitle:',
      };
    case 'subtitle_offsets':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, number>)
          .map(item => record(`offset:${item}`, (value as Record<string, number>)[item])),
        replacePrefix: 'offset:',
      };
    case 'resume':
      return {
        store: 'playback-progress',
        records: Object.keys(value as Record<string, ResumeEntry>).map(item => {
          const entry = (value as Record<string, ResumeEntry>)[item];
          return record(resumeKey(entry), entry, { updatedAt: entry.updatedAt });
        }),
        replacePrefix: 'resume:',
      };
    case 'watchlist':
      return {
        store: 'watchlist',
        records: Object.keys(value as Record<string, WatchlistEntry>).map(item => {
          const entry = (value as Record<string, WatchlistEntry>)[item];
          return record(watchlistKey(entry), entry, {
            scope: `${entry.accountId}|${entry.kind}`,
            updatedAt: entry.addedAt,
          });
        }),
        replacePrefix: null,
      };
    case 'online_sub_picks': {
      const entries = value as Record<string, PickedOnlineSub>;
      return {
        store: 'online-sub-picks',
        records: Object.keys(entries).map(item => record(`pick:${item}`, entries[item])),
        replacePrefix: null,
      };
    }
    case 'catchup_progress': {
      const entries = value as Record<string, StoredCatchup>;
      return {
        store: 'playback-progress',
        records: Object.keys(entries).map(item => {
          const entry = entries[item];
          return record(catchupKey(entry), entry, {
            updatedAt: entry.updatedAt,
            expiresAt: entry.expiresAt,
          });
        }),
        replacePrefix: 'catchup:',
      };
    }
    case 'recently_watched_live':
      return {
        store: 'recently-watched',
        records: (value as RecentlyWatchedLiveEntry[]).map(item =>
          record(`live:${item.channelKey}`, item, { updatedAt: item.updatedAt })),
        replacePrefix: null,
      };
    default:
      throw new Error(`Unsupported legacy user-data key: ${key}`);
  }
}

async function loadUserDataState(): Promise<UserDataState> {
  const [
    favorites,
    reminders,
    channelState,
    watchlist,
    progress,
    recentlyWatched,
    onlineSubPicks,
  ] = await Promise.all([
    loadUserRecords<string>('favorites'),
    loadUserRecords<Reminder>('reminders'),
    loadUserRecords('channel-state'),
    loadUserRecords<WatchlistEntry>('watchlist'),
    loadUserRecords<ResumeEntry | StoredCatchup>('playback-progress'),
    loadUserRecords<RecentlyWatchedLiveEntry>('recently-watched'),
    loadUserRecords<PickedOnlineSub>('online-sub-picks'),
  ]);

  const data: UserDataState = {
    favorites: favorites.map(item => item.value),
    reminders: reminders.map(item => item.value),
    channelCustomization: null,
    audioPrefs: {},
    subtitlePrefs: {},
    subtitleOffsets: {},
    resume: {},
    watchlist: {},
    onlineSubPicks: {},
    catchupProgress: {},
    recentlyWatchedLive: recentlyWatched.map(item => item.value),
  };

  const customMeta = channelState.find(item => item.key === 'custom:meta')?.value as
    Omit<ChannelCustomization, 'overrides' | 'groupOverrides'> | undefined;
  if (customMeta) {
    data.channelCustomization = {
      ...customMeta,
      overrides: {},
      groupOverrides: {},
    };
  }
  for (const item of channelState) {
    if (item.key.startsWith('audio:')) {
      data.audioPrefs[item.key.slice(6)] = item.value as AudioPref;
    } else if (item.key.startsWith('subtitle:')) {
      data.subtitlePrefs[item.key.slice(9)] = item.value as SubtitlePref;
    } else if (item.key.startsWith('offset:')) {
      data.subtitleOffsets[item.key.slice(7)] = item.value as number;
    } else if (item.key.startsWith('custom:channel:') && data.channelCustomization) {
      data.channelCustomization.overrides[item.key.slice(15)] =
        item.value as ChannelCustomization['overrides'][string];
    } else if (item.key.startsWith('custom:group:') && data.channelCustomization) {
      data.channelCustomization.groupOverrides[item.key.slice(13)] =
        item.value as ChannelCustomization['groupOverrides'][string];
    }
  }
  for (const item of watchlist) {
    const entry = item.value;
    data.watchlist[`${entry.accountId}|${entry.kind}|${entry.itemId}`] = entry;
  }
  for (const item of progress) {
    if (item.key.startsWith('resume:')) {
      const entry = item.value as ResumeEntry;
      data.resume[`${entry.accountId}|${entry.kind}|${entry.itemId}`] = entry;
    } else if (item.key.startsWith('catchup:')) {
      const entry = item.value as StoredCatchup;
      data.catchupProgress[`${entry.channelKey}|${entry.progStart}`] = entry;
    }
  }
  for (const item of onlineSubPicks) {
    data.onlineSubPicks[item.key.slice(5)] = item.value;
  }
  return data;
}

async function initUserData(): Promise<void> {
  if (!await openPersistenceDb()) throw new Error('IndexedDB unavailable');
  // TODO: Remove this legacy migration block once all supported installs use IndexedDB v4.
  const migrations: [string, unknown][] = [
    ['favorites', []],
    ['reminders', []],
    ['channel_custom', null],
    ['audio_prefs', {}],
    ['subtitle_prefs', {}],
    ['subtitle_offsets', {}],
    ['resume', {}],
    ['watchlist', {}],
    ['online_sub_picks', {}],
    ['catchup_progress', {}],
    ['recently_watched_live', []],
  ];
  const pending = [];
  const migratedKeys = await loadMigrationMarkers();
  for (let index = 0; index < migrations.length; index++) {
    const [key, defaultValue] = migrations[index];
    const legacyExists = localStorage.getItem(PREFIX + key) !== null;
    const migrated = migratedKeys.has(key);
    if (migrated && !legacyExists) continue;
    const destination = legacyRecords(key, get<unknown>(key, defaultValue));
    pending.push({
      legacyKey: key,
      storeName: destination.store,
      records: destination.records,
      replacePrefix: destination.replacePrefix,
      // A post-migration fallback has no complete baseline, so it may add/update but not delete.
      replaceExisting: !migrated,
    });
  }
  await migrateUserRecordSets(pending);
  const loadedUserData = await loadUserDataState();
  for (const [key] of migrations) remove(key);
  userData = loadedUserData;
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
    log.warn(
      `Quota hit writing '${key}'; evicting derived caches`,
      'event=persistence.local.quota',
      'operation=write',
      `key=${key}`,
    );
    evictCache();
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      log.error(
        `Write of '${key}' still failed after eviction`,
        'event=persistence.local.write.failed',
        'reason=quota_retry_failed',
        `key=${key}`,
      );
      return false;
    }
  }
}

function remove(key: string): void {
  localStorage.removeItem(PREFIX + key);
}

// Derived caches, dropped together: both are re-derivable from the playlist
// config, and a config edit can change what a provider serves — an account that
// switches live output keeps its stream route but changes container, so a probed
// MIME from the previous format must not decide how the new one is played.
function evictCache(): void {
  remove('cached_playlist');
  remove('stream_mimes');
  void clearCachedPlaylist().catch(err => log.warn(
    'Playlist cache eviction failed',
    'event=persistence.cache.eviction.failed',
    'operation=evict',
    'category=playlist',
    'trigger=local_quota',
    err,
  ));
  void clearCachedStreamMimes().catch(err => log.warn(
    'Stream MIME cache eviction failed',
    'event=persistence.cache.eviction.failed',
    'operation=evict',
    'category=catalog',
    'trigger=playlist_change',
    err,
  ));
}

export const StorageService = {
  get,
  set,
  remove,

  async init(): Promise<void> {
    if (!userDataInitPromise) {
      userDataInitPromise = initUserData()
        .then(() => log.info(
          'User data initialized',
          'event=persistence.user.init.completed',
          'operation=init',
        ))
        .catch((err) => {
          userDataInitPromise = null;
          log.error(
            'User data initialization failed; using localStorage fallback',
            'event=persistence.user.init.failed',
            'operation=init',
            err,
          );
        });
    }
    await userDataInitPromise;
    await migrateLegacyStreamMimeCache();
  },

  clearAll(): void {
    localStorage.clear();
  },

  async clearUserData(): Promise<void> {
    await clearAllUserData();
    userData = null;
    userDataInitPromise = null;
  },

  async flush(): Promise<void> {
    try {
      await flushUserDataWrites();
    } catch (initialError) {
      if (!userData) throw initialError;
      log.warn(
        'Retrying user data flush from the in-memory snapshot',
        'event=persistence.user.flush.retry',
        'operation=flush',
      );
      await replaceAllUserData(allUserRecords(userData));
      await flushUserDataWrites();
      log.info(
        'User data flush recovered from the in-memory snapshot',
        'event=persistence.user.flush.recovered',
        'operation=flush',
      );
    }
  },

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

  getEpgUrl(): string {
    return get<string>('epg_url', '');
  },
  setEpgUrl(url: string): void {
    set('epg_url', url);
  },

  getReminders(): Reminder[] {
    return userData ? cloneValue(userData.reminders) : get<Reminder[]>('reminders', []);
  },
  setReminders(list: Reminder[]): void {
    if (!userData) {
      set('reminders', list);
      return;
    }
    const previous = userData.reminders.map(item =>
      record(reminderKey(item), item, { updatedAt: item.startMs }));
    userData.reminders = cloneValue(list);
    const next = userData.reminders.map(item =>
      record(reminderKey(item), item, { updatedAt: item.startMs }));
    syncUserRecords('reminders', previous, next);
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
  getChannelCustomization(): ChannelCustomization | null {
    const data = userData
      ? cloneValue(userData.channelCustomization)
      : get<ChannelCustomization | null>('channel_custom', null);
    if (!data || data.version !== CONFIG.CHANNEL_CUSTOMIZATION_VERSION) return null;
    return data;
  },
  setChannelCustomization(data: ChannelCustomization): void {
    if (!userData) {
      set('channel_custom', data);
      return;
    }
    const previous = userData.channelCustomization
      ? customizationRecords(userData.channelCustomization)
      : [];
    userData.channelCustomization = cloneValue(data);
    syncUserRecords('channel-state', previous, customizationRecords(data));
  },
  clearChannelCustomization(): void {
    if (!userData) {
      remove('channel_custom');
      return;
    }
    const previous = userData.channelCustomization
      ? customizationRecords(userData.channelCustomization)
      : [];
    userData.channelCustomization = null;
    persistUserChanges('channel-state', [], previous.map(item => item.key));
  },

  // Reveal hidden channels in the normal lists (dimmed), for recovery.
  getShowHiddenChannels(): boolean {
    return get<boolean>('show_hidden_channels', false);
  },
  setShowHiddenChannels(val: boolean): void {
    set('show_hidden_channels', val);
  },

  getRecentlyWatchedLive(): RecentlyWatchedLiveEntry[] {
    const entries = userData
      ? cloneValue(userData.recentlyWatchedLive)
      : get<RecentlyWatchedLiveEntry[]>('recently_watched_live', []);
    return entries
      .filter(entry => !!entry.channelKey && Number.isFinite(entry.updatedAt))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  touchRecentlyWatchedLive(chKey: string, now?: number): void {
    if (!chKey) return;
    const entries = this.getRecentlyWatchedLive().filter(entry => entry.channelKey !== chKey);
    entries.unshift({ channelKey: chKey, updatedAt: now ?? Date.now() });
    const next = entries.slice(0, CONFIG.RECENTLY_WATCHED.MAX_LIVE_ENTRIES);
    if (!userData) {
      set('recently_watched_live', next);
      return;
    }
    const previousKeys = new Set(userData.recentlyWatchedLive.map(entry => `live:${entry.channelKey}`));
    userData.recentlyWatchedLive = cloneValue(next);
    const puts = next.map(entry =>
      record(`live:${entry.channelKey}`, entry, { updatedAt: entry.updatedAt }));
    const nextKeys = new Set(puts.map(item => item.key));
    persistUserChanges(
      'recently-watched',
      puts,
      [...previousKeys].filter(key => !nextKeys.has(key)),
    );
  },

  getFavorites(): string[] {
    return userData ? userData.favorites.slice() : get<string[]>('favorites', []);
  },
  setFavorites(favs: string[]): boolean {
    if (!userData) return set('favorites', favs);
    const unique = [...new Set(favs)];
    const previousKeys = new Set(userData.favorites.map(item => `favorite:${item}`));
    userData.favorites = unique;
    const puts = unique.map(item => record(`favorite:${item}`, item));
    const nextKeys = new Set(puts.map(item => item.key));
    persistUserChanges('favorites', puts, [...previousKeys].filter(key => !nextKeys.has(key)));
    return true;
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

  // Favorites have used both `id || name` and the query-stripped channelKey.
  // Re-key every match so migration never silently discards a saved favorite.
  // TODO(cleanup, post-1.9.0): after a couple of releases, remove this method,
  // its PlaylistService call sites, and its tests; the flags can remain inert.
  migrateFavoriteKeys(channels: Channel[]): void {
    if (get<boolean>('fav_stream_keyed', false)) return;
    if (!channels.length) return;
    const urlKeyed = get<boolean>('fav_url_keyed', false);
    const migrated: string[] = [];
    for (const oldKey of new Set(this.getFavorites())) {
      if (channels.some(ch => channelKey(ch) === oldKey)) {
        migrated.push(oldKey);
        continue;
      }
      const matches = channels.filter(ch =>
        urlKeyed ? legacyChannelKey(ch) === oldKey : (ch.id || ch.name) === oldKey);
      migrated.push(...matches.map(channelKey));
    }
    if (!this.setFavorites([...new Set(migrated)])) return;
    if (!set('fav_url_keyed', true)) return;
    set('fav_stream_keyed', true);
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
  getAudioPref(channelId: string, legacyChannelId = ''): AudioPref | null {
    if (!channelId) return null;
    const all = userData ? userData.audioPrefs : get<Record<string, AudioPref>>('audio_prefs', {});
    const pref = all[channelId] ?? all[legacyChannelId] ?? null;
    return pref ? cloneValue(pref) : null;
  },
  setAudioPref(channelId: string, pref: AudioPref): void {
    if (!channelId) return;
    if (userData) {
      userData.audioPrefs[channelId] = cloneValue(pref);
      persistUserChanges('channel-state', [record(`audio:${channelId}`, pref)]);
      return;
    }
    const all = get<Record<string, AudioPref>>('audio_prefs', {});
    all[channelId] = pref;
    set('audio_prefs', all);
  },

  // Preferred subtitle per channel (keyed by channelKey). Absent = follow the
  // stream's default (forced subtitle, else off); a stored `off` keeps them off.
  getSubtitlePref(channelId: string, legacyChannelId = ''): SubtitlePref | null {
    if (!channelId) return null;
    const all = userData
      ? userData.subtitlePrefs
      : get<Record<string, SubtitlePref>>('subtitle_prefs', {});
    const pref = all[channelId] ?? all[legacyChannelId] ?? null;
    return pref ? cloneValue(pref) : null;
  },
  setSubtitlePref(channelId: string, pref: SubtitlePref): void {
    if (!channelId) return;
    if (userData) {
      userData.subtitlePrefs[channelId] = cloneValue(pref);
      persistUserChanges('channel-state', [record(`subtitle:${channelId}`, pref)]);
      return;
    }
    const all = get<Record<string, SubtitlePref>>('subtitle_prefs', {});
    all[channelId] = pref;
    set('subtitle_prefs', all);
  },

  // Per-stream subtitle timing offset in seconds (keyed by channelPrefKey, same as the
  // subtitle pref). Absent or 0 = no shift.
  getSubtitleOffset(channelId: string, legacyChannelId = ''): number {
    if (!channelId) return 0;
    const all = userData
      ? userData.subtitleOffsets
      : get<Record<string, number>>('subtitle_offsets', {});
    return all[channelId] ?? all[legacyChannelId] ?? 0;
  },
  setSubtitleOffset(channelId: string, seconds: number): void {
    if (!channelId) return;
    if (userData) {
      if (seconds) {
        userData.subtitleOffsets[channelId] = seconds;
        persistUserChanges('channel-state', [record(`offset:${channelId}`, seconds)]);
      } else {
        delete userData.subtitleOffsets[channelId];
        persistUserChanges('channel-state', [], [`offset:${channelId}`]);
      }
      return;
    }
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

  // Resume points keyed `${accountId}|${kind}|${itemId}`.
  getResume(accountId: string, kind: ResumeKind, itemId: string): ResumeEntry | null {
    const all = userData ? userData.resume : get<Record<string, ResumeEntry>>('resume', {});
    const entry = all[`${accountId}|${kind}|${itemId}`] ?? null;
    return entry ? cloneValue(entry) : null;
  },
  setResume(entry: ResumeEntry): void {
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    const finished = entry.duration > 0 && entry.position >= entry.duration - CONFIG.XTREAM.RESUME_FINISH_PAD;
    if (userData) {
      if (finished || entry.position < CONFIG.XTREAM.RESUME_MIN_SECS) {
        delete userData.resume[key];
        persistUserChanges('playback-progress', [], [resumeKey(entry)]);
      } else {
        userData.resume[key] = cloneValue(entry);
        persistUserChanges('playback-progress', [
          record(resumeKey(entry), entry, { updatedAt: entry.updatedAt }),
        ]);
      }
      return;
    }
    const all = get<Record<string, ResumeEntry>>('resume', {});
    if (finished || entry.position < CONFIG.XTREAM.RESUME_MIN_SECS) {
      delete all[key];
    } else {
      all[key] = cloneValue(entry);
    }
    set('resume', all);
  },
  getResumeList(accountId: string): ResumeEntry[] {
    const all = userData ? userData.resume : get<Record<string, ResumeEntry>>('resume', {});
    return Object.keys(all)
      .map((k) => all[k])
      .filter((e) => e.accountId === accountId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneValue);
  },
  clearResume(accountId: string, kind: ResumeKind, itemId: string): void {
    const key = `${accountId}|${kind}|${itemId}`;
    if (userData) {
      delete userData.resume[key];
      persistUserChanges('playback-progress', [], [
        resumeKey({ accountId, kind, itemId }),
      ]);
      return;
    }
    const all = get<Record<string, ResumeEntry>>('resume', {});
    delete all[key];
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
    const all = userData ? userData.watchlist : get<Record<string, WatchlistEntry>>('watchlist', {});
    return Object.keys(all)
      .map((key) => all[key])
      .filter((entry) => entry.accountId === accountId && entry.kind === kind)
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(cloneValue);
  },
  isWatchlisted(accountId: string, kind: WatchlistKind, itemId: string): boolean {
    return this.getWatchlist(accountId, kind).some((entry) => entry.itemId === itemId);
  },
  toggleWatchlist(entry: WatchlistEntry): boolean {
    const all = userData ? userData.watchlist : get<Record<string, WatchlistEntry>>('watchlist', {});
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    if (all[key]) {
      delete all[key];
      if (userData) persistUserChanges('watchlist', [], [watchlistKey(entry)]);
      else set('watchlist', all);
      return false;
    }

    all[key] = cloneValue(entry);
    const scoped = Object.keys(all)
      .map((itemKey) => ({ key: itemKey, entry: all[itemKey] }))
      .filter((item) => item.entry.accountId === entry.accountId && item.entry.kind === entry.kind)
      .sort((a, b) => b.entry.addedAt - a.entry.addedAt);
    const removed = scoped.slice(CONFIG.XTREAM.WATCHLIST_MAX_ITEMS);
    for (const item of removed) delete all[item.key];
    if (userData) {
      persistUserChanges(
        'watchlist',
        [record(watchlistKey(entry), entry, {
          scope: `${entry.accountId}|${entry.kind}`,
          updatedAt: entry.addedAt,
        })],
        removed.map(item => watchlistKey(item.entry)),
      );
    } else {
      set('watchlist', all);
    }
    return true;
  },
  removeWatchlist(accountId: string, kind: WatchlistKind, itemId: string): void {
    const key = `${accountId}|${kind}|${itemId}`;
    if (userData) {
      const entry = userData.watchlist[key];
      delete userData.watchlist[key];
      if (entry) persistUserChanges('watchlist', [], [watchlistKey(entry)]);
      return;
    }
    const all = get<Record<string, WatchlistEntry>>('watchlist', {});
    delete all[key];
    set('watchlist', all);
  },
  clearWatchlist(accountId: string): void {
    const all = userData ? userData.watchlist : get<Record<string, WatchlistEntry>>('watchlist', {});
    const removed: WatchlistEntry[] = [];
    for (const key of Object.keys(all)) {
      if (all[key].accountId === accountId) {
        removed.push(all[key]);
        delete all[key];
      }
    }
    if (userData) {
      persistUserChanges('watchlist', [], removed.map(watchlistKey));
    } else {
      set('watchlist', all);
    }
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
    const all = userData
      ? userData.onlineSubPicks
      : get<Record<string, PickedOnlineSub>>('online_sub_picks', {});
    const picked = all[`${accountId}|${kind}|${itemId}`] ?? null;
    return picked ? cloneValue(picked) : null;
  },
  setPickedOnlineSub(accountId: string, kind: ResumeKind, itemId: string, pick: PickedOnlineSub): void {
    if (userData) {
      userData.onlineSubPicks[`${accountId}|${kind}|${itemId}`] = cloneValue(pick);
      persistUserChanges('online-sub-picks', [
        record(pickedSubKey(accountId, kind, itemId), pick),
      ]);
      return;
    }
    const all = get<Record<string, PickedOnlineSub>>('online_sub_picks', {});
    all[`${accountId}|${kind}|${itemId}`] = pick;
    set('online_sub_picks', all);
  },

  // Catch-up progress, one entry per programme per channel. Each record carries
  // a pre-computed expiresAt so pruning never needs per-entry catchupDays.
  getCatchupProgress(
    chKey: string,
    progStart: number,
    now?: number,
    legacyChKey = '',
  ): CatchupProgressEntry | null {
    const n = now ?? Date.now();
    const all = userData
      ? userData.catchupProgress
      : get<Record<string, StoredCatchup>>('catchup_progress', {});
    const removed: StoredCatchup[] = [];
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) {
        removed.push(all[k]);
        delete all[k];
      }
    }
    if (removed.length) {
      if (userData) {
        persistUserChanges('playback-progress', [], removed.map(catchupKey));
      } else {
        set('catchup_progress', all);
      }
    }
    const stored = all[`${chKey}|${progStart}`]
      ?? (legacyChKey ? all[`${legacyChKey}|${progStart}`] : undefined);
    if (!stored) return null;
    const { expiresAt: _x, ...entry } = stored;
    return entry;
  },

  setCatchupProgress(entry: CatchupProgressEntry, catchupDays: number, now?: number): void {
    const n = now ?? Date.now();
    const effDays = catchupDays > 0 ? catchupDays : CONFIG.CATCHUP.FALLBACK_RETENTION_DAYS;
    const all = userData
      ? userData.catchupProgress
      : get<Record<string, StoredCatchup>>('catchup_progress', {});
    const removed: StoredCatchup[] = [];
    // Prune expired entries on every write so the map does not grow forever.
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) {
        removed.push(all[k]);
        delete all[k];
      }
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
    if (userData) {
      const stored = all[key];
      persistUserChanges(
        'playback-progress',
        stored ? [record(catchupKey(stored), stored, {
          updatedAt: stored.updatedAt,
          expiresAt: stored.expiresAt,
        })] : [],
        [
          ...removed.map(catchupKey),
          ...(stored ? [] : [catchupKey(entry)]),
        ],
      );
    } else {
      set('catchup_progress', all);
    }
  },

  clearCatchupProgress(chKey: string, progStart: number): void {
    const key = `${chKey}|${progStart}`;
    if (userData) {
      delete userData.catchupProgress[key];
      persistUserChanges('playback-progress', [], [
        catchupKey({ channelKey: chKey, progStart }),
      ]);
      return;
    }
    const all = get<Record<string, StoredCatchup>>('catchup_progress', {});
    delete all[key];
    set('catchup_progress', all);
  },

  getCatchupProgressList(
    chKey: string,
    now?: number,
    legacyChKey = '',
  ): CatchupProgressEntry[] {
    const n = now ?? Date.now();
    const all = userData
      ? userData.catchupProgress
      : get<Record<string, StoredCatchup>>('catchup_progress', {});
    const removed: StoredCatchup[] = [];
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) {
        removed.push(all[k]);
        delete all[k];
      }
    }
    if (removed.length) {
      if (userData) {
        persistUserChanges('playback-progress', [], removed.map(catchupKey));
      } else {
        set('catchup_progress', all);
      }
    }
    const prefixes = [`${chKey}|`];
    if (legacyChKey && legacyChKey !== chKey) prefixes.push(`${legacyChKey}|`);
    const byStart = new Map<number, CatchupProgressEntry>();
    for (const prefix of prefixes) {
      for (const k of Object.keys(all)) {
        if (k.startsWith(prefix)) {
          const { expiresAt: _x, ...entry } = all[k];
          if (!byStart.has(entry.progStart)) byStart.set(entry.progStart, entry);
        }
      }
    }
    return [...byStart.values()];
  },

  getAllCatchupProgress(now?: number): CatchupProgressEntry[] {
    const n = now ?? Date.now();
    const all = userData
      ? userData.catchupProgress
      : get<Record<string, StoredCatchup>>('catchup_progress', {});
    const removed: StoredCatchup[] = [];
    const result: CatchupProgressEntry[] = [];
    for (const k of Object.keys(all)) {
      if (all[k].expiresAt <= n) {
        removed.push(all[k]);
        delete all[k];
        continue;
      }
      const { expiresAt: _x, ...entry } = all[k];
      result.push(entry);
    }
    if (removed.length) {
      if (userData) {
        persistUserChanges('playback-progress', [], removed.map(catchupKey));
      } else {
        set('catchup_progress', all);
      }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  },

  clearRecentlyWatched(): void {
    if (!userData) {
      remove('recently_watched_live');
      remove('catchup_progress');
      return;
    }
    const recentKeys = userData.recentlyWatchedLive.map(entry => `live:${entry.channelKey}`);
    const catchupKeys = Object.keys(userData.catchupProgress)
      .map(key => catchupKey(userData!.catchupProgress[key]));
    userData.recentlyWatchedLive = [];
    userData.catchupProgress = {};
    persistUserChanges('recently-watched', [], recentKeys);
    persistUserChanges('playback-progress', [], catchupKeys);
  },

};
