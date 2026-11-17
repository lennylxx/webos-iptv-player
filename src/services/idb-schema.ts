// Shared with the app worker, so it must stay free of DOM and storage access.
export const DB_NAME = 'iptv';
export const DB_VERSION = 7;

export const EPG_STORE = 'epg-cache';
export const CATALOG_STORE = 'catalog-cache';
export const PLAYLIST_STORE = 'playlist-cache';
export const SEARCH_INDEX_STORE = 'search-index-cache';
export const CACHE_META_STORE = 'cache-meta';
// Bump when parsed channels change shape or meaning, so old caches are never
// served: v5 re-reads M3U catch-up attributes. A write evicts older keys.
export const PLAYLIST_CACHE_KEY = 'combined-v5';
// Bumping it invalidates cached guides; v2 adds program catch-up ids.
export const PACKED_EPG_FORMAT = 'epg-packed-v2';
// Bump when item lists gain fields, so old catalog rows are never served.
export const VOD_STREAMS_RESOURCE = 'vod_streams-v3';
export const SERIES_RESOURCE = 'series-v3';

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function cacheRecordTimestamp(raw: Record<string, unknown>): number {
  return finiteNumber(raw.timestamp, raw.updatedAt as number);
}

export function cacheEntryMetaId(store: string, key: unknown): string {
  return `entry:${store}:${String(key)}`;
}
