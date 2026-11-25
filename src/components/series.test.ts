// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  PlaylistEntry, ResumeEntry, ResumeKind, VodQueueItem, WatchlistEntry, WatchlistKind,
} from '../types';
import type { CatalogSortPreference } from '../utils/catalog-sort';

const { catalogMock, storageMock, watchlistState, toastMock } = vi.hoisted(() => {
  const watchlistState = {
    entries: [] as WatchlistEntry[],
    marks: {} as Record<string, { watched?: boolean; hidden?: boolean }>,
  };
  const setMarks = (kind: string, ids: string[], flags: { watched?: boolean; hidden?: boolean }) => {
    for (const id of ids) watchlistState.marks[`${kind}|${id}`] = { ...watchlistState.marks[`${kind}|${id}`], ...flags };
  };
  return {
    catalogMock: { loadSeriesCategories: vi.fn(), loadSeries: vi.fn(), loadSeriesInfo: vi.fn() },
    watchlistState,
    storageMock: {
      getLlmConfig: vi.fn(() => ({ baseUrl: 'http://host/v1', model: 'm1' })),
      getCatalogSort: vi.fn((): CatalogSortPreference => ({ by: 'default', direction: 'asc' })),
      setCatalogSort: vi.fn((_kind: 'vod' | 'series', _sort: CatalogSortPreference) => true),
      getResumeList: vi.fn(() => [] as unknown[]),
      catalogMarkIds: vi.fn((_accountId: string, kind: string, flag: 'watched' | 'hidden') =>
        new Set(Object.keys(watchlistState.marks)
          .filter(key => key.split('|')[0] === kind && watchlistState.marks[key][flag])
          .map(key => key.split('|')[1]))),
      setCatalogMark: vi.fn((_accountId: string, kind: string, id: string,
        flags: { watched?: boolean; hidden?: boolean }) => setMarks(kind, [id], flags)),
      setCatalogMarks: vi.fn((_accountId: string, kind: string, ids: string[],
        flags: { watched?: boolean; hidden?: boolean }) => setMarks(kind, ids, flags)),
      isWatched: vi.fn(() => false),
      getResume: vi.fn((_accountId: string, _kind: ResumeKind, _itemId: string): ResumeEntry | null => null),
      clearResume: vi.fn(),
      getWatchlist: vi.fn(() => watchlistState.entries),
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
const { llmMock } = vi.hoisted(() => {
  const translateVod = vi.fn();
  // Each item of a batch answered as the tests set the one-item answer.
  const translateVods = vi.fn((items: unknown[], target: string, signal: AbortSignal) => Promise.all(items.map(item =>
    Promise.resolve(translateVod(item, target, signal)).then((text: unknown) => ({ text }), (error: unknown) => ({ error })))));
  return { llmMock: { isReady: vi.fn(() => false), translateVod, translateVods } };
});
vi.mock('../services/llm/llm-service', () => ({ LlmService: { isReady: llmMock.isReady } }));
vi.mock('../services/vod-translation', () => ({ translateVods: llmMock.translateVods }));
vi.mock('../services/xtream-catalog', () => catalogMock);
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { Series } from './series';
import { Focus } from '../navigation/focus-scope';
import { ProgramTranslation, resetProgramTranslationForTests, TRANSLATION_DWELL_MS } from './program-translation';
import { ParentalControlService } from '../services/parental-control';
import { LlmError } from '../services/llm/client';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const series = (id: string, name: string, categoryId = '1') => ({
  accountId: 'x1', seriesId: id, name, poster: '', rating: '', categoryId,
});

let container: HTMLElement;
function eventLines(spy: { mock: { calls: unknown[][] } }, code: string): string[] {
  return spy.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes(`event=${code} `));
}

beforeEach(() => {
  Focus.uninstall();
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  watchlistState.marks = {};
  // clearAllMocks clears calls but not implementations; re-establish defaults so a
  // prior test's mockReturnValue override doesn't leak (order-safety).
  storageMock.getResumeList.mockReturnValue([]);
  storageMock.getResume.mockReturnValue(null);
  storageMock.getCatalogSort.mockReturnValue({ by: 'default', direction: 'asc' });
  storageMock.setCatalogSort.mockReturnValue(true);
  watchlistState.entries = [];
  container = document.createElement('div');
  document.body.appendChild(container);
});

async function openWith(cats = [{ id: '1', name: 'Cat A' }], items = [series('s1', 'Series One')]) {
  catalogMock.loadSeriesCategories.mockResolvedValue(cats);
  catalogMock.loadSeries.mockResolvedValue(items);
  const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
  const view = new Series(container, handlers);
  Focus.setBase(() => view.focusScope);
  await view.open(account);
  return { view, handlers };
}

describe('Series browse + grid', () => {
  it('returns to the neighboring episode after direct browse playback completes', async () => {
    const entries = ['e1', 'e2', 'e3', 'e4'].map((itemId, i) => ({
      accountId: 'x1', kind: 'episode', itemId, name: `Title ${i}`, poster: '', ext: 'mp4',
      position: 100, duration: 600, updatedAt: 4 - i,
    }));
    storageMock.getResumeList.mockReturnValue(entries);
    const { view, handlers } = await openWith();
    const episode = container.querySelector<HTMLElement>('[data-resume-episode="e3"]')!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e3' }));
    storageMock.getResumeList.mockReturnValue([entries[0], entries[1], entries[3]]);
    view.refreshPlaybackState();
    expect(container.querySelector('.catalog-layer-browse .focused')?.getAttribute('data-key')).toBe('r:e4');
  });

  it('leaves the collection when playback completes its final episode', async () => {
    storageMock.getResumeList.mockReturnValue([{
      accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Title 1', poster: '', ext: 'mp4',
      position: 100, duration: 600, updatedAt: 1,
    }]);
    const { view } = await openWith();
    container.querySelector<HTMLElement>('[data-collection-manage="continue"]')!.click();
    view.handleAction('back');
    const episode = container.querySelector<HTMLElement>('.catalog-layer-grid [data-resume-episode]')!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    storageMock.getResumeList.mockReturnValue([]);
    view.refreshPlaybackState();
    expect(container.querySelector('.catalog-layer-grid')?.textContent).toBe('');
    expect(container.querySelector('[data-rail-key="continue"]')).toBeNull();
    expect(container.querySelector('.catalog-layer-browse .focused')).not.toBeNull();
  });

  it('keeps the resumed episode focused when playback moves it to the front of the collection', async () => {
    const entries = ['e1', 'e2', 'e3'].map((itemId, i) => ({
      accountId: 'x1', kind: 'episode', itemId, name: `Title ${i}`, poster: '', ext: 'mp4',
      position: 100, duration: 600, updatedAt: 3 - i,
    }));
    storageMock.getResumeList.mockReturnValue(entries);
    const { view, handlers } = await openWith();
    const manage = container.querySelector<HTMLElement>('[data-collection-manage="continue"]')!;
    manage.click();
    view.handleAction('back');
    const episode = container.querySelector<HTMLElement>('.catalog-layer-grid [data-resume-episode="e2"]')!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e2' }));
    storageMock.getResumeList.mockReturnValue([entries[1], entries[0], entries[2]]);
    view.refreshPlaybackState();
    expect(container.querySelector('.catalog-layer-grid .focused')?.getAttribute('data-key')).toBe('r:e2');
    expect(container.querySelector('.catalog-layer-grid .focused')?.closest('[data-grid-index]')
      ?.getAttribute('data-grid-index')).toBe('0');
  });

  it('restores its own saved sort field and direction', async () => {
    storageMock.getCatalogSort.mockReturnValue({ by: 'name', direction: 'desc' });
    await openWith(undefined, [series('s1', 'Title 1'), series('s2', 'Title 2'), series('s10', 'Title 10')]);
    expect(storageMock.getCatalogSort).toHaveBeenCalledWith('series');
    expect(Array.from(container.querySelectorAll<HTMLElement>(
      '[data-rail-key="cat:1"] .catalog-tile',
    )).map(el => el.dataset.itemId)).toEqual(['s10', 's2', 's1']);
    expect(container.querySelector('[data-sort-direction="desc"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('writes series direction changes without changing movie preferences', async () => {
    const { view } = await openWith(undefined, [series('s2', 'Title 2'), series('s1', 'Title 1')]);
    container.querySelector<HTMLElement>('.dropdown-trigger')!.click();
    container.querySelector<HTMLElement>('[data-dropdown-value="name"]')!.click();
    container.querySelector<HTMLElement>('[data-sort-direction="desc"]')!.click();
    expect(storageMock.setCatalogSort).toHaveBeenLastCalledWith('series', { by: 'name', direction: 'desc' });
    expect(storageMock.setCatalogSort.mock.calls.every(([kind]) => kind === 'series')).toBe(true);
    expect(view.focusScope.focusKey).toBe(JSON.stringify(['browse', '', 'sort-direction:name:desc']));
  });

  it('labels See all with the series count', async () => {
    await openWith([{ id: '1', name: 'Cat A' }], Array.from({ length: 21 }, (_, i) => series(`s${String(i)}`, `Series ${String(i)}`)));
    expect(container.querySelector('.catalog-see-all')?.textContent).toContain('21 series');
  });

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

  it.each([true, false])('updates the hero from resumed episodes with a loaded category: %s', async withCategory => {
    storageMock.getResumeList.mockReturnValue([1, 2].map(n => ({
      accountId: 'x1', kind: 'episode', itemId: `e${n}`, name: `Episode ${n}`,
      poster: `http://host/episode${n}.jpg`, ext: 'mp4',
      position: 100, duration: 600, updatedAt: 3 - n,
    })));
    await openWith(withCategory ? [{ id: '1', name: 'Cat A' }] : [], withCategory
      ? [{ ...series('s1', 'Series One'), poster: 'http://host/catalog.jpg' }] : []);
    const hero = container.querySelector<HTMLElement>('.catalog-hero')!;
    for (const n of [2, 1]) {
      container.querySelector<HTMLElement>(`[data-resume-episode="e${n}"]`)!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(container.querySelector('.catalog-hero-title')?.textContent).toBe(`Episode ${n}`);
      expect(hero.style.backgroundImage).toContain(`episode${n}.jpg`);
    }
    if (withCategory) {
      container.querySelector<HTMLElement>('[data-item-id="s1"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(container.querySelector('.catalog-hero-title')?.textContent).toBe('Series One');
      expect(hero.style.backgroundImage).toContain('catalog.jpg');
    }
    expect(catalogMock.loadSeriesInfo).not.toHaveBeenCalled();
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
    expect(container.querySelector('.catalog-sort .focused')).not.toBeNull();
    expect(handlers.onRevealTabBar).not.toHaveBeenCalled();
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

  it('returns from a removed Watchlist series to its rail neighbor, not its category twin', async () => {
    const saved = (id: string, addedAt: number): WatchlistEntry => ({
      accountId: 'x1', kind: 'series', itemId: id, name: `Series ${id}`, poster: '',
      rating: '', categoryId: '1', addedAt,
    });
    watchlistState.entries = [saved('s0', 3), saved('s1', 2), saved('s2', 1)];
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const { view } = await openWith(
      [{ id: '1', name: 'Cat A' }],
      [series('s0', 'Series s0'), series('s1', 'Series s1'), series('s2', 'Series s2')],
    );
    const watchlist = container.querySelector('[data-rail-key="watchlist"]')!;
    watchlist.querySelector('[data-item-id="s1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();
    container.querySelector('[data-action="watchlist"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    view.handleAction('back');

    const focused = container.querySelector<HTMLElement>('.catalog-browse .focused');
    expect(focused?.closest('[data-rail-key]')?.getAttribute('data-rail-key')).toBe('watchlist');
    expect(focused?.dataset.itemId).toBe('s2');
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
  plot: 'Series plot.',
  cast: 'Actor 1, Actor 2',
  director: 'Director 1',
  genre: 'Drama',
  releaseDate: '2021-02-03',
  episodeRunTimeMins: 45,
  poster: 'http://host/series.jpg',
  rating: '8.4',
  imdbId: '1234567',
  tmdbId: '7654',
  year: 2021,
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
  it('shows a watched episode and hides the series from its detail', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    watchlistState.marks['episode|e1'] = { watched: true };
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('[data-episode-id="e1"] .episode-watched')?.textContent).toBe('Watched');
    view.focusScope.track(JSON.stringify(['detail', '', 'hide']));
    view.handleAction('select');
    expect(storageMock.setCatalogMark).toHaveBeenCalledWith('x1', 'series', 's1', { hidden: true });
  });

  describe('watched marks', () => {
    const label = (key: string) => container.querySelector(`[data-key="${key}"]`)?.textContent?.trim();
    const select = (view: Series, key: string) => {
      view.focusScope.track(JSON.stringify(['detail', '', key]));
      view.handleAction('select');
    };

    it('marks the whole series, then clears it again', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      const { view } = await openWith();
      await openDetail(view);
      expect(label('watched')).toBe('Mark as watched');
      select(view, 'watched');
      expect(storageMock.setCatalogMarks).toHaveBeenCalledWith('x1', 'episode', ['e1', 'e2'], { watched: true });
      expect(watchlistState.marks['series|s1']).toEqual({ watched: true });
      expect(toastMock.showToast).toHaveBeenLastCalledWith('Marked as watched');
      expect(label('watched')).toBe('Mark as not watched');
      expect(label('season-watched')).toBe('Mark season as not watched');
      expect(container.querySelector('[data-key="ep-mark:e1"]')?.classList.contains('watched')).toBe(true);
      select(view, 'watched');
      expect(watchlistState.marks['episode|e1']).toEqual({ watched: false });
      expect(watchlistState.marks['series|s1']).toEqual({ watched: false });
      expect(label('watched')).toBe('Mark as watched');
    });

    it('marks a season, dropping its place in Continue Watching, and the last one marks the series', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      storageMock.getResumeList.mockReturnValue([{
        accountId: 'x1', kind: 'episode', itemId: 'e1', name: 'Series One', poster: '', ext: 'mp4',
        position: 100, duration: 1500, updatedAt: 1,
        watchlistOwner: { kind: 'series', itemId: 's1' },
      }]);
      // A hidden series' places stay out of Continue Watching, but not out of storage.
      watchlistState.marks['series|s1'] = { hidden: true };
      const { view } = await openWith();
      await (view as unknown as { openDetail(s: unknown): Promise<void> }).openDetail(series('s1', 'Series One'));
      select(view, 'season-watched');
      expect(storageMock.setCatalogMarks).toHaveBeenCalledWith('x1', 'episode', ['e1'], { watched: true });
      expect(storageMock.clearResume).toHaveBeenCalledWith('x1', 'episode', 'e1');
      expect(toastMock.showToast).toHaveBeenLastCalledWith('Season marked as watched');
      expect(watchlistState.marks['series|s1'].watched).toBeFalsy();
      select(view, 'season:2');
      select(view, 'season-watched');
      expect(watchlistState.marks['series|s1']).toEqual({ hidden: true, watched: true });
    });

    it('toggles one episode by its mark or the green key', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      const { view } = await openWith();
      await openDetail(view);
      select(view, 'ep-mark:e1');
      expect(watchlistState.marks['episode|e1']).toEqual({ watched: true });
      expect(container.querySelector('[data-episode-id="e1"] .episode-watched')).not.toBeNull();
      view.focusScope.track(JSON.stringify(['detail', '', 'ep:e1']));
      view.handleAction('green');
      expect(watchlistState.marks['episode|e1']).toEqual({ watched: false });
      expect(toastMock.showToast).toHaveBeenLastCalledWith('Marked as not watched');
    });

    it("leaves another account's series mark alone when the account switches", async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      const { view } = await openWith();
      await openDetail(view);
      watchlistState.marks['series|s1'] = { watched: true };
      void view.open({ ...account, id: 'x2' });
      expect(storageMock.setCatalogMark).not.toHaveBeenCalledWith('x2', 'series', 's1', { watched: false });
      expect(watchlistState.marks['series|s1']).toEqual({ watched: true });
    });

    it('offers no series mark when its seasons list no episodes', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue({ ...SERIES_INFO, episodesBySeason: { 1: [], 2: [] } });
      const { view } = await openWith();
      await openDetail(view);
      expect(container.querySelector('[data-key="watched"]')).toBeNull();
    });

    it('makes a watched series unwatched once it lists a new episode', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      watchlistState.marks['series|s1'] = { watched: true };
      watchlistState.marks['episode|e1'] = { watched: true };
      const { view } = await openWith();
      expect(container.querySelector('.catalog-tile[data-item-id="s1"] .catalog-watched-badge')).not.toBeNull();
      await openDetail(view);
      expect(watchlistState.marks['series|s1']).toEqual({ watched: false });
      expect(label('watched')).toBe('Mark as watched');
    });

    it('keeps Down on the watched marks column', async () => {
      catalogMock.loadSeriesInfo.mockResolvedValue({
        ...SERIES_INFO,
        seasons: [1],
        episodesBySeason: { 1: [SERIES_INFO.episodesBySeason[1][0], { ...SERIES_INFO.episodesBySeason[2][0], season: 1, episode: 2 }] },
      });
      const { view } = await openWith();
      await openDetail(view);
      view.focusScope.track(JSON.stringify(['detail', '', 'ep-mark:e1']));
      document.documentElement.classList.add('keyboard-nav');
      for (let i = 0; i < 2; i++) { // the first press shows the ring
        view.handleAction('down');
        Focus.input();
        Focus.flush();
      }
      document.documentElement.classList.remove('keyboard-nav');
      expect(view.focusScope.focusKey).toBe(JSON.stringify(['detail', '', 'ep-mark:e2']));
    });
  });

  it('renders a bounded episode window for a 50,000-item season', async () => {
    const episodes = Array.from({ length: 50_000 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({
      seasons: [1],
      episodesBySeason: { 1: episodes },
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(container.querySelectorAll('.episode-row').length).toBeLessThan(20);
    expect(container.querySelector<HTMLElement>('.series-episodes-spacer')?.style.height)
      .toBe('6900000px');

    const detail = container.querySelector<HTMLElement>('.series-detail')!;
    detail.scrollTop = 100 * 138;
    detail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const episode = container.querySelector<HTMLElement>(
      '[data-episode-index="100"] .episode-row',
    )!;
    episode.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    view.refreshPlaybackState();
    Focus.flush();

    expect(container.querySelector<HTMLElement>('.focused')?.dataset.key).toBe('ep:e100');
  });

  it('brings in an episode the list scrolled away instantly when a held key reaches it', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { view } = await openWith();
      await openDetail(view);
      const detail = container.querySelector<HTMLElement>('.series-detail')!;
      const keyOf = (index: number): string => {
        const row = container.querySelector<HTMLElement>(`[data-episode-index="${String(index)}"] [data-key]`)!;
        const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
        return JSON.stringify(['detail', rail, row.dataset.key]);
      };
      const first = keyOf(0);
      view.focusScope.focus(keyOf(1), 'key');
      Focus.flush();

      let top = 0;
      const behaviors: string[] = [];
      Object.defineProperty(detail, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = value; behaviors.push(detail.style.scrollBehavior); },
      });
      top = 100 * 138;
      detail.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(container.querySelector('[data-episode-index="0"]')).toBeNull();
      behaviors.length = 0;

      view.focusScope.focus(first, 'key');
      Focus.flush();

      expect(container.querySelector('[data-episode-index="0"]')).not.toBeNull();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).toEqual(behaviors.map(() => 'auto'));
    } finally {
      clock.mockRestore();
    }
  });

  it('scrolls smoothly again when a later input reveals the same episode a held key reached', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { view } = await openWith();
      await openDetail(view);
      const detail = container.querySelector<HTMLElement>('.series-detail')!;
      const keyOf = (index: number): string => {
        const row = container.querySelector<HTMLElement>(`[data-episode-index="${String(index)}"] [data-key]`)!;
        const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
        return JSON.stringify(['detail', rail, row.dataset.key]);
      };
      const first = keyOf(0);
      view.focusScope.focus(keyOf(1), 'key');
      Focus.flush();

      let top = 0;
      const behaviors: string[] = [];
      Object.defineProperty(detail, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = value; behaviors.push(detail.style.scrollBehavior); },
      });
      const scrollAway = async (): Promise<void> => {
        top = 100 * 138;
        detail.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(container.querySelector('[data-episode-index="0"]')).toBeNull();
        behaviors.length = 0;
      };
      await scrollAway();
      now += 50;
      view.focusScope.focus(first, 'key');
      Focus.flush();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).toEqual(behaviors.map(() => 'auto'));

      for (let frame = 0; frame < 2; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      await scrollAway();
      now += 1_000;
      view.focusScope.focus(first, 'key');
      Focus.flush();

      expect(container.querySelector('[data-episode-index="0"]')).not.toBeNull();
      expect(behaviors.length).toBeGreaterThan(0);
      expect(behaviors).not.toContain('auto');
    } finally {
      clock.mockRestore();
    }
  });

  it('brings a scrolled-away episode fully in when its rows measure taller than estimated', async () => {
    const episodes = Array.from({ length: 500 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [1], episodesBySeason: { 1: episodes } });
    const rect = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (!this.classList.contains('episode-row')) return rect.call(this);
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 184, width: 0, height: 184, toJSON: () => ({}) };
    });
    try {
      const { view } = await openWith();
      await openDetail(view);
      const row = container.querySelector<HTMLElement>('[data-episode-index="0"] [data-key]')!;
      const rail = row.closest<HTMLElement>('[data-rail-key]')?.dataset.railKey ?? '';
      expect(container.querySelector('[data-episode-index="40"]')).toBeNull();

      view.focusScope.focus(JSON.stringify(['detail', rail, 'ep:e40']), 'key');
      Focus.flush();

      const list = (view as unknown as {
        episodeVirtualizer: { scrollOffset: number; getItemOffset(index: number): number };
      }).episodeVirtualizer;
      const viewport = 984;
      expect(list.getItemOffset(41) - list.getItemOffset(40)).toBe(200);
      expect(list.getItemOffset(41)).toBeLessThanOrEqual(list.scrollOffset + viewport);
      expect(list.getItemOffset(40)).toBeGreaterThanOrEqual(list.scrollOffset);
      expect(container.querySelector<HTMLElement>('.series-detail')!.scrollTop).toBe(list.scrollOffset);
      expect(container.querySelector<HTMLElement>('.focused')?.dataset.key).toBe('ep:e40');
    } finally {
      spy.mockRestore();
    }
  });

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
    Focus.flush();
    expect(container.querySelector('.focused')?.getAttribute('data-key')).toBe('watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Added to Watchlist');

    view.handleAction('select');
    expect(container.querySelector('[data-action="watchlist"]')?.textContent).toContain('Add to Watchlist');
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Watchlist');
  });

  it('shows a loaded poster card inside the page, so it scrolls away with the header', async () => {
    const images: Array<{ url: string; onload: (() => void) | null }> = [];
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      url = '';
      set src(value: string) { this.url = value; images.push(this); }
    });
    try {
      catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
      const { view } = await openWith();
      await openDetail(view);
      expect(container.querySelector('.detail-poster-art')).toBeNull();
      images.find((img) => img.url === 'http://host/series.jpg')!.onload!();
      expect(container.querySelector<HTMLImageElement>('.series-detail .detail-poster-art img')?.src)
        .toBe('http://host/series.jpg');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders a season selector and the first season\'s episodes, and plays from the start', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.detail-meta')?.textContent)
      .toContain('2021  ·  45 min  ·  Drama  ·  8.4');
    expect(container.querySelector('.detail-plot')?.textContent).toBe('Series plot.');
    expect(container.querySelectorAll('.detail-cast')[0]?.textContent)
      .toContain('Cast Actor 1, Actor 2');
    expect(container.querySelectorAll('.detail-cast')[1]?.textContent)
      .toContain('Director Director 1');
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
      episodeTitle: 'Episode One',
      // The series' ids, for the online subtitle search.
      searchMeta: { season: 1, episode: 1, imdbId: '1234567', tmdbId: '7654' },
      watchlistOwner: {
        kind: 'series', itemId: 's1', name: 'Series One', poster: 'http://host/series.jpg',
      },
      episodeQueue: [
        expect.objectContaining({
          itemId: 'e2',
          url: 'http://host:8080/series/u/p/e2.mkv',
          title: expect.stringContaining('S2E1'),
          watchlistOwner: expect.objectContaining({ kind: 'series', itemId: 's1' }),
        }),
      ],
    }));
  });

  it('renders the normalized year when no release date is available', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({
      ...SERIES_INFO,
      releaseDate: '',
      year: 2022,
    });
    const { view } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.detail-meta')?.textContent)
      .toContain('2022  ·  45 min  ·  Drama  ·  8.4');
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
      previousEpisodes: [expect.objectContaining({ itemId: 'e1' })],
      episodeQueue: [],
    }));
  });

  it('marks an episode with a resume point and passes its saved position', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) =>
      id === 'e1' ? { accountId: 'x1', kind: 'episode', itemId: 'e1', name: '', poster: '', ext: 'mp4', position: 450, duration: 1500, updatedAt: 1 } : null);
    const { view, handlers } = await openWith();
    await openDetail(view);

    expect(container.querySelector('.episode-row[data-episode-id="e1"] .episode-resume')).not.toBeNull();
    const row = container.querySelector('.episode-row[data-episode-id="e1"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e1', resumeSecs: 450 }));
  });

  const ownedResume = (
    itemId: string, name: string, updatedAt: number, extra: Partial<ResumeEntry> = {},
  ): ResumeEntry => ({
    accountId: 'x1', kind: 'episode', itemId, name, poster: 'http://host/ep.jpg', ext: 'mp4',
    position: 450, duration: 1500, updatedAt, categoryId: '1',
    watchlistOwner: { kind: 'series', itemId: 's1' }, ...extra,
  });

  it('shows one stacked Continue Watching tile per series, for its latest episode', async () => {
    storageMock.getResumeList.mockReturnValue([
      ownedResume('e2', 'Series One — S2E1 — Episode Two', 2),
      ownedResume('e1', 'Series One — S1E1', 1),
    ]);
    await openWith();
    const tiles = container.querySelectorAll<HTMLElement>('[data-rail-key="continue"] .catalog-tile');
    expect(tiles).toHaveLength(1);
    expect(tiles[0].classList.contains('catalog-tile-stack')).toBe(true);
    expect(tiles[0].dataset.itemId).toBe('s1');
    expect(tiles[0].querySelector('.catalog-tile-name')?.textContent).toBe('Series One');
    expect(tiles[0].querySelector('.catalog-tile-sub')?.textContent).toBe('S2 E1');
  });

  it('opens the series on the resumed season, focused on Resume, which keeps the episode queue', async () => {
    const next: VodQueueItem = {
      url: 'http://host:8080/series/u/p/e3.mkv', title: 'Series One — S2E2',
      poster: '', accountId: 'x1', itemId: 'e3', kind: 'episode', subtitles: [],
    };
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResumeList.mockReturnValue([ownedResume('e2', 'Series One — S2E1 — Episode Two', 2, {
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1', name: 'Series One', poster: 'http://host/series.jpg' },
    })]);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) =>
      id === 'e2' ? ownedResume('e2', '', 2) : null);
    const { view, handlers } = await openWith([{ id: '1', name: 'Cat A' }], []);
    const tile = container.querySelector('[data-rail-key="continue"] .catalog-tile') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve(); await Promise.resolve();

    expect(container.querySelector('.detail-title')?.textContent).toBe('Series One');
    expect(container.querySelector('.series-season-btn.active')?.getAttribute('data-season')).toBe('2');
    const resume = container.querySelector('.catalog-layer-detail .focused');
    expect(resume?.getAttribute('data-action')).toBe('resume');
    expect(resume?.textContent).toContain('S2 E1');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e2', resumeSecs: 450, url: 'http://host:8080/series/u/p/e2.mkv',
    }));
  });

  it('removes every episode of the series from Continue Watching', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResumeList.mockReturnValue([
      ownedResume('e2', 'Series One — S2E1 — Episode Two', 2),
      ownedResume('e1', 'Series One — S1E1', 1),
    ]);
    const { view } = await openWith();
    await openDetail(view);
    storageMock.getResumeList.mockReturnValue([]);
    const remove = container.querySelector('[data-action="remove-resume"]') as HTMLElement;
    remove.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');

    expect(storageMock.clearResume.mock.calls).toEqual([['x1', 'episode', 'e2'], ['x1', 'episode', 'e1']]);
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Removed from Continue Watching');
    expect(container.querySelector('[data-action="resume"]')).toBeNull();
    expect(container.querySelector('[data-action="remove-resume"]')).toBeNull();
  });

  it('reads the episode code from the entry, not a title that looks like one', async () => {
    storageMock.getResumeList.mockReturnValue([
      ownedResume('e2', 'Series One — S2E1 — Recap — S9E9', 2, { season: 2, episode: 1 }),
      { ...ownedResume('e7', 'Series Two — S1E3 — Recap — S9E9', 1),
        watchlistOwner: { kind: 'series', itemId: 's2' } },
    ]);
    await openWith();
    const tiles = container.querySelectorAll('[data-rail-key="continue"] .catalog-tile');
    expect(Array.from(tiles, tile => [
      tile.querySelector('.catalog-tile-name')?.textContent,
      tile.querySelector('.catalog-tile-sub')?.textContent,
    ])).toEqual([['Series One', 'S2 E1'], ['Series Two', 'S1 E3']]);
  });

  it('follows playback into the next season when it returns to the detail', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResumeList.mockReturnValue([ownedResume('e1', 'Series One — S1E1', 1)]);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.series-season-btn.active')?.getAttribute('data-season')).toBe('1');
    storageMock.getResumeList.mockReturnValue([ownedResume('e2', 'Series One — S2E1', 2)]);
    view.refreshPlaybackState();
    expect(container.querySelector('.series-season-btn.active')?.getAttribute('data-season')).toBe('2');
    expect(container.querySelector('.episode-row[data-episode-id="e2"]')).not.toBeNull();
  });

  it('stays on the browsed season when playback leaves the series\' place unchanged', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    storageMock.getResumeList.mockReturnValue([ownedResume('e1', 'Series One — S1E1', 1)]);
    const { view, handlers } = await openWith();
    await openDetail(view);
    const season2 = container.querySelector('.series-season-btn[data-season="2"]') as HTMLElement;
    season2.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    const row = container.querySelector('.episode-row[data-episode-id="e2"]') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'e2' }));
    view.refreshPlaybackState();
    expect(container.querySelector('.series-season-btn.active')?.getAttribute('data-season')).toBe('2');
    expect(container.querySelector('.catalog-layer-detail .focused')?.getAttribute('data-episode-id')).toBe('e2');
  });

  it('keeps the episode code when Resume plays before the series info arrives', async () => {
    catalogMock.loadSeriesInfo.mockReturnValue(new Promise(() => undefined));
    storageMock.getResumeList.mockReturnValue([
      ownedResume('e2', 'Series One — S2E1', 2, { season: 2, episode: 1, imdbId: '123' }),
      ownedResume('e7', 'Series One — S1E3', 1),
    ]);
    const { view, handlers } = await openWith();
    const tile = container.querySelector('[data-rail-key="continue"] .catalog-tile') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();
    expect(container.querySelector('.catalog-layer-detail .focused')?.getAttribute('data-action')).toBe('resume');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenLastCalledWith(expect.objectContaining({
      itemId: 'e2', searchMeta: { season: 2, episode: 1, imdbId: '123' },
    }));
  });

  it('offers Play, not Resume, for a queued episode not yet started', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const queued = { ...ownedResume('e1', 'Series One — S1E1', 1), position: 0, duration: 0 };
    storageMock.getResumeList.mockReturnValue([queued]);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) => id === 'e1' ? queued : null);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('[data-action="resume"]')?.textContent).toContain('Play');
    expect(container.querySelector('[data-action="resume"]')?.textContent).not.toContain('Resume');
    expect(container.querySelector('.episode-row[data-episode-id="e1"] .episode-resume')).toBeNull();
  });

  it('keeps a held name and an instant switch through a re-render', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const { view } = await openWith();
    await openDetail(view);
    view.focusScope.track(JSON.stringify(['detail', '', 'hide']));
    const hide = () => container.querySelector<HTMLElement>('[data-action="hide"]')!;
    hide().dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    expect(hide().classList.contains('name-held')).toBe(true);
    const internals = view as unknown as { renderDetail(restoreFocus?: boolean): void; instantRow: HTMLElement | null };
    internals.instantRow = hide().parentElement;
    hide().parentElement!.classList.add('names-instant');
    internals.renderDetail(false);
    expect(hide().classList.contains('name-held')).toBe(true);
    expect(hide().parentElement!.classList.contains('names-instant')).toBe(true);
  });

  it('ends an instant name switch only after the latest one\'s frames', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    try {
      const { view } = await openWith();
      await openDetail(view);
      const swap = (action: string) => (view as unknown as { swapNames(el: HTMLElement): void })
        .swapNames(container.querySelector<HTMLElement>(`[data-action="${action}"]`)!);
      const row = container.querySelector<HTMLElement>('[data-action="watchlist"]')!.parentElement!;
      const frame = () => frames.splice(0).forEach((callback) => callback(0));
      swap('watchlist');
      swap('watched');
      expect(row.classList.contains('names-instant')).toBe(true);
      frame();
      swap('hide');
      frame();
      expect(row.classList.contains('names-instant')).toBe(true);
      frame();
      frame();
      expect(row.classList.contains('names-instant')).toBe(false);
    } finally {
      raf.mockRestore();
    }
  });

  it('measures the round actions\' names once, not on every re-render', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('detail-icon-name') ? 100 : 0;
      return { left: 0, top: 0, width, height: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    try {
      const { view } = await openWith();
      await openDetail(view);
      const names = () => measured.mock.contexts.filter((el) => (el as HTMLElement).classList.contains('detail-icon-name')).length;
      expect(names()).toBeGreaterThan(0);
      expect(container.querySelector<HTMLElement>('.detail-icon-row')?.style.getPropertyValue('--name-width')).toBe('100px');
      const before = names();
      (view as unknown as { renderDetail(restoreFocus?: boolean): void }).renderDetail(false);
      expect(names()).toBe(before);
      expect(container.querySelector<HTMLElement>('.detail-icon-row')?.style.getPropertyValue('--name-width')).toBe('100px');
    } finally {
      measured.mockRestore();
    }
  });

  it('draws resume progress only once a queued episode has been started', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
    let entry = { ...ownedResume('e1', 'Series One — S1E1', 1), position: 0 };
    storageMock.getResumeList.mockImplementation(() => [entry]);
    storageMock.getResume.mockImplementation((_a: string, _k: string, id: string) => id === 'e1' ? entry : null);
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('[data-action="resume"] .detail-btn-progress')).toBeNull();
    entry = { ...entry, position: 450 };
    view.handleAction('back');
    await openDetail(view);
    expect(container.querySelector('[data-action="resume"] .detail-btn-progress')).not.toBeNull();
  });

  it('shows a loaded series\' poster for an entry saved without one', async () => {
    storageMock.getResumeList.mockReturnValue([ownedResume('e1', 'Series One — S1E1', 1)]);
    await openWith(undefined, [{ ...series('s1', 'Series One'), poster: 'http://host/series.jpg' }]);
    const tile = container.querySelector('[data-rail-key="continue"] .catalog-tile')!;
    expect(tile.querySelector('img')?.getAttribute('src')).toBe('http://host/series.jpg');
  });

  it('spaces the Continue grid for the episode-code line', async () => {
    storageMock.getResumeList.mockReturnValue(Array.from({ length: 12 }, (_, i) =>
      ({ ...ownedResume(`e${i}`, `Series ${i} — S1E1`, 12 - i), watchlistOwner: { kind: 'series', itemId: `s${i}` } })));
    await openWith();
    container.querySelector<HTMLElement>('[data-collection-manage="continue"]')!.click();
    const grid = container.querySelector('.catalog-layer-grid .catalog-grid')!;
    expect(grid.classList.contains('catalog-grid-captioned')).toBe(true);
    const tops = Array.from(grid.querySelectorAll<HTMLElement>('.catalog-grid-cell'), cell => cell.style.top);
    expect(tops).toContain('419px');
    expect(tops).not.toContain('395px');
  });

  it('removes a grouped series tile from the managed collection as a whole', async () => {
    storageMock.getResumeList.mockReturnValue([
      ownedResume('e2', 'Series One — S2E1 — Episode Two', 2),
      ownedResume('e1', 'Series One — S1E1', 1),
    ]);
    const { view } = await openWith();
    container.querySelector<HTMLElement>('[data-collection-manage="continue"]')!.click();
    const mark = container.querySelector('.catalog-layer-grid .catalog-remove-mark') as HTMLElement;
    mark.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.clearResume.mock.calls).toEqual([['x1', 'episode', 'e2'], ['x1', 'episode', 'e1']]);
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
    expect(container.textContent).toContain('Unable to load episodes.');
    expect(container.textContent).not.toContain('Loading…');
  });
});

describe('Series deep-link (openItem)', () => {
  it('opens a series detail directly and Back returns to Search via the callback', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue({ seasons: [], episodesBySeason: {} });
    const handlers = { onRevealTabBar: vi.fn(), onBack: vi.fn(), onPlayVod: vi.fn() };
    const onDetailBack = vi.fn();
    const view = new Series(container, handlers);
    Focus.setBase(() => view.focusScope);
    await view.openItem(account, series('s9', 'Deep Series', '9'), onDetailBack);
    expect(container.querySelector('.series-detail')).not.toBeNull();
    expect(container.textContent).toContain('Deep Series');
    expect(container.querySelector('.catalog-browse')).toBeNull();
    const logs = vi.spyOn(console, 'log');
    view.handleAction('back');
    Focus.flush();
    expect(eventLines(logs, 'nav.focus.repaired')).toEqual([]);
    logs.mockRestore();
    expect(onDetailBack).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});

describe('Series detail translation', () => {
  beforeEach(() => {
    // Earlier tests' views stay on the page, and their late art would ask for their own details.
    Array.from(document.body.children).forEach(el => { if (el !== container) el.remove(); });
    vi.useFakeTimers();
    llmMock.isReady.mockReturnValue(true);
    llmMock.translateVod.mockImplementation(async (text: { title: string; description: string }) =>
      ({ title: `${text.title} (de)`, description: text.description ? `${text.description} (de)` : '' }));
    catalogMock.loadSeriesInfo.mockResolvedValue(SERIES_INFO);
  });
  afterEach(() => {
    resetProgramTranslationForTests();
    llmMock.isReady.mockReturnValue(false);
    document.documentElement.classList.remove('keyboard-nav');
    // A view left on the page would still ask for its own detail's translation.
    container.remove();
    vi.useRealTimers();
  });

  it('translates the series and its episodes on screen in one request', async () => {
    const { view } = await openWith();
    await openDetail(view);
    view.focusScope.track(JSON.stringify(['detail', '', 'translate']));
    view.handleAction('select');
    expect(ProgramTranslation.active).toBe(true);
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVods.mock.calls.map(call => call[0])).toEqual([[
      { title: 'Series One', description: 'Series plot.' },
      { title: 'Episode One', description: 'Ep plot.' },
    ]]);
    expect(container.querySelector('.series-detail .detail-title')!.textContent).toBe('Series One (de)');
    expect(container.querySelector('.series-detail .detail-plot')!.textContent).toBe('AI translation · Series plot. (de)');
    expect(container.querySelector('[data-episode-id="e1"] .episode-name')!.textContent).toBe('Episode One (de)');
    expect(container.querySelector('[data-episode-id="e1"] .episode-plot')!.textContent).toBe('AI translation · Ep plot. (de)');

    // The focus moving onto an episode already translated asks for nothing more.
    container.querySelector('[data-episode-id="e1"]')!.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVods).toHaveBeenCalledTimes(1);
  });

  const translateButton = () => container.querySelector<HTMLElement>('.series-detail [data-key="translate"]');
  const hoverEpisode = (id: string) =>
    container.querySelector(`[data-episode-id="${id}"]`)!.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  const select = (view: Series, key: string) => {
    view.focusScope.track(JSON.stringify(['detail', '', key]));
    view.handleAction('select');
  };
  const manyEpisodes = {
    ...SERIES_INFO,
    seasons: [1],
    episodesBySeason: { 1: ['e1', 'e2', 'e3', 'e4'].map((id, i) => ({
      id, title: `Episode ${i + 1}`, season: 1, episode: i + 1, containerExtension: 'mp4', durationSecs: 1500, plot: `Plot ${i + 1}.`, poster: '',
    })) },
  };

  it('translates the name of a series whose info failed to load', async () => {
    catalogMock.loadSeriesInfo.mockRejectedValue(new Error('offline'));
    const { view } = await openWith();
    await openDetail(view);
    expect(container.querySelector('.catalog-hint')?.textContent).toBeTruthy();
    select(view, 'translate');
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVod.mock.calls.map(call => call[0])).toEqual([{ title: 'Series One', description: '' }]);
    expect(container.querySelector('.series-detail .detail-title')!.textContent).toBe('Series One (de)');
    // Below the title, whose line clamp would cut it.
    expect(container.querySelector('.series-detail .detail-title-label')!.textContent).toBe('AI translation');
  });

  it('sends nothing from a series parental controls protect, its episodes included', async () => {
    vi.spyOn(ParentalControlService, 'protects').mockReturnValue(true);
    ProgramTranslation.toggle();
    const { view } = await openWith();
    await openDetail(view);
    expect(translateButton()).toBeNull();
    hoverEpisode('e1');
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVod).not.toHaveBeenCalled();
    expect(container.querySelector('[data-episode-id="e1"] .episode-plot')!.textContent).toBe('Ep plot.');
    vi.restoreAllMocks();
  });

  it('sends nothing for a series in an unknown category while parental controls are on', async () => {
    // Its category is locked, but the item doesn't say which one it is in.
    vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    vi.spyOn(ParentalControlService, 'protects').mockReturnValue(false);
    ProgramTranslation.toggle();
    const { view } = await openWith([{ id: '', name: 'Cat A' }], [series('s1', 'Series One', '')]);
    await openDetail(view);
    expect(translateButton()).toBeNull();
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVod).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('sends nothing for an episode left by Back or played before the focus rested', async () => {
    ProgramTranslation.toggle();
    const { view, handlers } = await openWith();
    await openDetail(view);
    hoverEpisode('e1');
    view.handleAction('select');
    expect(handlers.onPlayVod).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVod).not.toHaveBeenCalled();

    view.refreshPlaybackState();
    hoverEpisode('e1');
    view.handleAction('back');
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVod).not.toHaveBeenCalled();
  });

  it('sends the episodes on screen once, however fast the focus moves among them', async () => {
    catalogMock.loadSeriesInfo.mockResolvedValue(manyEpisodes);
    ProgramTranslation.toggle();
    const { view } = await openWith();
    await openDetail(view);
    document.documentElement.classList.add('keyboard-nav');
    view.focusScope.track(JSON.stringify(['detail', '', 'ep:e1']));
    Focus.flush();
    for (let i = 0; i < 3; i++) {
      view.handleAction('down');
      Focus.input();
      Focus.flush();
      await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS / 4);
    }
    expect(view.focusScope.focusKey).toBe(JSON.stringify(['detail', '', 'ep:e4']));
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(llmMock.translateVods).toHaveBeenCalledTimes(1);
    expect((llmMock.translateVods.mock.calls[0][0] as Array<{ title: string }>).map(item => item.title))
      .toEqual(['Series One', 'Episode 1', 'Episode 2', 'Episode 3', 'Episode 4']);
  });

  for (const [reason, message] of [['cap', 'Daily AI limit reached. Translation paused.'], ['auth', 'AI setup problem. Translation paused.']] as const) {
    it(`turns translation off with a message on a ${reason} error`, async () => {
      llmMock.translateVod.mockRejectedValue(new LlmError(reason, 'x'));
      const { view } = await openWith();
      await openDetail(view);
      select(view, 'translate');
      expect(translateButton()!.getAttribute('aria-label')).toBe('Show original');
      await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
      expect(toastMock.showToast).toHaveBeenCalledWith(message);
      expect(ProgramTranslation.active).toBe(false);
      expect(translateButton()!.getAttribute('aria-label')).toBe('Translate with AI');
      expect(translateButton()!.classList.contains('on')).toBe(false);
    });
  }

  it('asks again for a series translation that failed when Translate is pressed', async () => {
    llmMock.translateVod.mockRejectedValueOnce(new LlmError('network', 'offline'));
    const { view } = await openWith();
    await openDetail(view);
    select(view, 'translate');
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(container.querySelector('.series-detail .detail-plot')!.textContent).toBe('Translation failed · Series plot.');
    expect(translateButton()!.getAttribute('aria-label')).toBe('Translate with AI');

    const seriesCalls = () => llmMock.translateVod.mock.calls.filter(call => (call[0] as { title: string }).title === 'Series One');
    select(view, 'translate');
    expect(ProgramTranslation.active).toBe(true);
    // The press asks again at once, without the focus pause.
    expect(seriesCalls()).toHaveLength(2);
    expect(container.querySelector('.series-detail .detail-plot')!.textContent).toBe('Translating… · Series plot.');
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
    expect(seriesCalls()).toHaveLength(2);
    expect(container.querySelector('.series-detail .detail-plot')!.textContent).toBe('AI translation · Series plot. (de)');
    expect(translateButton()!.getAttribute('aria-label')).toBe('Show original');
  });
});
