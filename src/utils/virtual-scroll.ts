import { withInstantScroll } from './dom';
import { createLogger } from './logger';

const log = createLogger('VirtualScroll');

export type VirtualScrollAxis = 'horizontal' | 'vertical';

interface ExpectedScroll {
  axis: VirtualScrollAxis;
  offset: number;
  token: number;
  instant: boolean;
  // A smooth scroll the caller waits out: its own events until it lands
  // (or stalls) are not the user's.
  settle: { from: number; until: number } | null;
}

// Longer than Chromium's smooth scroll over a list's viewport.
const SMOOTH_SETTLE_MS = 800;

export class VirtualScrollGuard {
  private readonly expected = new WeakMap<HTMLElement, ExpectedScroll>();
  private nextToken = 0;

  readUserOffset(element: HTMLElement, axis: VirtualScrollAxis): number | null {
    const expected = this.expected.get(element);
    if (expected?.axis === axis && expected.settle) {
      const offset = this.readOffset(element, axis);
      const { from, until } = expected.settle;
      if (Math.abs(offset - expected.offset) < 1) {
        this.expected.delete(element);
        return null;
      }
      const between = offset >= Math.min(from, expected.offset) - 1
        && offset <= Math.max(from, expected.offset) + 1;
      if (between && Date.now() < until) return null;
      this.expected.delete(element);
      return offset;
    }
    if (expected?.axis === axis) {
      this.writeOffset(element, expected);
      return null;
    }
    return this.readOffset(element, axis);
  }

  // `settle`: a smooth scroll stays the caller's until it reaches `offset`,
  // so its in-between offsets never read as user scrolls.
  syncOffset(
    element: HTMLElement,
    axis: VirtualScrollAxis,
    offset: number,
    instant = false,
    settle = false,
  ): void {
    const safeOffset = Math.max(0, offset);
    const current = this.readOffset(element, axis);
    if (current === safeOffset) {
      const expected = this.expected.get(element);
      if (expected && (expected.axis !== axis || expected.offset !== safeOffset)) {
        this.expected.delete(element);
      }
      return;
    }
    const jump = instant || this.needsInstantJump(element, axis, Math.abs(safeOffset - current));
    const state: ExpectedScroll = {
      axis,
      offset: safeOffset,
      token: ++this.nextToken,
      instant: jump,
      settle: settle && !jump ? { from: current, until: Date.now() + SMOOTH_SETTLE_MS } : null,
    };
    this.expected.set(element, state);
    this.writeOffset(element, state);
    if (state.settle) {
      // Writing again mid-scroll would restart its easing; only an element
      // that did not take the offset (still hidden) gets it again.
      requestAnimationFrame(() => {
        if (this.expected.get(element)?.token === state.token && this.readOffset(element, axis) === current) {
          this.writeOffset(element, state);
        }
      });
      return;
    }
    requestAnimationFrame(() => {
      if (this.expected.get(element)?.token !== state.token) return;
      this.writeOffset(element, state);
      requestAnimationFrame(() => {
        if (this.expected.get(element)?.token === state.token) {
          this.expected.delete(element);
        }
      });
    });
  }

  // Apply now an offset still waiting for its frame, such as one a hidden
  // element could not take.
  flush(element: HTMLElement): void {
    const expected = this.expected.get(element);
    if (expected) this.writeOffset(element, expected);
  }

  // Apply a pending offset now and stop guarding it, so a scroll of the
  // caller's own (focus bringing its row into view) is not undone.
  release(element: HTMLElement): void {
    this.flush(element);
    this.expected.delete(element);
  }

  // A smooth scroll past one viewport outlives the guard's frames and crosses
  // offsets whose window is not rendered, so its later events read as user
  // scrolls that re-window the list and drop the focused row.
  private needsInstantJump(element: HTMLElement, axis: VirtualScrollAxis, distance: number): boolean {
    const viewport = axis === 'horizontal' ? element.clientWidth : element.clientHeight;
    if (distance <= viewport) return false;
    if (getComputedStyle(element).getPropertyValue('scroll-behavior') !== 'smooth') return false;
    log.debug('Forcing instant virtual scroll jump', 'event=scroll.jump.instant',
      `axis=${axis}`, `distance=${String(Math.round(distance))}`, `viewport=${String(viewport)}`);
    return true;
  }

  private readOffset(element: HTMLElement, axis: VirtualScrollAxis): number {
    return axis === 'horizontal' ? element.scrollLeft : element.scrollTop;
  }

  private writeOffset(element: HTMLElement, { axis, offset, instant }: ExpectedScroll): void {
    const write = (): void => {
      if (axis === 'horizontal') element.scrollLeft = offset;
      else element.scrollTop = offset;
    };
    if (instant) withInstantScroll([element], write);
    else write();
  }
}
