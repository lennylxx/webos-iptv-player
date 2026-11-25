import ISO6391 from 'iso-639-1';
import { getLocale } from '../i18n';
import { createLogger } from '../utils/logger';
import { languageKey, languageName } from '../utils/subtitle-tracks';
import type { VttCue } from '../utils/webvtt';
import { LlmError } from './llm/client';
import { LlmService } from './llm/llm-service';
import { StorageService } from './storage-service';
import { hasMarkers } from './subtitle-markers';

const log = createLogger('SubTranslate');

export type TranslationCue = Pick<VttCue, 'start' | 'end' | 'text'> & {
  // The text batches are planned on, when it differs from the text sent.
  original?: string;
};

export const SUBTITLE_TRANSLATION_FEATURE = 'subtitle-translation';
const PROMPT_VERSION = 1;
const MAX_LINES = 40;
// System prompt and line numbering.
const PROMPT_OVERHEAD_TOKENS = 600;
const WORKERS = 2;
// Batches within this window of the playback position go out first.
const NEAR_S = 60;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10000;
const MAX_RETRY_MS = 60000;
// Unusable replies in a row, with none usable, that end the run.
const FAILED_BATCHES_TO_STOP = 2;
const LINE_BREAK = '<br>';

const LABELS: Record<string, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文' };
const ENGLISH_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'pt-BR': 'Brazilian Portuguese',
};

/** The language subtitles are translated into: the preferred subtitle language, else the UI's. */
export function translationTarget(): string {
  return StorageService.getOnlineSubtitleConfig().preferredLanguage || getLocale();
}

export function targetLabel(code: string): string {
  return LABELS[code] || languageName(code);
}

/** Short untranslated tag of a target language: EN, PT, and 简中/繁中 for Chinese scripts. */
export function targetCode(code: string): string {
  const key = languageKey(code);
  if (key !== 'zh') return (key || code).toUpperCase();
  const script = chineseScript(code);
  return script === 'hant' ? '繁中' : script === 'hans' ? '简中' : 'ZH';
}

export function englishName(code: string): string {
  return ENGLISH_NAMES[code] || ISO6391.getName(languageKey(code)) || code;
}

// Simplified or Traditional for a Chinese tag, '' when it doesn't say.
function chineseScript(lang: string): string {
  const tag = lang.toLowerCase();
  if (/hant|tw|hk|mo/.test(tag)) return 'hant';
  if (/hans|cn|sg/.test(tag)) return 'hans';
  return '';
}

/** Whether a subtitle in `sourceLang` is worth translating into `target`; an unknown language is. */
export function needsTranslation(sourceLang: string, target: string): boolean {
  const source = languageKey(sourceLang);
  if (!source || source !== languageKey(target)) return true;
  if (source !== 'zh') return false;
  const from = chineseScript(sourceLang);
  const to = chineseScript(target);
  return !!from && !!to && from !== to;
}

/** Whether two targets name one language (pt and pt-BR do; zh-CN and zh-TW don't). */
export function sameTarget(a: string, b: string): boolean {
  return !needsTranslation(a, b) && !needsTranslation(b, a);
}

// Rough token count: ASCII runs about four characters a token, CJK about one.
function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) tokens += text.charCodeAt(i) < 128 ? 0.3 : 1;
  return Math.ceil(tokens);
}

function lineCost(text: string): number {
  return estimateTokens(text) + 4;
}

/** Splits cues into fixed batches of cue indices; fixed so a replay hits the same cached batches. */
export function planBatches(cues: readonly TranslationCue[], contextTokens: number): number[][] {
  // A quarter of the room for the lines sent; the reply runs up to about three times as long.
  const budget = Math.max(100, Math.floor((contextTokens - PROMPT_OVERHEAD_TOKENS) / 4));
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  cues.forEach((cue, index) => {
    const cost = lineCost(cue.original ?? cue.text);
    if (current.length && (current.length >= MAX_LINES || tokens + cost > budget)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(index);
    tokens += cost;
  });
  if (current.length) batches.push(current);
  return batches;
}

/** Reply token limit for a batch: room to answer, within the context size. */
export function replyTokens(inputTokens: number, contextTokens: number): number {
  const room = contextTokens - PROMPT_OVERHEAD_TOKENS - inputTokens;
  return Math.max(256, Math.min(Math.max(2048, inputTokens * 3), room));
}

/** Batch order: from the one at `position` to the end, then back toward the start. */
export function batchOrder(batches: readonly number[][], cues: readonly TranslationCue[], position: number): number[] {
  let first = batches.findIndex(batch => cues[batch[batch.length - 1]].end > position);
  if (first < 0) first = batches.length - 1;
  const order: number[] = [];
  for (let i = first; i < batches.length; i++) order.push(i);
  for (let i = first - 1; i >= 0; i--) order.push(i);
  return order;
}

function systemPrompt(target: string, keptTags: boolean): string {
  const language = englishName(target);
  const lines = [
    `You translate film and TV subtitles into ${language}.`,
    `Each input line is one subtitle: its number in square brackets, then its text. ${LINE_BREAK} marks a line break within a subtitle.`,
    'Reply with one line per subtitle, in the same order, each starting with the same number in square brackets. Write nothing else.',
    `Never merge, split, skip, or reorder subtitles. Keep ${LINE_BREAK}, formatting tags such as <i>, and leading dashes.`,
    `Write natural, concise subtitles. Keep names as they are, and copy a subtitle already in ${language} unchanged.`,
  ];
  if (keptTags) lines.push('Keep tags such as <i>, </i> and <x1/> exactly, moving them with the words they mark.');
  return lines.join('\n');
}

export function formatLines(texts: readonly string[]): string {
  return texts.map((text, i) => `[${i + 1}] ${text.replace(/\r?\n/g, LINE_BREAK)}`).join('\n');
}

/** Reads "[n] text" lines for ids 1..count; a line without a number continues the one above. */
export function parseLines(reply: string, count: number): Map<number, string> {
  const raw = new Map<number, string>();
  let current = 0;
  for (const source of reply.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.indexOf('```') === 0) continue;
    // Models writing CJK sometimes switch to full-width brackets.
    const match = /^[[［【]\s*(\d+)\s*[\]］】]\s*[:：]?\s*(.*)$/.exec(line);
    if (match) {
      const id = Number(match[1]);
      current = id >= 1 && id <= count && !raw.has(id) ? id : 0;
      if (current) raw.set(id, match[2]);
    } else if (current) {
      raw.set(current, `${raw.get(current)}\n${line}`);
    }
  }
  const lines = new Map<number, string>();
  raw.forEach((text, id) => {
    const value = text.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
    if (value) lines.set(id, value);
  });
  return lines;
}

// A reply with fewer lines than this is a failed batch: kept out of the cache and retried later.
function usableLines(count: number): number {
  return Math.ceil(count / 2);
}

function retryable(error: LlmError): boolean {
  if (error.reason === 'quota' || error.reason === 'timeout' || error.reason === 'network') return true;
  return error.reason === 'http' && error.status >= 500;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export interface TranslationReport {
  // null when the run reached every batch it could; else why it stopped.
  error: LlmError | null;
}

/**
 * Translates one subtitle file in batches of cue text. Timings never leave the
 * device; each translated batch is handed to `onLines` as it arrives.
 */
export class SubtitleTranslation {
  readonly total: number;
  private contextTokens: number;
  private batches: number[][];
  private finished = new Set<number>();
  private inFlight = new Set<number>();
  private resolvedLines = 0;
  private keptLines = 0;
  private controller: AbortController | null = null;
  private job: Promise<TranslationReport> | null = null;
  // Settles once the last run's sent batches are in, which may be after the run reported.
  private drain: Promise<unknown> = Promise.resolve();

  constructor(
    private cues: readonly TranslationCue[],
    readonly target: string,
    // Playback position on the cue timeline, read before each batch.
    private position: () => number,
    private onLines: (indices: number[], texts: string[]) => void,
    private onProgress: () => void = () => {},
    // Extra diagnostic fields for the start and the end of a run.
    private extra: { start?: string[]; finish?: () => string[] } = {},
  ) {
    this.total = cues.length;
    this.contextTokens = LlmService.contextTokens();
    this.batches = planBatches(cues, this.contextTokens);
  }

  get percent(): number {
    return this.total ? Math.floor((this.resolvedLines * 100) / this.total) : 100;
  }

  get complete(): boolean {
    return this.finished.size >= this.batches.length;
  }

  get running(): boolean {
    return this.job !== null && !this.controller?.signal.aborted;
  }

  /** Runs the batches not finished yet; joins a running job. */
  start(): Promise<TranslationReport> {
    if (this.job && !this.controller?.signal.aborted) return this.job;
    const controller = new AbortController();
    this.controller = controller;
    // The last run may still be finishing its sent batches; the new one runs after them.
    const job = this.drain.then(() => (controller.signal.aborted
      ? { error: new LlmError('cancelled', 'Translation was cancelled') }
      : this.run(controller.signal))).then((report) => {
      if (this.job === job) {
        this.job = null;
        this.controller = null;
      }
      return report;
    });
    this.job = job;
    return job;
  }

  /** Takes no new batches; batches already sent finish, so their answers are cached. */
  stop(): void {
    this.controller?.abort();
  }

  private nextBatch(skip: Set<number>): number {
    const order = batchOrder(this.batches, this.cues, this.position());
    for (const batch of order) {
      if (!this.finished.has(batch) && !this.inFlight.has(batch) && !skip.has(batch)) return batch;
    }
    return -1;
  }

  private async run(signal: AbortSignal): Promise<TranslationReport> {
    const keptBefore = this.keptLines;
    const failed = new Set<number>();
    const counts = { cached: 0, requested: 0 };
    let usable = 0;
    log.info(
      'Subtitle translation started',
      'event=subtitle.translate.start',
      `target=${this.target}`,
      `lines=${this.total}`,
      `batches=${this.batches.length}`,
      `remaining=${this.batches.length - this.finished.size}`,
      `resume=${String(this.finished.size > 0)}`,
      ...(this.extra.start ?? []),
    );
    let error: LlmError | null = null;
    // Ends the run's waits and queued requests on a stop or the first failure.
    const halt = new AbortController();
    const onStop = (): void => halt.abort();
    signal.addEventListener('abort', onStop);
    const fail = (e: LlmError): void => {
      if (!error) error = e;
      halt.abort();
    };
    const worker = async (): Promise<void> => {
      while (!halt.signal.aborted) {
        const batch = this.nextBatch(failed);
        if (batch < 0) return;
        this.inFlight.add(batch);
        try {
          if (await this.runBatch(batch, halt.signal, counts)) {
            usable++;
          } else {
            failed.add(batch);
            if (!usable && failed.size >= FAILED_BATCHES_TO_STOP) fail(new LlmError('schema', 'Replies were not usable'));
          }
        } catch (e) {
          fail(e instanceof LlmError ? e : new LlmError('network', 'Translation failed'));
        } finally {
          this.inFlight.delete(batch);
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < WORKERS; i++) workers.push(worker());
    const drained = Promise.all(workers).then(() => signal.removeEventListener('abort', onStop));
    this.drain = drained;
    // A stop or failure reports at once; sent batches finish in the background.
    const halted = new Promise<void>(resolve => halt.signal.addEventListener('abort', () => resolve()));
    await Promise.race([drained, halted]);
    const failure = error as LlmError | null;
    // A stop ends quietly, whatever the batches still out did after it.
    const stopped = signal.aborted || failure?.reason === 'cancelled';
    const totals = [
      `done=${this.resolvedLines - this.keptLines}`,
      `kept=${this.keptLines}`,
      `cached=${counts.cached}`,
      `requested=${counts.requested}`,
      `total=${this.total}`,
      ...(this.extra.finish?.() ?? []),
    ];
    if (stopped) {
      if (failure && failure.reason !== 'cancelled') {
        log.warn('Subtitle translation incomplete', 'event=subtitle.translate.incomplete',
          `reason=${failure.reason}`, `failed_batches=${failed.size}`, ...totals);
      }
      return { error: new LlmError('cancelled', 'Translation was cancelled') };
    }
    if (failure || failed.size || this.keptLines > keptBefore) {
      log.warn(
        'Subtitle translation incomplete',
        'event=subtitle.translate.incomplete',
        `reason=${failure ? failure.reason : failed.size ? 'unusable_reply' : 'lines_kept'}`,
        `failed_batches=${failed.size}`,
        ...totals,
      );
    } else {
      log.info('Subtitle translation finished', 'event=subtitle.translate.done', ...totals);
    }
    return { error: failure };
  }

  // True once the batch is applied; false for an unusable reply.
  private async runBatch(
    index: number,
    signal: AbortSignal,
    counts: { cached: number; requested: number },
  ): Promise<boolean> {
    // A blank cue has nothing to translate; it is neither sent nor counted as kept.
    const batch = this.batches[index].filter(cueIndex => this.cues[cueIndex].text.trim() !== '');
    const blank = this.batches[index].length - batch.length;
    if (!batch.length) {
      this.finish(index, blank, [], []);
      return true;
    }
    const texts = batch.map(cueIndex => this.cues[cueIndex].text);
    const inputTokens = batch.reduce((sum, cueIndex) => sum + lineCost(this.cues[cueIndex].text), 0);
    const position = this.position();
    const near = this.cues[batch[0]].start <= position + NEAR_S && this.cues[batch[batch.length - 1]].end >= position;
    const minimum = usableLines(batch.length);
    for (let attempt = 1; ; attempt++) {
      let reply: string;
      try {
        const outcome = await LlmService.runText({
          feature: SUBTITLE_TRANSLATION_FEATURE,
          priority: near ? 'foreground' : 'background',
          system: systemPrompt(this.target, texts.some(hasMarkers)),
          user: formatLines(texts),
          promptVersion: PROMPT_VERSION,
          maxTokens: replyTokens(inputTokens, this.contextTokens),
          signal,
          finishStarted: true,
          accept: text => parseLines(text, batch.length).size >= minimum,
        });
        reply = outcome.text;
        if (outcome.cached) counts.cached++;
        else counts.requested++;
      } catch (e) {
        if (!(e instanceof LlmError) || !retryable(e) || attempt >= MAX_ATTEMPTS || signal.aborted) throw e;
        const delay = Math.min(MAX_RETRY_MS, e.retryAfterMs || RETRY_MS * attempt);
        log.warn(
          'Subtitle translation retrying',
          'event=subtitle.translate.retry',
          `reason=${e.reason}`,
          ...(e.status ? [`status=${e.status}`] : []),
          `attempt=${attempt}`,
          `wait_ms=${delay}`,
        );
        await wait(delay, signal);
        if (signal.aborted) throw new LlmError('cancelled', 'Translation was cancelled');
        continue;
      }
      const lines = parseLines(reply, batch.length);
      if (lines.size < minimum) return false;
      const indices: number[] = [];
      const translated: string[] = [];
      batch.forEach((cueIndex, k) => {
        const text = lines.get(k + 1);
        if (text === undefined) return;
        indices.push(cueIndex);
        translated.push(text);
      });
      this.keptLines += batch.length - indices.length;
      this.finish(index, batch.length + blank, indices, translated);
      return true;
    }
  }

  private finish(index: number, lines: number, indices: number[], texts: string[]): void {
    this.finished.add(index);
    this.resolvedLines += lines;
    if (indices.length) this.onLines(indices, texts);
    this.onProgress();
  }
}
