import type { NavDirection } from '../types';

interface Candidate {
  el: HTMLElement;
  rect: DOMRect;
}

export class SpatialNav {
  private container: HTMLElement;
  private onFocusChange?: (el: HTMLElement | null) => void;
  private restrictRoot: HTMLElement | null = null;
  // Per-container memory for `data-nav-enter="last-focused"`: re-entering a
  // container returns to where focus left it instead of the nearest edge item.
  private lastFocusedIn = new Map<HTMLElement, HTMLElement>();
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
    this.container.addEventListener('nav:unhover', (e: Event) => {
      if (e.target === this.focused) this.clearHighlight();
    });
  }

  /** Query root: the restricted subtree when one is set, else the whole view. */
  private root(): HTMLElement {
    return this.restrictRoot ?? this.container;
  }

  /**
   * Trap navigation inside `el` (a dialog, menu or picker) so d-pad can't reach
   * the view behind it. Pass null to release. Focus sitting outside the trap is
   * left alone: the move that follows already enters at the first element, so
   * pulling it in here would spend the keypress on a step nobody asked for.
   */
  setRestrict(el: HTMLElement | null): void {
    this.restrictRoot = el;
  }

  // Navigable means measurable: an element hidden any way at all — `.hidden`,
  // an inline or stylesheet `display: none`, a hidden ancestor, a collapsed box
  // — reports a zero-sized rect. `visibility` is inherited, so reading it off
  // the element covers ancestors too. jsdom has no layout, so a stylesheet-hidden
  // element is pinned by e2e (`settings`/`movies`), not by unit tests.
  private getFocusables(): HTMLElement[] {
    return Array.from(this.root().querySelectorAll<HTMLElement>('[data-focusable]'));
  }

  private isNavigable(c: Candidate): boolean {
    if (c.rect.width <= 0 || c.rect.height <= 0) return false;
    return getComputedStyle(c.el).visibility !== 'hidden';
  }

  private getCandidates(): Candidate[] {
    const all = this.getFocusables().map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const navigable = all.filter((c) => this.isNavigable(c));
    // Everything measuring zero means the subtree isn't laid out yet (a view
    // still hidden when focus is seeded). Fall back to the unfiltered list so
    // focus lands somewhere rather than nowhere.
    return navigable.length ? navigable : all;
  }

  focus(el: HTMLElement | null): void {
    if (el) this.rememberFocus(el);
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

  private rememberFocus(el: HTMLElement): void {
    const container = el.closest<HTMLElement>('[data-nav-container]');
    if (container) this.lastFocusedIn.set(container, el);
  }

  /**
   * Entering a container marked `data-nav-enter="last-focused"` returns to the
   * element focus left it on, as long as that element is still navigable.
   */
  private enterTarget(best: Candidate, candidates: Candidate[]): HTMLElement {
    const container = best.el.closest<HTMLElement>('[data-nav-container]');
    if (!container || container.getAttribute('data-nav-enter') !== 'last-focused') return best.el;
    if (this.focused && container.contains(this.focused)) return best.el;

    const remembered = this.lastFocusedIn.get(container);
    if (!remembered) return best.el;
    if (!candidates.some((c) => c.el === remembered)) {
      // Re-rendered away or no longer navigable — drop the stale reference.
      this.lastFocusedIn.delete(container);
      return best.el;
    }
    return remembered;
  }

  /** Remove the visual highlight but keep `focused` so d-pad/hover can re-show it. */
  clearHighlight(): void {
    this.focused?.classList.remove('focused');
  }

  clearDetachedFocus(): void {
    if (this.focused && !this.container.contains(this.focused)) this.focus(null);
  }

  focusFirst(): boolean {
    const candidates = this.getCandidates();
    if (!candidates.length) return false;
    this.focus(candidates[0].el);
    return true;
  }

  focusBySelector(selector: string): void {
    const el = this.root().querySelector<HTMLElement>(selector);
    if (el) this.focus(el);
  }

  move(direction: NavDirection): boolean {
    const candidates = this.getCandidates();
    if (!candidates.length) return false;

    const current = candidates.find((c) => c.el === this.focused);
    if (!this.focused || !current) {
      this.focus(candidates[0].el);
      return true;
    }
    this.focused.classList.add('focused');

    const rect = current.rect;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let best: Candidate | null = null;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      if (candidate.el === this.focused) continue;

      const r = candidate.rect;
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
        candidate.el.closest('[data-nav-container]') === this.focused.closest('[data-nav-container]');

      const score = primary + secondary * 3 + (sameContainer ? 0 : 5000);

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (best) {
      this.focus(this.enterTarget(best, candidates));
      return true;
    }
    return false;
  }
}
