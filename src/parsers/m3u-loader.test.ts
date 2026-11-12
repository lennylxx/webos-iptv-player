import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  awaitCatchupClock,
  decodedResponseLength,
  fetchAndParseM3U,
  fetchAndParseM3UInWorker,
} from './m3u-loader';
import { CONFIG } from '../config';
import { serializedBytes } from '../utils/serialized-bytes';
import { measureHeldValue, writeHeldValue } from '../workers/held-values';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAndParseM3UInWorker', () => {
  const catchupSource = [
    '#EXTM3U',
    '#EXTINF:-1,Alpha',
    'http://host/live/u1/p1/101.ts',
    '#EXTINF:-1,Bravo',
    'http://host/live/u1/p1/102.ts',
  ].join('\n');
  const catchup = {
    accountId: 'a1',
    credentials: { baseUrl: 'http://host', username: 'u1', password: 'p1' },
    output: 'm3u8' as const,
  };

  function stubCatchupFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => url.includes('player_api.php')
      ? new Response(JSON.stringify({
          server_info: { timezone: 'Etc/GMT-2', timestamp_now: 1784665800, time_now: '2026-07-21 22:30:00' },
        }))
      : streamResponse([new TextEncoder().encode(catchupSource)]));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('stamps catch-up on archived streams with the panel clock', async () => {
    const fetchMock = stubCatchupFetch();

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: [
        { streamId: '101', directSource: '', archive: true, archiveDurationDays: 5 },
        { streamId: '102', directSource: '' },
      ],
      xtreamCatchup: catchup,
    });

    // The clock is requested before the playlist is fetched, not after.
    expect(String(fetchMock.mock.calls[0][0])).toContain('player_api.php');
    expect(result.data.channels[0]).toMatchObject({
      catchup: 'xtream',
      catchupSource: 'http://host/timeshift/u1/p1/{duration}/{start}/101.m3u8',
      catchupDays: 5,
      catchupAccountId: 'a1',
      catchupStreamId: '101',
      catchupTimeZone: 'Etc/GMT-2',
      catchupTimeOffsetMinutes: 120,
    });
    expect(result.data.channels[1]).toMatchObject({ catchup: '', catchupStreamId: '102' });
    expect(result.data.channels[1].catchupAccountId).toBeUndefined();
    expect(result.metrics.catchup).toEqual({ streams: 2, archived: 1, enabled: 1, unmatched: 0, clock: 'ok' });
  });

  it('passes archived Live catalog streams to the worker for catch-up', async () => {
    stubCatchupFetch();
    const stream = (streamId: string, archive: boolean) => ({
      streamId,
      name: streamId,
      icon: '',
      epgChannelId: '',
      categoryId: 'c1',
      categoryIds: ['c1'],
      directSource: '',
      archive,
      archiveDurationDays: archive ? 4 : 0,
    });

    const result = await fetchAndParseM3U(
      'http://host/get.php',
      5000,
      [stream('101', true), stream('102', false)],
      'http://host',
      undefined,
      undefined,
      undefined,
      false,
      catchup,
    );

    expect(result.data.channels.map(channel => channel.catchupDays)).toEqual([4, 0]);
    expect(result.metrics.catchup?.archived).toBe(1);
  });

  const archivedLive = [
    { streamId: '101', directSource: '', archive: true, archiveDurationDays: 5 },
    { streamId: '102', directSource: '' },
  ];

  function hangingClockFetch(playlist: () => Response): {
    fetchMock: ReturnType<typeof vi.fn>;
    clockSignal: () => AbortSignal | undefined;
  } {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (!url.includes('player_api.php')) return Promise.resolve(playlist());
      signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, clockSignal: () => signal };
  }

  async function withClockWait<T>(waitMs: number, run: () => Promise<T>): Promise<T> {
    const xtream = CONFIG.XTREAM as { CATCHUP_CLOCK_WAIT_MS: number };
    const previous = xtream.CATCHUP_CLOCK_WAIT_MS;
    xtream.CATCHUP_CLOCK_WAIT_MS = waitMs;
    try {
      return await run();
    } finally {
      xtream.CATCHUP_CLOCK_WAIT_MS = previous;
    }
  }

  it('gives up on a clock that never settles after the wait', async () => {
    await expect(awaitCatchupClock(new Promise(() => {}), 10)).resolves.toBeNull();
  });

  it('parses without the time zone when the clock stalls past the wait', async () => {
    // Like Chromium 53 with a stalled body: the clock ignores the abort.
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('player_api.php')
      ? new Promise<Response>(() => {})
      : Promise.resolve(streamResponse([new TextEncoder().encode(catchupSource)]))));

    const result = await withClockWait(10, () => fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    }));

    expect(result.data.channels[0]).toMatchObject({ catchup: 'xtream', catchupDays: 5 });
    expect(result.data.channels[0].catchupTimeZone).toBeUndefined();
    expect(result.metrics.catchup).toMatchObject({ clock: 'missing', clockFailure: 'wait' });
  });

  it('counts the clock wait from the playlist headers, not the request', async () => {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('player_api.php')) {
        await delay(150);
        return new Response(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      await delay(100);
      return streamResponse([new TextEncoder().encode(catchupSource)]);
    }));

    // The clock answers 150 ms in: past a 120 ms wait from the request, within
    // 120 ms of the headers at 100 ms.
    const result = await withClockWait(120, () => fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    }));

    expect(result.data.channels[0].catchupTimeZone).toBe('UTC');
    expect(result.metrics.catchup?.clock).toBe('ok');
  });

  it('cancels the clock request when the playlist fails', async () => {
    const { clockSignal } = hangingClockFetch(
      () => new Response('', { status: 500, statusText: 'Server Error' }),
    );

    await expect(fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    })).rejects.toThrow('HTTP 500');

    expect(clockSignal()?.aborted).toBe(true);
  });

  it('waits for a clock that answers after the playlist headers', async () => {
    let answerClock: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('player_api.php')
      ? new Promise<Response>(resolve => { answerClock = resolve; })
      : Promise.resolve(streamResponse([new TextEncoder().encode(catchupSource)]))));

    const loading = fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: { ...catchup, catalogStreams: 9 },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    answerClock(new Response(JSON.stringify({ server_info: { timezone: 'UTC' } })));
    const result = await loading;

    expect(result.data.channels[0]).toMatchObject({ catchup: 'xtream', catchupTimeZone: 'UTC' });
    expect(result.metrics.catchup?.streams).toBe(9);
  });

  it('stamps catch-up without a time zone when the clock fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('player_api.php')) throw new TypeError('offline');
      return streamResponse([new TextEncoder().encode(catchupSource)]);
    }));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    });

    expect(result.data.channels[0]).toMatchObject({ catchup: 'xtream', catchupDays: 5 });
    expect(result.data.channels[0].catchupTimeZone).toBeUndefined();
    expect(result.metrics.catchup).toMatchObject({ clock: 'missing', clockFailure: 'request_failed' });
  });

  function slowBodyResponse(bodyMs: number, signal?: AbortSignal): Response {
    let sent = false;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            await new Promise(resolve => setTimeout(resolve, bodyMs));
            if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
            sent = true;
            return { done: false, value: new TextEncoder().encode(catchupSource) };
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
  }

  it('returns a clock that arrives after stamping but before the load ends', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('player_api.php')) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return new Response(JSON.stringify({ server_info: { timezone: 'UTC' } }));
      }
      return slowBodyResponse(150);
    }));

    const result = await withClockWait(10, () => fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    }));

    expect(result.data.channels[0].catchupTimeZone).toBeUndefined();
    expect(result.metrics.catchup).toMatchObject({
      clock: 'late',
      lateClock: { timeZone: 'UTC' },
    });
  });

  it('keeps the clock wait out of the playlist timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init?: { signal?: AbortSignal }) =>
      url.includes('player_api.php')
        ? new Promise<Response>(() => {})
        : Promise.resolve(slowBodyResponse(100, init?.signal))));

    // 120 ms of clock wait plus 100 ms of body exceed the 180 ms timeout;
    // the body alone does not.
    const result = await withClockWait(120, () => fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 180,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
    }));

    expect(result.data.channels).toHaveLength(2);
  });

  it('counts catch-up enabled once per de-duplicated channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('player_api.php')
      ? new Response('{}')
      : streamResponse([new TextEncoder().encode(
          `${catchupSource}\n#EXTINF:-1,Alpha again\nhttp://host/live/u1/p1/101.ts`,
        )])));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: archivedLive,
      xtreamCatchup: catchup,
      playlistId: 'p1',
    });

    expect(result.data.channels).toHaveLength(2);
    expect(result.metrics.catchup).toMatchObject({ enabled: 1, clockFailure: 'no_server_info' });
  });

  it('skips the clock request when no stream is archived', async () => {
    const fetchMock = stubCatchupFetch();

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: [
        { streamId: '101', directSource: '' },
        { streamId: '102', directSource: '' },
      ],
      xtreamCatchup: catchup,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data.channels.every(channel => channel.catchup === '')).toBe(true);
    expect(result.metrics.catchup).toEqual({ streams: 2, archived: 0, enabled: 0, unmatched: 0, clock: 'missing' });
  });

  it('streams records and keeps only channels matched by the Live catalog', async () => {
    const source = [
      '#EXTM3U url-tvg="http://host/guide.xml"',
      '#EXTINF:-1 group-title="Live" custom="v",Alpha',
      '#EXTVLCOPT:http-user-agent=Agent',
      '#EXTHTTP:{"Referer":"http://host/a"}',
      'http://host/live/u1/p1/101.ts',
      '#EXTINF:-1,Movie',
      'http://host/vod/u1/p1/101.mkv',
      '#EXTINF:-1,Series',
      'http://host/series/u1/p1/201',
      '#EXTINF:-1,Bravo',
      'http://host/play?stream_id=102',
      '#EXTINF:-1,Charlie',
      'https://host/token/c?token=new&x=1',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse(splitBytes(new TextEncoder().encode(source), 7))));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: [
        { streamId: '101', directSource: '' },
        { streamId: '102', directSource: '' },
        { streamId: '103', directSource: 'https://host/token/c?x=1&token=old' },
      ],
    });

    expect(result.data.channels.map(channel => channel.name))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(result.data.channels[0]).toMatchObject({
      group: 'Live',
      sourceAttributes: { custom: 'v' },
      extras: {
        'http-user-agent': 'Agent',
        'http-referrer': 'http://host/a',
      },
      catchupStreamId: '101',
    });
    expect(result.data.channels.map(channel => channel.catchupStreamId))
      .toEqual(['101', '102', '103']);
    expect(result.data.epgUrl).toBe('http://host/guide.xml');
    expect(result.metrics).toMatchObject({
      transport: 'stream',
      filter: 'live_catalog',
      channelsKept: 3,
      channelsDropped: 2,
    });
  });

  it('merges a playlist\'s repeated streams across channel batches', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 600; i++) {
      lines.push(`#EXTINF:-1,ch${String(i)}`, `http://host/s${String(i % 550)}`);
    }
    lines.push('#EXTINF:-1,agent', '#EXTVLCOPT:http-user-agent=Agent', 'http://host/s0');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(lines.join('\n'))])));
    const batched = [] as Awaited<ReturnType<
      typeof fetchAndParseM3UInWorker
    >>['data']['channels'];

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/a',
      timeout: 5000,
      playlistId: 'pl1',
    }, chunk => {
      if (chunk.kind === 'channels') batched.push(...chunk.channels);
    });

    const channels = batched.concat(result.data.channels);
    expect(channels.map(ch => ch.name)).toEqual([
      ...Array.from({ length: 550 }, (_, i) => `ch${String(i)}`),
      'agent',
    ]);
    expect(channels.every(ch => ch.playlistIds.join() === 'pl1')).toBe(true);
    expect(result.metrics.duplicates).toBe(50);
  });

  it('reports the response size with every chunk when the server sends it', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 600; i++) lines.push(`#EXTINF:-1,ch${String(i)}`, `http://host/s${String(i)}`);
    const bytes = new TextEncoder().encode(lines.join('\n'));
    const response = streamResponse([bytes]);
    Object.assign(response, { headers: new Headers({ 'content-length': String(bytes.length) }) });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const totals: Array<number | undefined> = [];

    await fetchAndParseM3UInWorker({ url: 'http://host/a', timeout: 5000 }, chunk => {
      totals.push(chunk.totalBytes);
    });

    expect(totals.length).toBeGreaterThan(1);
    expect(totals.every(total => total === bytes.length)).toBe(true);
  });

  it('holds every channel it sent, measured as the page will store them', async () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 600; i++) {
      lines.push(`#EXTINF:-1,ch\u00e9${String(i)}`, `http://host/s${String(i % 550)}`);
    }
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(lines.join('\n'))])));
    const batched = [] as Awaited<ReturnType<
      typeof fetchAndParseM3UInWorker
    >>['data']['channels'];

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/a',
      timeout: 5000,
      playlistId: 'pl1',
      holdChannels: true,
    }, chunk => {
      if (chunk.kind === 'channels') batched.push(...chunk.channels);
    });

    const channels = JSON.parse(JSON.stringify(batched.concat(result.data.channels))) as unknown[];
    expect(result.held).not.toHaveProperty('bytes');
    expect(measureHeldValue(result.held!.token)).toBe(serializedBytes(channels));
    const writes: unknown[] = [];
    await writeHeldValue(
      { token: result.held!.token, timeoutMs: 1000, field: 'data', writes: [{ store: 's', value: {} }] },
      async batch => { writes.push(...batch); },
    );
    expect(writes).toEqual([{ store: 's', value: { data: channels } }]);
  });

  it('holds the channels it returns whole, and nothing unless asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,ch1\nhttp://host/a')])));

    const held = await fetchAndParseM3UInWorker({ url: 'http://host/a', timeout: 5000, holdChannels: true });
    expect(measureHeldValue(held.held!.token)).toBe(serializedBytes(held.data.channels));

    const result = await fetchAndParseM3UInWorker({ url: 'http://host/a', timeout: 5000 });
    expect(result.held).toBeUndefined();
  });

  it('preserves every M3U metadata surface through catalog filtering and batching', async () => {
    const source = [
      '#EXTM3U url-tvg="http://host/a.xml,http://host/b.xml" '
        + 'tvg-url="http://host/c.xml" max-conn="2" custom-header="header-value"',
      '#PLAYLIST:Provider Playlist',
      '#EXTINF:-1 tvg-id="ch1" tvg-name="Alpha" tvg-logo="http://host/logo.png" '
        + 'group-title="Old" catchup="default" catchup-days="7" '
        + 'catchup-source="http://host/archive/{utc}" tvg-chno="12" '
        + 'tvg-shift="-1.5" radio="true" custom-field="custom-value",Display Name',
      '#EXTGRP:Live;Regional',
      '#EXTVLCOPT:http-user-agent=Agent',
      '#EXTVLCOPT:network-caching=1500',
      '#KODIPROP:inputstream.adaptive.license_type=clearkey',
      '#EXTHTTP:{"User-Agent":"Agent","Referer":"http://host/ref","X-Test":"header"}',
      'http://host/play?stream_id=101',
      '#EXTINF:-1 group-title="Dropped" custom-field="drop",Movie',
      '#EXTVLCOPT:http-user-agent=DroppedAgent',
      '#KODIPROP:inputstream.adaptive.license_type=widevine',
      '#EXTHTTP:{"X-Dropped":"yes"}',
      'http://host/vod/u/p/201.mp4',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse(splitBytes(new TextEncoder().encode(source), 11))));
    const channels = [] as Awaited<ReturnType<
      typeof fetchAndParseM3UInWorker
    >>['data']['channels'];

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: [{ streamId: '101', directSource: '' }],
    }, chunk => {
      if (chunk.kind === 'channels') channels.push(...chunk.channels);
    });

    expect(channels).toEqual([{
      id: 'ch1',
      name: 'Alpha',
      logo: 'http://host/logo.png',
      group: 'Live',
      url: 'http://host/play?stream_id=101',
      extras: {
        'http-user-agent': 'Agent',
        'network-caching': '1500',
        'inputstream.adaptive.license_type': 'clearkey',
        'http-referrer': 'http://host/ref',
      },
      sourceAttributes: {
        'custom-field': 'custom-value',
        'kodiprop:inputstream.adaptive.license_type': 'clearkey',
      },
      httpHeaders: {
        'User-Agent': 'Agent',
        Referer: 'http://host/ref',
        'X-Test': 'header',
      },
      channelNumber: 12,
      tvgShift: -1.5,
      radio: true,
      sourceGroups: ['Live', 'Regional'],
      playlistIds: [],
      catchup: 'default',
      catchupSource: 'http://host/archive/{utc}',
      catchupStreamId: '101',
      catchupDays: 7,
    }]);
    expect(result.data).toMatchObject({
      channels: [],
      groups: ['Live', 'Regional'],
      epgUrl: 'http://host/a.xml',
      epgUrls: [
        'http://host/a.xml',
        'http://host/b.xml',
        'http://host/c.xml',
      ],
      headerAttributes: {
        'url-tvg': 'http://host/a.xml,http://host/b.xml',
        'tvg-url': 'http://host/c.xml',
        'max-conn': '2',
        'custom-header': 'header-value',
      },
      maxConnections: 2,
      name: 'Provider Playlist',
      format: 'extended-m3u',
      issues: [],
    });
    expect(result.metrics).toMatchObject({
      filter: 'live_catalog',
      channelsKept: 1,
      channelsDropped: 1,
    });
  });

  it('early-rejects only canonical non-Live locations across chunk boundaries', async () => {
    const source = [
      '#EXTM3U',
      '#EXTINF:-1 custom-field="movie",Movie',
      '#EXTHTTP:{bad',
      'http://host/movie/u1/p1/201.mp4',
      '#EXTINF:-1 custom-field="series",Series',
      '#EXTHTTP:{bad',
      'http://host/series/u1/p1/301.mkv',
      '#EXTINF:-1 custom-field="live",Alpha',
      'http://host/live/u1/p1/101.ts',
      '#EXTINF:-1 custom-field="provider",Provider',
      '#EXTHTTP:{bad',
      'http://host/proxy/movie/u1/p1/202.mp4?stream_id=102',
      '#EXTINF:-1 custom-field="alternate",Alternate',
      '#EXTHTTP:{bad',
      'http://host/vod/u1/p1/203.mkv?stream_id=103',
      '#EXTINF:-1 custom-field="malformed",Malformed',
      '#EXTHTTP:{bad',
      'not a url',
      '#EXTINF:-1 custom-field="direct",Bravo',
      'https://host/movie/u1/p1/104.ts?token=new',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse(splitBytes(new TextEncoder().encode(source), 1))));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamBaseUrl: 'http://host',
      xtreamLive: [
        { streamId: '101', directSource: '' },
        { streamId: '102', directSource: '' },
        { streamId: '103', directSource: '' },
        {
          streamId: '104',
          directSource: 'https://host/movie/u1/p1/104.ts?token=old',
        },
      ],
    });

    expect(result.data.channels).toEqual([
      expect.objectContaining({
        name: 'Alpha',
        sourceAttributes: { 'custom-field': 'live' },
        catchupStreamId: '101',
      }),
      expect.objectContaining({
        name: 'Bravo',
        sourceAttributes: { 'custom-field': 'direct' },
        catchupStreamId: '104',
      }),
    ]);
    expect(result.data.issues.filter(issue => issue.code === 'bad-exthttp'))
      .toHaveLength(2);
    expect(result.metrics).toMatchObject({
      filter: 'live_catalog',
      channelsKept: 2,
      channelsDropped: 5,
    });
  });

  it('does not guess stream identity when the Live catalog is unavailable', async () => {
    const source = [
      '#EXTM3U',
      '#EXTINF:-1,Alpha',
      'http://host/live/u1/p1/101.ts',
      '#EXTINF:-1,Movie',
      'http://host/movie/u1/p1/201.mkv',
      '#EXTINF:-1,Alternate',
      'http://host/vod/u1/p1/202.mkv',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(source)])));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamBaseUrl: 'http://host',
    });

    expect(result.data.channels.map(channel => channel.name))
      .toEqual(['Alpha', 'Movie', 'Alternate']);
    expect(result.metrics).toMatchObject({
      filter: 'unavailable',
      channelsDropped: 0,
    });
  });

  it('drops every entry when the authoritative Live catalog is empty', async () => {
    const source = [
      '#EXTM3U',
      '#EXTINF:-1,Movie',
      'http://host/movie/u1/p1/201.mkv',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(source)])));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamLive: [],
      xtreamBaseUrl: 'http://host',
    });

    expect(result.data.channels).toEqual([]);
    expect(result.metrics).toMatchObject({
      filter: 'live_catalog',
      channelsDropped: 1,
    });
  });

  it('incrementally decodes a BOM-marked UTF-16 playlist', async () => {
    const source = '#EXTM3U\r\n#EXTINF:-1,Alpha\r\nhttp://host/a';
    const bytes = encodeUtf16(source, true);
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse(splitBytes(bytes, 3))));

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/list.m3u',
      timeout: 5000,
    });

    expect(result.data.channels.map(channel => channel.name)).toEqual(['Alpha']);
    expect(result.data.channels[0].url).toBe('http://host/a');
  });

  it('reports structured fetch failures without including the source URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
    })));

    await expect(fetchAndParseM3UInWorker({
      url: 'http://host/private-list.m3u?token=secret',
      timeout: 5000,
    })).rejects.toMatchObject({
      name: 'M3UWorkerError',
      message: 'HTTP 503: Unavailable',
      details: {
        stage: 'fetch',
        reason: 'http',
        filter: 'none',
        inputBytes: 0,
        chunks: 0,
      },
    });
  });

  it('emits retained channels in bounded batches', async () => {
    const lines = ['#EXTM3U'];
    for (let index = 0; index < 513; index++) {
      lines.push(`#EXTINF:-1,Channel ${String(index)}`, `http://host/${String(index)}`);
    }
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(lines.join('\n'))])));
    const batches: string[][] = [];

    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/list.m3u',
      timeout: 5000,
    }, chunk => {
      if (chunk.kind === 'channels') {
        batches.push(chunk.channels.map(channel => channel.name));
      }
    });

    expect(batches.map(batch => batch.length)).toEqual([512, 1]);
    expect(batches[0][0]).toBe('Channel 0');
    expect(batches[1][0]).toBe('Channel 512');
    expect(result.data.channels).toEqual([]);
    expect(result.metrics.channelsKept).toBe(513);
  });

  it('reports processed and retained channel counts from worker batches', async () => {
    const lines = ['#EXTM3U'];
    for (let index = 0; index < 513; index++) {
      lines.push(`#EXTINF:-1,Channel ${String(index)}`, `http://host/${String(index)}`);
    }
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(lines.join('\n'))])));
    const progress: Array<{
      channelsProcessed: number;
      channelsKept: number;
      channelsDropped: number;
    }> = [];

    await fetchAndParseM3U(
      'http://host/list.m3u',
      5000,
      undefined,
      '',
      update => progress.push(update),
    );

    expect(progress.map(update => update.channelsProcessed)).toEqual([512, 513]);
    expect(progress[progress.length - 1]).toMatchObject({
      channelsKept: 513,
      channelsDropped: 0,
    });
  });

  it('reports the final count when every channel is filtered before 8 MiB', async () => {
    const source = [
      '#EXTM3U',
      '#EXTINF:-1,Movie',
      'http://host/movie/u/p/201.mp4',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(source)])));
    const progress: Array<{
      channelsProcessed: number;
      channelsKept: number;
      channelsDropped: number;
    }> = [];

    await fetchAndParseM3U(
      'http://host/get.php',
      5000,
      [],
      'http://host',
      update => progress.push(update),
    );

    expect(progress).toEqual([
      expect.objectContaining({
        channelsProcessed: 1,
        channelsKept: 0,
        channelsDropped: 1,
      }),
    ]);
  });
});

function streamResponse(chunks: Uint8Array[]): Response {
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

function splitBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function encodeUtf16(value: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2 + 2);
  bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const offset = index * 2 + 2;
    bytes[offset] = littleEndian ? code & 0xff : code >> 8;
    bytes[offset + 1] = littleEndian ? code >> 8 : code & 0xff;
  }
  return bytes;
}

describe('Xtream Live category name-match fallback', () => {
  const source = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Alpha",ch1',
    'http://host/live/u1/p1/101.ts',
    '#EXTINF:-1 group-title="  BRAVO   one ",ch2',
    'http://host/live/u1/p1/102.ts',
    '#EXTINF:-1 group-title="Charlie",ch3',
    'http://host/live/u1/p1/103.ts',
  ].join('\n');

  function stubSource(): void {
    vi.stubGlobal('fetch', vi.fn(async () =>
      streamResponse([new TextEncoder().encode(source)])));
  }

  it('keeps only channels whose group is listed in include mode', async () => {
    stubSource();
    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamBaseUrl: 'http://host',
      xtreamGroupFilter: { mode: 'include', names: ['alpha', 'bravo one'] },
    });

    expect(result.data.channels.map(channel => channel.name)).toEqual(['ch1', 'ch2']);
    expect(result.metrics).toMatchObject({
      filter: 'unavailable',
      channelsKept: 2,
      channelsDropped: 1,
    });
  });

  it('drops channels whose group is listed in exclude mode', async () => {
    stubSource();
    const result = await fetchAndParseM3UInWorker({
      url: 'http://host/get.php',
      timeout: 5000,
      xtreamBaseUrl: 'http://host',
      xtreamGroupFilter: { mode: 'exclude', names: ['bravo one'] },
    });

    expect(result.data.channels.map(channel => channel.name)).toEqual(['ch1', 'ch3']);
    expect(result.metrics).toMatchObject({ channelsKept: 2, channelsDropped: 1 });
  });

  it('carries the group filter from fetchAndParseM3U to the worker request', async () => {
    stubSource();
    const progress: Array<{ channelsKept: number; channelsDropped: number }> = [];

    const result = await fetchAndParseM3U(
      'http://host/get.php',
      5000,
      undefined,
      'http://host',
      update => progress.push(update),
      { mode: 'include', names: ['charlie'] },
    );

    expect(result.data.channels.map(channel => channel.name)).toEqual(['ch3']);
    expect(progress[progress.length - 1]).toMatchObject({
      channelsKept: 1,
      channelsDropped: 2,
    });
  });

  it('loads every channel when no group filter is given', async () => {
    stubSource();
    const result = await fetchAndParseM3U('http://host/get.php', 5000, undefined, 'http://host');

    expect(result.data.channels.map(channel => channel.name)).toEqual(['ch1', 'ch2', 'ch3']);
    expect(result.metrics).toMatchObject({ filter: 'unavailable', channelsDropped: 0 });
  });
});

describe('decodedResponseLength', () => {
  it('counts only an uncompressed Content-Length as the total', () => {
    expect(decodedResponseLength(new Headers({ 'content-length': '1200' }))).toBe(1200);
    expect(decodedResponseLength(new Headers({
      'content-length': '1200',
      'content-encoding': 'identity',
    }))).toBe(1200);
    expect(decodedResponseLength(new Headers({
      'content-length': '1200',
      'content-encoding': 'gzip',
    }))).toBe(0);
    expect(decodedResponseLength(new Headers())).toBe(0);
  });
});
