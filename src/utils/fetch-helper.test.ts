import { gzipSync, strToU8 } from 'fflate';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchLimitedText,
  fetchMaybeGzipText,
  fetchPlaylistText,
  fetchText,
  fetchWithTimeout,
  fetchWithRetry,
} from './fetch-helper';

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

  describe('fetchPlaylistText', () => {
    it('decodes a BOM-marked UTF-16 playlist', async () => {
      const source = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a';
      const bytes = new Uint8Array(source.length * 2 + 2);
      bytes.set([0xff, 0xfe]);
      for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        bytes[index * 2 + 2] = code & 0xff;
        bytes[index * 2 + 3] = code >> 8;
      }
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response)));
      await expect(fetchPlaylistText('http://host/a')).resolves.toBe(source);
    });

    it('keeps the timeout active while reading the playlist body', async () => {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => ({
        ok: true,
        arrayBuffer: () => new Promise<ArrayBuffer>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')));
        }),
      } as unknown as Response)));
      const pending = fetchPlaylistText('http://host/a', 5000);
      const assertion = expect(pending).rejects.toThrow('Aborted');
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    });
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

  it('keeps the fetchText timeout active while reading the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => ({
      ok: true,
      text: () => new Promise<string>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }),
    } as unknown as Response)));
    const p = fetchText('http://x', 5000);
    const assertion = expect(p).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
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

  it('honors an external abort while reading the body', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      }),
    ));

    const p = fetchLimitedText('http://x', 1024, 5000, controller.signal);
    const assertion = expect(p).rejects.toThrow('Aborted');
    controller.abort();
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
