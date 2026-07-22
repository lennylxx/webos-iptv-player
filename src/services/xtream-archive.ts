import type { Channel } from '../types';
import { CONFIG } from '../config';
import { StorageService } from './storage-service';
import { createXtreamClient } from './xtream-client';

type Availability = Map<number, boolean> | null;

interface CacheEntry {
  expiresAt: number;
  availability: Availability;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Availability>>();

function keyFor(channel: Channel): string {
  return channel.catchupAccountId && channel.catchupStreamId
    ? `${channel.catchupAccountId}:${channel.catchupStreamId}`
    : '';
}

function cached(channel: Channel, now = Date.now()): Availability | undefined {
  const key = keyFor(channel);
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.availability;
}

async function load(channel: Channel): Promise<Availability> {
  const key = keyFor(channel);
  if (!key) return null;
  const hit = cached(channel);
  if (hit !== undefined) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<Availability> => {
    const account = StorageService.getPlaylists()
      .find(item => item.id === channel.catchupAccountId && item.source === 'xtream' && item.xtream);
    if (!account?.xtream) return null;
    const listings = await createXtreamClient({
      baseUrl: account.url,
      ...account.xtream,
    }).getArchiveListings(channel.catchupStreamId!);
    if (listings === null) return null;
    const explicit = listings.filter(listing => listing.hasArchive !== null);
    if (!explicit.length) return null;
    return new Map(explicit.map(listing => [listing.start, listing.hasArchive!]));
  })();

  inFlight.set(key, request);
  try {
    const availability = await request;
    cache.set(key, {
      expiresAt: Date.now() + CONFIG.XTREAM.ARCHIVE_TTL_MS,
      availability,
    });
    return availability;
  } finally {
    inFlight.delete(key);
  }
}

function matchingAvailability(starts: Map<number, boolean>, startSeconds: number): boolean | undefined {
  for (let offset = -60; offset <= 60; offset++) {
    const available = starts.get(startSeconds + offset);
    if (available !== undefined) return available;
  }
  return undefined;
}

export const XtreamArchiveService = {
  getCached: cached,
  load,

  isAvailable(channel: Channel, startMs: number, now = Date.now()): boolean {
    if (!channel.catchupSource) return false;
    if (channel.catchupDays > 0 && startMs < now - channel.catchupDays * 86400000) return false;
    if (!keyFor(channel)) return true;
    const availability = cached(channel, now);
    if (availability === undefined || availability === null) return true;
    return matchingAvailability(availability, Math.floor(startMs / 1000)) !== false;
  },

  clear(): void {
    cache.clear();
    inFlight.clear();
  },
};
