import { CONFIG } from '../config';
import { withInstantScroll } from '../utils/dom';
import { Focus, Tier, type FocusScope } from './focus-scope';
import { InputMode } from './input-mode';

export type EdgeAxis = 'x' | 'y';
export type EdgeStep = 'moved' | 'still' | 'end';

// What a [data-edge-scroll] track scrolls. A native scroller is its own; a
// view that pages its content itself, such as the Guide's timeline, registers
// one with setEdgeScroller.
export interface EdgeScroller {
  // The edge the pointer rests on, or null; atEnd keeps an edge that can go no further.
  edgeAt(x: number, y: number, atEnd: boolean): { axis: EdgeAxis; direction: number } | null;
  // Moves along the edge by px, the native scroll for this frame, or by
  // its own measure of the frame's ms at the run's ramp (0 to 1): 'end'
  // when it could not move, 'still' when it has yet to.
  scroll(axis: EdgeAxis, direction: number, px: number, ramp: number, ms: number): EdgeStep;
  // A run begins at an edge, its dwell included, and ends.
  start?(): void;
  stop?(): void;
}

interface Edge {
  track: HTMLElement;
  owner: FocusScope;
  axis: EdgeAxis;
  direction: number;
}

const N = CONFIG.NAVIGATION;
const scrollers = new WeakMap<HTMLElement, EdgeScroller>();

export function setEdgeScroller(track: HTMLElement, scroller: EdgeScroller): void {
  scrollers.set(track, scroller);
}

let recheck: (() => void) | null = null;

// A registered scroller's edge can open under a resting pointer, as the
// timeline's past does once the clock moves on; this looks again, starting
// a run with its dwell. Only a move or this starts one.
export function recheckEdgeScroll(): void {
  recheck?.();
}

function trackBox(track: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  const box = track.getBoundingClientRect();
  return {
    left: Math.max(0, box.left + track.clientLeft),
    right: Math.min(window.innerWidth, box.left + track.clientLeft + track.clientWidth),
    top: Math.max(0, box.top + track.clientTop),
    bottom: Math.min(window.innerHeight, box.top + track.clientTop + track.clientHeight),
  };
}

// A native row scroller, through its scrollLeft.
function nativeScroller(track: HTMLElement): EdgeScroller {
  return {
    edgeAt: (x, y, atEnd) => {
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 1) return null;
      const { left, right, top, bottom } = trackBox(track);
      if (y < top || y >= bottom) return null;
      const zone = Math.min(N.EDGE_SCROLL_ZONE_PX, (right - left) / 3);
      const direction = x < left + zone ? -1 : x >= right - zone ? 1 : 0;
      if (!direction || (!atEnd && (direction < 0 ? track.scrollLeft <= 0 : track.scrollLeft >= max - 1))) return null;
      return { axis: 'x', direction };
    },
    scroll: (_axis, direction, px) => {
      const before = track.scrollLeft;
      const max = track.scrollWidth - track.clientWidth;
      if (direction < 0 ? before <= 0 : before >= max - 1) return 'end';
      const offset = Math.max(0, Math.min(max, before + direction * px));
      // Direct manipulation must not queue CSS smooth scrolls on every frame.
      withInstantScroll([track], () => { track.scrollLeft = offset; });
      return track.scrollLeft !== before ? 'moved' : 'still';
    },
  };
}

function scrollerOf(track: HTMLElement): EdgeScroller {
  return scrollers.get(track) ?? nativeScroller(track);
}

export function edgeScrollTrackAt(root: HTMLElement, x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const direct = hit.closest<HTMLElement>('[data-edge-scroll]');
  if (direct && root.contains(direct)) return direct;
  if (!root.contains(hit)) return null;
  const bounds = root.getBoundingClientRect();
  if (x < Math.max(0, bounds.left) || x >= Math.min(window.innerWidth, bounds.right)
      || y < Math.max(0, bounds.top) || y >= Math.min(window.innerHeight, bounds.bottom)) return null;
  for (const track of Array.from(root.querySelectorAll<HTMLElement>('[data-edge-scroll]'))) {
    if (!hit.contains(track)) continue;
    const box = track.getBoundingClientRect();
    const left = Math.max(0, box.left + track.clientLeft);
    const right = Math.min(window.innerWidth, box.left + track.clientLeft + track.clientWidth);
    const top = Math.max(0, box.top + track.clientTop);
    const bottom = Math.min(window.innerHeight, box.top + track.clientTop + track.clientHeight);
    if (right <= left || y < top || y >= bottom || (x >= left && x < right)) continue;
    // Only extend a visible row through its own empty margin, never over a control or another layer.
    if (track.contains(document.elementFromPoint(Math.max(left, Math.min(right - 1, x)), y))) return track;
  }
  return null;
}

// How far the run has eased from its slowest to its fastest, 0 to 1.
export function edgeScrollRamp(scrollingMs: number): number {
  const t = Math.max(0, Math.min(1, scrollingMs / N.EDGE_SCROLL_RAMP_MS));
  return t * t;
}

export function edgeScrollSpeed(scrollingMs: number): number {
  const min = N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND;
  return min + (N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND - min) * edgeScrollRamp(scrollingMs);
}

export function installEdgeScroll(
  onScroll: (track: HTMLElement) => void,
  onStop: () => void = () => {},
): () => void {
  let edge: Edge | null = null;
  let frame: number | null = null;
  let enteredAt = 0;
  let lastFrame = 0;
  let screenX: number | null = null;
  let screenY: number | null = null;
  let parked: Edge | null = null;
  let parkTimer: number | null = null;
  let parkedAt = 0;
  let parkedRan = 0;
  let handed = false;
  // An edge the resting pointer is on that could not step yet, as the
  // timeline's past from its present page; only it may start on a recheck.
  let dormant: Edge | null = null;

  const unpark = (): void => {
    if (parkTimer !== null) clearTimeout(parkTimer);
    parkTimer = null;
    parked = null;
  };

  const stop = (): void => {
    const was = edge;
    unpark();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    edge = null;
    if (!was) return;
    scrollerOf(was.track).stop?.();
    onStop();
  };

  const edgeAtPointer = (atEnd = false): Edge | null => {
    if (InputMode.current !== 'pointer' || document.hidden) return null;
    const point = Focus.pointerPosition();
    const keys = Focus.owner();
    // The tab bar holds the keys only until the pointer works the content below it.
    const owner = keys && keys.tier === Tier.bar ? Focus.ownerWithout(keys) : keys;
    const root = owner?.root();
    if (!point || !owner || !root) return null;
    const track = edgeScrollTrackAt(root, point.x, point.y);
    if (!track) return null;
    const at = scrollerOf(track).edgeAt(point.x, point.y, atEnd);
    return at ? { track, owner, axis: at.axis, direction: at.direction } : null;
  };

  const sameEdge = (a: Edge | null, b: Edge | null): boolean => !!a && !!b && a.track === b.track
    && a.owner === b.owner && a.axis === b.axis && a.direction === b.direction;

  const tick = (now: number): void => {
    frame = null;
    if (!edge || !sameEdge(edge, edgeAtPointer(true))) {
      stop();
      return;
    }
    if (now - enteredAt >= N.EDGE_SCROLL_DWELL_MS) {
      // A rAF timestamp may precede the clock read that started the run.
      const elapsed = Math.max(0, Math.min(now - lastFrame, 50));
      const track = edge.track;
      const ran = now - enteredAt - N.EDGE_SCROLL_DWELL_MS;
      const step = scrollerOf(track).scroll(
        edge.axis,
        edge.direction,
        edgeScrollSpeed(ran) * elapsed / 1000,
        edgeScrollRamp(ran),
        elapsed,
      );
      if (step === 'end') {
        const end = edge;
        const ran = performance.now() - enteredAt;
        stop();
        dormant = end;
        // Only content loading after the end can grow a track.
        if (end.direction > 0) park(end, ran);
        return;
      }
      if (step === 'moved') {
        if (!handed && Focus.owner() !== edge.owner) {
          handed = true;
          track.dispatchEvent(new CustomEvent('nav:edge-scroll', { bubbles: true }));
        }
        onScroll(track);
      }
    }
    lastFrame = now;
    frame = requestAnimationFrame(tick);
  };

  const begin = (next: Edge, since: number): void => {
    edge = next;
    scrollerOf(next.track).start?.();
    handed = false;
    enteredAt = since;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  };

  // Watch a track resting at its end under the pointer, in case it grows.
  // The run's clock stops meanwhile: `ran` is how long it had been on the edge.
  const park = (end: Edge, ran: number): void => {
    parked = end;
    parkedRan = ran;
    parkedAt = performance.now();
    const poll = (): void => {
      parkTimer = null;
      if (!parked) return;
      const next = edgeAtPointer();
      if (sameEdge(parked, next)) {
        resume(next as Edge);
        return;
      }
      if (performance.now() - parkedAt >= N.EDGE_SCROLL_PARK_MS) {
        unpark();
        return;
      }
      parkTimer = window.setTimeout(poll, N.EDGE_SCROLL_PARK_POLL_MS);
    };
    parkTimer = window.setTimeout(poll, N.EDGE_SCROLL_PARK_POLL_MS);
  };

  const resume = (next: Edge): void => {
    const ran = parkedRan;
    unpark();
    begin(next, performance.now() - ran);
  };

  const onMove = (event: MouseEvent): void => {
    const moved = screenX !== null && (event.screenX !== screenX || event.screenY !== screenY);
    screenX = event.screenX;
    screenY = event.screenY;
    // Content moving beneath a resting cursor fires synthetic mousemoves.
    if (!moved) return;
    if (event.buttons) {
      halt();
      return;
    }
    const next = edgeAtPointer();
    if (sameEdge(edge, next)) return;
    const end = next ? null : edgeAtPointer(true);
    dormant = end;
    // The run reaching its end parks from its own frame, keeping its speed.
    if (sameEdge(edge, end)) return;
    if (parked && sameEdge(parked, next ?? end)) {
      if (next) resume(next);
      return;
    }
    stop();
    // A pointer arriving at an end starts over with a dwell if the track grows.
    if (end && end.direction > 0) park(end, 0);
    if (!next) return;
    begin(next, performance.now());
  };
  recheck = (): void => {
    if (edge || parked || !dormant) return;
    const next = edgeAtPointer();
    if (!sameEdge(dormant, next)) return;
    dormant = null;
    begin(next as Edge, performance.now());
  };
  // The user stopped it: nothing starts again until the pointer really moves.
  const halt = (): void => {
    dormant = null;
    stop();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.keyCode !== CONFIG.KEYS.CURSOR_SHOW) halt();
  };
  const onCursor = (event: Event): void => {
    if ((event as CustomEvent<{ visibility?: boolean } | null>).detail?.visibility === false) halt();
  };
  const unsubscribe = InputMode.onChange(mode => {
    if (mode === 'keys') halt();
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', halt, true);
  document.addEventListener('click', halt, true);
  document.addEventListener('wheel', halt, true);
  document.addEventListener('cursorStateChange', onCursor);
  document.addEventListener('visibilitychange', halt);
  document.documentElement.addEventListener('mouseleave', halt);
  window.addEventListener('blur', halt);

  return () => {
    stop();
    recheck = null;
    unsubscribe();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', halt, true);
    document.removeEventListener('click', halt, true);
    document.removeEventListener('wheel', halt, true);
    document.removeEventListener('cursorStateChange', onCursor);
    document.removeEventListener('visibilitychange', halt);
    document.documentElement.removeEventListener('mouseleave', halt);
    window.removeEventListener('blur', halt);
  };
}
