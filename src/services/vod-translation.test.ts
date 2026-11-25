import { expect, it, vi } from 'vitest';

const { runText } = vi.hoisted(() => ({ runText: vi.fn() }));
vi.mock('./llm/llm-service', () => ({
  LlmService: { runText, cachedText: async () => undefined, storeText: async () => undefined, contextTokens: () => 16000 },
}));

import { translateVods } from './vod-translation';

it('sends only the titles and descriptions under its own feature and prompt', async () => {
  runText.mockResolvedValue({ text: '[T1] Film Alpha\n[D1] Eine Handlung.', cached: false });

  await expect(translateVods([{ title: 'Movie Alpha', description: 'A plot.' }], 'de')).resolves
    .toEqual([{ text: { title: 'Film Alpha', description: 'Eine Handlung.' } }]);
  const task = runText.mock.calls[0][0] as { user: string; system: string; feature: string };
  expect(task.feature).toBe('vod-translation');
  expect(task.user).toBe('[T1] Movie Alpha\n[D1] A plot.');
  expect(task.system).toContain('movie and TV series information into German');
});
