import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./llm/llm-service', () => ({ LlmService: { run } }));

import { suggestGuideMatches } from './epg-ai-match';

const candidates = [
  { id: 'g::a1', channelId: 'alpha.one', name: 'Alpha 1' },
  { id: 'g::a2', channelId: 'alpha.two', name: 'Alpha 2' },
  { id: 'g::b', channelId: 'bravo', name: 'Bravo' },
];

beforeEach(() => run.mockReset());

describe('suggestGuideMatches', () => {
  it('sends names and ids only, and keeps confident picks in order', async () => {
    run.mockResolvedValue({ value: { matches: [
      { number: 2, confidence: 'medium' },
      { number: 1, confidence: 'high' },
      { number: 2, confidence: 'high' },
      { number: 3, confidence: 'low' },
      { number: 9, confidence: 'high' },
    ] }, dropped: 0, cached: false });

    await expect(suggestGuideMatches({ name: 'Alpha One HD', group: 'Group 1' }, candidates)).resolves
      .toEqual(['g::a2', 'g::a1']);
    const task = run.mock.calls[0][0] as { user: string; feature: string };
    expect(task.feature).toBe('epg-match');
    expect(task.user).toBe('Channel: Alpha One HD\nGroup: Group 1\nGuide channels:\n'
      + '1. Alpha 1 (alpha.one)\n2. Alpha 2 (alpha.two)\n3. Bravo (bravo)');
    expect(task.user).not.toContain('g::');
  });

  it('asks nothing without candidates', async () => {
    await expect(suggestGuideMatches({ name: 'Alpha', group: '' }, [])).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
