import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./idb-cache', () => ({ getCachedEpg: vi.fn(), setCachedEpg: vi.fn(async () => {}) }));
vi.mock('../utils/fetch-helper', () => ({ fetchMaybeGzipText: vi.fn(async (url: string) => url) }));
vi.mock('../parsers/xmltv-parser', () => ({ parseXMLTV: vi.fn() }));

import { EpgService } from './epg-service';
import { getCachedEpg, setCachedEpg } from './idb-cache';
import { parseXMLTV } from '../parsers/xmltv-parser';
import { fetchMaybeGzipText } from '../utils/fetch-helper';
import type { Channel, EpgSource, ParsedEpg, Programme } from '../types';

function prog(over: Partial<Programme>): Programme {
  return {
    start: new Date(0), stop: new Date(0),
    title: '', description: '', category: '', icon: '', ...over,
  };
}

function channel(over: Partial<Channel>): Channel {
  return {
    id: '', name: '', logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
  };
}

const NOON = new Date('2024-06-01T12:00:00Z').getTime();
const h = (n: number) => new Date(NOON + n * 3600_000);
const source = (url: string, playlistIds: string[], kind: EpgSource['kind'] = 'm3u'): EpgSource =>
  ({ url, playlistIds, kind });
const parsed = (id: string, name: string, title: string, tzOffsetMinutes: number | null = null): ParsedEpg => ({
  channels: { [id]: { name, icon: '' } },
  programmes: { [id]: [prog({ title, start: h(-1), stop: h(1) })] },
  tzOffsetMinutes,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOON);
  vi.clearAllMocks();
  EpgService.reset();
  vi.mocked(getCachedEpg).mockResolvedValue(null);
});

afterEach(() => vi.useRealTimers());

describe('EpgService programme lookup', () => {
  beforeEach(() => {
    EpgService.programmes = {
      ch1: [
        prog({ title: 'Past', start: h(-2), stop: h(-1) }),
        prog({ title: 'Now', start: h(-1), stop: h(1) }),
        prog({ title: 'A', start: h(1), stop: h(2) }),
        prog({ title: 'B', start: h(2), stop: h(3) }),
      ],
    };
  });

  it('returns the current and capped upcoming programmes', () => {
    expect(EpgService.getNowPlaying('ch1')?.title).toBe('Now');
    expect(EpgService.getUpcoming('ch1', 1).map((item) => item.title)).toEqual(['A']);
  });

  it('returns empty results for an unknown channel', () => {
    expect(EpgService.getNowPlaying('missing')).toBeNull();
    expect(EpgService.getUpcoming('missing')).toEqual([]);
  });
});

describe('EpgService multi-source matching', () => {
  it('keeps colliding XMLTV ids isolated and uses the channel owning playlist', async () => {
    vi.mocked(parseXMLTV).mockImplementation((text) =>
      text === 'http://a' ? parsed('shared', 'Alpha', 'From A') : parsed('shared', 'Bravo', 'From B'));

    await EpgService.load([source('http://a', ['a']), source('http://b', ['b'], 'xtream')]);

    const aId = EpgService.findChannelId(channel({ id: 'shared', name: 'Alpha', playlistIds: ['a'] }));
    const bId = EpgService.findChannelId(channel({ id: 'shared', name: 'Bravo', playlistIds: ['b'] }));
    expect(aId).not.toBe(bId);
    expect(EpgService.getNowPlaying(aId!)?.title).toBe('From A');
    expect(EpgService.getNowPlaying(bId!)?.title).toBe('From B');
  });

  it('falls back to a case-insensitive name match within the owning feed', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('epg.5', 'Alpha HD', 'Matched'));
    await EpgService.load([source('http://a', ['a'])]);

    const id = EpgService.findChannelId(channel({ id: 'missing', name: 'alpha hd', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Matched');
  });

  it('matches a locally renamed channel through its source name', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('epg.6', 'Alpha', 'Matched'));
    await EpgService.load([source('http://a', ['a'])]);

    const id = EpgService.findChannelId(
      channel({ id: 'missing', name: 'My Alpha', sourceName: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Matched');
  });

  it('does not match a channel against an unrelated playlist feed', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('same', 'Alpha', 'Wrong source'));
    await EpgService.load([source('http://a', ['a'])]);

    expect(EpgService.findChannelId(channel({ id: 'same', name: 'Alpha', playlistIds: ['b'] }))).toBeNull();
  });

  it('gives a manual feed priority over playlist-owned feeds', async () => {
    vi.mocked(parseXMLTV).mockImplementation((text) =>
      text === 'http://manual' ? parsed('same', 'Alpha', 'Manual') : parsed('same', 'Alpha', 'Owned'));
    await EpgService.load([
      source('http://manual', [], 'manual'),
      source('http://owned', ['a']),
    ]);

    const id = EpgService.findChannelId(channel({ id: 'same', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Manual');
  });
});

describe('EpgService cache and refresh', () => {
  it('loads every feed from its independent URL cache', async () => {
    vi.mocked(getCachedEpg).mockImplementation(async (url) => ({
      url,
      timestamp: NOON,
      data: parsed('same', url, url),
    }));

    await EpgService.load([source('http://a', ['a']), source('http://b', ['b'])]);

    expect(getCachedEpg).toHaveBeenCalledWith('http://a');
    expect(getCachedEpg).toHaveBeenCalledWith('http://b');
    expect(fetchMaybeGzipText).not.toHaveBeenCalled();
  });

  it('refreshes a cache that predates timezone capture', async () => {
    const stale = { channels: {}, programmes: {} } as ParsedEpg;
    vi.mocked(getCachedEpg).mockResolvedValue({ url: 'http://a', timestamp: NOON, data: stale });
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Fresh', 480));

    await EpgService.load([source('http://a', ['a'])]);

    expect(fetchMaybeGzipText).toHaveBeenCalledWith('http://a', expect.any(Number));
    expect(EpgService.tzOffsetMinutes).toBe(480);
  });

  it('keeps stale cached programmes when their refresh fails', async () => {
    vi.mocked(getCachedEpg).mockResolvedValue({
      url: 'http://a',
      timestamp: NOON - 24 * 3600_000,
      data: parsed('a', 'Alpha', 'Cached'),
    });
    vi.mocked(fetchMaybeGzipText).mockRejectedValue(new Error('down'));

    await EpgService.load([source('http://a', ['a'])]);

    const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Cached');
  });

  it('does not cache a feed with zero programmes', async () => {
    vi.mocked(parseXMLTV).mockReturnValue({
      channels: { a: { name: 'Alpha', icon: '' } },
      programmes: {},
      tzOffsetMinutes: null,
    });

    await EpgService.load([source('http://a', ['a'])]);

    expect(setCachedEpg).not.toHaveBeenCalled();
    expect(EpgService.loaded).toBe(true);
  });

  it('keeps a successful feed when another feed fails', async () => {
    vi.mocked(fetchMaybeGzipText).mockImplementation(async (url) => {
      if (url === 'http://b') throw new Error('down');
      return url;
    });
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Available'));

    await EpgService.load([source('http://a', ['a']), source('http://b', ['b'])]);

    const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Available');
  });
});

describe('EpgService.reset', () => {
  it('clears merged data and loaded state', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Program'));
    await EpgService.load([source('http://a', ['a'])]);

    EpgService.reset();

    expect(EpgService.channels).toEqual({});
    expect(EpgService.programmes).toEqual({});
    expect(EpgService.loaded).toBe(false);
  });
});
