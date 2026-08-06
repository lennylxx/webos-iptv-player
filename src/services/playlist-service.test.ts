import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel, ChannelCustomization } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';

const { storageMock, fetchTextMock } = vi.hoisted(() => ({
  storageMock: {
    getCachedPlaylist: vi.fn(),
    getPlaylists: vi.fn(),
    setCachedPlaylist: vi.fn(),
    getFavorites: vi.fn(() => [] as string[]),
    migrateFavoriteKeys: vi.fn(),
    getShowHiddenChannels: vi.fn(() => false),
    getChannelCustomization: vi.fn(() => null),
    setChannelCustomization: vi.fn(),
    clearChannelCustomization: vi.fn(),
  },
  fetchTextMock: vi.fn(),
}));

vi.mock('./storage-service', () => ({ StorageService: storageMock }));
vi.mock('../utils/fetch-helper', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/fetch-helper')>(),
  fetchPlaylistText: fetchTextMock,
  fetchText: fetchTextMock,
  fetchLimitedText: fetchTextMock,
}));

import { PlaylistService } from './playlist-service';
import {
  channelKey,
  legacyChannelKey,
} from '../utils/channel';
import { ChannelCustomizationService } from './channel-customization';
import { CONFIG } from '../config';

function channel(over: Partial<Channel>): Channel {
  return {
    id: '', name: '', logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
  };
}

const P1 = `#EXTM3U url-tvg="http://localhost:8080/epg.xml"
#EXTINF:-1 tvg-id="a" group-title="News",Alpha
http://stream/u1
#EXTINF:-1 tvg-id="b",Bravo
http://stream/u2`;

const P2 = `#EXTM3U
#EXTINF:-1 tvg-id="b",Bravo Dup
http://stream/u2
#EXTINF:-1 tvg-id="c" group-title="Sports",Charlie
http://stream/u3`;

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getFavorites.mockReturnValue([]);
  PlaylistService.allChannels = [];
  PlaylistService.channels = [];
  PlaylistService.groups = [];
  PlaylistService.playlistTabs = [];
  PlaylistService.epgSources = [];
});

describe('PlaylistService.refresh', () => {
  beforeEach(() => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'b', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    fetchTextMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('p1') ? P1 : P2),
    );
  });

  it('merges playlists and de-duplicates channels by URL', async () => {
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('loads every distinct EPG URL declared by a playlist', async () => {
    fetchTextMock.mockResolvedValue(
      '#EXTM3U url-tvg="http://host/a.xml,http://host/b.xml"\n'
      + '#EXTINF:-1,Alpha\nhttp://host/a',
    );
    await PlaylistService.refresh();
    expect(PlaylistService.epgSources.map(source => source.url)).toEqual([
      'http://host/a.xml',
      'http://host/b.xml',
    ]);
  });

  it('tags each channel with every source playlist (by id) it appears in', async () => {
    await PlaylistService.refresh();
    // P1 is id 'a', P2 is id 'b'. Bravo (u2) is shared, so it belongs to both.
    expect(PlaylistService.channels.map(c => c.playlistIds)).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('rewrites a loopback EPG host to the playlist host', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.epgSources).toEqual([
      { url: 'http://host1:8080/epg.xml', playlistIds: ['a'], kind: 'm3u' },
    ]);
  });

  it('builds the group set and one tab per loaded playlist', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.groups).toEqual(['News', UNCATEGORIZED_GROUP, 'Sports']);
    expect(PlaylistService.playlistTabs).toEqual([
      { id: 'a', name: 'P1' },
      { id: 'b', name: 'P2' },
    ]);
  });

  it('keeps a fully-duplicated playlist as its own tab showing its channels', async () => {
    // P3 has the same content as P1: every channel is de-duplicated away, but
    // its tab must still appear and list those shared channels.
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'b', name: 'P2', url: 'http://host2/p2.m3u' },
      { id: 'c', name: 'P3', url: 'http://host3/p1.m3u' },
    ]);
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([
      { id: 'a', name: 'P1' },
      { id: 'b', name: 'P2' },
      { id: 'c', name: 'P3' },
    ]);
    expect(PlaylistService.getByGroup('builtin:all', 'c').map(c => c.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('keeps a same-URL sibling tab after the other is deleted', async () => {
    // The reported case: two playlists share a URL; deleting one must not drop
    // the other. Each has its own id, so the survivor keeps its tab + channels.
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'c', name: 'P3', url: 'http://host3/p1.m3u' }, // same content as P1
    ]);
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([
      { id: 'a', name: 'P1' },
      { id: 'c', name: 'P3' },
    ]);

    // Delete P1; only P3 remains configured.
    storageMock.getPlaylists.mockReturnValue([
      { id: 'c', name: 'P3', url: 'http://host3/p1.m3u' },
    ]);
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([{ id: 'c', name: 'P3' }]);
    expect(PlaylistService.getByGroup('builtin:all', 'c').map(ch => ch.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('still shows a tab for a configured playlist that loaded no channels', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'x', name: 'Down', url: 'http://host9/down.m3u' }, // unreachable
    ]);
    fetchTextMock.mockImplementation((url: string) =>
      url.includes('down') ? Promise.reject(new Error('unreachable')) : Promise.resolve(P1));
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([
      { id: 'a', name: 'P1' },
      { id: 'x', name: 'Down' },
    ]);
    expect(PlaylistService.getByGroup('builtin:all', 'x')).toEqual([]); // its tab is empty when selected
  });

  it('shows two same-named playlists as separate tabs, each with its own channels', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'Combo', url: 'http://host1/p1.m3u' },
      { id: 'b', name: 'Combo', url: 'http://host2/p2.m3u' },
    ]);
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([
      { id: 'a', name: 'Combo' },
      { id: 'b', name: 'Combo' },
    ]);
    // Each tab shows only its own playlist's channels; "All" still de-dups.
    expect(PlaylistService.getByGroup('builtin:all', 'a').map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.getByGroup('builtin:all', 'b').map(c => c.name)).toEqual(['Bravo', 'Charlie']);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('persists the merged result to the cache', async () => {
    await PlaylistService.refresh();
    expect(storageMock.setCachedPlaylist).toHaveBeenCalledWith(
      PlaylistService.channels,
      [{ url: 'http://host1:8080/epg.xml', playlistIds: ['a'], kind: 'm3u' }],
    );
  });

  it('returns an empty list and skips fetching when no playlists are configured', async () => {
    storageMock.getPlaylists.mockReturnValue([]);
    const channels = await PlaylistService.refresh();
    expect(channels).toEqual([]);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('skips a playlist that fails to fetch but keeps the others', async () => {
    fetchTextMock.mockImplementation((url: string) =>
      url.includes('p1') ? Promise.reject(new Error('boom')) : Promise.resolve(P2),
    );
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Bravo Dup', 'Charlie']);
    expect(storageMock.setCachedPlaylist).not.toHaveBeenCalled();
  });
});

describe('PlaylistService.refresh (xtream source)', () => {
  const XT = `#EXTM3U
#EXTINF:-1 tvg-id="a" group-title="News",Alpha
http://host:8080/live/u1/p1/101.ts
#EXTINF:-1 tvg-id="b",Bravo
http://host:8080/live/u1/p1/102.ts`;

  beforeEach(() => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080', source: 'xtream',
        xtream: { username: 'u1', password: 'p1' } },
    ]);
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.resolve('[]');
      if (url.includes('player_api.php')) return Promise.resolve(JSON.stringify({
        server_info: { timezone: 'UTC', timestamp_now: 1784662200, time_now: '2026-07-21 20:30:00' },
      }));
      return Promise.resolve(XT);
    });
  });

  it('fetches the derived get.php playlist URL, not the bare base', async () => {
    await PlaylistService.refresh();
    expect(fetchTextMock).toHaveBeenCalledWith(
      'http://host:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts',
      expect.any(Number),
    );
  });

  it('requests HLS for an explicit m3u8 preference', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080', source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveOutput: 'm3u8' } },
    ]);
    await PlaylistService.refresh();
    const call = fetchTextMock.mock.calls.find(([url]) => url.includes('/get.php?'));
    expect(new URL(call![0]).searchParams.get('output')).toBe('m3u8');
  });

  it('auto-prefers HLS when the account advertises it', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080', source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveOutput: 'auto' } },
    ]);
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.resolve('[]');
      if (url.includes('player_api.php')) return Promise.resolve(JSON.stringify({
        user_info: { auth: 1, allowed_output_formats: ['ts', 'm3u8'] },
        server_info: { timezone: 'UTC' },
      }));
      return Promise.resolve(XT);
    });
    await PlaylistService.refresh();
    const call = fetchTextMock.mock.calls.find(([url]) => url.includes('/get.php?'));
    expect(new URL(call![0]).searchParams.get('output')).toBe('m3u8');
  });

  it('parses the channels out of the derived playlist', async () => {
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    // Live URLs come straight from the M3U on the native /live/USER/PASS/ID.ts form.
    expect(channels.every(c => /\/live\/u1\/p1\/\d+\.ts$/.test(c.url))).toBe(true);
  });

  it('pushes the derived xmltv.php EPG URL', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.epgSources.map((source) => source.url)).toContain(
      'http://host:8080/xmltv.php?username=u1&password=p1',
    );
  });

  it('enables catch-up only for streams archived by the account', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 1, tv_archive_duration: '7' },
          { stream_id: 102, tv_archive: 0, tv_archive_duration: '0' },
        ]));
      }
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({
          server_info: { timezone: 'Etc/GMT-2', timestamp_now: 1784665800, time_now: '2026-07-21 22:30:00' },
        }));
      }
      return Promise.resolve(XT);
    });

    const channels = await PlaylistService.refresh();
    expect(channels[0]).toMatchObject({
      catchup: 'xtream',
      catchupDays: 7,
      catchupSource: 'http://host:8080/timeshift/u1/p1/{duration}/{start}/101.ts',
      catchupFallbackSource: 'http://host:8080/streaming/timeshift.php?username=u1&password=p1' +
        '&stream=101&start={start}&duration={duration}&extension=ts',
      catchupAccountId: 'x',
      catchupStreamId: '101',
      catchupTimeZone: 'Etc/GMT-2',
      catchupTimeOffsetMinutes: 120,
    });
    expect(channels[1].catchupSource).toBe('');
  });

  it('keeps provider-supplied M3U catch-up metadata', async () => {
    const withCatchup = XT.replace(
      'tvg-id="a"',
      'tvg-id="a" catchup="default" catchup-days="3" catchup-source="http://host/archive/{utc}"',
    );
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 1, tv_archive_duration: 7 },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(withCatchup);
    });
    const channels = await PlaylistService.refresh();
    expect(channels[0]).toMatchObject({
      catchup: 'default',
      catchupDays: 3,
      catchupSource: 'http://host/archive/{utc}',
    });
  });

  it('keeps one tab for the account even when its feed is unreachable', async () => {
    fetchTextMock.mockRejectedValue(new Error('down'));
    await PlaylistService.refresh();
    expect(PlaylistService.playlistTabs).toEqual([{ id: 'x', name: 'Acct' }]);
  });
});

describe('PlaylistService.load', () => {
  it('uses the cached playlist without hitting the network', async () => {
    const cached = [channel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['P1'] })];
    const epgSources = [{ url: 'http://e', playlistIds: ['P1'], kind: 'm3u' }];
    storageMock.getCachedPlaylist.mockReturnValue({ channels: cached, epgSources });
    const result = await PlaylistService.load();
    expect(result).toEqual(cached);
    expect(PlaylistService.allChannels).toBe(cached);
    expect(PlaylistService.groups).toEqual(['News']);
    expect(PlaylistService.epgSources).toEqual(epgSources);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('refreshes from the network on a cache miss', async () => {
    storageMock.getCachedPlaylist.mockReturnValue(null);
    storageMock.getPlaylists.mockReturnValue([{ name: 'P2', url: 'http://host2/p2.m3u' }]);
    fetchTextMock.mockResolvedValue(P2);
    const result = await PlaylistService.load();
    expect(result.map(c => c.name)).toEqual(['Bravo Dup', 'Charlie']);
    expect(fetchTextMock).toHaveBeenCalled();
  });
});

describe('PlaylistService.indexOf', () => {
  beforeEach(() => {
    storageMock.getPlaylists.mockReturnValue([
      { name: 'P1', url: 'http://host1/p1.m3u' },
      { name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    fetchTextMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('p1') ? P1 : P2),
    );
  });

  it('maps each channel to its global index after load', async () => {
    await PlaylistService.refresh();
    PlaylistService.channels.forEach((ch, i) =>
      expect(PlaylistService.indexOf(ch)).toBe(i));
  });

  it('returns -1 for a channel not in the list', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.indexOf(channel({ name: 'Ghost' }))).toBe(-1);
  });

  it('stays in sync after a re-load (no stale indices)', async () => {
    await PlaylistService.refresh();
    storageMock.getPlaylists.mockReturnValue([{ name: 'P2', url: 'http://host2/p2.m3u' }]);
    await PlaylistService.refresh();
    expect(PlaylistService.channels.map(c => PlaylistService.indexOf(c)))
      .toEqual(PlaylistService.channels.map((_, i) => i));
  });

  it('returns -1 after reset()', async () => {
    await PlaylistService.refresh();
    const first = PlaylistService.channels[0];
    PlaylistService.reset();
    expect(PlaylistService.indexOf(first)).toBe(-1);
  });
});

describe('PlaylistService.getByGroup', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['P1'], url: 'http://host/a' }),
      channel({ id: 'b', name: 'Bravo', group: 'Sports', playlistIds: ['P1'], url: 'http://host/b' }),
      channel({ id: 'c', name: 'Charlie', group: 'News', playlistIds: ['P2'], url: 'http://host/c' }),
    ];
  });

  it('returns everything for "All"', () => {
    expect(PlaylistService.getByGroup('builtin:all').map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('filters by group', () => {
    expect(PlaylistService.getByGroup('source:News').map(c => c.name)).toEqual(['Alpha', 'Charlie']);
  });

  it('keeps a provider group named Favorites separate from the built-in filter', () => {
    PlaylistService.channels[0].group = 'Favorites';
    storageMock.getFavorites.mockReturnValue([channelKey(PlaylistService.channels[1])]);
    expect(PlaylistService.getByGroup('source:Favorites').map(c => c.name)).toEqual(['Alpha']);
    expect(PlaylistService.getByGroup('builtin:favorites').map(c => c.name)).toEqual(['Bravo']);
  });

  it('filters by playlist when provided', () => {
    expect(PlaylistService.getByGroup('builtin:all', 'P1').map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.getByGroup('source:News', 'P2').map(c => c.name)).toEqual(['Charlie']);
  });

  it('resolves "Favorites" against StorageService, keyed by channelKey', () => {
    storageMock.getFavorites.mockReturnValue([channelKey(PlaylistService.channels[1])]);
    expect(PlaylistService.getByGroup('builtin:favorites').map(c => c.name)).toEqual(['Bravo']);
  });

  it('keeps query-identified streams separate in Favorites', () => {
    const first = channel({ name: 'Alpha', url: 'http://host/a?id=1' });
    const second = channel({ name: 'Bravo', url: 'http://host/a?id=2' });
    PlaylistService.channels = [first, second];
    storageMock.getFavorites.mockReturnValue([channelKey(first)]);

    expect(PlaylistService.getByGroup('builtin:favorites').map(c => c.name)).toEqual(['Alpha']);
  });
});

describe('PlaylistService.search', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ name: 'Alpha', group: 'News', playlistIds: ['P1'] }),
      channel({ name: 'Bravo', group: 'Sports', playlistIds: ['P1'] }),
      channel({ name: 'Charlie', group: 'News', playlistIds: ['P2'] }),
    ];
  });

  it('matches channel names case-insensitively, spanning all groups/playlists', () => {
    expect(PlaylistService.search('A').map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(PlaylistService.search('char').map(c => c.name)).toEqual(['Charlie']);
  });

  it('scopes results to a single playlist when one is given', () => {
    expect(PlaylistService.search('a', 'P1').map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.search('a', 'P2').map(c => c.name)).toEqual(['Charlie']);
  });

  it('returns no results for an empty or whitespace query', () => {
    expect(PlaylistService.search('')).toEqual([]);
    expect(PlaylistService.search('   ')).toEqual([]);
  });

  it('matches channel genres through natural-language-lite synonyms', () => {
    expect(PlaylistService.search('footy').map(c => c.name)).toEqual(['Bravo']);
    expect(PlaylistService.search('headlines').map(c => c.name)).toEqual(['Alpha', 'Charlie']);
  });
});

describe('PlaylistService.getGroupsForPlaylist', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ name: 'Alpha', group: 'News', playlistIds: ['P1'] }),
      channel({ name: 'Bravo', group: 'Sports', playlistIds: ['P1'] }),
      channel({ name: 'Charlie', group: 'Movies', playlistIds: ['P2'] }),
    ];
  });

  it('returns the distinct groups within a playlist', () => {
    expect(PlaylistService.getGroupsForPlaylist('P1')).toEqual(['News', 'Sports']);
  });

  it('returns all groups when no playlist is given', () => {
    expect(PlaylistService.getGroupsForPlaylist()).toEqual(['News', 'Sports', 'Movies']);
  });

  it('serves group counts from the derived index without rescanning channels', () => {
    let groupReads = 0;
    let urlReads = 0;
    PlaylistService.channels = Array.from({ length: 5000 }, (_, index) => {
      const item = channel({
        name: `ch${index}`,
        playlistIds: [`P${index % 2}`],
      });
      Object.defineProperty(item, 'group', {
        configurable: true,
        get: () => {
          groupReads++;
          return `Group ${index}`;
        },
      });
      Object.defineProperty(item, 'url', {
        configurable: true,
        get: () => {
          urlReads++;
          return `http://host/${index}`;
        },
      });
      return item;
    });

    const groups = PlaylistService.getGroupsForPlaylist();
    groupReads = 0;
    urlReads = 0;
    for (const group of groups) {
      expect(PlaylistService.getGroupCount(`source:${group}`)).toBe(1);
    }

    expect(groupReads).toBe(0);
    expect(PlaylistService.getGroupCount('builtin:favorites')).toBe(0);
    expect(urlReads).toBe(0);
    expect(PlaylistService.getGroupCount('builtin:all', 'P1')).toBe(2500);
  });
});

describe('PlaylistService.reset', () => {
  it('clears channels, groups, playlistTabs and epgSources', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host/1.m3u' },
    ]);
    fetchTextMock.mockResolvedValueOnce(P1);
    await PlaylistService.refresh();
    expect(PlaylistService.channels.length).toBeGreaterThan(0);
    expect(PlaylistService.groups.length).toBeGreaterThan(0);
    expect(PlaylistService.playlistTabs).toEqual([{ id: 'a', name: 'P1' }]);
    expect(PlaylistService.epgSources.length).toBeGreaterThan(0);

    PlaylistService.reset();

    expect(PlaylistService.channels).toEqual([]);
    expect(PlaylistService.groups).toEqual([]);
    expect(PlaylistService.playlistTabs).toEqual([]);
    expect(PlaylistService.epgSources).toEqual([]);
  });
});

describe('PlaylistService.search', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ id: '1', name: 'Alpha', playlistIds: ['a'] }),
      channel({ id: '2', name: 'XAlpha', playlistIds: ['a'] }),
      channel({ id: '3', name: 'Alpha HD', playlistIds: ['b'] }),
    ];
  });

  it('returns [] for a blank query', () => {
    expect(PlaylistService.search('  ')).toEqual([]);
  });

  it('ranks exact and prefix matches above a mid-word match', () => {
    expect(PlaylistService.search('alpha').map(c => c.name)).toEqual(['Alpha', 'Alpha HD', 'XAlpha']);
  });

  it('scopes to a single playlist when given', () => {
    expect(PlaylistService.search('alpha', 'b').map(c => c.name)).toEqual(['Alpha HD']);
  });
});

describe('PlaylistService customization', () => {
  const KEY_A = channelKey({ url: 'http://stream/u1' } as Channel);
  const KEY_B = channelKey({ url: 'http://stream/u2' } as Channel);

  function record(over: Partial<ChannelCustomization> = {}): ChannelCustomization {
    return {
      version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
      overrides: {}, order: [], groupOrder: [], groupOverrides: {}, customGroups: [], ...over,
    };
  }

  function useRecord(data: ChannelCustomization | null): void {
    storageMock.getChannelCustomization.mockReturnValue(data);
    ChannelCustomizationService.reload();
  }

  beforeEach(() => {
    storageMock.getPlaylists.mockReturnValue([{ id: 'a', name: 'P1', url: 'http://host1/p1.m3u' }]);
    fetchTextMock.mockResolvedValue(P1);
    useRecord(null);
  });

  it('keeps the raw parse on allChannels and the customized view on channels', async () => {
    useRecord(record({ overrides: { [KEY_B]: { hidden: true } }, order: [KEY_B, KEY_A] }));
    await PlaylistService.refresh();

    expect(PlaylistService.allChannels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha']);
    // The raw parse is cached, so an edit never forces a re-fetch.
    expect(storageMock.setCachedPlaylist).toHaveBeenCalledWith(
      PlaylistService.allChannels, PlaylistService.epgSources);
  });

  it('re-derives indices after an edit so index-based consumers follow', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.indexOf(PlaylistService.channels[0])).toBe(0);

    useRecord(record({ order: [KEY_B, KEY_A] }));
    PlaylistService.applyCustomization();

    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Bravo', 'Alpha']);
    expect(PlaylistService.indexOfKey(KEY_A)).toBe(1);
    expect(PlaylistService.indexOfKey(KEY_B)).toBe(0);
    expect(PlaylistService.indexOfKey('missing')).toBe(-1);
    expect(PlaylistService.getByIndex(0)?.name).toBe('Bravo');
  });

  it('prefers the channel key and uses the legacy index only without one', async () => {
    await PlaylistService.refresh();
    const savedKey = channelKey(PlaylistService.channels[1]);

    expect(PlaylistService.resolveLastChannelIndex(savedKey, 0)).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex('missing', 0)).toBe(-1);
    expect(PlaylistService.resolveLastChannelIndex('', 1)).toBe(1);
  });

  it('resolves query-distinguished streams precisely for autoplay', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1' }),
      channel({ url: 'http://host/stream?id=2' }),
    ];

    const second = channelKey(PlaylistService.channels[1]);
    expect(PlaylistService.resolveLastChannelIndex(second, 0)).toBe(1);
  });

  it('uses a stable query identity after a stream token rotates', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1&token=B' }),
      channel({ url: 'http://host/stream?id=2&token=B' }),
    ];
    const old = channel({ url: 'http://host/stream?id=2&token=A' });

    expect(PlaylistService.resolveLastChannelIndex(channelKey(old), 0)).toBe(1);
  });

  it('does not use an ambiguous legacy autoplay key', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1' }),
      channel({ url: 'http://host/stream?id=2' }),
    ];

    expect(PlaylistService.resolveLastChannelIndex(
      legacyChannelKey(PlaylistService.channels[1]),
      0,
    )).toBe(-1);
  });

  it('keeps empty custom groups in global navigation only', async () => {
    useRecord(record({ customGroups: ['Empty'] }));
    await PlaylistService.refresh();

    expect(PlaylistService.groups).toContain('Empty');
    expect(PlaylistService.getGroupsForPlaylist()).toContain('Empty');
    expect(PlaylistService.getGroupsForPlaylist('a')).not.toContain('Empty');
  });

  it('reveals hidden channels while edit mode asks for them', async () => {
    useRecord(record({ overrides: { [KEY_B]: { hidden: true } } }));
    await PlaylistService.refresh();
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha']);

    PlaylistService.setIncludeHidden(true);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    PlaylistService.setIncludeHidden(false);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha']);
  });

  it('reveals hidden channels when the show-hidden setting is on', async () => {
    useRecord(record({ overrides: { [KEY_B]: { hidden: true } } }));
    storageMock.getShowHiddenChannels.mockReturnValue(true);
    try {
      await PlaylistService.refresh();
      expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    } finally {
      storageMock.getShowHiddenChannels.mockReturnValue(false);
    }
  });

  it('applies renames and group assignments and orders the groups', async () => {
    useRecord(record({
      overrides: { [KEY_A]: { name: 'Alpha Two', group: 'Custom' } },
      groupOrder: [UNCATEGORIZED_GROUP, 'Custom'],
      customGroups: ['Custom'],
    }));
    await PlaylistService.refresh();

    const alpha = PlaylistService.channels[0];
    expect(alpha.name).toBe('Alpha Two');
    expect(alpha.sourceName).toBe('Alpha');
    expect(alpha.group).toBe('Custom');
    expect(alpha.sourceGroup).toBe('News');
    expect(PlaylistService.groups).toEqual([UNCATEGORIZED_GROUP, 'Custom']);
    expect(PlaylistService.getGroupsForPlaylist('a')).toEqual([UNCATEGORIZED_GROUP, 'Custom']);
  });

  it('applies customization to a cached playlist without a fetch', async () => {
    const cached = [
      channel({ name: 'Alpha', url: 'http://stream/u1', group: 'News', playlistIds: ['a'] }),
      channel({ name: 'Bravo', url: 'http://stream/u2', group: 'News', playlistIds: ['a'] }),
    ];
    storageMock.getCachedPlaylist.mockReturnValue({ channels: cached, epgSources: [] });
    useRecord(record({ order: [KEY_B, KEY_A] }));

    const result = await PlaylistService.load();
    expect(result.map(c => c.name)).toEqual(['Bravo', 'Alpha']);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('keeps channels added by a later refresh behind the arranged block', async () => {
    useRecord(record({ order: [KEY_B, KEY_A] }));
    await PlaylistService.refresh();
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Bravo', 'Alpha']);

    fetchTextMock.mockResolvedValue(`${P1}
#EXTINF:-1 tvg-id="d",Delta
http://stream/u4`);
    await PlaylistService.refresh();
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Bravo', 'Alpha', 'Delta']);
  });
});
