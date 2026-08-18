import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import type { Action, NumberEvent } from '../types';

type ActionHandler = (action: Action, event?: NumberEvent) => void;

const log = createLogger('Key');
const K = CONFIG.KEYS;

const ACTION_MAP: Record<number, Action> = {
  [K.UP]: 'up',
  [K.DOWN]: 'down',
  [K.LEFT]: 'left',
  [K.RIGHT]: 'right',
  [K.ENTER]: 'select',
  [K.BACK]: 'back',
  [K.ESC]: 'back', // Escape key for desktop
  [K.RED]: 'red',
  [K.GREEN]: 'green',
  [K.YELLOW]: 'yellow',
  [K.BLUE]: 'blue',
  [K.CH_UP]: 'channel_up',
  [K.CH_DOWN]: 'channel_down',
  [K.PLAY]: 'play',
  [K.PAUSE]: 'pause',
  [K.STOP]: 'stop',
  [K.REWIND]: 'rewind',
  [K.FORWARD]: 'fast_forward',
};

// Remote-control keys that must still reach the app even when a text input has
// focus. Text-editing keys are deliberately excluded so the input keeps them:
// digits are typed into the query, Left/Right/Up move the caret, and the
// channel-list's own listener handles Enter/ArrowDown/Escape to leave the box.
// Without this, pressing these dedicated buttons while the search box is focused
// (its blinking caret) did nothing — Back couldn't exit, Red/Blue couldn't open
// EPG/Settings, etc.
const INPUT_PASSTHROUGH_KEYS = new Set<number>([
  K.BACK, K.RED, K.GREEN, K.YELLOW, K.BLUE,
  K.CH_UP, K.CH_DOWN, K.PLAY, K.PAUSE, K.STOP, K.REWIND, K.FORWARD,
]);

let activeHandler: ActionHandler | null = null;
let numberBuffer = '';
let numberTimer: ReturnType<typeof setTimeout> | null = null;
let channelCount: (() => number) | null = null;
let wheelWarmedUp = true;
let wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;

function hasScrollableAncestor(el: HTMLElement | null): boolean {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

// A number can never exceed the highest channel there is, so 350 channels cap
// entry at three digits — and the buffer can no longer grow without bound.
function maxNumberDigits(): number {
  const count = channelCount?.() ?? 0;
  if (count <= 0) return CONFIG.PLAYER.CHANNEL_NUMBER_MAX_DIGITS;
  return String(count).length;
}

function flushNumber(): void {
  if (numberTimer) clearTimeout(numberTimer);
  numberTimer = null;
  if (!numberBuffer) return;
  const num = parseInt(numberBuffer, 10);
  numberBuffer = '';
  log.debug('Number entry', 'event=key.number', `number=${num}`,
    `handler=${activeHandler ? 'set' : 'none'}`);
  if (activeHandler) activeHandler('number', { number: num });
}

// Any other key abandons a half-typed number. Without this the digits merge
// across the interruption: Up pressed between "2" and "1" still tuned 21.
function cancelNumber(): void {
  if (!numberBuffer) return;
  if (numberTimer) clearTimeout(numberTimer);
  numberTimer = null;
  const length = numberBuffer.length;
  numberBuffer = '';
  log.debug('Number entry cancelled', 'event=key.number.cancelled', `digits=${length}`);
  if (activeHandler) activeHandler('number_cancel');
}

function handleNumber(digit: number): void {
  // At the cap the number still waits out the debounce: tuning on the keypress
  // itself gave no chance to read back what was typed.
  if (numberBuffer.length >= maxNumberDigits()) {
    log.debug('Number entry at cap', 'event=key.number.capped',
      `digits=${numberBuffer.length}`);
    return;
  }
  numberBuffer += digit;
  if (numberTimer) clearTimeout(numberTimer);
  numberTimer = null;
  // Echo each digit immediately: the flush is a second away, and without this
  // the TV shows nothing at all while a multi-digit number is being typed.
  const digits = numberBuffer;
  if (activeHandler) activeHandler('number_input', { number: parseInt(digits, 10), digits });
  numberTimer = setTimeout(flushNumber, CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
}

export const KeyHandler = {
  init(): void {
    // Capture phase, and logging only: components with their own keydown
    // listeners stop propagation, so a bubble-phase log never sees those
    // presses — and a button that "does nothing" must still leave a trace.
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      const code = e.keyCode;
      const tag = (e.target as HTMLElement).tagName;
      const inText = tag === 'INPUT' || tag === 'TEXTAREA';
      const mapped = ACTION_MAP[code];
      const isDigit = code >= K.NUM_0 && code <= K.NUM_9;
      const remoteButton = mapped !== undefined || INPUT_PASSTHROUGH_KEYS.has(code);
      // Character keys typed into a text field keep their code out of the log:
      // it would spell out the search query into a shareable diag report.
      const codeField = inText && !remoteButton ? 'code=hidden' : `code=${code}`;
      log.debug('Key down', 'event=key.down', codeField,
        `action=${mapped ?? (isDigit ? 'number' : 'unmapped')}`,
        `target=${inText ? 'text_input' : 'app'}`);
    }, true);

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Let input fields handle their own text-editing keys, but dedicated
      // remote-control buttons (Back, colored, channel, media) must still reach
      // the app — see INPUT_PASSTHROUGH_KEYS.
      const tag = (e.target as HTMLElement).tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && !INPUT_PASSTHROUGH_KEYS.has(e.keyCode)) {
        // No code here on purpose: it would spell out what is being typed.
        log.debug('Key ignored', 'event=key.ignored', 'reason=text_input');
        return;
      }

      const keyCode = e.keyCode;

      if (keyCode >= K.NUM_0 && keyCode <= K.NUM_9) {
        e.preventDefault();
        handleNumber(keyCode - K.NUM_0);
        return;
      }

      const action = ACTION_MAP[keyCode];
      cancelNumber();
      if (action) {
        e.preventDefault();
        if (activeHandler) activeHandler(action);
      }
    });

    // Mouse support for desktop preview. Skip re-dispatching when the focusable hasn't changed.
    let lastHover: HTMLElement | null = null;
    const setHoverTarget = (target: HTMLElement | null): void => {
      if (target === lastHover) return;
      lastHover?.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      lastHover = target;
      target?.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    };
    document.addEventListener('mouseover', (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      setHoverTarget(target);
    });
    // Cursor left the window: forget the last hover so returning to the same
    // element re-dispatches nav:hover (re-showing a cleared highlight).
    document.documentElement.addEventListener('mouseleave', () => setHoverTarget(null));

    // Magic Remote scroll wheel / desktop mouse wheel
    // Let any scrollable ancestor scroll natively — otherwise mouseover-driven
    // focus would snap back to the cursor as content scrolls underneath it.
    // First scroll after pointer was hidden just reactivates the cursor.
    document.addEventListener('wheel', (e: WheelEvent) => {
      if (hasScrollableAncestor(e.target as HTMLElement)) return;
      e.preventDefault();

      // Reset idle timer — if no scroll for 5s, next scroll is swallowed
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => { wheelWarmedUp = false; }, 5000);

      if (!wheelWarmedUp) {
        wheelWarmedUp = true;
        return;
      }

      if (!activeHandler) return;
      if (e.deltaY < 0) activeHandler('channel_up');
      else if (e.deltaY > 0) activeHandler('channel_down');
    }, { passive: false });

    document.addEventListener('click', (e: MouseEvent) => {
      // Components that self-activate on click (their own click handler is the
      // "OK" action) mark their root subtree with `data-self-activate` so this
      // global handler skips them — otherwise the deferred select below fires a
      // second time (e.g. on the view we just navigated to). This replaces an
      // older hardcoded class list; new self-handling components opt in by adding
      // the attribute, with no edit here.
      //
      // A detached target means a handler that ran earlier in this same click
      // already consumed it by removing the element (e.g. settings "Remove"
      // deletes its row) — skip it so we don't fire a spurious select.
      const t = e.target as HTMLElement;
      if (!t.isConnected || t.closest('[data-self-activate]')) return;
      const target = t.closest<HTMLElement>('[data-focusable]');
      if (target && activeHandler) {
        target.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
        // Small delay to let focus settle before firing select
        setTimeout(() => activeHandler!('select'), 0);
      }
    });
  },

  setHandler(handler: ActionHandler): void {
    activeHandler = handler;
  },

  // Direct entry is capped at the width of the highest channel number, which
  // changes with the playlist — read it live rather than pushing it on reload.
  setChannelCount(count: () => number): void {
    channelCount = count;
  },
};
