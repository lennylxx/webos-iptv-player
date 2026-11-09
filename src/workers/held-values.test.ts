import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdValue, writeHeldValue } from './held-values';
import type { CacheWrite } from './search-cache-reader';

const STORE = 'catalog-cache';

async function written(token: string): Promise<{ result: string; writes: CacheWrite[] }> {
  const writes: CacheWrite[] = [];
  const result = await writeHeldValue(
    { token, timeoutMs: 1000, field: 'data', writes: [{ store: STORE, value: { key: 'k', data: null } }] },
    async batch => { writes.push(...batch); },
  );
  return { result, writes };
}

describe('held values', () => {
  afterEach(() => vi.useRealTimers());

  it('writes a value once, into the field it was asked for', async () => {
    const token = holdValue(['a']);
    const first = await written(token);
    expect(first.result).toBe('written');
    expect(first.writes).toEqual([{ store: STORE, value: { key: 'k', data: ['a'] } }]);
    expect((await written(token)).result).toBe('missing');
  });

  it('reports a written value only once its write succeeded', async () => {
    const seen: unknown[] = [];
    const request = { timeoutMs: 1000, field: 'data', writes: [{ store: STORE, value: { key: 'k' } }] };
    const failed = holdValue(['a']);
    await writeHeldValue({ ...request, token: failed }, () => Promise.reject(new Error('x')), (...args) => seen.push(args));
    expect(seen).toEqual([]);
    await writeHeldValue({ ...request, token: failed }, async () => undefined, (...args) => seen.push(args));
    expect(seen).toEqual([[STORE, { key: 'k', data: ['a'] }]]);
  });

  it('drops the oldest value past the limit', async () => {
    const tokens = [holdValue(1), holdValue(2), holdValue(3), holdValue(4)];
    expect((await written(tokens[0])).result).toBe('missing');
    for (const token of tokens.slice(1)) expect((await written(token)).result).toBe('written');
  });

  it('lets an unclaimed value go after two minutes', async () => {
    vi.useFakeTimers();
    const token = holdValue(['a']);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect((await written(token)).result).toBe('missing');
  });
});
