import type { Action, NumberEvent, ParentalAccessRequest } from '../types';
import { CONFIG } from '../config';
import { t, tp } from '../i18n';
import { html, raw } from '../utils/dom';
import { LOCK_ICON } from './icons';
import { morph } from '../utils/morph';
import { Focus, Tier, type FocusScope, type Via } from '../navigation/focus-scope';
import { ParentalControlService } from '../services/parental-control';
import { createLogger } from '../utils/logger';

const log = createLogger('ParentalPin');

type PromptMode = 'challenge' | 'verify' | 'create' | 'confirm';

export class ParentalPinPrompt {
  private el: HTMLElement;
  private mode: PromptMode = 'challenge';
  private firstPin = '';
  private error = '';
  private submitting = false;
  // Bumped on open/hide so a check still running for a closed prompt is dropped.
  private session = 0;
  // Create and confirm steps either set the first PIN or replace the current one.
  private replacing = false;
  private title = '';
  private onVerified: (() => void) | null = null;
  private onCreated: (() => void) | null = null;
  // A lockout disables the input until it ends. Like iOS, a lockout of a
  // minute or more counts down in whole minutes; a shorter one shows seconds.
  private blockedUntil = 0;
  private blockedInMinutes = false;
  private blockTimer: number | null = null;
  // Registered on the first open. Cancel wears the scope's ring; the field's
  // caret stands in for it, so the ring is concealed while the field has it.
  private scope: FocusScope | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'parental-pin-prompt hidden';
    this.el.setAttribute('data-self-activate', '');
    document.body.appendChild(this.el);
    this.bindEvents();
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  showChallenge(request: ParentalAccessRequest): void {
    this.mode = 'challenge';
    this.title = request.label
      ? t('parental.enterFor', { name: request.label })
      : t('parental.enterForLocked');
    this.onVerified = null;
    this.onCreated = null;
    this.open();
  }

  showVerify(title: string, onVerified: () => void): void {
    this.mode = 'verify';
    this.title = title;
    this.onVerified = onVerified;
    this.onCreated = null;
    this.open();
  }

  showCreate(onCreated: () => void): void {
    this.startCreate(onCreated, false);
  }

  showChange(onChanged: () => void): void {
    this.startCreate(onChanged, true);
  }

  private startCreate(onCreated: () => void, replacing: boolean): void {
    this.replacing = replacing;
    this.mode = 'create';
    this.title = this.createTitle();
    this.firstPin = '';
    this.onVerified = null;
    this.onCreated = onCreated;
    this.open();
  }

  // Relocking drops the deferred action, so a challenge left open would only
  // unlock without opening what was asked for; a create or change flow left
  // open would let whoever comes back set a PIN without the current one.
  dismiss(): void {
    if (this.visible) this.hide();
  }

  // Leaving the manager ends what it opened (create/change/verify); a challenge
  // for content played from there is kept.
  dismissManagement(): void {
    if (this.visible && this.mode !== 'challenge') this.hide();
  }

  hide(cancelPending = true): void {
    if (this.visible) {
      log.info('PIN prompt closed', 'event=parental.prompt.closed', `mode=${this.mode}`,
        `result=${cancelPending ? 'cancelled' : 'done'}`);
    }
    this.session++;
    this.stopBlock();
    this.el.classList.add('hidden');
    if (this.scope) Focus.pop(this.scope);
    this.clearInput();
    this.error = '';
    this.firstPin = '';
    this.onVerified = null;
    this.onCreated = null;
    if (cancelPending) ParentalControlService.cancelChallenge();
  }

  handleAction(action: Action, event?: NumberEvent): void {
    if (!this.visible) return;
    const active = document.activeElement as HTMLElement | null;
    // A digit pressed away from the field types into it, as on a keypad.
    if (action === 'number_input') {
      const input = this.input();
      const digit = event?.digits?.slice(-1) ?? '';
      if (!input || input.disabled || this.submitting || !digit) return;
      input.focus();
      input.value += digit;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (action === 'back') {
      this.hide();
      return;
    }
    if (action === 'up') {
      this.focusInput();
      return;
    }
    if (action === 'down') {
      this.focusCancel('key');
      return;
    }
    if (action === 'select') {
      if (active?.classList.contains('parental-pin-input')) {
        active.focus();
        active.click();
      } else if (active?.dataset.pinAction === 'cancel') this.hide();
    }
  }

  private open(): void {
    log.info('PIN prompt opened', 'event=parental.prompt.opened', `mode=${this.mode}`,
      `replacing=${String(this.replacing)}`, `wasVisible=${String(this.visible)}`);
    if (!this.scope) {
      this.scope = Focus.register({
        id: 'prompt.parental_pin',
        root: this.el,
        restrict: 'self-only',
        tier: Tier.critical,
        onAction: (action, event) => this.handleAction(action, event),
        defaultKey: () => 'cancel',
      });
    }
    this.session++;
    this.submitting = false;
    this.error = '';
    this.stopBlock();
    this.el.classList.remove('hidden');
    Focus.push(this.scope);
    this.render();
    this.clearInput();
    const blockedForMs = this.mode === 'challenge' || this.mode === 'verify'
      ? ParentalControlService.retryBlockedForMs()
      : 0;
    if (blockedForMs > 0) this.block(blockedForMs);
    else this.focusInput();
  }

  private block(ms: number): void {
    this.stopBlock();
    this.blockedUntil = Date.now() + ms;
    this.blockedInMinutes = ms >= 60_000;
    this.clearInput();
    this.updateBlock();
  }

  private updateBlock(): void {
    this.blockTimer = null;
    const remaining = this.blockedUntil - Date.now();
    if (remaining <= 0) {
      this.blockedUntil = 0;
      this.error = '';
      this.render();
      this.focusInput();
      return;
    }
    let nextUpdate = remaining;
    if (this.blockedInMinutes) {
      const minutes = Math.ceil(remaining / 60_000);
      this.error = tp('parental.retryInMinutes', minutes);
      nextUpdate = remaining - (minutes - 1) * 60_000;
    } else {
      this.error = tp('parental.retryInSeconds', Math.ceil(remaining / 1000));
    }
    this.render();
    this.focusCancel('key');
    this.blockTimer = window.setTimeout(() => this.updateBlock(), nextUpdate);
  }

  private stopBlock(): void {
    if (this.blockTimer !== null) window.clearTimeout(this.blockTimer);
    this.blockTimer = null;
    this.blockedUntil = 0;
  }

  private cancelButton(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>('[data-pin-action="cancel"]');
  }

  // A field that already had the caret fires no focusin to conceal the ring.
  private focusInput(): void {
    const input = this.input();
    input?.focus();
    if (input && document.activeElement === input) this.scope?.conceal();
  }

  private focusCancel(via: Via): void {
    this.cancelButton()?.focus();
    this.scope?.focus('cancel', via);
    Focus.flush();
  }

  private input(): HTMLInputElement | null {
    return this.el.querySelector<HTMLInputElement>('.parental-pin-input');
  }

  private clearInput(): void {
    const input = this.input();
    if (input) {
      input.value = '';
      this.updatePinSlots(0);
    }
  }

  private render(): void {
    morph(this.el, html`
      <div class="parental-pin-dialog">
        <div class="parental-pin-lock" aria-hidden="true">${raw(LOCK_ICON)}</div>
        <h2>${this.title}</h2>
        <p>${this.mode === 'confirm'
          ? t('parental.confirmPinHint')
          : t('parental.pinHint', {
            length: CONFIG.PARENTAL_PIN_LENGTH,
          })}</p>
        ${this.mode === 'create'
          ? html`<p class="parental-pin-warning">${t('parental.forgotPinHint', { resetApp: t('settings.resetApp') })}</p>`
          : ''}
        <div class="parental-pin-field">
          <input class="parental-pin-input" type="number" inputmode="numeric"
                 ${this.blockedUntil ? raw('disabled') : ''}
                 pattern="[0-9]*" min="0" max="9999" step="1"
                 autocomplete="off" aria-label="${t('parental.pin')}">
          <div class="parental-pin-slots" aria-hidden="true">
            ${Array.from({ length: CONFIG.PARENTAL_PIN_LENGTH }, (_, index) =>
              html`<span data-pin-digit="${index}"></span>`)}
          </div>
        </div>
        <div class="parental-pin-error" aria-live="polite">${this.error}</div>
        <div class="parental-pin-actions">
          <button data-focusable data-key="cancel" data-pin-action="cancel">${t('common.cancel')}</button>
        </div>
      </div>
    `);
  }

  // The last digit submits; `submitting` drops keys typed while a check runs.
  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    const session = this.session;
    try {
      await this.submitPin(session);
    } catch (err) {
      log.error('PIN prompt submit failed', 'event=parental.prompt.failed', `mode=${this.mode}`, err);
      throw err;
    } finally {
      if (session === this.session) this.submitting = false;
    }
  }

  private async submitPin(session: number): Promise<void> {
    const pin = this.input()?.value ?? '';
    if (!new RegExp(`^\\d{${CONFIG.PARENTAL_PIN_LENGTH}}$`).test(pin)) {
      this.showError(t('parental.pinHint', {
        length: CONFIG.PARENTAL_PIN_LENGTH,
      }));
      return;
    }

    if (this.mode === 'create') {
      this.firstPin = pin;
      this.mode = 'confirm';
      this.title = t(this.replacing ? 'parental.confirmNewPin' : 'parental.confirmPin');
      this.error = '';
      this.clearInput();
      this.render();
      this.focusInput();
      return;
    }

    if (this.mode === 'confirm') {
      if (pin !== this.firstPin) {
        log.info('New PIN confirmation mismatch', 'event=parental.prompt.mismatch');
        this.firstPin = '';
        this.mode = 'create';
        this.title = this.createTitle();
        this.showError(t('parental.pinMismatch'));
        return;
      }
      if (this.replacing) await ParentalControlService.replacePin(pin);
      else await ParentalControlService.createPin(pin);
      if (session !== this.session) return;
      const onCreated = this.onCreated;
      this.hide(false);
      onCreated?.();
      return;
    }

    const result = this.mode === 'challenge'
      ? await ParentalControlService.submitPin(pin)
      : await ParentalControlService.verifyManagementPin(pin);
    if (session !== this.session) return;
    if (!result.accepted) {
      if (result.blockedForMs > 0) this.block(result.blockedForMs);
      else this.showError(t('parental.incorrectPin'));
      return;
    }
    const onVerified = this.onVerified;
    this.hide(false);
    onVerified?.();
  }

  private createTitle(): string {
    return t(this.replacing ? 'parental.newPin' : 'parental.createPin');
  }

  private showError(message: string): void {
    this.error = message;
    this.clearInput();
    this.render();
    this.focusInput();
  }

  private bindEvents(): void {
    this.el.addEventListener('input', (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (!input.classList.contains('parental-pin-input')) return;
      input.value = input.value.replace(/\D/g, '')
        .slice(0, CONFIG.PARENTAL_PIN_LENGTH);
      this.updatePinSlots(input.value.length);
      if (this.error) {
        this.error = '';
        const error = this.el.querySelector<HTMLElement>('.parental-pin-error');
        if (error) error.textContent = '';
      }
      if (input.value.length === CONFIG.PARENTAL_PIN_LENGTH) void this.submit();
    });
    this.el.addEventListener('focusin', (event: FocusEvent) => {
      if ((event.target as HTMLElement).classList.contains('parental-pin-input')) {
        this.updatePinSlots(this.input()?.value.length ?? 0);
        this.scope?.conceal();
      }
    });
    this.el.addEventListener('focusout', (event: FocusEvent) => {
      if ((event.target as HTMLElement).classList.contains('parental-pin-input')) {
        this.updatePinSlots(this.input()?.value.length ?? 0);
      }
    });
    this.el.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!(event.target as HTMLElement).classList.contains('parental-pin-input')) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.submit();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.focusCancel('key');
      } else if (event.key === 'ArrowUp') {
        // A number field would otherwise step its value and enter a digit.
        event.preventDefault();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    });
    this.el.addEventListener('nav:hover', (event: Event) => {
      if ((event.target as HTMLElement).closest('[data-pin-action="cancel"]')) this.focusCancel('pointer');
    });
    this.el.addEventListener('click', (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-pin-action]');
      if (button?.dataset.pinAction === 'cancel') this.hide();
    });
  }

  private updatePinSlots(length: number): void {
    const slots = this.el.querySelectorAll<HTMLElement>('[data-pin-digit]');
    const activeIndex = Math.min(length, slots.length - 1);
    const focused = document.activeElement === this.input();
    for (let i = 0; i < slots.length; i++) {
      slots[i].classList.toggle('filled', i < length);
      slots[i].classList.toggle('active', focused && i === activeIndex);
    }
  }
}
