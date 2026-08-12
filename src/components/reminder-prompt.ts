import type { Action } from '../types';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';

interface PromptHandlers {
  onConfirm: () => void;
  onCancel: () => void;
}

export class ReminderPrompt {
  private el: HTMLElement | null = null;
  private handlers: PromptHandlers | null = null;
  private focus: 'ok' | 'cancel' = 'ok';
  private title = '';
  private channelName = '';

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(title: string, channelName: string, handlers: PromptHandlers): void {
    this.handlers = handlers;
    this.focus = 'ok';
    this.title = title;
    this.channelName = channelName;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'reminder-prompt';
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
      case 'left': this.focus = 'ok'; this.render(); break;
      case 'right': this.focus = 'cancel'; this.render(); break;
      case 'select': this.focus === 'ok' ? this.confirm() : this.cancel(); break;
      case 'back': this.cancel(); break;
      default: break;
    }
  }

  private confirm(): void { const h = this.handlers; this.hide(); h?.onConfirm(); }
  private cancel(): void { const h = this.handlers; this.hide(); h?.onCancel(); }

  private render(): void {
    if (!this.el) return;
    morph(this.el, html`
      <div class="reminder-dialog">
        <p class="reminder-message">${t('reminder.message', {
          channel: this.channelName,
          title: this.title,
        })}</p>
        <div class="reminder-buttons">
          <button class="reminder-btn ${this.focus === 'ok' ? 'focused' : ''}"
                  data-key="ok" data-reminder-action="ok">${t('reminder.watchNow')}</button>
          <button class="reminder-btn ${this.focus === 'cancel' ? 'focused' : ''}"
                  data-key="cancel" data-reminder-action="cancel">${t('common.cancel')}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('mouseover', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-reminder-action]');
      if (!btn) return;
      const focus = btn.dataset.reminderAction === 'ok' ? 'ok' : 'cancel';
      if (focus === this.focus) return;
      this.focus = focus;
      this.render();
    });

    // Hit-test the button under the pointer.
    this.el!.addEventListener('click', (e: MouseEvent) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const btn = hit?.closest<HTMLElement>('[data-reminder-action]');
      if (!btn) return;
      btn.dataset.reminderAction === 'ok' ? this.confirm() : this.cancel();
    });
  }
}
