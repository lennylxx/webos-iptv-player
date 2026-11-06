import type { Action, AudioTrackOption, Channel, SubtitleTrackOption } from '../types';
import { CONFIG } from '../config';
import { $, html, inShownView, onceTransitionEnd, raw, withInstantScroll } from '../utils/dom';
import { morph } from '../utils/morph';
import { AUDIO_ICON, SPEED_ICON, SUBTITLE_ICON } from './icons';
import { t } from '../i18n';
import {
  PLAYBACK_RATES,
  type PlaybackRate,
  type PlaybackRateState,
} from '../services/playback-rate';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';

const AUTO_HIDE_MS = 5000;

const MENU_ITEMS = [
  { action: 'red', color: 'red', labelKey: 'player.guide' },
  { action: 'green', color: 'green', labelKey: 'player.toggleFavorite' },
  { action: 'yellow', color: 'yellow', labelKey: 'player.channelInfo' },
  { action: 'blue', color: 'blue', labelKey: 'common.settings' },
] as const;

const VOD_MENU_ITEMS = [
  { action: 'yellow', color: 'yellow', labelKey: 'player.titleInfo' },
  { action: 'blue', color: 'blue', labelKey: 'common.settings' },
] as const;

// Sentinel data-menu-action values for the non-color rows.
const OPEN_AUDIO = '__audio_open__';
const BACK = '__menu_back__';
const PICK_AUDIO = '__audio_track__';
const OPEN_SUBS = '__subs_open__';
const PICK_SUB = '__subs_track__';
const OPEN_OFFSET = '__subs_offset__';
const OPEN_SEARCH = '__subs_search__';
const OPEN_SPEED = '__speed_open__';
const PICK_SPEED = '__speed_rate__';

/**
 * The action overlay shown on the right edge during playback. Owns its own
 * visibility, auto-hide timer and focus index. Selecting a color item hides the
 * menu and emits the chosen action via `onAction`; the host decides how to
 * route it. When the stream has multiple audio tracks an "Audio Track" row opens
 * an in-place sub-menu for picking one; likewise a "Subtitles" row when the
 * stream carries subtitle tracks. Delegated DOM listeners are bound once in the
 * constructor.
 */
export class PlayerMenu {
  private el: HTMLElement | null;
  private lastReveal: { key: string; at: number; hidden: number } | null = null;
  // Opening a menu swaps its content; it lands on its row without a glide.
  private instantReveal = false;
  private getCurrentChannel: () => Channel | null;
  private onAction: (action: Action) => void;
  private getAudioTracks: () => AudioTrackOption[];
  private selectAudioTrack: (index: number) => void;
  private getSubtitleTracks: () => SubtitleTrackOption[];
  private selectSubtitleTrack: (index: number) => void;
  private getSubtitleOffsetState: () => { available: boolean; label: string };
  private openSubtitleOffset: () => void;
  private subtitleSearchAvailable: () => boolean;
  private openSubtitleSearch: () => void;
  private getPlaybackRateState: () => PlaybackRateState;
  private selectPlaybackRate: (rate: PlaybackRate) => Promise<boolean>;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusIdx = 0;
  private mode: 'main' | 'audio' | 'subtitles' | 'speed' = 'main';
  private cancelHide: (() => void) | null = null;
  // Registered on the first show; focusIdx stays the model, the scope paints it.
  private scope: FocusScope | null = null;

  constructor(
    container: HTMLElement,
    getCurrentChannel: () => Channel | null,
    onAction: (action: Action) => void,
    getAudioTracks: () => AudioTrackOption[],
    selectAudioTrack: (index: number) => void,
    getSubtitleTracks: () => SubtitleTrackOption[],
    selectSubtitleTrack: (index: number) => void,
    getSubtitleOffsetState: () => { available: boolean; label: string },
    openSubtitleOffset: () => void,
    getPlaybackRateState: () => PlaybackRateState,
    selectPlaybackRate: (rate: PlaybackRate) => Promise<boolean>,
    subtitleSearchAvailable: () => boolean,
    openSubtitleSearch: () => void,
  ) {
    this.getCurrentChannel = getCurrentChannel;
    this.onAction = onAction;
    this.getAudioTracks = getAudioTracks;
    this.selectAudioTrack = selectAudioTrack;
    this.getSubtitleTracks = getSubtitleTracks;
    this.selectSubtitleTrack = selectSubtitleTrack;
    this.getSubtitleOffsetState = getSubtitleOffsetState;
    this.openSubtitleOffset = openSubtitleOffset;
    this.getPlaybackRateState = getPlaybackRateState;
    this.selectPlaybackRate = selectPlaybackRate;
    this.subtitleSearchAvailable = subtitleSearchAvailable;
    this.openSubtitleSearch = openSubtitleSearch;
    this.el = $('#player-menu', container);
    this.bindEvents();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(): void {
    if (this.isVisible) return;
    if (!this.scope && this.el) {
      const el = this.el;
      this.scope = Focus.register({
        id: 'player.menu',
        hoverOnSettle: true,
        root: el,
        restrict: 'self-first',
        when: () => inShownView(el),
        defaultKey: () => this.keyAt(this.focusIdx),
        reveal: (key) => this.revealRow(key),
      });
    }
    this.isVisible = true;
    this.cancelHide?.();
    this.cancelHide = null;
    this.mode = 'main';
    this.focusIdx = 0;
    this.render();
    if (this.el) {
      this.el.classList.remove('hidden');
      this.el.offsetHeight;
      this.el.classList.add('visible');
    }
    if (this.scope) Focus.push(this.scope);
    this.openAt(0);
    this.resetTimer();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    if (this.scope) Focus.pop(this.scope);
    const el = this.el;
    if (el) {
      el.classList.remove('visible');
      this.cancelHide = onceTransitionEnd(el, () => {
        this.cancelHide = null;
        if (!this.isVisible) el.classList.add('hidden');
      });
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Re-reads player state, e.g. after a speed change was found not to apply
  // or a subtitle pick fell back to Off.
  refresh(): void {
    if (!this.isVisible) return;
    if (this.mode === 'speed') {
      if (this.getPlaybackRateState().available) this.render();
      else this.openMain();
      return;
    }
    if ((this.mode === 'audio' || this.mode === 'subtitles') && this.el) {
      const focusedKey = this.keyAt(this.focusIdx);
      this.render();
      const rows = this.rows();
      const idx = rows.findIndex(row => row.dataset.key === focusedKey);
      this.focusIdx = idx >= 0 ? idx : Math.max(0, Math.min(this.focusIdx, rows.length - 1));
      this.scope?.track(this.keyAt(this.focusIdx));
      Focus.flush();
      return;
    }
    if (this.mode !== 'main' || !this.el) return;
    const focusedAction = this.rows()[this.focusIdx]?.dataset.menuAction;
    this.render();
    // Keep focus on the same action. If its row went away, follow the pointer
    // if it rests on a row, else step to the row above.
    const rows = this.rows();
    const idx = rows.findIndex(row => row.dataset.menuAction === focusedAction);
    const hovered = rows.indexOf(this.el.querySelector<HTMLElement>('.menu-item:hover')!);
    this.focusIdx = idx >= 0 ? idx
      : hovered >= 0 ? hovered
        : Math.max(0, Math.min(this.focusIdx - 1, rows.length - 1));
    this.scope?.track(this.keyAt(this.focusIdx));
    Focus.flush();
  }

  resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.el?.matches(':hover')) {
        this.resetTimer();
        return;
      }
      this.hide();
    }, AUTO_HIDE_MS);
  }

  /** Back inside the menu: leave a sub-menu without closing. Returns whether it
   *  was consumed (so the host knows not to hide the menu). */
  handleBack(): boolean {
    if (this.mode !== 'main') {
      this.openMain();
      return true;
    }
    return false;
  }

  handleAction(action: Action): void {
    if (!this.el) return;
    const items = this.rows();
    const len = items.length;
    if (!len) return;

    this.resetTimer();

    if (action === 'up') {
      this.moveTo(Math.max(0, this.focusIdx - 1), 'key');
    } else if (action === 'down') {
      this.moveTo(Math.min(len - 1, this.focusIdx + 1), 'key');
    } else if (action === 'select') {
      const item = items[this.focusIdx];
      if (item) this.selectItem(item);
    }
  }

  private rows(): HTMLElement[] {
    return this.el ? Array.from(this.el.querySelectorAll<HTMLElement>('.menu-item')) : [];
  }

  private keyAt(idx: number): string | null {
    return this.rows()[idx]?.dataset.key ?? null;
  }

  private moveTo(idx: number, via: Via): void {
    this.focusIdx = idx;
    this.scope?.focus(this.keyAt(idx), via);
    Focus.flush();
  }

  private openAt(idx: number): void {
    this.instantReveal = true;
    try {
      this.moveTo(idx, 'key');
    } finally {
      this.instantReveal = false;
    }
  }

  // Scroll only the menu's list to a row past its viewport, never the page:
  // mid slide-in the panel is off-screen, and a scrollIntoView would shift the
  // whole view. (Magic-Remote wheel scrolling is native — the wheel handler
  // lets `.menu-items` scroll itself; see key-handler.ts.)
  private revealRow(key: string): boolean | null {
    const list = this.el?.querySelector<HTMLElement>('.menu-items');
    const row = this.rows().find(item => item.dataset.key === key);
    if (!list || !row) return null;

    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    let delta: number;
    if (rowRect.top < listRect.top) {
      delta = rowRect.top - listRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      delta = rowRect.bottom - listRect.bottom;
    } else {
      return null;
    }
    const now = Date.now();
    const hidden = Math.abs(delta);
    const last = this.lastReveal;
    const age = last ? now - last.at : -1;
    // The same row still sliding in from its own reveal: hidden less each pass.
    if (!this.instantReveal && last && last.key === key && age >= 0
      && age < CONFIG.NAVIGATION.REVEAL_SETTLE_MS && hidden < last.hidden) {
      last.hidden = hidden;
      return null;
    }
    // A held key steps faster than a smooth scroll settles; each step jumps.
    const repeated = !!last && last.key !== key
      && age >= 0 && age <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
    this.lastReveal = { key, at: now, hidden };
    const target = list.scrollTop + delta;
    if (repeated || this.instantReveal) withInstantScroll([list], () => { list.scrollTop = target; });
    else list.scrollTop = target;
    return true;
  }

  /** Route a selected/clicked row by its data-menu-action. */
  private selectItem(item: HTMLElement): void {
    const action = item.dataset.menuAction;
    if (action === OPEN_AUDIO) {
      this.openAudio();
    } else if (action === OPEN_SUBS) {
      this.openSubtitles();
    } else if (action === OPEN_SPEED) {
      this.openSpeed();
    } else if (action === BACK) {
      this.openMain();
    } else if (action === PICK_AUDIO) {
      const idx = Number(item.dataset.trackIndex);
      if (!Number.isNaN(idx)) this.selectAudioTrack(idx);
      this.openMain();
    } else if (action === PICK_SUB) {
      const idx = Number(item.dataset.trackIndex);
      if (!Number.isNaN(idx)) this.selectSubtitleTrack(idx);
      this.openMain();
    } else if (action === OPEN_SEARCH) {
      this.hide();
      this.openSubtitleSearch();
    } else if (action === OPEN_OFFSET) {
      this.hide();
      this.openSubtitleOffset();
    } else if (action === PICK_SPEED) {
      const rate = Number(item.dataset.playbackRate) as PlaybackRate;
      if (PLAYBACK_RATES.indexOf(rate) !== -1) {
        this.openMain();
        void this.selectPlaybackRate(rate).then(() => {
          if (this.isVisible && this.mode === 'main') this.render();
        });
      }
    } else if (action) {
      this.hide();
      this.onAction(action as Action);
    }
  }

  private openAudio(): void {
    this.mode = 'audio';
    const tracks = this.getAudioTracks();
    const active = tracks.findIndex(t => t.active);
    this.render();
    this.openAt(active >= 0 ? active + 1 : 0); // +1 for the Back row
    this.resetTimer();
  }

  private openSubtitles(): void {
    this.mode = 'subtitles';
    const tracks = this.getSubtitleTracks();
    const active = tracks.findIndex(t => t.active);
    // Rows: Back (0), Off (1), then tracks. Focus the active track, else Off.
    this.render();
    this.openAt(active >= 0 ? active + 2 : 1);
    this.resetTimer();
  }

  private openSpeed(): void {
    this.mode = 'speed';
    const active = PLAYBACK_RATES.indexOf(this.getPlaybackRateState().rate);
    this.render();
    this.openAt(active >= 0 ? active + 1 : 1);
    this.resetTimer();
  }

  private openMain(): void {
    this.mode = 'main';
    this.render();
    this.openAt(0);
    this.resetTimer();
  }

  private render(): void {
    if (this.mode === 'audio') this.renderAudio();
    else if (this.mode === 'subtitles') this.renderSubtitles();
    else if (this.mode === 'speed') this.renderSpeed();
    else this.renderMain();
  }

  private renderMain(): void {
    const el = this.el;
    if (!el) return;

    const ch = this.getCurrentChannel();
    const chName = ch?.name || '';
    const rows = ch ? MENU_ITEMS : VOD_MENU_ITEMS;
    const tracks = this.getAudioTracks();
    const activeTrack = tracks.find(t => t.active);
    const subtitles = this.getSubtitleTracks();
    const activeSub = subtitles.find(t => t.active);
    const speed = this.getPlaybackRateState();

    const audioShown = tracks.length >= 2;

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.menu')}</h2>
        ${chName ? html`<div class="menu-subtitle">${t('player.playing', { name: chName })}</div>` : ''}
      </div>
      <div class="menu-items">
        ${rows.map((item) => html`
          <div class="menu-item"
               data-key="${item.action}"
               data-focusable data-menu-action="${item.action}">
            <span class="menu-dot ${item.color}"></span>
            <span class="menu-item-label">${t(item.labelKey)}</span>
          </div>
        `)}
        ${speed.available ? html`
          <div class="menu-item"
               data-key="${OPEN_SPEED}"
               data-focusable data-menu-action="${OPEN_SPEED}">
            <span class="menu-icon speed">${raw(SPEED_ICON)}</span>
            <span class="menu-item-label">${t('player.playbackSpeed')}</span>
            <span class="menu-item-value">${speed.rate}x</span>
          </div>
        ` : ''}
        ${audioShown ? html`
          <div class="menu-item"
               data-key="${OPEN_AUDIO}"
               data-focusable data-menu-action="${OPEN_AUDIO}">
            <span class="menu-icon audio">${raw(AUDIO_ICON)}</span>
            <span class="menu-item-label">${t('player.audioTrack')}</span>
            <span class="menu-item-value">${activeTrack?.label || ''}</span>
          </div>
        ` : ''}
        ${subtitles.length >= 1 || this.subtitleSearchAvailable() ? html`
          <div class="menu-item"
               data-key="${OPEN_SUBS}"
               data-focusable data-menu-action="${OPEN_SUBS}">
            <span class="menu-icon subtitle">${raw(SUBTITLE_ICON)}</span>
            <span class="menu-item-label">${t('player.subtitles')}</span>
            <span class="menu-item-value">${activeSub?.label || t('common.off')}</span>
          </div>
        ` : ''}
      </div>
    `);
  }

  private renderSpeed(): void {
    const el = this.el;
    if (!el) return;
    const active = this.getPlaybackRateState().rate;

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.playbackSpeed')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        ${PLAYBACK_RATES.map((rate) => html`
          <div class="menu-item" data-key="speed:${rate}"
               data-focusable data-menu-action="${PICK_SPEED}"
               data-playback-rate="${rate}">
            <span class="menu-check">${rate === active ? '✓' : ''}</span>
            <span class="menu-track-label">${rate}x</span>
          </div>
        `)}
      </div>
    `);
  }

  private renderAudio(): void {
    const el = this.el;
    if (!el) return;

    const tracks = this.getAudioTracks();

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.audioTrack')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        ${tracks.map((t) => html`
          <div class="menu-item ${t.available === false ? 'unavailable' : ''}" data-key="audio:${t.index}"
               data-focusable data-menu-action="${PICK_AUDIO}" data-track-index="${t.index}">
            <span class="menu-check">${t.active ? '✓' : ''}</span>
            <span class="menu-track-label">${t.label}</span>
          </div>
        `)}
      </div>
    `);
  }

  private renderSubtitles(): void {
    const el = this.el;
    if (!el) return;

    const tracks = this.getSubtitleTracks();
    const anyActive = tracks.some(t => t.active);

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.subtitles')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        <div class="menu-item" data-key="sub:-1"
             data-focusable data-menu-action="${PICK_SUB}" data-track-index="-1">
          <span class="menu-check">${anyActive ? '' : '✓'}</span>
          <span class="menu-track-label">${t('common.off')}</span>
        </div>
        ${tracks.map((t) => html`
          <div class="menu-item ${t.available === false ? 'unavailable' : ''}" data-key="sub:${t.index}"
               data-focusable data-menu-action="${PICK_SUB}" data-track-index="${t.index}">
            <span class="menu-check">${t.active ? '✓' : ''}</span>
            <span class="menu-track-label">${t.label}</span>
          </div>
        `)}
        ${this.subtitleSearchAvailable() ? html`
          <div class="menu-item" data-key="${OPEN_SEARCH}"
               data-focusable data-menu-action="${OPEN_SEARCH}">
            <span class="menu-check"></span>
            <span class="menu-track-label">${t('player.searchOnline')}</span>
          </div>
        ` : ''}
        ${(() => {
          const st = this.getSubtitleOffsetState();
          return st.available ? html`
            <div class="menu-item" data-key="${OPEN_OFFSET}"
                 data-focusable data-menu-action="${OPEN_OFFSET}">
              <span class="menu-check"></span>
              <span class="menu-track-label">${t('player.subtitleSync')}</span>
              <span class="menu-item-value">${st.label}</span>
            </div>` : '';
        })()}
      </div>
    `);
  }

  private bindEvents(): void {
    const el = this.el;
    if (!el) return;

    // Click selects a row
    el.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-menu-action]');
      if (btn) this.selectItem(btn);
    });

    // Hover moves focus
    el.addEventListener('nav:hover', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      const idx = btn ? this.rows().indexOf(btn) : -1;
      if (idx < 0) return;
      this.moveTo(idx, 'pointer');
      this.resetTimer();
    });
  }
}
