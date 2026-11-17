import { CONFIG } from '../config';
import { DEFAULT_THEME, DEFAULT_OVERLAY, DEFAULT_TEXT_SIZE, isValidTextSize, type OverlayStyle, type TextSize } from '../config/themes';
import type { AudioPref, CatalogMark, CatalogMarkKind, CatchupProgressEntry, ChannelCustomization, ChannelCycleMode, HeaderPlayback, LastChannel, ManualEpgSource, ParentalControlConfig, ParentalPinThrottle, PlaylistEntry, RecentlyWatchedLiveEntry, Reminder, ResumeEntry, ResumeKind, SubtitlePref, TzMode, WatchlistEntry, WatchlistKind, XtreamLiveCategorySnapshot } from '../types';
import type { OnlineSubtitleConfig, PickedOnlineSub } from './subtitle-search/types';
import { isCatalogSort, isCatalogSortDirection, type CatalogSortPreference } from '../utils/catalog-sort';
import { normalizeXtreamBaseUrl } from '../utils/xtream-url';
import { createLogger } from '../utils/logger';
import { isLocalePreference, type LocalePreference } from '../i18n';
import { isAspectRatio, type AspectRatio } from './aspect-ratio';
import { isVideoQuality, parseOverride, serializeOverride, type QualityOverride, type VideoQuality } from '../utils/video-quality';
import {
  DEFAULT_ANIMATION_MODE,
  isAnimationMode,
  type AnimationMode,
} from './motion-service';
import {
  clearCachedPlaylist,
  clearCachedStreamMimes,
} from './idb-cache';
import { openPersistenceDb } from './idb-database';
import {
  applyUserChanges,
  clearAllUserData,
  flushUserDataWrites,
  loadAllUserRecords,
  restoreFallbackRecords,
  replaceAllUserData,
  type UserDataRecord,
} from './idb-user-data';

const log = createLogger('StorageService');

const PREFIX = CONFIG.STORAGE_PREFIX;
export const LIVE_RECONNECT_ATTEMPT_OPTIONS: readonly number[] = [0, 1, 2, 3, 4, 5];
export const NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS: readonly number[] = [1200, 1800, 2500, 3000, 3500];
export const PLAYER_OSD_TIMEOUT_MS_OPTIONS: readonly number[] = [3000, 5000, 8000, 10000, 12000];
export const REFRESH_INTERVAL_HOUR_OPTIONS: readonly number[] = [0, 1, 3, 6, 12, 24];
export const XTREAM_CATALOG_REFRESH_HOUR_OPTIONS: readonly number[] = [1, 3, 6, 12, 24];
const HOUR_MS = 60 * 60 * 1000;

export type WatchlistToggleResult = 'added' | 'removed' | 'full';

type StoredCatchup = CatchupProgressEntry & { expiresAt: number };

interface UserDataState {
  favorites: string[];
  reminders: Reminder[];
  channelCustomization: ChannelCustomization | null;
  audioPrefs: Record<string, AudioPref>;
  subtitlePrefs: Record<string, SubtitlePref>;
  subtitleOffsets: Record<string, number>;
  aspectRatios: Record<string, AspectRatio>;
  qualityPicks: Record<string, string>;
  resume: Record<string, ResumeEntry>;
  watchlist: Record<string, WatchlistEntry>;
  marks: Record<string, CatalogMark>;
  onlineSubPicks: Record<string, PickedOnlineSub>;
  catchupProgress: Record<string, StoredCatchup>;
  recentlyWatchedLive: RecentlyWatchedLiveEntry[];
  parentalControl: ParentalControlConfig | null;
  liveCategorySnapshots: Record<string, XtreamLiveCategorySnapshot>;
}

const LIVE_CATEGORY_KEY_PREFIX = 'live-categories:';
// Without IndexedDB the snapshot is session-only; losing it is harmless.
const fallbackLiveCategorySnapshots: Record<string, XtreamLiveCategorySnapshot> = {};

let userData: UserDataState | null = null;
let userDataInitPromise: Promise<void> | null = null;

// Individual writes are fire-and-forget (callers never await persistUserChanges),
// so a failure has no return value to surface — this is the only signal a caller
// (App, at init) can subscribe to in order to show something the user actually
// sees, instead of a console-only log line. Kept UI-agnostic here: this module
// only reports the transition into a failing streak, never renders anything
// itself. Fires once per streak, not once per failed write, so a run of failures
// (e.g. a dead IndexedDB connection until the next reconnect) doesn't spam it.
let writeFailing = false;
let onWriteFailure: (() => void) | null = null;
let onPlaylistsReplaced: ((previous: PlaylistEntry[], next: PlaylistEntry[]) => void) | null = null;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sanitizeManualEpgSources(value: unknown[]): ManualEpgSource[] {
  const sources: ManualEpgSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { url?: unknown; playlistIds?: unknown };
    if (typeof candidate.url !== 'string') continue;
    const url = candidate.url.trim();
    if (!url) continue;
    const playlistIds = Array.isArray(candidate.playlistIds)
      ? candidate.playlistIds.filter((id): id is string =>
          typeof id === 'string' && id !== '')
      : [];
    const existing = sources.find(source => source.url === url);
    if (!existing) {
      sources.push({ url, playlistIds: Array.from(new Set(playlistIds)) });
    } else if (!existing.playlistIds.length || !playlistIds.length) {
      existing.playlistIds = [];
    } else {
      for (const id of playlistIds) {
        if (!existing.playlistIds.includes(id)) existing.playlistIds.push(id);
      }
    }
  }
  return sources;
}

function record(key: string, value: unknown, extra: Partial<UserDataRecord> = {}): UserDataRecord {
  return { key, value, ...extra };
}

function persistUserChanges(
  store: Parameters<typeof applyUserChanges>[0],
  puts: UserDataRecord[],
  deletes: string[] = [],
): void {
  void applyUserChanges(store, puts, deletes).then(
    () => { writeFailing = false; },
    (err) => {
      log.error(
        'User data persistence failed',
        'event=persistence.user.write.failed',
        'operation=write',
        `store=${store}`,
        err,
      );
      if (!writeFailing) {
        writeFailing = true;
        onWriteFailure?.();
      }
    },
  );
}

function xtreamAccountKey(pl: PlaylistEntry): string | null {
  if (pl.source !== 'xtream' || !pl.xtream) return null;
  return `${normalizeXtreamBaseUrl(pl.url)}|${pl.xtream.username}`;
}

// Category ids belong to one account, so a removed or re-pointed account drops them.
function pruneLiveCategorySnapshots(previous: PlaylistEntry[], playlists: PlaylistEntry[]): void {
  const before = new Map<string, string | null>();
  for (const pl of previous) before.set(pl.id, xtreamAccountKey(pl));
  const keep = new Set<string>();
  for (const pl of playlists) {
    const key = xtreamAccountKey(pl);
    if (key && (!before.has(pl.id) || before.get(pl.id) === key)) keep.add(pl.id);
  }
  const all = userData ? userData.liveCategorySnapshots : fallbackLiveCategorySnapshots;
  const removed = Object.keys(all).filter(id => !keep.has(id));
  if (!removed.length) return;
  for (const id of removed) delete all[id];
  if (userData) {
    persistUserChanges('channel-state', [], removed.map(id => LIVE_CATEGORY_KEY_PREFIX + id));
  }
}

function reminderKey(item: Reminder): string {
  return `reminder:${item.channelKey}|${item.startMs}`;
}

function resumeKey(entry: Pick<ResumeEntry, 'accountId' | 'kind' | 'itemId'>): string {
  return `resume:${entry.accountId}|${entry.kind}|${entry.itemId}`;
}

// Drops the oldest entries of each over-cap account+kind scope (or only `scope`)
// from `all`; `keepKey`, the entry just written, is never the one evicted.
function trimResume(
  all: Record<string, ResumeEntry>,
  scope?: Pick<ResumeEntry, 'accountId' | 'kind'>,
  keepKey?: string,
): ResumeEntry[] {
  const scopes: Record<string, string[]> = {};
  for (const key of Object.keys(all)) {
    const entry = all[key];
    if (scope && (entry.accountId !== scope.accountId || entry.kind !== scope.kind)) continue;
    const id = `${entry.accountId}|${entry.kind}`;
    (scopes[id] = scopes[id] ?? []).push(key);
  }
  const removed: ResumeEntry[] = [];
  for (const id of Object.keys(scopes)) {
    const keys = scopes[id];
    if (keys.length <= CONFIG.XTREAM.RESUME_MAX_ITEMS) continue;
    keys.sort((a, b) => {
      if (a === keepKey) return -1;
      if (b === keepKey) return 1;
      return all[b].updatedAt - all[a].updatedAt || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const key of keys.slice(CONFIG.XTREAM.RESUME_MAX_ITEMS)) {
      removed.push(all[key]);
      delete all[key];
    }
  }
  return removed;
}

// Without IndexedDB the localStorage map is the store, so an over-cap one
// (saved before the cap existed) is trimmed and rewritten the first time it is read.
function fallbackResume(): Record<string, ResumeEntry> {
  const all = get<Record<string, ResumeEntry>>('resume', {});
  if (trimResume(all).length) set('resume', all);
  return all;
}

function markKey(entry: Pick<CatalogMark, 'accountId' | 'kind' | 'itemId'>): string {
  return `mark:${entry.accountId}|${entry.kind}|${entry.itemId}`;
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
      ...Object.keys(data.aspectRatios)
        .map(key => record(`aspect:${key}`, data.aspectRatios[key])),
      ...Object.keys(data.qualityPicks)
        .map(key => record(`quality:${key}`, data.qualityPicks[key])),
      ...Object.keys(data.liveCategorySnapshots).map(key =>
        record(LIVE_CATEGORY_KEY_PREFIX + key, data.liveCategorySnapshots[key])),
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
      ...Object.keys(data.marks).map(key =>
        record(markKey(data.marks[key]), data.marks[key], { updatedAt: data.marks[key].updatedAt })),
    ],
    'recently-watched': data.recentlyWatchedLive.map(entry =>
      record(`live:${entry.channelKey}`, entry, { updatedAt: entry.updatedAt })),
    'online-sub-picks': Object.keys(data.onlineSubPicks)
      .map(key => record(`pick:${key}`, data.onlineSubPicks[key])),
    'parental-control': data.parentalControl
      ? [record('config', data.parentalControl)]
      : [],
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

function parseLastChannel(stored: unknown): LastChannel | null {
  if (!stored || typeof stored !== 'object') return null;
  const value = stored as Record<string, unknown>;
  if (typeof value.index !== 'number' || !Number.isFinite(value.index)) return null;
  const last: LastChannel = { index: value.index };
  for (const field of ['key', 'stream', 'exact'] as const) {
    const text = value[field];
    if (typeof text === 'string' && text) last[field] = text;
  }
  return last;
}

// The records a fallback localStorage key holds.
function fallbackRecords(key: string, value: unknown): {
  store: Parameters<typeof applyUserChanges>[0];
  records: UserDataRecord[];
} {
  switch (key) {
    case 'favorites':
      return {
        store: 'favorites',
        records: (value as string[]).map(item => record(`favorite:${item}`, item)),
      };
    case 'reminders':
      return {
        store: 'reminders',
        records: (value as Reminder[]).map(item =>
          record(reminderKey(item), item, { updatedAt: item.startMs })),
      };
    case 'channel_custom':
      return {
        store: 'channel-state',
        records: value ? customizationRecords(value as ChannelCustomization) : [],
      };
    case 'audio_prefs':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, AudioPref>)
          .map(item => record(`audio:${item}`, (value as Record<string, AudioPref>)[item])),
      };
    case 'subtitle_prefs':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, SubtitlePref>)
          .map(item => record(`subtitle:${item}`, (value as Record<string, SubtitlePref>)[item])),
      };
    case 'subtitle_offsets':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, number>)
          .map(item => record(`offset:${item}`, (value as Record<string, number>)[item])),
      };
    case 'aspect_ratios':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, AspectRatio>)
          .map(item => record(`aspect:${item}`, (value as Record<string, AspectRatio>)[item])),
      };
    case 'quality_picks':
      return {
        store: 'channel-state',
        records: Object.keys(value as Record<string, string>)
          .filter(item => parseOverride((value as Record<string, string>)[item]))
          .map(item => record(`quality:${item}`, (value as Record<string, string>)[item])),
      };
    case 'resume':
      return {
        store: 'playback-progress',
        records: Object.keys(value as Record<string, ResumeEntry>).map(item => {
          const entry = (value as Record<string, ResumeEntry>)[item];
          return record(resumeKey(entry), entry, { updatedAt: entry.updatedAt });
        }),
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
      };
    case 'online_sub_picks': {
      const entries = value as Record<string, PickedOnlineSub>;
      return {
        store: 'online-sub-picks',
        records: Object.keys(entries).map(item => record(`pick:${item}`, entries[item])),
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
      };
    }
    case 'catalog_marks': {
      const marks = value as Record<string, CatalogMark>;
      return {
        store: 'playback-progress',
        records: Object.keys(marks).map(item =>
          record(markKey(marks[item]), marks[item], { updatedAt: marks[item].updatedAt })),
      };
    }
    case 'recently_watched_live':
      return {
        store: 'recently-watched',
        records: (value as RecentlyWatchedLiveEntry[]).map(item =>
          record(`live:${item.channelKey}`, item, { updatedAt: item.updatedAt })),
      };
    default:
      throw new Error(`Unsupported fallback user-data key: ${key}`);
  }
}

async function loadUserDataState(): Promise<UserDataState> {
  const records = await loadAllUserRecords();
  const favorites = records.favorites as UserDataRecord<string>[];
  const reminders = records.reminders as UserDataRecord<Reminder>[];
  const channelState = records['channel-state'];
  const watchlist = records.watchlist as UserDataRecord<WatchlistEntry>[];
  const progress = records['playback-progress'] as
    UserDataRecord<ResumeEntry | StoredCatchup>[];
  const recentlyWatched = records['recently-watched'] as
    UserDataRecord<RecentlyWatchedLiveEntry>[];
  const onlineSubPicks = records['online-sub-picks'] as
    UserDataRecord<PickedOnlineSub>[];
  const parentalControl = records['parental-control'] as
    UserDataRecord<ParentalControlConfig>[];

  const data: UserDataState = {
    favorites: favorites.map(item => item.value),
    reminders: reminders.map(item => item.value),
    channelCustomization: null,
    audioPrefs: {},
    subtitlePrefs: {},
    subtitleOffsets: {},
    aspectRatios: {},
    qualityPicks: {},
    resume: {},
    watchlist: {},
    marks: {},
    onlineSubPicks: {},
    catchupProgress: {},
    recentlyWatchedLive: recentlyWatched.map(item => item.value),
    parentalControl: parentalControl.find(item => item.key === 'config')?.value ?? null,
    liveCategorySnapshots: {},
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
    } else if (item.key.startsWith(LIVE_CATEGORY_KEY_PREFIX)) {
      data.liveCategorySnapshots[item.key.slice(LIVE_CATEGORY_KEY_PREFIX.length)] =
        item.value as XtreamLiveCategorySnapshot;
    } else if (item.key.startsWith('offset:')) {
      data.subtitleOffsets[item.key.slice(7)] = item.value as number;
    } else if (item.key.startsWith('aspect:')) {
      if (isAspectRatio(item.value)) data.aspectRatios[item.key.slice(7)] = item.value;
    } else if (item.key.startsWith('quality:')) {
      if (parseOverride(item.value)) data.qualityPicks[item.key.slice(8)] = item.value as string;
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
    } else if (item.key.startsWith('mark:')) {
      data.marks[item.key.slice(5)] = item.value as CatalogMark;
    }
  }
  for (const item of onlineSubPicks) {
    data.onlineSubPicks[item.key.slice(5)] = item.value;
  }
  return data;
}

async function initUserData(): Promise<void> {
  if (!await openPersistenceDb()) throw new Error('IndexedDB unavailable');
  // Keys user data falls back to while IndexedDB is unavailable.
  const fallbackKeys: [string, unknown][] = [
    ['favorites', []],
    ['reminders', []],
    ['channel_custom', null],
    ['audio_prefs', {}],
    ['subtitle_prefs', {}],
    ['subtitle_offsets', {}],
    ['aspect_ratios', {}],
    ['quality_picks', {}],
    ['resume', {}],
    ['watchlist', {}],
    ['online_sub_picks', {}],
    ['catchup_progress', {}],
    ['recently_watched_live', []],
    ['catalog_marks', {}],
  ];
  const pending = [];
  for (let index = 0; index < fallbackKeys.length; index++) {
    const [key, defaultValue] = fallbackKeys[index];
    if (localStorage.getItem(PREFIX + key) === null) continue;
    const destination = fallbackRecords(key, get<unknown>(key, defaultValue));
    pending.push({ key, storeName: destination.store, records: destination.records });
  }
  // A config saved while IndexedDB was unavailable is newer than the stored one.
  const fallbackParental = localStorage.getItem(PREFIX + 'parental_control') !== null
    ? get<ParentalControlConfig | null>('parental_control', null)
    : null;
  if (fallbackParental) {
    pending.push({
      key: 'parental_control',
      storeName: 'parental-control' as const,
      records: [record('config', fallbackParental)],
    });
  }
  await restoreFallbackRecords(pending);
  const loadedUserData = await loadUserDataState();
  for (const [key] of fallbackKeys) remove(key);
  remove('parental_control');
  const trimmed = trimResume(loadedUserData.resume);
  if (trimmed.length) persistUserChanges('playback-progress', [], trimmed.map(resumeKey));
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

  /** Called once, at startup, with something that shows the user a write
   *  failure is happening — a console-only log line is otherwise the only
   *  trace. Fires on the first failed user-data write in a streak. */
  setWriteFailureHandler(handler: () => void): void {
    onWriteFailure = handler;
  },

  // Sees every source change, from Settings, phone setup, or a LAN upload.
  setPlaylistsReplacedHandler(handler: (previous: PlaylistEntry[], next: PlaylistEntry[]) => void): void {
    onPlaylistsReplaced = handler;
  },

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
          if (!userData) fallbackResume();
        });
    }
    await userDataInitPromise;
  },

  // Keeps the aspect flag: the TV keeps the ratio the app set through a reset.
  clearAll(): void {
    const aspectDirty = this.getAspectDirty();
    localStorage.clear();
    if (aspectDirty) this.setAspectDirty(true);
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
    return get<PlaylistEntry[]>('playlists', []);
  },
  setPlaylists(playlists: PlaylistEntry[]): boolean {
    const previous = get<PlaylistEntry[]>('playlists', []);
    if (JSON.stringify(previous) === JSON.stringify(playlists)) return true;
    const stored = set('playlists', playlists);
    if (stored) {
      evictCache();
      pruneLiveCategorySnapshots(previous, playlists);
      onPlaylistsReplaced?.(previous, playlists);
    }
    return stored;
  },

  getLiveCategorySnapshot(playlistId: string): XtreamLiveCategorySnapshot | null {
    const all = userData ? userData.liveCategorySnapshots : fallbackLiveCategorySnapshots;
    return all[playlistId] ? cloneValue(all[playlistId]) : null;
  },
  setLiveCategorySnapshot(playlistId: string, snapshot: XtreamLiveCategorySnapshot): void {
    if (!playlistId) return;
    const value = cloneValue(snapshot);
    if (!userData) {
      fallbackLiveCategorySnapshots[playlistId] = value;
      return;
    }
    userData.liveCategorySnapshots[playlistId] = value;
    persistUserChanges('channel-state', [record(LIVE_CATEGORY_KEY_PREFIX + playlistId, value)]);
  },

  getLiveReconnectAttempts(): number {
    const attempts = get<unknown>(
      'live_reconnect_attempts',
      CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS,
    );
    return typeof attempts === 'number' && LIVE_RECONNECT_ATTEMPT_OPTIONS.includes(attempts)
      ? attempts
      : CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS;
  },
  setLiveReconnectAttempts(attempts: number): void {
    if (!LIVE_RECONNECT_ATTEMPT_OPTIONS.includes(attempts)) {
      throw new RangeError(`Invalid live reconnect attempts: ${String(attempts)}`);
    }
    set('live_reconnect_attempts', attempts);
  },

  getNumberEntryOsdTimeoutMs(): number {
    const timeout = get<unknown>(
      'number_entry_osd_timeout_ms',
      CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS,
    );
    return typeof timeout === 'number' && NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS.includes(timeout)
      ? timeout
      : CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS;
  },
  setNumberEntryOsdTimeoutMs(timeout: number): void {
    if (!NUMBER_ENTRY_OSD_TIMEOUT_MS_OPTIONS.includes(timeout)) {
      throw new RangeError(`Invalid Number Entry OSD timeout: ${String(timeout)}`);
    }
    set('number_entry_osd_timeout_ms', timeout);
  },

  getPlayerOsdTimeoutMs(): number {
    const timeout = get<unknown>(
      'player_osd_timeout_ms',
      CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS,
    );
    return typeof timeout === 'number' && PLAYER_OSD_TIMEOUT_MS_OPTIONS.includes(timeout)
      ? timeout
      : CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS;
  },
  setPlayerOsdTimeoutMs(timeout: number): void {
    if (!PLAYER_OSD_TIMEOUT_MS_OPTIONS.includes(timeout)) {
      throw new RangeError(`Invalid player OSD timeout: ${String(timeout)}`);
    }
    set('player_osd_timeout_ms', timeout);
  },

  getPlaylistRefreshIntervalHours(): number {
    const defaultHours = CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS / HOUR_MS;
    const hours = get<unknown>('playlist_refresh_interval_hours', defaultHours);
    return typeof hours === 'number' && REFRESH_INTERVAL_HOUR_OPTIONS.includes(hours)
      ? hours
      : defaultHours;
  },
  setPlaylistRefreshIntervalHours(hours: number): void {
    if (!REFRESH_INTERVAL_HOUR_OPTIONS.includes(hours)) {
      throw new RangeError(`Invalid playlist refresh interval: ${String(hours)}`);
    }
    set('playlist_refresh_interval_hours', hours);
  },
  getPlaylistRefreshIntervalMs(): number | null {
    const hours = this.getPlaylistRefreshIntervalHours();
    return hours === 0 ? null : hours * HOUR_MS;
  },

  getEpgRefreshIntervalHours(): number {
    const defaultHours = CONFIG.DEFAULT_EPG_REFRESH_INTERVAL_MS / HOUR_MS;
    const hours = get<unknown>('epg_refresh_interval_hours', defaultHours);
    return typeof hours === 'number' && REFRESH_INTERVAL_HOUR_OPTIONS.includes(hours)
      ? hours
      : defaultHours;
  },
  setEpgRefreshIntervalHours(hours: number): void {
    if (!REFRESH_INTERVAL_HOUR_OPTIONS.includes(hours)) {
      throw new RangeError(`Invalid EPG refresh interval: ${String(hours)}`);
    }
    set('epg_refresh_interval_hours', hours);
  },
  getEpgRefreshIntervalMs(): number | null {
    const hours = this.getEpgRefreshIntervalHours();
    return hours === 0 ? null : hours * HOUR_MS;
  },

  getXtreamCatalogRefreshIntervalHours(): number {
    const defaultHours = CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS / HOUR_MS;
    const hours = get<unknown>('xtream_catalog_refresh_interval_hours', defaultHours);
    return typeof hours === 'number' && XTREAM_CATALOG_REFRESH_HOUR_OPTIONS.includes(hours)
      ? hours
      : defaultHours;
  },
  setXtreamCatalogRefreshIntervalHours(hours: number): void {
    if (!XTREAM_CATALOG_REFRESH_HOUR_OPTIONS.includes(hours)) {
      throw new RangeError(`Invalid Xtream catalog refresh interval: ${String(hours)}`);
    }
    set('xtream_catalog_refresh_interval_hours', hours);
  },
  getXtreamCatalogRefreshIntervalMs(): number {
    return this.getXtreamCatalogRefreshIntervalHours() * HOUR_MS;
  },

  getCatalogSort(kind: 'vod' | 'series'): CatalogSortPreference {
    const value = get<unknown>(`catalog_sort_${kind}`, null);
    const stored = value && typeof value === 'object' ? value as Partial<CatalogSortPreference> : null;
    return stored && isCatalogSort(stored.by) && isCatalogSortDirection(stored.direction)
      ? { by: stored.by, direction: stored.direction }
      : { by: 'default', direction: 'asc' };
  },
  setCatalogSort(kind: 'vod' | 'series', sort: CatalogSortPreference): boolean {
    if (!isCatalogSort(sort.by) || !isCatalogSortDirection(sort.direction)) {
      throw new RangeError('Invalid catalog sort preference');
    }
    return set(`catalog_sort_${kind}`, { by: sort.by, direction: sort.direction });
  },

  getManualEpgSources(): ManualEpgSource[] {
    const stored = get<unknown>('manual_epg_sources', null);
    return Array.isArray(stored) ? sanitizeManualEpgSources(stored) : [];
  },
  setManualEpgSources(sources: ManualEpgSource[]): boolean {
    return set('manual_epg_sources', sanitizeManualEpgSources(sources));
  },

  getEpgOffsets(): Record<string, number> {
    const stored = get<unknown>('epg_offsets', {});
    const offsets: Record<string, number> = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return offsets;
    for (const url of Object.keys(stored)) {
      const value = (stored as Record<string, unknown>)[url];
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
      offsets[url] = Math.max(
        -CONFIG.EPG.OFFSET_MAX_MINUTES,
        Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES, Math.round(value)),
      );
    }
    return offsets;
  },
  setEpgOffsets(offsets: Record<string, number>): void {
    const sanitized: Record<string, number> = {};
    for (const url of Object.keys(offsets)) {
      const value = offsets[url];
      if (!url || !Number.isFinite(value) || value === 0) continue;
      sanitized[url] = Math.max(
        -CONFIG.EPG.OFFSET_MAX_MINUTES,
        Math.min(CONFIG.EPG.OFFSET_MAX_MINUTES, Math.round(value)),
      );
    }
    set('epg_offsets', sanitized);
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

  getLastChannel(): LastChannel | null {
    return parseLastChannel(get<unknown>('last_channel', null));
  },
  setLastChannel(last: LastChannel): void {
    set('last_channel', last);
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

  getParentalControl(): ParentalControlConfig | null {
    return userData
      ? cloneValue(userData.parentalControl)
      : get<ParentalControlConfig | null>('parental_control', null);
  },
  setParentalControl(config: ParentalControlConfig): void {
    if (!userData) {
      set('parental_control', config);
      return;
    }
    userData.parentalControl = cloneValue(config);
    persistUserChanges('parental-control', [record('config', config)]);
  },
  // Kept in localStorage so restarting the app cannot reset the retry delay.
  getParentalThrottle(): ParentalPinThrottle | null {
    return get<ParentalPinThrottle | null>('parental_throttle', null);
  },
  setParentalThrottle(throttle: ParentalPinThrottle | null): void {
    if (throttle) set('parental_throttle', throttle);
    else remove('parental_throttle');
  },
  clearParentalControl(): void {
    if (!userData) {
      remove('parental_control');
      return;
    }
    userData.parentalControl = null;
    persistUserChanges('parental-control', [], ['config']);
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

  // The user agent whose Luna answered it has no window lookup.
  getLunaWindowUnsupported(): string | null {
    const value = get<unknown>('luna_window_unsupported', null);
    return typeof value === 'string' ? value : null;
  },
  setLunaWindowUnsupported(userAgent: string): void {
    set('luna_window_unsupported', userAgent);
  },

  getHeaderPlayback(): HeaderPlayback {
    const mode = get<unknown>('header_playback', 'luna');
    return mode === 'off' || mode === 'proxy' ? mode : 'luna';
  },
  setHeaderPlayback(mode: HeaderPlayback): void {
    // A new setting gives Media service's window lookup another try.
    if (mode !== this.getHeaderPlayback()) remove('luna_window_unsupported');
    set('header_playback', mode);
  },

  getAutoPlay(): boolean {
    return get<boolean>('auto_play', false);
  },
  setAutoPlay(val: boolean): void {
    set('auto_play', val);
  },

  getLivePreview(): boolean {
    return get<unknown>('live_preview', false) === true;
  },
  setLivePreview(val: boolean): void {
    set('live_preview', val);
  },

  getAnimationMode(): AnimationMode {
    const mode = get<unknown>('animation_mode', DEFAULT_ANIMATION_MODE);
    return isAnimationMode(mode) ? mode : DEFAULT_ANIMATION_MODE;
  },
  setAnimationMode(mode: AnimationMode): void {
    if (!isAnimationMode(mode)) {
      throw new RangeError(`Invalid animation mode: ${String(mode)}`);
    }
    set('animation_mode', mode);
  },

  // 'global' = channel_up/channel_down cycles the entire channel list
  // (default, matches pre-scoping behavior), 'active' = stays within the
  // group/playlist/Favorites a channel was tuned from.
  getChannelCycleMode(): ChannelCycleMode {
    return get<ChannelCycleMode>('channel_cycle_mode', 'global');
  },
  setChannelCycleMode(mode: ChannelCycleMode): void {
    set('channel_cycle_mode', mode);
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
    const all = userData ? userData.audioPrefs : get<Record<string, AudioPref>>('audio_prefs', {});
    const pref = all[channelId] ?? null;
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
  getSubtitlePref(channelId: string): SubtitlePref | null {
    if (!channelId) return null;
    const all = userData
      ? userData.subtitlePrefs
      : get<Record<string, SubtitlePref>>('subtitle_prefs', {});
    const pref = all[channelId] ?? null;
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
  getSubtitleOffset(channelId: string): number {
    if (!channelId) return 0;
    const all = userData
      ? userData.subtitleOffsets
      : get<Record<string, number>>('subtitle_offsets', {});
    return all[channelId] ?? 0;
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

  // Per-stream picture aspect ratio (keyed by channelPrefKey, same as the
  // subtitle pref). Absent = auto.
  getAspectRatio(channelId: string): AspectRatio {
    if (!channelId) return 'auto';
    const all = userData
      ? userData.aspectRatios
      : get<Record<string, AspectRatio>>('aspect_ratios', {});
    const mode = all[channelId];
    return isAspectRatio(mode) ? mode : 'auto';
  },
  setAspectRatio(channelId: string, mode: AspectRatio): void {
    if (!channelId) return;
    if (userData) {
      if (mode !== 'auto') {
        userData.aspectRatios[channelId] = mode;
        persistUserChanges('channel-state', [record(`aspect:${channelId}`, mode)]);
      } else {
        delete userData.aspectRatios[channelId];
        persistUserChanges('channel-state', [], [`aspect:${channelId}`]);
      }
      return;
    }
    const all = get<Record<string, AspectRatio>>('aspect_ratios', {});
    if (mode !== 'auto') all[channelId] = mode; else delete all[channelId];
    set('aspect_ratios', all);
  },

  getVideoQuality(): VideoQuality {
    const quality = get<unknown>('video_quality', 'auto');
    return isVideoQuality(quality) ? quality : 'auto';
  },
  setVideoQuality(quality: VideoQuality): void {
    set('video_quality', quality);
  },

  // A stream's own Video quality pick (keyed like the aspect ratio). Absent
  // follows the setting.
  getQualityOverride(channelId: string): QualityOverride | null {
    if (!channelId) return null;
    const all = userData
      ? userData.qualityPicks
      : get<Record<string, string>>('quality_picks', {});
    return parseOverride(all[channelId]);
  },
  setQualityOverride(channelId: string, override: QualityOverride | null): void {
    if (!channelId) return;
    const value = override ? serializeOverride(override) : '';
    if (userData) {
      if (value) {
        userData.qualityPicks[channelId] = value;
        persistUserChanges('channel-state', [record(`quality:${channelId}`, value)]);
      } else {
        delete userData.qualityPicks[channelId];
        persistUserChanges('channel-state', [], [`quality:${channelId}`]);
      }
      return;
    }
    const all = get<Record<string, string>>('quality_picks', {});
    if (value) all[channelId] = value; else delete all[channelId];
    set('quality_picks', all);
  },

  // The app left a non-original TV aspect ratio that it has not restored.
  getAspectDirty(): boolean {
    return get<boolean>('aspect_dirty', false) === true;
  },
  setAspectDirty(dirty: boolean): void {
    if (dirty) set('aspect_dirty', true);
    else remove('aspect_dirty');
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
    const all = userData ? userData.resume : fallbackResume();
    const entry = all[`${accountId}|${kind}|${itemId}`] ?? null;
    return entry ? cloneValue(entry) : null;
  },
  // `keepStart` keeps a point below RESUME_MIN_SECS at 0 instead of dropping
  // it: an episode that auto-advance started is where its series stands.
  setResume(entry: ResumeEntry, opts: { keepStart?: boolean } = {}): void {
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    const finished = entry.duration > 0 && entry.position >= entry.duration - CONFIG.XTREAM.RESUME_FINISH_PAD;
    if (!finished && opts.keepStart && entry.position < CONFIG.XTREAM.RESUME_MIN_SECS) {
      entry = { ...entry, position: 0 };
    }
    const tooEarly = !opts.keepStart && entry.position < CONFIG.XTREAM.RESUME_MIN_SECS;
    // A duration within the pad of zero (a growing EVENT playlist) can't tell an end.
    if (finished && entry.duration > 2 * CONFIG.XTREAM.RESUME_FINISH_PAD) StorageService.setCatalogMark(entry.accountId, entry.kind, entry.itemId, { watched: true });
    if (userData) {
      if (finished || tooEarly) {
        delete userData.resume[key];
        persistUserChanges('playback-progress', [], [resumeKey(entry)]);
      } else {
        userData.resume[key] = cloneValue(entry);
        const evicted = trimResume(userData.resume, entry, key);
        persistUserChanges('playback-progress', [
          record(resumeKey(entry), entry, { updatedAt: entry.updatedAt }),
        ], evicted.map(resumeKey));
      }
      return;
    }
    const all = fallbackResume();
    if (finished || tooEarly) {
      delete all[key];
    } else {
      all[key] = cloneValue(entry);
      trimResume(all, entry, key);
    }
    set('resume', all);
  },
  getResumeList(accountId: string): ResumeEntry[] {
    const all = userData ? userData.resume : fallbackResume();
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
    const all = fallbackResume();
    delete all[key];
    set('resume', all);
  },
  clearResumeList(accountId: string, kind?: ResumeKind): void {
    const all = userData ? userData.resume : fallbackResume();
    const removed: ResumeEntry[] = [];
    for (const key of Object.keys(all)) {
      const entry = all[key];
      if (entry.accountId === accountId && (!kind || entry.kind === kind)) {
        removed.push(entry);
        delete all[key];
      }
    }
    if (userData) {
      persistUserChanges('playback-progress', [], removed.map(resumeKey));
    } else if (removed.length) {
      set('resume', all);
    }
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
  toggleWatchlist(entry: WatchlistEntry): WatchlistToggleResult {
    const all = userData ? userData.watchlist : get<Record<string, WatchlistEntry>>('watchlist', {});
    const key = `${entry.accountId}|${entry.kind}|${entry.itemId}`;
    if (all[key]) {
      delete all[key];
      if (userData) persistUserChanges('watchlist', [], [watchlistKey(entry)]);
      else set('watchlist', all);
      return 'removed';
    }

    // A full list refuses the add rather than dropping something the user saved.
    const count = Object.keys(all).filter((itemKey) =>
      all[itemKey].accountId === entry.accountId && all[itemKey].kind === entry.kind).length;
    if (count >= CONFIG.XTREAM.WATCHLIST_MAX_ITEMS) return 'full';

    all[key] = cloneValue(entry);
    if (userData) {
      persistUserChanges('watchlist', [record(watchlistKey(entry), entry, {
        scope: `${entry.accountId}|${entry.kind}`,
        updatedAt: entry.addedAt,
      })]);
    } else {
      set('watchlist', all);
    }
    return 'added';
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
  clearWatchlist(accountId: string, kind?: WatchlistKind): void {
    const all = userData ? userData.watchlist : get<Record<string, WatchlistEntry>>('watchlist', {});
    const removed: WatchlistEntry[] = [];
    for (const key of Object.keys(all)) {
      if (all[key].accountId === accountId && (!kind || all[key].kind === kind)) {
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
  setOnlineSubtitleConfig(cfg: OnlineSubtitleConfig): boolean {
    return set('online_subtitles', cfg);
  },

  getCatalogMark(accountId: string, kind: CatalogMarkKind, itemId: string): CatalogMark | null {
    const all = userData ? userData.marks : get<Record<string, CatalogMark>>('catalog_marks', {});
    const mark = all[`${accountId}|${kind}|${itemId}`];
    return mark ? cloneValue(mark) : null;
  },
  isWatched(accountId: string, kind: CatalogMarkKind, itemId: string): boolean {
    return !!StorageService.getCatalogMark(accountId, kind, itemId)?.watched;
  },
  isHidden(accountId: string, kind: CatalogMarkKind, itemId: string): boolean {
    return !!StorageService.getCatalogMark(accountId, kind, itemId)?.hidden;
  },
  /** Item ids of one account and kind carrying a mark, for filtering a whole list at once. */
  catalogMarkIds(accountId: string, kind: CatalogMarkKind, flag: 'watched' | 'hidden'): Set<string> {
    const all = userData ? userData.marks : get<Record<string, CatalogMark>>('catalog_marks', {});
    const ids = new Set<string>();
    for (const key of Object.keys(all)) {
      const mark = all[key];
      if (mark.accountId === accountId && mark.kind === kind && mark[flag]) ids.add(mark.itemId);
    }
    return ids;
  },
  // A mark with neither flag left is deleted, so the store holds only marked titles.
  setCatalogMark(
    accountId: string,
    kind: CatalogMarkKind,
    itemId: string,
    flags: { watched?: boolean; hidden?: boolean },
  ): void {
    StorageService.setCatalogMarks(accountId, kind, [itemId], flags);
  },
  // One write for many titles, such as every episode of a season.
  setCatalogMarks(
    accountId: string,
    kind: CatalogMarkKind,
    itemIds: string[],
    flags: { watched?: boolean; hidden?: boolean },
  ): void {
    const all = userData ? userData.marks : get<Record<string, CatalogMark>>('catalog_marks', {});
    const puts: UserDataRecord[] = [];
    const deletes: string[] = [];
    const now = Date.now();
    for (const itemId of itemIds) {
      const key = `${accountId}|${kind}|${itemId}`;
      const previous = all[key];
      const next: CatalogMark = { accountId, kind, itemId, updatedAt: now };
      const watched = flags.watched ?? previous?.watched;
      const hidden = flags.hidden ?? previous?.hidden;
      if (watched) next.watched = true;
      if (hidden) next.hidden = true;
      if (!!previous?.watched === !!watched && !!previous?.hidden === !!hidden) continue;
      if (watched || hidden) {
        all[key] = next;
        puts.push(record(markKey(next), next, { updatedAt: now }));
      } else {
        delete all[key];
        deletes.push(markKey(next));
      }
    }
    if (!puts.length && !deletes.length) return;
    if (userData) {
      persistUserChanges('playback-progress', puts, deletes);
      return;
    }
    set('catalog_marks', all);
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
    const stored = all[`${chKey}|${progStart}`];
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

  migrateCatchupEpgOffsets(
    previous: Record<string, number>,
    next: Record<string, number>,
    sourceByChannel: Record<string, string>,
  ): void {
    const all = userData
      ? userData.catchupProgress
      : get<Record<string, StoredCatchup>>('catchup_progress', {});
    const migratedAll: Record<string, StoredCatchup> = {};
    let changed = false;
    for (const entry of Object.keys(all).map(key => all[key])) {
      const sourceUrl = entry.epgSourceUrl ?? sourceByChannel[entry.channelKey];
      const deltaMs = sourceUrl
        ? ((next[sourceUrl] ?? 0) - (previous[sourceUrl] ?? 0)) * 60_000
        : 0;
      const migrated = deltaMs
        ? {
            ...entry,
            progStart: entry.progStart + deltaMs,
            progEnd: entry.progEnd + deltaMs,
            expiresAt: entry.expiresAt + deltaMs,
            epgSourceUrl: sourceUrl,
          }
        : entry;
      changed = changed || deltaMs !== 0;
      const migratedKey = `${migrated.channelKey}|${migrated.progStart}`;
      const existing = migratedAll[migratedKey];
      if (!existing || existing.updatedAt <= migrated.updatedAt) {
        migratedAll[migratedKey] = migrated;
      }
    }
    if (!changed) return;
    if (userData) {
      const toRecord = (entry: StoredCatchup) =>
        record(catchupKey(entry), entry, {
          updatedAt: entry.updatedAt,
          expiresAt: entry.expiresAt,
        });
      userData.catchupProgress = migratedAll;
      syncUserRecords(
        'playback-progress',
        Object.keys(all).map(key => toRecord(all[key])),
        Object.keys(migratedAll).map(key => toRecord(migratedAll[key])),
      );
    } else {
      set('catchup_progress', migratedAll);
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

  getCatchupProgressList(chKey: string, now?: number): CatchupProgressEntry[] {
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

  getSearchHistory(): string[] {
    const stored = get<unknown>('search_history', []);
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      .slice(0, CONFIG.SEARCH.HISTORY_MAX_ENTRIES);
  },

  // Newest first; a repeat moves to the front and the oldest falls off the end.
  addSearchHistory(query: string): void {
    const q = query.trim();
    if (!q) return;
    const key = q.toLowerCase();
    const prior = this.getSearchHistory();
    const rest = prior.filter(entry => entry.toLowerCase() !== key);
    const next = [q, ...rest].slice(0, CONFIG.SEARCH.HISTORY_MAX_ENTRIES);
    set('search_history', next);
    log.debug(
      'Search history saved',
      'event=search.history.saved',
      `items=${String(next.length)}`,
      `duplicates=${String(prior.length - rest.length)}`,
      `dropped=${String(rest.length + 1 - next.length)}`,
    );
  },

  clearSearchHistory(): boolean {
    try {
      remove('search_history');
      return true;
    } catch (err) {
      log.warn(
        'Search history clear failed',
        'event=persistence.search_history.clear.failed',
        'operation=clear',
        err,
      );
      return false;
    }
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
