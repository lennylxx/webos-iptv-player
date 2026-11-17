import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { M3UWorkerChunk, M3UWorkerRequest, M3UWorkerResponse } from '../workers/tasks';
import type { Channel } from '../types';

// The page side of the M3U load, with the worker's messages cloned as
// postMessage would: the page's channels are copies of the worker's.
const { workerTask } = vi.hoisted(() => ({
  workerTask: vi.fn<(
    task: string,
    request: unknown,
    onChunk: (chunk: unknown) => void,
  ) => Promise<unknown>>(),
}));

vi.mock('../workers/app-worker-client', () => ({
  runAppWorkerTask: workerTask,
  retainAppWorker: () => () => undefined,
  appWorkerGeneration: () => 0,
}));

import { fetchAndParseM3U, fetchAndParseM3UInWorker } from './m3u-loader';

function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }));
}

beforeEach(() => {
  vi.stubGlobal('Worker', class {});
  workerTask.mockImplementation(async (_task, request, onChunk) => {
    const result = await fetchAndParseM3UInWorker(
      request as M3UWorkerRequest,
      chunk => onChunk(structuredClone(chunk)),
    );
    return structuredClone(result);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function headerPlaylist(inherited: number, tail: string[]): string {
  const lines = ['#EXTM3U catchup="shift" catchup-days="7"'];
  for (let i = 0; i < inherited; i++) lines.push(`#EXTINF:-1,Ch ${String(i)}`, `http://host/c${String(i)}.ts`);
  return lines.concat(tail).join('\n');
}

describe('fetchAndParseM3U header catch-up', () => {
  it('streams batches under header catch-up and clears them on the page once revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(headerPlaylist(1200, [
      '#EXTINF:-1 catchup-days="2",Own',
      'http://host/own.ts',
    ]))));
    const seen: Channel[][] = [];

    const result = await fetchAndParseM3U(
      'http://host/p.m3u', 5000, undefined, '', undefined, undefined, undefined, false, undefined,
      channels => seen.push(channels),
    );

    // Progressive batches arrived before the end, still carrying the header's catch-up then.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0].length).toBeLessThanOrEqual(512);
    expect(result.catchupRevokedBefore).toBeGreaterThan(0);
    const channels = result.data.channels;
    expect(channels).toHaveLength(1201);
    expect(channels.slice(0, 1200).every(ch => ch.catchup === '' && ch.catchupDays === 0)).toBe(true);
    expect(channels[1200]).toMatchObject({ name: 'Own', catchup: 'shift', catchupDays: 2 });
    // The batches the UI already received are the same, cleared objects.
    expect(seen[0][0].catchup).toBe('');
  });

  it('clears the channels the page already has as soon as the revoke arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(headerPlaylist(1200, [
      '#EXTINF:-1 catchup-days="2",Own',
      'http://host/own.ts',
    ]))));
    const seen: Channel[][] = [];
    let clearedOnArrival: boolean | null = null;
    workerTask.mockImplementation(async (_task, request, onChunk) => {
      const result = await fetchAndParseM3UInWorker(request as M3UWorkerRequest, (chunk) => {
        onChunk(structuredClone(chunk));
        if (chunk.kind === 'catchupRevoked') {
          clearedOnArrival = seen.flat().slice(0, chunk.before).every(ch => ch.catchup === '');
        }
      });
      // The early message alone does it.
      return structuredClone({ ...result, catchupRevokedBefore: undefined });
    });

    const result = await fetchAndParseM3U(
      'http://host/p.m3u', 5000, undefined, '', undefined, undefined, undefined, false, undefined,
      channels => seen.push(channels),
    );

    expect(clearedOnArrival).toBe(true);
    expect(result.data.channels.slice(0, 1200).every(ch => ch.catchup === '')).toBe(true);
  });

  it('clears the copies the worker holds for the cache write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(headerPlaylist(1200, [
      '#EXTINF:-1 catchup-days="2",Own',
      'http://host/own.ts',
    ]))));
    const chunks: M3UWorkerChunk[] = [];
    let response: M3UWorkerResponse | null = null;
    const held: Channel[][] = [];
    const holdValues = await import('../workers/held-values');
    vi.spyOn(holdValues, 'holdBatches').mockImplementation((batches) => {
      held.push(...(batches as Channel[][]));
      return 'token';
    });

    response = await fetchAndParseM3UInWorker(
      { url: 'http://host/p.m3u', timeout: 5000, holdChannels: true },
      chunk => chunks.push(structuredClone(chunk)),
    );

    // Two full batches went out before the revoking channel; the rest were still parsing.
    expect(response.catchupRevokedBefore).toBe(1024);
    const sent = chunks.flatMap(chunk => chunk.kind === 'channels' ? chunk.channels : []);
    expect(sent.slice(0, 1024).every(ch => ch.catchup === 'shift')).toBe(true);
    expect(sent.slice(1024, 1200).every(ch => ch.catchup === '')).toBe(true);
    const heldChannels = held.flat();
    expect(heldChannels).toHaveLength(1201);
    expect(heldChannels.slice(0, 1200).every(ch => ch.catchup === '')).toBe(true);
    expect(heldChannels[1200].catchup).toBe('shift');
  });

  it('keeps header catch-up when no channel has its own attribute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(headerPlaylist(1200, []))));
    const result = await fetchAndParseM3U('http://host/p.m3u', 5000);
    expect(result.catchupRevokedBefore).toBeUndefined();
    expect(result.data.channels.every(ch => ch.catchup === 'shift' && ch.catchupDays === 7)).toBe(true);
  });

  it('collects a chunk larger than the call stack allows to spread', async () => {
    const big = Array.from({ length: 300_000 }, (_, i) => ({ name: `c${String(i)}` }) as Channel);
    workerTask.mockImplementationOnce(async (_task, _request, onChunk) => {
      onChunk({
        kind: 'channels', channels: big, inputBytes: 0, chunks: 1, channelsEmitted: big.length, channelsDropped: 0,
      });
      return {
        data: { channels: [], groups: [], epgUrl: '', epgUrls: [], headerAttributes: {}, format: 'extended-m3u', issues: [] },
        metrics: { transport: 'stream', filter: 'none', inputBytes: 0, chunks: 1, channelsKept: big.length, channelsDropped: 0, elapsedMs: 0 },
      };
    });
    const result = await fetchAndParseM3U('http://host/p.m3u', 5000);
    expect(result.data.channels).toHaveLength(300_000);
  });
});
