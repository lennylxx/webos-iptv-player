// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import {
  appWorkerGeneration,
  retainAppWorker,
  runAppWorkerTask,
  terminateAppWorker,
} from '../workers/app-worker-client';

const { cacheMock } = vi.hoisted(() => ({
  cacheMock: { reserveDelayMs: 0, settled: [] as boolean[] },
}));
vi.mock('./idb-cache', () => ({
  reserveSearchIndex: vi.fn(() => new Promise(resolve => {
    setTimeout(() => resolve({ generation: 0, fields: { cacheCategory: 'search' } }), cacheMock.reserveDelayMs);
  })),
  settleSearchIndex: vi.fn(async (_key: string, _reservation: unknown, stored: boolean) => {
    cacheMock.settled.push(stored);
  }),
  onPlaylistCacheWritten: () => () => undefined,
}));
vi.mock('./xtream-catalog', () => ({ onCatalogListRefreshed: () => () => undefined }));

import { SearchIndexPrewarmer, persistSearchIndexes } from './search-index-store';

const INDEX_KEY = 'catalog-cache|x1|vod_all|1|v1';
const candidate = { key: INDEX_KEY, prefix: 'catalog-cache|x1|vod_all|', bytes: 10 };

interface Request {
  kind: 'request';
  id: number;
  task: string;
}

// Like the app worker, it can only write an index it built itself.
class FakeWorker {
  static tasks: string[] = [];
  static terminations = 0;
  static created = 0;
  static last: FakeWorker | null = null;
  private listeners: Array<(event: { data: unknown }) => void> = [];
  private errorListeners: Array<(event: { message: string }) => void> = [];
  private built = false;

  constructor() {
    FakeWorker.created++;
    FakeWorker.last = this;
  }

  crash(): void {
    for (const listener of this.errorListeners) listener({ message: 'boom' });
  }

  postMessage(message: Request): void {
    FakeWorker.tasks.push(message.task);
    const builds = message.task !== 'search.persist';
    if (builds) this.built = true;
    const result = builds
      ? { accepted: true, persist: [candidate] }
      : { written: this.built ? [INDEX_KEY] : [] };
    setTimeout(() => {
      for (const listener of this.listeners) {
        listener({ data: { kind: 'success', id: message.id, result } });
      }
    }, 0);
  }

  addEventListener(type: string, listener: (event: { data: unknown } | { message: string }) => void): void {
    if (type === 'message') this.listeners.push(listener);
    if (type === 'error') this.errorListeners.push(listener);
  }

  terminate(): void {
    FakeWorker.terminations++;
  }
}

describe('SearchIndexPrewarmer worker lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    FakeWorker.tasks = [];
    FakeWorker.terminations = 0;
    FakeWorker.created = 0;
    FakeWorker.last = null;
    cacheMock.reserveDelayMs = 0;
    cacheMock.settled = [];
  });

  afterEach(() => {
    terminateAppWorker();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lets the worker terminate on idle once the prewarm is stored', async () => {
    const prewarm = new SearchIndexPrewarmer(() => [{ store: 'catalog-cache', key: 'x1|vod_all' }]);
    prewarm.schedule('startup');
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWorker.tasks).toEqual(['search.prewarm', 'search.persist']);
    expect(appWorkerGeneration()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(CONFIG.WORKER_IDLE_TERMINATION_MS);
    expect(appWorkerGeneration()).toBeNull();
    expect(FakeWorker.terminations).toBe(1);
  });

  it('keeps the building worker until a slow reservation lets it write', async () => {
    cacheMock.reserveDelayMs = CONFIG.WORKER_IDLE_TERMINATION_MS + 500;
    const prewarm = new SearchIndexPrewarmer(() => [{ store: 'catalog-cache', key: 'x1|vod_all' }]);
    prewarm.schedule('startup');
    await vi.advanceTimersByTimeAsync(cacheMock.reserveDelayMs + 10);

    expect(FakeWorker.tasks).toEqual(['search.prewarm', 'search.persist']);
    expect(FakeWorker.created).toBe(1);
    expect(cacheMock.settled).toEqual([true]);
    await vi.advanceTimersByTimeAsync(CONFIG.WORKER_IDLE_TERMINATION_MS);
    expect(appWorkerGeneration()).toBeNull();
  });

  it('keeps the worker an open Search built in until its index is stored', async () => {
    cacheMock.reserveDelayMs = CONFIG.WORKER_IDLE_TERMINATION_MS + 500;
    const response = runAppWorkerTask('search.index', { sessionId: 1 });
    await vi.advanceTimersByTimeAsync(1);
    const persisted = persistSearchIndexes((await response).persist);
    await vi.advanceTimersByTimeAsync(cacheMock.reserveDelayMs + 10);
    await persisted;

    expect(FakeWorker.created).toBe(1);
    expect(cacheMock.settled).toEqual([true]);
    await vi.advanceTimersByTimeAsync(CONFIG.WORKER_IDLE_TERMINATION_MS);
    expect(appWorkerGeneration()).toBeNull();
  });

  it('numbers each new worker and drops the number once it terminates or crashes', async () => {
    expect(appWorkerGeneration()).toBeNull();
    const release = retainAppWorker();
    try {
      const first = runAppWorkerTask('search.index', { sessionId: 1 });
      const generation = appWorkerGeneration();
      expect(generation).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await first;
      expect(appWorkerGeneration()).toBe(generation);

      terminateAppWorker();
      expect(appWorkerGeneration()).toBeNull();
      const second = runAppWorkerTask('search.index', { sessionId: 2 });
      const next = appWorkerGeneration();
      expect(next).not.toBeNull();
      expect(next).not.toBe(generation);
      await vi.advanceTimersByTimeAsync(1);
      await second;

      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      FakeWorker.last?.crash();
      expect(appWorkerGeneration()).toBeNull();
      expect(error.mock.calls.some(call => call.includes('event=worker.lifecycle.failed'))).toBe(true);
      const third = runAppWorkerTask('search.index', { sessionId: 3 });
      const restarted = appWorkerGeneration();
      expect(restarted).not.toBeNull();
      expect([generation, next]).not.toContain(restarted);
      await vi.advanceTimersByTimeAsync(1);
      await third;
    } finally {
      release();
    }
  });
});
