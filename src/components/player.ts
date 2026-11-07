import type {
  Action,
  AudioTrackOption,
  CatchupInfo,
  Channel,
  ChannelScope,
  LivePlaybackSnapshot,
  LivePlaybackStatus,
  NumberEvent,
  SubtitleTrackOption,
  VodPlayback,
  VodQueueItem,
  XtreamCatchupSource,
} from '../types';
import {
  formatXtreamCatchupStart,
  xtreamCatchupSources as buildXtreamCatchupSources,
  xtreamCredentialsFromLiveUrl,
} from '../utils/xtream-url';
import { show, hide } from '../utils/dom';
import {
  channelExactStreamIdentity,
  channelExactStreamKey,
  channelHttpHeaders,
  channelKey,
  channelStreamIdentity,
  channelStreamKey,
} from '../utils/channel';
import { dvrWindow, dvrState, type DvrWindow } from '../utils/dvr';
import { PlaylistService } from '../services/playlist-service';
import {
  ParentalControlService,
  liveParentalRequest,
  parentalTargetKey,
} from '../services/parental-control';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { CONFIG } from '../config';
import { StallWatchdog, type StallProbe, type StallRecovery } from '../utils/stall-watchdog';
import { StartupWatchdog, type StartupFailure, type StartupProbe } from '../utils/startup-watchdog';
import { resolutionBadge, hdrLabel, frameRateLabel, pickVariant, codecName, audioSummary, subtitleSummary, type StreamVariant, type MediaInfo } from '../utils/stream-info';
import { extFromUrl, diagnosticStreamUrl, streamUrlMime } from '../utils/url';
import { isWebOS } from '../utils/platform';
import { InputMode } from '../navigation/input-mode';
import { probeMedia } from '../services/media-probe';
import { ChannelHealthService } from '../services/channel-health';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { showToast } from './toast';
import { PlayerPipeline, type PipelineLoadOptions, type PipelineManifest } from './player-pipeline';
import type { Rectangle } from './player-presentation';
import {
  PlaybackRateController,
  type PlaybackRate,
  type PlaybackRateState,
} from '../services/playback-rate';
import {
  PlayerOsd,
  type PlayerOsdSnapshot,
  type PlayerOsdStreamInfo,
} from './player-osd';
import { PlayerTracks } from './player-tracks';

const log = createLogger('Player');

interface LunaResume {
  channel: Channel;
  position: number;
  paused: boolean;
}

// A coarse position for diagnostics, in 10 s steps.
function secondsBucket(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0 ? String(Math.floor(seconds / 10) * 10) : '0';
}

// True on the TV's webOS WebView; false in desktop preview / tests.
const STREAMING_MIMES = new Set(['application/vnd.apple.mpegurl', 'application/dash+xml']);

export class Player {
  private container: HTMLElement;
  private onBack: () => void;
  private onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void;
  private canAutoRevealOsd: () => boolean;
  private onChannelHealthChanged: () => void;
  private videoEl: HTMLVideoElement | null = null;
  private pipeline: PlayerPipeline;
  private tracks: PlayerTracks;
  private playbackRate: PlaybackRateController;
  private osd: PlayerOsd;
  private currentChannel: Channel | null = null;
  private currentIndex = -1;
  private currentIndexAnchor = -1;
  // The view (group/playlist) the current channel was launched from, if any —
  // null for launches with no such view (search, reminders, resume-on-boot),
  // which keeps channel_up/channel_down on the full list exactly as before.
  private currentScope: ChannelScope | null = null;
  private catchupInfo: CatchupInfo | null = null;
  private vod: VodPlayback | null = null;
  private upNextSeconds = 0;
  private upNextTimer: ReturnType<typeof setInterval> | null = null;
  private upNextAuthorized = false;
  private vodTracksLatePending = false;
  private pendingResumeSecs = 0;
  private pendingSeekTarget: number | null = null;
  private wasPlayingBeforeHide = false;
  private hidden = false;
  private syncOnResume = false;
  // Counts rebinds that only swapped the channel object, so a deferred play
  // can pick the copy a refresh put in its place.
  private rebinds = 0;
  private dvrPauseTick: ReturnType<typeof setInterval> | null = null;
  // Catch-up progress checkpointing. Wall-clock time of the last periodic save;
  // reset to Date.now() on every new catch-up session so the first checkpoint
  // fires CHECKPOINT_INTERVAL after tune-in, not immediately.
  private catchupCheckpointAt = 0;
  // Position (seconds) saved from the video element before suspend() destroys it.
  // play() consumes this to restore the position on resume; -1 = not pending.
  private catchupSuspendPos = -1;
  private catchupSourceIndex = 0;
  private catchupVariantConfirmed = false;
  private playbackGeneration = 0;
  private healthSuccessGeneration = -1;
  private healthStartedAt = 0;
  private liveHistoryGeneration = -1;
  private liveHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRetryPending = false;
  // Manual A/V resync (catch-up / VOD): true from the resync seek until playback
  // resumes, gating the "Resyncing…" message and debouncing repeat presses.
  private resyncing = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestVariants: StreamVariant[] = []; // HLS master variants for best-effort codec readout
  private vodInfo: MediaInfo | null = null; // container-header stream info for the active VOD (codec/fps/HDR)
  private stallWatchdog: StallWatchdog;
  private startupWatchdog: StartupWatchdog;
  private startupPending = false;
  private proxyReopened = false;
  // A frame came from the current load, or from any load since the user's.
  private loadPlayed = false;
  private channelPlayed = false;
  // A reopened proxy session seeks back to where a finite stream was.
  private reopenResume = false;
  // The user paused the element; startup, reloads, and `play` clear it.
  private userPaused = false;
  private lunaStallHeldLoad = -1; // one playback.luna.stall.held event per load
  // Hiding unloads Luna even when paused, unlike the element; resume reloads
  // at this position (0 for live) and pauses again once playing.
  private lunaResume: LunaResume | null = null;
  private lunaRestore: LunaResume | null = null;
  // The user's mute while a paused restore plays silently, until it pauses.
  private lunaRestoreMute: boolean | null = null;
  private liveSessionActive = false;
  private playbackActive = false;
  private livePreviewMode = false;
  private livePlaybackStatus: LivePlaybackStatus = 'loading';
  private liveMuted = false;
  private liveVolume = 1;
  private previewMuteOverride: boolean | null = null;
  constructor(
    container: HTMLElement,
    onBack: () => void,
    onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void = () => {},
    canAutoRevealOsd: () => boolean = () => true,
    onChannelHealthChanged: () => void = () => {},
    private onPlaybackStateChanged: () => void = () => {},
    private canResumePlayback: () => boolean = () => true,
    private authorizeLive: (
      channel: Channel,
      action: () => void,
      preview: boolean,
      ask?: boolean,
    ) => boolean = (_channel, action) => {
      action();
      return true;
    },
    private authorizeVod: (
      item: VodPlayback,
      action: () => void,
    ) => boolean = (_item, action) => {
      action();
      return true;
    },
  ) {
    this.container = container;
    this.onBack = onBack;
    this.onTvPlaybackChanged = onTvPlaybackChanged;
    this.canAutoRevealOsd = canAutoRevealOsd;
    this.onChannelHealthChanged = onChannelHealthChanged;
    this.pipeline = new PlayerPipeline({
      playbackLabel: loadToken => this.playbackLabel(loadToken),
      mediaState: video => this.mediaState(video),
      isCatchup: () => this.catchupInfo !== null,
      headerPlayback: () => StorageService.getHeaderPlayback(),
      onError: reason => this.onError(reason),
      onAudioTracksUpdated: () => {
        this.tracks.applyHlsAudioSelection();
        this.tracks.applyLunaAudioSelection();
        if (this.osd.isVisible()) this.osd.render();
        // A Luna switch confirms later, so the open menu's Audio row needs it too.
        this.onPlaybackStateChanged();
      },
      onSubtitleTracksUpdated: () => {
        this.tracks.applyHlsSubtitleSelection();
        if (this.osd.isVisible()) this.osd.render();
      },
      onManifest: manifest => this.applyPipelineManifest(manifest),
      onPlaybackPathChange: () => {
        this.tracks.stopSelfRender();
        // A path change reloads the element, which reads NETWORK_NO_SOURCE
        // until its resource selection runs: a tick due now would call that
        // source refused.
        if (this.startupPending) this.startupWatchdog.start();
        // Frozen ticks counted against Luna would reload the fallback source
        // in the same instant it starts.
        this.stallWatchdog.restartFreeze();
      },
      // A Luna stream that failed after playing moved to the proxy: that
      // step has its own start to make, and its failure must not rerun Luna.
      onStepRestarted: () => {
        this.loadPlayed = false;
        this.channelPlayed = false;
        this.startupPending = true;
        this.startupWatchdog.start();
      },
      onProxyExpired: () => this.onError(),
    });
    this.tracks = new PlayerTracks(this.pipeline, {
      getVideoElement: () => this.videoEl,
      getChannel: () => this.currentChannel,
      getVod: () => this.vod,
      playbackLabel: () => this.playbackLabel(),
      onChanged: () => this.onPlaybackStateChanged(),
    });
    this.playbackRate = new PlaybackRateController(() => this.videoEl, {
      onFallback: rate => this.onPlaybackRateFallback(rate),
      onVerified: rate => log.info('Playback rate verified',
        'event=playback.rate.verified', ...this.playbackRateFields(rate)),
    });
    this.osd = new PlayerOsd(container, {
      getSnapshot: () => this.osdSnapshot(),
      canAutoReveal: () => this.canAutoRevealOsd(),
      canSeek: () => this.canSeek(),
      onSeekFraction: fraction => this.seekToFraction(fraction),
      onPauseToggle: () => this.pauseToggle(),
      onGoLive: () => this.goToLive(),
      onResync: () => this.resyncAV(),
      onPlayNext: () => this.playNextItem(),
      onCancelNext: () => this.cancelNextItem(),
    });
    this.stallWatchdog = new StallWatchdog({
      probe: (): StallProbe => {
        const v = this.videoEl;
        // No element -> report "paused" so a stray tick is a no-op.
        if (!v) return { currentTime: 0, readyState: 0, networkState: 0, paused: true, seeking: false };
        return {
          currentTime: v.currentTime,
          readyState: v.readyState,
          networkState: v.networkState,
          paused: v.paused && !this.startupPending,
          seeking: v.seeking,
        };
      },
      onReload: recovery => {
        log.warn('Reconnecting live stream',
          'event=playback.recovery.reload', this.playbackLabel(),
          `cause=${recovery.cause}`,
          this.recoveryState(recovery));
        this.reloadCurrentStream();
      },
      onEscalate: recovery => {
        log.error('Live stream recovery exhausted; advancing channel',
          'event=playback.recovery.exhausted', this.playbackLabel(),
          `cause=${recovery.cause}`,
          this.recoveryState(recovery),
          ...(this.chainUnstarted() ? ['chain=unstarted'] : []));
        this.markLiveUnavailable(recovery.cause === 'stall' ? 'stall_exhausted' : 'playback_error');
        this.osd.updateMessage(this.streamErrorMessage());
        this.channelUp();
      },
      // A step that hangs is the startup watchdog's to escalate.
      holdStall: recovery => this.holdStallForLuna(recovery)
        || (this.startupPending && this.pipeline.canEscalate()),
      // A reload reruns a header chain from its first step, past HEADER_CHAIN_CAP_MS.
      canReload: () => !this.chainUnstarted(),
      pollMs: CONFIG.PLAYER.STALL_POLL_MS,
      freezeTicks: CONFIG.PLAYER.STALL_FREEZE_TICKS,
      maxReloads: CONFIG.PLAYER.DEFAULT_LIVE_RECONNECT_ATTEMPTS,
    });
    this.startupWatchdog = new StartupWatchdog({
      probe: (): StartupProbe => {
        const v = this.videoEl;
        if (!v) return { readyState: 0, networkState: 0 };
        return { readyState: v.readyState, networkState: v.networkState };
      },
      onFailure: (failure, probe, elapsedMs) => this.onStartupFailure(failure, probe, elapsedMs),
      pollMs: CONFIG.PLAYER.STARTUP_POLL_MS,
      timeoutMs: CONFIG.PLAYER.STARTUP_TIMEOUT,
    });
  }

  init(videoEl: HTMLVideoElement): void {
    this.videoEl = videoEl;
    this.pendingSeekTarget = null;
    this.pipeline.setVideoElement(videoEl);
    this.bindVideoEvents(videoEl);

    // Suspend/resume playback when the app is actually backgrounded so the
    // native media pipeline (a separate process) stops pulling segments off the
    // network. Drive this off visibilitychange ONLY: a real background (Home /
    // app switch) flips visibilityState to 'hidden', whereas the TV's Quick
    // Settings overlay merely blurs the window — we stay 'visible' behind it.
    // Suspending on blur is what blacked the app out when settings opened, and
    // getForegroundAppInfo (the precise signal) is a privileged Luna method this
    // app isn't allowed to call.
    const onHidden = (src: string) => { log.debug('suspend trigger:', src); this.suspend(); };
    const onVisible = (src: string) => { log.debug('resume trigger:', src); this.resume(); };

    document.addEventListener('visibilitychange', () => {
      log.debug('visibilitychange →', document.visibilityState);
      if (document.hidden) onHidden('visibilitychange'); else onVisible('visibilitychange');
    });
    document.addEventListener('webkitvisibilitychange', () => {
      if ((document as unknown as Record<string, boolean>).webkitHidden) onHidden('webkitvisibilitychange');
      else onVisible('webkitvisibilitychange');
    });
  }

  private bindVideoEvents(el: HTMLVideoElement): void {
    const onCurrent = (type: string, listener: () => void): void => {
      el.addEventListener(type, () => {
        if (el === this.videoEl) listener();
      });
    };
    const update = (status?: LivePlaybackStatus) => {
      if (status && this.liveSessionActive) this.livePlaybackStatus = status;
      this.onPlaybackStateChanged();
    };
    onCurrent('pause', () => update('paused'));
    onCurrent('volumechange', () => {
      if (this.liveSessionActive && !this.vod) this.rememberLiveAudio();
      update();
    });
    onCurrent('error', () => this.onError(el.error?.code === 4 ? 'unsupported' : undefined));
    // Resource selection starts here. Until then readyState/networkState still
    // describe the previous stream — on webOS the content-type probe can defer
    // the attach by up to MANIFEST_TIMEOUT — and recreateVideoEl() loads a
    // sourceless element, which is not a startup attempt.
    onCurrent('loadstart', () => {
      this.vodTracksLatePending = false;
      if (!el.currentSrc && !el.getAttribute('src') && !el.querySelector('source')) return;
      this.startupWatchdog.start();
    });
    onCurrent('loadedmetadata', () => {
      update();
      log.info('loadedmetadata', this.videoLabel(el), el.videoWidth + 'x' + el.videoHeight,
        this.mediaState(el), '| pendingResume:', this.pendingResumeSecs);
      if (this.vod) {
        this.logVodTracks(el);
        this.vodTracksLatePending = true;
      }
      if ((this.vod || this.catchupInfo || this.lunaRestore || this.reopenResume) && this.pendingResumeSecs > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        const target = Math.min(this.pendingResumeSecs, el.duration - 1);
        log.info('resume seek', this.videoLabel(el), '| requested:', this.pendingResumeSecs,
          '| target:', target, '| duration:', el.duration);
        el.currentTime = target;
        this.pendingResumeSecs = 0;
        this.reopenResume = false;
      }
      this.tracks.applyNativeAudioSelection();
      this.tracks.applyNativeSubtitleSelection();
      if (this.osd.isVisible()) this.osd.render();
    });
    // The watchdog's own success condition — a decoded first frame, whether or
    // not playback was allowed to begin (autoplay can be rejected, or the user
    // can pause while the spinner is up).
    onCurrent('canplay', () => {
      this.playbackRate.reapply();
    });
    onCurrent('loadeddata', () => {
      this.startupPending = false;
      this.notePlayed();
      this.pipeline.notePlaying();
      if (this.catchupInfo) this.catchupVariantConfirmed = true;
    });
    // Intrinsic size changes mid-stream (ABR up/down-switch) so the OSD pills
    // (resolution, and on hls.js the codec/HDR/fps) reflect the live variant.
    onCurrent('resize', () => {
      if (this.osd.isVisible()) this.osd.render();
    });
    // Some platforms populate audio/text tracks asynchronously, after loadedmetadata.
    el.audioTracks?.addEventListener?.('addtrack', () => {
      if (el !== this.videoEl) return;
      this.logLateVodTracks(el, null);
      this.tracks.applyNativeAudioSelection();
    });
    el.textTracks?.addEventListener?.('addtrack', (e: TrackEvent) => {
      if (el !== this.videoEl) return;
      this.logLateVodTracks(el, e.track as TextTrack | null);
      this.tracks.applyNativeSubtitleSelection();
    });
    // Any unpause, the pipeline's own play() included, ends the user's pause; a
    // `play` queued before a quick re-pause finds the element paused again.
    onCurrent('play', () => {
      if (!el.paused) this.userPaused = false;
    });
    onCurrent('playing', () => {
      this.startupPending = false;
      this.notePlayed();
      this.pipeline.notePlaying();
      const recovered = this.errorRetryPending;
      if (recovered) {
        this.cancelErrorAdvance();
        if (isWebOS()) this.stallWatchdog.resume();
      }
      update('playing');
      if (recovered) this.osd.render();
      log.info('playing', this.videoLabel(el), this.mediaState(el));
      this.playbackRate.reapply();
      if (this.catchupInfo) this.catchupVariantConfirmed = true;
      this.startupWatchdog.stop();
      this.tracks.reapplyNativeSubtitleCompositor();
      this.markTrackedLiveHealthy();
      if (this.resyncing) this.endResync();
      this.confirmLiveHistory(el);
      if (this.osd.isVisible()) this.osd.resetTimer();
      this.finishLunaRestore(el);
    });
    onCurrent('waiting', () => {
      update('buffering');
      log.debug('waiting', this.videoLabel(el), this.mediaState(el));
      this.cancelLiveHistoryTimer();
    });
    onCurrent('stalled', () => {
      log.debug('stalled event', this.videoLabel(el), this.mediaState(el));
    });
    onCurrent('timeupdate', () => {
      if (this.liveSessionActive && !this.catchupInfo && !el.paused && !el.seeking) {
        const recovered = this.stallWatchdog.observeProgress(el.currentTime);
        if (recovered && this.errorRetryPending) {
          this.cancelErrorAdvance();
          if (isWebOS()) this.stallWatchdog.resume();
          update('playing');
          this.osd.render();
        }
      }
      this.reconcileLiveDvrPosition(el);
      this.reconcilePendingSeek(el);
      this.refreshProgress();
    });
    onCurrent('progress', () => {
      this.reconcileLiveDvrPosition(el);
    });
    onCurrent('durationchange', () => {
      this.reconcileLiveDvrPosition(el);
    });
    onCurrent('seeked', () => {
      log.info('seeked', this.videoLabel(el), this.mediaState(el));
      this.playbackRate.reapply();
      this.reconcilePendingSeek(el, true);
      if (this.catchupInfo) this.saveCatchupProgress();
      this.refreshProgress();
    });
    onCurrent('ended', () => {
      if (this.playbackActive) this.onEnded();
    });
  }

  private finishLunaRestore(el: HTMLVideoElement): void {
    const restore = this.lunaRestore;
    if (!restore) return;
    this.lunaRestore = null;
    if (restore.paused) {
      this.userPaused = true;
      // Luna answers its pause command asynchronously; unmute after it lands.
      const paused = el.pause() as unknown;
      void Promise.resolve(paused).then(() => this.endLunaRestoreMute(el));
    }
    log.info('Playback restored after a Luna suspend', 'event=playback.luna.resume',
      this.playbackLabel(), `atS=${secondsBucket(el.currentTime)}`, `paused=${restore.paused ? 1 : 0}`,
      `path=${this.pipeline.isLunaActive() ? 'luna' : 'native'}`);
  }

  private endLunaRestoreMute(el: HTMLVideoElement): void {
    const muted = this.lunaRestoreMute;
    if (muted === null || el !== this.videoEl) return;
    this.lunaRestoreMute = null;
    el.muted = muted;
  }

  private playbackLabel(load = this.pipeline.currentLoadToken()): string {
    return `session=${String(this.playbackGeneration)} load=${String(load)}`;
  }

  private videoLabel(el: HTMLVideoElement): string {
    return this.pipeline.videoLabel(el);
  }

  private mediaState(el: HTMLVideoElement): string {
    return `t=${el.currentTime.toFixed(3)} duration=${String(el.duration)}` +
      ` ready=${String(el.readyState)} network=${String(el.networkState)}` +
      ` paused=${String(el.paused)} seeking=${String(el.seeking)}`;
  }

  private recoveryState(recovery: StallRecovery): string {
    const p = recovery.probe;
    return `frozen=${String(recovery.frozenMs)}ms reloads=${String(recovery.reloadCount)}` +
      `/${String(recovery.maxReloads)} t=${p.currentTime.toFixed(3)}` +
      ` ready=${String(p.readyState)} network=${String(p.networkState)}` +
      ` paused=${String(p.paused)} seeking=${String(p.seeking)}`;
  }

  // A reload would restart Luna before its deadline could fall back to the
  // element, so a server that never answers would never leave Luna.
  private holdStallForLuna(recovery: StallRecovery): boolean {
    if (!this.pipeline.isLunaStarting()) return false;
    const load = this.pipeline.currentLoadToken();
    if (this.lunaStallHeldLoad !== load) {
      this.lunaStallHeldLoad = load;
      log.info('Stall left to the Luna start deadline', 'event=playback.luna.stall.held',
        this.playbackLabel(load), this.recoveryState(recovery));
    }
    return true;
  }

  suspend(): void {
    this.hidden = true;
    this.startupWatchdog.stop();
    if (!this.videoEl || !this.currentChannel) return;
    if (this.wasPlayingBeforeHide) return; // already suspended
    // A Luna pipeline lives outside the page, so hiding always unloads it,
    // as it does one still waiting on its PlayReady client. A proxied stream
    // is released too: the TV pauses the element before the app hears it is
    // hidden, and a paused player keeps fetching through its session.
    this.wasPlayingBeforeHide = !this.videoEl.paused || this.pipeline.isLunaActive()
      || this.pipeline.isLunaPending() || this.pipeline.isProxyPending() || this.pipeline.isProxied();
    if (this.wasPlayingBeforeHide) {
      // Save catch-up position and remember it for resume() BEFORE the element is destroyed.
      // Prefer a not-yet-applied resume seek: if we suspend before loadedmetadata
      // seeks to pendingResumeSecs, currentTime is still 0 and would otherwise
      // collapse the resume point to the start on the next play().
      if (this.catchupInfo) {
        this.catchupSuspendPos = Math.max(
          this.videoEl.currentTime,
          this.pendingResumeSecs,
          this.pendingSeekTarget ?? 0,
        );
        this.saveCatchupProgress();
      }
      // A proxied stream reopens its session on resume, a finite one where it
      // was, and a paused one paused again.
      if (this.pipeline.isLunaActive() || this.lunaRestore || this.pipeline.isProxied()) {
        this.captureLunaResume(this.videoEl, this.currentChannel);
      }
      this.stallWatchdog.stop();
      this.tracks.suspend();
      this.pipeline.destroy();
      this.recreateVideoEl();
    }
  }

  private captureResumePoint(el: HTMLVideoElement, channel: Channel): LunaResume & {
    kind: 'catchup' | 'finite' | 'live';
  } {
    const clock = this.pipeline.lunaClock();
    const at = this.pendingSeekTarget ?? (clock ? clock() : el.currentTime);
    const kind = this.catchupInfo ? 'catchup' : Number.isFinite(el.duration) ? 'finite' : 'live';
    // Catch-up keeps its own resume point; a live stream reloads at its edge.
    let position = kind === 'finite' && Number.isFinite(at) && at > 0 ? at : 0;
    let paused = this.userPaused && el.paused;
    // A restore that hasn't landed yet: its seek and pause still stand, and
    // userPaused is only set once the restore pauses.
    const restore = this.lunaRestore;
    if (restore) {
      if (this.pendingResumeSecs > 0 || position === 0) position = restore.position;
      paused = paused || restore.paused;
    }
    return { channel, position, paused, kind };
  }

  private captureLunaResume(el: HTMLVideoElement, channel: Channel): void {
    const { position, paused, kind } = this.captureResumePoint(el, channel);
    this.lunaRestore = null;
    this.lunaResume = { channel, position, paused };
    log.info('Luna playback suspended', 'event=playback.luna.suspend', this.playbackLabel(),
      `kind=${kind}`, `atS=${secondsBucket(kind === 'catchup' ? this.catchupSuspendPos : position)}`,
      `paused=${paused ? 1 : 0}`);
  }

  /**
   * Hard-reset playback by swapping in a fresh <video> element. Normal channel
   * changes replace the webOS native pipeline through source + load(), but a
   * wedged or ended pipeline can remain terminal and retain its buffer. A fresh
   * element kills that pipeline and frees it.
   */
  private recreateVideoEl(): void {
    const old = this.videoEl;
    if (!old) return;
    this.userPaused = false;
    old.pause();
    old.removeAttribute('src');
    old.innerHTML = '';
    old.load();
    const fresh = document.createElement('video');
    fresh.id = old.id;
    fresh.autoplay = true;
    fresh.muted = !!old.muted;
    fresh.volume = Number.isFinite(old.volume) ? old.volume : 1;
    fresh.playbackRate = Number.isFinite(old.playbackRate) ? old.playbackRate : 1;
    this.bindVideoEvents(fresh);
    old.parentNode!.replaceChild(fresh, old);
    this.videoEl = fresh;
    this.pipeline.setVideoElement(fresh);
    this.onPlaybackStateChanged();
  }

  resume(): void {
    this.hidden = false;
    const syncOnResume = this.syncOnResume;
    this.syncOnResume = false;
    if (!this.videoEl) return;
    if (!this.canResumePlayback()) {
      this.stop();
      return;
    }
    // A stream still starting when we were hidden gets a fresh budget. Element
    // state alone can't say that: a seek into an unbuffered region also drops
    // readyState below HAVE_CURRENT_DATA.
    if (this.startupPending && this.videoEl.readyState < 2) this.startupWatchdog.start();
    if (this.vod) {
      this.reauthorizeVod(this.vod, this.videoEl);
      return;
    }
    if (!this.currentChannel) return;
    if (!this.wasPlayingBeforeHide) {
      if (syncOnResume) this.syncCurrentIndex(true);
      return;
    }
    this.wasPlayingBeforeHide = false;
    const channel = this.currentChannel;
    const index = this.currentIndex;
    const catchup = this.catchupInfo || undefined;
    const preview = this.livePreviewMode;
    // stop() below drops it; the PIN's play must still restore it.
    const lunaResume = this.lunaResume;
    const rebinds = this.rebinds;
    const play = () => {
      const latest = this.latestRebind(channel, index, rebinds);
      if (lunaResume) this.lunaResume = { ...lunaResume, channel: latest.channel };
      this.playResolved(latest.channel, latest.channelIndex, catchup);
    };
    // Backgrounding relocks parental controls, so a locked channel asks again
    // in full screen; a preview the user didn't start just stops.
    if (!this.authorizeLive(channel, play, preview, !preview)) {
      log.info('Resume waits for the parental PIN', 'event=parental.playback.relocked',
        'kind=live', `preview=${String(preview)}`, `catchup=${String(!!catchup)}`);
      this.stop();
      if (!preview) this.onBack();
    }
  }

  private reauthorizeVod(v: VodPlayback, el: HTMLVideoElement): void {
    const resumeSecs = this.pendingSeekTarget ?? (el.currentTime || v.resumeSecs);
    const resumed: VodPlayback = { ...v, resumeSecs };
    if (this.authorizeVod(resumed, () => { if (this.vod !== v) this.playVodResolved(resumed); })) return;
    log.info('Resume waits for the parental PIN', 'event=parental.playback.relocked',
      `kind=${v.kind}`);
    this.stop();
    v.onBack();
  }

  // Resolve the playable URL for a channel, applying the catch-up template when
  // a catch-up window is active. Shared by play() and the stall reload path.
  private xtreamCatchupSources(channel: Channel): XtreamCatchupSource[] {
    if (channel.catchupSources?.length) return channel.catchupSources;
    const inferred = xtreamCredentialsFromLiveUrl(channel.url);
    const account = channel.catchupAccountId
      ? StorageService.getPlaylists()
          .find(item => item.id === channel.catchupAccountId && item.source === 'xtream')
      : undefined;
    const credentials = account?.xtream
      ? { baseUrl: account.url, ...account.xtream }
      : inferred?.credentials;
    const streamId = channel.catchupStreamId || inferred?.streamId || '';
    if (credentials && streamId) {
      const output = /\.m3u8(?:[?#]|$)/i.test(channel.catchupSource) ? 'm3u8' : 'ts';
      return buildXtreamCatchupSources(credentials, streamId, output);
    }
    const sources: XtreamCatchupSource[] = [
      { kind: 'path-ts', url: channel.catchupSource },
    ];
    return sources;
  }

  private resolveStreamUrl(channel: Channel, catchup: CatchupInfo | null): string {
    if (catchup && channel.catchupSource) {
      let source = channel.catchup === 'xtream'
        ? this.xtreamCatchupSources(channel)[this.catchupSourceIndex]?.url || channel.catchupSource
        : channel.catchupSource;
      if (channel.catchup === 'xtream') {
        const durationMinutes = Math.max(1, Math.ceil((catchup.end - catchup.start) / 60));
        source = source
          .replace('{duration}', String(durationMinutes))
          .replace('{start}', formatXtreamCatchupStart(
            catchup.start,
            channel.catchupTimeZone,
            channel.catchupTimeOffsetMinutes,
          ));
      }
      return source
        .replace('{channel-id}', encodeURIComponent(channel.id || channel.name))
        .replace('{utc}', String(catchup.start))
        .replace('{utcend}', String(catchup.end));
    }
    return channel.url;
  }

  private startPlaybackGeneration(): void {
    this.cancelLiveHistoryTimer();
    this.cancelErrorAdvance();
    this.playbackGeneration++;
    this.healthStartedAt = Date.now();
    this.liveHistoryGeneration = -1;
  }

  private cancelErrorAdvance(): void {
    if (this.errorAdvanceTimer !== null) {
      clearTimeout(this.errorAdvanceTimer);
      this.errorAdvanceTimer = null;
    }
    this.errorRetryPending = false;
  }

  private cancelLiveHistoryTimer(): void {
    if (this.liveHistoryTimer === null) return;
    clearTimeout(this.liveHistoryTimer);
    this.liveHistoryTimer = null;
  }

  private confirmLiveHistory(el: HTMLVideoElement): void {
    if (el !== this.videoEl || this.vod || this.catchupInfo || !this.currentChannel) return;
    const generation = this.playbackGeneration;
    if (this.liveHistoryGeneration === generation || this.liveHistoryTimer !== null) return;
    const channel = this.currentChannel;
    this.liveHistoryTimer = setTimeout(() => {
      this.liveHistoryTimer = null;
      if (generation !== this.playbackGeneration || el !== this.videoEl || el.paused ||
          this.vod || this.catchupInfo || this.currentChannel !== channel) return;
      StorageService.touchRecentlyWatchedLive(channelKey(channel));
      this.liveHistoryGeneration = generation;
    }, CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
  }

  // scope: omit to keep whatever scope is already playing (channelUp/Down's
  // own internal calls do this); pass a ChannelScope to set a new one, or
  // null to explicitly clear it (e.g. a global number-entry jump).
  play(
    channelIndex: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope | null,
    preview = this.livePreviewMode,
  ): void {
    const channel = PlaylistService.getByIndex(channelIndex);
    if (!channel || !this.videoEl) {
      log.warn('play() ignored — no channel or video element', { channelIndex, hasChannel: !!channel });
      return;
    }
    this.authorizeLive(
      channel,
      () => this.playResolved(channel, channelIndex, catchup, scope),
      preview,
    );
  }

  private playResolved(
    channel: Channel,
    channelIndex: number,
    catchup?: CatchupInfo,
    scope?: ChannelScope | null,
  ): void {
    if (!this.videoEl) return;
    this.playbackRate.reset();
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.playbackActive = true;
    this.stallWatchdog.stop();
    this.startPlaybackGeneration();

    // Save progress for the outgoing catch-up session (channel switch, stopping catch-up).
    // Skip when resuming from suspend: catchupSuspendPos >= 0 means the element is fresh
    // (currentTime=0) and we already saved the real position in suspend().
    if (this.catchupSuspendPos < 0) this.saveCatchupProgress();

    // Determine resume position: prefer the pre-suspend position if available, else the
    // position requested by the caller (CatchupInfo.resumeSecs). Reset for live channels.
    if (this.catchupSuspendPos >= 0) {
      this.pendingResumeSecs = this.catchupSuspendPos;
      this.catchupSuspendPos = -1;
    } else {
      this.pendingResumeSecs = catchup?.resumeSecs ?? 0;
    }
    this.pendingSeekTarget = null;
    // By stream, not object: a playlist rebind while hidden replaces the channel.
    this.lunaRestore = this.lunaResume
      && channelStreamIdentity(this.lunaResume.channel) === channelStreamIdentity(channel)
      ? this.lunaResume : null;
    this.lunaResume = null;
    if (this.lunaRestore && this.lunaRestore.position > 0) {
      this.pendingResumeSecs = this.lunaRestore.position;
    }

    log.info('play index', channelIndex, '|', channel.name, catchup ? '(catchup)' : '');
    this.currentChannel = channel;
    this.currentIndex = channelIndex;
    if (channelIndex >= 0) this.currentIndexAnchor = channelIndex;
    if (scope !== undefined) this.currentScope = scope;
    this.catchupInfo = catchup || null;
    this.liveSessionActive = !catchup;
    this.livePlaybackStatus = 'loading';
    this.onTvPlaybackChanged(channelIndex, catchup ? catchup.start * 1000 : null);
    this.catchupSourceIndex = 0;
    this.catchupVariantConfirmed = false;
    this.vod = null;
    this.videoEl.muted = this.livePreviewMode && this.previewMuteOverride !== null
      ? this.previewMuteOverride
      : this.liveMuted;
    this.lunaRestoreMute = null;
    if (this.lunaRestore?.paused) {
      // Luna plays a moment before it can pause again; keep that silent.
      this.lunaRestoreMute = this.videoEl.muted;
      this.videoEl.muted = true;
    }
    this.videoEl.volume = this.liveVolume;
    this.catchupCheckpointAt = Date.now(); // reset periodic-save timer for the new session
    this.osd.clearFailedIcons();
    StorageService.setLastChannel({
      index: channelIndex >= 0 ? channelIndex : StorageService.getLastChannel()?.index ?? 0,
      key: channelKey(channel),
      stream: channelStreamKey(channel),
      exact: channelExactStreamKey(channel),
    });

    const url = this.resolveStreamUrl(channel, catchup || null);
    if (catchup) log.debug('catchup URL:', diagnosticStreamUrl(url));

    this.videoEl.classList.add('active');
    this.onPlaybackStateChanged();
    this.loadStream(url, channel.extras, { headers: channelHttpHeaders(channel) });
    this.showOSD();
    if (!this.livePreviewMode) show(this.container);
    this.stallWatchdog.start(isWebOS(), StorageService.getLiveReconnectAttempts());
  }

  isVod(): boolean { return this.vod !== null; }

  // Right opens the VOD menu unless it can seek (OSD up with a usable
  // duration), or the subtitle search overlay or up-next countdown owns the key.
  vodRightOpensMenu(): boolean {
    return !this.canSeek() && !this.tracks.isSubtitleSearchOpen() && this.upNextTimer === null;
  }

  // Back hides the OSD of a stream the user paused before it stops playback:
  // that OSD never auto-hides, and with it hidden Right reaches the menu. A
  // playing or still-starting stream's OSD hides by itself, a reconnect or
  // error message would only re-show, and a cursor still on screen re-reveals
  // it, so Back stops right away then.
  hideOsdForBack(): boolean {
    if (!this.userPaused || !this.videoEl?.paused || !this.osd.isVisible()
        || this.osd.showsMessage() || this.tracks.isSubtitleSearchOpen()
        || this.upNextTimer !== null || InputMode.keyAfterPointer) return false;
    // Back skips handleAction, which drops a stale pointer before OK seeks to it.
    this.osd.clearPointer();
    this.osd.hide();
    return true;
  }

  // `audio=none` means the engine lacks the audioTracks API, unlike an empty
  // list; under MSE the element's audioTracks don't describe the stream.
  private logVodTracks(el: HTMLVideoElement, phase?: 'late'): void {
    log.info('VOD tracks', 'event=vod.tracks', ...(phase ? [`phase=${phase}`] : []),
      `audio=${el.audioTracks ? el.audioTracks.length : 'none'}`,
      `text=${this.tracks.nativeTextTrackCount(el.textTracks)}`,
      `mse=${this.pipeline.isMseActive() ? 1 : 0}`);
  }

  // Tracks can arrive after loadedmetadata; report the first such add once per load.
  private logLateVodTracks(el: HTMLVideoElement, track: TextTrack | null): void {
    if (!this.vod || !this.vodTracksLatePending) return;
    if (track && this.tracks.ownsTextTrack(track)) return;
    this.vodTracksLatePending = false;
    this.logVodTracks(el, 'late');
  }

  playVod(v: VodPlayback): void {
    this.authorizeVod(v, () => this.playVodResolved(v));
  }

  private playVodResolved(v: VodPlayback): void {
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.playbackActive = true;
    this.livePreviewMode = false;
    this.restoreLiveMute();
    this.liveSessionActive = false;
    this.stallWatchdog.stop();
    if (!this.videoEl) { log.warn('playVod ignored — no video element'); return; }
    this.playbackRate.reset();
    this.startPlaybackGeneration();
    log.info('playVod', v.title, '| resume', v.resumeSecs);
    this.saveCatchupProgress(); // save any active catch-up before switching to VOD
    this.currentChannel = null;
    this.currentIndex = -1;
    this.currentScope = null;
    this.catchupInfo = null;
    this.vod = v;
    this.lunaResume = null;
    this.lunaRestore = null;
    this.pendingResumeSecs = v.resumeSecs > 0 ? v.resumeSecs : 0;
    this.pendingSeekTarget = null;
    this.osd.clearFailedIcons();
    this.videoEl.classList.add('active');
    this.loadStream(v.url, null, { direct: true });
    this.tracks.attachVod(v);
    // Read codec/fps/HDR from the container header — the video element can't
    // expose them on webOS. Fires once, off the playback path; re-renders the OSD
    // when it resolves. Guarded so a stale probe can't clobber a newer VOD.
    this.vodInfo = null;
    void probeMedia(v.url, `${v.accountId}|media_probe|${v.kind}|${v.itemId}`).then((info) => {
      if (this.vod !== v || !info) return;
      this.vodInfo = info;
      if (this.osd.isVisible()) this.osd.render();
    });
    this.showOSD();
    show(this.container);
  }

  private saveVodResume(): void {
    const v = this.vod;
    const el = this.videoEl;
    if (!v || !el) return;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    if (dur <= 0) return; // metadata not loaded yet — currentTime is 0/unknown; don't clobber the stored point
    StorageService.setResume({
      accountId: v.accountId, kind: v.kind, itemId: v.itemId,
      name: v.title, poster: v.poster, ext: extFromUrl(v.url),
      position: this.pendingSeekTarget ?? (el.currentTime || 0),
      duration: dur,
      updatedAt: Date.now(),
      episodeQueue: v.episodeQueue,
      watchlistOwner: v.watchlistOwner,
      categoryId: v.categoryId,
    });
  }

  private saveCatchupProgress(opts?: { completed?: boolean }): void {
    const info = this.catchupInfo;
    const ch = this.currentChannel;
    if (!info || !ch || !ch.catchupSource) return;
    const el = this.videoEl;
    const pos = this.pendingSeekTarget ?? (el ? (el.currentTime || 0) : 0);
    const progStartMs = info.start * 1000;
    const progEndMs = info.end * 1000;
    const epgDur = info.end - info.start; // seconds, as fallback when media duration unknown
    const dur = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : epgDur;
    const isCompleted = (opts?.completed ?? false) || (dur > 0 && pos >= dur - CONFIG.CATCHUP.FINISH_PAD);
    // Avoid writing a sub-threshold position that would delete a valid stored entry.
    if (!isCompleted && pos < CONFIG.CATCHUP.RESUME_MIN_SECS) return;
    StorageService.setCatchupProgress({
      channelKey: channelKey(ch),
      progStart: progStartMs,
      progEnd: progEndMs,
      epgSourceUrl: info.epgSourceUrl,
      title: info.title,
      description: info.description,
      icon: info.icon,
      position: pos,
      duration: dur,
      updatedAt: Date.now(),
      completed: isCompleted,
    }, ch.catchupDays);
  }

  private handleVodAction(action: Action): void {
    if (this.tracks.handleAction(action)) return;
    if (this.upNextTimer) {
      if (action === 'select' || action === 'play') this.playNextItem();
      else if (action === 'back' || action === 'stop') this.cancelNextItem();
      return;
    }
    switch (action) {
      case 'back':
      case 'stop': {
        const back = this.vod?.onBack;
        this.stop();       // saves the resume point, clears VOD state
        back?.();
        break;
      }
      case 'select':
        {
          const pointer = this.osd.pointerPosition();
          if (this.osd.seekAtPointer(pointer.x, pointer.y)) break;
        }
        if (this.canSeek()) this.pauseToggle();
        else this.osd.toggle();
        break;
      case 'left':
        this.seekBy(-CONFIG.PLAYER.SEEK_STEP);
        break;
      case 'right':
        this.seekBy(CONFIG.PLAYER.SEEK_STEP);
        break;
      case 'play':
        if (this.videoEl?.paused) this.pauseToggle();
        break;
      case 'pause':
        if (this.videoEl && !this.videoEl.paused) this.pauseToggle();
        break;
      case 'yellow':
        this.showOSD();
        break;
      default:
        break; // up/down/channel_up/channel_down are no-ops (no channels in VOD)
    }
  }

  closeSubtitleSearch(): void {
    this.tracks.closeSubtitleSearch();
  }

  subtitleSearchAvailable(): boolean {
    return this.tracks.subtitleSearchAvailable();
  }

  openSubtitleSearch(): void {
    void this.tracks.openSubtitleSearch();
  }

  openSubtitleOffset(): void {
    this.tracks.openSubtitleOffset();
  }

  closeSubtitleOffset(): void {
    this.tracks.closeSubtitleOffset();
  }

  subtitleOffsetState(): { available: boolean; label: string } {
    return this.tracks.subtitleOffsetState();
  }

  setSubtitleOffset(seconds: number): void {
    this.tracks.setSubtitleOffset(seconds);
  }

  // Stall watchdog recovery: swap in a fresh <video> (kills the wedged native
  // pipeline) and reload the current channel WITHOUT going through play() — that
  // would reset the watchdog's reload budget and prevent escalation.
  private reloadCurrentStream(): void {
    if (!this.currentChannel) return;
    this.osd.updateMessage(t('player.reconnecting'));
    this.recreateVideoEl();
    this.videoEl?.classList.add('active');
    this.loadStream(
      this.resolveStreamUrl(this.currentChannel, this.catchupInfo),
      this.currentChannel.extras,
      { headers: channelHttpHeaders(this.currentChannel), reload: true },
    );
  }

  // A finished catch-up VOD would otherwise freeze on its last frame; fall back
  // to the channel's live stream instead.
  private onEnded(): void {
    if (this.vod) {
      const v = this.vod;
      this.vod = null; // before stop(), so it doesn't re-save a resume point for a finished movie
      StorageService.clearResume(v.accountId, v.kind, v.itemId);
      if (v.kind === 'vod') {
        StorageService.removeWatchlist(v.accountId, 'vod', v.itemId);
      } else if ((v.episodeQueue?.length ?? 0) === 0 && v.watchlistOwner) {
        StorageService.removeWatchlist(v.accountId, v.watchlistOwner.kind, v.watchlistOwner.itemId);
      }
      this.stop();
      const queue = v.kind === 'episode' ? v.episodeQueue : v.watchlistQueue;
      const next = queue?.[0];
      if (next) {
        this.startNextItem(next, queue?.slice(1) ?? [], v.kind === 'episode', v.onBack, v);
        return;
      }
      v.onBack();
      return;
    }
    if (this.catchupInfo && this.currentChannel) {
      log.info('catch-up ended — resuming live');
      this.saveCatchupProgress({ completed: true });
      const idx = this.currentIndex;
      const channel = this.currentChannel;
      this.catchupInfo = null; // clear before play() so it doesn't re-save with pos=0
      this.recreateVideoEl();
      this.playResolved(channel, idx);
    }
  }

  stop(): void {
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.liveSessionActive = false;
    this.livePreviewMode = false;
    this.restoreLiveMute();
    this.playbackActive = false;
    this.wasPlayingBeforeHide = false;
    this.userPaused = false;
    this.lunaResume = null;
    this.lunaRestore = null;
    this.startPlaybackGeneration();
    this.clearUpNextTimer();
    this.vodTracksLatePending = false;
    if (this.vod) this.saveVodResume();
    this.saveCatchupProgress(); // save before the video element is torn down
    this.stallWatchdog.stop();
    this.startupPending = false;
    this.startupWatchdog.stop();
    this.tracks.stop();
    this.playbackRate.reset();
    this.pipeline.destroy();
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.innerHTML = '';
      this.videoEl.load();
      this.videoEl.classList.remove('active');
    }
    this.hideOSD();
    hide(this.container);
    this.vod = null;
    this.pendingResumeSecs = 0;
    this.reopenResume = false;
    this.pendingSeekTarget = null;
    this.catchupCheckpointAt = 0;
    this.catchupSuspendPos = -1;
    this.catchupSourceIndex = 0;
    this.catchupVariantConfirmed = false;
    this.resyncing = false;
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
    this.onPlaybackStateChanged();
  }

  private startNextItem(
    next: VodQueueItem,
    remaining: VodQueueItem[],
    isEpisodeQueue: boolean,
    onBack: () => void,
    finished: VodQueueItem,
  ): void {
    this.recreateVideoEl();
    // The PIN unlocked the whole series, so its next episode continues.
    this.upNextAuthorized = isEpisodeQueue && sameParentalItem(finished, next);
    this.vod = {
      ...next,
      resumeSecs: 0,
      episodeQueue: isEpisodeQueue ? remaining : undefined,
      watchlistQueue: isEpisodeQueue ? undefined : remaining,
      onBack,
    };
    this.upNextSeconds = CONFIG.PLAYER.UP_NEXT_COUNTDOWN;
    this.osd.show();
    show(this.container);
    this.upNextTimer = setInterval(() => {
      this.upNextSeconds--;
      if (this.upNextSeconds <= 0) this.playNextItem();
      else this.osd.render();
    }, 1000);
  }

  private clearUpNextTimer(): void {
    this.upNextAuthorized = false;
    if (this.upNextTimer) clearInterval(this.upNextTimer);
    this.upNextTimer = null;
    this.upNextSeconds = 0;
  }

  private playNextItem(): void {
    const next = this.vod;
    if (!next || !this.upNextTimer) return;
    const authorized = this.upNextAuthorized;
    log.debug('Up next starting', 'event=parental.upnext', `kind=${next.kind}`,
      `sameItem=${String(authorized)}`);
    this.clearUpNextTimer();
    if (authorized) {
      this.playVodResolved(next);
      return;
    }
    // A locked next item waits for the PIN off the player, as a live resume
    // does, so cancelling the prompt can't strand a blank up-next screen.
    if (!this.authorizeVod(next, () => this.playVodResolved(next))) this.cancelNextItem();
  }

  private cancelNextItem(): void {
    const back = this.vod?.onBack;
    this.stop();
    back?.();
  }

  private loadStream(url: string, extras: Record<string, string> | null, opts?: PipelineLoadOptions): void {
    if (!opts?.reload) {
      this.proxyReopened = false;
      this.channelPlayed = false;
      this.reopenResume = false;
    }
    this.loadPlayed = false;
    this.tracks.resetForLoad();
    this.vodTracksLatePending = false;
    this.manifestVariants = [];
    this.userPaused = false;
    this.startupPending = true;
    this.startupWatchdog.stop();
    this.pipeline.load(url, extras, opts);
    // Only the live preview reports a rect; every other entry is full screen,
    // and a rect left from an earlier preview would shrink the Luna picture.
    // After load, so the outgoing pipeline is already gone.
    if (!this.livePreviewMode) this.pipeline.setLunaDisplay('full');
  }

  /**
   * A stream that never produced a frame. `unsupported` means the element
   * rejected every source it was offered — a reload would re-offer the same one,
   * so surface it. A `timeout` on live/catch-up belongs to the stall watchdog,
   * whose in-place reload can still recover a transient failure; record it and
   * leave that recovery alone.
   */
  private onStartupFailure(
    failure: StartupFailure,
    probe: StartupProbe,
    elapsedMs: number,
  ): void {
    const v = this.videoEl;
    const source = v?.querySelector('source');
    const declaredType = source?.getAttribute('type') ?? '';
    // A source rejected on its declared type never becomes currentSrc.
    const url = this.pipeline.lunaStreamUrl() || elementSrc(v) || source?.getAttribute('src') ||
      this.vod?.url || this.currentChannel?.url || '';
    const deferred = failure === 'timeout' && !this.vod;
    const detail = [
      `reason=${failure}`,
      `handled=${deferred ? 'deferred' : 'error'}`,
      `elapsedMs=${String(elapsedMs)}`,
      `ready=${String(probe.readyState)}`,
      `network=${String(probe.networkState)}`,
      `type=${declaredType || '(none)'}`,
      `extension=${extFromUrl(url) || '(none)'}`,
      `canPlayType=${declaredType && v ? v.canPlayType(declaredType) || '(rejected)' : 'n/a'}`,
      `url=${diagnosticStreamUrl(url)}`,
    ];
    if (deferred) {
      log.warn('Stream produced no frame', 'event=playback.startup.failed',
        this.playbackLabel(), ...detail);
      this.escalateStartup();
      return;
    }
    log.error('Stream never started', 'event=playback.startup.failed',
      this.playbackLabel(), ...detail);
    if (this.escalateStartup()) return;
    this.startupPending = false;
    // A live source that already played on this channel failed its reload:
    // the server is away, not the format, so the reconnect budget applies.
    const reconnect = this.channelPlayed && this.liveSessionActive && !this.catchupInfo && !this.vod;
    this.onError(reconnect ? undefined : 'unsupported');
  }

  private applyPipelineManifest(manifest: PipelineManifest): void {
    this.manifestVariants = manifest.variants;
    this.tracks.applyManifest(manifest);
  }

  // A channel with HTTP headers that never started moves to the next step
  // the setting allows: the element, Media service, then the local proxy.
  private escalateStartup(): boolean {
    if (!this.startupPending || !this.pipeline.escalate()) return false;
    this.startupWatchdog.start();
    if (this.liveSessionActive && !this.catchupInfo && isWebOS()) this.stallWatchdog.resume();
    return true;
  }

  private notePlayed(): void {
    this.loadPlayed = true;
    this.channelPlayed = true;
  }

  // A header channel that no step started since the user's load.
  private chainUnstarted(): boolean {
    return !this.channelPlayed && this.pipeline.isHeaderChain();
  }

  // A proxy session the service expired, or lost, fails a stream that had
  // played: one fresh session resumes it where it was. Xtream VOD plays
  // direct, never through the proxy.
  private reopenProxy(): boolean {
    if (this.startupPending || !this.loadPlayed || this.proxyReopened || this.vod || !this.currentChannel
        || !this.pipeline.isProxied()) return false;
    this.proxyReopened = true;
    const v = this.videoEl;
    const position = this.pendingSeekTarget ?? v?.currentTime ?? 0;
    if (position > 0 && (this.catchupInfo || (v && Number.isFinite(v.duration)))) {
      this.pendingResumeSecs = Math.max(this.pendingResumeSecs, position);
      this.reopenResume = true;
    }
    log.warn('Reopening the local proxy session', 'event=playback.proxy.reopen', this.playbackLabel());
    this.reloadCurrentStream();
    return true;
  }

  private onError(reason?: 'unsupported'): void {
    if (!this.playbackActive || this.wasPlayingBeforeHide) return;
    if (this.errorAdvanceTimer !== null) return;
    if (this.escalateStartup()) return;
    if (this.reopenProxy()) return;
    if (this.liveSessionActive) {
      this.livePlaybackStatus = 'error';
      this.onPlaybackStateChanged();
    }
    this.cancelLiveHistoryTimer();
    if (this.vod) {
      const v = this.vod;
      this.vod = null;            // so stop() won't overwrite/wipe the resume point on error
      log.warn('VOD playback error', 'event=playback.vod.error',
        this.playbackLabel(), v.title);
      this.stop();
      showToast(t('player.unableToPlay'));
      v.onBack();
      return;
    }
    if (this.catchupInfo && this.currentChannel?.catchup === 'xtream' &&
        !this.catchupVariantConfirmed) {
      const sources = this.xtreamCatchupSources(this.currentChannel);
      const nextIndex = this.catchupSourceIndex + 1;
      if (nextIndex < sources.length) {
        const position = this.videoEl?.currentTime ?? 0;
        if (position > 0) this.pendingResumeSecs = Math.max(this.pendingResumeSecs, position);
        this.catchupSourceIndex = nextIndex;
        this.catchupVariantConfirmed = false;
        log.warn('Xtream catch-up failed; trying the next endpoint',
          'event=xtream.catchup.variant.attempted',
          `variant=${sources[nextIndex].kind}`,
          `attempt=${nextIndex + 1}`,
          `total=${sources.length}`,
          this.playbackLabel());
        this.osd.updateMessage(t('player.retryingCatchup'));
        this.recreateVideoEl();
        this.videoEl?.classList.add('active');
        this.loadStream(
          this.resolveStreamUrl(this.currentChannel, this.catchupInfo),
          this.currentChannel.extras,
          { headers: channelHttpHeaders(this.currentChannel) },
        );
        return;
      }
      const current = sources[this.catchupSourceIndex];
      log.warn(
        'Xtream catch-up endpoint variants exhausted',
        'event=xtream.catchup.variant.failed',
        `variant=${current?.kind || 'unknown'}`,
        `attempt=${this.catchupSourceIndex + 1}`,
        `total=${sources.length}`,
        this.playbackLabel(),
      );
    }
    const v = this.videoEl;
    log.error('Video playback error', 'event=playback.video.error',
      this.playbackLabel(),
      v ? this.mediaState(v) : 'no video element',
      v?.error ? { code: v.error.code, message: v.error.message } : 'no error info',
      '| channel:', this.currentChannel?.name,
      '| url:', diagnosticStreamUrl(this.pipeline.lunaStreamUrl() || elementSrc(v)
        || this.currentChannel?.url || ''));
    if (this.liveSessionActive && !this.catchupInfo && reason !== 'unsupported') {
      this.stallWatchdog.pause();
      this.errorRetryPending = true;
      this.livePlaybackStatus = 'buffering';
      this.onPlaybackStateChanged();
      this.osd.updateMessage(t('player.reconnecting'));
      this.errorAdvanceTimer = setTimeout(() => {
        this.errorAdvanceTimer = null;
        this.errorRetryPending = false;
        if (this.stallWatchdog.recoverFromError() && isWebOS()) {
          this.stallWatchdog.resume();
        }
      }, 2000);
      return;
    }
    this.stallWatchdog.stop();
    this.markLiveUnavailable('playback_error');
    this.osd.updateMessage(this.streamErrorMessage());
    this.errorAdvanceTimer = setTimeout(() => {
      this.errorAdvanceTimer = null;
      this.channelUp();
    }, 2000);
  }

  private streamErrorMessage(): string {
    return t(this.pipeline.headersTurnedOff() ? 'player.streamErrorHeadersOff' : 'player.streamError');
  }

  private markLiveUnavailable(reason: string): void {
    if (!this.currentChannel || this.catchupInfo || this.vod) return;
    void ChannelHealthService.recordPlaybackFailure(this.currentChannel, reason)
      .then(() => this.onChannelHealthChanged())
      .catch(err => log.error(
        'Channel health playback update failed',
        'event=channel.health.playback.write.failed',
        err,
      ));
  }

  private markTrackedLiveHealthy(): void {
    if (!this.currentChannel || this.catchupInfo || this.vod
        || this.healthSuccessGeneration === this.playbackGeneration) return;
    this.healthSuccessGeneration = this.playbackGeneration;
    const latencyMs = Math.max(0, Date.now() - this.healthStartedAt);
    void ChannelHealthService.recordPlaybackSuccess(this.currentChannel, latencyMs)
      .then(changed => {
        if (changed) this.onChannelHealthChanged();
      })
      .catch(err => log.error(
        'Channel health playback update failed',
        'event=channel.health.playback.write.failed',
        err,
      ));
  }

  showOSD(): void {
    if (this.livePreviewMode) return;
    this.osd.show();
  }

  getVideoElement(): HTMLVideoElement | null { return this.videoEl; }

  isInLivePreview(): boolean { return this.livePreviewMode; }

  enterLivePreview(): void {
    if (this.livePreviewMode) return;
    if (this.liveSessionActive) this.rememberLiveAudio();
    this.previewMuteOverride = null;
    this.livePreviewMode = true;
    this.hideOSD();
    hide(this.container);
    const win = this.liveDvrWindow();
    if (win && !dvrState(
      win, this.videoEl?.currentTime ?? win.end, CONFIG.PLAYER.DVR_LIVE_EDGE,
    ).atLiveEdge) {
      this.seekTo(win.end, false);
    }
  }

  /** Where the picture belongs: a preview slot rect, or null for full screen. */
  setVideoDisplay(rect: Rectangle | null): void {
    if (!rect) {
      this.pipeline.setLunaDisplay('full');
      return;
    }
    // setDisplayWindow takes the 1920x1080 app space.
    const scale = window.innerWidth > 0
      ? CONFIG.PLAYER.LUNA_MEDIA_DISPLAY_WIDTH / window.innerWidth : 1;
    this.pipeline.setLunaDisplay({
      x: rect.left * scale,
      y: rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    });
  }

  exitLivePreview(): void {
    if (!this.livePreviewMode) return;
    this.livePreviewMode = false;
    this.restoreLiveMute();
  }

  getLivePlaybackSnapshot(): LivePlaybackSnapshot | null {
    if (!this.liveSessionActive || !this.currentChannel || !this.videoEl || this.vod || this.catchupInfo) return null;
    return {
      channel: this.currentChannel,
      muted: this.lunaRestoreMute ?? this.videoEl.muted,
      status: this.livePlaybackStatus,
    };
  }

  togglePreviewMute(): void {
    if (!this.livePreviewMode || !this.liveSessionActive || !this.videoEl) return;
    this.previewMuteOverride = !(this.lunaRestoreMute ?? this.videoEl.muted);
    // A restore still silenced until its pause takes the choice when it ends.
    if (this.lunaRestoreMute !== null) this.lunaRestoreMute = this.previewMuteOverride;
    else this.videoEl.muted = this.previewMuteOverride;
    this.onPlaybackStateChanged();
  }

  private rememberLiveAudio(): void {
    if (!this.videoEl) return;
    const muted = this.lunaRestoreMute ?? !!this.videoEl.muted;
    if (this.livePreviewMode) this.previewMuteOverride = muted;
    else this.liveMuted = muted;
    this.liveVolume = Number.isFinite(this.videoEl.volume) ? this.videoEl.volume : 1;
  }

  private restoreLiveMute(): void {
    this.lunaRestoreMute = null;
    this.previewMuteOverride = null;
    if (this.videoEl) this.videoEl.muted = this.liveMuted;
  }

  /** The live DVR window (seekable timeshift) when playing live with a usable
   *  retained window; null for catch-up VOD or a non-DVR live stream. */
  private liveDvrWindow(): DvrWindow | null {
    const v = this.videoEl;
    if (!v || this.catchupInfo) return null;
    return dvrWindow(v.seekable, v.duration, CONFIG.PLAYER.DVR_MIN_WINDOW);
  }

  isLiveDvr(): boolean {
    return !!this.liveDvrWindow();
  }

  /** Seekable while the OSD (the seek UI) shows: catch-up VOD, or live DVR. */
  canSeek(): boolean {
    const v = this.videoEl;
    if (!this.osd.isVisible() || !v) return false;
    if (this.vod) return Number.isFinite(v.duration) && v.duration > 0;
    if (this.catchupInfo) return Number.isFinite(v.duration) && v.duration > 0;
    return this.isLiveDvr();
  }

  seekBy(seconds: number): void {
    this.seekTo((this.pendingSeekTarget ?? this.videoEl?.currentTime ?? 0) + seconds);
  }

  /** Seek to a fraction (0..1) of the seekable range (DVR window or VOD duration). */
  private seekToFraction(fraction: number): void {
    const v = this.videoEl;
    if (!v) return;
    const f = Math.max(0, Math.min(1, fraction));
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.start + f * win.length);
    else if (Number.isFinite(v.duration)) this.seekTo(f * v.duration);
  }

  private seekTo(time: number, showControls = true): void {
    const v = this.videoEl;
    if (!v) return;
    const win = this.liveDvrWindow();
    if (win) {
      // Live DVR: seeking near the end snaps to the live edge (a small pad back
      // so playback does not stall at the tip), while rewinding stays inside
      // the oldest edge of the sliding manifest.
      const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
      const oldest = this.oldestDvrTarget(win);
      this.pendingSeekTarget = time >= liveEdge ? liveEdge : Math.max(oldest, time);
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      this.pendingSeekTarget = Math.max(0, Math.min(v.duration, time));
    } else {
      return;
    }
    v.currentTime = this.pendingSeekTarget;
    if (showControls) {
      if (this.osd.isVisible()) this.osd.resetTimer(); else this.showOSD();
    }
    this.refreshProgress();
  }

  private reconcilePendingSeek(el: HTMLVideoElement, retry = false): void {
    if (el !== this.videoEl || this.pendingSeekTarget === null) return;
    if (Math.abs(el.currentTime - this.pendingSeekTarget) <= 1) {
      this.pendingSeekTarget = null;
    } else if (retry) {
      // webOS may discard currentTime assignments made while an earlier seek is
      // active. Re-submit the accumulated target once that seek completes.
      el.currentTime = this.pendingSeekTarget;
    }
  }

  private oldestDvrTarget(win: DvrWindow): number {
    const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
    return Math.min(liveEdge, win.start + Math.min(
      CONFIG.PLAYER.DVR_OLDEST_PAD,
      win.length / 2,
    ));
  }

  private reconcileLiveDvrPosition(el: HTMLVideoElement): void {
    if (el !== this.videoEl || el.paused || el.seeking) return;
    const win = this.liveDvrWindow();
    if (!win || el.currentTime >= win.start) return;
    const target = this.oldestDvrTarget(win);
    this.pendingSeekTarget = target;
    el.currentTime = target;
  }

  private goToLive(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.end);
  }

  private goToOldest(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(this.oldestDvrTarget(win));
  }

  /** Manually re-lock audio/video that has drifted over a long continuous
   *  catch-up/VOD decode. A small backward seek is the only thing that re-locks
   *  A/V on webOS — it flushes the native pipeline and re-fetches the segment — so
   *  it costs a ~2s rebuffer, masked by a "Resyncing…" message that clears on the
   *  next `playing`. Catch-up / VOD only. */
  resyncAV(): void {
    const v = this.videoEl;
    if (!v) return;
    if (!(this.vod || this.catchupInfo)) return;               // catch-up / VOD only
    if (!Number.isFinite(v.duration) || v.duration <= 0) return;
    if (this.resyncing || v.seeking) return;                   // debounce repeat presses
    this.resyncing = true;
    const target = Math.max(0, v.currentTime - CONFIG.PLAYER.RESYNC_SEEK_BACK);
    log.info('A/V resync — seek', v.currentTime.toFixed(2), '→', target.toFixed(2));
    this.osd.updateMessage(t('player.resyncing'));
    v.currentTime = target;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => this.endResync(), CONFIG.PLAYER.RESYNC_TIMEOUT);
  }

  private endResync(): void {
    if (!this.resyncing) return;
    this.resyncing = false;
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
    if (this.osd.isVisible()) this.osd.render();
  }

  /** Pause/resume. On live DVR, if the retained window rolled past the paused
   *  point, resume from the oldest available point rather than a dropped segment. */
  private pauseToggle(): void {
    const v = this.videoEl;
    if (!v) return;
    if (v.paused) {
      const win = this.liveDvrWindow();
      if (win && v.currentTime < win.start) {
        v.currentTime = this.oldestDvrTarget(win);
      }
      this.userPaused = false;
      v.play?.().catch(() => {});
      this.stopDvrPauseTick();
    } else {
      this.userPaused = true;
      v.pause?.();
      if (this.catchupInfo) this.saveCatchupProgress();
      if (this.isLiveDvr()) this.startDvrPauseTick();
    }
    if (this.osd.isVisible()) {
      this.osd.render();
      this.osd.resetTimer();
    } else {
      this.showOSD();
    }
  }

  // While paused on live DVR the window keeps rolling forward, so tick the OSD
  // to keep "behind live" and the cursor accurate (timeupdate is silent paused).
  private startDvrPauseTick(): void {
    this.stopDvrPauseTick();
    this.dvrPauseTick = setInterval(() => {
      if (!this.videoEl?.paused || !this.isLiveDvr()) this.stopDvrPauseTick();
      else if (this.osd.isVisible()) this.refreshProgress();
    }, 1000);
  }

  private stopDvrPauseTick(): void {
    if (this.dvrPauseTick) { clearInterval(this.dvrPauseTick); this.dvrPauseTick = null; }
  }

  /** Live-update the bar + labels in place (on timeupdate / after a seek). */
  private refreshProgress(): void {
    const v = this.videoEl;
    if (!v) return;
    // Throttled periodic catch-up checkpoint — runs regardless of OSD visibility
    // so progress is saved even when the OSD has auto-hidden.
    if (this.catchupInfo) {
      const now = Date.now();
      if (now - this.catchupCheckpointAt >= CONFIG.CATCHUP.CHECKPOINT_INTERVAL) {
        this.catchupCheckpointAt = now;
        this.saveCatchupProgress();
      }
    }
    this.osd.refreshProgress();
  }

  hideOSD(): void {
    this.osd.hide();
    this.stopDvrPauseTick();
  }

  // Resolution comes from the video element; other fields use the active MSE
  // rendition, native manifest metadata or the VOD container probe.
  private streamInfo(): PlayerOsdStreamInfo | null {
    const v = this.videoEl;
    const lvl = this.pipeline.streamInfo();
    const info = this.vod ? this.vodInfo : null; // container-header readout for VOD; null on the Live path
    const badge = resolutionBadge((v ? v.videoHeight : 0) || info?.height || 0);
    const variant = !this.pipeline.isMseActive() && v
      ? pickVariant(this.manifestVariants, v.videoWidth, v.videoHeight)
      : null;
    const vCodec = codecName(lvl?.videoCodec ?? variant?.videoCodec ?? info?.videoCodec ?? '');
    const aCodecName = codecName(lvl?.audioCodec ?? variant?.audioCodec ?? info?.audioCodec ?? '');
    // Atmos (JOC): native path from the manifest variant's audio group; hls.js from
    // the active audio track's channel layout — loadLevelObj carries no channels.
    const hlsChannels = lvl?.audioChannels ?? '';
    const atmos = lvl?.audioAtmos ?? (variant?.atmos || /\bJOC\b/i.test(hlsChannels));
    const aCodec = aCodecName && atmos ? `${aCodecName} Atmos` : aCodecName;
    const hdr = hdrLabel(lvl?.videoRange ?? variant?.videoRange ?? info?.hdr ?? '');
    const fps = frameRateLabel(lvl?.frameRate ?? variant?.frameRate ?? info?.fps ?? 0);
    const drm = this.pipeline.drmLabel();
    const audio = audioSummary(this.tracks.getAudioTracks());
    const subtitle = subtitleSummary(this.tracks.getSubtitleTracks());
    if (!(badge || hdr || drm || fps || vCodec || aCodec || audio || subtitle)) return null;
    return {
      resolution: badge,
      hdr,
      drm,
      fps,
      videoCodec: vCodec,
      audioCodec: aCodec,
      audio,
      subtitle,
    };
  }

  private osdSnapshot(): PlayerOsdSnapshot {
    const channel = this.currentChannel;
    const epgId = channel && !this.catchupInfo ? EpgService.findChannelId(channel) : null;
    const upcoming = epgId ? EpgService.getUpcoming(epgId, 1) : [];
    const win = this.liveDvrWindow();
    const video = this.videoEl;
    const position = this.pendingSeekTarget ?? video?.currentTime ?? 0;
    return {
      playback: video ? {
        position,
        duration: video.duration,
        paused: video.paused,
      } : null,
      channel,
      channelNumber: this.currentIndexAnchor + 1,
      catchup: this.catchupInfo,
      vodTitle: this.vod?.title ?? null,
      upNextSeconds: this.upNextSeconds,
      dvr: win && video
        ? dvrState(win, position, CONFIG.PLAYER.DVR_LIVE_EDGE)
        : null,
      nowPlaying: epgId ? EpgService.getNowPlaying(epgId) : null,
      upcoming: upcoming[0] ?? null,
      streamInfo: this.streamInfo(),
    };
  }

  channelUp(): void {
    if (this.shouldUseScope()) { this.scopedChannelStep(1); return; }
    this.globalChannelStep(1);
  }

  channelDown(): void {
    if (this.shouldUseScope()) { this.scopedChannelStep(-1); return; }
    this.globalChannelStep(-1);
  }

  // The settings.channelCycleMode gate: scoping only applies when the user
  // opted into 'active' — 'global' (the default) preserves the pre-scoping
  // full-list behavior even though currentScope is still tracked.
  private shouldUseScope(): boolean {
    return !!this.currentScope && StorageService.getChannelCycleMode() === 'active';
  }

  private globalChannelStep(delta: 1 | -1): void {
    const channels = PlaylistService.channels;
    const len = channels.length;
    if (!len) return;
    let next = this.currentIndex >= 0
      ? ((this.currentIndex + delta) % len + len) % len
      : delta > 0
        ? Math.min(this.currentIndexAnchor, len - 1)
        : Math.max(0, Math.min(this.currentIndexAnchor - 1, len - 1));
    next = this.firstUnlocked(channels, next, delta);
    this.play(next);
  }

  // Surfing passes over parental-locked channels instead of stopping on a PIN
  // prompt; they stay reachable from the list. If every other channel is locked,
  // the next one prompts as usual.
  private firstUnlocked(list: Channel[], start: number, delta: 1 | -1): number {
    const len = list.length;
    if (!ParentalControlService.enabled) return start;
    for (let step = 0, i = start; step < len; step++, i = ((i + delta) % len + len) % len) {
      if (list[i] === this.currentChannel) break;
      if (ParentalControlService.decision(liveParentalRequest(list[i], 'play')).allowed) return i;
    }
    return start;
  }

  // channel_up/channel_down while the current channel was launched from a
  // specific view (Favorites, a group, a folder, All) and the user has
  // opted into scoped cycling: step within that view's list — recomputed
  // live on every call, so a customization change mid-playback (unfavoriting,
  // hiding, reordering) is reflected immediately — instead of the full,
  // unfiltered channel list.
  private scopedChannelStep(delta: 1 | -1): void {
    const scope = this.currentScope;
    if (!scope) return;
    const list = PlaylistService.getByGroup(scope.group, scope.playlist);
    const pos = this.currentChannel ? list.indexOf(this.currentChannel) : -1;
    if (pos < 0) {
      // The view is empty, gone, or the playing channel dropped out of it —
      // resume plain global stepping instead of a remembered position in a
      // scope that's no longer valid.
      this.currentScope = null;
      this.globalChannelStep(delta);
      return;
    }
    const len = list.length;
    const next = this.firstUnlocked(list, ((pos + delta) % len + len) % len, delta);
    const globalIndex = PlaylistService.indexOf(list[next]);
    if (globalIndex < 0) return;
    this.play(globalIndex);
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrentCatchupStart(): number | null {
    return this.catchupInfo ? this.catchupInfo.start * 1000 : null;
  }

  getCurrentChannel(): Channel | null {
    return this.currentChannel;
  }

  /** Rebind live playback after the channel catalog is rebuilt or reordered;
   *  `resumed` replays a rebind deferred while the page was hidden. */
  syncCurrentIndex(resumed = false): void {
    const current = this.currentChannel;
    if (!current) return;
    const resolved = PlaylistService.resolveChannelKey(
      channelKey(current),
      channelStreamIdentity(current),
      channel => channel.group === current.group,
      channelExactStreamIdentity(current),
    );
    if (!resolved) {
      this.currentIndex = -1;
      this.onTvPlaybackChanged(-1, this.catchupInfo ? this.catchupInfo.start * 1000 : null);
      this.onPlaybackStateChanged();
      return;
    }
    if (this.liveSessionActive && !this.catchupInfo
        && (this.resolveStreamUrl(current, null)
          !== this.resolveStreamUrl(resolved.channel, null)
          || channelStreamIdentity(current)
            !== channelStreamIdentity(resolved.channel))) {
      const { channel, channelIndex } = resolved;
      if (this.wasPlayingBeforeHide) {
        // Suspended: resume() plays and re-authorizes the rebound channel.
        if (this.lunaResume) this.lunaResume = { ...this.lunaResume, channel };
        this.rebinds++;
        this.currentChannel = channel;
        this.currentIndex = channelIndex;
        this.currentIndexAnchor = channelIndex;
        this.onTvPlaybackChanged(channelIndex, null);
        this.onPlaybackStateChanged();
        return;
      }
      if (this.hidden) {
        // Hidden with the page's player kept: reload once visible, never here.
        this.syncOnResume = true;
        return;
      }
      const preview = this.livePreviewMode;
      // The reload keeps the user's pause and position, even when it lands
      // after resume() already restarted the stream.
      const point = this.videoEl ? this.captureResumePoint(this.videoEl, channel) : null;
      const rebinds = this.rebinds;
      const play = () => {
        const latest = this.latestRebind(channel, channelIndex, rebinds);
        if (point && (point.paused || point.position > 0)) {
          this.lunaResume = { channel: latest.channel, position: point.position, paused: point.paused };
        }
        this.playResolved(latest.channel, latest.channelIndex);
      };
      if (resumed) {
        // Backgrounding relocked parental controls, as resume() honors.
        if (!this.authorizeLive(channel, play, preview, !preview)) {
          log.info('Rebound channel waits for the parental PIN', 'event=parental.playback.relocked',
            'kind=live', `preview=${String(preview)}`, 'catchup=false', 'reason=resume');
          this.stop();
          if (!preview) this.onBack();
        }
        return;
      }
      // Already authorized: a refreshed stream must not ask for the PIN. A
      // stand-in under other parental groups that locks it must.
      if (sameParentalScope(current, channel)
          || ParentalControlService.decision(liveParentalRequest(channel)).allowed) {
        play();
        return;
      }
      if (!this.authorizeLive(channel, play, preview, !preview)) {
        log.info('Rebound channel waits for the parental PIN', 'event=parental.playback.relocked',
          'kind=live', `preview=${String(preview)}`, 'catchup=false', 'reason=rebind');
        this.stop();
        if (!preview) this.onBack();
      }
      return;
    }
    this.rebinds++;
    this.currentChannel = resolved.channel;
    this.currentIndex = resolved.channelIndex;
    this.currentIndexAnchor = resolved.channelIndex;
    this.onTvPlaybackChanged(
      resolved.channelIndex,
      this.catchupInfo ? this.catchupInfo.start * 1000 : null,
    );
    this.onPlaybackStateChanged();
  }

  // A play deferred behind the PIN: a refresh meanwhile may have rebound the
  // stream to a fresh copy, whose token the stale one no longer carries.
  private latestRebind(
    channel: Channel,
    channelIndex: number,
    rebinds: number,
  ): { channel: Channel; channelIndex: number } {
    const current = this.currentChannel;
    if (rebinds === this.rebinds || !current
        || channelStreamIdentity(current) !== channelStreamIdentity(channel)
        || !sameParentalScope(current, channel)) {
      return { channel, channelIndex };
    }
    return { channel: current, channelIndex: this.currentIndex };
  }

  getAudioTracks(): AudioTrackOption[] {
    return this.tracks.getAudioTracks();
  }

  selectAudioTrack(index: number): void {
    this.tracks.selectAudioTrack(index);
  }

  getSubtitleTracks(): SubtitleTrackOption[] {
    return this.tracks.getSubtitleTracks();
  }

  selectSubtitleTrack(index: number): void {
    this.tracks.selectSubtitleTrack(index);
  }

  getPlaybackRateState(): PlaybackRateState {
    return {
      // webOS's native HLS/DASH pipeline accepts setPlayRate but keeps 1x.
      // The Up Next countdown sets the queued vod before its media loads.
      available: this.playbackActive && this.vod !== null &&
        !STREAMING_MIMES.has(streamUrlMime(this.vod.url)) &&
        // The rate would reach the placeholder clip, not the Luna stream.
        !this.pipeline.isLunaActive() &&
        !this.playbackRate.isRejected(),
      rate: this.playbackRate.currentRate(),
    };
  }

  // Why a rate change failed or was dropped, so a diag report can tell a
  // missing mediaId, a Luna error, and a pipeline that ignores the rate apart.
  private playbackRateFields(rate?: PlaybackRate): string[] {
    const fields = [
      this.playbackLabel(),
      `engine=${this.playbackRate.usesNativeRate() ? 'native' : 'html'}`,
    ];
    if (rate !== undefined) fields.push(`rate=${String(rate)}`);
    const observed = this.playbackRate.lastObservedRate();
    if (observed !== null) fields.push(`observed=${String(observed)}`);
    const failure = this.playbackRate.lastFailure();
    if (failure) {
      fields.push(`stage=${failure.stage}`, `attempt=${String(failure.attempt)}`);
      if (failure.errorCode !== null) fields.push(`errorCode=${String(failure.errorCode)}`);
      if (failure.errorText) fields.push(`errorText=${JSON.stringify(failure.errorText)}`);
    }
    return fields;
  }

  private onPlaybackRateFallback(rate: PlaybackRate): void {
    if (this.playbackRate.isRejected()) {
      log.warn('Playback rate ignored by the pipeline', 'event=playback.rate.ignored',
        ...this.playbackRateFields(rate));
    } else {
      log.warn('Playback rate reapply failed', 'event=playback.rate.lost',
        ...this.playbackRateFields(rate));
    }
    showToast(t('player.playbackSpeedFailed'));
    this.onPlaybackStateChanged();
  }

  async setPlaybackRate(rate: PlaybackRate): Promise<boolean> {
    if (!this.getPlaybackRateState().available) return false;
    const result = await this.playbackRate.setRate(rate);
    if (result === 'superseded') return false;
    const applied = result === 'applied';
    if (!applied) {
      log.warn('Playback rate change failed', 'event=playback.rate.failed',
        ...this.playbackRateFields(rate));
      showToast(t('player.playbackSpeedFailed'));
    } else {
      log.info('Playback rate changed', 'event=playback.rate.changed',
        ...this.playbackRateFields(rate));
    }
    return applied;
  }

  handleAction(action: Action, event?: NumberEvent): void {
    // Any non-OK button means 5-way/button input, so a tracked cursor position
    // is stale — drop it so OK toggles the OSD rather than seeking.
    if (action !== 'select') this.osd.clearPointer();
    if (this.vod) { this.handleVodAction(action); return; }
    switch (action) {
      case 'back':
      case 'stop':
        this.stop();
        this.onBack();
        break;
      case 'select':
        {
          const pointer = this.osd.pointerPosition();
          if (this.osd.seekAtPointer(pointer.x, pointer.y)) break;
        }
        // OSD up on a pausable stream (live DVR or catch-up): OK pauses/resumes.
        if (this.canSeek()) this.pauseToggle();
        else this.osd.toggle();
        break;
      case 'left':
        this.seekBy(-CONFIG.PLAYER.SEEK_STEP);
        break;
      case 'right':
        this.seekBy(CONFIG.PLAYER.SEEK_STEP);
        break;
      case 'up':
      case 'channel_up':
        this.channelUp();
        break;
      case 'down':
      case 'channel_down':
        this.channelDown();
        break;
      case 'yellow':
        this.showOSD();
        break;
      case 'play':
        if (this.videoEl?.paused) this.pauseToggle();
        break;
      case 'pause':
        if (this.videoEl && !this.videoEl.paused) this.pauseToggle();
        break;
      case 'rewind':
        this.goToOldest();
        break;
      case 'fast_forward':
        this.goToLive();
        break;
      case 'number':
        if (event) this.playChannelNumber(event.number);
        break;
    }
  }

  // Channel numbers are 1-based, matching the OSD readout (currentIndexAnchor + 1).
  private playChannelNumber(number: number): void {
    const index = number - 1;
    if (index < 0 || index >= PlaylistService.channels.length) {
      log.debug('Channel number out of range', 'event=key.number.rejected',
        `number=${number}`, 'reason=out_of_range');
      this.showOSD();
      return;
    }
    log.debug('Channel number jump', 'event=key.number.accepted',
      `number=${number}`, `index=${index}`);
    // A typed absolute channel number is a deliberate "go anywhere" jump —
    // clear any active view scope so a following channel_up/down resumes
    // plain global stepping, not whatever view was active before this jump.
    this.play(index, undefined, null);
  }
}

// A restored Luna element keeps the placeholder as currentSrc until its next
// resource selection; it is never the stream that failed.
function elementSrc(video: HTMLVideoElement | null): string {
  const src = video?.currentSrc || '';
  return src.indexOf(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER) < 0 ? src : '';
}

// Same channel key and the same groups: what the PIN unlocked still covers it.
function sameParentalScope(a: Channel, b: Channel): boolean {
  const scope = (channel: Channel) => {
    const request = liveParentalRequest(channel);
    return [request.target, ...request.parents].map(parentalTargetKey).sort().join('\n');
  };
  return scope(a) === scope(b);
}

function sameParentalItem(a: VodQueueItem, b: VodQueueItem): boolean {
  return a.accountId === b.accountId && a.kind === b.kind && !!a.parentalItemId
    && a.parentalItemId === b.parentalItemId && a.categoryId === b.categoryId;
}
