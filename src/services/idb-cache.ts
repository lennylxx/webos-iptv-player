import { CONFIG } from '../config';
import type { Channel, EpgSource, ParsedEpg } from '../types';
import { createLogger } from '../utils/logger';
import type { SearchIndexCandidate } from '../workers/tasks';
import {
  CACHE_META_STORE as META_STORE,
  CACHE_STORES,
  cacheKeyPath,
  CATALOG_STORE,
  CHANNEL_HEALTH_STORE,
  EPG_STORE,
  openPersistenceDb,
  PLAYLIST_STORE,
  requestResult,
  SEARCH_INDEX_STORE,
  STREAM_MIME_STORE,
  SUBTITLE_STORE,
  transactionDone,
  type CacheStore,
} from './idb-database';
import { cacheEntryMetaId, cacheRecordTimestamp, PLAYLIST_CACHE_KEY } from './idb-schema';

const log = createLogger('CacheStorage');
const CACHE_CATEGORIES = ['playlist', 'epg', 'catalog', 'subtitle', 'health', 'search'] as const;
const FALLBACK_BUDGET_BYTES = 384 * 1024 * 1024;
const MAX_BUDGET_BYTES = 1024 * 1024 * 1024;
const SUBTITLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEARCH_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_MARGIN_BYTES = 4 * 1024 * 1024;
const ENTRY_META_PREFIX = 'entry:';
const ENTRY_META_INDEX_KEY = 'entry-index';
const ENTRY_META_VERSION = 1;
const ACCESS_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const STORAGE_ESTIMATE_TTL_MS = 60 * 1000;
const JSON_NULL_BYTES = 4;

export type CacheCategory = typeof CACHE_CATEGORIES[number];

interface CacheFields {
  cacheCategory: CacheCategory;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  expiresAt: number | null;
  byteSize: number;
}

interface CacheMeta {
  category: CacheCategory | 'total';
  bytes: number;
  entries: number;
  updatedAt: number;
}

interface CacheEntryMeta {
  category: string;
  cacheCategory: CacheCategory;
  store: CacheStore;
  key: IDBValidKey;
  byteSize: number;
  expiresAt: number | null;
  lastAccessedAt: number;
  /** The record's own timestamp, so the app worker can tell its version cheaply. */
  timestamp?: number;
  state?: CatalogListState;
}

interface CacheCandidate {
  store: CacheStore;
  key: IDBValidKey;
  category: CacheCategory;
  byteSize: number;
  expiresAt: number | null;
  lastAccessedAt: number;
}

export interface CacheUsageEntry {
  bytes: number;
  entries: number;
}

export interface CacheUsageSummary {
  total: CacheUsageEntry;
  categories: Record<CacheCategory, CacheUsageEntry>;
  budgetBytes: number;
  originUsageBytes: number | null;
  quotaBytes: number | null;
}

export interface CachedEpgFilter {
  ids: string[];
  names: string[];
}

export interface CachedEpgEntry {
  url: string;
  timestamp: number;
  data: ParsedEpg;
  /** Channel filter the entry was parsed with; absent means the whole feed. */
  filter?: CachedEpgFilter | null;
}

export interface CachedCatalogMetadata {
  timestamp: number;
  state?: CatalogListState;
}

export interface CachedCatalogEntry<T = unknown> extends CachedCatalogMetadata {
  key: string;
  data: T;
}

export interface CatalogListState {
  complete: boolean;
  refreshAfter: number;
  freshSince?: number;
}

interface StreamMimeEntry {
  mime: string;
  updatedAt: number;
}

interface CachedPlaylistPayload {
  sourceSignature: string;
  channels: Channel[];
  epgSources: EpgSource[];
  timestamp: number;
}

type StoredRecord = Record<string, unknown> & CacheFields;

let metadataPromise: Promise<void> | null = null;
let mutationChain: Promise<void> = Promise.resolve();
const accessTouches = new Map<string, number>();
let storageEstimateCache: {
  value: { usage: number | null; quota: number | null };
  timestamp: number;
} | null = null;
let scheduledPlaylist: {
  channels: Channel[];
  epgSources: EpgSource[];
  timestamp: number;
  refreshIntervalMs: number | null;
  sourceSignature: string;
  scheduledAt: number;
} | null = null;
let playlistFrame: number | null = null;
let playlistGeneration = 0;
let playlistTimer: ReturnType<typeof setTimeout> | null = null;
let clearGeneration = 0;

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(operation, operation);
  mutationChain = result.then(() => {}, () => {});
  return result;
}

function cancelPlaylistSchedule(): void {
  if (playlistFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(playlistFrame);
  }
  if (playlistTimer !== null) clearTimeout(playlistTimer);
  playlistFrame = null;
  playlistTimer = null;
}

function discardScheduledPlaylist(reason: 'cache_clear' | 'rescheduled'): void {
  cancelPlaylistSchedule();
  if (scheduledPlaylist) {
    log.info(
      'Playlist cache write cancelled',
      'event=playlist.cache.write.cancelled',
      `reason=${reason}`,
      `channels=${String(scheduledPlaylist.channels.length)}`,
      `epg=${String(scheduledPlaylist.epgSources.length)}`,
    );
  }
  scheduledPlaylist = null;
}

function persistScheduledPlaylist(): void {
  cancelPlaylistSchedule();
  const pending = scheduledPlaylist;
  scheduledPlaylist = null;
  if (!pending) return;
  const started = Date.now();
  log.info(
    'Playlist cache write started',
    'event=playlist.cache.write.started',
    `channels=${String(pending.channels.length)}`,
    `epg=${String(pending.epgSources.length)}`,
    `delayMs=${String(started - pending.scheduledAt)}`,
  );
  void setCachedPlaylistWithSignature(
    pending.channels,
    pending.epgSources,
    pending.timestamp,
    pending.sourceSignature,
    pending.refreshIntervalMs,
  ).then((stored) => {
    if (stored) {
      for (const listener of playlistWriteListeners) listener();
      log.info(
        'Playlist cache write completed',
        'event=playlist.cache.write.completed',
        `channels=${String(pending.channels.length)}`,
        `epg=${String(pending.epgSources.length)}`,
        `elapsedMs=${String(Date.now() - started)}`,
      );
    } else {
      log.warn(
        'Playlist cache write was not accepted',
        'event=playlist.cache.write.skipped',
        'operation=write',
        `channels=${String(pending.channels.length)}`,
        `elapsedMs=${String(Date.now() - started)}`,
      );
    }
  }, (err) => log.error(
    'Playlist cache write failed',
    'event=playlist.cache.write.failed',
    'operation=write',
    `channels=${String(pending.channels.length)}`,
    `elapsedMs=${String(Date.now() - started)}`,
    err,
  ));
}

const playlistWriteListeners: Array<() => void> = [];

/** Called after a scheduled playlist write lands in IndexedDB. */
export function onPlaylistCacheWritten(listener: () => void): () => void {
  playlistWriteListeners.push(listener);
  return () => {
    const index = playlistWriteListeners.indexOf(listener);
    if (index >= 0) playlistWriteListeners.splice(index, 1);
  };
}

export interface CacheRecordRef {
  store: typeof PLAYLIST_STORE | typeof CATALOG_STORE;
  key: string;
  timestamp: number;
}

// The stored record an in-memory array was read from or written to, so the
// app worker can read the same strings from IndexedDB instead of a postMessage.
const recordRefs = new WeakMap<object, CacheRecordRef>();

export function cacheRecordRef(value: object): CacheRecordRef | null {
  return recordRefs.get(value) ?? null;
}

function rememberRecord(value: unknown, ref: CacheRecordRef): void {
  if (value && typeof value === 'object') recordRefs.set(value, ref);
}

export interface PlaylistCacheToken {
  signature: string;
  generation: number;
}

// Taken when a refresh starts, so a response that outlives a source edit or a
// cache clear is not stored under the new configuration.
export function playlistCacheToken(): PlaylistCacheToken {
  return { signature: playlistSourceSignature(), generation: playlistGeneration };
}

export function scheduleCachedPlaylist(
  channels: Channel[],
  epgSources: EpgSource[] = [],
  timestamp = Date.now(),
  refreshIntervalMs: number | null = CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS,
  token: PlaylistCacheToken = playlistCacheToken(),
): void {
  if (!channels.length) return;
  if (
    token.generation !== playlistGeneration
    || token.signature !== playlistSourceSignature()
  ) {
    log.info(
      'Playlist cache write skipped',
      'event=playlist.cache.write.skipped',
      'operation=schedule',
      'reason=stale_refresh',
      `channels=${String(channels.length)}`,
    );
    return;
  }
  if (scheduledPlaylist) discardScheduledPlaylist('rescheduled');
  const scheduledAt = Date.now();
  scheduledPlaylist = {
    channels,
    epgSources,
    timestamp,
    refreshIntervalMs,
    sourceSignature: token.signature,
    scheduledAt,
  };
  cancelPlaylistSchedule();
  log.info(
    'Playlist cache write scheduled',
    'event=playlist.cache.write.scheduled',
    `channels=${String(channels.length)}`,
    `epg=${String(epgSources.length)}`,
    `delayMs=${String(CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS)}`,
  );
  if (typeof requestAnimationFrame === 'function') {
    playlistFrame = requestAnimationFrame(() => {
      playlistFrame = requestAnimationFrame(() => {
        playlistFrame = null;
        playlistTimer = setTimeout(
          persistScheduledPlaylist,
          CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS,
        );
      });
    });
  } else {
    playlistTimer = setTimeout(
      persistScheduledPlaylist,
      CONFIG.PLAYLIST_CACHE_WRITE_DELAY_MS,
    );
  }
}

export async function flushCacheWrites(): Promise<void> {
  if (scheduledPlaylist) persistScheduledPlaylist();
  await mutationChain;
}

function categoryForStore(store: CacheStore): CacheCategory {
  switch (store) {
    case PLAYLIST_STORE: return 'playlist';
    case EPG_STORE: return 'epg';
    case CATALOG_STORE: return 'catalog';
    case STREAM_MIME_STORE: return 'catalog';
    case SUBTITLE_STORE: return 'subtitle';
    case CHANNEL_HEALTH_STORE: return 'health';
    case SEARCH_INDEX_STORE: return 'search';
  }
}

function ttlFor(category: CacheCategory): number {
  switch (category) {
    case 'playlist': return CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS;
    case 'epg': return CONFIG.DEFAULT_EPG_REFRESH_INTERVAL_MS;
    case 'catalog': return CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
    case 'subtitle': return SUBTITLE_TTL_MS;
    case 'health': return 30 * 24 * 60 * 60 * 1000;
    case 'search': return SEARCH_INDEX_TTL_MS;
  }
}

const openDb = openPersistenceDb;

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9
        || code === 10 || code === 12 || code === 13) {
      bytes += 2;
    } else if (code < 32) {
      bytes += 6;
    } else if (code < 128) {
      bytes++;
    } else if (code < 2048) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff
        && i + 1 < value.length
        && value.charCodeAt(i + 1) >= 0xdc00
        && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function serializedBytes(value: unknown): number {
  const ancestors = new WeakSet<object>();

  const measure = (item: unknown, arrayItem: boolean): number => {
    switch (typeof item) {
      case 'string':
        return jsonStringBytes(item);
      case 'number':
        return Number.isFinite(item) ? String(item).length : JSON_NULL_BYTES;
      case 'boolean':
        return item ? 4 : 5;
      case 'bigint':
        throw new TypeError('BigInt cannot be serialized to JSON');
      case 'undefined':
      case 'function':
      case 'symbol':
        return arrayItem ? JSON_NULL_BYTES : 0;
      case 'object':
        break;
    }
    if (item === null) return JSON_NULL_BYTES;
    if (item instanceof Date) {
      return Number.isFinite(item.getTime())
        ? jsonStringBytes(item.toISOString())
        : JSON_NULL_BYTES;
    }
    // Typed arrays are stored as their bytes, not as JSON numbers.
    if (ArrayBuffer.isView(item)) return item.byteLength;
    if (ancestors.has(item)) throw new TypeError('Circular cache value');
    ancestors.add(item);
    let bytes = 2;
    let entries = 0;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        bytes += measure(item[i], true);
        entries++;
      }
    } else {
      const record = item as Record<string, unknown>;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        const field = record[key];
        const valueBytes = measure(field, false);
        if (!valueBytes) continue;
        bytes += jsonStringBytes(key) + 1 + valueBytes;
        entries++;
      }
    }
    ancestors.delete(item);
    return bytes + Math.max(0, entries - 1);
  };

  return measure(value, false);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function entryMetaId(store: CacheStore, key: IDBValidKey): string {
  return cacheEntryMetaId(store, key);
}

function entryMeta(
  store: CacheStore,
  key: IDBValidKey,
  record: StoredRecord,
  lastAccessedAt = record.lastAccessedAt,
): CacheEntryMeta {
  const state = store === CATALOG_STORE ? catalogListState(record.state) : undefined;
  return {
    category: entryMetaId(store, key),
    cacheCategory: categoryForStore(store),
    store,
    key,
    byteSize: record.byteSize,
    expiresAt: record.expiresAt,
    lastAccessedAt,
    timestamp: cacheRecordTimestamp(record),
    ...(state ? { state } : {}),
  };
}

function isCacheEntryMeta(value: unknown): value is CacheEntryMeta {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CacheEntryMeta>;
  return typeof record.category === 'string'
    && record.category.indexOf(ENTRY_META_PREFIX) === 0
    && typeof record.store === 'string'
    && CACHE_STORES.includes(record.store as CacheStore)
    && record.key !== undefined
    && typeof record.byteSize === 'number'
    && typeof record.lastAccessedAt === 'number';
}

function isNormalizedRecord(store: CacheStore, raw: Record<string, unknown>): raw is StoredRecord {
  return raw.cacheCategory === categoryForStore(store)
    && typeof raw.createdAt === 'number'
    && Number.isFinite(raw.createdAt)
    && typeof raw.updatedAt === 'number'
    && Number.isFinite(raw.updatedAt)
    && typeof raw.lastAccessedAt === 'number'
    && Number.isFinite(raw.lastAccessedAt)
    && (raw.expiresAt === null
      || (typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)))
    && typeof raw.byteSize === 'number'
    && Number.isFinite(raw.byteSize)
    && raw.byteSize > 0;
}

function normalizeRecord(
  store: CacheStore,
  raw: Record<string, unknown>,
  now = Date.now(),
): StoredRecord {
  const category = categoryForStore(store);
  const timestamp = finiteNumber(raw.timestamp, now);
  const updatedAt = finiteNumber(raw.updatedAt, timestamp);
  const createdAt = finiteNumber(raw.createdAt, updatedAt);
  const expiresAt = raw.expiresAt === null
    ? null
    : finiteNumber(raw.expiresAt, updatedAt + ttlFor(category));
  const normalized: StoredRecord = {
    ...raw,
    cacheCategory: category,
    createdAt,
    updatedAt,
    lastAccessedAt: finiteNumber(raw.lastAccessedAt, updatedAt),
    expiresAt,
    byteSize: 0,
  };
  normalized.byteSize = serializedBytes(normalized);
  return normalized;
}

async function readRaw(store: CacheStore, key: IDBValidKey): Promise<StoredRecord | null> {
  const db = await openDb();
  if (!db) {
    if (store === CATALOG_STORE) {
      log.warn(
        'Catalog cache is unavailable',
        'event=xtream.cache.unavailable',
        'operation=read',
      );
    }
    return null;
  }
  try {
    const tx = db.transaction(store, 'readonly');
    const raw = await requestResult(tx.objectStore(store).get(key)) as
      Record<string, unknown> | undefined;
    if (!raw) return null;
    const normalized = isNormalizedRecord(store, raw) ? raw : normalizeRecord(store, raw);
    if (!isNormalizedRecord(store, raw)) {
      void persistNormalizedRecord(store, normalized);
    } else {
      void touchRecord(store, normalized);
    }
    return normalized;
  } catch (err) {
    if (store === CATALOG_STORE) {
      log.warn(
        'Catalog cache read failed',
        'event=xtream.cache.read.failed',
        'operation=read',
        'category=catalog',
        err,
      );
    } else {
      log.warn(
        'Cache read failed',
        'event=persistence.cache.read.failed',
        'operation=read',
        `category=${categoryForStore(store)}`,
        err,
      );
    }
    return null;
  }
}

async function touchRecord(store: CacheStore, record: StoredRecord): Promise<void> {
  const key = record[cacheKeyPath(store)] as IDBValidKey;
  const id = entryMetaId(store, key);
  const now = Date.now();
  const lastTouch = accessTouches.get(id);
  if (lastTouch !== undefined && now - lastTouch < ACCESS_TOUCH_INTERVAL_MS) return;
  accessTouches.set(id, now);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(META_STORE, 'readwrite');
    const metadata = tx.objectStore(META_STORE);
    const request = metadata.get(id);
    request.onsuccess = () => {
      const current: unknown = request.result;
      if (isCacheEntryMeta(current) && current.timestamp !== undefined) {
        if (current.timestamp === cacheRecordTimestamp(record)) {
          metadata.put({ ...current, lastAccessedAt: now });
        }
      } else {
        metadata.put(entryMeta(store, key, record, now));
      }
    };
    await transactionDone(tx);
  } catch {
    // Access-time bookkeeping must not turn a valid cache hit into a miss.
  }
}

async function persistNormalizedRecord(store: CacheStore, record: StoredRecord): Promise<void> {
  try {
    await putRaw(store, record, false);
  } catch {
    // Legacy metadata backfill is best-effort; the payload remains readable.
  }
}

function emptyUsage(): Record<CacheCategory, CacheUsageEntry> {
  return {
    playlist: { bytes: 0, entries: 0 },
    epg: { bytes: 0, entries: 0 },
    catalog: { bytes: 0, entries: 0 },
    subtitle: { bytes: 0, entries: 0 },
    health: { bytes: 0, entries: 0 },
    search: { bytes: 0, entries: 0 },
  };
}

async function rebuildMetadata(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const categories = emptyUsage();
  const entries: CacheEntryMeta[] = [];
  // Search indexes are disposable and too large to re-measure here, so a
  // rebuild drops them instead.
  const scanned = CACHE_STORES.filter(store => store !== SEARCH_INDEX_STORE);
  try {
    const tx = db.transaction(scanned, 'readonly');
    const done = transactionDone(tx);
    await Promise.all(scanned.map((storeName) => new Promise<void>((resolve, reject) => {
      const category = categoryForStore(storeName);
      const req = tx.objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = normalizeRecord(storeName, cursor.value as Record<string, unknown>);
        categories[category].bytes += record.byteSize;
        categories[category].entries++;
        entries.push(entryMeta(storeName, cursor.primaryKey, record));
        cursor.continue();
      };
      req.onerror = () => reject(req.error ?? new Error('Cache scan failed'));
    })));
    await done;

    const now = Date.now();
    const total = CACHE_CATEGORIES.reduce((sum, category) => ({
      bytes: sum.bytes + categories[category].bytes,
      entries: sum.entries + categories[category].entries,
    }), { bytes: 0, entries: 0 });
    const keysTx = db.transaction(META_STORE, 'readonly');
    const existingKeys = await requestResult(keysTx.objectStore(META_STORE).getAllKeys());
    const metaTx = db.transaction([META_STORE, SEARCH_INDEX_STORE], 'readwrite');
    metaTx.objectStore(SEARCH_INDEX_STORE).clear();
    const metaStore = metaTx.objectStore(META_STORE);
    for (const key of existingKeys) {
      if (typeof key === 'string' && key.indexOf(ENTRY_META_PREFIX) === 0) {
        metaStore.delete(key);
      }
    }
    for (const category of CACHE_CATEGORIES) {
      metaStore.put({ category, ...categories[category], updatedAt: now } satisfies CacheMeta);
    }
    metaStore.put({ category: 'total', ...total, updatedAt: now } satisfies CacheMeta);
    for (const entry of entries) metaStore.put(entry);
    metaStore.put({
      category: ENTRY_META_INDEX_KEY,
      version: ENTRY_META_VERSION,
      updatedAt: now,
    });
    await transactionDone(metaTx);
  } catch (err) {
    log.warn(
      'Cache accounting rebuild failed',
      'event=persistence.cache.accounting.rebuild.failed',
      'operation=rebuild',
      err,
    );
  }
}

async function ensureMetadata(): Promise<void> {
  if (metadataPromise) return metadataPromise;
  metadataPromise = (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const [total, entryIndex] = await Promise.all([
        requestResult(store.get('total')),
        requestResult(store.get(ENTRY_META_INDEX_KEY)),
      ]);
      const indexVersion = (entryIndex as { version?: unknown } | undefined)?.version;
      if (!total || indexVersion !== ENTRY_META_VERSION) await rebuildMetadata();
    } catch {
      await rebuildMetadata();
    }
  })();
  return metadataPromise;
}

async function readMetadata(): Promise<{
  categories: Record<CacheCategory, CacheUsageEntry>;
  total: CacheUsageEntry;
}> {
  await ensureMetadata();
  const categories = emptyUsage();
  const total = { bytes: 0, entries: 0 };
  const db = await openDb();
  if (!db) return { categories, total };
  try {
    const tx = db.transaction(META_STORE, 'readonly');
    const records = await requestResult(tx.objectStore(META_STORE).getAll()) as CacheMeta[];
    for (const record of records) {
      if (record.category === 'total') {
        total.bytes = Math.max(0, finiteNumber(record.bytes, 0));
        total.entries = Math.max(0, finiteNumber(record.entries, 0));
      } else if (CACHE_CATEGORIES.includes(record.category)) {
        categories[record.category] = {
          bytes: Math.max(0, finiteNumber(record.bytes, 0)),
          entries: Math.max(0, finiteNumber(record.entries, 0)),
        };
      }
    }
  } catch (err) {
    log.warn(
      'Cache accounting read failed',
      'event=persistence.cache.accounting.read.failed',
      'operation=read',
      err,
    );
  }
  return { categories, total };
}

async function readEntryMeta(
  store: CacheStore,
  key: IDBValidKey,
): Promise<CacheEntryMeta | null> {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(META_STORE, 'readonly');
  const raw = await requestResult(
    tx.objectStore(META_STORE).get(entryMetaId(store, key)),
  );
  return isCacheEntryMeta(raw) ? raw : null;
}

async function storageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    // StorageManager is absent on webOS 4; guard before accessing it.
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return { usage: null, quota: null };
    }
    // eslint-disable-next-line compat/compat
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === 'number' ? estimate.usage : null,
      quota: typeof estimate.quota === 'number' ? estimate.quota : null,
    };
  } catch {
    return { usage: null, quota: null };
  }
}

async function cachedStorageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  const now = Date.now();
  if (storageEstimateCache
      && now - storageEstimateCache.timestamp < STORAGE_ESTIMATE_TTL_MS) {
    return storageEstimateCache.value;
  }
  const value = await storageEstimate();
  if (value.quota !== null) storageEstimateCache = { value, timestamp: now };
  return value;
}

function budgetForQuota(quota: number | null): number {
  if (quota === null || quota <= 0) return FALLBACK_BUDGET_BYTES;
  return Math.min(Math.floor(quota * 0.5), MAX_BUDGET_BYTES);
}

export async function getCacheUsage(): Promise<CacheUsageSummary> {
  const [metadata, estimate] = await Promise.all([readMetadata(), storageEstimate()]);
  return {
    ...metadata,
    budgetBytes: budgetForQuota(estimate.quota),
    originUsageBytes: estimate.usage,
    quotaBytes: estimate.quota,
  };
}

async function collectCandidates(): Promise<CacheCandidate[]> {
  const db = await openDb();
  if (!db) return [];
  await ensureMetadata();
  try {
    const tx = db.transaction(META_STORE, 'readonly');
    const records = await requestResult(tx.objectStore(META_STORE).getAll()) as unknown[];
    return records.filter(isCacheEntryMeta).map((record) => ({
      store: record.store,
      key: record.key,
      category: record.cacheCategory,
      byteSize: record.byteSize,
      expiresAt: record.expiresAt,
      lastAccessedAt: record.lastAccessedAt,
    }));
  } catch (err) {
    log.warn(
      'Cache candidate scan failed',
      'event=persistence.cache.eviction.scan.failed',
      'operation=scan',
      err,
    );
    return [];
  }
}

async function deleteCandidates(candidates: CacheCandidate[]): Promise<number> {
  if (!candidates.length) return 0;
  const db = await openDb();
  if (!db) return 0;
  const metadata = await readMetadata();
  const removedByCategory = emptyUsage();
  let removedBytes = 0;
  for (const candidate of candidates) {
    removedByCategory[candidate.category].bytes += candidate.byteSize;
    removedByCategory[candidate.category].entries++;
    removedBytes += candidate.byteSize;
  }
  try {
    const tx = db.transaction([...CACHE_STORES, META_STORE], 'readwrite');
    for (const candidate of candidates) {
      tx.objectStore(candidate.store).delete(candidate.key);
      tx.objectStore(META_STORE).delete(entryMetaId(candidate.store, candidate.key));
      accessTouches.delete(entryMetaId(candidate.store, candidate.key));
    }
    const now = Date.now();
    const metaStore = tx.objectStore(META_STORE);
    for (const category of CACHE_CATEGORIES) {
      const removed = removedByCategory[category];
      const current = metadata.categories[category];
      metaStore.put({
        category,
        bytes: Math.max(0, current.bytes - removed.bytes),
        entries: Math.max(0, current.entries - removed.entries),
        updatedAt: now,
      } satisfies CacheMeta);
    }
    metaStore.put({
      category: 'total',
      bytes: Math.max(0, metadata.total.bytes - removedBytes),
      entries: Math.max(0, metadata.total.entries - candidates.length),
      updatedAt: now,
    } satisfies CacheMeta);
    await transactionDone(tx);
    return removedBytes;
  } catch (err) {
    log.warn(
      'Cache eviction failed',
      'event=persistence.cache.eviction.failed',
      'operation=evict',
      err,
    );
    return 0;
  }
}

async function removeExpiredRecord(store: CacheStore, key: IDBValidKey): Promise<void> {
  await enqueueMutation(async () => {
    const current = await readRawWithoutTouch(store, key);
    if (!current || current.expiresAt === null || current.expiresAt > Date.now()) return;
    await deleteCandidates([{
      store,
      key,
      category: categoryForStore(store),
      byteSize: current.byteSize,
      expiresAt: current.expiresAt,
      lastAccessedAt: current.lastAccessedAt,
    }]);
  });
}

interface PruneResult {
  freed: number;
  // Bytes of live channel lists the prune would have taken but kept.
  kept: number;
}

// Only a new channel list may evict a live one: losing it means downloading
// every channel again on the next start, which panels limit.
async function pruneBytes(targetBytes: number, incoming: CacheCategory): Promise<PruneResult> {
  if (targetBytes <= 0) return { freed: 0, kept: 0 };
  const now = Date.now();
  const all = await collectCandidates();
  const keep = (item: CacheCandidate) => incoming !== 'playlist' && item.category === 'playlist'
    && (item.expiresAt === null || item.expiresAt > now);
  const candidates = all.filter((item) => !keep(item));
  const selected: CacheCandidate[] = [];
  const selectedKeys = new Set<string>();
  let bytes = 0;
  const addUntilTarget = (items: CacheCandidate[]) => {
    for (const item of items) {
      if (bytes >= targetBytes) break;
      const id = `${item.store}|${String(item.key)}`;
      if (selectedKeys.has(id)) continue;
      selectedKeys.add(id);
      selected.push(item);
      bytes += item.byteSize;
    }
  };

  addUntilTarget(candidates
    .filter((item) => item.expiresAt !== null && item.expiresAt <= now)
    .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0)));
  for (const category of ['search', 'subtitle', 'catalog', 'epg', 'playlist'] as const) {
    addUntilTarget(candidates
      .filter((item) => item.category === category)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt));
  }
  let kept = 0;
  for (const item of all) if (keep(item)) kept += item.byteSize;
  return { freed: await deleteCandidates(selected), kept };
}

// False when the room could only come from a live channel list, in which
// case the incoming record is not written.
async function ensureCapacity(deltaBytes: number, incoming: CacheCategory): Promise<boolean> {
  if (deltaBytes <= 0) return true;
  const metadata = await readMetadata();
  const estimate = await cachedStorageEstimate();
  const budgetBytes = budgetForQuota(estimate.quota);
  const cacheOver = metadata.total.bytes + deltaBytes - budgetBytes;
  const originOver = estimate.quota !== null && estimate.usage !== null
    ? estimate.usage + deltaBytes - Math.floor(estimate.quota * 0.8)
    : 0;
  const required = Math.max(cacheOver, originOver);
  if (required > 0) {
    log.info(
      'Cache budget exceeded; pruning',
      'event=persistence.cache.budget.exceeded',
      'operation=evict',
      `requiredBytes=${required}`,
      `incomingBytes=${deltaBytes}`,
    );
    const pruned = await pruneBytes(
      required + Math.max(CLEANUP_MARGIN_BYTES, Math.floor(deltaBytes * 0.1)),
      incoming,
    );
    if (pruned.freed < required && pruned.kept > 0) {
      log.info(
        'Cache write skipped to keep the channel list',
        'event=persistence.cache.write.skipped',
        'reason=budget',
        `category=${incoming}`,
        `requiredBytes=${required}`,
        `freedBytes=${pruned.freed}`,
      );
      return false;
    }
  }
  return true;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (
    err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  );
}

async function commitRecord(
  store: CacheStore,
  record: StoredRecord,
  previous: CacheEntryMeta | null,
): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error('IndexedDB unavailable');
  const metadata = await readMetadata();
  const category = categoryForStore(store);
  const deltaBytes = record.byteSize - (previous?.byteSize ?? 0);
  const deltaEntries = previous ? 0 : 1;
  const categoryUsage = metadata.categories[category];
  const now = Date.now();
  const tx = db.transaction([store, META_STORE], 'readwrite');
  tx.objectStore(store).put(record);
  const key = record[cacheKeyPath(store)] as IDBValidKey;
  tx.objectStore(META_STORE).put(entryMeta(store, key, record));
  tx.objectStore(META_STORE).put({
    category,
    bytes: Math.max(0, categoryUsage.bytes + deltaBytes),
    entries: Math.max(0, categoryUsage.entries + deltaEntries),
    updatedAt: now,
  } satisfies CacheMeta);
  tx.objectStore(META_STORE).put({
    category: 'total',
    bytes: Math.max(0, metadata.total.bytes + deltaBytes),
    entries: Math.max(0, metadata.total.entries + deltaEntries),
    updatedAt: now,
  } satisfies CacheMeta);
  await transactionDone(tx, (error) => {
    if (store === CATALOG_STORE) {
      log.warn(
        'Catalog cache write aborted',
        'event=xtream.cache.write.aborted',
        'operation=write',
        'category=catalog',
        error,
      );
    }
  });
}

async function putRawNow(
  store: CacheStore,
  raw: Record<string, unknown>,
  allowQuotaRetry = true,
): Promise<boolean> {
  const key = raw[cacheKeyPath(store)] as IDBValidKey | undefined;
  if (key === undefined || key === null) return false;
  const db = await openDb();
  if (!db) {
    if (store === CATALOG_STORE) {
      log.warn(
        'Catalog cache is unavailable',
        'event=xtream.cache.unavailable',
        'operation=write',
      );
    }
    return false;
  }
  await ensureMetadata();
  const previous = await readEntryMeta(store, key);
  const record = normalizeRecord(store, raw);
  const category = categoryForStore(store);
  if (!await ensureCapacity(Math.max(0, record.byteSize - (previous?.byteSize ?? 0)), category)) {
    return false;
  }
  try {
    const latest = await readEntryMeta(store, key);
    await commitRecord(store, record, latest);
    return true;
  } catch (err) {
    if (allowQuotaRetry && isQuotaError(err)) {
      log.warn(
        'Cache quota exceeded; pruning before retry',
        'event=persistence.cache.quota.exceeded',
        'operation=write',
        `category=${categoryForStore(store)}`,
        `recordBytes=${record.byteSize}`,
      );
      await pruneBytes(record.byteSize + CLEANUP_MARGIN_BYTES, category);
      try {
        const latest = await readEntryMeta(store, key);
        await commitRecord(store, record, latest);
        return true;
      } catch (retryErr) {
        if (store === CATALOG_STORE) {
          log.warn(
            'Catalog cache write failed',
            'event=xtream.cache.write.failed',
            'operation=write',
            'category=catalog',
            'reason=quota_retry_failed',
            retryErr,
          );
        } else {
          log.error(
            'Cache write failed after quota cleanup',
            'event=persistence.cache.write.failed',
            'operation=write',
            `category=${categoryForStore(store)}`,
            'reason=quota_retry_failed',
            retryErr,
          );
        }
        return false;
      }
    }
    if (store === CATALOG_STORE) {
      log.warn(
        'Catalog cache write failed',
        'event=xtream.cache.write.failed',
        'operation=write',
        'category=catalog',
        err,
      );
    } else {
      log.warn(
        'Cache write failed',
        'event=persistence.cache.write.failed',
        'operation=write',
        `category=${categoryForStore(store)}`,
        err,
      );
    }
    return false;
  }
}

function putRaw(
  store: CacheStore,
  raw: Record<string, unknown>,
  allowQuotaRetry = true,
): Promise<boolean> {
  return enqueueMutation(() => putRawNow(store, raw, allowQuotaRetry));
}

async function readRawWithoutTouch(
  store: CacheStore,
  key: IDBValidKey,
): Promise<StoredRecord | null> {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(store, 'readonly');
  const raw = await requestResult(tx.objectStore(store).get(key)) as
    Record<string, unknown> | undefined;
  if (!raw) return null;
  return isNormalizedRecord(store, raw) ? raw : normalizeRecord(store, raw);
}

async function readStoreEntries(store: CacheStore): Promise<CacheEntryMeta[]> {
  const db = await openDb();
  if (!db) throw new Error('IndexedDB unavailable');
  await ensureMetadata();
  const tx = db.transaction(META_STORE, 'readonly');
  const records = await requestResult(tx.objectStore(META_STORE).getAll()) as unknown[];
  return records.filter((record): record is CacheEntryMeta =>
    isCacheEntryMeta(record) && record.store === store);
}

function usageOf(entries: CacheEntryMeta[]): { bytes: number; entries: number } {
  return entries.reduce((usage, entry) => ({
    bytes: usage.bytes + entry.byteSize,
    entries: usage.entries + 1,
  }), { bytes: 0, entries: 0 });
}

const SEARCH_SOURCE_STORES: readonly CacheStore[] = [PLAYLIST_STORE, EPG_STORE, CATALOG_STORE];
// Bumped when a source store is cleared, so an index write that was reserved
// before the clear but lands after it is removed on settle.
const sourceClearGenerations: Record<string, number> = {};

function indexSourceStore(key: string): string {
  return key.slice(0, Math.max(0, key.indexOf('|')));
}

async function clearStoreNow(store: CacheStore): Promise<void> {
  const db = await openDb();
  if (!db) throw new Error('IndexedDB unavailable');
  await ensureMetadata();
  const metadata = await readMetadata();
  const category = categoryForStore(store);
  const storeEntries = await readStoreEntries(store);
  const indexed = SEARCH_SOURCE_STORES.indexOf(store) >= 0;
  // A source's search indexes are keyed to its records, so they go with it.
  const indexEntries = indexed
    ? (await readStoreEntries(SEARCH_INDEX_STORE)).filter(entry =>
      typeof entry.key === 'string' && indexSourceStore(entry.key) === store)
    : [];
  const storeUsage = usageOf(storeEntries);
  const indexUsage = usageOf(indexEntries);
  const categoryUsage = metadata.categories[category];
  const searchUsage = metadata.categories.search;
  if (indexed) sourceClearGenerations[store] = (sourceClearGenerations[store] ?? 0) + 1;
  const tx = db.transaction(
    indexed ? [store, SEARCH_INDEX_STORE, META_STORE] : [store, META_STORE],
    'readwrite',
  );
  tx.objectStore(store).clear();
  if (indexed) {
    tx.objectStore(SEARCH_INDEX_STORE).delete(IDBKeyRange.bound(`${store}|`, `${store}|\uffff`));
  }
  for (const entry of [...storeEntries, ...indexEntries]) {
    tx.objectStore(META_STORE).delete(entry.category);
    accessTouches.delete(entry.category);
  }
  const now = Date.now();
  tx.objectStore(META_STORE).put({
    category,
    bytes: Math.max(0, categoryUsage.bytes - storeUsage.bytes),
    entries: Math.max(0, categoryUsage.entries - storeUsage.entries),
    updatedAt: now,
  } satisfies CacheMeta);
  if (indexEntries.length) {
    tx.objectStore(META_STORE).put({
      category: 'search',
      bytes: Math.max(0, searchUsage.bytes - indexUsage.bytes),
      entries: Math.max(0, searchUsage.entries - indexUsage.entries),
      updatedAt: now,
    } satisfies CacheMeta);
  }
  tx.objectStore(META_STORE).put({
    category: 'total',
    bytes: Math.max(0, metadata.total.bytes - storeUsage.bytes - indexUsage.bytes),
    entries: Math.max(0, metadata.total.entries - storeUsage.entries - indexUsage.entries),
    updatedAt: now,
  } satisfies CacheMeta);
  await transactionDone(tx);
}

function clearStore(store: CacheStore): Promise<void> {
  return enqueueMutation(() => clearStoreNow(store));
}

function playlistSourceSignature(): string {
  let source = '[]';
  try {
    source = localStorage.getItem(CONFIG.STORAGE_PREFIX + 'playlists') ?? '[]';
  } catch {
    // An unavailable localStorage produces a stable empty-source signature.
  }
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function getCachedEpg(url: string): Promise<CachedEpgEntry | null> {
  const raw = await readRaw(EPG_STORE, url);
  if (!raw) return null;
  return {
    url,
    timestamp: cacheRecordTimestamp(raw),
    data: raw.data as ParsedEpg,
    filter: raw.filter as CachedEpgFilter | null | undefined,
  };
}

export async function setCachedEpg(
  url: string,
  data: ParsedEpg,
  filter?: CachedEpgFilter | null,
  timestamp = Date.now(),
  refreshIntervalMs: number | null = CONFIG.DEFAULT_EPG_REFRESH_INTERVAL_MS,
): Promise<boolean> {
  return putRaw(EPG_STORE, {
    url,
    timestamp,
    data,
    filter,
    expiresAt: refreshIntervalMs === null ? null : timestamp + refreshIntervalMs,
  });
}

export async function clearCachedEpg(): Promise<void> {
  try {
    await clearStore(EPG_STORE);
  } catch (err) {
    log.warn(
      'EPG cache clear failed',
      'event=persistence.cache.clear.failed',
      'operation=clear',
      'category=epg',
      err,
    );
    throw err;
  }
}

async function readCatalogMetadata(key: string): Promise<CacheEntryMeta | null> {
  try {
    await ensureMetadata();
    return await readEntryMeta(CATALOG_STORE, key);
  } catch (error) {
    log.warn(
      'Catalog metadata read failed',
      'event=xtream.cache.read.failed',
      'operation=read',
      'category=catalog',
      'reason=metadata',
      error,
    );
    return null;
  }
}

export async function getCachedCatalog<T = unknown>(
  key: string,
): Promise<CachedCatalogEntry<T> | null> {
  const raw = await readRaw(CATALOG_STORE, key);
  if (!raw) return null;
  const timestamp = cacheRecordTimestamp(raw);
  const metadata = await readCatalogMetadata(key);
  const state = (metadata?.timestamp === timestamp ? catalogListState(metadata.state) : undefined)
    ?? catalogListState(raw.state);
  rememberRecord(raw.data, { store: CATALOG_STORE, key, timestamp });
  return {
    key,
    timestamp,
    data: raw.data as T,
    ...(state ? { state } : {}),
  };
}

export async function getCachedCatalogMetadata(key: string): Promise<CachedCatalogMetadata | null> {
  const metadata = await readCatalogMetadata(key);
  if (!metadata) return null;
  if (metadata.timestamp === undefined) {
    const cached = await getCachedCatalog(key);
    return cached ? { timestamp: cached.timestamp, ...(cached.state ? { state: cached.state } : {}) } : null;
  }
  const state = catalogListState(metadata.state);
  return { timestamp: metadata.timestamp, ...(state ? { state } : {}) };
}

function catalogListState(value: unknown): CatalogListState | undefined {
  const state = value as Partial<CatalogListState> | null | undefined;
  if (typeof state?.complete !== 'boolean'
    || typeof state.refreshAfter !== 'number' || !Number.isFinite(state.refreshAfter)) return undefined;
  return {
    complete: state.complete,
    refreshAfter: state.refreshAfter,
    ...(typeof state.freshSince === 'number' && Number.isFinite(state.freshSince)
      ? { freshSince: state.freshSince } : {}),
  };
}

export async function setCachedCatalog(
  key: string,
  data: unknown,
  ttlMs: number | null = CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  state?: CatalogListState,
): Promise<void> {
  const timestamp = Date.now();
  const stored = await putRaw(CATALOG_STORE, {
    key,
    timestamp,
    data,
    ...(state ? { state } : {}),
    expiresAt: ttlMs === null ? null : timestamp + ttlMs,
  });
  if (stored) rememberRecord(data, { store: CATALOG_STORE, key, timestamp });
}

export function setCachedCatalogState(
  key: string,
  sourceTimestamp: number,
  state: CatalogListState,
  ttlMs: number | null = CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
): Promise<boolean> {
  const generation = catalogGeneration;
  return enqueueMutation(async () => {
    await ensureMetadata();
    if (generation !== catalogGeneration) return false;
    const db = await openDb();
    if (!db) return false;
    try {
      const now = Date.now();
      const tx = db.transaction(META_STORE, 'readwrite');
      const metadata = tx.objectStore(META_STORE);
      const request = metadata.get(entryMetaId(CATALOG_STORE, key));
      let accepted = false;
      request.onsuccess = () => {
        const source: unknown = request.result;
        if (generation !== catalogGeneration || !isCacheEntryMeta(source)
          || source.timestamp !== sourceTimestamp) return;
        metadata.put({
          ...source,
          state,
          expiresAt: ttlMs === null ? null : now + ttlMs,
          lastAccessedAt: now,
        } satisfies CacheEntryMeta);
        accepted = true;
      };
      await transactionDone(tx);
      return accepted;
    } catch (error) {
      log.warn(
        'Catalog cache write failed',
        'event=xtream.cache.write.failed',
        'operation=write',
        'category=catalog',
        error,
      );
      return false;
    }
  });
}

let catalogGeneration = 0;

// Bumped on every clear so an in-flight background refresh can tell its
// response predates the clear and must not repopulate the store.
export function catalogCacheGeneration(): number {
  return catalogGeneration;
}

export function clearCachedCatalog(): Promise<void> {
  catalogGeneration++;
  return clearStore(CATALOG_STORE);
}

export async function getCachedStreamMime(routeKey: string): Promise<string | null> {
  if (!routeKey) return null;
  try {
    const raw = await readRaw(STREAM_MIME_STORE, routeKey);
    if (!raw) return null;
    if (raw.expiresAt !== null && raw.expiresAt <= Date.now()) {
      await removeExpiredRecord(STREAM_MIME_STORE, routeKey);
      return null;
    }
    const data = raw.data as Partial<StreamMimeEntry> | undefined;
    return data && typeof data.mime === 'string' ? data.mime : null;
  } catch (err) {
    log.warn(
      'Stream MIME cache read failed',
      'event=persistence.cache.read.failed',
      'operation=read',
      'category=catalog',
      err,
    );
    return null;
  }
}

export async function setCachedStreamMime(routeKey: string, mime: string): Promise<void> {
  if (!routeKey || !mime) return;
  const timestamp = Date.now();
  await putRaw(STREAM_MIME_STORE, {
    key: routeKey,
    timestamp,
    data: { mime, updatedAt: timestamp } satisfies StreamMimeEntry,
    expiresAt: timestamp + CONFIG.PLAYER.STREAM_MIME_CACHE_TTL,
  });
}

export function clearCachedStreamMimes(): Promise<void> {
  return clearStore(STREAM_MIME_STORE);
}

// TODO: Remove this localStorage cache migration after all supported installs use IndexedDB v4.
export async function migrateLegacyStreamMimeCache(): Promise<void> {
  const legacyKey = CONFIG.STORAGE_PREFIX + 'stream_mimes';
  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Partial<StreamMimeEntry>>;
    const now = Date.now();
    let migrated = 0;
    for (const routeKey of Object.keys(parsed)) {
      const entry = parsed[routeKey];
      const updatedAt = entry?.updatedAt;
      if (
        !routeKey
        || typeof entry?.mime !== 'string'
        || typeof updatedAt !== 'number'
        || !Number.isFinite(updatedAt)
        || now - updatedAt > CONFIG.PLAYER.STREAM_MIME_CACHE_TTL
      ) {
        continue;
      }
      const current = await readRawWithoutTouch(STREAM_MIME_STORE, routeKey);
      if (current && current.updatedAt >= updatedAt) continue;
      const stored = await putRaw(STREAM_MIME_STORE, {
        key: routeKey,
        timestamp: updatedAt,
        data: { mime: entry.mime, updatedAt },
        expiresAt: updatedAt + CONFIG.PLAYER.STREAM_MIME_CACHE_TTL,
      });
      if (!stored) return;
      migrated++;
    }
    localStorage.removeItem(legacyKey);
    log.info(
      'Legacy stream MIME cache migration completed',
      'event=persistence.cache.migration.completed',
      'operation=migrate',
      'category=catalog',
      `records=${migrated}`,
    );
  } catch (err) {
    log.warn(
      'Legacy stream MIME cache migration failed',
      'event=persistence.cache.migration.failed',
      'operation=migrate',
      'category=catalog',
      err,
    );
  }
}

export async function getCachedSubtitle(key: string): Promise<string | null> {
  const raw = await readRaw(SUBTITLE_STORE, key);
  if (raw && raw.expiresAt !== null && raw.expiresAt <= Date.now()) {
    await removeExpiredRecord(SUBTITLE_STORE, key);
    return null;
  }
  return raw && typeof raw.text === 'string' ? raw.text : null;
}

export async function setCachedSubtitle(key: string, text: string): Promise<void> {
  const timestamp = Date.now();
  await putRaw(SUBTITLE_STORE, {
    key,
    timestamp,
    text,
    expiresAt: timestamp + SUBTITLE_TTL_MS,
  });
}

export async function getCachedChannelHealth<T>(): Promise<Record<string, T>> {
  try {
    await mutationChain;
    const db = await openDb();
    if (!db) return {};
    const tx = db.transaction(CHANNEL_HEALTH_STORE, 'readonly');
    const raw = await requestResult(
      tx.objectStore(CHANNEL_HEALTH_STORE).getAll(),
    ) as Record<string, unknown>[];
    const records: Record<string, T> = {};
    for (const item of raw) {
      const key = item.key;
      if (typeof key === 'string' && item.data !== undefined) records[key] = item.data as T;
    }
    return records;
  } catch (err) {
    log.warn(
      'Channel health cache read failed',
      'event=persistence.cache.read.failed',
      'operation=read',
      'category=health',
      err,
    );
    return {};
  }
}

export async function setCachedChannelHealth<T>(records: Record<string, T>): Promise<void> {
  await Promise.all(Object.keys(records).map(key => putRaw(CHANNEL_HEALTH_STORE, {
    key,
    data: records[key],
    timestamp: Date.now(),
    expiresAt: null,
  })));
}

export async function clearCachedChannelHealth(): Promise<void> {
  await clearStore(CHANNEL_HEALTH_STORE);
}

export async function getCachedPlaylist(
  refreshIntervalMs: number | null = CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS,
): Promise<{
  channels: Channel[];
  epgSources: EpgSource[];
  timestamp: number;
} | null> {
  const raw = await readRaw(PLAYLIST_STORE, PLAYLIST_CACHE_KEY);
  if (raw) {
    const payload = raw.data as CachedPlaylistPayload | undefined;
    const timestamp = cacheRecordTimestamp(raw);
    if (
      payload?.sourceSignature === playlistSourceSignature()
      && payload.channels?.length
      && (refreshIntervalMs === null || Date.now() - timestamp < refreshIntervalMs)
    ) {
      rememberRecord(payload.channels, { store: PLAYLIST_STORE, key: PLAYLIST_CACHE_KEY, timestamp });
      return {
        channels: payload.channels,
        epgSources: payload.epgSources ?? [],
        timestamp,
      };
    }
  }

  return null;
}

export async function setCachedPlaylist(
  channels: Channel[],
  epgSources: EpgSource[] = [],
  timestamp = Date.now(),
  refreshIntervalMs: number | null = CONFIG.DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS,
): Promise<boolean> {
  return setCachedPlaylistWithSignature(
    channels,
    epgSources,
    timestamp,
    playlistSourceSignature(),
    refreshIntervalMs,
  );
}

function setCachedPlaylistWithSignature(
  channels: Channel[],
  epgSources: EpgSource[],
  timestamp: number,
  sourceSignature: string,
  refreshIntervalMs: number | null,
): Promise<boolean> {
  if (!channels.length) return Promise.resolve(false);
  return putRaw(PLAYLIST_STORE, {
    key: PLAYLIST_CACHE_KEY,
    timestamp,
    data: {
      sourceSignature,
      channels,
      epgSources,
      timestamp,
    } satisfies CachedPlaylistPayload,
    expiresAt: refreshIntervalMs === null ? null : timestamp + refreshIntervalMs,
  }).then((stored) => {
    if (stored) rememberRecord(channels, { store: PLAYLIST_STORE, key: PLAYLIST_CACHE_KEY, timestamp });
    return stored;
  });
}

export async function clearCachedPlaylist(): Promise<void> {
  discardScheduledPlaylist('cache_clear');
  playlistGeneration++;
  try {
    await clearStore(PLAYLIST_STORE);
  } catch (err) {
    log.warn(
      'Playlist cache clear failed',
      'event=persistence.cache.clear.failed',
      'operation=clear',
      'category=playlist',
      err,
    );
    throw err;
  }
  try {
    localStorage.removeItem(CONFIG.STORAGE_PREFIX + 'cached_playlist');
  } catch {
    // IndexedDB remains authoritative when Web Storage is unavailable.
  }
}

export async function clearAllCachedData(): Promise<void> {
  discardScheduledPlaylist('cache_clear');
  playlistGeneration++;
  catalogGeneration++;
  clearGeneration++;
  return enqueueMutation(async () => {
    try {
      localStorage.removeItem(CONFIG.STORAGE_PREFIX + 'cached_playlist');
    } catch {
      // Continue clearing IndexedDB when Web Storage is unavailable.
    }
    const db = await openDb();
    if (!db) throw new Error('IndexedDB unavailable');
    try {
      const tx = db.transaction([...CACHE_STORES, META_STORE], 'readwrite');
      for (const store of CACHE_STORES) tx.objectStore(store).clear();
      tx.objectStore(META_STORE).clear();
      await transactionDone(tx);
      metadataPromise = null;
      accessTouches.clear();
      storageEstimateCache = null;
      log.info(
        'Cache clear completed',
        'event=persistence.cache.clear.completed',
        'operation=clear',
        'scope=all',
      );
    } catch (err) {
      log.warn(
        'Cache clear failed',
        'event=persistence.cache.clear.failed',
        'operation=clear',
        'scope=all',
        err,
      );
      throw err;
    }
  });
}

export interface SearchIndexReservation {
  generation: number;
  sourceGeneration: number;
  fields: CacheFields;
  /** Older or expired index records removed to make way. */
  evicted: number;
}

// A search index is the lowest-priority cache entry: it replaces older indexes
// of its source and expired indexes, never evicts anything else, and is not
// stored when it would take more than its share of the room left.
export function reserveSearchIndex(
  candidate: SearchIndexCandidate,
): Promise<SearchIndexReservation | null> {
  const generation = clearGeneration;
  return enqueueMutation(async () => {
    if (generation !== clearGeneration || !candidate.prefix
        || candidate.key.indexOf(candidate.prefix) !== 0) {
      return null;
    }
    const db = await openDb();
    if (!db) return null;
    await ensureMetadata();
    const store = indexSourceStore(candidate.prefix);
    const sourceGeneration = sourceClearGenerations[store] ?? 0;
    if (SEARCH_SOURCE_STORES.indexOf(store as CacheStore) >= 0) {
      // An index built from a record that was cleared or replaced meanwhile
      // would be orphaned on arrival.
      const source = await readEntryMeta(
        store as CacheStore,
        candidate.prefix.slice(store.length + 1, -1),
      );
      const version = candidate.key.slice(candidate.prefix.length).split('|')[0];
      if (!source || (source.timestamp !== undefined && String(source.timestamp) !== version)) {
        log.info(
          'Search index not stored',
          'event=search.index.persist.skipped',
          'reason=source_changed',
          `bytes=${String(candidate.bytes)}`,
        );
        return null;
      }
    }
    const now = Date.now();
    const replaced = (await collectCandidates()).filter(item =>
      item.store === SEARCH_INDEX_STORE && (
        (typeof item.key === 'string' && item.key.indexOf(candidate.prefix) === 0)
        || (item.expiresAt !== null && item.expiresAt <= now)
      ));
    await deleteCandidates(replaced);
    try {
      // Also drops an index written without accounting, e.g. across a clear.
      const tx = db.transaction(SEARCH_INDEX_STORE, 'readwrite');
      tx.objectStore(SEARCH_INDEX_STORE)
        .delete(IDBKeyRange.bound(candidate.prefix, `${candidate.prefix}\uffff`));
      await transactionDone(tx);
    } catch (err) {
      log.warn(
        'Search index cleanup failed',
        'event=search.index.persist.skipped',
        'reason=cleanup_failed',
        `evicted=${String(replaced.length)}`,
        err,
      );
      return null;
    }
    const metadata = await readMetadata();
    const estimate = await cachedStorageEstimate();
    let room = budgetForQuota(estimate.quota) - metadata.total.bytes;
    if (estimate.quota !== null && estimate.usage !== null) {
      room = Math.min(room, Math.floor(estimate.quota * 0.8) - estimate.usage);
    }
    if (candidate.bytes <= 0 || candidate.bytes > room * CONFIG.SEARCH.INDEX_BUDGET_SHARE) {
      log.info(
        'Search index not stored',
        'event=search.index.persist.skipped',
        'reason=budget',
        `bytes=${String(candidate.bytes)}`,
        `roomBytes=${String(Math.max(0, room))}`,
        `evicted=${String(replaced.length)}`,
      );
      return null;
    }
    const fields: CacheFields = {
      cacheCategory: 'search',
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlFor('search'),
      byteSize: candidate.bytes,
    };
    const usage = metadata.categories.search;
    try {
      const tx = db.transaction(META_STORE, 'readwrite');
      const metaStore = tx.objectStore(META_STORE);
      metaStore.put(entryMeta(SEARCH_INDEX_STORE, candidate.key, { ...fields }));
      metaStore.put({
        category: 'search',
        bytes: usage.bytes + candidate.bytes,
        entries: usage.entries + 1,
        updatedAt: now,
      } satisfies CacheMeta);
      metaStore.put({
        category: 'total',
        bytes: metadata.total.bytes + candidate.bytes,
        entries: metadata.total.entries + 1,
        updatedAt: now,
      } satisfies CacheMeta);
      await transactionDone(tx);
    } catch (err) {
      log.warn(
        'Search index reservation failed',
        'event=search.index.persist.skipped',
        'reason=reservation_failed',
        `evicted=${String(replaced.length)}`,
        err,
      );
      return null;
    }
    return { generation, sourceGeneration, fields, evicted: replaced.length };
  });
}

// Settles a reservation once the app worker's write finished: a failed write
// gives the room back, and a write that raced a cache clear is removed.
export function settleSearchIndex(
  key: string,
  reservation: SearchIndexReservation,
  written: boolean,
): Promise<void> {
  return enqueueMutation(async () => {
    const cleared = reservation.generation !== clearGeneration
      || reservation.sourceGeneration !== (sourceClearGenerations[indexSourceStore(key)] ?? 0);
    if (written && !cleared) return;
    const db = await openDb();
    if (!db) return;
    const meta = cleared ? null : await readEntryMeta(SEARCH_INDEX_STORE, key);
    if (meta) {
      await deleteCandidates([{
        store: SEARCH_INDEX_STORE,
        key,
        category: 'search',
        byteSize: meta.byteSize,
        expiresAt: meta.expiresAt,
        lastAccessedAt: meta.lastAccessedAt,
      }]);
      return;
    }
    try {
      const tx = db.transaction(SEARCH_INDEX_STORE, 'readwrite');
      tx.objectStore(SEARCH_INDEX_STORE).delete(key);
      await transactionDone(tx);
    } catch {
      // A later reservation for the same source drops it.
    }
  });
}
