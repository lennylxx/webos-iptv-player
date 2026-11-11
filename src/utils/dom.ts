import { createLogger } from './logger';
import { Focus } from '../navigation/focus-scope';

const log = createLogger('Dom');

export function $(selector: string, parent: Element | Document = document): HTMLElement | null {
  return parent.querySelector(selector);
}

export function $$(selector: string, parent: Element | Document = document): HTMLElement[] {
  return Array.from(parent.querySelectorAll(selector));
}

// A shown or hidden view flips the base and every `when` that reads
// `inShownView`, with no input or morph to settle the owner; the pass
// runs once the whole switch is done.
export function show(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = '';
  el.classList.remove('hidden');
  Focus.reconcile();
}

export function hide(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = 'none';
  el.classList.add('hidden');
  Focus.reconcile();
}

/** Whether `el` sits in the shown view, or outside every view. */
export function inShownView(el: Element): boolean {
  const view = el.closest('.view');
  return !view || !view.classList.contains('hidden');
}

// --- Transition end ------------------------------------------------------
// `addEventListener(…, { once: true })` is Chrome 55+; Chromium 53 ignores
// `once` and keeps the listener, so remove it by hand.
// Returns a function that stops waiting.
export function onceTransitionEnd(el: HTMLElement, callback: () => void): () => void {
  const onEnd = (): void => {
    el.removeEventListener('transitionend', onEnd);
    callback();
  };
  el.addEventListener('transitionend', onEnd);
  return () => el.removeEventListener('transitionend', onEnd);
}

// --- Focus without scrolling ---------------------------------------------
// `focus({ preventScroll })` is Chrome 64+; Chromium 53 ignores the option and
// scrolls the target into view. Detect once whether the engine reads it, and
// otherwise restore every ancestor's scroll offset after a plain focus.

let preventScrollSupported: boolean | undefined;

function supportsPreventScroll(): boolean {
  if (preventScrollSupported !== undefined) return preventScrollSupported;
  let read = false;
  const probe = {};
  Object.defineProperty(probe, 'preventScroll', {
    get: () => { read = true; return true; },
  });
  document.createElement('div').focus(probe);
  preventScrollSupported = read;
  log.info(
    'Focus option detected',
    'event=compat.focus.preventScroll',
    `supported=${read ? 1 : 0}`,
  );
  return read;
}

export function focusWithoutScroll(el: HTMLElement): void {
  if (supportsPreventScroll()) {
    // eslint-disable-next-line webos-compat/unsupported-patterns -- feature-detected above
    el.focus({ preventScroll: true });
    return;
  }
  const offsets: { node: Element; top: number; left: number }[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    offsets.push({ node, top: node.scrollTop, left: node.scrollLeft });
  }
  el.focus();
  for (const { node, top, left } of offsets) {
    if (node.scrollTop !== top) node.scrollTop = top;
    if (node.scrollLeft !== left) node.scrollLeft = left;
  }
}

// Overrides the CSS smooth-scroll policy for one synchronous scroll. Goes
// through setProperty, which works whether or not the engine reflects
// `style.scrollBehavior`.
export function withInstantScroll(nodes: HTMLElement[], scroll: () => void): void {
  const saved = nodes.map((node) => node.style.getPropertyValue('scroll-behavior'));
  nodes.forEach((node) => node.style.setProperty('scroll-behavior', 'auto'));
  try {
    scroll();
  } finally {
    nodes.forEach((node, i) => node.style.setProperty('scroll-behavior', saved[i]));
  }
}

// --- Safe HTML templating ------------------------------------------------
// Channel names, programme titles, logo URLs etc. come from untrusted M3U /
// XMLTV sources. Interpolating them straight into innerHTML is a DOM-XSS hole,
// so render templates use the `html` tagged template, which HTML-escapes every
// interpolated value by default. Wrap intentional, trusted markup in `raw()`.

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

// A frame callback runs before its paint, so the task queued from it runs
// after. A hidden page gets no frames; the timeout stands in for one.
export function afterNextPaint(fallbackMs = 500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(settle, fallbackMs);
    requestAnimationFrame(() => setTimeout(settle, 0));
  });
}

/** A string that is already trusted HTML and must not be re-escaped. */
export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark a string as trusted HTML so `html` won't escape it. */
export function raw(value: string): Safe {
  return new Safe(value);
}

function esc(value: unknown): string {
  if (value instanceof Safe) return value.value;
  if (Array.isArray(value)) return value.map(esc).join('');
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Tagged template that escapes interpolated values. Nested `html` results and
 * `raw(...)` values pass through unescaped; arrays are escaped element-wise and
 * concatenated. Returns a `Safe` — call `String(...)` when assigning to innerHTML.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += esc(values[i]);
  }
  return new Safe(out);
}
