import type { PlaylistEntry, VodCategory, VodItem, VodInfo, SeriesCategory, SeriesItem, SeriesInfo } from '../types';
import {
  createXtreamClient,
  isXtreamRequestCancelled,
  XtreamRequestError,
} from './xtream-client';
import {
  catalogCacheGeneration,
  getCachedCatalog,
  getCachedCatalogMetadata,
  setCachedCatalog,
  setCachedCatalogState,
  type CachedCatalogEntry,
  type CachedCatalogMetadata,
  type CatalogListState,
} from './idb-cache';
import { SERIES_RESOURCE, VOD_STREAMS_RESOURCE } from './idb-schema';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';

const log = createLogger('Catalog');

// Per-account cached catalog access. Categories are cheap and fetched up front;
// streams are fetched per category on demand. Each result is cached in
// IndexedDB (keyed `${accountId}|action[|param]`). Expired lists are served
// at once and refreshed in the background; expired details are re-fetched
// first. Failed re-fetches keep stale data; successful empty item lists clear it.

function clientFor(a: PlaylistEntry) {
  return createXtreamClient(
    { baseUrl: a.url, username: a.xtream!.username, password: a.xtream!.password },
    a.id,
  );
}

function fresh(timestamp: number): boolean {
  return Date.now() - timestamp < StorageService.getXtreamCatalogRefreshIntervalMs();
}

function listExpiresAt(cached: CachedCatalogMetadata): number {
  if (cached.state && !cached.state.complete) return cached.state.refreshAfter;
  return Math.min(
    (cached.state?.freshSince ?? cached.timestamp)
      + StorageService.getXtreamCatalogRefreshIntervalMs(),
    cached.state?.refreshAfter ?? Infinity,
  );
}

export async function getSearchCatalogExpiresAt(
  accountId: string,
): Promise<number | null> {
  const [vod, series] = await Promise.all([
    getCachedCatalogMetadata(`${accountId}|vod_all`),
    getCachedCatalogMetadata(`${accountId}|series_all`),
  ]);
  if (!vod || !series) return null;
  return Math.min(listExpiresAt(vod), listExpiresAt(series));
}

function resourceFor(key: string): string {
  return (key.split('|')[1] || 'unknown').replace(/-v\d+$/, '');
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new XtreamRequestError('cancelled', 'Xtream request was cancelled');
  }
}

function ensureCatalogActive(generation: number, signal?: AbortSignal): void {
  ensureActive(signal);
  if (generation !== catalogCacheGeneration()) {
    throw new XtreamRequestError('cancelled', 'Catalog cache was cleared');
  }
}

interface CatalogListResult<T> {
  data: T[];
  state?: CatalogListState;
  unchanged?: boolean;
}

type RefetchList<T> = (
  signal?: AbortSignal,
  cached?: CachedCatalogEntry<T[]>,
) => Promise<T[] | CatalogListResult<T>>;

function listResult<T>(result: T[] | CatalogListResult<T>): CatalogListResult<T> {
  return Array.isArray(result) ? { data: result } : result;
}

async function storeList<T>(key: string, result: CatalogListResult<T>): Promise<void> {
  const ttl = StorageService.getXtreamCatalogRefreshIntervalMs();
  if (result.state) await setCachedCatalog(key, result.data, ttl, result.state);
  else await setCachedCatalog(key, result.data, ttl);
}

const queuedRefreshKeys = new Set<string>();
const refreshQueue: Array<() => Promise<void>> = [];
let activeRefreshes = 0;

// Large lists can each be tens of megabytes, so stale ones are re-fetched a
// few at a time instead of all at once when Movies, Series, and Search open.
function pumpRefreshQueue(): void {
  while (
    activeRefreshes < CONFIG.XTREAM.BACKGROUND_REFRESH_CONCURRENCY
    && refreshQueue.length
  ) {
    const run = refreshQueue.shift()!;
    activeRefreshes++;
    const done = (): void => {
      activeRefreshes--;
      pumpRefreshQueue();
    };
    run().then(done, done);
  }
}

const refreshListeners: Array<(key: string, changed?: boolean) => void> = [];
const writeListeners: Array<(key: string) => void> = [];

/** Called with the cache key whenever a fetched or refreshed list is stored. */
export function onCatalogListWritten(listener: (key: string) => void): () => void {
  writeListeners.push(listener);
  return () => {
    const index = writeListeners.indexOf(listener);
    if (index >= 0) writeListeners.splice(index, 1);
  };
}

function notifyListWritten(key: string): void {
  for (const listener of writeListeners) listener(key);
}

/** A false second argument means only freshness changed, not the indexed data. */
export function onCatalogListRefreshed(listener: (key: string, changed?: boolean) => void): () => void {
  refreshListeners.push(listener);
  return () => {
    const index = refreshListeners.indexOf(listener);
    if (index >= 0) refreshListeners.splice(index, 1);
  };
}

// Refresh independently of the view. Unchanged catalogs only renew freshness,
// preserving the payload version and its prepared worker index.
function refreshListInBackground<T>(
  key: string,
  cached: CachedCatalogEntry<T[]>,
  refetch: RefetchList<T>,
  allowEmpty: boolean,
): void {
  if (queuedRefreshKeys.has(key)) return;
  queuedRefreshKeys.add(key);
  const generation = catalogCacheGeneration();
  refreshQueue.push(async () => {
    try {
      if (generation !== catalogCacheGeneration()) return;
      const result = listResult(await refetch(undefined, cached));
      const { data } = result;
      if (generation !== catalogCacheGeneration()) return;
      if (!data.length && !result.state && !allowEmpty) {
        log.warn(
          'Catalog refresh was empty; keeping stale data',
          'event=xtream.catalog.stale',
          `resource=${resourceFor(key)}`,
          'reason=empty',
          `items=${cached.data.length}`,
        );
        return;
      }
      // Legacy snapshots need one write to acquire the list-state marker.
      if (result.unchanged && result.state && cached.state) {
        const accepted = await setCachedCatalogState(
          key, cached.timestamp, result.state, StorageService.getXtreamCatalogRefreshIntervalMs(),
        );
        if (generation !== catalogCacheGeneration()) return;
        if (!accepted) {
          log.debug('Catalog freshness update was not accepted', key);
          return;
        }
        for (const listener of refreshListeners) listener(key, false);
        return;
      }
      await storeList(key, result);
      log.debug('refreshed', key, `(${data.length})`);
      if (generation !== catalogCacheGeneration()) return;
      notifyListWritten(key);
      for (const listener of refreshListeners) listener(key);
    } catch (err) {
      if (generation !== catalogCacheGeneration()) return;
      log.warn(
        'Catalog refresh failed; keeping stale data',
        'event=xtream.catalog.stale',
        `resource=${resourceFor(key)}`,
        'reason=request_failed',
        `items=${cached.data.length}`,
        err,
      );
    } finally {
      queuedRefreshKeys.delete(key);
    }
  });
  pumpRefreshQueue();
}

// Serve any cached list at once, re-fetching an expired one in the background;
// only a cold cache waits on the network.
async function cachedList<T>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: RefetchList<T>,
  allowEmpty = false,
): Promise<T[]> {
  const generation = catalogCacheGeneration();
  ensureCatalogActive(generation, signal);
  const cached = await getCachedCatalog<T[]>(key);
  ensureCatalogActive(generation, signal);
  if (cached) {
    if (Date.now() >= listExpiresAt(cached)) refreshListInBackground(key, cached, refetch, allowEmpty);
    log.debug('hit', key, `(${cached.data.length})`);
    return cached.data;
  }
  const result = listResult(await refetch(signal));
  const { data } = result;
  ensureCatalogActive(generation, signal);
  if (data.length || result.state || allowEmpty) {
    await storeList(key, result);
    log.debug('fetched', key, `(${data.length})`);
    notifyListWritten(key);
    return data;
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
    await setCachedCatalog(key, data, StorageService.getXtreamCatalogRefreshIntervalMs());
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
    requestSignal => clientFor(account).getVodCategories(requestSignal),
  );
}

export function loadVodStreams(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|${VOD_STREAMS_RESOURCE}|${categoryId}`,
    signal,
    requestSignal => clientFor(account).getVodStreams(categoryId, requestSignal),
    true,
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
    requestSignal => clientFor(account).getSeriesCategories(requestSignal),
  );
}

export function loadSeries(
  account: PlaylistEntry,
  categoryId: string,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|${SERIES_RESOURCE}|${categoryId}`,
    signal,
    requestSignal => clientFor(account).getSeries(categoryId, requestSignal),
    true,
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

type CatalogPartition<T> =
  | { ok: true; data: T[]; expiresAt: number }
  | { ok: false; data: T[]; available: boolean; error: unknown; deferred: boolean };

interface CatalogLoadContext {
  generation: number;
  signal: AbortSignal | undefined;
  requestSignal: AbortSignal;
  timedOut: () => boolean;
}

const partitionQueue: Array<() => void> = [];
let activePartitions = 0;

function pumpPartitions(): void {
  while (activePartitions < CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY && partitionQueue.length) {
    partitionQueue.shift()!();
  }
}

function requestPartition<T>(signal: AbortSignal, request: () => Promise<T[]>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const cancelled = (): void => {
      const index = partitionQueue.indexOf(run);
      if (index >= 0) partitionQueue.splice(index, 1);
      signal.removeEventListener('abort', cancelled);
      reject(new XtreamRequestError('cancelled', 'Catalog request was cancelled'));
    };
    const run = (): void => {
      signal.removeEventListener('abort', cancelled);
      if (signal.aborted) {
        cancelled();
        return;
      }
      activePartitions++;
      const done = (): void => {
        activePartitions--;
        pumpPartitions();
      };
      Promise.resolve().then(request).then(resolve, reject).then(done, done);
    };
    if (signal.aborted) {
      cancelled();
      return;
    }
    signal.addEventListener('abort', cancelled);
    partitionQueue.push(run);
    pumpPartitions();
  });
}

async function fetchPartition<T>(
  key: string,
  context: CatalogLoadContext,
  refetch: (signal?: AbortSignal) => Promise<T[]>,
  previous?: T[],
  keepStaleOnEmpty = false,
): Promise<CatalogPartition<T>> {
  const { generation, signal } = context;
  const cached = await getCachedCatalog<T[]>(key);
  ensureCatalogActive(generation, signal);
  if (cached && fresh(cached.timestamp)) {
    return { ok: true, data: cached.data, expiresAt: listExpiresAt(cached) };
  }
  const stale = cached?.data ?? previous;
  const budgetError = (): XtreamRequestError =>
    new XtreamRequestError('timeout', 'Catalog load exceeded its time budget');
  if (context.timedOut()) {
    return {
      ok: false, data: stale ?? [], available: stale !== undefined,
      error: budgetError(), deferred: true,
    };
  }
  let data: T[];
  try {
    data = await refetch(context.requestSignal);
    ensureCatalogActive(generation, signal);
    if (keepStaleOnEmpty && !data.length) {
      if (stale?.length) {
        log.warn(
          'Catalog refresh was empty; keeping stale data',
          'event=xtream.catalog.stale',
          `resource=${resourceFor(key)}`,
          'reason=empty',
          `items=${stale.length}`,
        );
      }
      throw new XtreamRequestError('request_failed', 'Catalog refresh returned no items');
    }
  } catch (error) {
    ensureCatalogActive(generation, signal);
    const deferred = context.timedOut();
    if (isXtreamRequestCancelled(error) && !deferred) throw error;
    return {
      ok: false, data: stale ?? [], available: stale !== undefined,
      error: deferred ? budgetError() : error, deferred,
    };
  }
  const expiresAt = Date.now() + StorageService.getXtreamCatalogRefreshIntervalMs();
  await setCachedCatalog(key, data, StorageService.getXtreamCatalogRefreshIntervalMs());
  ensureCatalogActive(generation, signal);
  notifyListWritten(key);
  return { ok: true, data, expiresAt };
}

async function fetchWholeCatalog<T extends { categoryId: string }>(
  accountId: string,
  resource: 'vod_all' | 'series_all',
  signal: AbortSignal | undefined,
  fetchItems: (categoryId?: string, signal?: AbortSignal) => Promise<T[]>,
  fetchCategories: (signal?: AbortSignal) => Promise<Array<{ id: string }>>,
  itemId: (item: T) => string,
  previous?: T[],
): Promise<CatalogListResult<T>> {
  ensureActive(signal);
  const whole = await fetchUnpartitionedCatalog(accountId, resource, signal, fetchItems, itemId, previous);
  if (whole) return whole;
  const controller = new AbortController();
  const deadline = Date.now() + CONFIG.XTREAM.CATALOG_LOAD_BUDGET_MS;
  let expired = false;
  const expire = (): void => {
    expired = true;
    controller.abort();
  };
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel);
  const timer = setTimeout(expire, CONFIG.XTREAM.CATALOG_LOAD_BUDGET_MS);
  const context: CatalogLoadContext = {
    generation: catalogCacheGeneration(),
    signal,
    requestSignal: controller.signal,
    timedOut: () => {
      if (!expired && Date.now() >= deadline) expire();
      return expired;
    },
  };
  try {
    return await fetchCatalogPartitions(
      accountId, resource, context, fetchItems, fetchCategories, itemId, previous,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

// One request for the whole list beats one per category by minutes on a
// large panel. A panel whose whole list fails (too large, too slow, or
// refused) loads by category instead, and keeps doing so for a while.
async function fetchUnpartitionedCatalog<T extends object>(
  accountId: string,
  resource: 'vod_all' | 'series_all',
  signal: AbortSignal | undefined,
  fetchItems: (categoryId?: string, signal?: AbortSignal) => Promise<T[]>,
  itemId: (item: T) => string,
  previous?: T[],
): Promise<CatalogListResult<T> | null> {
  const generation = catalogCacheGeneration();
  const fallbackKey = `${accountId}|${resource}_by_category`;
  const fallback = await getCachedCatalog<{ reason: string }>(fallbackKey);
  ensureCatalogActive(generation, signal);
  if (fallback && Date.now() - fallback.timestamp < CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS) return null;
  let data: T[];
  try {
    data = await fetchItems(undefined, signal);
  } catch (error) {
    ensureCatalogActive(generation, signal);
    if (isXtreamRequestCancelled(error)) throw error;
    const reason = error instanceof XtreamRequestError ? error.code : 'request_failed';
    log.info(
      'Whole catalog request failed; loading by category',
      'event=xtream.catalog.by_category',
      `resource=${resource}`,
      `reason=${reason}`,
    );
    await setCachedCatalog(fallbackKey, { reason }, CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS);
    ensureCatalogActive(generation, signal);
    return null;
  }
  ensureCatalogActive(generation, signal);
  // Some panels answer an unfiltered request with nothing; categories decide.
  if (!data.length) return null;
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const id = itemId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  const now = Date.now();
  const ttl = StorageService.getXtreamCatalogRefreshIntervalMs();
  return {
    data: result,
    unchanged: previous !== undefined && sameCatalogItems(previous, result),
    state: { complete: true, refreshAfter: now + ttl, freshSince: now },
  };
}

function sameCatalogItems<T extends object>(left: T[], right: T[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const keys = Object.keys(left[i]) as Array<keyof T>;
    if (keys.length !== Object.keys(right[i]).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(right[i], key) || left[i][key] !== right[i][key]) {
        return false;
      }
    }
  }
  return true;
}

async function fetchCatalogPartitions<T extends { categoryId: string }>(
  accountId: string,
  resource: 'vod_all' | 'series_all',
  context: CatalogLoadContext,
  fetchItems: (categoryId: string, signal?: AbortSignal) => Promise<T[]>,
  fetchCategories: (signal?: AbortSignal) => Promise<Array<{ id: string }>>,
  itemId: (item: T) => string,
  previous?: T[],
): Promise<CatalogListResult<T>> {
  const { generation, signal } = context;
  const oldPartitions = new Map<string, T[]>();
  for (const item of previous ?? []) {
    const partition = oldPartitions.get(item.categoryId);
    if (partition) partition.push(item);
    else oldPartitions.set(item.categoryId, [item]);
  }
  const categoryResource = resource === 'vod_all' ? 'vod_categories' : 'series_categories';
  const itemResource = resource === 'vod_all' ? VOD_STREAMS_RESOURCE : SERIES_RESOURCE;
  const oldCategories = Array.from(oldPartitions.keys())
    .filter(id => !!id)
    .map(id => ({ id }));
  const cursorKey = `${accountId}|${resource}_cursor`;
  const [categories, cursor] = await Promise.all([
    fetchPartition(
      `${accountId}|${categoryResource}`, context, fetchCategories,
      oldCategories.length ? oldCategories : undefined,
      true,
    ),
    getCachedCatalog<{ nextCategory: string }>(cursorKey),
  ]);
  ensureCatalogActive(generation, signal);
  if (!categories.ok && !categories.available) throw categories.error;
  const categoryIds = Array.from(new Set(categories.data.map(category => category.id)));
  const start = Math.max(0, categoryIds.indexOf(cursor?.data.nextCategory ?? ''));
  const partitions = new Map<string, CatalogPartition<T>>();
  let next = 0;
  let lastStarted: string | null = null;
  const load = async (): Promise<void> => {
    while (next < categoryIds.length) {
      const categoryId = categoryIds[(start + next++) % categoryIds.length];
      ensureCatalogActive(generation, signal);
      const partition = await fetchPartition(
        `${accountId}|${itemResource}|${categoryId}`, context,
        requestSignal => requestPartition(context.requestSignal, () => {
          ensureCatalogActive(generation, signal);
          ensureActive(context.requestSignal);
          lastStarted = categoryId;
          return fetchItems(categoryId, requestSignal);
        }),
        oldPartitions.get(categoryId),
      );
      partitions.set(categoryId, partition);
    }
  };
  const loads: Array<Promise<void>> = [];
  for (let i = 0; i < CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY; i++) loads.push(load());
  await Promise.all(loads);
  ensureCatalogActive(generation, signal);
  const result: T[] = [];
  const seen = new Set<string>();
  let expiresAt = categories.ok ? categories.expiresAt : 0;
  let failure = categories.ok ? null : { error: categories.error };
  let failed = 0;
  let stale = 0;
  let available = 0;
  let deferred = 0;
  // Merge in server order, not completion order, so cached indexes stay stable.
  for (const categoryId of categoryIds) {
    const partition = partitions.get(categoryId)!;
    if (partition.ok) {
      available++;
      expiresAt = Math.min(expiresAt, partition.expiresAt);
    } else {
      failed++;
      if (partition.deferred) deferred++;
      if (!failure) failure = { error: partition.error };
      if (partition.available) {
        available++;
        stale++;
      }
    }
    for (const item of partition.data) {
      const id = itemId(item);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(item);
    }
  }
  if (failure) {
    const budgetExhausted = context.timedOut();
    if (budgetExhausted && categoryIds.length) {
      // Rotate past attempted requests even if none succeeded, so slow early
      // categories cannot starve the rest on every retry.
      const resume = lastStarted === null ? start : (categoryIds.indexOf(lastStarted) + 1) % categoryIds.length;
      await setCachedCatalog(cursorKey, { nextCategory: categoryIds[resume] },
        StorageService.getXtreamCatalogRefreshIntervalMs());
      ensureCatalogActive(generation, signal);
    }
    log.warn(
      'Catalog is incomplete; failed partitions will be retried',
      'event=xtream.catalog.partial',
      `resource=${resource}`,
      `categories=${categoryIds.length}`,
      `failed=${failed}`,
      `stale=${stale}`,
      `missing=${failed - stale}`,
      `categoryListFailed=${String(!categories.ok)}`,
      `deferred=${deferred}`,
      `budgetExhausted=${String(budgetExhausted)}`,
    );
    if (categoryIds.length && !available) throw failure.error;
  }
  return {
    data: result,
    unchanged: previous !== undefined && sameCatalogItems(previous, result),
    state: {
      complete: !failure,
      refreshAfter: failure ? Date.now() + CONFIG.XTREAM.CATALOG_RETRY_DELAY_MS : expiresAt,
      ...(!failure ? {
        freshSince: expiresAt - StorageService.getXtreamCatalogRefreshIntervalMs(),
      } : {}),
    },
  };
}

export function loadAllVodStreams(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<VodItem[]> {
  return cachedList(
    `${account.id}|vod_all`,
    signal,
    (requestSignal, cached) => {
      const client = clientFor(account);
      return fetchWholeCatalog(
        account.id,
        'vod_all',
        requestSignal,
        client.getVodStreams,
        client.getVodCategories,
        item => item.streamId,
        cached?.data,
      );
    },
  );
}

export function loadAllSeries(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<SeriesItem[]> {
  return cachedList(
    `${account.id}|series_all`,
    signal,
    (requestSignal, cached) => {
      const client = clientFor(account);
      return fetchWholeCatalog(
        account.id,
        'series_all',
        requestSignal,
        client.getSeries,
        client.getSeriesCategories,
        item => item.seriesId,
        cached?.data,
      );
    },
  );
}
