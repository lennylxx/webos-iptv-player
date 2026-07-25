import type { Action, Channel, CatchupInfo, AudioTrackOption, AudioOption, AudioPref, ManifestAudio,
  SubtitleTrackOption, SubtitleOption, SubtitlePref, ManifestSubtitle, ManifestClosedCaption, VodPlayback, VodQueueItem, SidecarSubtitle } from '../types';
import { formatXtreamCatchupStart } from '../utils/xtream-url';
import { $, show, hide, html, raw, Safe } from '../utils/dom';
import { channelKey } from '../utils/channel';
import { morph } from '../utils/morph';
import { dvrWindow, dvrState, type DvrWindow, type DvrState } from '../utils/dvr';
import { fetchLimitedText } from '../utils/fetch-helper';
import { audioLabel, hlsAudioOptions, nativeAudioOptions, chooseAudioIndex, isPrefMatch, parseAudioRenditions, mergeManifestNames } from '../utils/audio-tracks';
import { subtitleLabel, hlsSubtitleOptions, manifestSubtitleOptions, nativeSubtitleOptions, chooseSubtitleIndex, isSubtitlePrefMatch, parseSubtitleRenditions, parseClosedCaptions, closedCaptionLabel, clampSubtitleOffset, formatSubtitleOffset, shiftForeignTrack } from '../utils/subtitle-tracks';
import { PlaylistService } from '../services/playlist-service';
import { EpgService } from '../services/epg-service';
import { StorageService } from '../services/storage-service';
import { HlsSubtitles } from '../services/hls-subtitles';
import { VodSubtitles } from '../services/vod-subtitles';
import { AssSubtitles, isAssSidecar } from '../services/ass-subtitles';
import { getCachedSubtitle, setCachedSubtitle } from '../services/idb-cache';
import { CONFIG } from '../config';
import { formatTime, formatPosition, formatDuration, getProgress } from '../utils/time';
import { getLenientLoaders } from '../utils/hls-stable-loader';
import { StallWatchdog, type StallProbe } from '../utils/stall-watchdog';
import { resolutionBadge, hdrLabel, frameRateLabel, parseVariants, pickVariant, codecName, audioSummary, subtitleSummary, type StreamVariant, type MediaInfo } from '../utils/stream-info';
import { extFromUrl, containerMime } from '../utils/url';
import { probeMedia } from '../services/media-probe';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { PLAY_ICON, PAUSE_ICON, RESYNC_ICON } from './icons';
import { showToast } from './toast';
import { subtitleSearchService } from '../services/subtitle-search/subtitle-search-service';
import { SubtitleSearchOverlay } from './subtitle-search-overlay';
import { SubtitleOffsetOverlay } from './subtitle-offset-overlay';
import type { OnlineSubtitleResult, SubtitleQuery } from '../services/subtitle-search/types';

const log = createLogger('Player');

// True on the TV's webOS WebView; false in desktop preview / tests.
const isWebOS = /webOS|Web0S/i.test(navigator.userAgent);

// Picker sentinel for the in-band CEA-608/708 toggle. -1 is the synthetic "Off"
// row; -2 is the single closed-caption entry, drawn by the native compositor via
// setSubtitleEnable (channel selection is impossible — selectTrack decode-freezes).
const CC_SUBTITLE_INDEX = -2;

// Sentinel for the "Search online…" subtitle row, which opens the search overlay.
const SEARCH_ONLINE_INDEX = -3;

// Base for the synthetic picker indices of ASS/SSA sidecars, which can't surface
// as native <track>s (assjs draws them). Kept high so it never collides with a
// real textTracks index or the -1 Off / -2 CC sentinels; the i-th ASS sidecar is
// ASS_SUBTITLE_BASE + i.
export const ASS_SUBTITLE_BASE = 1000;

// hls.js and mpegts.js are loaded as globals via preview-libs.js (desktop preview only)
const win = window as unknown as Record<string, unknown>;
type HlsType = typeof import('hls.js').default;
type MpegtsType = typeof import('mpegts.js').default;

export class Player {
  private container: HTMLElement;
  private onBack: () => void;
  private onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void;
  private videoEl: HTMLVideoElement | null = null;
  private hls: InstanceType<HlsType> | null = null;
  private mpegtsPlayer: { destroy(): void } | null = null;
  private currentChannel: Channel | null = null;
  private currentIndex = -1;
  private catchupInfo: CatchupInfo | null = null;
  private vod: VodPlayback | null = null;
  private upNextSeconds = 0;
  private upNextTimer: ReturnType<typeof setInterval> | null = null;
  private pendingResumeSecs = 0;
  private osdVisible = false;
  private pointerX: number | null = null;
  private pointerY: number | null = null;
  private osdTimer: ReturnType<typeof setTimeout> | null = null;
  private wasPlayingBeforeHide = false;
  private pointerBound = false;
  private dvrPauseTick: ReturnType<typeof setInterval> | null = null;
  // Programme-icon URLs that failed to load, so a re-render omits them instead of
  // re-requesting a broken image (which would thrash the OSD layout).
  private failedIcons = new Set<string>();
  private loadToken = 0;
  private hlsRecoveries = 0; // fatal hls.js errors recovered since the last good fragment
  private manifestAudio: ManifestAudio[] = []; // real track names parsed from the HLS master (webOS)
  private manifestSubtitles: ManifestSubtitle[] = []; // subtitle names parsed from the HLS master (webOS)
  private manifestClosedCaptions: ManifestClosedCaption[] = []; // CEA-608/708 declared in the HLS master (webOS)
  // Catch-up progress checkpointing. Wall-clock time of the last periodic save;
  // reset to Date.now() on every new catch-up session so the first checkpoint
  // fires CHECKPOINT_INTERVAL after tune-in, not immediately.
  private catchupCheckpointAt = 0;
  // Position (seconds) saved from the video element before suspend() destroys it.
  // play() consumes this to restore the position on resume; -1 = not pending.
  private catchupSuspendPos = -1;
  private catchupFallbackActive = false;
  private playbackGeneration = 0;
  private liveHistoryGeneration = -1;
  private liveHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  // Manual A/V resync (catch-up / VOD): true from the resync seek until playback
  // resumes, gating the "Resyncing…" message and debouncing repeat presses.
  private resyncing = false;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private ccEnabled = false; // live state of the native caption compositor (setSubtitleEnable)
  private selfRenderIndex = -1; // manifest subtitle rendition currently self-rendered (-1 = off)
  private masterUrl = ''; // HLS master URL of the active stream, for re-pointing self-render
  private manifestVariants: StreamVariant[] = []; // HLS master variants for best-effort codec readout
  private vodInfo: MediaInfo | null = null; // container-header stream info for the active VOD (codec/fps/HDR)
  private manifestSeq = 0;
  private manifestController: AbortController | null = null;
  private subs = new HlsSubtitles(); // self-rendered subtitles on the webOS native path
  private vodSubs = new VodSubtitles(); // sidecar SRT/WebVTT tracks for VOD (Xtream)
  private assSubs = new AssSubtitles(); // sidecar ASS/SSA subtitles for VOD, drawn by assjs
  private vodAssSidecars: SidecarSubtitle[] = []; // the ASS/SSA sidecars of the current VOD item
  private activeAssIndex = -1; // index into vodAssSidecars currently shown (-1 = none)
  private subsOverlay: SubtitleSearchOverlay | null = null; // online subtitle search overlay
  private subtitleOffsetS = 0; // per-stream subtitle timing offset (seconds; + = later)
  private offsetOverlay: SubtitleOffsetOverlay | null = null;
  private stallWatchdog: StallWatchdog;
  constructor(
    container: HTMLElement,
    onBack: () => void,
    onTvPlaybackChanged: (channelIndex: number, catchupStart: number | null) => void = () => {},
  ) {
    this.container = container;
    this.onBack = onBack;
    this.onTvPlaybackChanged = onTvPlaybackChanged;
    this.stallWatchdog = new StallWatchdog({
      probe: (): StallProbe => {
        const v = this.videoEl;
        // No element -> report "paused" so a stray tick is a no-op.
        if (!v) return { currentTime: 0, readyState: 0, paused: true, seeking: false };
        return { currentTime: v.currentTime, readyState: v.readyState, paused: v.paused, seeking: v.seeking };
      },
      onReload: () => this.reloadCurrentStream(),
      onEscalate: () => this.channelUp(),
      pollMs: CONFIG.PLAYER.STALL_POLL_MS,
      freezeTicks: CONFIG.PLAYER.STALL_FREEZE_TICKS,
      maxReloads: CONFIG.PLAYER.STALL_MAX_RELOADS,
    });
  }

  init(videoEl: HTMLVideoElement): void {
    this.videoEl = videoEl;
    this.bindVideoEvents(videoEl);

    // Pointer input. Activate OSD controls on click by coordinate hit-test (vs
    // e.target) since they sit over the video plane. Bound once (init() can re-run
    // on a fresh <video>): the handlers read this.videoEl live and the container
    // is stable. The view is marked `data-self-activate` so the global click
    // handler skips this subtree (also covering the sidebar, player menu and
    // subtitle overlay nested within).
    if (!this.pointerBound) {
      this.pointerBound = true;
      this.container.setAttribute('data-self-activate', '');
      this.container.addEventListener('mousemove', (e: MouseEvent) => {
        this.pointerX = e.clientX;
        this.pointerY = e.clientY;
        // An active cursor reveals the OSD (and its controls) so there's
        // something to aim at; keep it up while the cursor keeps moving.
        if (this.osdVisible) this.resetOsdTimer(); else this.showOSD();
      });
      this.container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));

      // A broken programme icon: record its URL (capture — `error` doesn't bubble)
      // and re-render so morph drops it and never re-requests it.
      this.container.addEventListener('error', (e: Event) => {
        const t = e.target as HTMLElement | null;
        if (!(t instanceof HTMLImageElement) || !t.classList.contains('osd-programme-icon')) return;
        const src = t.getAttribute('src');
        if (src && !this.failedIcons.has(src)) {
          this.failedIcons.add(src);
          if (this.osdVisible) this.renderOSD();
        }
      }, true);
    }

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
      log.info('loadedmetadata', el.videoWidth + 'x' + el.videoHeight, '| duration:', el.duration);
      if ((this.vod || this.catchupInfo) && this.pendingResumeSecs > 0 && Number.isFinite(el.duration) && el.duration > 0) {
        el.currentTime = Math.min(this.pendingResumeSecs, el.duration - 1);
        this.pendingResumeSecs = 0;
      }
      this.applyNativeAudioSelection();
      this.applyNativeSubtitleSelection();
      if (this.osdVisible) this.renderOSD();
    });
    // Intrinsic size changes mid-stream (ABR up/down-switch) so the OSD pills
    // (resolution, and on hls.js the codec/HDR/fps) reflect the live variant.
    el.addEventListener('resize', () => {
      if (this.osdVisible) this.renderOSD();
    });
    // Some platforms populate audio/text tracks asynchronously, after loadedmetadata.
    el.audioTracks?.addEventListener?.('addtrack', () => this.applyNativeAudioSelection());
    el.textTracks?.addEventListener?.('addtrack', () => this.applyNativeSubtitleSelection());
    el.addEventListener('playing', () => {
      log.info('playing');
      if (this.resyncing) this.endResync();
      this.confirmLiveHistory(el);
    });
    el.addEventListener('waiting', () => {
      log.debug('waiting (buffering)');
      this.cancelLiveHistoryTimer();
    });
    el.addEventListener('stalled', () => {
      log.warn('stalled');
      this.cancelLiveHistoryTimer();
    });
    el.addEventListener('timeupdate', () => this.refreshProgress());
    el.addEventListener('seeked', () => { if (this.catchupInfo) this.saveCatchupProgress(); });
    el.addEventListener('ended', () => this.onEnded());
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
        this.catchupSuspendPos = Math.max(this.videoEl.currentTime, this.pendingResumeSecs);
        this.saveCatchupProgress();
      }
      this.stallWatchdog.stop();
      this.subs.stop();
      this.cancelManifestTracks();
      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      if (this.mpegtsPlayer) {
        this.mpegtsPlayer.destroy();
        this.mpegtsPlayer = null;
      }
      this.recreateVideoEl();
    }
  }

  /**
   * Destroy the native media pipeline by swapping in a fresh <video> element.
   * On webOS the pipeline runs in a separate process and survives src changes —
   * and after a VOD reaches `ended` it stays terminal *and* keeps its whole
   * buffer, so the next stream won't start on the same element. A fresh element
   * kills the pipeline and frees it.
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
  }

  resume(): void {
    if (!this.videoEl || !this.currentChannel) return;
    if (this.wasPlayingBeforeHide) {
      this.wasPlayingBeforeHide = false;
      this.play(this.currentIndex, this.catchupInfo || undefined);
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
    this.playbackGeneration++;
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
    this.stallWatchdog.stop();
    const channel = PlaylistService.getByIndex(channelIndex);
    if (!channel || !this.videoEl) {
      log.warn('play() ignored — no channel or video element', { channelIndex, hasChannel: !!channel });
      return;
    }
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

    log.info('play index', channelIndex, '|', channel.name, catchup ? '(catchup)' : '');
    this.currentChannel = channel;
    this.currentIndex = channelIndex;
    this.catchupInfo = catchup || null;
    this.onTvPlaybackChanged(channelIndex, catchup ? catchup.start * 1000 : null);
    this.catchupFallbackActive = false;
    this.vod = null;
    this.catchupCheckpointAt = Date.now(); // reset periodic-save timer for the new session
    this.failedIcons.clear(); // fresh icon-load attempts per channel/programme visit
    StorageService.setLastChannel(channelIndex);

    const url = this.resolveStreamUrl(channel, catchup || null);
    if (catchup) log.debug('catchup URL:', url);

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
    this.failedIcons.clear();
    this.videoEl.classList.add('active');
    this.loadStream(v.url, null, { direct: true });
    // Split sidecars: SRT/WebVTT render as native <track>s; ASS/SSA are drawn by
    // assjs into an overlay. Both after loadStream — it resets the <video>'s children.
    this.activeAssIndex = -1;
    this.vodAssSidecars = v.subtitles.filter((s) => isAssSidecar(s.url));
    this.vodSubs.attach(this.videoEl, v.subtitles.filter((s) => !isAssSidecar(s.url)));
    this.assSubs.attach(this.videoEl, this.videoEl.parentElement ?? document.body, this.vodAssSidecars);
    void this.restoreOnlineSubtitle(v);
    // Read codec/fps/HDR from the container header — the video element can't
    // expose them on webOS. Fires once, off the playback path; re-renders the OSD
    // when it resolves. Guarded so a stale probe can't clobber a newer VOD.
    this.vodInfo = null;
    void probeMedia(v.url, `${v.accountId}|media_probe|${v.kind}|${v.itemId}`).then((info) => {
      if (this.vod !== v || !info) return;
      this.vodInfo = info;
      if (this.osdVisible) this.renderOSD();
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
      position: el.currentTime || 0,
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
    const pos = el ? (el.currentTime || 0) : 0;
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
    if (this.subsOverlay?.visible) { this.subsOverlay.handleAction(action); return; }
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
        if (this.seekAtPointer(this.pointerX, this.pointerY)) break;
        if (this.canSeek()) this.pauseToggle();
        else this.toggleOSD();
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

  /** Dismiss the online subtitle-search overlay if it is open. Called on every
   *  view transition (App.showView) so it never lingers over another view or
   *  reappears when its player view is shown again. */
  closeSubtitleSearch(): void {
    this.subsOverlay?.close();
  }

  private ensureOffsetOverlay(): SubtitleOffsetOverlay | null {
    if (this.offsetOverlay) return this.offsetOverlay;
    const container = $('#subtitle-offset');
    if (!container) return null;
    this.offsetOverlay = new SubtitleOffsetOverlay(container, (s) => this.setSubtitleOffset(s));
    return this.offsetOverlay;
  }

  /** Open the subtitle-sync adjuster, seeded with the current offset. */
  openSubtitleOffset(): void {
    const o = this.ensureOffsetOverlay();
    if (o) o.open(this.subtitleOffsetS);
  }

  subtitleOffsetOpen(): boolean {
    return this.offsetOverlay?.visible === true;
  }

  handleSubtitleOffsetAction(action: Action): void {
    this.offsetOverlay?.handleAction(action);
  }

  /** Dismiss the subtitle-sync adjuster (called on every view transition). */
  closeSubtitleOffset(): void {
    this.offsetOverlay?.close();
  }

  // Whether an offset-capable subtitle is currently active (a subtitle is on and it's a
  // path whose cues we can shift — not the native-compositor CC).
  private subtitleOffsetAvailable(): boolean {
    if (this.hls) return this.hls.subtitleDisplay === true && (this.hls.subtitleTrack ?? -1) >= 0;
    if (this.ccEnabled) return false;
    if (this.vod) {
      if (this.activeAssIndex >= 0) return true;
      const list = this.videoEl?.textTracks;
      if (list) for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if ((t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'showing') return true;
      }
      return false;
    }
    return this.selfRenderIndex >= 0;
  }

  /** State for the menu's "Subtitle Sync" row. */
  subtitleOffsetState(): { available: boolean; label: string } {
    return { available: this.subtitleOffsetAvailable(), label: formatSubtitleOffset(this.subtitleOffsetS) };
  }

  /** Set the subtitle offset (clamped), persist it per stream, and apply it live. */
  setSubtitleOffset(seconds: number): void {
    this.subtitleOffsetS = clampSubtitleOffset(seconds);
    const key = this.channelPrefKey();
    if (key) StorageService.setSubtitleOffset(key, this.subtitleOffsetS);
    this.applySubtitleOffset();
    log.debug('subtitle offset', formatSubtitleOffset(this.subtitleOffsetS), key ? '(persisted)' : '(not persisted)');
  }

  // Push the current offset to every engine. Owned tracks are shifted by their engine;
  // foreign native tracks (in-container VOD, hls.js preview) go through the idempotent
  // shifter. Safe to call anytime — inactive engines no-op.
  private applySubtitleOffset(): void {
    const s = this.subtitleOffsetS;
    this.subs.setOffset(s);
    this.vodSubs.setOffset(s);
    this.assSubs.setOffset(s);
    const list = this.videoEl?.textTracks;
    if (list) for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      if (this.subs.owns(t) || this.vodSubs.owns(t)) continue; // an engine already shifted these
      shiftForeignTrack(t, s);
    }
  }

  // Load the saved offset for the current stream and apply it (called on tune-in).
  private loadSubtitleOffset(): void {
    this.subtitleOffsetS = StorageService.getSubtitleOffset(this.channelPrefKey());
    this.applySubtitleOffset();
  }

  private ensureSubsOverlay(): SubtitleSearchOverlay | null {
    if (this.subsOverlay) return this.subsOverlay;
    const container = $('#subtitle-search');
    if (!container) return null;
    this.subsOverlay = new SubtitleSearchOverlay(
      container,
      (r) => void this.applyOnlineSubtitle(r),
      () => { /* closed */ },
      (q) => void this.runSubtitleSearch(q),
    );
    return this.subsOverlay;
  }

  private buildSubtitleQuery(): SubtitleQuery {
    const v = this.vod!;
    const m = v.searchMeta ?? {};
    return {
      type: v.kind === 'episode' ? 'episode' : 'movie',
      title: v.title,
      imdbId: m.imdbId, tmdbId: m.tmdbId, year: m.year, season: m.season, episode: m.episode,
    };
  }

  private async openSubtitleSearch(): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    if (!overlay || !this.vod) return;
    overlay.setQuery(this.vod.title); // prefill the box with the detected title
    await this.runSubtitleSearch(null);
  }

  /** Run an online subtitle search and feed the overlay. `query === null` uses the
   *  structured keys (imdb/tmdb/title); a string is a manual free-form title that
   *  overrides them via `manualQuery`. Errors/empties stay on screen (no
   *  auto-close) so the persistent search box can be edited and retried. */
  private async runSubtitleSearch(query: string | null): Promise<void> {
    const overlay = this.ensureSubsOverlay();
    if (!overlay || !this.vod) return;
    if (query != null) overlay.setQuery(query);
    overlay.showStatus(t('subtitle.searching'));
    try {
      const base = this.buildSubtitleQuery();
      const q = query != null ? { ...base, manualQuery: query } : base;
      const results = await subtitleSearchService.search(q);
      if (this.vod == null) return;
      if (!results.length) { overlay.showStatus(t('subtitle.noneFound')); return; }
      overlay.open(results, subtitleSearchService.preferredLanguage());
    } catch (e) {
      log.warn('subtitle search failed:', e);
      overlay.showStatus(t('subtitle.searchFailed'));
    }
  }

  private async applyOnlineSubtitle(r: OnlineSubtitleResult): Promise<void> {
    const overlay = this.subsOverlay;
    const v = this.vod;
    if (!v) return;
    overlay?.showStatus(t('subtitle.downloading'));
    try {
      const dl = await subtitleSearchService.download(r);
      if (this.vod !== v) return; // the user switched items mid-download — don't apply/persist to the wrong VOD
      const cacheKey = `${r.providerId}:${r.id}`;
      void setCachedSubtitle(cacheKey, dl.text);
      StorageService.setPickedOnlineSub(v.accountId, v.kind, v.itemId,
        { providerId: r.providerId, id: r.id, name: r.releaseName || r.language, lang: r.language, format: dl.format });
      const sub = { id: cacheKey, name: r.releaseName || r.language, lang: r.language, url: '', text: dl.text };
      if (dl.format === 'ass' || dl.format === 'ssa') {
        this.vodAssSidecars.push(sub);
        this.applySubtitleChoice(ASS_SUBTITLE_BASE + this.vodAssSidecars.length - 1);
      } else if (this.videoEl) {
        const track = this.vodSubs.addOnline(this.videoEl, sub);
        if (track) {
          const list = this.videoEl.textTracks;
          let ti = -1;
          for (let i = 0; i < list.length; i++) if (list[i] === track) ti = i;
          if (ti >= 0) this.applySubtitleChoice(ti);
        }
      }
      this.rememberSubtitle({ off: false, name: r.releaseName || r.language, lang: r.language });
      overlay?.close();
      showToast(t('player.subtitlesTrack', { name: r.releaseName || r.language }));
    } catch (e) {
      log.warn('online subtitle download failed:', e);
      overlay?.showStatus(t('subtitle.downloadFailed'), true);
    }
  }

  private async restoreOnlineSubtitle(v: VodPlayback): Promise<void> {
    const pick = StorageService.getPickedOnlineSub(v.accountId, v.kind, v.itemId);
    if (!pick || this.vod !== v) return;
    const cacheKey = `${pick.providerId}:${pick.id}`;
    let text = await getCachedSubtitle(cacheKey);
    if (this.vod !== v) return;
    if (text == null) {
      try {
        const dl = await subtitleSearchService.download(
          { providerId: pick.providerId, id: pick.id, language: pick.lang, releaseName: pick.name,
            fileName: pick.name, format: pick.format, hearingImpaired: false, downloads: 0 });
        if (this.vod !== v) return;
        text = dl.text;
        void setCachedSubtitle(cacheKey, text);
      } catch (e) {
        log.warn('restore online subtitle failed:', e);
        return;
      }
    }
    const sub = { id: cacheKey, name: pick.name, lang: pick.lang, url: '', text };
    if (pick.format === 'ass' || pick.format === 'ssa') this.vodAssSidecars.push(sub);
    else if (this.videoEl) this.vodSubs.addOnline(this.videoEl, sub);
    this.applyNativeSubtitleSelection();
  }

  // Stall watchdog recovery: swap in a fresh <video> (kills the wedged native
  // pipeline) and reload the current channel WITHOUT going through play() — that
  // would reset the watchdog's reload budget and prevent escalation.
  private reloadCurrentStream(): void {
    if (!this.currentChannel || this.currentIndex < 0) return;
    log.warn('stall watchdog — reloading current stream:', this.currentChannel.name);
    this.updateOSDMessage(t('player.reconnecting'));
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
    if (this.catchupInfo && this.currentIndex >= 0) {
      log.info('catch-up ended — resuming live');
      this.saveCatchupProgress({ completed: true });
      const idx = this.currentIndex;
      this.catchupInfo = null; // clear before play() so it doesn't re-save with pos=0
      this.recreateVideoEl();
      this.play(idx);
    }
  }

  stop(): void {
    this.startPlaybackGeneration();
    this.clearUpNextTimer();
    if (this.vod) this.saveVodResume();
    this.saveCatchupProgress(); // save before the video element is torn down
    this.stallWatchdog.stop();
    this.subs.stop();
    this.cancelManifestTracks();
    this.vodSubs.clear();
    this.assSubs.destroy();
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.mpegtsPlayer) {
      this.mpegtsPlayer.destroy();
      this.mpegtsPlayer = null;
    }
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
    this.vodAssSidecars = [];
    this.activeAssIndex = -1;
    this.pendingResumeSecs = 0;
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
    this.osdVisible = true;
    this.renderOSD();
    show($('#player-osd', this.container));
    show(this.container);
    this.upNextTimer = setInterval(() => {
      this.upNextSeconds--;
      if (this.upNextSeconds <= 0) this.playNextItem();
      else this.renderOSD();
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
    if (!this.videoEl) return;
    this.cancelManifestTracks();
    this.manifestAudio = [];
    this.manifestSubtitles = [];
    this.manifestClosedCaptions = [];
    this.ccEnabled = false; // fresh pipeline — captions start off (608 doesn't auto-draw)
    this.selfRenderIndex = -1;
    this.masterUrl = '';
    this.manifestVariants = [];
    this.subs.stop();

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.mpegtsPlayer) {
      this.mpegtsPlayer.destroy();
      this.mpegtsPlayer = null;
    }

    const isTsUrl = url.endsWith('.ts') || url.includes('.ts?') ||
      /[?&]extension=ts(?:&|$)/i.test(url);
    const isFlvUrl = url.endsWith('.flv') || url.includes('.flv?');

    // webOS: the TV's hardware HLS/TS decoders beat MSE libraries, so play
    // natively. The URL is enough to pick the <source> MIME (extension-less
    // proxied streams default to HLS) and it avoids an extra round-trip per zap.
    if (isWebOS) {
      if (opts?.direct) {
        const mime = containerMime(url);
        log.info('loadStream url=', url, '| webOS native VOD | MIME', mime);
        this.playNative(url, mime);
        return;
      }
      const mime = isFlvUrl ? 'video/x-flv' : isTsUrl ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
      log.info('loadStream url=', url, '| webOS native | catchup:', !!this.catchupInfo, '| MIME', mime);
      // HLS only: read the master's EXT-X-MEDIA audio/subtitle names — native
      // audio/text tracks expose them with empty name/language on webOS.
      if (!isTsUrl && !isFlvUrl) void this.loadManifestTracks(url, this.manifestSeq);
      this.playNative(url, mime);
      return;
    }

    // Desktop preview: native HLS is unreliable across Chrome/Firefox/Linux, so
    // always route through hls.js/mpegts.js. URL extensions lie — some providers
    // serve HLS with no .m3u8 suffix — so classify by the server's Content-Type,
    // falling back to the URL and defaulting to HLS.
    if (opts?.direct) {
      ++this.loadToken; // invalidate any in-flight detectContentType from a prior load
      log.info('loadStream url=', url, '| desktop direct VOD');
      this.videoEl.src = url;
      this.videoEl.play().catch(e => log.warn('Direct play() rejected:', e));
      return;
    }
    const token = ++this.loadToken;
    this.detectContentType(url).then(ct => {
      if (token !== this.loadToken || !this.videoEl) return; // superseded by a newer load
      const isFlv = isFlvUrl || ct.includes('flv');
      const isTs = isTsUrl || ct.includes('mp2t');
      const isDirect = !isTs && !isFlv && /^(?:video|audio)\//.test(ct);
      const isHls = !isTs && !isFlv && !isDirect; // proxied / extension-less ⇒ HLS
      log.info('loadStream url=', url, '| content-type:', ct || '(none)', '| catchup:', !!this.catchupInfo,
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

  // Classify a stream by the server's Content-Type — URL extensions are
  // unreliable for proxied/extension-less streams, so the response header is the
  // real signal. Headers are enough, so cancel the body. Returns '' on a
  // CORS/network failure, leaving the caller on its URL heuristic (default HLS).
  private async detectContentType(url: string): Promise<string> {
    try {
      const res = await fetch(url);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      res.body?.cancel().catch(() => {});
      return ct;
    } catch {
      return '';
    }
  }

  private playNative(url: string, mime: string): void {
    if (!this.videoEl) return;
    // A <source> with an explicit MIME tells the player the format even when the
    // URL has no file extension.
    this.videoEl.removeAttribute('src');
    this.videoEl.innerHTML = '';
    const source = document.createElement('source');
    source.src = url;
    source.type = mime;
    this.videoEl.appendChild(source);
    this.videoEl.load();
    this.videoEl.play().catch(e => log.warn('Native play() rejected:', e));
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
      this.hls = new Hls(hlsConfig);
      this.hls.loadSource(url);
      this.hls.attachMedia(this.videoEl);
      // The audio/subtitle track lists aren't ready at MANIFEST_PARSED — hls.js
      // fills them and fires their *_TRACKS_UPDATED events separately, so apply
      // the saved picks there.
      this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.applyHlsAudioSelection());
      this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.applyHlsSubtitleSelection());
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log.info('hls.js MANIFEST_PARSED — starting playback');
        this.videoEl?.play().catch(e => log.warn('hls play() rejected:', e));
      });
      // A good fragment played: the stream recovered, so refill the retry budget.
      this.hls.on(Hls.Events.FRAG_BUFFERED, () => { this.hlsRecoveries = 0; });
      // Bounded recovery: retry transient network/media errors (and rotating-URL
      // re-fetches) a few times, but give up on a genuinely dead stream so it
      // zaps to the next channel instead of retrying forever.
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        log.warn('hls.js error', { type: data.type, details: data.details, fatal: data.fatal });
        if (!data.fatal) return;
        if (this.hlsRecoveries >= CONFIG.PLAYER.HLS_MAX_RECOVERIES) { this.onError(); return; }
        this.hlsRecoveries++;
        const n = `${this.hlsRecoveries}/${CONFIG.PLAYER.HLS_MAX_RECOVERIES}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          log.info(`hls.js fatal network error — restarting load (${n})`);
          this.hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          log.info(`hls.js fatal media error — recovering (${n})`);
          this.hls?.recoverMediaError();
        } else {
          this.onError();
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
      player.on(mpegts.Events.ERROR, () => {
        this.onError();
      });
    } catch {
      this.videoEl.src = url;
      this.videoEl.play().catch(() => {});
    }
  }

  private onError(): void {
    this.cancelLiveHistoryTimer();
    if (this.vod) {
      const v = this.vod;
      this.vod = null;            // so stop() won't overwrite/wipe the resume point on error
      log.warn('VOD playback error:', v.title);
      this.stop();
      showToast(t('player.unableToPlay'));
      v.onBack();
      return;
    }
    if (this.catchupInfo && this.currentChannel?.catchup === 'xtream' &&
        this.currentChannel.catchupFallbackSource && !this.catchupFallbackActive) {
      this.catchupFallbackActive = true;
      log.warn('Xtream catch-up path failed — trying legacy endpoint');
      this.updateOSDMessage(t('player.retryingCatchup'));
      this.recreateVideoEl();
      this.videoEl?.classList.add('active');
      this.loadStream(
        this.resolveStreamUrl(this.currentChannel, this.catchupInfo, true),
        this.currentChannel.extras,
      );
      return;
    }
    const v = this.videoEl;
    log.error('video error', v?.error ? { code: v.error.code, message: v.error.message } : 'no error info',
      '| channel:', this.currentChannel?.name, '| url:', this.currentChannel?.url);
    this.updateOSDMessage(t('player.streamError'));
    setTimeout(() => this.channelUp(), 2000);
  }

  showOSD(): void {
    this.osdVisible = true;
    this.renderOSD();
    show($('#player-osd', this.container));
    this.resetOsdTimer();
  }

  private resetOsdTimer(): void {
    if (this.osdTimer) clearTimeout(this.osdTimer);
    // Keep the OSD up while paused (live DVR or catch-up): nothing to fall behind.
    if (this.videoEl?.paused) return;
    this.osdTimer = setTimeout(() => this.hideOSD(), CONFIG.PLAYER.OSD_TIMEOUT);
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
    if (!this.osdVisible || !v) return false;
    if (this.vod) return Number.isFinite(v.duration) && v.duration > 0;
    if (this.catchupInfo) return Number.isFinite(v.duration) && v.duration > 0;
    return this.isLiveDvr();
  }

  seekBy(seconds: number): void {
    this.seekTo((this.videoEl?.currentTime ?? 0) + seconds);
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

  /** Seek to the bar position under (x, y) when it's over the seek bar; returns
   *  whether it seeked. Used by both pointer clicks and OK over the bar. */
  private seekAtPointer(x: number | null, y: number | null): boolean {
    const v = this.videoEl;
    if (x === null || y === null || !v || !this.canSeek()) return false;
    const bar = $('[data-seekbar]', this.container) as HTMLElement | null;
    if (!bar) return false;
    const r = bar.getBoundingClientRect();
    const M = 20; // vertical slack so a near-miss with the imprecise cursor still counts
    const hit = r.width > 0 && x >= r.left && x <= r.right && y >= r.top - M && y <= r.bottom + M;
    if (!hit) return false;
    this.seekToFraction((x - r.left) / r.width);
    return true;
  }

  /** A pointer release: seek if it landed on the bar, else activate the play/pause
   *  or Go-to-Live control under it. Coordinate-based because the OSD controls sit
   *  over the video plane. */
  private onPointerRelease(x: number, y: number): void {
    if (this.upNextTimer) {
      if (this.hitsControl('[data-next-play]', x, y)) this.playNextItem();
      else if (this.hitsControl('[data-next-cancel]', x, y)) this.cancelNextItem();
      return;
    }
    if (this.seekAtPointer(x, y)) return;
    if (this.hitsControl('[data-playpause]', x, y)) this.pauseToggle();
    else if (this.hitsControl('[data-golive]', x, y)) this.goToLive();
    else if (this.hitsControl('[data-resync]', x, y)) this.resyncAV();
  }

  private hitsControl(selector: string, x: number, y: number): boolean {
    const el = $(selector, this.container) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private seekTo(time: number): void {
    const v = this.videoEl;
    if (!v) return;
    const win = this.liveDvrWindow();
    if (win) {
      // Live DVR: clamp within the retained window; seeking to/near the edge snaps
      // to the live edge (a small pad back so playback does not stall at the tip).
      const liveEdge = win.end - CONFIG.PLAYER.DVR_GO_LIVE_PAD;
      v.currentTime = time >= liveEdge ? liveEdge : Math.max(win.start, time);
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      v.currentTime = Math.max(0, Math.min(v.duration, time));
    } else {
      return;
    }
    if (this.osdVisible) this.resetOsdTimer(); else this.showOSD();
    this.refreshProgress();
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
    this.updateOSDMessage(t('player.resyncing'));
    v.currentTime = target;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => this.endResync(), CONFIG.PLAYER.RESYNC_TIMEOUT);
  }

  private endResync(): void {
    if (!this.resyncing) return;
    this.resyncing = false;
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
    if (this.osdVisible) this.renderOSD(); // repaint over the "Resyncing…" message
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
    if (this.osdVisible) { this.renderOSD(); this.resetOsdTimer(); } else this.showOSD();
  }

  // While paused on live DVR the window keeps rolling forward, so tick the OSD
  // to keep "behind live" and the cursor accurate (timeupdate is silent paused).
  private startDvrPauseTick(): void {
    this.stopDvrPauseTick();
    this.dvrPauseTick = setInterval(() => {
      if (this.osdVisible && this.videoEl?.paused && this.isLiveDvr()) this.refreshProgress();
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
    if (!this.osdVisible) return;
    if (this.vod) {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const bar = $('.osd-progress-bar', this.container) as HTMLElement | null;
      if (bar && dur > 0) bar.style.width = `${(Math.min(v.currentTime, dur) / dur) * 100}%`;
      const cur = $('.osd-time-current', this.container);
      if (cur) cur.textContent = formatPosition(v.currentTime);
      return;
    }
    const win = this.liveDvrWindow();
    // DVR availability can flip after the OSD is already open (the seekable
    // window fills in a beat after tune-in). When the current layout no longer
    // matches, do a full render so the DVR bar appears/disappears on its own —
    // no close/reopen. [data-golive] exists only in the DVR layout.
    const hasDvrBar = !!$('[data-golive]', this.container);
    if (!!win !== hasDvrBar) { this.renderOSD(); return; }
    if (win) {
      const st = dvrState(win, v.currentTime, CONFIG.PLAYER.DVR_LIVE_EDGE);
      const bar = $('.osd-progress-bar', this.container) as HTMLElement | null;
      if (bar) bar.style.width = `${st.fraction * 100}%`;
      const behind = $('.osd-dvr-behind', this.container);
      if (behind) behind.textContent = st.atLiveEdge ? t('common.live') : `-${formatPosition(st.behindLive)}`;
      const liveEl = $('.osd-dvr-live', this.container) as HTMLElement | null;
      if (liveEl) liveEl.classList.toggle('is-live', st.atLiveEdge);
      return;
    }
    if (!this.catchupInfo || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const bar = $('.osd-progress-bar', this.container) as HTMLElement | null;
    if (bar) bar.style.width = `${(Math.min(v.currentTime, v.duration) / v.duration) * 100}%`;
    const cur = $('.osd-time-current', this.container);
    if (cur) cur.textContent = formatPosition(v.currentTime);
  }

  hideOSD(): void {
    this.osdVisible = false;
    hide($('#player-osd', this.container));
    if (this.osdTimer) clearTimeout(this.osdTimer);
    this.stopDvrPauseTick();
  }

  private toggleOSD(): void {
    if (this.osdVisible) this.hideOSD();
    else this.showOSD();
  }

  /** The programme icon `<img>`, or nothing if it has no URL or that URL already
   *  failed to load. Keyed by URL so morph reuses a loaded icon across re-renders
   *  (no reload/flicker); a broken one is recorded by the delegated 'error'
   *  listener and omitted here on the next render. */
  private programmeIcon(url: string): Safe | string {
    if (!url || this.failedIcons.has(url)) return '';
    return html`<img class="osd-programme-icon" data-key="prog-icon:${url}" src="${url}" alt="">`;
  }

  /** The shared OSD play/pause button (live DVR and catch-up). Pointer-hit-tested
   *  by onPointerRelease and toggled by OK from handleAction. */
  private playPauseButton(): Safe {
    const paused = !!this.videoEl?.paused;
    return html`
      <button class="osd-dvr-btn" data-playpause aria-label="${t(paused ? 'player.play' : 'player.pause')}">
        ${paused ? raw(PLAY_ICON) : raw(PAUSE_ICON)}
      </button>
    `;
  }

  /** The OSD "Resync A/V" button (catch-up + VOD only). Pointer-hit-tested by
   *  onPointerRelease; invokes resyncAV() to flush the pipeline and re-lock A/V. */
  private resyncButton(): Safe {
    return html`
      <button class="osd-resync-btn" data-resync aria-label="${t('player.resync')}">
        ${raw(RESYNC_ICON)}
      </button>
    `;
  }

  private dvrProgressRow(st: DvrState): Safe {
    return html`
      <div class="osd-progress-row osd-dvr-row">
        ${this.playPauseButton()}
        <span class="osd-time-current osd-dvr-behind">${st.atLiveEdge ? t('common.live') : `-${formatPosition(st.behindLive)}`}</span>
        <div class="osd-progress" data-seekbar>
          <div class="osd-progress-bar" style="width: ${st.fraction * 100}%"></div>
        </div>
        <button class="osd-time-end osd-dvr-live ${st.atLiveEdge ? 'is-live' : ''}" data-golive aria-label="${t('player.goLive')}">${t('common.live')}</button>
      </div>
    `;
  }

  // The stream-info badges (resolution / HDR / fps / codecs / audio / subtitle),
  // shared by the Live and VOD OSD. Resolution comes from the video element; the
  // rest from the HLS manifest (empty for a direct-played VOD).
  private buildStreamInfo(): Safe | '' {
    const v = this.videoEl;
    const lvl = this.hls?.loadLevelObj;
    const info = this.vod ? this.vodInfo : null; // container-header readout for VOD; null on the Live path
    const badge = resolutionBadge((v ? v.videoHeight : 0) || info?.height || 0);
    const variant = !this.hls && v ? pickVariant(this.manifestVariants, v.videoWidth, v.videoHeight) : null;
    const vCodec = codecName(lvl?.videoCodec ?? variant?.videoCodec ?? info?.videoCodec ?? '');
    const aCodecName = codecName(lvl?.audioCodec ?? variant?.audioCodec ?? info?.audioCodec ?? '');
    // Atmos (JOC): native path from the manifest variant's audio group; hls.js from
    // the active audio track's channel layout — loadLevelObj carries no channels.
    const hlsChannels = this.hls?.audioTracks?.[this.hls.audioTrack]?.channels ?? '';
    const atmos = variant?.atmos || /\bJOC\b/i.test(hlsChannels);
    const aCodec = aCodecName && atmos ? `${aCodecName} Atmos` : aCodecName;
    const hdr = hdrLabel(lvl?.videoRange ?? variant?.videoRange ?? info?.hdr ?? '');
    const fps = frameRateLabel(lvl?.frameRate ?? variant?.frameRate ?? info?.fps ?? 0);
    const audio = audioSummary(this.getAudioTracks());
    const subtitle = subtitleSummary(this.getSubtitleTracks());
    if (!(badge || hdr || fps || vCodec || aCodec || audio || subtitle)) return '';
    return html`
      <div class="osd-stream-info">
        ${badge ? html`<span class="si-badge si-badge--${badge.tier}">${badge.label}</span>` : ''}
        ${hdr ? html`<span class="si-badge si-badge--hdr">${hdr}</span>` : ''}
        ${fps ? html`<span class="si-pill">${fps}fps</span>` : ''}
        ${vCodec ? html`<span class="si-pill">${vCodec}</span>` : ''}
        ${aCodec ? html`<span class="si-pill">${aCodec}</span>` : ''}
        ${audio ? html`<span class="si-text">${audio}</span>` : ''}
        ${subtitle ? html`<span class="si-text">CC: ${subtitle}</span>` : ''}
      </div>
    `;
  }

  // The VOD OSD reuses the Live markup: an `.osd-channel` header (movie/episode
  // title + shared stream-info) over the shared seekable `.osd-progress-row`.
  private renderVodOSD(osd: HTMLElement): void {
    if (this.upNextSeconds > 0) {
      morph(osd, html`
        <div class="osd-next-episode">
          <div class="osd-next-episode-label">${t('player.upNext')}</div>
          <div class="osd-channel-name">${this.vod?.title ?? ''}</div>
          <div class="osd-next-episode-time">${t(
            this.upNextSeconds === 1 ? 'player.playingInOne' : 'player.playingIn',
            { count: this.upNextSeconds },
          )}</div>
          <div class="osd-next-episode-actions">
            <button data-next-play>${t('player.playNow')}</button>
            <button data-next-cancel>${t('common.cancel')}</button>
          </div>
        </div>
      `);
      return;
    }
    const v = this.videoEl;
    const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
    const pos = v ? Math.min(v.currentTime || 0, dur || Infinity) : 0;
    const fraction = dur > 0 ? pos / dur : 0;
    morph(osd, html`
      <div class="osd-channel">
        <div class="osd-channel-name">${this.vod?.title ?? ''}</div>
        ${this.buildStreamInfo()}
      </div>
      <div class="osd-progress-row">
        ${this.playPauseButton()}
        <span class="osd-time-current">${formatPosition(pos)}</span>
        <div class="osd-progress" data-seekbar>
          <div class="osd-progress-bar" style="width: ${fraction * 100}%"></div>
        </div>
        <span class="osd-time-end">${dur > 0 ? formatPosition(dur) : ''}</span>
        ${this.resyncButton()}
      </div>
    `);
  }

  private renderOSD(): void {
    const osd = $('#player-osd', this.container);
    if (this.vod && osd) { this.renderVodOSD(osd); return; }
    if (!osd || !this.currentChannel) return;

    const ch = this.currentChannel;
    const catchup = this.catchupInfo;

    let programmeHtml: string | Safe = '';
    if (catchup) {
      // Catch-up playback: show the selected programme's info. The bar tracks the
      // video's playback position (a seekable VOD), not wall-clock time.
      const start = new Date(catchup.start * 1000);
      const end = new Date(catchup.end * 1000);
      const v = this.videoEl;
      const dur = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (catchup.end - catchup.start);
      const pos = v ? Math.min(v.currentTime || 0, dur) : 0;
      const progress = dur > 0 ? pos / dur : 0;
      const duration = formatDuration(end.getTime() - start.getTime());
      programmeHtml = html`
        <div class="osd-programme">
          <div class="osd-now-label">${t('common.catchup')}</div>
          <div class="osd-programme-detail">
            ${this.programmeIcon(catchup.icon)}
            <div class="osd-programme-info">
              <div class="osd-programme-title">${catchup.title}</div>
              <div class="osd-programme-time">
                ${formatTime(start)} - ${formatTime(end)}
                <span class="osd-remaining">${duration}</span>
              </div>
            </div>
          </div>
          <div class="osd-progress-row">
            ${this.playPauseButton()}
            <span class="osd-time-current">${formatPosition(pos)}</span>
            <div class="osd-progress" data-seekbar>
              <div class="osd-progress-bar" style="width: ${progress * 100}%"></div>
            </div>
            <span class="osd-time-end">${formatPosition(dur)}</span>
            ${this.resyncButton()}
          </div>
          ${catchup.description ? html`<div class="osd-description">${catchup.description}</div>` : ''}
        </div>
      `;
    } else {
      // Live playback. Show EPG programme info, and a DVR timeshift bar when the
      // stream exposes a usable seekable window.
      const win = this.liveDvrWindow();
      const st = win ? dvrState(win, this.videoEl!.currentTime, CONFIG.PLAYER.DVR_LIVE_EDGE) : null;
      const epgId = EpgService.findChannelId(ch);
      const nowPlaying = epgId ? EpgService.getNowPlaying(epgId) : null;
      const upcoming = epgId ? EpgService.getUpcoming(epgId, 1) : [];

      if (nowPlaying || st) {
        const next = upcoming.length ? html`
            <div class="osd-next">
              <span class="osd-next-label">${t('player.next')}</span>
              <span class="osd-next-title">${upcoming[0].title} <span class="osd-next-time">${formatTime(upcoming[0].start)}</span></span>
            </div>
          ` : '';
        const detail = nowPlaying ? html`
            <div class="osd-programme-detail">
              ${this.programmeIcon(nowPlaying.icon)}
              <div class="osd-programme-info">
                <div class="osd-programme-title">${nowPlaying.title}</div>
                <div class="osd-programme-time">
                  ${formatTime(nowPlaying.start)} - ${formatTime(nowPlaying.stop)}
                  <span class="osd-remaining">${t('player.remaining', {
                    duration: formatDuration(nowPlaying.stop.getTime() - Date.now()),
                  })}</span>
                </div>
              </div>
            </div>` : '';
        const progressRow = st ? this.dvrProgressRow(st) : (nowPlaying ? html`
            <div class="osd-progress-row">
              <span class="osd-time-current">${formatTime(new Date())}</span>
              <div class="osd-progress">
                <div class="osd-progress-bar" style="width: ${getProgress(nowPlaying.start, nowPlaying.stop) * 100}%"></div>
              </div>
              <span class="osd-time-end">${formatTime(nowPlaying.stop)}</span>
            </div>` : '');
        programmeHtml = html`
          <div class="osd-programme">
            <div class="osd-now-label">${t(st && !st.atLiveEdge ? 'player.timeshift' : 'player.now')}</div>
            ${detail}
            ${progressRow}
            ${nowPlaying && nowPlaying.description ? html`<div class="osd-description">${nowPlaying.description}</div>` : ''}
          </div>
          ${next}
        `;
      }
    }

    const streamInfoHtml = this.buildStreamInfo();

    morph(osd, html`
      <div class="osd-channel">
        <div class="osd-channel-number">${this.currentIndex + 1}</div>
        ${ch.logo ? html`<img class="osd-channel-logo" src="${ch.logo}" alt="">` : ''}
        <div class="osd-channel-name">${ch.name}</div>
        ${streamInfoHtml}
      </div>
      ${programmeHtml}
    `);
  }

  private updateOSDMessage(message: string): void {
    const osd = $('#player-osd', this.container);
    if (!osd) return;
    osd.innerHTML = String(html`<div class="osd-message">${message}</div>`);
    // osdVisible + timer so loadedmetadata repaints over this once the stream
    // recovers (else "Reconnecting…" sticks) and it auto-hides otherwise.
    this.osdVisible = true;
    show(osd);
    this.resetOsdTimer();
  }

  channelUp(): void {
    const len = PlaylistService.channels.length;
    if (!len) return;
    this.play((this.currentIndex + 1) % len);
  }

  channelDown(): void {
    const len = PlaylistService.channels.length;
    if (!len) return;
    this.play((this.currentIndex - 1 + len) % len);
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * Normalized audio renditions of the active stream — from hls.js in the desktop
   * preview, or the native `HTMLMediaElement.audioTracks` on webOS (whose alternate
   * tracks come back empty-named, so real labels are overlaid from the parsed
   * manifest — see `loadManifestAudio`).
   */
  private audioOptions(): AudioOption[] {
    if (this.hls) return hlsAudioOptions(this.hls.audioTracks || [], this.hls.audioTrack);
    const list = this.videoEl?.audioTracks;
    if (!list) return [];
    return mergeManifestNames(nativeAudioOptions(list), this.manifestAudio);
  }

  // Fetch the HLS master once and parse its audio + subtitle rendition names so
  // the pickers, toasts and per-channel memory show real labels instead of
  // "Audio 2" / "Subtitle 2". Native audio/text tracks carry no usable
  // name/language on webOS, so this is the only source. Re-applies the saved
  // picks once names are known; degrades to generic labels on a fetch failure.
  private async loadManifestTracks(url: string, seq: number): Promise<void> {
    const controller = new AbortController();
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
      const audio = parseAudioRenditions(text);
      if (audio.length >= 2) {
        this.manifestAudio = audio;
        log.info('manifest audio:', audio.map(r => r.name || r.lang || '?').join(', '));
        this.applyNativeAudioSelection();
      }
      const subs = parseSubtitleRenditions(text);
      if (subs.length) {
        this.manifestSubtitles = subs;
        this.masterUrl = url;
        log.info('manifest subtitles:', subs.map(r => r.name || r.lang || '?').join(', '));
        // Off unless FORCED or a saved pick (spec-correct — see applySelfRenderSelection).
        this.applySelfRenderSelection();
      }
      const ccs = parseClosedCaptions(text);
      if (ccs.length) {
        this.manifestClosedCaptions = ccs;
        log.info('manifest closed captions:', ccs.map(c => c.instreamId || c.name || '?').join(', '));
        // Re-apply a saved CC choice now the manifest confirms captions exist.
        this.applyNativeSubtitleSelection();
      }
      const variants = parseVariants(text);
      if (variants.length) {
        this.manifestVariants = variants;
        log.info('manifest variants:', variants.length);
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      log.warn('manifest tracks fetch failed:', e);
    } finally {
      if (this.manifestController === controller) this.manifestController = null;
    }
  }

  private cancelManifestTracks(): void {
    this.manifestSeq++;
    this.manifestController?.abort();
    this.manifestController = null;
  }

  // Picker-facing options. When webOS collapses same-language renditions (the
  // native list is shorter than the manifest), surface every manifest rendition
  // but mark the hidden ones unavailable — the TV can't switch to them, so the
  // picker grays them rather than pretending. `available` assumes the manifest
  // lists the native-exposed renditions first (default / first-per-language).
  private displayAudioOptions(): Array<AudioOption & { available: boolean }> {
    const opts = this.audioOptions();
    if (this.manifestAudio.length > opts.length) {
      return this.manifestAudio.map((m, i) => ({
        index: i, name: m.name, lang: m.lang, isDefault: m.isDefault,
        // Mark the playing native track, not the manifest DEFAULT flag — a
        // non-conformant playlist can carry >1 DEFAULT=YES (collapsed alternates),
        // which would otherwise check several rows at once.
        active: i < opts.length ? opts[i].active : false,
        available: i < opts.length,
      }));
    }
    return opts.map(o => ({ ...o, available: true }));
  }

  /** Audio tracks for the picker. Labels prefer name, then language, then a position. */
  getAudioTracks(): AudioTrackOption[] {
    return this.displayAudioOptions().map(o => ({
      index: o.index, label: audioLabel(o), active: o.active, available: o.available,
    }));
  }

  /** Switch the active audio track and remember it for this channel. No-op for a
   *  grayed (unavailable) track — webOS can't switch to a collapsed rendition. */
  selectAudioTrack(index: number): void {
    const opt = this.displayAudioOptions().find(o => o.index === index);
    if (!opt || !opt.available) return;
    if (this.hls) {
      if (index >= 0 && index < (this.hls.audioTracks?.length || 0)) this.hls.audioTrack = index;
    } else {
      const list = this.videoEl?.audioTracks;
      if (!list || index < 0 || index >= list.length) return;
      for (let i = 0; i < list.length; i++) list[i].enabled = (i === index);
    }
    this.rememberAudio(opt);
    showToast(t('player.switchingAudio', { name: audioLabel(opt) }));
  }

  private channelPrefKey(): string {
    if (this.vod) return `vod:${this.vod.accountId}:${this.vod.kind}:${this.vod.itemId}`;
    return this.currentChannel ? channelKey(this.currentChannel) : '';
  }

  private rememberAudio(opt: AudioOption): void {
    const key = this.channelPrefKey();
    if (key) StorageService.setAudioPref(key, { name: opt.name, lang: opt.lang });
    log.info('audio: user picked', opt.index, audioLabel(opt), key ? '— saved to storage' : '(no channel key, not saved)');
  }

  // Report the storage read and the resolved track on every tune-in — even when
  // no switch is needed (the chosen track is already active) — so the default
  // pick and the pref lookup are both visible in the log.
  private logAudioChoice(path: string, options: AudioOption[], pref: AudioPref | null, idx: number): void {
    const opt = options.find(o => o.index === idx);
    const label = opt ? audioLabel(opt) : t('player.audioFallback', { number: idx + 1 });
    log.info(`audio: ${path} | tracks:`, options.length,
      '| storage pref:', pref ? (pref.name || pref.lang || '(unnamed)') : 'none',
      '| using:', idx, label, isPrefMatch(opt, pref) ? '(saved pref)' : '(stream default)');
  }

  // Re-apply the remembered choice on tune-in; with no saved pick the stream
  // default stands. hls.js drives its own rendition, so the two paths are split.
  private applyHlsAudioSelection(): void {
    if (!this.hls) return;
    const options = this.audioOptions();
    if (options.length < 2) return;
    const pref = StorageService.getAudioPref(this.channelPrefKey());
    const idx = chooseAudioIndex(options, pref);
    this.logAudioChoice('hls', options, pref, idx);
    if (idx >= 0 && idx !== this.hls.audioTrack) this.hls.audioTrack = idx;
  }

  private applyNativeAudioSelection(): void {
    if (this.hls) return; // hls.js owns the rendition; videoEl exposes only the active one
    const list = this.videoEl?.audioTracks;
    if (!list || list.length < 2) return;
    const options = this.audioOptions();
    const pref = StorageService.getAudioPref(this.channelPrefKey());
    const idx = chooseAudioIndex(options, pref);
    this.logAudioChoice('native', options, pref, idx);
    if (idx < 0 || list[idx].enabled) return; // already active — don't disturb playback
    for (let i = 0; i < list.length; i++) list[i].enabled = (i === idx);
  }

  /**
   * Normalized subtitle renditions of the active stream — from hls.js in the
   * desktop preview, or the native `HTMLMediaElement.textTracks` on webOS (whose
   * tracks can come back empty-named, so real labels are overlaid from the parsed
   * manifest — see `loadManifestTracks`).
   */
  private subtitleOptions(): SubtitleOption[] {
    if (this.hls) return hlsSubtitleOptions(this.hls.subtitleTracks || [], this.hls.subtitleTrack);
    // VOD: in-container + SRT/WebVTT sidecars surface as switchable native
    // textTracks; ASS/SSA sidecars can't, so they're appended as synthetic
    // options at ASS_SUBTITLE_BASE + i (assjs draws them).
    if (this.vod) {
      const list = this.videoEl?.textTracks;
      const native = list ? nativeSubtitleOptions(list) : [];
      const ass = this.vodAssSidecars.map((s, i) => ({
        index: ASS_SUBTITLE_BASE + i,
        name: s.name, lang: s.lang,
        isDefault: false, isForced: false,
        active: this.activeAssIndex === i,
      }));
      return native.concat(ass);
    }
    // webOS native live/catch-up: in-manifest WebVTT is self-rendered (not surfaced
    // as switchable textTracks), so the choices are the parsed master renditions and
    // the active one is what we self-render.
    return manifestSubtitleOptions(this.manifestSubtitles, this.selfRenderIndex);
  }

  // Picker-facing options. Unlike audio — where webOS collapses same-language
  // renditions so unreachable ones are grayed (displayAudioOptions) — every
  // subtitle rendition is self-renderable, so all are selectable.
  private displaySubtitleOptions(): Array<SubtitleOption & { available: boolean }> {
    return this.subtitleOptions().map(o => ({ ...o, available: true }));
  }

  /** Subtitle tracks for the picker (the menu prepends its own "Off" row). On the
   *  webOS native path a single "Closed Captions" toggle is appended when the
   *  manifest declares in-band CEA-608/708 — drawn by the native compositor. */
  getSubtitleTracks(): SubtitleTrackOption[] {
    const tracks: SubtitleTrackOption[] = this.displaySubtitleOptions().map(o => ({
      index: o.index, label: subtitleLabel(o), active: o.active, available: o.available,
    }));
    if (this.ccAvailable()) {
      tracks.push({
        index: CC_SUBTITLE_INDEX,
        label: closedCaptionLabel(this.manifestClosedCaptions),
        active: this.ccEnabled,
        available: true,
      });
    }
    if (this.vod && subtitleSearchService.isAvailable()) {
      tracks.push({ index: SEARCH_ONLINE_INDEX, label: t('player.searchOnline'), active: false, available: true });
    }
    return tracks;
  }

  // In-band CC is offered only on the native pipeline (setSubtitleEnable is a
  // webOS Luna verb) and only when the master advertises CLOSED-CAPTIONS.
  private ccAvailable(): boolean {
    return isWebOS && this.manifestClosedCaptions.length > 0;
  }

  /** Switch the active subtitle (index -1 = off, -2 = in-band CC) and remember it
   *  for this channel. No-op for a grayed (unavailable) track the platform didn't
   *  expose. CC and the other subtitle paths are mutually exclusive. */
  selectSubtitleTrack(index: number): void {
    if (index === SEARCH_ONLINE_INDEX) { void this.openSubtitleSearch(); return; }
    if (index === CC_SUBTITLE_INDEX) {
      this.subs.stop();               // self-render and the native compositor can't both draw
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
      this.rememberSubtitle({ off: false, cc: true, name: '', lang: '' });
      showToast(t('player.subtitlesTrack', { name: closedCaptionLabel(this.manifestClosedCaptions) }));
      return;
    }
    if (index === -1) {
      this.setNativeCC(false);
      this.applySubtitleChoice(-1);
      this.rememberSubtitle({ off: true, name: '', lang: '' });
      showToast(t('player.subtitlesOff'));
      return;
    }
    const opt = this.displaySubtitleOptions().find(o => o.index === index);
    if (!opt || !opt.available) return;
    this.setNativeCC(false);
    this.applySubtitleChoice(index);
    this.rememberSubtitle({ off: false, name: opt.name, lang: opt.lang });
    showToast(t('player.subtitlesTrack', { name: subtitleLabel(opt) }));
  }

  // Toggle the native caption compositor (CEA-608/708, also IMSC) via Luna. Only
  // fires on a real state change, and needs the pipeline's mediaId — exposed on
  // the native element once decoding starts. selectTrack is deliberately avoided:
  // it decode-freezes the video, so this is enable/disable only.
  private setNativeCC(enable: boolean): void {
    if (!isWebOS || enable === this.ccEnabled) return;
    const v = this.videoEl as (HTMLVideoElement & { mediaId?: string }) | null;
    const mediaId = v?.mediaId;
    if (!mediaId) { if (enable) log.warn('CC: no mediaId yet — will retry on track/metadata events'); return; }
    const w = window as unknown as {
      webOS?: { service?: { request?: (uri: string, opts: {
        method: string; parameters: unknown;
        onSuccess?: (r: unknown) => void; onFailure?: (e: unknown) => void;
      }) => void } };
    };
    const request = w.webOS?.service?.request;
    if (!request) return;
    request('luna://com.webos.media', {
      method: 'setSubtitleEnable',
      parameters: { mediaId, enable },
      onSuccess: () => log.info('CC: setSubtitleEnable', enable, 'ok'),
      onFailure: (e) => log.warn('CC: setSubtitleEnable failed:', JSON.stringify(e)),
    });
    this.ccEnabled = enable;
  }

  // Route a subtitle pick to the active engine (index -1 = off). hls.js (preview)
  // drives its own rendition; the webOS native path self-renders the chosen WebVTT
  // rendition. selectTrack is never used — it decode-freezes the video on webOS.
  private applySubtitleChoice(index: number): void {
    this.applySubtitleChoiceRaw(index);
    this.applySubtitleOffset();
  }

  private applySubtitleChoiceRaw(index: number): void {
    if (this.hls) {
      this.hls.subtitleDisplay = index >= 0;
      if (index < (this.hls.subtitleTracks?.length || 0)) this.hls.subtitleTrack = index;
      return;
    }
    // VOD: an ASS/SSA sidecar (index >= ASS_SUBTITLE_BASE) is drawn by assjs;
    // otherwise toggle the native textTrack modes directly (index -1 = all off).
    // One path draws at a time, so each disables the other.
    if (this.vod) {
      const list = this.videoEl?.textTracks;
      if (index >= ASS_SUBTITLE_BASE) {
        if (list) for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (t.kind === 'subtitles' || t.kind === 'captions') t.mode = 'disabled';
        }
        const sidecar = this.vodAssSidecars[index - ASS_SUBTITLE_BASE];
        this.activeAssIndex = sidecar ? index - ASS_SUBTITLE_BASE : -1;
        if (sidecar) void this.assSubs.show(index - ASS_SUBTITLE_BASE);
        return;
      }
      this.activeAssIndex = -1;
      this.assSubs.hide();
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
        t.mode = i === index ? 'showing' : 'disabled';
      }
      if (index >= 0 && list[index]) void this.vodSubs.ensureLoaded(list[index]); // lazy-load a sidecar's cues
      return;
    }
    const m = index >= 0 ? this.manifestSubtitles[index] : undefined;
    if (!m || !this.videoEl || !this.masterUrl) {
      this.subs.stop();
      this.selfRenderIndex = -1;
      return;
    }
    this.selfRenderIndex = index;
    void this.subs.start(this.videoEl, this.masterUrl, { name: m.name, lang: m.lang });
  }

  // Spec-correct tune-in default for self-rendered WebVTT: subtitles stay off
  // unless a rendition is FORCED, or the user saved a pick for this channel.
  // DEFAULT=YES does not auto-enable — per HLS it only marks the preferred
  // rendition once subtitles are on. A saved CC pick is applied separately.
  private applySelfRenderSelection(): void {
    if (this.hls) return;
    const pref = StorageService.getSubtitlePref(this.channelPrefKey());
    this.loadSubtitleOffset();
    if (pref?.cc) { this.applySubtitleChoice(-1); return; } // CC path owns it
    const options = manifestSubtitleOptions(this.manifestSubtitles, this.selfRenderIndex);
    const idx = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('self-render', options, pref, idx);
    this.applySubtitleChoice(idx);
  }

  private rememberSubtitle(pref: SubtitlePref): void {
    const key = this.channelPrefKey();
    if (key) StorageService.setSubtitlePref(key, pref);
    log.info('subtitle: user picked', pref.off ? 'Off' : (pref.name || pref.lang || '(unnamed)'),
      key ? '— saved to storage' : '(no channel key, not saved)');
  }

  private logSubtitleChoice(path: string, options: SubtitleOption[], pref: SubtitlePref | null, idx: number): void {
    const opt = options.find(o => o.index === idx);
    const label = idx < 0 ? t('common.off') : opt
      ? subtitleLabel(opt)
      : t('player.subtitleFallback', { number: idx + 1 });
    const src = pref?.off ? '(off pref)' : isSubtitlePrefMatch(opt, pref) ? '(saved pref)' : '(stream default)';
    log.info(`subtitle: ${path} | tracks:`, options.length,
      '| storage pref:', pref ? (pref.off ? 'off' : (pref.name || pref.lang || '(unnamed)')) : 'none',
      '| using:', idx, label, src);
  }

  // Re-apply the remembered choice on tune-in. With no saved pick subtitles stay
  // off unless the stream marks one forced. hls.js drives its own rendition, so
  // the two paths are split like audio.
  private applyHlsSubtitleSelection(): void {
    if (!this.hls) return;
    const options = this.subtitleOptions();
    if (!options.length) return;
    const pref = StorageService.getSubtitlePref(this.channelPrefKey());
    const idx = chooseSubtitleIndex(options, pref);
    this.logSubtitleChoice('hls', options, pref, idx);
    this.hls.subtitleDisplay = idx >= 0;
    if (this.hls.subtitleTrack !== idx) this.hls.subtitleTrack = idx;
    this.loadSubtitleOffset();
  }

  // Re-apply a remembered subtitle choice on the native path once the pipeline/
  // manifest confirms tracks exist (fires on loadedmetadata, an addtrack event,
  // and after the manifest parse). VOD picks from the in-container textTracks;
  // live/catch-up WebVTT is handled by applySelfRenderSelection, CC below.
  private applyNativeSubtitleSelection(): void {
    if (this.hls) return; // hls.js owns the rendition and its native text tracks
    const pref = StorageService.getSubtitlePref(this.channelPrefKey());
    if (this.vod) {
      const options = this.subtitleOptions();
      if (!options.length) return;
      const idx = chooseSubtitleIndex(options, pref);
      this.logSubtitleChoice('vod-native', options, pref, idx);
      this.applySubtitleChoice(idx);
      this.loadSubtitleOffset();
      return;
    }
    if (this.ccAvailable() && pref?.cc) {
      this.subs.stop(); // self-render and the native compositor can't both draw
      this.selfRenderIndex = -1;
      this.setNativeCC(true);
    }
  }

  handleAction(action: Action): void {
    // Any non-OK button means 5-way/button input, so a tracked cursor position
    // is stale — drop it so OK toggles the OSD rather than seeking.
    if (action !== 'select') { this.pointerX = null; this.pointerY = null; }
    if (this.vod) { this.handleVodAction(action); return; }
    switch (action) {
      case 'back':
      case 'stop':
        this.stop();
        this.onBack();
        break;
      case 'select':
        if (this.seekAtPointer(this.pointerX, this.pointerY)) break;
        // OSD up on a pausable stream (live DVR or catch-up): OK pauses/resumes.
        if (this.canSeek()) this.pauseToggle();
        else this.toggleOSD();
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
