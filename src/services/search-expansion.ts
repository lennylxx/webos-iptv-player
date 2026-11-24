import { CONFIG } from '../config';
import { foldSearchText } from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { splitLetterNumberTokens } from '../utils/unicode-text';
import { LlmError } from './llm/client';
import { LlmService } from './llm/llm-service';
import type { NamedSchema } from './llm/types';

export const SEARCH_EXPANSION_FEATURE = 'search-expansion';
const PROMPT_VERSION = 1;
const MIN_LETTERS = 3;
const MAX_WORDS = 6;
const MAX_LENGTH = 60;
const MEMO_SIZE = 50;

const log = createLogger('Search');

interface Reply {
  alternatives: Array<{ text: string; lang: string; kind: string }>;
}

const SCHEMA: NamedSchema = {
  name: 'search_query_alternatives',
  schema: {
    type: 'object',
    properties: {
      alternatives: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            lang: { type: 'string' },
            kind: { type: 'string', enum: ['translation', 'transliteration', 'synonym', 'spelling'] },
          },
          required: ['text', 'lang', 'kind'],
          additionalProperties: false,
        },
      },
    },
    required: ['alternatives'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You help a TV app search its channel, program, movie, and series names in many languages.',
  'The user message is JSON {"query":"..."}: what the viewer typed into the search box.',
  `alternatives: up to ${CONFIG.SEARCH.EXPANSION_MAX} other ways the same words are written in TV listings:`,
  'translations into widely used languages, transliterations between scripts (such as Cyrillic and Latin), common synonyms, and spelling variants.',
  'Keep each alternative as short as the query. lang: its ISO 639-1 code. kind: how it relates to the query.',
  'Only rewrite the given words. Never add titles, names, or facts the query does not contain.',
  'Return an empty list when the query is a name that is not translated.',
].join('\n');

const memo = new Map<string, string[]>();
// Requests on their way, shared by every caller of the same query.
const inFlight = new Map<string, { promise: Promise<string[]>; abort: AbortController; waiters: number }>();

// CJK characters carry a syllable or word each, so one counts as two letters.
const WIDE_LETTER_RE = /[\u1100-\u11ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

function letterCount(words: string[]): number {
  let count = 0;
  for (const word of words) {
    for (let i = 0; i < word.length; i++) count += WIDE_LETTER_RE.test(word.charAt(i)) ? 2 : 1;
  }
  return count;
}

/** The query as sent to the model, or null when it is too short or long to expand. */
export function expansionQuery(query: string): string | null {
  const text = query.trim().replace(/\s+/g, ' ').toLowerCase();
  const words = splitLetterNumberTokens(foldSearchText(text));
  if (!words.length || words.length > MAX_WORDS || text.length > MAX_LENGTH) return null;
  return letterCount(words) >= MIN_LETTERS ? text : null;
}

// Alternatives that repeat the query or are too short to search are expected;
// malformed ones are counted.
function usable(reply: Reply, query: string): { kept: string[]; rejected: number } {
  const seen = new Set([foldSearchText(query)]);
  const kept: string[] = [];
  let rejected = 0;
  for (const alternative of reply.alternatives) {
    if (kept.length >= CONFIG.SEARCH.EXPANSION_MAX) break;
    const text = alternative.text.trim().replace(/\s+/g, ' ');
    const folded = foldSearchText(text);
    const words = splitLetterNumberTokens(folded);
    if (text.length > MAX_LENGTH || !words.length) {
      rejected++;
      continue;
    }
    if (seen.has(folded) || letterCount(words) < MIN_LETTERS) continue;
    seen.add(folded);
    kept.push(text);
  }
  return { kept, rejected };
}

export function cachedExpansion(query: string): string[] | undefined {
  const key = expansionQuery(query);
  return key === null ? undefined : memo.get(key);
}

async function request(key: string, signal: AbortSignal): Promise<string[]> {
  const outcome = await LlmService.run<Reply>({
    feature: SEARCH_EXPANSION_FEATURE,
    priority: 'background',
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ query: key }),
    schema: SCHEMA,
    promptVersion: PROMPT_VERSION,
    maxTokens: 512,
    signal,
    finishStarted: true,
  });
  const { kept: alternatives, rejected } = usable(outcome.value, key);
  const dropped = rejected + outcome.dropped;
  if (!alternatives.length && dropped > 0) {
    log.warn(
      'AI search alternatives were all unusable',
      'event=search.expansion.invalid',
      `dropped=${String(dropped)}`,
    );
  }
  if (memo.size >= MEMO_SIZE) memo.delete(memo.keys().next().value as string);
  memo.set(key, alternatives);
  return alternatives;
}

// Waits for the shared request; the last caller to lose interest drops it
// while it still waits in the queue.
function join(key: string, signal?: AbortSignal): Promise<string[]> {
  let entry = inFlight.get(key);
  if (!entry) {
    const abort = new AbortController();
    const created = { promise: request(key, abort.signal), abort, waiters: 0 };
    const settled = (): void => { if (inFlight.get(key) === created) inFlight.delete(key); };
    created.promise.then(settled, settled);
    inFlight.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.waiters++;
  return new Promise<string[]>((resolve, reject) => {
    let done = false;
    const leave = (): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (--shared.waiters === 0 && signal?.aborted) shared.abort.abort();
    };
    const onAbort = (): void => {
      leave();
      reject(new LlmError('cancelled', 'Request was cancelled'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    shared.promise.then((value) => {
      leave();
      resolve(value);
    }, (error: unknown) => {
      leave();
      reject(error);
    });
  });
}

/** Other ways to write the query; empty when there are none. Rejects when the model fails. */
export async function expandSearchQuery(query: string, signal?: AbortSignal): Promise<string[]> {
  const key = expansionQuery(query);
  if (key === null) return [];
  for (;;) {
    const known = memo.get(key);
    if (known) return known;
    try {
      return await join(key, signal);
    } catch (error) {
      // Another caller dropped the shared request before it was sent.
      if (error instanceof LlmError && error.reason === 'cancelled' && !signal?.aborted) continue;
      throw error;
    }
  }
}

export function resetSearchExpansionForTests(): void {
  memo.clear();
  inFlight.clear();
}
