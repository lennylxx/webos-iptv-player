import { FetchSession, FetchStopError } from '../../utils/fetch-session';
import { schemaInstruction } from './json';
import type { ChatMessage, LlmFailureReason, NamedSchema, StructuredMode, TokenUsage } from './types';

// What a failed response body revealed, so the body itself is never kept:
// some providers echo part of the key in it.
export type LlmErrorHint = '' | 'params' | 'address';

export class LlmError extends Error {
  constructor(
    public readonly reason: LlmFailureReason,
    message: string,
    public readonly status = 0,
    public readonly retryAfterMs = 0,
    public readonly hint: LlmErrorHint = '',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  schema: NamedSchema;
  mode: StructuredMode;
  thinkingOff: boolean;
  // Adds reasoning_effort "none" to the thinking-off fields.
  effortOff?: boolean;
  // OpenAI reasoning models take max_completion_tokens and no temperature.
  reasoningParams?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage | null;
  // The endpoint needed reasoning-model parameters.
  reasoningParams: boolean;
}

// Fields llama.cpp and vLLM (chat_template_kwargs) and Ollama's native API
// (think) read to skip a model's thinking; servers that reject unknown
// fields are detected.
const THINKING_OFF_FIELDS = { chat_template_kwargs: { enable_thinking: false }, think: false };
// Some servers answer a missing or bad key with 400, not 401, so the error's
// wording decides.
const KEY_REJECTED_RE = /\bapi[ _-]?key[^.]{0,60}?(invalid|not valid|missing|incorrect|expired|required)|\b(invalid|valid|missing|incorrect|expired|provided?|no)\b[^.]{0,60}?\bapi[ _-]?key/i;
const REASONING_PARAMS_RE = /max_completion_tokens|['"`]?(max_tokens|temperature)['"`]?[^.]{0,80}(not supported|unsupported|does not support)|(not supported|unsupported)[^.]{0,80}['"`]?(max_tokens|temperature)/i;

function headersFor(endpoint: Endpoint, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const hasKey = endpoint.apiKey.trim() !== '';
  Object.keys(endpoint.headers).forEach((name) => {
    // fetch would merge a differently cased duplicate into "x, Bearer key".
    const lower = name.toLowerCase();
    if (hasKey && lower === 'authorization') return;
    if (json && lower === 'content-type') return;
    headers[name] = endpoint.headers[name];
  });
  if (json) headers['Content-Type'] = 'application/json';
  if (hasKey) headers.Authorization = `Bearer ${endpoint.apiKey.trim()}`;
  return headers;
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  if (isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

// The message of an OpenAI-style error body (also when the body is a list of
// errors), or the body itself when it isn't JSON.
function errorMessageOf(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const fields = value as Record<string, unknown>;
      ['error', 'message', 'detail', 'code', 'status', 'type'].forEach((key) => collect(fields[key]));
    }
  };
  collect(parsed);
  return parts.join(' ');
}

function failureFor(status: number, body: string): LlmFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && KEY_REJECTED_RE.test(errorMessageOf(body))) return 'auth';
  if (status === 429) return 'quota';
  if (status === 404) return 'config';
  return 'http';
}

async function send(endpoint: Endpoint, path: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
  const session = new FetchSession(`${endpoint.baseUrl}${path}`, { timeout: endpoint.timeoutMs, signal });
  try {
    let response: Response;
    try {
      response = await session.open(init);
    } catch (error) {
      if (error instanceof FetchStopError) {
        throw new LlmError(error.reason === 'timeout' ? 'timeout' : 'cancelled', error.message);
      }
      // A rejected fetch is DNS, TLS, refused connection, or CORS.
      throw new LlmError('network', 'Request failed');
    }
    let text: string;
    try {
      text = new TextDecoder().decode(await session.readBody());
    } catch (error) {
      if (error instanceof FetchStopError) {
        throw new LlmError(error.reason === 'timeout' ? 'timeout' : 'cancelled', error.message);
      }
      throw new LlmError('network', 'Reading the response failed');
    }
    if (!response.ok) {
      throw new LlmError(
        failureFor(response.status, text),
        `HTTP ${response.status}`,
        response.status,
        response.status === 429 || response.status === 503 ? retryAfterMs(response) : 0,
        response.status === 400 && REASONING_PARAMS_RE.test(text) ? 'params' : '',
      );
    }
    return text;
  } finally {
    session.close();
  }
}

export function buildChatBody(request: ChatRequest): Record<string, unknown> {
  const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
  if (request.mode !== 'json_schema') {
    // json_object mode also needs the word "JSON" in the prompt on OpenAI.
    // Some chat templates reject any system message but a single leading one.
    const instruction = schemaInstruction(request.schema.schema);
    if (messages.length && messages[0].role === 'system') {
      messages[0].content = `${messages[0].content}\n\n${instruction}`;
    } else {
      messages.unshift({ role: 'system', content: instruction });
    }
  }
  const body: Record<string, unknown> = { model: request.model, messages, stream: false };
  if (!request.reasoningParams) body.temperature = request.temperature ?? 0;
  if (request.maxTokens) body[request.reasoningParams ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens;
  if (request.mode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.schema.name, schema: request.schema.schema },
    };
  } else if (request.mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (request.thinkingOff) {
    Object.keys(THINKING_OFF_FIELDS).forEach((key) => {
      body[key] = THINKING_OFF_FIELDS[key as keyof typeof THINKING_OFF_FIELDS];
    });
    if (request.effortOff) body.reasoning_effort = 'none';
  }
  return body;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : '')).join('');
  }
  return '';
}

function usageOf(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  return input || output ? { inputTokens: input, outputTokens: output } : null;
}

export async function chatCompletion(endpoint: Endpoint, request: ChatRequest): Promise<ChatResult> {
  let reasoningParams = request.reasoningParams === true;
  let text: string;
  try {
    text = await postChat(endpoint, { ...request, reasoningParams });
  } catch (error) {
    if (reasoningParams || !(error instanceof LlmError) || error.hint !== 'params') throw error;
    reasoningParams = true;
    text = await postChat(endpoint, { ...request, reasoningParams });
  }
  let parsed: { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new LlmError('http', 'Response is not JSON');
  }
  const message = parsed.choices && parsed.choices[0] && parsed.choices[0].message;
  return { text: contentText(message && message.content), usage: usageOf(parsed.usage), reasoningParams };
}

function postChat(endpoint: Endpoint, request: ChatRequest): Promise<string> {
  return send(endpoint, '/chat/completions', {
    method: 'POST',
    headers: headersFor(endpoint, true),
    body: JSON.stringify(buildChatBody(request)),
  }, request.signal);
}

export async function listModels(endpoint: Endpoint, signal?: AbortSignal): Promise<string[]> {
  const text = await send(endpoint, '/models', { method: 'GET', headers: headersFor(endpoint, false) }, signal);
  let parsed: { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown; name?: unknown; model?: unknown }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new LlmError('http', 'Response is not JSON');
  }
  const ids: string[] = [];
  (parsed.data ?? []).forEach((m) => { if (typeof m.id === 'string') ids.push(m.id); });
  // llama.cpp also answers with an Ollama-style `models` list.
  if (!ids.length) {
    (parsed.models ?? []).forEach((m) => {
      const id = typeof m.id === 'string' ? m.id : typeof m.model === 'string' ? m.model : m.name;
      if (typeof id === 'string') ids.push(id);
    });
  }
  // Some servers list ids as "models/<id>" but takes the bare id in requests.
  return ids.map((id) => id.replace(/^models\//, '')).filter((id, i, all) => all.indexOf(id) === i).sort();
}
