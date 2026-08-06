import type { PlaylistEntry, VodCategory, VodItem, VodInfo, SeriesCategory, SeriesItem, SeriesInfo } from '../types';
import {
  createXtreamClient,
  isXtreamRequestCancelled,
  XtreamRequestError,
} from './xtream-client';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('Catalog');

// Per-account cached catalog access. Categories are cheap and fetched up front;
// streams are fetched per category on demand. Each result is cached in
// IndexedDB (keyed `${accountId}|action[|param]`) and served while within TTL.
// On a failed/empty re-fetch we keep serving the stale copy rather than a blank.

function clientFor(a: PlaylistEntry) {
  return createXtreamClient(
    { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password },
    a.id,
  );
}

function fresh(timestamp: number): boolean {
  return Date.now() - timestamp < CONFIG.XTREAM.CATALOG_TTL_MS;
}

function resourceFor(key: string): string {
  return key.split('|')[1] || 'unknown';
}

// Serve a fresh cache hit; otherwise re-fetch a list, caching a non-empty result
// and falling back to the stale copy on an empty/failed re-fetch (logged, since
// the fallback is otherwise invisible — the caller just sees old data).
function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new XtreamRequestError('cancelled', 'Xtream request was cancelled');
  }
}

async function cachedList<T>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: () => Promise<T[]>,
): Promise<T[]> {
  ensureActive(signal);
  const cached = await getCachedCatalog<T[]>(key);
  ensureActive(signal);
  if (cached && fresh(cached.timestamp)) { log.debug('hit', key, `(${cached.data.length})`); return cached.data; }
  let data: T[];
  try {
    data = await refetch();
  } catch (err) {
    if (isXtreamRequestCancelled(err)) throw err;
    if (cached) {
      log.warn(
        'Catalog refresh failed; serving stale data',
        'event=xtream.catalog.stale',
        `resource=${resourceFor(key)}`,
        'reason=request_failed',
        `items=${cached.data.length}`,
        err,
      );
      return cached.data;
    }
    throw err;
  }
  ensureActive(signal);
  if (data.length) {
    await setCachedCatalog(key, data);
    log.debug('fetched', key, `(${data.length})`);
    return data;
  }
  if (cached) {
    log.warn(
      'Catalog refresh was empty; serving stale data',
      'event=xtream.catalog.stale',
      `resource=${resourceFor(key)}`,
      'reason=empty',
      `items=${cached.data.length}`,
    );
    return cached.data;
  }
  log.warn(
    'Catalog returned no items and has no cache',
    'event=xtream.catalog.empty',
    `resource=${resourceFor(key)}`,
  );
  return data;
}

// Single-object variant of cachedList: caches a truthy result, otherwise serves
// the stale copy (or null) on an empty/failed re-fetch.
async function cachedItem<T>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: () => Promise<T | null>,
): Promise<T | null> {
  ensureActive(signal);
  const cached = await getCachedCatalog<T>(key);
  ensureActive(signal);
  if (cached && fresh(cached.timestamp)) { log.debug('hit', key); return cached.data; }
  let data: T | null;
  try {
    data = await refetch();
  } catch (err) {
    if (isXtreamRequestCancelled(err)) throw err;
    if (cached) {
      log.warn(
        'Catalog detail refresh failed; serving stale data',
        'event=xtream.catalog.stale',
        `resource=${resourceFor(key)}`,
        'reason=request_failed',
        err,
      );
      return cached.data;
    }
    throw err;
  }
  ensureActive(signal);
  if (data) {
    await setCachedCatalog(key, data);
    log.debug('fetched', key);
    return data;
  }
  if (cached) {
    log.warn(
      'Catalog detail refresh was empty; serving stale data',
      'event=xtream.catalog.stale',
      `resource=${resourceFor(key)}`,
      'reason=empty',
    );
    return cached.data;
  }
  log.warn(
    'Catalog detail returned no item and has no cache',
    'event=xtream.catalog.empty',
    `resource=${resourceFor(key)}`,
  );
  return null;
}

export function loadVodCategories(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<VodCategory[]> {
  return cachedList(
    `${account.id}|vod_categories`,
    signal,
    () => clientFor(account).getVodCategories(signal),
  );
}

export function loadVodStreams(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|vod_streams|${categoryId}`,
    signal,
    () => clientFor(account).getVodStreams(categoryId, signal),
  );
}

export function loadVodInfo(
  account: PlaylistEntry,
  vodId: string,
  signal?: AbortSignal,
): Promise<VodInfo | null> {
  return cachedItem(
    `${account.id}|vod_info|${vodId}`,
    signal,
    () => clientFor(account).getVodInfo(vodId, signal),
  );
}

export function loadSeriesCategories(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<SeriesCategory[]> {
  return cachedList(
    `${account.id}|series_categories`,
    signal,
    () => clientFor(account).getSeriesCategories(signal),
  );
}

export function loadSeries(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|series|${categoryId}`,
    signal,
    () => clientFor(account).getSeries(categoryId, signal),
  );
}

export function loadSeriesInfo(
  account: PlaylistEntry,
  seriesId: string,
  signal?: AbortSignal,
): Promise<SeriesInfo | null> {
  return cachedItem(
    `${account.id}|series_info|${seriesId}`,
    signal,
    () => clientFor(account).getSeriesInfo(seriesId, signal),
  );
}

export function loadAllVodStreams(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|vod_all`,
    signal,
    () => clientFor(account).getVodStreams(undefined, signal),
  );
}

export function loadAllSeries(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|series_all`,
    signal,
    () => clientFor(account).getSeries(undefined, signal),
  );
}
