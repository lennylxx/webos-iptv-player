import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../types';

const { translate, batch, isReady, protects, showToast, llmConfig } = vi.hoisted(() => {
  // One item's translation, as the tests set it; the batch answers each item with it.
  const translate = vi.fn();
  return {
    llmConfig: { baseUrl: 'http://host/v1', model: 'm1' },
    translate,
    batch: vi.fn((items: unknown[], target: string, signal: AbortSignal) => Promise.all(items.map(item =>
      Promise.resolve(translate(item, target, signal)).then(text => ({ text }), (error: unknown) => ({ error }))))),
  isReady: vi.fn(() => true),
    protects: vi.fn((_request: { target: string }) => false),
    showToast: vi.fn(),
  };
});
vi.mock('../services/epg-translation', () => ({ EPG_TRANSLATION_FEATURE: 'epg-translation', translatePrograms: batch }));
vi.mock('../services/llm/llm-service', () => ({ LlmService: { isReady } }));
vi.mock('../services/parental-control', () => ({
  ParentalControlService: { protects },
  liveParentalRequest: (channel: Channel) => ({ target: channel.url, parents: [] }),
}));
vi.mock('./toast', () => ({ showToast }));
vi.mock('../services/storage-service', () => ({ StorageService: { getLlmConfig: () => llmConfig } }));

import { LlmError } from '../services/llm/client';
import {
  ProgramTranslation,
  programDescription,
  programTitleLabel,
  MAX_REMEMBERED_TRANSLATIONS,
  programView,
  liveSource,
  resetProgramTranslationForTests,
  TRANSLATION_DWELL_MS,
} from './program-translation';

const ch1 = { name: 'ch1', url: 'http://host/a' } as Channel;
const live1 = liveSource(ch1);
const alpha = { title: 'Program Alpha', description: 'An episode.' };
const bravo = { title: 'Program Bravo', description: '' };
const owner = {};

async function dwell(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  translate.mockReset();
  batch.mockClear();
  isReady.mockReturnValue(true);
  protects.mockReturnValue(false);
  showToast.mockReset();
  llmConfig.model = 'm1';
});

afterEach(() => {
  resetProgramTranslationForTests();
  vi.useRealTimers();
});

describe('ProgramTranslation', () => {
  it('sends nothing until Green turns it on', async () => {
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).not.toHaveBeenCalled();
    expect(programView(live1, alpha)).toEqual({ ...alpha, label: '', ai: false });
  });

  it('translates the program the focus rests on and labels it', async () => {
    translate.mockResolvedValue({ title: 'Programm Alpha', description: 'Eine Folge.' });
    const changed = vi.fn();
    ProgramTranslation.subscribe(changed);
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS - 1);
    expect(translate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(translate).toHaveBeenCalledWith(alpha, 'en', expect.anything());
    expect(programView(live1, alpha)).toEqual({ title: 'Programm Alpha', description: 'Eine Folge.', label: 'AI translation', ai: true });
    expect(changed).toHaveBeenCalled();

    ProgramTranslation.toggle();
    expect(programView(live1, alpha)).toEqual({ ...alpha, label: '', ai: false });
  });

  it('sends nothing for a program the focus only passes over', async () => {
    translate.mockResolvedValue(alpha);
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    ProgramTranslation.want(owner, live1, bravo);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toEqual(bravo);
  });

  it('shows progress while a translation is on its way', async () => {
    let resolve!: (text: typeof alpha) => void;
    translate.mockReturnValue(new Promise((done) => { resolve = done; }));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha).label).toBe('Translating…');
    resolve({ title: 'Programm Alpha', description: 'Eine Folge.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(programView(live1, alpha).label).toBe('AI translation');
  });

  it('shows text already in the UI language unlabeled', async () => {
    translate.mockResolvedValue({ title: 'Program  Alpha', description: 'An episode. ' });
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha)).toEqual({ ...alpha, label: '', ai: false });
  });

  it('never sends a program of a channel a parental rule guards', async () => {
    protects.mockReturnValue(true);
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).not.toHaveBeenCalled();
    expect(ProgramTranslation.available(live1)).toBe(false);
  });

  it('is unavailable without AI set up', () => {
    isReady.mockReturnValue(false);
    expect(ProgramTranslation.available(live1)).toBe(false);
  });

  it('marks a failure and asks again only once translation is turned on again', async () => {
    translate.mockRejectedValueOnce(new LlmError('network', 'offline'));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha).label).toBe('Translation failed');
    expect(ProgramTranslation.active).toBe(true);

    translate.mockResolvedValue({ title: 'Programm Alpha', description: 'Eine Folge.' });
    ProgramTranslation.want(owner, live1, null);
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(programView(live1, alpha).label).toBe('Translation failed');

    ProgramTranslation.toggle();
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(programView(live1, alpha).label).toBe('AI translation');
  });

  it('turns off at the daily AI limit and says so', async () => {
    translate.mockRejectedValue(new LlmError('cap', 'Daily cap reached'));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(ProgramTranslation.active).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Daily AI limit reached. Translation paused.');
  });

  it('turns off when the AI setup is wrong and says so', async () => {
    translate.mockRejectedValue(new LlmError('auth', 'Invalid API key'));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(ProgramTranslation.active).toBe(false);
    expect(showToast).toHaveBeenCalledWith('AI setup problem. Translation paused.');
  });

  it('sends a program again when the focus came back before its dropped request said so', async () => {
    const dropped: Array<() => void> = [];
    translate.mockImplementationOnce((_text: unknown, _target: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      // The service notices the abort only after its cache read.
      signal.addEventListener('abort', () => dropped.push(() => reject(new LlmError('cancelled', 'Request was cancelled'))));
    }));
    translate.mockResolvedValue({ title: 'Programm Alpha', description: 'Eine Folge.' });
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    ProgramTranslation.want(owner, live1, bravo);
    ProgramTranslation.want(owner, live1, alpha);
    dropped.forEach(reject => reject());
    await vi.advanceTimersByTimeAsync(0);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(programView(live1, alpha).label).toBe('AI translation');
  });

  it('turns off without a word once AI features are switched off', async () => {
    ProgramTranslation.toggle();
    expect(ProgramTranslation.active).toBe(true);
    isReady.mockReturnValue(false);
    await Promise.resolve();
    expect(ProgramTranslation.active).toBe(false);
    expect(showToast).not.toHaveBeenCalled();

    isReady.mockReturnValue(true);
    await Promise.resolve();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).not.toHaveBeenCalled();
  });

  it('stays off when Green is pressed without AI features', async () => {
    isReady.mockReturnValue(false);
    await Promise.resolve();
    ProgramTranslation.toggle();
    expect(ProgramTranslation.active).toBe(false);
  });

  it('reads the AI settings once for a whole list', async () => {
    ProgramTranslation.toggle();
    await Promise.resolve();
    isReady.mockClear();
    for (let i = 0; i < 20; i++) programView(live1, { title: `Program ${i}`, description: '' });
    expect(isReady).toHaveBeenCalledTimes(1);
  });

  it('sends a program once while its translation is on its way', async () => {
    translate.mockReturnValue(new Promise(() => undefined));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    ProgramTranslation.want(owner, live1, bravo);
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once the surface that wanted a program lets it go', async () => {
    translate.mockResolvedValue(alpha);
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    ProgramTranslation.release({});
    ProgramTranslation.release(owner);
    await dwell();
    expect(translate).not.toHaveBeenCalled();
  });

  it('keeps another surface\'s program when one lets go', async () => {
    translate.mockResolvedValue(alpha);
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    ProgramTranslation.release({});
    await dwell();
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('asks again after the AI model changes, showing no earlier result', async () => {
    translate.mockRejectedValueOnce(new LlmError('network', 'offline'));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha).label).toBe('Translation failed');

    llmConfig.model = 'm2';
    // The AI settings are read once per synchronous pass.
    await Promise.resolve();
    expect(programView(live1, alpha).label).toBe('');
    translate.mockResolvedValue({ title: 'Programm Alpha', description: 'Eine Folge.' });
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate).toHaveBeenCalledTimes(2);
    expect(programView(live1, alpha).label).toBe('AI translation');
  });

  it('sends a program again when the focus left it while it still waited in the queue', async () => {
    translate.mockImplementation((_text: unknown, _target: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new LlmError('cancelled', 'Request was cancelled')));
    }));
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha).label).toBe('Translating…');
    ProgramTranslation.want(owner, live1, bravo);
    await vi.advanceTimersByTimeAsync(0);
    expect(programView(live1, alpha).label).toBe('');

    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(translate.mock.calls.map(call => (call[0] as { title: string }).title))
      .toEqual(['Program Alpha', 'Program Alpha']);
  });

  it('asks again at once for a failed translation, showing its progress', async () => {
    translate.mockRejectedValueOnce(new LlmError('network', 'offline'));
    translate.mockResolvedValueOnce({ title: 'Programm Alpha', description: 'Eine Folge.' });
    ProgramTranslation.toggle();
    ProgramTranslation.want(owner, live1, alpha);
    await dwell();
    expect(programView(live1, alpha).label).toBe('Translation failed');

    expect(ProgramTranslation.retry(owner, live1, alpha)).toBe(true);
    expect(programView(live1, alpha).label).toBe('Translating…');
    expect(translate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(programView(live1, alpha).label).toBe('AI translation');
    expect(ProgramTranslation.retry(owner, live1, alpha)).toBe(false);
  });
});

describe('a surface that shows several programs', () => {
  const program = (i: number) => ({ title: `Program ${i}`, description: `Episode ${i}.` });
  const items = (from: number, to: number, source = live1) =>
    Array.from({ length: to - from }, (_, k) => ({ source, text: program(from + k) }));
  const sentTitles = () => batch.mock.calls.map(call => (call[0] as Array<{ title: string }>).map(item => item.title));

  beforeEach(() => {
    translate.mockImplementation(async (text: { title: string; description: string }) =>
      ({ title: text.title.replace('Program', 'Programm'), description: text.description.replace('Episode', 'Folge') }));
    ProgramTranslation.toggle();
  });

  it('sends everything it shows in one request once it settles', async () => {
    ProgramTranslation.show(owner, items(0, 5));
    await dwell();
    expect(sentTitles()).toEqual([['Program 0', 'Program 1', 'Program 2', 'Program 3', 'Program 4']]);
    expect(programView(live1, program(3))).toEqual({ title: 'Programm 3', description: 'Folge 3.', label: 'AI translation', ai: true });
  });

  it('sends nothing while it scrolls, then only what it shows once it rests', async () => {
    for (let step = 0; step < 6; step++) {
      ProgramTranslation.show(owner, items(step, step + 4));
      await vi.advanceTimersByTimeAsync(TRANSLATION_DWELL_MS / 2);
    }
    expect(batch).not.toHaveBeenCalled();
    await dwell();
    expect(sentTitles()).toEqual([['Program 5', 'Program 6', 'Program 7', 'Program 8']]);
  });

  it('sends only what has no translation yet or on its way, so a scroll asks for the new rows alone', async () => {
    ProgramTranslation.show(owner, items(0, 4));
    await dwell();
    ProgramTranslation.show(owner, items(2, 6));
    await dwell();
    expect(sentTitles()).toEqual([['Program 0', 'Program 1', 'Program 2', 'Program 3'], ['Program 4', 'Program 5']]);

    // A program another surface already sent goes out once, even while its answer is still on its way.
    translate.mockReturnValue(new Promise(() => undefined));
    const other = {};
    ProgramTranslation.show(owner, items(6, 8));
    await dwell();
    ProgramTranslation.show(other, items(7, 9));
    await dwell();
    expect(sentTitles().slice(2)).toEqual([['Program 6', 'Program 7'], ['Program 8']]);
  });

  it('asks again for nothing it shows once it shows the same programs again', async () => {
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('never sends the programs of a channel a parental rule guards', async () => {
    const ch2 = { name: 'ch2', url: 'http://host/b' } as Channel;
    protects.mockImplementation(request => request.target === ch2.url);
    ProgramTranslation.show(owner, [...items(0, 2), ...items(5, 7, liveSource(ch2))]);
    await dwell();
    expect(sentTitles()).toEqual([['Program 0', 'Program 1']]);
  });

  it('sends nothing once it no longer shows, and drops a request still waiting in the queue', async () => {
    ProgramTranslation.show(owner, items(0, 3));
    ProgramTranslation.release(owner);
    await dwell();
    expect(batch).not.toHaveBeenCalled();

    translate.mockImplementation((_text: unknown, _target: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new LlmError('cancelled', 'Request was cancelled')));
    }));
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    expect(programView(live1, program(1)).label).toBe('Translating…');
    ProgramTranslation.release(owner);
    await vi.advanceTimersByTimeAsync(0);
    expect(programView(live1, program(1)).label).toBe('');
  });

  it('keeps a request waiting in the queue while it shows some of its programs, and sends only the new ones', async () => {
    const aborted = vi.fn();
    translate.mockImplementation((_text: unknown, _target: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted();
        reject(new LlmError('cancelled', 'Request was cancelled'));
      });
    }));
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    ProgramTranslation.show(owner, items(1, 4));
    await dwell();
    expect(aborted).not.toHaveBeenCalled();
    expect(sentTitles()).toEqual([['Program 0', 'Program 1', 'Program 2'], ['Program 3']]);

    ProgramTranslation.show(owner, items(5, 6));
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toHaveBeenCalledTimes(4);
  });

  it('sends at once what another settled surface shows when the surface that sent it lets go while it waits in the queue', async () => {
    translate.mockImplementation((_text: unknown, _target: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new LlmError('cancelled', 'Request was cancelled')));
    }));
    const other = {};
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    ProgramTranslation.show(other, items(1, 4));
    await dwell();
    expect(sentTitles()).toEqual([['Program 0', 'Program 1', 'Program 2'], ['Program 3']]);

    translate.mockImplementation(async (text: { title: string; description: string }) =>
      ({ title: text.title.replace('Program', 'Programm'), description: text.description }));
    ProgramTranslation.release(owner);
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTitles()[2]).toEqual(['Program 1', 'Program 2']);
    expect(programView(live1, program(2)).title).toBe('Programm 2');
  });

  it('marks each program of a failed request failed, and sends only the new ones when the surface moves', async () => {
    translate.mockRejectedValueOnce(new LlmError('network', 'offline'));
    translate.mockRejectedValueOnce(new LlmError('network', 'offline'));
    ProgramTranslation.show(owner, items(0, 2));
    await dwell();
    expect(programView(live1, program(0)).label).toBe('Translation failed');
    expect(programView(live1, program(1)).label).toBe('Translation failed');
    ProgramTranslation.show(owner, items(0, 3));
    await dwell();
    expect(sentTitles()[1]).toEqual(['Program 2']);
    ProgramTranslation.show(owner, items(0, 2));
    await dwell();
    expect(sentTitles()).toHaveLength(2);
  });
});

describe('program labels', () => {
  it('puts the label of a program without a description in its title line', () => {
    const view = { title: 'Program Bravo', description: '', label: 'Translating…', ai: false };
    expect(programDescription('desc', view)).toBe('');
    expect(String(programTitleLabel(view))).toContain('Translating…');
    expect(String(programTitleLabel(view))).not.toContain('ai-icon');
    expect(String(programTitleLabel({ ...view, label: 'AI translation', ai: true })))
      .toContain('<span class="ai-icon"><svg');
  });

  it('leads the description with the label', () => {
    const view = { title: 'Program Alpha', description: 'An episode.', label: 'AI translation', ai: true };
    expect(String(programTitleLabel(view))).toBe('');
    expect(String(programDescription('desc', view)))
      .toMatch(/<span class="program-translation-label"><span class="ai-icon"><svg.*<\/span>AI translation · <\/span>An episode\./);
  });
});

describe('remembered translations', () => {
  const program = (i: number) => ({ title: `Program ${i}`, description: '' });
  const label = (i: number) => programView(live1, program(i)).label;

  async function translateRange(from: number, to: number): Promise<void> {
    for (let i = from; i < to; i++) {
      ProgramTranslation.want(owner, live1, program(i));
      await dwell();
    }
  }

  beforeEach(() => {
    translate.mockImplementation(async (text: { title: string }) => ({ title: `Programm ${text.title}`, description: '' }));
    ProgramTranslation.toggle();
  });

  it('keeps no more than the cap, dropping the oldest', async () => {
    await translateRange(0, MAX_REMEMBERED_TRANSLATIONS + 1);
    expect(label(0)).toBe('');
    expect(label(1)).toBe('AI translation');
    expect(label(MAX_REMEMBERED_TRANSLATIONS)).toBe('AI translation');
  });

  it('keeps a translation shown again lately', async () => {
    await translateRange(0, MAX_REMEMBERED_TRANSLATIONS);
    expect(label(0)).toBe('AI translation');
    await translateRange(MAX_REMEMBERED_TRANSLATIONS, MAX_REMEMBERED_TRANSLATIONS + 1);
    expect(label(0)).toBe('AI translation');
    expect(label(1)).toBe('');
  });

  it('never drops a translation still on its way', async () => {
    translate.mockImplementationOnce(() => new Promise(() => undefined));
    await translateRange(0, MAX_REMEMBERED_TRANSLATIONS + 5);
    expect(label(0)).toBe('Translating…');
  });
});
