import type { AudioOption, ManifestAudio, ManifestClosedCaption, ManifestSubtitle, SubtitleOption } from '../types';
import { CONFIG } from '../config';
import { getCachedStreamMime, setCachedStreamMime } from '../services/idb-cache';
import { parseMpd, type MpdManifest } from '../parsers/mpd-manifest';
import {
  nativeDrmConfig,
  PlayReadyDrm,
  type PlayReadyConfig,
} from '../services/playready-drm';
import { parseAudioRenditions } from '../utils/audio-tracks';
import { FetchTextError, fetchLimitedText } from '../utils/fetch-helper';
import { getLenientLoaders } from '../utils/hls-stable-loader';
import { createLogger } from '../utils/logger';
import { parseClosedCaptions, parseSubtitleRenditions } from '../utils/subtitle-tracks';
import { parseVariants, type StreamVariant } from '../utils/stream-info';
import { mediaOptionSourceType } from '../utils/webos-media-option';
import { createDashEngine, type DashPlayerLike } from './mse/dash-engine';
import { createHlsEngine } from './mse/hls-engine';
import type { MseEngine, PipelineStreamInfo } from './mse/engine';
import {
  containerMime,
  diagnosticStreamUrl,
  sniffStreamContentType,
  isMpdText,
  mpdOpeningVerdict,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';

const log = createLogger('Player');

const isWebOS = /webOS|Web0S/i.test(navigator.userAgent);

// hls.js, mpegts.js and dash.js are loaded as globals via preview-libs.js
// (desktop preview only)
const win = window as unknown as Record<string, unknown>;

type HlsType = typeof import('hls.js').default;
type MpegtsType = typeof import('mpegts.js').default;

interface DashjsNamespace {
  MediaPlayer: {
    (): { create(): DashPlayerLike & {
      initialize(video: HTMLVideoElement, url: string, autoplay: boolean): void;
      updateSettings(settings: Record<string, unknown>): void;
      on(event: string, listener: (data?: unknown) => void): void;
    } };
    events: {
      ERROR: string;
      FRAGMENT_LOADING_COMPLETED: string;
      STREAM_INITIALIZED: string;
    };
  };
}

export interface PipelineManifest {
  audio: ManifestAudio[];
  subtitles: ManifestSubtitle[];
  closedCaptions: ManifestClosedCaption[];
  variants: StreamVariant[];
  masterUrl: string;
}

export interface PlayerPipelineOptions {
  playbackLabel: (loadToken: number) => string;
  mediaState: (video: HTMLVideoElement) => string;
  isCatchup: () => boolean;
  onError: () => void;
  onAudioTracksUpdated: () => void;
  onSubtitleTracksUpdated: () => void;
  onManifest: (manifest: PipelineManifest) => void;
}

export class PlayerPipeline {
  private videoEl: HTMLVideoElement | null = null;
  private hls: InstanceType<HlsType> | null = null;
  private mpegtsPlayer: { destroy(): void } | null = null;
  private engine: MseEngine | null = null;
  private loadToken = 0;
  private hlsRecoveries = 0;
  private dashRecoveries = 0;
  private manifestSeq = 0;
  private manifestController: AbortController | null = null;
  private videoLoadLabels = new WeakMap<HTMLVideoElement, string>();
  private playReadyDrm = new PlayReadyDrm();
  private activeDrm = '';

  constructor(private callbacks: PlayerPipelineOptions) {}

  setVideoElement(videoEl: HTMLVideoElement): void {
    this.videoEl = videoEl;
  }

  currentLoadToken(): number {
    return this.loadToken;
  }

  videoLabel(el: HTMLVideoElement): string {
    return this.videoLoadLabels.get(el) ?? this.callbacks.playbackLabel(this.loadToken);
  }

  // "An MSE library owns the tracks" — hls.js or dash.js in the desktop preview.
  isMseActive(): boolean {
    return this.engine !== null;
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

  streamInfo(): PipelineStreamInfo | null {
    return this.engine?.streamInfo() ?? null;
  }

  drmLabel(): string {
    return this.activeDrm;
  }

  load(url: string, extras: Record<string, string> | null, opts?: { direct?: boolean }): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const token = ++this.loadToken;
    this.videoLoadLabels.set(videoEl, this.callbacks.playbackLabel(token));
    const safeUrl = diagnosticStreamUrl(url);
    this.cancelManifest();
    this.destroyLoaders();
    this.playReadyDrm.release();
    this.activeDrm = '';

    const urlMime = streamUrlMime(url);
    const isTsUrl = urlMime === 'video/mp2t';
    const isFlvUrl = urlMime === 'video/x-flv';
    const isHlsUrl = urlMime === 'application/vnd.apple.mpegurl';
    const isDashUrl = urlMime === 'application/dash+xml';

    // webOS: the TV's hardware HLS/TS decoders beat MSE libraries, so play
    // natively. Explicit extensions and previously verified routes avoid a
    // probe; only a cold ambiguous route pays the bounded classification cost.
    if (isWebOS) {
      if (opts?.direct) {
        const mime = containerMime(url);
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token),
          'reason=direct', 'url=', safeUrl,
          '| webOS native VOD | MIME', mime || '(sniffed)');
        this.playNative(url, mime);
        return;
      }
      if (isTsUrl || isFlvUrl || isHlsUrl || isDashUrl) {
        const mime = isFlvUrl ? 'video/x-flv'
          : isTsUrl ? 'video/mp2t'
          : isDashUrl ? 'application/dash+xml'
          : 'application/vnd.apple.mpegurl';
        log.info('Selected webOS native playback', 'event=playback.path.native',
          this.callbacks.playbackLabel(token),
          'reason=url', 'url=', safeUrl,
          '| webOS native | catchup:', this.callbacks.isCatchup(), '| MIME', mime);
        if (isDashUrl) {
          this.loadNativeDash(url, extras, token);
          return;
        }
        if (isHlsUrl) {
          void this.loadManifest(url, this.manifestSeq, token);
        }
        this.playNativeMime(url, mime);
        return;
      }
      const routeKey = streamRouteKey(url);
      void getCachedStreamMime(routeKey).then(cachedMime => {
        if (token !== this.loadToken || !this.videoEl) return;
        if (cachedMime) {
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token),
            'reason=cache', 'url=', safeUrl,
            '| webOS native | cached MIME', cachedMime,
            '| catchup:', this.callbacks.isCatchup());
          if (cachedMime === 'application/vnd.apple.mpegurl') {
            void this.loadManifest(url, this.manifestSeq, token);
          } else if (cachedMime === 'application/dash+xml') {
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
          log.info('Selected webOS native playback', 'event=playback.path.native',
            this.callbacks.playbackLabel(token),
            'reason=probe', 'url=', safeUrl,
            '| webOS native | content-type:', contentType || '(none)',
            '| catchup:', this.callbacks.isCatchup(), '| MIME', mime || '(auto)');
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
        'reason=direct', 'url=', safeUrl, '| desktop direct VOD');
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
      log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
        '| content-type:', ct || '(none)', '| catchup:', this.callbacks.isCatchup(),
        '| isHls:', isHls, '| isTs:', isTs, '| isFlv:', isFlv, '| isDash:', isDash);
      if (isTs || isFlv) {
        log.info('Selected mpegts.js playback', 'event=playback.path.mpegts',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.loadWithMpegts(url, isFlv, token);
      } else if (isDash) {
        log.info('Selected dash.js playback', 'event=playback.path.dash',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.loadWithDash(url, token);
      } else if (isDirect) {
        log.info('Selected direct playback', 'event=playback.path.direct',
          this.callbacks.playbackLabel(token),
          'reason=probe');
        this.videoEl.src = url;
        this.videoEl.play().catch(e => log.warn('Direct play() rejected',
          'event=playback.play.rejected',
          this.callbacks.playbackLabel(token), 'path=direct', e));
      } else {
        log.info('Selected hls.js playback', 'event=playback.path.hls',
          this.callbacks.playbackLabel(token),
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
    this.playReadyDrm.release();
    this.activeDrm = '';
  }

  private destroyLoaders(): void {
    // The engine owns its library instance, hls.js included.
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
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
      this.callbacks.playbackLabel(this.loadToken),
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
    void this.loadManifest(url, seq, loadToken, 'dash').then(parsed => {
      if (loadToken !== this.loadToken || !this.videoEl) return;
      const configured = nativeDrmConfig(extras);
      const detected = parsed?.drm;
      if (configured?.type === 'unsupported' || detected?.type === 'unsupported') {
        const value = configured?.type === 'unsupported' ? configured.value : detected?.scheme;
        log.warn('Unsupported native DASH DRM', 'event=playback.dash.drm.unsupported',
          this.callbacks.playbackLabel(loadToken), `type=${value || 'unknown'}`);
        this.callbacks.onError();
        return;
      }
      if (configured?.type !== 'playready' && detected?.type !== 'playready') {
        this.playNativeDash(url);
        return;
      }
      const config: PlayReadyConfig = configured?.type === 'playready'
        ? configured
        : {
            type: 'playready',
            licenseUrl: '',
            customData: '',
            unsupportedOptions: [],
          };
      if (config.unsupportedOptions.length) {
        log.warn('Ignoring unsupported native PlayReady options',
          'event=playback.dash.drm.options.unsupported',
          this.callbacks.playbackLabel(loadToken),
          `options=${config.unsupportedOptions.join(',')}`);
      }
      void this.playReadyDrm.prepare(config, response => {
        if (loadToken !== this.loadToken) return;
        log.warn('PlayReady rights error', 'event=playback.dash.drm.rights',
          this.callbacks.playbackLabel(loadToken),
          `state=${String(response.errorState ?? '')}`);
        this.callbacks.onError();
      }).then(clientId => {
        if (!clientId || loadToken !== this.loadToken || !this.videoEl) return;
        log.info('PlayReady DRM ready', 'event=playback.dash.drm.ready',
          this.callbacks.playbackLabel(loadToken));
        this.activeDrm = 'PlayReady';
        this.playNativeDash(url, clientId);
      }).catch(error => {
        if (loadToken !== this.loadToken) return;
        log.warn('PlayReady setup failed', 'event=playback.dash.drm.failed',
          this.callbacks.playbackLabel(loadToken), error);
        this.callbacks.onError();
      });
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
    videoEl.play().catch(e => log.warn('Native play() rejected',
      'event=playback.play.rejected',
      this.videoLabel(videoEl), 'path=native', this.callbacks.mediaState(videoEl), e));
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

  private loadWithDash(url: string, loadToken: number): void {
    if (!this.videoEl) return;
    const dashjs = win.__dashjs as DashjsNamespace | undefined;
    try {
      if (!dashjs) {
        log.warn('dash.js unavailable; using direct playback',
          'event=playback.path.direct', this.callbacks.playbackLabel(loadToken),
          'reason=dash-unavailable');
        this.videoEl.src = url;
        this.videoEl.play().catch(() => {});
        return;
      }
      this.dashRecoveries = 0;
      const player = dashjs.MediaPlayer().create();
      player.updateSettings({
        streaming: { buffer: { bufferTimeDefault: CONFIG.PLAYER.BUFFER_LENGTH } },
      });
      player.initialize(this.videoEl, url, true);
      this.engine = createDashEngine(player);
      // dash.js resolves its rendition lists only once the streams are known,
      // so the saved picks are applied there, as with hls.js.
      player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, () => {
        this.callbacks.onAudioTracksUpdated();
        this.callbacks.onSubtitleTracksUpdated();
      });
      player.on(dashjs.MediaPlayer.events.FRAGMENT_LOADING_COMPLETED, data => {
        const request = (data as { request?: { type?: string } } | undefined)?.request;
        if (request?.type === 'MediaSegment') this.dashRecoveries = 0;
      });
      // dash.js retries internally, so give it a bounded budget before zapping
      // to the next channel.
      player.on(dashjs.MediaPlayer.events.ERROR, (data?: unknown) => {
        log.warn('dash.js error', 'event=playback.dash.error',
          this.callbacks.playbackLabel(loadToken), data);
        if (this.dashRecoveries >= CONFIG.PLAYER.DASH_MAX_RECOVERIES) {
          this.callbacks.onError();
          return;
        }
        this.dashRecoveries++;
      });
    } catch (error) {
      log.warn('dash.js initialization failed; using direct playback',
        'event=playback.dash.init.failed', this.callbacks.playbackLabel(loadToken), error);
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
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
  ): Promise<MpdManifest | null> {
    const dash = format === 'dash';
    const controller = new AbortController();
    const started = Date.now();
    this.manifestController?.abort();
    this.manifestController = controller;
    try {
      const text = await fetchLimitedText(
        url,
        dash ? CONFIG.PLAYER.MPD_MAX_BYTES : CONFIG.PLAYER.MANIFEST_MAX_BYTES,
        CONFIG.PLAYER.MANIFEST_TIMEOUT,
        controller.signal,
        dash ? mpdOpeningVerdict : '#EXTM3U',
      );
      if (seq !== this.manifestSeq) return null;
      if (dash && !isMpdText(text)) {
        throw new FetchTextError('invalid_content', 'Response is not an MPD');
      }
      log.debug('Manifest fetched', 'event=playback.manifest.fetched',
        this.callbacks.playbackLabel(loadToken),
        `format=${format} bytes=${String(text.length)} elapsed=${String(Date.now() - started)}ms`);
      const parsed = dash ? parseMpd(text, url) : null;
      const audio = parsed ? parsed.audio : parseAudioRenditions(text);
      const subtitles = parsed ? parsed.subtitles : parseSubtitleRenditions(text);
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
      this.callbacks.onManifest({
        audio: audio.length >= 2 ? audio : [],
        subtitles,
        closedCaptions,
        variants,
        masterUrl: subtitles.length ? url : '',
      });
      return parsed;
    } catch (e) {
      if (controller.signal.aborted) return null;
      log.warn('Manifest fetch failed', 'event=playback.manifest.failed',
        this.callbacks.playbackLabel(loadToken),
        `elapsed=${String(Date.now() - started)}ms`, e);
      return null;
    } finally {
      if (this.manifestController === controller) this.manifestController = null;
    }
  }

  private cancelManifest(): void {
    this.manifestSeq++;
    this.manifestController?.abort();
    this.manifestController = null;
  }
}
