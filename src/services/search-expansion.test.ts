import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./llm/llm-service', () => ({ LlmService: { run } }));

import {
  cachedExpansion,
  expandSearchQuery,
  expansionQuery,
  resetSearchExpansionForTests,
} from './search-expansion';

type Alternative = { text: string; lang?: string; kind?: string };

function reply(alternatives: Alternative[], dropped = 0): unknown {
  return {
    value: { alternatives: alternatives.map(a => ({ lang: 'l1', kind: 'translation', ...a })) },
    dropped,
    cached: false,
  };
}

beforeEach(() => {
  run.mockReset();
  resetSearchExpansionForTests();
});

afterEach(() => vi.restoreAllMocks());

describe('expansionQuery', () => {
  it('normalizes the query and skips one too short or too long', () => {
    expect(expansionQuery('  Zorb   Quix ')).toBe('zorb quix');
    expect(expansionQuery('ab')).toBeNull();
    expect(expansionQuery('a b c')).toBe('a b c');
    expect(expansionQuery('a b c d e f g')).toBeNull();
    expect(expansionQuery('!!!')).toBeNull();
  });

  it('counts each CJK character as two letters', () => {
    expect(expansionQuery('体育')).toBe('体育');
    expect(expansionQuery('体')).toBeNull();
  });
});

describe('expandSearchQuery', () => {
  it('sends only the query and keeps up to six new alternatives', async () => {
    run.mockResolvedValue(reply([
      { text: 'Zorb' }, { text: ' quix ' }, { text: 'QUIX' },
      { text: 'alt1' }, { text: 'alt2' }, { text: 'alt3' }, { text: 'alt4' }, { text: 'alt5' }, { text: 'alt6' },
    ]));
    await expect(expandSearchQuery(' ZORB ')).resolves.toEqual(['quix', 'alt1', 'alt2', 'alt3', 'alt4', 'alt5']);
    const task = run.mock.calls[0][0] as { user: string; feature: string };
    expect(JSON.parse(task.user)).toEqual({ query: 'zorb' });
    expect(task.feature).toBe('search-expansion');
  });

  it('answers a repeat of the query from memory', async () => {
    run.mockResolvedValue(reply([{ text: 'quix' }]));
    expect(cachedExpansion('zorb')).toBeUndefined();
    await expandSearchQuery('zorb');
    expect(cachedExpansion('Zorb ')).toEqual(['quix']);
    await expect(expandSearchQuery('ZORB')).resolves.toEqual(['quix']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a reply whose alternatives are all unusable, but not one that only repeats the query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    run.mockResolvedValueOnce(reply([{ text: 'zorb' }]));
    await expect(expandSearchQuery('zorb')).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    run.mockResolvedValueOnce(reply([{ text: '...' }, { text: 'x'.repeat(61) }], 1));
    await expect(expandSearchQuery('quix')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('[Search]', expect.any(String), 'event=search.expansion.invalid', 'dropped=3');
  });

  it('skips alternatives too short to search', async () => {
    run.mockResolvedValue(reply([{ text: 'qx' }, { text: '足' }, { text: '足球' }, { text: 'quix' }]));
    await expect(expandSearchQuery('zorb')).resolves.toEqual(['足球', 'quix']);
  });

  it('sends one request for a query asked again while it is on its way', async () => {
    let resolve: (value: unknown) => void = () => {};
    run.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const first = new AbortController();
    const dropped = expandSearchQuery('zorb', first.signal);
    first.abort();
    await expect(dropped).rejects.toMatchObject({ reason: 'cancelled' });
    const again = expandSearchQuery('zorb');
    resolve(reply([{ text: 'quix' }]));
    await expect(again).resolves.toEqual(['quix']);
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as { priority: string }).priority).toBe('background');
  });

  it('asks again when the request every caller had dropped never left the queue', async () => {
    run.mockImplementationOnce((task: { signal: AbortSignal }) => new Promise((_, reject) => {
      task.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })));
    }));
    const first = new AbortController();
    const dropped = expandSearchQuery('zorb', first.signal);
    first.abort();
    await expect(dropped).rejects.toMatchObject({ reason: 'cancelled' });
    run.mockResolvedValueOnce(reply([{ text: 'quix' }]));
    await expect(expandSearchQuery('zorb')).resolves.toEqual(['quix']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for a query too short to expand', async () => {
    await expect(expandSearchQuery('ab')).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
