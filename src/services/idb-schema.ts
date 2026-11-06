// Shared with the app worker, so it must stay free of DOM and storage access.
export const DB_NAME = 'iptv';
export const DB_VERSION = 7;

export const EPG_STORE = 'epg-cache';
export const CATALOG_STORE = 'catalog-cache';
export const PLAYLIST_STORE = 'playlist-cache';
export const SEARCH_INDEX_STORE = 'search-index-cache';
export const CACHE_META_STORE = 'cache-meta';
// Avoid deserializing caches that may contain Xtream VOD rows or channels whose
// URL still carries an unparsed `|Name=value` header suffix.
export const PLAYLIST_CACHE_KEY = 'combined-v4';
// Bump when item lists gain fields, so old catalog rows are never served.
export const VOD_STREAMS_RESOURCE = 'vod_streams-v2';
export const SERIES_RESOURCE = 'series-v2';

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function cacheRecordTimestamp(raw: Record<string, unknown>): number {
  return finiteNumber(raw.timestamp, raw.updatedAt as number);
}

export function cacheEntryMetaId(store: string, key: unknown): string {
  return `entry:${store}:${String(key)}`;
}
