import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { channelOverrideMock, epgChannelIdsMock } = vi.hoisted(() => ({
  channelOverrideMock: vi.fn(() => null as { epgChannelId?: string } | null),
  epgChannelIdsMock: vi.fn(() => [] as string[]),
}));

vi.mock('./idb-cache', () => ({ getCachedEpg: vi.fn(), setCachedEpg: vi.fn(async () => {}) }));
vi.mock('../utils/fetch-helper', () => ({ fetchMaybeGzipText: vi.fn(async (url: string) => url) }));
vi.mock('./channel-customization', () => ({
  ChannelCustomizationService: {
    overrideFor: channelOverrideMock,
    epgChannelIds: epgChannelIdsMock,
  },
}));
vi.mock('../parsers/xmltv-parser', () => {
  const parseXMLTV = vi.fn();
  return {
    parseXMLTV,
    parseXMLTVWithStats: vi.fn((xml: string, options?: unknown) => {
      const data = parseXMLTV(xml, options) as ParsedEpg | undefined;
      const kept = Object.values(data?.programmes ?? {}).reduce((n, list) => n + list.length, 0);
      return {
        data,
        stats: {
          channelsKept: Object.keys(data?.channels ?? {}).length,
          programmesSeen: kept,
          programmesMatched: kept,
          programmesKept: kept,
        },
      };
    }),
  };
});

import { EpgService } from './epg-service';
import { getCachedEpg, setCachedEpg } from './idb-cache';
import { parseXMLTV, parseXMLTVWithStats } from '../parsers/xmltv-parser';
import { fetchMaybeGzipText } from '../utils/fetch-helper';
import type { Channel, EpgSource, ParsedEpg, Programme } from '../types';
import { CONFIG } from '../config';

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
  channelOverrideMock.mockReturnValue(null);
  epgChannelIdsMock.mockReturnValue([]);
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
    expect(EpgService.getUpcoming('ch1', 0)).toEqual([]);
    expect(EpgService.getProgrammesStartingInRange('ch1', h(-1).getTime(), h(2).getTime())
      .map(item => item.title)).toEqual(['Now', 'A']);
    expect(EpgService.getProgrammesIntersectingRange('ch1', h(0).getTime(), h(1).getTime())
      .map(item => item.title)).toEqual(['Now']);
    expect(EpgService.getProgrammeAtStart('ch1', h(1).getTime())?.title).toBe('A');
  });

  it('returns empty results for an unknown channel', () => {
    expect(EpgService.getNowPlaying('missing')).toBeNull();
    expect(EpgService.getUpcoming('missing')).toEqual([]);
  });
});

describe('EpgService multi-source matching', () => {
  it('applies a source offset without mutating parsed program times', async () => {
    const data = parsed('a', 'Alpha', 'Shifted');
    const originalStart = data.programmes.a[0].start.getTime();
    vi.mocked(parseXMLTV).mockReturnValue(data);

    await EpgService.load([{ ...source('http://a', ['a']), offsetMinutes: 60 }]);

    const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.programmes[id!][0].start).toEqual(h(0));
    expect(EpgService.programmes[id!][0].stop).toEqual(h(2));
    expect(data.programmes.a[0].start.getTime()).toBe(originalStart);
  });

  it('keeps colliding XMLTV ids isolated and uses the channel owning playlist', async () => {
    vi.mocked(parseXMLTV).mockImplementation((text) =>
      text === 'http://a' ? parsed('shared', 'Alpha', 'From A') : parsed('shared', 'Bravo', 'From B'));

    await EpgService.load([source('http://a', ['a']), source('http://b', ['b'], 'xtream')]);

    const alpha = channel({ id: 'shared', name: 'Alpha', playlistIds: ['a'] });
    const aId = EpgService.findChannelId(alpha);
    const bId = EpgService.findChannelId(channel({ id: 'shared', name: 'Bravo', playlistIds: ['b'] }));
    expect(aId).not.toBe(bId);
    expect(EpgService.getSourceUrl(alpha)).toBe('http://a');
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

  it('matches an XMLTV channel through a secondary display name', async () => {
    const data = parsed('epg.7', 'Alpha', 'Matched');
    data.channels['epg.7'].aliases = ['Alpha HD'];
    vi.mocked(parseXMLTV).mockReturnValue(data);
    await EpgService.load([source('http://a', ['a'])]);

    const id = EpgService.findChannelId(
      channel({ id: '', name: 'alpha hd', playlistIds: ['a'] }));
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

  it('uses a manual channel mapping before id and name matching', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('epg.8', 'Bravo', 'Mapped'));
    const mappedId = `${encodeURIComponent('http://a')}::epg.8`;
    channelOverrideMock.mockReturnValue({ epgChannelId: mappedId });
    epgChannelIdsMock.mockReturnValue([mappedId]);
    const playlistChannel = channel({
      id: 'wrong',
      name: 'Alpha',
      url: 'http://host/a',
      playlistIds: ['a'],
    });

    await EpgService.load([source('http://a', ['a'])], [playlistChannel]);

    const id = EpgService.findChannelId(playlistChannel);
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Mapped');
    expect(vi.mocked(parseXMLTVWithStats).mock.calls[0][1]).toMatchObject({
      channelIds: new Set(['wrong', 'epg.8']),
      retainChannelCatalog: true,
    });
  });

  it('collects sparse EPG mappings without per-channel customization lookups', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('epg.8', 'Alpha', 'Mapped'));
    const channels = Array.from({ length: 1000 }, (_, index) => channel({
      id: `ch${String(index)}`,
      name: `Channel ${String(index)}`,
      url: `http://host/${String(index)}`,
      playlistIds: ['a'],
    }));

    await EpgService.load([source('http://a', ['a'])], channels);

    expect(epgChannelIdsMock).toHaveBeenCalledTimes(1);
    expect(channelOverrideMock).not.toHaveBeenCalled();
  });

  it('lists searchable mapping candidates only from eligible feeds', async () => {
    vi.mocked(parseXMLTV).mockImplementation((text) =>
      text === 'http://a'
        ? parsed('epg.9', 'Alpha Guide', 'A')
        : parsed('epg.10', 'Alpha Other', 'B'));
    const playlistChannel = channel({
      name: 'Alpha',
      url: 'http://host/a',
      playlistIds: ['a'],
    });
    await EpgService.load([
      source('http://a', ['a']),
      source('http://b', ['b']),
    ], [playlistChannel]);

    expect(EpgService.getMappingCandidates(playlistChannel, 'guide')).toEqual([{
      id: `${encodeURIComponent('http://a')}::epg.9`,
      channelId: 'epg.9',
      name: 'Alpha Guide',
      sourceName: 'EPG 1',
    }]);
  });

  it('keeps the selected mapping visible when it does not match the search', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('epg.9', 'Bravo Guide', 'A'));
    const mappedId = `${encodeURIComponent('http://a')}::epg.9`;
    channelOverrideMock.mockReturnValue({ epgChannelId: mappedId });
    const playlistChannel = channel({
      name: 'Alpha',
      url: 'http://host/a',
      playlistIds: ['a'],
    });
    await EpgService.load([source('http://a', ['a'])], [playlistChannel]);

    expect(EpgService.getMappingCandidates(playlistChannel, 'Alpha')).toEqual([{
      id: mappedId,
      channelId: 'epg.9',
      name: 'Bravo Guide',
      sourceName: 'EPG 1',
    }]);
  });

  it('returns the complete candidate catalog when no limit is requested', async () => {
    const data = parsed('epg.0', 'Guide 000', 'A');
    for (let index = 1; index < 80; index++) {
      data.channels[`epg.${String(index)}`] = {
        name: `Guide ${String(index).padStart(3, '0')}`,
        icon: '',
      };
    }
    vi.mocked(parseXMLTV).mockReturnValue(data);
    const playlistChannel = channel({
      name: 'Alpha',
      url: 'http://host/a',
      playlistIds: ['a'],
    });
    await EpgService.load([source('http://a', ['a'])], [playlistChannel]);

    expect(EpgService.getMappingCandidates(playlistChannel, '')).toHaveLength(80);
    expect(EpgService.getMappingCandidates(playlistChannel, '', 50)).toHaveLength(50);
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

  it('ignores an in-flight load that completes after reset', async () => {
    let resolveFetch!: (value: string) => void;
    vi.mocked(fetchMaybeGzipText).mockImplementationOnce(() =>
      new Promise(resolve => { resolveFetch = resolve; }));
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Program'));
    const loading = EpgService.load([source('http://a', ['a'])]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMaybeGzipText).toHaveBeenCalled();

    EpgService.reset();
    resolveFetch('xml');
    await loading;

    expect(EpgService.channels).toEqual({});
    expect(EpgService.programmes).toEqual({});
    expect(EpgService.loaded).toBe(false);
  });
});

describe('EpgService channel pre-filter', () => {
  it('parses only the channels the source serves, by id and source name', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Program'));

    await EpgService.load([source('http://a', ['a']), source('http://b', ['b'])], [
      channel({ id: 'a', name: 'My Alpha', sourceName: 'Alpha', playlistIds: ['a'] }),
      channel({ id: 'b', name: 'Bravo', playlistIds: ['b'] }),
    ]);

    const options = vi.mocked(parseXMLTVWithStats).mock.calls
      .find(call => call[0] === 'http://a')?.[1] as
      { channelIds: Set<string>; channelNames: Set<string> };
    expect([...options.channelIds]).toEqual(['a']);
    expect([...options.channelNames].sort()).toEqual(['alpha', 'my alpha']);
  });

  it('passes every channel to a manual feed and skips filtering without a playlist', async () => {
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Program'));

    await EpgService.load([source('http://m', [], 'manual')], [
      channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
    ]);
    const manual = vi.mocked(parseXMLTVWithStats).mock.calls[0][1] as { channelIds: Set<string> };
    expect([...manual.channelIds]).toEqual(['a']);

    vi.mocked(parseXMLTVWithStats).mockClear();
    EpgService.reset();
    await EpgService.load([source('http://a', ['a'])]);
    expect(vi.mocked(parseXMLTVWithStats).mock.calls[0][1]).toEqual({});
  });

  it('keeps an unmatched filter instead of retaining the entire feed', async () => {
    vi.mocked(parseXMLTVWithStats).mockReturnValueOnce({
      data: { channels: {}, programmes: {}, tzOffsetMinutes: null },
      stats: {
        channelsKept: 0,
        programmesSeen: 500,
        programmesMatched: 0,
        programmesKept: 0,
      },
    } as never);
    await EpgService.load([source('http://a', ['a'])], [
      channel({ id: 'zz', name: 'Zulu', playlistIds: ['a'] }),
    ]);

    expect(vi.mocked(parseXMLTVWithStats)).toHaveBeenCalledTimes(1);
    expect(setCachedEpg).not.toHaveBeenCalled();
  });

  it('keeps a valid filter when its programmes are outside the time window', async () => {
    vi.mocked(parseXMLTVWithStats).mockReturnValueOnce({
      data: {
        channels: { a: { name: 'Alpha', icon: '' } },
        programmes: {},
        tzOffsetMinutes: null,
      },
      stats: {
        channelsKept: 1,
        programmesSeen: 500,
        programmesMatched: 1,
        programmesKept: 0,
      },
    } as never);

    await EpgService.load([source('http://a', ['a'])], [
      channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
    ]);

    expect(vi.mocked(parseXMLTVWithStats)).toHaveBeenCalledTimes(1);
    expect(setCachedEpg).not.toHaveBeenCalled();
  });

  it('refetches when the playlist gained a channel the cache was not parsed for', async () => {
    vi.mocked(getCachedEpg).mockResolvedValue({
      url: 'http://a',
      timestamp: NOON,
      data: parsed('a', 'Alpha', 'Cached'),
      filter: { ids: ['b'], names: ['bravo'] },
    });
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Fresh'));

    await EpgService.load([source('http://a', ['a'])], [
      channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
    ]);

    expect(fetchMaybeGzipText).toHaveBeenCalledWith('http://a', expect.any(Number));
    const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Fresh');
  });

  it('retries an under-covered cache after a transient fetch failure', async () => {
    vi.mocked(getCachedEpg).mockResolvedValue({
      url: 'http://a',
      timestamp: NOON,
      data: parsed('a', 'Alpha', 'Cached'),
      filter: { ids: ['a'], names: ['alpha'] },
    });
    vi.mocked(fetchMaybeGzipText).mockRejectedValueOnce(new Error('down'));

    const channels = [
      channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
      channel({ id: 'b', name: 'Bravo', playlistIds: ['a'] }),
    ];
    await EpgService.load([source('http://a', ['a'])], channels);

    vi.mocked(parseXMLTV).mockReturnValue(parsed('b', 'Bravo', 'Fresh'));
    await EpgService.refresh();

    expect(fetchMaybeGzipText).toHaveBeenCalledTimes(2);
    const id = EpgService.findChannelId(channels[1]);
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Fresh');
  });

  it('skips a source with no applicable playlist channels', async () => {
    await EpgService.load([source('http://a', ['a'])], [
      channel({ id: 'b', name: 'Bravo', playlistIds: ['b'] }),
    ]);

    expect(getCachedEpg).not.toHaveBeenCalled();
    expect(fetchMaybeGzipText).not.toHaveBeenCalled();
  });

  it('serves a cache whose filter still covers the playlist, including a shrunk one', async () => {
    const channels = [
      channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
      channel({ id: 'b', name: 'Bravo', playlistIds: ['a'] }),
    ];
    vi.mocked(parseXMLTV).mockReturnValue(parsed('a', 'Alpha', 'Fresh'));
    await EpgService.load([source('http://a', ['a'])], channels);
    expect(vi.mocked(setCachedEpg).mock.calls[0][2]).toEqual({
      ids: ['a', 'b'], names: ['alpha', 'bravo'],
    });

    EpgService.reset();
    vi.mocked(fetchMaybeGzipText).mockClear();
    vi.mocked(setCachedEpg).mockClear();
    const cached = parsed('a', 'Alpha', 'Cached');
    const extra = parsed('b', 'Bravo', 'Extra');
    cached.channels.b = extra.channels.b;
    cached.programmes.b = extra.programmes.b;
    cached.channelCatalogComplete = true;
    vi.mocked(getCachedEpg).mockResolvedValue({
      url: 'http://a',
      timestamp: NOON - CONFIG.EPG_REFRESH_INTERVAL + 1000,
      data: cached,
      filter: { ids: ['a', 'b'], names: ['alpha', 'bravo'] },
    });

    await EpgService.load([source('http://a', ['a'])], channels.slice(0, 1));

    expect(fetchMaybeGzipText).not.toHaveBeenCalled();
    expect(setCachedEpg).toHaveBeenCalledTimes(1);
    expect(setCachedEpg).toHaveBeenCalledWith(
      'http://a',
      expect.anything(),
      { ids: ['a'], names: ['alpha'] },
      NOON - CONFIG.EPG_REFRESH_INTERVAL + 1000,
    );
    const cachedData = vi.mocked(setCachedEpg).mock.calls[0][1];
    expect(Object.keys(cachedData.channels)).toEqual(['a', 'b']);
    expect(Object.keys(cachedData.programmes)).toEqual(['a']);
    const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
    expect(EpgService.getNowPlaying(id!)?.title).toBe('Cached');

    vi.setSystemTime(NOON + 1001);
    await EpgService.refresh();
    expect(fetchMaybeGzipText).toHaveBeenCalled();
  });

  it('serves an unfiltered cache to any filter and keeps data when a refresh comes back empty',
    async () => {
      vi.mocked(getCachedEpg).mockResolvedValue({
        url: 'http://a', timestamp: NOON, data: parsed('a', 'Alpha', 'Cached'),
      });

      await EpgService.load([source('http://a', ['a'])], [
        channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }),
      ]);
      expect(fetchMaybeGzipText).not.toHaveBeenCalled();

      vi.setSystemTime(NOON + CONFIG.EPG_REFRESH_INTERVAL + 1);
      vi.mocked(parseXMLTV).mockReturnValue({
        channels: {}, programmes: {}, tzOffsetMinutes: null,
      });
      await EpgService.refresh();

      expect(fetchMaybeGzipText).toHaveBeenCalled();
      const id = EpgService.findChannelId(channel({ id: 'a', name: 'Alpha', playlistIds: ['a'] }));
      expect(EpgService.getProgrammeAtStart(id!, h(-1).getTime())?.title).toBe('Cached');
    });
});
