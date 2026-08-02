import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatchupProgressEntry, Channel, RecentlyWatchedLiveEntry } from '../types';

const { data, archiveMock, storageMock, epgMock, playlistMock } = vi.hoisted(() => {
  const channels: Channel[] = [];
  const live: RecentlyWatchedLiveEntry[] = [];
  const catchup: CatchupProgressEntry[] = [];
  const data = { channels, live, catchup, available: true };
  return {
    data,
    archiveMock: {
      load: vi.fn(async () => null),
      isAvailable: vi.fn(() => data.available),
    },
    storageMock: {
      getRecentlyWatchedLive: vi.fn(() => data.live),
      getAllCatchupProgress: vi.fn(() => data.catchup),
      clearCatchupProgress: vi.fn(),
    },
    epgMock: {
      programmes: {} as Record<string, Array<{
        start: Date;
        stop: Date;
        title: string;
        description: string;
        category: string;
        icon: string;
      }>>,
      findChannelId: vi.fn((): string | null => null),
    },
    playlistMock: {
      channels: data.channels,
      resolveChannelKey: vi.fn((key: string) => {
        const exact = data.channels.find(ch => channelKey(ch) === key);
        if (exact) return { channel: exact, channelIndex: data.channels.indexOf(exact) };
        const legacy = data.channels.filter(ch => legacyChannelKey(ch) === key);
        return legacy.length === 1
          ? { channel: legacy[0], channelIndex: data.channels.indexOf(legacy[0]) }
          : null;
      }),
    },
  };
});

vi.mock('./playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('./storage-service', () => ({ StorageService: storageMock }));
vi.mock('./epg-service', () => ({ EpgService: epgMock }));
vi.mock('./xtream-archive', () => ({ XtreamArchiveService: archiveMock }));

import { RecentlyWatchedService } from './recently-watched';
import { channelKey, legacyChannelKey } from '../utils/channel';

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'ch1',
  name: 'Channel Alpha',
  logo: '',
  group: 'Group 1',
  url: 'http://host/a',
  extras: null,
  playlistIds: ['p1'],
  catchup: 'default',
  catchupSource: 'http://host/catchup/{utc}',
  catchupDays: 7,
  ...over,
});

const progress = (ch: Channel, over: Partial<CatchupProgressEntry> = {}): CatchupProgressEntry => ({
  channelKey: channelKey(ch),
  progStart: 1_000_000,
  progEnd: 4_600_000,
  title: 'Program Alpha',
  description: 'Summary',
  icon: '',
  position: 600,
  duration: 3600,
  updatedAt: 2000,
  completed: false,
  ...over,
});

beforeEach(() => {
  data.channels.length = 0;
  data.live.length = 0;
  data.catchup.length = 0;
  data.available = true;
  epgMock.programmes = {};
  epgMock.findChannelId.mockReset().mockReturnValue(null);
  archiveMock.load.mockClear();
  archiveMock.isAvailable.mockClear();
  playlistMock.resolveChannelKey.mockClear();
  storageMock.clearCatchupProgress.mockClear();
});

describe('RecentlyWatchedService.getItems', () => {
  it('merges live and Catch-up entries by recency', () => {
    const ch1 = channel();
    const ch2 = channel({ id: 'ch2', name: 'Channel Bravo', url: 'http://host/b' });
    data.channels.push(ch1, ch2);
    data.live.push({ channelKey: channelKey(ch1), updatedAt: 3000 });
    data.catchup.push(progress(ch2, { updatedAt: 4000 }));

    const items = RecentlyWatchedService.getItems();

    expect(items.map(item => item.kind)).toEqual(['catchup', 'live']);
    expect(items.map(item => item.channelIndex)).toEqual([1, 0]);
    expect(playlistMock.resolveChannelKey).toHaveBeenCalledTimes(2);
  });

  it('resolves an unambiguous legacy channel key', () => {
    const ch = channel({ url: 'http://host/a?id=1' });
    data.channels.push(ch);
    data.live.push({ channelKey: legacyChannelKey(ch), updatedAt: 3000 });

    expect(RecentlyWatchedService.getItems()[0]?.channel).toBe(ch);
  });

  it('does not guess an ambiguous legacy channel key', () => {
    const first = channel({ url: 'http://host/a?id=1' });
    const second = channel({ id: 'ch2', url: 'http://host/a?id=2' });
    data.channels.push(first, second);
    data.live.push({ channelKey: legacyChannelKey(first), updatedAt: 3000 });

    expect(RecentlyWatchedService.getItems()).toEqual([]);
  });

  it('deduplicates legacy and current live entries after the channel is watched again', () => {
    const ch = channel({ url: 'http://host/a?id=1' });
    data.channels.push(ch);
    data.live.push(
      { channelKey: legacyChannelKey(ch), updatedAt: 2000 },
      { channelKey: channelKey(ch), updatedAt: 3000 },
    );

    const items = RecentlyWatchedService.getItems();

    expect(items).toHaveLength(1);
    expect(items[0].updatedAt).toBe(3000);
  });

  it('filters both item types by playlist membership without changing order', () => {
    const ch1 = channel({ playlistIds: ['p1'] });
    const ch2 = channel({ id: 'ch2', url: 'http://host/b', playlistIds: ['p2'] });
    data.channels.push(ch1, ch2);
    data.live.push(
      { channelKey: channelKey(ch2), updatedAt: 4000 },
      { channelKey: channelKey(ch1), updatedAt: 3000 },
    );
    data.catchup.push(progress(ch1, { updatedAt: 2000 }));

    const items = RecentlyWatchedService.getItems('p1');

    expect(items.map(item => item.updatedAt)).toEqual([3000, 2000]);
    expect(items.every(item => item.channel === ch1)).toBe(true);
  });

  it('omits completed, below-threshold, unresolved, and unavailable Catch-up entries', () => {
    const ch = channel();
    data.channels.push(ch);
    data.catchup.push(
      progress(ch, { progStart: 1, completed: true }),
      progress(ch, { progStart: 2, position: 5 }),
      progress(channel({ url: 'http://host/missing' }), { progStart: 3 }),
      progress(ch, { progStart: 4 }),
    );
    data.available = false;

    expect(RecentlyWatchedService.getItems()).toEqual([]);
    expect(storageMock.clearCatchupProgress).toHaveBeenCalledWith(channelKey(ch), 4);
  });

  it('resolves a legacy Catch-up title from the current EPG', () => {
    const ch = channel();
    data.channels.push(ch);
    data.catchup.push(progress(ch, {
      title: undefined,
      description: undefined,
      icon: undefined,
    }));
    epgMock.findChannelId.mockReturnValue('epg1');
    epgMock.programmes.epg1 = [{
      start: new Date(1_000_000),
      stop: new Date(4_600_000),
      title: 'Program Bravo',
      description: 'Legacy summary',
      category: '',
      icon: 'http://host/icon',
    }];

    const item = RecentlyWatchedService.getItems()[0];

    expect(item.kind).toBe('catchup');
    if (item.kind === 'catchup') {
      expect(item.progress).toMatchObject({
        title: 'Program Bravo',
        description: 'Legacy summary',
        icon: 'http://host/icon',
      });
    }
  });

  it('limits the visible merged list', () => {
    for (let i = 0; i < 55; i++) {
      const ch = channel({ id: `ch${String(i)}`, url: `http://host/${String(i)}` });
      data.channels.push(ch);
      data.live.push({ channelKey: channelKey(ch), updatedAt: i });
    }
    const items = RecentlyWatchedService.getItems();
    expect(items).toHaveLength(50);
    expect(items[0].updatedAt).toBe(54);
  });
});

describe('RecentlyWatchedService.catchupInfo', () => {
  it('loads availability and reconstructs resumable Catch-up metadata', async () => {
    const ch = channel();
    const item = {
      kind: 'catchup' as const,
      channel: ch,
      channelIndex: 0,
      progress: progress(ch),
      updatedAt: 2000,
    };

    await expect(RecentlyWatchedService.catchupInfo(item)).resolves.toEqual({
      start: 1000,
      end: 4600,
      title: 'Program Alpha',
      description: 'Summary',
      icon: '',
      resumeSecs: 600,
    });
    expect(archiveMock.load).toHaveBeenCalledWith(ch);
  });

  it('removes an entry when archive metadata explicitly makes it unavailable', async () => {
    const ch = channel();
    const item = {
      kind: 'catchup' as const,
      channel: ch,
      channelIndex: 0,
      progress: progress(ch),
      updatedAt: 2000,
    };
    archiveMock.load.mockImplementationOnce(async () => {
      data.available = false;
      return null;
    });

    await expect(RecentlyWatchedService.catchupInfo(item)).resolves.toBeNull();
    expect(storageMock.clearCatchupProgress)
      .toHaveBeenCalledWith(item.progress.channelKey, item.progress.progStart);
  });
});
