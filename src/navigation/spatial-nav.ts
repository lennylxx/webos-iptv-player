import type { NavDirection } from '../types';

export class SpatialNav {
  private container: HTMLElement;
  private onFocusChange?: (el: HTMLElement | null) => void;
  focused: HTMLElement | null = null;

  constructor(container: HTMLElement, onFocusChange?: (el: HTMLElement | null) => void) {
    this.container = container;
    this.onFocusChange = onFocusChange;
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.hasAttribute('data-focusable')) {
        this.focus(target);
      }
    });
  }

  private getFocusables(): HTMLElement[] {
    return Array.from(
      this.container.querySelectorAll<HTMLElement>(
        '[data-focusable]:not(.hidden):not([style*="display: none"])'
      )
    );
  }

  focus(el: HTMLElement | null): void {
    // Already focused: re-assert the class (morph may strip it), skip scroll.
    if (el && el === this.focused) {
      el.classList.add('focused');
      return;
    }
    if (this.focused) this.focused.classList.remove('focused');
    this.focused = el;
    if (el) {
      el.classList.add('focused');
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    this.onFocusChange?.(el);
  }

  /** Remove the visual highlight but keep `focused` so d-pad/hover can re-show it. */
  clearHighlight(): void {
    this.focused?.classList.remove('focused');
  }

  clearDetachedFocus(): void {
    if (this.focused && !this.container.contains(this.focused)) this.focus(null);
  }

  focusFirst(): void {
    const items = this.getFocusables();
    if (items.length) this.focus(items[0]);
  }

  focusBySelector(selector: string): void {
    const el = this.container.querySelector<HTMLElement>(selector);
    if (el) this.focus(el);
  }

  move(direction: NavDirection): boolean {
    const items = this.getFocusables();
    if (!items.length) return false;

    if (!this.focused || !items.includes(this.focused)) {
      this.focus(items[0]);
      return true;
    }

    const rect = this.focused.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let best: HTMLElement | null = null;
    let bestScore = Infinity;

    for (const item of items) {
      if (item === this.focused) continue;

      const r = item.getBoundingClientRect();
      const ix = r.left + r.width / 2;
      const iy = r.top + r.height / 2;

      const dx = ix - cx;
      const dy = iy - cy;

      // Off-axis distance measured as the gap between the rects (0 when they
      // overlap on that axis), not centre-to-centre — so a vertical move can
      // reach a wide or right-aligned item that shares the travel column,
      // rather than always favouring a narrow left-aligned one.
      const gapX = Math.max(r.left - rect.right, rect.left - r.right, 0);
      const gapY = Math.max(r.top - rect.bottom, rect.top - r.bottom, 0);

      let valid = false;
      let primary = 0;
      let secondary = 0;

      switch (direction) {
        case 'up':
          valid = dy < -5;
          primary = Math.abs(dy);
          secondary = gapX;
          break;
        case 'down':
          valid = dy > 5;
          primary = Math.abs(dy);
          secondary = gapX;
          break;
        case 'left':
          valid = dx < -5;
          primary = Math.abs(dx);
          secondary = gapY;
          break;
        case 'right':
          valid = dx > 5;
          primary = Math.abs(dx);
          secondary = gapY;
          break;
      }

      if (!valid) continue;

      const sameContainer =
        item.closest('[data-nav-container]') === this.focused.closest('[data-nav-container]');

      const score = primary + secondary * 3 + (sameContainer ? 0 : 5000);

      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best) {
      this.focus(best);
      return true;
    }
    return false;
  }
}
