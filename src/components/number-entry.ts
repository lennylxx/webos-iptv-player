import { CONFIG } from '../config';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';

// Body-mounted like the toast, so it survives view switches (the buffer does too).
let entryEl: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;

export function showNumberEntry(digits: string): void {
  if (!digits) return;
  if (!entryEl) {
    entryEl = document.createElement('div');
    entryEl.className = 'number-entry';
    document.body.appendChild(entryEl);
  }
  if (hideTimer) clearTimeout(hideTimer);
  sequence++;

  // Keyed by position, so only the digit just typed mounts fresh and pops in.
  const tiles = digits.split('').map((digit, index) =>
    html`<span class="number-entry-digit" data-key="d${String(index)}">${digit}</span>`);
  // A new key per keypress remounts the bar, restarting the debounce it tracks.
  const duration = `animation-duration: ${String(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT)}ms`;
  morph(entryEl, html`<span class="number-entry-digits">${tiles}</span>
    <span class="number-entry-countdown" data-key="c${String(sequence)}">
      <i class="number-entry-countdown-fill" style="${duration}"></i>
    </span>`);

  entryEl.classList.add('visible');
  // The tune that hides this never arrives if a modal swallowed the flush.
  hideTimer = setTimeout(() => {
    entryEl?.classList.remove('visible');
  }, CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT + 500);
}

export function hideNumberEntry(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  entryEl?.classList.remove('visible');
}
