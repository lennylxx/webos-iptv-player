import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from '../llm/json';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock('../llm/llm-service', () => ({
  LlmService: { run: runMock, contextTokens: () => 16000 },
}));

import { askSchema, askSearch, capNames, capVocabulary } from './ask-query';

const reply = {
  types: ['program'],
  keywords: [' Alpha ', 'alpha', '', 'Bravo'],
  groups: ['Group A'],
  genres: ['Genre A'],
  time: 'tonight',
  from_hour: -1,
  to_hour: -1,
};

describe('ask-query', () => {
  beforeEach(() => {
    runMock.mockReset();
    runMock.mockResolvedValue({ value: reply, dropped: 1, cached: false });
  });

  it('keeps the leading names that fit the budget, at most 150', () => {
    expect(capNames(['A1', 'A1', ' ', 'B2', 'C3'], 4)).toEqual(['A1']);
    const many = Array.from({ length: 300 }, (_unused, index) => `n${String(index)}`);
    expect(capNames(many, 100000)).toHaveLength(150);
    expect(capVocabulary({ groups: many, categories: [], genres: many }, 400).groups.length)
      .toBeLessThan(capVocabulary({ groups: many, categories: [], genres: [] }, 400).groups.length);
  });

  it('sends the most used names in a stable order', () => {
    expect(capVocabulary({ groups: ['b', 'c', 'a'], categories: [], genres: [] }, 12).groups).toEqual(['b', 'c']);
    expect(capVocabulary({ groups: ['c', 'b', 'a'], categories: [], genres: [] }, 100).groups).toEqual(['a', 'b', 'c']);
  });

  it('allows only the given names and leaves out a list the viewer lacks', () => {
    const schema = askSchema(['channel', 'program'], { groups: ['Group A'], categories: [], genres: [] });
    expect(validate(schema.schema, { ...reply, genres: undefined, groups: ['Group A', 'Made up'] }))
      .toEqual({ value: expect.objectContaining({ groups: ['Group A'] }), dropped: 1 });
    expect(validate(schema.schema, { ...reply, genres: undefined, categories: ['Cat A'] })?.value)
      .not.toHaveProperty('categories');
    expect(validate(schema.schema, { ...reply, genres: undefined, time: 'midnight' })).toBeNull();
  });

  it('sends the query and the names only, and cleans the reply', async () => {
    const signal = new AbortController().signal;
    const result = await askSearch(' alpha tonight ', ['channel', 'program'], {
      groups: ['Group A'], categories: [], genres: ['Genre A'],
    }, signal);
    const task = runMock.mock.calls[0][0] as { feature: string; user: string; signal: AbortSignal };
    expect(task.feature).toBe('search-ask');
    expect(task.signal).toBe(signal);
    expect(JSON.parse(task.user)).toEqual({
      query: 'alpha tonight', types: ['channel', 'program'], groups: ['Group A'], genres: ['Genre A'],
    });
    expect(result).toEqual({
      filter: {
        types: ['program'], keywords: ['Alpha', 'Bravo'], groups: ['Group A'], categories: [],
        genres: ['Genre A'], time: 'tonight', fromHour: -1, toHour: -1,
      },
      dropped: 1,
      cached: false,
    });
  });
});
