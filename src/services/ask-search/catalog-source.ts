import type { PlaylistEntry, SeriesItem, VodItem } from '../../types';
import { CONFIG } from '../../config';
import {
  loadSeries,
  loadSeriesCategories,
  loadVodCategories,
  loadVodStreams,
} from '../xtream-catalog';
import {
  isSeriesConcealed,
  isVodConcealed,
  ParentalControlService,
} from '../parental-control';

// Whatever the session, a locked category's name never leaves the device.
function categoryLocked(account: PlaylistEntry, kind: 'vod-category' | 'series-category', categoryId: string): boolean {
  return ParentalControlService.enabled
    && ParentalControlService.parentsLocked([{ kind, accountId: account.id, categoryId }]);
}

/** Category ids by name, for each catalog; a name can cover several ids. */
export interface AskCatalogCategories {
  names: string[];
  movies: Map<string, string[]>;
  series: Map<string, string[]>;
}

function byName(
  account: PlaylistEntry,
  kind: 'vod-category' | 'series-category',
  categories: Array<{ id: string; name: string }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const category of categories) {
    const name = category.name.trim();
    if (!name) continue;
    if (categoryLocked(account, kind, category.id)) continue;
    const ids = map.get(name);
    if (ids) ids.push(category.id);
    else map.set(name, [category.id]);
  }
  return map;
}

/** The account's visible category names; a catalog that fails to load has none. */
export async function askCatalogCategories(
  account: PlaylistEntry,
  signal: AbortSignal,
): Promise<AskCatalogCategories> {
  const [vod, series] = await Promise.all([
    loadVodCategories(account, signal).catch(() => []),
    loadSeriesCategories(account, signal).catch(() => []),
  ]);
  const movies = byName(account, 'vod-category', vod);
  const shows = byName(account, 'series-category', series);
  const names: string[] = [];
  movies.forEach((_ids, name) => names.push(name));
  shows.forEach((_ids, name) => { if (!movies.has(name)) names.push(name); });
  return { names, movies, series: shows };
}

/** The categories still unlocked, as the rules stand now. */
export function unlockedCategories(account: PlaylistEntry, categories: AskCatalogCategories): AskCatalogCategories {
  const keep = (kind: 'vod-category' | 'series-category', map: Map<string, string[]>): Map<string, string[]> => {
    const kept = new Map<string, string[]>();
    map.forEach((ids, name) => {
      const open = ids.filter(id => !categoryLocked(account, kind, id));
      if (open.length) kept.set(name, open);
    });
    return kept;
  };
  const movies = keep('vod-category', categories.movies);
  const series = keep('series-category', categories.series);
  return { names: categories.names.filter(name => movies.has(name) || series.has(name)), movies, series };
}

function idsFor(map: Map<string, string[]>, names: string[]): string[] {
  const ids: string[] = [];
  for (const name of names) ids.push(...(map.get(name) ?? []));
  return ids;
}

// Loads each category, a few at a time; one that fails lists nothing.
async function loadEach<T>(ids: string[], load: (id: string) => Promise<T[]>): Promise<T[][]> {
  const lists: T[][] = new Array(ids.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const index = next++;
      lists[index] = await load(ids[index]).catch((): T[] => []);
    }
  };
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(CONFIG.XTREAM.CATALOG_LOAD_CONCURRENCY, ids.length); i++) workers.push(worker());
  await Promise.all(workers);
  return lists;
}

/**
 * The movies or series in the named categories: from the catalog Search
 * already holds, else loaded per category, without hidden items either way.
 */
async function itemsIn<T extends { categoryId: string }>(
  ids: string[],
  held: T[] | null,
  load: (id: string) => Promise<T[]>,
  idOf: (item: T) => string,
  concealed: (item: T) => boolean,
): Promise<T[]> {
  if (held) {
    const wanted = new Set(ids);
    return held.filter(item => wanted.has(item.categoryId));
  }
  const lists = await loadEach(ids, load);
  const concealing = ParentalControlService.concealing;
  const seen: Record<string, true> = {};
  const items: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      const id = idOf(item);
      if (seen[id] || (concealing && concealed(item))) continue;
      seen[id] = true;
      items.push(item);
    }
  }
  return items;
}

export function askMovies(
  account: PlaylistEntry,
  categories: AskCatalogCategories,
  names: string[],
  held: VodItem[] | null,
  signal: AbortSignal,
): Promise<VodItem[]> {
  return itemsIn(
    idsFor(categories.movies, names),
    held,
    id => loadVodStreams(account, id, signal),
    item => item.streamId,
    isVodConcealed,
  );
}

export function askSeries(
  account: PlaylistEntry,
  categories: AskCatalogCategories,
  names: string[],
  held: SeriesItem[] | null,
  signal: AbortSignal,
): Promise<SeriesItem[]> {
  return itemsIn(
    idsFor(categories.series, names),
    held,
    id => loadSeries(account, id, signal),
    item => item.seriesId,
    isSeriesConcealed,
  );
}
