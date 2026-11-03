import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import { createLogger } from '../utils/logger';
import { Focus, type FocusScope } from './focus-scope';
import { InputMode, setCursorHidden, setInputMode } from './input-mode';
import { edgeScrollTrackAt, installEdgeScroll } from './edge-scroll';
import type { Action, NumberEvent } from '../types';

type ActionHandler = (action: Action, event?: NumberEvent) => void;

const log = createLogger('Key');
const K = CONFIG.KEYS;
const WHEEL_SCROLL_WINDOW_MS = 1000;
const HOVER_SYNC_DELAY_MS = 60;

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
let dispatchingWheel = false;

function hasScrollableAncestor(el: Element | null): boolean {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
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
  numberTimer = setTimeout(flushNumber, StorageService.getNumberEntryOsdTimeoutMs());
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

    // `:hover` outlives a switch to the D-pad while the pointer sits still, so
    // CSS scopes pointer-hover looks to `html:not(.keyboard-nav)`. Compare
    // coordinates: Chromium fires a synthetic mousemove when content moves
    // under a resting cursor, and the first one only seeds the position.
    let pointerX: number | null = null;
    let pointerY: number | null = null;
    let edgeScrollTrack: HTMLElement | null = null;
    let edgeScrollOwner: FocusScope | null = null;
    let edgeScrollActive = false;

    // Mouse support for desktop preview. Skip re-dispatching when the focusable hasn't changed.
    let lastHover: HTMLElement | null = null;
    let suppressedHovers = 0;
    // A key or a wheel step moves focus without the pointer, so the hover it
    // left behind is stale: the next pointer use re-hovers even the same element.
    let hoverStale = false;
    const setHoverTarget = (target: HTMLElement | null): void => {
      if (target === lastHover && !(hoverStale && target)) return;
      if (target !== lastHover) {
        lastHover?.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
        lastHover = target;
      }
      if (!target) return;
      hoverStale = false;
      target.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    };
    // `data-hover-target`: an item a view lights on hover by itself (the
    // guide's programmes), so it gets no click-to-select from here.
    const closestFocusable = (el: unknown): HTMLElement | null => el instanceof Element
      ? el.closest<HTMLElement>('[data-focusable], [data-hover-target]') : null;
    const focusableAt = (e: MouseEvent): HTMLElement | null => closestFocusable(e.target);
    const settleEdgeFocus = (): void => {
      const track = edgeScrollTrack;
      const owner = edgeScrollOwner;
      edgeScrollTrack = null;
      edgeScrollOwner = null;
      edgeScrollActive = false;
      const point = Focus.pointerPosition();
      const root = owner?.root();
      if (InputMode.current !== 'pointer' || !track || !point
          || !root?.contains(track) || Focus.owner() !== owner) return;
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || edgeScrollTrackAt(root, point.x, point.y) !== track) return;
      let target = closestFocusable(hit);
      if (!target || !track.contains(target)) {
        const box = track.getBoundingClientRect();
        const left = Math.max(0, box.left + track.clientLeft);
        const right = Math.min(window.innerWidth, box.left + track.clientLeft + track.clientWidth);
        const top = Math.max(0, box.top + track.clientTop);
        const bottom = Math.min(window.innerHeight, box.top + track.clientTop + track.clientHeight);
        let nearest = Infinity;
        target = null;
        for (const item of Array.from(track.querySelectorAll<HTMLElement>('[data-focusable], [data-hover-target]'))) {
          const r = item.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.right <= left || r.left >= right
              || r.bottom <= top || r.top >= bottom || getComputedStyle(item).visibility === 'hidden') continue;
          const dx = Math.max(r.left - point.x, 0, point.x - r.right);
          const dy = Math.max(r.top - point.y, 0, point.y - r.bottom);
          const distance = dx * dx + dy * dy;
          if (distance < nearest) {
            nearest = distance;
            target = item;
          }
        }
      }
      if (target) {
        // Hand the keys the visible pick, not the tile the scroll left behind.
        hoverStale = true;
        setHoverTarget(target);
        Focus.flush();
      }
    };
    // A panel that settled under the resting pointer: hover what lies there.
    // It moved since any hover the pointer gave it, so that hover is stale:
    // even the same item is hovered afresh. The browser still holds its own
    // hover where the pointer last moved, so a move back onto that element
    // fires no mouseover: a move hovers what it lands on unless it is tracked.
    Focus.setHoverAt((x, y, within) => {
      const target = closestFocusable(document.elementFromPoint(x, y));
      if (target && !within.contains(target)) return;
      hoverStale = true;
      setHoverTarget(target);
    });

    const leaveKeys = (via: string): void => {
      setInputMode('pointer');
      if (suppressedHovers > 0) {
        log.debug('Hover resumed', 'event=nav.hover.resumed', `via=${via}`,
          `suppressed=${suppressedHovers}`);
        suppressedHovers = 0;
      }
    };
    const resumePointer = (e: MouseEvent, via: string): void => {
      if (InputMode.current !== 'keys') return;
      leaveKeys(via);
      setHoverTarget(focusableAt(e));
    };
    // Chromium fires mouseout and mouseover before the mousemove of the same
    // step, so those must already see pointer mode.
    const movedFrom = (e: MouseEvent): boolean => pointerX !== null
      && (e.screenX !== pointerX || e.screenY !== pointerY);

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // webOS reports its cursor appearing or hiding as a key press; neither
      // is the D-pad taking over.
      if (e.keyCode === K.CURSOR_HIDE) {
        settleEdgeFocus();
        Focus.pointerGone();
      }
      if (e.keyCode === K.CURSOR_SHOW || e.keyCode === K.CURSOR_HIDE) {
        setCursorHidden(e.keyCode === K.CURSOR_HIDE);
        return;
      }
      settleEdgeFocus();
      setInputMode('keys');
      hoverStale = true;
    }, true);
    let pointerClientX = 0;
    let pointerClientY = 0;
    // Position-only consumers such as the player's edge panels; Chromium 53 fires no pointermove.
    const dispatchPointerMove = (e: MouseEvent): void => {
      // A hover may have re-rendered the target out of the document.
      const at = e.target instanceof Element && document.contains(e.target) ? e.target : document;
      at.dispatchEvent(new CustomEvent('nav:pointermove', {
        bubbles: true, detail: { clientX: e.clientX, clientY: e.clientY },
      }));
    };
    document.addEventListener('mousemove', (e: MouseEvent) => {
      const moved = movedFrom(e);
      pointerX = e.screenX;
      pointerY = e.screenY;
      pointerClientX = e.clientX;
      pointerClientY = e.clientY;
      Focus.pointer(e.clientX, e.clientY);
      if (!moved) {
        // A repeat in pointer mode is the cursor pushed against the screen edge.
        if (InputMode.current !== 'keys') dispatchPointerMove(e);
        return;
      }
      // Firmware may re-show its cursor on a move without reporting it.
      setCursorHidden(false);
      // Pointing off a stopped scroll's track: the keys follow the pointer again.
      if (edgeScrollTrack && !edgeScrollActive) {
        const root = edgeScrollOwner?.root();
        if (!root || edgeScrollTrackAt(root, e.clientX, e.clientY) !== edgeScrollTrack) {
          edgeScrollTrack = null;
          edgeScrollOwner = null;
        }
      }
      if (InputMode.current === 'keys') resumePointer(e, 'move');
      else if (hoverStale || focusableAt(e) !== lastHover) setHoverTarget(focusableAt(e));
      dispatchPointerMove(e);
    }, true);
    // Scrolling content with the wheel is pointer use even with the cursor at
    // rest; the hovers it causes must follow the pointer again. A wheel that
    // only steps channels moves nothing under the pointer.
    let pointerScrollUntil = 0;
    let scrollVia: 'wheel' | 'edge' = 'wheel';
    document.addEventListener('wheel', (e: WheelEvent) => {
      // An SVG icon under the pointer still sits in the scrolled list.
      if (e.target instanceof Element && hasScrollableAncestor(e.target)) {
        pointerClientX = e.clientX;
        pointerClientY = e.clientY;
        Focus.pointer(e.clientX, e.clientY);
        pointerScrollUntil = Date.now() + WHEEL_SCROLL_WINDOW_MS;
        scrollVia = 'wheel';
        resumePointer(e, 'wheel');
      }
    }, true);
    // webOS fires no mouseover as scrolled content slides under a resting
    // cursor, so hover what lands under it once the scroll (and any virtual
    // list re-render) settles.
    let hoverSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const syncScrollHover = (): void => {
      if (Date.now() > pointerScrollUntil) return;
      if (hoverSyncTimer !== null) clearTimeout(hoverSyncTimer);
      const via = scrollVia;
      const owner = Focus.owner();
      hoverSyncTimer = setTimeout(() => {
        hoverSyncTimer = null;
        if (InputMode.current === 'keys' || document.hidden) return;
        if (via === 'edge' && (edgeScrollActive || !Focus.pointerPosition() || Focus.owner() !== owner)) return;
        const hit = document.elementFromPoint(pointerClientX, pointerClientY);
        if (!hit) return;
        const root = owner?.root();
        // A gutter has no hover target; keep the track available for the keys.
        if (via === 'edge' && edgeScrollTrack && root && !closestFocusable(hit)
            && edgeScrollTrackAt(root, pointerClientX, pointerClientY) === edgeScrollTrack) return;
        log.debug('Hover synced after scroll', 'event=nav.hover.synced', `via=${via}`);
        // A real mouseover, so views with their own hover handling follow too.
        hit.dispatchEvent(new MouseEvent('mouseover', {
          bubbles: true,
          clientX: pointerClientX,
          clientY: pointerClientY,
          screenX: pointerX ?? 0,
          screenY: pointerY ?? 0,
        }));
        if (via === 'edge') {
          edgeScrollTrack = null;
          edgeScrollOwner = null;
        }
      }, HOVER_SYNC_DELAY_MS);
    };
    const cancelEdgeHover = (): void => {
      if (scrollVia !== 'edge') return;
      pointerScrollUntil = 0;
      edgeScrollTrack = null;
      edgeScrollOwner = null;
      edgeScrollActive = false;
      if (hoverSyncTimer !== null) clearTimeout(hoverSyncTimer);
      hoverSyncTimer = null;
    };
    document.addEventListener('scroll', syncScrollHover, true);
    installEdgeScroll(track => {
      pointerScrollUntil = Date.now() + WHEEL_SCROLL_WINDOW_MS;
      scrollVia = 'edge';
      edgeScrollTrack = track;
      edgeScrollOwner = Focus.owner();
      edgeScrollActive = true;
    }, () => {
      if (!edgeScrollTrack) return;
      edgeScrollActive = false;
      if (scrollVia !== 'edge') {
        edgeScrollTrack = null;
        edgeScrollOwner = null;
        return;
      }
      if (Focus.owner() === edgeScrollOwner) syncScrollHover();
      else cancelEdgeHover();
    });
    document.addEventListener('mousedown', cancelEdgeHover, true);
    document.addEventListener('click', cancelEdgeHover, true);
    window.addEventListener('blur', cancelEdgeHover);
    // While the D-pad drives, rows scrolling under a resting cursor fire
    // mouseover too; following them would pull focus back under the pointer.
    // Capture phase, so components with their own mouseover never see them.
    document.addEventListener('mouseover', (e: MouseEvent) => {
      // Hover reveal would add a second scroll as new tiles slide under it.
      if (edgeScrollActive && edgeScrollTrack && !movedFrom(e)
          && e.target instanceof Node && edgeScrollTrack.contains(e.target)) {
        e.stopImmediatePropagation();
        return;
      }
      if (InputMode.current !== 'keys') return;
      if (movedFrom(e)) {
        resumePointer(e, 'move');
      } else if (pointerX === null || (e.screenX === pointerX && e.screenY === pointerY)) {
        // A pointer that never moved yet can't tell a real move from content
        // sliding under it; its first mousemove only seeds the position.
        suppressedHovers++;
        e.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener('mouseout', (e: MouseEvent) => {
      if (InputMode.current === 'keys' && movedFrom(e)) leaveKeys('move');
    }, true);
    document.addEventListener('mouseover', (e: MouseEvent) => setHoverTarget(focusableAt(e)));
    // Cursor left the window: forget the last hover so returning to the same
    // element re-dispatches nav:hover (re-showing a cleared highlight).
    document.documentElement.addEventListener('mouseleave', () => {
      settleEdgeFocus();
      Focus.pointerGone();
      setHoverTarget(null);
    });
    document.addEventListener('cursorStateChange', (e: Event) => {
      const detail = (e as CustomEvent<{ visibility?: boolean } | null>).detail;
      if (detail && typeof detail.visibility === 'boolean') setCursorHidden(detail.visibility === false);
      if (detail && detail.visibility === false) {
        settleEdgeFocus();
        Focus.pointerGone();
      }
    });

    // Magic Remote scroll wheel / desktop mouse wheel
    // Let any scrollable ancestor scroll natively — otherwise mouseover-driven
    // focus would snap back to the cursor as content scrolls underneath it.
    // First scroll after pointer was hidden just reactivates the cursor.
    document.addEventListener('wheel', (e: WheelEvent) => {
      const scrolls = hasScrollableAncestor(e.target as Element);
      // A surface that handles the wheel itself cancels nav:wheel.
      const at = e.target instanceof Element ? e.target : document;
      const claimed = !at.dispatchEvent(new CustomEvent('nav:wheel', {
        bubbles: true, cancelable: true, detail: { step: !scrolls },
      }));
      if (claimed || scrolls) return;
      e.preventDefault();

      // Reset idle timer — if no scroll for 5s, next scroll is swallowed
      if (wheelIdleTimer) clearTimeout(wheelIdleTimer);
      wheelIdleTimer = setTimeout(() => { wheelWarmedUp = false; }, 5000);

      if (!wheelWarmedUp) {
        wheelWarmedUp = true;
        return;
      }

      if (!activeHandler || e.deltaY === 0) return;
      dispatchingWheel = true;
      hoverStale = true;
      try {
        activeHandler(e.deltaY < 0 ? 'channel_up' : 'channel_down');
      } finally {
        dispatchingWheel = false;
      }
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

  // Whether the action being handled is a wheel step rather than a key.
  isWheelAction(): boolean {
    return dispatchingWheel;
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
