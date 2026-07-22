import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const { getPlaylists, getArchiveListings } = vi.hoisted(() => ({
  getPlaylists: vi.fn(),
  getArchiveListings: vi.fn(),
}));

vi.mock('./storage-service', () => ({
  StorageService: { getPlaylists },
}));
vi.mock('./xtream-client', () => ({
  createXtreamClient: () => ({ getArchiveListings }),
}));

import { XtreamArchiveService } from './xtream-archive';

const START = 1709978400;
const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'ch1',
  name: 'Channel 1',
  logo: '',
  group: 'News',
  url: 'http://host/live/u1/p1/101.ts',
  extras: null,
  playlistIds: ['x1'],
  catchup: 'xtream',
  catchupSource: 'http://host/timeshift/{start}',
  catchupDays: 7,
  catchupAccountId: 'x1',
  catchupStreamId: '101',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  XtreamArchiveService.clear();
  getPlaylists.mockReturnValue([{
    id: 'x1',
    name: 'Account 1',
    url: 'http://host',
    source: 'xtream',
    xtream: { username: 'u1', password: 'p1' },
  }]);
});

describe('XtreamArchiveService', () => {
  it('uses explicit has_archive flags as authoritative availability', async () => {
    getArchiveListings.mockResolvedValue([
      { start: START, stop: START + 3600, hasArchive: true },
      { start: START + 3600, stop: START + 7200, hasArchive: false },
    ]);
    const ch = channel();
    await XtreamArchiveService.load(ch);
    expect(XtreamArchiveService.isAvailable(ch, START * 1000, START * 1000 + 1000)).toBe(true);
    expect(XtreamArchiveService.isAvailable(ch, (START + 3600) * 1000, START * 1000 + 1000)).toBe(false);
  });

  it('matches small timestamp differences between XMLTV and Xtream EPG', async () => {
    getArchiveListings.mockResolvedValue([
      { start: START + 30, stop: START + 3630, hasArchive: true },
    ]);
    const ch = channel();
    await XtreamArchiveService.load(ch);
    expect(XtreamArchiveService.isAvailable(ch, START * 1000, START * 1000 + 1000)).toBe(true);
  });

  it('falls back to channel-level catch-up when the endpoint fails or omits flags', async () => {
    const failed = channel();
    getArchiveListings.mockResolvedValueOnce(null);
    await XtreamArchiveService.load(failed);
    expect(XtreamArchiveService.isAvailable(failed, START * 1000, START * 1000 + 1000)).toBe(true);

    XtreamArchiveService.clear();
    getArchiveListings.mockResolvedValueOnce([
      { start: START, stop: START + 3600, hasArchive: null },
    ]);
    await XtreamArchiveService.load(failed);
    expect(XtreamArchiveService.isAvailable(failed, START * 1000, START * 1000 + 1000)).toBe(true);
  });

  it('falls back to channel-level catch-up for an empty or windowed response', async () => {
    getArchiveListings.mockResolvedValue([]);
    const ch = channel();
    await XtreamArchiveService.load(ch);
    expect(XtreamArchiveService.isAvailable(ch, START * 1000, START * 1000 + 1000)).toBe(true);
  });

  it('allows an XMLTV program absent from a partial Xtream listing response', async () => {
    getArchiveListings.mockResolvedValue([
      { start: START, stop: START + 3600, hasArchive: true },
    ]);
    const ch = channel();
    await XtreamArchiveService.load(ch);
    expect(XtreamArchiveService.isAvailable(
      ch,
      (START + 7200) * 1000,
      START * 1000 + 1000,
    )).toBe(true);
  });

  it('deduplicates concurrent requests and caches the result', async () => {
    getArchiveListings.mockResolvedValue([
      { start: START, stop: START + 3600, hasArchive: true },
    ]);
    const ch = channel();
    await Promise.all([
      XtreamArchiveService.load(ch),
      XtreamArchiveService.load(ch),
    ]);
    await XtreamArchiveService.load(ch);
    expect(getArchiveListings).toHaveBeenCalledTimes(1);
  });

  it('keeps generic M3U catch-up independent of the Xtream endpoint', () => {
    const ch = channel({ catchup: 'default', catchupAccountId: undefined, catchupStreamId: undefined });
    expect(XtreamArchiveService.isAvailable(ch, START * 1000, START * 1000 + 1000)).toBe(true);
  });

  it('rejects programs older than the advertised retention window', () => {
    const now = START * 1000 + 8 * 86400000;
    expect(XtreamArchiveService.isAvailable(channel(), START * 1000, now)).toBe(false);
  });
});
