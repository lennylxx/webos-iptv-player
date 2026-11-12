import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel, ChannelCustomization } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';

const { storageMock, cacheMock, fetchTextMock, heldReleaseMock } = vi.hoisted(() => ({
  heldReleaseMock: vi.fn(),
  storageMock: {
    getPlaylists: vi.fn(),
    getFavorites: vi.fn(() => [] as string[]),
    migrateFavoriteKeys: vi.fn(),
    getShowHiddenChannels: vi.fn(() => false),
    getChannelCustomization: vi.fn(() => null),
    getPlaylistRefreshIntervalMs: vi.fn(() => 6 * 60 * 60 * 1000),
    setChannelCustomization: vi.fn(),
    clearChannelCustomization: vi.fn(),
    liveCategorySnapshots: new Map<string, unknown>(),
    getLiveCategorySnapshot: vi.fn(function getLiveCategorySnapshot(id: string) {
      return storageMock.liveCategorySnapshots.get(id) ?? null;
    }),
    setLiveCategorySnapshot: vi.fn((id: string, snapshot: unknown) => {
      storageMock.liveCategorySnapshots.set(id, snapshot);
    }),
  },
  cacheMock: {
    getCachedPlaylist: vi.fn(),
    scheduleCachedPlaylist: vi.fn(),
    playlistCacheToken: vi.fn(() => ({ signature: 's1', generation: 0 })),
    cacheRecordRef: vi.fn((_value: unknown): unknown => null),
  },
  fetchTextMock: vi.fn(),
}));

vi.mock('./storage-service', () => ({ StorageService: storageMock }));
vi.mock('./idb-cache', () => cacheMock);
vi.mock('../parsers/m3u-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/m3u-loader')>();
  return {
    ...actual,
    fetchAndParseM3U: vi.fn(async (
      url: string,
      timeout: number,
      streams?: Array<{
        streamId: string;
        directSource: string;
        archive?: boolean;
        archiveDurationDays?: number;
      }>,
      baseUrl?: string,
      onProgress?: (progress: {
        inputBytes: number;
        chunks: number;
        channelsProcessed: number;
        channelsKept: number;
        channelsDropped: number;
      }) => void,
      groupFilter?: { mode: 'include' | 'exclude'; names: string[] },
      playlistId?: string,
      holdChannels?: boolean,
      xtreamCatchup?: import('../workers/tasks').XtreamCatchupRequest,
    ) => {
      const clock = await actual.loadXtreamCatchupClock(streams, xtreamCatchup);
      const text = await fetchTextMock(url, timeout);
      const { parseM3U } = await import('../parsers/m3u-parser');
      const liveFilters = actual.createXtreamM3ULiveFilters(
        streams,
        baseUrl,
        groupFilter,
        streams && xtreamCatchup ? { ...xtreamCatchup, clock: clock.clock } : undefined,
      );
      const data = parseM3U(text, url, {
        ...(liveFilters.streamLocationPrefilter
          ? {
              streamLocationPrefilter:
                liveFilters.streamLocationPrefilter,
            }
          : {}),
        ...(liveFilters.channelPostfilter
          ? { channelPostfilter: liveFilters.channelPostfilter }
          : {}),
      });
      // Like the worker: a playlist id asks for its own copies merged.
      let duplicates: number | undefined;
      if (playlistId !== undefined) {
        const { channelExactStreamIdentity } = await import('../utils/channel-identity');
        const seen = new Set<string>();
        duplicates = 0;
        data.channels = data.channels.filter((ch) => {
          const identity = channelExactStreamIdentity(ch);
          if (seen.has(identity)) {
            duplicates!++;
            return false;
          }
          seen.add(identity);
          ch.playlistIds = [playlistId];
          return true;
        });
      }
      if (holdChannels && data.channels.length) {
        const { holdRecord } = await import('./held-records');
        holdRecord(data.channels, { bytes: 1, write: vi.fn(), release: heldReleaseMock });
      }
      onProgress?.({
        inputBytes: text.length,
        chunks: 1,
        channelsProcessed: data.channels.length + liveFilters.getDroppedCount(),
        channelsKept: data.channels.length,
        channelsDropped: liveFilters.getDroppedCount(),
      });
      return {
        data,
        metrics: {
          transport: 'stream' as const,
          filter: liveFilters.mode,
          inputBytes: text.length,
          chunks: 1,
          channelsKept: data.channels.length,
          channelsDropped: liveFilters.getDroppedCount(),
          elapsedMs: 0,
          ...(duplicates !== undefined ? { duplicates } : {}),
          ...(liveFilters.catchupCounts ? { catchup: liveFilters.catchupCounts(clock) } : {}),
        },
      };
    }),
  };
});
vi.mock('../utils/fetch-helper', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/fetch-helper')>(),
  fetchText: fetchTextMock,
  fetchLimitedText: fetchTextMock,
}));

import { PlaylistService } from './playlist-service';
import { fetchAndParseM3U } from '../parsers/m3u-loader';
import {
  channelExactStreamIdentity,
  channelExactStreamKey,
  channelHttpHeaders,
  channelKey,
  channelStreamIdentity,
  channelStreamKey,
  legacyChannelKey,
} from '../utils/channel';
import { ChannelCustomizationService } from './channel-customization';
import { heldRecord } from './held-records';
import { ParentalControlService } from './parental-control';
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
  cacheMock.getCachedPlaylist.mockResolvedValue(null);
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

  it('leaves the cache write to the worker only for a lone playlist', async () => {
    await PlaylistService.refresh();
    expect(vi.mocked(fetchAndParseM3U).mock.calls.map(call => call[7])).toEqual([false, false]);

    storageMock.getPlaylists.mockReturnValue([{ id: 'a', name: 'P1', url: 'http://host1/p1.m3u' }]);
    await PlaylistService.refresh();
    expect(vi.mocked(fetchAndParseM3U).mock.calls[2][7]).toBe(true);
    const scheduled = vi.mocked(cacheMock.scheduleCachedPlaylist).mock.calls[1][0] as Channel[];
    expect(scheduled).toBe(PlaylistService.allChannels);
    expect(heldRecord(scheduled)).not.toBeNull();
    expect(heldReleaseMock).not.toHaveBeenCalled();
  });

  it('merges playlists and de-duplicates channels by URL', async () => {
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('keeps channels that share a URL but send different headers', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://stream/u1|Referer=http://host/a\n'
      : '#EXTM3U\n#EXTINF:-1,Bravo\nhttp://stream/u1|Referer=http://host/b\n'
        + '#EXTINF:-1,Bravo Dup\nhttp://stream/u1|Referer=http://host/b\n'));
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('keeps channels that share a URL but declare different option headers', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\n#EXTVLCOPT:http-referrer=http://host/a\nhttp://stream/u1\n'
        + '#EXTINF:-1,Bravo\n#EXTHTTP:{"Cookie":"c=1"}\nhttp://stream/u1\n'
        + '#EXTINF:-1,Charlie\n'
        + '#KODIPROP:inputstream.adaptive.stream_headers=Referer=http%3A%2F%2Fhost%2Fc\n'
        + 'http://stream/u1\n'
        + '#EXTINF:-1,Delta\nhttp://stream/u2\n'
      : '#EXTM3U\n#EXTINF:-1,Alpha Dup\n#EXTVLCOPT:http-referrer=http://host/a\nhttp://stream/u1\n'
        + '#EXTINF:-1,Delta Dup\nhttp://stream/u2\n'));
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(channels.map(c => channelHttpHeaders(c))).toEqual([
      { Referer: 'http://host/a' }, { Cookie: 'c=1' }, { Referer: 'http://host/c' }, {},
    ]);
    expect(channels.map(c => c.playlistIds)).toEqual([['a', 'b'], ['a'], ['a'], ['a', 'b']]);
  });

  it('keeps channels that share a URL but use different DRM options', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\n'
        + '#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready\n'
        + '#KODIPROP:inputstream.adaptive.license_key=http://host/l1\nhttp://stream/u1\n'
        + '#EXTINF:-1,Bravo\nhttp://stream/u1\n'
      : '#EXTM3U\n#EXTINF:-1,Bravo Dup\nhttp://stream/u1\n'));
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(channels.map(c => c.playlistIds)).toEqual([['a'], ['a', 'b']]);
  });

  it('merges channels whose options differ only in what playback ignores', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\n#EXTVLCOPT:network-caching=1000\nhttp://stream/u1\n'
      : '#EXTM3U\n#EXTINF:-1,Alpha Dup\n#EXTVLCOPT:http-reconnect=true\nhttp://stream/u1\n'));
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Alpha']);
    expect(channels[0].playlistIds).toEqual(['a', 'b']);
  });

  it('resolves the exact stream among channels that share a key', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\n#EXTVLCOPT:http-referrer=http://host/a\nhttp://stream/u1\n'
        + '#EXTINF:-1,Bravo\nhttp://stream/u1\n'
        + '#EXTINF:-1,Charlie\n#EXTVLCOPT:http-user-agent=Agent 1\nhttp://stream/u1\n'
      : '#EXTM3U\n'));
    const [alpha, bravo, charlie] = await PlaylistService.refresh();
    const key = channelKey(alpha);
    expect(channelKey(bravo)).toBe(key);
    for (const channel of [alpha, bravo, charlie]) {
      expect(PlaylistService.resolveChannelKey(key, channelStreamIdentity({ ...channel }))?.channel)
        .toBe(channel);
    }
  });

  it('schedules the next refresh from the last successful refresh time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await PlaylistService.refresh();

      now.mockReturnValue(1_000_000 + 2 * 60 * 60 * 1000);

      expect(PlaylistService.getNextRefreshDelayMs(6 * 60 * 60 * 1000))
        .toBe(4 * 60 * 60 * 1000);
    } finally {
      now.mockRestore();
    }
  });

  it('reports cumulative channel-loading progress across sources', async () => {
    const progress: Parameters<typeof PlaylistService.refresh>[0] extends
      ((value: infer Value) => void) ? Value[] : never = [];

    await PlaylistService.refresh(value => progress.push(value));

    expect(progress).toEqual([
      {
        sourceNumber: 1,
        sourceCount: 2,
        inputBytes: P1.length,
        channelsProcessed: 2,
        channelsKept: 2,
      },
      {
        sourceNumber: 2,
        sourceCount: 2,
        inputBytes: P2.length,
        channelsProcessed: 4,
        channelsKept: 4,
      },
    ]);
  });

  it('loads a bare MPD playlist URL as a single DASH channel', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'DASH', url: 'http://host/live.mpd' },
    ]);
    fetchTextMock.mockResolvedValue(
      '<?xml version="1.0"?><MPD type="dynamic"></MPD>',
    );

    const channels = await PlaylistService.refresh();

    expect(channels).toEqual([
      expect.objectContaining({
        name: 'live',
        url: 'http://host/live.mpd',
        playlistIds: ['a'],
      }),
    ]);
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
    expect(cacheMock.scheduleCachedPlaylist).toHaveBeenCalledWith(
      PlaylistService.channels,
      [{ url: 'http://host1:8080/epg.xml', playlistIds: ['a'], kind: 'm3u' }],
      expect.any(Number),
      6 * 60 * 60 * 1000,
      { signature: 's1', generation: 0 },
      ['a', 'b'],
    );
  });

  it('binds the cache write to the sources the refresh started with', async () => {
    const started = { signature: 'before', generation: 1 };
    cacheMock.playlistCacheToken.mockReturnValueOnce(started);
    cacheMock.playlistCacheToken.mockReturnValueOnce({ signature: 'after', generation: 2 });

    await PlaylistService.refresh();

    expect(cacheMock.scheduleCachedPlaylist.mock.calls[0][4]).toBe(started);
  });

  it('does not block the refreshed channel list on cache persistence', async () => {
    await expect(PlaylistService.refresh()).resolves.toHaveLength(3);
    expect(cacheMock.scheduleCachedPlaylist).toHaveBeenCalledOnce();
  });

  it('returns an empty list and skips fetching when no playlists are configured', async () => {
    storageMock.getPlaylists.mockReturnValue([]);
    const channels = await PlaylistService.refresh();
    expect(channels).toEqual([]);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('skips disabled sources and omits their playlist tabs', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u', enabled: false },
      { id: 'b', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);

    const channels = await PlaylistService.refresh();

    expect(fetchTextMock).toHaveBeenCalledTimes(1);
    expect(fetchTextMock).toHaveBeenCalledWith('http://host2/p2.m3u', 60000);
    expect(channels.map(channel => channel.name)).toEqual(['Bravo Dup', 'Charlie']);
    expect(PlaylistService.playlistTabs).toEqual([{ id: 'b', name: 'P2' }]);
  });

  it('clears in-memory channels when every source is disabled', async () => {
    PlaylistService.allChannels = [
      channel({ id: 'a', name: 'Alpha', url: 'http://stream/a', playlistIds: ['a'] }),
    ];
    PlaylistService.channels = PlaylistService.allChannels;
    storageMock.getPlaylists.mockReturnValue([
      { id: 'a', name: 'P1', url: 'http://host1/p1.m3u', enabled: false },
    ]);

    await expect(PlaylistService.refresh()).resolves.toEqual([]);

    expect(PlaylistService.allChannels).toEqual([]);
    expect(PlaylistService.playlistTabs).toEqual([]);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('skips a playlist that fails to fetch but keeps the others', async () => {
    fetchTextMock.mockImplementation((url: string) =>
      url.includes('p1') ? Promise.reject(new Error('boom')) : Promise.resolve(P2),
    );
    const channels = await PlaylistService.refresh();
    expect(channels.map(c => c.name)).toEqual(['Bravo Dup', 'Charlie']);
    expect(cacheMock.scheduleCachedPlaylist).not.toHaveBeenCalled();
    expect(PlaylistService.hasFailedSource(['a'])).toBe(true);
    expect(PlaylistService.hasFailedSource(['b'])).toBe(false);
    fetchTextMock.mockResolvedValue(P1);
    await PlaylistService.refresh();
    expect(PlaylistService.hasFailedSource(['a'])).toBe(false);
  });

  it('keeps the current list when an automatic refresh is incomplete', async () => {
    await PlaylistService.refresh();
    const previousChannels = PlaylistService.channels;
    const previousEpgSources = PlaylistService.epgSources;
    fetchTextMock.mockImplementation((url: string) =>
      url.includes('p1') ? Promise.reject(new Error('boom')) : Promise.resolve(P2),
    );

    const channels = await PlaylistService.refresh(
      undefined,
      { preserveOnFailure: true },
    );

    expect(channels).toBe(previousChannels);
    expect(PlaylistService.channels).toBe(previousChannels);
    expect(PlaylistService.epgSources).toBe(previousEpgSources);
    expect(PlaylistService.channels.map(channel => channel.name))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(PlaylistService.hasFailedSource(['a'])).toBe(true);
    expect(cacheMock.scheduleCachedPlaylist).toHaveBeenCalledOnce();
  });

  it('clears unresolved source state when the catalog is reset', async () => {
    fetchTextMock.mockRejectedValue(new Error('offline'));
    await PlaylistService.refresh();
    expect(PlaylistService.hasFailedSource(['a'])).toBe(true);
    PlaylistService.reset();
    expect(PlaylistService.hasFailedSource(['a'])).toBe(false);
  });

  it('counts copies within and across playlists in each source log', async () => {
    fetchTextMock.mockImplementation((url: string) => Promise.resolve(url.includes('p1')
      ? '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://stream/u1\n#EXTINF:-1,Alpha Dup\nhttp://stream/u1\n'
        + '#EXTINF:-1,Bravo\nhttp://stream/u2\n'
      : '#EXTM3U\n#EXTINF:-1,Bravo Dup\nhttp://stream/u2\n#EXTINF:-1,Charlie\nhttp://stream/u3\n'
        + '#EXTINF:-1,Charlie Dup\nhttp://stream/u3\n'));
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const channels = await PlaylistService.refresh();
    const lines = info.mock.calls.map(args => args.join(' '))
      .filter(line => line.includes('event=playlist.source.load.completed'));
    info.mockRestore();

    expect(channels.map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('channels=3 added=2 duplicates=1');
    expect(lines[1]).toContain('channels=3 added=1 duplicates=2');
  });

  it('logs the loaded catalog size for a diagnostics report', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    await PlaylistService.refresh();
    expect(info.mock.calls.map(args => args.join(' '))).toContainEqual(
      expect.stringContaining(
        'event=playlist.load.completed source=network channels=3 all=3'
        + ' groups=3 epg=1 sources=2 failed=0',
      ),
    );
    info.mockRestore();
  });

  it('warns with the failed source count when a playlist load fails', async () => {
    fetchTextMock.mockRejectedValue(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await PlaylistService.refresh();
    expect(warn.mock.calls.map(args => args.join(' '))).toContainEqual(
      expect.stringContaining(
        'event=playlist.load.completed source=network channels=0 all=0'
        + ' groups=0 epg=0 sources=2 failed=2',
      ),
    );
    warn.mockRestore();
    error.mockRestore();
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
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 0 },
          { stream_id: 102, tv_archive: 0 },
        ]));
      }
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

  it('does not refetch an unavailable Live catalog when the M3U is usable', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.resolve('<html>nope</html>');
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(XT);
    });

    await PlaylistService.refresh();
    expect(fetchTextMock.mock.calls.filter(([url]) =>
      url.includes('action=get_live_streams'))).toHaveLength(1);
  });

  it('does not guess content type when the Player API Live catalog is unavailable', async () => {
    const mixed = `#EXTM3U
#EXTINF:-1,Alpha
http://host:8080/live/u1/p1/101.ts
#EXTINF:-1,Bravo
http://host:8080/movie/u1/p1/201.mp4
#EXTINF:-1,Charlie
http://host:8080/SeRiEs/u1/p1/301.mkv
#EXTINF:-1,Delta
http://host:8080/movies/u1/p1/401.ts
#EXTINF:-1,Echo
http://host:8080/play?path=/series/u1/p1/501.mkv
#EXTINF:-1,Foxtrot
not-a-url`;
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.resolve('<html>nope</html>');
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(mixed);
    });

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
    ]);
  });

  it('cross-checks alternate routes against the Player API Live catalog', async () => {
    const mixed = `#EXTM3U
#EXTINF:-1,Alpha
http://host:8080/live/u1/p1/101.ts
#EXTINF:-1,Movie
http://host:8080/vod/u1/p1/101.mkv
#EXTINF:-1,Series
http://host:8080/series/u1/p1/201
#EXTINF:-1,Bravo
http://host:8080/play?stream_id=102
#EXTINF:-1,Movie Query
http://host:8080/movie/u1/p1/301.mp4?stream_id=102
#EXTINF:-1,Charlie
https://host/token/abc?token=new&x=1`;
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 0 },
          { stream_id: 102, tv_archive: 0 },
          {
            stream_id: 103,
            direct_source: 'https://host/token/abc?x=1&token=old',
            tv_archive: 0,
          },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(mixed);
    });

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
    expect(channels.map(channel => channel.catchupStreamId))
      .toEqual(['101', '102', '103']);
  });

  it('keeps M3U metadata for a path-prefixed Xtream portal', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080/panel', source: 'xtream',
        xtream: { username: 'u1', password: 'p1' } },
    ]);
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 0 },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(`#EXTM3U
#EXTINF:-1 custom-field="kept",Alpha
http://host:8080/panel/live/u1/p1/101.ts`);
    });

    const channels = await PlaylistService.refresh();

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      name: 'Alpha',
      sourceAttributes: { 'custom-field': 'kept' },
      catchupStreamId: '101',
    });
  });

  it('treats a successful empty Live catalog as authoritative', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.resolve('[]');
      if (url.includes('action=get_live_categories')) return Promise.resolve('[]');
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(`#EXTM3U
#EXTINF:-1,Movie
http://host:8080/movie/u1/p1/201.mp4`);
    });

    expect(await PlaylistService.refresh()).toEqual([]);
    expect(fetchTextMock.mock.calls.filter(([url]) =>
      url.includes('action=get_live_streams'))).toHaveLength(1);
  });

  it('does not filter movie and series paths from an ordinary M3U', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'm', name: 'M3U', url: 'http://host/list.m3u', source: 'url' },
    ]);
    fetchTextMock.mockResolvedValue(`#EXTM3U
#EXTINF:-1,Alpha
http://host/movie/u1/p1/201.mp4
#EXTINF:-1,Bravo
http://host/series/u1/p1/301.mkv`);

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('does not request live categories when get.php returns channels', async () => {
    await PlaylistService.refresh();
    expect(fetchTextMock.mock.calls.some(([url]) =>
      url.includes('action=get_live_categories'))).toBe(false);
  });

  it.each([
    ['fails', 'reject'],
    ['contains no channels', 'empty'],
    ['contains only standard VOD entries', 'vod'],
  ])('uses the Player API live catalog when get.php %s', async (_label, mode) => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_categories')) {
        return Promise.resolve(JSON.stringify([
          { category_id: '1', category_name: 'Alpha' },
        ]));
      }
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          {
            stream_id: 201,
            name: 'Bravo',
            stream_icon: 'http://host/b.png',
            epg_channel_id: 'epg-b',
            category_id: '1',
            direct_source: 'https://host/direct/201',
            tv_archive: 1,
            tv_archive_duration: 3,
          },
          {
            stream_id: 202,
            name: 'Charlie',
            category_id: '9',
            direct_source: 'file:///tmp/not-allowed',
            tv_archive: 0,
          },
        ]));
      }
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({
          server_info: { timezone: 'UTC' },
        }));
      }
      if (mode === 'reject') return Promise.reject(new Error('get.php unavailable'));
      if (mode === 'vod') {
        return Promise.resolve('#EXTM3U\n#EXTINF:-1,Delta\n'
          + 'http://host:8080/movie/u1/p1/301.mp4');
      }
      return Promise.resolve('#EXTM3U');
    });

    const channels = await PlaylistService.refresh();

    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      id: 'epg-b',
      name: 'Bravo',
      logo: 'http://host/b.png',
      group: 'Alpha',
      url: 'https://host/direct/201',
      catchup: 'xtream',
      catchupStreamId: '201',
      catchupDays: 3,
    });
    expect(channels[1]).toMatchObject({
      name: 'Charlie',
      group: UNCATEGORIZED_GROUP,
      url: 'http://host:8080/live/u1/p1/202.ts',
      catchupSource: '',
    });
  });

  it('uses the selected HLS output for Player API fallback URLs', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080', source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveOutput: 'm3u8' } },
    ]);
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_categories')) return Promise.resolve('[]');
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 201, name: 'Alpha', category_id: '1', tv_archive: 0 },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve('#EXTM3U');
    });

    const channels = await PlaylistService.refresh();
    expect(channels[0].url).toBe('http://host:8080/live/u1/p1/201.m3u8');
  });

  it('loads uncategorized live streams when live categories are unsupported', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_categories')) {
        return Promise.resolve('<html>unsupported</html>');
      }
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 201, name: 'Alpha', category_id: '1', tv_archive: 0 },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve('#EXTM3U');
    });

    const channels = await PlaylistService.refresh();
    expect(channels).toHaveLength(1);
    expect(channels[0].group).toBe(UNCATEGORIZED_GROUP);
  });

  it('pushes the derived xmltv.php EPG URL', async () => {
    await PlaylistService.refresh();
    expect(PlaylistService.epgSources.map((source) => source.url)).toContain(
      'http://host:8080/xmltv.php?username=u1&password=p1',
    );
  });

  it('leaves the cache write of a playlist without catch-up to the worker', async () => {
    await PlaylistService.refresh();
    const scheduled = vi.mocked(cacheMock.scheduleCachedPlaylist).mock.calls[0][0] as Channel[];
    expect(heldRecord(scheduled)).not.toBeNull();
    expect(heldReleaseMock).not.toHaveBeenCalled();
  });

  it('leaves the cache write to the worker once it stamped catch-up', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([{ stream_id: 101, tv_archive: 1, tv_archive_duration: '7' }]));
      }
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      return Promise.resolve(XT);
    });
    const pageCatchup = vi.spyOn(
      PlaylistService as unknown as { applyXtreamCatchup(): Promise<number> },
      'applyXtreamCatchup',
    );

    try {
      await PlaylistService.refresh();
    } finally {
      pageCatchup.mockRestore();
    }

    const scheduled = vi.mocked(cacheMock.scheduleCachedPlaylist).mock.calls[0][0] as Channel[];
    expect(scheduled[0]).toMatchObject({
      catchup: 'xtream',
      catchupStreamId: '101',
      catchupAccountId: 'x',
      catchupTimeZone: 'UTC',
    });
    expect(pageCatchup).not.toHaveBeenCalled();
    expect(heldRecord(scheduled)).not.toBeNull();
    expect(heldReleaseMock).not.toHaveBeenCalled();
  });

  function withWorkerCatchup(
    catchup: Partial<import('../workers/tasks').XtreamCatchupCounts>,
  ): void {
    const base = vi.mocked(fetchAndParseM3U).getMockImplementation()!;
    vi.mocked(fetchAndParseM3U).mockImplementationOnce(async (...args) => {
      const result = await base(...args);
      for (const channel of result.data.channels) {
        delete channel.catchupTimeZone;
        delete channel.catchupTimeOffsetMinutes;
      }
      result.metrics.catchup = { ...result.metrics.catchup!, ...catchup };
      return result;
    });
  }

  function archivedFeed(): void {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([{ stream_id: 101, tv_archive: 1, tv_archive_duration: '7' }]));
      }
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      return Promise.resolve(XT);
    });
  }

  it('adds a late panel clock on the page and writes the cache itself', async () => {
    archivedFeed();
    withWorkerCatchup({ clock: 'late', lateClock: { timeZone: 'Etc/GMT-3', offsetMinutes: 180 } });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await PlaylistService.refresh();
      expect(info.mock.calls.map(args => args.join(' ')).join('\n')).toContain('clock=late');
    } finally {
      info.mockRestore();
    }

    const scheduled = vi.mocked(cacheMock.scheduleCachedPlaylist).mock.calls[0][0] as Channel[];
    expect(scheduled[0]).toMatchObject({ catchupTimeZone: 'Etc/GMT-3', catchupTimeOffsetMinutes: 180 });
    expect(heldRecord(scheduled)).toBeNull();
    expect(heldReleaseMock).toHaveBeenCalledTimes(1);
  });

  it('logs why the panel clock is missing', async () => {
    archivedFeed();
    withWorkerCatchup({ clock: 'missing', clockFailure: 'timeout' });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await PlaylistService.refresh();
      expect(info.mock.calls.map(args => args.join(' ')).join('\n'))
        .toContain('event=xtream.catchup.matched streams=1 archived=1 enabled=1 unmatched=0 clock=missing clockFailure=timeout');
    } finally {
      info.mockRestore();
    }
    expect(heldReleaseMock).not.toHaveBeenCalled();
  });

  it('lets the worker drop its channels once catch-up matching fails', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) return Promise.reject(new Error('down'));
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(XT);
    });
    const catchup = vi.spyOn(
      PlaylistService as unknown as { applyXtreamCatchup(): Promise<number> },
      'applyXtreamCatchup',
    ).mockRejectedValue(new Error('offline'));

    try {
      await PlaylistService.refresh();
    } finally {
      catchup.mockRestore();
    }

    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][7]).toBe(true);
    expect(cacheMock.scheduleCachedPlaylist).not.toHaveBeenCalled();
    expect(heldReleaseMock).toHaveBeenCalledTimes(1);
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
      catchupAccountId: 'x',
      catchupStreamId: '101',
      catchupTimeZone: 'Etc/GMT-2',
      catchupTimeOffsetMinutes: 120,
    });
    expect(channels[0].catchupSources).toBeUndefined();
    expect(channels[1].catchupSource).toBe('');
  });

  it('links query-based and direct-source live URLs to archive stream ids', async () => {
    const nonstandard = `#EXTM3U
#EXTINF:-1,Alpha
http://host/play?stream_id=301
#EXTINF:-1,Bravo
https://host/token/abc?token=new&x=1`;
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 301, tv_archive: 1, tv_archive_duration: 3 },
          {
            stream_id: 302,
            direct_source: 'https://host/token/abc?x=1&token=old',
            tv_archive: 1,
            tv_archive_duration: 4,
          },
        ]));
      }
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      return Promise.resolve(nonstandard);
    });

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.catchupStreamId)).toEqual(['301', '302']);
    expect(channels.map(channel => channel.catchupDays)).toEqual([3, 4]);
    expect(channels.every(channel => channel.catchup === 'xtream')).toBe(true);
  });

  it('drops M3U entries absent from the Live catalog without logging their URLs', async () => {
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 101, tv_archive: 0, tv_archive_duration: 0 },
          { stream_id: 999, tv_archive: 1, tv_archive_duration: 3 },
        ]));
      }
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve(XT);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n')).not.toContain('/live/u1/p1/');
    warn.mockRestore();
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

describe('PlaylistService.refresh (Xtream Live categories)', () => {
  const XT = `#EXTM3U
#EXTINF:-1 group-title="News",Alpha
http://host:8080/live/u1/p1/101.ts
#EXTINF:-1 group-title="Sports",Bravo
http://host:8080/live/u1/p1/102.ts`;
  let liveStreams: Array<Record<string, unknown>>;
  let liveStreamsBody: string | null;
  let categoriesBody: string;

  function account(liveCategories?: { mode: 'include' | 'exclude'; ids: string[] }) {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host:8080', source: 'xtream',
        xtream: { username: 'u1', password: 'p1', ...(liveCategories ? { liveCategories } : {}) } },
    ]);
  }

  function referencesPassed(): string[] | undefined {
    const streams = vi.mocked(fetchAndParseM3U).mock.calls[0][2];
    return streams?.map(stream => stream.streamId);
  }

  beforeEach(() => {
    storageMock.liveCategorySnapshots.clear();
    PlaylistService.takeLiveCategoryNotices();
    liveStreams = [
      { stream_id: 101, category_id: 'c1', tv_archive: 1, tv_archive_duration: 2 },
      { stream_id: 102, category_id: 'c2', tv_archive: 1, tv_archive_duration: 3 },
    ];
    liveStreamsBody = null;
    categoriesBody = JSON.stringify([
      { category_id: 'c1', category_name: '  NEWS ' },
      { category_id: 'c2', category_name: 'Sports' },
    ]);
    account();
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(liveStreamsBody ?? JSON.stringify(liveStreams));
      }
      if (url.includes('action=get_live_categories')) return Promise.resolve(categoriesBody);
      if (url.includes('player_api.php')) {
        return Promise.resolve(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      return Promise.resolve(XT);
    });
  });

  it('loads every Live channel without a filter', async () => {
    const channels = await PlaylistService.refresh();
    expect(channels.map(channel => channel.name)).toEqual(['Alpha', 'Bravo']);
    expect(referencesPassed()).toEqual(['101', '102']);
    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][5]).toBeUndefined();
  });

  it('narrows the Live references to included categories and keeps catch-up', async () => {
    account({ mode: 'include', ids: ['c1'] });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    const channels = await PlaylistService.refresh();

    // The log counts the whole catalog, as page-side matching did.
    expect(info.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=xtream.catchup.matched streams=2 archived=2 enabled=1 unmatched=0 clock=ok');
    info.mockRestore();

    expect(referencesPassed()).toEqual(['101']);
    expect(channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(channels[0]).toMatchObject({
      catchup: 'xtream',
      catchupStreamId: '101',
      catchupDays: 2,
    });
    expect(fetchTextMock.mock.calls.some(([url]) =>
      url.includes('action=get_live_categories'))).toBe(false);
  });

  it('logs catch-up matching when the filter keeps no archived stream', async () => {
    liveStreams[0].tv_archive = 0;
    account({ mode: 'include', ids: ['c1'] });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    const channels = await PlaylistService.refresh();

    expect(channels[0].catchup).toBe('');
    expect(info.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=xtream.catchup.matched streams=2 archived=1 enabled=0');
    info.mockRestore();
  });

  it('drops excluded categories but keeps a stream listed in another category', async () => {
    liveStreams[0].category_ids = ['c1', 'c3'];
    liveStreams.push({ stream_id: 103, category_id: 'c2', tv_archive: 0 });
    account({ mode: 'exclude', ids: ['c2', 'c1'] });

    const channels = await PlaylistService.refresh();

    // 101 sits in c3 too, so it survives excluding c1 and c2.
    expect(referencesPassed()).toEqual(['101']);
    expect(channels.map(channel => channel.name)).toEqual(['Alpha']);
  });

  it('ignores a malformed filter and loads everything', async () => {
    account({ mode: 'include', ids: [] });
    const channels = await PlaylistService.refresh();
    expect(channels.map(channel => channel.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('filters by category name when the Live catalog is unavailable', async () => {
    liveStreamsBody = '<html>nope</html>';
    account({ mode: 'include', ids: ['c1'] });

    const channels = await PlaylistService.refresh();

    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][2]).toBeUndefined();
    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][5])
      .toEqual({ mode: 'include', names: ['news'] });
    expect(channels.map(channel => channel.name)).toEqual(['Alpha']);
  });

  it('loads no channels by name when every included category was removed', async () => {
    liveStreamsBody = '<html>nope</html>';
    account({ mode: 'include', ids: ['c9'] });

    const channels = await PlaylistService.refresh();

    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][5]).toEqual({ mode: 'include', names: [] });
    expect(channels).toEqual([]);
  });

  it('applies an exclude filter by category name when the Live catalog is unavailable', async () => {
    liveStreamsBody = '<html>nope</html>';
    account({ mode: 'exclude', ids: ['c1'] });

    const channels = await PlaylistService.refresh();

    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][5])
      .toEqual({ mode: 'exclude', names: ['news'] });
    expect(channels.map(channel => channel.name)).toEqual(['Bravo']);
  });

  it('loads unfiltered when neither the catalog nor the categories load', async () => {
    liveStreamsBody = '<html>nope</html>';
    categoriesBody = '<html>nope</html>';
    account({ mode: 'include', ids: ['c1'] });

    const channels = await PlaylistService.refresh();

    expect(vi.mocked(fetchAndParseM3U).mock.calls[0][5]).toBeUndefined();
    expect(channels.map(channel => channel.name)).toEqual(['Alpha', 'Bravo']);
    expect(storageMock.setLiveCategorySnapshot).not.toHaveBeenCalled();
  });

  it('announces new categories while filtering by category name', async () => {
    liveStreamsBody = '<html>nope</html>';
    categoriesBody = JSON.stringify([
      { category_id: 'c1', category_name: 'News' },
      { category_id: 'c2', category_name: 'Sports' },
      { category_id: 'c3', category_name: 'Movies' },
    ]);
    account({ mode: 'include', ids: ['c1'] });
    storageMock.liveCategorySnapshots.set('x', {
      knownIds: ['c1', 'c2'],
      announcedIds: [],
      counts: { c1: 1, c2: 1 },
    });

    await PlaylistService.refresh();

    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([
      { playlistId: 'x', accountName: 'Acct', count: 1 },
    ]);
    expect(storageMock.liveCategorySnapshots.get('x')).toEqual({
      knownIds: ['c1', 'c2'],
      announcedIds: ['c3'],
      counts: { c1: 1, c2: 1 },
    });
  });

  it('applies the filter to the Player API fallback playlist', async () => {
    account({ mode: 'include', ids: ['c2'] });
    fetchTextMock.mockImplementation((url: string) => {
      if (url.includes('action=get_live_streams')) {
        return Promise.resolve(JSON.stringify([
          { stream_id: 201, name: 'Alpha', category_id: 'c1', tv_archive: 0 },
          { stream_id: 202, name: 'Bravo', category_id: 'c2', tv_archive: 0 },
        ]));
      }
      if (url.includes('action=get_live_categories')) return Promise.resolve(categoriesBody);
      if (url.includes('player_api.php')) return Promise.resolve('{}');
      return Promise.resolve('#EXTM3U');
    });

    const channels = await PlaylistService.refresh();

    expect(channels.map(channel => channel.name)).toEqual(['Bravo']);
    expect(channels[0].group).toBe('Sports');
  });

  it('seeds a snapshot on first load and announces each new category set once', async () => {
    account({ mode: 'include', ids: ['c1'] });

    await PlaylistService.refresh();
    expect(PlaylistService.hasLiveCategoryNotices()).toBe(false);
    expect(storageMock.liveCategorySnapshots.get('x')).toEqual({
      knownIds: ['c1', 'c2'],
      announcedIds: [],
      counts: { c1: 1, c2: 1 },
    });

    liveStreams.push(
      { stream_id: 103, category_id: 'c3', tv_archive: 0 },
      { stream_id: 104, category_id: 'c4', tv_archive: 0 },
      { stream_id: 105, category_id: 'c4', tv_archive: 0 },
    );
    await PlaylistService.refresh();
    expect(PlaylistService.hasLiveCategoryNotices()).toBe(true);
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([
      { playlistId: 'x', accountName: 'Acct', count: 2 },
    ]);
    expect(PlaylistService.hasLiveCategoryNotices()).toBe(false);
    expect(storageMock.liveCategorySnapshots.get('x')).toMatchObject({
      knownIds: ['c1', 'c2'],
      announcedIds: ['c3', 'c4'],
      counts: { c1: 1, c2: 1, c3: 1, c4: 2 },
    });

    await PlaylistService.refresh();
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([]);
  });

  it('announces only the categories added since the last notice', async () => {
    account({ mode: 'include', ids: ['c1'] });
    storageMock.liveCategorySnapshots.set('x', {
      knownIds: ['c1', 'c2'],
      announcedIds: ['c3'],
      counts: { c1: 1, c2: 1 },
    });
    liveStreams.push(
      { stream_id: 103, category_id: 'c3', tv_archive: 0 },
      { stream_id: 104, category_id: 'c4', tv_archive: 0 },
    );

    await PlaylistService.refresh();

    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([
      { playlistId: 'x', accountName: 'Acct', count: 1 },
    ]);
  });

  it('does not re-announce a category that briefly disappeared', async () => {
    account({ mode: 'include', ids: ['c1'] });
    storageMock.liveCategorySnapshots.set('x', {
      knownIds: ['c1', 'c2'],
      announcedIds: [],
      counts: { c1: 1, c2: 1 },
    });
    liveStreams.push({ stream_id: 103, category_id: 'c3', tv_archive: 0 });
    await PlaylistService.refresh();
    expect(PlaylistService.takeLiveCategoryNotices()).toHaveLength(1);

    liveStreams.pop();
    await PlaylistService.refresh();
    expect(storageMock.liveCategorySnapshots.get('x')).toMatchObject({ announcedIds: ['c3'] });

    liveStreams.push({ stream_id: 103, category_id: 'c3', tv_archive: 0 });
    await PlaylistService.refresh();
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([]);
  });

  it('drops a queued notice once its account is removed, re-filtered, or reviewed', async () => {
    const queue = async () => {
      account({ mode: 'include', ids: ['c1'] });
      storageMock.liveCategorySnapshots.set('x', { knownIds: ['c1', 'c2'], announcedIds: [], counts: {} });
      await PlaylistService.refresh();
    };
    liveStreams.push({ stream_id: 103, category_id: 'c3', tv_archive: 0 });

    await queue();
    storageMock.getPlaylists.mockReturnValue([]);
    expect(PlaylistService.hasLiveCategoryNotices()).toBe(false);
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([]);

    await queue();
    account({ mode: 'exclude', ids: ['c2'] });
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([]);

    await queue();
    storageMock.liveCategorySnapshots.set('x', { knownIds: ['c1', 'c2', 'c3'], announcedIds: [], counts: {} });
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([]);

    await queue();
    expect(PlaylistService.takeLiveCategoryNotices()).toEqual([
      { playlistId: 'x', accountName: 'Acct', count: 1 },
    ]);
  });

  it('never announces new categories in exclude mode', async () => {
    account({ mode: 'exclude', ids: ['c2'] });
    storageMock.liveCategorySnapshots.set('x', {
      knownIds: ['c1', 'c2'],
      announcedIds: [],
      counts: { c1: 1, c2: 1 },
    });
    liveStreams.push({ stream_id: 103, category_id: 'c3', tv_archive: 0 });

    await PlaylistService.refresh();

    expect(PlaylistService.hasLiveCategoryNotices()).toBe(false);
    expect(storageMock.liveCategorySnapshots.get('x')).toMatchObject({
      announcedIds: [],
      counts: { c1: 1, c2: 1, c3: 1 },
    });
  });

  it('does not rewrite an unchanged snapshot', async () => {
    account({ mode: 'include', ids: ['c1'] });
    await PlaylistService.refresh();
    storageMock.setLiveCategorySnapshot.mockClear();

    await PlaylistService.refresh();

    expect(storageMock.setLiveCategorySnapshot).not.toHaveBeenCalled();
  });
});

describe('PlaylistService.load', () => {
  it('uses the cached playlist without hitting the network', async () => {
    const cached = [channel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['P1'] })];
    const epgSources = [{ url: 'http://e', playlistIds: ['P1'], kind: 'm3u' }];
    storageMock.getPlaylists.mockReturnValue([
      { id: 'P1', name: 'P1', url: 'http://host/p1.m3u' },
    ]);
    cacheMock.getCachedPlaylist.mockResolvedValue({ channels: cached, epgSources });
    const result = await PlaylistService.load();
    expect(result).toEqual(cached);
    expect(PlaylistService.allChannels).toBe(cached);
    expect(PlaylistService.groups).toEqual(['News']);
    expect(PlaylistService.epgSources).toEqual(epgSources);
    expect(fetchTextMock).not.toHaveBeenCalled();
  });

  it('boots from an expired cache and exposes its age for the overdue refresh', async () => {
    const intervalMs = 6 * 60 * 60 * 1000;
    const timestamp = Date.now() - 2 * intervalMs;
    const cached = [channel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['P1'] })];
    storageMock.getPlaylists.mockReturnValue([
      { id: 'P1', name: 'P1', url: 'http://host/p1.m3u' },
    ]);
    cacheMock.getCachedPlaylist.mockImplementation(async (maxAgeMs: number | null) =>
      maxAgeMs === null || Date.now() - timestamp < maxAgeMs
        ? { channels: cached, epgSources: [], timestamp }
        : null);

    expect(await PlaylistService.load()).toEqual(cached);
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(PlaylistService.getNextRefreshDelayMs(intervalMs)).toBe(0);
  });

  describe('with a source disabled since a cached channel was stored', () => {
    const cached = () => [
      channel({ id: 'a', name: 'Alpha', url: 'http://stream/a', playlistIds: ['P1'] }),
      channel({ id: 'b', name: 'Bravo', url: 'http://stream/b', playlistIds: ['P1', 'P2'] }),
      channel({ id: 'c', name: 'Charlie', url: 'http://stream/c', playlistIds: ['P2'] }),
    ];

    beforeEach(() => {
      storageMock.getPlaylists.mockReturnValue([
        { id: 'P1', name: 'P1', url: 'http://host/p1.m3u' },
        { id: 'P2', name: 'P2', url: 'http://host/p2.m3u', enabled: false },
      ]);
    });

    it('drops the disabled source from a cache without recorded source ids', async () => {
      cacheMock.getCachedPlaylist.mockResolvedValue({ channels: cached(), epgSources: [] });

      const result = await PlaylistService.load();

      expect(result.map(c => [c.name, c.playlistIds])).toEqual([['Alpha', ['P1']], ['Bravo', ['P1']]]);
    });

    it('drops the disabled source when the cache recorded it', async () => {
      cacheMock.getCachedPlaylist.mockResolvedValue({
        channels: cached(), epgSources: [], sourceIds: ['P1', 'P2'],
      });

      const result = await PlaylistService.load();

      expect(result.map(c => [c.name, c.playlistIds])).toEqual([['Alpha', ['P1']], ['Bravo', ['P1']]]);
    });
  });

  it('takes recorded enabled source ids instead of scanning cached channels', async () => {
    const cached = [channel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['P1'] })];
    storageMock.getPlaylists.mockReturnValue([
      { id: 'P1', name: 'P1', url: 'http://host/p1.m3u' },
    ]);
    const some = vi.spyOn(cached, 'some');
    cacheMock.getCachedPlaylist.mockResolvedValue({ channels: cached, epgSources: [], sourceIds: ['P1'] });

    await PlaylistService.load();

    expect(some).not.toHaveBeenCalled();
    expect(PlaylistService.allChannels).toBe(cached);
  });

  it('refreshes from the network on a cache miss', async () => {
    cacheMock.getCachedPlaylist.mockResolvedValue(null);
    storageMock.getPlaylists.mockReturnValue([{ name: 'P2', url: 'http://host2/p2.m3u' }]);
    fetchTextMock.mockResolvedValue(P2);
    const result = await PlaylistService.load();
    expect(result.map(c => c.name)).toEqual(['Bravo Dup', 'Charlie']);
    expect(fetchTextMock).toHaveBeenCalled();
  });

  it('does not infer cached channel types from their URLs', async () => {
    const cached = [
      channel({
        name: 'Alpha',
        url: 'http://host/movie/u1/p1/201.mp4',
        group: 'Group 1',
        playlistIds: ['x'],
      }),
      channel({
        name: 'Bravo',
        url: 'http://host/SeRiEs/u1/p1/301.mkv',
        group: 'Group 1',
        playlistIds: ['x', 'm'],
      }),
      channel({
        name: 'Charlie',
        url: 'http://host/live/u1/p1/101.ts',
        group: 'Group 1',
        playlistIds: ['x'],
      }),
    ];
    storageMock.getPlaylists.mockReturnValue([
      { id: 'x', name: 'Acct', url: 'http://host', source: 'xtream',
        xtream: { username: 'u1', password: 'p1' } },
      { id: 'm', name: 'M3U', url: 'http://host/list.m3u', source: 'url' },
    ]);
    cacheMock.getCachedPlaylist.mockResolvedValue({ channels: cached, epgSources: [] });

    const result = await PlaylistService.load();

    expect(result.map(channel => channel.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(result[1].playlistIds).toEqual(['x', 'm']);
    expect(fetchTextMock).not.toHaveBeenCalled();
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

  it('shows the first of channels sharing a favorite key, in the filtered playlist', () => {
    const first = channel({ name: 'Alpha', url: 'http://host/a', playlistIds: ['P1'] });
    const second = channel({
      name: 'Bravo', url: 'http://host/a', playlistIds: ['P2'], httpHeaders: { Referer: 'http://host/r' },
    });
    PlaylistService.channels = [first, second];
    storageMock.getFavorites.mockReturnValue([channelKey(first)]);

    expect(PlaylistService.getByGroup('builtin:favorites').map(c => c.name)).toEqual(['Alpha']);
    expect(PlaylistService.getByGroup('builtin:favorites', 'P2').map(c => c.name)).toEqual(['Bravo']);
  });
});

describe('PlaylistService.resolveChannelKey', () => {
  const alpha = channel({ name: 'Alpha', group: 'g1', url: 'http://host/a' });
  const bravo = channel({
    name: 'Bravo', group: 'g2', url: 'http://host/a', httpHeaders: { Referer: 'http://host/r' },
  });
  const charlie = channel({ name: 'Charlie', group: 'g2', url: 'http://host/a', extras: {
    'inputstream.adaptive.license_type': 'com.microsoft.playready',
  } });

  beforeEach(() => {
    PlaylistService.channels = [alpha, bravo, charlie];
  });

  it('picks the first of channels sharing a key without a stream', () => {
    expect(PlaylistService.resolveChannelKey(channelKey(alpha))).toEqual({ channel: alpha, channelIndex: 0 });
  });

  it('prefers the exact stream, then a preferred entry, then the first', () => {
    const key = channelKey(alpha);
    const inG2 = (item: Channel) => item.group === 'g2';
    expect(PlaylistService.resolveChannelKey(key, channelStreamIdentity(charlie))?.channel).toBe(charlie);
    expect(PlaylistService.resolveChannelKey(key, 'gone', inG2)?.channel).toBe(bravo);
    expect(PlaylistService.resolveChannelKey(key, 'gone')?.channel).toBe(alpha);
  });

  it('keeps the exact stream across a rotated token', () => {
    const playing = channel({
      url: 'http://host/c?token=t1', httpHeaders: { 'User-Agent': 'ua1' },
    });
    const plain = channel({ url: 'http://host/c?token=t2' });
    const withAgent = channel({
      url: 'http://host/c?token=t2', httpHeaders: { 'User-Agent': 'ua1' },
    });
    PlaylistService.channels = [plain, withAgent];

    expect(PlaylistService.resolveChannelKey(channelKey(playing), channelStreamIdentity(playing))
      ?.channel).toBe(withAgent);
    expect(PlaylistService.resolveLastChannelIndex({
      index: 0, key: channelKey(playing), stream: channelStreamKey(playing),
    })).toBe(1);
  });

  it('tells apart copies that differ only by a token', () => {
    const copyA = channel({ group: 'g1', url: 'http://host/c?token=A' });
    const copyB = channel({ group: 'g1', url: 'http://host/c?token=B' });
    PlaylistService.channels = [copyA, copyB];
    const inG1 = (item: Channel) => item.group === 'g1';

    expect(PlaylistService.resolveChannelKey(channelKey(copyB), channelStreamIdentity(copyB),
      inG1, channelExactStreamIdentity(copyB))?.channel).toBe(copyB);
    // A rotated token on the playing copy falls back to the stable stream.
    expect(PlaylistService.resolveChannelKey(channelKey(copyB), channelStreamIdentity(copyB),
      inG1, 'gone')?.channel).toBe(copyA);
  });

  it('resolves a legacy key that only channels sharing one key carry', () => {
    const first = channel({ url: 'http://host/b?id=1' });
    const second = channel({ url: 'http://host/b?id=1', httpHeaders: { Referer: 'http://host/r' } });
    PlaylistService.channels = [first, second];
    expect(legacyChannelKey(first)).not.toBe(channelKey(first));

    expect(PlaylistService.resolveChannelKey(legacyChannelKey(first))?.channel).toBe(first);
  });
});

function localSearchResults(query: string, playlist?: string): Channel[] {
  return PlaylistService.searchLocalRanked(
    query,
    PlaylistService.channels.length,
    playlist,
  ).items;
}

describe('PlaylistService.searchLocalRanked', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ name: 'Alpha', group: 'News', playlistIds: ['P1'] }),
      channel({ name: 'Bravo', group: 'Sports', playlistIds: ['P1'] }),
      channel({ name: 'Charlie', group: 'News', playlistIds: ['P2'] }),
    ];
  });

  it('matches channel names case-insensitively, spanning all groups/playlists', () => {
    expect(localSearchResults('A').map(c => c.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(localSearchResults('char').map(c => c.name)).toEqual(['Charlie']);
  });

  it('builds the local fallback index only when search is used', () => {
    const internals = PlaylistService as unknown as {
      channelSearchIndex: unknown[];
    };
    PlaylistService.getByGroup('builtin:all');
    expect(internals.channelSearchIndex).toHaveLength(0);

    localSearchResults('alpha');
    expect(internals.channelSearchIndex).toHaveLength(3);
  });

  it('scopes results to a single playlist when one is given', () => {
    expect(localSearchResults('a', 'P1').map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(localSearchResults('a', 'P2').map(c => c.name)).toEqual(['Charlie']);
  });

  it('returns no results for an empty or whitespace query', () => {
    expect(localSearchResults('')).toEqual([]);
    expect(localSearchResults('   ')).toEqual([]);
  });

  it('matches channel genres through natural-language-lite synonyms', () => {
    expect(localSearchResults('footy').map(c => c.name)).toEqual(['Bravo']);
    expect(localSearchResults('headlines').map(c => c.name)).toEqual(['Alpha', 'Charlie']);
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

describe('PlaylistService.searchLocalRanked', () => {
  beforeEach(() => {
    PlaylistService.channels = [
      channel({ id: '1', name: 'Alpha', playlistIds: ['a'] }),
      channel({ id: '2', name: 'XAlpha', playlistIds: ['a'] }),
      channel({ id: '3', name: 'Alpha HD', playlistIds: ['b'] }),
    ];
  });

  it('returns [] for a blank query', () => {
    expect(localSearchResults('  ')).toEqual([]);
  });

  it('ranks exact and prefix matches above a mid-word match', () => {
    expect(localSearchResults('alpha').map(c => c.name)).toEqual(['Alpha', 'Alpha HD', 'XAlpha']);
  });

  it('scopes to a single playlist when given', () => {
    expect(localSearchResults('alpha', 'b').map(c => c.name)).toEqual(['Alpha HD']);
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
    expect(cacheMock.scheduleCachedPlaylist).toHaveBeenCalledWith(
      PlaylistService.allChannels,
      PlaylistService.epgSources,
      expect.any(Number),
      6 * 60 * 60 * 1000,
      { signature: 's1', generation: 0 },
      ['a'],
    );
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

    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key: savedKey })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key: 'missing' })).toBe(-1);
    expect(PlaylistService.resolveLastChannelIndex({ index: 1 })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex(null)).toBe(0);
  });

  it('resolves query-distinguished streams precisely for autoplay', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1' }),
      channel({ url: 'http://host/stream?id=2' }),
    ];

    const second = channelKey(PlaylistService.channels[1]);
    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key: second })).toBe(1);
  });

  it('uses a stable query identity after a stream token rotates', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1&token=B' }),
      channel({ url: 'http://host/stream?id=2&token=B' }),
    ];
    const old = channel({ url: 'http://host/stream?id=2&token=A' });

    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key: channelKey(old) })).toBe(1);
  });

  it('resumes the saved stream among channels sharing its key, else the first', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream' }),
      channel({ url: 'http://host/stream', httpHeaders: { Referer: 'http://host/r' } }),
    ];
    const [first, second] = PlaylistService.channels;
    const key = channelKey(second);

    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key, stream: channelStreamKey(second) })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex({ index: 0, key, stream: channelStreamKey(first) })).toBe(0);
    expect(PlaylistService.resolveLastChannelIndex({ index: 1, key })).toBe(0);
    expect(PlaylistService.resolveLastChannelIndex({ index: 1, key, stream: 'gone' })).toBe(0);
  });

  it('resumes the saved copy among copies that differ only by a token', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?token=A' }),
      channel({ url: 'http://host/stream?token=B' }),
    ];
    const [copyA, copyB] = PlaylistService.channels;
    const key = channelKey(copyB);
    const stream = channelStreamKey(copyB);

    expect(PlaylistService.resolveLastChannelIndex({
      index: 0, key, stream, exact: channelExactStreamKey(copyB),
    })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex({
      index: 1, key, stream, exact: channelExactStreamKey(copyA),
    })).toBe(0);
    // Every token rotated: the saved index still picks the copy.
    expect(PlaylistService.resolveLastChannelIndex({ index: 1, key, stream, exact: 'gone' })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex({ index: 1, key, stream })).toBe(1);
    expect(PlaylistService.resolveLastChannelIndex({ index: 5, key, stream, exact: 'gone' })).toBe(0);
  });

  it('does not use an ambiguous legacy autoplay key', () => {
    PlaylistService.channels = [
      channel({ url: 'http://host/stream?id=1' }),
      channel({ url: 'http://host/stream?id=2' }),
    ];

    expect(PlaylistService.resolveLastChannelIndex({
      index: 0, key: legacyChannelKey(PlaylistService.channels[1]),
    })).toBe(-1);
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

  it('keeps the EPG channel set stable while hidden channels are revealed', async () => {
    useRecord(record({ overrides: { [KEY_B]: { hidden: true } } }));
    await PlaylistService.refresh();
    expect(PlaylistService.getEpgEligibleChannels().map(c => c.name)).toEqual(['Alpha']);

    // A widened selection would force an EPG refetch, so neither toggle may
    // widen it: both only reveal hidden channels for editing.
    PlaylistService.setIncludeHidden(true);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.getEpgEligibleChannels().map(c => c.name)).toEqual(['Alpha']);
    PlaylistService.setIncludeHidden(false);

    storageMock.getShowHiddenChannels.mockReturnValue(true);
    try {
      PlaylistService.applyCustomization();
      expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
      expect(PlaylistService.getEpgEligibleChannels().map(c => c.name)).toEqual(['Alpha']);
    } finally {
      storageMock.getShowHiddenChannels.mockReturnValue(false);
      PlaylistService.applyCustomization();
    }
  });

  it('drops concealed channels from every list but keeps them in the EPG set', async () => {
    useRecord(record({}));
    await PlaylistService.refresh();
    const concealing = vi.spyOn(ParentalControlService, 'concealing', 'get')
      .mockReturnValue(true);
    const concealed = vi.spyOn(ParentalControlService, 'isConcealed')
      .mockImplementation(request => request.target.kind === 'live-channel'
        && request.target.channelKey === KEY_B);
    try {
      PlaylistService.applyCustomization();
      expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha']);
      expect(PlaylistService.indexOfKey(KEY_B)).toBe(-1);
      expect(PlaylistService.getEpgEligibleChannels().map(c => c.name))
        .toEqual(['Alpha', 'Bravo']);
    } finally {
      concealing.mockRestore();
      concealed.mockRestore();
      PlaylistService.applyCustomization();
    }
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('maps visible channels to their playlist-cache record', async () => {
    useRecord(record({ order: [KEY_B, KEY_A] }));
    await PlaylistService.refresh();
    expect(PlaylistService.getChannelCacheSource()).toBeNull();

    const ref = { store: 'playlist-cache', key: 'k', timestamp: 1 };
    cacheMock.cacheRecordRef.mockImplementation(value =>
      value === PlaylistService.allChannels ? ref : null);
    const concealing = vi.spyOn(ParentalControlService, 'concealing', 'get')
      .mockReturnValue(true);
    const concealed = vi.spyOn(ParentalControlService, 'isConcealed')
      .mockImplementation(request => request.target.kind === 'live-channel'
        && request.target.channelKey === KEY_A);
    try {
      PlaylistService.applyCustomization();
      expect(PlaylistService.getChannelCacheSource()).toEqual({
        record: ref,
        length: 2,
        selection: new Uint32Array([1]),
      });
      concealing.mockReturnValue(false);
      PlaylistService.applyCustomization();
      expect(PlaylistService.getChannelCacheSource()?.selection)
        .toEqual(new Uint32Array([1, 0]));
    } finally {
      concealing.mockRestore();
      concealed.mockRestore();
      cacheMock.cacheRecordRef.mockReset();
      cacheMock.cacheRecordRef.mockReturnValue(null);
      PlaylistService.applyCustomization();
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
    cacheMock.getCachedPlaylist.mockResolvedValue({ channels: cached, epgSources: [] });
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

describe('PlaylistService progressive load', () => {
  const BIG = ['#EXTM3U'];
  const GROUPS = ['News', 'Sports', '', 'Kids'];
  for (let i = 0; i < 11; i++) {
    const group = GROUPS[i % GROUPS.length];
    BIG.push(`#EXTINF:-1 tvg-id="ch${String(i)}"${group ? ` group-title="${group}"` : ''},ch${String(i)}`);
    BIG.push(`http://stream/s${String(i)}`);
  }
  const keyOf = (i: number) => channelKey({ url: `http://stream/s${String(i)}` } as Channel);

  // Like the real loader: the parsed channels arrive in batches, tail included.
  function streamInBatches(size: number): void {
    const base = vi.mocked(fetchAndParseM3U).getMockImplementation()!;
    vi.mocked(fetchAndParseM3U).mockImplementation(async (...args) => {
      const result = await base(...args);
      const onChannels = args[9];
      const all = result.data.channels;
      for (let i = 0; onChannels && i < all.length; i += size) onChannels(all.slice(i, i + size));
      return result;
    });
  }

  function useRecord(over: Partial<ChannelCustomization>): void {
    storageMock.getChannelCustomization.mockReturnValue({
      version: CONFIG.CHANNEL_CUSTOMIZATION_VERSION,
      overrides: {}, order: [], groupOrder: [], groupOverrides: {}, customGroups: [], ...over,
    });
    ChannelCustomizationService.reload();
  }

  function snapshot() {
    const names = (list: Channel[]) => list.map(c => c.name);
    const groups = PlaylistService.getGroupsForPlaylist();
    return {
      all: names(PlaylistService.allChannels),
      channels: names(PlaylistService.channels),
      unconcealed: names(PlaylistService.getUnconcealedChannels()),
      groups,
      byGroup: groups.map(g => names(PlaylistService.getByGroup(`source:${g}`))),
      byPlaylist: names(PlaylistService.getByGroup('builtin:all', 'p1')),
      indexes: PlaylistService.channels.map(c => PlaylistService.indexOf(c)),
      keys: [0, 1, 2, 3].map(i => PlaylistService.indexOfKey(keyOf(i))),
      sources: Array.from((PlaylistService as unknown as {
        channelSourceIndices: Uint32Array;
      }).channelSourceIndices),
      search: names(PlaylistService.searchLocalRanked('ch1', 10).items),
    };
  }

  const loadInBatches = async (seen: Array<{ loading: boolean; count: number }> = []) => {
    streamInBatches(3);
    await PlaylistService.refresh(undefined, {
      onChannels: () => seen.push({
        loading: PlaylistService.loading,
        count: PlaylistService.channels.length,
      }),
    });
    return seen;
  };

  beforeEach(() => {
    storageMock.getPlaylists.mockReturnValue([{ id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' }]);
    fetchTextMock.mockResolvedValue(BIG.join('\n'));
    useRecord({});
  });

  afterEach(() => {
    vi.mocked(fetchAndParseM3U).mockRestore?.();
    storageMock.getChannelCustomization.mockReturnValue(null);
    ChannelCustomizationService.reload();
    vi.restoreAllMocks();
  });

  it('lists every source tab from the first batch', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host1/p2.m3u' },
    ]);
    PlaylistService.reset();
    const tabs: string[][] = [];
    streamInBatches(3);
    await PlaylistService.refresh(undefined, {
      onChannels: () => tabs.push(PlaylistService.playlistTabs.map(tab => tab.id)),
    });
    expect(tabs[0]).toEqual(['p1', 'p2']);
  });

  it('shows the channels batch by batch, then matches a whole load', async () => {
    useRecord({
      overrides: { [keyOf(1)]: { hidden: true }, [keyOf(4)]: { name: 'renamed', group: 'custom:mine' } },
      customGroups: ['custom:mine'],
    });
    const concealing = vi.spyOn(ParentalControlService, 'concealing', 'get').mockReturnValue(true);
    vi.spyOn(ParentalControlService, 'isConcealed').mockImplementation(request =>
      request.target.kind === 'live-channel' && request.target.channelKey === keyOf(5));
    await PlaylistService.refresh();
    const whole = snapshot();

    const seen = await loadInBatches();
    // The list being replaced empties before the first batch.
    expect(seen.map(s => s.loading)).toEqual([true, true, true, true, true]);
    expect(seen.map(s => s.count)).toEqual([0, 2, 4, 7, 9]);
    expect(PlaylistService.loading).toBe(false);
    expect(snapshot()).toEqual(whole);
    concealing.mockReturnValue(false);
  });

  it('adopts the arrived channels under new list identities', async () => {
    let during: Channel[] | null = null;
    const apply = vi.spyOn(PlaylistService, 'applyCustomization');
    streamInBatches(4);
    await PlaylistService.refresh(undefined, {
      onChannels: () => { during = PlaylistService.channels; },
    });
    expect(apply).not.toHaveBeenCalled();
    expect(PlaylistService.channels).toHaveLength(11);
    expect(PlaylistService.channels).not.toBe(during);
    expect(PlaylistService.channels).toEqual(during);
  });

  it('applies a custom channel order once the whole list is in', async () => {
    useRecord({ order: [keyOf(10), keyOf(2)] });
    const seen: string[][] = [];
    streamInBatches(4);
    await PlaylistService.refresh(undefined, {
      onChannels: () => seen.push(PlaylistService.channels.map(c => c.name)),
    });
    expect(seen[1]).toEqual(['ch0', 'ch1', 'ch2', 'ch3']);
    expect(PlaylistService.channels.slice(0, 3).map(c => c.name)).toEqual(['ch10', 'ch2', 'ch0']);
  });

  it('merges a second playlist in a whole pass at the end', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    fetchTextMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('p1') ? BIG.join('\n') : P2));
    await PlaylistService.refresh();
    const whole = snapshot();
    const seen = await loadInBatches();
    expect(seen.at(-1)!.count).toBe(11);
    expect(snapshot()).toEqual(whole);
  });

  it('lists the channels under a second playlist that only repeats the first', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p1-copy.m3u' },
    ]);
    await PlaylistService.refresh();
    const whole = PlaylistService.getByGroup('builtin:all', 'p2').map(c => c.name);
    const groups = PlaylistService.getGroupsForPlaylist('p2');
    expect(whole).toHaveLength(11);
    expect(groups).toHaveLength(4);
    await loadInBatches();
    expect(PlaylistService.getByGroup('builtin:all', 'p2').map(c => c.name)).toEqual(whole);
    expect(PlaylistService.getGroupsForPlaylist('p2')).toEqual(groups);
  });

  it('drops a failed source\'s arrived channels before the next source streams in', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    fetchTextMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('p1') ? BIG.join('\n') : P2));
    const base = vi.mocked(fetchAndParseM3U).getMockImplementation()!;
    vi.mocked(fetchAndParseM3U).mockImplementation(async (...args) => {
      const result = await base(...args);
      const onChannels = args[9];
      if (args[0].includes('p1')) {
        onChannels?.(result.data.channels.slice(0, 3));
        throw new Error('connection reset');
      }
      onChannels?.(result.data.channels);
      return result;
    });
    const seen: string[][] = [];
    await PlaylistService.refresh(undefined, {
      onChannels: () => seen.push(PlaylistService.channels.map(c => c.name)),
    });
    expect(seen.at(-1)).toEqual(['Bravo Dup', 'Charlie']);
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Bravo Dup', 'Charlie']);
  });

  function holdFirstFetch(): { started: () => boolean; release: () => void } {
    let releaseFirst: ((text: string) => void) | null = null;
    fetchTextMock.mockImplementationOnce(() => new Promise<string>(resolve => (releaseFirst = resolve)));
    return { started: () => releaseFirst !== null, release: () => releaseFirst!(BIG.join('\n')) };
  }

  it('keeps a load cleared by reset() from bringing its channels back', async () => {
    streamInBatches(4);
    const held = holdFirstFetch();
    const first = PlaylistService.refresh(undefined, { onChannels: () => {} });
    await vi.waitFor(() => expect(held.started()).toBe(true));
    PlaylistService.reset();
    held.release();
    await first;
    expect(PlaylistService.channels).toEqual([]);
    expect(PlaylistService.allChannels).toEqual([]);
  });

  it('keeps a load a cache hit replaced from adding to the cached list', async () => {
    streamInBatches(4);
    const held = holdFirstFetch();
    const first = PlaylistService.refresh(undefined, { onChannels: () => {} });
    await vi.waitFor(() => expect(held.started()).toBe(true));
    const cached = [channel({ id: 'a', name: 'Alpha', url: 'http://stream/a', playlistIds: ['p1'] })];
    cacheMock.getCachedPlaylist.mockResolvedValueOnce({ channels: cached, epgSources: [], timestamp: Date.now() });
    await PlaylistService.load();
    held.release();
    await first;
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha']);
    expect(cached).toHaveLength(1);
  });

  it('is complete only once a load has the whole list', async () => {
    PlaylistService.reset();
    expect(PlaylistService.complete).toBe(true);
    streamInBatches(3);
    const seen: boolean[] = [];
    const loading = PlaylistService.load(undefined, {
      onChannels: () => seen.push(PlaylistService.complete),
    });
    expect(PlaylistService.complete).toBe(false);
    await loading;
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).not.toContain(true);
    expect(PlaylistService.complete).toBe(true);
  });

  it('is complete once the latest load is, while a load it replaced still waits', async () => {
    streamInBatches(4);
    const held = holdFirstFetch();
    const first = PlaylistService.load(undefined, { onChannels: () => {} });
    await vi.waitFor(() => expect(held.started()).toBe(true));
    await PlaylistService.load(undefined, { onChannels: () => {} });
    expect(PlaylistService.complete).toBe(true);
    held.release();
    await first;
    expect(PlaylistService.complete).toBe(true);
  });

  it('stops a load a newer one replaced before its next source', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    streamInBatches(4);
    const held = holdFirstFetch();
    const first = PlaylistService.load(undefined, { onChannels: () => {} });
    await vi.waitFor(() => expect(held.started()).toBe(true));
    await PlaylistService.load(undefined, { onChannels: () => {} });
    const fetches = fetchTextMock.mock.calls.length;
    held.release();
    await first;
    expect(fetchTextMock.mock.calls.length).toBe(fetches);
  });

  it('ends the progressive load when a source throws outside its own recovery', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    streamInBatches(4);
    const log = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args.includes('event=playlist.source.load.started') && args.includes('load=2')) {
        throw new Error('boom');
      }
      log(...args);
    });
    await expect(PlaylistService.refresh(undefined, { onChannels: () => {} })).rejects.toThrow('boom');
    expect(PlaylistService.loading).toBe(false);
  });

  it('is not complete after a reload that failed partway through its sources', async () => {
    storageMock.getPlaylists.mockReturnValue([
      { id: 'p1', name: 'P1', url: 'http://host1/p1.m3u' },
      { id: 'p2', name: 'P2', url: 'http://host2/p2.m3u' },
    ]);
    streamInBatches(4);
    await PlaylistService.load(undefined, { onChannels: () => {} });
    expect(PlaylistService.complete).toBe(true);
    const log = console.log;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args.includes('event=playlist.source.load.started') && args.includes('load=2')) {
        throw new Error('boom');
      }
      log(...args);
    });
    await expect(PlaylistService.load(undefined, { onChannels: () => {} })).rejects.toThrow('boom');
    expect(PlaylistService.channels.length).toBeGreaterThan(0);
    expect(PlaylistService.complete).toBe(false);
    vi.mocked(console.log).mockImplementation(log);
    await PlaylistService.load(undefined, { onChannels: () => {} });
    expect(PlaylistService.complete).toBe(true);
  });

  it('drops the result of a load a newer one replaced', async () => {
    streamInBatches(4);
    let releaseFirst!: (text: string) => void;
    fetchTextMock.mockImplementationOnce(() => new Promise<string>(resolve => (releaseFirst = resolve)));
    const first = PlaylistService.refresh(undefined, { onChannels: () => {} });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    fetchTextMock.mockResolvedValue(P1);
    await PlaylistService.refresh(undefined, { onChannels: () => {} });
    releaseFirst(BIG.join('\n'));
    await first;
    expect(PlaylistService.channels.map(c => c.name)).toEqual(['Alpha', 'Bravo']);
    expect(PlaylistService.loading).toBe(false);
  });
});
