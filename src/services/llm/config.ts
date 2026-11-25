import { contentHash } from './hash';
import type { LlmCapabilities, LlmConfig, ReasoningEffort, StructuredMode } from './types';

export type EndpointKind = 'local' | 'remote';

export interface EndpointProfile {
  kind: EndpointKind;
  concurrency: number;
  timeoutMs: number;
  // Send chat_template_kwargs, the field LAN servers' chat templates read to skip a model's thinking.
  preferThinkingOff: boolean;
}

// Rate limits come from the server itself: a 429 pauses the queue for the wait it names.
const PROFILES: Record<EndpointKind, EndpointProfile> = {
  local: { kind: 'local', concurrency: 1, timeoutMs: 180000, preferThinkingOff: true },
  remote: { kind: 'remote', concurrency: 2, timeoutMs: 90000, preferThinkingOff: false },
};

// Context size until one is picked or Test connection reads the server's;
// a saved contextTokens of 0 stands for it.
export const DEFAULT_CONTEXT_TOKENS = 16000;
// The default on a LAN server: some local servers cut a longer prompt short
// instead of refusing it.
export const LOCAL_DEFAULT_CONTEXT_TOKENS = 8192;

// Features the user starts by hand; the AI switch alone turns them on.
// Features that run on their own need their own toggle in `features`.
const ON_DEMAND_FEATURES = [
  'subtitle-translation', 'subtitle-title', 'epg-match', 'search-ask', 'parental-suggestions', 'epg-translation',
  'vod-translation',
];

export function featureEnabled(config: LlmConfig, feature: string): boolean {
  return config.features[feature] === true || ON_DEMAND_FEATURES.indexOf(feature) >= 0;
}

const MODES: readonly StructuredMode[] = ['json_schema', 'json_object', 'prompt'];
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low'];
export const MIN_CONTEXT_TOKENS = 2048;
// The largest Context size Settings offers.
const MAX_CONTEXT_TOKENS = 128000;
// A reply larger than this may exceed what a server lets a model write at once.
const MAX_REPLY_TOKENS = 8192;
// Items a batch job sends at most at the 16k context size; a larger context takes more.
const BATCH_ITEMS = 200;
const BATCH_ITEMS_CONTEXT = 16000;

function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : '';
}

function isLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || /\.(local|lan|home|internal)$/.test(host)) return true;
  // A single-label name only resolves on the home network.
  if (host.indexOf('.') < 0 && host.charAt(0) !== '[') return true;
  if (host.charAt(0) === '[') return host === '[::1]' || /^\[f[cd]/.test(host) || /^\[fe80:/.test(host);
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return false;
  const a = Number(ip[1]);
  const b = Number(ip[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** Request limits and local-model handling inferred from where the endpoint lives. */
export function endpointProfile(baseUrl: string): EndpointProfile {
  return isLocalHost(hostOf(baseUrl)) ? PROFILES.local : PROFILES.remote;
}

/** The Context size a server starts with until one is picked or reported: less on the LAN. */
export function defaultContextTokens(baseUrl: string): number {
  return endpointProfile(baseUrl).kind === 'local' ? LOCAL_DEFAULT_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS;
}

/** The prompt budget requests are sized to: the size picked or detected, else the server's default. */
export function effectiveContextTokens(config: LlmConfig): number {
  return config.contextTokens || defaultContextTokens(config.baseUrl);
}

/**
 * Whether the saved Context size was learned from the server (Test connection
 * or an overflow saves it as detected too) rather than picked by the user.
 */
export function contextLearned(config: LlmConfig): boolean {
  return config.contextTokens !== 0 && config.contextTokens === config.detectedContextTokens;
}

/** `next` with a Context size learned from `previous`'s server or model dropped, back to the default. */
export function keepContextFor(previous: LlmConfig, next: LlmConfig): LlmConfig {
  if (!contextLearned(previous) || endpointSignature(previous) === endpointSignature(next)) return next;
  return { ...next, contextTokens: 0, detectedContextTokens: 0 };
}

/**
 * A batch whose prompt overflowed the model's context, split smaller: as the
 * planner splits it at the lowered context, else in half. Never called for one item.
 */
export function splitForContext<T>(batch: readonly T[], replan: (items: readonly T[]) => T[][]): T[][] {
  const again = replan(batch);
  if (again.length > 1) return again;
  const half = Math.ceil(batch.length / 2);
  return [batch.slice(0, half), batch.slice(half)];
}

/**
 * After the batch at `index` overflowed: the batches not sent yet planned
 * again when the Context size dropped below the one they were planned with,
 * so later ones fit at once; else, or if the batch would go whole again, it
 * alone is split. Returns the Context size the batches are now planned with.
 */
export function replanAfterOverflow<T>(
  batches: T[][],
  index: number,
  planned: number,
  contextTokens: number,
  plan: (items: readonly T[], contextTokens: number) => T[][],
): number {
  const failed = batches[index];
  if (contextTokens < planned) {
    const rest: T[] = [];
    batches.slice(index).forEach((batch) => batch.forEach((item) => rest.push(item)));
    const again = plan(rest, contextTokens);
    batches.splice(index, batches.length - index, ...again);
    const first = batches[index];
    if (first && first.length >= failed.length && failed.every((item) => first.indexOf(item) >= 0)) {
      batches.splice(index, 1, ...splitForContext(first, (items) => plan(items, contextTokens)));
    }
    return contextTokens;
  }
  batches.splice(index, 1, ...splitForContext(failed, (items) => plan(items, contextTokens)));
  return planned;
}

/**
 * The most items a batch of a background job holds: 200 at 16k, more in step
 * with a larger context, while their replies stay within MAX_REPLY_TOKENS.
 */
export function batchItemLimit(
  contextTokens: number,
  replyTokensPerItem: number,
  replyOverhead: number,
  // The model's output cap, where known: a reply covering every item stays within it.
  replyCap = 0,
): number {
  const scaled = Math.floor((BATCH_ITEMS * contextTokens) / BATCH_ITEMS_CONTEXT);
  const fits = Math.floor((MAX_REPLY_TOKENS - replyOverhead) / replyTokensPerItem);
  const limit = Math.max(BATCH_ITEMS, Math.min(scaled, fits));
  return replyCap > 0 ? Math.max(1, Math.min(limit, Math.floor((replyCap - replyOverhead) / replyTokensPerItem))) : limit;
}

export function defaultLlmConfig(): LlmConfig {
  return {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    extraHeaders: '',
    contextTokens: 0,
    detectedContextTokens: 0,
    dailyRequestCap: 0,
    dailyTokenCap: 0,
    features: {},
    capabilities: null,
  };
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function capabilities(value: unknown): LlmCapabilities | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LlmCapabilities>;
  if (typeof raw.signature !== 'string' || MODES.indexOf(raw.structured as StructuredMode) < 0) return null;
  return {
    signature: raw.signature,
    structured: raw.structured as StructuredMode,
    effort: EFFORTS.indexOf(raw.effort as ReasoningEffort) >= 0 ? raw.effort as ReasoningEffort : '',
    thinkingFields: raw.thinkingFields === true,
    maxCompletionTokens: raw.maxCompletionTokens === true,
    maxOutputTokens: count(raw.maxOutputTokens, 0),
    checkedAt: count(raw.checkedAt, 0),
  };
}

export function normalizeLlmConfig(raw: unknown): LlmConfig {
  const base = defaultLlmConfig();
  if (!raw || typeof raw !== 'object') return base;
  const value = raw as Partial<Record<keyof LlmConfig, unknown>>;
  const features: Record<string, boolean> = {};
  if (value.features && typeof value.features === 'object') {
    const source = value.features as Record<string, unknown>;
    Object.keys(source).forEach((key) => {
      if (typeof source[key] === 'boolean') features[key] = source[key] as boolean;
    });
  }
  return {
    enabled: value.enabled === true,
    baseUrl: str(value.baseUrl, base.baseUrl),
    model: str(value.model, base.model),
    apiKey: str(value.apiKey, ''),
    extraHeaders: str(value.extraHeaders, ''),
    // 0 keeps the server's default; any other size clamps to what Settings offers.
    contextTokens: value.contextTokens === 0 ? 0 : count(value.contextTokens, base.contextTokens, MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS),
    detectedContextTokens: count(value.detectedContextTokens, 0),
    dailyRequestCap: count(value.dailyRequestCap, 0),
    dailyTokenCap: count(value.dailyTokenCap, 0),
    features,
    capabilities: capabilities(value.capabilities),
  };
}

/**
 * The server URL to keep: with the http:// a remote-typed address usually
 * leaves out ("192.168.1.5:8080/v1"), cleaned like normalizeBaseUrl.
 */
export function completeServerUrl(url: string): string {
  const text = normalizeBaseUrl(url);
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text}`;
}

/** The base URL as entered, without trailing slashes or a pasted `/chat/completions`; nothing is added. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

/** scheme://host:port, the part a key must never leave without being re-entered. */
export function originOf(baseUrl: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(completeServerUrl(baseUrl));
  return match ? match[1].toLowerCase() : baseUrl.trim().toLowerCase();
}

export function endpointSignature(config: LlmConfig): string {
  return `${normalizeBaseUrl(config.baseUrl)}|${config.model.trim()}`;
}

/** What detected capabilities belong to: the server, the model, and the key (another key may mean another plan). */
export function capabilitySignature(config: LlmConfig): string {
  return `${endpointSignature(config)}|${contentHash([config.apiKey.trim()])}`;
}

export function isConfigured(config: LlmConfig): boolean {
  return normalizeBaseUrl(config.baseUrl) !== '' && config.model.trim() !== '';
}

/**
 * Parses "Name: value" headers split by lines or by a ";" that starts another
 * header, so a value may itself hold ";". Skips malformed names and values
 * fetch would reject (outside Latin-1).
 */
export function parseExtraHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  text.split(/;(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+\s*:)|[\r\n]+/).forEach((line) => {
    const at = line.indexOf(':');
    if (at <= 0) return;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/;$/, '').trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || !value || /[^\x20-\xff]/.test(value)) return;
    headers[name] = value;
  });
  return headers;
}
