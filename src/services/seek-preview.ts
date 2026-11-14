import { CONFIG } from '../config';
import { parseMpdImageTrack } from '../parsers/mpd-manifest';
import { fetchLimitedText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';

const log = createLogger('SeekPreview');

/** A preview frame: a whole image, or one tile of a sprite sheet. */
export interface SeekThumbnail {
  url: string;
  tile: { x: number; y: number; w: number; h: number } | null;
  width: number;   // the image's full size, in pixels
  height: number;
}

export interface SeekPreviewSource {
  streamUrl: string;
  mime: string;
  /** The playlist's `seek_preview` template, or ''. */
  template: string;
  catchupType: string;
  /** Unix seconds shown at media time `t`, or null when the stream has no
   *  wall clock (VOD). */
  utcAt: ((t: number) => number) | null;
  /** A sliding live window: image tracks would need wall-clock sync. */
  live: boolean;
}

export type SeekPreviewProviderName = 'template' | 'flussonic' | 'nimble' | 'hls' | 'dash' | 'vtt';

interface Candidate {
  url: string;
  tile: SeekThumbnail['tile'];
  width: number;   // 0 when only the loaded image knows
  height: number;
  fresh?: boolean; // so close to now that a miss does not count
}

interface Provider {
  name: SeekPreviewProviderName;
  init?: (signal: AbortSignal) => Promise<boolean>;
  candidate(t: number): Candidate | null;
}

export type ImageLoader = (url: string) => Promise<{ width: number; height: number }>;

const UTC_STEP = 10;  // seconds; nearby targets share one server image
const MAX_MISSES = 3;  // consecutive image failures before a provider is dropped
// A miss this close to now may be a frame the server has not made yet.
const LIVE_EDGE_GRACE = 60;

function loadImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('image'));
    img.src = url;
  });
}

function splitUrl(url: string): { dir: string; file: string; query: string } | null {
  const match = url.match(/^(https?:\/\/[^?#]+\/)([^/?#]*)(\?[^#]*)?/i);
  if (!match) return null;
  return { dir: match[1], file: match[2], query: match[3] || '' };
}

function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function queryParam(url: string, name: string): string {
  const match = url.match(new RegExp(`[?&]${name}=([^&#]*)`));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Flussonic playback names whose sibling `{utc}-preview.jpg` is the DVR frame.
// Names a generic server also uses only count when the playlist says the
// channel is Flussonic.
const FLUSSONIC_FILE = /^(?:(?:index|mono|video|archive|audio|tracks-[\w,]+)-\d+-(?:\d+|now)\.(?:m3u8|mpd|ts)|(?:video-)?timeshift_(?:abs|rel)-\d+\.(?:m3u8|ts|mpd)|archive-\d+-\d+\.mp4)$/i;
const FLUSSONIC_GENERIC_FILE = /^(?:index|mono|video)\.m3u8$|^(?:index|Manifest)\.mpd$|^mpegts$/i;
const FLUSSONIC_CATCHUP = /^(?:flussonic|fs|flussonic-(?:hls|dash|ts))$/i;

/** The `{utc}-preview.jpg` URL for a Flussonic stream, as a template, or ''. */
export function flussonicPreviewTemplate(streamUrl: string, catchupType: string): string {
  const parts = splitUrl(streamUrl);
  if (!parts || !/^https?:\/\/[^/]+\/.+\//i.test(parts.dir)) return '';
  const known = FLUSSONIC_FILE.test(parts.file)
    || (FLUSSONIC_CATCHUP.test(catchupType) && FLUSSONIC_GENERIC_FILE.test(parts.file));
  return known ? `${parts.dir}{utc}-preview.jpg${parts.query}` : '';
}

const NIMBLE_FILE = /^playlist(?:_fmp4)?_dvr(?:_range-\d+-\d+|_timeshift-\d+(?:-\d+)?)?\.m3u8$/i;

/** Nimble Streamer's `dvr_thumbnail_{utc}.jpg` URL, as a template, or ''. */
export function nimblePreviewTemplate(streamUrl: string): string {
  const parts = splitUrl(streamUrl);
  if (!parts || !NIMBLE_FILE.test(parts.file)) return '';
  return `${parts.dir}dvr_thumbnail_{utc}.jpg${parts.query}`;
}

function pad(value: number, size = 2): string {
  const text = String(value);
  return text.length >= size ? text : new Array(size - text.length + 1).join('0') + text;
}

function shiftSeconds(shift: string | undefined): number {
  if (!shift) return 0;
  const match = shift.match(/^([+-])(\d+)([smhd]?)$/i);
  if (!match) return NaN;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[3].toLowerCase()] ?? 1;
  return (match[1] === '-' ? -1 : 1) * parseInt(match[2], 10) * unit;
}

function isoUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Expands an OTT Navigator `seek_preview` template for the frame at `utc`
 *  (Unix seconds), or returns null when it uses a variable this app cannot
 *  fill. In a preview template, start and end both name the previewed moment. */
export function expandSeekPreviewTemplate(
  template: string,
  utc: number,
  nowSeconds: number,
  token: string,
): string | null {
  let globalShift = 0;
  let text = template.replace(/\{\{shift:start:([+-]\d+[smhd]?)\}\}/i, (_m, shift: string) => {
    globalShift = shiftSeconds(shift);
    return '';
  });
  if (!Number.isFinite(globalShift)) return null;
  let unresolved = false;
  text = text.replace(/\$?\{([a-z_-]+)(?::([+-]\d+[smhd]?))?\}/gi, (match, rawName: string, shift?: string) => {
    const name = rawName.toLowerCase();
    const offset = shiftSeconds(shift);
    const at = utc + globalShift + (Number.isFinite(offset) ? offset : 0);
    const parts = name.match(/^(start|end)-(year|mon|day|hour|min|sec)$/);
    if (parts) {
      const date = new Date(at * 1000);
      const field = parts[2];
      if (field === 'year') return String(date.getFullYear());
      if (field === 'mon') return pad(date.getMonth() + 1);
      if (field === 'day') return pad(date.getDate());
      if (field === 'hour') return pad(date.getHours());
      if (field === 'min') return pad(date.getMinutes());
      return pad(date.getSeconds());
    }
    switch (name) {
      case 'utc': case 'start': case 'utcend': case 'end':
        return String(Math.floor(at));
      case 'start_iso': case 'end_iso':
        return isoUtc(at);
      case 'timestamp': case 'current_utc': case 'lutc':
        return String(Math.floor(nowSeconds));
      case 'now_iso':
        return isoUtc(nowSeconds);
      case 'offset':
        return String(Math.max(0, Math.floor(nowSeconds - at)));
      case 'token': case 'key':
        if (token) return encodeURIComponent(token);
        break;
    }
    unresolved = true;
    return match;
  });
  return unresolved ? null : text;
}

// Image playlist (EXT-X-IMAGES-ONLY): one entry per image, optionally a tile sheet.
interface ImageSegment {
  start: number;
  duration: number;
  url: string;
  tiles: { w: number; h: number; cols: number; rows: number; each: number } | null;
}

function hlsAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) out[match[1]] = match[2].replace(/^"|"$/g, '');
  return out;
}

function size(value: string | undefined): { w: number; h: number } | null {
  const match = (value || '').match(/^(\d+)x(\d+)$/i);
  return match ? { w: parseInt(match[1], 10), h: parseInt(match[2], 10) } : null;
}

/** The image playlist URI in an HLS master whose thumbnail width is closest to
 *  `width`, or '' when the master lists no image stream. */
export function pickHlsImageStream(master: string, masterUrl: string, width: number): string {
  let best = '';
  let bestScore = Infinity;
  for (const line of master.split(/\r?\n/)) {
    if (line.indexOf('#EXT-X-IMAGE-STREAM-INF:') !== 0) continue;
    const attrs = hlsAttrs(line.slice(line.indexOf(':') + 1));
    if (!attrs.URI) continue;
    const res = size(attrs.RESOLUTION);
    const score = res ? Math.abs(res.w - width) : width;
    if (score < bestScore) {
      bestScore = score;
      best = resolveUrl(attrs.URI, masterUrl);
    }
  }
  return best;
}

export function parseHlsImagePlaylist(text: string, url: string): ImageSegment[] {
  const out: ImageSegment[] = [];
  let start = 0;
  let duration = 0;
  let tiles: ImageSegment['tiles'] = null;
  let gap = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf('#EXTINF:') === 0) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.indexOf('#EXT-X-TILES:') === 0) {
      const attrs = hlsAttrs(line.slice(13));
      const res = size(attrs.RESOLUTION);
      const layout = size(attrs.LAYOUT);
      const each = parseFloat(attrs.DURATION) || 0;
      tiles = res && layout && each > 0
        ? { w: res.w, h: res.h, cols: layout.w, rows: layout.h, each }
        : null;
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line[0] !== '#') {
      if (!gap && duration > 0) out.push({ start, duration, url: resolveUrl(line, url), tiles });
      start += duration;
      duration = 0;
      tiles = null;
      gap = false;
    }
  }
  return out;
}

function tileCandidate(
  url: string,
  offset: number,
  each: number,
  grid: { w: number; h: number; cols: number; rows: number },
): Candidate {
  const index = Math.max(0, Math.min(grid.cols * grid.rows - 1, Math.floor(offset / each)));
  return {
    url,
    tile: {
      x: (index % grid.cols) * grid.w,
      y: Math.floor(index / grid.cols) * grid.h,
      w: grid.w,
      h: grid.h,
    },
    width: grid.w * grid.cols,
    height: grid.h * grid.rows,
  };
}

function imageSegmentCandidate(segments: ImageSegment[], t: number): Candidate | null {
  for (const seg of segments) {
    if (t < seg.start || t >= seg.start + seg.duration) continue;
    if (!seg.tiles) return { url: seg.url, tile: null, width: 0, height: 0 };
    return tileCandidate(seg.url, t - seg.start, seg.tiles.each, seg.tiles);
  }
  return null;
}

function vttSeconds(value: string): number {
  const parts = value.split(':').map(parseFloat);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

interface VttCue { start: number; end: number; url: string; tile: SeekThumbnail['tile'] }

/** A WebVTT thumbnail sidecar: cue payloads are image URLs (relative to the
 *  VTT), optionally cropped with `#xywh=x,y,w,h`. */
export function parseThumbnailVtt(text: string, url: string): VttCue[] {
  const out: VttCue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timing = lines.findIndex(line => line.indexOf('-->') >= 0);
    if (timing < 0) continue;
    const match = lines[timing].match(/([\d:.]+)\s+-->\s+([\d:.]+)/);
    const payload = (lines[timing + 1] || '').trim();
    if (!match || !payload) continue;
    const hash = payload.indexOf('#');
    const image = hash >= 0 ? payload.slice(0, hash) : payload;
    const xywh = payload.slice(hash + 1).match(/^xywh=(\d+),(\d+),(\d+),(\d+)$/);
    out.push({
      start: vttSeconds(match[1]),
      end: vttSeconds(match[2]),
      url: resolveUrl(image, url),
      tile: hash >= 0 && xywh ? {
        x: parseInt(xywh[1], 10), y: parseInt(xywh[2], 10),
        w: parseInt(xywh[3], 10), h: parseInt(xywh[4], 10),
      } : null,
    });
  }
  return out;
}

function isVttTemplate(template: string): boolean {
  return /\.vtt(?:[?#]|$)/i.test(template) && !/\{/.test(template);
}

function isHls(source: SeekPreviewSource): boolean {
  return /mpegurl/i.test(source.mime) || /\.m3u8(?:[?#]|$)/i.test(source.streamUrl);
}

function isDash(source: SeekPreviewSource): boolean {
  return /dash\+xml/i.test(source.mime) || /\.mpd(?:[?#]|$)/i.test(source.streamUrl);
}

function fetchManifest(url: string, signal: AbortSignal): Promise<string> {
  return fetchLimitedText(url, CONFIG.PLAYER.MPD_MAX_BYTES, CONFIG.PLAYER.SEEK_PREVIEW_FETCH_TIMEOUT, signal);
}

function utcProvider(
  name: SeekPreviewProviderName,
  template: string,
  source: SeekPreviewSource,
  now: () => number,
): Provider | null {
  const utcAt = source.utcAt;
  if (!template || !utcAt) return null;
  const token = queryParam(source.streamUrl, 'token');
  // Whether a placeholder resolves never depends on the time, so one probe
  // tells an unusable template apart and leaves the next source to try.
  if (expandSeekPreviewTemplate(template, 0, 0, token) === null) {
    log.info('Seek preview source unusable', 'event=seek.preview.failed', `source=${name}`, 'reason=template');
    return null;
  }
  return {
    name,
    candidate: t => {
      const utc = Math.floor(utcAt(t) / UTC_STEP) * UTC_STEP;
      const nowSec = now() / 1000;
      const url = expandSeekPreviewTemplate(template, utc, nowSec, token);
      return url ? { url, tile: null, width: 0, height: 0, fresh: nowSec - utc < LIVE_EDGE_GRACE } : null;
    },
  };
}

function vttProvider(vttUrl: string): Provider {
  let cues: VttCue[] = [];
  return {
    name: 'vtt',
    init: async signal => {
      cues = parseThumbnailVtt(await fetchManifest(vttUrl, signal), vttUrl);
      return cues.length > 0;
    },
    candidate: t => {
      const cue = cues.find(c => t >= c.start && t < c.end);
      return cue ? { url: cue.url, tile: cue.tile, width: 0, height: 0 } : null;
    },
  };
}

export function buildProviders(source: SeekPreviewSource, now: () => number = Date.now): Provider[] {
  const out: Provider[] = [];
  const add = (provider: Provider | null) => { if (provider) out.push(provider); };
  // VTT cue times are media time, which a sliding DVR window does not keep.
  if (source.template && isVttTemplate(source.template)) {
    if (!source.live) add(vttProvider(source.template));
  } else {
    add(utcProvider('template', source.template, source, now));
  }
  add(utcProvider('flussonic', flussonicPreviewTemplate(source.streamUrl, source.catchupType), source, now));
  add(utcProvider('nimble', nimblePreviewTemplate(source.streamUrl), source, now));
  if (!source.live && isHls(source)) {
    let segments: ImageSegment[] = [];
    add({
      name: 'hls',
      init: async signal => {
        const playlist = pickHlsImageStream(
          await fetchManifest(source.streamUrl, signal), source.streamUrl, CONFIG.PLAYER.SEEK_PREVIEW_WIDTH);
        if (!playlist) return false;
        segments = parseHlsImagePlaylist(await fetchManifest(playlist, signal), playlist);
        return segments.length > 0;
      },
      candidate: t => imageSegmentCandidate(segments, t),
    });
  }
  if (!source.live && isDash(source)) {
    let track: ReturnType<typeof parseMpdImageTrack> = null;
    add({
      name: 'dash',
      init: async signal => {
        track = parseMpdImageTrack(
          await fetchManifest(source.streamUrl, signal), source.streamUrl, CONFIG.PLAYER.SEEK_PREVIEW_WIDTH);
        return !!track;
      },
      candidate: t => {
        if (!track) return null;
        const sheet = track.sheetsAt(t).find(s => t >= s.start && t < s.start + s.duration);
        if (!sheet) return null;
        const grid = {
          w: Math.floor(track.width / track.cols),
          h: Math.floor(track.height / track.rows),
          cols: track.cols,
          rows: track.rows,
        };
        return tileCandidate(sheet.url, t - sheet.start, sheet.duration / (track.cols * track.rows), grid);
      },
    });
  }
  return out;
}

/** Seek-bar preview frames for the current playback. Tries each provider that
 *  fits the stream in order, keeps the first that serves an image, and asks
 *  for a repaint whenever a requested frame finishes loading. */
export class SeekPreview {
  private providers: Provider[] = [];
  private index = 0;
  private ready = false;
  private initializing = false;
  private confirmed = false;
  private misses = 0;
  private tried: SeekPreviewProviderName[] = [];
  private loaded = new Map<string, { width: number; height: number }>();
  private failed = new Set<string>();
  private wanted: number | null = null;
  private shown: SeekThumbnail | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading = false;
  private abort: AbortController | null = null;
  private generation = 0;

  constructor(
    private onUpdate: () => void,
    private loader: ImageLoader = loadImage,
  ) {}

  start(source: SeekPreviewSource | null): void {
    this.stop();
    this.providers = source ? buildProviders(source) : [];
    if (source) {
      log.info('Seek preview sources', 'event=seek.preview.sources',
        `sources=${this.providers.map(p => p.name).join(',') || 'none'}`, `live=${source.live}`);
    }
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.providers = [];
    this.index = 0;
    this.ready = false;
    this.initializing = false;
    this.loading = false;
    this.confirmed = false;
    this.misses = 0;
    this.tried = [];
    this.loaded.clear();
    this.failed.clear();
    this.wanted = null;
    this.shown = null;
  }

  /** The frame to show for media time `t`: the loaded frame for `t`, else the
   *  last one shown while `t`'s frame loads. Null drops the request. */
  thumbnailAt(t: number | null): SeekThumbnail | null {
    if (t === null || !this.providers.length) {
      this.wanted = null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.shown = null;
      return null;
    }
    if (this.wanted !== t) {
      this.wanted = t;
      const immediate = this.ready ? this.resolveCached(t) : null;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (immediate) {
        this.shown = immediate;
      } else {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.lookup();
        }, CONFIG.PLAYER.SEEK_PREVIEW_DEBOUNCE);
      }
    }
    return this.shown;
  }

  private provider(): Provider | null {
    return this.providers[this.index] ?? null;
  }

  private resolveCached(t: number): SeekThumbnail | null {
    const candidate = this.provider()?.candidate(t);
    const size = candidate && this.loaded.get(candidate.url);
    return candidate && size ? this.thumbnail(candidate, size) : null;
  }

  private thumbnail(candidate: Candidate, size: { width: number; height: number }): SeekThumbnail {
    return {
      url: candidate.url,
      tile: candidate.tile,
      width: candidate.width || size.width,
      height: candidate.height || size.height,
    };
  }

  private lookup(): void {
    const t = this.wanted;
    const provider = this.provider();
    if (t === null || !provider) return;
    if (!this.ready) {
      void this.initProvider(provider);
      return;
    }
    const candidate = provider.candidate(t);
    if (!candidate || this.failed.has(candidate.url)) {
      this.show(null);
      return;
    }
    const size = this.loaded.get(candidate.url);
    if (size) {
      this.show(this.thumbnail(candidate, size));
      return;
    }
    // One image at a time: a held key would otherwise queue stale frames
    // ahead of the one the user stopped on.
    if (this.loading) return;
    this.loading = true;
    const generation = this.generation;
    const index = this.index;
    const stale = () => this.wanted === null || provider.candidate(this.wanted)?.url !== candidate.url;
    this.loader(candidate.url).then(loadedSize => {
      if (generation !== this.generation) return;
      this.loading = false;
      if (index !== this.index) return;
      this.loaded.set(candidate.url, loadedSize);
      this.misses = 0;
      if (!this.confirmed) {
        this.confirmed = true;
        log.info('Seek preview source', 'event=seek.preview.source', `source=${provider.name}`);
      }
      this.lookup();
    }, () => {
      if (generation !== this.generation) return;
      this.loading = false;
      if (index !== this.index) return;
      // A frame the user already moved past, or one the server may not have
      // made yet this close to now, says nothing about the source.
      if (stale() || candidate.fresh) {
        if (stale()) this.lookup();
        else this.show(null);
        return;
      }
      this.failed.add(candidate.url);
      this.misses++;
      if (!this.confirmed || this.misses >= MAX_MISSES) {
        this.next('image');
        return;
      }
      this.show(null);
    });
  }

  private async initProvider(provider: Provider): Promise<void> {
    if (this.initializing) return;
    if (!provider.init) {
      this.ready = true;
      this.lookup();
      return;
    }
    this.initializing = true;
    const generation = this.generation;
    this.abort = new AbortController();
    let ok = false;
    try {
      ok = await provider.init(this.abort.signal);
    } catch {
      ok = false;
    }
    if (generation !== this.generation) return;
    this.initializing = false;
    this.abort = null;
    if (!ok) {
      this.next('manifest');
      return;
    }
    this.ready = true;
    this.lookup();
  }

  private next(reason: 'image' | 'manifest'): void {
    const provider = this.provider();
    if (provider) {
      this.tried.push(provider.name);
      if (provider.name !== 'hls' && provider.name !== 'dash' || reason !== 'manifest') {
        log.info('Seek preview source failed', 'event=seek.preview.failed',
          `source=${provider.name}`, `reason=${reason}`);
      }
    }
    this.index++;
    this.ready = false;
    this.confirmed = false;
    this.misses = 0;
    this.failed.clear();
    this.show(null);
    if (this.provider()) this.lookup();
    else log.info('Seek preview unavailable', 'event=seek.preview.exhausted', `tried=${this.tried.join(',')}`);
  }

  private show(thumbnail: SeekThumbnail | null): void {
    const changed = this.shown?.url !== thumbnail?.url || this.shown?.tile !== thumbnail?.tile;
    this.shown = thumbnail;
    if (changed) this.onUpdate();
  }
}
