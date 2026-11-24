import type { LlmCapabilities, LlmConfig, StructuredMode } from './types';

export type EndpointKind = 'local' | 'remote';

export interface EndpointProfile {
  kind: EndpointKind;
  concurrency: number;
  timeoutMs: number;
  // Ask the server to skip the model's thinking, when it accepts the fields.
  preferThinkingOff: boolean;
}

// Rate limits come from the server itself: a 429 pauses the queue for its Retry-After.
const PROFILES: Record<EndpointKind, EndpointProfile> = {
  local: { kind: 'local', concurrency: 1, timeoutMs: 180000, preferThinkingOff: true },
  remote: { kind: 'remote', concurrency: 2, timeoutMs: 90000, preferThinkingOff: false },
};

// Context size until one is picked or Test connection reads the server's.
export const DEFAULT_CONTEXT_TOKENS = 16000;

// Features the user starts by hand; the AI switch alone turns them on.
// Features that run on their own need their own toggle in `features`.
const ON_DEMAND_FEATURES = ['subtitle-translation', 'subtitle-title', 'epg-match', 'search-ask'];

export function featureEnabled(config: LlmConfig, feature: string): boolean {
  return config.features[feature] === true || ON_DEMAND_FEATURES.indexOf(feature) >= 0;
}

const MODES: readonly StructuredMode[] = ['json_schema', 'json_object', 'prompt'];
const MIN_CONTEXT_TOKENS = 2048;
// The largest Context size Settings offers.
const MAX_CONTEXT_TOKENS = 128000;

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

export function defaultLlmConfig(): LlmConfig {
  return {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    extraHeaders: '',
    contextTokens: DEFAULT_CONTEXT_TOKENS,
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
    thinkingOff: raw.thinkingOff === true,
    effortOff: raw.effortOff === true,
    reasoningParams: raw.reasoningParams === true,
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
    contextTokens: count(value.contextTokens, base.contextTokens, MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS),
    detectedContextTokens: count(value.detectedContextTokens, 0),
    dailyRequestCap: count(value.dailyRequestCap, 0),
    dailyTokenCap: count(value.dailyTokenCap, 0),
    features,
    capabilities: capabilities(value.capabilities),
  };
}

/** Adds the http:// a remote-typed address usually leaves out ("192.168.1.5:8080/v1"). */
export function completeServerUrl(url: string): string {
  const text = url.trim();
  if (!text || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text}`;
}

/** The base URL without trailing slashes or a pasted `/chat/completions`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
}

/** scheme://host:port, the part a key must never leave without being re-entered. */
export function originOf(baseUrl: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(completeServerUrl(baseUrl));
  return match ? match[1].toLowerCase() : baseUrl.trim().toLowerCase();
}

export function endpointSignature(config: LlmConfig): string {
  return `${normalizeBaseUrl(config.baseUrl)}|${config.model.trim()}`;
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
