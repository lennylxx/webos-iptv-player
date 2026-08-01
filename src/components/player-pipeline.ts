import type { AudioOption, ManifestAudio, ManifestClosedCaption, ManifestSubtitle, SubtitleOption } from '../types';
import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import { hlsAudioOptions, parseAudioRenditions } from '../utils/audio-tracks';
import { fetchLimitedText } from '../utils/fetch-helper';
import { getLenientLoaders } from '../utils/hls-stable-loader';
import { createLogger } from '../utils/logger';
import { parseClosedCaptions, parseSubtitleRenditions, hlsSubtitleOptions } from '../utils/subtitle-tracks';
import { parseVariants, type StreamVariant } from '../utils/stream-info';
import {
  containerMime,
  diagnosticStreamUrl,
  sniffStreamContentType,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';

const log = createLogger('Player');
const isWebOS = /webOS|Web0S/i.test(navigator.userAgent);

// hls.js and mpegts.js are loaded as globals via preview-libs.js (desktop preview only)
const win = window as unknown as Record<string, unknown>;

type HlsType = typeof import('hls.js').default;
type MpegtsType = typeof import('mpegts.js').default;

export interface PipelineManifest {
  audio: ManifestAudio[];
  subtitles: ManifestSubtitle[];
  closedCaptions: ManifestClosedCaption[];
  variants: StreamVariant[];
  masterUrl: string;
}

export interface PipelineStreamInfo {
  videoCodec: string;
  audioCodec: string;
  videoRange: string;
  frameRate: number;
  audioChannels: string;
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
  private loadToken = 0;
  private hlsRecoveries = 0;
  private manifestSeq = 0;
  private manifestController: AbortController | null = null;
  private videoLoadLabels = new WeakMap<HTMLVideoElement, string>();

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

  isHlsActive(): boolean {
    return this.hls !== null;
  }

  hlsAudioOptions(): AudioOption[] {
    return this.hls ? hlsAudioOptions(this.hls.audioTracks || [], this.hls.audioTrack) : [];
  }

  setHlsAudioTrack(index: number): boolean {
    if (!this.hls || index < 0 || index >= (this.hls.audioTracks?.length || 0)) return false;
    this.hls.audioTrack = index;
    return true;
  }

  hlsSubtitleOptions(): SubtitleOption[] {
    return this.hls ? hlsSubtitleOptions(this.hls.subtitleTracks || [], this.hls.subtitleTrack) : [];
  }

  setHlsSubtitleTrack(index: number): boolean {
    if (!this.hls) return false;
    this.hls.subtitleDisplay = index >= 0;
    if (index < (this.hls.subtitleTracks?.length || 0)) this.hls.subtitleTrack = index;
    return true;
  }

  streamInfo(): PipelineStreamInfo | null {
    const hls = this.hls;
    if (!hls) return null;
    const level = hls.loadLevelObj;
    const channels = hls.audioTracks?.[hls.audioTrack]?.channels ?? '';
    return {
      videoCodec: level?.videoCodec ?? '',
      audioCodec: level?.audioCodec ?? '',
      videoRange: level?.videoRange ?? '',
      frameRate: level?.frameRate ?? 0,
      audioChannels: channels,
    };
  }

  load(url: string, extras: Record<string, string> | null, opts?: { direct?: boolean }): void {
    const videoEl = this.videoEl;
    if (!videoEl) return;
    const token = ++this.loadToken;
    this.videoLoadLabels.set(videoEl, this.callbacks.playbackLabel(token));
    const safeUrl = diagnosticStreamUrl(url);
    this.cancelManifest();
    this.destroyLoaders();

    const urlMime = streamUrlMime(url);
    const isTsUrl = urlMime === 'video/mp2t';
    const isFlvUrl = urlMime === 'video/x-flv';
    const isHlsUrl = urlMime === 'application/vnd.apple.mpegurl';

    // webOS: the TV's hardware HLS/TS decoders beat MSE libraries, so play
    // natively. Explicit extensions and previously verified routes avoid a
    // probe; only a cold ambiguous route pays the bounded classification cost.
    if (isWebOS) {
      if (opts?.direct) {
        const mime = containerMime(url);
        log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
          '| webOS native VOD | MIME', mime);
        this.playNative(url, mime);
        return;
      }
      if (isTsUrl || isFlvUrl || isHlsUrl) {
        const mime = isFlvUrl ? 'video/x-flv'
          : isTsUrl ? 'video/mp2t'
          : 'application/vnd.apple.mpegurl';
        log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
          '| webOS native | catchup:', this.callbacks.isCatchup(), '| MIME', mime);
        if (isHlsUrl) void this.loadManifest(url, this.manifestSeq, token);
        this.playNative(url, mime);
        return;
      }
      const routeKey = streamRouteKey(url);
      const cachedMime = StorageService.getStreamMime(routeKey);
      if (cachedMime) {
        log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
          '| webOS native | cached MIME', cachedMime,
          '| catchup:', this.callbacks.isCatchup());
        if (cachedMime === 'application/vnd.apple.mpegurl') {
          void this.loadManifest(url, this.manifestSeq, token);
        }
        this.playNative(url, cachedMime);
        return;
      }
      void this.detectContentType(url).then(contentType => {
        if (token !== this.loadToken || !this.videoEl) return;
        const mime = streamMime(contentType);
        if (routeKey && contentType &&
            contentType.split(';')[0].trim() !== 'application/octet-stream') {
          StorageService.setStreamMime(routeKey, mime);
        }
        log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
          '| webOS native | content-type:', contentType || '(none)',
          '| catchup:', this.callbacks.isCatchup(), '| MIME', mime || '(auto)');
        if (mime === 'application/vnd.apple.mpegurl') {
          void this.loadManifest(url, this.manifestSeq, token);
        }
        this.playNative(url, mime);
      });
      return;
    }

    // Desktop preview: native HLS is unreliable across Chrome/Firefox/Linux, so
    // always route through hls.js/mpegts.js. URL extensions lie — some providers
    // serve HLS with no .m3u8 suffix — so classify by the server's Content-Type,
    // falling back to the URL and defaulting to HLS.
    if (opts?.direct) {
      log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl, '| desktop direct VOD');
      videoEl.src = url;
      videoEl.play().catch(e => log.warn('Direct play() rejected:', e));
      return;
    }
    void this.detectContentType(url).then(ct => {
      if (token !== this.loadToken || !this.videoEl) return;
      const isFlv = isFlvUrl || ct.includes('flv');
      const isTs = isTsUrl || ct.includes('mp2t');
      const isDirect = !isTs && !isFlv && /^(?:video|audio)\//.test(ct);
      const isHls = !isTs && !isFlv && !isDirect;
      log.info('loadStream', this.callbacks.playbackLabel(token), 'url=', safeUrl,
        '| content-type:', ct || '(none)', '| catchup:', this.callbacks.isCatchup(),
        '| isHls:', isHls, '| isTs:', isTs, '| isFlv:', isFlv);
      if (isTs || isFlv) {
        log.info('Using mpegts.js');
        this.loadWithMpegts(url, isFlv);
      } else if (isDirect) {
        log.info('Using direct video src');
        this.videoEl.src = url;
        this.videoEl.play().catch(e => log.warn('Direct play() rejected:', e));
      } else {
        log.info('Using hls.js');
        this.loadWithHls(url, extras);
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
  }

  private destroyLoaders(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.mpegtsPlayer) {
      this.mpegtsPlayer.destroy();
      this.mpegtsPlayer = null;
    }
  }

  // Classify a stream by the server's Content-Type — URL extensions are
  // unreliable for proxied/extension-less streams, so the response header is the
  // real signal. Headers are enough, so cancel the body. Returns '' on a
  // CORS/network failure, leaving the caller on its URL heuristic (default HLS).
  private async detectContentType(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.PLAYER.MANIFEST_TIMEOUT);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch(url, { signal: controller.signal });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.split(';')[0].trim() !== 'application/octet-stream') {
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
    } catch {
      return '';
    } finally {
      if (reader) void reader.cancel().catch(() => {});
      clearTimeout(timer);
    }
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
    videoEl.play().catch(e => log.warn('Native play() rejected', this.videoLabel(videoEl),
      this.callbacks.mediaState(videoEl), e));
  }

  private loadWithHls(url: string, extras: Record<string, string> | null): void {
    if (!this.videoEl) return;
    const Hls = win.__Hls as HlsType | undefined;
    try {
      if (!Hls?.isSupported()) {
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
      hls.loadSource(url);
      hls.attachMedia(this.videoEl);
      // The audio/subtitle track lists aren't ready at MANIFEST_PARSED — hls.js
      // fills them and fires their *_TRACKS_UPDATED events separately, so apply
      // the saved picks there.
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, this.callbacks.onAudioTracksUpdated);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, this.callbacks.onSubtitleTracksUpdated);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log.info('hls.js MANIFEST_PARSED — starting playback');
        this.videoEl?.play().catch(e => log.warn('hls play() rejected:', e));
      });
      // A good fragment played: the stream recovered, so refill the retry budget.
      hls.on(Hls.Events.FRAG_BUFFERED, () => { this.hlsRecoveries = 0; });
      // Bounded recovery: retry transient network/media errors (and rotating-URL
      // re-fetches) a few times, but give up on a genuinely dead stream so it
      // zaps to the next channel instead of retrying forever.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        log.warn('hls.js error', { type: data.type, details: data.details, fatal: data.fatal });
        if (!data.fatal) return;
        if (this.hlsRecoveries >= CONFIG.PLAYER.HLS_MAX_RECOVERIES) {
          this.callbacks.onError();
          return;
        }
        this.hlsRecoveries++;
        const n = `${this.hlsRecoveries}/${CONFIG.PLAYER.HLS_MAX_RECOVERIES}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log.info(`hls.js fatal network error — restarting load (${n})`);
          this.hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log.info(`hls.js fatal media error — recovering (${n})`);
          this.hls?.recoverMediaError();
        } else {
          this.callbacks.onError();
        }
      });
    } catch {
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  private loadWithMpegts(url: string, isFlv: boolean): void {
    if (!this.videoEl) return;
    const mpegts = win.__mpegts as MpegtsType | undefined;
    try {
      if (!mpegts?.isSupported()) {
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
      player.on(mpegts.Events.ERROR, this.callbacks.onError);
    } catch {
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  // Fetch the HLS master once and parse its audio + subtitle rendition names so
  // the pickers, toasts and per-channel memory show real labels instead of
  // "Audio 2" / "Subtitle 2". Native audio/text tracks carry no usable
  // name/language on webOS, so this is the only source. The Player re-applies
  // saved picks when the parsed manifest is delivered.
  private async loadManifest(url: string, seq: number, loadToken: number): Promise<void> {
    const controller = new AbortController();
    const started = Date.now();
    this.manifestController?.abort();
    this.manifestController = controller;
    try {
      const text = await fetchLimitedText(
        url,
        CONFIG.PLAYER.MANIFEST_MAX_BYTES,
        CONFIG.PLAYER.MANIFEST_TIMEOUT,
        controller.signal,
        '#EXTM3U',
      );
      if (seq !== this.manifestSeq) return;
      log.debug('manifest fetched', this.callbacks.playbackLabel(loadToken),
        `bytes=${String(text.length)} elapsed=${String(Date.now() - started)}ms`);
      const audio = parseAudioRenditions(text);
      const subtitles = parseSubtitleRenditions(text);
      const closedCaptions = parseClosedCaptions(text);
      const variants = parseVariants(text);
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
    } catch (e) {
      if (controller.signal.aborted) return;
      log.warn('manifest fetch failed', this.callbacks.playbackLabel(loadToken),
        `elapsed=${String(Date.now() - started)}ms`, e);
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
