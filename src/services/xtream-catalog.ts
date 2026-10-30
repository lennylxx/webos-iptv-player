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
import {
  SERIES_CATALOG_RESOURCE,
  SERIES_RESOURCE,
  VOD_CATALOG_RESOURCE,
  VOD_STREAMS_RESOURCE,
} from './idb-schema';
import {
  CatalogTable,
  isCatalogColumns,
  sameCatalogColumns,
  type CatalogColumns,
} from './catalog-table';
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
  const expiresAt = (key: string) => {
    const held = heldCatalog(key);
    if (held) return Promise.resolve(held.fetchedAt + StorageService.getXtreamCatalogRefreshIntervalMs());
    return getCachedCatalogMetadata(key).then(cached => cached ? listExpiresAt(cached) : null);
  };
  const [vod, series] = await Promise.all([
    expiresAt(`${accountId}|${VOD_CATALOG_RESOURCE}`),
    expiresAt(`${accountId}|${SERIES_CATALOG_RESOURCE}`),
  ]);
  if (vod === null || series === null) return null;
  return Math.min(vod, series);
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

interface CatalogListResult<D> {
  data: D;
  state?: CatalogListState;
  unchanged?: boolean;
}

// A list is an item array, or a whole catalog stored by column.
type ListData = { length: number };

type RefetchList<D extends ListData> = (
  signal?: AbortSignal,
  cached?: CachedCatalogEntry<D>,
) => Promise<D | CatalogListResult<D>>;

function listResult<D extends ListData>(result: D | CatalogListResult<D>): CatalogListResult<D> {
  return Array.isArray(result) ? { data: result } : result as CatalogListResult<D>;
}

async function storeList<D extends ListData>(key: string, result: CatalogListResult<D>): Promise<void> {
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
function refreshListInBackground<D extends ListData>(
  key: string,
  cached: CachedCatalogEntry<D>,
  refetch: RefetchList<D>,
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
async function cachedList<D extends ListData>(
  key: string,
  signal: AbortSignal | undefined,
  refetch: RefetchList<D>,
  allowEmpty = false,
  valid: (data: unknown) => boolean = Array.isArray,
): Promise<D> {
  const generation = catalogCacheGeneration();
  ensureCatalogActive(generation, signal);
  const cached = await getCachedCatalog<D>(key);
  ensureCatalogActive(generation, signal);
  if (cached && valid(cached.data)) {
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

// Unfiltered lists download one at a time: two in flight at once can hold
// enough memory for webOS to kill the app.
let wholeCatalogQueue: Promise<void> = Promise.resolve();

function takeWholeCatalogTurn(): Promise<() => void> {
  let release = (): void => undefined;
  const done = new Promise<void>(resolve => { release = resolve; });
  const turn = wholeCatalogQueue.then(() => release);
  wholeCatalogQueue = wholeCatalogQueue.then(() => done);
  return turn;
}

// The search catalog is one unfiltered request per list, as other Xtream
// players make it. A failed list is not loaded by category instead: on a
// large panel that is hundreds of requests per search, enough for providers
// to block the account. It is asked for again after WHOLE_CATALOG_RETRY_MS.
async function fetchWholeCatalog(
  accountId: string,
  resource: 'vod_all' | 'series_all',
  signal: AbortSignal | undefined,
  fetchColumns: (signal?: AbortSignal) => Promise<CatalogColumns>,
  previous?: CatalogColumns,
): Promise<CatalogListResult<CatalogColumns>> {
  ensureActive(signal);
  const generation = catalogCacheGeneration();
  const failureKey = `${accountId}|${resource}`;
  const failedAt = StorageService.getWholeCatalogRefusedAt(failureKey);
  if (failedAt !== null && Date.now() - failedAt < CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS) {
    throw new XtreamRequestError('request_failed', 'Catalog list failed recently');
  }
  let data: CatalogColumns;
  const release = await takeWholeCatalogTurn();
  try {
    ensureCatalogActive(generation, signal);
    data = await fetchColumns(signal);
    if (!data.length) throw new XtreamRequestError('request_failed', 'Catalog list was empty');
  } catch (error) {
    ensureCatalogActive(generation, signal);
    if (isXtreamRequestCancelled(error)) throw error;
    const reason = error instanceof XtreamRequestError ? error.code : 'request_failed';
    log.warn(
      'Catalog list failed; it will be requested again later',
      'event=xtream.catalog.whole_failed',
      `resource=${resource}`,
      `reason=${reason}`,
      `retryMs=${CONFIG.XTREAM.WHOLE_CATALOG_RETRY_MS}`,
    );
    StorageService.setWholeCatalogRefusedAt(failureKey, Date.now());
    throw error;
  } finally {
    release();
  }
  ensureCatalogActive(generation, signal);
  const now = Date.now();
  const ttl = StorageService.getXtreamCatalogRefreshIntervalMs();
  return {
    data,
    unchanged: previous !== undefined && sameCatalogColumns(previous, data),
    state: { complete: true, refreshAfter: now + ttl, freshSince: now },
  };
}

// The latest whole catalog downloaded this session, by cache key. The cache
// often has no room for one next to the channel list, so this copy serves it
// until it expires instead of a download on every Search open.
interface HeldCatalog {
  columns: CatalogColumns;
  fetchedAt: number;
  generation: number;
}

const heldCatalogs = new Map<string, HeldCatalog>();
const wholeCatalogLoads = new Map<string, Promise<CatalogColumns>>();

function heldCatalog(key: string): HeldCatalog | null {
  const held = heldCatalogs.get(key);
  if (!held) return null;
  if (held.generation !== catalogCacheGeneration() || !fresh(held.fetchedAt)) {
    heldCatalogs.delete(key);
    return null;
  }
  return held;
}

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  ensureActive(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new XtreamRequestError('cancelled', 'Xtream request was cancelled'));
    signal.addEventListener('abort', abort);
    work.then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
  });
}

// One load per key at a time, detached from the caller: a startup preload
// and a Search open share one download, and closing Search keeps it going.
function loadWholeCatalog(
  account: PlaylistEntry,
  resource: 'vod_all' | 'series_all',
  signal: AbortSignal | undefined,
): Promise<CatalogColumns> {
  ensureActive(signal);
  const kind = resource === 'vod_all' ? 'vod' : 'series';
  const key = `${account.id}|${kind === 'vod' ? VOD_CATALOG_RESOURCE : SERIES_CATALOG_RESOURCE}`;
  const held = heldCatalog(key);
  if (held) return Promise.resolve(held.columns);
  let load = wholeCatalogLoads.get(key);
  if (!load) {
    const client = clientFor(account);
    const fetchColumns = kind === 'vod' ? client.getVodCatalog : client.getSeriesCatalog;
    load = cachedList<CatalogColumns>(
      key,
      undefined,
      async (requestSignal, cached) => {
        const generation = catalogCacheGeneration();
        const result = await fetchWholeCatalog(account.id, resource, requestSignal, fetchColumns, cached?.data);
        heldCatalogs.set(key, { columns: result.data, fetchedAt: Date.now(), generation });
        return result;
      },
      false,
      data => isCatalogColumns(data, kind),
    );
    const settled = load;
    wholeCatalogLoads.set(key, settled);
    const forget = () => {
      if (wholeCatalogLoads.get(key) === settled) wholeCatalogLoads.delete(key);
    };
    settled.then(forget, forget);
  }
  return untilAborted(load, signal);
}

export async function loadAllVodStreams(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<CatalogTable<VodItem>> {
  return new CatalogTable<VodItem>(await loadWholeCatalog(account, 'vod_all', signal));
}

export async function loadAllSeries(
  account: PlaylistEntry,
  signal?: AbortSignal,
): Promise<CatalogTable<SeriesItem>> {
  return new CatalogTable<SeriesItem>(await loadWholeCatalog(account, 'series_all', signal));
}

// Downloads the search catalog ahead of a Search open; a failure is left
// for Search to report and is not asked again within the retry window.
export function preloadSearchCatalog(account: PlaylistEntry): Promise<void> {
  return Promise.all([
    loadWholeCatalog(account, 'vod_all', undefined),
    loadWholeCatalog(account, 'series_all', undefined),
  ]).then(() => undefined, (error: unknown) => {
    log.info(
      'Search catalog preload failed',
      'event=xtream.catalog.preload.failed',
      `reason=${error instanceof XtreamRequestError ? error.code : 'request_failed'}`,
    );
  });
}
