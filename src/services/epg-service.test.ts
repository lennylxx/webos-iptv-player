import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./idb-cache', () => ({ getCachedEpg: vi.fn(), setCachedEpg: vi.fn(async () => {}) }));
vi.mock('../utils/fetch-helper', () => ({ fetchMaybeGzipText: vi.fn(async () => '<tv/>') }));
vi.mock('../parsers/xmltv-parser', () => ({ parseXMLTV: vi.fn() }));
vi.mock('./storage-service', () => ({ StorageService: { getEpgUrl: vi.fn(() => 'http://epg') } }));

import { EpgService } from './epg-service';
import { getCachedEpg, setCachedEpg } from './idb-cache';
import { parseXMLTV } from '../parsers/xmltv-parser';
import { fetchMaybeGzipText } from '../utils/fetch-helper';
import type { Channel, Programme, ParsedEpg } from '../types';

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOON);
  EpgService.channels = {};
  EpgService.programmes = {};
  EpgService.loaded = false;
});

afterEach(() => vi.useRealTimers());

describe('EpgService.getNowPlaying', () => {
  it('returns the programme currently airing', () => {
    EpgService.programmes = {
      ch1: [
        prog({ title: 'Past', start: h(-2), stop: h(-1) }),
        prog({ title: 'Now', start: h(-1), stop: h(1) }),
        prog({ title: 'Next', start: h(1), stop: h(2) }),
      ],
    };
    expect(EpgService.getNowPlaying('ch1')?.title).toBe('Now');
  });

  it('returns null when nothing is airing or the channel is unknown', () => {
    EpgService.programmes = { ch1: [prog({ start: h(1), stop: h(2) })] };
    expect(EpgService.getNowPlaying('ch1')).toBeNull();
    expect(EpgService.getNowPlaying('missing')).toBeNull();
  });
});

describe('EpgService.getUpcoming', () => {
  it('returns future programmes capped at the requested count', () => {
    EpgService.programmes = {
      ch1: [
        prog({ title: 'Now', start: h(-1), stop: h(1) }),
        prog({ title: 'A', start: h(1), stop: h(2) }),
        prog({ title: 'B', start: h(2), stop: h(3) }),
        prog({ title: 'C', start: h(3), stop: h(4) }),
      ],
    };
    expect(EpgService.getUpcoming('ch1', 2).map(p => p.title)).toEqual(['A', 'B']);
  });

  it('returns an empty array for an unknown channel', () => {
    expect(EpgService.getUpcoming('missing')).toEqual([]);
  });
});

describe('EpgService.findChannelId', () => {
  it('matches by tvg-id when programmes exist for it', () => {
    EpgService.programmes = { 'tvg.1': [prog({})] };
    expect(EpgService.findChannelId(channel({ id: 'tvg.1', name: 'Alpha' }))).toBe('tvg.1');
  });

  it('falls back to a case-insensitive name match against EPG channels', () => {
    EpgService.channels = { 'epg.5': { name: 'Alpha HD', icon: '' } };
    expect(EpgService.findChannelId(channel({ id: '', name: 'alpha hd' }))).toBe('epg.5');
  });

  it('returns null when neither id nor name matches', () => {
    EpgService.channels = { 'epg.5': { name: 'Beta', icon: '' } };
    expect(EpgService.findChannelId(channel({ id: 'x', name: 'Alpha' }))).toBeNull();
  });
});

describe('EpgService.load — timezone offset capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    EpgService.reset();
  });

  it('refreshes a cache that predates tz capture so the offset is recovered', async () => {
    // Pre-feature cache: fresh by age, but its data has no tzOffsetMinutes field.
    const stale = { channels: { c1: { name: 'C1', icon: '' } }, programmes: {} } as ParsedEpg;
    vi.mocked(getCachedEpg).mockResolvedValue({ url: 'http://epg', timestamp: NOON, data: stale });
    vi.mocked(parseXMLTV).mockReturnValue({ channels: {}, programmes: {}, tzOffsetMinutes: 480 });

    await EpgService.load();

    expect(fetchMaybeGzipText).toHaveBeenCalled(); // did NOT trust the stale cache
    expect(EpgService.tzOffsetMinutes).toBe(480);
  });

  it('uses a fresh cache that carries the tz field, even when it is null', async () => {
    const cached = { channels: {}, programmes: {}, tzOffsetMinutes: null } as ParsedEpg;
    vi.mocked(getCachedEpg).mockResolvedValue({ url: 'http://epg', timestamp: NOON, data: cached });

    await EpgService.load();

    expect(fetchMaybeGzipText).not.toHaveBeenCalled(); // trusted the cache
    expect(EpgService.tzOffsetMinutes).toBeNull();
  });
});

describe('EpgService.refresh — empty-EPG caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    EpgService.reset();
    vi.mocked(getCachedEpg).mockResolvedValue(null); // force a network refresh
  });

  it('caches an EPG that has programmes', async () => {
    vi.mocked(parseXMLTV).mockReturnValue({
      channels: { c1: { name: 'C1', icon: '' } },
      programmes: { c1: [prog({})] },
      tzOffsetMinutes: null,
    });
    await EpgService.refresh();
    expect(setCachedEpg).toHaveBeenCalled();
  });

  it('does NOT cache an EPG with zero programmes, so it refetches next load', async () => {
    vi.mocked(parseXMLTV).mockReturnValue({ channels: { c1: { name: 'C1', icon: '' } }, programmes: {}, tzOffsetMinutes: null });
    await EpgService.refresh();
    expect(setCachedEpg).not.toHaveBeenCalled();
    expect(EpgService.loaded).toBe(true); // still usable in-memory this session
  });

  it('treats present-but-empty programme arrays as empty (not cached)', async () => {
    vi.mocked(parseXMLTV).mockReturnValue({ channels: {}, programmes: { c1: [] }, tzOffsetMinutes: null });
    await EpgService.refresh();
    expect(setCachedEpg).not.toHaveBeenCalled();
  });
});

describe('EpgService.reset', () => {
  it('clears channels, programmes, loaded flag and last fetch time', () => {
    EpgService.channels = { 'epg.1': { name: 'Alpha', icon: '' } };
    EpgService.programmes = { 'epg.1': [prog({ title: 'x' })] };
    EpgService.loaded = true;

    EpgService.reset();

    expect(EpgService.channels).toEqual({});
    expect(EpgService.programmes).toEqual({});
    expect(EpgService.loaded).toBe(false);
  });
});
