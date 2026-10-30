// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlaylistEntry, Programme } from '../types';
import type { SearchIndexPersistRequest, SearchIndexRequest, SearchQueryRequest } from '../workers/tasks';

const {
  catalogMock,
  playlistMock,
  epgMock,
  reminderMock,
  storageMock,
  archiveMock,
  toastMock,
  workerMock,
  cacheMock,
  persistMock,
} = vi.hoisted(() => ({
  persistMock: vi.fn(async (_candidates?: Array<{ key: string; prefix: string }>) => undefined),
  catalogMock: {
    getSearchCatalogExpiresAt: vi.fn(),
    loadAllVodStreams: vi.fn(),
    loadAllSeries: vi.fn(),
    loadVodCategories: vi.fn(async () => [] as unknown[]),
    loadSeriesCategories: vi.fn(async () => [] as unknown[]),
    onCatalogListRefreshed: vi.fn(),
  },
  playlistMock: {
    channels: [] as unknown[],
    search: vi.fn(() => [] as unknown[]),
    searchRanked: vi.fn(),
    indexOf: vi.fn(() => 0),
    getChannelCacheSource: vi.fn((): unknown => null),
  },
  epgMock: {
    programmes: {} as Record<string, Programme[]>,
    findChannelId: vi.fn((channel: { id: string }) => channel.id),
    getSourceUrl: vi.fn(() => 'http://host/epg.xml'),
    programmeCacheOrigin: vi.fn((): unknown => null),
  },
  reminderMock: { has: vi.fn(() => false), add: vi.fn(), remove: vi.fn() },
  storageMock: {
    getCatchupProgressList: vi.fn(() => [] as unknown[]),
    clearCatchupProgress: vi.fn(),
    addSearchHistory: vi.fn(),
    getHideArabic: vi.fn(() => false),
  },
  archiveMock: {
    load: vi.fn(async () => null as Set<number> | null),
    isAvailable: vi.fn((channel: { catchupSource?: string }) => !!channel.catchupSource),
  },
  toastMock: vi.fn(),
  workerMock: {
    run: vi.fn(),
    retain: vi.fn(() => vi.fn()),
    running: false,
    generation: 0,
    restart: (): void => undefined,
    terminate: (): void => undefined,
  },
  cacheMock: {
    records: new Map<string, Record<string, unknown>>(),
    refs: new WeakMap<object, unknown>(),
    sources: new WeakMap<object, object>(),
  },
}));
// Tests hand the catalog mocks item arrays; Search receives them as column
// tables, the same table for the same array, and a cache record remembered
// for an array belongs to its columns.
vi.mock('../services/xtream-catalog', async () => {
  const { CatalogColumnsBuilder, CatalogTable } = await import('../services/catalog-table');
  const tables = new WeakMap<object, unknown>();
  const toTable = (kind: 'vod' | 'series') => (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const known = tables.get(value);
    if (known) return known;
    const builder = new CatalogColumnsBuilder(kind, 'x1');
    for (const item of value as Array<Record<string, unknown>>) {
      builder.add({
        ...(item as unknown as { name: string; poster: string; rating: string; categoryId: string }),
        id: String(kind === 'vod' ? item.streamId : item.seriesId),
      });
    }
    const columns = builder.build();
    cacheMock.sources.set(columns, value);
    const table = new CatalogTable(columns);
    tables.set(value, table);
    return table;
  };
  return {
    ...catalogMock,
    loadAllVodStreams: (...args: unknown[]) =>
      Promise.resolve(catalogMock.loadAllVodStreams(...args)).then(toTable('vod')),
    loadAllSeries: (...args: unknown[]) =>
      Promise.resolve(catalogMock.loadAllSeries(...args)).then(toTable('series')),
  };
});
vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({ EpgService: epgMock }));
vi.mock('../services/reminder-service', () => ({ ReminderService: reminderMock }));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../services/xtream-archive', () => ({ XtreamArchiveService: archiveMock }));
vi.mock('./toast', () => ({ showToast: toastMock }));
vi.mock('../services/search-index-store', () => ({ persistSearchIndexes: persistMock }));
vi.mock('../services/idb-cache', async importOriginal => ({
  ...await importOriginal<typeof import('../services/idb-cache')>(),
  cacheRecordRef: (value: object) => cacheMock.refs.get(cacheMock.sources.get(value) ?? value) ?? null,
}));
vi.mock('../workers/app-worker-client', async () => {
  const { SearchWorkerIndex } = await import('../workers/search-index');
  const createIndex = () => new SearchWorkerIndex({
    read: async ref => cacheMock.records.get(`${ref.store}|${ref.key}`) ?? null,
    count: async ref => cacheMock.records.has(`${ref.store}|${ref.key}`) ? 1 : 0,
    write: async (store, value) => {
      cacheMock.records.set(`${store}|${String(value.key)}`, value);
    },
  });
  let index = createIndex();
  // A crash, or an idle termination followed by another task's start: a new, empty worker.
  workerMock.restart = () => {
    index = createIndex();
    workerMock.generation++;
    workerMock.running = true;
  };
  // The worker and its index are gone; the next task starts an empty one.
  workerMock.terminate = () => {
    index = createIndex();
    workerMock.running = false;
  };
  workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
    if (!workerMock.running) workerMock.generation++;
    workerMock.running = true;
    if (task === 'search.index') return index.index(payload as SearchIndexRequest);
    if (task === 'search.query') return index.query(payload as SearchQueryRequest);
    if (task === 'search.persist') return index.persist(payload as SearchIndexPersistRequest);
    throw new Error(`Unexpected worker task: ${task}`);
  });
  return {
    runAppWorkerTask: workerMock.run,
    retainAppWorker: workerMock.retain,
    appWorkerGeneration: () => workerMock.running ? workerMock.generation : null,
  };
});

import { Search } from './search';
import { CONFIG } from '../config';
import { Focus } from '../navigation/focus-scope';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, name: string) => ({ accountId: 'x1', streamId: id, name, poster: '', rating: '', categoryId: '1', containerExtension: 'mp4' });
const ser = (id: string, name: string) => ({ accountId: 'x1', seriesId: id, name, poster: '', rating: '', categoryId: '1' });
const chan = (name: string) => ({ id: name, name, logo: '', group: '', url: `http://host/${name}`, extras: null, playlistIds: ['x1'], catchup: '', catchupSource: '', catchupDays: 0 });
const prog = (title: string, start: number, stop: number): Programme => ({
  title,
  start: new Date(start),
  stop: new Date(stop),
  description: '',
  category: 'Drama',
  icon: '',
});

let container: HTMLElement;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  workerMock.terminate();
  playlistMock.channels = [];
  playlistMock.search.mockReturnValue([]);
  playlistMock.searchRanked.mockImplementation((query: string, limit: number) => {
    const items = playlistMock.search(query);
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  });
  playlistMock.indexOf.mockReturnValue(0);
  playlistMock.getChannelCacheSource.mockReturnValue(null);
  epgMock.programmeCacheOrigin.mockReturnValue(null);
  cacheMock.records.clear();
  epgMock.programmes = {};
  epgMock.findChannelId.mockImplementation((channel: { id: string }) => channel.id);
  reminderMock.has.mockReturnValue(false);
  storageMock.getCatchupProgressList.mockReturnValue([]);
  archiveMock.load.mockResolvedValue(null);
  archiveMock.isAvailable.mockImplementation((channel: { catchupSource?: string }) => !!channel.catchupSource);
  catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(
    Date.now() + CONFIG.XTREAM.DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
});

function mkHandlers() {
  return {
    onRevealTabBar: vi.fn(),
    onReleaseTabBar: vi.fn(),
    onBack: vi.fn(),
    onPlayChannel: vi.fn(),
    onOpenMovie: vi.fn(),
    onOpenSeries: vi.fn(),
  };
}

// Every source has reached the worker, so a query runs at once.
async function indexReady(view: Search): Promise<void> {
  await vi.waitFor(() => {
    expect((view as unknown as { pendingIndex: unknown }).pendingIndex).toBeNull();
  }, { timeout: 3000 });
}

function diagEvents(spy: { mock: { calls: unknown[][] } }, event: string): string[] {
  return spy.mock.calls
    .map(call => call.filter(part => typeof part === 'string').join(' '))
    .filter(line => line.includes(`event=${event} `));
}

// The catalog refresh replaced the movie list and settled.
async function refreshLanded(view: Search, name: string): Promise<void> {
  const internals = view as unknown as { allVod: { length: number; nameAt: (index: number) => string } };
  await vi.waitFor(() => expect(internals.allVod.length && internals.allVod.nameAt(0)).toBe(name));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function sequelPosts(): unknown[] {
  return workerMock.run.mock.calls.filter(([task, payload]) =>
    task === 'search.index'
    && (payload as SearchIndexRequest).chunk?.names?.indexOf('Alpha Sequel') === 0);
}

// Index posts whose first catalog name is the given one.
function namePosts(name: string): unknown[] {
  return workerMock.run.mock.calls.filter(([task, payload]) =>
    task === 'search.index' && (payload as SearchIndexRequest).chunk?.names?.[0] === name);
}

// Animation frames wait for release(), which runs them and lets later ones through.
function holdFrames() {
  const pending: FrameRequestCallback[] = [];
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    pending.push(callback);
    return pending.length;
  });
  return {
    release: () => {
      if (!vi.isMockFunction(window.requestAnimationFrame)) return;
      frame.mockRestore();
      for (const callback of pending.splice(0)) callback(performance.now());
    },
  };
}

// A worker task that waits for release() before it runs.
function holdWorkerTask(matches: (task: string, payload: SearchIndexRequest) => boolean) {
  const originalRun = workerMock.run.getMockImplementation()!;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const hold = { held: false, release, restore: () => workerMock.run.mockImplementation(originalRun) };
  workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
    if (!hold.held && matches(task, payload)) {
      hold.held = true;
      await released;
    }
    return originalRun(task, payload);
  });
  return hold;
}

const openViews: Search[] = [];

async function openWith(opts: { vod?: unknown[]; series?: unknown[] } = {}) {
  catalogMock.loadAllVodStreams.mockResolvedValue(opts.vod ?? []);
  catalogMock.loadAllSeries.mockResolvedValue(opts.series ?? []);
  const handlers = mkHandlers();
  const view = new Search(container, handlers);
  openViews.push(view);
  await view.open(account);
  await indexReady(view);
  return { view, handlers };
}

afterEach(() => {
  // An active view's unfinished index build or query would run into the next test.
  for (const view of openViews.splice(0)) view.deactivate();
  // A failed assertion skips a test's own mockRestore.
  for (const method of ['log', 'warn', 'error'] as const) {
    if (vi.isMockFunction(console[method])) console[method].mockRestore();
  }
  Focus.setBase(() => null);
  Focus.uninstall();
});

describe('Search', () => {
  it('renders results-only and empty on open (no in-view query box, no hint)', async () => {
    await openWith();
    expect(container.querySelector('.search-results')).not.toBeNull();
    expect(container.querySelector('.search-input')).toBeNull(); // the box lives in the tab bar
    // The results view is only shown once a query is typed, so it renders empty.
    expect(container.querySelector('.search-results')?.textContent?.trim()).toBe('');
  });

  it('reuses a complete worker index when Search reopens before idle termination', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    const initialResets = workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    ).length;

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    view.deactivate();
    await view.open(account);
    await view.setQuery('alpha');

    expect(workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    )).toHaveLength(initialResets);
    expect(diagEvents(info, 'search.index.ready'))
      .toEqual([expect.stringContaining('mode=reused channels=1 programmes=0 items=1')]);
    info.mockRestore();
    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Alpha Movie');
  });

  it('leaves out Arabic titles and titles in Arabic categories while the setting is on', async () => {
    storageMock.getHideArabic.mockReturnValue(true);
    catalogMock.loadVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }, { id: '2', name: 'أفلام' }]);
    try {
      const { view } = await openWith({
        vod: [vod('10', 'Alpha Movie'), vod('11', 'Alpha فيلم'), { ...vod('12', 'Alpha Three'), categoryId: '2' }],
        series: [ser('s1', 'Alpha Show'), ser('s2', 'Alpha مسلسل')],
      });
      await view.setQuery('alpha');
      expect(container.textContent).toContain('Alpha Movie');
      expect(container.textContent).toContain('Alpha Show');
      expect(container.textContent).not.toContain('فيلم');
      expect(container.textContent).not.toContain('مسلسل');
      expect(container.textContent).not.toContain('Alpha Three');
    } finally {
      storageMock.getHideArabic.mockReturnValue(false);
      catalogMock.loadVodCategories.mockResolvedValue([]);
    }
  });

  it('reloads the account catalog after it is invalidated', async () => {
    const { view } = await openWith({ vod: [vod('10', 'Old Movie')] });
    view.deactivate();
    view.invalidateCatalog();
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
    catalogMock.loadAllSeries.mockResolvedValue([]);

    await view.open(account);
    await indexReady(view);
    await view.setQuery('movie');

    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('New Movie');
    expect(container.textContent).not.toContain('Old Movie');
  });

  it('keeps the ready worker index while an expired catalog is retried without content changes', async () => {
    const movies = [vod('10', 'Alpha Movie')];
    const series = [ser('20', 'Alpha Series')];
    const movieRef = { store: 'catalog-cache', key: 'x1|vod_all', timestamp: 1303 };
    const seriesRef = { store: 'catalog-cache', key: 'x1|series_all', timestamp: 1304 };
    cacheMock.refs.set(movies, movieRef);
    cacheMock.refs.set(series, seriesRef);
    cacheMock.records.set('catalog-cache|x1|vod_all', { timestamp: 1303, data: movies });
    cacheMock.records.set('catalog-cache|x1|series_all', { timestamp: 1304, data: series });
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    const { view } = await openWith({ vod: movies, series });
    const indexed = workerMock.run.mock.calls.filter(([task]) => task === 'search.index').length;
    const copiedMovies = movies.map(item => ({ ...item }));
    const copiedSeries = series.map(item => ({ ...item }));
    cacheMock.refs.set(copiedMovies, movieRef);
    cacheMock.refs.set(copiedSeries, seriesRef);
    catalogMock.loadAllVodStreams.mockResolvedValue(copiedMovies);
    catalogMock.loadAllSeries.mockResolvedValue(copiedSeries);
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() + 60_000);

    view.deactivate();
    await view.open(account);
    await vi.waitFor(() => expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(catalogMock.getSearchCatalogExpiresAt).toHaveBeenCalledTimes(2));
    await view.setQuery('alpha');

    expect(workerMock.run.mock.calls.filter(([task]) => task === 'search.index')).toHaveLength(indexed);
    expect(container.textContent).toContain('Alpha Movie');
    expect(container.textContent).toContain('Alpha Series');
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as
      (key: string, changed?: boolean) => void;
    refreshed('x1|vod_all-v3', false);
    await vi.waitFor(() => expect(catalogMock.getSearchCatalogExpiresAt).toHaveBeenCalledTimes(3));
    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2);
    expect(workerMock.run.mock.calls.filter(([task]) => task === 'search.index')).toHaveLength(indexed);
  });

  it('ignores a superseded refresh for the same account', async () => {
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    const { view } = await openWith({ vod: [vod('10', 'Old Movie')] });
    let finishStale: (value: unknown[]) => void = () => undefined;
    const stale = new Promise<unknown[]>(resolve => { finishStale = resolve; });
    catalogMock.loadAllVodStreams.mockReturnValueOnce(stale);

    view.deactivate();
    await view.open(account);
    await vi.waitFor(() => expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2));
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() + 60_000);
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    refreshed('x1|vod_all-v3');
    await view.setQuery('movie');
    await vi.waitFor(() => expect(container.textContent).toContain('New Movie'));

    finishStale([vod('10', 'Old Movie')]);
    await stale;
    await new Promise(resolve => setTimeout(resolve, 0));
    await view.setQuery('movie');

    expect(container.textContent).toContain('New Movie');
    expect(container.textContent).not.toContain('Old Movie');
  });

  it('does not mark an inactive stale load fresh after a changed catalog notification', async () => {
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    const { view } = await openWith({ vod: [vod('10', 'Old Movie')] });
    let finishExpiry: (value: number) => void = () => undefined;
    const staleExpiry = new Promise<number>(resolve => { finishExpiry = resolve; });
    catalogMock.getSearchCatalogExpiresAt.mockReturnValueOnce(staleExpiry);

    view.deactivate();
    await view.open(account);
    await vi.waitFor(() => expect(catalogMock.getSearchCatalogExpiresAt).toHaveBeenCalledTimes(2));
    view.deactivate();
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
    const expiresAt = Date.now() + 60_000;
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(expiresAt);
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    refreshed('x1|vod_all-v3');
    finishExpiry(expiresAt);
    await staleExpiry;
    await new Promise(resolve => setTimeout(resolve, 0));

    await view.open(account);
    await indexReady(view);
    await view.setQuery('movie');

    expect(container.textContent).toContain('New Movie');
    expect(container.textContent).not.toContain('Old Movie');
    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(3);
  });

  it('reloads the account catalog after its natural TTL expires', async () => {
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    const { view } = await openWith({ vod: [vod('10', 'Old Movie')] });
    view.deactivate();
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
    catalogMock.loadAllSeries.mockResolvedValue([]);

    await view.open(account);
    await indexReady(view);
    await view.setQuery('movie');

    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(container.textContent).toContain('New Movie'));
    expect(container.textContent).not.toContain('Old Movie');
  });

  it('rebuilds the index after the shared worker was terminated while inactive', async () => {
    const { view } = await openWith();
    view.deactivate();
    workerMock.terminate();

    await view.open(account);

    expect(workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    )).toHaveLength(2);
  });

  it('rebuilds the index when another task started a new worker while inactive', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    view.deactivate();
    workerMock.restart();

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await view.open(account);
    await indexReady(view);
    await view.setQuery('alpha');

    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
    expect(diagEvents(info, 'search.index.ready'))
      .toEqual([expect.stringContaining('mode=fallback channels=1 programmes=0 items=1')]);
    warn.mockRestore();
    info.mockRestore();
    expect(workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    )).toHaveLength(2);
    expect(container.textContent).toContain('Alpha Movie');
  });

  it('rebuilds the index when its worker crashed before Search recorded it', async () => {
    playlistMock.channels = [chan('Alpha')];
    // indexSettled logs search.index.ready before it records the worker index.
    let fired = 0;
    const crashOnReady = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args.indexOf('event=search.index.ready') >= 0) {
        fired++;
        workerMock.terminate();
      }
    });
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    crashOnReady.mockRestore();
    expect(fired).toBe(1);
    view.deactivate();

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await view.open(account);
    await indexReady(view);
    await view.setQuery('alpha');

    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
    expect(diagEvents(info, 'search.index.ready'))
      .toEqual([expect.stringContaining('mode=fallback channels=1 programmes=0 items=1')]);
    warn.mockRestore();
    info.mockRestore();
    expect(container.textContent).toContain('Alpha Movie');
  });

  it('rebuilds the index when a new worker replaced its worker before Search recorded it', async () => {
    playlistMock.channels = [chan('Alpha')];
    // indexSettled logs search.index.ready before it records the worker index.
    let fired = 0;
    const restartOnReady = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (args.indexOf('event=search.index.ready') >= 0) {
        fired++;
        workerMock.restart();
      }
    });
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    restartOnReady.mockRestore();
    expect(fired).toBe(1);
    view.deactivate();

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await view.open(account);
    await indexReady(view);
    await view.setQuery('alpha');

    expect(diagEvents(warn, 'search.worker.index.missing')).toEqual([]);
    expect(diagEvents(info, 'search.index.ready'))
      .toEqual([expect.stringContaining('mode=fallback channels=1 programmes=0 items=1')]);
    warn.mockRestore();
    info.mockRestore();
    expect(container.textContent).toContain('Alpha Movie');
  });

  it('recovers from a worker crash while open and reuses the rebuilt index on reopen', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    workerMock.restart();

    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await view.setQuery('alpha');
    await vi.waitFor(() => expect(container.textContent).toContain('Alpha Movie'));
    expect(diagEvents(warn, 'search.worker.index.missing')).toHaveLength(1);
    expect(diagEvents(error, 'search.worker.index.missing')).toEqual([]);

    view.deactivate();
    await view.open(account);
    await view.setQuery('alpha');

    expect(diagEvents(info, 'search.index.ready'))
      .toEqual([expect.stringContaining('mode=reused channels=1 programmes=0 items=1')]);
    expect(diagEvents(warn, 'search.worker.index.missing')).toHaveLength(1);
    error.mockRestore();
    warn.mockRestore();
    info.mockRestore();
    expect(container.textContent).toContain('Alpha Movie');
  });

  it('does not reuse an index a catalog refresh completed during a crash rebuild', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    workerMock.restart();
    const originalRun = workerMock.run.getMockImplementation()!;
    let releaseChannels!: () => void;
    const channelsHeld = new Promise<void>(resolve => { releaseChannels = resolve; });
    let held = false;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (task === 'search.index' && payload.chunk?.source === 'channels' && !held) {
        held = true;
        await channelsHeld;
      }
      return originalRun(task, payload);
    });
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The query finds the new worker empty and rebuilds; its channels post stalls.
      const query = view.setQuery('alpha');
      await vi.waitFor(() => expect(held).toBe(true));
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'Alpha Sequel')]);
      const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
      refreshed('x1|vod_all-v3');
      // The refresh lands mid-rebuild; it must not call the index ready.
      await refreshLanded(view, 'Alpha Sequel');
      expect(sequelPosts()).toEqual([]);
      expect(diagEvents(info, 'search.worker.index.ready')).toEqual([]);

      view.deactivate();
      await view.open(account);
      expect(diagEvents(info, 'search.index.ready')).toEqual([]);
      releaseChannels();
      await query;
      await indexReady(view);
      await view.setQuery('alpha');
      // The query that started the rebuild was superseded; it must not fall back.
      expect(diagEvents(warn, 'search.worker.fallback.used')).toEqual([]);
    } finally {
      releaseChannels();
      info.mockRestore();
      warn.mockRestore();
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.querySelector('.catalog-tile[data-channel-index="0"]')?.textContent)
      .toContain('Alpha');
    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('keeps a catalog refresh that lands during a crash rebuild', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    workerMock.restart();
    const originalRun = workerMock.run.getMockImplementation()!;
    let releaseChannels!: () => void;
    const channelsHeld = new Promise<void>(resolve => { releaseChannels = resolve; });
    let held = false;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (task === 'search.index' && payload.chunk?.source === 'channels' && !held) {
        held = true;
        await channelsHeld;
      }
      return originalRun(task, payload);
    });
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const query = view.setQuery('alpha');
      await vi.waitFor(() => expect(held).toBe(true));
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'Alpha Sequel')]);
      const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
      refreshed('x1|vod_all-v3');
      await refreshLanded(view, 'Alpha Sequel');
      // The rebuild resumes after the refresh replaced the catalog.
      releaseChannels();
      await query;
      await view.setQuery('alpha');
      expect(container.textContent).toContain('Alpha Sequel');
      expect(container.textContent).not.toContain('Alpha Movie');

      info.mockClear();
      view.deactivate();
      await view.open(account);
      await view.setQuery('alpha');
      expect(diagEvents(info, 'search.index.ready'))
        .toEqual([expect.stringContaining('mode=reused')]);
    } finally {
      releaseChannels();
      info.mockRestore();
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('maps results onto a catalog refresh that replaced a crash rebuild post', async () => {
    playlistMock.channels = [chan('Alpha')];
    // Two chunks, so the rebuild's movie post spans a frame.
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie'), ...fillers] });
    workerMock.restart();
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'Alpha Sequel')]);
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const originalRun = workerMock.run.getMockImplementation()!;
    let fired = false;
    workerMock.run.mockImplementation((task: string, payload: SearchIndexRequest) => {
      if (task === 'search.index' && payload.chunk?.names?.[0] === 'Alpha Movie' && !fired) {
        fired = true;
        refreshed('x1|vod_all-v3');
      }
      return originalRun(task, payload);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await view.setQuery('alpha');
      expect(fired).toBe(true);
      await view.setQuery('alpha');
    } finally {
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('completes a crash rebuild that a catalog refresh post crossing its reset fails under', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    // Two chunks, so the refresh's movie post spans a frame.
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'Alpha Sequel'), ...fillers]);
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const originalRun = workerMock.run.getMockImplementation()!;
    let query: Promise<void> | null = null;
    let secondChunkSent!: () => void;
    const secondChunk = new Promise<void>(resolve => { secondChunkSent = resolve; });
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (task === 'search.index' && payload.chunk?.source === 'movies' && payload.chunk.start > 0) {
        secondChunkSent();
      }
      // The rebuild is busy with channels while the refresh's second chunk goes out.
      if (query && task === 'search.index' && payload.chunk?.source === 'channels') await secondChunk;
      const result = originalRun(task, payload);
      if (!query && task === 'search.index' && payload.chunk?.names?.[0] === 'Alpha Sequel') {
        // The worker crashes after the refresh's first chunk; a query rebuilds
        // it before the second goes out, so the new worker drops that chunk.
        workerMock.restart();
        query = view.setQuery('alpha');
      }
      return result;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(query).not.toBeNull());
      await query;
      expect(diagEvents(warn, 'search.index.lost')).toEqual([expect.stringContaining('source=catalog')]);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toEqual([]);
      const resets = workerMock.run.mock.calls.filter(
        ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
      ).length;
      await view.setQuery('alpha');
      expect(workerMock.run.mock.calls.filter(
        ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
      )).toHaveLength(resets);
    } finally {
      workerMock.run.mockImplementation(originalRun);
    }

    expect(diagEvents(warn, 'search.worker.fallback.used')).toEqual([]);
    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('posts the programmes an EPG refresh replaced during a crash rebuild', async () => {
    const later = (offset: number) => [Date.now() + offset * 3600000, Date.now() + (offset + 1) * 3600000] as const;
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = { Alpha: [prog('Old Report', ...later(1))] };
    const { view } = await openWith();
    workerMock.restart();
    const hold = holdWorkerTask((task, payload) => task === 'search.index' && payload.chunk?.source === 'channels');
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The query finds the new worker empty and rebuilds; its channels post stalls.
      const query = view.setQuery('report');
      await vi.waitFor(() => expect(hold.held).toBe(true));
      epgMock.programmes = { Alpha: [prog('New Show', ...later(1)), prog('Late Report', ...later(2))] };
      const refresh = view.refreshPrograms();
      await vi.waitFor(() => expect(workerMock.run.mock.calls.some(([task, payload]) => task === 'search.index'
        && JSON.stringify((payload as SearchIndexRequest).chunk?.documents ?? []).includes('Late Report')))
        .toBe(true));
      hold.release();
      await Promise.all([query, refresh]);
      await view.setQuery('report');
      expect(container.querySelector('.search-program-row')?.textContent).toContain('Late Report');

      info.mockClear();
      view.deactivate();
      await view.open(account);
      await view.setQuery('report');
      expect(diagEvents(info, 'search.index.ready')).toEqual([expect.stringContaining('mode=reused')]);
    } finally {
      hold.release();
      hold.restore();
    }

    const rows = Array.from(container.querySelectorAll('.search-program-row'), row => row.textContent);
    expect(rows).toEqual([expect.stringContaining('Late Report')]);
  });

  it('posts the channels a playlist change replaced during a crash rebuild', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith();
    workerMock.restart();
    const hold = holdWorkerTask((task, payload) => task === 'search.index' && payload.chunk?.source === 'channels');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const query = view.setQuery('alpha');
      await vi.waitFor(() => expect(hold.held).toBe(true));
      playlistMock.channels = [chan('Bravo'), chan('Alpha')];
      hold.release();
      await query;
      await view.setQuery('alpha');
    } finally {
      hold.release();
      hold.restore();
    }

    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).not.toContain('Bravo');
  });

  it('keeps an older catalog refresh from replacing a crash rebuild post', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    workerMock.restart();
    const channels = holdWorkerTask((task, payload) => task === 'search.index' && payload.chunk?.source === 'channels');
    const older = [vod('20', 'Alpha Old')];
    const newer = [vod('31', 'Bravo Other'), vod('30', 'Alpha Sequel')];
    // Had the older copy been indexed, it would go through the cache, whose
    // round trip would land its fallback post after the rebuild's own.
    cacheMock.refs.set(older, { store: 'catalog-cache', key: 'x1|vod_all', timestamp: 5 });
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let cache: ReturnType<typeof holdWorkerTask> | null = null;
    try {
      const query = view.setQuery('alpha');
      await vi.waitFor(() => expect(channels.held).toBe(true));
      cache = holdWorkerTask((task, payload) => task === 'search.index' && !!payload.cachedMovies);
      catalogMock.loadAllVodStreams.mockResolvedValue(older);
      refreshed('x1|vod_all-v3');
      await refreshLanded(view, 'Alpha Old');
      catalogMock.loadAllVodStreams.mockResolvedValue(newer);
      refreshed('x1|vod_all-v3');
      await refreshLanded(view, 'Bravo Other');
      channels.release();
      await query;
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.setQuery('alpha');
      // Refreshes that land mid-rebuild leave their lists to it; neither copy goes out on its own.
      expect(cache.held).toBe(false);
      expect(workerMock.run.mock.calls.filter(([task, payload]) => task === 'search.index'
        && (payload as SearchIndexRequest).chunk?.names?.indexOf('Alpha Sequel') === 1)).toHaveLength(1);
    } finally {
      channels.release();
      cache?.release();
      cache?.restore();
      channels.restore();
    }

    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Alpha Old');
    expect(container.textContent).not.toContain('Bravo Other');
  });

  it('reposts a source whose crash rebuild post another post replaced', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie'), vod('11', 'Bravo Movie')] });
    workerMock.restart();
    const internals = view as unknown as {
      workerSession: number;
      postSource(sessionId: number, source: string, total: number, documentAt: (index: number) => string): Promise<boolean>;
    };
    const older = ['Bravo Old', 'Alpha Old'];
    const originalRun = workerMock.run.getMockImplementation()!;
    let replaced: Promise<boolean> | null = null;
    workerMock.run.mockImplementation((task: string, payload: SearchIndexRequest) => {
      const result = originalRun(task, payload);
      // No public writer posts a source mid-rebuild, so this stands in for one
      // that bypassed the rebuild and posts an older list right behind its movies.
      if (!replaced && task === 'search.index' && payload.chunk?.names?.[0] === 'Alpha Movie') {
        replaced = internals.postSource(internals.workerSession, 'movies', older.length, index => older[index]);
      }
      return result;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await view.setQuery('alpha');
      expect(replaced).not.toBeNull();
      await replaced;
      await view.setQuery('alpha');
    } finally {
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Alpha Movie');
    expect(container.textContent).not.toContain('Bravo Movie');
  });

  it('maps results onto a crash rebuild post that replaced an older catalog refresh', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    // Two chunks, so the first refresh's post waits a frame between them.
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const internals = view as unknown as { sourcePosts: Record<string, unknown> };
    const frames = holdFrames();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let reset: ReturnType<typeof holdWorkerTask> | null = null;
    try {
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('20', 'Alpha Old'), ...fillers]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(namePosts('Alpha Old')).toHaveLength(1));
      const older = internals.sourcePosts.movies;
      // The worker crashes; a query rebuilds it while a second refresh lands.
      workerMock.restart();
      reset = holdWorkerTask((task, payload) => task === 'search.index' && !!payload.reset);
      const query = view.setQuery('alpha');
      await vi.waitFor(() => expect(reset!.held).toBe(true));
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('31', 'Bravo Other'), vod('30', 'Alpha Sequel')]);
      refreshed('x1|vod_all-v3');
      await refreshLanded(view, 'Bravo Other');
      reset.release();
      await vi.waitFor(() => expect(internals.sourcePosts.movies).not.toBe(older));
      frames.release();
      await query;
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.setQuery('alpha');
    } finally {
      frames.release();
      reset?.release();
      reset?.restore();
    }

    expect(namePosts('Bravo Other')).toHaveLength(1);
    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Filler');
  });

  it('maps results onto the later of two overlapping catalog refreshes', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
    // Two chunks, so the first refresh's post waits a frame between them.
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const internals = view as unknown as { sourcePosts: Record<string, unknown> };
    const frames = holdFrames();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('20', 'Alpha Old'), ...fillers]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(namePosts('Alpha Old')).toHaveLength(1));
      const older = internals.sourcePosts.movies;
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('31', 'Bravo Other'), vod('30', 'Alpha Sequel')]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(internals.sourcePosts.movies).not.toBe(older));
      frames.release();
      await vi.waitFor(() => expect(namePosts('Bravo Other')).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.setQuery('alpha');
    } finally {
      frames.release();
    }

    expect(container.textContent).toContain('Alpha Sequel');
    expect(container.textContent).not.toContain('Filler');
  });

  it('keeps the later series list when an older overlapping refresh resumes after it', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')], series: [ser('s1', 'Alpha Show')] });
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const internals = view as unknown as {
      sourcePosts: Record<string, unknown>;
      indexedSeries: unknown;
      allSeries: unknown;
    };
    const frames = holdFrames();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('20', 'Alpha Old'), ...fillers]);
      catalogMock.loadAllSeries.mockResolvedValue([ser('s2', 'Alpha Old Show')]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(namePosts('Alpha Old')).toHaveLength(1));
      const older = internals.sourcePosts.movies;
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('31', 'Bravo Other'), vod('30', 'Alpha Sequel')]);
      catalogMock.loadAllSeries.mockResolvedValue([ser('s3', 'Alpha New Show')]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(internals.sourcePosts.movies).not.toBe(older));
      frames.release();
      await vi.waitFor(() => expect(namePosts('Alpha New Show')).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.setQuery('alpha');
    } finally {
      frames.release();
    }

    expect(internals.indexedSeries).toBe(internals.allSeries);
    expect(container.textContent).toContain('Alpha New Show');
    expect(container.textContent).not.toContain('Alpha Old Show');
    view.deactivate();
    await view.open(account);
    await view.setQuery('alpha');
    expect(container.textContent).toContain('Alpha New Show');
    expect(container.textContent).not.toContain('Alpha Old Show');
    // The superseded refresh never posts its older series list.
    expect(namePosts('Alpha Old Show')).toHaveLength(0);
  });

  it('rebuilds on reopen when a later refresh failed to post the series list a ready mark claimed', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')], series: [ser('s1', 'Alpha Show')] });
    const fillers = Array.from({ length: CONFIG.SEARCH.INDEX_CHUNK_SIZE }, (_, i) => vod(`f${i}`, `Filler ${i}`));
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const internals = view as unknown as { sourcePosts: Record<string, unknown> };
    const originalRun = workerMock.run.getMockImplementation()!;
    let rejectSeries!: () => void;
    const seriesRejected = new Promise<void>(resolve => { rejectSeries = resolve; });
    let seriesHeld = false;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (!seriesHeld && task === 'search.index' && payload.chunk?.names?.[0] === 'Alpha New Show') {
        seriesHeld = true;
        await seriesRejected;
        return { accepted: false };
      }
      return originalRun(task, payload);
    });
    const frames = holdFrames();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('20', 'Alpha Old'), ...fillers]);
      catalogMock.loadAllSeries.mockResolvedValue([ser('s2', 'Alpha Old Show')]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(namePosts('Alpha Old')).toHaveLength(1));
      const older = internals.sourcePosts.movies;
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('31', 'Bravo Other'), vod('30', 'Alpha Sequel')]);
      catalogMock.loadAllSeries.mockResolvedValue([ser('s3', 'Alpha New Show')]);
      refreshed('x1|vod_all-v3');
      await vi.waitFor(() => expect(internals.sourcePosts.movies).not.toBe(older));
      frames.release();
      // The older refresh settles and marks the index ready while the newer series post is out.
      await vi.waitFor(() => expect(seriesHeld).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 0));
      view.deactivate();
      rejectSeries();
      await new Promise(resolve => setTimeout(resolve, 0));
      workerMock.run.mockImplementation(originalRun);
      const resets = workerMock.run.mock.calls.filter(
        ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
      ).length;
      await view.open(account);
      await indexReady(view);
      await view.setQuery('alpha');
      expect(workerMock.run.mock.calls.filter(
        ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
      )).toHaveLength(resets + 1);
    } finally {
      frames.release();
      rejectSeries();
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Alpha New Show');
    expect(container.textContent).not.toContain('Alpha Show');
  });

  it('does not fall back to posting an older series list after a later refresh loaded from cache', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith({ series: [ser('s1', 'Alpha Show')] });
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    const internals = view as unknown as { allSeries: { columns: unknown } };
    const olderSeries = [ser('s2', 'Alpha Old Show')];
    const newerSeries = [ser('s3', 'Alpha New Show')];
    // The older record is gone from IndexedDB, so its cached load falls back to a post.
    cacheMock.refs.set(olderSeries, { store: 'catalog-cache', key: 'x1|series_old', timestamp: 1 });
    cacheMock.refs.set(newerSeries, { store: 'catalog-cache', key: 'x1|series_new', timestamp: 2 });
    cacheMock.records.set('catalog-cache|x1|series_new', { timestamp: 2, data: newerSeries });
    const held = holdWorkerTask((task, payload) => task === 'search.index'
      && payload.cachedSeries?.record.key === 'x1|series_old');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      catalogMock.loadAllSeries.mockResolvedValue(olderSeries);
      refreshed('x1|series_all-v3');
      await vi.waitFor(() => expect(held.held).toBe(true));
      catalogMock.loadAllSeries.mockResolvedValue(newerSeries);
      refreshed('x1|series_all-v3');
      await vi.waitFor(() => expect(
        internals.allSeries.columns && cacheMock.sources.get(internals.allSeries.columns as object),
      ).toBe(newerSeries));
      await vi.waitFor(() => expect(workerMock.run.mock.calls.some(([task, payload]) => task === 'search.index'
        && (payload as SearchIndexRequest).cachedSeries?.record.key === 'x1|series_new')).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 0));
      held.release();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      await view.setQuery('alpha');
    } finally {
      held.release();
      held.restore();
    }

    expect(container.textContent).toContain('Alpha New Show');
    expect(container.textContent).not.toContain('Alpha Old Show');
    expect(namePosts('Alpha Old Show')).toHaveLength(0);
  });

  it('does not reuse an index a crash rebuild finished after the guide refreshed while closed', async () => {
    const later = (offset: number) => [Date.now() + offset * 3600000, Date.now() + (offset + 1) * 3600000] as const;
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = { Alpha: [prog('Old Report', ...later(1))] };
    const { view } = await openWith();
    workerMock.restart();
    const hold = holdWorkerTask((task, payload) => task === 'search.index' && payload.chunk?.source === 'channels');
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The query finds the new worker empty and rebuilds; its channels post stalls.
      const query = view.setQuery('report');
      await vi.waitFor(() => expect(hold.held).toBe(true));
      view.deactivate();
      epgMock.programmes = { Alpha: [prog('New Report', ...later(1))] };
      await view.refreshPrograms();
      hold.release();
      await query;
      // The rebuild posted the program index of the old guide data.
      await vi.waitFor(() => expect(diagEvents(info, 'search.worker.index.ready')).toHaveLength(1));

      info.mockClear();
      await view.open(account);
      await indexReady(view);
      await view.setQuery('report');
      expect(diagEvents(info, 'search.index.ready')).toEqual([expect.not.stringContaining('mode=reused')]);
    } finally {
      hold.release();
      hold.restore();
    }

    const rows = Array.from(container.querySelectorAll('.search-program-row'), row => row.textContent);
    expect(rows).toEqual([expect.stringContaining('New Report')]);
  });

  it('does not reuse an index whose channels were replaced before it settled while closed', async () => {
    playlistMock.channels = [chan('Alpha')];
    let finishVod!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise((resolve) => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const view = new Search(container, mkHandlers());
    openViews.push(view);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Channels and programmes reach the worker; the catalog is still loading.
    await view.open(account);
    view.deactivate();
    playlistMock.channels = [chan('Bravo')];
    finishVod([]);
    await vi.waitFor(() => expect(diagEvents(info, 'search.worker.index.ready')).toHaveLength(1));

    info.mockClear();
    await view.open(account);
    await indexReady(view);
    await view.setQuery('bravo');
    expect(diagEvents(info, 'search.index.ready')).toEqual([expect.not.stringContaining('mode=reused')]);
    expect(container.textContent).toContain('Bravo');
  });

  it('rebuilds the index when playlist data changes while inactive', async () => {
    const { view } = await openWith();
    view.deactivate();
    playlistMock.channels = [chan('Bravo')];

    await view.open(account);
    await view.setQuery('bravo');

    expect(workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    )).toHaveLength(2);
    expect(container.textContent).toContain('Bravo');
  });

  it('renders Channels / Movies / Series result rails when the query is set', async () => {
    playlistMock.channels = [chan('Channel One')];
    const { view } = await openWith({ vod: [vod('10', 'Movie One')], series: [ser('s1', 'Series One')] });
    await view.setQuery('one');
    expect(container.querySelector('.catalog-tile[data-channel-index="0"]')?.textContent).toContain('Channel One');
    expect(container.querySelector('.catalog-tile[data-stream-id="10"]')?.textContent).toContain('Movie One');
    expect(container.querySelector('.catalog-tile[data-series-id="s1"]')?.textContent).toContain('Series One');
  });

  it('publishes a bounded first batch from 50,000 ranked results', async () => {
    const initial = CONFIG.SEARCH.INITIAL_RESULTS;
    const many = Array.from(
      { length: CONFIG.SEARCH.RESULT_CAP + 5 },
      (_, i) => vod(String(i), `Movie ${i}`),
    );
    const { view } = await openWith({ vod: many });
    await view.setQuery('movie');
    expect(initial).toBe(200);
    expect(container.querySelectorAll('.catalog-tile[data-stream-id]').length).toBeLessThan(30);
    expect(container.querySelector<HTMLElement>(
      '[data-search-virtual="movies"] .search-virtual-rail-spacer',
    )?.style.width).toBe(`${String(initial * 240)}px`);
  });

  it('expands the ranked batch near the virtual rail boundary', async () => {
    const many = Array.from(
      { length: 2_000 },
      (_, i) => vod(String(i), `Movie ${i}`),
    );
    const { view } = await openWith({ vod: many });
    await view.setQuery('movie');
    const rail = container.querySelector<HTMLElement>('[data-search-virtual="movies"]')!;
    rail.scrollLeft = CONFIG.SEARCH.INITIAL_RESULTS * 240;
    rail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(container.querySelector<HTMLElement>(
      '[data-search-virtual="movies"] .search-virtual-rail-spacer',
    )?.style.width).toBe(
      `${String(CONFIG.SEARCH.INITIAL_RESULTS
        * CONFIG.SEARCH.EXPANSION_FACTOR * 240)}px`,
    );
  });

  it('asks for one more batch at a time while scrolling past the rail boundary', async () => {
    const many = Array.from({ length: 2_000 }, (_, i) => vod(String(i), `Movie ${i}`));
    const { view } = await openWith({ vod: many });
    await view.setQuery('movie');
    const internals = view as unknown as {
      startQuery(generation: number, preserveOffsets?: boolean): Promise<void>;
      resultLimit: number;
    };
    let finish = (): void => {};
    const start = vi.spyOn(internals, 'startQuery')
      .mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const rail = container.querySelector<HTMLElement>('[data-search-virtual="movies"]')!;
    for (let i = 0; i < 4; i++) {
      rail.scrollLeft = CONFIG.SEARCH.INITIAL_RESULTS * 240 - 300 + i * 10;
      rail.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(internals.resultLimit).toBe(CONFIG.SEARCH.INITIAL_RESULTS * CONFIG.SEARCH.EXPANSION_FACTOR);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    rail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('re-renders a scrolled virtual rail only when its window changes', async () => {
    const many = Array.from({ length: 400 }, (_, i) => vod(String(i), `Movie ${i}`));
    const { view } = await openWith({ vod: many });
    await view.setQuery('movie');
    const rail = container.querySelector<HTMLElement>('[data-search-virtual="movies"]')!;
    const render = vi.spyOn(view as unknown as { render(): void }, 'render');
    const scrollTo = async (left: number): Promise<void> => {
      rail.scrollLeft = left;
      rail.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    };
    // An edge scroll moves a few pixels a frame; the same cells stay.
    for (const left of [10, 20, 30]) await scrollTo(left);
    expect(render).not.toHaveBeenCalled();
    await scrollTo(240 * 20);
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-search-index="20"]')).not.toBeNull();
  });

  it('does not open a focused result the rail scrolled out of its window', async () => {
    const many = Array.from({ length: 400 }, (_, i) => vod(String(i), `Movie ${i}`));
    const { view, handlers } = await openWith({ vod: many });
    Focus.setBase(() => view.focusScope);
    await view.setQuery('movie');
    view.focusFirstResult();
    Focus.flush();
    const first = container.querySelector<HTMLElement>('.catalog-tile[data-key="v:0"]')!;
    expect(first.classList.contains('focused')).toBe(true);

    const rail = container.querySelector<HTMLElement>('[data-search-virtual="movies"]')!;
    rail.scrollLeft = 24_000;
    rail.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    Focus.flush();
    expect(first.isConnected).toBe(false);
    expect(container.querySelector('.focused')).toBeNull();

    view.handleAction('select');
    expect(handlers.onOpenMovie).not.toHaveBeenCalled();
  });

  it('publishes only the newest query scheduled in one frame', async () => {
    playlistMock.channels = [chan('Alpha'), chan('Bravo')];
    const { view } = await openWith();
    view.scheduleQuery('alpha');
    view.scheduleQuery('bravo');
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(container.textContent).toContain('Bravo');
    expect(container.textContent).not.toContain('Alpha');
  });

  it('discards a slower response from an older query', async () => {
    playlistMock.channels = [chan('Alpha'), chan('Bravo')];
    const { view } = await openWith();
    const originalRun = workerMock.run.getMockImplementation()!;
    let resolveAlpha!: (value: unknown) => void;
    workerMock.run.mockImplementation((task: string, payload: SearchQueryRequest) => {
      if (task === 'search.query' && payload.query === 'alpha') {
        return new Promise(resolve => { resolveAlpha = resolve; });
      }
      return originalRun(task, payload);
    });

    const alpha = view.setQuery('alpha');
    await view.setQuery('bravo');
    resolveAlpha({
      channels: { indices: [0], hasMore: false },
      programmes: { indices: [], hasMore: false },
      movies: { indices: [], hasMore: false },
      series: { indices: [], hasMore: false },
    });
    await alpha;

    expect(container.textContent).toContain('Bravo');
    expect(container.textContent).not.toContain('Alpha');
    workerMock.run.mockImplementation(originalRun);
  });

  it('rebuilds worker indexes after a query failure', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith();
    const originalRun = workerMock.run.getMockImplementation()!;
    let failed = false;
    workerMock.run.mockImplementation((task: string, payload: SearchQueryRequest) => {
      if (task === 'search.query' && !failed) {
        failed = true;
        return Promise.reject(new Error('worker restarted'));
      }
      return originalRun(task, payload);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await view.setQuery('alpha');

    expect(container.textContent).toContain('Alpha');
    expect(diagEvents(info, 'search.worker.recovery.completed'))
      .toEqual([expect.stringMatching(/reason=query_failed elapsedMs=\d+$/)]);
    info.mockRestore();
    expect(workerMock.run).toHaveBeenCalledWith(
      'search.index',
      expect.objectContaining({ reset: true }),
    );
    workerMock.run.mockImplementation(originalRun);
  });

  it('does not rebuild the index for a session dropped under a failing query', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith();
    const internals = view as unknown as { workerSession: number };
    const originalRun = workerMock.run.getMockImplementation()!;
    let fail!: () => void;
    const failing = new Promise<void>(resolve => { fail = resolve; });
    let held = false;
    workerMock.run.mockImplementation(async (task: string, payload: SearchQueryRequest) => {
      if (task === 'search.query' && !held) {
        held = true;
        await failing;
        throw new Error('App worker failed');
      }
      return originalRun(task, payload);
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resets = (session: number) => workerMock.run.mock.calls.filter(([task, payload]) =>
      task === 'search.index'
      && (payload as SearchIndexRequest).reset
      && (payload as SearchIndexRequest).sessionId === session);
    try {
      const stale = view.setQuery('alpha');
      await vi.waitFor(() => expect(held).toBe(true));
      const staleSession = internals.workerSession;
      // Settings drop the catalog under the live view; no query has started since.
      view.invalidateCatalog();
      const staleResets = resets(staleSession).length;
      fail();
      await stale;
      // Its reset would wipe whatever index the worker holds for a newer session.
      expect(resets(staleSession)).toHaveLength(staleResets);
      expect(diagEvents(error, 'search.worker.query.failed')).toEqual([]);

      await view.setQuery('alpha');
      expect(resets(internals.workerSession)).toHaveLength(1);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toEqual([]);
    } finally {
      fail();
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Alpha');
  });

  it.each([
    ['completes', true],
    ['fails', false],
  ])('drops a query superseded while the rebuild of its missing index %s', async (_outcome, rebuilt) => {
    const alpha = chan('Alpha');
    const bravo = chan('Bravo');
    playlistMock.channels = [alpha, bravo];
    vi.mocked(playlistMock.indexOf).mockImplementation(
      ((channel: unknown) => playlistMock.channels.indexOf(channel)) as () => number,
    );
    const local = vi.fn((query: string) => ({ items: query === 'bravo' ? [bravo] : [alpha], hasMore: false }));
    Object.assign(playlistMock, { searchLocalRanked: local });
    const { view } = await openWith();
    // The new worker is empty, so the query finds no index and rebuilds it.
    workerMock.restart();
    const originalRun = workerMock.run.getMockImplementation()!;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (task === 'search.index' && payload.reset && !held) {
        held = true;
        await released;
        if (!rebuilt) return { accepted: false };
      }
      return originalRun(task, payload);
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const internals = view as unknown as { render: () => void };
    const render = internals.render.bind(view);
    const rendered: string[] = [];
    try {
      const stale = view.setQuery('alpha');
      await vi.waitFor(() => expect(held).toBe(true));
      internals.render = () => {
        render();
        rendered.push(container.textContent ?? '');
      };
      const current = view.setQuery('bravo');
      release();
      await Promise.all([stale, current]);

      expect(diagEvents(warn, 'search.worker.index.missing')).toHaveLength(1);
      expect(rendered.filter(text => text.includes('Alpha'))).toEqual([]);
      // Only the current query may fall back, and only when the rebuild failed.
      expect(diagEvents(warn, 'search.worker.fallback.used')).toHaveLength(rebuilt ? 0 : 1);
    } finally {
      release();
      Reflect.deleteProperty(view, 'render');
      Reflect.deleteProperty(playlistMock, 'searchLocalRanked');
      workerMock.run.mockImplementation(originalRun);
    }

    expect(container.textContent).toContain('Bravo');
    expect(container.textContent).not.toContain('Alpha');
  });

  it('ranks on the main thread without rebuilding until the retry delay passes', async () => {
    const alpha = chan('Alpha');
    playlistMock.channels = [alpha];
    Object.assign(playlistMock, { searchLocalRanked: vi.fn(() => ({ items: [alpha], hasMore: false })) });
    const { view } = await openWith();
    // The new worker is empty and fails every rebuild.
    workerMock.restart();
    const originalRun = workerMock.run.getMockImplementation()!;
    let failing = true;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (failing && task === 'search.index' && payload.reset) throw new Error('App worker failed');
      return originalRun(task, payload);
    });
    const resets = () => workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    ).length;
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      await view.setQuery('alpha');
      const firstResets = resets();
      expect(diagEvents(error, 'search.worker.recovery.failed')).toHaveLength(1);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toHaveLength(1);
      expect(container.textContent).toContain('Alpha');

      await view.setQuery('alph');
      vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS - 1);
      await view.setQuery('alp');
      expect(resets()).toBe(firstResets);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toHaveLength(1);
      expect(container.textContent).toContain('Alpha');

      // The worker still fails once the delay passes: one more rebuild, not logged again.
      vi.advanceTimersByTime(1);
      await view.setQuery('al');
      expect(resets()).toBe(firstResets + 1);
      expect(diagEvents(error, 'search.worker.recovery.failed')).toHaveLength(1);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toHaveLength(2);

      // The worker recovered: the next query after the delay ranks there again.
      failing = false;
      vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS);
      await view.setQuery('alpha');
      expect(resets()).toBe(firstResets + 2);
      expect(diagEvents(info, 'search.worker.recovery.completed')).toHaveLength(1);
      expect(diagEvents(warn, 'search.worker.fallback.used')).toHaveLength(2);
      expect(container.textContent).toContain('Alpha');

      // A later failure starts a new streak, logged again and not delayed by the old one.
      workerMock.restart();
      failing = true;
      await view.setQuery('alph');
      expect(resets()).toBe(firstResets + 3);
      expect(diagEvents(error, 'search.worker.recovery.failed')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(playlistMock, 'searchLocalRanked');
      workerMock.run.mockImplementation(originalRun);
    }
  });

  it('rebuilds at once on a new worker that replaced the one a rebuild failed on', async () => {
    const alpha = chan('Alpha');
    playlistMock.channels = [alpha];
    Object.assign(playlistMock, { searchLocalRanked: vi.fn(() => ({ items: [alpha], hasMore: false })) });
    const { view } = await openWith();
    workerMock.restart();
    const originalRun = workerMock.run.getMockImplementation()!;
    let failing = true;
    workerMock.run.mockImplementation(async (task: string, payload: SearchIndexRequest) => {
      if (failing && task === 'search.index' && payload.reset) throw new Error('App worker failed');
      return originalRun(task, payload);
    });
    const resets = () => workerMock.run.mock.calls.filter(
      ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
    ).length;
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      await view.setQuery('alpha');
      const firstResets = resets();
      // The failing worker crashed; another task started a new one.
      failing = false;
      workerMock.restart();
      await view.setQuery('alph');
      expect(resets()).toBe(firstResets + 1);
      expect(diagEvents(info, 'search.worker.recovery.completed')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(playlistMock, 'searchLocalRanked');
      workerMock.run.mockImplementation(originalRun);
    }
    expect(container.textContent).toContain('Alpha');
  });

  it('plays a channel result on select via its playlist index', async () => {
    playlistMock.channels = [chan('Channel One')];
    playlistMock.indexOf.mockReturnValue(7);
    const { view, handlers } = await openWith();
    await view.setQuery('one');
    const tile = container.querySelector('.catalog-tile[data-channel-index="7"]') as HTMLElement;
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(7);
  });

  it('routes a movie result to onOpenMovie and a series result to onOpenSeries', async () => {
    const { view, handlers } = await openWith({ vod: [vod('10', 'Movie One')], series: [ser('s1', 'Series One')] });
    await view.setQuery('one');
    const movie = container.querySelector('.catalog-tile[data-stream-id="10"]') as HTMLElement;
    movie.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onOpenMovie).toHaveBeenCalledWith(account, expect.objectContaining({ streamId: '10' }));

    const series = container.querySelector('.catalog-tile[data-series-id="s1"]') as HTMLElement;
    series.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onOpenSeries).toHaveBeenCalledWith(account, expect.objectContaining({ seriesId: 's1' }));
  });

  it('shows channel results while the catalog loads, and the preparing hint instead of No results', async () => {
    playlistMock.channels = [chan('Alpha')];
    let finishVod!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise((resolve) => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const view = new Search(container, mkHandlers());
    await view.open(account, 'alpha');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The indexed channels answer at once; the catalog joins them when it lands.
    expect(container.querySelector('.catalog-tile[data-channel-index="0"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Preparing search…');
    expect(container.textContent).not.toContain('No results');
    await view.setQuery('zzz');
    expect(container.textContent).toContain('Preparing search…');
    expect(container.textContent).not.toContain('No results');

    view.scheduleQuery('alpha');
    finishVod([vod('10', 'Alpha Movie')]);
    await vi.waitFor(() => expect(container.textContent).toContain('Alpha Movie'));
    expect(container.textContent).not.toContain('Preparing search…');
    expect(container.querySelector('.catalog-tile[data-channel-index="0"]')).not.toBeNull();
    const [ready] = diagEvents(info, 'search.index.ready');
    expect(ready).toMatch(/mode=fallback channels=1 programmes=0 items=1 persisted=0 built=0 posted=2/);
    expect(Number(ready.match(/hintMs=(\d+)/)?.[1])).toBeGreaterThanOrEqual(40);
    info.mockRestore();
  });

  it('focuses an indexed channel result while the catalog loads, and keeps it when the catalog lands', async () => {
    playlistMock.channels = [chan('Alpha')];
    let finishVod!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise((resolve) => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const box = document.createElement('input');
    box.className = 'tab-bar-search-input';
    document.body.appendChild(box);
    const handlers = mkHandlers();
    handlers.onRevealTabBar.mockImplementation(() => box.focus());
    handlers.onReleaseTabBar.mockImplementation(() => box.blur());
    const view = new Search(container, handlers);
    Focus.setBase(() => view.focusScope);
    await view.open(account, 'alpha');
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.focusFirstResult();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tile = (): Element | null => container.querySelector('.catalog-tile[data-channel-index="0"]');
    expect(tile()?.classList.contains('focused')).toBe(true);

    finishVod([vod('10', 'Alpha Movie')]);
    await vi.waitFor(() => expect(container.textContent).toContain('Alpha Movie'));
    expect(tile()?.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
    box.remove();
  });

  it('marks the index ready when the catalog fails to load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    playlistMock.channels = [chan('Alpha')];
    catalogMock.loadAllVodStreams.mockRejectedValue(new Error('offline'));
    catalogMock.loadAllSeries.mockRejectedValue(new Error('offline'));
    const view = new Search(container, mkHandlers());
    await view.open(account, 'alpha');

    await vi.waitFor(() => expect(container.querySelector('.catalog-tile[data-channel-index="0"]')).not.toBeNull());
    expect(container.textContent).not.toContain('Preparing search…');
    error.mockRestore();
  });

  it('posts a source the worker cannot read in frame-sized chunks', async () => {
    const total = CONFIG.SEARCH.INDEX_CHUNK_SIZE * 2 + 5;
    playlistMock.channels = Array.from({ length: total }, (_, i) => chan(`Channel ${i}`));
    const view = new Search(container, mkHandlers());
    await view.open(null);
    await indexReady(view);

    const chunks = workerMock.run.mock.calls
      .map(([, payload]) => (payload as SearchIndexRequest).chunk)
      .filter(chunk => chunk?.source === 'channels');
    expect(chunks.map(chunk => [chunk!.start, chunk!.documents!.length, chunk!.total])).toEqual([
      [0, CONFIG.SEARCH.INDEX_CHUNK_SIZE, total],
      [CONFIG.SEARCH.INDEX_CHUNK_SIZE, CONFIG.SEARCH.INDEX_CHUNK_SIZE, total],
      [CONFIG.SEARCH.INDEX_CHUNK_SIZE * 2, 5, total],
    ]);
    await view.setQuery(`channel ${total - 1}`);
    expect(container.querySelector('.search-channel-row, [data-channel-index]')).not.toBeNull();
  });

  it('re-indexes a stale catalog once its background refresh lands', async () => {
    const view = new Search(container, mkHandlers());
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('10', 'Old Movie')]);
    catalogMock.loadAllSeries.mockResolvedValue([]);
    await view.open(account, 'movie');
    await vi.waitFor(() => expect(container.textContent).toContain('Old Movie'));

    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() + 60000);
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
    refreshed('x1|vod_all-v3');

    await vi.waitFor(() => expect(container.textContent).toContain('New Movie'));
    expect(container.textContent).not.toContain('Old Movie');
  });

  it('rebuilds the index when a background catalog refresh fails to reach the worker', async () => {
    const view = new Search(container, mkHandlers());
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('10', 'Old Movie')]);
    catalogMock.loadAllSeries.mockResolvedValue([]);
    await view.open(account, 'movie');
    await vi.waitFor(() => expect(container.textContent).toContain('Old Movie'));

    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'movies') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    try {
      catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() + 60000);
      catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'New Movie')]);
      refreshed('x1|vod_all-v3');

      await vi.waitFor(() => expect(container.textContent).toContain('New Movie'));
      expect(rejected).toBe(true);
    } finally {
      workerMock.run.mockImplementation(run);
    }
  });

  it('maps a query answered mid-refresh onto the catalog the worker ranked', async () => {
    const handlers = mkHandlers();
    const view = new Search(container, handlers);
    const refreshed = catalogMock.onCatalogListRefreshed.mock.calls[0][0] as (key: string) => void;
    catalogMock.getSearchCatalogExpiresAt.mockResolvedValue(Date.now() - 1);
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('10', 'Alpha Movie')]);
    catalogMock.loadAllSeries.mockResolvedValue([]);
    await view.open(account);
    await indexReady(view);

    let expire: (value: number) => void = () => undefined;
    catalogMock.getSearchCatalogExpiresAt.mockReturnValue(new Promise(resolve => { expire = resolve; }));
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('11', 'Bravo Movie'), vod('10', 'Alpha Movie')]);
    const asked = catalogMock.getSearchCatalogExpiresAt.mock.calls.length;
    refreshed('x1|vod_all-v3');
    await vi.waitFor(() => expect(catalogMock.getSearchCatalogExpiresAt.mock.calls.length).toBe(asked + 1));

    // The page holds the new list; the worker still ranks the old one.
    await view.setQuery('alpha');
    expect(container.textContent).toContain('Alpha Movie');
    expect(container.textContent).not.toContain('Bravo Movie');
    const tile = container.querySelector('.catalog-tile[data-stream-id]') as HTMLElement;
    expect(tile.dataset.streamId).toBe('10');
    tile.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onOpenMovie).toHaveBeenCalledWith(account, expect.objectContaining({ streamId: '10' }));

    expire(Date.now() + 60000);
    await vi.waitFor(() => expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(2));
    await view.setQuery('movie');
    await vi.waitFor(() => expect(container.textContent).toContain('Bravo Movie'));
    expect(container.querySelectorAll('.catalog-tile[data-stream-id]')).toHaveLength(2);
  });

  it('logs each source a rejected channel post leaves incomplete', async () => {
    playlistMock.channels = [chan('Alpha')];
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'channels') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const view = new Search(container, mkHandlers());
      await view.open(null);
      await indexReady(view);
      expect(diagEvents(warn, 'search.index.lost')).toEqual([
        expect.stringMatching(/source=channels reason=rejected$/),
        expect.stringMatching(/source=programmes reason=rejected$/),
      ]);
    } finally {
      warn.mockRestore();
      workerMock.run.mockImplementation(run);
    }
  });

  it('runs one rebuild of a lost index for queries typed while it runs', async () => {
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = { Alpha: [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)] };
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    const held: Array<() => void> = [];
    let resets = 0;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      const request = payload as SearchIndexRequest;
      if (!rejected && request.chunk?.source === 'programmes') {
        rejected = true;
        return { accepted: false };
      }
      if (rejected && request.reset) {
        resets++;
        await new Promise<void>(resolve => held.push(resolve));
      }
      return run(task, payload);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const view = new Search(container, mkHandlers());
      await view.open(null, 'report');
      await vi.waitFor(() => expect(held).toHaveLength(1));
      void view.setQuery('evening');
      void view.setQuery('evening report');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(resets).toBe(1);
      expect((view as unknown as { workerIndexReady: boolean }).workerIndexReady).toBe(false);

      held.splice(0).forEach(release => release());
      await vi.waitFor(() => expect(container.querySelector('.search-program-row')?.textContent)
        .toContain('Evening Report'));
      expect(resets).toBe(1);
      expect((view as unknown as { workerIndexReady: boolean }).workerIndexReady).toBe(true);
      await view.setQuery('alpha');
      expect(container.textContent).toContain('Alpha');
      expect(resets).toBe(1);
    } finally {
      held.splice(0).forEach(release => release());
      warn.mockRestore();
      workerMock.run.mockImplementation(run);
    }
  });

  it('runs one recovery when a program refresh settles the last pending source', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith();
    await view.setQuery('report');
    const internals = view as unknown as { pendingIndex: unknown; workerIndexLost: boolean };
    internals.pendingIndex = { channels: false, programmes: true, catalog: false };
    internals.workerIndexLost = true;
    epgMock.programmes = { Alpha: [prog('Late Report', Date.now() + 3600000, Date.now() + 7200000)] };
    workerMock.run.mockClear();

    await view.refreshPrograms();
    await vi.waitFor(() => expect(container.querySelector('.search-program-row')?.textContent)
      .toContain('Late Report'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const calls = workerMock.run.mock.calls;
    expect(calls.filter(([task, payload]) => task === 'search.index'
      && (payload as SearchIndexRequest).reset)).toHaveLength(1);
    expect(calls.filter(([task]) => task === 'search.query')).toHaveLength(1);
  });

  it('focuses a result that appears only once the catalog loads', async () => {
    let finishVod!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise((resolve) => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const box = document.createElement('input');
    box.className = 'tab-bar-search-input';
    document.body.appendChild(box);
    const handlers = mkHandlers();
    handlers.onRevealTabBar.mockImplementation(() => box.focus());
    handlers.onReleaseTabBar.mockImplementation(() => box.blur());
    const view = new Search(container, handlers);
    Focus.setBase(() => view.focusScope);
    const opening = view.open(account);
    view.scheduleQuery('movie');
    view.focusFirstResult();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.catalog-tile')).toBeNull();
    // The remote waits in the box rather than on nothing.
    expect(document.activeElement).toBe(box);

    finishVod([vod('10', 'Movie One')]);
    await opening;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlers.onReleaseTabBar).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.catalog-tile[data-stream-id="10"]')?.classList.contains('focused')).toBe(true);
    box.remove();
  });

  it('leaves the remote where it went while the catalog loaded', async () => {
    let finishVod!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise((resolve) => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const box = document.createElement('input');
    box.className = 'tab-bar-search-input';
    document.body.appendChild(box);
    const handlers = mkHandlers();
    handlers.onRevealTabBar.mockImplementation(() => box.focus());
    const view = new Search(container, handlers);
    Focus.setBase(() => view.focusScope);
    const opening = view.open(account);
    view.scheduleQuery('movie');
    view.focusFirstResult();
    await new Promise((resolve) => setTimeout(resolve, 50));
    box.blur();

    finishVod([vod('10', 'Movie One')]);
    await opening;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
    expect(handlers.onReleaseTabBar).not.toHaveBeenCalled();
    expect(container.querySelector('.catalog-tile.focused')).toBeNull();
    box.remove();
  });

  it('hands focus back to the search box when the query matches nothing', async () => {
    const { view, handlers } = await openWith({ vod: [vod('10', 'Movie One')] });
    await view.setQuery('zzz');
    view.focusFirstResult();
    expect(handlers.onRevealTabBar).toHaveBeenCalledTimes(1);
  });

  it('records the query when a result is opened', async () => {
    const { view } = await openWith({ vod: [vod('10', 'Movie One')] });
    await view.setQuery('  one ');
    container.querySelector<HTMLElement>('.catalog-tile[data-stream-id="10"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(storageMock.addSearchHistory).toHaveBeenCalledWith('  one ');
  });

  it('indexes channels, programmes, and the catalog from IndexedDB records', async () => {
    const source = [chan('Bravo'), chan('Alpha')];
    const alpha = { ...source[1], name: 'Alpha Prime', sourceName: 'Alpha' };
    playlistMock.channels = [alpha];
    const programmes = [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)];
    epgMock.programmes = { Alpha: programmes };
    const movies = [vod('10', 'Alpha Movie'), vod('11', 'Bravo Movie')];
    const playlistRef = { store: 'playlist-cache', key: 'k', timestamp: 1 };
    const epgRef = { url: 'http://host/epg.xml', id: 'Alpha', timestamp: 2 };
    const vodRef = { store: 'catalog-cache', key: 'x1|vod_all', timestamp: 3 };
    cacheMock.records.set('playlist-cache|k', { timestamp: 1, data: { channels: source } });
    cacheMock.records.set('epg-cache|http://host/epg.xml', {
      timestamp: 2,
      data: { programmes: { Alpha: programmes } },
    });
    cacheMock.records.set('catalog-cache|x1|vod_all', { timestamp: 3, data: movies });
    cacheMock.refs.set(movies, vodRef);
    playlistMock.getChannelCacheSource.mockReturnValue({
      record: playlistRef,
      length: 2,
      selection: new Uint32Array([1]),
    });
    epgMock.programmeCacheOrigin.mockReturnValue(epgRef);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { view } = await openWith({ vod: movies });
    expect(diagEvents(info, 'search.index.ready')).toEqual([expect.stringMatching(
      /mode=cache channels=1 programmes=1 items=2 persisted=0 built=3 posted=0 elapsedMs=\d+ hintMs=0$/,
    )]);
    const requests = workerMock.run.mock.calls
      .filter(([task]) => task === 'search.index')
      .map(([, payload]) => payload as SearchIndexRequest);
    expect(requests.some(request => request.chunk && request.chunk.source !== 'series')).toBe(false);
    expect(requests.some(request => request.cachedChannels)).toBe(true);
    expect(requests.some(request => request.cachedProgrammes)).toBe(true);
    expect(requests.some(request => request.cachedMovies)).toBe(true);

    await view.setQuery('prime');
    expect(container.textContent).toContain('Alpha Prime');
    await view.setQuery('report');
    expect(container.querySelector('.search-program-row')?.textContent).toContain('Alpha Prime');
    await view.setQuery('bravo');
    expect(container.textContent).toContain('Bravo Movie');

    // Store the offered indexes as the app does, so a new worker can load them.
    const offered = persistMock.mock.calls.flatMap(([candidates]) => candidates ?? []);
    await workerMock.run('search.persist', {
      entries: offered.map(({ key, prefix }) => ({ key, prefix, fields: {} })),
    });
    view.deactivate();
    workerMock.terminate();
    await view.open(account);
    await indexReady(view);
    expect(diagEvents(info, 'search.index.ready')[1])
      .toContain('mode=persisted channels=1 programmes=1 items=2 persisted=3 built=0 posted=0');
    info.mockRestore();
  });

  it('offers the indexes the worker built from IndexedDB records for storing', async () => {
    const source = [chan('Bravo'), chan('Alpha')];
    playlistMock.channels = [source[1]];
    cacheMock.records.set('playlist-cache|offer', { timestamp: 4, data: { channels: source } });
    playlistMock.getChannelCacheSource.mockReturnValue({
      record: { store: 'playlist-cache', key: 'offer', timestamp: 4 },
      length: 2,
      selection: new Uint32Array([1]),
    });

    await openWith();
    expect(persistMock).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'playlist-cache|offer|4|v1', prefix: 'playlist-cache|offer|' }),
    ]);
  });

  it('posts the documents a stale IndexedDB record cannot provide', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    epgMock.programmes = {
      Alpha: [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)],
    };
    cacheMock.records.set('playlist-cache|stale', { timestamp: 9, data: { channels: [channel] } });
    playlistMock.getChannelCacheSource.mockReturnValue({
      record: { store: 'playlist-cache', key: 'stale', timestamp: 1 },
      length: 1,
      selection: new Uint32Array([0]),
    });
    epgMock.programmeCacheOrigin.mockReturnValue({ url: 'http://host/stale.xml', id: 'Alpha', timestamp: 2 });

    const { view } = await openWith();
    const posted = workerMock.run.mock.calls
      .filter(([task]) => task === 'search.index')
      .map(([, payload]) => payload as SearchIndexRequest);
    expect(posted.some(request => request.chunk?.source === 'channels'
      && request.chunk.documents?.length === 1)).toBe(true);
    expect(posted.some(request => request.chunk?.source === 'programmes'
      && request.chunk.documents?.length === 1)).toBe(true);
    expect(diagEvents(info, 'search.worker.cache.fallback')).toEqual([
      expect.stringMatching(/source=channels reason=record_changed$/),
      expect.stringMatching(/source=programmes reason=\w+$/),
    ]);
    expect(diagEvents(info, 'search.index.ready')[0]).toContain('mode=fallback');

    await view.setQuery('report');
    expect(container.querySelector('.search-program-row')?.textContent).toContain('Evening Report');
    info.mockRestore();
  });

  it('searches EPG program metadata and shows its channel and airtime', async () => {
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    epgMock.programmes = { Alpha: [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)] };
    const { view } = await openWith();
    await view.setQuery('report');
    const row = container.querySelector('.search-program-row');
    expect(row?.textContent).toContain('Evening Report');
    expect(row?.textContent).toContain('Alpha');
    expect(row?.textContent).toContain('Set reminder');
  });

  it('lets overlapping chunked program posts take turns instead of colliding', async () => {
    const total = CONFIG.SEARCH.INDEX_CHUNK_SIZE * 2 + 5;
    const start = Date.now() + 3600000;
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = {
      Alpha: Array.from({ length: total }, (_, i) => prog(`Show ${i}`, start + i * 60000, start + (i + 1) * 60000)),
    };
    const view = new Search(container, mkHandlers());
    await view.open(null);
    await indexReady(view);
    const internals = view as unknown as {
      workerSession: number;
      postSource(sessionId: number, source: string, total: number, at: (i: number) => string[]): Promise<boolean>;
    };
    const sessionId = internals.workerSession;
    const older = internals.postSource(sessionId, 'programmes', total, i => [`Old ${i}`]);
    const newer = internals.postSource(sessionId, 'programmes', total, i => [`Show ${i}`]);

    expect(await Promise.all([older, newer])).toEqual([true, true]);
    await view.setQuery(`show ${total - 1}`);
    expect(container.querySelector('.search-program-row')?.textContent).toContain(`Show ${total - 1}`);
  });

  it('runs a query typed while preparing once a program post is rejected', async () => {
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = { Alpha: [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)] };
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'programmes') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const view = new Search(container, mkHandlers());
      await view.open(null, 'report');
      await vi.waitFor(() => expect(container.querySelector('.search-program-row')?.textContent)
        .toContain('Evening Report'));
      expect(container.textContent).not.toContain('Preparing search…');
      expect(diagEvents(warn, 'search.index.lost'))
        .toEqual([expect.stringMatching(/source=programmes reason=rejected$/)]);
      expect(diagEvents(info, 'search.index.ready')).toEqual([expect.stringContaining('mode=lost')]);
      expect(diagEvents(info, 'search.worker.recovery.completed'))
        .toEqual([expect.stringContaining('reason=lost')]);
      warn.mockRestore();
      info.mockRestore();
    } finally {
      workerMock.run.mockImplementation(run);
    }
  });

  it('rebuilds an index whose catalog post failed and never reuses it', async () => {
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'movies') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    try {
      const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
      const resets = (): number => workerMock.run.mock.calls.filter(
        ([task, payload]) => task === 'search.index' && (payload as SearchIndexRequest).reset,
      ).length;
      const before = resets();
      view.deactivate();
      await view.open(account);
      await indexReady(view);
      expect(resets()).toBeGreaterThan(before);

      await view.setQuery('alpha movie');
      expect(container.textContent).toContain('Alpha Movie');
    } finally {
      workerMock.run.mockImplementation(run);
    }
  });

  it('recovers movies when the catalog post fails during open', async () => {
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'movies') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    try {
      const { view } = await openWith({ vod: [vod('10', 'Alpha Movie')] });
      await view.setQuery('alpha movie');
      expect(container.textContent).toContain('Alpha Movie');
    } finally {
      workerMock.run.mockImplementation(run);
    }
  });

  it('keeps channel results for a pending catalog after a program post fails, then shows it all', async () => {
    playlistMock.channels = [chan('Alpha')];
    epgMock.programmes = { Alpha: [prog('Evening Report', Date.now() + 3600000, Date.now() + 7200000)] };
    let finishVod: (value: unknown[]) => void = () => undefined;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise(resolve => { finishVod = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const run = workerMock.run.getMockImplementation()!;
    let rejected = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!rejected && (payload as SearchIndexRequest).chunk?.source === 'programmes') {
        rejected = true;
        return { accepted: false };
      }
      return run(task, payload);
    });
    try {
      const view = new Search(container, mkHandlers());
      void view.open(account, 'alpha');
      await vi.waitFor(() => expect(rejected).toBe(true));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(container.querySelector('.catalog-tile[data-channel-index="0"]')).not.toBeNull();
      expect(container.textContent).not.toContain('No results found.');

      finishVod([vod('10', 'Alpha Movie')]);
      await vi.waitFor(() => expect(container.textContent).toContain('Alpha Movie'));
      expect(container.textContent).toContain('Evening Report');
    } finally {
      workerMock.run.mockImplementation(run);
    }
  });

  it('recovers program results when a refresh loses its worker post', async () => {
    playlistMock.channels = [chan('Alpha')];
    const { view } = await openWith();
    await view.setQuery('report');
    epgMock.programmes = { Alpha: [prog('Late Report', Date.now() + 3600000, Date.now() + 7200000)] };
    const run = workerMock.run.getMockImplementation()!;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let crashed = false;
    workerMock.run.mockImplementation(async (task: string, payload: unknown) => {
      if (!crashed && (payload as SearchIndexRequest).chunk?.source === 'programmes') {
        crashed = true;
        throw new Error('worker crashed');
      }
      return run(task, payload);
    });
    try {
      await view.refreshPrograms();
      await vi.waitFor(() => expect(container.querySelector('.search-program-row')?.textContent)
        .toContain('Late Report'));
    } finally {
      workerMock.run.mockImplementation(run);
      error.mockRestore();
    }
  });

  it('refreshes program results when EPG finishes loading after Search opens', async () => {
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    const { view } = await openWith();
    await view.setQuery('report');
    expect(container.querySelector('.search-program-row')).toBeNull();

    epgMock.programmes = { Alpha: [prog('Late Report', Date.now() + 3600000, Date.now() + 7200000)] };
    await view.refreshPrograms();
    expect(container.querySelector('.search-program-row')?.textContent).toContain('Late Report');
  });

  it('refreshes a query typed while the initial program index is building', async () => {
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    epgMock.programmes = {
      Alpha: [prog('Late Report', Date.now() + 3600000, Date.now() + 7200000)],
    };
    catalogMock.loadAllVodStreams.mockResolvedValue([]);
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const view = new Search(container, mkHandlers());

    const opening = view.open(account);
    await view.setQuery('report');
    await opening;

    expect(container.querySelector('.search-program-row')?.textContent)
      .toContain('Late Report');
  });

  it('does not build the program index until Search opens', async () => {
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    epgMock.programmes = {
      Alpha: [prog('Late Report', Date.now() + 3600000, Date.now() + 7200000)],
    };
    const view = new Search(container, mkHandlers());

    await view.refreshPrograms();
    expect(epgMock.findChannelId).not.toHaveBeenCalled();

    catalogMock.loadAllVodStreams.mockResolvedValue([]);
    catalogMock.loadAllSeries.mockResolvedValue([]);
    await view.open(null);
    expect(epgMock.findChannelId).toHaveBeenCalledWith(channel);
  });

  it('plays a current program and starts catch-up for an aired program', async () => {
    const now = Date.now();
    const liveChannel = chan('Alpha');
    const catchupChannel = { ...chan('Bravo'), catchupSource: '{utc}' };
    playlistMock.channels = [liveChannel, catchupChannel];
    epgMock.programmes = {
      Alpha: [prog('Live Report', now - 60000, now + 60000)],
      Bravo: [prog('Past Report', now - 120000, now - 60000)],
    };
    const { view, handlers } = await openWith();
    await view.setQuery('report');

    const rows = container.querySelectorAll<HTMLElement>('.search-program-row');
    rows[0].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(0, undefined);

    rows[1].dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(1, expect.objectContaining({ title: 'Past Report' }));
  });

  it('offers resume or start over for a partially watched catch-up program', async () => {
    const now = Date.now();
    const start = now - 120000;
    const channel = { ...chan('Alpha'), catchupSource: '{utc}' };
    playlistMock.channels = [channel];
    epgMock.programmes = { Alpha: [prog('Past Report', start, now - 60000)] };
    storageMock.getCatchupProgressList.mockReturnValue([{
      channelKey: 'key',
      progStart: start,
      progEnd: now - 60000,
      position: 30,
      duration: 60,
      updatedAt: now,
      completed: false,
    }]);
    const { view, handlers } = await openWith();
    await view.setQuery('past');
    const row = container.querySelector('.search-program-row') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(document.querySelector('.catchup-resume-prompt')?.classList.contains('hidden')).toBe(false);
    expect(storageMock.addSearchHistory).not.toHaveBeenCalled();

    view.handleAction('select');
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(0, expect.objectContaining({ resumeSecs: 30 }));
    expect(storageMock.addSearchHistory).toHaveBeenCalledWith('past');
  });

  it('does not play an Xtream program whose has_archive flag is false', async () => {
    const now = Date.now();
    const channel = {
      ...chan('Alpha'),
      catchupSource: '{utc}',
      catchupAccountId: 'x1',
      catchupStreamId: '101',
    };
    playlistMock.channels = [channel];
    epgMock.programmes = { Alpha: [prog('Past Report', now - 120000, now - 60000)] };
    archiveMock.load.mockResolvedValue(new Set());
    archiveMock.isAvailable.mockReturnValue(false);
    const { view, handlers } = await openWith();
    await view.setQuery('past');
    const row = container.querySelector('.search-program-row') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    await Promise.resolve();

    expect(handlers.onPlayChannel).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith("This program isn't available for catch-up.");
    expect(storageMock.addSearchHistory).not.toHaveBeenCalled();
  });

  it('toggles a reminder for a future program', async () => {
    const now = Date.now();
    const channel = chan('Alpha');
    playlistMock.channels = [channel];
    epgMock.programmes = { Alpha: [prog('Future Report', now + 60000, now + 120000)] };
    const { view } = await openWith();
    await view.setQuery('future');
    const row = container.querySelector('.search-program-row') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(reminderMock.add).toHaveBeenCalledWith(expect.objectContaining({
      channelName: 'Alpha',
      title: 'Future Report',
    }));
    expect(storageMock.addSearchHistory).not.toHaveBeenCalled();
  });

  it('opens an Xtream movie result on a pointer click', async () => {
    const { view, handlers } = await openWith({ vod: [vod('10', 'Movie One')] });
    await view.setQuery('one');
    const movie = container.querySelector('.catalog-tile[data-stream-id="10"]') as HTMLElement;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => movie;
    container.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 50, bubbles: true }));
    document.elementFromPoint = orig;
    expect(handlers.onOpenMovie).toHaveBeenCalledWith(account, expect.objectContaining({ streamId: '10' }));
  });

  it('shows a no-results message when nothing matches', async () => {
    const { view } = await openWith();
    await view.setQuery('zzz');
    expect(container.textContent).toContain('No results');
  });

  it('focusFirstResult moves focus into the first result (tab bar handoff)', async () => {
    playlistMock.channels = [chan('Channel One')];
    const { view } = await openWith();
    Focus.setBase(() => view.focusScope);
    await view.setQuery('one');
    view.focusFirstResult();
    Focus.flush();
    expect(container.querySelector('.catalog-tile.focused')).not.toBeNull();
  });

  it('reveals the tab bar when Up cannot move within the view', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('up');
    expect(handlers.onRevealTabBar).toHaveBeenCalled();
  });

  it('goes back to Live from Search', async () => {
    const { view, handlers } = await openWith();
    view.handleAction('back');
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it('keeps a catalog load running across close and reopen', async () => {
    playlistMock.channels = [chan('Alpha')];
    let finish!: (items: unknown[]) => void;
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    catalogMock.loadAllSeries.mockResolvedValue([]);
    const view = new Search(container, mkHandlers());
    await view.open(account);
    const signal = catalogMock.loadAllVodStreams.mock.calls[0][1] as AbortSignal;

    view.deactivate();
    expect(signal.aborted).toBe(false);
    await view.open(account, 'alpha');
    finish([vod('10', 'Alpha Movie')]);

    await vi.waitFor(() => expect(container.textContent).toContain('Alpha Movie'));
    expect(catalogMock.loadAllVodStreams).toHaveBeenCalledTimes(1);
  });

  it('aborts a catalog load when Search reopens for another account', async () => {
    catalogMock.loadAllVodStreams.mockReturnValue(new Promise(() => undefined));
    catalogMock.loadAllSeries.mockReturnValue(new Promise(() => undefined));
    const view = new Search(container, mkHandlers());
    await view.open(account);
    const signal = catalogMock.loadAllVodStreams.mock.calls[0][1] as AbortSignal;

    view.deactivate();
    await view.open({ ...account, id: 'x2' });

    expect(signal.aborted).toBe(true);
  });

  it('a superseded a1 load cannot clobber a2 catalog (account-switch race)', async () => {
    const a1: PlaylistEntry = { id: 'a1', name: 'A1', url: 'http://host/a', source: 'xtream', xtream: { username: 'u1', password: 'p1' } };
    const a2: PlaylistEntry = { id: 'a2', name: 'A2', url: 'http://host/a', source: 'xtream', xtream: { username: 'u2', password: 'p2' } };

    let resolveA1Vod!: (v: unknown) => void;
    let resolveA2Vod!: (v: unknown) => void;
    let resolveA1Series!: (v: unknown) => void;
    let resolveA2Series!: (v: unknown) => void;

    catalogMock.loadAllVodStreams
      .mockReturnValueOnce(new Promise((r) => { resolveA1Vod = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveA2Vod = r; }));
    catalogMock.loadAllSeries
      .mockReturnValueOnce(new Promise((r) => { resolveA1Series = r; }))
      .mockReturnValueOnce(new Promise((r) => { resolveA2Series = r; }));

    const view = new Search(container, mkHandlers());

    // Start both opens concurrently; neither load has resolved yet.
    const p1 = view.open(a1);
    const a1Signal = catalogMock.loadAllVodStreams.mock.calls[0][1] as AbortSignal;
    const p2 = view.open(a2);
    expect(a1Signal.aborted).toBe(true);
    expect(catalogMock.loadAllVodStreams.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

    // Resolve a2's load first — it should commit as the current account.
    resolveA2Vod([vod('v2', 'Bravo Movie')]);
    resolveA2Series([]);
    await p2;

    // Resolve a1's stale load last — the guard should discard it.
    resolveA1Vod([vod('v1', 'Alpha Movie')]);
    resolveA1Series([]);
    await p1;

    await view.setQuery('movie');
    expect(container.textContent).toContain('Bravo Movie');
    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('does not retain the previous account catalog when the next load fails', async () => {
    const { view } = await openWith({ vod: [vod('v1', 'Alpha Movie')] });
    const a2: PlaylistEntry = {
      id: 'a2',
      name: 'A2',
      url: 'http://host/a',
      source: 'xtream',
      xtream: { username: 'u2', password: 'p2' },
    };
    catalogMock.loadAllVodStreams.mockRejectedValue(new Error('failed'));
    catalogMock.loadAllSeries.mockRejectedValue(new Error('failed'));

    await view.open(a2);
    await view.setQuery('movie');

    expect(container.textContent).not.toContain('Alpha Movie');
  });

  it('keeps movie search available when the series catalog fails', async () => {
    catalogMock.loadAllVodStreams.mockResolvedValue([vod('v1', 'Alpha Movie')]);
    catalogMock.loadAllSeries.mockRejectedValue(new Error('failed'));
    const view = new Search(container, mkHandlers());

    await view.open(account);
    await view.setQuery('movie');

    expect(container.textContent).toContain('Alpha Movie');
  });
});

describe('Search (M3U-only, no account)', () => {
  async function openM3U() {
    const handlers = mkHandlers();
    const view = new Search(container, handlers);
    await view.open(null);
    return { view, handlers };
  }

  it('does not load a catalog for an M3U-only account', async () => {
    await openM3U();
    expect(catalogMock.loadAllVodStreams).not.toHaveBeenCalled();
    expect(catalogMock.loadAllSeries).not.toHaveBeenCalled();
  });

  it('renders channel results as a vertical list (no poster rails)', async () => {
    playlistMock.channels = [chan('Alpha News'), chan('Beta News')];
    playlistMock.indexOf.mockImplementation((ch: { name: string }) => (ch.name === 'Alpha News' ? 0 : 1));
    const { view } = await openM3U();
    await view.setQuery('news');
    expect(container.querySelectorAll('.search-channel-row').length).toBe(2);
    expect(container.querySelector('.catalog-rail')).toBeNull();
    expect(container.querySelector('.search-channels .catalog-rail-title')?.textContent).toBe('Channels');
    const cells = container.querySelectorAll<HTMLElement>('.search-virtual-list-cell');
    expect(cells[0].style.top).toBe('0px');
    expect(cells[1].style.top).toBe('88px');
  });

  it('plays a channel row on select', async () => {
    playlistMock.channels = [chan('Alpha News')];
    playlistMock.indexOf.mockReturnValue(3);
    const { view, handlers } = await openM3U();
    await view.setQuery('news');
    const row = container.querySelector('.search-channel-row') as HTMLElement;
    row.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    view.handleAction('select');
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(3);
  });

  it('plays a channel row on a pointer click', async () => {
    playlistMock.channels = [chan('Alpha News')];
    playlistMock.indexOf.mockReturnValue(5);
    const { handlers, view } = await openM3U();
    await view.setQuery('news');
    const row = container.querySelector('.search-channel-row') as HTMLElement;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => row;
    container.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 50, bubbles: true }));
    document.elementFromPoint = orig;
    expect(handlers.onPlayChannel).toHaveBeenCalledWith(5);
  });
});
