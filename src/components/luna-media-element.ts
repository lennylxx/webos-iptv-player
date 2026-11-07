import { CONFIG } from '../config';
import {
  buildLoadParameters,
  findWindowId,
  foregroundAppInfo,
  isMissingMethod,
  LunaMediaError,
  loadMedia,
  mediaCommand,
  seekMedia,
  selectAudioTrack,
  setDisplayWindow,
  setMediaVolume,
  subscribeMedia,
  type LunaDisplay,
  type LunaTransport,
} from '../services/luna-media';
import { isLunaAvailable, type LunaRequestHandle } from '../services/luna';
import { createLogger } from '../utils/logger';

const log = createLogger('Player');

export type LunaFallbackReason = 'no_window' | 'load_failed' | 'error' | 'timeout';
/** Where the start failed: the window lookup, a Luna call, or the UMS stream. */
export type LunaFallbackStage =
  | 'media_id' | 'app_info' | 'no_match'
  | 'window' | 'load' | 'completed' | 'playing'
  | 'subscription' | 'event' | 'play';

export interface LunaMediaElementOptions {
  uri: string;
  headers: Record<string, string>;
  /** Defaults to HLS. */
  transport?: LunaTransport;
  /** A loaded PlayReady DRM client, for protected DASH. */
  playReadyClientId?: string;
  /** The playback label (`session=… load=…`) its diag events carry. */
  label: string;
  /**
   * Called at most once, before loadCompleted, after the element is
   * restored. unsupported: the TV answered that it has no window lookup,
   * which no retry changes.
   */
  onFallback: (reason: LunaFallbackReason, code: number, stage: LunaFallbackStage, unsupported?: boolean) => void;
  /** Called once, when the stream first plays. */
  onStarted?: () => void;
  /**
   * Called on a pipeline error after the stream played; true when the caller
   * moved the stream elsewhere, so no error event follows.
   */
  onPlaybackError?: (code: number) => boolean;
  /** Called when the audio list or its selection changes, once loaded. */
  onAudioTracks?: () => void;
}

/** An audio rendition as UMS lists it; `index` is what selectTrack takes. */
export interface LunaAudioTrack {
  index: number;
  language: string;
  selected: boolean;
}

interface AudioSwitch {
  from: number;
  to: number;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// The placeholder's own media events would describe a 2 s clip, not the stream.
const MEDIA_EVENTS = [
  'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied', 'ended',
  'error', 'loadeddata', 'loadedmetadata', 'loadstart', 'pause', 'play',
  'playing', 'progress', 'ratechange', 'resize', 'seeked', 'seeking',
  'stalled', 'suspend', 'timeupdate', 'volumechange', 'waiting',
];

const OVERRIDDEN = [
  'currentTime', 'duration', 'paused', 'seeking', 'ended', 'readyState',
  'networkState', 'buffered', 'seekable', 'videoWidth', 'videoHeight',
  'error', 'muted', 'volume', 'play', 'pause', 'mediaId',
] as const;

const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;
const NETWORK_LOADING = 2;
const MEDIA_ERR_NETWORK = 2;

type WebOsVideo = HTMLVideoElement & { mediaId?: string };

interface Range {
  start: number;
  end: number;
}

function timeRanges(range: Range | null): TimeRanges {
  const ranges = range && range.end > range.start ? [range] : [];
  const at = (index: number, key: keyof Range): number => {
    const item = ranges[index];
    if (!item) throw new RangeError('Index out of range');
    return item[key];
  };
  return {
    length: ranges.length,
    start: (index: number) => at(index, 'start'),
    end: (index: number) => at(index, 'end'),
  } as TimeRanges;
}

function eventValue(event: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (!(key in event)) return null;
  const value = event[key];
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : { [key]: value };
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(value: unknown, keys: readonly string[]): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = numberField(record, key);
    if (found !== null) return found;
  }
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const nested = record[key];
    const found = Array.isArray(nested) ? firstNumber(nested[0], keys) : null;
    if (found !== null) return found;
  }
  return null;
}

// A restored element can still deliver queued placeholder events; each video
// ends the previous adapter's quiet period before a new one starts.
const quietEnders = new WeakMap<HTMLVideoElement, () => void>();
// Unloads still in flight, which a new load can race for the decoder.
let pendingUnloads = 0;

function unloadMedia(mediaId: string): Promise<void> {
  pendingUnloads++;
  return mediaCommand('unload', mediaId).then(() => {
    pendingUnloads--;
  }, (error: unknown) => {
    pendingUnloads--;
    throw error;
  });
}

function errorCode(error: unknown): number {
  return error instanceof LunaMediaError ? error.code : -1;
}

function displayMode(display: LunaDisplay): string {
  return display === 'full' ? 'mode=full'
    : `mode=rect rect=${String(display.x)},${String(display.y)},${String(display.width)}x${String(display.height)}`;
}

// sourceInfo's programInfo[0].audioTrackInfo, read defensively; null when absent.
function audioTrackInfo(info: Record<string, unknown>): LunaAudioTrack[] | null {
  const programs = info.programInfo;
  const program: unknown = Array.isArray(programs) ? programs[0] : null;
  const list = program && typeof program === 'object'
    ? (program as Record<string, unknown>).audioTrackInfo
    : undefined;
  if (!Array.isArray(list)) return null;
  return list.map((item: unknown, index) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const language = typeof record.language === 'string' ? record.language.trim() : '';
    return {
      index,
      language: language.toLowerCase() === 'und' ? '' : language,
      selected: record.selected === true,
    };
  });
}

function protoMethod(name: 'play' | 'pause' | 'load'): (this: HTMLMediaElement) => unknown {
  return HTMLMediaElement.prototype[name] as (this: HTMLMediaElement) => unknown;
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Plays a stream through com.webos.media/load and presents it as the player
 * <video>: the element keeps a bundled placeholder clip (whose window ID the
 * Luna pipeline borrows for its picture) while its media state and events are
 * overridden from the UMS subscription. Player code needs no special cases.
 */
export class LunaMediaElement {
  private state: 'idle' | 'starting' | 'loaded' | 'closed' = 'idle';
  private lunaMediaId = '';
  private subscription: LunaRequestHandle | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private forcePlayTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataSent = false;
  private sourceInfoSeen = false;
  private started = false;
  private firstFrameSent = false;
  private lastAdvanceAt = 0;
  private seekTarget = 0;
  private seekFrom = 0;
  private dispatching = false;
  private display: LunaDisplay = 'full';
  private appliedDisplay = '';
  private saved = new Map<string, PropertyDescriptor | undefined>();
  private hadLoop = false;
  private placeholderStarted = false;
  private phase: 'window' | 'load' | 'completed' = 'window';
  private windowMiss: { stage: LunaFallbackStage; code: number } = { stage: 'media_id', code: 0 };
  private startAt = 0;
  private windowMs = -1;
  private loadMs = -1;
  private completedMs = -1;
  private forcedPlay = false;
  private shownMode = '';
  private displayFailLogged = false;
  private seekFailLogged = false;
  private audio: LunaAudioTrack[] = [];
  private audioSwitch: AudioSwitch | null = null;
  private audioConfirmed = -1;
  private audioChangeReported = false;

  private time = 0;
  private timeAt = 0;
  private durationS = NaN;
  private pausedState = true;
  private seekingState = false;
  private endedState = false;
  private ready = HAVE_NOTHING;
  private bufferedRange: Range | null = null;
  private seekableRange: Range | null = null;
  private width = 0;
  private height = 0;
  private errorState: MediaError | null = null;
  private mutedState: boolean;
  private volumeState: number;

  constructor(private readonly video: HTMLVideoElement, private readonly options: LunaMediaElementOptions) {
    this.mutedState = video.muted;
    this.volumeState = video.volume;
  }

  get mediaId(): string {
    return this.lunaMediaId;
  }

  isLoaded(): boolean {
    return this.state === 'loaded';
  }

  /** Not yet playing, so the start deadline still decides its fate. */
  isStarting(): boolean {
    return this.state === 'starting' || (this.state === 'loaded' && !this.started);
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    this.startAt = Date.now();
    quietEnders.get(this.video)?.();
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      // A pipeline that loaded but never plays is as failed as one that never loads.
      if (this.state === 'starting') this.fail('timeout', 0, this.phase);
      else if (this.state === 'loaded' && !this.started) this.fail('timeout', 0, 'playing');
    }, CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    window.addEventListener('pagehide', this.onPageHide);
    for (const type of MEDIA_EVENTS) window.addEventListener(type, this.suppress, true);
    this.install();
    this.emit('loadstart');
    void this.run();
  }

  /** UMS's audio renditions; empty until loadCompleted, when selectTrack works. */
  audioTracks(): LunaAudioTrack[] {
    return this.state === 'loaded' ? this.audio.map(track => ({ ...track })) : [];
  }

  /**
   * Switches the Luna pipeline's audio rendition. Resolves true on trackSelected,
   * or when the call succeeded and no event followed; false on a refused call or
   * a pipeline error meanwhile. A newer switch or a teardown resolves it false.
   */
  selectAudio(index: number): Promise<boolean> {
    const mediaId = this.lunaMediaId;
    if (!mediaId || this.state !== 'loaded' || !this.audio[index]) return Promise.resolve(false);
    if (this.audioSwitch) this.finishAudio(this.audioSwitch, false);
    return new Promise(resolve => {
      const pending: AudioSwitch = {
        from: this.audio.findIndex(track => track.selected),
        to: index,
        resolve,
        timer: null,
      };
      this.audioSwitch = pending;
      selectAudioTrack(mediaId, index).then(() => {
        if (this.audioSwitch !== pending) return;
        pending.timer = setTimeout(() => this.finishAudio(pending, true),
          CONFIG.PLAYER.LUNA_MEDIA_AUDIO_EVENT_MS);
      }, error => {
        if (this.audioSwitch === pending) this.failAudio(pending, 'call', errorCode(error));
      });
    });
  }

  setDisplay(display: LunaDisplay): void {
    this.display = display;
    // Before loadCompleted the display service answers "Context Error";
    // onLoaded applies the latest rect.
    if (this.lunaMediaId && this.state === 'loaded') this.applyDisplay();
  }

  /** Unsubscribes, unloads the Luna pipeline, and restores the element. */
  destroy(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearTimers();
    if (this.audioSwitch) this.finishAudio(this.audioSwitch, false);
    this.subscription?.cancel();
    this.subscription = null;
    if (this.lunaMediaId) {
      const label = this.options.label;
      unloadMedia(this.lunaMediaId).catch(error => {
        log.warn('Luna unload failed', 'event=playback.luna.unload.failed', label,
          `code=${String(errorCode(error))}`);
      });
    }
    this.restore();
  }

  private async run(): Promise<void> {
    // On webOS 4 a placeholder clip played for nothing leaves the native
    // pipeline unable to play the next source, so the window lookup is
    // proven before the element is touched.
    try {
      await foregroundAppInfo();
    } catch (error) {
      if (this.state !== 'starting') return;
      const unsupported = isMissingMethod(error) && isLunaAvailable();
      this.fail('no_window', errorCode(error), 'app_info', unsupported);
      return;
    }
    if (this.state !== 'starting') return;
    this.startPlaceholder();
    let windowId = '';
    try {
      windowId = await this.placeholderWindowId();
    } catch (error) {
      windowId = '';
      this.windowMiss = { stage: 'app_info', code: errorCode(error) };
    }
    if (this.state !== 'starting') return;
    if (!windowId) {
      this.fail('no_window', this.windowMiss.code, this.windowMiss.stage);
      return;
    }
    this.windowMs = Date.now() - this.startAt;
    protoMethod('pause').call(this.video);
    if (pendingUnloads > 0) {
      log.info('Luna load starts before an unload finished', 'event=playback.luna.unload.pending',
        this.options.label, `count=${String(pendingUnloads)}`);
    }
    this.phase = 'load';
    let mediaId: string;
    try {
      mediaId = await loadMedia(buildLoadParameters(
        this.options.uri, this.options.transport ?? 'HLS', __APP_ID__, windowId, this.options.headers,
        this.options.playReadyClientId));
    } catch (error) {
      if (this.state === 'starting') this.fail('load_failed', errorCode(error), 'load');
      return;
    }
    if (this.state !== 'starting') {
      // Superseded while load was in flight: the pipeline is ours to release.
      unloadMedia(mediaId).catch(() => {});
      return;
    }
    this.loadMs = Date.now() - this.startAt;
    this.phase = 'completed';
    this.lunaMediaId = mediaId;
    // Before any play, so a muted preview never starts with sound.
    this.applyVolume();
    this.subscription = subscribeMedia(mediaId, this.onEvent, code => {
      if (this.state === 'starting') this.fail('error', code, 'subscription');
      else if (this.state === 'loaded') this.mediaError(code, 'subscription');
    });
    this.forcePlayTimer = setTimeout(() => {
      this.forcePlayTimer = null;
      if (this.state !== 'starting') return;
      // Some firmware sends no loadCompleted to a late subscriber; time then
      // advancing after play still completes the start.
      log.info('Luna loadCompleted missing, playing anyway', 'event=playback.luna.play.forced',
        this.options.label);
      this.forcedPlay = true;
      this.startPlay();
    }, CONFIG.PLAYER.LUNA_MEDIA_FORCE_PLAY_MS);
  }

  private async placeholderWindowId(): Promise<string> {
    const deadline = Date.now() + CONFIG.PLAYER.LUNA_MEDIA_WINDOW_TIMEOUT_MS;
    for (;;) {
      if (this.state !== 'starting') return '';
      const mediaId = this.placeholderMediaId();
      if (mediaId) {
        const windowId = findWindowId(await foregroundAppInfo(), __APP_ID__, mediaId);
        if (this.state !== 'starting') return '';
        if (windowId && this.placeholderMediaId() === mediaId) return windowId;
        this.windowMiss = { stage: 'no_match', code: 0 };
      }
      if (Date.now() >= deadline) return '';
      await waitMs(CONFIG.PLAYER.LUNA_MEDIA_WINDOW_POLL_MS);
    }
  }

  private placeholderMediaId(): string {
    const saved = this.saved.get('mediaId');
    const value: unknown = saved?.get
      ? saved.get.call(this.video)
      : saved ? saved.value : this.protoMediaId();
    return typeof value === 'string' ? value : '';
  }

  private protoMediaId(): unknown {
    let proto: object | null = Object.getPrototypeOf(this.video) as object | null;
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'mediaId');
      if (descriptor) return descriptor.get ? descriptor.get.call(this.video) : descriptor.value;
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return undefined;
  }

  private startPlaceholder(): void {
    const video = this.video;
    this.placeholderStarted = true;
    this.hadLoop = video.loop;
    video.classList.add('luna-media');
    video.removeAttribute('src');
    video.innerHTML = '';
    video.loop = true;
    // The clip has no audio track, so the element needs no mute (which would
    // flash the TV's mute OSD).
    video.src = CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER;
    protoMethod('load').call(video);
    const played = protoMethod('play').call(video) as Promise<void> | undefined;
    played?.catch?.(() => {});
  }

  private restore(): void {
    window.removeEventListener('pagehide', this.onPageHide);
    for (const type of MEDIA_EVENTS) window.removeEventListener(type, this.suppress, true);
    if (this.placeholderStarted) {
      for (const type of MEDIA_EVENTS) window.addEventListener(type, this.quiet, true);
      quietEnders.set(this.video, this.endQuiet);
      this.quietTimer = setTimeout(this.endQuiet, CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER_QUIET_MS);
    }
    this.uninstall();
    const video = this.video;
    if (video.muted !== this.mutedState) video.muted = this.mutedState;
    if (video.volume !== this.volumeState) video.volume = this.volumeState;
    if (!this.placeholderStarted) return;
    video.classList.remove('luna-media');
    video.loop = this.hadLoop;
    protoMethod('pause').call(video);
    video.removeAttribute('src');
    video.innerHTML = '';
    protoMethod('load').call(video);
  }

  private fail(reason: LunaFallbackReason, code: number, stage: LunaFallbackStage, unsupported = false): void {
    this.destroy();
    if (unsupported) this.options.onFallback(reason, code, stage, true);
    else this.options.onFallback(reason, code, stage);
  }

  private clearTimers(): void {
    for (const timer of [this.deadlineTimer, this.forcePlayTimer, this.metadataTimer, this.seekTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.deadlineTimer = null;
    this.forcePlayTimer = null;
    this.metadataTimer = null;
    this.seekTimer = null;
  }

  private applyDisplay(): void {
    const mediaId = this.lunaMediaId;
    // The live preview re-lays out every second; resend only a moved picture.
    const key = `${mediaId} ${JSON.stringify(this.display)}`;
    if (key === this.appliedDisplay) return;
    this.appliedDisplay = key;
    const mode = displayMode(this.display);
    setDisplayWindow(mediaId, this.display).then(() => {
      // Once per load and per full/rect switch, not per preview re-layout.
      const kind = mode.split(' ')[0];
      if (this.state === 'closed' || kind === this.shownMode) return;
      this.shownMode = kind;
      log.info('Luna picture placed', 'event=playback.luna.display', this.options.label, mode);
    }, error => {
      if (this.appliedDisplay === key) this.appliedDisplay = '';
      // The preview retries every re-layout; one line per load is enough.
      if (this.displayFailLogged) return;
      this.displayFailLogged = true;
      log.warn('Luna display window failed', 'event=playback.luna.display.failed', this.options.label,
        `code=${String(errorCode(error))}`);
    });
  }

  private command(method: 'play' | 'pause', onFailure?: (code: number) => void): Promise<void> {
    if (!this.lunaMediaId || this.state === 'closed') return Promise.resolve();
    const mediaId = this.lunaMediaId;
    return mediaCommand(method, mediaId).then(() => undefined, error => {
      const code = errorCode(error);
      log.warn(`Luna ${method} failed`, `event=playback.luna.${method}.failed`, this.options.label,
        `code=${String(code)}`);
      if (this.lunaMediaId === mediaId && this.state !== 'closed') onFailure?.(code);
    });
  }

  private startPlay(): void {
    // A refused play before the stream ever played is a failed start.
    void this.command('play', code => {
      if (!this.started) this.fail('error', code, 'play');
    });
  }

  private markStarted(): void {
    this.lastAdvanceAt = Date.now();
    if (this.started) return;
    this.started = true;
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    // The start timeline: window borrowed, load answered, loadCompleted, playing.
    log.info('Luna playback started', 'event=playback.luna.started', this.options.label,
      `windowMs=${String(this.windowMs)}`, `loadMs=${String(this.loadMs)}`,
      `completedMs=${this.completedMs < 0 ? 'none' : String(this.completedMs)}`,
      `startMs=${String(Date.now() - this.startAt)}`, `forced=${this.forcedPlay ? '1' : '0'}`);
    this.options.onStarted?.();
  }

  /**
   * The position between UMS reports, which come about once a second; NaN
   * until the first report, since 0 is not where a live stream starts.
   */
  clockTime(): number {
    if (!this.timeAt) return NaN;
    if (this.state !== 'loaded' || this.pausedState || this.seekingState
        || this.readyState() <= HAVE_CURRENT_DATA) {
      return this.time;
    }
    return this.time + Math.min(Date.now() - this.timeAt, CONFIG.PLAYER.LUNA_MEDIA_CLOCK_STEP_MS) / 1000;
  }

  // UMS may stall without bufferingStart; time that stops moving while
  // playing must still read as a stall to the player's watchdog.
  private readyState(): number {
    if (this.ready > HAVE_CURRENT_DATA && this.started && !this.pausedState
        && !this.seekingState
        && Date.now() - this.lastAdvanceAt >= CONFIG.PLAYER.LUNA_MEDIA_FROZEN_MS) {
      return HAVE_CURRENT_DATA;
    }
    return this.ready;
  }

  private applyVolume(): void {
    if (!this.lunaMediaId || this.state === 'closed') return;
    const volume = this.mutedState ? 0 : Math.round(Math.max(0, Math.min(1, this.volumeState)) * 100);
    setMediaVolume(this.lunaMediaId, volume).catch(error => {
      log.warn('Luna volume failed', 'event=playback.luna.volume.failed', this.options.label,
        `code=${String(errorCode(error))}`);
    });
  }

  private seek(seconds: number): void {
    if (!this.lunaMediaId || !Number.isFinite(seconds)) return;
    this.seekingState = true;
    this.seekFrom = this.time;
    this.time = Math.max(0, seconds);
    this.timeAt = Date.now();
    this.seekTarget = this.time;
    if (this.seekTimer !== null) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      if (this.seekingState) this.seekFailed('timeout', 0);
      this.finishSeek();
    }, CONFIG.PLAYER.LUNA_MEDIA_SEEK_TIMEOUT_MS);
    this.emit('seeking');
    const mediaId = this.lunaMediaId;
    seekMedia(mediaId, this.time * 1000).catch(error => {
      if (this.lunaMediaId !== mediaId || this.state === 'closed') return;
      this.seekFailed('refused', errorCode(error));
      this.finishSeek();
    });
  }

  private seekFailed(reason: 'refused' | 'timeout', code: number): void {
    if (this.seekFailLogged || this.state === 'closed') return;
    this.seekFailLogged = true;
    log.warn('Luna seek failed', 'event=playback.luna.seek.failed', this.options.label,
      `reason=${reason}`, `code=${String(code)}`);
  }

  private finishSeek(): void {
    if (this.seekTimer !== null) clearTimeout(this.seekTimer);
    this.seekTimer = null;
    if (!this.seekingState || this.state === 'closed') return;
    this.seekingState = false;
    this.emit('seeked');
  }

  private readonly suppress = (event: Event): void => {
    if (event.target === this.video && !this.dispatching) event.stopImmediatePropagation();
  };

  // After restore, until the next real source starts loading.
  private readonly quiet = (event: Event): void => {
    if (event.target !== this.video) return;
    if (event.type === 'loadstart' && this.realSourceLoading()) {
      this.endQuiet();
      return;
    }
    event.stopImmediatePropagation();
  };

  private readonly endQuiet = (): void => {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    for (const type of MEDIA_EVENTS) window.removeEventListener(type, this.quiet, true);
    if (quietEnders.get(this.video) === this.endQuiet) quietEnders.delete(this.video);
  };

  private realSourceLoading(): boolean {
    const src = this.video.getAttribute('src') || this.video.currentSrc
      || this.video.querySelector('source')?.getAttribute('src') || '';
    return !!src && src.indexOf(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER) < 0;
  }

  private readonly onPageHide = (): void => {
    this.destroy();
  };

  private emit(type: string): void {
    this.dispatching = true;
    try {
      this.video.dispatchEvent(new Event(type));
    } finally {
      this.dispatching = false;
    }
  }

  private readonly onEvent = (event: Record<string, unknown>): void => {
    if (this.state === 'closed') return;
    const error = eventValue(event, 'error');
    if (error) {
      const code = numberField(error, 'errorCode') ?? -1;
      // UMS reports `errorCode 0 "No Error"` right after subscribe.
      if (code !== 0) {
        if (this.state === 'starting') this.fail('error', code, 'event');
        else this.mediaError(code, 'event');
        return;
      }
    }
    if (eventValue(event, 'loadCompleted')) {
      if (this.completedMs < 0) this.completedMs = Date.now() - this.startAt;
      this.onLoaded();
    }
    const sourceInfo = eventValue(event, 'sourceInfo');
    if (sourceInfo) this.onSourceInfo(sourceInfo);
    const trackSelected = eventValue(event, 'trackSelected');
    if (trackSelected) this.onTrackSelected(trackSelected);
    const videoInfo = eventValue(event, 'videoInfo');
    if (videoInfo) this.onVideoInfo(videoInfo);
    const current = numberField(eventValue(event, 'currentTime'), 'currentTime');
    if (current !== null) this.onCurrentTime(current / 1000);
    const buffer = eventValue(event, 'bufferRange');
    if (buffer) {
      const begin = numberField(buffer, 'beginTime');
      const end = numberField(buffer, 'endTime');
      if (begin !== null && end !== null) {
        this.bufferedRange = { start: begin / 1000, end: end / 1000 };
        this.emit('progress');
      }
    }
    const seekable = eventValue(event, 'seekableRanges');
    if (seekable) {
      const start = numberField(seekable, 'start') ?? numberField(seekable, 'beginTime');
      const end = numberField(seekable, 'end') ?? numberField(seekable, 'endTime');
      if (start !== null && end !== null) {
        this.seekableRange = { start: start / 1000, end: end / 1000 };
        this.emit('durationchange');
      }
    }
    if (eventValue(event, 'playing')) this.onPlaying();
    if (eventValue(event, 'paused') && !this.pausedState) {
      this.pausedState = true;
      this.emit('pause');
    }
    if (eventValue(event, 'bufferingStart')) {
      if (this.ready > HAVE_CURRENT_DATA) this.ready = HAVE_CURRENT_DATA;
      this.emit('waiting');
    }
    if (eventValue(event, 'bufferingEnd')) this.endBuffering();
    if (eventValue(event, 'seekDone')) this.finishSeek();
    if (eventValue(event, 'endOfStream')) {
      this.endedState = true;
      this.pausedState = true;
      this.emit('ended');
    }
  };

  private endBuffering(): void {
    this.lastAdvanceAt = Date.now();
    if (!this.firstFrameSent || this.ready >= HAVE_ENOUGH_DATA) return;
    this.ready = HAVE_ENOUGH_DATA;
    if (!this.pausedState) this.emit('playing');
  }

  private onLoaded(): void {
    if (this.state !== 'starting') return;
    this.state = 'loaded';
    this.applyDisplay();
    if (this.audio.length) this.options.onAudioTracks?.();
    if (this.forcePlayTimer !== null) clearTimeout(this.forcePlayTimer);
    this.forcePlayTimer = null;
    // loadedmetadata waits for sourceInfo, so a VOD/catch-up duration is
    // known when the player seeks to its resume position.
    if (this.sourceInfoSeen) this.sendMetadata();
    else {
      this.metadataTimer = setTimeout(() => this.sendMetadata(),
        CONFIG.PLAYER.LUNA_MEDIA_METADATA_WAIT_MS);
    }
  }

  private sendMetadata(): void {
    if (this.metadataTimer !== null) clearTimeout(this.metadataTimer);
    this.metadataTimer = null;
    if (this.metadataSent || this.state !== 'loaded') return;
    this.metadataSent = true;
    if (this.ready < HAVE_METADATA) this.ready = HAVE_METADATA;
    if (Number.isNaN(this.durationS)) this.durationS = Infinity;
    this.emit('durationchange');
    this.emit('loadedmetadata');
    this.applyVolume();
    this.startPlay();
  }

  private onPlaying(): void {
    if (this.state === 'starting') this.onLoaded();
    this.sendMetadata();
    this.finishSeek();
    this.markStarted();
    const wasPaused = this.pausedState;
    this.pausedState = false;
    this.endedState = false;
    this.ready = HAVE_ENOUGH_DATA;
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.emit('loadeddata');
      this.emit('canplay');
    }
    if (wasPaused) this.emit('play');
    this.emit('playing');
  }

  private onCurrentTime(seconds: number): void {
    // Some firmware sends no loadCompleted to a late subscriber; time moving
    // proves the pipeline is playing.
    if (this.state === 'starting' && seconds > 0) this.onLoaded();
    if (this.seekingState) {
      // Positions nearer the pre-seek time are stale reports, not the seek.
      if (seconds <= this.seekTarget
          || seconds - this.seekTarget >= Math.abs(seconds - this.seekFrom)) return;
      this.time = seconds;
      this.finishSeek();
    }
    if (seconds > this.time && this.state === 'loaded' && this.metadataSent) {
      // Once started, only UMS or the player changes paused: a late position
      // after a pause must not resume the OSD.
      if (!this.started) this.onPlaying();
      else if (!this.pausedState) {
        this.markStarted();
        this.endBuffering();
      }
    }
    this.time = seconds;
    this.timeAt = Date.now();
    this.emit('timeupdate');
  }

  private onSourceInfo(info: Record<string, unknown>): void {
    const durationMs = firstNumber(info, ['duration']);
    const duration = durationMs !== null && durationMs > 0 ? durationMs / 1000 : Infinity;
    this.sourceInfoSeen = true;
    if (duration !== this.durationS) {
      this.durationS = duration;
      if (Number.isFinite(duration)) this.seekableRange = { start: 0, end: duration };
      if (this.metadataSent) this.emit('durationchange');
    }
    this.onVideoInfo(info);
    const audio = audioTrackInfo(info);
    if (audio) this.onAudioInfo(audio);
    if (this.state === 'loaded') this.sendMetadata();
  }

  // A re-push with the same tracks keeps a switch UMS already confirmed; only
  // a different count or language list replaces the list wholesale.
  private onAudioInfo(audio: LunaAudioTrack[]): void {
    if (JSON.stringify(audio) === JSON.stringify(this.audio)) return;
    const first = !this.audio.length;
    const change = audio.length !== this.audio.length ? 'count'
      : audio.some((track, i) => track.language !== this.audio[i].language) ? 'langs' : 'selected';
    const keep = change === 'selected' && (this.audioConfirmed >= 0 || !!this.audioSwitch);
    if (!first) this.reportAudioChange(change, audio, keep);
    if (keep) return;
    this.audio = audio;
    if (change !== 'selected') this.audioConfirmed = -1;
    if (this.state === 'loaded') this.options.onAudioTracks?.();
  }

  private reportAudioChange(change: string, audio: LunaAudioTrack[], kept: boolean): void {
    if (this.audioChangeReported) return;
    this.audioChangeReported = true;
    const selected = (list: LunaAudioTrack[]) => String(list.findIndex(track => track.selected));
    log.info('Luna audio tracks changed', 'event=audio.luna.tracks.changed', this.options.label,
      `change=${change}`, `count=${String(this.audio.length)}>${String(audio.length)}`,
      `langs=${audio.map(track => track.language || 'und').join(',')}`,
      `selected=${selected(this.audio)}>${selected(audio)}`, `kept=${String(kept)}`);
  }

  private onTrackSelected(record: Record<string, unknown>): void {
    if (typeof record.type === 'string' && record.type !== 'audio') return;
    const pending = this.audioSwitch;
    const index = numberField(record, 'index') ?? pending?.to ?? null;
    if (index === null) return;
    if (pending && pending.to === index) this.finishAudio(pending, true);
    else this.markAudioSelected(index);
  }

  private markAudioSelected(index: number): void {
    const track = this.audio[index];
    if (!track) return;
    this.audioConfirmed = index;
    if (track.selected) return;
    for (const item of this.audio) item.selected = item.index === index;
    if (this.state === 'loaded') this.options.onAudioTracks?.();
  }

  private finishAudio(pending: AudioSwitch, ok: boolean): void {
    if (this.audioSwitch !== pending) return;
    this.audioSwitch = null;
    if (pending.timer !== null) clearTimeout(pending.timer);
    if (ok) this.markAudioSelected(pending.to);
    pending.resolve(ok);
  }

  private failAudio(pending: AudioSwitch, reason: 'call' | 'error', code: number): void {
    log.warn('Luna audio switch failed', 'event=audio.luna.switch.failed', this.options.label,
      `reason=${reason}`, `code=${String(code)}`, `from=${String(pending.from)}`, `to=${String(pending.to)}`);
    this.finishAudio(pending, false);
  }

  private onVideoInfo(info: Record<string, unknown>): void {
    const width = firstNumber(info, ['width']);
    const height = firstNumber(info, ['height']);
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.emit('resize');
  }

  private mediaError(code: number, source: 'event' | 'subscription'): void {
    // An error while a switch is in flight leaves the previous rendition selected.
    if (this.audioSwitch) this.failAudio(this.audioSwitch, 'error', code);
    log.warn('Luna playback error', 'event=playback.luna.error', this.options.label,
      `code=${String(code)}`, `source=${source}`);
    if (this.started && this.options.onPlaybackError?.(code)) return;
    this.errorState = { code: MEDIA_ERR_NETWORK, message: `UMS error ${String(code)}` } as MediaError;
    this.emit('error');
  }

  private install(): void {
    const self = this;
    const accessors: Record<(typeof OVERRIDDEN)[number], PropertyDescriptor> = {
      currentTime: {
        get: () => self.time,
        set: (value: number) => self.seek(Number(value)),
      },
      duration: { get: () => self.durationS },
      paused: { get: () => self.pausedState },
      seeking: { get: () => self.seekingState },
      ended: { get: () => self.endedState },
      readyState: { get: () => self.readyState() },
      networkState: { get: () => NETWORK_LOADING },
      buffered: { get: () => timeRanges(self.bufferedRange) },
      seekable: { get: () => timeRanges(self.seekableRange) },
      videoWidth: { get: () => self.width },
      videoHeight: { get: () => self.height },
      error: { get: () => self.errorState },
      muted: {
        get: () => self.mutedState,
        set: (value: boolean) => {
          if (self.mutedState === !!value) return;
          self.mutedState = !!value;
          self.applyVolume();
          self.emit('volumechange');
        },
      },
      volume: {
        get: () => self.volumeState,
        set: (value: number) => {
          if (!Number.isFinite(value) || self.volumeState === value) return;
          self.volumeState = value;
          self.applyVolume();
          self.emit('volumechange');
        },
      },
      play: {
        value: (): Promise<void> => {
          if (!self.pausedState && !self.endedState) return Promise.resolve();
          if (!self.metadataSent) return self.command('play');
          // Optimistic, so the OSD needs no UMS echo; a refusal reverts it.
          self.pausedState = false;
          self.endedState = false;
          self.emit('play');
          return self.command('play', () => {
            if (self.pausedState) return;
            self.pausedState = true;
            self.emit('pause');
          });
        },
      },
      // Unlike the element's, settles once UMS answered, so a caller can wait
      // for the pause to land.
      pause: {
        value: (): Promise<void> => {
          if (self.pausedState) return Promise.resolve();
          self.pausedState = true;
          self.emit('pause');
          return self.command('pause', () => {
            if (!self.pausedState) return;
            self.pausedState = false;
            self.emit('play');
            self.emit('playing');
          });
        },
      },
      mediaId: { get: () => self.lunaMediaId || undefined },
    };
    for (const key of OVERRIDDEN) {
      this.saved.set(key, Object.getOwnPropertyDescriptor(this.video, key));
      Object.defineProperty(this.video, key, {
        configurable: true,
        enumerable: false,
        ...accessors[key],
        ...('value' in accessors[key] ? { writable: true } : {}),
      });
    }
  }

  private uninstall(): void {
    const target = this.video as WebOsVideo;
    for (const [key, descriptor] of this.saved) {
      delete (target as unknown as Record<string, unknown>)[key];
      if (descriptor) Object.defineProperty(target, key, descriptor);
    }
    this.saved.clear();
  }
}
