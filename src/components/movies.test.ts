// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Action, PlaylistEntry, ResumeEntry, VodItem, WatchlistEntry, WatchlistKind } from '../types';
import type { CatalogSortPreference } from '../utils/catalog-sort';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: { loadVodCategories: vi.fn(), loadVodStreams: vi.fn(), loadVodInfo: vi.fn() },
    watchlistState,
    storageMock: {
      getCatalogSort: vi.fn((): CatalogSortPreference => ({ by: 'default', direction: 'asc' })),
      getHideArabic: vi.fn(() => false),
      setCatalogSort: vi.fn((_kind: 'vod' | 'series', _sort: CatalogSortPreference) => true),
      getResumeList: vi.fn(() => [] as unknown[]),
      getResume: vi.fn((): ResumeEntry | null => null),
      clearResume: vi.fn(),
      getWatchlist: vi.fn(() => watchlistState.entries),
      removeWatchlist: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) => {
        watchlistState.entries = watchlistState.entries.filter(entry => entry.itemId !== itemId);
      }),
      isWatchlisted: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) =>
        watchlistState.entries.some((entry) => entry.itemId === itemId)),
      toggleWatchlist: vi.fn((entry: WatchlistEntry) => {
        const index = watchlistState.entries.findIndex((item) => item.itemId === entry.itemId);
        if (index >= 0) {
          watchlistState.entries.splice(index, 1);
          return 'removed' as const;
        }
        watchlistState.entries.unshift(entry);
        return 'added' as const;
      }),
    },
    toastMock: { showToast: vi.fn() },
  };
});
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Movies } from './movies';
import { Focus, Tier } from '../navigation/focus-scope';
import { FocusRing } from '../navigation/focus-ring';
import { VirtualGrid } from '../utils/virtual-grid';
import { ParentalControlService } from '../services/parental-control';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, name: string, categoryId = '1'): VodItem => ({
  accountId: 'x1', streamId: id, name, poster: '', rating: '', categoryId, containerExtension: 'mp4',
});

let container: HTMLElement;
function eventLines(spy: { mock: { calls: unknown[][] } }, code: string): string[] {
  return spy.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes(`event=${code} `));
}

// A key as the app routes it: the view acts, then the focus scope reconciles.
function pressKey(view: { handleAction(action: Action): void }, action: Action): void {
  document.documentElement.classList.add('keyboard-nav');
  view.handleAction(action);
  Focus.input();
  Focus.flush();
}

beforeEach(() => {
  document.documentElement.classList.remove('keyboard-nav');
  Focus.uninstall();
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // clearAllMocks clears calls but not implementations; re-establish the default
  // return so a prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  storageMock.getCatalogSort.mockReturnValue({ by: 'default', direction: 'asc' });
  storageMock.setCatalogSort.mockReturnValue(true);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], streams = [vod('10', 'Movie One')]) {
  catalogMock.loadVodCategories.mockResolvedValue(cats);
  catalogMock.loadVodStreams.mockResolvedValue(streams);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Movies(container, handlers);
  Focus.setBase(() => view.focusScope);
  await view.open(account);
  return { view, handlers };
}

describe('Movies browse + grid', () => {
  describe('collection management', () => {
    function savedTitles(count: number): void {
      watchlistState.entries = Array.from({ length: count }, (_, i) => ({
        accountId: 'x1', kind: 'vod', itemId: `m${i}`, name: `Title ${i}`,
        poster: '', rating: '', categoryId: '1', containerExtension: 'mp4', addedAt: count - i,
      }));
    }

    it('returns from detail to the same resume title after it moves to the front', async () => {
      const entries = ['10', '11', '12'].map((itemId, i) => ({
        accountId: 'x1', kind: 'vod', itemId, name: `Title ${i}`, poster: '', ext: 'mp4',
        position: 100, duration: 600, updatedAt: 3 - i,
      }));
      storageMock.getResumeList.mockReturnValue(entries);
      catalogMock.loadVodInfo.mockResolvedValue(null);
      const { view } = await openWith();
      container.querySelector<HTMLElement>('[data-collection-manage="continue"]')!.click();
      pressKey(view, 'back');
      const title = container.querySelector<HTMLElement>('.catalog-layer-grid [data-item-id="11"]')!;
      title.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      await Promise.resolve();
      storageMock.getResumeList.mockReturnValue([entries[1], entries[0], entries[2]]);
      pressKey(view, 'back');
      expect(container.querySelector('.catalog-layer-grid .focused')?.getAttribute('data-item-id')).toBe('11');
    });

    it('leaves a managed collection grid where the wheel stops it', async () => {
      savedTitles(80);
      const { view } = await openWith();
      container.querySelector<HTMLElement>('[data-collection-manage="watchlist"]')!.click();
      vi.useFakeTimers();
      try {
        const grid = container.querySelector<HTMLElement>('.catalog-layer-grid .catalog-grid.catalog-managing')!;
        const track = grid.querySelector<HTMLElement>('.catalog-grid-track')!;
        let top = 0;
        Object.defineProperty(grid, 'scrollTop', {
          configurable: true, get: () => top, set: (value: number) => { top = value; },
        });
        Object.defineProperty(grid, 'clientHeight', { value: 900, configurable: true });
        grid.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
        track.getBoundingClientRect = () => ({ top: 180 - top } as DOMRect);
        const reveal = vi.mocked(Element.prototype.scrollIntoView);
        // Wheel steps shorter than half a row, each settling before the next,
        // from above the first row, mid-grid, both ways, and near the end.
        const stops = [80, 160, 240, 320, 240, 400, 700, 620, 1000, 920, 1000, 4300, 4380, 4300];
        for (const stop of stops) {
          top = stop;
          grid.dispatchEvent(new Event('scroll', { bubbles: true }));
          vi.advanceTimersByTime(250);
          expect(top).toBe(stop);
          // The pointer at rest hovers what slid under it; that never scrolls.
          const remove = grid.querySelector<HTMLElement>('[data-collection-action="remove"]')!;
          remove.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
          Focus.flush();
          vi.advanceTimersByTime(250);
          expect(top).toBe(stop);
        }
        expect(reveal).not.toHaveBeenCalled();
        expect(grid.querySelectorAll('.focused')).toHaveLength(1);

        // The D-pad still brings its pick into view.
        top = 80;
        grid.dispatchEvent(new Event('scroll', { bubbles: true }));
        vi.advanceTimersByTime(250);
        grid.querySelector<HTMLElement>('[data-grid-index="0"] [data-collection-action="remove"]')!
          .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
        for (let row = 0; row < 3; row++) pressKey(view, 'down');
        expect(top).toBeGreaterThan(180 + 395);
        expect(grid.querySelectorAll('.focused')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('caps collection previews and opens a counted virtual grid without sorting controls', async () => {
      savedTitles(200);
      const { view } = await openWith();
      const rail = container.querySelector('[data-rail-key="watchlist"]')!;
      expect(rail.querySelectorAll('.catalog-tile:not(.catalog-see-all)')).toHaveLength(20);
      const seeAll = rail.querySelector<HTMLElement>('[data-collection-see-all]')!;
      expect(seeAll.textContent).toContain('200 movies');
      seeAll.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      view.handleAction('select');
      const grid = container.querySelector('.catalog-layer-grid')!;
      expect(grid.querySelector('.catalog-grid-title')?.textContent).toContain('200 movies');
      expect(grid.querySelector('.catalog-sort')).toBeNull();
      expect(grid.querySelectorAll('.catalog-tile').length).toBeLessThan(50);
    });

    it('makes only removal buttons actionable and keeps focus on the surviving neighbor', async () => {
      savedTitles(3);
      const { view } = await openWith();
      const manage = container.querySelector<HTMLElement>('[data-collection-manage="watchlist"]')!;
      expect(manage).not.toBeNull();
      manage.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      const grid = container.querySelector('.catalog-layer-grid')!;
      expect(grid.querySelector('.catalog-tile')?.hasAttribute('data-focusable')).toBe(false);
      const buttons = grid.querySelectorAll<HTMLElement>('[data-collection-action="remove"]');
      expect(buttons).toHaveLength(3);
      buttons[1].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      expect(storageMock.removeWatchlist).toHaveBeenCalledExactlyOnceWith('x1', 'vod', 'm1');
      expect(grid.querySelector('.catalog-remove-mark.focused')?.getAttribute('data-key')).toBe('w:m2');
      pressKey(view, 'back');
      expect(grid.querySelector('.catalog-managing')).toBeNull();
      expect(grid.querySelector('.catalog-sort')).toBeNull();
      pressKey(view, 'back');
      expect(container.querySelector('.catalog-layer-browse')?.classList.contains('catalog-layer-hidden')).toBe(false);
      expect(view.focusScope.focusKey).toBe(JSON.stringify(['browse', 'watchlist', 'manage:watchlist']));
    });

    it('returns to browse with a valid focus after removing the final title', async () => {
      savedTitles(1);
      const { view } = await openWith();
      const manage = container.querySelector<HTMLElement>('[data-collection-manage="watchlist"]')!;
      expect(manage).not.toBeNull();
      manage.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      const remove = container.querySelector<HTMLElement>('[data-collection-action="remove"]')!;
      remove.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      expect(container.querySelector('[data-rail-key="watchlist"]')).toBeNull();
      expect(container.querySelector('.catalog-layer-grid')?.textContent).toBe('');
      expect(container.querySelector('.catalog-layer-browse .focused')).not.toBeNull();
    });

    it.each(['continue', 'watchlist'] as const)(
      'leaves the %s collection after its final title is removed from detail',
      async (kind) => {
        const entry: ResumeEntry = {
          accountId: 'x1', kind: 'vod', itemId: 'm0', name: 'Title 0', poster: '', ext: 'mp4',
          position: 100, duration: 600, updatedAt: 1,
        };
        if (kind === 'watchlist') savedTitles(1);
        else {
          storageMock.getResumeList.mockReturnValue([entry]);
          storageMock.getResume.mockReturnValue(entry);
          storageMock.clearResume.mockImplementationOnce(() => {
            storageMock.getResumeList.mockReturnValue([]);
            storageMock.getResume.mockReturnValue(null);
          });
        }
        catalogMock.loadVodInfo.mockResolvedValue(null);
        const { view } = await openWith();
        container.querySelector<HTMLElement>(`[data-collection-manage="${kind}"]`)!.click();
        pressKey(view, 'back');
        const tile = container.querySelector<HTMLElement>('.catalog-layer-grid .catalog-tile[data-focusable]')!;
        tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
        pressKey(view, 'select');
        await Promise.resolve();
        const remove = container.querySelector<HTMLElement>(
          `[data-action="${kind === 'continue' ? 'remove-resume' : 'watchlist'}"]`,
        )!;
        remove.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
        pressKey(view, 'select');
        if (kind === 'continue') expect(storageMock.clearResume).toHaveBeenCalledWith('x1', 'vod', 'm0');
        else expect(watchlistState.entries).toHaveLength(0);
        pressKey(view, 'back');
        expect(container.querySelector('.catalog-layer-grid')?.textContent).toBe('');
        expect(container.querySelector(`[data-rail-key="${kind}"]`)).toBeNull();
        expect(container.querySelector('.catalog-layer-browse .focused')).not.toBeNull();
      },
    );

    it('counts and clears only visible titles, without revealing or deleting concealed ones', async () => {
      savedTitles(22);
      const concealed = vi.spyOn(ParentalControlService, 'isConcealed').mockImplementation(
        request => request.target.kind === 'vod-item' && request.target.itemId === 'm0');
      try {
        await openWith();
        const rail = container.querySelector('[data-rail-key="watchlist"]')!;
        expect(rail.querySelector('.catalog-see-all-count')?.textContent).toBe('21 movies');
        rail.querySelector<HTMLElement>('[data-collection-manage]')!.click();
        container.querySelector<HTMLElement>('[data-collection-action="clear"]')!.click();
        document.querySelector<HTMLElement>('.confirmation-prompt:not(.hidden) [data-confirm-action="confirm"]')!.click();
        expect(watchlistState.entries.map(entry => entry.itemId)).toEqual(['m0']);
        expect(container.querySelector('[data-rail-key="watchlist"]')).toBeNull();
      } finally {
        concealed.mockRestore();
      }
    });
  });

  describe('catalog sorting', () => {
    const streams = () => [
      { ...vod('10', 'Title 10'), rating: '5', addedAt: 1000, year: 2001 },
      { ...vod('2', 'Title 2'), rating: '9', addedAt: 3000, year: 2003 },
      { ...vod('1', 'Title 1'), rating: '7', addedAt: 2000, year: 2002 },
    ];
    const browse = () => container.querySelector<HTMLElement>('.catalog-layer-browse')!;
    const order = (root = browse()) => Array.from(
      root.querySelectorAll<HTMLElement>('[data-rail-key="cat:1"] .catalog-tile[data-item-id]'),
    ).map(el => el.dataset.itemId);
    function choose(by: string, root = browse()): void {
      root.querySelector<HTMLElement>('.dropdown-trigger')!.click();
      root.querySelector<HTMLElement>(`[data-dropdown-value="${by}"]`)!.click();
    }

    it('keeps server order and hides directions until a field is selected', async () => {
      await openWith(undefined, streams());
      expect(order()).toEqual(['10', '2', '1']);
      expect(browse().querySelector('[role="radiogroup"]')).toBeNull();
    });

    it('sorts the complete category before slicing the preview and restores server order', async () => {
      const items = Array.from({ length: 30 }, (_, i) => vod(String(30 - i), `Title ${30 - i}`));
      const original = items.slice();
      await openWith(undefined, items);
      choose('name');
      expect(order()).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
      expect(items).toEqual(original);
      expect(storageMock.setCatalogSort).toHaveBeenLastCalledWith('vod', { by: 'name', direction: 'asc' });
      choose('default');
      expect(order()).toEqual(original.slice(0, 20).map(item => item.streamId));
      expect(browse().querySelector('[role="radiogroup"]')).toBeNull();
    });

    it('keeps direction selection separate from focus', async () => {
      const { view } = await openWith(undefined, streams());
      choose('name');
      const desc = browse().querySelector<HTMLElement>('[data-sort-direction="desc"]')!;
      const asc = browse().querySelector<HTMLElement>('[data-sort-direction="asc"]')!;
      expect(asc.getAttribute('role')).toBe('radio');
      expect(asc.getAttribute('aria-checked')).toBe('true');
      expect(desc.getAttribute('aria-checked')).toBe('false');
      desc.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(asc.classList.contains('active')).toBe(true);
      expect(desc.classList.contains('active')).toBe(false);
      expect(order()).toEqual(['1', '2', '10']);
      view.handleAction('select');
      expect(order()).toEqual(['10', '2', '1']);
      expect(browse().querySelector('[data-sort-direction="desc"]')?.getAttribute('aria-checked')).toBe('true');
      expect(view.focusScope.focusKey).toBe(JSON.stringify(['browse', '', 'sort-direction:desc']));
    });

    it('selecting the same field or direction never silently reverses it', async () => {
      await openWith(undefined, streams());
      choose('name');
      browse().querySelector<HTMLElement>('[data-sort-direction="desc"]')!.click();
      storageMock.setCatalogSort.mockClear();
      choose('name');
      browse().querySelector<HTMLElement>('[data-sort-direction="desc"]')!.click();
      expect(order()).toEqual(['10', '2', '1']);
      expect(storageMock.setCatalogSort).not.toHaveBeenCalled();
    });

    it.each(['added', 'rating', 'year'])('starts %s descending and permits ascending', async by => {
      await openWith(undefined, streams());
      choose(by);
      expect(order()).toEqual(['2', '1', '10']);
      expect(storageMock.setCatalogSort).toHaveBeenLastCalledWith('vod', { by, direction: 'desc' });
      browse().querySelector<HTMLElement>('[data-sort-direction="asc"]')!.click();
      expect(order()).toEqual(['10', '1', '2']);
      expect(storageMock.setCatalogSort).toHaveBeenLastCalledWith('vod', { by, direction: 'asc' });
    });

    it('leaves Continue Watching and Watchlist in their own order', async () => {
      storageMock.getResumeList.mockReturnValue([
        { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Title 10', poster: '', ext: 'mp4', position: 100, duration: 600, updatedAt: 3 },
        { accountId: 'x1', kind: 'vod', itemId: '1', name: 'Title 1', poster: '', ext: 'mp4', position: 100, duration: 600, updatedAt: 2 },
      ]);
      watchlistState.entries = ['10', '1'].map(itemId => ({
        accountId: 'x1', kind: 'vod', itemId, name: `Title ${itemId}`,
        poster: '', rating: '', categoryId: '1', containerExtension: 'mp4', addedAt: 1,
      }));
      const { view } = await openWith(undefined, streams());
      const rows = Array.from(browse().querySelector('.catalog-rails-body')!.children);
      expect(rows.map(row => row.classList.contains('catalog-sort') ? 'sort' : row.getAttribute('data-rail-key')))
        .toEqual(['continue', 'watchlist', 'sort', 'cat:1']);
      const special = () => ['continue', 'watchlist'].map(key =>
        browse().querySelector(`[data-rail-key="${key}"]`)!.textContent);
      const before = special();
      choose('name');
      expect(order()).toEqual(['1', '2', '10']);
      expect(special()).toEqual(before);
      browse().querySelector<HTMLElement>('.catalog-sort .dropdown-trigger')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'down');
      expect(browse().querySelector('.focused')?.closest('[data-rail-key]')?.getAttribute('data-rail-key'))
        .toBe('cat:1');
      pressKey(view, 'up');
      expect(browse().querySelector('.catalog-sort .focused')).not.toBeNull();
      pressKey(view, 'down');
      expect(browse().querySelector('.focused')?.closest('[data-rail-key]')?.getAttribute('data-rail-key'))
        .toBe('cat:1');
    });

    it('does not show category sorting when only a saved collection is available', async () => {
      storageMock.getResumeList.mockReturnValue([
        { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Title 10', poster: '', ext: 'mp4',
          position: 100, duration: 600, updatedAt: 3 },
      ]);
      await openWith([], []);
      expect(browse().querySelector('[data-rail-key="continue"]')).not.toBeNull();
      expect(browse().querySelector('.catalog-sort')).toBeNull();
    });

    it('keeps the old order, label, and scroll offset if saving the preference fails', async () => {
      await openWith(undefined, streams());
      const track = browse().querySelector<HTMLElement>('[data-rail-key="cat:1"] .catalog-rail-track')!;
      track.scrollLeft = 230;
      storageMock.setCatalogSort.mockReturnValue(false);
      choose('name');
      expect(order()).toEqual(['10', '2', '1']);
      expect(browse().querySelector('.dropdown-current')?.textContent).toBe('Default');
      expect(browse().querySelector('[role="radiogroup"]')).toBeNull();
      expect(track.scrollLeft).toBe(230);
    });

    it.each([true, false])('resets other browse rails after a grid sort only when saving succeeds: %s', async saved => {
      const items = Array.from({ length: 30 }, (_, i) => vod(String(30 - i), `Title ${30 - i}`));
      const { view } = await openWith([
        { id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' },
      ], items);
      const track = browse().querySelector<HTMLElement>('[data-rail-key="cat:2"] .catalog-rail-track')!;
      track.scrollLeft = 230;
      const seeAll = browse().querySelector<HTMLElement>('.catalog-see-all[data-category-id="1"]')!;
      seeAll.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      pressKey(view, 'select');
      await Promise.resolve();
      storageMock.setCatalogSort.mockReturnValue(saved);
      choose('name', container.querySelector<HTMLElement>('.catalog-layer-grid')!);
      pressKey(view, 'back');
      expect(track.scrollLeft).toBe(saved ? 0 : 230);
      expect(order()[0]).toBe(saved ? '1' : '30');
      expect(view.focusScope.focusKey).toBe(JSON.stringify(['browse', 'cat:1', 'all:1']));
    });

    it('applies the current order to newly loaded categories and preserves it on Back', async () => {
      const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
      const { view } = await openWith(cats, streams());
      choose('name');
      browse().querySelector<HTMLElement>('[data-sort-direction="desc"]')!.click();
      catalogMock.loadVodStreams.mockResolvedValue([
        vod('1', 'Title 1', '7'), vod('10', 'Title 10', '7'), vod('2', 'Title 2', '7'),
      ]);
      const cat = browse().querySelector<HTMLElement>('[data-category-id="7"]')!;
      cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      view.handleAction('select');
      await Promise.resolve(); await Promise.resolve();
      const grid = container.querySelector<HTMLElement>('.catalog-layer-grid')!;
      expect(Array.from(grid.querySelectorAll<HTMLElement>('.catalog-tile'))
        .map(el => el.dataset.itemId)).toEqual(['10', '2', '1']);
      choose('name', grid);
      expect(grid.querySelector('[data-sort-direction="desc"]')?.getAttribute('aria-checked')).toBe('true');
      view.handleAction('back');
      expect(order()).toEqual(['10', '2', '1']);
      expect(browse().querySelector('[data-sort-direction="desc"]')?.getAttribute('aria-checked')).toBe('true');
    });

    it('restores the persisted movie preference when reopening', async () => {
      storageMock.getCatalogSort.mockReturnValue({ by: 'rating', direction: 'asc' });
      await openWith(undefined, streams());
      expect(storageMock.getCatalogSort).toHaveBeenCalledWith('vod');
      expect(order()).toEqual(['10', '1', '2']);
      expect(browse().querySelector('.dropdown-current')?.textContent).toBe('Rating');
      expect(browse().querySelector('[data-sort-direction="asc"]')?.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('renders a rail per preloaded category with poster tiles', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    expect(container.querySelector('.catalog-rail-title')?.textContent).toContain('Cat A');
    expect(container.querySelector('.catalog-tile[data-item-id="10"]')?.textContent).toContain('Movie One');
  });

  it('hides Arabic-named categories and titles while the setting is on', async () => {
    storageMock.getHideArabic.mockReturnValue(true);
    try {
      await openWith(
        [{ id: '1', name: 'Cat A' }, { id: '2', name: 'أفلام' }],
        [vod('10', 'Movie One'), vod('11', 'فيلم')],
      );
      const titles = Array.from(container.querySelectorAll('.catalog-rail-title')).map(el => el.textContent);
      expect(titles.join('|')).toContain('Cat A');
      expect(titles.join('|')).not.toContain('أفلام');
      expect(container.querySelector('.catalog-tile[data-item-id="10"]')).not.toBeNull();
      expect(container.querySelector('.catalog-tile[data-item-id="11"]')).toBeNull();
      expect(catalogMock.loadVodStreams.mock.calls.map(call => call[1])).toEqual(['1']);
    } finally {
      storageMock.getHideArabic.mockReturnValue(false);
    }
  });

  it('updates the hero title and backdrop to the focused movie', async () => {
    const m1 = { accountId: 'x1', streamId: '10', name: 'Movie One', poster: 'http://host/p1.jpg', rating: '', categoryId: '1', containerExtension: 'mp4' };
    const m2 = { accountId: 'x1', streamId: '11', name: 'Movie Two', poster: 'http://host/p2.jpg', rating: '', categoryId: '1', containerExtension: 'mp4' };
    await openWith([{ id: '1', name: 'Cat A' }], [m1, m2]);
    const hero = container.querySelector<HTMLElement>('.catalog-hero')!;
    const title = () => container.querySelector('.catalog-hero-title')?.textContent;

    container.querySelector('.catalog-tile[data-item-id="11"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Movie Two');
    expect(hero.style.backgroundImage).toContain('p2.jpg');

    container.querySelector('.catalog-tile[data-item-id="10"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Movie One');
    expect(hero.style.backgroundImage).toContain('p1.jpg');
  });

  it('shows a Continue rail from the resume list', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResumeList as ReturnType<typeof vi.fn>).mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    await openWith();
    expect(container.textContent).toContain('Continue Watching');
  });

  it('shows a Watchlist rail from stored movie snapshots', async () => {
    watchlistState.entries = [{
      accountId: 'x1', kind: 'vod', itemId: '42', name: 'Saved Movie', poster: '',
      rating: '', categoryId: '9', containerExtension: 'mkv', addedAt: 2,
    }];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    expect(container.textContent).toContain('Watchlist');
    const tile = container.querySelector('.catalog-tile[data-item-id="42"]') as HTMLElement;
    expect(tile.textContent).toContain('Saved Movie');
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Saved Movie');
  });

  it('queues only the movies after one launched from the Watchlist rail', async () => {
    watchlistState.entries = [
      {
        accountId: 'x1', kind: 'vod', itemId: '42', name: 'Saved Movie One', poster: '',
        rating: '', categoryId: '9', containerExtension: 'mp4', addedAt: 2,
      },
      {
        accountId: 'x1', kind: 'vod', itemId: '43', name: 'Saved Movie Two', poster: '',
        rating: '', categoryId: '9', containerExtension: 'mkv', addedAt: 1,
      },
    ];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('[data-watchlist-item="42"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '42',
      watchlistQueue: [
        expect.objectContaining({
          itemId: '43',
          title: 'Saved Movie Two',
          url: 'http://host:8080/movie/u/p/43.mkv',
        }),
      ],
    }));
  });

  describe('detail info landing late', () => {
    async function openSlowDetail() {
      let resolveInfo: (info: unknown) => void = () => undefined;
      catalogMock.loadVodInfo.mockReturnValue(new Promise((resolve) => { resolveInfo = resolve; }));
      const { view, handlers } = await openWith();
      container.querySelector('.catalog-tile[data-item-id="10"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      view.handleAction('select');
      const detail = () => container.querySelector('.catalog-layer:not(.catalog-layer-hidden)')!;
      expect(detail().querySelector('.focused')).not.toBeNull();
      const land = async () => {
        resolveInfo({
          plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
          poster: '', backdrop: '', rating: '', subtitles: [],
        });
        await Promise.resolve(); await Promise.resolve();
      };
      return { view, handlers, detail, land };
    }

    it('leaves the ring off a button the pointer left, for the next key to reveal', async () => {
      const { view, detail, land } = await openSlowDetail();
      const button = detail().querySelector<HTMLElement>('.focused')!;
      button.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      await land();
      expect(detail().querySelector('.focused')).toBeNull();
      view.handleAction('down');
      expect(detail().querySelector('.focused')?.getAttribute('data-key'))
        .toBe(button.getAttribute('data-key'));
    });
  });

  it('reveals the tab bar when Up cannot move within the view', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('up');
    expect(container.querySelector('.catalog-sort .focused')).not.toBeNull();
    expect(handlers.onRevealTabBar).not.toHaveBeenCalled();
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalled();
  });

  // One failing rail category must not blank every other rail.
  it('drops only the failed rail when one category load rejects', async () => {
    const cats = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    catalogMock.loadVodCategories.mockResolvedValue(cats);
    catalogMock.loadVodStreams.mockImplementation((_a: unknown, categoryId: string) =>
      categoryId === '3'
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve([vod(`${categoryId}0`, `Movie ${categoryId}`, categoryId)]));
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    Focus.setBase(() => view.focusScope);
    await view.open(account);

    for (const id of ['1', '2', '4', '5', '6']) {
      expect(container.querySelector(`.catalog-tile[data-item-id="${id}0"]`)).not.toBeNull();
    }
    expect(container.querySelector('.catalog-see-all[data-category-id="3"]')).toBeNull();
    expect(eventLines(errors, 'xtream.view.load.failed').join('\n')).toContain('operation=rail mode=vod');
    expect(eventLines(warns, 'xtream.view.rails.partial')[0]).toContain('kept=5 total=6');
    errors.mockRestore();
    warns.mockRestore();

    // The failed category stays reachable from All Categories and retries.
    const cat = container.querySelector<HTMLElement>('.catalog-cat[data-category-id="3"]')!;
    expect(cat).not.toBeNull();
    catalogMock.loadVodStreams.mockResolvedValue([vod('30', 'Movie 3', '3')]);
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.catalog-grid .catalog-tile[data-item-id="30"]')).not.toBeNull();
  });

  it('retries a category grid whose load failed when it is opened again', async () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view } = await openWith(cats, [vod('10', 'Movie One')]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const openCategory = async () => {
      container.querySelector<HTMLElement>('.catalog-cat[data-category-id="7"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      view.handleAction('select');
      await Promise.resolve(); await Promise.resolve();
    };
    catalogMock.loadVodStreams.mockRejectedValue(new Error('timeout'));
    await openCategory();
    expect(container.querySelector('.catalog-grid .catalog-tile[data-item-id]')).toBeNull();
    expect(eventLines(errors, 'xtream.view.load.failed').join('\n')).toContain('operation=category mode=vod');
    errors.mockRestore();
    view.handleAction('back');

    catalogMock.loadVodStreams.mockResolvedValue([vod('20', 'Movie Two', '7')]);
    await openCategory();
    expect(container.querySelector('.catalog-grid .catalog-tile[data-item-id="20"]')).not.toBeNull();
  });

  it('drills into a non-rail category grid and back to browse', async () => {
    // 7 categories: the first RAIL_CATEGORIES (6) become poster rails; the 7th
    // is a non-rail tile in the "All Categories" rail — the drill-in target.
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view, handlers } = await openWith(cats, [vod('10', 'Movie One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    expect(cat).not.toBeNull();
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadVodStreams.mockResolvedValue([vod('20', 'Movie Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    expect(container.querySelector('.catalog-tile[data-item-id="20"]')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('keeps browse resident under a grid and returns to the same tile', async () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view } = await openWith(cats, [vod('10', 'Movie One')]);
    const browse = container.querySelector('.catalog-browse');
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadVodStreams.mockResolvedValue([vod('20', 'Movie Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.catalog-browse')).toBe(browse);
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .toContain('catalog-layer-hidden');
    expect(container.querySelector('.catalog-layer-grid .focused')?.getAttribute('data-item-id'))
      .toBe('20');
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).toBe(browse);
    expect(cat.isConnected).toBe(true);
    expect(cat.classList).toContain('focused');
    expect(container.querySelector('.catalog-grid')).toBeNull();
  });

  it('lands on the next Watchlist tile after removing the opened one', async () => {
    const saved = (id: string, addedAt: number): WatchlistEntry => ({
      accountId: 'x1', kind: 'vod', itemId: id, name: `Saved ${id}`, poster: '',
      rating: '', categoryId: '9', containerExtension: 'mp4', addedAt,
    });
    watchlistState.entries = [saved('41', 3), saved('42', 2), saved('43', 1)];
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    container.querySelector('[data-watchlist-item="42"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    container.querySelector('[data-action="watchlist"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    view.handleAction('back');

    expect(container.querySelector('[data-watchlist-item="42"]')).toBeNull();
    expect(container.querySelector('.catalog-browse .focused')?.getAttribute('data-watchlist-item'))
      .toBe('43');
  });

  it('shows browse again after Back from a Search deep link', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One'), vod('11', 'Movie Two')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="11"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    const back = vi.fn();
    await view.openItem(account, vod('99', 'Found Movie'), back);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    const logs = vi.spyOn(console, 'log');
    view.handleAction('back');
    Focus.flush();
    expect(eventLines(logs, 'nav.focus.repaired')).toEqual([]);
    logs.mockRestore();

    expect(back).toHaveBeenCalled();
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .not.toContain('catalog-layer-hidden');
    expect(container.querySelector('.movies-detail')).toBeNull();
    expect(tile.classList).toContain('focused');
  });

  it('reloads a browse a Search deep link interrupted once it is shown again', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    catalogMock.loadVodCategories.mockReturnValueOnce(new Promise(() => {}));
    catalogMock.loadVodStreams.mockResolvedValue([vod('10', 'Movie One')]);
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    Focus.setBase(() => view.focusScope);
    void view.open(account);
    await view.openItem(account, vod('99', 'Found Movie'), vi.fn());
    catalogMock.loadVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }]);
    const backLogs = vi.spyOn(console, 'log');
    view.handleAction('back');
    Focus.flush();
    expect(eventLines(backLogs, 'nav.focus.repaired')).toEqual([]);
    backLogs.mockRestore();
    await Promise.resolve(); await Promise.resolve();
    // Not behind Search: only once the section is shown again.
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);
    const logs = vi.spyOn(console, 'log');
    view.ensureLoaded(account);
    expect(eventLines(logs, 'xtream.view.reload')).toEqual([
      expect.stringMatching(/operation=browse mode=vod reason=stale$/),
    ]);
    logs.mockRestore();
    await vi.waitFor(() => expect(container.querySelector('.catalog-browse')).not.toBeNull());
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.catalog-tile[data-item-id="10"]')).not.toBeNull();
  });

  // A bar above the catalog that holds the keys while it is open.
  function openBar(): { close(): void } {
    const bar = document.createElement('div');
    bar.innerHTML = '<button data-focusable data-key="b1"></button>';
    document.body.appendChild(bar);
    let open = true;
    Focus.push(Focus.register({ id: 'bar', root: bar, tier: Tier.bar, when: () => open }));
    Focus.flush();
    return { close: () => { open = false; Focus.flush(); } };
  }

  it('keeps a tile dark once the pointer left it under an open bar', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One'), vod('11', 'Movie Two')]);
    FocusRing.install(() => ({ root: Focus.owner()?.root() ?? null }));
    Focus.install();
    try {
      const bar = openBar();
      const tile = container.querySelector<HTMLElement>('.catalog-tile[data-item-id="11"]')!;
      tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      Focus.flush();
      expect(tile.classList.contains('focused')).toBe(true);
      tile.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));

      bar.close();
      expect(container.querySelectorAll('.focused')).toHaveLength(0);
    } finally {
      FocusRing.uninstall();
    }
  });

  it('brings the remembered tile back in view when the section resumes', async () => {
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One'), vod('11', 'Movie Two')]);
    const tile = container.querySelector<HTMLElement>('.catalog-tile[data-item-id="11"]')!;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    Focus.flush();
    const key = view.focusScope.focusKey;
    expect(tile.classList.contains('focused')).toBe(true);
    tile.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    Focus.flush();
    expect(tile.classList.contains('focused')).toBe(false);

    const reveal = vi.spyOn(view as unknown as { revealKey(k: string): boolean | null }, 'revealKey');
    view.resumeFocus();
    Focus.flush();
    expect(view.focusScope.focusKey).toBe(key);
    expect(reveal).toHaveBeenCalledWith(key);
    expect(tile.classList.contains('focused')).toBe(true);
  });

  it('lands on the first shown detail button when the focused one is gone', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    storageMock.getResume.mockReturnValue({ position: 60, duration: 600 } as never);
    const { view } = await openWith();
    await view.openItem(account, vod('99', 'Found Movie'), vi.fn());
    const button = (key: string) =>
      container.querySelector<HTMLElement>(`.movies-detail [data-key="${key}"]`)!;
    button('resume').style.display = 'none';
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const shown = !(this as HTMLElement).closest('[style*="display: none"], .catalog-layer-hidden');
      return { x: 0, y: 0, top: 0, left: 0, right: shown ? 100 : 0, bottom: shown ? 40 : 0,
        width: shown ? 100 : 0, height: shown ? 40 : 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      document.documentElement.classList.add('keyboard-nav');
      view.focusScope.track(JSON.stringify(['detail', '', 'gone']));
      Focus.flush();
      expect(button('play').classList.contains('focused')).toBe(true);

      view.focusScope.track(null);
      view.focusScope.enter('key');
      Focus.flush();
      expect(button('play').classList.contains('focused')).toBe(true);
      expect(button('resume').classList.contains('focused')).toBe(false);
    } finally {
      rect.mockRestore();
    }
  });

  it('rings a detail opened from Search after the pointer left the last one', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    await view.openItem(account, vod('98', 'First Find'), vi.fn());
    container.querySelector('.movies-detail .focused')!
      .dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    Focus.flush();
    expect(container.querySelector('.movies-detail .focused')).toBeNull();

    await view.openItem(account, vod('99', 'Second Find'), vi.fn());
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Second Find');
    Focus.flush();
    expect(container.querySelector('.movies-detail .focused')).not.toBeNull();
  });

  it('keeps the ring hidden when the detail it was hidden on loses that button', async () => {
    let resolveInfo!: (info: unknown) => void;
    catalogMock.loadVodInfo.mockReturnValueOnce(new Promise((r) => { resolveInfo = r; }));
    storageMock.getResume.mockReturnValue({ position: 60, duration: 600 } as never);
    const { view } = await openWith();
    void view.openItem(account, vod('99', 'Found Movie'), vi.fn());
    const resume = container.querySelector('.movies-detail [data-key="resume"]') as HTMLElement;
    resume.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    resume.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    Focus.flush();
    expect(container.querySelector('.movies-detail .focused')).toBeNull();

    storageMock.getResume.mockReturnValue(null);
    resolveInfo({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    await vi.waitFor(() =>
      expect(container.querySelector('.movies-detail [data-key="resume"]')).toBeNull());
    Focus.flush();
    expect(container.querySelector('.movies-detail .focused')).toBeNull();
  });

  it('keeps a second deep-linked detail when the section is shown again', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    catalogMock.loadVodCategories.mockReturnValueOnce(new Promise(() => {}));
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    Focus.setBase(() => view.focusScope);
    void view.open(account);
    await view.openItem(account, vod('98', 'First Find'), vi.fn());
    view.handleAction('back');
    await view.openItem(account, vod('99', 'Second Find'), vi.fn());
    view.ensureLoaded(account);

    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.movies-detail')?.textContent).toContain('Second Find');
  });

  it('reopens browse on the active account when the section is shown again', async () => {
    const { view } = await openWith();
    const logs = vi.spyOn(console, 'log');
    view.ensureLoaded(account);
    expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(1);
    expect(eventLines(logs, 'xtream.view.reload')).toEqual([]);

    const other: PlaylistEntry = { ...account, id: 'x2' };
    view.ensureLoaded(other);
    expect(eventLines(logs, 'xtream.view.reload')).toEqual([
      expect.stringMatching(/operation=browse mode=vod reason=account$/),
    ]);
    logs.mockRestore();
    await vi.waitFor(() => expect(catalogMock.loadVodCategories).toHaveBeenCalledTimes(2));
    expect(catalogMock.loadVodCategories).toHaveBeenLastCalledWith(other, expect.anything());
  });

  it('stays in browse when Back cancels a category grid that is still loading', async () => {
    const cats = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Cat ${i + 1}` }));
    const { view } = await openWith(cats, [vod('10', 'Movie One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    let resolve!: (items: unknown[]) => void;
    catalogMock.loadVodStreams.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    view.handleAction('select');
    expect(container.querySelector('.catalog-layer-grid .catalog-loading')).not.toBeNull();
    // The hidden category tile no longer takes OK while the grid loads.
    expect(container.querySelector('.focused')).toBeNull();
    const loads = catalogMock.loadVodStreams.mock.calls.length;
    view.handleAction('select');
    expect(catalogMock.loadVodStreams).toHaveBeenCalledTimes(loads);
    view.handleAction('back');
    const logs = vi.spyOn(console, 'log');
    resolve([vod('20', 'Movie Two', '7')]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(eventLines(logs, 'xtream.view.load.superseded')).toEqual([
      expect.stringMatching(/operation=category mode=vod reason=left$/),
    ]);
    logs.mockRestore();

    expect(container.querySelector('.catalog-grid')).toBeNull();
    expect(container.querySelector('.catalog-layer-browse')!.classList)
      .not.toContain('catalog-layer-hidden');
    expect(cat.classList).toContain('focused');
  });

  it('finds the origin rail of a category id that needs selector escaping', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const id = 'q"1\\';
    const { view } = await openWith([{ id, name: 'Cat Q' }], [vod('10', 'Movie One', id), vod('11', 'Movie Two', id)]);
    const tile = container.querySelector('.catalog-tile[data-item-id="11"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    // Browse rebuilds the tile as a new node, so focus must find it by rail.
    tile.remove();
    expect(() => view.handleAction('back')).not.toThrow();
    expect(container.querySelector('.catalog-browse .focused')?.getAttribute('data-item-id'))
      .toBe('11');
  });

  // Issue 77: rails stop at RAIL_ITEMS, so every category's full grid must stay
  // reachable from browse — through See all on a rail and through All Categories.
  const eightFullCategories = async () => {
    const cats = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: `Cat ${String(i + 1)}` }));
    catalogMock.loadVodCategories.mockResolvedValue(cats);
    catalogMock.loadVodStreams.mockImplementation((_account: PlaylistEntry, categoryId: string) =>
      Promise.resolve(Array.from({ length: 50 }, (_, i) => vod(`${categoryId}-${String(i)}`, `Movie ${String(i)}`, categoryId))));
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    Focus.setBase(() => view.focusScope);
    await view.open(account);
    return view;
  };
  const selectAndSettle = async (view: Movies, el: HTMLElement) => {
    el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
  };

  it('opens the full grid of every category from browse', async () => {
    const view = await eightFullCategories();
    const fullHeight = new VirtualGrid({ columnStride: 244, rowStride: 395, overscanRows: 0 })
      .getTotalSize(50, 1760);

    for (let id = 1; id <= 6; id++) {
      const rail = container.querySelector<HTMLElement>(`.catalog-see-all[data-category-id="${String(id)}"]`)!
        .closest<HTMLElement>('.catalog-rail')!;
      expect(rail.querySelectorAll('.catalog-tile[data-item-id]').length).toBe(20);
      const seeAll = rail.querySelector<HTMLElement>('.catalog-see-all')!;
      expect(seeAll.textContent).toContain('See all');
      expect(seeAll.textContent).toContain('50 movies');
      await selectAndSettle(view, seeAll);
      expect(container.querySelector('.catalog-grid-title')?.textContent).toBe(`Cat ${String(id)}`);
      expect(container.querySelector<HTMLElement>('.catalog-grid-track')?.style.height)
        .toBe(`${String(fullHeight)}px`);
      view.handleAction('back');
    }

    const tiles = Array.from(container.querySelectorAll<HTMLElement>('.catalog-cat'))
      .map((el) => el.dataset.categoryId);
    expect(tiles).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-cat[data-category-id="2"]')!);
    expect(container.querySelector('.catalog-grid-title')?.textContent).toBe('Cat 2');
  });

  it('returns focus to See all when backing out of its grid', async () => {
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-see-all[data-category-id="3"]')!);
    view.handleAction('back');
    const focused = container.querySelector<HTMLElement>('.focused');
    expect(focused?.classList.contains('catalog-see-all')).toBe(true);
    expect(focused?.dataset.categoryId).toBe('3');
  });

  const noInfo = { plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 };
  const focusedKey = () => container.querySelector<HTMLElement>('.focused')?.dataset.key;

  it('returns focus to See all after detail, grid, and back to browse', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-see-all[data-category-id="4"]')!);
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-grid .catalog-tile[data-item-id="4-30"]')!);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    view.handleAction('back');
    expect(focusedKey()).toBe('all:4');
  });

  it('shows a locked category as locked on its See all tile too', async () => {
    const lockState = vi.spyOn(ParentalControlService, 'groupLockState').mockImplementation(
      (targets) => (targets.some((target) => 'categoryId' in target && target.categoryId === '2') ? 'locked' : null));
    try {
      await eightFullCategories();
      expect(container.querySelector('.catalog-see-all[data-category-id="2"] .lock-badge.is-locked')).not.toBeNull();
      expect(container.querySelector('.catalog-see-all[data-category-id="1"] .lock-badge')).toBeNull();
    } finally {
      lockState.mockRestore();
    }
  });

  it('keeps focus in the Watchlist rail after the origin title is removed', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '1-5', categoryId: '1', name: 'Movie 5', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    watchlistState.entries = ['42', '43'].map((itemId, i) => ({
      accountId: 'x1', kind: 'vod' as const, itemId, name: `Saved ${itemId}`, poster: '',
      rating: '', categoryId: '1', containerExtension: 'mp4', addedAt: 2 - i,
    }));
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('[data-watchlist-item="42"]')!);
    await selectAndSettle(view, container.querySelector<HTMLElement>('[data-action="watchlist"]')!);
    view.handleAction('back');
    expect(container.querySelector('[data-watchlist-item="42"]')).toBeNull();
    expect(focusedKey()).toBe('w:43');
  });

  it('returns focus to the rail tile a detail was opened from', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    const view = await eightFullCategories();
    await selectAndSettle(view, container.querySelector<HTMLElement>('.catalog-tile[data-item-id="2-14"]')!);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    view.handleAction('back');
    expect(focusedKey()).toBe('i:2:2-14');
  });

  it('returns focus to the Continue tile, not its twin in a category rail', async () => {
    catalogMock.loadVodInfo.mockResolvedValue(noInfo);
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '1-5', categoryId: '1', name: 'Movie 5', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    const view = await eightFullCategories();
    const twin = container.querySelector<HTMLElement>('[data-rail-key="continue"] .catalog-tile')!;
    expect(container.querySelectorAll(`[data-key="${twin.dataset.key!}"]`).length).toBe(2);
    await selectAndSettle(view, twin);
    view.handleAction('back');
    expect(container.querySelector('.focused')?.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey)
      .toBe('continue');
  });

  it('returns focus to an All Categories tile beyond the first rendered window', async () => {
    const cats = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `Cat ${String(i + 1)}` }));
    catalogMock.loadVodCategories.mockResolvedValue(cats);
    catalogMock.loadVodStreams.mockResolvedValue([]);
    const view = new Movies(container, { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() });
    Focus.setBase(() => view.focusScope);
    await view.open(account);
    container.querySelector<HTMLElement>('.catalog-cat[data-category-id="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    for (let i = 0; i < 40; i++) view.handleAction('right');
    expect(focusedKey()).toBe('c:41');
    expect(container.querySelector('.catalog-cat[data-category-id="1"]')).toBeNull();
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.catalog-grid-title')?.textContent).toBe('Cat 41');
    view.handleAction('back');
    expect(focusedKey()).toBe('c:41');
  });

  describe('rail edge gutter', () => {
    // A 1000px scrollport scrolled to 500, holding 220px tiles.
    const stubRail = (tileStart: number) => {
      const track = container.querySelector<HTMLElement>('[data-rail-key="cat:1"] .catalog-rail-track')!;
      const tile = track.querySelector<HTMLElement>('.catalog-tile[data-item-id="1-3"]')!;
      let scrollLeft = 500;
      const writes: { value: number; behavior: string }[] = [];
      Object.defineProperty(track, 'scrollLeft', {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => { writes.push({ value, behavior: track.style.scrollBehavior }); scrollLeft = value; },
      });
      Object.defineProperty(track, 'clientWidth', { configurable: true, value: 1000 });
      Object.defineProperty(tile, 'offsetWidth', { configurable: true, value: 220 });
      track.getBoundingClientRect = () => ({ left: 0 } as DOMRect);
      tile.getBoundingClientRect = () => ({ left: tileStart - scrollLeft } as DOMRect);
      track.style.scrollBehavior = 'smooth';
      return { track, tile, writes };
    };
    const keyboard = (on: boolean) => document.documentElement.classList.toggle('keyboard-nav', on);
    // The pointer rests on the tile and leaves; the first key only shows
    // the ring there, and brings the tile into view.
    const keyOnto = (view: Movies, tile: HTMLElement) => {
      tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      tile.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
      Focus.flush();
      pressKey(view, 'right');
      keyboard(false);
    };

    it('nudges a flush, fully visible tile instantly', async () => {
      const view = await eightFullCategories();
      const { track, tile, writes } = stubRail(1280); // ends exactly at 1500
      keyOnto(view, tile);
      expect(writes).toEqual([{ value: 1512 - 1000, behavior: 'auto' }]);
      expect(track.style.scrollBehavior).toBe('smooth');
      expect(focusedKey()).toBe(tile.dataset.key);
    });

    it('retargets the smooth scroll for a tile still out of view', async () => {
      const view = await eightFullCategories();
      const { tile, writes } = stubRail(1400);
      keyOnto(view, tile);
      expect(writes).toEqual([{ value: 1632 - 1000, behavior: 'smooth' }]);
    });

    it('leaves the rail alone when a pointer focuses an edge tile', async () => {
      await eightFullCategories();
      keyboard(false);
      const { tile, writes } = stubRail(1280);
      tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(writes).toEqual([]);
    });
  });

  it('omits See all when a rail already shows the whole category', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], Array.from({ length: 20 }, (_, i) => vod(String(i), `Movie ${String(i)}`)));
    expect(container.querySelectorAll('.catalog-tile[data-item-id]').length).toBe(20);
    expect(container.querySelector('.catalog-see-all')).toBeNull();
  });

  it('virtualizes 50,000 categories and a 50,000-item grid', async () => {
    const cats = Array.from(
      { length: 50_000 },
      (_, i) => ({ id: String(i + 1), name: `Category ${String(i + 1)}` }),
    );
    const streams = Array.from(
      { length: 50_000 },
      (_, i) => vod(String(i), `Movie ${String(i)}`, '7'),
    );
    const { view } = await openWith(cats, streams);

    expect(container.querySelectorAll('.catalog-category-rail-cell').length).toBeLessThan(20);
    expect(container.querySelector<HTMLElement>('.catalog-category-rail-spacer')?.style.width)
      .toBe(`${String(50_000 * 320)}px`);

    const category = container.querySelector<HTMLElement>(
      '.catalog-cat[data-category-id="7"]',
    )!;
    category.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelectorAll('.catalog-grid-cell').length).toBeLessThan(60);
    expect(container.querySelector<HTMLElement>('.catalog-grid-track')?.style.height)
      .toBe('2821485px');
  });

  it('re-renders a scrolled All categories rail only when its window changes', async () => {
    const cats = Array.from({ length: 200 }, (_, i) => ({ id: String(i + 1), name: `Category ${String(i + 1)}` }));
    const { view } = await openWith(cats, [vod('1', 'Movie 1', '1')]);
    const rail = container.querySelector<HTMLElement>('.catalog-category-rail')!;
    const render = vi.spyOn(view as unknown as { renderBrowse(restore?: boolean): void }, 'renderBrowse');
    const scrollTo = async (left: number): Promise<void> => {
      rail.scrollLeft = left;
      rail.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    // An edge scroll moves a few pixels a frame; the same cells stay.
    for (const left of [10, 20, 30]) await scrollTo(left);
    expect(render).not.toHaveBeenCalled();
    await scrollTo(320 * 50);
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-category-virtual-index="50"]')).not.toBeNull();
  });

  // The grid virtualizer is only measured while rendering, so a call to
  // getTotalSize is the observable trace of a full grid render.
  const openGrid = async () => {
    const streams = Array.from(
      { length: 50 },
      (_, index) => vod(String(index), `Movie ${String(index)}`, '7'),
    );
    const cats = Array.from(
      { length: 7 },
      (_, index) => ({ id: String(index + 1), name: `Cat ${String(index + 1)}` }),
    );
    const { view } = await openWith(cats, streams);
    container.querySelector<HTMLElement>('.catalog-cat[data-category-id="7"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();
    return view;
  };

  it('leaves the scope key alone when a hidden layer reports a hover', async () => {
    const view = await openGrid();
    const key = view.focusScope.focusKey;
    expect(key).not.toBeNull();
    container.querySelector<HTMLElement>('.catalog-layer-hidden .catalog-tile[data-item-id]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(view.focusScope.focusKey).toBe(key);
  });

  it('moves focus inside the window without re-rendering the grid', async () => {
    const view = await openGrid();
    const rendered = vi.spyOn(VirtualGrid.prototype, 'getTotalSize');
    view.handleAction('right');
    expect(rendered).not.toHaveBeenCalled();
    expect(container.querySelector(
      '[data-grid-index="1"] [data-focusable].focused',
    )).not.toBeNull();
    expect(container.querySelector(
      '[data-grid-index="0"] [data-focusable].focused',
    )).toBeNull();
    rendered.mockRestore();
  });

  it('re-renders the grid once a focus move scrolls the window', async () => {
    const view = await openGrid();
    const rendered = vi.spyOn(VirtualGrid.prototype, 'getTotalSize');
    view.handleAction('down');
    expect(rendered).not.toHaveBeenCalled();
    view.handleAction('down');
    expect(rendered).toHaveBeenCalled();
    expect(container.querySelector(
      '[data-grid-index="14"] [data-focusable].focused',
    )).not.toBeNull();
    rendered.mockRestore();
  });

  it('renders the window once per step while Down is held, keeping one ring', async () => {
    const view = await openGrid();
    const grid = container.querySelector<HTMLElement>('.catalog-grid')!;
    const track = container.querySelector<HTMLElement>('.catalog-grid-track')!;
    // A smooth scroll still on its way: the live offset trails each write
    // by one step.
    let writes = 0;
    let live = 0;
    let target = 0;
    Object.defineProperty(grid, 'scrollTop', {
      configurable: true,
      get: () => live,
      set: (value: number) => { writes++; live = target; target = value; },
    });
    grid.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    track.getBoundingClientRect = () => ({ top: 126 - grid.scrollTop } as DOMRect);
    const rendered = vi.spyOn(VirtualGrid.prototype, 'getTotalSize');
    pressKey(view, 'down');
    pressKey(view, 'down');
    const perRender = rendered.mock.calls.length;
    expect(perRender).toBeGreaterThan(0);
    for (let step = 0; step < 4; step++) {
      rendered.mockClear();
      writes = 0;
      pressKey(view, 'down');
      expect(rendered.mock.calls.length).toBeLessThanOrEqual(perRender);
      expect(writes).toBeLessThanOrEqual(1);
      expect(container.querySelectorAll('.catalog-grid .focused')).toHaveLength(1);
    }
    expect(live).toBeLessThan(target);

    // The row in view by the window's own offset needs no scroll, however
    // far the live offset trails.
    rendered.mockClear();
    writes = 0;
    pressKey(view, 'right');
    expect(rendered).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    expect(container.querySelectorAll('.catalog-grid .focused')).toHaveLength(1);
    rendered.mockRestore();
  });

  it('leaves free grid scrolling where it stops', async () => {
    const cats = Array.from(
      { length: 7 },
      (_, index) => ({ id: String(index + 1), name: `Cat ${String(index + 1)}` }),
    );
    const streams = Array.from(
      { length: 50 },
      (_, index) => vod(String(index), `Movie ${String(index)}`, '7'),
    );
    const { view } = await openWith(cats, streams);
    const category = container.querySelector<HTMLElement>(
      '.catalog-cat[data-category-id="7"]',
    )!;
    category.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    await Promise.resolve();

    vi.useFakeTimers();
    try {
      const grid = container.querySelector<HTMLElement>('.catalog-grid')!;
      const track = container.querySelector<HTMLElement>('.catalog-grid-track')!;
      Object.defineProperty(grid, 'clientHeight', { value: 900, configurable: true });
      grid.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
      track.getBoundingClientRect = () => ({ top: 126 - grid.scrollTop } as DOMRect);
      grid.scrollTop = 577;
      grid.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(1000);

      expect(grid.scrollTop).toBe(577);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to Live from the browse top level', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('refreshes the Continue rail from storage on each browse render', async () => {
    const { StorageService } = await import('../services/storage-service');
    const getResumeList = StorageService.getResumeList as ReturnType<typeof vi.fn>;
    getResumeList.mockReturnValue([]);
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    expect(container.textContent).not.toContain('Continue Watching');

    // A movie is watched, so a resume entry now exists; walking detail -> browse
    // should surface it without re-entering the section.
    getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4', position: 100, duration: 6000, updatedAt: 1 },
    ]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back'); // detail -> browse re-render
    expect(container.textContent).toContain('Continue Watching');
  });
});

describe('Movies detail', () => {
  it('removes only the movie progress and moves focus off the disappearing detail action', async () => {
    storageMock.getResume.mockReturnValue({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Title 1', poster: '', ext: 'mp4',
      position: 100, duration: 600, updatedAt: 1,
    });
    catalogMock.loadVodInfo.mockResolvedValue(null);
    const { view } = await openWith();
    const tile = container.querySelector<HTMLElement>('.catalog-tile[data-item-id="10"]')!;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    pressKey(view, 'select');
    await Promise.resolve();
    const remove = container.querySelector<HTMLElement>('[data-action="remove-resume"]')!;
    remove.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    storageMock.clearResume.mockImplementationOnce(() => { storageMock.getResume.mockReturnValue(null); });
    pressKey(view, 'select');
    expect(storageMock.clearResume).toHaveBeenCalledExactlyOnceWith('x1', 'vod', '10');
    expect(storageMock.removeWatchlist).not.toHaveBeenCalled();
    expect(container.querySelector('[data-action="remove-resume"]')).toBeNull();
    expect(container.querySelector('.movies-detail .focused')?.getAttribute('data-key')).toBe('play');
    expect(toastMock.showToast).toHaveBeenCalledWith('Removed from Continue Watching');
  });

  it('adds and removes the movie from Watchlist without losing button focus', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    Focus.flush();
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders plot/meta and a Play button, and plays from the start', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'A plot.', cast: 'Actor A', director: 'Dir A', genre: 'Drama',
      releaseDate: '2020-05-01', durationSecs: 3600, poster: 'http://host:8080/p.jpg',
      imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.detail-plot')?.textContent).toContain('A plot.');
    expect(container.textContent).toContain('Drama');
    expect(container.textContent).toContain('2020');

    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '10', accountId: 'x1', kind: 'vod', resumeSecs: 0,
      url: 'http://host:8080/movie/u/p/10.mp4',
      watchlistQueue: undefined,
    }));
  });

  it('offers Resume when a resume point exists and passes its position', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600, poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    const resume = container.querySelector('[data-action="resume"]') as HTMLElement;
    expect(resume).not.toBeNull();
    resume.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ resumeSecs: 900 }));
  });

  it('refreshes the detail actions when playback creates a resume point', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 3600,
      poster: '', imdbId: '', tmdbId: '', year: 0,
    });
    const { view } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('[data-action="resume"]')).toBeNull();

    storageMock.getResume.mockReturnValue({
      accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '',
      ext: 'mp4', position: 20, duration: 3600, updatedAt: 1,
    });
    view.refreshPlaybackState();
    expect(container.querySelector('[data-action="resume"]')).not.toBeNull();
  });

  it('backs out of detail to the browse view', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: '', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('forwards searchMeta.tmdbId to onPlayVod when currentInfo has it', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'p', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '',
      imdbId: '1375666', tmdbId: '27205', year: 2010,
    });
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      searchMeta: { imdbId: '1375666', tmdbId: '27205', year: 2010 },
    }));
  });

  it('preserves detail focus across the info re-render instead of snapping to the first button', async () => {
    const { StorageService } = await import('../services/storage-service');
    (StorageService.getResume as ReturnType<typeof vi.fn>).mockReturnValue(
      { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', position: 900, duration: 3600, updatedAt: 1 },
    );
    let resolveInfo!: (v: unknown) => void;
    catalogMock.loadVodInfo.mockReturnValue(new Promise((r) => { resolveInfo = r; }));
    const { view } = await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    const tile = container.querySelector('.catalog-tile[data-item-id="10"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); // info-less render committed; focus lands on the first button (Resume)
    const play = container.querySelector('[data-action="play"]') as HTMLElement;
    play.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })); // move focus to Play
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
    resolveInfo({ plot: 'x', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    await Promise.resolve(); await Promise.resolve(); // info re-render
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('play');
  });
});

describe('Movies deep-link (openItem)', () => {
  it('opens a movie detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({ plot: 'Deep plot.', cast: '', director: '', genre: '', releaseDate: '', durationSecs: 0, poster: '', imdbId: '', tmdbId: '', year: 0 });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Movies(container, handlers);
    Focus.setBase(() => view.focusScope);
    await view.openItem(account, vod('42', 'Deep Movie', '9'), onDetailBack);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Movie');
    // No browse is loaded underneath; Back returns to Search via the callback.
    expect(container.querySelector('.catalog-browse')).toBeNull();
    const logs = vi.spyOn(console, 'log');
    view.handleAction('back');
    Focus.flush();
    expect(eventLines(logs, 'nav.focus.repaired')).toEqual([]);
    logs.mockRestore();
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled(); // did not fall through to Live
  });
});

describe('Movies account-switch race', () => {
  it('a superseded a1 open() cannot clobber a2 rails (account-switch race)', async () => {
    const a1: PlaylistEntry = { id: 'a1', name: 'A1', url: 'http://host/a', source: 'xtream', xtream: { username: 'u1', password: 'p1' } };
    const a2: PlaylistEntry = { id: 'a2', name: 'A2', url: 'http://host/a', source: 'xtream', xtream: { username: 'u2', password: 'p2' } };

    let resolveA1Cats!: (v: unknown) => void;
    let resolveA2Cats!: (v: unknown) => void;
    let resolveA2Streams!: (v: unknown) => void;

    catalogMock.loadVodCategories
      .mockReturnValueOnce(new Promise((r) => { resolveA1Cats = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveA2Cats = r; }));
    // a1's categories guard fires before loadVodStreams is called for a1,
    // so only one stream load occurs (for a2).
    catalogMock.loadVodStreams
      .mockReturnValueOnce(new Promise((r) => { resolveA2Streams = r; }));

    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const view = new Movies(container, handlers);
    Focus.setBase(() => view.focusScope);

    // Start both opens concurrently; neither has resolved yet.
    const p1 = view.open(a1);
    const a1Signal = catalogMock.loadVodCategories.mock.calls[0][1] as AbortSignal;
    const p2 = view.open(a2);
    expect(a1Signal.aborted).toBe(true);
    expect(catalogMock.loadVodCategories.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

    // Resolve a2's categories; wait for open(a2) to resume and call loadVodStreams.
    resolveA2Cats([{ id: 'c2', name: 'Cat Bravo' }]);
    await Promise.resolve(); await Promise.resolve();
    resolveA2Streams([vod('v2', 'Bravo Movie', 'c2')]);
    await p2;

    // Resolve a1's stale categories last — first guard discards them.
    resolveA1Cats([{ id: 'c1', name: 'Cat Alpha' }]);
    await p1;

    expect(container.textContent).toContain('Bravo Movie');
    expect(container.textContent).not.toContain('Alpha Movie');
    expect(container.textContent).toContain('Cat Bravo');
    expect(container.textContent).not.toContain('Cat Alpha');
  });
});
