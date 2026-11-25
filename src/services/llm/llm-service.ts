import { createLogger } from '../../utils/logger';
import { StorageService } from '../storage-service';
import { getCachedLlmResult, setCachedLlmResult } from '../idb-cache';
import {
  chatCompletion,
  isErrorHint,
  LlmError,
  type LlmErrorHint,
  listModels,
  listModelsDetailed,
  propsContext,
  type ChatRequest,
  type ChatResult,
  type Endpoint,
  type ModelList,
} from './client';
import {
  endpointProfile,
  capabilitySignature,
  effectiveContextTokens,
  endpointSignature,
  MIN_CONTEXT_TOKENS,
  featureEnabled,
  originOf,
  isConfigured,
  normalizeBaseUrl,
  parseExtraHeaders,
} from './config';
import { contentHash } from './hash';
import { extractJson, stripThinking, validate } from './json';
import { LlmQueue } from './queue';
import { HOUR_MS } from './rate';
import type { LlmCapabilities, LlmConfig, LlmPriority, NamedSchema, ReasoningEffort, StructuredMode } from './types';
import { addUsage, capHit, usageFor, type UsageDay } from './usage';

const log = createLogger('LLM');

interface LlmTaskBase {
  // Feature id: its toggle, usage counter, and diagnostics label.
  feature: string;
  priority: LlmPriority;
  system: string;
  user: string;
  // Bump when the prompt or schema changes, so old cached answers are ignored.
  promptVersion: number;
  // The reply's output budget, always sent; a model's reported cap lowers it.
  maxTokens: number;
  // Foreground actions the user confirmed past a daily cap.
  ignoreCap?: boolean;
  signal?: AbortSignal;
  // The signal drops the request only while it waits; once sent, it finishes and is cached.
  finishStarted?: boolean;
  // A batch of several items the caller sends again in smaller parts when a
  // reply is cut off at the model's output cap; any other task gets the cut-off reply.
  splittable?: boolean;
}

export interface LlmTask extends LlmTaskBase {
  schema: NamedSchema;
}

export interface LlmTextTask extends LlmTaskBase {
  // Whether a reply is good enough to cache; the caller still gets every reply.
  accept?: (text: string) => boolean;
}

export interface LlmTextOutcome {
  text: string;
  cached: boolean;
  // The reply stopped at its token budget: possibly cut short, so it is not kept.
  truncated?: boolean;
}

interface TextReply {
  text: string;
  truncated: boolean;
}

export interface LlmOutcome<T> {
  value: T;
  // Invalid array items the model returned and validation dropped.
  dropped: number;
  cached: boolean;
}

export interface ConnectionReport {
  models: string[];
  capabilities: LlmCapabilities;
  // The model's context window as the server reports it; 0 when it doesn't.
  contextTokens: number;
}

const PROBE_SCHEMA: NamedSchema = {
  name: 'probe',
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, word: { type: 'string', enum: ['alpha', 'bravo'] } },
    required: ['ok', 'word'],
    additionalProperties: false,
  },
};
const PROBE_PROMPT = 'Return ok=true and word="bravo".';
const LADDER: readonly StructuredMode[] = ['json_schema', 'json_object', 'prompt'];
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low'];
// Room for a model that thinks before it answers.
const PROBE_MAX_TOKENS = 1000;
// Throttled or overloaded requests wait and retry this often before failing.
const RATE_RETRIES = 4;
// Network failures, timeouts, and other server errors retry fewer times.
const ERROR_RETRIES = 2;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_JITTER_MS = 750;
// A longer wait than this pauses the server's queue and fails the request instead of holding it.
const INLINE_WAIT_MAX_MS = 60000;
// A spent quota holds the server's queue this long; a foreground action may then try again.
const QUOTA_PAUSE_MS = 30000;
// A capability probe retries once, and only after a short wait.
const PROBE_RETRIES = 1;
const PROBE_WAIT_MAX_MS = 10000;
const CAPABILITY_MAX_AGE_MS = 7 * 24 * HOUR_MS;

// One queue per server, so a Test connection with unsaved values or a
// model switch keeps that server's 429 pause.
const queues = new Map<string, LlmQueue>();
interface Detection {
  promise: Promise<LlmCapabilities>;
  apiKey: string;
  ignoreCap: boolean;
}

// One detection per endpoint and model, shared by every caller waiting on it.
const detections = new Map<string, Detection>();

function endpointOf(config: LlmConfig): Endpoint {
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey,
    headers: parseExtraHeaders(config.extraHeaders),
    timeoutMs: endpointProfile(config.baseUrl).timeoutMs,
  };
}

function queueFor(config: LlmConfig): LlmQueue {
  const limits = { concurrency: endpointProfile(config.baseUrl).concurrency };
  const origin = originOf(config.baseUrl);
  let queue = queues.get(origin);
  if (queue) {
    queue.setLimits(limits);
  } else {
    queue = new LlmQueue(limits);
    queues.set(origin, queue);
  }
  return queue;
}

function readUsage(): UsageDay {
  return usageFor(StorageService.getLlmUsage(), Date.now());
}

// A failure several callers share (a quota 429 that also fails the queued
// jobs, a joined detection) is one occurrence and logs once.
const loggedFailures = typeof WeakSet === 'function' ? new WeakSet<object>() : null;

function logFailure(feature: string, error: unknown): void {
  const reason = error instanceof LlmError ? error.reason : 'network';
  if (reason === 'cancelled') return;
  if (error && typeof error === 'object' && loggedFailures) {
    if (loggedFailures.has(error)) return;
    loggedFailures.add(error);
  }
  log.warn(
    'LLM request failed',
    'event=llm.request.failed',
    `feature=${feature}`,
    `reason=${reason}`,
    ...(error instanceof LlmError && error.status ? [`status=${error.status}`] : []),
    // A closed set: e.g. output-cap tells a reply cut off at the cap from a prompt over the context.
    ...(error instanceof LlmError && isErrorHint(error.hint) ? [`hint=${error.hint}`] : []),
  );
}

/** Rejects as cancelled when the caller's signal aborts, without stopping shared work. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new LlmError('cancelled', 'Request was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new LlmError('cancelled', 'Request was cancelled'));
    signal.addEventListener('abort', onAbort);
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

/** Waits, or rejects as cancelled when the signal aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('cancelled', 'Request was cancelled'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError('cancelled', 'Request was cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * How often a failure is worth retrying: a throttle or overload most, a
 * dropped connection or server error less. A timeout is not: it already held
 * the server's slot for the whole timeout.
 */
function retries(error: unknown): number {
  if (!(error instanceof LlmError)) return 0;
  if (error.reason === 'rate' || error.hint === 'overloaded') return RATE_RETRIES;
  if (error.reason === 'network' || error.hint === 'internal') return ERROR_RETRIES;
  return 0;
}

interface SendOptions {
  ignoreCap: boolean;
  // The signal drops the request only while it waits; once sent, it finishes and is cached.
  finishStarted?: boolean;
  // A request whose budget we enlarged: an overflow says nothing about the context the prompts need.
  keepContext?: boolean;
  // A capability probe: a LAN server's bare 500 is a ladder step there.
  probing?: boolean;
  // A probe the user waits on (Test connection): it waits little and briefly.
  interactive?: boolean;
}

/**
 * Sends a request through the server's queue, retrying throttles, overloads,
 * dropped connections, and server errors. Each try takes a queue slot of its
 * own, so a backoff holds no slot another request could use.
 */
async function send(
  config: LlmConfig,
  feature: string,
  priority: LlmPriority,
  request: Omit<ChatRequest, 'model'>,
  options: SendOptions,
): Promise<ChatResult> {
  const q = queueFor(config);
  // Refusals belong to this server, model, and key; another key on the server goes on.
  const tag = capabilitySignature(config);
  // Checked as the request leaves the queue, so a queued batch can't overshoot
  // the cap, and before it takes a rate slot, so refused jobs don't delay others.
  const precheck = options.ignoreCap ? undefined : () => capError(StorageService.getLlmConfig());
  // A bare 500 is a ladder step for a LAN server's probe, not worth waiting out.
  const ladderStep = options.probing && endpointProfile(config.baseUrl).kind === 'local';
  // A probe doesn't wait out a long pause another request's throttle set, e.g. Test connection pressed again.
  if (options.interactive && q.pausedForMs() > PROBE_WAIT_MAX_MS) {
    throw new LlmError('rate', 'Server is throttling requests', 0, q.pausedForMs());
  }
  for (let attempt = 0; ; attempt++) {
    // finishStarted keeps only the first request going once the caller stops; no retry is sent for it.
    const signal = options.finishStarted && attempt === 0 ? undefined : request.signal;
    try {
      // Within an output cap another request learned while this one waited in line.
      const budget = (): number => {
        const learned = storedOutputCap(config);
        return learned > 0 ? Math.min(request.maxTokens, learned) : request.maxTokens;
      };
      return await q.run(priority, () => attemptOnce(config, feature, { ...request, signal, maxTokens: budget() }, options.keepContext === true),
        request.signal, attempt === 0 ? { precheck, tag } : { tag, front: true });
    } catch (error) {
      if (error instanceof LlmError && error.reason === 'quota') {
        // A spent quota fails every background batch alike; don't spend a request on each.
        // A foreground action may still try, e.g. right after a top-up.
        const dropped = q.refuse(QUOTA_PAUSE_MS, error, ['background'], tag);
        if (dropped) log.warn('Queued AI requests dropped', 'event=llm.queue.rejected', 'reason=quota', `count=${dropped}`);
      }
      let allowed = ladderStep && error instanceof LlmError && error.hint === 'internal' ? 0 : retries(error);
      if (options.interactive) allowed = Math.min(allowed, PROBE_RETRIES);
      if (!allowed || !(error instanceof LlmError)) throw error;
      const named = error.retryAfterMs;
      if (named > HOUR_MS) throw new LlmError('quota', error.message, error.status);
      const wait = named || Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * Math.pow(2, attempt))
        + Math.floor(Math.random() * BACKOFF_JITTER_MS);
      const throttled = error.reason === 'rate' || error.hint === 'overloaded';
      if (throttled && wait > INLINE_WAIT_MAX_MS) {
        // Too long to hold anyone for: this server's requests for the key fail at once until then.
        const dropped = q.refuse(wait, error, ['foreground', 'background'], tag);
        if (dropped) log.warn('Queued AI requests dropped', 'event=llm.queue.rejected', `reason=${error.reason}`, `count=${dropped}`);
        throw error;
      }
      // A throttled server's other requests wait out the same wait; a failed connection holds no one.
      if (throttled) q.pause(wait);
      // A probe doesn't keep Test connection checking for long.
      if (attempt >= allowed || (options.interactive && wait > PROBE_WAIT_MAX_MS)) throw error;
      if (request.signal?.aborted) throw new LlmError('cancelled', 'Request was cancelled');
      log.warn('AI request failed; retrying', 'event=llm.request.retry', `feature=${feature}`,
        `reason=${error.reason === 'http' ? error.hint : error.reason}`,
        `status=${error.status}`, `wait_ms=${wait}`, `attempt=${attempt + 1}`);
      await sleep(wait, request.signal);
    }
  }
}

/**
 * After a prompt overflowed the model's context, sizes later batches to the
 * context the server named, or to half the current one when it named none.
 */
function lowerContext(config: LlmConfig, named: number): void {
  const latest = StorageService.getLlmConfig();
  if (endpointSignature(latest) !== endpointSignature(config)) return;
  // Halves the size this request was planned with, so overflows of requests
  // sent together lower it once, not once each.
  const sized = effectiveContextTokens(config);
  const next = Math.max(MIN_CONTEXT_TOKENS, named > 0 ? Math.min(sized, named) : Math.floor(sized / 2));
  if (effectiveContextTokens(latest) <= next) return;
  StorageService.setLlmConfig({ ...latest, contextTokens: next, detectedContextTokens: next });
  log.warn('Prompt overflowed the model context; lowering Context size', 'event=llm.context.lowered',
    `tokens=${next}`, `named=${named}`);
}

function attemptOnce(
  config: LlmConfig,
  feature: string,
  request: Omit<ChatRequest, 'model'>,
  keepContext = false,
): Promise<ChatResult> {
  const sent = !request.signal || !request.signal.aborted;
  // Usage is recorded before the queue frees the slot, so the next request sees it.
  return chatCompletion(endpointOf(config), { ...request, model: config.model.trim() }).then((result) => {
    StorageService.setLlmUsage(addUsage(readUsage(), feature, result.usage));
    if (result.pauseMs) queueFor(config).pause(result.pauseMs);
    return result;
  }, (error: unknown) => {
    // The server answered, or got the request before it was stopped: it counts toward the day.
    const reached = error instanceof LlmError && (error.status > 0
      || (sent && (error.reason === 'cancelled' || error.reason === 'timeout')));
    if (reached) StorageService.setLlmUsage(addUsage(readUsage(), feature, null));
    if (error instanceof LlmError && error.reason === 'context' && !keepContext) lowerContext(config, error.contextTokens);
    // Saved before the slot frees, so the next request in line already goes within it.
    if (error instanceof LlmError && error.hint === 'output-cap' && error.outputTokens > 0) learnOutputCap(config, error.outputTokens);
    throw error;
  });
}

interface Thinking {
  effort: ReasoningEffort | '';
  fields: boolean;
}

function firstThinking(config: LlmConfig): Thinking {
  return { effort: 'none', fields: endpointProfile(config.baseUrl).preferThinkingOff };
}

/**
 * The next rung after the server refused this thinking control, or null when
 * nothing is left to drop. A named field goes first; a refused or unnamed
 * reasoning_effort steps none → minimal → low → left out.
 */
function nextThinking(thinking: Thinking, hint: LlmErrorHint): Thinking | null {
  if (hint === 'thinking-fields' && thinking.fields) return { ...thinking, fields: false };
  if (thinking.effort) {
    const at = EFFORTS.indexOf(thinking.effort);
    const effort = hint === 'unknown-field' || at + 1 >= EFFORTS.length ? '' : EFFORTS[at + 1];
    return { ...thinking, effort };
  }
  return thinking.fields ? { effort: '', fields: false } : null;
}

/** Whether a failed request means "this request shape isn't supported" rather than a failing server. */
function rejectsShape(config: LlmConfig, error: LlmError): boolean {
  if (error.reason !== 'http') return false;
  if (error.status === 400 || error.status === 422) return true;
  // A chat template that throws on a request it can't render, e.g. a thinking control it doesn't know.
  if (error.hint === 'effort' || error.hint === 'thinking-fields' || error.hint === 'template') return error.status >= 500;
  // Some local servers answer a chat-template error with a bare 500.
  return error.status === 500 && error.hint === 'internal' && endpointProfile(config.baseUrl).kind === 'local';
}

/** Whether a rejection may be the thinking control; an unnamed one counts while one was sent. */
function rejectsThinking(config: LlmConfig, error: LlmError): boolean {
  if (!rejectsShape(config, error)) return false;
  return ['effort', 'thinking-fields', 'unknown-field', 'template', 'internal', ''].indexOf(error.hint) >= 0;
}

interface ProbeResult {
  outcome: 'pass' | 'invalid' | LlmError;
  maxCompletionTokens: boolean;
  thought: boolean;
}

interface ProbeContext {
  ignoreCap: boolean;
  // Test connection, which the user waits on; a feature's detection waits like any request.
  interactive: boolean;
  // An output cap a probe's budget was refused with.
  outputCap: number;
}

async function probe(
  config: LlmConfig,
  mode: StructuredMode,
  thinking: Thinking,
  maxCompletionTokens: boolean,
  context: ProbeContext,
): Promise<ProbeResult> {
  const budget = context.outputCap > 0 ? Math.min(PROBE_MAX_TOKENS, context.outputCap) : PROBE_MAX_TOKENS;
  try {
    const result = await send(config, 'probe', 'foreground', {
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      schema: PROBE_SCHEMA,
      mode,
      effort: thinking.effort,
      thinkingFields: thinking.fields,
      maxCompletionTokens,
      maxTokens: budget,
    }, { ignoreCap: context.ignoreCap, probing: true, interactive: context.interactive });
    return {
      outcome: validate(PROBE_SCHEMA.schema, extractJson(result.text)) ? 'pass' : 'invalid',
      maxCompletionTokens: result.maxCompletionTokens,
      thought: result.thought,
    };
  } catch (error) {
    // A model whose output cap is below the probe's budget: once more within it, and the cap is kept.
    if (error instanceof LlmError && error.hint === 'output-cap' && error.outputTokens > 0 && error.outputTokens < budget) {
      context.outputCap = error.outputTokens;
      return probe(config, mode, thinking, maxCompletionTokens, context);
    }
    if (error instanceof LlmError && rejectsShape(config, error)) return { outcome: error, maxCompletionTokens, thought: false };
    throw error;
  }
}

async function detect(config: LlmConfig, ignoreCap: boolean, list?: ModelList, interactive = false): Promise<LlmCapabilities> {
  const context: ProbeContext = { ignoreCap, interactive, outputCap: 0 };
  const { caps, thought } = await detectModes(config, context);
  const models = list || await listModelsDetailed(endpointOf(config)).catch(() => null);
  const reported = (models && models.outputs[config.model.trim()]) || 0;
  caps.maxOutputTokens = reported > 0 && context.outputCap > 0 ? Math.min(reported, context.outputCap) : reported || context.outputCap;
  logDetected(config, caps, thought);
  return caps;
}

interface Detected {
  caps: LlmCapabilities;
  // The model still thought with the chosen control: replies are slower, not wrong.
  thought: boolean;
}

/**
 * Thinking control first, on its own ladder: the least reasoning_effort the
 * server takes (and the LAN-only thinking fields), with no response_format so
 * a refusal can only be about thinking. Then structured output, best mode first.
 */
async function detectModes(config: LlmConfig, context: ProbeContext): Promise<Detected> {
  let thinking = firstThinking(config);
  let maxCompletionTokens = false;
  let thought = false;
  for (;;) {
    const result = await probe(config, 'prompt', thinking, maxCompletionTokens, context);
    maxCompletionTokens = result.maxCompletionTokens;
    thought = result.thought;
    if (typeof result.outcome === 'string') break;
    const next = rejectsThinking(config, result.outcome) ? nextThinking(thinking, result.outcome.hint) : null;
    // Not about thinking, or nothing left to drop: the structured probes report it.
    if (!next) break;
    thinking = next;
  }
  let answered = false;
  let lastError: LlmError | null = null;
  const caps = (structured: StructuredMode): Detected => ({
    caps: {
      signature: capabilitySignature(config),
      structured,
      effort: thinking.effort,
      thinkingFields: thinking.fields,
      maxCompletionTokens,
      maxOutputTokens: 0,
      checkedAt: Date.now(),
    },
    thought,
  });
  for (const mode of LADDER) {
    for (;;) {
      const result = await probe(config, mode, thinking, maxCompletionTokens, context);
      maxCompletionTokens = result.maxCompletionTokens;
      if (result.outcome === 'pass') {
        thought = result.thought;
        return caps(mode);
      }
      if (result.outcome === 'invalid') {
        answered = true;
        break;
      }
      lastError = result.outcome;
      // A thinking control that only this response format refuses, by name.
      const named = result.outcome.hint === 'effort' || result.outcome.hint === 'thinking-fields';
      const next = named ? nextThinking(thinking, result.outcome.hint) : null;
      if (!next) break;
      thinking = next;
    }
  }
  // Never a successful reply: the server is failing, not lacking a mode.
  if (!answered && lastError) throw lastError;
  // Replies came but none was valid JSON; prompt-only still lets features try and validate.
  log.warn('No structured output mode passed the probe', 'event=llm.capability.fallback', 'mode=prompt');
  return caps('prompt');
}

function logDetected(config: LlmConfig, caps: LlmCapabilities, thought: boolean): void {
  log.info(
    'AI server capabilities detected',
    'event=llm.capability.detected',
    `profile=${endpointProfile(config.baseUrl).kind}`,
    `mode=${caps.structured}`,
    `effort=${caps.effort || 'omitted'}`,
    `thinking_fields=${String(caps.thinkingFields)}`,
    `still_thinking=${String(thought)}`,
    `max_field=${caps.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'}`,
    `max_output=${caps.maxOutputTokens}`,
  );
}

// One cap event per kind and day: refused jobs would otherwise log each.
let capLogged = '';

function capError(config: LlmConfig): LlmError | null {
  const usage = readUsage();
  const hit = capHit(config, usage);
  if (!hit) return null;
  if (capLogged !== `${usage.day}|${hit}`) {
    capLogged = `${usage.day}|${hit}`;
    log.warn('Daily AI limit reached', 'event=llm.cap.reached', `kind=${hit}`);
  }
  return new LlmError('cap', 'Daily cap reached');
}

function learnOutputCap(config: LlmConfig, tokens: number): void {
  const latest = StorageService.getLlmConfig();
  const saved = latest.capabilities;
  if (!saved || saved.signature !== capabilitySignature(config) || capabilitySignature(latest) !== saved.signature) return;
  if (saved.maxOutputTokens > 0 && saved.maxOutputTokens <= tokens) return;
  StorageService.setLlmConfig({ ...latest, capabilities: { ...saved, maxOutputTokens: tokens } });
}

/** The output cap saved for this server, model, and key; 0 when none. */
function storedOutputCap(config: LlmConfig): number {
  const latest = StorageService.getLlmConfig();
  const saved = latest.capabilities;
  return saved && saved.signature === capabilitySignature(config) ? saved.maxOutputTokens : 0;
}

function saveCapabilities(caps: LlmCapabilities): void {
  const latest = StorageService.getLlmConfig();
  if (capabilitySignature(latest) !== caps.signature) return;
  const saved = latest.capabilities;
  let next = caps;
  // Another request with the same detection learned something since this one
  // read it: what it learned stays (the output cap, max_completion_tokens).
  if (saved && saved.signature === caps.signature && saved.checkedAt === caps.checkedAt) {
    const outputs = [saved.maxOutputTokens, caps.maxOutputTokens].filter((tokens) => tokens > 0);
    next = {
      ...caps,
      maxOutputTokens: outputs.length ? Math.min.apply(null, outputs) : 0,
      maxCompletionTokens: caps.maxCompletionTokens || saved.maxCompletionTokens,
    };
  }
  StorageService.setLlmConfig({ ...latest, capabilities: next });
}

function capabilitiesFor(config: LlmConfig, signal: AbortSignal | undefined, ignoreCap: boolean): Promise<LlmCapabilities> {
  const signature = capabilitySignature(config);
  const saved = config.capabilities;
  // Past its age, the next request probes from the best rung again, so a server upgrade is picked up.
  if (saved && saved.signature === signature && Date.now() - saved.checkedAt < CAPABILITY_MAX_AGE_MS) {
    return Promise.resolve(saved);
  }
  let detection = detections.get(signature);
  // Don't join a detection that would fail this caller for another reason:
  // one sent with an older key, or one the daily cap can stop when this caller may pass it.
  if (!detection || detection.apiKey !== config.apiKey || (ignoreCap && !detection.ignoreCap)) {
    const started: Detection = { promise: detect(config, ignoreCap), apiKey: config.apiKey, ignoreCap };
    detection = started;
    detections.set(signature, started);
    started.promise.then(saveCapabilities, () => undefined).then(() => {
      if (detections.get(signature) === started) detections.delete(signature);
    });
  }
  return untilAborted(detection.promise, signal);
}

async function reportedContext(config: LlmConfig, list: ModelList): Promise<number> {
  let source = 'none';
  let tokens = list.contexts[config.model.trim()] || 0;
  if (tokens) {
    source = 'models';
  } else {
    // An optional extra, tried whenever /models names no context; the connection already passed.
    tokens = await propsContext(endpointOf(config)).catch(() => 0);
    if (tokens) source = 'props';
  }
  if (!tokens && list.trainingContexts[config.model.trim()]) {
    tokens = list.trainingContexts[config.model.trim()];
    source = 'training';
  }
  log.info('Context size reported', 'event=llm.context.detected', `source=${source}`, `tokens=${tokens}`);
  return tokens;
}

function textKey(config: LlmConfig, task: LlmTextTask): string {
  return contentHash([endpointSignature(config), task.feature, String(task.promptVersion), 'text', task.system, task.user]);
}

// Plain-text requests in flight, by cache key.
const pendingTexts = new Map<string, Promise<TextReply>>();

interface Exchange {
  messages: ChatRequest['messages'];
  // Absent for a plain-text reply.
  schema?: NamedSchema;
}

const NEXT_MODE: Record<StructuredMode, StructuredMode | null> = { json_schema: 'json_object', json_object: 'prompt', prompt: null };

/**
 * The capabilities one rung down after a saved rung failed, e.g. once the
 * server changed; null when the failure isn't about a rung or none is left.
 */
function stepDown(config: LlmConfig, caps: LlmCapabilities, error: unknown, structured: boolean): LlmCapabilities | null {
  if (!(error instanceof LlmError) || !rejectsShape(config, error)) return null;
  const hint = error.hint;
  if (hint === 'effort' || hint === 'thinking-fields' || hint === 'unknown-field') {
    const next = nextThinking({ effort: caps.effort, fields: caps.thinkingFields }, hint);
    return next ? { ...caps, effort: next.effort, thinkingFields: next.fields } : null;
  }
  if (hint === 'response-format' && structured) {
    const mode = NEXT_MODE[caps.structured];
    return mode ? { ...caps, structured: mode } : null;
  }
  return null;
}

/**
 * Sends a task with the saved capabilities. A saved rung the server now
 * refuses steps down once and is saved; max_completion_tokens is learned when
 * the server asks for it; a model that spent its whole budget thinking gets
 * one more try with twice the budget.
 */
async function complete(
  config: LlmConfig,
  caps: LlmCapabilities,
  task: LlmTaskBase,
  exchange: Exchange,
  ignoreCap: boolean,
): Promise<{ result: ChatResult; caps: LlmCapabilities }> {
  let current = caps;
  // The cap these capabilities carry, or one another request learned since, read before every send.
  const cap = (): number => {
    const learned = storedOutputCap(config);
    const own = current.maxOutputTokens;
    return own > 0 && learned > 0 ? Math.min(own, learned) : own || learned;
  };
  const fit = (tokens: number): number => (cap() > 0 ? Math.min(tokens, cap()) : tokens);
  let maxTokens = fit(task.maxTokens);
  let stepped = false;
  let capped = false;
  let enlarged: ChatResult | null = null;
  for (;;) {
    maxTokens = fit(maxTokens);
    let result: ChatResult;
    try {
      result = await send(config, task.feature, task.priority, {
        ...exchange,
        mode: exchange.schema ? current.structured : 'text',
        effort: current.effort,
        thinkingFields: current.thinkingFields,
        maxCompletionTokens: current.maxCompletionTokens,
        maxTokens,
        signal: task.signal,
      }, { ignoreCap, finishStarted: task.finishStarted, keepContext: !!enlarged });
    } catch (error) {
      // Over the model's output cap, which /models didn't report: learn it, and send once more within it.
      if (!capped && error instanceof LlmError && error.hint === 'output-cap' && error.outputTokens > 0
        && error.outputTokens < maxTokens) {
        capped = true;
        current = { ...current, maxOutputTokens: error.outputTokens };
        saveCapabilities(current);
        log.warn('AI reply budget over the model output cap; retrying within it', 'event=llm.output.capped',
          `feature=${task.feature}`, `max_tokens=${maxTokens}`, `cap=${error.outputTokens}`);
        if (enlarged) return { result: enlarged, caps: current };
        maxTokens = error.outputTokens;
        continue;
      }
      // The doubled budget is more than the server allows: the empty reply stands, as without the retry.
      if (enlarged && error instanceof LlmError && (error.reason === 'context' || (error.reason === 'http' && (error.status === 400 || error.status === 422)))) {
        return { result: enlarged, caps: current };
      }
      const lower = stepped ? null : stepDown(config, current, error, !!exchange.schema);
      if (!lower) throw error;
      log.warn('Saved AI capability refused; stepping down', 'event=llm.capability.stepped',
        `mode=${lower.structured}`, `effort=${lower.effort || 'omitted'}`, `thinking_fields=${String(lower.thinkingFields)}`);
      stepped = true;
      current = lower;
      saveCapabilities(current);
      continue;
    }
    if (result.maxCompletionTokens && !current.maxCompletionTokens) {
      current = { ...current, maxCompletionTokens: true };
      saveCapabilities(current);
    }
    // Cut short at the output cap: the request asks more than one reply may hold.
    // A batching caller sends it again in smaller parts; nothing is lowered.
    if (task.splittable && result.finishReason === 'length' && fit(task.maxTokens) < task.maxTokens) {
      throw new LlmError('context', 'Reply is over the output cap', 0, 0, 'output-cap');
    }
    const larger = fit(maxTokens * 2);
    if (enlarged || result.text.trim() || result.finishReason !== 'length' || larger <= maxTokens) {
      return { result, caps: current };
    }
    log.warn('AI reply cut off before any answer; retrying with a larger budget', 'event=llm.reply.truncated',
      `feature=${task.feature}`, `max_tokens=${maxTokens}`, `retry_max_tokens=${larger}`);
    enlarged = result;
    maxTokens = larger;
  }
}

async function requestText(config: LlmConfig, task: LlmTextTask, key: string, ignoreCap: boolean): Promise<TextReply> {
  const caps = await capabilitiesFor(config, task.signal, ignoreCap);
  const { result } = await complete(config, caps, task, {
    messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
  }, ignoreCap);
  const text = stripThinking(result.text).trim();
  // A reply cut off at its budget may still parse; it is never kept.
  const truncated = result.finishReason === 'length';
  if (!truncated && (!task.accept || task.accept(text))) await setCachedLlmResult(key, text).catch(() => undefined);
  return { text, truncated };
}

// Refuses a task the settings or the daily cap don't allow.
function gate(config: LlmConfig, feature: string, ignoreCap: boolean): void {
  if (!config.enabled || !featureEnabled(config, feature)) throw new LlmError('disabled', 'Feature is off');
  if (!isConfigured(config)) throw new LlmError('config', 'Endpoint is not configured');
  if (!ignoreCap) {
    const refused = capError(config);
    if (refused) throw refused;
  }
}

function logUnlessExpected(feature: string, error: unknown): void {
  if (!(error instanceof LlmError && (error.reason === 'disabled' || error.reason === 'cap'))) {
    logFailure(feature, error);
  }
}

export const LlmService = {
  isReady(feature?: string): boolean {
    const config = StorageService.getLlmConfig();
    return config.enabled && isConfigured(config) && (!feature || featureEnabled(config, feature));
  },

  /** The most a reply may be, as the server reported or refused it; 0 when unknown. */
  outputCap(): number {
    const config = StorageService.getLlmConfig();
    const caps = config.capabilities;
    return caps && caps.signature === capabilitySignature(config) ? caps.maxOutputTokens : 0;
  },

  /** The prompt budget batching features should stay within. */
  contextTokens(): number {
    return effectiveContextTokens(StorageService.getLlmConfig());
  },

  usageToday(): UsageDay {
    return readUsage();
  },

  async run<T>(task: LlmTask): Promise<LlmOutcome<T>> {
    const config = StorageService.getLlmConfig();
    const ignoreCap = task.ignoreCap === true;
    try {
      gate(config, task.feature, true);
      const key = contentHash([endpointSignature(config), task.feature, String(task.promptVersion), task.system, task.user]);
      const hit = await getCachedLlmResult(key);
      if (hit !== undefined) {
        const checked = validate(task.schema.schema, hit);
        if (checked) return { value: checked.value as T, dropped: 0, cached: true };
      }
      gate(config, task.feature, ignoreCap);
      let caps = await capabilitiesFor(config, task.signal, ignoreCap);
      for (let attempt = 1; ; attempt++) {
        const sent = await complete(config, caps, task, {
          messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
          schema: task.schema,
        }, ignoreCap);
        const result = sent.result;
        caps = sent.caps;
        const attempts = task.priority === 'foreground' && caps.structured !== 'json_schema' ? 2 : 1;
        // An empty reply is a failed one, like invalid JSON.
        const checked = validate(task.schema.schema, extractJson(result.text));
        if (checked) {
          // A reply cut off at its budget that still validates is used but never kept.
          if (result.finishReason !== 'length') await setCachedLlmResult(key, checked.value).catch(() => undefined);
          return { value: checked.value as T, dropped: checked.dropped, cached: false };
        }
        if (attempt >= attempts) throw new LlmError('schema', 'Reply did not match the schema');
      }
    } catch (error) {
      logUnlessExpected(task.feature, error);
      throw error;
    }
  },

  /** Like `run`, for a reply the caller parses itself: plain text, thinking removed. */
  async runText(task: LlmTextTask): Promise<LlmTextOutcome> {
    const config = StorageService.getLlmConfig();
    const ignoreCap = task.ignoreCap === true;
    try {
      gate(config, task.feature, true);
      const key = textKey(config, task);
      const hit = await getCachedLlmResult(key);
      if (typeof hit === 'string') return { text: hit, cached: true };
      // The same request already out (e.g. a job rebuilt after a reload) answers this caller too.
      const shared = pendingTexts.get(key);
      if (shared) {
        try {
          const reply = await untilAborted(shared, task.signal);
          return { text: reply.text, cached: true, ...(reply.truncated ? { truncated: true } : {}) };
        } catch (error) {
          // The caller that sent it stopped while it waited in the queue; send it anew.
          if (error instanceof LlmError && error.reason === 'cancelled' && !task.signal?.aborted) {
            return LlmService.runText(task);
          }
          throw error;
        }
      }
      gate(config, task.feature, ignoreCap);
      const request = requestText(config, task, key, ignoreCap);
      pendingTexts.set(key, request);
      const settle = (): void => {
        if (pendingTexts.get(key) === request) pendingTexts.delete(key);
      };
      request.then(settle, settle);
      const reply = await request;
      return { text: reply.text, cached: false, ...(reply.truncated ? { truncated: true } : {}) };
    } catch (error) {
      logUnlessExpected(task.feature, error);
      throw error;
    }
  },

  /** The reply `runText` keeps for the task, without sending anything; undefined when none is kept. */
  async cachedText(task: LlmTextTask): Promise<string | undefined> {
    const hit = await getCachedLlmResult(textKey(StorageService.getLlmConfig(), task)).catch(() => undefined);
    return typeof hit === 'string' ? hit : undefined;
  },

  /** Keeps a reply as `runText` would for the task, e.g. one part of a reply that answered several at once. */
  async storeText(task: LlmTextTask, text: string): Promise<void> {
    await setCachedLlmResult(textKey(StorageService.getLlmConfig(), task), text).catch(() => undefined);
  },

  /** Lists models and re-detects structured output for the given, possibly unsaved, config. */
  async testConnection(config: LlmConfig): Promise<ConnectionReport> {
    if (!isConfigured(config)) throw new LlmError('config', 'Endpoint is not configured');
    let modelsMissing = false;
    try {
      let list: ModelList = { ids: [], contexts: {}, outputs: {}, trainingContexts: {} };
      try {
        list = await listModelsDetailed(endpointOf(config));
      } catch (error) {
        // Some gateways have no /models; the probe below decides.
        if (!(error instanceof LlmError) || (error.reason !== 'config' && error.reason !== 'http')) throw error;
        modelsMissing = error.status === 404;
      }
      const capabilities = await detect({ ...config, capabilities: null }, true, list, true);
      const contextTokens = await reportedContext(config, list);
      return { models: list.ids, capabilities, contextTokens };
    } catch (error) {
      logFailure('probe', error);
      // Both paths missing means the address is wrong, not the model.
      if (modelsMissing && error instanceof LlmError && error.status === 404) {
        throw new LlmError('config', 'HTTP 404', 404, 0, 'address');
      }
      throw error;
    }
  },

  async listModels(config: LlmConfig, signal?: AbortSignal): Promise<string[]> {
    return listModels(endpointOf(config), signal);
  },
};

export function resetLlmServiceForTests(): void {
  queues.clear();
  pendingTexts.clear();
  detections.clear();
  capLogged = '';
}
