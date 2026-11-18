import type { Action, NavDirection } from '../types';
import { CONFIG } from '../config';
import type { FocusScope } from './focus-scope';

interface Candidate {
  el: HTMLElement;
  rect: DOMRect;
  container: Element | null;
}

// The keys that move focus, which a concealed ring spends on showing itself first.
// CH± counts only where the view moves focus with it.
export function isFocusMove(action: Action, channelKeys = false): boolean {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right'
    || (channelKeys && (action === 'channel_up' || action === 'channel_down'));
}

export interface SpatialNavOptions {
  // False for a view that follows the pointer and keeps focus in view itself:
  // the nav then only picks elements geometrically.
  follow?: boolean;
  // The scope that paints the ring for the nav's focus, by `data-key`. The
  // pointer leaving the focused element conceals it, and the next move only
  // shows it again.
  scope?: FocusScope;
  // Hears every focus request, the focused element's own included, for a
  // host that gates the ring itself.
  onRequest?: (el: HTMLElement | null, via: 'key' | 'pointer') => void;
}

const OPPOSITE: Record<NavDirection, NavDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' };

const containerOf = (el: Element | null | undefined): HTMLElement | null =>
  el?.closest<HTMLElement>('[data-nav-container]') ?? null;

const outerContainerOf = (container: HTMLElement): HTMLElement | null =>
  containerOf(container.parentElement);

// A `data-nav-rect` target sits on the grid where its first child does (a
// round action whose name slides out beside it), so the name never moves it.
function navRect(el: HTMLElement): DOMRect {
  return (el.hasAttribute('data-nav-rect') && el.firstElementChild || el).getBoundingClientRect();
}

export class SpatialNav {
  private container: HTMLElement;
  private readonly follow: boolean;
  private readonly scope: FocusScope | null;
  private readonly onRequest?: (el: HTMLElement | null, via: 'key' | 'pointer') => void;
  private onFocusChange?: (el: HTMLElement | null) => void;
  private restrictRoot: HTMLElement | null = null;
  private visibilityCache = new WeakMap<HTMLElement, boolean>();
  private readonly visibilityObserver: MutationObserver;
  private readonly stylesheetObserver: MutationObserver;
  private lastScrollFocusAt = 0;
  // Per-container memory for `data-nav-enter="last-focused"`: re-entering a
  // container returns to where focus left it instead of the nearest edge item.
  private lastFocusedIn = new Map<HTMLElement, HTMLElement>();
  // The last key move into a container marked `data-nav-remember`: the
  // opposite key from where it landed goes back.
  private lastMove: { from: HTMLElement; to: HTMLElement; direction: NavDirection } | null = null;
  // Where focus last sat, to recover near it once a re-render removes the
  // element; null once the view swapped its content.
  private lastRect: DOMRect | null = null;
  // The nav container focus sat in, kept while a re-render detaches the
  // focused element, so its keyed counterpart is sought there first.
  private lastContainer: HTMLElement | null = null;
  // Focus left outside a trap enters it at the first item, not the nearest one.
  private focusInTrap = true;
  focused: HTMLElement | null = null;

  constructor(
    container: HTMLElement,
    onFocusChange?: (el: HTMLElement | null) => void,
    options: SpatialNavOptions = {},
  ) {
    this.container = container;
    this.onFocusChange = onFocusChange;
    this.follow = options.follow !== false;
    this.scope = options.scope ?? null;
    this.onRequest = options.onRequest;
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
    if (!this.follow) return;
    this.container.addEventListener('nav:hover', (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.hasAttribute('data-focusable')) {
        this.focus(target, 'pointer');
      }
    });
    const scope = this.scope;
    if (!scope) return;
    this.container.addEventListener('nav:unhover', (e: Event) => {
      const el = this.focused;
      if (el && e.target === el && scope.focusKey === (el.dataset.key ?? null)) scope.conceal();
    });
  }

  /** Query root: the restricted subtree when one is set, else the whole view. */
  private root(): HTMLElement {
    return this.restrictRoot ?? this.container;
  }

  // The view swapped its content, so focus a re-render removes has no
  // counterpart: the next move starts at the first item.
  resetRecovery(): void {
    this.lastRect = null;
  }

  /**
   * Trap navigation inside `el` (a dialog, menu or picker) so d-pad can't reach
   * the view behind it. Pass null to release. Focus sitting outside the trap is
   * left alone: the move that follows already enters at the first element, so
   * pulling it in here would spend the keypress on a step nobody asked for.
   */
  setRestrict(el: HTMLElement | null): void {
    // Setting the same trap again keeps what recovery knows about a focused
    // element a re-render detached, so the next key still recovers in place.
    const keep = el === this.restrictRoot && !!this.focused && !this.focused.isConnected;
    this.restrictRoot = el;
    if (!keep) this.focusInTrap = !el || (!!this.focused && el.contains(this.focused));
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
        rect: navRect(el),
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
      .filter((name) => name && name !== 'focused' && name !== 'focused-parked')
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
      // Leaving a nested container (a row of buttons inside a row), its
      // enclosing one is nearer than an unrelated container.
      const related = !sameContainer && !!candidate.container && !!currentContainer
        && (candidate.container.contains(currentContainer) || currentContainer.contains(candidate.container));
      const score = primary + secondary * 3 + (sameContainer ? 0 : related ? 2500 : 5000);

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return { candidate: best, score: bestScore };
  }

  focus(el: HTMLElement | null, via: 'key' | 'pointer' = 'key'): void {
    // Any other way focus moves ends what a remembered key move can undo.
    if (el !== this.focused) this.lastMove = null;
    if (el) this.rememberFocus(el);
    // Already focused: skip scroll, but the scope may have hidden the ring,
    // so it hears the request again. A host mirroring focus into its scope
    // hears a re-hover too, which may relight a ring the pointer concealed.
    if (el && el === this.focused) {
      this.request(el, via);
      if (!this.follow || via === 'pointer') this.onFocusChange?.(el);
      return;
    }
    this.focused = el;
    this.lastContainer = el?.closest<HTMLElement>('[data-nav-container]') ?? null;
    this.focusInTrap = !this.restrictRoot || (!!el && this.restrictRoot.contains(el));
    if (el && !this.follow) {
      this.lastRect = navRect(el);
    } else if (el) {
      const now = Date.now();
      const elapsed = now - this.lastScrollFocusAt;
      const repeated = this.lastScrollFocusAt !== 0
        && elapsed >= 0
        && elapsed <= CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;
      this.lastScrollFocusAt = now;
      el.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: repeated ? 'instant' : 'auto',
      });
      this.lastRect = navRect(el);
    } else {
      this.lastScrollFocusAt = 0;
      this.lastRect = null;
    }
    this.request(el, via);
    this.onFocusChange?.(el);
  }

  private request(el: HTMLElement | null, via: 'key' | 'pointer'): void {
    if (this.scope) this.scope.focus(el?.dataset.key ?? null, via);
    this.onRequest?.(el, via);
  }

  // Whether `el` is in the nav's root and could take focus now.
  navigable(el: HTMLElement): boolean {
    return this.root().contains(el) && this.getCandidates([el], false).length > 0;
  }

  private rememberFocus(el: HTMLElement): void {
    const container = el.closest<HTMLElement>('[data-nav-container]');
    if (container) this.lastFocusedIn.set(container, el);
  }

  /**
   * Entering a container marked `data-nav-enter="last-focused"` returns to the
   * element focus left it on, as long as that element is still navigable;
   * one marked `"first"`, entered from its enclosing container, starts at
   * its first navigable element.
   */
  private enterTarget(best: Candidate, candidates: Candidate[]): HTMLElement {
    const container = best.el.closest<HTMLElement>('[data-nav-container]');
    const enter = container?.getAttribute('data-nav-enter');
    if (!container || (enter !== 'last-focused' && enter !== 'first')) return best.el;
    if (this.focused && container.contains(this.focused)) return best.el;
    // `first` is how the enclosing container's own buttons enter it; from
    // anywhere else geometry still picks the way in.
    if (enter === 'first') {
      const outer = outerContainerOf(container);
      if (!this.focused || !outer || !outer.contains(this.focused)) return best.el;
      return candidates.find((c) => c.container === container)?.el ?? best.el;
    }

    const remembered = this.lastFocusedIn.get(container);
    if (!remembered) return best.el;
    if (!candidates.some((c) => c.el === remembered)) {
      // Re-rendered away or no longer navigable — drop the stale reference.
      this.lastFocusedIn.delete(container);
      return best.el;
    }
    return remembered;
  }

  // Where focusFirst() would land, without moving focus.
  first(): HTMLElement | null {
    return this.getCandidates()[0]?.el ?? null;
  }

  focusFirst(): boolean {
    const first = this.first();
    if (!first) return false;
    this.focus(first);
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

  // A re-render replaced the focused element: its keyed counterpart is the
  // same item, already ringed by key, so a move goes on from there. Focus
  // left outside a trap is not the trap's item, whatever its key.
  private adoptReplacement(root: HTMLElement): void {
    const lost = this.focused;
    const key = lost?.dataset.key;
    if (!lost || this.container.contains(lost) || !this.lastRect || key === undefined
        || !this.focusInTrap) return;
    const matches = this.getCandidates(
      Array.from(root.querySelectorAll<HTMLElement>('[data-focusable][data-key]'))
        .filter((el) => el.dataset.key === key),
      false,
    );
    if (!matches.length) return;
    // Another surface may reuse the key (a Search tile and row): the item
    // stays in its own container, else the one nearest where it was wins.
    const container = this.lastContainer;
    const inContainer = container?.isConnected
      ? matches.filter((c) => c.container === container)
      : [];
    const keyed = this.nearest(inContainer.length ? inContainer : matches, this.lastRect).el;
    this.focused = keyed;
    this.lastContainer = keyed.closest<HTMLElement>('[data-nav-container]');
    this.rememberFocus(keyed);
    this.onFocusChange?.(keyed);
  }

  /**
   * A ring the pointer concealed shows on the next move, so a list does not
   * run on from a row the user could not see. Returns true if it did.
   */
  showConcealed(): boolean {
    const root = this.root();
    this.adoptReplacement(root);
    const el = this.focused;
    if (!this.scope?.concealed || !el || this.scope.focusKey !== (el.dataset.key ?? null)
        || !this.navigable(el)) return false;
    this.request(el, 'key');
    this.lastRect = navRect(el);
    return true;
  }

  // Focus was re-rendered away with no keyed counterpart: prefer whatever now
  // sits nearest where it was, instead of restarting at the view's top.
  private replacementFor(candidates: Candidate[]): HTMLElement {
    if (!this.focused || !this.lastRect || !this.focusInTrap) return candidates[0].el;
    return this.nearest(candidates, this.lastRect).el;
  }

  private nearest(candidates: Candidate[], from: DOMRect): Candidate {
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best = candidates[0];
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const r = candidate.rect;
      const distance = Math.pow(r.left + r.width / 2 - fx, 2) + Math.pow(r.top + r.height / 2 - fy, 2);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  move(direction: NavDirection): boolean {
    if (this.showConcealed()) return true;
    const back = this.rememberedSource(direction);
    if (back) {
      this.moveTo(back, direction);
      this.lastMove = null;
      return true;
    }
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
        const same = this.findBest(this.inLane(focusedContainer, sameCandidates, current, direction), current, direction);
        // A same-container result this near stands; only a farther one is
        // weighed against the other containers in the full-view scan.
        if (same.candidate && same.score <= 5000) {
          this.moveTo(same.candidate.el, direction);
          return true;
        }
      }
    }

    const leave = this.leaveTarget(direction);
    if (leave !== undefined) {
      if (leave) this.moveTo(leave, direction);
      return true;
    }

    const candidates = this.getCandidates();
    if (!candidates.length) return false;

    const current = candidates.find((c) => c.el === this.focused);
    if (!this.focused || !current) {
      this.focus(this.replacementFor(candidates));
      return true;
    }
    this.lastRect = current.rect;

    const lane = this.inLane(containerOf(this.focused), candidates, current, direction);
    const best = this.findBest(lane, current, direction).candidate;

    if (best) {
      this.moveTo(this.enterTarget(best, candidates), direction);
      return true;
    }
    return false;
  }

  /**
   * In a `data-nav-straight` container, Left and
   * Right keep to the line: everything inside the container, nested rows
   * too, must share it. Up and Down step to the container's own adjacent line
   * and the element there nearest across; with no line of its own left, the
   * adjacent line beyond (a nested row wrapped below, or the next block)
   * gets the same rule, unless a leave rule says otherwise.
   */
  private inLane(container: HTMLElement | null, candidates: Candidate[], current: Candidate,
    direction: NavDirection): Candidate[] {
    if (!container?.hasAttribute('data-nav-straight')) return candidates;
    const r = current.rect;
    if (direction === 'left' || direction === 'right') {
      return candidates.filter((c) => c === current || !container.contains(c.el)
        || (c.rect.top < r.bottom && c.rect.bottom > r.top));
    }
    const down = direction === 'down';
    const ahead = (c: Candidate) => c !== current && (down ? c.rect.top >= r.bottom - 1 : c.rect.bottom <= r.top + 1);
    const gap = (c: Candidate) => (down ? c.rect.top - r.bottom : r.top - c.rect.bottom);
    const cx = r.left + r.width / 2;
    // Nearest across: the smallest gap (none where it overlaps the column),
    // then the nearest center.
    const apart = (c: Candidate) => Math.max(c.rect.left - r.right, r.left - c.rect.right, 0);
    const center = (c: Candidate) => Math.abs(c.rect.left + c.rect.width / 2 - cx);
    const nearestOnNextLine = (pool: Candidate[]) => {
      const nearest = pool.reduce((a, c) => (gap(c) < gap(a) ? c : a));
      const line = pool.filter((c) => c.rect.top < nearest.rect.bottom && c.rect.bottom > nearest.rect.top);
      return line.reduce((a, c) => (apart(c) < apart(a) || (apart(c) === apart(a) && center(c) < center(a)) ? c : a));
    };
    const own = candidates.filter((c) => c.container === container && ahead(c));
    const others = candidates.filter((c) => c === current || c.container !== container);
    if (own.length) return [...others, nearestOnNextLine(own)];
    const beyond = candidates.filter((c) => c.container !== container && ahead(c));
    return beyond.length ? [current, nearestOnNextLine(beyond)] : [current];
  }

  private moveTo(el: HTMLElement, direction: NavDirection): void {
    const from = this.focused;
    this.focus(el);
    const toContainer = containerOf(el);
    const remember = !!from && containerOf(from) !== toContainer && !!toContainer?.hasAttribute('data-nav-remember');
    this.lastMove = remember ? { from: from!, to: el, direction } : null;
  }

  private rememberedSource(direction: NavDirection): HTMLElement | null {
    const last = this.lastMove;
    if (!last || last.to !== this.focused || direction !== OPPOSITE[last.direction]) return null;
    if (!last.from.isConnected || !this.root().contains(last.from)) return null;
    const [from, to] = this.getCandidates([last.from, last.to], false);
    if (!from || !to || from.el !== last.from) return null;
    // A re-render may have moved it, say a row that wrapped; then it is no
    // longer the way back.
    const dx = from.rect.left + from.rect.width / 2 - (to.rect.left + to.rect.width / 2);
    const dy = from.rect.top + from.rect.height / 2 - (to.rect.top + to.rect.height / 2);
    const ahead = direction === 'up' ? dy < -5 : direction === 'down' ? dy > 5 : direction === 'left' ? dx < -5 : dx > 5;
    return ahead ? last.from : null;
  }

  /**
   * A container may say where a direction leaves it:
   * `data-nav-leave-up=".selector"` goes there, and an
   * empty value keeps focus in place. It applies only once nothing inside the
   * container lies that way; undefined leaves the move to geometry.
   */
  private leaveTarget(direction: NavDirection): HTMLElement | null | undefined {
    const root = this.root();
    for (let container = containerOf(this.focused); container && root.contains(container);
      container = outerContainerOf(container)) {
      const rule = container.getAttribute(`data-nav-leave-${direction}`);
      if (rule === null) continue;
      const inside = this.getCandidates(Array.from(container.querySelectorAll<HTMLElement>('[data-focusable]')), false);
      const current = inside.find((c) => c.el === this.focused);
      if (current && this.findBest(this.inLane(container, inside, current, direction), current, direction).candidate) {
        return undefined;
      }
      if (rule === '') return null;
      const target = root.querySelector<HTMLElement>(rule);
      return target && this.getCandidates([target], false).length ? target : undefined;
    }
    return undefined;
  }
}
