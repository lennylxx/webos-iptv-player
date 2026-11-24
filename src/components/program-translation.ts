import type { Channel } from '../types';
import { getLocale, t } from '../i18n';
import { EPG_TRANSLATION_FEATURE, translateProgram, type ProgramText } from '../services/epg-translation';
import { LlmError } from '../services/llm/client';
import { endpointSignature } from '../services/llm/config';
import { LlmService } from '../services/llm/llm-service';
import { catalogParentalRequest, liveParentalRequest, ParentalControlService } from '../services/parental-control';
import { translateVod } from '../services/vod-translation';
import { StorageService } from '../services/storage-service';
import { html, raw, type Safe } from '../utils/dom';
import { AI_ICON } from './icons';
import { clickHint } from './key-hints';
import { showToast } from './toast';

// A program the focus only passes over sends nothing.
export const TRANSLATION_DWELL_MS = 400;
// Results kept in memory for display; IndexedDB keeps them all, so an older
// one comes back from there without a new AI request.
export const MAX_REMEMBERED_TRANSLATIONS = 200;

export type ProgramTranslationState =
  | { status: 'pending' }
  | { status: 'failed' }
  // `changed` is false when the text was already in the UI language.
  | { status: 'done'; text: ProgramText; changed: boolean };

/** Where a title and description come from: how to translate them, and whether parental controls keep them back. */
export interface TranslationSource {
  // Each kind has its own prompt, so its results are kept apart.
  kind: 'program' | 'vod';
  guarded(): boolean;
  translate(text: ProgramText, target: string, signal: AbortSignal): Promise<ProgramText>;
}

/** A live channel's programs, in the Guide and the player's info. */
export function liveSource(channel: Channel | null | undefined): TranslationSource | null {
  if (!channel) return null;
  return {
    kind: 'program',
    guarded: () => ParentalControlService.protects(liveParentalRequest(channel)),
    translate: translateProgram,
  };
}

/** A movie or series and its episodes, in their detail page. */
export function catalogSource(
  kind: 'vod' | 'series',
  item: { accountId: string; categoryId: string; name: string; id: string },
): TranslationSource {
  return {
    kind: 'vod',
    // An unknown category may be a locked one, so parental controls keep it back.
    guarded: () => (!item.categoryId && ParentalControlService.enabled)
      || ParentalControlService.protects(catalogParentalRequest(kind, item)),
    translate: translateVod,
  };
}

let active = false;
const states = new Map<string, ProgramTranslationState>();
const listeners: Array<() => void> = [];
let wantedKey = '';
// The surface whose focused program is wanted; only it lets the program go.
let wantedBy: object | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

interface AiState {
  ready: boolean;
  signature: string | null;
}

let aiState: AiState | null = null;

// Read once per synchronous pass: a list render asks for every row.
function currentAi(): AiState {
  if (!aiState) {
    aiState = { ready: LlmService.isReady(EPG_TRANSLATION_FEATURE), signature: null };
    void Promise.resolve().then(() => { aiState = null; });
  }
  return aiState;
}

// Another model or server answers anew, so its results are kept apart.
function keyOf(source: TranslationSource, text: ProgramText): string {
  const ai = currentAi();
  if (ai.signature === null) ai.signature = endpointSignature(StorageService.getLlmConfig());
  return `${ai.signature}\n${getLocale()}\n${source.kind}\n${text.title}\n${text.description}`;
}

// AI switched off in Settings ends the session's translation, without a word.
function checkReady(): void {
  if (active && !currentAi().ready) {
    active = false;
    release();
  }
}

function schedule(key: string, source: TranslationSource, text: ProgramText): void {
  const program = { title: text.title, description: text.description };
  timer = setTimeout(() => { void request(key, source, program); }, TRANSLATION_DWELL_MS);
}

// Least recently shown first, so the oldest go once the cap is passed.
function remember(key: string, state: ProgramTranslationState): void {
  states.delete(key);
  states.set(key, state);
  if (states.size <= MAX_REMEMBERED_TRANSLATIONS) return;
  let excess = states.size - MAX_REMEMBERED_TRANSLATIONS;
  // A pending entry stays: its request's outcome or cancellation still reads it.
  states.forEach((entry, entryKey) => {
    if (excess > 0 && entry.status !== 'pending' && entryKey !== key) {
      states.delete(entryKey);
      excess--;
    }
  });
}

function recall(key: string): ProgramTranslationState | undefined {
  const state = states.get(key);
  if (state) {
    states.delete(key);
    states.set(key, state);
  }
  return state;
}

function notify(): void {
  listeners.slice().forEach(listener => listener());
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function release(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  // Drops the request only while it waits in the queue; a sent one still lands.
  if (controller) controller.abort();
  controller = null;
  wantedKey = '';
  wantedBy = null;
}

function stop(message: string): void {
  const wasActive = active;
  active = false;
  release();
  if (wasActive) showToast(message);
}

async function request(key: string, source: TranslationSource, text: ProgramText): Promise<void> {
  timer = null;
  const own = new AbortController();
  controller = own;
  remember(key, { status: 'pending' });
  notify();
  try {
    const result = await source.translate(text, getLocale(), own.signal);
    const changed = normalized(result.title) !== normalized(text.title)
      || normalized(result.description) !== normalized(text.description);
    remember(key, { status: 'done', text: result, changed });
  } catch (error) {
    const reason = error instanceof LlmError ? error.reason : 'network';
    if (states.get(key)?.status === 'pending') states.delete(key);
    if (reason === 'cap') stop(t('ai.translateLimit'));
    else if (reason === 'auth' || reason === 'disabled' || reason === 'config') stop(t('ai.setupProblem'));
    else if (reason !== 'cancelled') remember(key, { status: 'failed' });
    // The focus came back while the dropped request still read as on its way.
    else if (active && wantedKey === key && timer === null && controller === null) schedule(key, source, text);
  } finally {
    if (controller === own) controller = null;
  }
  notify();
}

/**
 * The session's translation of program, movie, and series info: Green in
 * the Guide and the player's info, or Translate on a detail page, turns it
 * on everywhere, then the title the focus rests on translates into the UI
 * language. Off at every launch.
 */
export const ProgramTranslation = {
  /** Whether the source's text may be sent: AI is set up and no parental rule guards it. */
  available(source: TranslationSource | null | undefined): boolean {
    return !!source && currentAi().ready && !source.guarded();
  },

  translatable(source: TranslationSource | null | undefined, text: ProgramText | null | undefined): boolean {
    return !!text && !!(text.title.trim() || text.description.trim()) && ProgramTranslation.available(source);
  },

  get active(): boolean {
    checkReady();
    return active;
  },

  toggle(): void {
    active = !active && currentAi().ready;
    if (!active) release();
    notify();
  },

  /** What a program shows while translation is on; null shows it as it is. */
  stateOf(source: TranslationSource | null | undefined, text: ProgramText | null | undefined): ProgramTranslationState | null {
    checkReady();
    if (!active || !source || !text || !ProgramTranslation.translatable(source, text)) return null;
    return recall(keyOf(source, text)) ?? null;
  },

  /** The program the focus rests on in `owner`'s surface; null when it rests on none. */
  want(owner: object, source: TranslationSource | null | undefined, text: ProgramText | null | undefined): void {
    checkReady();
    if (!active || !source || !text || !ProgramTranslation.translatable(source, text)) {
      ProgramTranslation.release(owner);
      return;
    }
    const key = keyOf(source, text);
    if (key === wantedKey) {
      wantedBy = owner;
      return;
    }
    release();
    wantedKey = key;
    wantedBy = owner;
    const state = recall(key);
    if (state && state.status !== 'failed') return;
    schedule(key, source, text);
  },

  /** Asks again at once for a translation that failed; false when it had not failed. */
  retry(owner: object, source: TranslationSource | null | undefined, text: ProgramText | null | undefined): boolean {
    if (!source || !text || ProgramTranslation.stateOf(source, text)?.status !== 'failed') return false;
    release();
    wantedKey = keyOf(source, text);
    wantedBy = owner;
    // The press asked for it, so it needs no pause and shows its progress now.
    void request(wantedKey, source, { title: text.title, description: text.description });
    return true;
  },

  /** `owner` no longer shows the program it wanted, so it is not sent once the focus would have rested. */
  release(owner: object): void {
    if (wantedBy === owner) release();
  },

  subscribe(listener: () => void): () => void {
    listeners.push(listener);
    return () => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    };
  },
};

export interface ProgramView {
  title: string;
  description: string;
  // Says the text is an AI translation, or how getting one goes; '' for the original.
  label: string;
  // The text is an AI translation, so its label shows the AI icon.
  ai: boolean;
}

/** The title and description to show for a program, translated while translation is on. */
export function programView(source: TranslationSource | null | undefined, text: ProgramText): ProgramView {
  const state = ProgramTranslation.stateOf(source, text);
  if (state?.status === 'done' && state.changed) {
    return { title: state.text.title, description: state.text.description, label: t('ai.translation'), ai: true };
  }
  const label = state?.status === 'pending' ? t('ai.translating') : state?.status === 'failed' ? t('ai.translateFailed') : '';
  return { title: text.title, description: text.description, label, ai: false };
}

function labelIcon(view: ProgramView): Safe | '' {
  return view.ai ? html`<span class="ai-icon">${raw(AI_ICON)}</span>` : '';
}

/** The description line, led by the translation label. */
export function programDescription(className: string, view: ProgramView): Safe | '' {
  if (!view.description) return '';
  const label = view.label ? html`<span class="program-translation-label">${labelIcon(view)}${view.label} · </span>` : '';
  return html`<div class="${className}">${label}${view.description}</div>`;
}

/** The label of a program without a description, in its title line, so no line comes and goes. */
export function programTitleLabel(view: ProgramView): Safe | '' {
  if (view.description || !view.label) return '';
  return html`<span class="program-translation-label is-title">${labelIcon(view)}${view.label}</span>`;
}

/** What turning translation over does: Translate, or Show original while it is on. */
export function translateLabel(): string {
  return t(active ? 'ai.showOriginal' : 'ai.translate');
}

/** Green's legend key: Translate, or Show original while translation is on. */
export function translateHint(dataKey: string, attrs: Record<string, string>): Safe {
  return clickHint('green', translateLabel(), dataKey, attrs);
}

export function resetProgramTranslationForTests(): void {
  release();
  aiState = null;
  active = false;
  states.clear();
  listeners.length = 0;
}
