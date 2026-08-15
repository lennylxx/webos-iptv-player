import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const { stored, cacheMock } = vi.hoisted(() => {
  const stored: Record<string, unknown> = {};
  return {
    stored,
    cacheMock: {
      getCachedChannelHealth: vi.fn(async () => ({ ...stored })),
      setCachedChannelHealth: vi.fn(async (records: Record<string, unknown>) => {
        Object.assign(stored, records);
      }),
      clearCachedChannelHealth: vi.fn(async () => {
        for (const key of Object.keys(stored)) delete stored[key];
      }),
    },
  };
});

vi.mock('./idb-cache', () => cacheMock);

import { ChannelHealthService } from './channel-health';

function channel(url: string): Channel {
  return {
    id: url,
    name: 'Alpha',
    logo: '',
    group: '',
    url,
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

beforeEach(async () => {
  for (const key of Object.keys(stored)) delete stored[key];
  await ChannelHealthService.clear();
  cacheMock.setCachedChannelHealth.mockClear();
  vi.restoreAllMocks();
});

describe('ChannelHealthService', () => {
  it('marks a stream healthy after receiving media bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), {
        status: 200,
        headers: { 'content-type': 'video/mp2t' },
      })));
    const item = channel('http://host/a');

    await ChannelHealthService.checkAll([item]);

    expect(ChannelHealthService.getRecord(item)).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
    });
    expect(cacheMock.setCachedChannelHealth).toHaveBeenCalledOnce();
  });

  it('follows an HLS manifest to its first media segment', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n',
        { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
      ))
      .mockResolvedValueOnce(new Response(
        new Uint8Array([0x47, 0x40, 0x00, 0x10]),
        { status: 206, headers: { 'content-type': 'video/mp2t' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    await ChannelHealthService.checkAll([channel('http://host/live/index.m3u8')]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://host/live/seg.ts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('requires two consecutive failures before marking a stream unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const item = channel('http://host/a');

    await ChannelHealthService.checkAll([item]);
    expect(ChannelHealthService.getRecord(item)?.status).toBe('suspect');
    await ChannelHealthService.checkAll([item]);
    expect(ChannelHealthService.getRecord(item)?.status).toBe('unavailable');
  });

  it('marks a confirmed playback failure unavailable immediately', async () => {
    const item = channel('http://host/a');

    await ChannelHealthService.recordPlaybackFailure(item, 'playback_error');

    expect(ChannelHealthService.getRecord(item)).toMatchObject({
      status: 'unavailable',
      consecutiveFailures: 2,
      error: 'playback_error',
    });
  });

  it('restores a tracked channel after successful playback', async () => {
    const item = channel('http://host/a');
    await ChannelHealthService.recordPlaybackFailure(item, 'playback_error');

    const changed = await ChannelHealthService.recordPlaybackSuccess(item, 250);

    expect(changed).toBe(true);
    expect(ChannelHealthService.getRecord(item)).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      latencyMs: 250,
    });
  });

  it('does not persist an active result over a newer playback update', async () => {
    let finishSecond: (() => void) | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).indexOf('/b') !== -1) {
        await new Promise<void>(resolve => { finishSecond = resolve; });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = channel('http://host/a');
    const second = channel('http://host/b');

    const checking = ChannelHealthService.checkAll([first, second]);
    await vi.waitFor(() =>
      expect(ChannelHealthService.getRecord(first)?.status).toBe('healthy'));
    await ChannelHealthService.recordPlaybackFailure(first, 'playback_error');
    finishSecond?.();
    await checking;

    expect(Object.values(stored)).toContainEqual(expect.objectContaining({
      status: 'unavailable',
      error: 'playback_error',
    }));
  });

  it('does not apply a probe result over playback updated while probing', async () => {
    let finishProbe: (() => void) | null = null;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>(resolve => { finishProbe = resolve; });
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const item = channel('http://host/a');

    const checking = ChannelHealthService.checkAll([item]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await ChannelHealthService.recordPlaybackFailure(item, 'playback_error');
    finishProbe?.();
    await checking;

    expect(ChannelHealthService.getRecord(item)).toMatchObject({
      status: 'unavailable',
      error: 'playback_error',
    });
    expect(Object.values(stored)).toContainEqual(expect.objectContaining({
      status: 'unavailable',
      error: 'playback_error',
    }));
  });

  it('does not create a record from passive playback success', async () => {
    const item = channel('http://host/a');

    const changed = await ChannelHealthService.recordPlaybackSuccess(item, 250);

    expect(changed).toBe(false);
    expect(ChannelHealthService.getRecord(item)).toBeNull();
    expect(cacheMock.setCachedChannelHealth).not.toHaveBeenCalled();
  });

  it('does not count duplicate stream URLs twice', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = channel('http://host/a');
    const duplicate = { ...channel('http://host/a'), id: 'duplicate' };

    const summary = await ChannelHealthService.checkAll([first, duplicate]);

    expect(summary.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits while paused before starting the next batch', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let waitCount = 0;
    let resume: (() => void) | null = null;
    const waitWhilePaused = vi.fn(() => {
      waitCount++;
      if (waitCount === 1) return Promise.resolve();
      return new Promise<void>(resolve => { resume = resolve; });
    });
    const items = Array.from({ length: 5 }, (_, index) =>
      channel(`http://host/${index + 1}`));

    const checking = ChannelHealthService.checkAll(items, { waitWhilePaused });
    await vi.waitFor(() => expect(waitWhilePaused).toHaveBeenCalledTimes(2));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    resume?.();
    await checking;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not record an aborted check as a failure', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const item = channel('http://host/a');

    const summary = await ChannelHealthService.checkAll([item], {
      signal: controller.signal,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ChannelHealthService.getRecord(item)).toBeNull();
    expect(summary.unknown).toBe(1);
  });
});
