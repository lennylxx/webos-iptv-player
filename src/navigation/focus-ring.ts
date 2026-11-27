// One rule for every focus ring, however a component draws it: only the
// surface that receives the next key shows one. A ring outside that surface is
// parked (its class swapped for a style-less twin) and comes back unchanged
// when the keys return, so no view has to know which surface sits above it.

import type { Action } from '../types';
import { createLogger } from '../utils/logger';
import { InputMode } from './input-mode';

const log = createLogger('FocusRing');

const FOCUSED = 'focused';
const PARKED = 'focused-parked';

// `modal`: a prompt over everything, where even the pointer's hover stays dark.
// `id`: the owning focus scope, marked on the root for tests and diagnostics.
// `id` is read only to mark the owner, since a scope's mode may cost a query.
export interface RingOwner { root: Element | null; modal?: boolean; id?: () => string | undefined }
type OwnerResolver = () => RingOwner;

// Marks the owner root so tests and on-device inspection can see who has the
// keys: empty, `modal`, or `deferred` while its own ring waits.
const OWNER_ATTR = 'data-ring-owner';
const HOVER_ATTR = 'data-ring-hover';
const SCOPE_ATTR = 'data-focus-scope';
// Set by the reconcile pass on a logical owner whose focus resolves to nothing.
export const UNRESOLVED_ATTR = 'data-focus-unresolved';

// Keys that act on the focused item, so they only show a deferred focus. Back,
// number entry, and the media keys still act.
const REVEAL_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'up', 'down', 'left', 'right', 'select', 'channel_up', 'channel_down',
  'red', 'green', 'yellow', 'blue',
]);

let resolver: OwnerResolver | null = null;
let marked: Element | null = null;
let hoverTarget: Element | null = null;
let onWheel: (() => void) | null = null;
let onPress: ((e: Event) => void) | null = null;
let offMode: (() => void) | null = null;
// An owner entered by the pointer keeps its focus but parks the ring until the
// remote, the wheel, or the pointer on it shows where that focus is.
let deferredRoot: Element | null = null;

function setHoverTarget(el: Element | null): void {
  if (el === hoverTarget) return;
  hoverTarget?.removeAttribute(HOVER_ATTR);
  hoverTarget = el;
  hoverTarget?.setAttribute(HOVER_ATTR, '');
}

// The hover target is an input of the gate, so moving it re-gates every ring
// at once: one the pointer lands on lights, one it leaves outside the owner parks.
function hoverMoved(el: Element | null): void {
  if (el === hoverTarget) return;
  setHoverTarget(el);
  FocusRing.sync();
}

/** Show or remove an element's ring; removal also drops a parked one. */
export function setRing(el: Element, on: boolean): void {
  if (on) {
    el.classList.add(FOCUSED);
    return;
  }
  el.classList.remove(FOCUSED);
  el.classList.remove(PARKED);
}

/** Elements under `scope` matching `selector` (comma list allowed) that carry a ring, shown or parked. */
export function ringsIn(scope: ParentNode, selector = ''): Element[] {
  const parts = selector ? selector.split(',').map((s) => s.trim()) : [''];
  return Array.from(scope.querySelectorAll(
    parts.map((s) => `${s}.${FOCUSED}, ${s}.${PARKED}`).join(', '),
  ));
}

/** Whether `el` carries a ring, shown or parked. */
export function hasRing(el: Element): boolean {
  return el.classList.contains(FOCUSED) || el.classList.contains(PARKED);
}

/** The ring classes `el` carries, shown or parked. */
export function ringClasses(el: Element): string[] {
  return [FOCUSED, PARKED].filter((name) => el.classList.contains(name));
}

/** Whether `el` shows a ring, not a parked one. */
export function ringShown(el: Element): boolean {
  return el.classList.contains(FOCUSED);
}

/** Whether the pointer rests on `el`, or on the focusable that holds it. */
export function isHovered(el: Element): boolean {
  return !!hoverTarget && hoverTarget.contains(el);
}

/** Whether `name` is a marker FocusRing writes, which a template never carries. */
export function isRingAttr(name: string): boolean {
  return name === OWNER_ATTR || name === HOVER_ATTR || name === SCOPE_ATTR || name === UNRESOLVED_ATTR;
}

function swap(el: Element, from: string, to: string): void {
  el.classList.remove(from);
  el.classList.add(to);
}

function allowed(el: Element, owner: Element, modal: boolean): boolean {
  if (owner.contains(el)) return owner !== deferredRoot;
  // The pointer may point anywhere; what it hovers stays lit until a key.
  // Hover never moves the keys, except that the tab bar releases them to the
  // scope below it.
  return !modal && !!hoverTarget && hoverTarget.contains(el)
    && InputMode.current !== 'keys';
}

export const FocusRing = {
  /** Gate rings to the root `owner()` returns; a null root leaves every ring alone. */
  install(owner: OwnerResolver): void {
    FocusRing.uninstall();
    resolver = owner;
    // Before KeyHandler turns the step into an action, so it acts from a shown focus.
    onWheel = () => { if (deferredRoot) FocusRing.reveal('wheel'); };
    // Before the view's click handler, which may focus the item without a hover.
    onPress = (e: Event) => {
      if (e.target instanceof Node && deferredRoot?.contains(e.target)) FocusRing.reveal('pointer');
    };
    document.addEventListener('wheel', onWheel, true);
    document.addEventListener('mousedown', onPress, true);
    // The remote taking over parks what the pointer alone kept lit.
    offMode = InputMode.onChange(() => FocusRing.sync());
    FocusRing.sync();
  },

  uninstall(): void {
    marked?.removeAttribute(OWNER_ATTR);
    marked?.removeAttribute(SCOPE_ATTR);
    marked = null;
    resolver = null;
    deferredRoot = null;
    setHoverTarget(null);
    if (onWheel) document.removeEventListener('wheel', onWheel, true);
    if (onPress) document.removeEventListener('mousedown', onPress, true);
    offMode?.();
    offMode = null;
    onWheel = null;
    onPress = null;
  },

  /**
   * The pointer now rests on `el`. Called by the owner stack's hover gate,
   * before any component sees the hover, so `isHovered` already answers.
   */
  hover(el: Element): void {
    hoverMoved(el);
    if (deferredRoot?.contains(el)) FocusRing.reveal('hover');
  },

  /** The pointer left `el`; a hover elsewhere since then keeps its mark. */
  unhover(el: Element): void {
    if (el === hoverTarget) hoverMoved(null);
  },

  /** Park the current owner's own ring until a key, the wheel, or the pointer on it; ends with the owner. */
  defer(view: string): void {
    const resolved = resolver?.();
    if (!resolved?.root || resolved.modal) return;
    deferredRoot = resolved.root;
    log.debug('Focus ring deferred', 'event=nav.focus.deferred', `view=${view}`);
    FocusRing.sync();
  },

  get deferred(): boolean {
    return deferredRoot !== null;
  },

  /**
   * End a deferral and show the parked focus. With `consume`, true when there
   * was a ring to show, so the key that showed it should do nothing else.
   */
  reveal(via: 'key' | 'hover' | 'wheel' | 'pointer', action = '', consume = false): boolean {
    if (!deferredRoot) return false;
    // A key that moved the keys elsewhere showed nothing here; no sync() has
    // ended the deferral yet.
    if (resolver?.()?.root !== deferredRoot) {
      deferredRoot = null;
      FocusRing.sync();
      return false;
    }
    const hidden = deferredRoot.getElementsByClassName(PARKED).length > 0;
    deferredRoot = null;
    const consumed = consume && hidden;
    const fields = via === 'key' ? [`action=${action}`, `consumed=${consumed ? 'yes' : 'no'}`] : [];
    log.debug('Focus ring shown', 'event=nav.focus.shown', `via=${via}`, ...fields);
    FocusRing.sync();
    return consumed;
  },

  /** End a deferral on a key; true when the key only showed the focus and must not act. */
  revealForKey(action: Action): boolean {
    return FocusRing.reveal('key', action, REVEAL_ACTIONS.has(action));
  },

  sync(): void {
    const resolved = resolver?.();
    const owner = resolved?.root ?? null;
    const modal = !!resolved?.modal;
    // A deferral belongs to the owner it was made for: a view switch, the
    // player, or an overlay ends it.
    if (deferredRoot && deferredRoot !== owner) deferredRoot = null;
    if (owner !== marked) {
      marked?.removeAttribute(OWNER_ATTR);
      marked?.removeAttribute(SCOPE_ATTR);
      marked = owner;
    }
    if (!owner) return;
    const mark = modal ? 'modal' : owner === deferredRoot ? 'deferred' : '';
    if (owner.getAttribute(OWNER_ATTR) !== mark) owner.setAttribute(OWNER_ATTR, mark);
    const id = resolved?.id?.();
    if (id === undefined) owner.removeAttribute(SCOPE_ATTR);
    else if (owner.getAttribute(SCOPE_ATTR) !== id) owner.setAttribute(SCOPE_ATTR, id);
    const shown = document.getElementsByClassName(FOCUSED);
    for (const el of Array.from(shown)) {
      if (!allowed(el, owner, modal)) swap(el, FOCUSED, PARKED);
    }
    const parked = document.getElementsByClassName(PARKED);
    for (const el of Array.from(parked)) {
      if (el.classList.contains(FOCUSED)) el.classList.remove(PARKED);
      else if (allowed(el, owner, modal)) swap(el, PARKED, FOCUSED);
    }
  },
};
