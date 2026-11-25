// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const cache = new Map<string, unknown>();
vi.mock('../services/idb-cache', () => ({
  getCachedLlmResult: vi.fn(async (key: string) => cache.get(key)),
  setCachedLlmResult: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
}));
vi.mock('./toast', () => ({ showToast: vi.fn() }));

import { defaultLlmConfig } from '../services/llm/config';
import { resetLlmServiceForTests } from '../services/llm/llm-service';
import { StorageService } from '../services/storage-service';
import {
  MAX_REMEMBERED_TRANSLATIONS,
  ProgramTranslation,
  programView,
  liveSource,
  resetProgramTranslationForTests,
  TRANSLATION_DWELL_MS,
} from './program-translation';

const ch1 = { name: 'ch1', url: 'http://host/a', playlistIds: [] } as unknown as Channel;
const live1 = liveSource(ch1);
const owner = {};
const program = (i: number) => ({ title: `Program ${i}`, description: '' });

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });
}

// A server that translates every line it gets, keeping the lines' tags.
function answerAll() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { messages: Array<{ content: string }> };
    return reply(body.messages[1].content.replace(/Program/g, 'Programm'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  cache.clear();
  resetLlmServiceForTests();
  StorageService.setLlmConfig({
    ...defaultLlmConfig(),
    enabled: true,
    baseUrl: 'http://host/v1',
    model: 'm1',
    capabilities: { signature: 'http://host/v1|m1', structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 },
  });
});

afterEach(() => {
  resetProgramTranslationForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('brings a translation dropped from memory back from the cache without a new AI request', async () => {
  const fetch = answerAll();
  ProgramTranslation.toggle();
  for (let i = 0; i <= MAX_REMEMBERED_TRANSLATIONS; i++) {
    ProgramTranslation.want(owner, live1, program(i));
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
  }
  expect(fetch).toHaveBeenCalledTimes(MAX_REMEMBERED_TRANSLATIONS + 1);
  expect(programView(live1, program(0)).label).toBe('');

  ProgramTranslation.want(owner, live1, program(0));
  await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
  expect(programView(live1, program(0))).toEqual({ title: 'Programm 0', description: '', label: 'AI translation', ai: true });
  expect(fetch).toHaveBeenCalledTimes(MAX_REMEMBERED_TRANSLATIONS + 1);
});

it('shows programs a batch translated on their own later, and a batch reuses what one asked alone', async () => {
  const fetch = answerAll();
  ProgramTranslation.toggle();
  ProgramTranslation.want(owner, live1, program(1));
  await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
  ProgramTranslation.show(owner, [0, 1, 2].map(i => ({ source: live1, text: program(i) })));
  await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
  expect(fetch).toHaveBeenCalledTimes(2);
  const second = JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)) as { messages: Array<{ content: string }> };
  expect(second.messages[1].content).toBe('[T1] Program 0\n[T2] Program 2');

  // Dropped from memory, each comes back from its own cached answer.
  resetProgramTranslationForTests();
  ProgramTranslation.toggle();
  ProgramTranslation.want(owner, live1, program(2));
  await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
  expect(programView(live1, program(2)).title).toBe('Programm 2');
  expect(fetch).toHaveBeenCalledTimes(2);
});
