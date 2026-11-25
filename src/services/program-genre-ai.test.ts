import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedSchema } from './llm/types';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./llm/llm-service', () => ({ LlmService: { run } }));

import { validate } from './llm/json';
import { classifyBatch, planGenreBatches, type GenreItem } from './program-genre-ai';

interface Task {
  feature: string;
  priority: string;
  user: string;
  schema: NamedSchema;
}

const item = (title: string, description = ''): GenreItem => ({ key: title.toLowerCase(), title, description });
const task = (): Task => run.mock.calls[0][0] as Task;

beforeEach(() => run.mockReset());

describe('planGenreBatches', () => {
  it('orders by key, so the same titles make the same batches', () => {
    const a = planGenreBatches([item('Charlie'), item('Alpha'), item('Bravo')], 16000);
    expect(planGenreBatches([item('Bravo'), item('Charlie'), item('Alpha')], 16000)).toEqual(a);
    expect(a[0].map(i => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('splits by item count and by the context size', () => {
    const many = Array.from({ length: 450 }, (_, i) => item(`Show ${1000 + i}`, 'An episode.'));
    expect(planGenreBatches(many, 16000).map(batch => batch.length)).toEqual([200, 200, 50]);
    // A larger context takes more a batch, as long as the reply stays within 8192 tokens.
    expect(planGenreBatches(many, 32000).map(batch => batch.length)).toEqual([400, 50]);
    expect(planGenreBatches(many, 128000).map(batch => batch.length)).toEqual([450]);
    const thousand = Array.from({ length: 1000 }, (_, i) => item(`Show ${1000 + i}`, 'An episode.'));
    expect(planGenreBatches(thousand, 128000).map(batch => batch.length)).toEqual([580, 420]);
    const small = planGenreBatches(many, 2048);
    expect(small.length).toBeGreaterThan(3);
    expect(small.reduce((sum, batch) => sum + batch.length, 0)).toBe(450);
  });
});

describe('classifyBatch', () => {
  it('sends titles and clipped descriptions only, in the background', async () => {
    run.mockResolvedValue({ value: { items: [] }, dropped: 0, cached: false });
    await classifyBatch([item('Alpha', `Long ${'x'.repeat(400)}`), item('Bravo')]);
    const sent = JSON.parse(task().user) as { genres: string[]; items: Array<{ i: number; t: string; d?: string }> };
    expect(task().feature).toBe('program-genres');
    expect(task().priority).toBe('background');
    expect(sent.genres).toContain('sports');
    expect(sent.items.map(i => [i.i, i.t])).toEqual([[0, 'Alpha'], [1, 'Bravo']]);
    expect(sent.items[0].d?.length).toBe(161);
    expect(sent.items[1]).not.toHaveProperty('d');
    expect(task().user).not.toContain('alpha');
  });

  it('maps genres back to keys; a repeat or a missing item gets none', async () => {
    run.mockResolvedValue({
      value: { items: [{ i: 0, g: 'sports' }, { i: 0, g: 'news' }, { i: 1, g: 'none' }] },
      dropped: 1,
      cached: true,
    });
    const result = await classifyBatch([item('Alpha'), item('Bravo'), item('Charlie')]);
    expect(result).toEqual({ genres: { alpha: 'sports', bravo: '', charlie: '' }, cached: true, dropped: 2 });
  });

  it('accepts only the listed genres and indexes in range', async () => {
    run.mockResolvedValue({ value: { items: [] }, dropped: 0, cached: false });
    await classifyBatch([item('Alpha'), item('Bravo')]);
    const checked = validate(task().schema.schema, {
      items: [{ i: 0, g: 'sports' }, { i: 1, g: 'adult' }, { i: 2, g: 'news' }, { i: 1, g: 'Sports' }],
    });
    expect(checked).toEqual({ value: { items: [{ i: 0, g: 'sports' }] }, dropped: 3 });
  });
});
