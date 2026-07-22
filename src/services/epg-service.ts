import type { Channel, EpgChannel, EpgSource, ParsedEpg, Programme } from '../types';
import { parseXMLTV } from '../parsers/xmltv-parser';
import { fetchMaybeGzipText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { getCachedEpg, setCachedEpg } from './idb-cache';

const log = createLogger('EPG');

interface SourceState {
  data: ParsedEpg;
  timestamp: number;
}

class EpgServiceImpl {
  channels: Record<string, EpgChannel> = {};
  programmes: Record<string, Programme[]> = {};
  /** Offset of the first loaded feed that declares one. Display remains global. */
  tzOffsetMinutes: number | null = null;
  loaded = false;
  private sources: EpgSource[] = [];
  private states = new Map<string, SourceState>();

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale programme data does not survive a reload.
   */
  reset(): void {
    this.channels = {};
    this.programmes = {};
    this.tzOffsetMinutes = null;
    this.loaded = false;
    this.sources = [];
    this.states.clear();
  }

  async load(sources: EpgSource[]): Promise<void> {
    this.setSources(sources);
    await Promise.all(this.sources.map((source) => this.loadSource(source)));
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
  }

  async refresh(): Promise<void> {
    await Promise.all(this.sources.map(async (source) => {
      const state = this.states.get(source.url);
      if (state && Date.now() - state.timestamp < CONFIG.EPG_REFRESH_INTERVAL) return;
      await this.fetchSource(source);
    }));
    this.rebuildIndexes();
    this.loaded = this.sources.length > 0;
  }

  getNowPlaying(channelId: string): Programme | null {
    const progs = this.programmes[channelId];
    if (!progs) return null;
    const now = Date.now();
    return progs.find((p) => p.start.getTime() <= now && p.stop.getTime() > now) ?? null;
  }

  getUpcoming(channelId: string, count = 5): Programme[] {
    const progs = this.programmes[channelId];
    if (!progs) return [];
    const now = Date.now();
    return progs.filter((p) => p.start.getTime() > now).slice(0, count);
  }

  findChannelId(channel: Channel): string | null {
    if (!this.sources.length) return this.findLegacyChannelId(channel);
    const candidates = this.sources.filter((source) =>
      source.kind === 'manual' || source.playlistIds.some((id) => channel.playlistIds.includes(id)));

    for (const source of candidates) {
      if (!channel.id) continue;
      const key = this.channelKey(source.url, channel.id);
      if (this.programmes[key]?.length) return key;
    }

    const name = channel.name.toLowerCase();
    if (!name) return null;
    for (const source of candidates) {
      const state = this.states.get(source.url);
      if (!state) continue;
      for (const id in state.data.channels) {
        if (state.data.channels[id].name.toLowerCase() !== name) continue;
        const key = this.channelKey(source.url, id);
        if (this.programmes[key]?.length) return key;
      }
    }
    return null;
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
      } else {
        merged.push({ ...source, playlistIds: source.playlistIds.slice() });
      }
    }
    this.sources = merged;
    const active = new Set(merged.map((source) => source.url));
    for (const url of this.states.keys()) {
      if (!active.has(url)) this.states.delete(url);
    }
  }

  private async loadSource(source: EpgSource): Promise<void> {
    try {
      const cached = await getCachedEpg(source.url);
      if (cached) {
        this.states.set(source.url, { data: cached.data, timestamp: cached.timestamp });
        const age = Date.now() - cached.timestamp;
        const hasTzField = 'tzOffsetMinutes' in cached.data;
        if (age < CONFIG.EPG_REFRESH_INTERVAL && hasTzField) {
          log.info('Loaded cache:', source.url, '|', Object.keys(cached.data.programmes).length,
            'channels with programmes, age', Math.round(age / 60000), 'min');
          return;
        }
      }
    } catch (err) {
      log.warn('Cache read failed:', source.url, err);
    }
    await this.fetchSource(source);
  }

  private async fetchSource(source: EpgSource): Promise<void> {
    const done = log.time(`fetch '${source.url}'`);
    try {
      const text = await fetchMaybeGzipText(source.url, 120000);
      const result = parseXMLTV(text);
      const programmeCount = Object.values(result.programmes).reduce((n, list) => n + list.length, 0);
      this.states.set(source.url, { data: result, timestamp: Date.now() });
      log.info('Loaded', source.url, '|', Object.keys(result.channels).length, 'channels,',
        programmeCount, 'programmes');
      // Don't cache an empty feed: it may be a transient upstream response, and
      // persisting it would hide valid programme data until the cache expires.
      if (programmeCount > 0) {
        await setCachedEpg(source.url, result);
      } else {
        log.warn('EPG has 0 programmes — not caching:', source.url);
      }
    } catch (err) {
      log.error('Failed to load EPG:', source.url, err);
    }
    done();
  }

  private rebuildIndexes(): void {
    this.channels = {};
    this.programmes = {};
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
        this.programmes[this.channelKey(source.url, id)] = data.programmes[id];
      }
    }
  }

  private channelKey(url: string, id: string): string {
    return `${encodeURIComponent(url)}::${id}`;
  }

  private findLegacyChannelId(channel: Channel): string | null {
    if (channel.id && this.programmes[channel.id]) return channel.id;
    if (!channel.name) return null;
    for (const id in this.channels) {
      if (this.channels[id].name.toLowerCase() === channel.name.toLowerCase()) return id;
    }
    return null;
  }
}

export const EpgService = new EpgServiceImpl();
