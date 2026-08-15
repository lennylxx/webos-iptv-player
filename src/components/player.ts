import type {
  Action,
  AudioTrackOption,
  CatchupInfo,
  Channel,
  SubtitleTrackOption,
  VodPlayback,
  VodQueueItem,
} from '../types';
import { formatXtreamCatchupStart } from '../utils/xtream-url';
import { show, hide } from '../utils/dom';
import { channelKey } from '../utils/channel';
import { dvrWindow, dvrState, type DvrWindow } from '../utils/dvr';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { CONFIG } from '../config';
import { StallWatchdog, type StallProbe, type StallRecovery } from '../utils/stall-watchdog';
import { resolutionBadge, hdrLabel, frameRateLabel, pickVariant, codecName, audioSummary, subtitleSummary, type StreamVariant, type MediaInfo } from '../utils/stream-info';
import { extFromUrl, diagnosticStreamUrl } from '../utils/url';
import { probeMedia } from '../services/media-probe';
import { ChannelHealthService } from '../services/channel-health';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { showToast } from './toast';
import { PlayerPipeline, type PipelineManifest } from './player-pipeline';
import {
  PlayerOsd,
  type PlayerOsdSnapshot,
  type PlayerOsdStreamInfo,
} from './player-osd';
import { PlayerTracks } from './player-tracks';

const log = createLogger('Player');

// True on the TV's webOS WebView; false in desktop preview / tests.
const isWebOS = /webOS|Web0S/i.test(navigator.userAgent);

export class Player {
  private container: HTMLElement;
  private onBack: () => void;
  private onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void;
  private canAutoRevealOsd: () => boolean;
  private onChannelHealthChanged: () => void;
  private videoEl: HTMLVideoElement | null = null;
  private pipeline: PlayerPipeline;
  private tracks: PlayerTracks;
  private osd: PlayerOsd;
  private currentChannel: Channel | null = null;
  private currentIndex = -1;
  private currentIndexAnchor = -1;
  private catchupInfo: CatchupInfo | null = null;
  private vod: VodPlayback | null = null;
  private upNextSeconds = 0;
  private upNextTimer: ReturnType<typeof setInterval> | null = null;
  private pendingResumeSecs = 0;
  private pendingSeekTarget: number | null = null;
  private wasPlayingBeforeHide = false;
  private dvrPauseTick: ReturnType<typeof setInterval> | null = null;
  // Catch-up progress checkpointing. Wall-clock time of the last periodic save;
  // reset to Date.now() on every new catch-up session so the first checkpoint
  // fires CHECKPOINT_INTERVAL after tune-in, not immediately.
  private catchupCheckpointAt = 0;
  // Position (seconds) saved from the video element before suspend() destroys it.
  // play() consumes this to restore the position on resume; -1 = not pending.
  private catchupSuspendPos = -1;
  private catchupFallbackActive = false;
  private playbackGeneration = 0;
  private healthSuccessGeneration = -1;
  private healthStartedAt = 0;
  private liveHistoryGeneration = -1;
  private liveHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  // Manual A/V resync (catch-up / VOD): true from the resync seek until playback
  // resumes, gating the "Resyncing…" message and debouncing repeat presses.
  private resyncing = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private manifestVariants: StreamVariant[] = []; // HLS master variants for best-effort codec readout
  private vodInfo: MediaInfo | null = null; // container-header stream info for the active VOD (codec/fps/HDR)
  private stallWatchdog: StallWatchdog;
  constructor(
    container: HTMLElement,
    onBack: () => void,
    onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void = () => {},
    canAutoRevealOsd: () => boolean = () => true,
    onChannelHealthChanged: () => void = () => {},
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
      onError: () => this.onError(),
      onAudioTracksUpdated: () => this.tracks.applyHlsAudioSelection(),
      onSubtitleTracksUpdated: () => this.tracks.applyHlsSubtitleSelection(),
      onManifest: manifest => this.applyPipelineManifest(manifest),
    });
    this.tracks = new PlayerTracks(this.pipeline, {
      getVideoElement: () => this.videoEl,
      getChannel: () => this.currentChannel,
      getVod: () => this.vod,
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
          paused: v.paused,
          seeking: v.seeking,
        };
      },
      onReload: recovery => {
        log.warn('Watchdog reloading a stalled stream',
          'event=playback.stall.reload', this.playbackLabel(),
          this.recoveryState(recovery));
        this.reloadCurrentStream();
      },
      onEscalate: recovery => {
        log.error('Watchdog recovery exhausted; advancing channel',
          'event=playback.stall.exhausted', this.playbackLabel(),
          this.recoveryState(recovery));
        this.markLiveUnavailable('stall_exhausted');
        this.channelUp();
      },
      pollMs: CONFIG.PLAYER.STALL_POLL_MS,
      freezeTicks: CONFIG.PLAYER.STALL_FREEZE_TICKS,
      maxReloads: CONFIG.PLAYER.STALL_MAX_RELOADS,
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
    el.addEventListener('error', () => this.onError());
    el.addEventListener('loadedmetadata', () => {
      log.info('loadedmetadata', this.videoLabel(el), el.videoWidth + 'x' + el.videoHeight,
        this.mediaState(el), '| pendingResume:', this.pendingResumeSecs);
      if ((this.vod || this.catchupInfo) && this.pendingResumeSecs > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        const target = Math.min(this.pendingResumeSecs, el.duration - 1);
        log.info('resume seek', this.videoLabel(el), '| requested:', this.pendingResumeSecs,
          '| target:', target, '| duration:', el.duration);
        el.currentTime = target;
        this.pendingResumeSecs = 0;
      }
      this.tracks.applyNativeAudioSelection();
      this.tracks.applyNativeSubtitleSelection();
      if (this.osd.isVisible()) this.osd.render();
    });
    // Intrinsic size changes mid-stream (ABR up/down-switch) so the OSD pills
    // (resolution, and on hls.js the codec/HDR/fps) reflect the live variant.
    el.addEventListener('resize', () => {
      if (this.osd.isVisible()) this.osd.render();
    });
    // Some platforms populate audio/text tracks asynchronously, after loadedmetadata.
    el.audioTracks?.addEventListener?.('addtrack', () => this.tracks.applyNativeAudioSelection());
    el.textTracks?.addEventListener?.('addtrack', () => this.tracks.applyNativeSubtitleSelection());
    el.addEventListener('playing', () => {
      log.info('playing', this.videoLabel(el), this.mediaState(el));
      this.markTrackedLiveHealthy();
      if (this.resyncing) this.endResync();
      this.confirmLiveHistory(el);
      if (this.osd.isVisible()) this.osd.resetTimer();
    });
    el.addEventListener('waiting', () => {
      log.debug('waiting', this.videoLabel(el), this.mediaState(el));
      this.cancelLiveHistoryTimer();
    });
    el.addEventListener('stalled', () => {
      log.debug('stalled event', this.videoLabel(el), this.mediaState(el));
    });
    el.addEventListener('timeupdate', () => {
      this.reconcilePendingSeek(el);
      this.refreshProgress();
    });
    el.addEventListener('seeked', () => {
      log.info('seeked', this.videoLabel(el), this.mediaState(el));
      this.reconcilePendingSeek(el, true);
      if (this.catchupInfo) this.saveCatchupProgress();
      this.refreshProgress();
    });
    el.addEventListener('ended', () => this.onEnded());
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

  suspend(): void {
    if (!this.videoEl || !this.currentChannel) return;
    if (this.wasPlayingBeforeHide) return; // already suspended
    this.wasPlayingBeforeHide = !this.videoEl.paused;
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
      this.stallWatchdog.stop();
      this.tracks.suspend();
      this.pipeline.destroy();
      this.recreateVideoEl();
    }
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
    old.pause();
    old.removeAttribute('src');
    old.innerHTML = '';
    old.load();
    const fresh = document.createElement('video');
    fresh.id = old.id;
    fresh.autoplay = true;
    this.bindVideoEvents(fresh);
    old.parentNode!.replaceChild(fresh, old);
    this.videoEl = fresh;
    this.pipeline.setVideoElement(fresh);
  }

  resume(): void {
    if (!this.videoEl || !this.currentChannel) return;
    if (this.wasPlayingBeforeHide) {
      this.wasPlayingBeforeHide = false;
      this.playResolved(this.currentChannel, this.currentIndex, this.catchupInfo || undefined);
    }
  }

  // Resolve the playable URL for a channel, applying the catch-up template when
  // a catch-up window is active. Shared by play() and the stall reload path.
  private resolveStreamUrl(channel: Channel, catchup: CatchupInfo | null, fallback = false): string {
    if (catchup && channel.catchupSource) {
      let source = fallback && channel.catchupFallbackSource
        ? channel.catchupFallbackSource
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
    if (this.errorAdvanceTimer !== null) {
      clearTimeout(this.errorAdvanceTimer);
      this.errorAdvanceTimer = null;
    }
    this.playbackGeneration++;
    this.healthStartedAt = Date.now();
    this.liveHistoryGeneration = -1;
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

  play(channelIndex: number, catchup?: CatchupInfo): void {
    const channel = PlaylistService.getByIndex(channelIndex);
    if (!channel || !this.videoEl) {
      log.warn('play() ignored — no channel or video element', { channelIndex, hasChannel: !!channel });
      return;
    }
    this.playResolved(channel, channelIndex, catchup);
  }

  private playResolved(channel: Channel, channelIndex: number, catchup?: CatchupInfo): void {
    if (!this.videoEl) return;
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

    log.info('play index', channelIndex, '|', channel.name, catchup ? '(catchup)' : '');
    this.currentChannel = channel;
    this.currentIndex = channelIndex;
    if (channelIndex >= 0) this.currentIndexAnchor = channelIndex;
    this.catchupInfo = catchup || null;
    this.onTvPlaybackChanged(channelIndex, catchup ? catchup.start * 1000 : null);
    this.catchupFallbackActive = false;
    this.vod = null;
    this.catchupCheckpointAt = Date.now(); // reset periodic-save timer for the new session
    this.osd.clearFailedIcons();
    if (channelIndex >= 0) StorageService.setLastChannel(channelIndex);
    StorageService.setLastChannelKey(channelKey(channel));

    const url = this.resolveStreamUrl(channel, catchup || null);
    if (catchup) log.debug('catchup URL:', diagnosticStreamUrl(url));

    this.videoEl.classList.add('active');
    this.loadStream(url, channel.extras);
    this.showOSD();
    show(this.container);
    if (isWebOS) this.stallWatchdog.start();
  }

  isVod(): boolean { return this.vod !== null; }

  playVod(v: VodPlayback): void {
    this.stallWatchdog.stop();
    if (!this.videoEl) { log.warn('playVod ignored — no video element'); return; }
    this.startPlaybackGeneration();
    log.info('playVod', v.title, '| resume', v.resumeSecs);
    this.saveCatchupProgress(); // save any active catch-up before switching to VOD
    this.currentChannel = null;
    this.currentIndex = -1;
    this.catchupInfo = null;
    this.vod = v;
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

  openSubtitleOffset(): void {
    this.tracks.openSubtitleOffset();
  }

  subtitleOffsetOpen(): boolean {
    return this.tracks.subtitleOffsetOpen();
  }

  handleSubtitleOffsetAction(action: Action): void {
    this.tracks.handleSubtitleOffsetAction(action);
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
      this.resolveStreamUrl(this.currentChannel, this.catchupInfo, this.catchupFallbackActive),
      this.currentChannel.extras,
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
        this.startNextItem(next, queue?.slice(1) ?? [], v.kind === 'episode', v.onBack);
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
    this.startPlaybackGeneration();
    this.clearUpNextTimer();
    if (this.vod) this.saveVodResume();
    this.saveCatchupProgress(); // save before the video element is torn down
    this.stallWatchdog.stop();
    this.tracks.stop();
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
    this.pendingSeekTarget = null;
    this.catchupCheckpointAt = 0;
    this.catchupSuspendPos = -1;
    this.catchupFallbackActive = false;
    this.resyncing = false;
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
  }

  private startNextItem(
    next: VodQueueItem,
    remaining: VodQueueItem[],
    isEpisodeQueue: boolean,
    onBack: () => void,
  ): void {
    this.recreateVideoEl();
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
    if (this.upNextTimer) clearInterval(this.upNextTimer);
    this.upNextTimer = null;
    this.upNextSeconds = 0;
  }

  private playNextItem(): void {
    const next = this.vod;
    if (!next || !this.upNextTimer) return;
    this.clearUpNextTimer();
    this.playVod(next);
  }

  private cancelNextItem(): void {
    const back = this.vod?.onBack;
    this.stop();
    back?.();
  }

  private loadStream(url: string, extras: Record<string, string> | null, opts?: { direct?: boolean }): void {
    this.tracks.resetForLoad();
    this.manifestVariants = [];
    this.pipeline.load(url, extras, opts);
  }

  private applyPipelineManifest(manifest: PipelineManifest): void {
    this.manifestVariants = manifest.variants;
    this.tracks.applyManifest(manifest);
  }

  private onError(): void {
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
        this.currentChannel.catchupFallbackSource && !this.catchupFallbackActive) {
      this.catchupFallbackActive = true;
      log.warn('Xtream catch-up failed; trying the legacy endpoint',
        'event=playback.catchup.fallback', this.playbackLabel(),
        'reason=xtream-path-failed');
      this.osd.updateMessage(t('player.retryingCatchup'));
      this.recreateVideoEl();
      this.videoEl?.classList.add('active');
      this.loadStream(
        this.resolveStreamUrl(this.currentChannel, this.catchupInfo, true),
        this.currentChannel.extras,
      );
      return;
    }
    const v = this.videoEl;
    if (this.errorAdvanceTimer !== null) return;
    this.markLiveUnavailable('playback_error');
    log.error('Video playback error', 'event=playback.video.error',
      this.playbackLabel(),
      v ? this.mediaState(v) : 'no video element',
      v?.error ? { code: v.error.code, message: v.error.message } : 'no error info',
      '| channel:', this.currentChannel?.name,
      '| url:', diagnosticStreamUrl(v?.currentSrc || this.currentChannel?.url || ''));
    this.osd.updateMessage(t('player.streamError'));
    this.errorAdvanceTimer = setTimeout(() => {
      this.errorAdvanceTimer = null;
      this.channelUp();
    }, 2000);
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
    this.osd.show();
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

  private seekTo(time: number): void {
    const v = this.videoEl;
    if (!v) return;
    const win = this.liveDvrWindow();
    if (win) {
      // Live DVR: clamp within the retained window; seeking to/near the edge snaps
      // to the live edge (a small pad back so playback does not stall at the tip).
      const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
      this.pendingSeekTarget = time >= liveEdge ? liveEdge : Math.max(win.start, time);
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      this.pendingSeekTarget = Math.max(0, Math.min(v.duration, time));
    } else {
      return;
    }
    v.currentTime = this.pendingSeekTarget;
    if (this.osd.isVisible()) this.osd.resetTimer(); else this.showOSD();
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

  private goToLive(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.end);
  }

  private goToOldest(): void {
    const win = this.liveDvrWindow();
    if (win) this.seekTo(win.start);
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
      if (win && v.currentTime < win.start) v.currentTime = win.start;
      v.play?.().catch(() => {});
      this.stopDvrPauseTick();
    } else {
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
      if (this.osd.isVisible() && this.videoEl?.paused && this.isLiveDvr()) this.refreshProgress();
      else this.stopDvrPauseTick();
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

  // Stream-info values for the OSD. Resolution comes from the video element; the
  // rest from the HLS manifest (empty for a direct-played VOD).
  private streamInfo(): PlayerOsdStreamInfo | null {
    const v = this.videoEl;
    const lvl = this.pipeline.streamInfo();
    const info = this.vod ? this.vodInfo : null; // container-header readout for VOD; null on the Live path
    const badge = resolutionBadge((v ? v.videoHeight : 0) || info?.height || 0);
    const variant = !this.pipeline.isHlsActive() && v
      ? pickVariant(this.manifestVariants, v.videoWidth, v.videoHeight)
      : null;
    const vCodec = codecName(lvl?.videoCodec ?? variant?.videoCodec ?? info?.videoCodec ?? '');
    const aCodecName = codecName(lvl?.audioCodec ?? variant?.audioCodec ?? info?.audioCodec ?? '');
    // Atmos (JOC): native path from the manifest variant's audio group; hls.js from
    // the active audio track's channel layout — loadLevelObj carries no channels.
    const hlsChannels = lvl?.audioChannels ?? '';
    const atmos = variant?.atmos || /\bJOC\b/i.test(hlsChannels);
    const aCodec = aCodecName && atmos ? `${aCodecName} Atmos` : aCodecName;
    const hdr = hdrLabel(lvl?.videoRange ?? variant?.videoRange ?? info?.hdr ?? '');
    const fps = frameRateLabel(lvl?.frameRate ?? variant?.frameRate ?? info?.fps ?? 0);
    const audio = audioSummary(this.tracks.getAudioTracks());
    const subtitle = subtitleSummary(this.tracks.getSubtitleTracks());
    if (!(badge || hdr || fps || vCodec || aCodec || audio || subtitle)) return null;
    return {
      resolution: badge,
      hdr,
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
    const len = PlaylistService.channels.length;
    if (!len) return;
    const next = this.currentIndex >= 0
      ? (this.currentIndex + 1) % len
      : Math.min(this.currentIndexAnchor, len - 1);
    this.play(next);
  }

  channelDown(): void {
    const len = PlaylistService.channels.length;
    if (!len) return;
    const next = this.currentIndex >= 0
      ? (this.currentIndex - 1 + len) % len
      : Math.max(0, Math.min(this.currentIndexAnchor - 1, len - 1));
    this.play(next);
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

  /** Re-point the playing index after a customization reordered the channel list.
   *  Playback itself is untouched — only the index the UI reports changes. */
  syncCurrentIndex(): void {
    if (!this.currentChannel) return;
    const idx = PlaylistService.indexOf(this.currentChannel);
    if (idx >= 0) {
      this.currentIndex = idx;
      this.currentIndexAnchor = idx;
      this.onTvPlaybackChanged(idx, this.catchupInfo ? this.catchupInfo.start * 1000 : null);
    } else {
      this.currentIndex = -1;
      this.onTvPlaybackChanged(-1, this.catchupInfo ? this.catchupInfo.start * 1000 : null);
    }
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

  handleAction(action: Action): void {
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
    }
  }
}
