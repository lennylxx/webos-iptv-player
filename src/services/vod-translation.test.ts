import { expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./llm/llm-service', () => ({ LlmService: { run } }));

import { translateVod } from './vod-translation';

it('sends only the title and description under its own feature and prompt', async () => {
  run.mockResolvedValue({ value: { title: 'Film Alpha', description: 'Eine Handlung.' }, dropped: 0, cached: false });

  await expect(translateVod({ title: 'Movie Alpha', description: 'A plot.' }, 'de')).resolves
    .toEqual({ title: 'Film Alpha', description: 'Eine Handlung.' });
  const task = run.mock.calls[0][0] as { user: string; system: string; feature: string };
  expect(task.feature).toBe('vod-translation');
  expect(task.user).toBe('Title: Movie Alpha\nDescription: A plot.');
  expect(task.system).toContain('movie and TV series information into German.');
});
