// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry, WatchlistEntry, WatchlistKind } from '../types';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = { entries: [] as WatchlistEntry[] };
  return {
    catalogMock: { loadSeriesCategories: vi.fn(), loadSeries: vi.fn(), loadSeriesInfo: vi.fn() },
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

import { Series } from './series';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const series = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', seriesId: id, name, poster: '', rating: '', categoryId,
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  // clearAllMocks clears calls but not implementations; re-establish defaults so a
  // prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], items = [series('s1', 'Series One')]) {
  catalogMock.loadSeriesCategories.mockResolvedValue(cats);
  catalogMock.loadSeries.mockResolvedValue(items);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Series(container, handlers);
  await view.open(account);
  return { view, handlers };
}

describe('Series browse + grid', () => {
  it('renders a rail per preloaded category with poster tiles', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], [series('s1', 'Series One')]);
    expect(container.querySelector('.catalog-rail-title')?.textContent).toContain('Cat A');
    expect(container.querySelector('.catalog-tile[data-item-id="s1"]')?.textContent).toContain('Series One');
  });

  it('updates the hero title and backdrop to the focused series', async () => {
    const s1 = { accountId: 'x1', seriesId: 's1', name: 'Series One', poster: 'http://host/a1.jpg', rating: '', categoryId: '1' };
    const s2 = { accountId: 'x1', seriesId: 's2', name: 'Series Two', poster: 'http://host/a2.jpg', rating: '', categoryId: '1' };
    await openWith([{ id: '1', name: 'Cat A' }], [s1, s2]);
    const hero = container.querySelector<HTMLElement>('.catalog-hero')!;
    const title = () => container.querySelector('.catalog-hero-title')?.textContent;

    container.querySelector('.catalog-tile[data-item-id="s2"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Series Two');
    expect(hero.style.backgroundImage).toContain('a2.jpg');

    container.querySelector('.catalog-tile[data-item-id="s1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(title()).toBe('Series One');
    expect(hero.style.backgroundImage).toContain('a1.jpg');
  });

  it('shows a Continue rail from the episode resume list and resumes an episode directly', async () => {
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1 — Episode One', poster: '', ext: 'mkv', position: 300, duration: 1500, updatedAt: 1 },
    ]);
    const { view, handlers } = await openWith();
    expect(container.textContent).toContain('Continue Watching');
    const tile = container.querySelector('.catalog-tile[data-resume-episode="e1"]') as HTMLElement;
    expect(tile).not.toBeNull();
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 300,
      url: 'http://host:8080/series/u/p/e1.mkv',
    }));
  });

  it('shows a Watchlist rail from stored series snapshots', async () => {
    watchlistState.entries = [{
      accountId: 'x1', kind: 'series', itemId: 's9', name: 'Saved Series',
      poster: '', rating: '', categoryId: '9', addedAt: 2,
    }];
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(container.textContent).toContain('Watchlist');
    const tile = container.querySelector('.catalog-tile[data-item-id="s9"]') as HTMLElement;
    expect(tile.textContent).toContain('Saved Series');
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.series-detail')?.textContent).toContain('Saved Series');
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
    const { view, handlers } = await openWith(cats, [series('s1', 'Series One')]);
    const cat = container.querySelector('.catalog-cat[data-category-id="7"]') as HTMLElement;
    expect(cat).not.toBeNull();
    cat.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    catalogMock.loadSeries.mockResolvedValue([series('s2', 'Series Two', '7')]);
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.catalog-grid')).not.toBeNull();
    expect(container.querySelector('.catalog-tile[data-item-id="s2"]')).not.toBeNull();
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('opens a series detail on select and backs out to browse', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Series One');
    view.handleAction('back');
    expect(container.querySelector('.catalog-browse')).not.toBeNull();
    expect(handlers.onBack).not.toHaveBeenCalled();
  });

  it('goes back to Live from the browse top level', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('refreshes the Continue rail from storage on each browse render', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    expect(container.textContent).not.toContain('Continue Watching');
    // An episode is watched, so a resume entry now exists; walking detail -> browse
    // should surface it without re-entering the section.
    storageMock.getResumeList.mockReturnValue([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1', poster: '', ext: 'mp4', position: 300, duration: 1500, updatedAt: 1 },
    ]);
    const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    view.handleAction('back'); // detail -> browse re-render
    expect(container.textContent).toContain('Continue Watching');
  });
});

const SERIES_INFO = {
  seasons: [1, 2],
  episodesBySeason: {
    1: [{ id: 'e1', title: 'Episode One', season: 1, episode: 1, containerExtension: 'mp4', durationSecs: 1500, plot: 'Ep plot.', poster: '' }],
    2: [{ id: 'e2', title: 'Episode Two', season: 2, episode: 1, containerExtension: 'mkv', durationSecs: 1600, plot: '', poster: '' }],
  },
};

async function openDetail(view: Series) {
  const tile = container.querySelector('.catalog-tile[data-item-id="s1"]') as HTMLElement;
  tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  view.handleAction('select');
  await Promise.resolve(); await Promise.resolve(); // info-less render, then the loaded render
}

describe('Series detail', () => {
  it('adds and removes the series from Watchlist without losing button focus', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view } = await openWith();
    await openDetail(view);

    const button = container.querySelector('[data-action="watchlist"]') as HTMLElement;
    button.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.toggleWatchlist).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'x1', kind: 'series', itemId: 's1', name: 'Series One',
    }));
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Remove from Watchlist');
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('renders a season selector and the first season\'s episodes, and plays from the start', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.series-season-btn[data-season="1"]')?.textContent).toContain('Season 1');
    expect(container.querySelector('.series-season-btn[data-season="2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')?.textContent).toContain('Episode One');
    expect(container.textContent).toContain('Ep plot.');

    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1', accountId: 'x1', kind: 'episode', resumeSecs: 0,
      url: 'http://host:8080/series/u/p/e1.mp4',
      title: expect.stringContaining('S1E1'),
      watchlistOwner: { kind: 'series', itemId: 's1' },
      episodeQueue: [
        expect.objectContaining({
          itemId: 'e2',
          url: 'http://host:8080/series/u/p/e2.mkv',
          title: expect.stringContaining('S2E1'),
          watchlistOwner: { kind: 'series', itemId: 's1' },
        }),
      ],
    }));
  });

  it('switches season and plays that season\'s episode with its own container extension', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    const season2 = container.querySelector('.series-season-btn[data-season="2"]') as HTMLElement;
    season2.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(container.querySelector('.episode-row[data-episode-id="e2"]')).not.toBeNull();
    expect(container.querySelector('.episode-row[data-episode-id="e1"]')).toBeNull();

    const row = container.querySelector('.episode-row[data-episode-id="e2"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e2', kind: 'episode', url: 'http://host:8080/series/u/p/e2.mkv',
    }));
  });

  it('marks an episode with a resume point and passes its saved position', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) =>
      id === 'e1' ? { accountId: 'x1', kind: 'episode', itemId: 'e1', name: '', poster: '', position: 450, duration: 1500, updatedAt: 1 } : null);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.episode-row[data-episode-id="e1"] .episode-resume')).not.toBeNull();
    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e1', resumeSecs: 450 }));
  });

  it('restores the remaining episode queue from Continue Watching', async () => {
    const next = {
      url: 'http://host:8080/series/u/p/e2.mkv', title: 'Series One — S2E1 — Episode Two',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
    };
    storageMock.getResumeList.mockReturnValue([
      {
        accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One — S1E1',
        poster: '', ext: 'mp4', position: 450, duration: 1500, updatedAt: 1,
        episodeQueue: [next],
        watchlistOwner: { kind: 'series', itemId: 's1' },
      },
    ]);
    const { view, handlers } = await openWith();
    const tile = container.querySelector('.catalog-tile[data-resume-episode="e1"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
  });

  it('shows an empty state when the series has no seasons', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('No episodes available');
  });

  it('shows a failed state instead of a perpetual Loading when info is null', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(null);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load episodes.");
    expect(container.textContent).not.toContain('Loading…');
  });
});

describe('Series deep-link (openItem)', () => {
  it('opens a series detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Series(container, handlers);
    await view.openItem(account, series('s9', 'Deep Series', '9'), onDetailBack);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Series');
    expect(container.querySelector('.catalog-browse')).toBeNull();
    view.handleAction('back');
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});
