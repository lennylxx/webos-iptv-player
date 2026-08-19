// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpatialNav } from './spatial-nav';

// jsdom implements no layout: scrollIntoView is missing and getBoundingClientRect
// returns zeros. Stub both so focus()/move() can be exercised deterministically.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function focusable(rect: { x: number; y: number; w?: number; h?: number }, container?: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-focusable', '');
  if (container) el.setAttribute('data-nav-container', container);
  const { x, y, w = 100, h = 40 } = rect;
  el.getBoundingClientRect = () =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect;
  return el;
}

function makeContainer(...els: HTMLElement[]): HTMLElement {
  const container = document.createElement('div');
  els.forEach((el) => container.appendChild(el));
  document.body.appendChild(container);
  return container;
}

describe('SpatialNav', () => {
  describe('focus', () => {
    it('adds the "focused" class and moves it off the previous element', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));

      nav.focus(a);
      expect(a.classList.contains('focused')).toBe(true);
      expect(nav.focused).toBe(a);

      nav.focus(b);
      expect(a.classList.contains('focused')).toBe(false);
      expect(b.classList.contains('focused')).toBe(true);
      expect(nav.focused).toBe(b);
    });

    it('skips scrollIntoView when re-focusing the already-focused element', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      expect(a.scrollIntoView).toHaveBeenCalledTimes(1);
      nav.focus(a); // e.g. mouseover sweeping across the row's children
      expect(a.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('re-asserts the focused class on the same element (morph may strip it)', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      a.classList.remove('focused'); // morph treats class as authoritative
      nav.focus(a);
      expect(a.classList.contains('focused')).toBe(true);
    });

    it('clearHighlight removes the class but keeps focused, and re-focus restores it', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      nav.clearHighlight();
      expect(a.classList.contains('focused')).toBe(false);
      expect(nav.focused).toBe(a); // kept for d-pad/hover resume
      nav.focus(a); // cursor returns to the same element
      expect(a.classList.contains('focused')).toBe(true);
    });

    it('focus(null) clears the current focus', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);
      nav.focus(null);
      expect(a.classList.contains('focused')).toBe(false);
      expect(nav.focused).toBeNull();
    });

    it('focusFirst focuses the first focusable element', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focusFirst();
      expect(nav.focused).toBe(a);
    });

    it('focusBySelector focuses a matching element', () => {
      const a = focusable({ x: 0, y: 0 });
      a.id = 'target';
      const nav = new SpatialNav(makeContainer(a));
      nav.focusBySelector('#target');
      expect(nav.focused).toBe(a);
    });
  });

  describe('nav:hover', () => {
    it('focuses a focusable element when it receives nav:hover', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(nav.focused).toBe(a);
    });

    it('clears only the visual highlight when the pointer leaves', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      nav.focus(a);

      a.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      expect(a.classList.contains('focused')).toBe(false);
      expect(nav.focused).toBe(a);
    });
  });

  describe('move', () => {
    it('focuses the first element when nothing is focused yet', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.move('down');
      expect(nav.focused).toBe(a);
    });

    it('moves down to the geometrically nearest element below', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(top);
      nav.move('down');
      expect(nav.focused).toBe(bottom);
    });

    it('moves up to the element above', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(bottom);
      nav.move('up');
      expect(nav.focused).toBe(top);
    });

    it('moves right to the element to the right', () => {
      const left = focusable({ x: 0, y: 0 });
      const right = focusable({ x: 200, y: 0 });
      const nav = new SpatialNav(makeContainer(left, right));
      nav.focus(left);
      nav.move('right');
      expect(nav.focused).toBe(right);
    });

    it('does not move when there is no candidate in that direction', () => {
      const top = focusable({ x: 0, y: 0 });
      const bottom = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(top, bottom));
      nav.focus(top);
      nav.move('up'); // nothing above the top element
      expect(nav.focused).toBe(top);
    });

    it('prefers the nearer of two candidates in the same direction', () => {
      const cur = focusable({ x: 0, y: 0 });
      const near = focusable({ x: 0, y: 100 });
      const far = focusable({ x: 0, y: 400 });
      const nav = new SpatialNav(makeContainer(cur, near, far));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(near);
    });

    // Rects are explicit here because jsdom has no layout; a stylesheet-hidden
    // element is proven in e2e/settings.spec.ts and e2e/movies.spec.ts.
    it('ignores zero-sized elements', () => {
      const cur = focusable({ x: 0, y: 0 });
      const collapsed = focusable({ x: 0, y: 100, w: 0, h: 0 });
      const visible = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(cur, collapsed, visible));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(visible);
    });

    it('ignores elements hidden with visibility', () => {
      const cur = focusable({ x: 0, y: 0 });
      const invisible = focusable({ x: 0, y: 100 });
      invisible.style.visibility = 'hidden';
      const visible = focusable({ x: 0, y: 200 });
      const nav = new SpatialNav(makeContainer(cur, invisible, visible));
      nav.focus(cur);
      nav.move('down');
      expect(nav.focused).toBe(visible);
    });

    // focusFirst takes DOM order, not geometry, so a hidden leading element is
    // picked outright — no scoring to save it.
    it('focusFirst skips a hidden leading element', () => {
      const collapsed = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const visible = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(collapsed, visible));
      nav.focusFirst();
      expect(nav.focused).toBe(visible);
    });

    // A view seeded with focus before it is shown measures zero everywhere;
    // filtering all of it out would leave focus nowhere.
    it('falls back to unmeasured elements when nothing has been laid out', () => {
      const a = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const b = focusable({ x: 0, y: 0, w: 0, h: 0 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focusFirst();
      expect(nav.focused).toBe(a);
    });
  });

  describe('setRestrict', () => {
    function makeRestricted(): {
      nav: SpatialNav; outside: HTMLElement; inside: HTMLElement; dialog: HTMLElement;
    } {
      const outside = focusable({ x: 0, y: 0 });
      const dialog = document.createElement('div');
      const inside = focusable({ x: 0, y: 100 });
      const other = focusable({ x: 0, y: 200 });
      dialog.appendChild(inside);
      dialog.appendChild(other);
      const container = makeContainer(outside, dialog);
      return { nav: new SpatialNav(container), outside, inside, dialog };
    }

    it('keeps d-pad inside the restricted subtree', () => {
      const { nav, inside, dialog } = makeRestricted();
      nav.focus(inside);
      nav.setRestrict(dialog);
      expect(nav.move('up')).toBe(false); // the element above is outside
      expect(nav.focused).toBe(inside);
    });

    // One keypress is one step: entering the trap must land on its first
    // element, not enter and then move off it.
    it('enters at the first element when focus was outside', () => {
      const { nav, outside, inside, dialog } = makeRestricted();
      nav.focus(outside);
      nav.setRestrict(dialog);
      expect(nav.focused).toBe(outside);
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(inside);
    });

    it('releases the trap on null', () => {
      const { nav, outside, inside, dialog } = makeRestricted();
      nav.focus(inside);
      nav.setRestrict(dialog);
      nav.setRestrict(null);
      expect(nav.move('up')).toBe(true);
      expect(nav.focused).toBe(outside);
    });
  });

  describe('data-nav-enter="last-focused"', () => {
    function makeTwoContainers(enterTo?: string): {
      nav: SpatialNav; sidebarTop: HTMLElement; listTop: HTMLElement; listBottom: HTMLElement;
    } {
      const sidebar = document.createElement('div');
      sidebar.setAttribute('data-nav-container', '');
      const sidebarTop = focusable({ x: 0, y: 0 });
      const sidebarBottom = focusable({ x: 0, y: 100 });
      sidebar.appendChild(sidebarTop);
      sidebar.appendChild(sidebarBottom);

      const list = document.createElement('div');
      list.setAttribute('data-nav-container', '');
      if (enterTo) list.setAttribute('data-nav-enter', enterTo);
      const listTop = focusable({ x: 200, y: 0 });
      const listBottom = focusable({ x: 200, y: 100 });
      list.appendChild(listTop);
      list.appendChild(listBottom);

      const container = makeContainer(sidebar, list);
      return { nav: new SpatialNav(container), sidebarTop, listTop, listBottom };
    }

    it('returns to the last focused element when re-entering', () => {
      const { nav, sidebarTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listBottom); // not the geometrically nearest listTop
    });

    it('uses geometry for a container that has not been visited', () => {
      const { nav, sidebarTop, listTop } = makeTwoContainers('last-focused');
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });

    it('does not apply while moving within the same container', () => {
      const { nav, listTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(listTop);
      nav.move('down');
      expect(nav.focused).toBe(listBottom);
    });

    it('stays geometric without the opt-in attribute', () => {
      const { nav, sidebarTop, listTop, listBottom } = makeTwoContainers();
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });

    it('falls back to geometry when the remembered element is gone', () => {
      const { nav, sidebarTop, listTop, listBottom } = makeTwoContainers('last-focused');
      nav.focus(listBottom);
      nav.focus(sidebarTop);
      listBottom.remove();
      nav.move('right');
      expect(nav.focused).toBe(listTop);
    });
  });

  describe('move return value', () => {
    it('returns true when focus moves to a target', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focus(a);
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(b);
    });

    it('returns false at an edge (no target in that direction)', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const nav = new SpatialNav(makeContainer(a, b));
      nav.focus(a);
      nav.clearHighlight();
      expect(nav.move('up')).toBe(false);
      expect(nav.focused).toBe(a);
      expect(a.classList.contains('focused')).toBe(true);
    });

    it('returns true when nothing was focused yet (focuses the first item)', () => {
      const a = focusable({ x: 0, y: 0 });
      const nav = new SpatialNav(makeContainer(a));
      expect(nav.move('down')).toBe(true);
      expect(nav.focused).toBe(a);
    });

    it('returns false when there are no focusables', () => {
      const empty = document.createElement('div');
      document.body.appendChild(empty);
      const nav = new SpatialNav(empty);
      expect(nav.move('down')).toBe(false);
    });
  });

  describe('onFocusChange', () => {
    it('fires with the newly focused element on focus() and move()', () => {
      const a = focusable({ x: 0, y: 0 });
      const b = focusable({ x: 0, y: 100 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a, b), cb);
      nav.focus(a);
      expect(cb).toHaveBeenLastCalledWith(a);
      nav.move('down');
      expect(cb).toHaveBeenLastCalledWith(b);
    });

    it('does not fire when re-focusing the already-focused element', () => {
      const a = focusable({ x: 0, y: 0 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a), cb);
      nav.focus(a);
      cb.mockClear();
      nav.focus(a);
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires on nav:hover over a focusable', () => {
      const a = focusable({ x: 0, y: 0 });
      const cb = vi.fn();
      const nav = new SpatialNav(makeContainer(a), cb);
      a.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(cb).toHaveBeenCalledWith(a);
      expect(nav.focused).toBe(a);
    });
  });
});
