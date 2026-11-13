import type {
  Channel,
  ChannelOverride,
  EpgChannel,
  EpgSource,
  ParsedEpg,
  Programme,
} from '../types';
import { fetchAndParseXMLTV } from '../parsers/xmltv-loader';
import { createLogger } from '../utils/logger';
import { EpgTimeIndex } from '../utils/epg-time-index';
import { yieldToEventLoop } from '../utils/yield';
import { CONFIG } from '../config';
import { getCachedEpg, setCachedEpg } from './idb-cache';
import { releaseHeldRecord } from './held-records';
import type { CachedEpgFilter } from './idb-cache';
import { ChannelCustomizationService } from './channel-customization';
import { channelKey } from '../utils/channel';
import { StorageService } from './storage-service';

const log = createLogger('EPG');

interface SourceState {
  data: ParsedEpg;
  timestamp: number;
  needsRefresh: boolean;
  mappingIndex?: PreparedEpgMappingSearchEntry[];
  /** Timestamp of the epg-cache record holding `data`'s programme arrays. */
  cacheTimestamp?: number;
}

/** Where a channel's programmes live in the epg-cache store. */
export interface ProgrammeCacheOrigin {
  url: string;
  id: string;
  timestamp: number;
}

interface ProgrammeOrigin {
  url: string;
  id: string;
  state: SourceState;
}

/** A loaded source as the last index rebuild saw it, by encoded URL. */
interface IndexedSource {
  source: EpgSource;
  state: SourceState;
  offsetMs: number;
  /** Time-shifted copies, made on first lookup so their identity holds. */
  shifted: Map<string, Programme[]>;
}

/** A per-channel offset copy of a base channel's programmes. */
interface DerivedEntry {
  channel: EpgChannel | undefined;
  programmes: Programme[];
  origin: ProgrammeOrigin | null;
}

function ownValue<T>(record: Record<string, T> | null, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function shiftProgrammes(programmes: Programme[], deltaMs: number): Programme[] {
  return programmes.map(programme => ({
    ...programme,
    start: new Date(programme.start.getTime() + deltaMs),
    stop: new Date(programme.stop.getTime() + deltaMs),
  }));
}

/** The playlist channels a source is parsed down to. */
interface SourceFilter {
  ids: Set<string>;
  names: Set<string>;
  /** Fingerprint of the inputs it was built from; see `FilterKey`. */
  key: string;
}

type CacheRestoreResult = 'missing' | 'fresh' | 'stale';

/** Filters built from one set of playlist channels and channel mappings. */
interface FilterMemo {
  channels: Channel[] | null;
  mapped: string;
  mappedIds: string[];
  bySource: Map<string, SourceFilter>;
  /** Keys taken without building the filter, by `filterSourceKey`. */
  keys: Map<string, string>;
}

// A filter walks every playlist channel; on a TV that is seconds of work, so
// it yields between slices instead of blocking input for the whole walk.
const FILTER_SLICE_MS = 12;
const FILTER_SLICE_CHECK = 256;
// Below this a walk costs well under a slice, so it runs at once.
const FILTER_SYNC_MAX_CHANNELS = 4096;

function nextTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function emptyFilterMemo(): FilterMemo {
  return { channels: null, mapped: '', mappedIds: [], bySource: new Map(), keys: new Map() };
}

function filterSourceKey(source: EpgSource): string {
  return `${source.kind}|${source.playlistIds.join(',')}|${source.url}`;
}

export interface EpgMappingCandidate {
  id: string;
  channelId: string;
  name: string;
  sourceName: string;
}

export interface EpgMappingSearchEntry extends EpgMappingCandidate {
  fields: string[];
  sourceIndex: number;
}

interface PreparedEpgMappingSearchEntry {
  channelId: string;
  name: string;
  fields: string[];
}

function indexChannelName(index: Map<string, string[]>, name: string, id: string): void {
  const normalized = name.toLowerCase();
  const ids = index.get(normalized);
  if (!ids) index.set(normalized, [id]);
  else if (!ids.includes(id)) ids.push(id);
}

// A large guide's names and aliases took the longest task of a warm launch
// to index at once, so they are indexed a slice at a time. A message task
// yields without the timer clamp that tens of slices would add up.
async function buildNameIndexSliced(channels: ParsedEpg['channels']): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const ids = Object.keys(channels);
  let sliceStart = Date.now();
  for (let i = 0; i < ids.length; i++) {
    if (i % FILTER_SLICE_CHECK === 0 && Date.now() - sliceStart >= FILTER_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = Date.now();
    }
    const id = ids[i];
    const channel = channels[id];
    indexChannelName(index, channel.name, id);
    const aliases = channel.aliases;
    if (aliases) for (const alias of aliases) indexChannelName(index, alias, id);
  }
  return index;
}

function servedBy(playlistIds: Set<string>, channel: Channel): boolean {
  for (const id of channel.playlistIds) if (playlistIds.has(id)) return true;
  return false;
}

function filterServes(source: EpgSource): (channel: Channel) => boolean {
  if (source.kind === 'manual' && source.playlistIds.length === 0) return () => true;
  const playlistIds = new Set(source.playlistIds);
  return channel => servedBy(playlistIds, channel);
}

function addToFilter(filter: SourceFilter, channel: Channel): void {
  if (channel.id) filter.ids.add(channel.id);
  // A rename keeps the source name, and findChannelId matches either one.
  if (channel.name) filter.names.add(channel.name.toLowerCase());
  if (channel.sourceName) filter.names.add(channel.sourceName.toLowerCase());
}

/**
 * Hashes every input a source's filter is built from, so equal keys mean
 * equal filters. A boot compares it with the key cached beside the guide
 * instead of building the filter: hashing a channel costs far less than
 * lowercasing its names into two sets and checking the cache against them.
 * Channels are summed, so a reorder, which leaves the filter alone, keeps it.
 */
class FilterKey {
  private readonly head: HashPair;
  private sum: HashPair = [0, 0];
  private count = 0;

  constructor(source: EpgSource, mappedIds: string[]) {
    let head = hashString(SEED, filterSourceKey(source));
    for (const id of mappedIds.slice().sort()) head = hashString(head, id);
    this.head = head;
  }

  addChannel(channel: Channel): void {
    if (!channel.id && !channel.name && !channel.sourceName) return;
    let hash = hashString(SEED, channel.id || '');
    hash = hashString(hash, channel.name || '');
    hash = hashString(hash, channel.sourceName || '');
    this.sum = [(this.sum[0] + hash[0]) | 0, (this.sum[1] + hash[1]) | 0];
    this.count++;
  }

  digest(): string {
    const hash = hashString(this.head, `${String(this.count)}:${String(this.sum[0])}:${String(this.sum[1])}`);
    return `2.${(hash[0] >>> 0).toString(36)}.${(hash[1] >>> 0).toString(36)}`;
  }
}

type HashPair = [number, number];

const SEED: HashPair = [0x811c9dc5, 0x9747b28c];

// Length-prefixed, so ('ab', 'c') and ('a', 'bc') never hash alike.
function hashString(start: HashPair, value: string): HashPair {
  let a = Math.imul(start[0] ^ value.length, 0x01000193);
  let b = Math.imul(start[1] ^ value.length, 0x5bd1e995);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return [a, b];
}

function buildFilter(source: EpgSource, channels: Channel[], mappedIds: string[]): SourceFilter {
  const filter: SourceFilter = { ids: new Set(mappedIds), names: new Set(), key: '' };
  const key = new FilterKey(source, mappedIds);
  const serves = filterServes(source);
  for (const channel of channels) {
    if (!serves(channel)) continue;
    addToFilter(filter, channel);
    key.addChannel(channel);
  }
  filter.key = key.digest();
  return filter;
}

async function forEachSliced(channels: Channel[], visit: (channel: Channel) => void): Promise<void> {
  let sliceStart = Date.now();
  for (let i = 0; i < channels.length; i++) {
    if (i % FILTER_SLICE_CHECK === 0 && Date.now() - sliceStart >= FILTER_SLICE_MS) {
      await nextTask();
      sliceStart = Date.now();
    }
    visit(channels[i]);
  }
}

async function buildFilterSliced(
  source: EpgSource,
  channels: Channel[],
  mappedIds: string[],
): Promise<SourceFilter> {
  const filter: SourceFilter = { ids: new Set(mappedIds), names: new Set(), key: '' };
  const key = new FilterKey(source, mappedIds);
  const serves = filterServes(source);
  await forEachSliced(channels, (channel) => {
    if (!serves(channel)) return;
    addToFilter(filter, channel);
    key.addChannel(channel);
  });
  filter.key = key.digest();
  return filter;
}

async function filterKeySliced(
  source: EpgSource,
  channels: Channel[],
  mappedIds: string[],
): Promise<string> {
  const key = new FilterKey(source, mappedIds);
  const serves = filterServes(source);
  await forEachSliced(channels, (channel) => {
    if (serves(channel)) key.addChannel(channel);
  });
  return key.digest();
}

function sourceAppliesToChannel(source: EpgSource, channel: Channel): boolean {
  return (source.kind === 'manual' && source.playlistIds.length === 0)
    || source.playlistIds.some((id) => channel.playlistIds.includes(id));
}

class EpgServiceImpl {
  private indexedSources = new Map<string, IndexedSource>();
  private derivedEntries = new Map<string, DerivedEntry>();
  /** Offset of the first loaded feed that declares one. Display remains global. */
  tzOffsetMinutes: number | null = null;
  loaded = false;
  private sources: EpgSource[] = [];
  private states = new Map<string, SourceState>();
  private channelIdsByName = new Map<string, Map<string, string[]>>();
  private timeIndexes = new Map<string, { source: Programme[]; index: EpgTimeIndex }>();
  private derivedOffsets = new Map<string, { id: string; baseId: string; minutes: number }>();
  private mappedChannelIds: string[] = [];
  private playlistChannels: Channel[] | null = null;
  /** The filters the last completed load was built from, kept as their
   *  inputs so a boot need not build them before the first screen. */
  private applied: { memo: FilterMemo; sources: EpgSource[] } | null = null;
  private indexRevision = 0;
  private builtIndexRevision = -1;
  private filterMemo: FilterMemo = emptyFilterMemo();
  private pendingWork: Promise<unknown> | null = null;
  private revision = 0;
  private resetEpoch = 0;
  private mappingRevisionValue = 0;
  private guideRevisionValue = 0;
  private lastIdleKey = '';

  get mappingRevision(): number {
    return this.mappingRevisionValue;
  }

  /** Changes whenever the published guide is replaced or cleared. */
  get guideRevision(): number {
    return this.guideRevisionValue;
  }

  getProgrammes(channelId: string): Programme[] | null {
    return this.programmesOf(channelId) ?? null;
  }

  /** Earliest and latest programme start across the guide, without flattening it. */
  getProgrammeStartRange(): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    const visit = (programmes: Programme[], offsetMs: number): void => {
      if (!programmes.length) return;
      const first = programmes[0].start.getTime() + offsetMs;
      const last = programmes[programmes.length - 1].start.getTime() + offsetMs;
      if (first < min) min = first;
      if (last > max) max = last;
    };
    this.indexedSources.forEach(entry => {
      const all = entry.state.data.programmes;
      for (const id in all) visit(all[id], entry.offsetMs);
    });
    this.derivedEntries.forEach(entry => visit(entry.programmes, 0));
    return min === Infinity ? null : { min, max };
  }

  getNextRefreshDelayMs(intervalMs: number): number {
    let nextDueAt = Number.POSITIVE_INFINITY;
    for (const source of this.sources) {
      // An idle source keeps no state; counting it as due re-arms a 0ms timer forever.
      if (this.isIdle(source)) continue;
      const state = this.states.get(source.url);
      if (!state || state.needsRefresh) return 0;
      nextDueAt = Math.min(nextDueAt, state.timestamp + intervalMs);
    }
    return nextDueAt === Number.POSITIVE_INFINITY
      ? intervalMs
      : Math.max(0, nextDueAt - Date.now());
  }

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale programme data does not survive a reload.
   */
  reset(): void {
    this.resetEpoch++;
    this.revision++;
    this.guideRevisionValue++;
    this.indexedSources = new Map();
    this.derivedEntries.clear();
    this.tzOffsetMinutes = null;
    this.loaded = false;
    this.mappingRevisionValue++;
    this.sources = [];
    this.states.clear();
    this.indexRevision++;
    this.channelIdsByName.clear();
    this.timeIndexes.clear();
    this.derivedOffsets.clear();
    this.mappedChannelIds = [];
    this.lastIdleKey = '';
    this.playlistChannels = null;
    this.applied = null;
    this.filterMemo = emptyFilterMemo();
  }

  load(
    sources: EpgSource[],
    channels?: Channel[],
    onDataPublished?: () => void,
  ): Promise<void> {
    return this.enqueue(() => this.runLoad(sources, channels, onDataPublished));
  }

  // `ready` holds the restore at the head of the queue, so work queued after
  // it still waits for the cached guide.
  restoreCached(
    sources: EpgSource[],
    channels?: Channel[],
    ready?: Promise<unknown>,
  ): Promise<void> {
    const epoch = this.resetEpoch;
    return this.enqueue(async () => {
      if (ready) await ready;
      // A reset while this waited means its sources were removed.
      if (epoch !== this.resetEpoch) return;
      // Resolves even when it fails, so the caller still starts refreshes.
      try {
        await this.runRestoreCached(sources, channels);
      } catch (err) {
        log.error('Cached guide restore failed:', err);
      }
    });
  }

  private async runRestoreCached(
    sources: EpgSource[],
    channels?: Channel[],
  ): Promise<void> {
    this.playlistChannels = channels ?? null;
    this.setSources(sources);
    this.mappedChannelIds = this.collectMappedChannelIds();
    // A large playlist builds a source's filter only when it has a cached
    // guide to check; a small one builds them all now, at little cost.
    const memo = this.currentFilterMemo();
    if (memo.channels !== null && memo.channels.length <= FILTER_SYNC_MAX_CHANNELS) {
      this.prepareFilters(memo, this.sources);
    }
    this.applied = { memo, sources: this.sources };
    const revision = ++this.revision;
    const restored = await Promise.all(this.sources.map(async (source) => {
      try {
        return {
          source,
          result: await this.restoreCachedSource(source, revision),
        };
      } catch (err) {
        log.warn('Cache read failed:', source.url, err);
        return { source, result: 'missing' as const };
      }
    }));
    if (revision !== this.revision) return;
    for (const { source, result } of restored) {
      if (result !== 'missing') continue;
      this.states.delete(source.url);
      this.indexRevision++;
      this.channelIdsByName.delete(source.url);
    }
    this.publish(revision);
  }

  /**
   * One XMLTV parse at a time. Two concurrent parses hold two full sets of
   * retained programmes, which is the allocation the retention ceiling exists
   * to bound, and `refresh()` reaches the same parser as `load()` — so both
   * queue here. Each body re-reads its own preconditions when it finally
   * runs, so work the entry ahead of it already did is skipped, not repeated.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.pendingWork;
    const task = (async () => {
      if (previous) await previous.catch(() => undefined);
      return run();
    })();
    this.pendingWork = task;
    return (async () => {
      try {
        return await task;
      } finally {
        if (this.pendingWork === task) this.pendingWork = null;
      }
    })();
  }

  private async runLoad(
    sources: EpgSource[],
    channels?: Channel[],
    onDataPublished?: () => void,
  ): Promise<void> {
    const previousSources = this.sources;
    this.playlistChannels = channels ?? null;
    this.setSources(sources);
    this.mappedChannelIds = this.collectMappedChannelIds();
    const startRevision = this.revision;
    const memo = this.currentFilterMemo();
    const pending = this.prepareFilters(memo, this.sources);
    if (pending) await pending;
    const filters = new Map(this.sources.map(source =>
      [source.url, this.filterIn(memo, source)] as const));
    const applied = this.applied;
    let unchanged = this.loaded
      && applied !== null
      && sameSourceList(previousSources, this.sources);
    if (unchanged && applied && applied.memo !== memo) {
      const prior = applied.memo;
      // A filter the last load never built would come from channels renamed
      // in place since then, so it cannot show what that load used; a key it
      // took instead still does.
      unchanged = prior.channels === null || applied.sources.every(source =>
        prior.bySource.has(filterSourceKey(source)))
        ? sameFilters(new Map(applied.sources.map(source =>
          [source.url, this.filterIn(prior, source)] as const)), filters)
        : sameKeys(prior, applied.sources, filters);
    }
    if (this.revision !== startRevision) return;
    // Equal filters: keep only the new memo, so the old channel list can go.
    this.applied = { memo, sources: this.sources };
    // Entering and leaving channel edit mode rebuilds the channel array to
    // reveal hidden entries, without changing which channels are eligible
    // or what they map to. Reloading on that would re-read the whole cached
    // guide, or start a second parse, for an identical filter.
    if (unchanged) return;
    const revision = ++this.revision;
    await Promise.all(this.sources.map((source) =>
      this.loadSource(source, revision, onDataPublished)));
    if (revision !== this.revision) return;
    this.publish(revision);
  }

  refresh(onDataPublished?: () => void, force = false): Promise<boolean> {
    return this.enqueue(() => this.runRefresh(onDataPublished, force));
  }

  private async runRefresh(
    onDataPublished?: () => void,
    force = false,
  ): Promise<boolean> {
    const refreshIntervalMs = StorageService.getEpgRefreshIntervalMs();
    const idle = new Set<string>();
    for (const source of this.sources) {
      if (this.isIdle(source)) idle.add(source.url);
    }
    // Log each distinct idle set once; the source list is part of the key
    // so an account switch reports its own idle sources.
    const idleKey = idle.size
      ? `${Array.from(idle).sort().join(' ')}|${this.sources.map(s => s.url).join(' ')}`
      : '';
    if (idleKey !== this.lastIdleKey) {
      this.lastIdleKey = idleKey;
      log.info(
        'EPG sources with no eligible channels skipped',
        'event=epg.refresh.idle',
        `count=${String(idle.size)}`,
        `total=${String(this.sources.length)}`,
      );
    }
    const sourcesToRefresh = this.sources.filter((source) => {
      if (idle.has(source.url)) return false;
      const state = this.states.get(source.url);
      return force || !state || state.needsRefresh
        || (refreshIntervalMs !== null
          && Date.now() - state.timestamp >= refreshIntervalMs);
    });
    if (!sourcesToRefresh.length) return true;

    this.mappedChannelIds = this.collectMappedChannelIds();
    const startRevision = this.revision;
    const pending = this.prepareFilters(this.currentFilterMemo(), sourcesToRefresh);
    if (pending) {
      await pending;
      if (this.revision !== startRevision) return false;
    }
    const revision = ++this.revision;
    const refreshed = await Promise.all(sourcesToRefresh.map(source =>
      this.fetchSource(source, this.filterFor(source), revision, onDataPublished)));
    if (revision !== this.revision) return false;
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
    this.mappingRevisionValue++;
    return refreshed.every(Boolean);
  }

  getNowPlaying(channelId: string): Programme | null {
    return this.getTimeIndex(channelId)?.currentAt(Date.now()) ?? null;
  }

  getUpcoming(channelId: string, count = 5): Programme[] {
    return this.getTimeIndex(channelId)?.upcomingAfter(Date.now(), count) ?? [];
  }

  getProgrammesStartingInRange(channelId: string, from: number, to: number): Programme[] {
    return this.getTimeIndex(channelId)?.startingInRange(from, to) ?? [];
  }

  getProgrammesIntersectingRange(channelId: string, from: number, to: number): Programme[] {
    return this.getTimeIndex(channelId)?.intersectingRange(from, to) ?? [];
  }

  getProgrammeAtStart(channelId: string, timestamp: number): Programme | null {
    return this.getTimeIndex(channelId)?.atStart(timestamp) ?? null;
  }

  getSourceName(url: string): string | null {
    return this.states.get(url)?.data.sourceName?.trim() || null;
  }

  getSourceUrl(channel: Channel): string | null {
    const channelId = this.findChannelId(channel);
    if (!channelId) return null;
    const separator = channelId.indexOf('::');
    if (separator < 0) return null;
    try {
      return decodeURIComponent(channelId.slice(0, separator));
    } catch {
      return null;
    }
  }

  findChannelId(channel: Channel): string | null {
    const override = ChannelCustomizationService.overrideFor(channelKey(channel));
    const baseId = this.findBaseChannelId(channel, override);
    return baseId ? this.applyChannelOffset(channel, baseId, override) : null;
  }

  // A time shift copies programmes without touching their text, so a shifted
  // or per-channel-offset list still matches its cached source list.
  programmeCacheOrigin(channelId: string): ProgrammeCacheOrigin | null {
    const origin = this.originOf(channelId);
    const timestamp = origin?.state.cacheTimestamp;
    if (!origin || timestamp === undefined) return null;
    return { url: origin.url, id: origin.id, timestamp };
  }

  /** The epg-cache records the loaded guide came from, for the Search index prewarm. */
  getProgrammeCacheRecords(): Array<{ url: string; timestamp: number }> {
    const records: Array<{ url: string; timestamp: number }> = [];
    for (const source of this.sources) {
      const timestamp = this.states.get(source.url)?.cacheTimestamp;
      if (timestamp !== undefined) records.push({ url: source.url, timestamp });
    }
    return records;
  }

  getSourceOffsetMinutes(channel: Channel): number {
    const override = ChannelCustomizationService.overrideFor(channelKey(channel));
    const baseId = this.findBaseChannelId(channel, override);
    return baseId ? this.sourceOffsetOf(baseId) : 0;
  }

  private findBaseChannelId(channel: Channel, override: ChannelOverride | null): string | null {
    if (!this.sources.length) return this.findLegacyChannelId(channel);
    if (override?.epgChannelId && this.channelOf(override.epgChannelId)) {
      const mapped = this.splitChannelKey(override.epgChannelId);
      const source = mapped && this.sources.find(item => item.url === mapped.url);
      if (source && sourceAppliesToChannel(source, channel)) return override.epgChannelId;
    }
    const candidates = this.sources.filter(source => sourceAppliesToChannel(source, channel));

    for (const source of candidates) {
      if (!channel.id) continue;
      const key = this.channelKey(source.url, channel.id);
      if (this.programmesOf(key)?.length) return key;
    }

    const name = channel.name.toLowerCase();
    const sourceName = (channel.sourceName ?? '').toLowerCase();
    if (!name && !sourceName) return null;
    for (const source of candidates) {
      const state = this.states.get(source.url);
      if (!state) continue;
      const index = this.channelIdsByName.get(source.url);
      const ids = [
        ...(index?.get(name) ?? []),
        ...(sourceName && sourceName !== name ? index?.get(sourceName) ?? [] : []),
      ];
      for (const id of ids) {
        const key = this.channelKey(source.url, id);
        if (this.programmesOf(key)?.length) return key;
      }
    }
    return null;
  }

  private applyChannelOffset(
    channel: Channel,
    baseId: string,
    override: ChannelOverride | null,
  ): string {
    const key = channelKey(channel);
    const previous = this.derivedOffsets.get(key);
    const deltaMinutes = override?.epgOffsetDeltaMinutes;
    const sourceMinutes = this.sourceOffsetOf(baseId);
    if (deltaMinutes === undefined || deltaMinutes === 0) {
      this.removeDerivedOffset(key, previous);
      return baseId;
    }
    const minutes = sourceMinutes + deltaMinutes;
    if (previous?.baseId === baseId && previous.minutes === minutes) return previous.id;
    this.removeDerivedOffset(key, previous);
    const source = this.programmesOf(baseId);
    if (!source) return baseId;
    const id = `${baseId}::channel:${encodeURIComponent(key)}`;
    const shifted = shiftProgrammes(source, deltaMinutes * 60_000);
    const guideChannel = this.channelOf(baseId);
    this.derivedEntries.set(id, {
      channel: guideChannel,
      programmes: shifted,
      origin: this.originOf(baseId),
    });
    this.timeIndexes.set(id, { source: shifted, index: new EpgTimeIndex(shifted) });
    this.derivedOffsets.set(key, { id, baseId, minutes });
    return id;
  }

  private removeDerivedOffset(
    key: string,
    derived: { id: string } | undefined,
  ): void {
    if (!derived) return;
    this.derivedEntries.delete(derived.id);
    this.timeIndexes.delete(derived.id);
    this.derivedOffsets.delete(key);
  }

  getMappingSearchEntries(channel: Channel): EpgMappingSearchEntry[] {
    const entries: EpgMappingSearchEntry[] = [];
    const sources = this.sources.filter(source => sourceAppliesToChannel(source, channel));
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const source = sources[sourceIndex];
      const state = this.states.get(source.url);
      if (!state) continue;
      const data = state.data;
      if (!state.mappingIndex) {
        state.mappingIndex = [];
        for (const id in data.channels) {
          const epgChannel = data.channels[id];
          state.mappingIndex.push({
            channelId: id,
            name: epgChannel.name,
            fields: [id, epgChannel.name, ...(epgChannel.aliases ?? [])]
              .map(value => value.toLowerCase()),
          });
        }
      }
      for (const entry of state.mappingIndex) {
        const candidateId = this.channelKey(source.url, entry.channelId);
        entries.push({
          id: candidateId,
          channelId: entry.channelId,
          name: entry.name,
          sourceName: data.sourceName?.trim() || `EPG ${String(sourceIndex + 1)}`,
          fields: entry.fields,
          sourceIndex,
        });
      }
    }
    return entries;
  }

  getLocalMappingCandidates(
    channel: Channel,
    query: string,
    limit?: number,
  ): EpgMappingCandidate[] {
    const normalized = query.trim().toLowerCase();
    const current = ChannelCustomizationService.overrideFor(channelKey(channel))?.epgChannelId;
    const candidates: Array<EpgMappingCandidate & { score: number }> = [];
    for (const entry of this.getMappingSearchEntries(channel)) {
        const selected = entry.id === current;
        let exact = false;
        let prefix = false;
        let position = -1;
        if (normalized) {
          for (const field of entry.fields) {
            const next = field.indexOf(normalized);
            if (next < 0) continue;
            if (position < 0 || next < position) position = next;
            if (next === 0) prefix = true;
            if (field === normalized) exact = true;
          }
          if (position < 0 && !selected) continue;
        }
        candidates.push({
          id: entry.id,
          channelId: entry.channelId,
          name: entry.name,
          sourceName: entry.sourceName,
          score: selected
            ? -1
            : normalized
            ? (exact ? 0 : prefix ? 100 : 200) + Math.max(0, position)
              + entry.sourceIndex * 1000
            : entry.sourceIndex * 1000,
        });
    }
    const sorted = candidates
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)
        || a.channelId.localeCompare(b.channelId));
    const visible = limit === undefined ? sorted : sorted.slice(0, Math.max(0, limit));
    return visible.map(candidate => ({
        id: candidate.id,
        channelId: candidate.channelId,
        name: candidate.name,
        sourceName: candidate.sourceName,
      }));
  }

  private setSources(sources: EpgSource[]): void {
    const merged: EpgSource[] = [];
    for (const source of sources) {
      if (!source.url) continue;
      const existing = merged.find((item) => item.url === source.url);
      if (existing) {
        const globalManual =
          (existing.kind === 'manual' && existing.playlistIds.length === 0)
          || (source.kind === 'manual' && source.playlistIds.length === 0);
        if (globalManual) {
          existing.playlistIds = [];
        } else {
          for (const id of source.playlistIds) {
            if (!existing.playlistIds.includes(id)) existing.playlistIds.push(id);
          }
        }
        if (source.kind === 'manual') existing.kind = 'manual';
        if (source.offsetMinutes !== undefined) existing.offsetMinutes = source.offsetMinutes;
      } else {
        merged.push({ ...source, playlistIds: source.playlistIds.slice() });
      }
    }
    this.sources = merged;
    this.indexRevision++;
    const active = new Set(merged.map((source) => source.url));
    for (const url of this.states.keys()) {
      if (!active.has(url)) {
        this.states.delete(url);
        this.indexRevision++;
        this.channelIdsByName.delete(url);
      }
    }
  }

  private async loadSource(
    source: EpgSource,
    revision: number,
    onDataPublished?: () => void,
  ): Promise<void> {
    let cached: CacheRestoreResult = 'missing';
    try {
      cached = await this.restoreCachedSource(source, revision);
    } catch (err) {
      log.warn('Cache read failed:', source.url, err);
    }
    if (cached === 'fresh') return;
    if (cached === 'stale') this.publish(revision, onDataPublished);
    const filter = this.filterFor(source);
    await this.fetchSource(source, filter, revision, onDataPublished);
  }

  private async restoreCachedSource(
    source: EpgSource,
    revision: number,
  ): Promise<CacheRestoreResult> {
    if (revision !== this.revision) return 'missing';
    if (this.isIdle(source)) {
      this.states.delete(source.url);
      this.indexRevision++;
      this.channelIdsByName.delete(source.url);
      // Idle means its filter is empty; record that so a later load can
      // compare against it instead of reloading every source.
      const memo = this.currentFilterMemo();
      memo.bySource.set(filterSourceKey(source), {
        ids: new Set(),
        names: new Set(),
        key: new FilterKey(source, this.mappedIdsFor(memo, source)).digest(),
      });
      return 'missing';
    }
    const cached = await getCachedEpg(source.url);
    if (revision !== this.revision || !cached) return 'missing';
    const memo = this.currentFilterMemo();
    // Parsed with the very filter this playlist builds, so it needs no check.
    let trusted = false;
    if (cached.filter?.key !== undefined && memo.channels !== null) {
      const key = await this.filterKeyIn(memo, source);
      if (revision !== this.revision) return 'missing';
      trusted = key === cached.filter.key;
    }
    let filter: SourceFilter | null = null;
    let covered = true;
    let filtered = { data: cached.data, changed: false };
    if (!trusted) {
      const pending = this.prepareFilters(memo, [source]);
      if (pending) {
        await pending;
        if (revision !== this.revision) return 'missing';
      }
      filter = this.filterIn(memo, source);
      covered = covers(cached.filter, filter);
      filtered = filterParsedEpg(cached.data, filter);
    }
    const age = Date.now() - cached.timestamp;
    const refreshIntervalMs = StorageService.getEpgRefreshIntervalMs();
    const hasTzField = 'tzOffsetMinutes' in cached.data;
    const hasChannelCatalog = !cached.filter
      || cached.data.channelCatalogComplete === true;
    // A filtered rewrite below keeps the timestamp and the kept id arrays.
    const stored = await this.setState(source.url, {
      data: filtered.data,
      timestamp: cached.timestamp,
      needsRefresh: !hasTzField || !hasChannelCatalog || !covered,
      cacheTimestamp: cached.timestamp,
    }, revision);
    if (!stored) return 'missing';
    const fresh = (refreshIntervalMs === null || age < refreshIntervalMs)
      && hasTzField
      && hasChannelCatalog
      && covered;
    if (fresh && !trusted && (filtered.changed || !filtersEqual(cached.filter, filter))) {
      await setCachedEpg(
        source.url,
        filtered.data,
        serializeFilter(filter),
        cached.timestamp,
        refreshIntervalMs,
      );
    }
    if (fresh) {
      log.info('Loaded cache:', source.url, '|', Object.keys(filtered.data.programmes).length,
        'channels with programmes, age', Math.round(age / 60000), 'min');
    }
    return fresh ? 'fresh' : 'stale';
  }

  private publish(revision: number, onPublished?: () => void): void {
    if (revision !== this.revision) return;
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
    this.mappingRevisionValue++;
    onPublished?.();
  }

  private async fetchSource(
    source: EpgSource,
    filter = this.filterFor(source),
    revision = this.revision,
    onDataPublished?: () => void,
  ): Promise<boolean> {
    if (revision !== this.revision) return false;
    if (filter && isEmptyFilter(filter)) {
      this.states.delete(source.url);
      this.indexRevision++;
      this.channelIdsByName.delete(source.url);
      return true;
    }
    const done = log.time(`fetch '${source.url}'`);
    let result: ParsedEpg | null = null;
    try {
      const loaded = await fetchAndParseXMLTV(source.url, 120000, filter
        ? {
            channelIds: filter.ids,
            channelNames: filter.names,
            retainChannelCatalog: true,
            maxProgrammes: CONFIG.EPG.MAX_RETAINED_PROGRAMMES,
          }
        : { maxProgrammes: CONFIG.EPG.MAX_RETAINED_PROGRAMMES }, true);
      result = loaded.data;
      const { stats } = loaded;
      if (revision !== this.revision) {
        done();
        return false;
      }
      const programmeCount = stats.programmesKept;
      // An empty parse is usually a transient upstream response; neither cache
      // it nor let it replace programmes already loaded for this source.
      if (programmeCount === 0 && this.hasProgrammes(source.url)) {
        log.warn('EPG has 0 programmes — keeping the previous data:', source.url);
        done();
        return false;
      }
      // A truncated parse is usable for this session, but it is not the
      // guide the filter asked for — so it must not settle as the answer.
      const truncated = stats.droppedBudget > 0;
      const state: SourceState = {
        data: result,
        timestamp: Date.now(),
        needsRefresh: truncated,
      };
      if (!await this.setState(source.url, state, revision)) {
        done();
        return false;
      }
      if (onDataPublished) this.publish(revision, onDataPublished);
      log.info('Loaded', source.url, '|', Object.keys(result.channels).length, 'channels,',
        programmeCount, 'programmes', filter ? `(of ${String(stats.programmesSeen)} seen)` : '');
      if (truncated) {
        // Caching it under the full filter would make `covers()` report the
        // gap as covered on the next boot, turning it permanent and silent.
        log.warn(
          'EPG hit its retention ceiling; partial guide, not cached',
          'event=epg.budget.exhausted',
          `kept=${String(programmeCount)}`,
          `dropped=${String(stats.droppedBudget)}`,
          'hint=hide the channels you do not watch',
        );
      } else if (programmeCount > 0) {
        const cachedAt = Date.now();
        const stored = await setCachedEpg(
          source.url,
          result,
          serializeFilter(filter),
          cachedAt,
          StorageService.getEpgRefreshIntervalMs(),
        );
        if (stored) {
          state.cacheTimestamp = cachedAt;
          for (const listener of epgWriteListeners) listener(source.url);
        }
      } else {
        log.warn('EPG has 0 programmes — not caching:', source.url);
      }
      done();
      return !truncated;
    } catch (err) {
      log.error('Failed to load EPG:', source.url, err);
      done();
      return false;
    } finally {
      // Any path that skipped the cache write lets the worker drop its copy.
      releaseHeldRecord(result);
    }
  }

  private hasProgrammes(url: string): boolean {
    const data = this.states.get(url)?.data;
    if (!data) return false;
    for (const id in data.programmes) {
      if (data.programmes[id].length) return true;
    }
    return false;
  }

  // The state lands with its name index, so a lookup never sees one without
  // the other. False when a newer load or a reset took over meanwhile.
  private async setState(url: string, state: SourceState, revision: number): Promise<boolean> {
    const index = await buildNameIndexSliced(state.data.channels);
    if (revision !== this.revision) return false;
    this.states.set(url, state);
    this.indexRevision++;
    this.channelIdsByName.set(url, index);
    return true;
  }

  /**
   * The EPG ids the saved mappings point at, derived from the eligible
   * channels — a hidden channel must not pull its programmes back into the
   * filter through a mapping. Without a channel list nothing is filtered
   * anyway, so every saved mapping stands.
   */
  private collectMappedChannelIds(): string[] {
    const mapped = ChannelCustomizationService.epgChannelIds();
    // Nothing mapped is the common case, and it costs one sparse walk; only
    // a playlist that actually carries mappings pays for the key set.
    if (this.playlistChannels === null || !mapped.length) return mapped;
    const eligibleMappings = new Set<string>();
    for (const source of this.sources) {
      const eligibleChannels = new Set<string>();
      for (const channel of this.playlistChannels) {
        if (sourceAppliesToChannel(source, channel)) {
          eligibleChannels.add(channelKey(channel));
        }
      }
      for (const id of ChannelCustomizationService.epgChannelIdsFor(eligibleChannels)) {
        if (this.splitChannelKey(id)?.url === source.url) eligibleMappings.add(id);
      }
    }
    return [...eligibleMappings];
  }

  /**
   * Restrict parsing to the channels this source actually serves. Both the
   * tvg-id and the source-side name are allowed, so a feed the playlist matches
   * by name only still resolves in `findChannelId`.
   */
  private filterFor(source: EpgSource): SourceFilter | null {
    return this.filterIn(this.currentFilterMemo(), source);
  }

  private async filterKeyIn(memo: FilterMemo, source: EpgSource): Promise<string> {
    const sourceKey = filterSourceKey(source);
    const known = memo.bySource.get(sourceKey)?.key ?? memo.keys.get(sourceKey);
    if (known !== undefined) return known;
    const key = await filterKeySliced(source, memo.channels ?? [], this.mappedIdsFor(memo, source));
    memo.keys.set(sourceKey, key);
    return key;
  }

  private filterIn(memo: FilterMemo, source: EpgSource): SourceFilter | null {
    if (memo.channels === null) return null;
    const key = filterSourceKey(source);
    let filter = memo.bySource.get(key);
    if (!filter) {
      filter = buildFilter(source, memo.channels, this.mappedIdsFor(memo, source));
      memo.bySource.set(key, filter);
    }
    return filter;
  }

  // A boot asks for the same filter several times; each walk lowercases
  // every channel name, so reuse it until the channels or mappings change.
  private currentFilterMemo(): FilterMemo {
    const mapped = this.mappedChannelIds.join('\n');
    if (this.filterMemo.channels !== this.playlistChannels
        || this.filterMemo.mapped !== mapped) {
      this.filterMemo = {
        channels: this.playlistChannels,
        mapped,
        mappedIds: this.mappedChannelIds.slice(),
        bySource: new Map(),
        keys: new Map(),
      };
    }
    return this.filterMemo;
  }

  /** Builds `memo`'s missing filters for `sources` in slices that yield,
   *  or returns null when there was nothing large left to build. */
  private prepareFilters(memo: FilterMemo, sources: EpgSource[]): Promise<void> | null {
    const channels = memo.channels;
    if (channels === null) return null;
    if (channels.length <= FILTER_SYNC_MAX_CHANNELS) {
      for (const source of sources) this.filterIn(memo, source);
      return null;
    }
    const missing = sources.filter(source => !memo.bySource.has(filterSourceKey(source)));
    if (!missing.length) return null;
    return (async () => {
      for (const source of missing) {
        const key = filterSourceKey(source);
        if (memo.bySource.has(key)) continue;
        const filter = await buildFilterSliced(source, channels, this.mappedIdsFor(memo, source));
        memo.bySource.set(key, filter);
      }
    })();
  }

  private mappedIdsFor(memo: FilterMemo, source: EpgSource): string[] {
    const ids: string[] = [];
    for (const override of memo.mappedIds) {
      const mapped = this.splitChannelKey(override);
      if (mapped?.url === source.url) ids.push(mapped.id);
    }
    return ids;
  }

  // Whether `filterFor(source)` would be empty, without building it: this runs
  // on every refresh, including each time the guide opens.
  private isIdle(source: EpgSource): boolean {
    if (this.playlistChannels === null) return false;
    for (const channel of this.playlistChannels) {
      if ((channel.id || channel.name || channel.sourceName)
        && sourceAppliesToChannel(source, channel)) return false;
    }
    return !this.mappedChannelIds.some(id => this.splitChannelKey(id)?.url === source.url);
  }

  private rebuildIndexes(): void {
    // A load publishes as each source lands and once more at the end; the
    // final pass would rebuild every guide index from identical state.
    if (this.builtIndexRevision === this.indexRevision) return;
    this.builtIndexRevision = this.indexRevision;
    // Snapshot each source instead of copying every channel into one keyed
    // map: a large guide made that the longest task of a load.
    this.indexedSources = new Map();
    this.derivedEntries.clear();
    this.guideRevisionValue++;
    this.timeIndexes.clear();
    this.derivedOffsets.clear();
    this.tzOffsetMinutes = null;
    for (const source of this.sources) {
      const state = this.states.get(source.url);
      const data = state?.data;
      if (!state || !data) continue;
      if (this.tzOffsetMinutes === null && data.tzOffsetMinutes != null) {
        this.tzOffsetMinutes = data.tzOffsetMinutes;
      }
      this.indexedSources.set(encodeURIComponent(source.url), {
        source,
        state,
        offsetMs: (source.offsetMinutes ?? 0) * 60_000,
        shifted: new Map(),
      });
    }
    const staleMappings = this.mappedChannelIds
      .filter(id => !this.channelOf(id)).length;
    if (staleMappings) {
      log.warn(
        'Saved EPG mappings no longer match loaded guide channels',
        'event=epg.mapping.stale',
        `count=${String(staleMappings)}`,
      );
    }
  }

  private getTimeIndex(channelId: string): EpgTimeIndex | null {
    const programmes = this.programmesOf(channelId);
    if (!programmes) return null;
    const cached = this.timeIndexes.get(channelId);
    if (cached?.source === programmes) return cached.index;
    const index = new EpgTimeIndex(programmes);
    this.timeIndexes.set(channelId, { source: programmes, index });
    return index;
  }

  private locate(key: string): { entry: IndexedSource; id: string } | null {
    const separator = key.indexOf('::');
    if (separator < 0) return null;
    const entry = this.indexedSources.get(key.slice(0, separator));
    return entry ? { entry, id: key.slice(separator + 2) } : null;
  }

  private programmesOf(key: string): Programme[] | undefined {
    const derived = this.derivedEntries.get(key);
    if (derived) return derived.programmes;
    const at = this.locate(key);
    if (!at) return undefined;
    const { entry, id } = at;
    const programmes = ownValue(entry.state.data.programmes, id);
    if (!programmes || entry.offsetMs === 0) return programmes;
    let shifted = entry.shifted.get(id);
    if (!shifted) {
      shifted = shiftProgrammes(programmes, entry.offsetMs);
      entry.shifted.set(id, shifted);
    }
    return shifted;
  }

  private channelOf(key: string): EpgChannel | undefined {
    const derived = this.derivedEntries.get(key);
    if (derived) return derived.channel;
    const at = this.locate(key);
    return at ? ownValue(at.entry.state.data.channels, at.id) : undefined;
  }

  private originOf(key: string): ProgrammeOrigin | null {
    const derived = this.derivedEntries.get(key);
    if (derived) return derived.origin;
    const at = this.locate(key);
    if (!at || !ownValue(at.entry.state.data.programmes, at.id)) return null;
    return { url: at.entry.source.url, id: at.id, state: at.entry.state };
  }

  private sourceOffsetOf(key: string): number {
    if (this.derivedEntries.has(key)) return 0;
    const at = this.locate(key);
    return at && ownValue(at.entry.state.data.programmes, at.id)
      ? at.entry.source.offsetMinutes ?? 0
      : 0;
  }

  private channelKey(url: string, id: string): string {
    return `${encodeURIComponent(url)}::${id}`;
  }

  private splitChannelKey(key: string): { url: string; id: string } | null {
    const separator = key.indexOf('::');
    if (separator < 0) return null;
    try {
      return {
        url: decodeURIComponent(key.slice(0, separator)),
        id: key.slice(separator + 2),
      };
    } catch {
      return null;
    }
  }

  private findLegacyChannelId(channel: Channel): string | null {
    if (channel.id && this.programmesOf(channel.id)) return channel.id;
    if (!channel.name) return null;
    const name = channel.name.toLowerCase();
    let found: string | null = null;
    this.indexedSources.forEach((entry, prefix) => {
      if (found) return;
      const channels = entry.state.data.channels;
      for (const id in channels) {
        if (matchesChannelName(channels[id], name, '')) {
          found = `${prefix}::${id}`;
          return;
        }
      }
    });
    return found;
  }
}

const epgWriteListeners: Array<(url: string) => void> = [];

/** Called once a fetched guide is stored, after its cache record is known. */
export function onEpgCacheWritten(listener: (url: string) => void): () => void {
  epgWriteListeners.push(listener);
  return () => {
    const index = epgWriteListeners.indexOf(listener);
    if (index >= 0) epgWriteListeners.splice(index, 1);
  };
}

export const EpgService = new EpgServiceImpl();

function matchesChannelName(channel: EpgChannel, name: string, sourceName: string): boolean {
  const primary = channel.name.toLowerCase();
  if (primary === name || primary === sourceName) return true;
  return channel.aliases?.some((alias) => {
    const normalized = alias.toLowerCase();
    return normalized === name || normalized === sourceName;
  }) ?? false;
}

/**
 * Whether a cached parse still serves `wanted`. An unfiltered cache is a
 * superset of every filter, and a shrinking playlist stays covered, so only a
 * playlist that gained channels forces a refetch.
 */
function covers(cached: CachedEpgFilter | null | undefined, wanted: SourceFilter | null): boolean {
  if (!cached) return true;
  if (!wanted) return false;
  const ids = new Set(cached.ids);
  const names = new Set(cached.names);
  for (const id of wanted.ids) if (!ids.has(id)) return false;
  for (const name of wanted.names) if (!names.has(name)) return false;
  return true;
}

function sameSourceList(current: EpgSource[], next: EpgSource[]): boolean {
  if (current.length !== next.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i].url !== next[i].url) return false;
    if (current[i].kind !== next[i].kind) return false;
    if ((current[i].offsetMinutes ?? 0) !== (next[i].offsetMinutes ?? 0)) return false;
  }
  return true;
}

function sameFilters(
  current: ReadonlyMap<string, SourceFilter | null>,
  next: ReadonlyMap<string, SourceFilter | null>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [url, filter] of next) {
    if (!current.has(url)) return false;
    if (!sameFilter(current.get(url) ?? null, filter)) return false;
  }
  return true;
}

function sameKeys(
  prior: FilterMemo,
  priorSources: EpgSource[],
  next: ReadonlyMap<string, SourceFilter | null>,
): boolean {
  if (priorSources.length !== next.size) return false;
  return priorSources.every((source) => {
    const sourceKey = filterSourceKey(source);
    const key = prior.bySource.get(sourceKey)?.key ?? prior.keys.get(sourceKey);
    return key !== undefined && key === next.get(source.url)?.key;
  });
}

function sameFilter(current: SourceFilter | null, next: SourceFilter | null): boolean {
  if (!current || !next) return current === next;
  return sameSet(current.ids, next.ids) && sameSet(current.names, next.names);
}

function sameSet(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (current.size !== next.size) return false;
  for (const value of next) if (!current.has(value)) return false;
  return true;
}

function isEmptyFilter(filter: SourceFilter): boolean {
  return filter.ids.size === 0 && filter.names.size === 0;
}

function serializeFilter(filter: SourceFilter | null): CachedEpgFilter | null {
  return filter && {
    ids: [...filter.ids],
    names: [...filter.names],
    key: filter.key,
  };
}

function filtersEqual(
  cached: CachedEpgFilter | null | undefined,
  wanted: SourceFilter | null,
): boolean {
  if (!cached || !wanted) return !cached && !wanted;
  if (cached.ids.length !== wanted.ids.size || cached.names.length !== wanted.names.size) {
    return false;
  }
  return cached.ids.every((id) => wanted.ids.has(id))
    && cached.names.every((name) => wanted.names.has(name));
}

function filterParsedEpg(
  data: ParsedEpg,
  filter: SourceFilter | null,
): { data: ParsedEpg; changed: boolean } {
  if (!filter) return { data, changed: false };
  const accepted = new Set(filter.ids);
  for (const id in data.channels) {
    const channel = data.channels[id];
    if (matchesAnyChannelName(channel, filter.names)) accepted.add(id);
  }

  const channels = data.channels;
  const programmes: Record<string, Programme[]> = {};
  let keptProgrammeChannels = 0;
  for (const id in data.programmes) {
    if (!accepted.has(id)) continue;
    programmes[id] = data.programmes[id];
    keptProgrammeChannels++;
  }
  const changed = keptProgrammeChannels !== Object.keys(data.programmes).length;
  return {
    data: changed ? {
      channels,
      programmes,
      channelCatalogComplete: data.channelCatalogComplete,
      sourceName: data.sourceName,
      tzOffsetMinutes: data.tzOffsetMinutes,
    } : data,
    changed,
  };
}

function matchesAnyChannelName(channel: EpgChannel, names: ReadonlySet<string>): boolean {
  if (names.has(channel.name.toLowerCase())) return true;
  return channel.aliases?.some((alias) => names.has(alias.toLowerCase())) ?? false;
}
