// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    history: [] as string[],
    getSearchHistory: vi.fn((): string[] => []),
    clearSearchHistory: vi.fn((): boolean => true),
  },
}));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));

import { SearchHistoryDropdown } from './search-history-dropdown';
import { SpatialNav } from '../navigation/spatial-nav';
import { Focus } from '../navigation/focus-scope';
import { scopeId } from '../test/scope-id';

const anchor = { right: 1700, bottom: 74, width: 640 };

function mk() {
  const handlers = { onPick: vi.fn(), onCleared: vi.fn(), onReturnToInput: vi.fn(), onDismiss: vi.fn() };
  const dropdown = new SearchHistoryDropdown(handlers);
  const root = document.querySelector<HTMLElement>('.search-history-dropdown')!;
  return { dropdown, handlers, root };
}

const tiles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.search-history-tile')];
// The scope paints the ring on its next reconcile.
const focused = (root: HTMLElement) => {
  Focus.flush();
  return root.querySelector<HTMLElement>('.focused');
};

describe('SearchHistoryDropdown', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Element.prototype.scrollIntoView = vi.fn();
    vi.clearAllMocks();
    storageMock.history = ['Alpha', 'Bravo', '<b>x</b>'];
    storageMock.getSearchHistory.mockImplementation(() => storageMock.history.slice());
    storageMock.clearSearchHistory.mockImplementation(() => { storageMock.history = []; return true; });
  });
  afterEach(() => Focus.uninstall());

  it('hangs the recent searches and a clear button from the search box', () => {
    const { dropdown, root } = mk();
    expect(dropdown.open(anchor)).toBe(true);
    expect(dropdown.isOpen).toBe(true);
    expect(root.classList.contains('hidden')).toBe(false);
    expect(tiles(root).map(tile => tile.textContent)).toEqual(['Alpha', 'Bravo', '<b>x</b>']);
    expect(root.querySelector('.search-history-tile b')).toBeNull();
    const head = root.querySelector('.search-history-head');
    expect(head?.lastElementChild?.matches('[data-history-clear]')).toBe(true);
    expect(head?.lastElementChild?.textContent).toBe('Clear search history');
    const panel = root.querySelector<HTMLElement>('.search-history-panel')!;
    expect(panel.style.top).toBe('86px');
    expect(panel.style.width).toBe('640px');
    expect(root.querySelector('.search-history-scrim')).not.toBeNull();
  });

  it('owns the keys while open and hands them back when it closes', () => {
    const below = Focus.register({ id: scopeId('view.test'), root: document.body });
    Focus.setBase(() => below);
    const { dropdown } = mk();
    dropdown.open(anchor);
    expect(Focus.owner()?.id).toBe('search.history');
    dropdown.handleAction('back');
    expect(dropdown.isOpen).toBe(false);
    expect(Focus.owner()).toBe(below);
  });

  it('logs open, pick, and clear for tv.sh diag without the query text', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { dropdown, root } = mk();
    dropdown.open(anchor);
    tiles(root)[1].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    dropdown.handleAction('select');
    dropdown.open(anchor);
    const clear = root.querySelector<HTMLElement>('[data-history-clear]')!;
    document.elementFromPoint = vi.fn(() => clear);
    clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const lines = spy.mock.calls.map((args) => args.join(' '));
    spy.mockRestore();
    const events = lines.map((l) => l.match(/event=(\S+)/)?.[1]).filter(Boolean);
    expect(events).toEqual([
      'search.history.opened', 'search.history.picked', 'search.history.closed',
      'search.history.opened', 'search.history.click', 'search.history.cleared', 'search.history.closed',
    ]);
    expect(lines.find((l) => l.includes('event=search.history.picked'))).toMatch(/mode=key count=2 items=3/);
    expect(lines.find((l) => l.includes('event=search.history.cleared'))).toMatch(/mode=pointer items=3/);
    expect(lines.join('\n')).not.toMatch(/Alpha|Bravo/);
  });

  it('stays closed without recent searches', () => {
    storageMock.history = [];
    const { dropdown, root } = mk();
    expect(dropdown.open(anchor)).toBe(false);
    expect(dropdown.isOpen).toBe(false);
    expect(root.classList.contains('hidden')).toBe(true);
  });

  it('starts on the first query, not the clear button', () => {
    const { dropdown, root } = mk();
    dropdown.open(anchor);
    expect(dropdown.focusFirst()).toBe(true);
    expect(focused(root)?.textContent).toBe('Alpha');
  });

  it('picks a recent search with OK and closes', () => {
    const { dropdown, handlers } = mk();
    dropdown.open(anchor);
    dropdown.focusFirst();
    dropdown.handleAction('select');
    expect(handlers.onPick).toHaveBeenCalledWith('Alpha');
    expect(dropdown.isOpen).toBe(false);
  });

  it('clears recent searches at once and returns to the box', () => {
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    root.querySelector('[data-history-clear]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    dropdown.handleAction('select');
    expect(storageMock.clearSearchHistory).toHaveBeenCalled();
    expect(handlers.onCleared).toHaveBeenCalled();
    expect(dropdown.isOpen).toBe(false);
  });

  it('keeps recent searches when clearing them fails', () => {
    storageMock.clearSearchHistory.mockReturnValue(false);
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    root.querySelector('[data-history-clear]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(() => dropdown.handleAction('select')).not.toThrow();
    expect(handlers.onCleared).not.toHaveBeenCalled();
    expect(dropdown.isOpen).toBe(true);
  });

  // Regression: Back on a recent search used to leave Search for Live.
  it('closes on Back and hands focus back to the search box', () => {
    const { dropdown, handlers } = mk();
    dropdown.open(anchor);
    dropdown.focusFirst();
    dropdown.handleAction('back');
    expect(dropdown.isOpen).toBe(false);
    expect(handlers.onReturnToInput).toHaveBeenCalled();
  });

  it('returns to the search box on Up from the top row, staying open', () => {
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    root.querySelector('[data-history-clear]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    dropdown.handleAction('up');
    expect(handlers.onReturnToInput).toHaveBeenCalled();
    expect(dropdown.isOpen).toBe(true);
    expect(focused(root)).toBeNull();
  });

  it('never lands on the clear button when nothing in it is focused yet', () => {
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    for (const action of ['down', 'left', 'right', 'select'] as const) {
      dropdown.open(anchor);
      dropdown.handleAction(action);
      expect(focused(root)).toBe(tiles(root)[0]);
      expect(handlers.onPick).not.toHaveBeenCalled();
      dropdown.close('back');
    }
    dropdown.open(anchor);
    dropdown.handleAction('up');
    expect(handlers.onReturnToInput).toHaveBeenCalledTimes(1);
    expect(focused(root)).toBeNull();
    expect(storageMock.clearSearchHistory).not.toHaveBeenCalled();
  });

  it('goes back to the box when Up from a lower row would reach the clear button', () => {
    storageMock.history = ['Alpha', 'Bravo', 'Charlie'];
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    const [, , third] = tiles(root);
    Object.defineProperty(third, 'offsetTop', { configurable: true, value: 60 });
    const clear = root.querySelector<HTMLElement>('[data-history-clear]')!;
    // An uneven row: geometry scores the clear button above this tile.
    const move = vi.spyOn(SpatialNav.prototype, 'move').mockImplementation(function (this: SpatialNav) {
      this.focus(clear);
      return true;
    });
    third.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    dropdown.handleAction('up');
    move.mockRestore();
    expect(handlers.onReturnToInput).toHaveBeenCalledTimes(1);
    expect(focused(root)).toBeNull();
  });

  it('keeps the focus ring on a tile when it re-anchors', () => {
    const { dropdown, root } = mk();
    dropdown.open(anchor);
    dropdown.focusFirst();
    dropdown.open({ ...anchor, right: 1600 });
    expect(focused(root)).toBe(tiles(root)[0]);
  });

  it('keeps only its scrim up while the account menu is open', () => {
    const { dropdown, root } = mk();
    dropdown.close('account-menu');
    expect(root.classList.contains('hidden')).toBe(true);

    dropdown.open(anchor);
    dropdown.close('account-menu');
    expect(dropdown.isOpen).toBe(false);
    expect(root.classList.contains('hidden')).toBe(false);
    expect(root.classList.contains('search-history-dropdown--menu')).toBe(true);

    dropdown.open(anchor);
    expect(root.classList.contains('search-history-dropdown--menu')).toBe(false);
    dropdown.close('account-menu');
    dropdown.close('view-change');
    expect(root.classList.contains('hidden')).toBe(true);
    expect(root.classList.contains('search-history-dropdown--menu')).toBe(false);
  });

  it('swallows color keys while open', () => {
    const { dropdown, handlers } = mk();
    dropdown.open(anchor);
    dropdown.focusFirst();
    dropdown.handleAction('red');
    expect(dropdown.isOpen).toBe(true);
    expect(handlers.onPick).not.toHaveBeenCalled();
    expect(handlers.onReturnToInput).not.toHaveBeenCalled();
  });

  it('picks a tile on click and leaves search on a click outside the panel', () => {
    const { dropdown, handlers, root } = mk();
    dropdown.open(anchor);
    const bravo = tiles(root)[1];
    const scrim = root.querySelector<HTMLElement>('.search-history-scrim')!;
    let hit: Element = bravo;
    document.elementFromPoint = vi.fn(() => hit);
    bravo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handlers.onPick).toHaveBeenCalledWith('Bravo');

    dropdown.open(anchor);
    hit = scrim;
    scrim.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dropdown.isOpen).toBe(false);
    expect(handlers.onDismiss).toHaveBeenCalled();
    expect(handlers.onReturnToInput).not.toHaveBeenCalled();
  });
});
