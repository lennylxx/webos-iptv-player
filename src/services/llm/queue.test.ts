import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmQueue } from './queue';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function deferred(): { promise: Promise<string>; resolve: (v: string) => void } {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('LLM request queue', () => {
  it('runs foreground jobs before queued background jobs', async () => {
    const queue = new LlmQueue({ concurrency: 1 });
    const order: string[] = [];
    const first = deferred();
    const blocker = queue.run('background', () => { order.push('b1'); return first.promise; });
    const b2 = queue.run('background', async () => { order.push('b2'); return 'b2'; });
    const f1 = queue.run('foreground', async () => { order.push('f1'); return 'f1'; });
    first.resolve('b1');
    await Promise.all([blocker, b2, f1]);
    expect(order).toEqual(['b1', 'f1', 'b2']);
  });

  it('pauses after a quota answer, and cancels a queued job', async () => {
    const queue = new LlmQueue({ concurrency: 1 });
    queue.pause(5000);
    const ran = vi.fn(async () => 'x');
    const controller = new AbortController();
    const cancelled = queue.run('foreground', ran, controller.signal);
    const kept = queue.run('foreground', ran);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ reason: 'cancelled' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(kept).resolves.toBe('x');
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('prechecks a job as it leaves the queue, not when it joins', async () => {
    const queue = new LlmQueue({ concurrency: 1 });
    const started: string[] = [];
    let capped = false;
    const first = deferred();
    const blocker = queue.run('background', () => { started.push('a'); return first.promise; });
    const refused = queue.run('background', async () => { started.push('b'); return 'b'; }, undefined,
      { precheck: () => (capped ? new Error('cap') : null) });
    const next = queue.run('background', async () => { started.push('c'); return 'c'; });
    capped = true;
    first.resolve('a');
    await expect(refused).rejects.toThrow('cap');
    await expect(Promise.all([blocker, next])).resolves.toEqual(['a', 'c']);
    expect(started).toEqual(['a', 'c']);
  });
});
