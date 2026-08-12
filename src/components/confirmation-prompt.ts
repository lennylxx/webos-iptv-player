import type { Action } from '../types';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';

interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export class ConfirmationPrompt {
  private el: HTMLElement | null = null;
  private options: ConfirmationOptions | null = null;
  private focus: 'confirm' | 'cancel' = 'cancel';

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: ConfirmationOptions): void {
    this.options = options;
    this.focus = 'cancel';
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'confirmation-prompt';
      this.el.setAttribute('data-self-activate', '');
      document.body.appendChild(this.el);
      this.bindEvents();
    }
    this.el.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.options = null;
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left':
        this.focus = 'confirm';
        this.render();
        break;
      case 'right':
        this.focus = 'cancel';
        this.render();
        break;
      case 'select':
        this.focus === 'confirm' ? this.confirm() : this.cancel();
        break;
      case 'back':
        this.cancel();
        break;
    }
  }

  private confirm(): void {
    const options = this.options;
    this.hide();
    options?.onConfirm();
  }

  private cancel(): void {
    const options = this.options;
    this.hide();
    options?.onCancel();
  }

  private render(): void {
    if (!this.el || !this.options) return;
    morph(this.el, html`
      <div class="confirmation-dialog">
        <h2 class="confirmation-title">${this.options.title}</h2>
        <p class="confirmation-message">${this.options.message}</p>
        <div class="confirmation-buttons">
          <button class="confirmation-btn danger ${this.focus === 'confirm' ? 'focused' : ''}"
                  data-key="confirm" data-confirm-action="confirm">${this.options.confirmLabel}</button>
          <button class="confirmation-btn ${this.focus === 'cancel' ? 'focused' : ''}"
                  data-key="cancel" data-confirm-action="cancel">${this.options.cancelLabel}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('mouseover', (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm-action]');
      if (!button) return;
      const focus = button.dataset.confirmAction === 'confirm' ? 'confirm' : 'cancel';
      if (focus === this.focus) return;
      this.focus = focus;
      this.render();
    });

    this.el!.addEventListener('click', (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm-action]');
      if (!button) return;
      button.dataset.confirmAction === 'confirm' ? this.confirm() : this.cancel();
    });
  }
}
