// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CONFIG } from '../config';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { edgeScrollSpeed, installEdgeScroll, recheckEdgeScroll, setEdgeScroller, type EdgeAxis } from './edge-scroll';
import { Focus, Tier, type FocusScope } from './focus-scope';
import { setInputMode } from './input-mode';

const N = CONFIG.NAVIGATION;
let track: HTMLElement;
let root: HTMLElement;
let hit: Element | null;
let owner: FocusScope;
let dispose: () => void;
let scrolled: Mock<(track: HTMLElement) => void>;
let x = 500;
let y = 150;
let screen = 0;

function move(clientX: number, clientY = 150, real = true): void {
  x = clientX;
  y = clientY;
  if (real) screen++;
  Focus.pointer(x, y);
  track.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: x, clientY: y, screenX: screen, screenY: screen,
  }));
}

function wait(ms = N.EDGE_SCROLL_DWELL_MS + 80): void {
  vi.advanceTimersByTime(ms);
}

function start(): void {
  move(1090);
  wait();
  expect(track.scrollLeft).toBeGreaterThan(0);
}

function expectStopped(): void {
  const offset = track.scrollLeft;
  wait(800);
  expect(track.scrollLeft).toBe(offset);
}

beforeEach(() => {
  vi.useFakeTimers();
  Focus.uninstall();
  setInputMode('pointer');
  morph(document.body, html``);
  morph(document.body, html`
    <div data-key="root"><div data-edge-scroll><button data-key="a">Title</button></div></div>
  `);
  root = document.body.firstElementChild as HTMLElement;
  track = root.firstElementChild as HTMLElement;
  hit = track.firstElementChild;
  vi.stubGlobal('innerWidth', 1920);
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 600));
  Object.defineProperties(track, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 4000 },
    clientLeft: { configurable: true, value: 0 },
    clientTop: { configurable: true, value: 0 },
  });
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 100, right: 1100, top: 100, bottom: 300, width: 1000, height: 200,
    x: 100, y: 100, toJSON: () => ({}),
  });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) =>
    window.setTimeout(() => fn(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true, value: () => hit,
  });
  owner = Focus.register({ id: 'edge-test', root });
  Focus.setBase(() => owner);
  scrolled = vi.fn<(track: HTMLElement) => void>();
  dispose = installEdgeScroll(scrolled);
  screen = 0;
  move(500);
});

afterEach(() => {
  dispose();
  Focus.uninstall();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pointer edge scrolling', () => {
  it('waits at the edge before scrolling only that track continuously', () => {
    move(1090);
    wait(N.EDGE_SCROLL_DWELL_MS - 20);
    expect(track.scrollLeft).toBe(0);
    wait(100);
    const first = track.scrollLeft;
    expect(first).toBeGreaterThan(0);
    wait(160);
    expect(track.scrollLeft).toBeGreaterThan(first);
    expect(root.scrollTop).toBe(0);
    expect(root.scrollLeft).toBe(0);
    expect(scrolled).toHaveBeenCalled();
  });

  it('eases from the minimum to the maximum speed over the ramp', () => {
    expect(edgeScrollSpeed(-100)).toBe(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND);
    expect(edgeScrollSpeed(0)).toBe(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND);
    const quarter = edgeScrollSpeed(N.EDGE_SCROLL_RAMP_MS / 4);
    const half = edgeScrollSpeed(N.EDGE_SCROLL_RAMP_MS / 2);
    expect(quarter).toBeGreaterThan(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND);
    expect(half - quarter).toBeLessThan(edgeScrollSpeed(N.EDGE_SCROLL_RAMP_MS) - half);
    expect(edgeScrollSpeed(N.EDGE_SCROLL_RAMP_MS)).toBe(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND);
    expect(edgeScrollSpeed(N.EDGE_SCROLL_RAMP_MS * 3)).toBe(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND);
  });

  it('speeds up the longer the pointer stays and restarts slow after reversing', () => {
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 100_000 });
    const rate = (): number => {
      const from = track.scrollLeft;
      wait(480);
      return Math.abs(track.scrollLeft - from) / 0.48;
    };
    move(1090);
    wait(N.EDGE_SCROLL_DWELL_MS);
    const early = rate();
    expect(early).toBeGreaterThan(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND * 0.8);
    expect(early).toBeLessThan(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND * 1.3);
    move(1080);
    wait(N.EDGE_SCROLL_RAMP_MS);
    const late = rate();
    expect(late).toBeGreaterThan(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND * 0.9);
    expect(late).toBeLessThanOrEqual(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND * 1.05);
    move(110);
    wait(N.EDGE_SCROLL_DWELL_MS);
    expect(rate()).toBeLessThan(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND * 1.3);
  });

  it('cancels a brief pass through the edge', () => {
    move(1090);
    wait(200);
    move(500);
    expectStopped();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('resets the dwell when reversing direction', () => {
    track.scrollLeft = 500;
    start();
    move(110);
    const offset = track.scrollLeft;
    wait(300);
    expect(track.scrollLeft).toBe(offset);
    wait(200);
    expect(track.scrollLeft).toBeLessThan(offset);
  });

  it('keeps running across real movement within the same edge', () => {
    move(1090);
    wait(250);
    move(1085);
    wait(250);
    expect(track.scrollLeft).toBeGreaterThan(0);
  });

  it.each(['left', 'right'])('scrolls from the %s outer gutter of the owning surface', side => {
    vi.spyOn(document, 'elementFromPoint').mockImplementation(px =>
      px >= 100 && px < 1100 ? track : root);
    track.scrollLeft = 500;
    move(side === 'left' ? 1 : 1199);
    wait();
    if (side === 'left') expect(track.scrollLeft).toBeLessThan(500);
    else expect(track.scrollLeft).toBeGreaterThan(500);
    expect(root.scrollLeft).toBe(0);
    expect(root.scrollTop).toBe(0);
  });

  it('keeps the same dwell when moving from the track into its outer gutter', () => {
    vi.spyOn(document, 'elementFromPoint').mockImplementation(px => px < 1100 ? track : root);
    move(1090);
    wait(250);
    move(1199);
    wait(250);
    expect(track.scrollLeft).toBeGreaterThan(0);
  });

  it('stops outside the owning surface instead of extending its gutter indefinitely', () => {
    vi.spyOn(document, 'elementFromPoint').mockImplementation(px => px < 1100 ? track : root);
    start();
    move(1200);
    expectStopped();
  });

  it('does not scroll through a control in the outer gutter', () => {
    const control = document.createElement('button');
    root.appendChild(control);
    vi.spyOn(document, 'elementFromPoint').mockImplementation(px => px < 1100 ? track : control);
    move(1199);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('does not extend a clipped or hidden track into an exposed outer gutter', () => {
    hit = root;
    move(1199);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('does not arm from a synthetic mousemove under a resting cursor', () => {
    move(1090, 150, false);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('stops outside the track or its edge', () => {
    start();
    move(500);
    expectStopped();
    start();
    move(1090, 310);
    expectStopped();
  });

  it.each(['mousedown', 'click', 'wheel'])('stops on %s and requires a real move to restart', event => {
    start();
    track.dispatchEvent(new MouseEvent(event, { bubbles: true }));
    expectStopped();
    move(1090, 150, false);
    expectStopped();
    const offset = track.scrollLeft;
    move(1085);
    wait();
    expect(track.scrollLeft).toBeGreaterThan(offset);
  });

  it.each([CONFIG.KEYS.RIGHT, CONFIG.KEYS.CURSOR_HIDE])('stops on control key %i', keyCode => {
    start();
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode, bubbles: true }));
    expectStopped();
  });

  it('stops when the keys take over without a DOM key event', () => {
    start();
    setInputMode('keys');
    expectStopped();
  });

  it('ignores the cursor-show key', () => {
    start();
    const offset = track.scrollLeft;
    document.dispatchEvent(new KeyboardEvent('keydown', {
      keyCode: CONFIG.KEYS.CURSOR_SHOW, bubbles: true,
    }));
    wait(100);
    expect(track.scrollLeft).toBeGreaterThan(offset);
  });

  it.each(['event', 'position'])('stops when the cursor hides through %s', method => {
    start();
    if (method === 'event') {
      document.dispatchEvent(new CustomEvent('cursorStateChange', { detail: { visibility: false } }));
    } else Focus.pointerGone();
    expectStopped();
  });

  it.each(['blur', 'visibilitychange', 'mouseleave'])('stops on %s', event => {
    start();
    const target = event === 'blur' ? window : event === 'mouseleave' ? document.documentElement : document;
    target.dispatchEvent(new Event(event));
    expectStopped();
  });

  it('stops when a prompt takes ownership and does not resume when it closes', () => {
    start();
    const prompt = document.createElement('div');
    root.appendChild(prompt);
    const scope = Focus.register({ id: 'edge-prompt', root: prompt, restrict: 'self-only' });
    Focus.push(scope);
    expectStopped();
    Focus.pop(scope);
    expectStopped();
    move(1080);
    const offset = track.scrollLeft;
    wait();
    expect(track.scrollLeft).toBeGreaterThan(offset);
  });

  it('does not scroll the base view while an unrelated nonmodal owner is active', () => {
    const overlay = document.createElement('div');
    root.appendChild(overlay);
    Focus.push(Focus.register({ id: 'edge-overlay', root: overlay }));
    move(1090);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('cancels a pending dwell if the owner changes', () => {
    move(1090);
    wait(200);
    const scope = Focus.register({ id: 'edge-other', root: document.createElement('div') });
    Focus.push(scope);
    wait(32);
    Focus.pop(scope);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('stops when a virtualized track is removed instead of following a replacement', () => {
    start();
    track.remove();
    hit = root;
    expectStopped();
  });

  it('requires opt-in, overflow, and a visible unobstructed hit', () => {
    track.removeAttribute('data-edge-scroll');
    move(1090);
    wait();
    expect(track.scrollLeft).toBe(0);
    track.setAttribute('data-edge-scroll', '');
    Object.defineProperty(track, 'scrollWidth', { value: 1000 });
    move(1080);
    wait();
    expect(track.scrollLeft).toBe(0);
    Object.defineProperty(track, 'scrollWidth', { value: 4000 });
    hit = root;
    move(1090);
    wait();
    expect(track.scrollLeft).toBe(0);
  });

  it('clamps to each end and stops without an idle animation loop', () => {
    track.scrollLeft = 2995;
    start();
    wait(100);
    expect(track.scrollLeft).toBe(3000);
    const calls = scrolled.mock.calls.length;
    wait();
    expect(scrolled).toHaveBeenCalledTimes(calls);
    wait(N.EDGE_SCROLL_PARK_MS);
    expect(vi.getTimerCount()).toBe(0);
    track.scrollLeft = 5;
    move(110);
    wait();
    expect(track.scrollLeft).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expectStopped();
  });

  function scrollToEndAtSpeed(): void {
    move(1090);
    wait(N.EDGE_SCROLL_DWELL_MS + N.EDGE_SCROLL_RAMP_MS + 600);
    expect(track.scrollLeft).toBe(3000);
  }

  function grow(): void {
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 100_000 });
  }

  function progressIn(ms: number): number {
    const from = track.scrollLeft;
    wait(ms);
    return track.scrollLeft - from;
  }

  it('resumes at speed when a track that reached its end grows under the resting pointer', () => {
    scrollToEndAtSpeed();
    wait(2000);
    grow();
    wait(N.EDGE_SCROLL_PARK_POLL_MS + 40);
    expect(track.scrollLeft).toBeGreaterThan(3000);
    expect(progressIn(160)).toBeGreaterThan(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND * 0.12);
  });

  it('keeps the speed when the pointer jitters on a parked edge as the track grows', () => {
    scrollToEndAtSpeed();
    wait(400);
    grow();
    move(1091);
    wait(48);
    expect(track.scrollLeft).toBeGreaterThan(3000);
    expect(progressIn(160)).toBeGreaterThan(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND * 0.12);
  });

  it('keeps the speed when the pointer moves in the frame that reaches the end', () => {
    move(1090);
    while (track.scrollLeft < 3000) wait(16);
    move(1091);
    wait(400);
    grow();
    wait(N.EDGE_SCROLL_PARK_POLL_MS + 40);
    expect(progressIn(160)).toBeGreaterThan(N.EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND * 0.12);
  });

  it('never steps back when a frame timestamp precedes the resume', () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) =>
      window.setTimeout(() => fn(performance.now() - 30), 16));
    scrollToEndAtSpeed();
    wait(400);
    grow();
    let lowest = track.scrollLeft;
    for (let i = 0; i < N.EDGE_SCROLL_PARK_POLL_MS + 100; i++) {
      wait(1);
      lowest = Math.min(lowest, track.scrollLeft);
    }
    expect(lowest).toBe(3000);
    expect(track.scrollLeft).toBeGreaterThan(3000);
  });

  it('starts slow after a dwell when a track grows under a pointer that arrived at its end', () => {
    track.scrollLeft = 3000;
    move(1090);
    wait(N.EDGE_SCROLL_RAMP_MS);
    grow();
    wait(N.EDGE_SCROLL_DWELL_MS - 40);
    expect(track.scrollLeft).toBe(3000);
    wait(N.EDGE_SCROLL_PARK_POLL_MS + 100);
    expect(track.scrollLeft).toBeGreaterThan(3000);
    expect(progressIn(160)).toBeLessThan(N.EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND * 0.2);
  });

  it('dwells again before resuming a grown track the pointer left and came back to', () => {
    track.scrollLeft = 2995;
    start();
    wait(100);
    expect(track.scrollLeft).toBe(3000);
    move(500);
    move(1090);
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 8000 });
    wait(N.EDGE_SCROLL_DWELL_MS - 40);
    expect(track.scrollLeft).toBe(3000);
    wait(200);
    expect(track.scrollLeft).toBeGreaterThan(3000);
  });

  it('does not resume a grown track once the pointer has left its edge', () => {
    track.scrollLeft = 2995;
    start();
    wait(100);
    move(500);
    Object.defineProperty(track, 'scrollWidth', { configurable: true, value: 8000 });
    expectStopped();
  });

  it('scrolls the content under the tab bar and asks the bar for the keys once', () => {
    const barRoot = document.createElement('div');
    document.body.appendChild(barRoot);
    const bar = Focus.register({ id: 'edge-bar', root: barRoot, tier: Tier.bar, restrict: 'self-first' });
    Focus.push(bar);
    const asked = vi.fn();
    root.addEventListener('nav:edge-scroll', asked);
    move(1090);
    wait();
    expect(track.scrollLeft).toBeGreaterThan(0);
    wait(200);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalled();
  });

  it('overrides CSS smooth scrolling only while writing each offset', () => {
    track.style.setProperty('scroll-behavior', 'smooth');
    const write = vi.fn();
    let offset = 0;
    Object.defineProperty(track, 'scrollLeft', {
      configurable: true,
      get: () => offset,
      set: (next: number) => {
        write(track.style.getPropertyValue('scroll-behavior'));
        offset = next;
      },
    });
    start();
    expect(write).toHaveBeenCalledWith('auto');
    expect(track.style.getPropertyValue('scroll-behavior')).toBe('smooth');
  });

  it('disposes listeners and the pending frame', () => {
    start();
    dispose();
    expectStopped();
    move(1080);
    expectStopped();
  });
});

describe('custom edge scrollers', () => {
  // A scroller with a bottom edge that has `room` steps left.
  const custom = (room: number) => {
    const steps: [EdgeAxis, number][] = [];
    const start = vi.fn<() => void>();
    setEdgeScroller(track, {
      edgeAt: (_x, py, atEnd) => (py >= 280 && (atEnd || steps.length < room) ? { axis: 'y', direction: 1 } : null),
      scroll: (axis, direction) => {
        if (steps.length >= room) return 'end';
        steps.push([axis, direction]);
        return 'moved';
      },
      start,
    });
    return { steps, start };
  };

  it('drives a registered scroller from its own edges, not scrollLeft', () => {
    const { steps, start } = custom(3);
    move(500, 290);
    wait(N.EDGE_SCROLL_DWELL_MS - 20);
    expect(steps).toEqual([]);
    wait(100);

    expect(start).toHaveBeenCalledOnce();
    expect(steps[0]).toEqual(['y', 1]);
    expect(scrolled).toHaveBeenCalledWith(track);
    expect(track.scrollLeft).toBe(0);
    wait(800);
    expect(steps).toHaveLength(3);
  });

  it('stops a registered scroller as the pointer leaves its edge', () => {
    const { steps } = custom(1000);
    move(500, 290);
    wait();
    expect(steps.length).toBeGreaterThan(0);
    move(500, 200);
    const count = steps.length;
    wait(800);
    expect(steps).toHaveLength(count);
  });

  it('starts a run with its dwell when an edge opens under a resting pointer, once rechecked', () => {
    let open = false;
    let steps = 0;
    setEdgeScroller(track, {
      // A backward edge: a forward one parks and polls for growth by itself.
      edgeAt: (_x, py, atEnd) => (py >= 280 && (open || atEnd) ? { axis: 'y', direction: -1 } : null),
      scroll: () => {
        steps++;
        return 'moved';
      },
    });
    move(500, 290);
    wait(800);
    expect(steps).toBe(0);

    open = true;
    wait(800);
    expect(steps).toBe(0);
    recheckEdgeScroll();
    wait(N.EDGE_SCROLL_DWELL_MS - 20);
    expect(steps).toBe(0);
    wait(100);
    expect(steps).toBeGreaterThan(0);
  });

  it('starts nothing on a recheck after a click stopped the run under a resting pointer', () => {
    const { steps } = custom(1000);
    move(500, 290);
    wait();
    expect(steps.length).toBeGreaterThan(0);

    track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500, clientY: 290 }));
    const count = steps.length;
    wait(60_000);
    recheckEdgeScroll();
    wait(1000);
    expect(steps).toHaveLength(count);
  });
});

describe('rechecking native tracks', () => {
  it('leaves a track a click stopped still on a recheck', () => {
    start();
    track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    const offset = track.scrollLeft;
    wait(60_000);
    recheckEdgeScroll();
    wait(1000);
    expect(track.scrollLeft).toBe(offset);
  });
});

