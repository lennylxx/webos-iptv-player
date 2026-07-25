import type { Action, AudioTrackOption, SubtitleTrackOption } from '../types';
import { PlaylistService } from '../services/playlist-service';
import { $, html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { SUBTITLE_ICON } from './icons';
import { t } from '../i18n';

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
  private getCurrentIndex: () => number;
  private onAction: (action: Action) => void;
  private getAudioTracks: () => AudioTrackOption[];
  private selectAudioTrack: (index: number) => void;
  private getSubtitleTracks: () => SubtitleTrackOption[];
  private selectSubtitleTrack: (index: number) => void;
  private getSubtitleOffsetState: () => { available: boolean; label: string };
  private openSubtitleOffset: () => void;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusIdx = 0;
  private mode: 'main' | 'audio' | 'subtitles' = 'main';

  constructor(
    container: HTMLElement,
    getCurrentIndex: () => number,
    onAction: (action: Action) => void,
    getAudioTracks: () => AudioTrackOption[],
    selectAudioTrack: (index: number) => void,
    getSubtitleTracks: () => SubtitleTrackOption[],
    selectSubtitleTrack: (index: number) => void,
    getSubtitleOffsetState: () => { available: boolean; label: string },
    openSubtitleOffset: () => void,
  ) {
    this.getCurrentIndex = getCurrentIndex;
    this.onAction = onAction;
    this.getAudioTracks = getAudioTracks;
    this.selectAudioTrack = selectAudioTrack;
    this.getSubtitleTracks = getSubtitleTracks;
    this.selectSubtitleTrack = selectSubtitleTrack;
    this.getSubtitleOffsetState = getSubtitleOffsetState;
    this.openSubtitleOffset = openSubtitleOffset;
    this.el = $('#player-menu', container);
    this.bindEvents();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(): void {
    if (this.isVisible) return;
    this.isVisible = true;
    this.mode = 'main';
    this.focusIdx = 0;
    this.render();
    if (this.el) {
      this.el.classList.remove('hidden');
      this.el.offsetHeight;
      this.el.classList.add('visible');
    }
    this.resetTimer();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    const el = this.el;
    if (el) {
      el.classList.remove('visible');
      el.addEventListener('transitionend', () => {
        if (!this.isVisible) el.classList.add('hidden');
      }, { once: true });
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    const items = this.el.querySelectorAll<HTMLElement>('.menu-item');
    const len = items.length;
    if (!len) return;

    this.resetTimer();

    if (action === 'up') {
      this.focusIdx = Math.max(0, this.focusIdx - 1);
    } else if (action === 'down') {
      this.focusIdx = Math.min(len - 1, this.focusIdx + 1);
    } else if (action === 'select') {
      const item = items[this.focusIdx];
      if (item) this.selectItem(item);
      return;
    }

    items.forEach((item, i) => {
      item.classList.toggle('focused', i === this.focusIdx);
    });
    this.scrollFocusedIntoView();
  }

  // Keep the focused row visible when D-pad navigation moves past the scroll
  // viewport of a long track list. (Magic-Remote wheel scrolling is native — the
  // wheel handler lets `.menu-items` scroll itself; see key-handler.ts.)
  private scrollFocusedIntoView(): void {
    this.el?.querySelector<HTMLElement>('.menu-item.focused')?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Route a selected/clicked row by its data-menu-action. */
  private selectItem(item: HTMLElement): void {
    const action = item.dataset.menuAction;
    if (action === OPEN_AUDIO) {
      this.openAudio();
    } else if (action === OPEN_SUBS) {
      this.openSubtitles();
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
    } else if (action === OPEN_OFFSET) {
      this.hide();
      this.openSubtitleOffset();
    } else if (action) {
      this.hide();
      this.onAction(action as Action);
    }
  }

  private openAudio(): void {
    this.mode = 'audio';
    const tracks = this.getAudioTracks();
    const active = tracks.findIndex(t => t.active);
    this.focusIdx = active >= 0 ? active + 1 : 0; // +1 for the Back row
    this.render();
    this.resetTimer();
  }

  private openSubtitles(): void {
    this.mode = 'subtitles';
    const tracks = this.getSubtitleTracks();
    const active = tracks.findIndex(t => t.active);
    // Rows: Back (0), Off (1), then tracks. Focus the active track, else Off.
    this.focusIdx = active >= 0 ? active + 2 : 1;
    this.render();
    this.resetTimer();
  }

  private openMain(): void {
    this.mode = 'main';
    this.focusIdx = 0;
    this.render();
    this.resetTimer();
  }

  private render(): void {
    if (this.mode === 'audio') this.renderAudio();
    else if (this.mode === 'subtitles') this.renderSubtitles();
    else this.renderMain();
    this.scrollFocusedIntoView();
  }

  private renderMain(): void {
    const el = this.el;
    if (!el) return;

    const ch = PlaylistService.getByIndex(this.getCurrentIndex());
    const chName = ch?.name || '';
    // VOD (no channel, index < 0) swaps in its own action set for the channel one.
    const rows = this.getCurrentIndex() < 0 ? VOD_MENU_ITEMS : MENU_ITEMS;
    const tracks = this.getAudioTracks();
    const activeTrack = tracks.find(t => t.active);
    const subtitles = this.getSubtitleTracks();
    const activeSub = subtitles.find(t => t.active);

    const audioShown = tracks.length >= 2;
    const audioRowIdx = rows.length;
    const subsRowIdx = rows.length + (audioShown ? 1 : 0);

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.menu')}</h2>
        ${chName ? html`<div class="menu-subtitle">${t('player.playing', { name: chName })}</div>` : ''}
      </div>
      <div class="menu-items">
        ${rows.map((item, i) => html`
          <div class="menu-item ${i === this.focusIdx ? 'focused' : ''}"
               data-key="${item.action}"
               data-focusable data-menu-action="${item.action}">
            <span class="menu-dot ${item.color}"></span> ${t(item.labelKey)}
          </div>
        `)}
        ${audioShown ? html`
          <div class="menu-item ${audioRowIdx === this.focusIdx ? 'focused' : ''}"
               data-focusable data-menu-action="${OPEN_AUDIO}">
            <span class="menu-icon audio">♫</span> ${t('player.audioTrack')}
            <span class="menu-item-value">${activeTrack?.label || ''}</span>
          </div>
        ` : ''}
        ${subtitles.length >= 1 ? html`
          <div class="menu-item ${subsRowIdx === this.focusIdx ? 'focused' : ''}"
               data-focusable data-menu-action="${OPEN_SUBS}">
            <span class="menu-icon subtitle">${raw(SUBTITLE_ICON)}</span> ${t('player.subtitles')}
            <span class="menu-item-value">${activeSub?.label || t('common.off')}</span>
          </div>
        ` : ''}
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
        <div class="menu-item ${this.focusIdx === 0 ? 'focused' : ''}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span> ${t('common.back')}
        </div>
        ${tracks.map((t, i) => html`
          <div class="menu-item ${this.focusIdx === i + 1 ? 'focused' : ''} ${t.available === false ? 'unavailable' : ''}"
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
        <div class="menu-item ${this.focusIdx === 0 ? 'focused' : ''}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span> ${t('common.back')}
        </div>
        <div class="menu-item ${this.focusIdx === 1 ? 'focused' : ''}"
             data-focusable data-menu-action="${PICK_SUB}" data-track-index="-1">
          <span class="menu-check">${anyActive ? '' : '✓'}</span>
          <span class="menu-track-label">${t('common.off')}</span>
        </div>
        ${tracks.map((t, i) => html`
          <div class="menu-item ${this.focusIdx === i + 2 ? 'focused' : ''} ${t.available === false ? 'unavailable' : ''}"
               data-focusable data-menu-action="${PICK_SUB}" data-track-index="${t.index}">
            <span class="menu-check">${t.active ? '✓' : ''}</span>
            <span class="menu-track-label">${t.label}</span>
          </div>
        `)}
        ${(() => {
          const st = this.getSubtitleOffsetState();
          return st.available ? html`
            <div class="menu-item ${this.focusIdx === tracks.length + 2 ? 'focused' : ''}"
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
    el.addEventListener('mouseover', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if (btn) {
        const items = el.querySelectorAll<HTMLElement>('.menu-item');
        items.forEach((item, i) => {
          if (item === btn) this.focusIdx = i;
          item.classList.toggle('focused', item === btn);
        });
        this.resetTimer();
      }
    });
  }
}
