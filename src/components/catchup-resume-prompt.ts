import type { Action } from '../types';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { formatPosition } from '../utils/time';

interface ResumeHandlers {
  onResume: () => void;
  onStartOver: () => void;
  onCancel: () => void;
}

export class CatchupResumePrompt {
  private el: HTMLElement | null = null;
  private handlers: ResumeHandlers | null = null;
  private focusIdx = 0;
  private title = '';
  private position = 0;

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(title: string, position: number, handlers: ResumeHandlers): void {
    this.handlers = handlers;
    this.focusIdx = 0;
    this.title = title;
    this.position = position;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'catchup-resume-prompt';
      // Self-activates on click; mark so the global click handler skips it.
      this.el.setAttribute('data-self-activate', '');
      document.body.appendChild(this.el);
      this.bindEvents();
    }
    this.el.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.handlers = null;
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left':
        if (this.focusIdx > 0) { this.focusIdx--; this.render(); }
        break;
      case 'right':
        if (this.focusIdx < 2) { this.focusIdx++; this.render(); }
        break;
      case 'select':
        this.activate(this.focusIdx);
        break;
      case 'back':
        this.doCancel();
        break;
      default:
        break;
    }
  }

  private activate(idx: number): void {
    const h = this.handlers;
    this.hide();
    if (idx === 0) h?.onResume();
    else if (idx === 1) h?.onStartOver();
    else h?.onCancel();
  }

  private doCancel(): void {
    const h = this.handlers;
    this.hide();
    h?.onCancel();
  }

  private render(): void {
    if (!this.el) return;
    morph(this.el, html`
      <div class="catchup-resume-dialog">
        <p class="catchup-resume-message">${t('prompt.resume', {
          title: this.title,
          position: formatPosition(this.position),
        })}</p>
        <div class="catchup-resume-buttons">
          <button class="catchup-resume-btn ${this.focusIdx === 0 ? 'focused' : ''}"
                  data-key="resume" data-action="resume">${t('common.resume')}</button>
          <button class="catchup-resume-btn ${this.focusIdx === 1 ? 'focused' : ''}"
                  data-key="start-over" data-action="start-over">${t('prompt.startOver')}</button>
          <button class="catchup-resume-btn ${this.focusIdx === 2 ? 'focused' : ''}"
                  data-key="cancel" data-action="cancel">${t('common.cancel')}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    // Hit-test the button under the pointer.
    this.el!.addEventListener('click', (e: MouseEvent) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const btn = hit?.closest<HTMLElement>('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'resume') this.activate(0);
      else if (action === 'start-over') this.activate(1);
      else if (action === 'cancel') this.activate(2);
    });
  }
}
