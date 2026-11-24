// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run, isReady } = vi.hoisted(() => ({ run: vi.fn(), isReady: vi.fn(() => true) }));
vi.mock('../services/llm/llm-service', () => ({ LlmService: { run, isReady } }));

import { CONFIG } from '../config';
import { resetSearchExpansionForTests } from '../services/search-expansion';
import { SearchQueryExpansion } from './search-query-expansion';

function reply(...texts: string[]): unknown {
  return { value: { alternatives: texts.map(text => ({ text, lang: 'l1', kind: 'translation' })) }, dropped: 0, cached: false };
}

const DELAY = CONFIG.SEARCH.EXPANSION_DELAY_MS;
const settlingAdds = vi.fn((key: string) => key !== '1234');

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset();
  isReady.mockReturnValue(true);
  resetSearchExpansionForTests();
});

afterEach(() => vi.useRealTimers());

describe('SearchQueryExpansion', () => {
  it('asks once typing pauses, then offers the alternatives for that query only', async () => {
    run.mockResolvedValue(reply('quix'));
    const ready = vi.fn<(query: string) => void>();
    const expansion = new SearchQueryExpansion(ready, settlingAdds);
    expansion.plan('zo');
    expansion.plan('zor');
    expansion.plan('zorb');
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith('zorb');
    expect(expansion.alternativesFor('Zorb ')).toEqual(['quix']);
  });

  it('hands over the normalized query, so a case or spacing change keeps the answer', async () => {
    run.mockResolvedValue(reply('quix'));
    const ready = vi.fn<(key: string) => void>();
    const expansion = new SearchQueryExpansion(ready, settlingAdds);
    expansion.plan('Zorb');
    expansion.plan('zorb ');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith('zorb');
    expect(expansion.alternativesFor('zorbs')).toBeUndefined();
  });

  it('drops an answer a newer query superseded, and reuses a known answer at once', async () => {
    let resolve: (value: unknown) => void = () => {};
    run.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const ready = vi.fn<(query: string) => void>();
    const expansion = new SearchQueryExpansion(ready, settlingAdds);
    expansion.plan('zorb');
    await vi.advanceTimersByTimeAsync(DELAY);
    const signal = (run.mock.calls[0][0] as { signal: AbortSignal }).signal;
    expansion.plan('zorbs');
    expect(signal.aborted).toBe(true);
    resolve(reply('quix'));
    await vi.advanceTimersByTimeAsync(0);
    // Only the pause itself asked for a ranking, not the superseded answer.
    expect(ready).toHaveBeenCalledTimes(1);
    expect(expansion.alternativesFor('zorb')).toBeUndefined();

    // The sent request still finished and was kept, so going back needs no wait.
    expansion.plan('zorb');
    expect(expansion.alternativesFor('zorb')).toEqual(['quix']);
  });

  it('sends nothing while the feature is off, and stays quiet when the model fails', async () => {
    isReady.mockReturnValue(false);
    const ready = vi.fn<(query: string) => void>();
    const expansion = new SearchQueryExpansion(ready, settlingAdds);
    expansion.plan('zorb');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(run).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);

    isReady.mockReturnValue(true);
    run.mockRejectedValue(new Error('down'));
    expansion.plan('quix');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(2);
    expect(expansion.alternativesFor('quix')).toBeUndefined();
  });

  it('marks a query settled once typing pauses, and reranks it only when the settled ranking tries more', async () => {
    isReady.mockReturnValue(false);
    const ready = vi.fn<(key: string) => void>();
    const expansion = new SearchQueryExpansion(ready, settlingAdds);
    expansion.plan('zorb');
    expect(expansion.settledOn('zorb')).toBe(false);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(expansion.settledOn('Zorb ')).toBe(true);
    expect(expansion.settledOn('zorbs')).toBe(false);
    expect(ready).toHaveBeenCalledWith('zorb');

    expansion.plan('1234');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(expansion.settledOn('1234')).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('does not rerank for a known empty AI answer', async () => {
    run.mockResolvedValue(reply());
    const ready = vi.fn<(key: string) => void>();
    const expansion = new SearchQueryExpansion(ready, () => false);
    expansion.plan('zorb');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expansion.plan('zorbs');
    expansion.plan('zorb');
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(run).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });
});
