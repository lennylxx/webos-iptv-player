import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../llm/llm-service', () => ({ LlmService: { run } }));

import { suggestSearchTitle } from './ai-title';

function reply(value: Record<string, unknown>): { value: unknown; dropped: number; cached: boolean } {
  return { value: { title: '', year: 0, season: 0, episode: 0, original_title: '', ...value }, dropped: 0, cached: false };
}

beforeEach(() => run.mockReset());

describe('suggestSearchTitle', () => {
  it('sends only the name and type, and maps the reply', async () => {
    run.mockResolvedValue(reply({ title: ' Alpha ', year: 2019, original_title: 'Bravo' }));
    await expect(suggestSearchTitle('|EN| Alpha 4K', 'movie')).resolves.toEqual({
      title: 'Alpha', year: 2019, season: 0, episode: 0, originalTitle: 'Bravo',
    });
    const task = run.mock.calls[0][0] as { user: string; feature: string; schema: unknown };
    expect(JSON.parse(task.user)).toEqual({ type: 'movie', name: '|EN| Alpha 4K' });
    expect(task.feature).toBe('subtitle-title');
  });

  it('drops an original title that only repeats the title, and an empty title', async () => {
    run.mockResolvedValueOnce(reply({ title: 'Alpha', original_title: 'alpha' }));
    await expect(suggestSearchTitle('Alpha', 'movie')).resolves.toMatchObject({ originalTitle: '' });
    run.mockResolvedValueOnce(reply({ title: '  ' }));
    await expect(suggestSearchTitle('Alpha', 'movie')).resolves.toBeNull();
  });
});
