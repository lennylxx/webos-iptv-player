import { LlmService } from '../llm/llm-service';
import type { JsonSchema, NamedSchema } from '../llm/types';
import { ASK_TIMES, type AskTime } from './time-window';

export const SEARCH_ASK_FEATURE = 'search-ask';
const PROMPT_VERSION = 1;
const NAME_CEILING = 150;
const PICK_LIMIT = 10;
const KEYWORD_LIMIT = 6;
const KEYWORD_LENGTH = 60;
// The share of the prompt budget the name lists may fill, split between them.
const VOCABULARY_SHARE = 0.5;

export type AskType = 'channel' | 'program' | 'movie' | 'series';

/** Names that exist in the viewer's lists, most used first. */
export interface AskVocabulary {
  groups: string[];
  categories: string[];
  genres: string[];
}

export interface AskFilter {
  types: AskType[];
  keywords: string[];
  groups: string[];
  categories: string[];
  genres: string[];
  time: AskTime;
  // -1 when the request names no hour.
  fromHour: number;
  toHour: number;
}

export interface AskReply {
  filter: AskFilter;
  dropped: number;
  cached: boolean;
}

interface Reply {
  types: AskType[];
  keywords: string[];
  groups?: string[];
  categories?: string[];
  genres?: string[];
  time: AskTime;
  from_hour: number;
  to_hour: number;
}

const SYSTEM_PROMPT = [
  'You turn a TV viewer\'s search request into a filter over their own IPTV channels, program guide, and movie and series catalog.',
  'The user message is JSON {"query":"...","types":[...],"groups":[...],"categories":[...],"genres":[...]}: the request, the kinds of results that exist, and the names in the viewer\'s lists. groups are channel groups, categories are movie and series categories, genres are program guide categories. A list may be missing.',
  'types: the kinds the request asks for (program is a TV guide listing); [] when it does not say.',
  'keywords: words a matching title, channel, or description would contain, as the request writes them, plus their common spellings in other languages; [] when the request names only a kind, genre, language, country, or time.',
  'groups, categories, genres: names copied exactly from the given lists that match the request\'s topic, language, or country; [] when none clearly matches.',
  'time: when a program airs; "any" when the request gives no time. from_hour, to_hour: the hours 0-24 the request names, else -1.',
  'Never invent names or titles.',
].join('\n');

// Rough token count: ASCII runs about four characters a token, CJK about one.
function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) tokens += text.charCodeAt(i) < 128 ? 0.3 : 1;
  return Math.ceil(tokens);
}

/** The leading names that fit a token budget, at most the ceiling. */
export function capNames(names: string[], budgetTokens: number): string[] {
  const kept: string[] = [];
  const seen: Record<string, true> = {};
  let used = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen[name]) continue;
    const cost = estimateTokens(name) + 2;
    if (used + cost > budgetTokens || kept.length >= NAME_CEILING) break;
    seen[name] = true;
    kept.push(name);
    used += cost;
  }
  return kept;
}

/** Each list's share of the prompt budget. */
export function capVocabulary(vocabulary: AskVocabulary, contextTokens: number): AskVocabulary {
  const lists = [vocabulary.groups, vocabulary.categories, vocabulary.genres].filter(list => list.length).length;
  const share = lists ? Math.floor((contextTokens * VOCABULARY_SHARE) / lists) : 0;
  // The most used names are kept, then sorted, so the prompt and its cache
  // key stay the same while the counts shift.
  return {
    groups: capNames(vocabulary.groups, share).sort(),
    categories: capNames(vocabulary.categories, share).sort(),
    genres: capNames(vocabulary.genres, share).sort(),
  };
}

function names(list: string[]): JsonSchema {
  return { type: 'array', items: { type: 'string', enum: list }, maxItems: PICK_LIMIT };
}

export function askSchema(types: AskType[], vocabulary: AskVocabulary): NamedSchema {
  const properties: Record<string, JsonSchema> = {
    types: { type: 'array', items: { type: 'string', enum: types }, maxItems: types.length },
    keywords: { type: 'array', items: { type: 'string' }, maxItems: KEYWORD_LIMIT },
    time: { type: 'string', enum: ASK_TIMES.slice() },
    from_hour: { type: 'integer', minimum: -1, maximum: 24 },
    to_hour: { type: 'integer', minimum: -1, maximum: 24 },
  };
  // An empty enum is no valid schema, so a list the viewer lacks is left out.
  if (vocabulary.groups.length) properties.groups = names(vocabulary.groups);
  if (vocabulary.categories.length) properties.categories = names(vocabulary.categories);
  if (vocabulary.genres.length) properties.genres = names(vocabulary.genres);
  return {
    name: 'search_filter',
    schema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

function cleanKeywords(list: string[]): string[] {
  const kept: string[] = [];
  const seen: Record<string, true> = {};
  for (const raw of list) {
    const keyword = raw.trim();
    const key = keyword.toLowerCase();
    if (!keyword || keyword.length > KEYWORD_LENGTH || seen[key]) continue;
    seen[key] = true;
    kept.push(keyword);
    if (kept.length >= KEYWORD_LIMIT) break;
  }
  return kept;
}

function unique<T>(list: T[]): T[] {
  return list.filter((item, index) => list.indexOf(item) === index);
}

export function filterFromReply(reply: Reply): AskFilter {
  return {
    types: unique(reply.types),
    keywords: cleanKeywords(reply.keywords),
    groups: unique(reply.groups ?? []),
    categories: unique(reply.categories ?? []),
    genres: unique(reply.genres ?? []),
    time: reply.time,
    fromHour: reply.from_hour,
    toHour: reply.to_hour,
  };
}

/** Asks the AI model to turn a search request into a filter over the given names. */
export async function askSearch(
  query: string,
  types: AskType[],
  vocabulary: AskVocabulary,
  signal?: AbortSignal,
): Promise<AskReply> {
  const lists = capVocabulary(vocabulary, LlmService.contextTokens());
  const message: Record<string, unknown> = { query: query.trim(), types };
  if (lists.groups.length) message.groups = lists.groups;
  if (lists.categories.length) message.categories = lists.categories;
  if (lists.genres.length) message.genres = lists.genres;
  const outcome = await LlmService.run<Reply>({
    feature: SEARCH_ASK_FEATURE,
    priority: 'foreground',
    system: SYSTEM_PROMPT,
    user: JSON.stringify(message),
    schema: askSchema(types, lists),
    promptVersion: PROMPT_VERSION,
    maxTokens: 600,
    signal,
  });
  return { filter: filterFromReply(outcome.value), dropped: outcome.dropped, cached: outcome.cached };
}
