import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MediaInfo } from '../utils/stream-info';

vi.mock('../parsers/mp4-info', () => ({ parseMp4Info: vi.fn() }));
vi.mock('../parsers/mkv-info', () => ({ parseMkvInfo: vi.fn() }));
vi.mock('./idb-cache', () => ({ getCachedCatalog: vi.fn(), setCachedCatalog: vi.fn() }));

import { probeMedia, FRONT_BYTES, TAIL_BYTES, PROBE_TIMEOUT } from './media-probe';
import { parseMp4Info } from '../parsers/mp4-info';
import { parseMkvInfo } from '../parsers/mkv-info';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';

const mp4 = vi.mocked(parseMp4Info);
const mkv = vi.mocked(parseMkvInfo);
const getCache = vi.mocked(getCachedCatalog);
const setCache = vi.mocked(setCachedCatalog);

const INFO: MediaInfo = { videoCodec: 'avc1', audioCodec: 'mp4a', width: 1920, height: 1080, fps: 24, hdr: '' };

// A streaming Response: the body is delivered through a getReader() that yields
// `bytes` in `chunkSize` pieces, mirroring how probeMedia reads a capped prefix.
// A 206 carries a Content-Range with the total; a 200 (server ignored Range)
// carries none. The cancel spy lets a test assert the body was released early.
function streamResponse(bytes: Uint8Array, total: number, status = 206, chunkSize = bytes.length || 1) {
  const cancel = vi.fn(async () => {});
  const response = {
    status,
    body: {
      getReader() {
        let offset = 0;
        return {
          read: async () => {
            if (offset >= bytes.length) return { done: true, value: undefined };
            const chunk = bytes.subarray(offset, offset + chunkSize);
            offset += chunk.length;
            return { done: false, value: chunk };
          },
          cancel,
        };
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-range' && status === 206 ? `bytes 0-${bytes.length - 1}/${total}` : null,
    },
  } as unknown as Response;
  return { response, cancel };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  getCache.mockResolvedValue(null);
  setCache.mockResolvedValue(undefined);
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('probeMedia', () => {
  it('returns null for an unsupported extension without fetching or touching the cache', async () => {
    expect(await probeMedia('http://host/movie/10.avi', 'k')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCache).not.toHaveBeenCalled();
  });

  it('requests an open-ended front range, parses it, and caches the result', async () => {
    mp4.mockReturnValue(INFO);
    fetchMock.mockResolvedValue(streamResponse(new Uint8Array([1, 2, 3]), 1000).response);
    const result = await probeMedia('http://host/movie/10.mp4', 'key1');
    expect(result).toEqual(INFO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Range).toBe('bytes=0-');
    expect(setCache).toHaveBeenCalledWith('key1', INFO, null);
  });

  it('routes .mkv/.webm to the MKV parser and never fetches a tail range', async () => {
    mkv.mockReturnValue(null);
    fetchMock.mockResolvedValue(streamResponse(new Uint8Array(10), 5_000_000).response);
    expect(await probeMedia('http://host/movie/10.mkv', 'k')).toBeNull();
    expect(mkv).toHaveBeenCalled();
    expect(mp4).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // front only, no tail
  });

  it('falls back to an open-ended tail range for an MP4 with moov at the end', async () => {
    mp4.mockReturnValueOnce(null).mockReturnValueOnce(INFO);
    const total = 5_000_000;
    fetchMock
      .mockResolvedValueOnce(streamResponse(new Uint8Array(FRONT_BYTES), total).response)
      .mockResolvedValueOnce(streamResponse(new Uint8Array([9, 9, 9]), total).response);
    const result = await probeMedia('http://host/movie/10.mp4', 'k');
    expect(result).toEqual(INFO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Range).toBe(`bytes=${total - TAIL_BYTES}-`);
  });

  it('reads a capped prefix when the server ignores Range (status 200)', async () => {
    mp4.mockReturnValue(INFO);
    fetchMock.mockResolvedValue(streamResponse(new Uint8Array([1, 2, 3, 4]), 0, 200).response);
    const result = await probeMedia('http://host/movie/10.mp4', 'k');
    expect(result).toEqual(INFO);
    expect(mp4).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // a range-ignoring 200 gives no tail to fetch
  });

  it('caps the streamed prefix at FRONT_BYTES and cancels the rest of an oversized body', async () => {
    mp4.mockReturnValue(INFO);
    const oversized = new Uint8Array(FRONT_BYTES + 1_000_000);
    const { response, cancel } = streamResponse(oversized, 0, 200, 512 * 1024);
    fetchMock.mockResolvedValue(response);
    const result = await probeMedia('http://host/movie/10.mp4', 'k');
    expect(result).toEqual(INFO);
    expect(mp4.mock.calls[0][0].length).toBe(FRONT_BYTES); // never more than the cap
    expect(cancel).toHaveBeenCalled(); // body released instead of fully downloaded
  });

  it('rejects a range-ignoring 200 on the tail read (a full response is not the tail)', async () => {
    mp4.mockReturnValue(null); // front never yields a video track
    const total = 5_000_000;
    fetchMock
      .mockResolvedValueOnce(streamResponse(new Uint8Array(FRONT_BYTES), total).response)
      .mockResolvedValueOnce(streamResponse(new Uint8Array([1, 2, 3]), 0, 200).response);
    expect(await probeMedia('http://host/movie/10.mp4', 'k')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mp4).toHaveBeenCalledTimes(1); // the 200 tail is discarded before parsing
    expect(setCache).not.toHaveBeenCalled();
  });

  it('returns the cached result without fetching on a cache hit', async () => {
    getCache.mockResolvedValue({ key: 'k', timestamp: 0, data: INFO });
    expect(await probeMedia('http://host/movie/10.mp4', 'k')).toEqual(INFO);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when a fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect(await probeMedia('http://host/movie/10.mp4', 'k')).toBeNull();
    expect(setCache).not.toHaveBeenCalled();
  });

  it('aborts and returns null when the request exceeds the probe timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
    const pending = probeMedia('http://host/movie/10.mp4', 'k');
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT + 10);
    expect(await pending).toBeNull();
    expect(setCache).not.toHaveBeenCalled();
  });
});
