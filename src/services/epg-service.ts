import type { Channel, EpgChannel, Programme } from '../types';
import { parseXMLTV } from '../parsers/xmltv-parser';
import { fetchMaybeGzipText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';
import { getCachedEpg, setCachedEpg } from './idb-cache';

const log = createLogger('EPG');

class EpgServiceImpl {
  channels: Record<string, EpgChannel> = {};
  programmes: Record<string, Programme[]> = {};
  /** Timezone offset (minutes east of UTC) of the source feed, or null. Display only. */
  tzOffsetMinutes: number | null = null;
  loaded = false;
  private lastFetchTime = 0;

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale programme data does not survive a reload.
   */
  reset(): void {
    this.channels = {};
    this.programmes = {};
    this.tzOffsetMinutes = null;
    this.loaded = false;
    this.lastFetchTime = 0;
  }

  async load(): Promise<void> {
    const url = StorageService.getEpgUrl();
    if (!url) {
      log.warn('No EPG URL — skipping load');
      return;
    }

    try {
      const cached = await getCachedEpg(url);
      if (cached) {
        const age = Date.now() - cached.timestamp;
        // A cache written before tz capture lacks the field entirely (vs. a feed
        // with no offset, which stores it as null). Refresh those so 'feed'
        // mode gets the offset instead of silently falling back to the device clock.
        const hasTzField = 'tzOffsetMinutes' in cached.data;
        if (age < CONFIG.EPG_REFRESH_INTERVAL && hasTzField) {
          this.channels = cached.data.channels;
          this.programmes = cached.data.programmes;
          this.tzOffsetMinutes = cached.data.tzOffsetMinutes ?? null;
          this.loaded = true;
          this.lastFetchTime = cached.timestamp;
          log.info('Loaded from IDB cache:',
            Object.keys(cached.data.channels).length, 'channels,',
            Object.keys(cached.data.programmes).length, 'with programmes, age',
            Math.round(age / 60000), 'min');
          return;
        }
        log.info(hasTzField
          ? `Cache stale (age ${Math.round(age / 60000)} min) — refreshing`
          : 'Cache predates timezone capture — refreshing');
      }
    } catch (err) {
      log.warn('Cache read failed:', err);
    }

    return this.refresh();
  }

  async refresh(): Promise<void> {
    const url = StorageService.getEpgUrl();
    if (!url) {
      log.warn('No EPG URL — skipping refresh');
      return;
    }

    if (this.loaded && Date.now() - this.lastFetchTime < CONFIG.EPG_REFRESH_INTERVAL) {
      log.info('Skipping refresh — data is fresh');
      return;
    }

    const done = log.time('refresh');
    log.info('Fetching EPG from', url);
    try {
      const text = await fetchMaybeGzipText(url, 120000);
      log.info('Fetched EPG:', text.length, 'bytes');
      const parseDone = log.time('parse');
      const result = parseXMLTV(text);
      parseDone();
      this.channels = result.channels;
      this.programmes = result.programmes;
      this.tzOffsetMinutes = result.tzOffsetMinutes ?? null;
      this.loaded = true;
      this.lastFetchTime = Date.now();
      const programmeCount = Object.values(result.programmes).reduce((n, p) => n + p.length, 0);
      log.info('Loaded', Object.keys(result.channels).length, 'channels,',
        Object.keys(result.programmes).length, 'channels with programmes,', programmeCount, 'programmes');

      // Don't cache an empty EPG: a transient upstream failure can return channels
      // with zero programmes, and caching that would mask real data until the TTL
      // expires. Skipping the write lets the next load refetch.
      if (programmeCount > 0) {
        setCachedEpg(url, result).catch(err => log.warn('Cache write failed:', err));
      } else {
        log.warn('EPG has 0 programmes — not caching so it refetches next load');
      }
    } catch (err) {
      log.error('Failed to load EPG:', err);
    }
    done();
  }

  getNowPlaying(channelId: string): Programme | null {
    const progs = this.programmes[channelId];
    if (!progs) return null;
    const now = Date.now();
    return progs.find(p => p.start.getTime() <= now && p.stop.getTime() > now) ?? null;
  }

  getUpcoming(channelId: string, count = 5): Programme[] {
    const progs = this.programmes[channelId];
    if (!progs) return [];
    const now = Date.now();
    return progs.filter(p => p.start.getTime() > now).slice(0, count);
  }

  findChannelId(m3uChannel: Channel): string | null {
    if (m3uChannel.id && this.programmes[m3uChannel.id]) {
      return m3uChannel.id;
    }
    for (const [id, ch] of Object.entries(this.channels)) {
      if (ch.name && ch.name.toLowerCase() === m3uChannel.name.toLowerCase()) {
        return id;
      }
    }
    return null;
  }
}

export const EpgService = new EpgServiceImpl();
