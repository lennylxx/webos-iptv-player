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
import { CONFIG } from '../config';
import { getCachedEpg, setCachedEpg } from './idb-cache';
import type { CachedEpgFilter } from './idb-cache';
import { ChannelCustomizationService } from './channel-customization';
import { channelKey } from '../utils/channel';

const log = createLogger('EPG');

interface SourceState {
  data: ParsedEpg;
  timestamp: number;
  needsRefresh: boolean;
}

/** The playlist channels a source is parsed down to. */
interface SourceFilter {
  ids: Set<string>;
  names: Set<string>;
}

export interface EpgMappingCandidate {
  id: string;
  channelId: string;
  name: string;
  sourceName: string;
}

class EpgServiceImpl {
  channels: Record<string, EpgChannel> = {};
  programmes: Record<string, Programme[]> = {};
  /** Offset of the first loaded feed that declares one. Display remains global. */
  tzOffsetMinutes: number | null = null;
  loaded = false;
  private sources: EpgSource[] = [];
  private states = new Map<string, SourceState>();
  private channelIdsByName = new Map<string, Map<string, string[]>>();
  private timeIndexes = new Map<string, { source: Programme[]; index: EpgTimeIndex }>();
  private sourceOffsets = new Map<string, number>();
  private derivedOffsets = new Map<string, { id: string; baseId: string; minutes: number }>();
  private mappedChannelIds: string[] = [];
  private playlistChannels: Channel[] | null = null;
  private revision = 0;
  private mappingRevisionValue = 0;

  get mappingRevision(): number {
    return this.mappingRevisionValue;
  }

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale programme data does not survive a reload.
   */
  reset(): void {
    this.revision++;
    this.channels = {};
    this.programmes = {};
    this.tzOffsetMinutes = null;
    this.loaded = false;
    this.mappingRevisionValue++;
    this.sources = [];
    this.states.clear();
    this.channelIdsByName.clear();
    this.timeIndexes.clear();
    this.sourceOffsets.clear();
    this.derivedOffsets.clear();
    this.mappedChannelIds = [];
    this.playlistChannels = null;
  }

  async load(sources: EpgSource[], channels?: Channel[]): Promise<void> {
    const revision = ++this.revision;
    this.playlistChannels = channels ?? null;
    this.mappedChannelIds = ChannelCustomizationService.epgChannelIds();
    this.setSources(sources);
    await Promise.all(this.sources.map((source) => this.loadSource(source, revision)));
    if (revision !== this.revision) return;
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
    this.mappingRevisionValue++;
  }

  async refresh(): Promise<void> {
    const revision = ++this.revision;
    this.mappedChannelIds = ChannelCustomizationService.epgChannelIds();
    await Promise.all(this.sources.map(async (source) => {
      const state = this.states.get(source.url);
      if (state && !state.needsRefresh
        && Date.now() - state.timestamp < CONFIG.EPG_REFRESH_INTERVAL) return;
      await this.fetchSource(source, this.filterFor(source), revision);
    }));
    if (revision !== this.revision) return;
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
    this.mappingRevisionValue++;
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

  getSourceOffsetMinutes(channel: Channel): number {
    const override = ChannelCustomizationService.overrideFor(channelKey(channel));
    const baseId = this.findBaseChannelId(channel, override);
    return baseId ? this.sourceOffsets.get(baseId) ?? 0 : 0;
  }

  private findBaseChannelId(channel: Channel, override: ChannelOverride | null): string | null {
    if (!this.sources.length) return this.findLegacyChannelId(channel);
    if (override?.epgChannelId && this.channels[override.epgChannelId]) {
      return override.epgChannelId;
    }
    const candidates = this.sources.filter((source) =>
      source.kind === 'manual' || source.playlistIds.some((id) => channel.playlistIds.includes(id)));

    for (const source of candidates) {
      if (!channel.id) continue;
      const key = this.channelKey(source.url, channel.id);
      if (this.programmes[key]?.length) return key;
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
        if (this.programmes[key]?.length) return key;
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
    const sourceMinutes = this.sourceOffsets.get(baseId) ?? 0;
    if (deltaMinutes === undefined || deltaMinutes === 0) {
      this.removeDerivedOffset(key, previous);
      return baseId;
    }
    const minutes = sourceMinutes + deltaMinutes;
    if (previous?.baseId === baseId && previous.minutes === minutes) return previous.id;
    this.removeDerivedOffset(key, previous);
    const source = this.programmes[baseId];
    if (!source) return baseId;
    const id = `${baseId}::channel:${encodeURIComponent(key)}`;
    const deltaMs = deltaMinutes * 60_000;
    const shifted = source.map(programme => ({
      ...programme,
      start: new Date(programme.start.getTime() + deltaMs),
      stop: new Date(programme.stop.getTime() + deltaMs),
    }));
    this.channels[id] = this.channels[baseId];
    this.programmes[id] = shifted;
    this.timeIndexes.set(id, { source: shifted, index: new EpgTimeIndex(shifted) });
    this.derivedOffsets.set(key, { id, baseId, minutes });
    return id;
  }

  private removeDerivedOffset(
    key: string,
    derived: { id: string } | undefined,
  ): void {
    if (!derived) return;
    delete this.channels[derived.id];
    delete this.programmes[derived.id];
    this.timeIndexes.delete(derived.id);
    this.derivedOffsets.delete(key);
  }

  getMappingCandidates(
    channel: Channel,
    query: string,
    limit?: number,
  ): EpgMappingCandidate[] {
    const normalized = query.trim().toLowerCase();
    const current = ChannelCustomizationService.overrideFor(channelKey(channel))?.epgChannelId;
    const candidates: Array<EpgMappingCandidate & { score: number }> = [];
    const sources = this.sources.filter((source) =>
      source.kind === 'manual'
      || source.playlistIds.some((id) => channel.playlistIds.includes(id)));
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const source = sources[sourceIndex];
      const data = this.states.get(source.url)?.data;
      if (!data) continue;
      for (const id in data.channels) {
        const epgChannel = data.channels[id];
        const candidateId = this.channelKey(source.url, id);
        const selected = candidateId === current;
        const names = [epgChannel.name, ...(epgChannel.aliases ?? [])];
        const fields = [id, ...names].map(value => value.toLowerCase());
        const positions = normalized
          ? fields.map(value => value.indexOf(normalized)).filter(position => position >= 0)
          : [];
        if (normalized && !positions.length && !selected) continue;
        const exact = fields.some(value => value === normalized);
        const prefix = fields.some(value => value.indexOf(normalized) === 0);
        const position = positions.length ? Math.min(...positions) : 0;
        candidates.push({
          id: candidateId,
          channelId: id,
          name: epgChannel.name,
          sourceName: data.sourceName?.trim() || `EPG ${String(sourceIndex + 1)}`,
          score: selected
            ? -1
            : normalized
            ? (exact ? 0 : prefix ? 100 : 200) + position + sourceIndex * 1000
            : sourceIndex * 1000,
        });
      }
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
        for (const id of source.playlistIds) {
          if (!existing.playlistIds.includes(id)) existing.playlistIds.push(id);
        }
        if (source.kind === 'manual') existing.kind = 'manual';
        if (source.offsetMinutes !== undefined) existing.offsetMinutes = source.offsetMinutes;
      } else {
        merged.push({ ...source, playlistIds: source.playlistIds.slice() });
      }
    }
    this.sources = merged;
    const active = new Set(merged.map((source) => source.url));
    for (const url of this.states.keys()) {
      if (!active.has(url)) {
        this.states.delete(url);
        this.channelIdsByName.delete(url);
      }
    }
  }

  private async loadSource(source: EpgSource, revision: number): Promise<void> {
    if (revision !== this.revision) return;
    const filter = this.filterFor(source);
    if (filter && isEmptyFilter(filter)) {
      this.states.delete(source.url);
      this.channelIdsByName.delete(source.url);
      return;
    }
    try {
      const cached = await getCachedEpg(source.url);
      if (revision !== this.revision) return;
      if (cached) {
        const age = Date.now() - cached.timestamp;
        const hasTzField = 'tzOffsetMinutes' in cached.data;
        const hasChannelCatalog = !cached.filter
          || cached.data.channelCatalogComplete === true;
        const covered = covers(cached.filter, filter);
        const filtered = filterParsedEpg(cached.data, filter);
        this.setState(source.url, {
          data: filtered.data,
          timestamp: cached.timestamp,
          needsRefresh: !hasTzField || !hasChannelCatalog || !covered,
        });
        if (age < CONFIG.EPG_REFRESH_INTERVAL && hasTzField && hasChannelCatalog && covered) {
          if (filtered.changed || !filtersEqual(cached.filter, filter)) {
            await setCachedEpg(
              source.url,
              filtered.data,
              serializeFilter(filter),
              cached.timestamp,
            );
          }
          log.info('Loaded cache:', source.url, '|', Object.keys(filtered.data.programmes).length,
            'channels with programmes, age', Math.round(age / 60000), 'min');
          return;
        }
      }
    } catch (err) {
      log.warn('Cache read failed:', source.url, err);
    }
    await this.fetchSource(source, filter, revision);
  }

  private async fetchSource(
    source: EpgSource,
    filter = this.filterFor(source),
    revision = this.revision,
  ): Promise<void> {
    if (revision !== this.revision) return;
    if (filter && isEmptyFilter(filter)) {
      this.states.delete(source.url);
      this.channelIdsByName.delete(source.url);
      return;
    }
    const done = log.time(`fetch '${source.url}'`);
    try {
      const { data: result, stats } = await fetchAndParseXMLTV(source.url, 120000, filter
        ? {
            channelIds: filter.ids,
            channelNames: filter.names,
            retainChannelCatalog: true,
          }
        : {});
      if (revision !== this.revision) {
        done();
        return;
      }
      const programmeCount = stats.programmesKept;
      // An empty parse is usually a transient upstream response; neither cache
      // it nor let it replace programmes already loaded for this source.
      if (programmeCount === 0 && this.hasProgrammes(source.url)) {
        log.warn('EPG has 0 programmes — keeping the previous data:', source.url);
        done();
        return;
      }
      this.setState(source.url, {
        data: result,
        timestamp: Date.now(),
        needsRefresh: false,
      });
      log.info('Loaded', source.url, '|', Object.keys(result.channels).length, 'channels,',
        programmeCount, 'programmes', filter ? `(of ${String(stats.programmesSeen)} seen)` : '');
      if (programmeCount > 0) {
        await setCachedEpg(source.url, result, serializeFilter(filter));
      } else {
        log.warn('EPG has 0 programmes — not caching:', source.url);
      }
    } catch (err) {
      log.error('Failed to load EPG:', source.url, err);
    }
    done();
  }

  private hasProgrammes(url: string): boolean {
    const data = this.states.get(url)?.data;
    if (!data) return false;
    for (const id in data.programmes) {
      if (data.programmes[id].length) return true;
    }
    return false;
  }

  private setState(url: string, state: SourceState): void {
    this.states.set(url, state);
    const index = new Map<string, string[]>();
    for (const id in state.data.channels) {
      const channel = state.data.channels[id];
      const names = [channel.name, ...(channel.aliases ?? [])];
      for (const value of names) {
        const normalized = value.toLowerCase();
        const ids = index.get(normalized);
        if (ids) {
          if (!ids.includes(id)) ids.push(id);
        } else {
          index.set(normalized, [id]);
        }
      }
    }
    this.channelIdsByName.set(url, index);
  }

  /**
   * Restrict parsing to the channels this source actually serves. Both the
   * tvg-id and the source-side name are allowed, so a feed the playlist matches
   * by name only still resolves in `findChannelId`.
   */
  private filterFor(source: EpgSource): SourceFilter | null {
    if (this.playlistChannels === null) return null;
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const override of this.mappedChannelIds) {
      const mapped = this.splitChannelKey(override);
      if (mapped?.url === source.url) ids.add(mapped.id);
    }
    for (const channel of this.playlistChannels) {
      if (source.kind !== 'manual'
        && !channel.playlistIds.some((id) => source.playlistIds.includes(id))) continue;
      if (channel.id) ids.add(channel.id);
      // A rename keeps the source name, and findChannelId matches either one.
      if (channel.name) names.add(channel.name.toLowerCase());
      if (channel.sourceName) names.add(channel.sourceName.toLowerCase());
    }
    return { ids, names };
  }

  private rebuildIndexes(): void {
    this.channels = {};
    this.programmes = {};
    this.timeIndexes.clear();
    this.sourceOffsets.clear();
    this.derivedOffsets.clear();
    this.tzOffsetMinutes = null;
    for (const source of this.sources) {
      const data = this.states.get(source.url)?.data;
      if (!data) continue;
      if (this.tzOffsetMinutes === null && data.tzOffsetMinutes != null) {
        this.tzOffsetMinutes = data.tzOffsetMinutes;
      }
      for (const id in data.channels) {
        this.channels[this.channelKey(source.url, id)] = data.channels[id];
      }
      for (const id in data.programmes) {
        const key = this.channelKey(source.url, id);
        const offsetMinutes = source.offsetMinutes ?? 0;
        const offsetMs = offsetMinutes * 60_000;
        const shiftedPrograms = offsetMs === 0
          ? data.programmes[id]
          : data.programmes[id].map(program => ({
              ...program,
              start: new Date(program.start.getTime() + offsetMs),
              stop: new Date(program.stop.getTime() + offsetMs),
            }));
        this.programmes[key] = shiftedPrograms;
        this.sourceOffsets.set(key, offsetMinutes);
        this.timeIndexes.set(key, {
          source: shiftedPrograms,
          index: new EpgTimeIndex(shiftedPrograms),
        });
      }
    }
    const staleMappings = this.mappedChannelIds
      .filter(id => !this.channels[id]).length;
    if (staleMappings) {
      log.warn(
        'Saved EPG mappings no longer match loaded guide channels',
        'event=epg.mapping.stale',
        `count=${String(staleMappings)}`,
      );
    }
  }

  private getTimeIndex(channelId: string): EpgTimeIndex | null {
    const programmes = this.programmes[channelId];
    if (!programmes) return null;
    const cached = this.timeIndexes.get(channelId);
    if (cached?.source === programmes) return cached.index;
    const index = new EpgTimeIndex(programmes);
    this.timeIndexes.set(channelId, { source: programmes, index });
    return index;
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
    if (channel.id && this.programmes[channel.id]) return channel.id;
    if (!channel.name) return null;
    const name = channel.name.toLowerCase();
    for (const id in this.channels) {
      if (matchesChannelName(this.channels[id], name, '')) return id;
    }
    return null;
  }
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

function isEmptyFilter(filter: SourceFilter): boolean {
  return filter.ids.size === 0 && filter.names.size === 0;
}

function serializeFilter(filter: SourceFilter | null): CachedEpgFilter | null {
  return filter && {
    ids: [...filter.ids],
    names: [...filter.names],
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
