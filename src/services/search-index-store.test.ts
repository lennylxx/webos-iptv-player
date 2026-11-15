// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SearchIndexCandidate } from '../workers/tasks';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  playlistListeners: [] as Array<() => void>,
  catalogListeners: [] as Array<(key: string) => void>,
  epgListeners: [] as Array<() => void>,
}));

vi.mock('../workers/app-worker-client', () => ({
  runAppWorkerTask: mocks.run,
  retainAppWorker: () => () => undefined,
}));
vi.mock('./idb-cache', () => ({
  reserveSearchIndex: mocks.reserve,
  settleSearchIndex: mocks.settle,
  onPlaylistCacheWritten: (listener: () => void) => {
    mocks.playlistListeners.push(listener);
    return () => undefined;
  },
}));
vi.mock('./xtream-catalog', () => ({
  onCatalogListWritten: (listener: (key: string) => void) => {
    mocks.catalogListeners.push(listener);
    return () => undefined;
  },
}));
vi.mock('./epg-service', () => ({
  onEpgCacheWritten: (listener: () => void) => {
    mocks.epgListeners.push(listener);
    return () => undefined;
  },
}));

import { persistSearchIndexes, SearchIndexPrewarmer } from './search-index-store';

const candidate = (key: string): SearchIndexCandidate => ({ key, prefix: `${key}|`, bytes: 10 });
const reservation = { generation: 0, evicted: 1, fields: { cacheCategory: 'search', byteSize: 10 } };

function logged(spy: MockInstance<typeof console.log>, event: string): string[] {
  return spy.mock.calls
    .map(call => call.filter(part => typeof part === 'string').join(' '))
    .filter(line => line.includes(`event=${event} `) || line.endsWith(`event=${event}`));
}
const SOURCE = { store: 'catalog-cache' as const, key: 'x1|vod_all' };

type IdleCallback = () => void;
type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleCallback, options?: { timeout: number }) => number;
};

describe('persistSearchIndexes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.settle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the worker to write only the reserved indexes, then settles them', async () => {
    mocks.reserve.mockImplementation(async (item: SearchIndexCandidate) =>
      item.key === 'a' ? reservation : null);
    mocks.run.mockResolvedValue({ written: ['a'] });

    await persistSearchIndexes([candidate('a'), candidate('b')]);

    expect(mocks.run).toHaveBeenCalledWith('search.persist', {
      entries: [{ key: 'a', prefix: 'a|', fields: reservation.fields }],
    });
    expect(mocks.settle).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledWith('a', reservation, true);
    expect(logged(vi.mocked(console.log), 'search.index.persist.completed'))
      .toEqual([expect.stringContaining('count=1 bytes=10 evicted=1')]);
  });

  it('logs each index the worker could not write, with its reason', async () => {
    mocks.reserve.mockResolvedValue(reservation);
    mocks.run.mockResolvedValue({ written: ['a'], failed: [{ key: 'b', reason: 'quota_exceeded' }] });

    await persistSearchIndexes([candidate('a'), candidate('b'), candidate('c')]);

    expect(logged(vi.mocked(console.warn), 'search.index.persist.failed')).toEqual([
      expect.stringContaining('reason=quota_exceeded bytes=10'),
      expect.stringContaining('reason=not_written bytes=10'),
    ]);
    expect(logged(vi.mocked(console.log), 'search.index.persist.completed'))
      .toEqual([expect.stringContaining('count=1 bytes=10 evicted=3')]);
  });

  it('logs a reservation error as a skipped index', async () => {
    mocks.reserve.mockRejectedValue(new Error('e1'));
    await persistSearchIndexes([candidate('a')]);
    expect(logged(vi.mocked(console.warn), 'search.index.persist.skipped'))
      .toEqual([expect.stringContaining('reason=error bytes=10')]);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not wake the worker when nothing fits', async () => {
    mocks.reserve.mockResolvedValue(null);
    await persistSearchIndexes([candidate('a')]);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('releases every reservation when the worker write fails', async () => {
    mocks.reserve.mockResolvedValue(reservation);
    mocks.run.mockRejectedValue(new Error('terminated'));

    await persistSearchIndexes([candidate('a'), candidate('b')]);

    expect(mocks.settle.mock.calls).toEqual([
      ['a', reservation, false],
      ['b', reservation, false],
    ]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(logged(vi.mocked(console.warn), 'search.index.persist.failed')).toHaveLength(2);
    expect(logged(vi.mocked(console.warn), 'search.index.persist.failed')[0]).toContain('reason=worker_failed');
    expect(logged(vi.mocked(console.log), 'search.index.persist.completed')).toEqual([]);
  });

  it('runs one persist at a time', async () => {
    let release: () => void = () => undefined;
    mocks.reserve.mockResolvedValue(reservation);
    mocks.run.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ written: ['a'] });
    })).mockResolvedValue({ written: ['b'] });

    const first = persistSearchIndexes([candidate('a')]);
    const second = persistSearchIndexes([candidate('b')]);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});

describe('SearchIndexPrewarmer', () => {
  let idle: IdleCallback[];
  const win = window as IdleWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    idle = [];
    win.requestIdleCallback = vi.fn((callback: IdleCallback) => idle.push(callback));
    mocks.reserve.mockResolvedValue(reservation);
    mocks.settle.mockResolvedValue(undefined);
    mocks.run.mockImplementation(async (task: string) =>
      task === 'search.prewarm' ? { persist: [candidate('a')] } : { written: ['a'] });
  });

  afterEach(() => {
    Reflect.deleteProperty(win, 'requestIdleCallback');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function flushIdle(): Promise<void> {
    while (idle.length) {
      idle.shift()!();
      await vi.waitFor(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  it('builds and stores the indexes once the page is idle', async () => {
    const prewarm = new SearchIndexPrewarmer(() => [SOURCE]);
    prewarm.schedule('startup');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(win.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });

    await flushIdle();
    expect(mocks.run.mock.calls.map(call => call[0])).toEqual(['search.prewarm', 'search.persist']);
    expect(mocks.run.mock.calls[0][1]).toEqual({ sources: [SOURCE] });
    expect(logged(vi.mocked(console.log), 'search.index.prewarm.completed')).toEqual([
      expect.stringMatching(/reason=startup sources=1 built=1 skipped=0 elapsedMs=\d+$/),
    ]);
  });

  it('logs each skipped source and a failed prewarm', async () => {
    mocks.run.mockResolvedValueOnce({ persist: [], skipped: [{ store: 'catalog-cache', reason: 'missing' }] });
    const prewarm = new SearchIndexPrewarmer(() => [SOURCE]);
    prewarm.schedule('epg');
    await flushIdle();
    expect(logged(vi.mocked(console.log), 'search.index.prewarm.skipped'))
      .toEqual([expect.stringContaining('source=catalog-cache reason=missing')]);
    expect(logged(vi.mocked(console.log), 'search.index.prewarm.completed'))
      .toEqual([expect.stringContaining('reason=epg sources=1 built=0 skipped=1')]);

    mocks.run.mockRejectedValueOnce(new Error('terminated'));
    prewarm.schedule('catalog');
    await flushIdle();
    expect(logged(vi.mocked(console.warn), 'search.index.prewarm.failed'))
      .toEqual([expect.stringMatching(/reason=catalog elapsedMs=\d+$/)]);
  });

  it('coalesces triggers and repeats once for a trigger during a run', async () => {
    let finish: () => void = () => undefined;
    mocks.run.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ persist: [] });
    }));
    const prewarm = new SearchIndexPrewarmer(() => [SOURCE]);
    prewarm.schedule('startup');
    prewarm.schedule('epg');
    expect(idle).toHaveLength(1);
    idle.shift()!();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));

    prewarm.schedule('catalog');
    prewarm.schedule('playlist');
    finish();
    await vi.waitFor(() => expect(idle).toHaveLength(1));
    await flushIdle();
    expect(mocks.run.mock.calls.filter(call => call[0] === 'search.prewarm')).toHaveLength(2);
  });

  it('does not wake the worker without sources', async () => {
    const prewarm = new SearchIndexPrewarmer(() => []);
    prewarm.schedule('startup');
    await flushIdle();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('falls back to a timer without requestIdleCallback', async () => {
    Reflect.deleteProperty(win, 'requestIdleCallback');
    vi.useFakeTimers();
    const prewarm = new SearchIndexPrewarmer(() => [SOURCE]);
    prewarm.schedule('startup');
    expect(mocks.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.run).toHaveBeenCalledWith('search.prewarm', { sources: [SOURCE] });
  });

  it('re-indexes after a playlist, guide, or Search catalog cache write', async () => {
    mocks.playlistListeners.length = 0;
    mocks.catalogListeners.length = 0;
    mocks.epgListeners.length = 0;
    const prewarm = new SearchIndexPrewarmer(() => [SOURCE]);
    prewarm.watchSourceWrites();
    mocks.playlistListeners.forEach(listener => listener());
    await flushIdle();
    mocks.catalogListeners.forEach(listener => listener('x1|vod_categories'));
    await flushIdle();
    mocks.catalogListeners.forEach(listener => listener(SOURCE.key));
    await flushIdle();
    mocks.epgListeners.forEach(listener => listener());
    await flushIdle();
    expect(logged(vi.mocked(console.log), 'search.index.prewarm.completed')
      .map(line => /reason=(\w+)/.exec(line)![1])).toEqual(['playlist', 'catalog', 'epg']);
  });
});
