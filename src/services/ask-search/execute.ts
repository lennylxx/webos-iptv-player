import type { Channel, Programme } from '../../types';
import {
  prepareNameSearchItems,
  prepareSearchItems,
  rankPreparedNamesTopK,
  rankPreparedTopK,
} from '../../utils/channel-search';
import type { AskFilter, AskType } from './ask-query';
import { inWindows, type TimeWindow } from './time-window';

export interface AskProgram {
  channel: Channel;
  channelIndex: number;
  programme: Programme;
}

export function programDocument(result: AskProgram): string[] {
  return [
    result.programme.title,
    result.programme.category,
    result.programme.description,
    result.channel.name,
    result.channel.group,
  ];
}

/** Whether results of a kind are wanted: a time asks for programs unless the kinds are named. */
export function wantsType(filter: AskFilter, type: AskType, timed: boolean): boolean {
  if (filter.types.length) return filter.types.indexOf(type) >= 0;
  return !timed || type === 'program';
}

/** Names by how many items carry them, most first. */
export function namesByCount(values: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = raw.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.keys()).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

// Each keyword's matches in rank order, taken in turn so every keyword shows.
// `key` names an item, when equal items can arrive as different objects.
function interleave<T>(lists: T[][], limit: number, key?: (item: T) => unknown): T[] {
  const merged: T[] = [];
  const seen = new Set<unknown>();
  for (let rank = 0; merged.length < limit; rank++) {
    let any = false;
    for (const list of lists) {
      if (rank >= list.length) continue;
      any = true;
      const item = list[rank];
      const id = key ? key(item) : item;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    if (!any) break;
  }
  return merged;
}

/** A program as its result row names it: the channel and the start. */
export function programKey(result: AskProgram): string {
  return `${String(result.channelIndex)}:${String(result.programme.start.getTime())}`;
}

/**
 * Orders named items by the keywords: matches first, in rank order. With a
 * topic already narrowing them, the rest follow; otherwise only matches stay.
 */
export function rankNames<T extends { name: string }>(
  items: T[],
  keywords: string[],
  keepRest: boolean,
  limit: number,
): T[] {
  if (!keywords.length) return items.slice(0, limit);
  const index = prepareNameSearchItems(items);
  const matched = interleave(keywords.map(keyword => rankPreparedNamesTopK(index, keyword, limit, true).items), limit);
  if (!keepRest || matched.length >= limit) return matched;
  const seen = new Set(matched);
  for (const item of items) {
    if (matched.length >= limit) break;
    if (!seen.has(item)) matched.push(item);
  }
  return matched;
}

/** Channels in the named groups, or null when the filter names none. */
export function askChannels(channels: Channel[], filter: AskFilter, limit: number): Channel[] | null {
  if (!filter.groups.length) return null;
  const candidates = channels.filter(channel => filter.groups.indexOf(channel.group.trim()) >= 0);
  return rankNames(candidates, filter.keywords, true, limit);
}

// Live first, then upcoming by start, then past from the latest.
function compareAiring(now: number): (a: AskProgram, b: AskProgram) => number {
  return (a, b) => {
    const ra = airing(a.programme, now);
    const rb = airing(b.programme, now);
    if (ra !== rb) return ra - rb;
    const diff = a.programme.start.getTime() - b.programme.start.getTime();
    return ra === 2 ? -diff : diff;
  };
}

function airing(programme: Programme, now: number): number {
  return programme.stop.getTime() <= now ? 2 : programme.start.getTime() > now ? 1 : 0;
}

// The first `limit` items in airing order, without sorting them all: each
// airing bucket keeps its best `limit` in a short sorted list.
function firstByAiring(items: AskProgram[], now: number, limit: number): AskProgram[] {
  const order = compareAiring(now);
  const buckets: AskProgram[][] = [[], [], []];
  for (const item of items) {
    const bucket = buckets[airing(item.programme, now)];
    if (bucket.length >= limit && order(item, bucket[bucket.length - 1]) >= 0) continue;
    let at = bucket.length;
    while (at > 0 && order(item, bucket[at - 1]) < 0) at--;
    bucket.splice(at, 0, item);
    if (bucket.length > limit) bucket.pop();
  }
  return buckets[0].concat(buckets[1], buckets[2]).slice(0, limit);
}

export interface ProgramSource {
  channels: Channel[];
  // The guide channel id a channel's programs are listed under, or null.
  guideId: (channel: Channel) => string | null;
  programmes: (guideId: string) => Programme[] | null;
  // The genre a program is filtered by; its category when left out.
  genre?: (programme: Programme) => string;
}

export interface ProgramCollector {
  // Collects one channel's programs; true once every channel is done.
  step(): boolean;
  candidates: AskProgram[];
}

/**
 * Collects the programs on the named groups' channels, of the named genres,
 * airing in the windows, a channel at a time.
 */
export function collectPrograms(
  source: ProgramSource,
  filter: AskFilter,
  windows: TimeWindow[] | null,
): ProgramCollector {
  const candidates: AskProgram[] = [];
  // Channels that share a guide id list its programs once.
  const listed = new Set<string>();
  let channelIndex = 0;
  const genreOf = source.genre ?? ((programme: Programme) => programme.category);
  return {
    candidates,
    step(): boolean {
      if (channelIndex >= source.channels.length) return true;
      const index = channelIndex++;
      const channel = source.channels[index];
      if (filter.groups.length && filter.groups.indexOf(channel.group.trim()) < 0) return false;
      const id = source.guideId(channel);
      if (!id || listed.has(id)) return false;
      listed.add(id);
      for (const programme of source.programmes(id) ?? []) {
        if (filter.genres.length && filter.genres.indexOf(genreOf(programme).trim()) < 0) continue;
        if (windows && !inWindows(windows, programme.start.getTime(), programme.stop.getTime())) continue;
        candidates.push({ channel, channelIndex: index, programme });
      }
      return false;
    },
  };
}

/** Whether the filter narrows programs beyond their keywords. */
export function narrowsPrograms(filter: AskFilter, windows: TimeWindow[] | null): boolean {
  return filter.groups.length > 0 || filter.genres.length > 0 || !!windows;
}

const MATCH_CHUNK = 256;

export interface ProgramMatcher {
  // Matches one chunk of programs against the keywords; true once all are done.
  step(): boolean;
  matched: Set<AskProgram>;
}

/** Finds the programs any keyword matches, a chunk at a time. */
export function matchPrograms(candidates: AskProgram[], keywords: string[]): ProgramMatcher {
  const matched = new Set<AskProgram>();
  let next = 0;
  return {
    matched,
    step(): boolean {
      if (!keywords.length || next >= candidates.length) return true;
      const chunk = candidates.slice(next, next + MATCH_CHUNK);
      next += chunk.length;
      const prepared = prepareSearchItems(chunk, programDocument);
      for (const keyword of keywords) {
        // The model's words: whole words and word starts, no typo matches.
        for (const item of rankPreparedTopK(prepared, keyword, chunk.length, 0, false, true).items) matched.add(item);
      }
      return next >= candidates.length;
    },
  };
}

/**
 * Orders collected programs by airing. Keywords narrow them, or with a group
 * or genre named, put the matches first.
 */
export function rankPrograms(
  candidates: AskProgram[],
  matched: Set<AskProgram>,
  filter: AskFilter,
  now: number,
  limit: number,
): AskProgram[] {
  const topic = filter.groups.length > 0 || filter.genres.length > 0;
  if (!filter.keywords.length) return firstByAiring(candidates, now, limit);
  const hits = firstByAiring(candidates.filter(item => matched.has(item)), now, limit);
  if (!topic || hits.length >= limit) return hits;
  const rest = firstByAiring(candidates.filter(item => !matched.has(item)), now, limit - hits.length);
  return hits.concat(rest);
}

/** The programs the filter names, or null when it names no group, genre, or time. */
export function askPrograms(
  source: ProgramSource,
  filter: AskFilter,
  windows: TimeWindow[] | null,
  now: number,
  limit: number,
): AskProgram[] | null {
  if (!narrowsPrograms(filter, windows)) return null;
  const collector = collectPrograms(source, filter, windows);
  while (!collector.step()) { /* collect every channel */ }
  const matcher = matchPrograms(collector.candidates, filter.keywords);
  while (!matcher.step()) { /* match every chunk */ }
  return rankPrograms(collector.candidates, matcher.matched, filter, now, limit);
}

export { interleave };
