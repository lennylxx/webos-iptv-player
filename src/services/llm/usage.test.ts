import { describe, expect, it } from 'vitest';
import { defaultLlmConfig } from './config';
import { addUsage, capHit, usageFor } from './usage';

describe('LLM usage counters', () => {
  it('start from zero on a new local day', () => {
    const day1 = new Date(2026, 0, 1, 23, 0).getTime();
    const day2 = new Date(2026, 0, 2, 0, 30).getTime();
    const used = addUsage(usageFor(null, day1), 'f1', { inputTokens: 5, outputTokens: 1 });
    expect(usageFor(used, day1).features.f1).toEqual({ requests: 1, inputTokens: 5, outputTokens: 1 });
    expect(usageFor(used, day2).features).toEqual({});
  });

  it('hit the token cap across features', () => {
    const now = Date.now();
    let usage = addUsage(usageFor(null, now), 'f1', { inputTokens: 60, outputTokens: 0 });
    usage = addUsage(usage, 'f2', { inputTokens: 30, outputTokens: 10 });
    expect(capHit({ ...defaultLlmConfig(), dailyTokenCap: 101 }, usage)).toBeNull();
    expect(capHit({ ...defaultLlmConfig(), dailyTokenCap: 100 }, usage)).toBe('tokens');
    expect(capHit({ ...defaultLlmConfig(), dailyRequestCap: 2 }, usage)).toBe('requests');
  });
});
