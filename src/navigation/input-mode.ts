// Whether the remote's keys or the pointer drive the UI. The `keyboard-nav`
// class on <html> is the one truth, so CSS and this module never disagree;
// only KeyHandler changes it, through setInputMode().

export type Mode = 'keys' | 'pointer';

const CLASS = 'keyboard-nav';
const listeners = new Set<(mode: Mode) => void>();
const goneListeners = new Set<() => void>();
let keyAfterPointer = false;
let cursorHidden = false;

function read(): Mode {
  return document.documentElement.classList.contains(CLASS) ? 'keys' : 'pointer';
}

export const InputMode = {
  get current(): Mode {
    return read();
  },

  /** Whether the key being handled is the first since the pointer drove the UI
   *  with its cursor still on screen. */
  get keyAfterPointer(): boolean {
    return keyAfterPointer;
  },

  /** Call `fn` on each switch; returns the unsubscribe. */
  onChange(fn: (mode: Mode) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },

  /** Call `fn` when the pointer leaves the window or webOS hides its cursor. */
  onPointerGone(fn: () => void): () => void {
    goneListeners.add(fn);
    return () => { goneListeners.delete(fn); };
  },
};

/** KeyHandler only: switch the mode and tell subscribers when it changed. */
export function setInputMode(mode: Mode): void {
  keyAfterPointer = mode === 'keys' && read() === 'pointer' && !cursorHidden;
  if (mode === 'pointer') cursorHidden = false;
  if (read() === mode) return;
  document.documentElement.classList.toggle(CLASS, mode === 'keys');
  for (const fn of Array.from(listeners)) fn(mode);
}

/** KeyHandler only: the pointer left the window or its cursor hid. */
export function notifyPointerGone(): void {
  for (const fn of Array.from(goneListeners)) fn();
}

/** KeyHandler only: webOS hid or showed its cursor; the mode stays as it is. */
export function setCursorHidden(hidden: boolean): void {
  cursorHidden = hidden;
}
