import { FetchTextError, fetchLimitedText, fetchLimitedTextStream } from '../utils/fetch-helper';
import { JsonArrayStream, JsonArrayStreamError } from '../utils/json-array-stream';
import { CatalogColumnsBuilder, type CatalogColumns } from './catalog-table';
import { xtreamPlayerApi, type XtreamCredentials } from '../utils/xtream-url';
import { createLogger } from '../utils/logger';
import type { VodCategory, VodItem, VodInfo, SeriesCategory, SeriesItem, SeriesInfo, Episode, SidecarSubtitle } from '../types';
import { CONFIG } from '../config';

const log = createLogger('Xtream');

// Account check is an interactive "verify these credentials" call, so fail fast.
const ACCOUNT_INFO_TIMEOUT = 15000;
// Catalog calls can be large; use the default network timeout.
const CATALOG_TIMEOUT = 30000;

export type XtreamRequestErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'too_large'
  | 'invalid_json'
  | 'request_failed';

export class XtreamRequestError extends Error {
  constructor(
    public readonly code: XtreamRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XtreamRequestError';
  }
}

export function isXtreamRequestCancelled(err: unknown): boolean {
  return err instanceof XtreamRequestError && err.code === 'cancelled';
}

/** Account status from the portal's `user_info`, normalized for display. */
export interface XtreamAccountInfo {
  /** False = the panel reached us but rejected the credentials (`auth: 0`). */
  auth: boolean;
  status: string;
  /** Unix seconds, or null for an unlimited/non-expiring account. */
  expiresAt: number | null;
  maxConnections: number;
  activeConnections: number;
  allowedOutputFormats: string[];
}

export interface XtreamLiveStream {
  streamId: string;
  name: string;
  icon: string;
  epgChannelId: string;
  categoryId: string;
  /** `category_id` plus any extra ids from a panel's `category_ids` array. */
  categoryIds: string[];
  directSource: string;
  archive: boolean;
  archiveDurationDays: number;
}

export interface XtreamLiveCatalogResult {
  available: boolean;
  streams: XtreamLiveStream[];
}

export interface XtreamLiveCategory {
  id: string;
  name: string;
  parentId: string;
}

export interface XtreamServerClock {
  timeZone: string;
  offsetMinutes: number | null;
}

export interface XtreamArchiveListing {
  start: number;
  stop: number;
  hasArchive: boolean | null;
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function catalogTimestamp(value: unknown): number | null {
  const text = toStr(value).trim();
  let timestamp = NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    // Xtream sends Unix seconds; larger values are already milliseconds.
    timestamp = number < 1e12 ? number * 1000 : number;
  } else if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    timestamp = Date.parse(text);
  }
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function catalogYear(value: unknown): number | null {
  const match = /^(\d{4})(?:$|[-/.T ])/.exec(toStr(value).trim());
  const year = match ? Number(match[1]) : 0;
  return year > 0 ? year : null;
}

function firstValid<T>(parse: (value: unknown) => T | null, ...values: unknown[]): T | null {
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

// List-level sort metadata only; series lists use last_modified when added is absent.
function catalogSortMetadata(item: Record<string, unknown>, series = false): {
  addedAt?: number;
  year?: number;
} {
  const addedAt = firstValid(catalogTimestamp, item.added, series ? item.last_modified : undefined);
  const year = firstValid(
    catalogYear, item.year, item.releaseDate, item.release_date, item.releasedate,
  );
  return {
    ...(addedAt !== null ? { addedAt } : {}),
    ...(year !== null ? { year } : {}),
  };
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = toStr(value);
    if (text.trim()) return text;
  }
  return '';
}

function mapFetchError(err: unknown): XtreamRequestError {
  if (err instanceof XtreamRequestError) return err;
  if (err instanceof FetchTextError) {
    if (err.code === 'aborted') {
      return new XtreamRequestError('cancelled', 'Xtream request was cancelled');
    }
    if (err.code === 'timeout') {
      return new XtreamRequestError('timeout', 'Xtream request timed out');
    }
    if (err.code === 'too_large') {
      return new XtreamRequestError('too_large', 'Xtream response exceeded its size limit');
    }
  }
  return new XtreamRequestError('request_failed', 'Xtream request failed');
}

function diagnosticEndpoint(url: string): string {
  try {
    return new URL(url).searchParams.get('action') || 'account_info';
  } catch {
    return 'unknown';
  }
}

function logRequestFailure(
  url: string,
  error: XtreamRequestError,
  timeout: number,
  maxBytes: number,
): void {
  if (error.code === 'cancelled') return;
  log.warn(
    'Xtream request failed',
    'event=xtream.request.failed',
    `endpoint=${diagnosticEndpoint(url)}`,
    `code=${error.code}`,
    `timeoutMs=${timeout}`,
    `limitBytes=${maxBytes}`,
  );
}

async function fetchJsonStrict(
  url: string,
  timeout: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  let text: string;
  try {
    text = await fetchLimitedText(url, maxBytes, timeout, signal);
  } catch (err) {
    const requestError = mapFetchError(err);
    logRequestFailure(url, requestError, timeout, maxBytes);
    throw requestError;
  }
  try {
    return JSON.parse(text);
  } catch {
    const requestError =
      new XtreamRequestError('invalid_json', 'Xtream response was not valid JSON');
    logRequestFailure(url, requestError, timeout, maxBytes);
    throw requestError;
  }
}

// Tolerant metadata callers model unsupported endpoints as null/empty.
// Cancellation still propagates to the request owner.
async function fetchJson(
  url: string,
  timeout: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    return await fetchJsonStrict(url, timeout, maxBytes, signal);
  } catch (err) {
    if (isXtreamRequestCancelled(err)) throw err;
    return null;
  }
}

// Catalog lists are parsed one element at a time as they download and mapped
// at once to the few fields the app keeps, so a list of tens of megabytes
// never sits in memory as one string or as its raw parsed objects.
async function streamCatalogList(
  url: string,
  maxBytes: number,
  timeout: number,
  idField: 'category_id' | 'stream_id' | 'series_id',
  onItem: (item: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let objects = 0;
  let withId = 0;
  const parser = new JsonArrayStream(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    objects++;
    if (toStr(item[idField]) !== '') withId++;
    onItem(item);
  });
  try {
    await fetchLimitedTextStream(url, maxBytes, timeout, signal, text => parser.push(text));
    parser.finish();
  } catch (err) {
    const requestError = err instanceof JsonArrayStreamError
      ? err.code === 'not_array'
        ? new XtreamRequestError('request_failed', 'Xtream catalog response was not a valid list')
        : new XtreamRequestError('invalid_json', 'Xtream response was not valid JSON')
      : mapFetchError(err);
    logRequestFailure(url, requestError, timeout, maxBytes);
    throw requestError;
  }
  if (objects && !withId) {
    const error = new XtreamRequestError('request_failed', 'Xtream catalog response was not a valid list');
    logRequestFailure(url, error, timeout, maxBytes);
    throw error;
  }
}

async function fetchCatalogList<T>(
  url: string,
  maxBytes: number,
  timeout: number,
  idField: 'category_id' | 'stream_id' | 'series_id',
  map: (item: Record<string, unknown>) => T | null,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  await streamCatalogList(url, maxBytes, timeout, idField, (item) => {
    const mapped = map(item);
    if (mapped !== null) items.push(mapped);
  }, signal);
  return items;
}

function vodItem(accountId: string, s: Record<string, unknown>): VodItem | null {
  const streamId = toStr(s.stream_id);
  return streamId ? {
    accountId,
    streamId,
    name: toStr(s.name),
    poster: toStr(s.stream_icon),
    rating: toStr(s.rating),
    categoryId: toStr(s.category_id),
    containerExtension: toStr(s.container_extension),
    ...catalogSortMetadata(s),
  } : null;
}

function seriesItem(accountId: string, s: Record<string, unknown>): SeriesItem | null {
  const seriesId = toStr(s.series_id);
  return seriesId ? {
    accountId,
    seriesId,
    name: toStr(s.name),
    poster: toStr(s.cover),
    rating: toStr(s.rating),
    categoryId: toStr(s.category_id),
    ...catalogSortMetadata(s, true),
  } : null;
}

// Whole catalogs go straight into columns as each title is parsed.
async function fetchCatalogColumns(
  url: string,
  kind: 'vod' | 'series',
  accountId: string,
  signal?: AbortSignal,
): Promise<CatalogColumns> {
  const builder = new CatalogColumnsBuilder(kind, accountId);
  await streamCatalogList(
    url,
    CONFIG.XTREAM.WHOLE_CATALOG_MAX_BYTES,
    CONFIG.XTREAM.WHOLE_CATALOG_TIMEOUT_MS,
    kind === 'vod' ? 'stream_id' : 'series_id',
    (raw) => {
      if (kind === 'vod') {
        const item = vodItem(accountId, raw);
        if (item) builder.add({ ...item, id: item.streamId });
      } else {
        const item = seriesItem(accountId, raw);
        if (item) builder.add({ ...item, id: item.seriesId });
      }
    },
    signal,
  );
  return builder.build();
}

// Coerce an unknown JSON value to an array of plain objects (empty if not an array).
function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

function liveCategoryIds(stream: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const add = (value: unknown): void => {
    const id = toStr(value);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  };
  add(stream.category_id);
  if (Array.isArray(stream.category_ids)) stream.category_ids.forEach(add);
  return ids;
}

function parseLiveStreams(value: unknown): XtreamLiveStream[] {
  return asArray(value)
    .map((stream) => ({
      streamId: toStr(stream.stream_id),
      name: toStr(stream.name),
      icon: toStr(stream.stream_icon),
      epgChannelId: toStr(stream.epg_channel_id),
      categoryId: toStr(stream.category_id),
      categoryIds: liveCategoryIds(stream),
      directSource: toStr(stream.direct_source),
      archive: stream.tv_archive === 1 || stream.tv_archive === '1'
        || stream.tv_archive === true,
      archiveDurationDays: Math.max(0, toNumber(stream.tv_archive_duration)),
    }))
    .filter(stream => stream.streamId !== '');
}

// Sidecar subtitles from a VOD / episode info block. Only entries with an
// absolute http(s) URL are kept — panels vary, and a filename we can't resolve
// to a URL is useless (and unsafe to guess at).
function parseSubtitles(v: unknown): SidecarSubtitle[] {
  return asArray(v)
    .map((s) => ({
      id: toStr(s.subtitle_id ?? s.id),
      name: toStr(s.title ?? s.name),
      lang: toStr(s.language ?? s.lang),
      url: toStr(s.url ?? s.subtitle_url),
    }))
    .filter((s) => /^https?:\/\//i.test(s.url));
}

function parseServerOffset(server: Record<string, unknown>): number | null {
  const timestamp = toNumber(server.timestamp_now);
  const timeNow = toStr(server.time_now);
  const match = timeNow.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!timestamp || !match) return null;
  const wallClockAsUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  );
  return Math.round((wallClockAsUtc - timestamp * 1000) / 60000);
}

/** A per-account handle over the Xtream `player_api.php` JSON endpoint. Flat
 *  composition (no inheritance); catalog methods grow on the same factory. */
export function createXtreamClient(creds: XtreamCredentials, accountId = '') {
  return {
    /** Account status, or null when the panel is unreachable / returns non-JSON. */
    async getAccountInfo(signal?: AbortSignal): Promise<XtreamAccountInfo | null> {
      const data = await fetchJson(
        xtreamPlayerApi(creds),
        ACCOUNT_INFO_TIMEOUT,
        CONFIG.XTREAM.ACCOUNT_MAX_BYTES,
        signal,
      ) as { user_info?: Record<string, unknown> } | null;
      const u = data?.user_info;
      if (!u) return null;
      const exp = u.exp_date;
      return {
        auth: u.auth === 1 || u.auth === '1' || u.auth === true,
        status: typeof u.status === 'string' ? u.status : '',
        expiresAt: exp === null || exp === undefined || exp === '' ? null : toNumber(exp) || null,
        maxConnections: toNumber(u.max_connections),
        activeConnections: toNumber(u.active_cons),
        allowedOutputFormats: Array.isArray(u.allowed_output_formats)
          ? u.allowed_output_formats.filter((format): format is string => typeof format === 'string')
          : [],
      };
    },

    async getLiveStreams(signal?: AbortSignal): Promise<XtreamLiveStream[]> {
      return parseLiveStreams(await fetchJson(
        xtreamPlayerApi(creds, 'get_live_streams'),
        CATALOG_TIMEOUT,
        CONFIG.XTREAM.CATALOG_MAX_BYTES,
        signal,
      ));
    },

    async getLiveStreamsResult(signal?: AbortSignal): Promise<XtreamLiveCatalogResult> {
      try {
        const value = await fetchJsonStrict(
          xtreamPlayerApi(creds, 'get_live_streams'),
          CATALOG_TIMEOUT,
          CONFIG.XTREAM.CATALOG_MAX_BYTES,
          signal,
        );
        return {
          available: Array.isArray(value),
          streams: parseLiveStreams(value),
        };
      } catch (err) {
        if (isXtreamRequestCancelled(err)) throw err;
        return { available: false, streams: [] };
      }
    },

    async getLiveCategories(signal?: AbortSignal): Promise<XtreamLiveCategory[]> {
      const arr = asArray(await fetchJson(
        xtreamPlayerApi(creds, 'get_live_categories'),
        CATALOG_TIMEOUT,
        CONFIG.XTREAM.CATEGORY_MAX_BYTES,
        signal,
      ));
      return arr
        .map((category) => ({
          id: toStr(category.category_id),
          name: toStr(category.category_name),
          parentId: toStr(category.parent_id),
        }))
        .filter(category => category.id !== '');
    },

    async getServerClock(signal?: AbortSignal): Promise<XtreamServerClock | null> {
      const data = await fetchJson(
        xtreamPlayerApi(creds),
        ACCOUNT_INFO_TIMEOUT,
        CONFIG.XTREAM.ACCOUNT_MAX_BYTES,
        signal,
      );
      if (!data || typeof data !== 'object') return null;
      const server = (data as { server_info?: unknown }).server_info;
      if (!server || typeof server !== 'object') return null;
      const record = server as Record<string, unknown>;
      return {
        timeZone: toStr(record.timezone),
        offsetMinutes: parseServerOffset(record),
      };
    },

    async getArchiveListings(
      streamId: string,
      signal?: AbortSignal,
    ): Promise<XtreamArchiveListing[] | null> {
      const request = (action: string): Promise<unknown> => fetchJson(
        xtreamPlayerApi(creds, action, { stream_id: streamId }),
        CATALOG_TIMEOUT,
        CONFIG.XTREAM.DETAIL_MAX_BYTES,
        signal,
      );
      let data = await request('get_simple_data_table');
      let raw = data && typeof data === 'object'
        ? (data as { epg_listings?: unknown }).epg_listings
        : undefined;
      if (!Array.isArray(raw)) {
        // Some legacy panels shipped `date` instead of Xtream's `data` action spelling.
        data = await request('get_simple_date_table');
        raw = data && typeof data === 'object'
          ? (data as { epg_listings?: unknown }).epg_listings
          : undefined;
      }
      if (!Array.isArray(raw)) return null;
      return asArray(raw)
        .map((listing) => {
          const start = toNumber(listing.start_timestamp);
          const stop = toNumber(listing.stop_timestamp);
          const flag = listing.has_archive;
          return {
            start,
            stop,
            hasArchive: flag === undefined || flag === null
              ? null
              : flag === 1 || flag === '1' || flag === true,
          };
        })
        .filter(listing => listing.start > 0 && listing.stop > listing.start);
    },

    async getVodCategories(signal?: AbortSignal): Promise<VodCategory[]> {
      return fetchCatalogList(
        xtreamPlayerApi(creds, 'get_vod_categories'),
        CONFIG.XTREAM.CATEGORY_MAX_BYTES,
        CATALOG_TIMEOUT,
        'category_id',
        (c) => {
          const id = toStr(c.category_id);
          return id ? { id, name: toStr(c.category_name) } : null;
        },
        signal,
      );
    },

    async getVodStreams(categoryId?: string, signal?: AbortSignal): Promise<VodItem[]> {
      const params = categoryId ? { category_id: categoryId } : undefined;
      return fetchCatalogList(
        xtreamPlayerApi(creds, 'get_vod_streams', params),
        categoryId ? CONFIG.XTREAM.CATALOG_MAX_BYTES : CONFIG.XTREAM.WHOLE_CATALOG_MAX_BYTES,
        categoryId ? CATALOG_TIMEOUT : CONFIG.XTREAM.WHOLE_CATALOG_TIMEOUT_MS,
        'stream_id',
        s => vodItem(accountId, s),
        signal,
      );
    },

    /** Every movie on the account, from one unfiltered request. */
    getVodCatalog(signal?: AbortSignal): Promise<CatalogColumns> {
      return fetchCatalogColumns(xtreamPlayerApi(creds, 'get_vod_streams'), 'vod', accountId, signal);
    },

    async getVodInfo(vodId: string, signal?: AbortSignal): Promise<VodInfo | null> {
      const data = await fetchJsonStrict(
        xtreamPlayerApi(creds, 'get_vod_info', { vod_id: vodId }),
        CATALOG_TIMEOUT,
        CONFIG.XTREAM.DETAIL_MAX_BYTES,
        signal,
      );
      if (!data || typeof data !== 'object') return null;
      const info = (data as { info?: unknown }).info;
      if (!info || typeof info !== 'object') return null;
      const i = info as Record<string, unknown>;
      return {
        plot: toStr(i.plot),
        cast: toStr(i.cast),
        director: toStr(i.director),
        genre: toStr(i.genre),
        releaseDate: toStr(i.releasedate ?? i.release_date),
        durationSecs: toNumber(i.duration_secs),
        poster: toStr(i.movie_image ?? i.cover_big),
        subtitles: parseSubtitles(i.subtitles),
        imdbId: toStr(i.imdb_id ?? i.imdb).replace(/^tt/i, ''),
        tmdbId: toStr(i.tmdb_id ?? i.tmdb),
        year: Number(toStr(i.releasedate ?? i.release_date).slice(0, 4)) || 0,
      };
    },

    async getSeriesCategories(signal?: AbortSignal): Promise<SeriesCategory[]> {
      return fetchCatalogList(
        xtreamPlayerApi(creds, 'get_series_categories'),
        CONFIG.XTREAM.CATEGORY_MAX_BYTES,
        CATALOG_TIMEOUT,
        'category_id',
        (c) => {
          const id = toStr(c.category_id);
          return id ? { id, name: toStr(c.category_name) } : null;
        },
        signal,
      );
    },

    async getSeries(categoryId?: string, signal?: AbortSignal): Promise<SeriesItem[]> {
      const params = categoryId ? { category_id: categoryId } : undefined;
      return fetchCatalogList(
        xtreamPlayerApi(creds, 'get_series', params),
        categoryId ? CONFIG.XTREAM.CATALOG_MAX_BYTES : CONFIG.XTREAM.WHOLE_CATALOG_MAX_BYTES,
        categoryId ? CATALOG_TIMEOUT : CONFIG.XTREAM.WHOLE_CATALOG_TIMEOUT_MS,
        'series_id',
        s => seriesItem(accountId, s),
        signal,
      );
    },

    /** Every series on the account, from one unfiltered request. */
    getSeriesCatalog(signal?: AbortSignal): Promise<CatalogColumns> {
      return fetchCatalogColumns(xtreamPlayerApi(creds, 'get_series'), 'series', accountId, signal);
    },

    async getSeriesInfo(seriesId: string, signal?: AbortSignal): Promise<SeriesInfo | null> {
      const data = await fetchJsonStrict(
        xtreamPlayerApi(creds, 'get_series_info', { series_id: seriesId }),
        CATALOG_TIMEOUT,
        CONFIG.XTREAM.DETAIL_MAX_BYTES,
        signal,
      );
      if (!data || typeof data !== 'object') return null;
      const response = data as { info?: unknown; episodes?: unknown };
      const info = response.info && typeof response.info === 'object'
        ? response.info as Record<string, unknown>
        : {};
      const releaseDate = firstNonEmptyString(
        info.releaseDate,
        info.release_date,
        info.releasedate,
      );
      const yearValue = firstNonEmptyString(info.year, releaseDate);
      const yearMatch = yearValue.match(/\d{4}/);
      const runTime = info.episode_run_time;
      const episodesRaw = response.episodes;
      const episodesBySeason: Record<number, Episode[]> = {};
      if (episodesRaw && typeof episodesRaw === 'object') {
        const byKey = episodesRaw as Record<string, unknown>;
        for (const key in byKey) {
          const seasonNum = Number(key);
          episodesBySeason[seasonNum] = asArray(byKey[key])
            .map((e) => {
              const einfo = (e.info && typeof e.info === 'object') ? e.info as Record<string, unknown> : {};
              return {
                id: toStr(e.id),
                title: toStr(e.title),
                season: toNumber(e.season) || seasonNum,
                episode: toNumber(e.episode_num),
                containerExtension: toStr(e.container_extension),
                durationSecs: toNumber(einfo.duration_secs),
                plot: toStr(einfo.plot),
                poster: toStr(einfo.movie_image),
                subtitles: parseSubtitles(e.subtitles ?? einfo.subtitles),
              };
            })
            .filter((ep) => ep.id !== '');
        }
      }
      const seasons = Object.keys(episodesBySeason).map(Number).sort((a, b) => a - b);
      return {
        plot: toStr(info.plot),
        cast: toStr(info.cast),
        director: toStr(info.director),
        genre: toStr(info.genre),
        releaseDate,
        episodeRunTimeMins: Math.max(
          0,
          toNumber(Array.isArray(runTime) ? runTime[0] : runTime),
        ),
        poster: firstNonEmptyString(info.cover, info.movie_image, info.cover_big),
        rating: firstNonEmptyString(info.rating, info.rating_5based),
        imdbId: firstNonEmptyString(info.imdb_id, info.imdb).replace(/^tt/i, ''),
        tmdbId: firstNonEmptyString(info.tmdb_id, info.tmdb),
        year: yearMatch ? Number(yearMatch[0]) : 0,
        seasons,
        episodesBySeason,
      };
    },
  };
}

export type XtreamClient = ReturnType<typeof createXtreamClient>;
