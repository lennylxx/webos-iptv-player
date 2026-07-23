import type { Action } from '../types';
import { html, show, hide } from '../utils/dom';
import { morph } from '../utils/morph';
import { CONFIG } from '../config';
import { clampSubtitleOffset, formatSubtitleOffset } from '../utils/subtitle-tracks';
import { t } from '../i18n';

/**
 * A small modal adjuster shown over the player for nudging the subtitle offset.
 * Left/Right change the value by CONFIG.PLAYER.SUBTITLE_OFFSET_STEP and apply it live
 * via `onChange`; OK/select resets to 0; Back closes. The card is marked
 * `data-self-activate` so the global click handler skips it (Magic-Remote OK is a
 * click); a click on the Reset control resets.
 */
export class SubtitleOffsetOverlay {
  private el: HTMLElement;
  private onChange: (seconds: number) => void;
  private onClose: () => void;
  private seconds = 0;
  private isVisible = false;

  constructor(container: HTMLElement, onChange: (seconds: number) => void, onClose: () => void = () => { /* no-op */ }) {
    this.el = container;
    this.onChange = onChange;
    this.onClose = onClose;
    this.el.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-offset-reset]')) this.reset();
    });
  }

  get visible(): boolean {
    return this.isVisible;
  }

  open(seconds: number): void {
    this.seconds = clampSubtitleOffset(seconds);
    this.isVisible = true;
    this.render();
    show(this.el);
  }

  close(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    hide(this.el);
    this.onClose();
  }

  handleAction(action: Action): void {
    if (action === 'left') this.nudge(-CONFIG.PLAYER.SUBTITLE_OFFSET_STEP);
    else if (action === 'right') this.nudge(CONFIG.PLAYER.SUBTITLE_OFFSET_STEP);
    else if (action === 'select') this.reset();
    else if (action === 'back') this.close();
  }

  private nudge(delta: number): void {
    const next = clampSubtitleOffset(this.seconds + delta);
    if (next !== this.seconds) { this.seconds = next; this.onChange(next); }
    this.render();
  }

  private reset(): void {
    if (this.seconds !== 0) { this.seconds = 0; this.onChange(0); }
    this.render();
  }

  private render(): void {
    morph(this.el, html`
      <div class="subs-offset-card" data-self-activate>
        <div class="subs-offset-title">${t('player.subtitleSync')}</div>
        <div class="subs-offset-value">${formatSubtitleOffset(this.seconds)}</div>
        <div class="subs-offset-hint">${t('subtitle.syncHint')}</div>
        <div class="subs-offset-reset" data-focusable data-offset-reset>${t('subtitle.reset')}</div>
      </div>
    `);
  }
}
