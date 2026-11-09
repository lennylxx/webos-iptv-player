import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldRecord, releaseHeldRecord } from './held-records';
import { holdWorkerValue } from './worker-held-records';

const worker = vi.hoisted(() => ({ generation: 1 as number | null, size: 7 as number | null }));

vi.mock('../workers/app-worker-client', () => ({
  appWorkerGeneration: () => worker.generation,
  retainAppWorker: () => () => undefined,
  runAppWorkerTask: vi.fn((task: string) => {
    if (task === 'cache.release-held') return Promise.resolve();
    if (task === 'cache.measure-held') {
      return worker.size === null ? Promise.reject(new Error('worker gone')) : Promise.resolve(worker.size);
    }
    return Promise.reject(new Error('worker gone'));
  }),
}));

const request = { field: 'data', writes: [] };

describe('holdWorkerValue', () => {
  afterEach(() => {
    worker.generation = 1;
    worker.size = 7;
  });

  it('asks the worker for the size it left out of the load', async () => {
    const value = [{ id: '1' }];
    holdWorkerValue(value, { token: 't1' }, false);
    expect(heldRecord(value)!.bytes).toBeUndefined();
    expect(await heldRecord(value)!.measure!()).toBe(7);
    worker.size = null;
    expect(await heldRecord(value)!.measure!()).toBeNull();
    releaseHeldRecord(value);
  });

  it('lets the page write its copy when the worker died mid-write', async () => {
    const value = [{ id: '1' }];
    holdWorkerValue(value, { token: 't1', bytes: 10 }, false);
    const write = heldRecord(value)!.write(request);
    worker.generation = null;
    expect(await write).toBe('missing');
    releaseHeldRecord(value);
  });

  it('reports a failed write from a worker that is still running', async () => {
    const value = [{ id: '1' }];
    holdWorkerValue(value, { token: 't1', bytes: 10 }, false);
    expect(await heldRecord(value)!.write(request)).toBe('failed');
    releaseHeldRecord(value);
  });

  it('knows a worker restarted before the write is not the one holding the value', async () => {
    const value = [{ id: '1' }];
    holdWorkerValue(value, { token: 't1', bytes: 10 }, false);
    worker.generation = 2;
    expect(await heldRecord(value)!.write(request)).toBe('missing');
    releaseHeldRecord(value);
  });
});
