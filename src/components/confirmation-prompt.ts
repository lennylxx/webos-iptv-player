import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';

interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  // Off for a confirm that destroys nothing.
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export class ConfirmationPrompt {
  private el: HTMLElement | null = null;
  private options: ConfirmationOptions | null = null;
  private focus: 'confirm' | 'cancel' = 'cancel';
  private scope: FocusScope | null = null;

  // `id` names the focus scope, registered on the first show.
  constructor(private readonly id: string) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: ConfirmationOptions): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => this.focus,
      });
    }
    this.options = options;
    // A destructive action defaults to Cancel; anything else to the action.
    this.focus = options.danger === false ? 'confirm' : 'cancel';
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'confirmation-prompt';
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    // Last in <body>, so it paints above a prompt of its tier shown before it.
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    Focus.push(this.scope);
    this.moveTo(this.focus, 'key');
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.options = null;
    if (this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left':
        this.moveTo('confirm', 'key');
        break;
      case 'right':
        this.moveTo('cancel', 'key');
        break;
      case 'select':
        this.focus === 'confirm' ? this.confirm() : this.cancel();
        break;
      case 'back':
        this.cancel();
        break;
    }
  }

  private moveTo(focus: 'confirm' | 'cancel', via: Via): void {
    this.focus = focus;
    this.scope?.focus(focus, via);
    Focus.flush();
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
          <button class="confirmation-btn ${this.options.danger === false ? '' : 'danger'}" data-focusable
                  data-key="confirm" data-confirm-action="confirm">${this.options.confirmLabel}</button>
          <button class="confirmation-btn" data-focusable
                  data-key="cancel" data-confirm-action="cancel">${this.options.cancelLabel}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('nav:hover', (event: Event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm-action]');
      if (!button) return;
      this.moveTo(button.dataset.confirmAction === 'confirm' ? 'confirm' : 'cancel', 'pointer');
    });

    this.el!.addEventListener('click', (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-confirm-action]');
      if (!button) return;
      button.dataset.confirmAction === 'confirm' ? this.confirm() : this.cancel();
    });
  }
}
