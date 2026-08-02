export type VirtualScrollAxis = 'horizontal' | 'vertical';

interface ExpectedScroll {
  axis: VirtualScrollAxis;
  offset: number;
  token: number;
}

export class VirtualScrollGuard {
  private readonly expected = new WeakMap<HTMLElement, ExpectedScroll>();
  private nextToken = 0;

  readUserOffset(element: HTMLElement, axis: VirtualScrollAxis): number | null {
    const expected = this.expected.get(element);
    if (expected?.axis === axis) {
      this.writeOffset(element, axis, expected.offset);
      return null;
    }
    return this.readOffset(element, axis);
  }

  syncOffset(element: HTMLElement, axis: VirtualScrollAxis, offset: number): void {
    const safeOffset = Math.max(0, offset);
    if (this.readOffset(element, axis) === safeOffset) return;
    const state = {
      axis,
      offset: safeOffset,
      token: ++this.nextToken,
    };
    this.expected.set(element, state);
    this.writeOffset(element, axis, safeOffset);
    requestAnimationFrame(() => {
      if (this.expected.get(element)?.token !== state.token) return;
      this.writeOffset(element, axis, safeOffset);
      requestAnimationFrame(() => {
        if (this.expected.get(element)?.token === state.token) {
          this.expected.delete(element);
        }
      });
    });
  }

  private readOffset(element: HTMLElement, axis: VirtualScrollAxis): number {
    return axis === 'horizontal' ? element.scrollLeft : element.scrollTop;
  }

  private writeOffset(element: HTMLElement, axis: VirtualScrollAxis, offset: number): void {
    if (axis === 'horizontal') element.scrollLeft = offset;
    else element.scrollTop = offset;
  }
}
