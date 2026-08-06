// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: { loadVodCategories: vi.fn(), loadVodStreams: vi.fn(), loadVodInfo: vi.fn() },
    watchlistState,
    storageMock: {
      getResumeList: vi.fn(() => [] as unknown[]),
      getResume: vi.fn(() => null),
      getWatchlist: vi.fn(() => watchlistState.entries),
      isWatchlisted: vi.fn((_accountId: string, _kind: WatchlistKind, itemId: string) =>
        watchlistState.entries.some((entry) => entry.itemId === itemId)),
      toggleWatchlist: vi.fn((entry: WatchlistEntry) => {
        const index = watchlistState.entries.findIndex((item) => item.itemId === entry.itemId);
        if (index >= 0) {
          watchlistState.entries.splice(index, 1);
          return false;
        }
        watchlistState.entries.unshift(entry);
        return true;
      }),
    },
    toastMock: { showToast: vi.fn() },
  };
});
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Movies } from './movies';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', streamId: id, name, poster: '', rating: '', categoryId, containerExtension: 'mp4',
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // clearAllMocks clears calls but not implementations; re-establish the default
  // return so a prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], streams = [vod('10', 'Movie One')]) {
  catalogMock.loadVodCategories.mockResolvedValue(cats);
  catalogMock.loadVodStreams.mockResolvedValue(streams);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Movies(container, handlers);
  await view.open(account);
  return { view, handlers };
}

describe('Movies browse + grid', () => {
  it('renders a rail per preloaded category with poster tiles', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [vod('10', 'Movie One')]);
    expect(container.querySelector('.catalog-rail-title')?.textContent).toContain('Cat A');
    expect(container.querySelector('.catalog-tile[data-item-id="10"]')?.textContent).toContain('Movie One');
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

  it('reveals the tab bar when Up cannot move within the view', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalled();
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
      .toBe(`${String((50_000 - 6) * 320)}px`);

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

  it('snaps free grid scrolling to the nearest row after it stops', async () => {
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
      vi.advanceTimersByTime(100);

      expect(grid.scrollTop).toBe(521);
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
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders plot/meta and a Play button, and plays from the start', async () => {
    catalogMock.loadVodInfo.mockResolvedValue({
      plot: 'A plot.', cast: 'Actor A', director: 'Dir A', genre: 'Drama',
      releaseDate: '2020-05-01', durationSecs: 3600, poster: 'http://host:8080/p.jpg', imdbId: '', tmdbId: '', year: 0,
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
    await view.openItem(account, vod('42', 'Deep Movie', '9'), onDetailBack);
    expect(container.querySelector('.movies-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Movie');
    // No browse is loaded underneath; Back returns to Search via the callback.
    expect(container.querySelector('.catalog-browse')).toBeNull();
    view.handleAction('back');
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
