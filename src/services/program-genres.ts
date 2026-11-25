import type { Channel, Programme } from '../types';
import { formatNumber, t, type TextMessageKey } from '../i18n';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { runInFrameSlices } from '../utils/frame-slices';
import { EpgService } from './epg-service';
import { getCachedLlmResult, setCachedLlmResult } from './idb-cache';
import { LlmService } from './llm/llm-service';
import { featureEnabled } from './llm/config';
import { ParentalControlService, liveParentalRequest } from './parental-control';
import { PlaylistService } from './playlist-service';
import { StorageService } from './storage-service';
import {
  PROGRAM_GENRES,
  PROGRAM_GENRES_FEATURE,
  PROMPT_VERSION,
  classifyBatch,
  failureReason,
  planGenreBatches,
  type GenreItem,
  type ProgramGenre,
} from './program-genre-ai';

export { PROGRAM_GENRES_FEATURE, type ProgramGenre } from './program-genre-ai';

const log = createLogger('ProgramGenres');

const STORE_KEY = `program-genres|v${PROMPT_VERSION}`;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A title not seen in the window for this long is dropped.
const KEEP_DAYS = 14;
const MAX_ENTRIES = 30000;
// After a guide load or refresh, so the guide's other work finishes first.
const SCHEDULE_DELAY_MS = 30000;
// The store is written every few batches or this often, and when a run ends.
const SAVE_EVERY_BATCHES = 5;
const SAVE_INTERVAL_MS = 30000;

interface Entry {
  g: ProgramGenre | '';
  // The day the title was last in the window.
  d: number;
}

export type GenreStatus =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; count: number }
  | { state: 'limit' }
  | { state: 'failed' };

export interface GenreEstimate {
  programs: number;
  requests: number;
}

const GENRE_IDS: readonly string[] = PROGRAM_GENRES;

let entries = new Map<string, Entry>();
let loading: Promise<void> | null = null;
let active = false;
let revision = 0;
let status: GenreStatus = { state: 'idle' };
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let running: Promise<void> | null = null;
// Asked for while a run was going; it starts once that one ends.
let rerun = false;
let saving: Promise<void> | null = null;
// The generation a save asked for meanwhile belongs to; null when none waits.
let saveAgain: number | null = null;
// Bumped on cancel and reset, so a save asked for before them writes nothing.
let generation = 0;
// The status shown before the running job began, shown again when it stops without its own.
let beforeRun: GenreStatus = { state: 'idle' };
// What the running job's titles came from; once it changes they are stale.
let jobScope: Scope | null = null;
const listeners: Array<() => void> = [];
let keys = new WeakMap<Programme, string>();

function today(): number {
  return Math.floor(Date.now() / DAY_MS);
}

/** A title as the store keys it: case, spacing, and punctuation folded, so repeats of a show match. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[\s.,:;!?¡¿'"`“”‘’«»()[\]{}\-–—_/\\|*#~+]+/g, ' ').trim();
}

function keyOf(programme: Programme): string {
  let key = keys.get(programme);
  if (key === undefined) {
    key = titleKey(programme.title);
    keys.set(programme, key);
  }
  return key;
}

function needsGenre(programme: Programme): boolean {
  return !programme.category.trim() && !!keyOf(programme);
}

function notify(): void {
  listeners.slice().forEach(listener => listener());
}

function setStatus(next: GenreStatus): void {
  status = next;
  notify();
}

function readStore(value: unknown): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const list = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : null;
  if (!Array.isArray(list)) return map;
  for (const row of list) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[2] !== 'number') continue;
    const genre = row[1];
    if (genre !== '' && GENRE_IDS.indexOf(genre as string) < 0) continue;
    map.set(row[0], { g: genre as ProgramGenre | '', d: row[2] });
  }
  return map;
}

function load(): Promise<void> {
  if (!loading) {
    loading = getCachedLlmResult(STORE_KEY)
      .then((value) => {
        // Titles learned while the store loaded stay over what it held.
        const stored = readStore(value);
        entries.forEach((entry, key) => stored.set(key, entry));
        entries = stored;
        revision++;
      })
      .catch(() => undefined);
  }
  return loading;
}

function pruned(): Array<[string, ProgramGenre | '', number]> {
  const oldest = today() - KEEP_DAYS;
  const rows: Array<[string, ProgramGenre | '', number]> = [];
  entries.forEach((entry, key) => {
    if (entry.d >= oldest) rows.push([key, entry.g, entry.d]);
  });
  if (rows.length > MAX_ENTRIES) {
    rows.sort((a, b) => b[2] - a[2]);
    rows.length = MAX_ENTRIES;
  }
  return rows;
}

// One write at a time; a save asked for meanwhile runs once after it.
function persist(): Promise<void> {
  if (saving) {
    saveAgain = generation;
    return saving;
  }
  saving = setCachedLlmResult(STORE_KEY, { entries: pruned() })
    .catch(() => undefined)
    .then(() => {
      saving = null;
      const again = saveAgain;
      saveAgain = null;
      return again === generation ? persist() : undefined;
    });
  return saving;
}

interface Scope {
  // Hides and locks: a request out with titles collected before them is stopped.
  privacy: string;
  channels: Channel[];
  // A guide reload or remap: the titles already out are still fine to send.
  guide: string;
}

function currentScope(): Scope {
  return {
    privacy: [ParentalControlService.rulesRevision, ParentalControlService.enabled ? 1 : 0,
      StorageService.getShowHiddenChannels() ? 1 : 0, ParentalControlService.approvedSources.join(',')].join('|'),
    // A new list on every customization, such as a channel hidden; the walked list is new per call.
    channels: PlaylistService.getUnconcealedChannels(),
    guide: `${EpgService.guideRevision}|${EpgService.mappingRevision}`,
  };
}

// The channels or the parental rules changed since the running job collected its titles.
function privacyStale(): boolean {
  if (!jobScope) return false;
  const now = currentScope();
  return now.privacy !== jobScope.privacy || now.channels !== jobScope.channels;
}

// Also the guide: the job sends no further batch, though the one out may finish.
function jobStale(): boolean {
  if (!jobScope) return false;
  return privacyStale() || currentScope().guide !== jobScope.guide;
}

function restoreStatus(): void {
  if (status.state === 'running') setStatus(beforeRun);
}

function arm(delayMs: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void ProgramGenres.run();
  }, delayMs);
}

// Stops a job whose titles went stale, with the request it has waiting; the
// next run starts once a burst of edits pauses.
function stopStale(stale: () => boolean = jobStale): boolean {
  if (!stale()) return false;
  controller?.abort();
  restoreStatus();
  arm(CONFIG.EPG.GENRE_RESTART_DELAY_MS);
  return true;
}

// Visits each program of the unhidden, unprotected channels that is on in the
// next 24 hours, a channel at a time; false when `current` stops it. Channels
// the user hid stay out even while edit mode or "show hidden" lists them.
function walkWindow(visit: (programme: Programme) => void, current: () => boolean): Promise<boolean> {
  const now = Date.now();
  const end = now + WINDOW_MS;
  let channels = PlaylistService.getEpgEligibleChannels();
  if (ParentalControlService.enabled) {
    channels = channels.filter(channel => !ParentalControlService.protects(liveParentalRequest(channel)));
  }
  const listed = new Set<string>();
  let index = 0;
  return runInFrameSlices(() => {
    if (index >= channels.length) return true;
    const id = EpgService.findChannelId(channels[index++]);
    if (!id || listed.has(id)) return false;
    listed.add(id);
    for (const programme of EpgService.getProgrammes(id) ?? []) {
      if (programme.start.getTime() >= end) break;
      if (programme.stop.getTime() > now) visit(programme);
    }
    return false;
  }, { shouldContinue: current });
}

interface Pending {
  items: GenreItem[];
  programs: number;
}

// The titles still without a genre, once each, and how many programs carry them.
async function pending(current: () => boolean, touch: boolean): Promise<Pending | null> {
  const day = today();
  const items = new Map<string, GenreItem>();
  let programs = 0;
  let touched = false;
  const done = await walkWindow((programme) => {
    if (!needsGenre(programme)) return;
    const key = keyOf(programme);
    const entry = entries.get(key);
    if (entry) {
      if (touch && entry.d !== day) {
        entry.d = day;
        touched = true;
      }
      return;
    }
    programs++;
    if (!items.has(key)) items.set(key, { key, title: programme.title, description: programme.description });
  }, current);
  if (!done) return null;
  if (touched) void persist();
  return { items: Array.from(items.values()), programs };
}

async function countGenres(current: () => boolean): Promise<number | null> {
  let count = 0;
  const done = await walkWindow((programme) => {
    if (programGenre(programme)) count++;
  }, current);
  return done ? count : null;
}

async function runJob(signal: AbortSignal): Promise<void> {
  const current = () => !signal.aborted;
  await load();
  const work = current() ? await pending(current, true) : null;
  if (!work) return;
  const batches = planGenreBatches(work.items, LlmService.contextTokens());
  // Nothing new since a run that counted: the count stands.
  if (!batches.length && status.state === 'done') return;
  let cached = 0;
  let unsaved = 0;
  let savedAt = Date.now();
  let dropped = 0;
  let classified = 0;
  let failed = 0;
  let reason: string = 'none';
  for (let index = 0; index < batches.length; index++) {
    // A channel hidden or locked meanwhile: its titles are not sent; a later run walks again.
    if (stopStale()) {
      if (unsaved) void persist();
      return;
    }
    setStatus({ state: 'running', done: index, total: batches.length });
    try {
      const result = await classifyBatch(batches[index], signal);
      // Stopped meanwhile (turned off, cache cleared): keep nothing.
      if (signal.aborted) return;
      if (result.cached) cached++;
      dropped += result.dropped;
      const day = today();
      Object.keys(result.genres).forEach((key) => {
        const genre = result.genres[key];
        if (genre) classified++;
        entries.set(key, { g: genre, d: day });
      });
      revision++;
      unsaved++;
      if (unsaved >= SAVE_EVERY_BATCHES || Date.now() - savedAt >= SAVE_INTERVAL_MS) {
        unsaved = 0;
        savedAt = Date.now();
        void persist();
      }
    } catch (error) {
      reason = failureReason(error);
      failed = batches.length - index;
      break;
    }
  }
  if (batches.length && reason !== 'cancelled') {
    log.info('Program genres finished', 'event=genre.ai.run', `programs=${work.programs}`,
      `titles=${work.items.length}`, `batches=${batches.length}`, `cached=${cached}`,
      `classified=${classified}`, `dropped=${dropped}`, `failed=${failed}`, `reason=${reason}`);
  }
  if (reason === 'cancelled' || signal.aborted) return;
  if (unsaved) void persist();
  if (reason === 'cap') {
    setStatus({ state: 'limit' });
    return;
  }
  if (reason !== 'none') {
    setStatus({ state: 'failed' });
    return;
  }
  const count = await countGenres(current);
  if (count !== null) setStatus({ state: 'done', count });
}

function startJob(): Promise<void> {
  if (status.state !== 'running') beforeRun = status;
  if (!active || !LlmService.isReady(PROGRAM_GENRES_FEATURE)) {
    restoreStatus();
    return Promise.resolve();
  }
  const run = new AbortController();
  controller = run;
  jobScope = currentScope();
  const settle = (): Promise<void> | undefined => {
    if (controller === run) {
      controller = null;
      jobScope = null;
    }
    if (running === job) running = null;
    // cancel() clears a rerun asked for before it; one asked for after it still runs.
    const again = rerun;
    rerun = false;
    if (again) return startJob();
    restoreStatus();
    return undefined;
  };
  const job: Promise<void> = runJob(run.signal).then(settle, settle);
  running = job;
  return job;
}

function readActive(): boolean {
  const config = StorageService.getLlmConfig();
  return config.enabled && featureEnabled(config, PROGRAM_GENRES_FEATURE);
}

/** The genre the AI model gave a program without a category; null when it has one or none is known. */
export function programGenre(programme: Programme): ProgramGenre | null {
  if (!active || programme.category.trim()) return null;
  const entry = entries.get(keyOf(programme));
  return entry && entry.g ? entry.g : null;
}

export function genreLabel(genre: ProgramGenre): string {
  return t(`genre.${genre}` as TextMessageKey);
}

/** The program's genre as Search shows and filters it: the guide's category, else the AI one. */
export function programGenreName(programme: Programme): string {
  const category = programme.category.trim();
  if (category) return category;
  const genre = programGenre(programme);
  return genre ? genreLabel(genre) : '';
}

export const ProgramGenres = {
  /** Bumped whenever a lookup may answer differently. */
  get revision(): number {
    return revision;
  },

  /** Whether AI features and the genres toggle are on, as last synced. */
  get active(): boolean {
    return active;
  },

  get status(): GenreStatus {
    return status;
  },

  /** The status line Settings shows under the toggle; empty when there is nothing to say. */
  statusText(): string {
    switch (status.state) {
      case 'running':
        return t('settings.aiProgramGenresProgress', { done: formatNumber(status.done), total: formatNumber(status.total) });
      case 'done':
        return status.count ? t('settings.aiProgramGenresDone', { count: formatNumber(status.count) }) : '';
      case 'limit':
        return t('parental.aiLimitOnly');
      case 'failed':
        return t('parental.aiFailed');
      default:
        return '';
    }
  },

  subscribe(listener: () => void): () => void {
    listeners.push(listener);
    return () => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    };
  },

  /** Rereads the toggle; loads what is stored once it is on and stops a run once it is off. */
  sync(): void {
    const next = readActive();
    if (next === active) return;
    active = next;
    revision++;
    if (active) {
      void load().then(() => notify());
    } else {
      this.cancel();
      setStatus({ state: 'idle' });
    }
  },

  /** How many programs in the next 24 hours would be sent, and in how many requests. */
  async estimate(): Promise<GenreEstimate> {
    await load();
    const work = await pending(() => true, false);
    if (!work) return { programs: 0, requests: 0 };
    return { programs: work.programs, requests: planGenreBatches(work.items, LlmService.contextTokens()).length };
  },

  /** Runs after `delayMs`, replacing a run already waiting. */
  schedule(delayMs = SCHEDULE_DELAY_MS): void {
    this.sync();
    if (!active) return;
    // A job over the old channels or locks stops sending now; the scheduled one
    // starts over. One over an older guide stops after the batch it has out.
    if (privacyStale()) {
      controller?.abort();
      restoreStatus();
    }
    arm(delayMs);
  },

  /** Stops a run over channels or locks that changed, without waiting for its next batch. */
  scopeChanged(): void {
    if (active) stopStale(privacyStale);
  },

  /**
   * Starts a run, or, while one is going, one more after it: one job at a
   * time, however often the guide refreshes meanwhile. A job over hidden or
   * locked channels stops first; one over an older guide after its batch out.
   */
  run(): Promise<void> {
    if (running) {
      if (privacyStale()) controller?.abort();
      rerun = true;
      return running;
    }
    return startJob();
  },

  cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    rerun = false;
    saveAgain = null;
    generation++;
    controller?.abort();
    controller = null;
    jobScope = null;
  },

  /** Forgets every learned genre, as clearing the cache does. */
  reset(): void {
    this.cancel();
    entries = new Map();
    loading = null;
    keys = new WeakMap();
    revision++;
    if (active) void load().then(() => notify());
    setStatus({ state: 'idle' });
  },
};

export function resetProgramGenresForTests(): void {
  ProgramGenres.cancel();
  entries = new Map();
  loading = null;
  active = false;
  revision = 0;
  status = { state: 'idle' };
  running = null;
  rerun = false;
  saving = null;
  saveAgain = null;
  generation = 0;
  jobScope = null;
  beforeRun = { state: 'idle' };
  listeners.length = 0;
  keys = new WeakMap();
}
