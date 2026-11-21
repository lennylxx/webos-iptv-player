import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { LegacyAbortController } from '../test/legacy-fetch';
import { faultFetch } from '../test/fault-fetch';
import {
  fetchLimitedText,
  fetchText,
  fetchWithTimeout,
} from './fetch-helper';
import { mpdOpeningVerdict } from './url';

function okResponse(body = 'body'): Response {
  return new Response(body, { status: 200, statusText: 'OK' });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchText / fetchWithTimeout', () => {
  it('returns the response body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('hello')));
    await expect(fetchText('http://x')).resolves.toBe('hello');
  });

  it('passes an abort signal through to fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithTimeout('http://x');
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, statusText: 'Not Found',
    } as unknown as Response)));
    await expect(fetchWithTimeout('http://x')).rejects.toThrow('HTTP 404: Not Found');
  });

  it('aborts the request after the timeout elapses', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }),
    ));
    const p = fetchWithTimeout('http://x', {}, 5000);
    const assertion = expect(p).rejects.toMatchObject({ name: 'FetchStopError', reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('gives up on a fetchText server that never answers', async () => {
    vi.stubGlobal('fetch', faultFetch(() => ({ hang: true })));
    const p = fetchText('http://x', 5000);
    const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  // On webOS 4 abort can't reach a body read, so the timeout must cancel it.
  it('times out a fetchText body that stalls after its headers on webOS 4', async () => {
    onTestFinished(() => { vi.unstubAllGlobals(); });
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: 'WEBVTT\n\n00:00:01.000', stallAfterBytes: 7 })));
    const p = fetchText('http://x', 5000);
    const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('times out a fetchWithTimeout body that stalls after its headers', async () => {
    onTestFinished(() => { vi.unstubAllGlobals(); });
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '{"data":[]}', stallAfterBytes: 8 })));
    const p = fetchWithTimeout('http://x', {}, 5000);
    const assertion = expect(p).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('honors the caller signal, which a timeout signal used to replace', async () => {
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '{}', stallAfterBytes: 1 })));
    const caller = new AbortController();
    const p = fetchWithTimeout('http://x', { signal: caller.signal }, 5000);
    const assertion = expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    await assertion;
  });

  it('returns a readable response for a status that carries no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect((await fetchWithTimeout('http://x')).status).toBe(204);
  });
});

describe('fetchLimitedText', () => {
  it('cancels an endless response after reaching the byte limit', async () => {
    const cancel = vi.fn(async () => {});
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(5) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(5) });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://x', 8, 5000)).rejects.toThrow('exceeds 8 bytes');
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects a declared oversized response before reading its body', async () => {
    const read = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-length': '9' }),
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://x', 8, 5000))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(read).not.toHaveBeenCalled();
  });

  it('cancels binary MPEG-TS data as soon as it cannot be an HLS manifest', async () => {
    const cancel = vi.fn(async () => {});
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0x01]) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024) });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 256 * 1024, 5000, undefined, '#EXTM3U'))
      .rejects.toThrow('does not begin with #EXTM3U');
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('accepts a payload matching any one of several required prefixes', async () => {
    const bytes = new TextEncoder().encode('<MPD type="static"></MPD>');
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .resolves.toBe('<MPD type="static"></MPD>');
  });

  it('accepts a payload matching the longer of the candidate prefixes', async () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0"?><MPD/>');
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .resolves.toContain('<MPD/>');
  });

  it('waits for enough bytes before judging a prefix split across chunks', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('<M') })
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('PD/>') })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .resolves.toBe('<MPD/>');
  });

  it('tolerates a UTF-8 BOM ahead of a required prefix', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<MPD/>')]);
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel: vi.fn() }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .resolves.toContain('<MPD/>');
  });

  it('cancels as soon as a payload can match none of the required prefixes', async () => {
    const cancel = vi.fn(async () => {});
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('<html><body>') })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024) });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .rejects.toMatchObject({ code: 'invalid_content' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects a bounded read when the response exposes no stream reader', async () => {
    const arrayBuffer = vi.fn(async () =>
      new TextEncoder().encode('<html></html>').buffer);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer,
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000, undefined, ['<?xml', '<MPD']))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('does not trust Content-Length without a stream reader', async () => {
    const arrayBuffer = vi.fn(async () => new Uint8Array(2 * 1024 * 1024).buffer);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-length': '8' }),
      arrayBuffer,
    } as unknown as Response)));

    await expect(fetchLimitedText('http://host/a', 1024, 5000))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a non-MPD stream before reading later chunks', async () => {
    const cancel = vi.fn(async () => {});
    const read = vi.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode('<html><body>provider error</body></html>'),
      })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1024) });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(fetchLimitedText(
      'http://host/a.mpd',
      1024 * 1024,
      5000,
      undefined,
      mpdOpeningVerdict,
    )).rejects.toMatchObject({ code: 'invalid_content' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('honors an external abort while reading the body', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }),
    ));

    const p = fetchLimitedText('http://x', 1024, 5000, controller.signal);
    const assertion = expect(p).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await assertion;
  });

  it('times out a body that stalls after its headers on webOS 4', async () => {
    onTestFinished(() => { vi.unstubAllGlobals(); });
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: 'WEBVTT\n\n00:00:01.000', stallAfterBytes: 7 })));

    const pending = fetchLimitedText('http://x', 1024, 5000);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  // A small response trickling in means a broken server; the load behind it must not wait minutes.
  it('keeps its timeout as a hard total while a response trickles in', async () => {
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '[1,2,3]', chunkSize: 3, chunkDelayMs: 3000 })));
    const pending = fetchLimitedText('http://x', 1024, 5000);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('distinguishes its timeout from an external cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }),
    ));

    const pending = fetchLimitedText('http://x', 1024, 5000);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
