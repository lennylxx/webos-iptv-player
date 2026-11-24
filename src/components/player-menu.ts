import type { Action, AudioTrackOption, Channel, SubtitleTrackOption, TranslationLanguageOption } from '../types';
import { CONFIG } from '../config';
import { $, html, inShownView, onceTransitionEnd, raw, withInstantScroll, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { AI_ICON, ASPECT_ICON, AUDIO_ICON, QUALITY_ICON, SPEED_ICON, SUBTITLE_ICON } from './icons';
import { t } from '../i18n';
import {
  PLAYBACK_RATES,
  type PlaybackRate,
  type PlaybackRateState,
} from '../services/playback-rate';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { ASPECT_RATIOS, type AspectRatio } from '../services/aspect-ratio';
import { tierRate, type QualityOverride, type QualityTier, type VideoQuality } from '../utils/video-quality';
import { qualityTierLabel, videoQualityLabel } from './video-quality-labels';

export interface QualityMenuState {
  /** The Video quality setting a stream without its own pick follows. */
  setting: VideoQuality;
  override: QualityOverride | null;
  /** Lowest first. */
  tiers: QualityTier[];
  /** The tier the override pins, or -1. */
  pinned: number;
}

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
const TRANSLATE_SUBS = '__subs_translate__';
const OPEN_TRANSLATE = '__subs_translate_open__';
const PICK_TRANSLATE = '__subs_translate_pick__';
const OPEN_SPEED = '__speed_open__';
const PICK_SPEED = '__speed_rate__';
const OPEN_ASPECT = '__aspect_open__';
const PICK_ASPECT = '__aspect_ratio__';
const OPEN_QUALITY = '__quality_open__';
const PICK_QUALITY = '__quality_pick__';

function qualityValue(state: QualityMenuState): string {
  if (state.override === 'auto') return t('player.qualityAuto');
  const pinned = state.tiers[state.pinned];
  return pinned ? qualityTierLabel(pinned) : videoQualityLabel(state.setting);
}

// "{name} · ✦ AI · EN": the name gives way to the untranslated note, which
// always shows in full.
function aiTranslationLabel(name: string, code: string): Safe {
  return html`<span class="menu-track-label menu-track-ai">
    <span class="menu-track-name">${name}</span> <span class="menu-track-note">· <span class="ai-icon">${
      raw(AI_ICON)}</span>AI · ${code}</span></span>`;
}

function aspectLabel(mode: AspectRatio): string {
  if (mode === 'auto') return t('player.aspectAuto');
  if (mode === 'zoom') return t('player.aspectZoom');
  return mode === '16x9' ? '16:9' : '4:3';
}

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
  private getAspectRatio: () => AspectRatio | null;
  private selectAspectRatio: (mode: AspectRatio) => void;
  private getQuality: () => QualityMenuState | null;
  private selectQuality: (pick: QualityOverride | null) => void;
  private getTranslateLabel: () => string | null;
  private translateSubtitles: (target?: string) => void;
  private isVisible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private focusIdx = 0;
  private mode: 'main' | 'audio' | 'subtitles' | 'translate' | 'speed' | 'aspect' | 'quality' = 'main';
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
    // null hides the Aspect Ratio row.
    getAspectRatio: () => AspectRatio | null = () => null,
    selectAspectRatio: (mode: AspectRatio) => void = () => {},
    // null hides the Video Quality row.
    getQuality: () => QualityMenuState | null = () => null,
    selectQuality: (pick: QualityOverride | null) => void = () => {},
    // null hides the subtitle translate row.
    getTranslateLabel: () => string | null = () => null,
    translateSubtitles: (target?: string) => void = () => {},
    private onVisibilityChange: () => void = () => {},
    // null hides the row that opens the translation language list.
    private getTranslateLanguages: () => TranslationLanguageOption[] | null = () => null,
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
    this.getAspectRatio = getAspectRatio;
    this.selectAspectRatio = selectAspectRatio;
    this.getQuality = getQuality;
    this.selectQuality = selectQuality;
    this.getTranslateLabel = getTranslateLabel;
    this.translateSubtitles = translateSubtitles;
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
    this.onVisibilityChange();
  }

  hide(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    if (this.scope) Focus.pop(this.scope);
    this.onVisibilityChange();
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
    if (this.mode === 'aspect') {
      if (this.getAspectRatio()) this.render();
      else this.openMain();
      return;
    }
    if (this.mode === 'quality' && !this.getQuality()) {
      this.openMain();
      return;
    }
    if (this.mode === 'translate' && !this.getTranslateLanguages()?.length) {
      this.openSubtitles();
      return;
    }
    if ((this.mode === 'audio' || this.mode === 'subtitles' || this.mode === 'translate' || this.mode === 'quality') && this.el) {
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
    if (this.mode === 'translate') {
      this.openSubtitles(OPEN_TRANSLATE);
      return true;
    }
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
    } else if (action === OPEN_ASPECT) {
      this.openAspect();
    } else if (action === OPEN_QUALITY) {
      this.openQuality();
    } else if (action === BACK) {
      this.handleBack();
    } else if (action === PICK_AUDIO) {
      const idx = Number(item.dataset.trackIndex);
      if (!Number.isNaN(idx)) this.selectAudioTrack(idx);
      this.openMain();
    } else if (action === PICK_SUB) {
      const idx = Number(item.dataset.trackIndex);
      if (!Number.isNaN(idx)) this.selectSubtitleTrack(idx);
      this.openMain();
    } else if (action === TRANSLATE_SUBS) {
      this.translateSubtitles();
      this.openMain();
    } else if (action === OPEN_TRANSLATE) {
      this.openTranslate();
    } else if (action === PICK_TRANSLATE) {
      const code = item.dataset.lang;
      if (code) this.translateSubtitles(code);
      this.openMain();
    } else if (action === OPEN_SEARCH) {
      this.hide();
      this.openSubtitleSearch();
    } else if (action === OPEN_OFFSET) {
      this.hide();
      this.openSubtitleOffset();
    } else if (action === PICK_ASPECT) {
      const mode = item.dataset.aspectRatio;
      if ((ASPECT_RATIOS as readonly string[]).indexOf(mode ?? '') !== -1) {
        this.selectAspectRatio(mode as AspectRatio);
      }
      this.openMain();
    } else if (action === PICK_QUALITY) {
      const state = this.getQuality();
      const pick = item.dataset.quality;
      const tier = state?.tiers[Number(item.dataset.tierIndex)];
      if (pick === 'default') this.selectQuality(null);
      else if (pick === 'auto') this.selectQuality('auto');
      else if (tier) this.selectQuality({ height: tier.height, bandwidth: tier.bandwidth });
      this.openMain();
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

  // Focuses the row keyed `focusKey`, else the active track, else Off.
  private openSubtitles(focusKey?: string): void {
    this.mode = 'subtitles';
    const tracks = this.getSubtitleTracks();
    const active = tracks.findIndex(t => t.active);
    // Rows: Back (0), Off (1), then tracks.
    this.render();
    const keyed = focusKey ? this.rows().findIndex(row => row.dataset.key === focusKey) : -1;
    this.openAt(keyed >= 0 ? keyed : active >= 0 ? active + 2 : 1);
    this.resetTimer();
  }

  private openTranslate(): void {
    const languages = this.getTranslateLanguages();
    if (!languages?.length) return;
    this.mode = 'translate';
    const active = languages.findIndex(language => language.active);
    this.render();
    this.openAt(active >= 0 ? active + 1 : 1); // +1 for the Back row
    this.resetTimer();
  }

  private openSpeed(): void {
    this.mode = 'speed';
    const active = PLAYBACK_RATES.indexOf(this.getPlaybackRateState().rate);
    this.render();
    this.openAt(active >= 0 ? active + 1 : 1);
    this.resetTimer();
  }

  private openAspect(): void {
    this.mode = 'aspect';
    const current = this.getAspectRatio();
    const active = current ? ASPECT_RATIOS.indexOf(current) : -1;
    this.render();
    this.openAt(active >= 0 ? active + 1 : 1);
    this.resetTimer();
  }

  private openQuality(): void {
    const state = this.getQuality();
    if (!state) return;
    this.mode = 'quality';
    this.render();
    const key = this.qualityActiveKey(state);
    const idx = this.rows().findIndex(row => row.dataset.key === key);
    this.openAt(idx >= 0 ? idx : 1);
    this.resetTimer();
  }

  private qualityActiveKey(state: QualityMenuState): string {
    // With the setting on Auto, an Auto pick is the Default row.
    if (state.override === 'auto') return state.setting === 'auto' ? 'quality:default' : 'quality:auto';
    const pinned = state.tiers[state.pinned];
    return pinned ? `quality:${tierRate(pinned)}` : 'quality:default';
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
    else if (this.mode === 'translate') this.renderTranslate();
    else if (this.mode === 'speed') this.renderSpeed();
    else if (this.mode === 'aspect') this.renderAspect();
    else if (this.mode === 'quality') this.renderQuality();
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
    const aspect = this.getAspectRatio();
    const quality = this.getQuality();

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
        ${quality ? html`
          <div class="menu-item"
               data-key="${OPEN_QUALITY}"
               data-focusable data-menu-action="${OPEN_QUALITY}">
            <span class="menu-icon quality">${raw(QUALITY_ICON)}</span>
            <span class="menu-item-label">${t('player.videoQuality')}</span>
            <span class="menu-item-value">${qualityValue(quality)}</span>
          </div>
        ` : ''}
        ${aspect ? html`
          <div class="menu-item"
               data-key="${OPEN_ASPECT}"
               data-focusable data-menu-action="${OPEN_ASPECT}">
            <span class="menu-icon aspect">${raw(ASPECT_ICON)}</span>
            <span class="menu-item-label">${t('player.aspectRatio')}</span>
            <span class="menu-item-value">${aspectLabel(aspect)}</span>
          </div>
        ` : ''}
        ${speed.available ? html`
          <div class="menu-item"
               data-key="${OPEN_SPEED}"
               data-focusable data-menu-action="${OPEN_SPEED}">
            <span class="menu-icon speed">${raw(SPEED_ICON)}</span>
            <span class="menu-item-label">${t('player.playbackSpeed')}</span>
            <span class="menu-item-value">${speed.rate}x</span>
          </div>
        ` : ''}
      </div>
    `);
  }

  private renderAspect(): void {
    const el = this.el;
    if (!el) return;
    const active = this.getAspectRatio();

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.aspectRatio')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        ${ASPECT_RATIOS.map((mode) => html`
          <div class="menu-item" data-key="aspect:${mode}"
               data-focusable data-menu-action="${PICK_ASPECT}"
               data-aspect-ratio="${mode}">
            <span class="menu-check">${mode === active ? '✓' : ''}</span>
            <span class="menu-track-label">${aspectLabel(mode)}</span>
          </div>
        `)}
      </div>
    `);
  }

  private renderQuality(): void {
    const el = this.el;
    const state = this.getQuality();
    if (!el || !state) return;
    const active = this.qualityActiveKey(state);
    const check = (key: string): string => (key === active ? '✓' : '');
    const tiers = state.tiers.map((tier, index) => ({ tier, index })).reverse();

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.videoQuality')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        <div class="menu-item" data-key="quality:default"
             data-focusable data-menu-action="${PICK_QUALITY}" data-quality="default">
          <span class="menu-check">${check('quality:default')}</span>
          <span class="menu-track-label">${t('player.qualityDefault', { value: videoQualityLabel(state.setting) })}</span>
        </div>
        ${state.setting !== 'auto' ? html`
          <div class="menu-item" data-key="quality:auto"
               data-focusable data-menu-action="${PICK_QUALITY}" data-quality="auto">
            <span class="menu-check">${check('quality:auto')}</span>
            <span class="menu-track-label">${t('player.qualityAuto')}</span>
          </div>
        ` : ''}
        ${tiers.map(({ tier, index }) => html`
          <div class="menu-item" data-key="quality:${tierRate(tier)}"
               data-focusable data-menu-action="${PICK_QUALITY}" data-quality="tier"
               data-tier-index="${index}">
            <span class="menu-check">${check(`quality:${tierRate(tier)}`)}</span>
            <span class="menu-track-label">${qualityTierLabel(tier)}</span>
          </div>
        `)}
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
    const translateLabel = this.getTranslateLabel();
    const translateOther = !!this.getTranslateLanguages()?.length;

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
            ${t.aiSource !== undefined && t.aiCode ? aiTranslationLabel(t.aiSource, t.aiCode) : html`
              <span class="menu-track-label">${t.label}</span>`}
            ${t.detail ? html`<span class="menu-item-value">${t.detail}</span>` : ''}
          </div>
        `)}
        ${translateLabel ? html`
          <div class="menu-item" data-key="${TRANSLATE_SUBS}"
               data-focusable data-menu-action="${TRANSLATE_SUBS}">
            <span class="menu-check menu-check-ai"><span class="ai-icon">${raw(AI_ICON)}</span></span>
            <span class="menu-track-label">${translateLabel}</span>
          </div>
        ` : ''}
        ${translateOther ? html`
          <div class="menu-item" data-key="${OPEN_TRANSLATE}"
               data-focusable data-menu-action="${OPEN_TRANSLATE}">
            <span class="menu-check menu-check-ai"><span class="ai-icon">${raw(AI_ICON)}</span></span>
            <span class="menu-track-label">${t('player.translateToOther')}</span>
          </div>
        ` : ''}
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

  private renderTranslate(): void {
    const el = this.el;
    if (!el) return;
    const languages = this.getTranslateLanguages() ?? [];

    morph(el, html`
      <div class="menu-header">
        <h2>${t('player.translationLanguage')}</h2>
      </div>
      <div class="menu-items">
        <div class="menu-item" data-key="${BACK}"
             data-focusable data-menu-action="${BACK}">
          <span class="menu-check menu-back">‹</span>
          <span class="menu-item-label">${t('common.back')}</span>
        </div>
        ${languages.map((language) => html`
          <div class="menu-item" data-key="translate:${language.code}"
               data-focusable data-menu-action="${PICK_TRANSLATE}" data-lang="${language.code}">
            <span class="menu-check">${language.active ? '✓' : ''}</span>
            <span class="menu-track-label">${language.label}</span>
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
    el.addEventListener('nav:hover', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      const idx = btn ? this.rows().indexOf(btn) : -1;
      if (idx < 0) return;
      this.moveTo(idx, 'pointer');
      this.resetTimer();
    });
  }
}
