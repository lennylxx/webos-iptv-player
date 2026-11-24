import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./llm/llm-service', () => ({ LlmService: { run } }));

import { clipDescription, MAX_DESCRIPTION_CHARS, translateProgram } from './epg-translation';

beforeEach(() => run.mockReset());

describe('translateProgram', () => {
  it('sends only the title and description, into the target language', async () => {
    run.mockResolvedValue({ value: { title: 'Programm Alpha', description: 'Eine Folge.' }, dropped: 0, cached: false });

    await expect(translateProgram({ title: 'Program Alpha', description: 'An episode.' }, 'de')).resolves
      .toEqual({ title: 'Programm Alpha', description: 'Eine Folge.' });
    const task = run.mock.calls[0][0] as { user: string; system: string; feature: string; finishStarted: boolean };
    expect(task.feature).toBe('epg-translation');
    expect(task.user).toBe('Title: Program Alpha\nDescription: An episode.');
    expect(task.system).toContain('into German.');
    expect(task.finishStarted).toBe(true);
  });

  it('names Simplified Chinese for zh-CN', async () => {
    run.mockResolvedValue({ value: { title: 'a', description: '' }, dropped: 0, cached: false });
    await translateProgram({ title: 'Program Alpha', description: '' }, 'zh-CN');
    expect((run.mock.calls[0][0] as { system: string }).system).toContain('into Simplified Chinese.');
  });

  it('keeps the original text a reply leaves out', async () => {
    run.mockResolvedValue({ value: { title: ' ', description: '' }, dropped: 0, cached: false });
    await expect(translateProgram({ title: 'Program Alpha', description: 'An episode.' }, 'de')).resolves
      .toEqual({ title: 'Program Alpha', description: 'An episode.' });
  });

  it('clips a long description', async () => {
    run.mockResolvedValue({ value: { title: 'a', description: 'b' }, dropped: 0, cached: false });
    await translateProgram({ title: 'Program Alpha', description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 50) }, 'de');
    const user = (run.mock.calls[0][0] as { user: string }).user;
    expect(user.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 50);
    expect(user.endsWith('…')).toBe(true);
  });

  it('keeps a long description already in the target language whole', async () => {
    const long = `${'word '.repeat(400)}end.`;
    // The model copies back the clipped text it was sent.
    run.mockResolvedValue({ value: { title: 'Program Alpha', description: clipDescription(long) }, dropped: 0, cached: false });
    await expect(translateProgram({ title: 'Program Alpha', description: long }, 'en')).resolves
      .toEqual({ title: 'Program Alpha', description: long });
  });
});
