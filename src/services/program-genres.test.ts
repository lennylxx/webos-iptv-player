import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Programme } from '../types';

const state = vi.hoisted(() => ({
  channels: [] as Array<{ id: string }>,
  // Channels the user hid, which edit mode or "show hidden" lists too.
  hidden: [] as Array<{ id: string }>,
  guide: {} as Record<string, unknown[]>,
  protectedIds: [] as string[],
  parentalOn: false,
  config: { enabled: true, features: { 'program-genres': true } as Record<string, boolean> },
  store: new Map<string, unknown>(),
  writes: 0,
  // While set, a write lands at once but its promise waits for the test.
  heldWrites: null as Array<() => void> | null,
  guideRevision: 0,
  rulesRevision: 0,
  approved: [] as string[],
  showHidden: false,
  // The unconcealed list as the real service keeps it: one array until the channels change.
  shown: null as { channels: unknown[]; hidden: unknown[]; list: unknown[] } | null,
  run: vi.fn(),
}));

vi.mock('./epg-service', () => ({
  EpgService: {
    get guideRevision() { return state.guideRevision; },
    mappingRevision: 0,
    findChannelId: (channel: { id: string }) => channel.id,
    getProgrammes: (id: string) => state.guide[id] ?? null,
  },
}));
vi.mock('./playlist-service', () => ({
  PlaylistService: {
    // Hidden channels show while "show hidden" or edit mode is on; the guide's list never has them.
    getUnconcealedChannels: () => {
      if (!state.showHidden) return state.channels;
      const shown = state.shown;
      if (shown && shown.channels === state.channels && shown.hidden === state.hidden) return shown.list;
      const list = state.channels.concat(state.hidden);
      state.shown = { channels: state.channels, hidden: state.hidden, list };
      return list;
    },
    getEpgEligibleChannels: () => (state.showHidden ? state.channels.slice() : state.channels),
  },
}));
vi.mock('./parental-control', () => ({
  ParentalControlService: {
    get enabled() { return state.parentalOn; },
    get rulesRevision() { return state.rulesRevision; },
    get approvedSources() { return state.approved; },
    protects: (request: { id: string }) => state.protectedIds.indexOf(request.id) >= 0,
  },
  liveParentalRequest: (channel: { id: string }) => ({ id: channel.id }),
}));
vi.mock('./storage-service', () => ({
  StorageService: { getLlmConfig: () => state.config, getShowHiddenChannels: () => state.showHidden },
}));
vi.mock('./idb-cache', () => ({
  getCachedLlmResult: (key: string) => Promise.resolve(state.store.get(key)),
  setCachedLlmResult: (key: string, value: unknown) => {
    state.writes++;
    state.store.set(key, JSON.parse(JSON.stringify(value)));
    const held = state.heldWrites;
    return held ? new Promise<void>((resolve) => { held.push(resolve); }) : Promise.resolve();
  },
}));
vi.mock('./llm/llm-service', () => ({
  LlmService: {
    run: state.run,
    isReady: () => state.config.enabled && state.config.features['program-genres'] === true,
    contextTokens: () => 16000,
  },
}));
vi.mock('../utils/frame-slices', () => ({
  runInFrameSlices: (step: () => boolean, options: { shouldContinue?: () => boolean } = {}) => {
    for (;;) {
      if (options.shouldContinue && !options.shouldContinue()) return Promise.resolve(false);
      if (step()) return Promise.resolve(true);
    }
  },
}));

import { LlmError } from './llm/client';
import { LlmService } from './llm/llm-service';
import { CONFIG } from '../config';
import {
  ProgramGenres,
  programGenre,
  programGenreName,
  resetProgramGenresForTests,
  titleKey,
} from './program-genres';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 10, 12);

const programme = (title: string, startHours: number, category = '', description = ''): Programme => ({
  title, description, category, icon: '',
  start: new Date(NOW + startHours * HOUR), stop: new Date(NOW + (startHours + 1) * HOUR),
});

interface Sent { items: Array<{ i: number; t: string }> }
// A request held open until the test settles it.
function holdRequest(): { resolve: () => void; reject: (error: unknown) => void } {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  state.run.mockImplementationOnce((task: { user: string }) => new Promise((res, rej) => {
    const sent = JSON.parse(task.user) as Sent;
    resolve = () => res({ value: { items: sent.items.map(item => ({ i: item.i, g: 'sports' })) }, dropped: 0, cached: false });
    reject = rej;
  }));
  return { resolve: () => resolve(undefined), reject: (error) => reject(error) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

const sentTitles = (): string[][] => state.run.mock.calls.map(call =>
  (JSON.parse((call[0] as { user: string }).user) as Sent).items.map(item => item.t));

// Answers every item with the genre its title names after a colon, else none.
function answerByTitle(): void {
  state.run.mockImplementation((task: { user: string }) => {
    const sent = JSON.parse(task.user) as Sent;
    return Promise.resolve({
      value: { items: sent.items.map(item => ({ i: item.i, g: /: (\w+)$/.exec(item.t)?.[1] ?? 'none' })) },
      dropped: 0,
      cached: false,
    });
  });
}

let lines: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  resetProgramGenresForTests();
  state.run.mockReset();
  state.store.clear();
  state.parentalOn = false;
  state.protectedIds = [];
  state.config = { enabled: true, features: { 'program-genres': true } };
  state.channels = [{ id: 'ch1' }, { id: 'ch2' }] as Channel[];
  state.hidden = [];
  state.writes = 0;
  state.heldWrites = null;
  state.guideRevision = 0;
  state.rulesRevision = 0;
  state.approved = [];
  state.showHidden = false;
  state.shown = null;
  state.guide = {
    ch1: [
      programme('Old: news', -3),
      programme('Alpha: sports', 1, '', 'A match.'),
      programme('Bravo: news', 2, 'Genre B'),
      programme('Late: music', 30),
    ],
    ch2: [programme('alpha:  SPORTS', 3), programme('Charlie', 4)],
  };
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  ProgramGenres.sync();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('titleKey', () => {
  it('folds case, spacing, and punctuation so repeats match', () => {
    expect(titleKey('  Alpha:  SPORTS! ')).toBe(titleKey('alpha - sports'));
    expect(titleKey('…')).toBe('…');
  });
});

describe('ProgramGenres', () => {
  it('sends each title once, only for programs in the next 24 hours without a category', async () => {
    answerByTitle();
    expect(await ProgramGenres.estimate()).toEqual({ programs: 3, requests: 1 });
    await ProgramGenres.run();
    expect(sentTitles()).toEqual([['Alpha: sports', 'Charlie']]);
    const [alpha, bravo] = [state.guide.ch1[1], state.guide.ch1[2]] as Programme[];
    expect(programGenre(alpha)).toBe('sports');
    expect(programGenre(state.guide.ch2[0] as Programme)).toBe('sports');
    expect(programGenreName(alpha)).toBe('Sports');
    // The guide's category always wins.
    expect(programGenre(bravo)).toBeNull();
    expect(programGenreName(bravo)).toBe('Genre B');
    expect(programGenre(state.guide.ch2[1] as Programme)).toBeNull();
    expect(ProgramGenres.statusText()).toBe('Programs with an AI genre: 2');
    expect(lines.some(line => line.includes('event=genre.ai.run') && line.includes('programs=3')
      && line.includes('titles=2') && line.includes('classified=1') && line.includes('reason=none'))).toBe(true);
  });

  it('skips the channels parental controls protect', async () => {
    answerByTitle();
    state.parentalOn = true;
    state.protectedIds = ['ch2'];
    await ProgramGenres.run();
    expect(sentTitles()).toEqual([['Alpha: sports']]);
  });

  it('keeps what it learned across a reload and sends only new titles', async () => {
    answerByTitle();
    await ProgramGenres.run();
    resetProgramGenresForTests();
    ProgramGenres.sync();
    state.guide.ch2.push(programme('Delta: kids', 5));
    state.run.mockClear();
    expect(await ProgramGenres.estimate()).toEqual({ programs: 1, requests: 1 });
    await ProgramGenres.run();
    expect(sentTitles()).toEqual([['Delta: kids']]);
    expect(programGenre(state.guide.ch1[1] as Programme)).toBe('sports');
  });

  it('stops at the daily limit, keeping finished batches, and says so', async () => {
    state.run.mockRejectedValue(new LlmError('cap', 'Daily cap reached'));
    await ProgramGenres.run();
    expect(ProgramGenres.status).toEqual({ state: 'limit' });
    expect(ProgramGenres.statusText()).toBe('Daily AI limit reached.');
    expect(programGenre(state.guide.ch1[1] as Programme)).toBeNull();
    state.run.mockRejectedValue(new LlmError('network', 'Down'));
    await ProgramGenres.run();
    expect(ProgramGenres.statusText()).toBe('AI unavailable.');
  });

  it('shows no genre and sends nothing while the toggle is off', async () => {
    answerByTitle();
    await ProgramGenres.run();
    state.config = { enabled: true, features: {} };
    ProgramGenres.sync();
    expect(programGenre(state.guide.ch1[1] as Programme)).toBeNull();
    state.run.mockClear();
    ProgramGenres.schedule(0);
    await vi.runAllTimersAsync();
    expect(state.run).not.toHaveBeenCalled();
  });

  it('forgets every genre on reset, as clearing the cache does', async () => {
    answerByTitle();
    await ProgramGenres.run();
    state.store.clear();
    ProgramGenres.reset();
    await ProgramGenres.estimate();
    expect(programGenre(state.guide.ch1[1] as Programme)).toBeNull();
  });

  it('runs one job at a time, however often it is asked, and sends a new title once', async () => {
    answerByTitle();
    const first = holdRequest();
    const a = ProgramGenres.run();
    await flush();
    const b = ProgramGenres.run();
    const c = ProgramGenres.run();
    state.guide.ch2.push(programme('Delta: kids', 5));
    first.resolve();
    await Promise.all([a, b, c]);
    expect(sentTitles()).toEqual([['Alpha: sports', 'Charlie'], ['Delta: kids']]);
  });

  it('shows no failure when turned off while runs wait on each other', async () => {
    const first = holdRequest();
    const a = ProgramGenres.run();
    await flush();
    const b = ProgramGenres.run();
    const c = ProgramGenres.run();
    state.guide.ch2.push(programme('Delta: kids', 5));
    const second = holdRequest();
    const third = holdRequest();
    first.resolve();
    await flush();
    state.config = { enabled: true, features: {} };
    ProgramGenres.sync();
    second.reject(new LlmError('network', 'Down'));
    third.reject(new LlmError('network', 'Down'));
    await Promise.all([a, b, c]);
    expect(ProgramGenres.statusText()).toBe('');
  });

  it('keeps no genre from a batch that finishes after a reset', async () => {
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    ProgramGenres.cancel();
    state.store.clear();
    ProgramGenres.reset();
    held.resolve();
    await run;
    await flush();
    expect(programGenre(state.guide.ch1[1] as Programme)).toBeNull();
    expect(JSON.stringify(Array.from(state.store.values()))).not.toContain('sports');
  });

  it('writes nothing back once cleared while a write and a second one wait', async () => {
    answerByTitle();
    state.heldWrites = [];
    state.guide.ch2 = Array.from({ length: 1300 }, (_, i) => programme(`Show ${String(1000 + i)}: sports`, 3 + i / 100));
    await ProgramGenres.run();
    expect(state.heldWrites).toHaveLength(1);
    ProgramGenres.cancel();
    state.store.clear();
    state.heldWrites.forEach(release => release());
    await flush();
    expect(state.writes).toBe(1);
    expect(state.store.size).toBe(0);
  });

  it('runs a rerun asked for right after a cancel', async () => {
    answerByTitle();
    const held = holdRequest();
    const first = ProgramGenres.run();
    await flush();
    ProgramGenres.cancel();
    const second = ProgramGenres.run();
    held.resolve();
    await Promise.all([first, second]);
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(programGenre(state.guide.ch1[1] as Programme)).toBe('sports');
  });

  it('stops sending a hidden channel\'s titles and starts over with what is left', async () => {
    answerByTitle();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const first = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    state.channels = [{ id: 'ch1' }] as Channel[];
    ProgramGenres.schedule(1000);
    first.resolve();
    await run;
    await vi.runAllTimersAsync();
    expect(sentTitles().slice(1)).toEqual([['Alpha: sports']]);
  });

  it('restarts at once on a run asked for after the guide changed', async () => {
    answerByTitle();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const first = holdRequest();
    const a = ProgramGenres.run();
    await flush();
    state.guide.ch2 = [programme('Delta: kids', 5)];
    state.guideRevision++;
    const b = ProgramGenres.run();
    first.resolve();
    await Promise.all([a, b]);
    expect(sentTitles().slice(1)).toEqual([['Delta: kids']]);
  });

  it('lets the request out finish when the guide reloads, then sends only what is new', async () => {
    answerByTitle();
    const first = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    const signal = (state.run.mock.calls[0][0] as { signal: AbortSignal }).signal;
    state.guide.ch2.push(programme('Delta: kids', 5));
    state.guideRevision++;
    ProgramGenres.schedule(1000);
    expect(signal.aborted).toBe(false);
    first.resolve();
    await run;
    await vi.runAllTimersAsync();
    expect(sentTitles()).toEqual([['Alpha: sports', 'Charlie'], ['Delta: kids']]);
    expect(programGenre(state.guide.ch2[1] as Programme)).toBe('sports');
  });

  it('never sends or counts the programs of channels the user hid, even while they show', async () => {
    answerByTitle();
    state.showHidden = true;
    state.hidden = [{ id: 'ch3' }] as Channel[];
    state.guide.ch3 = [programme('Hidden: news', 1)];
    expect(await ProgramGenres.estimate()).toEqual({ programs: 3, requests: 1 });
    await ProgramGenres.run();
    expect(sentTitles()).toEqual([['Alpha: sports', 'Charlie']]);
  });

  it('sends no later batch of a channel locked mid-run, and runs again without it', async () => {
    answerByTitle();
    state.parentalOn = true;
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const first = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    state.protectedIds = ['ch2'];
    state.rulesRevision++;
    first.resolve();
    await run;
    expect(sentTitles().slice(1)).toEqual([]);
    expect(programGenre(state.guide.ch1[1] as Programme)).toBe('sports');
  });

  it('sends no later batch of a channel hidden mid-run, with no guide reload', async () => {
    answerByTitle();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const first = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    state.channels = [{ id: 'ch1' }] as Channel[];
    first.resolve();
    await run;
    expect(sentTitles().slice(1)).toEqual([]);
  });

  it('drops the batch waiting in the AI queue once a channel is locked', async () => {
    answerByTitle();
    state.parentalOn = true;
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    const queued = (state.run.mock.calls[0][0] as { signal: AbortSignal }).signal;
    state.protectedIds = ['ch2'];
    state.rulesRevision++;
    ProgramGenres.scopeChanged();
    expect(queued.aborted).toBe(true);
    held.resolve();
    await run;
  });

  it('counts a source locked again as a change', async () => {
    state.approved = ['s1'];
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    const queued = (state.run.mock.calls[0][0] as { signal: AbortSignal }).signal;
    state.approved = [];
    ProgramGenres.scopeChanged();
    expect(queued.aborted).toBe(true);
    held.resolve();
    await run;
  });

  it('starts over once after a burst of channel edits pauses', async () => {
    answerByTitle();
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    for (let edit = 0; edit < 3; edit++) {
      if (edit) await vi.advanceTimersByTimeAsync(1000);
      state.channels = state.channels.slice();
      ProgramGenres.scopeChanged();
    }
    held.resolve();
    await run;
    state.guide.ch2.push(programme('Delta: kids', 5));
    await vi.advanceTimersByTimeAsync(CONFIG.EPG.GENRE_RESTART_DELAY_MS - 1);
    expect(state.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(sentTitles().slice(1)).toEqual([['Alpha: sports', 'Charlie', 'Delta: kids']]);
  });

  it('shows the last result again as soon as a stale run stops', async () => {
    answerByTitle();
    await ProgramGenres.run();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    expect(ProgramGenres.status.state).toBe('running');
    state.channels = [{ id: 'ch1' }] as Channel[];
    ProgramGenres.scopeChanged();
    expect(ProgramGenres.statusText()).toBe('Programs with an AI genre: 2');
    held.resolve();
    await run;
  });

  it('shows the last result again once a stale run stops before the next one starts', async () => {
    answerByTitle();
    await ProgramGenres.run();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    expect(ProgramGenres.status.state).toBe('running');
    state.channels = [{ id: 'ch1' }] as Channel[];
    ProgramGenres.schedule(1000);
    held.resolve();
    await run;
    expect(ProgramGenres.statusText()).toBe('Programs with an AI genre: 2');
  });

  it('shows the last result again when the run after a stale one finds AI not ready', async () => {
    answerByTitle();
    await ProgramGenres.run();
    state.guide.ch2 = Array.from({ length: 300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    const held = holdRequest();
    const run = ProgramGenres.run();
    await flush();
    state.channels = [{ id: 'ch1' }] as Channel[];
    const ready = vi.spyOn(LlmService, 'isReady').mockReturnValue(false);
    void ProgramGenres.run();
    held.resolve();
    await run;
    expect(ProgramGenres.statusText()).toBe('Programs with an AI genre: 2');
    ready.mockRestore();
  });

  it('writes the store every few batches and at the end, not after each', async () => {
    answerByTitle();
    state.guide.ch2 = Array.from({ length: 1300 }, (_, i) => programme(`Show ${String(1000 + i)}`, 3 + i / 100));
    await ProgramGenres.run();
    expect(state.run.mock.calls.length).toBe(7);
    expect(state.writes).toBe(2);
  });

  it('walks the guide once on a refresh with nothing new', async () => {
    answerByTitle();
    await ProgramGenres.run();
    const walked = vi.spyOn(state.guide.ch1, Symbol.iterator);
    await ProgramGenres.run();
    expect(walked).toHaveBeenCalledTimes(1);
    expect(ProgramGenres.statusText()).toBe('Programs with an AI genre: 2');
  });

  it('runs once a scheduled delay passes', async () => {
    answerByTitle();
    ProgramGenres.schedule(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(state.run).toHaveBeenCalledTimes(1);
  });
});
