import { LlmError } from './llm/client';
import { LlmService } from './llm/llm-service';
import { englishName } from './subtitle-translation';

export const EPG_TRANSLATION_FEATURE = 'epg-translation';
const PROMPT_VERSION = 1;
// Keeps one request inside a small local model's context.
export const MAX_DESCRIPTION_CHARS = 1500;
// Titles and descriptions sent in one request, at most.
export const MAX_BATCH_ITEMS = 20;
// The system prompt and the reply's framing.
const PROMPT_OVERHEAD_TOKENS = 600;

export interface ProgramText {
  title: string;
  description: string;
}

/** One item's translation, or why it has none. */
export type TitledOutcome = { text: ProgramText } | { error: unknown };

/**
 * The batch format, as the system prompt explains it: each title on a
 * "[Tn]" line and each description on a "[Dn]" line, n counting the items.
 */
export function formatLines(language: string): string[] {
  return [
    'Each input line is an item\'s title or its description: [T1] is the title of item 1, [D1] its description, and so on. An item may have only one of them.',
    'Reply with every input line, in the same order, each starting with the same tag in square brackets, then its translation on that one line. Write nothing else.',
    'Never merge, split, skip, or reorder lines.',
    `Copy text already in ${language} unchanged.`,
    'Translate only: add no facts, comments, or explanations, and do not shorten.',
  ];
}

function systemPrompt(target: string): string {
  const language = englishName(target);
  return [
    `You translate TV guide program information into ${language}, as a TV guide in that language writes it.`,
    ...formatLines(language),
    'Keep names of people, places, and teams as they are usually written. Keep a title that is a show\'s name when it has no common translation.',
  ].join('\n');
}

export function clipDescription(text: string): string {
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}…` : text;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The reply's text, or the original in full when the reply leaves it out or
// copies back what was sent, which may be clipped.
function replyOr(reply: string, sent: string, original: string): string {
  const text = reply.trim();
  return !sent || !text || normalized(text) === normalized(sent) ? original : text;
}

export interface TitledPrompt {
  feature: string;
  system: string;
  promptVersion: number;
}

// What one item puts on its lines: each on one line, the description clipped.
interface Sent {
  title: string;
  description: string;
}

function sentOf(item: ProgramText): Sent {
  return { title: normalized(item.title), description: normalized(clipDescription(item.description.trim())) };
}

export function formatItems(items: readonly Sent[]): string {
  const lines: string[] = [];
  items.forEach((item, i) => {
    if (item.title) lines.push(`[T${i + 1}] ${item.title}`);
    if (item.description) lines.push(`[D${i + 1}] ${item.description}`);
  });
  return lines.join('\n');
}

/**
 * Reads a reply's "[Tn]"/"[Dn]" lines, a line without a tag continuing the one
 * above; null unless it has exactly the lines sent, each once, so a reply
 * never puts one item's text on another.
 */
export function parseItems(reply: string, items: readonly Sent[]): Array<{ title: string; description: string }> | null {
  const expected = new Set<string>();
  items.forEach((item, i) => {
    if (item.title) expected.add(`T${i + 1}`);
    if (item.description) expected.add(`D${i + 1}`);
  });
  const found = new Map<string, string>();
  let current = '';
  for (const source of reply.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.indexOf('```') === 0) continue;
    // Models writing CJK sometimes switch to full-width brackets.
    const match = /^[[［【]\s*([TDtd])\s*(\d+)\s*[\]］】]\s*[:：]?\s*(.*)$/.exec(line);
    if (match) {
      current = `${match[1].toUpperCase()}${Number(match[2])}`;
      if (!expected.has(current) || found.has(current)) return null;
      found.set(current, match[3]);
    } else if (current) {
      found.set(current, `${found.get(current)} ${line}`);
    }
  }
  if (found.size !== expected.size) return null;
  return items.map((_, i) => ({ title: found.get(`T${i + 1}`) ?? '', description: found.get(`D${i + 1}`) ?? '' }));
}

// Rough token count: ASCII runs about four characters a token, other scripts about one.
function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) tokens += text.charCodeAt(i) < 128 ? 0.3 : 1;
  return Math.ceil(tokens);
}

function itemCost(item: Sent): number {
  return estimateTokens(item.title) + estimateTokens(item.description) + 8;
}

/** Splits items into requests that fit the context: a quarter of the room for the lines sent, the reply up to three times as long. */
function batchBudget(contextTokens: number): number {
  return Math.max(200, Math.floor((contextTokens - PROMPT_OVERHEAD_TOKENS) / 4));
}

export function planBatches(items: readonly Sent[], contextTokens: number): number[][] {
  const budget = batchBudget(contextTokens);
  const batches: number[][] = [];
  let current: number[] = [];
  let tokens = 0;
  items.forEach((item, index) => {
    const cost = itemCost(item);
    if (current.length && (current.length >= MAX_BATCH_ITEMS || tokens + cost > budget)) {
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

function taskFor(prompt: TitledPrompt, sent: readonly Sent[], signal?: AbortSignal) {
  const user = formatItems(sent);
  const input = estimateTokens(user);
  const room = LlmService.contextTokens() - PROMPT_OVERHEAD_TOKENS - input;
  return {
    feature: prompt.feature,
    priority: 'foreground' as const,
    system: prompt.system,
    user,
    promptVersion: prompt.promptVersion,
    maxTokens: Math.max(512, Math.min(Math.max(2048, input * 3), room)),
    signal,
    // Once sent, a reply still lands in the cache when the surface has moved on.
    finishStarted: true,
    splittable: sent.length > 1,
  };
}

function translated(item: ProgramText, sent: Sent, reply: { title: string; description: string }): ProgramText {
  return {
    title: replyOr(reply.title, sent.title, item.title),
    description: replyOr(reply.description, sent.description, item.description),
  };
}

// Sends one request for the items; a reply that fits them is kept per item, so
// a later request for any of them, alone or with others, is answered from it.
async function requestHalves(prompt: TitledPrompt, items: readonly ProgramText[], sent: readonly Sent[], signal?: AbortSignal): Promise<TitledOutcome[]> {
  const half = Math.ceil(items.length / 2);
  const parts = await Promise.all([
    request(prompt, items.slice(0, half), sent.slice(0, half), signal),
    request(prompt, items.slice(half), sent.slice(half), signal),
  ]);
  return parts[0].concat(parts[1]);
}

async function request(prompt: TitledPrompt, items: readonly ProgramText[], sent: readonly Sent[], signal?: AbortSignal): Promise<TitledOutcome[]> {
  // Planned before the Context size dropped, or before the model's output cap
  // was known: sized to them now instead of overflowing or cutting the reply short.
  const cost = sent.reduce((sum, item) => sum + itemCost(item), 0);
  const cap = LlmService.outputCap();
  const tooLong = cost > batchBudget(LlmService.contextTokens()) || (cap > 0 && cost * 3 > cap);
  if (items.length > 1 && tooLong) return requestHalves(prompt, items, sent, signal);
  let reply: string;
  try {
    // The reply is kept per item below, not as a whole.
    const outcome = await LlmService.runText({ ...taskFor(prompt, sent, signal), accept: () => false });
    // Cut off at its budget: a description may end mid-sentence, so nothing of it is used or kept.
    if (outcome.truncated) {
      if (items.length > 1) return requestHalves(prompt, items, sent, signal);
      return [{ error: new LlmError('schema', 'Reply was cut off') }];
    }
    reply = outcome.text;
  } catch (error) {
    // Too long for the model: each half asks on its own.
    if (error instanceof LlmError && error.reason === 'context' && items.length > 1) return requestHalves(prompt, items, sent, signal);
    return items.map(() => ({ error }));
  }
  const parsed = parseItems(reply, sent);
  if (!parsed) {
    if (items.length === 1) return [{ error: new LlmError('schema', 'Reply did not match the lines sent') }];
    // A reply that does not fit the batch is never mapped; each item asks alone.
    return Promise.all(items.map((item, i) => request(prompt, [item], [sent[i]], signal).then(out => out[0])));
  }
  await Promise.all(parsed.map((one, i) => LlmService.storeText(taskFor(prompt, [sent[i]]), [
    sent[i].title ? `[T1] ${one.title}` : '',
    sent[i].description ? `[D1] ${one.description}` : '',
  ].filter(line => line).join('\n'))));
  return items.map((item, i) => ({ text: translated(item, sent[i], parsed[i]) }));
}

/**
 * Titles and descriptions in the prompt's language, the original standing for
 * text already in it: each item kept from an earlier reply comes from there,
 * and the rest go in as few requests as fit the context.
 */
export async function translateTitledMany(
  prompt: TitledPrompt,
  items: readonly ProgramText[],
  signal?: AbortSignal,
): Promise<TitledOutcome[]> {
  const sent = items.map(sentOf);
  const out: Array<TitledOutcome | null> = await Promise.all(items.map(async (item, i) => {
    const hit = await LlmService.cachedText(taskFor(prompt, [sent[i]]));
    const parsed = hit === undefined ? null : parseItems(hit, [sent[i]]);
    return parsed ? { text: translated(item, sent[i], parsed[0]) } : null;
  }));
  const missing = out.map((outcome, i) => (outcome ? -1 : i)).filter(i => i >= 0);
  const batches = planBatches(missing.map(i => sent[i]), LlmService.contextTokens());
  await Promise.all(batches.map(async (batch) => {
    const indices = batch.map(k => missing[k]);
    const results = await request(prompt, indices.map(i => items[i]), indices.map(i => sent[i]), signal);
    results.forEach((result, k) => { out[indices[k]] = result; });
  }));
  return out as TitledOutcome[];
}

/** Programs' titles and descriptions in `target`; the original stands for text already in it. */
export function translatePrograms(programs: readonly ProgramText[], target: string, signal?: AbortSignal): Promise<TitledOutcome[]> {
  return translateTitledMany({ feature: EPG_TRANSLATION_FEATURE, system: systemPrompt(target), promptVersion: PROMPT_VERSION }, programs, signal);
}
