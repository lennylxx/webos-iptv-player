import {
  isLetterOrNumber,
  splitLetterNumberTokens,
  stripCombiningDiacritics,
} from './unicode-text';

const SYNONYM_GROUPS = [
  ['sports', 'sport', 'footy', 'football', 'soccer', 'athletics'],
  ['kids', 'kid', 'children', 'child', 'cartoons', 'cartoon', 'animation', 'animated'],
  ['news', 'headlines', 'current affairs'],
  ['movies', 'movie', 'films', 'film', 'cinema'],
  ['music', 'songs', 'song', 'concerts', 'concert'],
  ['documentaries', 'documentary', 'docs', 'history', 'nature'],
] as const;

const STOP_WORDS = new Set(['find', 'me', 'show', 'watch', 'for', 'please', 'channel', 'channels', 'program', 'programs']);

function fold(value: string): string {
  return stripCombiningDiacritics(value.normalize('NFD')).toLowerCase();
}

function splitFolded(value: string): string[] {
  return splitLetterNumberTokens(value);
}

function tokens(value: string): string[] {
  return splitFolded(fold(value));
}

function queryTokens(query: string): string[] {
  const all = tokens(query);
  const meaningful = all.filter(token => !STOP_WORDS.has(token));
  return meaningful.length ? meaningful : all;
}

function variants(token: string): string[] {
  for (const group of SYNONYM_GROUPS) {
    if ((group as readonly string[]).includes(token)) return [token, ...group.filter(value => value !== token)];
  }
  return [token];
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let edits = 0;
    for (let i = 0; i < a.length;) {
      if (a[i] === b[i]) {
        i++;
        continue;
      }
      if (edits > 0) return false;
      edits++;
      if (i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i]) i += 2;
      else i++;
    }
    return true;
  }

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let shortIndex = 0;
  let longIndex = 0;
  let edits = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      longIndex++;
    } else {
      if (edits > 0) return false;
      edits++;
      longIndex++;
    }
  }
  return true;
}

function tokenScore(
  queryToken: string,
  fieldTokens: string[],
  start: number,
  end: number,
): number | null {
  let best: number | null = null;
  const expanded = variants(queryToken);
  for (let variantIndex = 0; variantIndex < expanded.length; variantIndex++) {
    const variant = expanded[variantIndex];
    for (let tokenIndex = start; tokenIndex < end; tokenIndex++) {
      const fieldToken = fieldTokens[tokenIndex];
      let score: number | null = null;
      if (fieldToken === variant) score = variantIndex === 0 ? 0 : 4;
      else if (fieldToken.startsWith(variant)) score = variantIndex === 0 ? 1 : 5;
      else if (variantIndex === 0 && variant.length >= 4 && withinOneEdit(variant, fieldToken)) score = 2;
      if (score !== null && (best === null || score < best)) best = score;
    }
  }
  return best;
}

export interface PreparedSearchItem<T> {
  item: T;
  values: string[];
  fieldTokens: string[];
  fieldTokenOffsets: number[];
}

export interface PreparedNameSearchIndex<T> {
  items: T[];
  values: string[];
}

export interface RankedSearchResult<T> {
  items: T[];
  hasMore: boolean;
}

interface ScoredSearchItem<T> {
  item: T;
  score: number;
  idx: number;
}

interface ScoredNameItem<T> {
  item: T;
  tier: number;
  pos: number;
  len: number;
  idx: number;
}

export function prepareSearchItem<T>(
  item: T,
  fields: (item: T) => string[],
): PreparedSearchItem<T> {
  const values = fields(item).map(fold).filter(Boolean);
  const fieldTokens: string[] = [];
  const fieldTokenOffsets = [0];
  for (const value of values) {
    const tokens = splitFolded(value);
    for (const token of tokens) fieldTokens.push(token);
    fieldTokenOffsets.push(fieldTokens.length);
  }
  return { item, values, fieldTokens, fieldTokenOffsets };
}

export function prepareSearchItems<T>(items: T[], fields: (item: T) => string[]): PreparedSearchItem<T>[] {
  return items.map(item => prepareSearchItem(item, fields));
}

export function prepareNameSearchItems<T extends { name: string }>(
  items: T[],
): PreparedNameSearchIndex<T> {
  return {
    items,
    values: items.map(item => fold(item.name)),
  };
}

function compareScored<T>(a: ScoredSearchItem<T>, b: ScoredSearchItem<T>): number {
  return a.score - b.score || a.idx - b.idx;
}

function compareNameScored<T>(a: ScoredNameItem<T>, b: ScoredNameItem<T>): number {
  return a.tier - b.tier
    || a.pos - b.pos
    || a.len - b.len
    || a.idx - b.idx;
}

function directScore<T>(
  prepared: PreparedSearchItem<T>,
  query: string,
): number | null {
  let best: number | null = null;
  for (let fieldIndex = 0; fieldIndex < prepared.values.length; fieldIndex++) {
    const value = prepared.values[fieldIndex];
    const pos = value.indexOf(query);
    if (pos === -1) continue;
    const tier = value === query
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    const score = tier * 1000 + fieldIndex * 100 + pos * 10 + value.length;
    if (best === null || score < best) best = score;
  }
  return best;
}

function fuzzyScore<T>(
  prepared: PreparedSearchItem<T>,
  terms: string[],
): number | null {
  let total = 10000;
  for (const term of terms) {
    let best: number | null = null;
    for (let fieldIndex = 0; fieldIndex < prepared.values.length; fieldIndex++) {
      const score = tokenScore(
        term,
        prepared.fieldTokens,
        prepared.fieldTokenOffsets[fieldIndex],
        prepared.fieldTokenOffsets[fieldIndex + 1],
      );
      if (score !== null) {
        const weighted = score + fieldIndex * 10;
        if (best === null || weighted < best) best = weighted;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

class BoundedHeap<T> {
  private values: T[] = [];

  constructor(
    private limit: number,
    private compare: (a: T, b: T) => number,
  ) {}

  add(value: T): void {
    if (this.values.length < this.limit) {
      this.values.push(value);
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (this.compare(value, this.values[0]) >= 0) return;
    this.values[0] = value;
    this.bubbleDown(0);
  }

  sorted(): T[] {
    return this.values.sort(this.compare);
  }

  private bubbleUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], this.values[index]) >= 0) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  private bubbleDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worse = index;
      if (left < this.values.length
          && this.compare(this.values[left], this.values[worse]) > 0) worse = left;
      if (right < this.values.length
          && this.compare(this.values[right], this.values[worse]) > 0) worse = right;
      if (worse === index) return;
      [this.values[index], this.values[worse]] = [this.values[worse], this.values[index]];
      index = worse;
    }
  }
}

export function rankPreparedTopK<T>(
  items: PreparedSearchItem<T>[],
  query: string,
  limit: number,
  includeFuzzy = true,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  const terms = queryTokens(query);
  if (!q || !terms.length || limit <= 0) return { items: [], hasMore: false };
  const heap = new BoundedHeap<ScoredSearchItem<T>>(limit, compareScored);
  const directMatches = includeFuzzy ? new Uint8Array(items.length) : null;
  let matches = 0;
  for (let i = 0; i < items.length; i++) {
    const prepared = items[i];
    const score = directScore(prepared, q);
    if (score === null) continue;
    if (directMatches) directMatches[i] = 1;
    matches++;
    heap.add({ item: prepared.item, score, idx: i });
  }
  if (includeFuzzy && matches < limit) {
    for (let i = 0; i < items.length; i++) {
      const prepared = items[i];
      if (directMatches?.[i]) continue;
      const score = fuzzyScore(prepared, terms);
      if (score === null) continue;
      matches++;
      heap.add({ item: prepared.item, score, idx: i });
    }
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit
      || (includeFuzzy && matches >= limit && items.length > matches),
  };
}

export function rankPreparedNamesTopK<T>(
  index: PreparedNameSearchIndex<T>,
  query: string,
  limit: number,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  if (!q || limit <= 0) return { items: [], hasMore: false };
  const heap = new BoundedHeap<ScoredNameItem<T>>(limit, compareNameScored);
  let matches = 0;
  for (let i = 0; i < index.items.length; i++) {
    const value = index.values[i];
    const pos = value.indexOf(q);
    if (pos === -1) continue;
    const tier = value === q
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    matches++;
    heap.add({
      item: index.items[i],
      tier,
      pos,
      len: value.length,
      idx: i,
    });
  }
  return {
    items: heap.sorted().map(value => value.item),
    hasMore: matches > limit,
  };
}

export function rankPrepared<T>(items: PreparedSearchItem<T>[], query: string): T[] {
  return rankPreparedTopK(items, query, items.length).items;
}

export function rankByFields<T>(items: T[], query: string, fields: (item: T) => string[]): T[] {
  return rankPrepared(prepareSearchItems(items, fields), query);
}

export function rankByName<T extends { name: string }>(items: T[], query: string): T[] {
  return rankPreparedNamesTopK(
    prepareNameSearchItems(items),
    query,
    items.length,
  ).items;
}

export function rankChannels<T extends { name: string; group: string; sourceName?: string }>(
  items: T[],
  query: string,
): T[] {
  // A renamed channel stays findable under its source name too.
  return rankByFields(items, query, item => [item.name, item.group, item.sourceName ?? '']);
}
