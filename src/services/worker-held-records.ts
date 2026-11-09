import { CONFIG } from '../config';
import { appWorkerGeneration, retainAppWorker, runAppWorkerTask } from '../workers/app-worker-client';
import { holdRecord, releaseHeldRecord } from './held-records';

// The worker keeps the value it sent, so caching it there skips cloning it here.
export function holdWorkerValue(
  value: object,
  held: { token: string; bytes?: number },
  detached: boolean,
): void {
  const { token } = held;
  // A worker stopped when idle loses the value, so it runs until the page
  // caches or drops it, or the worker would have forgotten it anyway.
  const releaseWorker = retainAppWorker();
  const generation = appWorkerGeneration();
  const expiry = setTimeout(() => releaseHeldRecord(value), CONFIG.XTREAM.HELD_LIST_MS);
  holdRecord(value, {
    ...(held.bytes !== undefined
      ? { bytes: held.bytes }
      // Left out of the load so it didn't wait on a walk of the whole value.
      : { measure: () => runAppWorkerTask('cache.measure-held', { token }).catch(() => null) }),
    ...(detached ? { detached } : {}),
    write: request => runAppWorkerTask('cache.write-held', {
      ...request,
      token,
      timeoutMs: CONFIG.XTREAM.HELD_WRITE_TIMEOUT_MS,
    // A worker that died mid-write took the value with it, so the page
    // writes its own copy rather than leaving no cache at all.
    }).catch(() => appWorkerGeneration() === generation ? 'failed' as const : 'missing' as const),
    release: () => {
      clearTimeout(expiry);
      runAppWorkerTask('cache.release-held', { token }).catch(() => undefined);
      releaseWorker();
    },
  });
}
