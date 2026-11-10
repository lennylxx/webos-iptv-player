import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdBatches, holdEpg, holdValue, measureHeldValue, writeHeldValue } from './held-values';
import { serializedBytes } from '../utils/serialized-bytes';
import { SearchCacheError, type CacheWrite } from './search-cache-reader';

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

  it('keeps a value whose write ran out of quota for the retry', async () => {
    const token = holdValue(['a']);
    const request = { token, timeoutMs: 1000, field: 'data', writes: [{ store: STORE, value: { key: 'k' } }] };
    expect(await writeHeldValue(request, () => Promise.reject(new SearchCacheError('quota_exceeded'))))
      .toBe('quota_exceeded');
    expect((await written(token)).result).toBe('written');
  });

  it('writes a value into a nested field without touching its siblings', async () => {
    const token = holdValue(['a']);
    const writes: CacheWrite[] = [];
    const record = { key: 'k', data: { channels: null, epgSources: ['e'] } };
    await writeHeldValue(
      { token, timeoutMs: 1000, field: 'data.channels', writes: [{ store: STORE, value: record }] },
      async batch => { writes.push(...batch); },
    );
    expect(writes).toEqual([{ store: STORE, value: { key: 'k', data: { channels: ['a'], epgSources: ['e'] } } }]);
    expect(record.data.channels).toBeNull();
  });

  it('joins held batches only once asked to measure or write them', async () => {
    const batches = [['a'], ['b']];
    const token = holdBatches(batches);
    batches.push(['c']);
    expect(measureHeldValue(token)).toBe(13);
    expect((await written(token)).writes[0]!.value).toEqual({ key: 'k', data: ['a', 'b', 'c'] });
    expect(measureHeldValue(token)).toBeNull();
  });

  it('drops the oldest value past the limit', async () => {
    const tokens = [holdValue(1), holdValue(2), holdValue(3), holdValue(4), holdValue(5)];
    expect((await written(tokens[0])).result).toBe('missing');
    for (const token of tokens.slice(1)) expect((await written(token)).result).toBe('written');
  });

  it('keeps every guide apart from the lists, built once on first use', async () => {
    const lists = [holdValue(1), holdValue(2), holdValue(3), holdValue(4)];
    const build = vi.fn(() => ({ channels: {} }));
    const guides = Array.from({ length: 5 }, () => holdEpg(build));
    expect(build).not.toHaveBeenCalled();
    expect(measureHeldValue(guides[0])).toBe(serializedBytes({ channels: {} }));
    expect((await written(guides[0])).writes[0]!.value).toEqual({ key: 'k', data: { channels: {} } });
    expect(build).toHaveBeenCalledTimes(1);
    for (const token of guides.slice(1)) expect((await written(token)).result).toBe('written');
    for (const token of lists) expect((await written(token)).result).toBe('written');
  });

  it('lets an unclaimed value go after two minutes', async () => {
    vi.useFakeTimers();
    const token = holdValue(['a']);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect((await written(token)).result).toBe('missing');
  });
});
