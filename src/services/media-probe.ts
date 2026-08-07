import { parseMp4Info } from '../parsers/mp4-info';
import { parseMkvInfo } from '../parsers/mkv-info';
import { extFromUrl } from '../utils/url';
import { getCachedCatalog, setCachedCatalog } from './idb-cache';
import type { MediaInfo } from '../utils/stream-info';
import { createLogger } from '../utils/logger';

const log = createLogger('MediaProbe');

// Header-only ranges. The MP4/MKV metadata we read lives near the front (fast-
// start moov, or the EBML Tracks element). MP4 also allows moov at the end, so a
// single tail range is the fallback. Two 2 MB ranges cap the one-time download
// at ~4 MB; the media itself streams independently on the <video> element.
export const FRONT_BYTES = 2 * 1024 * 1024;
export const TAIL_BYTES = 2 * 1024 * 1024;
// Bound each range request. The probe is best-effort background work off the
// playback path, so a slow/hung origin must not leave a fetch pending forever —
// a miss just drops the OSD badges (the element's resolution still shows).
export const PROBE_TIMEOUT = 15000;

type Parser = (bytes: Uint8Array) => MediaInfo | null;

function parserFor(url: string): Parser | null {
  switch (extFromUrl(url)) {
    case 'mp4':
    case 'm4v':
    case 'mov':
      return parseMp4Info;
    case 'mkv':
    case 'webm':
      return parseMkvInfo;
    default:
      return null;
  }
}

// Stream at most `maxBytes` from the response body, then cancel the rest. Keeps a
// range-ignoring 200 from downloading the whole payload, and releases the
// connection as soon as we have the header we need.
async function readCappedPrefix(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body available (shouldn't happen on webOS/preview) — fall
    // back to buffering, still clamped to the cap.
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        received += value.length;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

// Read up to `maxBytes` from `url` starting at `start`, tolerant of servers that
// mishandle Range. It sends an open-ended `bytes=start-` (what the media element
// itself sends, so a strict server can't 416 on an end past EOF) and streams only
// the prefix it needs, bounded by an abort timeout. A 206 is always accepted; a
// 200 (Range ignored) is accepted only when `acceptFull` — for the front read,
// where the header we want is still at the start. The tail read forbids it,
// because a range-ignoring full response is the front, not the tail.
async function fetchRange(
  url: string,
  start: number,
  maxBytes: number,
  acceptFull: boolean,
): Promise<{ bytes: Uint8Array; total: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-` }, signal: controller.signal });
    if (res.status !== 206 && !(acceptFull && res.status === 200)) return null;
    const contentRange = res.headers.get('Content-Range') ?? '';
    const total = parseInt(contentRange.split('/')[1] ?? '', 10);
    const bytes = await readCappedPrefix(res, maxBytes);
    if (!bytes.length) return null;
    return { bytes, total: Number.isFinite(total) ? total : 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Read codec/fps/HDR (and resolution) from a VOD container header. Fetches at
// most a 2 MB front range plus, for MP4 with moov at the end, a 2 MB tail range.
// Caches successful parses per stream in the IndexedDB catalog store. Returns
// null (caller falls back to the element's resolution) for unsupported
// containers, servers without range support, or an unparseable header.
export async function probeMedia(url: string, cacheKey: string): Promise<MediaInfo | null> {
  const parser = parserFor(url);
  if (!parser) { log.debug('unsupported container', extFromUrl(url) || '(none)', cacheKey); return null; }

  const cached = await getCachedCatalog<MediaInfo>(cacheKey);
  if (cached) { log.debug('cache hit', cacheKey); return cached.data; }

  try {
    const front = await fetchRange(url, 0, FRONT_BYTES, true);
    if (!front) { log.warn('no usable range response', cacheKey); return null; }
    let info = parser(front.bytes);

    if (!info && parser === parseMp4Info && front.total > front.bytes.length) {
      const start = Math.max(front.bytes.length, front.total - TAIL_BYTES);
      const tail = await fetchRange(url, start, TAIL_BYTES, false);
      if (tail) info = parseMp4Info(tail.bytes);
    }

    if (!info) { log.warn('unparseable header', extFromUrl(url), cacheKey); return null; }
    await setCachedCatalog(cacheKey, info, null);
    log.debug('probed', cacheKey, info.videoCodec || '?', `${info.width}x${info.height}`, info.hdr || '');
    return info;
  } catch (err) {
    log.warn('probe failed:', err);
    return null;
  }
}
