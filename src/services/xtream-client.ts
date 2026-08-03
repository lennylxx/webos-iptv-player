import { fetchText } from '../utils/fetch-helper';
import { xtreamPlayerApi, type XtreamCredentials } from '../utils/xtream-url';
import { createLogger } from '../utils/logger';
import type { VodCategory, VodItem, VodInfo, SeriesCategory, SeriesItem, SeriesInfo, Episode, SidecarSubtitle } from '../types';

const log = createLogger('Xtream');

// Account check is an interactive "verify these credentials" call, so fail fast.
const ACCOUNT_INFO_TIMEOUT = 15000;
// Catalog calls can be large; use the default network timeout.
const CATALOG_TIMEOUT = 30000;

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
  archive: boolean;
  archiveDurationDays: number;
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

// Fetch + parse JSON, tolerant: returns null on network or parse failure.
async function fetchJson(url: string, timeout: number): Promise<unknown> {
  try {
    return JSON.parse(await fetchText(url, timeout));
  } catch (err) {
    log.warn('fetchJson failed:', err);
    return null;
  }
}

// Coerce an unknown JSON value to an array of plain objects (empty if not an array).
function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
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
    async getAccountInfo(): Promise<XtreamAccountInfo | null> {
      try {
        const text = await fetchText(xtreamPlayerApi(creds), ACCOUNT_INFO_TIMEOUT);
        const data = JSON.parse(text) as { user_info?: Record<string, unknown> };
        const u = data.user_info;
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
      } catch (err) {
        log.warn('getAccountInfo failed:', err);
        return null;
      }
    },

    async getLiveStreams(): Promise<XtreamLiveStream[]> {
      const arr = asArray(await fetchJson(xtreamPlayerApi(creds, 'get_live_streams'), CATALOG_TIMEOUT));
      return arr
        .map((stream) => ({
          streamId: toStr(stream.stream_id),
          archive: stream.tv_archive === 1 || stream.tv_archive === '1' || stream.tv_archive === true,
          archiveDurationDays: Math.max(0, toNumber(stream.tv_archive_duration)),
        }))
        .filter(stream => stream.streamId !== '');
    },

    async getServerClock(): Promise<XtreamServerClock | null> {
      const data = await fetchJson(xtreamPlayerApi(creds), ACCOUNT_INFO_TIMEOUT);
      if (!data || typeof data !== 'object') return null;
      const server = (data as { server_info?: unknown }).server_info;
      if (!server || typeof server !== 'object') return null;
      const record = server as Record<string, unknown>;
      return {
        timeZone: toStr(record.timezone),
        offsetMinutes: parseServerOffset(record),
      };
    },

    async getArchiveListings(streamId: string): Promise<XtreamArchiveListing[] | null> {
      const data = await fetchJson(
        xtreamPlayerApi(creds, 'get_simple_data_table', { stream_id: streamId }),
        CATALOG_TIMEOUT,
      );
      if (!data || typeof data !== 'object') return null;
      const raw = (data as { epg_listings?: unknown }).epg_listings;
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

    async getVodCategories(): Promise<VodCategory[]> {
      const arr = asArray(await fetchJson(xtreamPlayerApi(creds, 'get_vod_categories'), CATALOG_TIMEOUT));
      return arr
        .map((c) => ({ id: toStr(c.category_id), name: toStr(c.category_name) }))
        .filter((c) => c.id !== '');
    },

    async getVodStreams(categoryId?: string): Promise<VodItem[]> {
      const params = categoryId ? { category_id: categoryId } : undefined;
      const arr = asArray(await fetchJson(xtreamPlayerApi(creds, 'get_vod_streams', params), CATALOG_TIMEOUT));
      return arr
        .map((s) => ({
          accountId,
          streamId: toStr(s.stream_id),
          name: toStr(s.name),
          poster: toStr(s.stream_icon),
          rating: toStr(s.rating),
          categoryId: toStr(s.category_id),
          containerExtension: toStr(s.container_extension),
        }))
        .filter((v) => v.streamId !== '');
    },

    async getVodInfo(vodId: string): Promise<VodInfo | null> {
      const data = await fetchJson(xtreamPlayerApi(creds, 'get_vod_info', { vod_id: vodId }), CATALOG_TIMEOUT);
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

    async getSeriesCategories(): Promise<SeriesCategory[]> {
      const arr = asArray(await fetchJson(xtreamPlayerApi(creds, 'get_series_categories'), CATALOG_TIMEOUT));
      return arr
        .map((c) => ({ id: toStr(c.category_id), name: toStr(c.category_name) }))
        .filter((c) => c.id !== '');
    },

    async getSeries(categoryId?: string): Promise<SeriesItem[]> {
      const params = categoryId ? { category_id: categoryId } : undefined;
      const arr = asArray(await fetchJson(xtreamPlayerApi(creds, 'get_series', params), CATALOG_TIMEOUT));
      return arr
        .map((s) => ({
          accountId,
          seriesId: toStr(s.series_id),
          name: toStr(s.name),
          poster: toStr(s.cover),
          rating: toStr(s.rating),
          categoryId: toStr(s.category_id),
        }))
        .filter((s) => s.seriesId !== '');
    },

    async getSeriesInfo(seriesId: string): Promise<SeriesInfo | null> {
      const data = await fetchJson(xtreamPlayerApi(creds, 'get_series_info', { series_id: seriesId }), CATALOG_TIMEOUT);
      if (!data || typeof data !== 'object') return null;
      const episodesRaw = (data as { episodes?: unknown }).episodes;
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
      return { seasons, episodesBySeason };
    },
  };
}

export type XtreamClient = ReturnType<typeof createXtreamClient>;
