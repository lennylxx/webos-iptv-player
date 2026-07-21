import { gzipSync, strToU8 } from 'fflate';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchMaybeGzipText, fetchText, fetchWithTimeout, fetchWithRetry } from './fetch-helper';

function okResponse(body = 'body'): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => body,
  } as unknown as Response;
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
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithTimeout('http://x');
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
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
    const assertion = expect(p).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe('fetchMaybeGzipText', () => {
  it('reads an uncompressed UTF-8 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<tv/>')));
    await expect(fetchMaybeGzipText('http://host/epg.xml')).resolves.toBe('<tv/>');
  });

  it('decompresses a raw XMLTV .xml.gz response', async () => {
    const xmltv = '<?xml version="1.0"?><tv><channel id="ch1"/></tv>';
    const compressed = gzipSync(strToU8(xmltv));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(compressed)));

    await expect(fetchMaybeGzipText('http://host/guide.xml.gz')).resolves.toBe(xmltv);
  });
});

describe('fetchWithRetry', () => {
  it('retries after a failure and resolves once a call succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(okResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const p = fetchWithRetry('http://x', {}, 2);
    await vi.advanceTimersByTimeAsync(1000); // first backoff
    await expect(p).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('always down'));
    vi.stubGlobal('fetch', fetchMock);

    const p = fetchWithRetry('http://x', {}, 1);
    const assertion = expect(p).rejects.toThrow('always down');
    await vi.advanceTimersByTimeAsync(1000); // single backoff between the 2 attempts
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
