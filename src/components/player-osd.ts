import type { CatchupInfo, Channel, Programme } from '../types';
import { CONFIG } from '../config';
import { $, hide, html, raw, type Safe, show } from '../utils/dom';
import { type DvrState } from '../utils/dvr';
import { morph } from '../utils/morph';
import { formatDuration, formatPosition, formatTime, getProgress } from '../utils/time';
import { t, tp } from '../i18n';
import { PAUSE_ICON, PLAY_ICON, RESYNC_ICON } from './icons';

export interface PlayerOsdSnapshot {
  playback: {
    position: number;
    duration: number;
    paused: boolean;
  } | null;
  channel: Channel | null;
  channelNumber: number;
  catchup: CatchupInfo | null;
  vodTitle: string | null;
  upNextSeconds: number;
  dvr: DvrState | null;
  nowPlaying: Programme | null;
  upcoming: Programme | null;
  streamInfo: PlayerOsdStreamInfo | null;
}

export interface PlayerOsdStreamInfo {
  resolution: {
    tier: string;
    label: string;
  } | null;
  hdr: string;
  fps: string;
  videoCodec: string;
  audioCodec: string;
  audio: string;
  subtitle: string;
}

export interface PlayerOsdOptions {
  getSnapshot: () => PlayerOsdSnapshot;
  canAutoReveal: () => boolean;
  canSeek: () => boolean;
  onSeekFraction: (fraction: number) => void;
  onPauseToggle: () => void;
  onGoLive: () => void;
  onResync: () => void;
  onPlayNext: () => void;
  onCancelNext: () => void;
}

export class PlayerOsd {
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pointerX: number | null = null;
  private pointerY: number | null = null;
  // Programme-icon URLs that failed to load, so a re-render omits them instead of
  // re-requesting a broken image (which would thrash the OSD layout).
  private failedIcons = new Set<string>();

  constructor(private container: HTMLElement, private callbacks: PlayerOsdOptions) {
    // Activate OSD controls on click by coordinate hit-test (vs e.target) since
    // they sit over the video plane. The persistent container is marked so the
    // global click handler skips this self-activating subtree.
    container.setAttribute('data-self-activate', '');
    container.addEventListener('mousemove', (e: MouseEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      // An active cursor reveals the OSD (and its controls) so there's
      // something to aim at; keep it up while the cursor keeps moving.
      if (this.visible) this.resetTimer();
      else if (this.callbacks.canAutoReveal()) this.show();
    });
    container.addEventListener('click', (e: MouseEvent) => this.onPointerRelease(e.clientX, e.clientY));
    // A broken programme icon: record its URL (capture — `error` doesn't bubble)
    // and re-render so morph drops it and never re-requests it.
    container.addEventListener('error', (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement) ||
          !target.classList.contains('osd-programme-icon')) return;
      const src = target.getAttribute('src');
      if (src && !this.failedIcons.has(src)) {
        this.failedIcons.add(src);
        if (this.visible) this.render();
      }
    }, true);
  }

  isVisible(): boolean {
    return this.visible;
  }

  pointerPosition(): { x: number | null; y: number | null } {
    return { x: this.pointerX, y: this.pointerY };
  }

  clearPointer(): void {
    this.pointerX = null;
    this.pointerY = null;
  }

  clearFailedIcons(): void {
    this.failedIcons.clear();
  }

  show(): void {
    this.visible = true;
    this.render();
    const osd = $('#player-osd', this.container);
    if (osd) show(osd);
    this.resetTimer();
  }

  hide(): void {
    this.visible = false;
    const osd = $('#player-osd', this.container);
    if (osd) hide(osd);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  toggle(): void {
    if (this.visible) this.hide(); else this.show();
  }

  resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Keep the OSD up while paused (live DVR or catch-up): nothing to fall behind.
    if (this.callbacks.getSnapshot().playback?.paused) return;
    this.timer = setTimeout(() => this.hide(), CONFIG.PLAYER.OSD_TIMEOUT);
  }

  render(): void {
    const osd = $('#player-osd', this.container);
    if (!osd) return;
    const state = this.callbacks.getSnapshot();
    if (state.vodTitle !== null) {
      this.renderVod(osd, state);
      return;
    }
    if (!state.channel) return;

    let programmeHtml: string | Safe = '';
    if (state.catchup) {
      // Catch-up playback: show the selected programme's info. The bar tracks the
      // video's playback position (a seekable VOD), not wall-clock time.
      const catchup = state.catchup;
      const start = new Date(catchup.start * 1000);
      const end = new Date(catchup.end * 1000);
      const playback = state.playback;
      const dur = playback && Number.isFinite(playback.duration) && playback.duration > 0
        ? playback.duration
        : catchup.end - catchup.start;
      const pos = playback ? Math.min(playback.position, dur) : 0;
      const progress = dur > 0 ? pos / dur : 0;
      programmeHtml = html`
        <div class="osd-programme">
          <div class="osd-now-label">${t('common.catchup')}</div>
          <div class="osd-programme-detail">
            ${this.programmeIcon(catchup.icon)}
            <div class="osd-programme-info">
              <div class="osd-programme-title">${catchup.title}</div>
              <div class="osd-programme-time">
                ${formatTime(start)} - ${formatTime(end)}
                <span class="osd-remaining">${formatDuration(end.getTime() - start.getTime())}</span>
              </div>
            </div>
          </div>
          <div class="osd-progress-row">
            ${this.playPauseButton(state.playback?.paused ?? false)}
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
    } else if (state.nowPlaying || state.dvr) {
      // Live playback. Show EPG programme info, and a DVR timeshift bar when the
      // stream exposes a usable seekable window.
      const nowPlaying = state.nowPlaying;
      const next = state.upcoming ? html`
        <div class="osd-next">
          <span class="osd-next-label">${t('player.next')}</span>
          <span class="osd-next-title">${state.upcoming.title}
            <span class="osd-next-time">${formatTime(state.upcoming.start)}</span>
          </span>
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
        </div>
      ` : '';
      const progressRow = state.dvr
        ? this.dvrProgressRow(state.dvr, state.playback?.paused ?? false)
        : nowPlaying ? html`
          <div class="osd-progress-row">
            <span class="osd-time-current">${formatTime(new Date())}</span>
            <div class="osd-progress">
              <div class="osd-progress-bar"
                style="width: ${getProgress(nowPlaying.start, nowPlaying.stop) * 100}%"></div>
            </div>
            <span class="osd-time-end">${formatTime(nowPlaying.stop)}</span>
          </div>
        ` : '';
      programmeHtml = html`
        <div class="osd-programme">
          <div class="osd-now-label">${t(state.dvr && !state.dvr.atLiveEdge
            ? 'player.timeshift'
            : 'player.now')}</div>
          ${detail}
          ${progressRow}
          ${nowPlaying?.description
            ? html`<div class="osd-description">${nowPlaying.description}</div>`
            : ''}
        </div>
        ${next}
      `;
    }

    morph(osd, html`
      <div class="osd-channel">
        <div class="osd-channel-number">${state.channelNumber}</div>
        ${state.channel.logo
          ? html`<img class="osd-channel-logo" src="${state.channel.logo}" alt="">`
          : ''}
        <div class="osd-channel-name">${state.channel.name}</div>
        ${this.renderStreamInfo(state.streamInfo)}
      </div>
      ${programmeHtml}
    `);
  }

  updateMessage(message: string): void {
    const osd = $('#player-osd', this.container);
    if (!osd) return;
    morph(osd, html`<div class="osd-message">${message}</div>`);
    // Keep the OSD visible so metadata can repaint over this once the stream
    // recovers (else "Reconnecting..." sticks) and it auto-hides otherwise.
    this.visible = true;
    show(osd);
    this.resetTimer();
  }

  refreshProgress(): void {
    if (!this.visible) return;
    const state = this.callbacks.getSnapshot();
    const playback = state.playback;
    if (!playback) return;
    if (state.vodTitle !== null) {
      const dur = Number.isFinite(playback.duration) ? playback.duration : 0;
      this.setProgress(dur > 0 ? Math.min(playback.position, dur) / dur : 0);
      const current = $('.osd-time-current', this.container);
      if (current) current.textContent = formatPosition(playback.position);
      return;
    }
    const hasDvrBar = !!$('[data-golive]', this.container);
    // DVR availability can flip after the OSD is already open (the seekable
    // window fills in a beat after tune-in). When the current layout no longer
    // matches, do a full render so the DVR bar appears/disappears on its own.
    if (!!state.dvr !== hasDvrBar) {
      this.render();
      return;
    }
    if (state.dvr) {
      this.setProgress(state.dvr.fraction);
      const behind = $('.osd-dvr-behind', this.container);
      if (behind) {
        behind.textContent = state.dvr.atLiveEdge
          ? t('common.live')
          : `-${formatPosition(state.dvr.behindLive)}`;
      }
      const live = $('.osd-dvr-live', this.container) as HTMLElement | null;
      if (live) live.classList.toggle('is-live', state.dvr.atLiveEdge);
      return;
    }
    if (!state.catchup || !Number.isFinite(playback.duration) || playback.duration <= 0) return;
    this.setProgress(Math.min(playback.position, playback.duration) / playback.duration);
    const current = $('.osd-time-current', this.container);
    if (current) current.textContent = formatPosition(playback.position);
  }

  /** Seek to the bar position under (x, y) when it's over the seek bar; returns
   *  whether it seeked. Used by both pointer clicks and OK over the bar. */
  seekAtPointer(x: number | null, y: number | null): boolean {
    if (x === null || y === null || !this.callbacks.canSeek()) return false;
    const bar = $('[data-seekbar]', this.container) as HTMLElement | null;
    if (!bar) return false;
    const rect = bar.getBoundingClientRect();
    const margin = 20;
    const hit = rect.width > 0 && x >= rect.left && x <= rect.right &&
      y >= rect.top - margin && y <= rect.bottom + margin;
    if (!hit) return false;
    this.callbacks.onSeekFraction((x - rect.left) / rect.width);
    return true;
  }

  // The VOD OSD reuses the Live markup: an `.osd-channel` header (movie/episode
  // title + shared stream-info) over the shared seekable `.osd-progress-row`.
  private renderVod(osd: HTMLElement, state: PlayerOsdSnapshot): void {
    if (state.upNextSeconds > 0) {
      morph(osd, html`
        <div class="osd-next-episode">
          <div class="osd-next-episode-label">${t('player.upNext')}</div>
          <div class="osd-channel-name">${state.vodTitle ?? ''}</div>
          <div class="osd-next-episode-time">${tp('player.playingIn', state.upNextSeconds)}</div>
          <div class="osd-next-episode-actions">
            <button data-next-play>${t('player.playNow')}</button>
            <button data-next-cancel>${t('common.cancel')}</button>
          </div>
        </div>
      `);
      return;
    }
    const playback = state.playback;
    const dur = playback && Number.isFinite(playback.duration) ? playback.duration : 0;
    const pos = playback ? Math.min(playback.position, dur || Infinity) : 0;
    morph(osd, html`
      <div class="osd-channel">
        <div class="osd-channel-name">${state.vodTitle ?? ''}</div>
        ${this.renderStreamInfo(state.streamInfo)}
      </div>
      <div class="osd-progress-row">
        ${this.playPauseButton(playback?.paused ?? false)}
        <span class="osd-time-current">${formatPosition(pos)}</span>
        <div class="osd-progress" data-seekbar>
          <div class="osd-progress-bar" style="width: ${dur > 0 ? (pos / dur) * 100 : 0}%"></div>
        </div>
        <span class="osd-time-end">${dur > 0 ? formatPosition(dur) : ''}</span>
        ${this.resyncButton()}
      </div>
    `);
  }

  /** The programme icon `<img>`, or nothing if it has no URL or that URL already
   *  failed to load. Keyed by URL so morph reuses a loaded icon across re-renders
   *  (no reload/flicker); the delegated error listener drops a broken one. */
  private programmeIcon(url: string): Safe | string {
    if (!url || this.failedIcons.has(url)) return '';
    return html`<img class="osd-programme-icon" data-key="prog-icon:${url}" src="${url}" alt="">`;
  }

  /** The shared OSD play/pause button (live DVR and catch-up). Pointer-hit-tested
   *  by onPointerRelease and toggled by OK from Player.handleAction. */
  private playPauseButton(paused: boolean): Safe {
    return html`
      <button class="osd-dvr-btn" data-playpause
        aria-label="${t(paused ? 'player.play' : 'player.pause')}">
        ${paused ? raw(PLAY_ICON) : raw(PAUSE_ICON)}
      </button>
    `;
  }

  /** The OSD "Resync A/V" button (catch-up + VOD only). Pointer-hit-tested by
   *  onPointerRelease; invokes Player.resyncAV() through the callback. */
  private resyncButton(): Safe {
    return html`
      <button class="osd-resync-btn" data-resync aria-label="${t('player.resync')}">
        ${raw(RESYNC_ICON)}
      </button>
    `;
  }

  private dvrProgressRow(state: DvrState, paused: boolean): Safe {
    return html`
      <div class="osd-progress-row osd-dvr-row">
        ${this.playPauseButton(paused)}
        <span class="osd-time-current osd-dvr-behind">${state.atLiveEdge
          ? t('common.live')
          : `-${formatPosition(state.behindLive)}`}</span>
        <div class="osd-progress" data-seekbar>
          <div class="osd-progress-bar" style="width: ${state.fraction * 100}%"></div>
        </div>
        <button class="osd-time-end osd-dvr-live ${state.atLiveEdge ? 'is-live' : ''}"
          data-golive aria-label="${t('player.goLive')}">${t('common.live')}</button>
      </div>
    `;
  }

  // The stream-info badges (resolution / HDR / fps / codecs / audio / subtitle),
  // shared by the Live and VOD OSD.
  private renderStreamInfo(info: PlayerOsdStreamInfo | null): Safe | string {
    if (!info) return '';
    return html`
      <div class="osd-stream-info">
        ${info.resolution
          ? html`<span class="si-badge si-badge--${info.resolution.tier}">${
              info.resolution.label
            }</span>`
          : ''}
        ${info.hdr ? html`<span class="si-badge si-badge--hdr">${info.hdr}</span>` : ''}
        ${info.fps ? html`<span class="si-pill">${info.fps}fps</span>` : ''}
        ${info.videoCodec ? html`<span class="si-pill">${info.videoCodec}</span>` : ''}
        ${info.audioCodec ? html`<span class="si-pill">${info.audioCodec}</span>` : ''}
        ${info.audio ? html`<span class="si-text">${info.audio}</span>` : ''}
        ${info.subtitle ? html`<span class="si-text">${t('player.subtitlesTrack', { name: info.subtitle })}</span>` : ''}
      </div>
    `;
  }

  private setProgress(fraction: number): void {
    const bar = $('.osd-progress-bar', this.container) as HTMLElement | null;
    if (bar) bar.style.width = `${fraction * 100}%`;
  }

  /** A pointer release: seek if it landed on the bar, else activate the play/pause,
   *  Go-to-Live, or resync control under it. Coordinates are used because the OSD
   *  controls sit over the video plane. */
  private onPointerRelease(x: number, y: number): void {
    const state = this.callbacks.getSnapshot();
    if (state.upNextSeconds > 0) {
      if (this.hitsControl('[data-next-play]', x, y)) this.callbacks.onPlayNext();
      else if (this.hitsControl('[data-next-cancel]', x, y)) this.callbacks.onCancelNext();
      return;
    }
    if (this.seekAtPointer(x, y)) return;
    if (this.hitsControl('[data-playpause]', x, y)) this.callbacks.onPauseToggle();
    else if (this.hitsControl('[data-golive]', x, y)) this.callbacks.onGoLive();
    else if (this.hitsControl('[data-resync]', x, y)) this.callbacks.onResync();
  }

  private hitsControl(selector: string, x: number, y: number): boolean {
    const element = $(selector, this.container) as HTMLElement | null;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && x >= rect.left && x <= rect.right &&
      y >= rect.top && y <= rect.bottom;
  }
}
