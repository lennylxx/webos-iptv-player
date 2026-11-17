import type {
  XtreamLiveCategoryFilter,
  XtreamLiveCategorySnapshot,
} from '../types';

export interface XtreamGroupNameFilter {
  mode: XtreamLiveCategoryFilter['mode'];
  names: string[];
}

function uniqueIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const id = String(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** A usable filter, or undefined when the value means "load everything". */
export function normalizeLiveCategoryFilter(
  value: unknown,
): XtreamLiveCategoryFilter | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { mode?: unknown; ids?: unknown };
  if (raw.mode !== 'include' && raw.mode !== 'exclude') return undefined;
  const ids = uniqueIds(Array.isArray(raw.ids) ? raw.ids : []);
  // An empty include list would load an empty account; an empty exclude list is no filter.
  if (!ids.length) return undefined;
  return { mode: raw.mode, ids };
}

/** A stream with several categories is kept in include mode when any is
 *  listed, and in exclude mode unless every one is listed. */
export function createLiveCategoryMatcher(
  filter: XtreamLiveCategoryFilter | undefined,
): (categoryIds: readonly string[]) => boolean {
  if (!filter) return () => true;
  const ids = new Set(filter.ids);
  const listed = (id: string): boolean => ids.has(id);
  return filter.mode === 'include'
    ? categoryIds => categoryIds.some(listed)
    : categoryIds => !categoryIds.length || !categoryIds.every(listed);
}

export function filterLiveStreams<T extends { categoryIds: readonly string[] }>(
  filter: XtreamLiveCategoryFilter | undefined,
  streams: readonly T[],
): T[] {
  const keep = createLiveCategoryMatcher(filter);
  return streams.filter(stream => keep(stream.categoryIds));
}

export function liveCategoryCounts(
  streams: readonly { categoryIds: readonly string[] }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stream of streams) {
    for (const id of stream.categoryIds) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

/** Ids present in the current catalog that an include-mode filter neither
 *  lists nor has shown the user before. */
export function newLiveCategoryIds(
  filter: XtreamLiveCategoryFilter | undefined,
  snapshot: XtreamLiveCategorySnapshot | null,
  currentIds: readonly string[],
): string[] {
  if (!filter || filter.mode !== 'include' || !snapshot) return [];
  const known = new Set(snapshot.knownIds.concat(filter.ids));
  return uniqueIds(currentIds).filter(id => !known.has(id));
}

export function normalizeGroupName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The name-match fallback used when the Live catalog is unavailable; null
 *  when the category list is unavailable too. */
export function liveCategoryGroupFilter(
  filter: XtreamLiveCategoryFilter,
  categories: readonly { id: string; name: string }[],
): XtreamGroupNameFilter | null {
  const ids = new Set(filter.ids);
  const names = uniqueIds(categories
    .filter(category => ids.has(category.id))
    .map(category => normalizeGroupName(category.name)));
  // An empty catalog means the lookup failed; a catalog without the chosen
  // ids still applies, so an include filter keeps nothing rather than all.
  return categories.length ? { mode: filter.mode, names } : null;
}

// Group names repeat across a playlist's channels; a cap keeps a playlist
// of unique names from growing the matcher's cache without bound.
const GROUP_MATCH_CACHE_MAX = 4096;

export function createGroupNameMatcher(filter: XtreamGroupNameFilter): (group: string) => boolean {
  const names = new Set(filter.names);
  const include = filter.mode === 'include';
  const cache = new Map<string, boolean>();
  return group => {
    let keep = cache.get(group);
    if (keep === undefined) {
      keep = names.has(normalizeGroupName(group)) === include;
      if (cache.size < GROUP_MATCH_CACHE_MAX) cache.set(group, keep);
    }
    return keep;
  };
}
