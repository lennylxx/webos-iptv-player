// Focus scopes and the owner stack: who gets the next key, and, for a scope
// that holds logical focus, which element carries the ring. A scope holds its
// focus as a key, never a node, so a re-render or a recycled row cannot strand
// it; the reconcile pass after each input paints the one ring and keeps it in
// view.
//
// A scope without `defaultKey` only routes keys: it paints no ring, and
// reconcile only re-gates the rings for it.

import { CONFIG } from '../config';
import type { Action, NumberEvent } from '../types';
import { createLogger } from '../utils/logger';
import { FocusRing, hasRing, isHovered, ringShown, ringsIn, setRing, UNRESOLVED_ATTR } from './focus-ring';
import { InputMode } from './input-mode';
import { SCOPES, type ScopeId, type ScopeMode } from './scope-ids';

const log = createLogger('Focus');

export type Via = 'key' | 'pointer' | 'resume' | 'back';
export type EnterTo = 'last' | 'default';
export type LeaveDir = 'up' | 'down' | 'left' | 'right';

// Who wins when several scopes want the keys: the higher tier, then within a
// tier the latest push.
export const Tier = {
  panel: 5,     // a player panel the menus open over: the subtitle search
  overlay: 10,  // dropdowns and player overlays
  bar: 20,      // the tab bar
  prompt: 30,   // modal prompts
  critical: 40, // the parental PIN, which must outrank a prompt that a timer raises
} as const;
type RepairReason = 'two_rings' | 'outside_owner' | 'unresolved' | 'clipped' | 'detached';

export interface ScopeSpec<I extends ScopeId = ScopeId> {
  id: I;
  // Which of its SCOPES modes the root shows now; required when it lists any.
  mode?: () => ScopeMode<I>;
  root: HTMLElement | (() => HTMLElement | null);
  // `self-only`: a modal that keeps every key and keeps hover outside it dark.
  restrict?: 'self-only' | 'self-first';
  // Defaults to `prompt` for a self-only scope, else `overlay`.
  tier?: number;
  // A pushed scope counts only while this holds, such as while
  // its view is the shown one; it keeps its place on the stack meanwhile.
  when?: () => boolean;
  // Takes the keys while the scope owns them; without it the shown view routes them.
  onAction?: (action: Action, event?: NumberEvent) => void;
  defaultKey?: () => string | null;
  enterTo?: EnterTo | ((via: Via) => EnterTo);
  // Where a key off this scope's edge goes: another scope's id, or null to
  // keep it here.
  leaveFor?: Partial<Record<LeaveDir, string | null>>;
  // How the scope takes the keys when another leaves for it; without it,
  // its `enterTo` rule applies.
  onEnter?: (via: Via) => void;
  resolve?: (key: string) => HTMLElement | null;
  // A key still in the model but not rendered, such as a virtual list row
  // scrolled away: no fallback and no ring until a reveal renders it.
  has?: (key: string) => boolean;
  // Asked on every pass that may reveal, since a virtual list knows its own
  // scroll better than geometry: true when it scrolled, false to fall back
  // to the geometric check, null when it keeps the key in view itself.
  reveal?: (key: string) => boolean | null;
  // The pointer resting on such a key may reveal it, such as a half-hidden tab.
  revealOnHover?: (key: string) => boolean;
  // Hide the ring, keeping the key, once the pointer leaves the root.
  concealOnLeave?: boolean;
  // Called once the scope stops owning the keys, such as to drop a caret
  // that would otherwise keep the arrow keys from the new owner.
  onRelease?: () => void;
  // Called once the scope comes to own the keys, such as to give a caret
  // back to a field that onRelease took it from.
  onAcquire?: () => void;
  // A panel that slides out under a resting pointer hovers what settles
  // under it, as a move would. Off for prompts: their safe default must
  // not yield to a cursor that merely rests, or hides, where they open.
  hoverOnSettle?: boolean;
}

export interface FocusScope {
  readonly id: string;
  // The id, and the mode when the scope has modes: `id:mode`.
  readonly surface: string;
  readonly modal: boolean;
  readonly logical: boolean;
  readonly tier: number;
  readonly focusKey: string | null;
  // Whether the ring is hidden while the key is kept, until the next request.
  readonly concealed: boolean;
  root(): HTMLElement | null;
  /** Route `action` to the scope; false when it has no handler of its own. */
  handle(action: Action, event?: NumberEvent): boolean;
  /** Request focus on `key`; reconcile paints it. Off the keys, a pointer request lights it while hovered. */
  focus(key: string | null, via: Via): void;
  /**
   * Follow a key the component's state moved to without an input: no reveal,
   * and the ring stays concealed unless `show`.
   */
  track(key: string | null, show?: boolean): void;
  /** Move focus that the user scrolled away to `key`, in view, and report the repair. */
  resume(key: string, distance: number, ...fields: string[]): void;
  /** Hide the ring but keep the key, until the next focus request. */
  conceal(): void;
  /** Apply the scope's `enterTo` rule. */
  enter(via: Via): void;
  /** Hand a key off the edge to the `leaveFor` scope; false when none takes it. */
  leave(dir: LeaveDir): boolean;
  dispose(): void;
}

// jsdom has no CSS.escape; the fallback covers what a quoted string needs.
function cssString(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[\0-\x1f\x7f"\\]/g, (c) =>
    (c === '"' || c === '\\' ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `));
}

function byKey(root: HTMLElement, key: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-key="${cssString(key)}"]`);
}

// How much of the element the viewport or a clipping ancestor hides; an
// element larger than its scroller only has to fill it.
function hiddenBy(el: Element): number {
  const r = el.getBoundingClientRect();
  let left = 0;
  let top = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const b = n.getBoundingClientRect();
    if (s.overflowX !== 'visible') {
      left = Math.max(left, b.left + n.clientLeft);
      right = Math.min(right, b.left + n.clientLeft + n.clientWidth);
    }
    if (s.overflowY !== 'visible') {
      top = Math.max(top, b.top + n.clientTop);
      bottom = Math.min(bottom, b.top + n.clientTop + n.clientHeight);
    }
    if (s.position === 'fixed') break;
  }
  if (right <= left || bottom <= top) return 0;
  const slack = 1;
  const w = Math.min(r.right, right) - Math.max(r.left, left);
  const h = Math.min(r.bottom, bottom) - Math.max(r.top, top);
  const hiddenX = Math.min(r.width, right - left) - Math.max(0, w);
  const hiddenY = Math.min(r.height, bottom - top) - Math.max(0, h);
  return (hiddenX > slack ? hiddenX : 0) + (hiddenY > slack ? hiddenY : 0);
}

class Scope implements FocusScope {
  focusKey: string | null = null;
  // The ring reconcile painted, so a ring anyone else left in the root shows.
  painted: Element | null = null;
  // Whether `painted` is the pointer's pick lit while another scope owns the keys.
  hoverLit = false;
  // The key the last reconcile settled on, so a clip of unchanged focus shows.
  settledKey: string | null = null;
  // A focus request other than the pointer's, which may reveal its key.
  requested = false;
  concealed = false;

  constructor(readonly spec: ScopeSpec) {}

  get id(): string { return this.spec.id; }
  get surface(): string {
    const mode = this.spec.mode?.();
    return mode ? `${this.spec.id}:${mode}` : this.spec.id;
  }
  get modal(): boolean { return this.spec.restrict === 'self-only'; }
  get tier(): number { return this.spec.tier ?? (this.modal ? Tier.prompt : Tier.overlay); }
  get live(): boolean { return this.spec.when ? this.spec.when() : true; }
  get logical(): boolean { return this.spec.defaultKey !== undefined; }

  root(): HTMLElement | null {
    const r = this.spec.root;
    return typeof r === 'function' ? r() : r;
  }

  element(key: string): HTMLElement | null {
    if (this.spec.resolve) return this.spec.resolve(key);
    const root = this.root();
    return root ? byKey(root, key) : null;
  }

  handle(action: Action, event?: NumberEvent): boolean {
    if (!this.spec.onAction) return false;
    this.spec.onAction(action, event);
    return true;
  }

  focus(key: string | null, via: Via): void {
    this.focusKey = key;
    this.concealed = false;
    // A pointer request lights the item where it is; any other may reveal it.
    // Off the keys, one the pointer is not on waits for them, keeping a
    // reveal already asked for.
    if (via !== 'pointer') this.requested = true;
    else if (this.lightHovered() || Focus.owner() === this) this.requested = false;
    Focus.reconcile();
  }

  // Off the keys, as under an open bar menu, the pointer's pick lights only
  // while the pointer rests on it, and only it; FocusRing parks it once the
  // pointer goes.
  lightHovered(): boolean {
    if (!this.logical || Focus.owner() === this) return false;
    const root = this.root();
    const el = root && !this.concealed && this.focusKey !== null
      ? within(root, this.element(this.focusKey)) : null;
    if (!root || !el || !isHovered(el)) {
      this.unlight();
      return false;
    }
    // An owner nested in this root keeps its ring.
    const ownerRoot = Focus.owner()?.root() ?? null;
    const kept = ownerRoot && root.contains(ownerRoot) ? ownerRoot : null;
    for (const other of ringsIn(root)) {
      if (other !== el && !kept?.contains(other)) setRing(other, false);
    }
    setRing(el, true);
    this.painted = el;
    this.hoverLit = true;
    FocusRing.sync();
    return true;
  }

  // Drop the pointer's pick lit off the keys; the pointer's next use hovers afresh.
  unlight(): void {
    if (this.painted) setRing(this.painted, false);
    this.painted = null;
    this.hoverLit = false;
  }

  track(key: string | null, show = false): void {
    this.focusKey = key;
    if (show) this.concealed = false;
    Focus.reconcile();
  }

  resume(key: string, distance: number, ...fields: string[]): void {
    this.focusKey = key;
    this.concealed = false;
    this.requested = false;
    repaired('detached', this, `distance=${String(distance)}`, ...fields);
    Focus.reconcile();
  }

  conceal(): void {
    this.concealed = true;
    this.requested = false;
    this.lightHovered();
    Focus.reconcile();
  }

  enter(via: Via): void {
    const rule = typeof this.spec.enterTo === 'function'
      ? this.spec.enterTo(via) : this.spec.enterTo ?? 'last';
    const keep = rule === 'last' && this.focusKey !== null && this.element(this.focusKey) !== null;
    this.focus(keep ? this.focusKey : this.spec.defaultKey?.() ?? null, via);
  }

  leave(dir: LeaveDir): boolean {
    const id = this.spec.leaveFor?.[dir];
    if (id === undefined) return false;
    if (id === null) return true;
    const target = registry.get(id);
    if (!target || !target.live) return false;
    if (target.spec.onEnter) target.spec.onEnter('key');
    else target.enter('key');
    return true;
  }

  dispose(): void {
    Focus.pop(this);
    if (registry.get(this.id) === this) registry.delete(this.id);
  }
}

const registry = new Map<string, Scope>();
let stack: Scope[] = [];
let base: (() => FocusScope | null) | null = null;
let scheduled = false;
let listening = false;
// Set by an input, so only it (or a focus request) may scroll the ring into
// view; a pass after a re-render (or mid smooth scroll) never does.
// A hover reveals only where the scope asks for it.
let pendingHover = false;
let pendingOther = false;
let lastOwner: string | null = null;
// Rings a morph kept against its template; the next pass drops any whose
// scope no longer paints them, as the template would have.
let held: Element[] = [];
// Where the pointer last rested (client coordinates), from KeyHandler.
let pointerAt: { x: number; y: number } | null = null;
const pointerListeners = new Set<(x: number, y: number) => void>();
let settleFrame: number | null = null;
// KeyHandler's hover, so a settled panel's hover is one it tracks.
let hoverAt: ((x: number, y: number, within: HTMLElement) => void) | null = null;
const SETTLE_MAX_FRAMES = 60;
// Per scope, so one surface's reveal never makes another's jump.
const lastReveal = new WeakMap<Scope, { key: string; at: number; hidden: number }>();

function repaired(reason: RepairReason, scope: Scope, ...fields: string[]): void {
  log.debug('Focus repaired', 'event=nav.focus.repaired', `reason=${reason}`, `scope=${scope.id}`,
    ...fields);
}

function within(root: HTMLElement, el: HTMLElement | null): HTMLElement | null {
  return el && root.contains(el) ? el : null;
}

function apart(a: Element, b: Element): boolean {
  return !a.contains(b) && !b.contains(a);
}

// Whether a morph of `root` could change what a pass paints: a pass that
// finds the owner's ring in place, outside the morph, with no ring shown
// there (a template draws one shown) and no pointer's pick lit in it, would
// change nothing. A parked ring off the keys stays parked.
function touches(root: HTMLElement, owner: Scope): boolean {
  const ownerRoot = owner.root();
  const painted = owner.painted;
  if (scheduled || !owner.logical || owner.concealed || !ownerRoot || !painted) return true;
  if (!ownerRoot.contains(painted) || !hasRing(painted)) return true;
  if (!document.documentElement.contains(root) || !document.documentElement.contains(ownerRoot)) return true;
  if (!apart(root, ownerRoot)) return true;
  if (ringsIn(root).some((el) => ringShown(el) || Focus.paints(el))) return true;
  for (const scope of Array.from(registry.values())) {
    const lit = scope.hoverLit ? scope.root() : null;
    if (lit && !apart(root, lit)) return true;
  }
  return false;
}

function run(): void {
  paint();
  const kept = held;
  held = [];
  for (const el of kept) if (!Focus.paints(el)) setRing(el, false);
  // A re-render drops the class of a pick the pointer lit off the keys. Once
  // the keys take over it stays dark, so it is dropped rather than relit for
  // FocusRing to park again on every pass.
  const owner = Focus.owner();
  const keys = InputMode.current === 'keys';
  for (const scope of Array.from(registry.values())) {
    if (scope === owner || !scope.hoverLit) continue;
    if (keys) scope.unlight();
    else scope.lightHovered();
  }
  FocusRing.sync();
}

function paint(): void {
  const hovered = pendingHover;
  const other = pendingOther;
  pendingHover = pendingOther = false;
  const owner = Focus.owner() as Scope | null;
  if (!owner || !owner.logical) return;
  const requested = owner.requested;
  owner.requested = false;
  const root = owner.root();
  if (!root) return;
  const spec = owner.spec;

  if (owner.concealed) {
    for (const other of ringsIn(root)) setRing(other, false);
    owner.painted = null;
    owner.hoverLit = false;
    root.removeAttribute(UNRESOLVED_ATTR);
    return;
  }

  let key = owner.focusKey;
  let el = key !== null ? owner.element(key) : null;
  let pending = false;
  let reason: RepairReason | null = null;
  if (el && !root.contains(el)) {
    el = null;
    reason = 'outside_owner';
  } else if (key !== null && !el) {
    if (spec.has?.(key)) pending = true;
    else reason = 'unresolved';
  }
  if (!el && !pending) {
    key = spec.defaultKey!();
    el = key !== null ? within(root, owner.element(key)) : null;
  }
  if (reason) repaired(reason, owner);
  owner.focusKey = key;

  const unchanged = key === owner.settledKey;
  owner.settledKey = key;
  const allowed = key !== null && !FocusRing.deferred && (requested
    || (other && InputMode.current === 'keys')
    || (hovered && !!spec.revealOnHover?.(key)));
  if (allowed && key !== null && (el || pending)) {
    const own = spec.reveal ? spec.reveal(key) : false;
    let revealed = own === true;
    if (revealed) {
      el = within(root, owner.element(key));
    }
    const hidden = !revealed && own === false && el ? hiddenBy(el) : 0;
    if (el && hidden > 0) {
      const now = Date.now();
      const last = lastReveal.get(owner);
      const age = last ? now - last.at : -1;
      // The same key still sliding in from its own reveal: hidden less each pass.
      const sliding = !!last && last.key === key && age >= 0 && age < CONFIG.NAVIGATION.REVEAL_SETTLE_MS
        && hidden < last.hidden;
      if (last) last.hidden = hidden;
      if (!sliding) {
        // A held key steps faster than a smooth scroll settles; each step jumps.
        const repeated = !!last && last.key !== key
          && age >= 0 && age <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
        lastReveal.set(owner, { key, at: now, hidden });
        // The polyfill makes this mean `nearest` on Chromium 53 too.
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: repeated ? 'instant' : 'auto' });
        revealed = true;
      }
    }
    if (revealed && unchanged && !pending) repaired('clipped', owner);
  }

  if (key !== null && !el && !pending) root.setAttribute(UNRESOLVED_ATTR, '');
  else root.removeAttribute(UNRESOLVED_ATTR);

  let stray = false;
  for (const other of ringsIn(root)) {
    if (other === el) continue;
    if (other !== owner.painted && ringShown(other)) stray = true;
    setRing(other, false);
  }
  if (stray) repaired('two_rings', owner);
  if (el && !hasRing(el)) setRing(el, true);
  owner.painted = el;
  owner.hoverLit = false;
}

function topmost(...skip: Scope[]): Scope | null {
  let best: Scope | null = null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    if (skip.indexOf(s) < 0 && s.live && (!best || s.tier > best.tier)) best = s;
  }
  return best;
}

function cancelSettle(): void {
  if (settleFrame !== null) cancelAnimationFrame(settleFrame);
  settleFrame = null;
}

// A panel that slides out under a resting pointer gets no mouseover, so once
// it stops moving, hover what now lies under the pointer, as a move would.
// It must also cover the pointer: before its slide starts, it holds still
// off to the side. The mode is read once it settles: the move that opened
// it may not have reached the input mode yet.
function hoverUnderPointer(scope: Scope): void {
  cancelSettle();
  if (!hoverAt || typeof requestAnimationFrame !== 'function') return;
  let last = '';
  let frames = 0;
  const step = (): void => {
    settleFrame = null;
    const root = scope.root();
    if (!root || !pointerAt || InputMode.current !== 'pointer' || lastOwner !== scope.id) return;
    const r = root.getBoundingClientRect();
    const rect = `${r.left},${r.top},${r.width},${r.height}`;
    const covers = pointerAt.x >= r.left && pointerAt.x < r.right && pointerAt.y >= r.top && pointerAt.y < r.bottom;
    if ((rect !== last || !covers) && ++frames < SETTLE_MAX_FRAMES) {
      last = rect;
      settleFrame = requestAnimationFrame(step);
      return;
    }
    hoverAt?.(pointerAt.x, pointerAt.y, root);
  };
  settleFrame = requestAnimationFrame(step);
}

// A wheel a surface claimed (canceled nav:wheel) moved nothing of ours.
function onWheel(e: Event): void {
  if (!e.defaultPrevented) Focus.input();
}

function onInput(): void {
  Focus.input();
}

function onHoverInput(): void {
  Focus.input('hover');
}

// A pushed modal keeps the pointer's hover outside it from reaching the
// surfaces below, so nothing behind it moves focus or lights up. A hover
// that passes marks the ring's hover target before any component sees it.
function onHoverGate(e: Event): void {
  if (!(e.target instanceof Element)) return;
  const owner = Focus.owner() as Scope | null;
  if (owner?.modal && stack.indexOf(owner) >= 0) {
    const root = owner.root();
    if (root && !root.contains(e.target)) {
      e.stopImmediatePropagation();
      return;
    }
  }
  FocusRing.hover(e.target);
}

function onUnhover(e: Event): void {
  if (e.target instanceof Element) FocusRing.unhover(e.target);
}

function onLeave(e: MouseEvent): void {
  if (InputMode.current === 'keys') return;
  const owner = Focus.owner() as Scope | null;
  if (!owner?.logical || !owner.spec.concealOnLeave) return;
  const root = owner.root();
  if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
  if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
  owner.conceal();
}

function resolveOwner(): { owner: FocusScope | null; best: Scope | null } {
  const best = topmost();
  return { owner: best ?? (base ? base() : null), best };
}

export const Focus = {
  register<I extends ScopeId>(spec: ScopeSpec<I>): FocusScope {
    if (registry.has(spec.id)) throw new Error(`Focus scope ${spec.id} is already registered`);
    const modes: readonly string[] | undefined = SCOPES[spec.id];
    if (modes?.length && !spec.mode) throw new Error(`Focus scope ${spec.id} must report its mode`);
    const scope = new Scope(spec as ScopeSpec);
    registry.set(spec.id, scope);
    return scope;
  },

  /** A scope shown above the view: the owner until popped, unless a higher tier is up. */
  push(scope: FocusScope): void {
    const s = scope as Scope;
    stack = stack.filter((entry) => entry !== s);
    stack.push(s);
    Focus.reconcile();
  },

  /** Take a pushed scope off the stack; it keeps its registration but no ring. */
  pop(scope: FocusScope): void {
    const s = scope as Scope;
    const before = stack.length;
    stack = stack.filter((entry) => entry !== s);
    if (s.painted) setRing(s.painted, false);
    s.painted = null;
    s.hoverLit = false;
    if (stack.length !== before) Focus.reconcile();
  },

  /** The scope that owns the keys when nothing above it does: the shown view. */
  setBase(resolve: () => FocusScope | null): void {
    base = resolve;
  },

  owner(): FocusScope | null {
    let { owner, best } = resolveOwner();
    // A `when` or the shown view can change the owner without a push, a pop,
    // or an input: whoever asks first (a key, a morph, FocusRing.sync)
    // triggers the pass.
    const id = owner ? owner.id : null;
    if (id !== lastOwner) {
      const released = lastOwner !== null ? registry.get(lastOwner) : undefined;
      lastOwner = id;
      Focus.reconcile();
      released?.spec.onRelease?.();
      // onRelease may push or pop a scope: the owner after it acquires.
      ({ owner, best } = resolveOwner());
      lastOwner = owner ? owner.id : null;
      if (owner) (owner as Scope).spec.onAcquire?.();
      if (best && best.spec.hoverOnSettle && stack.indexOf(best) >= 0) hoverUnderPointer(best);
      else cancelSettle();
    }
    return owner;
  },

  /** The scope that would own the keys if `scopes` were gone; it may sit above them. */
  ownerWithout(...scopes: FocusScope[]): FocusScope | null {
    return topmost(...(scopes as Scope[])) ?? (base ? base() : null);
  },

  /** The shown view's scope, which owns the keys when nothing else does. */
  base(): FocusScope | null {
    return base ? base() : null;
  },

  /** Note where the pointer rests, in client coordinates. */
  pointer(x: number, y: number): void {
    pointerAt = { x, y };
    for (const listener of Array.from(pointerListeners)) listener(x, y);
  },

  /**
   * Follow the pointer's moves. Chromium hovers before the move of the same
   * step lands here, so a hover that reads the position sees the old one.
   */
  onPointer(listener: (x: number, y: number) => void): () => void {
    pointerListeners.add(listener);
    return () => { pointerListeners.delete(listener); };
  },

  /** Where the pointer last rested, in client coordinates. */
  pointerPosition(): { x: number; y: number } | null {
    return pointerAt;
  },

  /** The cursor hid or left the window: nothing rests anywhere. */
  pointerGone(): void {
    pointerAt = null;
    cancelSettle();
  },

  /**
   * The owner's surface just stopped moving under the resting pointer, which
   * fires no mouseover: hover what now lies there, as a move would.
   */
  hoverPointerIn(scope: FocusScope): void {
    const root = (scope as Scope).root();
    if (!hoverAt || !root || !pointerAt || InputMode.current !== 'pointer') return;
    if (Focus.owner() !== scope) return;
    hoverAt(pointerAt.x, pointerAt.y, root);
  },

  /** Hover the item at a point, if it lies within the given root. */
  setHoverAt(hook: ((x: number, y: number, within: HTMLElement) => void) | null): void {
    hoverAt = hook;
  },

  /** Note an input (key, hover, click, wheel): the next pass may reveal the ring. */
  input(kind: 'hover' | 'other' = 'other'): void {
    if (kind === 'hover') pendingHover = true;
    else pendingOther = true;
    Focus.reconcile();
  },

  /** Run the reconcile pass once, in a microtask, however often it is asked for. */
  reconcile(): void {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      if (!scheduled) return;
      scheduled = false;
      run();
    });
  },

  /** Run a pending reconcile now. */
  flush(): void {
    if (!scheduled) return;
    scheduled = false;
    run();
  },

  /** Whether `el` wears the ring the owner painted, or the pointer's pick lit off the keys. */
  paints(el: Element): boolean {
    // The owner as it resolves now: a morph may run before anyone settles a new one.
    const owner = resolveOwner().owner;
    for (const scope of Array.from(registry.values())) {
      if (scope.painted === el && (scope === owner || scope.hoverLit)) return true;
    }
    return false;
  },

  /** Note a morph(): the template may have replaced the owner's ring or drawn one to gate. */
  afterMorph(root?: HTMLElement, kept: Element[] = []): void {
    if (kept.length) {
      held = held.concat(kept);
      Focus.reconcile();
      return;
    }
    const before = lastOwner;
    const owner = Focus.owner() as Scope | null;
    if (root && owner && lastOwner === before && !touches(root, owner)) return;
    Focus.reconcile();
  },

  /** Reconcile after the pointer inputs that can move focus; keys come from the host. */
  install(): void {
    if (listening) return;
    listening = true;
    document.addEventListener('nav:hover', onHoverGate, true);
    document.addEventListener('nav:unhover', onUnhover, true);
    document.addEventListener('nav:hover', onHoverInput);
    document.addEventListener('click', onInput);
    document.addEventListener('nav:wheel', onWheel);
    document.addEventListener('mouseout', onLeave);
  },

  uninstall(): void {
    if (listening) {
      document.removeEventListener('nav:hover', onHoverGate, true);
      document.removeEventListener('nav:unhover', onUnhover, true);
      document.removeEventListener('nav:hover', onHoverInput);
      document.removeEventListener('click', onInput);
      document.removeEventListener('nav:wheel', onWheel);
      document.removeEventListener('mouseout', onLeave);
    }
    listening = false;
    for (const scope of Array.from(registry.values())) scope.dispose();
    stack = [];
    base = null;
    scheduled = false;
    pendingHover = pendingOther = false;
    lastOwner = null;
    held = [];
    pointerAt = null;
    cancelSettle();
  },
};
