import { createLogger } from '../../utils/logger';
import { StorageService } from '../storage-service';
import { getCachedLlmResult, setCachedLlmResult } from '../idb-cache';
import {
  chatCompletion,
  LlmError,
  listModels,
  listModelsDetailed,
  llamaCppContext,
  type ChatRequest,
  type ChatResult,
  type Endpoint,
  type ModelList,
} from './client';
import {
  endpointProfile,
  endpointSignature,
  featureEnabled,
  originOf,
  isConfigured,
  normalizeBaseUrl,
  parseExtraHeaders,
} from './config';
import { contentHash } from './hash';
import { extractJson, stripThinking, validate } from './json';
import { LlmQueue } from './queue';
import type { LlmCapabilities, LlmConfig, LlmPriority, NamedSchema, StructuredMode } from './types';
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
  maxTokens?: number;
  // Foreground actions the user confirmed past a daily cap.
  ignoreCap?: boolean;
  signal?: AbortSignal;
  // The signal drops the request only while it waits; once sent, it finishes and is cached.
  finishStarted?: boolean;
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

async function send(
  config: LlmConfig,
  feature: string,
  priority: LlmPriority,
  request: Omit<ChatRequest, 'model'>,
  ignoreCap: boolean,
  finishStarted = false,
): Promise<ChatResult> {
  const q = queueFor(config);
  // Checked as the request leaves the queue, so a queued batch can't overshoot
  // the cap, and before it takes a rate slot, so refused jobs don't delay others.
  const precheck = ignoreCap ? undefined : () => capError(StorageService.getLlmConfig());
  return q.run(priority, () => {
    // Usage is recorded before the queue frees the slot, so the next request sees it.
    const signal = finishStarted ? undefined : request.signal;
    const sent = !signal || !signal.aborted;
    return chatCompletion(endpointOf(config), { ...request, signal, model: config.model.trim() }).then((result) => {
      StorageService.setLlmUsage(addUsage(readUsage(), feature, result.usage));
      return result;
    }, (error: unknown) => {
      // The server answered, or got the request before it was stopped: it counts toward the day.
      const reached = error instanceof LlmError && (error.status > 0
        || (sent && (error.reason === 'cancelled' || error.reason === 'timeout')));
      if (reached) StorageService.setLlmUsage(addUsage(readUsage(), feature, null));
      if (error instanceof LlmError && error.reason === 'quota') {
        q.pause(error.retryAfterMs || 30000);
        // A spent daily quota fails every queued batch alike; don't spend a request on each.
        const dropped = q.rejectPending('background', error);
        if (dropped) log.warn('Queued AI requests dropped', 'event=llm.queue.rejected', 'reason=quota', `count=${dropped}`);
      }
      throw error;
    });
  }, request.signal, precheck);
}

interface ProbeResult {
  outcome: 'pass' | 'invalid' | LlmError;
  reasoningParams: boolean;
}

/** Whether a failed probe means "this request shape isn't supported" rather than a failing server. */
function rejectsShape(config: LlmConfig, error: LlmError): boolean {
  if (error.reason !== 'http') return false;
  if (error.status === 400 || error.status === 422) return true;
  // llama.cpp answers a chat-template error with 500.
  return error.status === 500 && endpointProfile(config.baseUrl).kind === 'local';
}

interface Thinking {
  thinkingOff: boolean;
  effortOff: boolean;
}

async function probe(
  config: LlmConfig,
  mode: StructuredMode,
  thinking: Thinking,
  reasoningParams: boolean,
  ignoreCap: boolean,
): Promise<ProbeResult> {
  try {
    const result = await send(config, 'probe', 'foreground', {
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      schema: PROBE_SCHEMA,
      mode,
      thinkingOff: thinking.thinkingOff,
      effortOff: thinking.effortOff,
      reasoningParams,
      // Room for a model that thinks before it answers.
      maxTokens: 1000,
    }, ignoreCap);
    return {
      outcome: validate(PROBE_SCHEMA.schema, extractJson(result.text)) ? 'pass' : 'invalid',
      reasoningParams: result.reasoningParams,
    };
  } catch (error) {
    if (error instanceof LlmError && rejectsShape(config, error)) return { outcome: error, reasoningParams };
    throw error;
  }
}

async function detect(config: LlmConfig, ignoreCap: boolean): Promise<LlmCapabilities> {
  const caps = await detectModes(config, ignoreCap);
  logDetected(config, caps);
  return caps;
}

async function detectModes(config: LlmConfig, ignoreCap: boolean): Promise<LlmCapabilities> {
  // Local servers: every thinking-off field first, then without reasoning_effort
  // (vLLM may reject "none"), then none at all.
  const thinkingOptions: Thinking[] = endpointProfile(config.baseUrl).preferThinkingOff
    ? [{ thinkingOff: true, effortOff: true }, { thinkingOff: true, effortOff: false }, { thinkingOff: false, effortOff: false }]
    : [{ thinkingOff: false, effortOff: false }];
  let answered = false;
  let lastError: LlmError | null = null;
  let reasoningParams = false;
  for (const mode of LADDER) {
    for (const thinking of thinkingOptions) {
      const result = await probe(config, mode, thinking, reasoningParams, ignoreCap);
      reasoningParams = result.reasoningParams;
      if (result.outcome === 'pass') {
        return {
          signature: endpointSignature(config),
          structured: mode,
          thinkingOff: thinking.thinkingOff,
          effortOff: thinking.effortOff,
          reasoningParams,
          checkedAt: Date.now(),
        };
      }
      if (result.outcome === 'invalid') answered = true;
      else lastError = result.outcome;
    }
  }
  // Never a successful reply: the server is failing, not lacking a mode.
  if (!answered && lastError) throw lastError;
  // Replies came but none was valid JSON; prompt-only still lets features try and validate.
  log.warn('No structured output mode passed the probe', 'event=llm.capability.fallback', 'mode=prompt');
  return {
    signature: endpointSignature(config),
    structured: 'prompt',
    thinkingOff: false,
    effortOff: false,
    reasoningParams,
    checkedAt: Date.now(),
  };
}

function logDetected(config: LlmConfig, caps: LlmCapabilities): void {
  log.info(
    'Structured output detected',
    'event=llm.capability.detected',
    `profile=${endpointProfile(config.baseUrl).kind}`,
    `mode=${caps.structured}`,
    `thinking_off=${String(caps.thinkingOff)}`,
    `effort_off=${String(caps.effortOff)}`,
    `reasoning_params=${String(caps.reasoningParams)}`,
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

function saveCapabilities(caps: LlmCapabilities): void {
  const latest = StorageService.getLlmConfig();
  if (endpointSignature(latest) === caps.signature) StorageService.setLlmConfig({ ...latest, capabilities: caps });
}

function capabilitiesFor(config: LlmConfig, signal: AbortSignal | undefined, ignoreCap: boolean): Promise<LlmCapabilities> {
  const signature = endpointSignature(config);
  if (config.capabilities && config.capabilities.signature === signature) return Promise.resolve(config.capabilities);
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
  } else if (list.llamaCpp) {
    // An optional extra; the connection already passed.
    tokens = await llamaCppContext(endpointOf(config)).catch(() => 0);
    if (tokens) source = 'props';
  }
  log.info('Context size reported', 'event=llm.context.detected', `source=${source}`, `tokens=${tokens}`);
  return tokens;
}

// Plain-text requests in flight, by cache key.
const pendingTexts = new Map<string, Promise<string>>();

async function requestText(config: LlmConfig, task: LlmTextTask, key: string, ignoreCap: boolean): Promise<string> {
  const caps = await capabilitiesFor(config, task.signal, ignoreCap);
  const result = await send(config, task.feature, task.priority, {
    messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
    mode: 'text',
    thinkingOff: caps.thinkingOff,
    effortOff: caps.effortOff,
    reasoningParams: caps.reasoningParams,
    maxTokens: task.maxTokens,
    signal: task.signal,
  }, ignoreCap, task.finishStarted);
  if (result.reasoningParams && !caps.reasoningParams) saveCapabilities({ ...caps, reasoningParams: true });
  const text = stripThinking(result.text).trim();
  if (!task.accept || task.accept(text)) await setCachedLlmResult(key, text).catch(() => undefined);
  return text;
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

  /** The prompt budget batching features should stay within. */
  contextTokens(): number {
    return StorageService.getLlmConfig().contextTokens;
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
      const caps = await capabilitiesFor(config, task.signal, ignoreCap);
      const attempts = task.priority === 'foreground' && caps.structured !== 'json_schema' ? 2 : 1;
      for (let attempt = 1; ; attempt++) {
        const result = await send(config, task.feature, task.priority, {
          messages: [{ role: 'system', content: task.system }, { role: 'user', content: task.user }],
          schema: task.schema,
          mode: caps.structured,
          thinkingOff: caps.thinkingOff,
          effortOff: caps.effortOff,
          reasoningParams: caps.reasoningParams,
          maxTokens: task.maxTokens,
          signal: task.signal,
        }, ignoreCap, task.finishStarted);
        if (result.reasoningParams && !caps.reasoningParams) saveCapabilities({ ...caps, reasoningParams: true });
        const checked = validate(task.schema.schema, extractJson(result.text));
        if (checked) {
          await setCachedLlmResult(key, checked.value).catch(() => undefined);
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
      const key = contentHash([endpointSignature(config), task.feature, String(task.promptVersion), 'text', task.system, task.user]);
      const hit = await getCachedLlmResult(key);
      if (typeof hit === 'string') return { text: hit, cached: true };
      // The same request already out (e.g. a job rebuilt after a reload) answers this caller too.
      const shared = pendingTexts.get(key);
      if (shared) {
        try {
          return { text: await untilAborted(shared, task.signal), cached: true };
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
      return { text: await request, cached: false };
    } catch (error) {
      logUnlessExpected(task.feature, error);
      throw error;
    }
  },

  /** Lists models and re-detects structured output for the given, possibly unsaved, config. */
  async testConnection(config: LlmConfig): Promise<ConnectionReport> {
    if (!isConfigured(config)) throw new LlmError('config', 'Endpoint is not configured');
    let modelsMissing = false;
    try {
      let list: ModelList = { ids: [], contexts: {}, llamaCpp: false };
      try {
        list = await listModelsDetailed(endpointOf(config));
      } catch (error) {
        // Some gateways have no /models; the probe below decides.
        if (!(error instanceof LlmError) || (error.reason !== 'config' && error.reason !== 'http')) throw error;
        modelsMissing = error.status === 404;
      }
      const capabilities = await detect({ ...config, capabilities: null }, true);
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
