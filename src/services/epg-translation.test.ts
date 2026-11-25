import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runText, cachedText, storeText, cache } = vi.hoisted(() => {
  const cache = new Map<string, string>();
  return {
    cache,
    runText: vi.fn(),
    cachedText: vi.fn(async (task: { user: string }) => cache.get(task.user)),
    storeText: vi.fn(async (task: { user: string }, text: string) => { cache.set(task.user, text); }),
  };
});
vi.mock('./llm/llm-service', () => ({ LlmService: { runText, cachedText, storeText, contextTokens: () => 16000 } }));

import { LlmError } from './llm/client';
import { clipDescription, MAX_BATCH_ITEMS, MAX_DESCRIPTION_CHARS, parseItems, translatePrograms } from './epg-translation';

interface Task { user: string; system: string; feature: string; finishStarted: boolean; priority: string }
const tasks = () => runText.mock.calls.map(call => call[0] as Task);
const program = (i: number, description = `Episode ${i}.`) => ({ title: `Program ${i}`, description });
// Answers like a model: every line with its tag, translated.
const translateLines = (user: string) => user.replace(/Program/g, 'Programm').replace(/Episode/g, 'Folge');

beforeEach(() => {
  runText.mockReset();
  runText.mockImplementation(async (task: Task) => ({ text: translateLines(task.user), cached: false }));
  cache.clear();
  storeText.mockClear();
});

describe('translatePrograms', () => {
  it('sends the titles and descriptions as numbered plain-text lines in one request', async () => {
    const out = await translatePrograms([program(1), program(2, ''), { title: '', description: 'Only a plot.' }], 'de');
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].user).toBe('[T1] Program 1\n[D1] Episode 1.\n[T2] Program 2\n[D3] Only a plot.');
    expect(tasks()[0].feature).toBe('epg-translation');
    expect(tasks()[0].priority).toBe('foreground');
    expect(tasks()[0].finishStarted).toBe(true);
    expect(tasks()[0].system).toContain('into German');
    expect(out).toEqual([
      { text: { title: 'Programm 1', description: 'Folge 1.' } },
      { text: { title: 'Programm 2', description: '' } },
      { text: { title: '', description: 'Only a plot.' } },
    ]);
  });

  it('names Simplified Chinese for zh-CN', async () => {
    await translatePrograms([program(1)], 'zh-CN');
    expect(tasks()[0].system).toContain('into Simplified Chinese');
  });

  it('keeps each answer per program, so a later request alone or with others reuses it', async () => {
    await translatePrograms([program(1), program(2)], 'de');
    expect(storeText).toHaveBeenCalledTimes(2);
    runText.mockClear();
    const out = await translatePrograms([program(2)], 'de');
    expect(runText).not.toHaveBeenCalled();
    expect(out).toEqual([{ text: { title: 'Programm 2', description: 'Folge 2.' } }]);

    await translatePrograms([program(1), program(3), program(2)], 'de');
    expect(tasks().map(task => task.user)).toEqual(['[T1] Program 3\n[D1] Episode 3.']);
  });

  it('sends each program alone when a reply does not match the lines sent, never mapping it', async () => {
    runText.mockImplementationOnce(async () => ({ text: '[T1] Programm 2\n[D1] Folge 2.\n[T2] Programm 1', cached: false }));
    const out = await translatePrograms([program(1), program(2)], 'de');
    expect(tasks().map(task => task.user)).toEqual([
      '[T1] Program 1\n[D1] Episode 1.\n[T2] Program 2\n[D2] Episode 2.',
      '[T1] Program 1\n[D1] Episode 1.',
      '[T1] Program 2\n[D1] Episode 2.',
    ]);
    expect(out).toEqual([
      { text: { title: 'Programm 1', description: 'Folge 1.' } },
      { text: { title: 'Programm 2', description: 'Folge 2.' } },
    ]);
  });

  it('fails a lone program whose reply does not match', async () => {
    runText.mockResolvedValueOnce({ text: 'Programm 1', cached: false });
    const [out] = await translatePrograms([program(1)], 'de');
    expect((out as { error: LlmError }).error.reason).toBe('schema');
    expect(storeText).not.toHaveBeenCalled();
  });

  it('fails every program of a request that fails', async () => {
    const error = new LlmError('cap', 'Daily cap reached');
    runText.mockRejectedValueOnce(error);
    expect(await translatePrograms([program(1), program(2)], 'de')).toEqual([{ error }, { error }]);
  });

  it('splits a long list into requests of at most MAX_BATCH_ITEMS', async () => {
    const programs = Array.from({ length: MAX_BATCH_ITEMS + 3 }, (_, i) => program(i));
    const out = await translatePrograms(programs, 'de');
    expect(tasks().map(task => task.user.split('\n').length)).toEqual([MAX_BATCH_ITEMS * 2, 6]);
    expect(out.every(outcome => 'text' in outcome)).toBe(true);
  });

  it('clips a long description and keeps it whole when the reply copies it back', async () => {
    const long = `${'word '.repeat(400)}end.`;
    runText.mockImplementationOnce(async (task: Task) => ({ text: task.user, cached: false }));
    const [out] = await translatePrograms([{ title: 'Program 1', description: long }], 'en');
    expect(tasks()[0].user.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 40);
    expect(tasks()[0].user).toContain(clipDescription(long.trim()).replace(/\s+/g, ' ').trim());
    expect(out).toEqual({ text: { title: 'Program 1', description: long } });
  });
});

describe('parseItems', () => {
  const sent = [{ title: 'a', description: 'b' }, { title: 'c', description: '' }];

  it('reads full-width brackets, a continued line, and a preamble before the first tag', () => {
    expect(parseItems('Here you go:\n【T1】 A\n[D1] B\nmore\n［T2］: C', sent))
      .toEqual([{ title: 'A', description: 'B more' }, { title: 'C', description: '' }]);
  });

  it('refuses a missing, repeated, or unknown line', () => {
    expect(parseItems('[T1] A\n[D1] B', sent)).toBeNull();
    expect(parseItems('[T1] A\n[D1] B\n[T2] C\n[T2] D', sent)).toBeNull();
    expect(parseItems('[T1] A\n[D1] B\n[T2] C\n[D2] D', sent)).toBeNull();
    expect(parseItems('[T1] A\n[D1] B\n[T2] C\n[T3] D', sent)).toBeNull();
  });
});
