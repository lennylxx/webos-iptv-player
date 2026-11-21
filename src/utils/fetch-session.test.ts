import { afterEach, describe, expect, it, vi } from 'vitest';
import { faultFetch } from '../test/fault-fetch';
import { FetchSession, FetchStopError, progressTimeouts } from './fetch-session';
import { LegacyAbortController } from '../test/legacy-fetch';

// The body stays open after `chunks` unless `end` closes it.
function streamResponse(chunks: string[], status = 200, end = false) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      if (end) c.close();
    },
    cancel,
  });
  return { response: new Response(body, { status }), cancel };
}

async function outcome(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let result: unknown = 'pending';
  promise.then(value => { result = value; }, (error: unknown) => { result = error; });
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

async function drain(session: FetchSession): Promise<number> {
  let bytes = 0;
  for (;;) {
    const next = await session.read();
    if (next.done) return bytes;
    bytes += next.value.length;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FetchSession', () => {
  it('times out a body that stalls after its headers where abort cannot reach it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('AbortController', LegacyAbortController);
    const { response, cancel } = streamResponse(['#EXTM3U\n']);
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const session = new FetchSession('http://host/a', { timeout: 1000 });

    const result = await outcome(session.open().then(() => drain(session)), 2000);

    expect(result).toBeInstanceOf(FetchStopError);
    expect((result as FetchStopError).reason).toBe('timeout');
    expect(cancel).toHaveBeenCalled();
    session.close();
  });

  it('lets a slow body that keeps arriving run past its progress timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', faultFetch(() => ({ body: 'abcdef', chunkSize: 1, chunkDelayMs: 500 })));
    const session = new FetchSession('http://host/a', progressTimeouts(1000));

    const result = await outcome(session.open().then(() => drain(session)), 5000);

    expect(result).toBe(6);
    session.close();
  });

  it('stops a body that goes quiet for the idle timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['a', 'b']).response));
    const session = new FetchSession('http://host/a', { timeout: 60_000, idleTimeout: 500 });

    const result = await outcome(session.open().then(() => drain(session)), 1000);

    expect((result as FetchStopError).reason).toBe('timeout');
    session.close();
  });

  it('stops waiting for headers after the headers timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    const session = new FetchSession('http://host/a', { timeout: 60_000, headersTimeout: 500 });

    expect(((await outcome(session.open(), 1000)) as FetchStopError).reason).toBe('timeout');
    session.close();
  });

  it('reports a caller cancel as cancelled, not a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['a']).response));
    const caller = new AbortController();
    const session = new FetchSession('http://host/a', { timeout: 60_000, signal: caller.signal });
    await session.open();
    const reading = outcome(drain(session), 100);
    caller.abort();

    expect(((await reading) as FetchStopError).reason).toBe('cancelled');
    session.close();
  });

  it('holds the timeout while paused and resumes it with the time left', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['a']).response));
    const session = new FetchSession('http://host/a', { timeout: 1000 });
    await session.open();
    await vi.advanceTimersByTimeAsync(400);
    const resume = session.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.stopReason).toBeNull();

    resume();
    await vi.advanceTimersByTimeAsync(550);
    expect(session.stopReason).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.stopReason).toBe('timeout');
    session.close();
  });

  it('reads a whole body and cancels the unread body of a refused one on close', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(['ab', 'c'], 200, true).response));
    const ok = new FetchSession('http://host/a', { timeout: 1000 });
    await ok.open();
    expect(await drain(ok)).toBe(3);
    ok.close();

    const refused = streamResponse(['error page'], 503);
    vi.stubGlobal('fetch', vi.fn(async () => refused.response));
    const session = new FetchSession('http://host/b', { timeout: 1000 });
    expect((await session.open()).status).toBe(503);
    session.close();
    expect(refused.cancel).toHaveBeenCalled();
  });
});
