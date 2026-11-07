import type { AudioOption, HeaderPlayback, ManifestAudio, ManifestClosedCaption, ManifestSubtitle, SubtitleOption } from '../types';
import { CONFIG } from '../config';
import { getCachedStreamMime, setCachedStreamMime } from '../services/idb-cache';
import { parseMpd, type MpdManifest } from '../parsers/mpd-manifest';
import {
  parseDrmConfig,
  isShakaDrmConfig,
  type DrmConfig,
  type PlayReadyConfig,
  type ShakaDrmConfig,
} from '../services/drm-config';
import { PlayReadyDrm } from '../services/playready-drm';
import { loadShaka, type ShakaNamespaceLike } from '../services/shaka-loader';
import { fetchManifestViaService } from '../services/manifest-service';
import { StorageService } from '../services/storage-service';
import {
  closeStreamProxy,
  openStreamProxy,
  touchStreamProxy,
  type StreamProxyCookies,
  type StreamProxyResult,
  type StreamProxyStatus,
} from '../services/proxy-service';
import { parseAudioRenditions } from '../utils/audio-tracks';
import { FetchTextError, fetchFailureReason, fetchLimitedText } from '../utils/fetch-helper';
import { getLenientLoaders } from '../utils/hls-stable-loader';
import { createLogger } from '../utils/logger';
import { isWebOS } from '../utils/platform';
import {
  hasLunaHeaders,
  hasOnlyUserAgent,
  lunaHeaderNames,
  tlsUnsafeHeaderNames,
  withoutHeaders,
  type LunaDisplay,
} from '../services/luna-media';
import { LunaMediaElement, type LunaAudioTrack, type LunaFallbackReason } from './luna-media-element';
import { parseClosedCaptions, parseSubtitleRenditions } from '../utils/subtitle-tracks';
import { parseVariants, type StreamVariant } from '../utils/stream-info';
import { mediaOptionSourceType } from '../utils/webos-media-option';
import { createHlsEngine } from './mse/hls-engine';
import type { MseEngine, PipelineStreamInfo } from './mse/engine';
import { createShakaEngine, type ShakaPlayerLike } from './mse/shaka-engine';
import {
  containerMime,
  sniffStreamContentType,
  isMpdText,
  mpdOpeningVerdict,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';

const log = createLogger('Player');


// Desktop HLS/MPEG-TS libraries are globals from preview-libs.js. Shaka is also
// a global, but webOS loads its separate bundle only for Widevine/ClearKey.
const win = window as unknown as Record<string, unknown>;

type LunaRouteReason = 'url' | 'cache' | 'probe' | 'guess' | 'ua_only';

// How far a channel with HTTP headers escalates when a step fails to start:
// the element, then Media service, then the loopback proxy.
type ChainStep = 'video' | 'luna' | 'proxy';

// How loadSource came to this URL: the chain step it plays, and for the
// loopback proxy, whose session-specific URL stands for it, the channel's own.
interface SourceRoute {
  step: ChainStep;
  original?: string;
}

interface HeaderChain {
  token: number;
  url: string;
  key: string;
  extras: Record<string, string> | null;
  opts: PipelineLoadOptions | undefined;
  // The steps the setting allows and the channel can use, in order.
  steps: ChainStep[];
  step: ChainStep;
  tried: ChainStep[];
  startedAt: number;
  won: boolean;
  // The first step whose manifest read got a 2xx, and each step's failed status.
  manifestOk: ChainStep | '';
  manifestFailed: Partial<Record<ChainStep, number>>;
  manifestOnceLogged: boolean;
  // A proxy step's upstream status was read before the element's turn.
  upstreamChecked: boolean;
}

// A manifest as read: its text, its final URL, and whether only the service could read it.
interface ManifestRead {
  text: string;
  baseUrl: string;
  viaService: boolean;
}

interface LunaDash {
  extras: Record<string, string> | null;
  clientId: string;
  // The header-less MPD read; null when it failed, so its DRM is unknown.
  parsed: MpdManifest | null;
  read: ManifestRead | null;
  // clientId is a guessed PlayReady client, tried after a clear load failed for this reason.
  guessedAfter?: LunaFallbackReason;
  // This load is the one PlayReady retry; its clear failure is already recorded.
  retry?: boolean;
}

const DETECTED_PLAYREADY: PlayReadyConfig = {
  type: 'playready',
  licenseUrl: '',
  customData: '',
  unsupportedOptions: [],
};

// Why a configured DRM keeps a header channel off Luna: only DASH with
// PlayReady, which UMS decrypts itself, can load there.
function lunaDrmSkip(drm: DrmConfig | null, format: 'hls' | 'dash'): string {
  if (!drm) return '';
  if (format !== 'dash') return 'drm';
  if (drm.type === 'playready') return '';
  return drm.type === 'unsupported' ? 'drm_unsupported' : 'drm_mse';
}

type HlsType = typeof import('hls.js').default;
type MpegtsType = typeof import('mpegts.js').default;

interface ShakaError {
  category?: number;
  code?: number;
  data?: unknown[];
  severity?: number;
}

interface ShakaRequest {
  headers: Record<string, string>;
}

interface ShakaPlayerRuntime extends ShakaPlayerLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  attach(video: HTMLVideoElement): Promise<void>;
  configure(config: Record<string, unknown>): boolean;
  getNetworkingEngine(): {
    registerRequestFilter(filter: (type: number, request: ShakaRequest) => void): void;
  } | null;
  load(url: string): Promise<void>;
  getDrmInfo?(): { keySystem: string } | null;
}

function shakaErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return 'code=unknown';
  const detail = error as ShakaError;
  return `category=${typeof detail.category === 'number' ? detail.category : 'unknown'}`
    + ` code=${typeof detail.code === 'number' ? detail.code : 'unknown'}`;
}

interface ShakaNamespace extends ShakaNamespaceLike {
  Player: {
    new(): ShakaPlayerRuntime;
    isBrowserSupported?: () => boolean;
  };
  net?: {
    NetworkingEngine?: {
      RequestType?: {
        LICENSE?: number;
      };
    };
  };
  util: {
    Error: {
      Severity: {
        CRITICAL: number;
      };
      Code?: {
        BAD_HTTP_STATUS?: number;
        LICENSE_REQUEST_FAILED?: number;
        LICENSE_RESPONSE_REJECTED?: number;
      };
    };
  };
}

function isPermanentShakaLicenseError(error: unknown, shaka: ShakaNamespace): boolean {
  const detail = error as ShakaError | null;
  const codes = shaka.util.Error.Code;
  if (!detail || !codes) return false;
  const responseRejected = codes.LICENSE_RESPONSE_REJECTED;
  const requestFailed = codes.LICENSE_REQUEST_FAILED;
  const badHttpStatus = codes.BAD_HTTP_STATUS;
  if (typeof responseRejected === 'number' && detail.code === responseRejected) return true;
  if (typeof requestFailed !== 'number' || detail.code !== requestFailed ||
      typeof badHttpStatus !== 'number') return false;
  const networkError = detail.data?.[0] as ShakaError | undefined;
  if (!networkError || networkError.code !== badHttpStatus) return false;
  const status = networkError.data?.[1];
  return status === 401 || status === 403;
}

export interface PipelineManifest {
  audio: ManifestAudio[];
  subtitles: ManifestSubtitle[];
  closedCaptions: ManifestClosedCaption[];
  variants: StreamVariant[];
  masterUrl: string;
  /** The master or MPD at masterUrl, when only the bundled service could read it. */
  masterText?: string;
}

export interface PipelineLoadOptions {
  direct?: boolean;
  /** Every HTTP header the channel declares (see channelHttpHeaders). */
  headers?: Record<string, string>;
  /** A recovery reload of the same play, which keeps its Luna fallbacks. */
  reload?: boolean;
}

export interface PlayerPipelineOptions {
  playbackLabel: (loadToken: number) => string;
  mediaState: (video: HTMLVideoElement) => string;
  isCatchup: () => boolean;
  /** The HTTP headers setting, read per load. */
  headerPlayback: () => HeaderPlayback;
  onError: (reason?: 'unsupported') => void;
  onAudioTracksUpdated: () => void;
  onSubtitleTracksUpdated: () => void;
  onManifest: (manifest: PipelineManifest) => void;
  /** Playback moved between Luna and the element mid-load; clocked renderers must restart. */
  onPlaybackPathChange: () => void;
  /** A stream that had played moved to a step that has not: it counts as unstarted again. */
  onStepRestarted?: () => void;
  /** The current load's proxy session expired under it. */
  onProxyExpired?: () => void;
}

// Node's HTTP client sends no User-Agent of its own, and many origins refuse
// a request without one, so the service sends the TV's unless the channel sets it.
function withDefaultUserAgent(headers: Record<string, string>): Record<string, string> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (!ua || Object.keys(headers).some(name => name.toLowerCase() === 'user-agent')) return headers;
  const out: Record<string, string> = {};
  Object.keys(headers).forEach(name => { out[name] = headers[name]; });
  out['User-Agent'] = ua;
  return out;
}

class UrlCredentialsError extends Error {}

function hasUrlCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return !!(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

// The service's Node 0.12 url.parse sends a non-ASCII path as raw bytes.
function serviceRequestUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export class PlayerPipeline {
  private videoEl: HTMLVideoElement | null = null;
  private hls: InstanceType<HlsType> | null = null;
  private mpegtsPlayer: { destroy(): void } | null = null;
  private engine: MseEngine | null = null;
  private engineTeardown: { promise: Promise<void>; label: string } | null = null;
  private msePending = false;
  private loadToken = 0;
  private hlsRecoveries = 0;
  private manifestSeq = 0;
  private manifestController: AbortController | null = null;
  private videoLoadLabels = new WeakMap<HTMLVideoElement, string>();
  private playReadyDrm = new PlayReadyDrm();
  private activeDrm = '';
  private luna: LunaMediaElement | null = null;
  // Bumped when a newer source takes the element, whose load() aborts the
  // pending play() of the one before.
  private nativePlaySeq = 0;
  private lunaDisplay: LunaDisplay = 'full';
  private lunaUrl = '';
  // A User-Agent-only HLS load on the element, which Luna may retry once.
  private uaRetry: {
    url: string;
    headers: Record<string, string>;
    extras: Record<string, string> | null;
    token: number;
    mime: string;
  } | null = null;
  // Streams that fell back once stay on <video> for the rest of the session.
  private lunaFailed = new Set<string>();
  private lunaTransientFailures = new Map<string, number>();
  // Streams that fell back during this play: its reloads stay on <video>
  // rather than spend another Luna deadline.
  private lunaFellBack = new Set<string>();
  private lunaNoWindows = 0;
  private lunaOff = false;
  // MPDs unreadable without headers that played on a guessed PlayReady client,
  // with the clear failure that led to the guess.
  private lunaPlayReadyUrls = new Map<string, LunaFallbackReason>();
  // The load whose Luna start waits on its MPD read or a PlayReady client.
  private lunaPreparing = -1;
  private lunaSkipToken = -1; // one playback.luna.skipped event per load
  private headersOffToken = -1;
  private proxyToken = '';
  // The held session's load label and the cookies its jar refused so far.
  private proxySession: { label: string; cookies: StreamProxyCookies } | null = null;
  private proxyTouchTimer: ReturnType<typeof setInterval> | null = null;
  // The failed proxy step's status read, which its session must outlive.
  private proxyStatusPending: Promise<StreamProxyStatus | null> | null = null;
  // The load whose proxy step waits on a teardown or a session open.
  private proxyStarting = -1;
  // A session opened while Luna tries the same load, ready if Luna fails.
  private proxyOpen: { token: number; promise: Promise<StreamProxyResult> } | null = null;
  private chain: HeaderChain | null = null;
  // The step that played each channel after an earlier one failed.
  private chainWinners = new Map<string, ChainStep>();

  constructor(private callbacks: PlayerPipelineOptions) {}

  setVideoElement(videoEl: HTMLVideoElement): void {
    if (this.videoEl !== videoEl) this.engineTeardown = null;
    this.videoEl = videoEl;
  }

  currentLoadToken(): number {
    return this.loadToken;
  }

  videoLabel(el: HTMLVideoElement): string {
    return this.videoLoadLabels.get(el) ?? this.callbacks.playbackLabel(this.loadToken);
  }

  // "An MSE library owns the tracks" — hls.js in preview or Shaka on either path.
  isMseActive(): boolean {
    return this.engine !== null || this.msePending;
  }

  mseAudioOptions(): AudioOption[] {
    return this.engine?.audioOptions() ?? [];
  }

  setMseAudioTrack(index: number): boolean {
    return this.engine?.setAudioTrack(index) ?? false;
  }

  mseSubtitleOptions(): SubtitleOption[] {
    return this.engine?.subtitleOptions() ?? [];
  }

  setMseSubtitleTrack(index: number): boolean {
    return this.engine?.setSubtitleTrack(index) ?? false;
  }

  /** The current load would have sent its headers, but HTTP headers is Off. */
  headersTurnedOff(): boolean {
    return this.headersOffToken === this.loadToken;
  }

  /** A header-carrying stream plays through com.webos.media, not the element. */
  isLunaActive(): boolean {
    return this.luna !== null;
  }

  /** A Luna load that has not played yet; its own deadline falls back. */
  isLunaStarting(): boolean {
    return this.luna?.isStarting() ?? false;
  }

  /** Luna is about to start once its MPD is read or its PlayReady client is ready. */
  isLunaPending(): boolean {
    return this.lunaPreparing === this.loadToken;
  }

  /** The stream Luna plays; the element itself holds only the placeholder. */
  lunaStreamUrl(): string {
    return this.luna ? this.lunaUrl : '';
  }

  /** Luna's playback clock; the element's own media time is the placeholder's. */
  lunaClock(): (() => number) | null {
    const luna = this.luna;
    const videoEl = this.videoEl;
    if (!luna || !videoEl) return null;
    return () => (this.luna === luna ? luna.clockTime() : videoEl.currentTime);
  }

  /** UMS's audio renditions on Luna; the element's own are the placeholder's. */
  lunaAudioTracks(): LunaAudioTrack[] {
    return this.luna?.audioTracks() ?? [];
  }

  selectLunaAudio(index: number): Promise<boolean> {
    return this.luna ? this.luna.selectAudio(index) : Promise.resolve(false);
  }

  /** The Luna pipeline's own mediaId once it loaded; empty before, or off Luna. */
  lunaMediaId(): string {
    return this.luna?.isLoaded() ? this.luna.mediaId : '';
  }

  /** Where the Luna picture goes; the element's own rect does not move it. */
  setLunaDisplay(display: LunaDisplay): void {
    this.lunaDisplay = display;
    this.luna?.setDisplay(display);
  }

  streamInfo(): PipelineStreamInfo | null {
    return this.engine?.streamInfo() ?? null;
  }

  drmLabel(): string {
    return this.activeDrm;
  }

  load(url: string, extras: Record<string, string> | null, opts?: PipelineLoadOptions): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const token = ++this.loadToken;
    const label = this.callbacks.playbackLabel(token);
    this.uaRetry = null;
    if (!opts?.reload) this.lunaFellBack.clear();
    this.cancelManifest();
    this.destroyLoaders();
    // The old session's source leaves before the session closes, so its
    // refused requests do not fail the new load.
    if (this.proxyToken) this.detachSource(videoEl);
    this.closeProxy();
    this.dropProxyOpen();
    this.chain = this.planChain(url, extras, token, opts);
    this.videoLoadLabels.set(videoEl, label);
    this.playReadyDrm.release();
    this.activeDrm = '';

    const teardown = this.engineTeardown;
    const queuedAt = Date.now();
    const isCurrent = () => {
      if (token === this.loadToken && videoEl === this.videoEl) return true;
      if (teardown) {
        log.info('Queued playback cancelled', 'event=playback.mse.teardown.cancelled',
          label, `owner=(${teardown.label})`, `elapsedMs=${Date.now() - queuedAt}`,
          `reason=${token !== this.loadToken ? 'superseded' : 'video_replaced'}`);
      }
      return false;
    };
    const start = () => {
      if (!isCurrent()) return;
      if (teardown) {
        log.info('Playback resuming after MSE teardown', 'event=playback.mse.teardown.resumed',
          label, `owner=(${teardown.label})`, `elapsedMs=${Date.now() - queuedAt}`);
      }
      this.msePending = false;
      this.startChain(url, extras, token, opts);
    };
    if (teardown) {
      this.msePending = true;
      log.info('Playback waiting for MSE teardown', 'event=playback.mse.teardown.wait',
        label, `owner=(${teardown.label})`);
      void teardown.promise.then(start, error => {
        if (!isCurrent()) return;
        this.msePending = false;
        log.warn('Playback blocked by failed MSE teardown',
          'event=playback.mse.teardown.blocked', label, `owner=(${teardown.label})`,
          `elapsedMs=${Date.now() - queuedAt}`, shakaErrorDetail(error));
        this.callbacks.onError();
      });
    } else {
      start();
    }
  }

  private loadSource(
    url: string,
    extras: Record<string, string> | null,
    token: number,
    opts?: PipelineLoadOptions,
    route?: SourceRoute,
  ): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const urlMime = streamUrlMime(url);
    const isTsUrl = urlMime === 'video/mp2t';
    const isFlvUrl = urlMime === 'video/x-flv';
    const isHlsUrl = urlMime === 'application/vnd.apple.mpegurl';
    const isDashUrl = urlMime === 'application/dash+xml';

    // webOS: the TV's hardware HLS/TS decoders beat MSE libraries, so play
    // natively. Explicit extensions and previously verified routes avoid a
    // probe; only a cold ambiguous route pays the bounded classification cost.
    if (isWebOS()) {
      if (opts?.direct) {
        const mime = containerMime(url);
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token),
          'reason=direct', '| webOS native VOD | MIME', mime || '(sniffed)');
        this.playNative(url, mime);
        return;
      }
      const headers = opts?.headers ?? {};
      // A User-Agent channel that played on Luna before starts there.
      const lunaUa = this.chainFor(token)?.step === 'luna' && hasOnlyUserAgent(headers);
      const lunaHeaders = isHlsUrl || isDashUrl
        ? this.lunaHeaders(url, headers, extras, token, lunaUa, isDashUrl ? 'dash' : 'hls') : null;
      if (lunaHeaders) {
        if (isDashUrl) this.loadLunaDash(url, lunaHeaders, extras, token, 'url');
        else this.loadLuna(url, lunaHeaders, token, 'url');
        return;
      }
      if (isTsUrl || isFlvUrl || isHlsUrl || isDashUrl) {
        const mime = isFlvUrl ? 'video/x-flv'
          : isTsUrl ? 'video/mp2t'
          : isDashUrl ? 'application/dash+xml'
          : 'application/vnd.apple.mpegurl';
        if (!isHlsUrl && !isDashUrl) this.noteLunaSkip(token, headers, 'non_hls');
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token), ...this.viaProxy(token),
          'reason=url', '| webOS native | catchup:', this.callbacks.isCatchup(), '| MIME', mime);
        if (isDashUrl) {
          this.rememberUaRetry(url, headers, extras, token, mime);
          this.loadNativeDash(url, extras, token);
          return;
        }
        if (isHlsUrl) {
          this.rememberUaRetry(url, headers, extras, token, mime);
          void this.loadManifest(url, this.manifestSeq, token);
        }
        this.playNativeMime(url, mime);
        return;
      }
      // A proxy URL's token changes per play; the route belongs to the channel's URL.
      const routeKey = streamRouteKey(route?.original ?? url);
      void getCachedStreamMime(routeKey).then(cachedMime => {
        if (token !== this.loadToken || !this.videoEl) return;
        const cachedDash = cachedMime === 'application/dash+xml';
        const cachedLunaHeaders = cachedMime === 'application/vnd.apple.mpegurl' || cachedDash
          ? this.lunaHeaders(url, headers, extras, token, lunaUa, cachedDash ? 'dash' : 'hls') : null;
        if (cachedLunaHeaders) {
          if (cachedDash) this.loadLunaDash(url, cachedLunaHeaders, extras, token, 'cache');
          else this.loadLuna(url, cachedLunaHeaders, token, 'cache');
          return;
        }
        if (cachedMime) {
          if (cachedMime !== 'application/vnd.apple.mpegurl' && !cachedDash) {
            if (this.toProxy(token, 'non_hls')) return;
            this.noteLunaSkip(token, headers, 'non_hls');
          }
          // A Luna step that skipped the stream hands it to the proxy, not the bare element.
          if (this.toProxy(token, 'luna_skipped')) return;
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token), ...this.viaProxy(token),
            'reason=cache', '| webOS native | cached MIME', cachedMime,
            '| catchup:', this.callbacks.isCatchup());
          if (cachedMime === 'application/vnd.apple.mpegurl') {
            this.rememberUaRetry(url, headers, extras, token, cachedMime);
            void this.loadManifest(url, this.manifestSeq, token);
          } else if (cachedDash) {
            this.rememberUaRetry(url, headers, extras, token, cachedMime);
            this.loadNativeDash(url, extras, token);
            return;
          }
          this.playNativeMime(url, cachedMime);
          return;
        }
        void this.detectContentType(url, token).then(contentType => {
          if (token !== this.loadToken || !this.videoEl) return;
          const mime = streamMime(contentType);
          if (routeKey && contentType &&
              contentType.split(';')[0].trim() !== 'application/octet-stream') {
            void setCachedStreamMime(routeKey, mime);
          }
          // A header-protected server often refuses the header-less probe, so an
          // unknown type tries Luna too; its fallback covers a wrong guess.
          const probedDash = mime === 'application/dash+xml';
          const probedLunaHeaders = mime === 'application/vnd.apple.mpegurl' || !contentType || probedDash
            ? this.lunaHeaders(url, headers, extras, token, lunaUa, probedDash ? 'dash' : 'hls') : null;
          if (probedLunaHeaders) {
            if (probedDash) this.loadLunaDash(url, probedLunaHeaders, extras, token, 'probe');
            else this.loadLuna(url, probedLunaHeaders, token, contentType ? 'probe' : 'guess', mime);
            return;
          }
          if (contentType && mime !== 'application/vnd.apple.mpegurl' && !probedDash
              && this.toProxy(token, 'non_hls')) return;
          if (this.toProxy(token, 'luna_skipped')) return;
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token), ...this.viaProxy(token),
            'reason=probe', '| webOS native | content-type:', contentType || '(none)',
            '| catchup:', this.callbacks.isCatchup(), '| MIME', mime || '(auto)');
          if (contentType && mime !== 'application/vnd.apple.mpegurl' && !probedDash) {
            this.noteLunaSkip(token, headers, 'non_hls');
          }
          if (mime === 'application/vnd.apple.mpegurl' || !contentType || probedDash) {
            this.rememberUaRetry(url, headers, extras, token, mime);
          }
          if (mime === 'application/vnd.apple.mpegurl') {
            void this.loadManifest(url, this.manifestSeq, token);
          } else if (mime === 'application/dash+xml') {
            this.loadNativeDash(url, extras, token);
            return;
          }
          this.playNativeMime(url, mime);
        });
      });
      return;
    }

    // Desktop preview: native HLS is unreliable across Chrome/Firefox/Linux, so
    // always route through hls.js/mpegts.js. URL extensions lie — some providers
    // serve HLS with no .m3u8 suffix — so classify by the server's Content-Type,
    // falling back to the URL and defaulting to HLS.
    if (opts?.direct) {
      log.info('Selected direct playback', 'event=playback.path.direct',
        this.callbacks.playbackLabel(token),
        'reason=direct', '| desktop direct VOD');
      videoEl.src = url;
      videoEl.play().catch(e => log.warn('Direct play() rejected',
        'event=playback.play.rejected',
        this.callbacks.playbackLabel(token), 'path=direct', e));
      return;
    }
    void this.detectContentType(url, token).then(ct => {
      if (token !== this.loadToken || !this.videoEl) return;
      const isFlv = isFlvUrl || ct.includes('flv');
      const isTs = isTsUrl || ct.includes('mp2t');
      const isDash = !isTs && !isFlv &&
        (isDashUrl || ct.includes('dash+xml') || ct.includes('dash.mpd'));
      const isDirect = !isTs && !isFlv && !isDash && /^(?:video|audio)\//.test(ct);
      const isHls = !isTs && !isFlv && !isDash && !isDirect;
      log.info('loadStream', this.callbacks.playbackLabel(token),
        '| content-type:', ct || '(none)', '| catchup:', this.callbacks.isCatchup(),
        '| isHls:', isHls, '| isTs:', isTs, '| isFlv:', isFlv, '| isDash:', isDash);
      if (isTs || isFlv) {
        log.info('Selected mpegts.js playback', 'event=playback.path.mpegts',
          this.callbacks.playbackLabel(token), ...this.viaProxy(token),
          'reason=probe');
        this.loadWithMpegts(url, isFlv, token);
      } else if (isDash) {
        log.info('Selected Shaka playback', 'event=playback.path.dash',
          this.callbacks.playbackLabel(token), ...this.viaProxy(token),
          'reason=probe');
        const configured = parseDrmConfig(extras);
        if (configured?.type === 'unsupported') {
          log.warn('Unsupported DASH DRM', 'event=playback.dash.drm.unsupported',
            this.callbacks.playbackLabel(token), `type=${configured.value}`);
          this.callbacks.onError('unsupported');
          return;
        }
        this.loadWithShaka(
          url,
          token,
          isShakaDrmConfig(configured) ? configured : null,
        );
      } else if (isDirect) {
        log.info('Selected direct playback', 'event=playback.path.direct',
          this.callbacks.playbackLabel(token), ...this.viaProxy(token),
          'reason=probe');
        this.videoEl.src = url;
        this.videoEl.play().catch(e => log.warn('Direct play() rejected',
          'event=playback.play.rejected',
          this.callbacks.playbackLabel(token), 'path=direct', e));
      } else {
        log.info('Selected hls.js playback', 'event=playback.path.hls',
          this.callbacks.playbackLabel(token), ...this.viaProxy(token),
          'reason=probe');
        this.loadWithHls(url, extras, token);
      }
    });
  }

  destroy(): void {
    // Invalidate an in-flight content-type probe before tearing down loaders.
    // Its fetch may not be abortable on every target, so the load token is the
    // final guard against restarting playback after stop/suspend.
    this.loadToken++;
    this.cancelManifest();
    this.destroyLoaders();
    this.closeProxy();
    this.dropProxyOpen();
    this.playReadyDrm.release();
    this.activeDrm = '';
  }

  /** The current load plays through a loopback proxy session. */
  isProxied(): boolean {
    return this.proxyToken !== '';
  }

  /**
   * The current load's step failed to start: try the next step its HTTP
   * headers setting allows. False when none is left, or time ran out.
   */
  escalate(): boolean {
    const chain = this.chainFor(this.loadToken);
    if (!chain || chain.won || !this.videoEl) return false;
    // A Luna step that already handed the stream to the element.
    if (chain.step === 'luna' && !this.luna && this.lunaPreparing !== chain.token) {
      chain.step = 'video';
      if (chain.tried.indexOf('video') < 0) chain.tried.push('video');
    }
    this.reportStepFailure(chain);
    return this.advance(chain, 'startup');
  }

  /**
   * The current load escalates through header playback steps, or has only a
   * step that sends headers: a reload reruns either past HEADER_CHAIN_CAP_MS.
   */
  isHeaderChain(): boolean {
    const chain = this.chainFor(this.loadToken);
    return !!chain && (chain.steps.length > 1 || chain.steps[0] !== 'video')
      && this.callbacks.headerPlayback() !== 'off';
  }

  /** The current load has a step left to escalate to within HEADER_CHAIN_CAP_MS. */
  canEscalate(): boolean {
    const chain = this.chainFor(this.loadToken);
    return !!chain && !chain.won && this.nextStep(chain) !== null
      && Date.now() - chain.startedAt <= CONFIG.PLAYER.HEADER_CHAIN_CAP_MS;
  }

  /** A proxy step about to load, its session not open yet; the element sits detached. */
  isProxyPending(): boolean {
    return this.proxyStarting === this.loadToken;
  }

  /** The element played a frame; Luna reports its own start. */
  notePlaying(): void {
    const chain = this.chainFor(this.loadToken);
    if (!chain || this.luna || chain.step === 'luna') return;
    this.chainWon(chain);
  }

  private chainFor(token: number): HeaderChain | null {
    const chain = this.chain;
    return chain && chain.token === token ? chain : null;
  }

  private planChain(
    url: string,
    extras: Record<string, string> | null,
    token: number,
    opts: PipelineLoadOptions | undefined,
  ): HeaderChain | null {
    if (opts?.direct) return null;
    const headers = opts?.headers ?? {};
    const sendable = withoutHeaders(headers, tlsUnsafeHeaderNames(url, headers));
    // The element cannot send Referer, Cookie, or other headers; only the
    // proxy plays a URL with user:password the page refuses.
    const needsHeaders = hasLunaHeaders(sendable);
    const userAgentOnly = hasOnlyUserAgent(headers);
    const credentials = /^http:/i.test(url) && hasUrlCredentials(url);
    const proxy = (needsHeaders || userAgentOnly || credentials)
      && this.callbacks.headerPlayback() === 'proxy';
    const steps: ChainStep[] = [];
    // Luna mode logs its own skips when the step runs.
    if (proxy && (needsHeaders || userAgentOnly) && isWebOS() && this.lunaWindowUnsupported()) {
      this.noteLunaSkip(token, headers, 'no_window_latched', userAgentOnly);
    }
    if (!needsHeaders && !(credentials && proxy)) steps.push('video');
    if ((needsHeaders || userAgentOnly) && this.lunaPossible(url, extras)) steps.push('luna');
    if (proxy) steps.push('proxy');
    // The element still tries a stream whose server may not need the headers,
    // unless the proxy was the last step that could send them.
    if (steps.indexOf('video') < 0 && !(proxy && needsHeaders)) steps.push('video');
    const key = streamRouteKey(url);
    const remembered = this.chainWinners.get(key);
    const step = remembered && steps.indexOf(remembered) >= 0 ? remembered : steps[0];
    return {
      token, url, key, extras, opts, steps, step,
      tried: [step],
      startedAt: Date.now(),
      won: false,
      manifestOk: '',
      manifestFailed: {},
      manifestOnceLogged: false,
      upstreamChecked: false,
    };
  }

  // Luna steps known to fail before they start; lunaHeaders logs the reason.
  private lunaPossible(url: string, extras: Record<string, string> | null): boolean {
    if (!isWebOS() || this.lunaOff || this.lunaWindowUnsupported() || this.lunaFailed.has(url)
        || this.lunaFellBack.has(url)) return false;
    const mime = streamUrlMime(url);
    if (mime === 'video/mp2t' || mime === 'video/x-flv') return false;
    // An extension-less URL may still classify as DASH, the one format Luna
    // plays with PlayReady.
    return !lunaDrmSkip(parseDrmConfig(extras), mime === 'application/vnd.apple.mpegurl' ? 'hls' : 'dash');
  }

  private startChain(
    url: string,
    extras: Record<string, string> | null,
    token: number,
    opts: PipelineLoadOptions | undefined,
  ): void {
    const chain = this.chainFor(token);
    if (chain?.step === 'proxy') {
      this.loadThroughProxy(chain);
      return;
    }
    this.loadSource(url, extras, token, opts, chain ? { step: chain.step } : undefined);
  }

  private nextStep(chain: HeaderChain): ChainStep | null {
    for (const step of chain.steps) {
      if (chain.tried.indexOf(step) < 0) return step;
    }
    return null;
  }

  /**
   * Moves the chain to its next untried step. `announce` runs just before
   * that step loads, or with 'none' when no step is left.
   */
  private advance(
    chain: HeaderChain,
    cause: string,
    announce?: (next: ChainStep | 'none') => void,
  ): boolean {
    const from = chain.step;
    const label = this.callbacks.playbackLabel(chain.token);
    for (let next = this.nextStep(chain); next; next = this.nextStep(chain)) {
      chain.tried.push(next);
      const pendingStatus = this.proxyStatusPending;
      if (from === 'proxy' && next === 'video' && pendingStatus && !chain.upstreamChecked) {
        chain.tried.pop();
        chain.upstreamChecked = true;
        void pendingStatus.then(status => {
          // Another trigger already moved the chain on while the status was read.
          if (chain.token !== this.loadToken || chain.step !== 'proxy'
              || chain.tried.indexOf('video') >= 0) return;
          if (status && status.lastStatus >= 200 && status.lastStatus < 300) {
            chain.tried.push('video');
            // The proxy reached the server, so the element without headers cannot.
            log.warn('Header playback stopped escalating', 'event=playback.chain.stopped', label,
              'step=proxy', 'next=video', `last=${String(status.lastStatus)}`);
            announce?.('none');
            this.callbacks.onError();
            return;
          }
          if (!this.advance(chain, cause, announce)) this.callbacks.onError();
        });
        return true;
      }
      const elapsedMs = Date.now() - chain.startedAt;
      if (elapsedMs > CONFIG.PLAYER.HEADER_CHAIN_CAP_MS) {
        log.warn('Header playback stopped escalating', 'event=playback.chain.capped', label,
          `step=${from}`, `next=${next}`, `elapsedMs=${String(elapsedMs)}`);
        break;
      }
      chain.step = next;
      // A User-Agent retry knows its probed type; any other Luna step loads as usual.
      if (next === 'luna' && from === 'video' && this.uaRetry) {
        announce?.(next);
        if (this.retryWithLuna()) return true;
        chain.step = from;
        continue;
      }
      announce?.(next);
      if (next !== 'luna') {
        log.warn('Header playback escalated', 'event=playback.chain.escalated', label,
          `from=${from}`, `to=${next}`, `cause=${cause}`, `elapsedMs=${String(elapsedMs)}`);
      }
      this.callbacks.onPlaybackPathChange();
      this.cancelManifest();
      this.destroyLoaders();
      this.uaRetry = null;
      if (next === 'proxy') this.proxyStarting = chain.token;
      const go = () => {
        if (chain.token !== this.loadToken || !this.videoEl) return;
        if (next === 'proxy') {
          this.loadThroughProxy(chain);
          return;
        }
        this.closeProxy();
        if (this.videoEl) this.detachSource(this.videoEl);
        this.loadSource(chain.url, chain.extras, chain.token, chain.opts, { step: next as ChainStep });
      };
      const teardown = this.engineTeardown;
      if (teardown) {
        this.msePending = true;
        void teardown.promise.then(() => {
          this.msePending = false;
          go();
        }, () => {
          this.msePending = false;
          if (this.proxyStarting === chain.token) this.proxyStarting = -1;
          if (chain.token === this.loadToken) this.callbacks.onError();
        });
      } else {
        go();
      }
      return true;
    }
    announce?.('none');
    return false;
  }

  /** A Luna step that cannot play the stream gives it to the proxy, when that is next. */
  private toProxy(token: number, cause: string, announce?: () => void): boolean {
    const chain = this.chainFor(token);
    if (!chain || chain.step !== 'luna' || this.nextStep(chain) !== 'proxy') return false;
    if (chain.won) {
      // A Luna stream that played, then failed: the proxy still sends the
      // headers, and its cap counts from now. The proxy wins the route only
      // once it plays.
      chain.won = false;
      chain.startedAt = Date.now();
      this.chainWinners.delete(chain.key);
    }
    return this.advance(chain, cause, next => { if (next === 'proxy') announce?.(); });
  }

  private chainWon(chain: HeaderChain): void {
    if (chain.won || chain.token !== this.loadToken) return;
    chain.won = true;
    // The element without the channel's headers is only a last resort, never a start.
    if (chain.step === chain.steps[0] || (chain.step === 'video' && this.chainNeedsHeaders(chain))) {
      this.chainWinners.delete(chain.key);
    } else {
      this.chainWinners.set(chain.key, chain.step);
    }
    if (chain.step !== 'proxy') this.dropProxyOpen();
  }

  private chainNeedsHeaders(chain: HeaderChain): boolean {
    const headers = chain.opts?.headers ?? {};
    return hasLunaHeaders(withoutHeaders(headers, tlsUnsafeHeaderNames(chain.url, headers)));
  }

  // A one-time manifest URL: an earlier step read it, so a later one cannot.
  private reportStepFailure(chain: HeaderChain): void {
    const step = chain.step;
    const proxyToken = this.proxyToken;
    if (step === 'proxy' && proxyToken) {
      const label = this.callbacks.playbackLabel(chain.token);
      const pending = touchStreamProxy(proxyToken).then(status => {
        if (!status) return null;
        this.noteProxyCookies(proxyToken, status.cookies);
        log.warn('Local proxy step failed', 'event=playback.proxy.upstream', label,
          `last=${String(status.lastStatus)}`, `manifest=${String(status.manifestStatus)}`);
        this.checkManifestOnce(chain, step, status.manifestStatus || chain.manifestFailed.proxy || 0);
        return status;
      });
      this.proxyStatusPending = pending;
      return;
    }
    this.checkManifestOnce(chain, step, chain.manifestFailed[step] ?? 0);
  }

  private checkManifestOnce(chain: HeaderChain, step: ChainStep, status: number): void {
    if (chain.manifestOnceLogged || status < 400 || !chain.manifestOk || chain.manifestOk === step) return;
    chain.manifestOnceLogged = true;
    log.warn('Manifest refused after an earlier step read it', 'event=playback.chain.manifest_once',
      this.callbacks.playbackLabel(chain.token), `step=${step}`, `status=${String(status)}`,
      `earlier=${chain.manifestOk}`);
  }

  private viaProxy(token: number): string[] {
    return this.proxyToken && this.chainFor(token)?.step === 'proxy' ? ['via=proxy'] : [];
  }

  // Stops the element's source, so it neither keeps playing nor errors
  // under the load that replaces it.
  private detachSource(videoEl: HTMLVideoElement): void {
    if (!videoEl.getAttribute('src') && !videoEl.querySelector('source')) return;
    videoEl.removeAttribute('src');
    videoEl.innerHTML = '';
    this.nativePlaySeq++;
    videoEl.load();
  }

  private closeProxy(): void {
    const proxyToken = this.proxyToken;
    const session = this.proxySession;
    this.proxyToken = '';
    this.proxySession = null;
    if (this.proxyTouchTimer !== null) {
      clearInterval(this.proxyTouchTimer);
      this.proxyTouchTimer = null;
    }
    const pending = this.proxyStatusPending;
    this.proxyStatusPending = null;
    if (!proxyToken) return;
    const close = () => Promise.resolve(closeStreamProxy(proxyToken)).then(cookies => {
      if (session) PlayerPipeline.logProxyCookies(session.label, cookies ?? session.cookies);
    });
    if (pending) void pending.then(close, close);
    else void close();
  }

  private noteProxyCookies(proxyToken: string, cookies: StreamProxyCookies): void {
    if (this.proxySession && proxyToken === this.proxyToken) this.proxySession.cookies = cookies;
  }

  // Once per session and reason, when the session ends: the service's own
  // log is not in a diag report.
  private static logProxyCookies(label: string, cookies: StreamProxyCookies): void {
    Object.keys(cookies).sort().forEach(reason => {
      log.warn('Local proxy did not keep a cookie', 'event=playback.proxy.cookie', label,
        `reason=${reason}`, `count=${String(cookies[reason])}`);
    });
  }

  private dropProxyOpen(): void {
    const pending = this.proxyOpen;
    this.proxyOpen = null;
    if (pending) {
      void pending.promise.then(result => {
        if (result.ok) void closeStreamProxy(result.token);
      });
    }
  }

  private openProxy(chain: HeaderChain): Promise<StreamProxyResult> {
    const headers = chain.opts?.headers ?? {};
    return openStreamProxy(serviceRequestUrl(chain.url), withDefaultUserAgent(headers));
  }

  // While Luna tries, a proxy session opens too, so a Luna failure does not
  // wait for it.
  private preopenProxy(token: number): void {
    const chain = this.chainFor(token);
    if (!chain || this.proxyOpen || chain.steps.indexOf('proxy') < 0
        || chain.tried.indexOf('proxy') >= 0) return;
    this.proxyOpen = { token, promise: this.openProxy(chain) };
  }

  // The service expires a session no request used for two minutes; a paused
  // or fully buffered player still holds it.
  private startProxyTouch(token: number): void {
    const proxyToken = this.proxyToken;
    this.proxyTouchTimer = setInterval(() => {
      void touchStreamProxy(proxyToken).then(status => {
        if (!status || proxyToken !== this.proxyToken) return;
        if (status.alive) {
          this.noteProxyCookies(proxyToken, status.cookies);
          return;
        }
        if (this.proxyTouchTimer !== null) clearInterval(this.proxyTouchTimer);
        this.proxyTouchTimer = null;
        log.warn('Local proxy session expired', 'event=playback.proxy.expired',
          this.callbacks.playbackLabel(token));
        const session = this.proxySession;
        this.proxySession = null;
        if (session) PlayerPipeline.logProxyCookies(session.label, session.cookies);
        // The element would wait on 404s without ever erroring.
        if (token === this.loadToken) this.callbacks.onProxyExpired?.();
      });
    }, CONFIG.PLAYER.PROXY_TOUCH_INTERVAL);
  }

  /**
   * Opens a loopback proxy session that sends the channel's headers, then
   * plays its URL on the element or an MSE library without them. A session
   * that cannot open moves the chain to its next step.
   */
  private loadThroughProxy(chain: HeaderChain): void {
    const { token, url, extras } = chain;
    const videoEl = this.videoEl;
    if (!videoEl) return;
    this.detachSource(videoEl);
    const started = Date.now();
    const pending = this.proxyOpen;
    const opening = pending?.token === token ? pending.promise : this.openProxy(chain);
    if (pending?.token === token) this.proxyOpen = null;
    this.proxyStarting = token;
    void opening.then(result => {
      if (this.proxyStarting === token) this.proxyStarting = -1;
      if (token !== this.loadToken || !this.videoEl || chain.step !== 'proxy') {
        if (result.ok) void closeStreamProxy(result.token);
        return;
      }
      const label = this.callbacks.playbackLabel(token);
      if (!result.ok) {
        const advanced = this.advance(chain, 'proxy_failed', next => {
          log.warn('Local proxy unavailable', 'event=playback.proxy.failed', label,
            `reason=${result.reason}`, `fallback=${next}`);
        });
        if (advanced) return;
        // Reloading reopens the same failing session; no step is left to try.
        log.warn('Header playback stopped escalating', 'event=playback.chain.stopped', label,
          'step=proxy', 'next=none', `reason=${result.reason}`);
        this.callbacks.onError('unsupported');
        return;
      }
      this.proxyToken = result.token;
      this.proxySession = { label, cookies: {} };
      this.startProxyTouch(token);
      const mime = streamUrlMime(url);
      const format = mime === 'application/vnd.apple.mpegurl' ? 'hls'
        : mime === 'application/dash+xml' ? 'dash'
        : mime === 'video/mp2t' ? 'ts'
        : mime === 'video/x-flv' ? 'flv' : 'unknown';
      log.info('Local proxy opened', 'event=playback.proxy.opened', label,
        `format=${format}`, `elapsedMs=${String(Date.now() - started)}`);
      this.loadSource(result.url, extras, token, { ...chain.opts, headers: {} },
        { step: 'proxy', original: url });
    });
  }

  private destroyLoaders(): void {
    this.msePending = false;
    if (this.luna) {
      const luna = this.luna;
      this.luna = null;
      luna.destroy();
    }
    // The engine owns its library instance, hls.js included.
    if (this.engine) {
      const engine = this.engine;
      const label = this.videoEl ? this.videoLabel(this.videoEl)
        : this.callbacks.playbackLabel(this.loadToken);
      const source = this.hls ? 'hls' : 'shaka';
      const startedAt = Date.now();
      log.info('Destroying MSE engine', 'event=playback.mse.destroy.started',
        label, `source=${source}`);
      this.engine = null;
      const teardown = engine.destroy();
      const completed = () => {
        log.info('MSE engine destroyed', 'event=playback.mse.destroy.completed',
          label, `source=${source}`, `elapsedMs=${Date.now() - startedAt}`);
      };
      if (teardown) {
        const pending = { promise: teardown, label };
        this.engineTeardown = pending;
        void teardown.then(() => {
          if (this.engineTeardown === pending) this.engineTeardown = null;
          completed();
        }, error => {
          // A failed teardown keeps this element blocked until it is replaced.
          log.warn('MSE engine teardown failed', 'event=playback.mse.destroy.failed',
            label, `source=${source}`, `elapsedMs=${Date.now() - startedAt}`,
            shakaErrorDetail(error));
        });
      } else {
        completed();
      }
    }
    this.hls = null;
    if (this.mpegtsPlayer) {
      this.mpegtsPlayer.destroy();
      this.mpegtsPlayer = null;
    }
  }

  // Classify a stream by the server's Content-Type — URL extensions are
  // unreliable for proxied/extension-less streams, so the response header is the
  // real signal. Headers are enough, so cancel the body. Returns '' on a
  // CORS/network failure, leaving the caller on its URL heuristic (default HLS).
  private async detectContentType(url: string, loadToken: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.PLAYER.MANIFEST_TIMEOUT);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch(url, { signal: controller.signal });
      // An error page's type says nothing about the stream.
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        return '';
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const baseType = ct.split(';')[0].trim();
      const sniffBody = baseType === 'application/octet-stream'
        || baseType === 'application/xml'
        || baseType === 'text/xml';
      if (!sniffBody) {
        res.body?.cancel().catch(() => {});
        return ct;
      }
      reader = res.body?.getReader() ?? null;
      if (!reader) return ct;
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        chunks.push(value);
        length += value.length;
      }
      const prefix = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        prefix.set(chunk, offset);
        offset += chunk.length;
      }
      return sniffStreamContentType(ct, prefix);
    } catch (error) {
      log.warn('Content-type classification failed', 'event=playback.classify.failed',
        this.callbacks.playbackLabel(loadToken),
        error instanceof Error ? error.name : 'Error');
      return '';
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      clearTimeout(timer);
    }
  }

  /** The headers to load through Luna, or null when the stream stays on <video>. */
  private lunaHeaders(
    url: string,
    headers: Record<string, string>,
    extras: Record<string, string> | null,
    token: number,
    userAgentOnly = false,
    format: 'hls' | 'dash' = 'hls',
  ): Record<string, string> | null {
    if (!isWebOS() || !(userAgentOnly ? hasOnlyUserAgent(headers) : hasLunaHeaders(headers))) return null;
    const chain = this.chainFor(token);
    const otherSkip = this.lunaWindowUnsupported() ? 'no_window_latched'
      : this.lunaOff ? 'latched_off'
      : this.lunaFailed.has(url) ? 'failed_before'
      : this.lunaFellBack.has(url) ? 'fell_back'
      : chain && chain.step !== 'luna' && chain.steps.indexOf('luna') >= 0
        ? chain.tried.indexOf('luna') >= 0 ? 'tried' : 'remembered'
      : lunaDrmSkip(parseDrmConfig(extras), format);
    const unsafe = tlsUnsafeHeaderNames(url, headers);
    if (this.callbacks.headerPlayback() === 'off') {
      // Blame the setting only when Media service would have sent the headers.
      if (!otherSkip && (userAgentOnly || hasLunaHeaders(withoutHeaders(headers, unsafe)))) {
        this.headersOffToken = token;
      }
      this.noteLunaSkip(token, headers, 'setting', userAgentOnly);
      return null;
    }
    if (otherSkip) {
      this.noteLunaSkip(token, headers, otherSkip, userAgentOnly);
      return null;
    }
    if (!unsafe.length) return headers;
    const kept = withoutHeaders(headers, unsafe);
    const usable = hasLunaHeaders(kept);
    log.info('Luna credentials withheld over https', 'event=playback.luna.tls.stripped',
      this.callbacks.playbackLabel(token), `headers=${unsafe.join(',')}`,
      `path=${usable ? 'luna' : 'native'}`);
    return usable ? kept : null;
  }

  // Why a channel whose headers need Luna still plays without them.
  private noteLunaSkip(token: number, headers: Record<string, string>, reason: string, userAgentOnly = false): void {
    if (token === this.lunaSkipToken || !isWebOS()
        || !(userAgentOnly ? hasOnlyUserAgent(headers) : hasLunaHeaders(headers))) return;
    this.lunaSkipToken = token;
    log.info('Luna header playback skipped', 'event=playback.luna.skipped',
      this.callbacks.playbackLabel(token), `reason=${reason}`, `headers=${lunaHeaderNames(headers)}`);
  }

  private rememberUaRetry(
    url: string,
    headers: Record<string, string>,
    extras: Record<string, string> | null,
    token: number,
    mime: string,
  ): void {
    this.uaRetry = hasOnlyUserAgent(headers) ? { url, headers, extras, token, mime } : null;
  }

  /**
   * A User-Agent-only channel that failed to start on the element, where the
   * page's own User-Agent replaces the channel's, gets one Luna try per load.
   */
  private retryWithLuna(): boolean {
    const retry = this.uaRetry;
    this.uaRetry = null;
    const videoEl = this.videoEl;
    if (!retry || retry.token !== this.loadToken || !videoEl || this.luna) return false;
    // Shaka owns the element; Luna would compete for it.
    if (this.engine || this.msePending) return false;
    const dash = retry.mime === 'application/dash+xml';
    const headers = this.lunaHeaders(retry.url, retry.headers, retry.extras, retry.token, true,
      dash ? 'dash' : 'hls');
    if (!headers) return false;
    log.warn('User-Agent channel failed on the video element', 'event=playback.luna.fallback',
      this.callbacks.playbackLabel(retry.token), 'reason=ua_only');
    this.cancelManifest();
    this.callbacks.onPlaybackPathChange();
    if (dash) {
      // The MPD read and PlayReady prepare take time: drop the failed source and
      // its DRM client first, so neither errors under the Luna retry.
      this.destroyLoaders();
      videoEl.removeAttribute('src');
      videoEl.innerHTML = '';
      // Supersedes the failed source's play(), so its abort is not logged.
      this.nativePlaySeq++;
      videoEl.load();
      this.playReadyDrm.release();
      this.activeDrm = '';
    }
    if (dash) this.loadLunaDash(retry.url, headers, retry.extras, retry.token, 'ua_only');
    else this.loadLuna(retry.url, headers, retry.token, 'ua_only', retry.mime);
    return true;
  }

  // Read each time: a change of the header playback setting clears it.
  private lunaWindowUnsupported(): boolean {
    return StorageService.getLunaWindowUnsupported() === navigator.userAgent;
  }

  // Kept across launches until the header playback setting changes; a
  // timeout or any other error stays on the per-session count.
  private latchNoWindow(code: number, label: string): void {
    if (this.lunaWindowUnsupported()) return;
    StorageService.setLunaWindowUnsupported(navigator.userAgent);
    log.warn('Luna window lookup unsupported on this firmware', 'event=playback.luna.window_unsupported',
      label, 'stage=app_info', `code=${String(code)}`);
  }

  // A load UMS rejects is permanent for the session; a stream error, a
  // missing window, or a timeout may be transient and gets another try.
  private markLunaFailure(url: string, reason: LunaFallbackReason, label: string): void {
    this.lunaFellBack.add(url);
    if (reason === 'no_window' && ++this.lunaNoWindows >= CONFIG.PLAYER.LUNA_MEDIA_NO_WINDOW_LIMIT
        && !this.lunaOff) {
      // No window for several channels: this TV cannot show a Luna picture.
      this.lunaOff = true;
      log.warn('Luna playback disabled for this session', 'event=playback.luna.disabled',
        label, 'reason=no_window', `count=${String(this.lunaNoWindows)}`);
    }
    if (reason === 'load_failed') {
      this.lunaFailed.add(url);
      return;
    }
    const count = (this.lunaTransientFailures.get(url) ?? 0) + 1;
    this.lunaTransientFailures.set(url, count);
    if (count >= CONFIG.PLAYER.LUNA_MEDIA_TRANSIENT_FAILURES) this.lunaFailed.add(url);
  }

  private loadLuna(
    url: string,
    headers: Record<string, string>,
    token: number,
    reason: LunaRouteReason,
    fallbackMime = 'application/vnd.apple.mpegurl',
    dash: LunaDash | null = null,
  ): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    if (this.luna) {
      const previous = this.luna;
      this.luna = null;
      previous.destroy();
    }
    const label = this.callbacks.playbackLabel(token);
    const isHlsMime = fallbackMime === 'application/vnd.apple.mpegurl';
    const drmUnknown = !!dash && !dash.clientId && !dash.parsed;
    log.info('Selected webOS Luna playback', 'event=playback.path.luna', label,
      `reason=${reason}`, `headers=${lunaHeaderNames(headers)}`, `format=${dash ? 'dash' : 'hls'}`,
      `drm=${dash?.clientId ? 'playready' : drmUnknown ? 'unknown' : 'none'}`,
      ...(drmUnknown ? ['mpd=unreadable'] : []));
    const fallBack = (fallback: LunaFallbackReason, code: number, stage: string): void => {
      const note = (to: string): void => {
        log.warn(`Luna playback fell back to ${to}`,
          'event=playback.luna.fallback', label,
          `reason=${fallback}`, `code=${String(code)}`, `stage=${stage}`);
      };
      if (token !== this.loadToken || videoEl !== this.videoEl) {
        note('nothing: its load was replaced');
        return;
      }
      const chain = this.chainFor(token);
      if (chain) this.reportStepFailure(chain);
      if (this.toProxy(token, `luna_${fallback}`, () => note('the local proxy'))) return;
      this.callbacks.onPlaybackPathChange();
      // The element already failed this stream once.
      if (reason === 'ua_only' || (chain && (chain.tried.indexOf('video') >= 0
          || chain.steps.indexOf('video') < 0))) {
        note('nothing: every step failed');
        this.callbacks.onError();
        return;
      }
      note('the video element');
      if (chain) {
        chain.step = 'video';
        chain.tried.push('video');
      }
      this.cancelManifest();
      if (dash) {
        // A fresh client for the element: UMS may keep the one Luna loaded.
        if (dash.clientId) {
          this.playReadyDrm.release();
          this.activeDrm = '';
        }
        // Reuse the MPD read, so the fallback keeps within the startup watchdog.
        if (dash.parsed && dash.read) {
          this.notifyManifest(dash.read.baseUrl, dash.read.text, dash.parsed, dash.read.viaService, token);
        }
        this.playDash(url, dash.extras, token, dash.parsed);
        return;
      }
      log.info('Selected webOS native playback', 'event=playback.path.native', label,
        'reason=luna_fallback', `format=${isHlsMime ? 'hls' : 'auto'}`);
      if (isHlsMime) void this.loadManifest(url, this.manifestSeq, token);
      this.playNativeMime(url, fallbackMime);
    };
    // Only a clear load UMS rejected suggests the stream really is PlayReady.
    if (dash?.guessedAfter && dash.guessedAfter !== 'load_failed') this.activeDrm = '';
    const luna = new LunaMediaElement(videoEl, {
      uri: url,
      headers,
      transport: dash ? 'MPEG-DASH' : 'HLS',
      playReadyClientId: dash?.clientId || undefined,
      label,
      onFallback: (fallback, code, stage, unsupported) => {
        if (this.luna !== luna) return;
        this.luna = null;
        if (unsupported) this.latchNoWindow(code, label);
        if (dash?.guessedAfter) this.lunaPlayReadyUrls.delete(url);
        const current = token === this.loadToken && videoEl === this.videoEl;
        // An MPD unreadable without headers hid its DRM: a load that failed
        // as clear gets one PlayReady try. A reload that supersedes it loads
        // PlayReady up front, recorded as any load, so it cannot repeat.
        if (current && drmUnknown && dash && (fallback === 'load_failed' || fallback === 'error')) {
          this.lunaPlayReadyUrls.set(url, fallback);
          log.warn('Luna DASH retrying as PlayReady', 'event=playback.luna.drm.retry', label,
            `reason=${fallback}`, `code=${String(code)}`, `stage=${stage}`, 'drm=playready');
          // The failed session restored the element, which reads no source
          // while PlayReady prepares.
          this.callbacks.onPlaybackPathChange();
          this.lunaPreparing = token;
          void this.preparePlayReady(DETECTED_PLAYREADY, token, true).then(clientId => {
            if (this.lunaPreparing === token) this.lunaPreparing = -1;
            if (token !== this.loadToken || videoEl !== this.videoEl) return;
            if (!clientId) {
              this.lunaPlayReadyUrls.delete(url);
              this.markLunaFailure(url, fallback, label);
              fallBack(fallback, code, stage);
              return;
            }
            this.loadLuna(url, headers, token, reason, fallbackMime,
              { ...dash, clientId, guessedAfter: fallback, retry: true });
          });
          return;
        }
        // A failed retry records the clear failure, then only a worse one or
        // a missing window, which counts toward turning Luna off.
        if (dash?.retry && dash.guessedAfter) this.markLunaFailure(url, dash.guessedAfter, label);
        if (!dash?.retry || fallback === 'no_window') this.markLunaFailure(url, fallback, label);
        else if (fallback === 'load_failed' && dash.guessedAfter !== 'load_failed') {
          this.markLunaFailure(url, fallback, label);
        }
        fallBack(fallback, code, stage);
      },
      onStarted: () => {
        const chain = this.chainFor(token);
        if (chain && this.luna === luna) this.chainWon(chain);
        this.lunaTransientFailures.delete(url);
        this.lunaNoWindows = 0;
        if (dash?.guessedAfter) this.lunaPlayReadyUrls.set(url, dash.guessedAfter);
      },
      // A pipeline error after the start is no failed start: it counts toward
      // no Luna fallback, but the proxy may still send the headers.
      onPlaybackError: () => {
        if (this.luna !== luna || token !== this.loadToken || videoEl !== this.videoEl
          || !this.toProxy(token, 'luna_played_error')) return false;
        this.callbacks.onStepRestarted?.();
        this.callbacks.onPlaybackPathChange();
        return true;
      },
      onAudioTracks: () => {
        if (this.luna === luna) this.callbacks.onAudioTracksUpdated();
      },
    });
    this.luna = luna;
    this.lunaUrl = url;
    this.preopenProxy(token);
    luna.setDisplay(this.lunaDisplay);
    this.nativePlaySeq++;
    luna.start();
    // DASH already read its MPD before the load.
    if (dash) return;
    // For subtitle renditions and audio names only, so Luna never waits on it:
    // the page reads it without the channel's headers, the service after a 4xx.
    this.cancelManifest();
    void this.loadManifest(url, this.manifestSeq, token, 'hls', undefined, undefined, headers);
  }

  /**
   * DASH reads its MPD without the channel's headers first, as the element
   * path does, to find its DRM: clear and PlayReady DASH load through Luna,
   * Widevine and ClearKey stay on Shaka. A 4xx MPD is read again through the
   * bundled service with the headers; an MPD still unread loads Luna as configured.
   */
  private loadLunaDash(
    url: string,
    headers: Record<string, string>,
    extras: Record<string, string> | null,
    token: number,
    reason: LunaRouteReason,
  ): void {
    const configured = parseDrmConfig(extras);
    let held = false;
    let handled = false;
    let skipped = '';
    let started = false;
    const holdLuna = async (parsed: MpdManifest | null, read: ManifestRead | null): Promise<void> => {
      if (token !== this.loadToken || !this.videoEl) return;
      const detected = configured ? null : parsed?.drm ?? null;
      if (detected && detected.type !== 'playready') {
        skipped = detected.type === 'unsupported' ? 'drm_unsupported' : 'drm_mse';
        this.noteLunaSkip(token, headers, skipped, reason === 'ua_only');
        return;
      }
      let clientId = '';
      // A URL whose guessed PlayReady retry played skips the clear load that failed.
      const guessedAfter = configured || parsed ? undefined : this.lunaPlayReadyUrls.get(url);
      if (configured?.type === 'playready' || detected || guessedAfter) {
        handled = true;
        clientId = await this.preparePlayReady(
          configured?.type === 'playready' ? configured : DETECTED_PLAYREADY, token, !!guessedAfter);
        if (!clientId) {
          // A guess that cannot even prepare plays on the element instead.
          if (guessedAfter) {
            this.lunaPlayReadyUrls.delete(url);
            handled = false;
          }
          return;
        }
      }
      if (token !== this.loadToken || !this.videoEl) return;
      handled = true;
      started = true;
      if (this.lunaPreparing === token) this.lunaPreparing = -1;
      this.loadLuna(url, headers, token, reason, 'application/dash+xml',
        { extras, clientId, parsed, read, guessedAfter });
    };
    this.cancelManifest();
    // Pending until Luna starts, so suspend during the MPD read unloads it.
    this.lunaPreparing = token;
    void this.loadManifest(url, this.manifestSeq, token, 'dash', parsed => {
      if (!configured && (parsed?.drm?.type === 'widevine' || parsed?.drm?.type === 'clearkey')) {
        this.msePending = true;
      }
    }, async (parsed, read) => {
      // A throw after the hold re-enters it from the manifest's catch.
      if (held) return;
      held = true;
      try {
        await holdLuna(parsed, read);
      } finally {
        if (!started && this.lunaPreparing === token) this.lunaPreparing = -1;
      }
    }, headers).then(parsed => {
      if (handled || token !== this.loadToken || !this.videoEl) return;
      if (this.toProxy(token, skipped || 'luna_skipped')) return;
      if (reason === 'ua_only') {
        this.callbacks.onError();
        return;
      }
      log.info('Selected webOS native playback', 'event=playback.path.native',
        this.callbacks.playbackLabel(token), `reason=${skipped || 'luna_skipped'}`,
        'format=dash');
      this.playDash(url, extras, token, parsed);
    });
  }

  // DASH keeps application/dash+xml for classification and uses mediaOption on
  // the source element to select the native MPEG-DASH transport.
  private playNativeMime(url: string, mime: string): void {
    if (mime === 'application/dash+xml') {
      this.playNativeDash(url);
      return;
    }
    this.playNative(url, mime);
  }

  private playNativeDash(url: string, clientId = ''): void {
    const bare = CONFIG.PLAYER.DASH_SOURCE === 'bare';
    const type = bare && !clientId
      ? ''
      : mediaOptionSourceType('video/mp4', {
        mediaTransportType: 'MPEG-DASH',
        ...(clientId ? {
          option: { drm: { type: 'playready' as const, clientId } },
        } : {}),
      });
    log.info('Native DASH source', 'event=playback.path.native.dash',
      this.callbacks.playbackLabel(this.loadToken), ...this.viaProxy(this.loadToken),
      `hint=${bare && !clientId ? 'none' : 'mediaOption'}`,
      `drm=${clientId ? 'playready' : 'none'}`);
    this.playNative(url, type);
  }

  private loadNativeDash(
    url: string,
    extras: Record<string, string> | null,
    loadToken: number,
  ): void {
    const seq = this.manifestSeq;
    const configured = parseDrmConfig(extras);
    void this.loadManifest(url, seq, loadToken, 'dash', parsed => {
      if (isShakaDrmConfig(configured)
          || (!configured && (parsed?.drm?.type === 'widevine' || parsed?.drm?.type === 'clearkey'))) {
        this.msePending = true;
      }
    }).then(parsed => {
      if (loadToken !== this.loadToken || !this.videoEl) return;
      this.playDash(url, extras, loadToken, parsed);
    });
  }

  private playDash(
    url: string,
    extras: Record<string, string> | null,
    loadToken: number,
    parsed: MpdManifest | null,
  ): void {
    const configured = parseDrmConfig(extras);
    const detected = parsed?.drm;
    if (configured?.type === 'unsupported' || (!configured && detected?.type === 'unsupported')) {
      const value = configured?.type === 'unsupported' ? configured.value : detected?.scheme;
      log.warn('Unsupported native DASH DRM', 'event=playback.dash.drm.unsupported',
        this.callbacks.playbackLabel(loadToken), `type=${value || 'unknown'}`);
      this.callbacks.onError('unsupported');
      return;
    }
    if (isShakaDrmConfig(configured)
        || (!configured && (detected?.type === 'widevine' || detected?.type === 'clearkey'))) {
      const defaults = { licenseUrl: '', headers: {}, unsupportedOptions: [] };
      const config: ShakaDrmConfig = isShakaDrmConfig(configured)
        ? configured
        : detected?.type === 'clearkey'
          ? { ...defaults, type: 'clearkey', clearKeys: {} }
          : { ...defaults, type: 'widevine' };
      this.loadWithShaka(url, loadToken, config);
      return;
    }
    if (configured?.type !== 'playready' && detected?.type !== 'playready') {
      this.playNativeDash(url);
      return;
    }
    void this.preparePlayReady(configured?.type === 'playready' ? configured : DETECTED_PLAYREADY, loadToken)
      .then(clientId => {
        if (clientId) this.playNativeDash(url, clientId);
      });
  }

  /** Loads a PlayReady client for this load; '' when it failed (reported unless quiet) or went stale. */
  private preparePlayReady(config: PlayReadyConfig, loadToken: number, quiet = false): Promise<string> {
    if (config.unsupportedOptions.length) {
      log.warn('Ignoring unsupported native PlayReady options',
        'event=playback.dash.drm.options.unsupported',
        this.callbacks.playbackLabel(loadToken),
        `options=${config.unsupportedOptions.join(',')}`);
    }
    return this.playReadyDrm.prepare(config, response => {
      if (loadToken !== this.loadToken) return;
      log.warn('PlayReady rights error', 'event=playback.dash.drm.rights',
        this.callbacks.playbackLabel(loadToken),
        `state=${String(response.errorState ?? '')}`);
      this.callbacks.onError('unsupported');
    }).then(clientId => {
      if (!clientId || loadToken !== this.loadToken || !this.videoEl) return '';
      log.info('PlayReady DRM ready', 'event=playback.dash.drm.ready',
        this.callbacks.playbackLabel(loadToken));
      this.activeDrm = 'PlayReady';
      return clientId;
    }, error => {
      if (loadToken !== this.loadToken) return '';
      log.warn('PlayReady setup failed', 'event=playback.dash.drm.failed',
        this.callbacks.playbackLabel(loadToken), error);
      // A guessed client's failure leaves the caller to fall back.
      if (!quiet) this.callbacks.onError('unsupported');
      return '';
    });
  }

  private playNative(url: string, mime: string): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    // A <source> with an explicit MIME tells the player the format even when the
    // URL has no file extension.
    videoEl.removeAttribute('src');
    videoEl.innerHTML = '';
    const source = document.createElement('source');
    source.src = url;
    if (mime) source.type = mime;
    videoEl.appendChild(source);
    videoEl.load();
    const seq = ++this.nativePlaySeq;
    videoEl.play().catch(e => {
      if (seq !== this.nativePlaySeq) return;
      log.warn('Native play() rejected', 'event=playback.play.rejected',
        this.videoLabel(videoEl), 'path=native', this.callbacks.mediaState(videoEl), e);
    });
  }

  private loadWithHls(
    url: string,
    extras: Record<string, string> | null,
    loadToken: number,
  ): void {
    if (!this.videoEl) return;
    const Hls = win.__Hls as HlsType | undefined;
    try {
      if (!Hls?.isSupported()) {
        log.warn('hls.js unsupported; using direct playback',
            'event=playback.path.direct', this.callbacks.playbackLabel(loadToken),
            'reason=hls-unsupported');
        this.videoEl.src = url;
        this.videoEl.play().catch(() => {});
        return;
      }
      const hlsConfig: Record<string, unknown> = {
        maxBufferLength: CONFIG.PLAYER.BUFFER_LENGTH,
        enableWorker: false,
      };

      // Stable-URI loaders so a rotating-URL live window doesn't trip hls.js.
      const loaders = getLenientLoaders(Hls);
      hlsConfig.pLoader = loaders.pLoader;
      hlsConfig.fLoader = loaders.fLoader;
      if (extras?.['http-user-agent']) {
        hlsConfig.xhrSetup = (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('User-Agent', extras['http-user-agent']);
        };
      }
      this.hlsRecoveries = 0;
      const hls = new Hls(hlsConfig);
      this.hls = hls;
      this.engine = createHlsEngine(hls);
      hls.loadSource(url);
      hls.attachMedia(this.videoEl);
      // The audio/subtitle track lists aren't ready at MANIFEST_PARSED — hls.js
      // fills them and fires their *_TRACKS_UPDATED events separately, so apply
      // the saved picks there.
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, this.callbacks.onAudioTracksUpdated);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, this.callbacks.onSubtitleTracksUpdated);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log.info('hls.js manifest parsed; starting playback',
          'event=playback.manifest.parsed', this.callbacks.playbackLabel(loadToken),
          'path=hls');
        this.videoEl?.play().catch(e => log.warn('hls play() rejected:', e));
      });
      // A good fragment played: the stream recovered, so refill the retry budget.
      hls.on(Hls.Events.FRAG_BUFFERED, () => { this.hlsRecoveries = 0; });
      // Bounded recovery: retry transient network/media errors (and rotating-URL
      // re-fetches) a few times, but give up on a genuinely dead stream so it
      // zaps to the next channel instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (loadToken !== this.loadToken) return;
        log.warn('hls.js error', 'event=playback.hls.error',
          this.callbacks.playbackLabel(loadToken),
          { type: data.type, details: data.details, fatal: data.fatal });
        if (!data.fatal) return;
        if (this.hlsRecoveries >= CONFIG.PLAYER.HLS_MAX_RECOVERIES) {
          this.callbacks.onError();
          return;
        }
        this.hlsRecoveries++;
        const n = `${this.hlsRecoveries}/${CONFIG.PLAYER.HLS_MAX_RECOVERIES}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log.info('Restarting hls.js after a fatal network error',
            'event=playback.hls.recover.network',
            this.callbacks.playbackLabel(loadToken), n);
          this.hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log.info('Recovering hls.js after a fatal media error',
            'event=playback.hls.recover.media',
            this.callbacks.playbackLabel(loadToken), n);
          this.hls?.recoverMediaError();
        } else {
          this.callbacks.onError();
        }
      });
    } catch (error) {
      log.warn('hls.js initialization failed; using direct playback',
        'event=playback.hls.init.failed', this.callbacks.playbackLabel(loadToken), error);
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  private loadWithShaka(
    url: string,
    loadToken: number,
    drm: ShakaDrmConfig | null = null,
  ): void {
    if (!this.videoEl) return;
    this.msePending = true;
    const label = this.callbacks.playbackLabel(loadToken);
    const startedAt = Date.now();
    log.info('Initializing Shaka', 'event=playback.dash.init.started',
      label, `drm=${drm?.type || 'none'}`);
    void loadShaka().then(loaded => {
      if (loadToken !== this.loadToken || !this.videoEl) return;
      const shaka = loaded as ShakaNamespace;
      const videoEl = this.videoEl;
      const player = new shaka.Player();
      const engine = createShakaEngine(player);
      this.engine = engine;
      this.msePending = false;
      const config: Record<string, unknown> = {
        streaming: { bufferingGoal: CONFIG.PLAYER.BUFFER_LENGTH },
      };
      if (drm) {
        const keySystem = drm.type === 'clearkey' ? 'org.w3.clearkey' : 'com.widevine.alpha';
        config.drm = {
          preferredKeySystems: [keySystem],
          servers: drm.licenseUrl
            ? { [keySystem]: drm.licenseUrl }
            : {},
          ...(drm.type === 'clearkey' && Object.keys(drm.clearKeys).length
            ? { clearKeys: drm.clearKeys } : {}),
        };
        const licenseType =
          shaka.net?.NetworkingEngine?.RequestType?.LICENSE;
        const networking = player.getNetworkingEngine();
        if (Object.keys(drm.headers).length && (licenseType === undefined || !networking)) {
          throw new Error('Shaka license request filters are unavailable');
        }
        if (licenseType !== undefined && networking && Object.keys(drm.headers).length) {
          networking.registerRequestFilter((type, request) => {
            if (type !== licenseType) return;
            for (const name in drm.headers) {
              request.headers[name] = drm.headers[name];
            }
          });
        }
        if (drm.unsupportedOptions.length) {
          log.warn('Ignoring unsupported Shaka DRM options',
            'event=playback.dash.drm.options.unsupported',
            this.callbacks.playbackLabel(loadToken),
            `options=${drm.unsupportedOptions.join(',')}`);
        }
      }
      if (!player.configure(config)) {
        log.warn('Shaka rejected configuration', 'event=playback.dash.drm.failed',
          this.callbacks.playbackLabel(loadToken));
        throw new Error('Shaka configuration rejected');
      }
      const notifyAudioTracks = (event: Event) => {
        if (loadToken === this.loadToken && this.engine === engine) {
          const info = engine.streamInfo();
          log.info('Shaka variant changed', 'event=playback.dash.variant.changed',
            label, `reason=${event.type}`,
            `width=${videoEl.videoWidth} height=${videoEl.videoHeight}`,
            `videoCodec=${info?.videoCodec || 'unknown'}`,
            `audioCodec=${info?.audioCodec || 'unknown'}`,
            `videoRange=${info?.videoRange || 'unknown'}`,
            `frameRate=${info?.frameRate || 0}`,
            `audioChannels=${info?.audioChannels || 'unknown'}`,
            `audioAtmos=${info?.audioAtmos === true}`,
            this.callbacks.mediaState(videoEl));
          this.callbacks.onAudioTracksUpdated();
        }
      };
      player.addEventListener('adaptation', notifyAudioTracks);
      player.addEventListener('variantchanged', notifyAudioTracks);
      const notifyTextTracks = () => {
        if (loadToken === this.loadToken && this.engine === engine) {
          this.callbacks.onSubtitleTracksUpdated();
        }
      };
      player.addEventListener('textchanged', notifyTextTracks);
      player.addEventListener('texttrackvisibility', notifyTextTracks);

      let reportedCriticalError = false;
      const reportCriticalError = (error: unknown) => {
        if (reportedCriticalError || loadToken !== this.loadToken) return;
        reportedCriticalError = true;
        log.warn('Shaka critical error', 'event=playback.dash.error',
          this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
        if (isPermanentShakaLicenseError(error, shaka)) {
          this.callbacks.onError('unsupported');
        } else {
          this.callbacks.onError();
        }
      };
      player.addEventListener('error', event => {
        const error = (event as CustomEvent<ShakaError>).detail;
        log.warn('Shaka error', 'event=playback.dash.error',
          this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
        if (error?.severity === shaka.util.Error.Severity.CRITICAL) {
          reportCriticalError(error);
        }
      });

      void player.attach(videoEl).then(() => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        log.info('Shaka attached; loading stream', 'event=playback.dash.load.started',
          label, `elapsedMs=${Date.now() - startedAt}`);
        return player.load(url);
      }).then(() => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        const keySystem = player.getDrmInfo?.()?.keySystem;
        this.activeDrm = drm?.type === 'clearkey' || (!drm && keySystem === 'org.w3.clearkey')
          ? 'ClearKey'
          : drm?.type === 'widevine' || keySystem === 'com.widevine.alpha' ? 'Widevine' : '';
        log.info('Shaka stream loaded', 'event=playback.dash.load.completed',
          label, `elapsedMs=${Date.now() - startedAt}`,
          `keySystem=${keySystem || 'none'}`, `mediaKeys=${Boolean(videoEl.mediaKeys)}`,
          this.callbacks.mediaState(videoEl));
        if (this.activeDrm) {
          log.info('Shaka DRM ready', 'event=playback.dash.drm.ready',
            `drm=${this.activeDrm}`,
            this.callbacks.playbackLabel(loadToken));
        }
        this.callbacks.onAudioTracksUpdated();
        this.callbacks.onSubtitleTracksUpdated();
        videoEl.play().catch(error => log.warn('Shaka play() rejected',
          'event=playback.play.rejected',
          this.callbacks.playbackLabel(loadToken), 'path=dash', shakaErrorDetail(error)));
      }).catch(error => {
        if (loadToken !== this.loadToken || this.engine !== engine) return;
        this.destroyLoaders();
        reportCriticalError(error);
      });
    }).catch(error => {
      if (loadToken !== this.loadToken) return;
      this.msePending = false;
      this.destroyLoaders();
      log.warn('Shaka initialization failed',
        'event=playback.dash.init.failed', this.callbacks.playbackLabel(loadToken), shakaErrorDetail(error));
      this.callbacks.onError();
    });
  }

  private loadWithMpegts(url: string, isFlv: boolean, loadToken: number): void {
    if (!this.videoEl) return;
    const mpegts = win.__mpegts as MpegtsType | undefined;
    try {
      if (!mpegts?.isSupported()) {
      log.warn('mpegts.js unsupported; using direct playback',
        'event=playback.path.direct', this.callbacks.playbackLabel(loadToken),
        'reason=mpegts-unsupported');
      this.videoEl.src = url;
        this.videoEl.play().catch(() => {});
        return;
      }
      const player = mpegts.createPlayer({
        type: isFlv ? 'flv' : 'mpegts',
        isLive: true,
        url,
      });
      this.mpegtsPlayer = player;
      player.attachMediaElement(this.videoEl);
      player.load();
      player.play();
      player.on(mpegts.Events.ERROR, () => {
        if (loadToken !== this.loadToken) return;
        log.error('mpegts.js playback error', 'event=playback.mpegts.error',
          this.callbacks.playbackLabel(loadToken));
        this.callbacks.onError();
      });
    } catch (error) {
      log.warn('mpegts.js initialization failed; using direct playback',
        'event=playback.mpegts.init.failed', this.callbacks.playbackLabel(loadToken), error);
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  // Fetch the HLS master once and parse its audio + subtitle rendition names so
  // the pickers, toasts and per-channel memory show real labels instead of
  // "Audio 2" / "Subtitle 2". Native audio/text tracks carry no usable
  // name/language on webOS, so this is the only source. The Player re-applies
  // saved picks when the parsed manifest is delivered.
  private async loadManifest(
    url: string, seq: number, loadToken: number, format: 'hls' | 'dash' = 'hls',
    beforeNotify?: (manifest: MpdManifest | null) => void,
    // Runs before the tracks hear of the manifest, or of its failure.
    hold?: (manifest: MpdManifest | null, read: ManifestRead | null) => Promise<void>,
    // The Luna path's headers: a 4xx page fetch retries through the bundled service.
    lunaHeaders?: Record<string, string>,
  ): Promise<MpdManifest | null> {
    const dash = format === 'dash';
    const controller = new AbortController();
    const started = Date.now();
    const maxBytes = dash ? CONFIG.PLAYER.MPD_MAX_BYTES : CONFIG.PLAYER.MANIFEST_MAX_BYTES;
    const chain = this.chainFor(loadToken);
    const step: ChainStep | null = !chain ? null
      : lunaHeaders ? 'luna' : chain.step === 'luna' ? 'video' : chain.step;
    this.manifestController?.abort();
    this.manifestController = controller;
    try {
      let text: string;
      let baseUrl = url;
      let viaService = false;
      try {
        // The page's fetch() rejects a URL with user:password@ outright.
        if (lunaHeaders && hasUrlCredentials(url)) throw new UrlCredentialsError();
        text = await fetchLimitedText(
          url,
          maxBytes,
          CONFIG.PLAYER.MANIFEST_TIMEOUT,
          controller.signal,
          dash ? mpdOpeningVerdict : '#EXTM3U',
        );
      } catch (e) {
        const credentials = e instanceof UrlCredentialsError;
        const status = e instanceof FetchTextError && e.code === 'http' ? e.status : 0;
        if (!lunaHeaders || controller.signal.aborted
          || (!credentials && (status < 400 || status >= 500))) throw e;
        const fetched = await this.fetchManifestThroughService(url, lunaHeaders, dash, maxBytes,
          controller.signal, loadToken, credentials ? 'credentials' : fetchFailureReason(e));
        if (!fetched) throw e;
        text = fetched.text;
        baseUrl = fetched.url;
        viaService = true;
      }
      if (seq !== this.manifestSeq) return null;
      if (dash && !isMpdText(text)) {
        throw new FetchTextError('invalid_content', 'Response is not an MPD');
      }
      if (chain && step && !chain.manifestOk) chain.manifestOk = step;
      log.debug('Manifest fetched', 'event=playback.manifest.fetched',
        this.callbacks.playbackLabel(loadToken),
        `format=${format} bytes=${String(text.length)} elapsed=${String(Date.now() - started)}ms`);
      const parsed = dash ? parseMpd(text, baseUrl) : null;
      beforeNotify?.(parsed);
      if (hold) {
        await hold(parsed, { text, baseUrl, viaService });
        if (seq !== this.manifestSeq) return null;
      }
      this.notifyManifest(baseUrl, text, parsed, viaService, loadToken);
      return parsed;
    } catch (e) {
      if (controller.signal.aborted) return null;
      if (chain && step && e instanceof FetchTextError && e.code === 'http') {
        chain.manifestFailed[step] = e.status;
      }
      if (hold) {
        await hold(null, null);
        if (seq !== this.manifestSeq) return null;
      }
      if (this.luna) {
        log.info('Subtitles unavailable on Luna playback', 'event=subtitles.luna.unavailable',
          this.callbacks.playbackLabel(loadToken), 'stage=manifest', `reason=${fetchFailureReason(e)}`);
        // Settled with nothing, so Luna audio stops waiting for names.
        this.callbacks.onManifest({ audio: [], subtitles: [], closedCaptions: [], variants: [], masterUrl: '' });
        return null;
      }
      log.warn('Manifest fetch failed', 'event=playback.manifest.failed',
        this.callbacks.playbackLabel(loadToken),
        `elapsed=${String(Date.now() - started)}ms`, e);
      return null;
    } finally {
      if (this.manifestController === controller) this.manifestController = null;
    }
  }

  // The page cannot send Referer, User-Agent, or Cookie; the bundled service can.
  private async fetchManifestThroughService(
    url: string,
    headers: Record<string, string>,
    dash: boolean,
    maxBytes: number,
    signal: AbortSignal,
    loadToken: number,
    page: string,
  ): Promise<{ text: string; url: string } | null> {
    const started = Date.now();
    const result = await fetchManifestViaService(serviceRequestUrl(url), withDefaultUserAgent(headers), {
      maxBytes,
      // DASH holds the Luna load until this settles.
      timeoutMs: dash ? CONFIG.PLAYER.DASH_MANIFEST_SERVICE_TIMEOUT : CONFIG.PLAYER.MANIFEST_TIMEOUT,
      graceMs: dash ? CONFIG.PLAYER.DASH_MANIFEST_SERVICE_GRACE_MS : CONFIG.PLAYER.MANIFEST_SERVICE_GRACE_MS,
      signal,
    });
    if (signal.aborted) return null;
    let reason = result.ok ? '' : result.reason;
    if (result.ok && !(dash ? isMpdText(result.text) : result.text.indexOf('#EXTM3U') === 0)) {
      reason = 'parse';
    }
    const label = this.callbacks.playbackLabel(loadToken);
    const elapsed = `elapsed=${String(Date.now() - started)}ms`;
    if (!result.ok || reason) {
      log.warn('Manifest service fetch failed', 'event=playback.luna.manifest.service', label,
        'outcome=failed', `reason=${reason}`, `page=${page}`, elapsed);
      return null;
    }
    log.info('Manifest fetched through the service', 'event=playback.luna.manifest.service', label,
      'outcome=ok', `page=${page}`, elapsed);
    return { text: result.text, url: result.url };
  }

  private notifyManifest(
    url: string, text: string, parsed: MpdManifest | null, viaService = false, loadToken = this.loadToken,
  ): void {
    const audio = parsed ? parsed.audio : parseAudioRenditions(text);
    const luna = this.luna !== null;
    let subtitles = parsed ? parsed.subtitles : parseSubtitleRenditions(text);
    // The page cannot re-read the MPD for the segments a live window adds.
    if (viaService && subtitles.some(s => s.dash?.needsManifestRefresh)) {
      subtitles = subtitles.filter(s => !s.dash?.needsManifestRefresh);
      if (luna) {
        log.info('Subtitles unavailable on Luna playback', 'event=subtitles.luna.unavailable',
          this.callbacks.playbackLabel(loadToken), 'stage=manifest', 'reason=dynamic_mpd');
      }
    }
    const closedCaptions = parsed ? parsed.closedCaptions : parseClosedCaptions(text);
    const variants = parsed ? parsed.variants : parseVariants(text);
    if (audio.length >= 2) {
      log.info('manifest audio:', audio.map(r => r.name || r.lang || '?').join(', '));
    }
    if (subtitles.length) {
      log.info('manifest subtitles:', subtitles.map(r => r.name || r.lang || '?').join(', '));
    }
    if (closedCaptions.length) {
      log.info('manifest closed captions:',
        closedCaptions.map(c => c.instreamId || c.name || '?').join(', '));
    }
    if (variants.length) log.info('manifest variants:', variants.length);
    // On Luna the manifest only feeds subtitles, captions and audio names;
    // UMS alone picks the variant.
    this.callbacks.onManifest({
      audio: audio.length >= 2 || luna ? audio : [],
      subtitles,
      closedCaptions,
      variants: luna ? [] : variants,
      masterUrl: subtitles.length ? url : '',
      // The page would be refused again, so subtitles start from this text.
      masterText: subtitles.length && viaService ? text : undefined,
    });
  }

  private cancelManifest(): void {
    this.manifestSeq++;
    this.manifestController?.abort();
    this.manifestController = null;
  }
}
