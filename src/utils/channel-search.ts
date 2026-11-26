import {
  foldNonAsciiSearchText,
  isLetterOrNumber,
  splitLetterNumberTokens,
} from './unicode-text';
import { hasScript, transliterateQuery, type SearchScript } from './transliterate';

// Genre words in English and the UI languages; folded once at load. Only a
// settled query tries the translations, which multiply each fuzzy pass's cost.
const SYNONYM_GROUPS: ReadonlyArray<{ english: readonly string[]; translated: readonly string[] }> = [
  {
    english: [
      'sports', 'sport', 'footy', 'football', 'soccer', 'athletics',
    ],
    translated: [
      'fußball', 'fussball', 'deportes', 'deporte', 'fútbol', 'calcio', 'esporte', 'esportes',
      'futebol', 'спорт', 'футбол', 'spor', 'futbol', '体育', '足球',
    ],
  },
  {
    english: [
      'kids', 'kid', 'children', 'child', 'cartoons', 'cartoon', 'animation', 'animated',
    ],
    translated: [
      'kinder', 'zeichentrick', 'infantil', 'niños', 'dibujos', 'enfants', 'jeunesse', 'dessins',
      'bambini', 'cartoni', 'dzieci', 'bajki', 'crianças', 'desenhos', 'детский', 'детям',
      'мультфильмы', 'мульт', 'çocuk', 'дитячий', 'дітям', 'мультфільми', '少儿', '儿童', '动画', '卡通',
    ],
  },
  {
    english: ['news', 'headlines', 'current affairs'],
    translated: [
      'nachrichten', 'noticias', 'infos', 'actualités', 'notizie', 'telegiornale', 'wiadomości',
      'informacje', 'notícias', 'jornal', 'новости', 'haber', 'haberler', 'новини', '新闻',
    ],
  },
  {
    english: [
      'movies', 'movie', 'films', 'film', 'cinema',
    ],
    translated: [
      'filme', 'kino', 'películas', 'película', 'cine', 'cinéma', 'filmy', 'filmes', 'фильмы',
      'кино', 'filmler', 'sinema', 'фільми', 'кіно', '电影',
    ],
  },
  {
    english: [
      'music', 'songs', 'song', 'concerts', 'concert',
    ],
    translated: [
      'musik', 'música', 'musique', 'musica', 'muzyka', 'музыка', 'müzik', 'музика', '音乐',
    ],
  },
  {
    english: [
      'documentaries', 'documentary', 'docs', 'history', 'nature',
    ],
    translated: [
      'dokumentation', 'doku', 'documentales', 'documental', 'documentaires', 'documentaire',
      'documentari', 'documentario', 'dokumenty', 'dokumentalne', 'documentários', 'documentário',
      'документальные', 'документальный', 'belgesel', 'документальні', 'документальний', '纪录片',
    ],
  },
];

const STOP_WORDS = new Set(['find', 'me', 'show', 'watch', 'for', 'please', 'channel', 'channels', 'program', 'programs']);

// NFD leaves ASCII as is and strips no mark from it, so skip both there.
const ASCII_ONLY = /^[\x00-\x7f]*$/;

function fold(value: string): string {
  if (ASCII_ONLY.test(value)) return value.toLowerCase();
  return foldNonAsciiSearchText(value);
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

let synonymGroups: { english: Map<string, string[]>; all: Map<string, string[]> } | null = null;

function groupMap(multilingual: boolean): Map<string, string[]> {
  const byWord = new Map<string, string[]>();
  SYNONYM_GROUPS.forEach(({ english, translated }) => {
    const group: string[] = [];
    for (const word of multilingual ? english.concat(translated) : english) {
      const folded = fold(word);
      if (group.indexOf(folded) < 0) group.push(folded);
    }
    for (const word of group) if (!byWord.has(word)) byWord.set(word, group);
  });
  return byWord;
}

function synonymsByWord(multilingual: boolean): Map<string, string[]> {
  if (!synonymGroups) {
    synonymGroups = {
      english: groupMap(false),
      all: groupMap(true),
    };
  }
  return multilingual ? synonymGroups.all : synonymGroups.english;
}

function variants(token: string, multilingual: boolean): string[] {
  const group = synonymsByWord(multilingual).get(token);
  return group ? [token, ...group.filter(value => value !== token)] : [token];
}

/** Whether a query has a genre word the UI languages translate, which a settled ranking tries. */
export function hasMultilingualSynonyms(query: string): boolean {
  return queryTokens(query).some(token => variants(token, true).length > variants(token, false).length);
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
  expanded: string[],
  fieldTokens: string[],
  start: number,
  end: number,
  strict: boolean,
): number | null {
  let best: number | null = null;
  for (let variantIndex = 0; variantIndex < expanded.length; variantIndex++) {
    const variant = expanded[variantIndex];
    for (let tokenIndex = start; tokenIndex < end; tokenIndex++) {
      const fieldToken = fieldTokens[tokenIndex];
      let score: number | null = null;
      if (fieldToken === variant) score = variantIndex === 0 ? 0 : 4;
      else if (fieldToken.startsWith(variant)) score = variantIndex === 0 ? 1 : 5;
      else if (!strict && variantIndex === 0 && variant.length >= 4 && withinOneEdit(variant, fieldToken)) score = 2;
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

export { fold as foldSearchText };

export function prepareSearchItem<T>(
  item: T,
  fields: (item: T) => string[],
): PreparedSearchItem<T> {
  return prepareFoldedSearchItem(item, fields(item).map(fold));
}

/** Like `prepareSearchItem`, for field values already passed through `foldSearchText`. */
export function prepareFoldedSearchItem<T>(item: T, folded: string[]): PreparedSearchItem<T> {
  const values = folded.filter(Boolean);
  const fieldTokens: string[] = [];
  const fieldTokenOffsets = [0];
  for (const value of values) {
    const tokens = splitFolded(value);
    for (const token of tokens) fieldTokens.push(token);
    fieldTokenOffsets.push(fieldTokens.length);
  }
  // slice() copies to exact length; push() leaves spare capacity that a
  // large index pays for on every item.
  return { item, values, fieldTokens: fieldTokens.slice(), fieldTokenOffsets: fieldTokenOffsets.slice() };
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
  strict: boolean,
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
    if (strict && tier === 3) continue;
    const score = tier * 1000 + fieldIndex * 100 + pos * 10 + value.length;
    if (best === null || score < best) best = score;
  }
  return best;
}

function fuzzyScore<T>(
  prepared: PreparedSearchItem<T>,
  terms: string[][],
  strict: boolean,
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
        strict,
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

/**
 * `strict` matches whole words and word starts only, without typos, for
 * keywords an AI model chose rather than a person typed.
 */
export function rankPreparedTopK<T>(
  items: PreparedSearchItem<T>[],
  query: string,
  limit: number,
  fuzzyFill = limit,
  multilingual = false,
  strict = false,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  const tokens = queryTokens(query);
  if (!q || !tokens.length || limit <= 0) return { items: [] };
  const terms = tokens.map(token => variants(token, multilingual));
  const heap = new BoundedHeap<ScoredSearchItem<T>>(limit, compareScored);
  const directMatches = new Uint8Array(items.length);
  let matches = 0;
  for (let i = 0; i < items.length; i++) {
    const prepared = items[i];
    const score = directScore(prepared, q, strict);
    if (score === null) continue;
    directMatches[i] = 1;
    matches++;
    heap.add({ item: prepared.item, score, idx: i });
  }
  if (matches < fuzzyFill) {
    for (let i = 0; i < items.length; i++) {
      const prepared = items[i];
      if (directMatches[i]) continue;
      const score = fuzzyScore(prepared, terms, strict);
      if (score === null) continue;
      heap.add({ item: prepared.item, score, idx: i });
    }
  }
  return { items: heap.sorted().map(value => value.item) };
}

export function rankPreparedNamesTopK<T>(
  index: PreparedNameSearchIndex<T>,
  query: string,
  limit: number,
  strict = false,
): RankedSearchResult<T> {
  const q = fold(query.trim());
  if (!q || limit <= 0) return { items: [] };
  const heap = new BoundedHeap<ScoredNameItem<T>>(limit, compareNameScored);
  for (let i = 0; i < index.items.length; i++) {
    const value = index.values[i];
    const pos = value.indexOf(q);
    if (pos === -1) continue;
    const tier = value === q
      ? 0
      : pos === 0
        ? 1
        : !isLetterOrNumber(value[pos - 1]) ? 2 : 3;
    if (strict && tier === 3) continue;
    heap.add({
      item: index.items[i],
      tier,
      pos,
      len: value.length,
      idx: i,
    });
  }
  return { items: heap.sorted().map(value => value.item) };
}

const scriptMemo = new WeakMap<object, { size: number; known: Partial<Record<SearchScript, boolean>> }>();

// Whether a list uses a script, worked out once per list and length, since a
// list may grow in place.
function memoScript(key: { length: number }, script: SearchScript, scan: () => boolean): boolean {
  let entry = scriptMemo.get(key);
  if (!entry || entry.size !== key.length) scriptMemo.set(key, entry = { size: key.length, known: {} });
  const cached = entry.known[script];
  if (cached !== undefined) return cached;
  return (entry.known[script] = scan());
}

export function preparedHaveScript<T>(items: PreparedSearchItem<T>[], script: SearchScript): boolean {
  return memoScript(items, script, () => items.some(item => item.values.some(value => hasScript(value, script))));
}

export function namesHaveScript<T>(index: PreparedNameSearchIndex<T>, script: SearchScript): boolean {
  return memoScript(index.values, script, () => index.values.some(value => hasScript(value, script)));
}

/**
 * The query, then its transliterations the searched items' scripts can match
 * (none without `hasTarget`), then the alternatives, without repeats once folded.
 */
export function expandedQueries(
  query: string,
  alternatives: readonly string[] | undefined,
  hasTarget: ((script: SearchScript) => boolean) | null,
): string[] {
  const queries = [query];
  const seen = new Set([fold(query.trim())]);
  const add = (value: string): void => {
    const folded = fold(value.trim());
    if (!folded || seen.has(folded)) return;
    seen.add(folded);
    queries.push(value);
  };
  if (hasTarget) {
    for (const other of transliterateQuery(fold(query.trim()))) {
      if (hasTarget(other.script)) add(other.text);
    }
  }
  if (alternatives) alternatives.forEach(add);
  return queries;
}

/** Whether the query has a spelling in another script that the searched items use. */
export function transliterates(query: string, hasTarget: (script: SearchScript) => boolean): boolean {
  return transliterateQuery(fold(query.trim())).some(other => hasTarget(other.script));
}

/**
 * Ranks the first query as usual; each further query only fills the slots
 * left, so its matches follow every match of the queries before it. Adds the
 * further queries that placed an item to `contributed`.
 */
export function rankExpanded<T>(
  queries: readonly string[],
  limit: number,
  rank: (query: string) => T[],
  contributed?: Set<string>,
): T[] {
  const items = rank(queries[0]).slice(0, limit);
  if (queries.length < 2) return items;
  const seen = new Set(items);
  for (let i = 1; i < queries.length && items.length < limit; i++) {
    const before = items.length;
    for (const item of rank(queries[i])) {
      if (items.length >= limit) break;
      if (seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }
    if (contributed && items.length > before) contributed.add(queries[i]);
  }
  return items;
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
