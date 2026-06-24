import type { Action, AudioTrackOption } from '../types';
import { PlaylistService } from '../services/playlist-service';
import { $, html } from '../utils/dom';
import { morph } from '../utils/morph';

const AUTO_HIDE_MS = 5000;

const MENU_ITEMS = [
  { action: 'red' as const, color: 'red', label: 'Programme Guide' },
  { action: 'green' as const, color: 'green', label: 'Toggle Favorite' },
  { action: 'yellow' as const, color: 'yellow', label: 'Channel Info' },
  { action: 'blue' as const, color: 'blue', label: 'Settings' },
];

// Sentinel data-menu-action values for the non-colour rows.
const OPEN_AUDIO = '__audio_open__';
const BACK = '__audio_back__';
const PICK_AUDIO = '__audio_track__';

/**
 * The action overlay shown on the right edge during playback. Owns its own
 * visibility, auto-hide timer and focus index. Selecting a colour item hides the
 * menu and emits the chosen action via `onAction`; the host decides how to
 * route it. When the stream has multiple audio tracks an "Audio Track" row opens
 * an in-place sub-menu for picking one. Delegated DOM listeners are bound once
 * in the constructor.
 */
export class PlayerMenu {
  private el: HTMLElement | null;
  private getCurrentIndex: () => number;
  private onAction: (action: Action) => void;
  private getAudioTracks: () => AudioTrackOption[];
  private selectAudioTrack: (index: number) => void;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusIdx = 0;
  private mode: 'main' | 'audio' = 'main';

  constructor(
    container: HTMLElement,
    getCurrentIndex: () => number,
    onAction: (action: Action) => void,
    getAudioTracks: () => AudioTrackOption[],
    selectAudioTrack: (index: number) => void,
  ) {
    this.getCurrentIndex = getCurrentIndex;
    this.onAction = onAction;
    this.getAudioTracks = getAudioTracks;
    this.selectAudioTrack = selectAudioTrack;
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

  /** Back inside the menu: leave the audio sub-menu without closing. Returns
   *  whether it was consumed (so the host knows not to hide the menu). */
  handleBack(): boolean {
    if (this.mode === 'audio') {
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
  }

  /** Route a selected/clicked row by its data-menu-action. */
  private selectItem(item: HTMLElement): void {
    const action = item.dataset.menuAction;
    if (action === OPEN_AUDIO) {
      this.openAudio();
    } else if (action === BACK) {
      this.openMain();
    } else if (action === PICK_AUDIO) {
      const idx = Number(item.dataset.trackIndex);
      if (!Number.isNaN(idx)) this.selectAudioTrack(idx);
      this.openMain();
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

  private openMain(): void {
    this.mode = 'main';
    this.focusIdx = 0;
    this.render();
    this.resetTimer();
  }

  private render(): void {
    if (this.mode === 'audio') this.renderAudio();
    else this.renderMain();
  }

  private renderMain(): void {
    const el = this.el;
    if (!el) return;

    const ch = PlaylistService.getByIndex(this.getCurrentIndex());
    const chName = ch?.name || '';
    const tracks = this.getAudioTracks();
    const activeTrack = tracks.find(t => t.active);

    morph(el, html`
      <div class="menu-header">
        <h2>Menu</h2>
        ${chName ? html`<div class="menu-subtitle">Playing: ${chName}</div>` : ''}
      </div>
      <div class="menu-items">
        ${MENU_ITEMS.map((item, i) => html`
          <div class="menu-item ${i === this.focusIdx ? 'focused' : ''}"
               data-key="${item.action}"
               data-focusable data-menu-action="${item.action}">
            <span class="menu-dot ${item.color}"></span> ${item.label}
          </div>
        `)}
        ${tracks.length >= 2 ? html`
          <div class="menu-item ${MENU_ITEMS.length === this.focusIdx ? 'focused' : ''}"
               data-focusable data-menu-action="${OPEN_AUDIO}">
            <span class="menu-icon audio">♫</span> Audio Track
            <span class="menu-item-value">${activeTrack?.label || ''}</span>
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
        <h2>Audio Track</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item ${this.focusIdx === 0 ? 'focused' : ''}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span> Back
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
