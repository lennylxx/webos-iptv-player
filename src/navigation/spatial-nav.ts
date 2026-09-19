import type { NavDirection } from '../types';

interface Candidate {
  el: HTMLElement;
  rect: DOMRect;
  container: Element | null;
}

export class SpatialNav {
  private container: HTMLElement;
  private onFocusChange?: (el: HTMLElement | null) => void;
  private restrictRoot: HTMLElement | null = null;
  private visibilityCache = new WeakMap<HTMLElement, boolean>();
  private readonly visibilityObserver: MutationObserver;
  private readonly stylesheetObserver: MutationObserver;
  // Per-container memory for `data-nav-enter="last-focused"`: re-entering a
  // container returns to where focus left it instead of the nearest edge item.
  private lastFocusedIn = new Map<HTMLElement, HTMLElement>();
  focused: HTMLElement | null = null;

  constructor(container: HTMLElement, onFocusChange?: (el: HTMLElement | null) => void) {
    this.container = container;
    this.onFocusChange = onFocusChange;
    this.visibilityObserver = new MutationObserver((records) => {
      if (records.some((record) => this.mutationAffectsVisibility(record))) {
        this.visibilityCache = new WeakMap();
      }
    });
    this.visibilityObserver.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    this.stylesheetObserver = new MutationObserver(() => {
      this.visibilityCache = new WeakMap();
    });
    this.stylesheetObserver.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['media', 'disabled', 'href'],
    });
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
    this.visibilityCache = new WeakMap();
  }

  private getFocusables(): HTMLElement[] {
    return Array.from(this.root().querySelectorAll<HTMLElement>('[data-focusable]'));
  }

  // Collapsed/display-none elements have no measurable box, while inherited
  // visibility:hidden keeps its geometry and must be checked separately.
  private isNavigable(c: Candidate): boolean {
    if (c.rect.width <= 0 || c.rect.height <= 0) return false;
    const cached = this.visibilityCache.get(c.el);
    if (cached !== undefined) return cached;
    const visible = getComputedStyle(c.el).visibility !== 'hidden';
    this.visibilityCache.set(c.el, visible);
    return visible;
  }

  private getCandidates(
    elements = this.getFocusables(),
    fallback = true,
    container?: HTMLElement,
  ): Candidate[] {
    const all: Candidate[] = [];
    for (const el of elements) {
      const candidateContainer = el.closest('[data-nav-container]');
      if (container && candidateContainer !== container) continue;
      all.push({
        el,
        rect: el.getBoundingClientRect(),
        container: candidateContainer,
      });
    }
    const navigable = all.filter((c) => this.isNavigable(c));
    // Everything measuring zero means the subtree isn't laid out yet (a view
    // still hidden when focus is seeded). Fall back to the unfiltered list so
    // focus lands somewhere rather than nowhere.
    return navigable.length || !fallback ? navigable : all;
  }

  private mutationAffectsVisibility(record: MutationRecord): boolean {
    if (record.type === 'childList') return true;
    if (record.attributeName === 'class') {
      const target = record.target as Element;
      return this.visibilityClasses(record.oldValue)
        !== this.visibilityClasses(target.getAttribute('class'));
    }
    if (record.attributeName === 'style') {
      const target = record.target as Element;
      return this.inlineVisibility(record.oldValue)
        !== this.inlineVisibility(target.getAttribute('style'));
    }
    return true;
  }

  private visibilityClasses(value: string | null): string {
    return (value ?? '').split(/\s+/)
      .filter((name) => name && name !== 'focused')
      .sort()
      .join(' ');
  }

  private inlineVisibility(value: string | null): string {
    const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(value ?? '');
    const visibility = /(?:^|;)\s*visibility\s*:\s*([^;]+)/i.exec(value ?? '');
    return `${display?.[1].trim().toLowerCase() ?? ''}|${
      visibility?.[1].trim().toLowerCase() ?? ''
    }`;
  }

  private findBest(
    candidates: Candidate[],
    current: Candidate,
    direction: NavDirection,
  ): { candidate: Candidate | null; score: number } {
    const rect = current.rect;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const currentContainer = current.container;
    let best: Candidate | null = null;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      if (candidate.el === current.el) continue;

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

      const sameContainer = candidate.container === currentContainer;
      const score = primary + secondary * 3 + (sameContainer ? 0 : 5000);

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return { candidate: best, score: bestScore };
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

  focusContainerEntry(selector: string): boolean {
    const container = this.root().querySelector<HTMLElement>(selector);
    if (!container) return false;
    const elements = Array.from(
      container.querySelectorAll<HTMLElement>('[data-focusable]'),
    );
    const candidates = this.getCandidates(elements, true, container);
    if (!candidates.length) return false;
    const remembered = this.lastFocusedIn.get(container);
    const target = remembered && candidates.some(candidate => candidate.el === remembered)
      ? remembered
      : candidates[0].el;
    this.focus(target);
    return true;
  }

  move(direction: NavDirection): boolean {
    const root = this.root();
    const focusedContainer = this.focused?.closest<HTMLElement>('[data-nav-container]');
    if (this.focused && root.contains(this.focused) && focusedContainer
        && root.contains(focusedContainer)) {
      const sameElements = Array.from(
        focusedContainer.querySelectorAll<HTMLElement>('[data-focusable]'),
      );
      const sameCandidates = this.getCandidates(sameElements, false, focusedContainer);
      const current = sameCandidates.find((c) => c.el === this.focused);
      if (current) {
        const same = this.findBest(sameCandidates, current, direction);
        // A cross-container candidate always pays at least 5000, so a nearer
        // same-container result cannot be displaced by the full-view scan.
        if (same.candidate && same.score <= 5000) {
          this.focus(same.candidate.el);
          return true;
        }
      }
    }

    const candidates = this.getCandidates();
    if (!candidates.length) return false;

    const current = candidates.find((c) => c.el === this.focused);
    if (!this.focused || !current) {
      this.focus(candidates[0].el);
      return true;
    }
    this.focused.classList.add('focused');

    const best = this.findBest(candidates, current, direction).candidate;

    if (best) {
      this.focus(this.enterTarget(best, candidates));
      return true;
    }
    return false;
  }
}
