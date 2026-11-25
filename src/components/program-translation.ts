import type { Channel } from '../types';
import { getLocale, t } from '../i18n';
import { EPG_TRANSLATION_FEATURE, translatePrograms, type ProgramText, type TitledOutcome } from '../services/epg-translation';
import { LlmError } from '../services/llm/client';
import { endpointSignature } from '../services/llm/config';
import { LlmService } from '../services/llm/llm-service';
import { catalogParentalRequest, liveParentalRequest, ParentalControlService } from '../services/parental-control';
import { translateVods } from '../services/vod-translation';
import { StorageService } from '../services/storage-service';
import { html, raw, type Safe } from '../utils/dom';
import { AI_ICON } from './icons';
import { clickHint } from './key-hints';
import { showToast } from './toast';

// What a surface shows is sent once it has stayed this long, so scrolling or
// paging past items sends nothing.
export const TRANSLATION_DWELL_MS = 400;
// Results kept in memory for display; IndexedDB keeps them all, so an older
// one comes back from there without a new AI request.
export const MAX_REMEMBERED_TRANSLATIONS = 400;

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
  // One outcome per item, in order; items of one kind may go in one request.
  translate(items: readonly ProgramText[], target: string, signal: AbortSignal): Promise<TitledOutcome[]>;
}

/** A title and description a surface shows, and where it comes from. */
export interface TranslationItem {
  source: TranslationSource | null | undefined;
  text: ProgramText | null | undefined;
}

/** A live channel's programs, in the Guide, the player's info, Live, and Search. */
export function liveSource(channel: Channel | null | undefined): TranslationSource | null {
  if (!channel) return null;
  return {
    kind: 'program',
    guarded: () => ParentalControlService.protects(liveParentalRequest(channel)),
    translate: translatePrograms,
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
    translate: translateVods,
  };
}

interface Wanted {
  source: TranslationSource;
  text: ProgramText;
}

// What one surface shows, by key, and its requests not yet answered, with the keys each holds.
interface Surface {
  items: Map<string, Wanted>;
  timer: ReturnType<typeof setTimeout> | null;
  requests: Map<AbortController, string[]>;
}

let active = false;
let revision = 0;
const states = new Map<string, ProgramTranslationState>();
const listeners: Array<() => void> = [];
const surfaces = new Map<object, Surface>();

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
    releaseAll();
  }
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
  revision++;
  listeners.slice().forEach(listener => listener());
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function release(owner: object): void {
  const surface = surfaces.get(owner);
  if (!surface) return;
  surfaces.delete(owner);
  if (surface.timer !== null) clearTimeout(surface.timer);
  // Drops a request only while it waits in the queue; a sent one still lands.
  surface.requests.forEach((_keys, request) => request.abort());
}

function releaseAll(): void {
  Array.from(surfaces.keys()).forEach(release);
}

function stop(message: string): void {
  const wasActive = active;
  active = false;
  releaseAll();
  if (wasActive) showToast(message);
}

function settle(owner: object, surface: Surface): void {
  if (surface.timer !== null) clearTimeout(surface.timer);
  surface.timer = setTimeout(() => flush(owner), TRANSLATION_DWELL_MS);
}

// Sends what the surface shows and has no translation for, one request per
// kind of source, as the service splits it to fit the context. A failed one
// waits for a retry or for translation to be turned on again, so a failing
// model is not asked again on every scroll.
function flush(owner: object): void {
  const surface = surfaces.get(owner);
  if (!surface) return;
  surface.timer = null;
  if (!active) return;
  const groups = new Map<TranslationSource['translate'], Array<[string, Wanted]>>();
  surface.items.forEach((wanted, key) => {
    if (states.has(key)) return;
    if (!ProgramTranslation.available(wanted.source)) return;
    const group = groups.get(wanted.source.translate) ?? [];
    group.push([key, wanted]);
    groups.set(wanted.source.translate, group);
  });
  groups.forEach((entries, translate) => { void send(surface, entries, translate); });
}

async function send(surface: Surface, entries: Array<[string, Wanted]>, translate: TranslationSource['translate']): Promise<void> {
  const own = new AbortController();
  surface.requests.set(own, entries.map(([key]) => key));
  entries.forEach(([key]) => remember(key, { status: 'pending' }));
  notify();
  let outcomes: TitledOutcome[];
  try {
    outcomes = await translate(entries.map(([, wanted]) => wanted.text), getLocale(), own.signal);
  } catch (error) {
    outcomes = entries.map(() => ({ error }));
  } finally {
    surface.requests.delete(own);
  }
  let message = '';
  let cancelled = false;
  outcomes.forEach((outcome, i) => {
    const [key, wanted] = entries[i];
    if ('text' in outcome) {
      const result = outcome.text;
      const changed = normalized(result.title) !== normalized(wanted.text.title)
        || normalized(result.description) !== normalized(wanted.text.description);
      remember(key, { status: 'done', text: result, changed });
      return;
    }
    const reason = outcome.error instanceof LlmError ? outcome.error.reason : 'network';
    if (states.get(key)?.status === 'pending') states.delete(key);
    if (reason === 'cap' || reason === 'quota') message = 'ai.translateLimit';
    else if (reason === 'auth' || reason === 'disabled' || reason === 'config' || reason === 'context') message = message || 'ai.setupProblem';
    else if (reason === 'cancelled') cancelled = true;
    else remember(key, { status: 'failed' });
  });
  if (message) {
    stop(t(message as 'ai.translateLimit' | 'ai.setupProblem'));
  } else if (cancelled && active) {
    // A settled surface still showing what a dropped request held asks for it
    // now; one still settling asks once it settles.
    const keys = entries.map(([key]) => key);
    surfaces.forEach((shown, owner) => {
      if (shown.timer === null && keys.some(key => shown.items.has(key) && !states.has(key))) flush(owner);
    });
  }
  notify();
}

function sameKeys(a: Map<string, Wanted>, b: Map<string, Wanted>): boolean {
  if (a.size !== b.size) return false;
  for (const key of b.keys()) if (!a.has(key)) return false;
  return true;
}

/**
 * The session's translation of program, movie, and series info: Green in
 * the Guide and the player's info, or Translate on a detail page, turns it
 * on everywhere, then what each surface shows translates into the UI
 * language once the surface settles, as few requests as fit. Off at every
 * launch.
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

  /** Bumped whenever a shown translation may have changed. */
  get revision(): number {
    return revision;
  },

  toggle(): void {
    active = !active && currentAi().ready;
    if (!active) releaseAll();
    // Turned on again, it asks again for what failed before.
    else states.forEach((state, key) => { if (state.status === 'failed') states.delete(key); });
    notify();
  },

  /** What a program shows while translation is on; null shows it as it is. */
  stateOf(source: TranslationSource | null | undefined, text: ProgramText | null | undefined): ProgramTranslationState | null {
    checkReady();
    if (!active || !source || !text || !ProgramTranslation.translatable(source, text)) return null;
    return recall(keyOf(source, text)) ?? null;
  },

  /**
   * Everything `owner`'s surface shows; what has no translation yet is sent
   * once the surface has shown the same items for TRANSLATION_DWELL_MS.
   */
  show(owner: object, items: readonly TranslationItem[]): void {
    checkReady();
    if (!active) {
      release(owner);
      return;
    }
    const next = new Map<string, Wanted>();
    for (const item of items) {
      if (!item.source || !item.text || !ProgramTranslation.translatable(item.source, item.text)) continue;
      next.set(keyOf(item.source, item.text), {
        source: item.source,
        text: { title: item.text.title, description: item.text.description },
      });
    }
    const surface = surfaces.get(owner);
    if (surface && sameKeys(surface.items, next)) return;
    if (!next.size) {
      release(owner);
      return;
    }
    if (surface) {
      // The surface moved on: a request still waiting in the queue drops,
      // unless it holds something the surface still shows.
      surface.requests.forEach((keys, request) => {
        if (keys.some(key => next.has(key))) return;
        request.abort();
        surface.requests.delete(request);
      });
      surface.items = next;
      settle(owner, surface);
      return;
    }
    const added: Surface = { items: next, timer: null, requests: new Map() };
    surfaces.set(owner, added);
    settle(owner, added);
  },

  /** The one program `owner`'s surface shows, as the player's info and a detail page do; null for none. */
  want(owner: object, source: TranslationSource | null | undefined, text: ProgramText | null | undefined): void {
    ProgramTranslation.show(owner, [{ source, text }]);
  },

  /** Asks again at once for a translation that failed; false when it had not failed. */
  retry(owner: object, source: TranslationSource | null | undefined, text: ProgramText | null | undefined): boolean {
    if (!source || !text || ProgramTranslation.stateOf(source, text)?.status !== 'failed') return false;
    const key = keyOf(source, text);
    const wanted: Wanted = { source, text: { title: text.title, description: text.description } };
    let surface = surfaces.get(owner);
    if (!surface) {
      surface = { items: new Map([[key, wanted]]), timer: null, requests: new Map() };
      surfaces.set(owner, surface);
    }
    // The press asked for it, so it needs no pause and shows its progress now.
    void send(surface, [[key, wanted]], source.translate);
    return true;
  },

  /** `owner` no longer shows anything, so what it showed is not sent once it would have settled. */
  release(owner: object): void {
    release(owner);
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

/** A title shown alone, led by the AI mark when it is a translation. */
export function programTitle(view: ProgramView): Safe {
  return view.ai ? html`<span class="ai-icon is-title-mark">${raw(AI_ICON)}</span>${view.title}` : html`${view.title}`;
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

/** What turning translation over does on a detail page: Translate, or Show original while it is on. */
export function translateLabel(): string {
  return t(active ? 'ai.showOriginal' : 'ai.translate');
}

/** Green's key where program info shows: Translate program info, or Show original while translation is on. */
export function translateHint(dataKey: string, attrs: Record<string, string>): Safe {
  return clickHint('green', t(active ? 'ai.showOriginal' : 'ai.translateProgramInfo'), dataKey, attrs);
}

export function resetProgramTranslationForTests(): void {
  releaseAll();
  aiState = null;
  revision = 0;
  active = false;
  states.clear();
  listeners.length = 0;
}
