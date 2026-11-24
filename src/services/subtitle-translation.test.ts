import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VttCue } from '../utils/webvtt';

const { runText } = vi.hoisted(() => ({ runText: vi.fn() }));
vi.mock('./llm/llm-service', () => ({
  LlmService: { runText, contextTokens: () => 16000 },
}));
vi.mock('./storage-service', () => ({
  StorageService: { getOnlineSubtitleConfig: () => ({ preferredLanguage: '' }) },
}));

import { LlmError } from './llm/client';
import type { LlmTextTask } from './llm/llm-service';
import {
  batchOrder,
  formatLines,
  needsTranslation,
  parseLines,
  planBatches,
  replyTokens,
  sameTarget,
  SubtitleTranslation,
  targetCode,
} from './subtitle-translation';

type Outcome = { text: string; cached: boolean };

function cues(count: number, text = (i: number) => `Line ${i}`): VttCue[] {
  return Array.from({ length: count }, (_, i) => ({ start: i * 2, end: i * 2 + 1, text: text(i) }));
}

function inputLines(task: LlmTextTask): string[] {
  return task.user.split('\n').map(line => line.replace(/^\[\d+\] /, ''));
}

// Echoes each line back as "<text> (l2)", so a test can see which lines came back.
function translate(task: LlmTextTask): Promise<Outcome> {
  return Promise.resolve({ text: formatLines(inputLines(task).map(text => `${text} (l2)`)), cached: false });
}

function later(task: LlmTextTask): Promise<Outcome> {
  return new Promise(resolve => setTimeout(() => resolve(translate(task)), 0));
}

function logged(): string[] {
  const lines = (method: 'warn' | 'log' | 'info') => vi.mocked(console[method]).mock.calls.map(args => args.join(' '));
  return [...lines('warn'), ...lines('log'), ...lines('info')];
}

function job(list: VttCue[], onLines = vi.fn<(indices: number[], texts: string[]) => void>(), position = () => 0): SubtitleTranslation {
  return new SubtitleTranslation(list, 'de', position, onLines);
}

beforeEach(() => {
  runText.mockReset();
  vi.useRealTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('planBatches', () => {
  it('splits by line count and keeps the same batches for the same cues', () => {
    const list = cues(100);
    const batches = planBatches(list, 16000);
    expect(batches.map(batch => batch.length)).toEqual([40, 40, 20]);
    expect(planBatches(list, 16000)).toEqual(batches);
    // A larger context still sends at most 40 lines a batch.
    expect(planBatches(list, 128000)).toEqual(batches);
    expect(planBatches(cues(100, () => '字'.repeat(80)), 128000).map(batch => batch.length)).toEqual([40, 40, 20]);
  });

  it('starts a new batch when the context budget runs out', () => {
    // Budget (1400 - 600) / 4 = 200; each line costs 64.
    const batches = planBatches(cues(9, () => '字'.repeat(60)), 1400);
    expect(batches.map(batch => batch.length)).toEqual([3, 3, 3]);
  });
});

describe('replyTokens', () => {
  it('leaves room for the reply within a small context', () => {
    expect(replyTokens(800, 4096)).toBe(2400);
    expect(replyTokens(874, 4096)).toBe(2622);
    expect(replyTokens(100, 16000)).toBe(2048);
    expect(replyTokens(3000, 3500)).toBe(256);
  });
});

describe('batchOrder', () => {
  it('starts at the playback position, then fills in the lines before it', () => {
    const list = cues(100);
    const batches = planBatches(list, 2000);
    const order = batchOrder(batches, list, list[50].start);
    const first = batches.findIndex(batch => batch.indexOf(50) >= 0);
    expect(order[0]).toBe(first);
    expect(order.slice().sort((a, b) => a - b)).toEqual(batches.map((_, i) => i));
    expect(order[batches.length - first]).toBe(first - 1);
  });

  it('starts at the last batch past the end', () => {
    const list = cues(50);
    expect(batchOrder(planBatches(list, 16000), list, 1e6)).toEqual([1, 0]);
  });
});

describe('needsTranslation', () => {
  it('compares base languages, Chinese scripts, and offers an unknown one', () => {
    expect(needsTranslation('ger', 'de')).toBe(false);
    expect(needsTranslation('en', 'de')).toBe(true);
    expect(needsTranslation('', 'de')).toBe(true);
    expect(needsTranslation('zh-TW', 'zh-CN')).toBe(true);
    expect(needsTranslation('zh-Hans', 'zh-CN')).toBe(false);
    expect(needsTranslation('zh', 'zh-CN')).toBe(false);
  });
});

describe('sameTarget', () => {
  it('treats regional variants as one language, but not the Chinese scripts', () => {
    expect(sameTarget('pt', 'pt-BR')).toBe(true);
    expect(sameTarget('zh-CN', 'zh-TW')).toBe(false);
  });
});

describe('targetCode', () => {
  it('tags a target by its base language, and Chinese by its script', () => {
    expect(targetCode('de')).toBe('DE');
    expect(targetCode('pt-BR')).toBe('PT');
    expect(targetCode('zh-CN')).toBe('简中');
    expect(targetCode('zh-TW')).toBe('繁中');
    expect(targetCode('zh-Hant')).toBe('繁中');
  });
});

describe('formatLines / parseLines', () => {
  it('numbers lines, carries line breaks as <br>, and reads them back', () => {
    expect(formatLines(['Alpha', 'Bravo\nCharlie'])).toBe('[1] Alpha\n[2] Bravo<br>Charlie');
    expect(parseLines('```\n[1] A\n[2] B <br/> C\n```', 2)).toEqual(new Map([[1, 'A'], [2, 'B\nC']]));
  });

  it('keeps the first of a repeated number and drops numbers out of range or empty', () => {
    const reply = 'Sure:\n[1] A\n[1] B\n[3] ignored\n[2]  \n';
    expect(parseLines(reply, 2)).toEqual(new Map([[1, 'A']]));
  });

  it('reads full-width brackets and a colon after the number', () => {
    expect(parseLines('【1】甲\n［2］：乙\n[3]: 丙', 3)).toEqual(new Map([[1, '甲'], [2, '乙'], [3, '丙']]));
  });

  it('joins an unnumbered line to the one above', () => {
    expect(parseLines('[1] A\nmore\n[2] B', 2)).toEqual(new Map([[1, 'A\nmore'], [2, 'B']]));
  });
});

describe('SubtitleTranslation', () => {
  it('sends only numbered cue text and applies the translated lines', async () => {
    runText.mockImplementation(translate);
    const onLines = vi.fn<(indices: number[], texts: string[]) => void>();
    const translation = job(cues(3), onLines);

    expect(await translation.start()).toEqual({ error: null });

    const task = runText.mock.calls[0][0] as LlmTextTask;
    expect(task.user).toBe('[1] Line 0\n[2] Line 1\n[3] Line 2');
    expect(task.system).toContain('German');
    expect(task.priority).toBe('foreground');
    expect(task.finishStarted).toBe(true);
    expect(task.accept?.('[1] A\n[2] B')).toBe(true);
    expect(task.accept?.('[1] A')).toBe(false);
    expect(onLines).toHaveBeenCalledWith([0, 1, 2], ['Line 0 (l2)', 'Line 1 (l2)', 'Line 2 (l2)']);
    expect(translation.complete).toBe(true);
    expect(translation.percent).toBe(100);
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.start target=de lines=3 batches=1 remaining=1 resume=false/);
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.done done=3 kept=0 cached=0 requested=1 total=3/);
  });

  it('keeps the original for lines missing from a usable reply', async () => {
    runText.mockResolvedValueOnce({ text: '[1] A\n[2] B', cached: true });
    const onLines = vi.fn<(indices: number[], texts: string[]) => void>();
    const translation = job(cues(3), onLines);

    expect(await translation.start()).toEqual({ error: null });

    expect(onLines).toHaveBeenCalledWith([0, 1], ['A', 'B']);
    expect(translation.complete).toBe(true);
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.incomplete reason=lines_kept failed_batches=0 done=2 kept=1 cached=1 requested=0 total=3/);
  });

  it('stops when the first replies are unusable and retries them on the next start', async () => {
    runText.mockResolvedValue({ text: 'I cannot help with that.', cached: false });
    const onLines = vi.fn<(indices: number[], texts: string[]) => void>();
    const translation = job(cues(200), onLines);

    expect((await translation.start()).error?.reason).toBe('schema');
    expect(onLines).not.toHaveBeenCalled();
    expect(translation.percent).toBe(0);
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.incomplete reason=schema failed_batches=\d+ done=0/);

    runText.mockReset();
    runText.mockImplementation(translate);
    expect(await translation.start()).toEqual({ error: null });
    expect(translation.complete).toBe(true);
  });

  it('retries a rate-limited batch after the server’s wait', async () => {
    vi.useFakeTimers();
    runText
      .mockRejectedValueOnce(new LlmError('quota', 'HTTP 429', 429, 5000))
      .mockImplementation(translate);
    const translation = job(cues(3));

    const pending = translation.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(runText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ error: null });
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.retry reason=quota status=429 attempt=1 wait_ms=5000/);
  });

  it('stops after the retries run out, and at once on a daily cap', async () => {
    vi.useFakeTimers();
    runText.mockRejectedValue(new LlmError('http', 'HTTP 503', 503));
    const translation = job(cues(3));

    const pending = translation.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect((await pending).error?.status).toBe(503);
    expect(runText).toHaveBeenCalledTimes(3);

    runText.mockReset();
    runText.mockRejectedValue(new LlmError('cap', 'Daily cap reached'));
    expect((await translation.start()).error?.reason).toBe('cap');
    expect(runText).toHaveBeenCalledTimes(1);
  });

  it('ends a failed run at once instead of waiting out another batch’s retry', async () => {
    vi.useFakeTimers();
    runText
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new LlmError('auth', 'HTTP 401', 401)), 10)))
      .mockRejectedValueOnce(new LlmError('quota', 'HTTP 429', 429, 60000))
      .mockImplementation(translate);
    const translation = job(cues(200));

    const pending = translation.start();
    await vi.advanceTimersByTimeAsync(100);

    expect((await pending).error?.reason).toBe('auth');
    expect(runText).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when a batch sent before a stop fails afterwards', async () => {
    const replies: Array<() => void> = [];
    runText.mockImplementation(() => new Promise<Outcome>((_, reject) => {
      replies.push(() => reject(new LlmError('http', 'HTTP 503', 503)));
    }));
    const translation = job(cues(200));

    const pending = translation.start();
    await vi.waitFor(() => expect(runText).toHaveBeenCalledTimes(2));
    translation.stop();
    expect((await pending).error?.reason).toBe('cancelled');
    replies.forEach(reply => reply());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(logged().join('\n')).not.toMatch(/translate\.incomplete|translate\.done/);
    // The late failures leave nothing behind: the next run starts clean and finishes.
    runText.mockReset();
    runText.mockImplementation(translate);
    expect(await translation.start()).toEqual({ error: null });
    expect(translation.complete).toBe(true);
  });

  it('reports a failure at once while another sent batch is still out', async () => {
    runText
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockRejectedValueOnce(new LlmError('http', 'HTTP 400', 400));
    const translation = job(cues(200));

    expect((await translation.start()).error?.status).toBe(400);
    expect(translation.running).toBe(false);
  });

  it('resumes after a stop only once the sent batches are in, without asking for them again', async () => {
    const replies: Array<() => void> = [];
    runText.mockImplementation((task: LlmTextTask) => new Promise<Outcome>((resolve) => {
      replies.push(() => resolve(translate(task)));
    }));
    const translation = job(cues(200));
    const first = translation.start();
    await vi.waitFor(() => expect(runText).toHaveBeenCalledTimes(2));
    translation.stop();
    expect((await first).error?.reason).toBe('cancelled');

    runText.mockImplementation(translate);
    const second = translation.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runText).toHaveBeenCalledTimes(2);

    replies.forEach(reply => reply());
    expect(await second).toEqual({ error: null });
    expect(runText).toHaveBeenCalledTimes(5);
    expect(translation.complete).toBe(true);
  });

  it('neither sends nor keeps a blank cue', async () => {
    runText.mockImplementation(translate);
    const onLines = vi.fn<(indices: number[], texts: string[]) => void>();
    const translation = job(cues(3, i => (i === 1 ? ' ' : `Line ${i}`)), onLines);

    expect(await translation.start()).toEqual({ error: null });

    expect((runText.mock.calls[0][0] as LlmTextTask).user).toBe('[1] Line 0\n[2] Line 2');
    expect(onLines).toHaveBeenCalledWith([0, 2], ['Line 0 (l2)', 'Line 2 (l2)']);
    expect(translation.percent).toBe(100);
    expect(logged().join('\n')).toMatch(/event=subtitle\.translate\.done done=3 kept=0/);
  });

  it('takes the batch at the current position next, so a seek is translated first', async () => {
    let position = 0;
    const list = cues(200);
    const order: string[] = [];
    runText.mockImplementation((task: LlmTextTask) => {
      order.push(inputLines(task)[0]);
      if (order.length === 1) position = list[170].start;
      return later(task);
    });
    const translation = job(list, undefined, () => position);

    await translation.start();

    // The second worker already reads the new position; then the batches before it follow.
    expect(order.slice(0, 3)).toEqual(['Line 0', 'Line 160', 'Line 120']);
  });

  it('lets sent batches finish after a stop, and reports the stop as cancelled', async () => {
    const replies: Array<() => void> = [];
    runText.mockImplementation((task: LlmTextTask) => new Promise<Outcome>((resolve) => {
      replies.push(() => resolve(translate(task)));
    }));
    const onLines = vi.fn<(indices: number[], texts: string[]) => void>();
    const translation = job(cues(200), onLines);

    const pending = translation.start();
    expect(translation.start()).toBe(pending);
    await vi.waitFor(() => expect(runText).toHaveBeenCalledTimes(2));
    translation.stop();
    expect(translation.running).toBe(false);
    replies.forEach(reply => reply());

    expect((await pending).error?.reason).toBe('cancelled');
    expect(runText).toHaveBeenCalledTimes(2);
    expect(onLines).toHaveBeenCalledTimes(2);
    expect(logged().join('\n')).not.toMatch(/incomplete|translate\.done/);
  });
});
