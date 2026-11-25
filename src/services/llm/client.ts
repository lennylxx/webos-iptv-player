import { FetchSession, FetchStopError } from '../../utils/fetch-session';
import { schemaInstruction, stripThinking } from './json';
import { exhaustedResetMs, hasQuotaCode, headerWaitMs, namesAccountLimit, namesMoney, namesQuota, rateVerdict } from './rate';
import type { ChatMessage, LlmFailureReason, NamedSchema, ReasoningEffort, StructuredMode, TokenUsage } from './types';

// What a failed response body revealed, so the body itself is never kept:
// some servers echo part of the key in it.
// - max-tokens: the server wants max_completion_tokens instead of max_tokens.
// - effort: the reasoning_effort value or another thinking switch was refused.
// - thinking-fields: chat_template_kwargs was refused by name.
// - response-format: the response_format (JSON mode) was refused.
// - unknown-field: an unnamed or unrecognized request field was refused.
// - output-cap: the reply budget is over the model's output cap, which the error names.
// - permission: the account may not use the model (403 that isn't a bad key).
// - model: the server named the model as missing (beside a plain 404).
// - too-large: one request over a per-request token cap; send less, don't wait.
// - overloaded: a 502/503/529 or an "overloaded" server error, worth waiting out.
// - template: a server error from the chat template, not worth retrying.
// - internal: any other server error, worth a retry or two.
// - address: neither /models nor /chat/completions exists at the base URL.
const ERROR_HINTS = [
  'max-tokens', 'output-cap', 'effort', 'thinking-fields', 'response-format', 'unknown-field', 'permission',
  'model', 'too-large', 'overloaded', 'template', 'internal', 'address',
] as const;
export type LlmErrorHint = '' | typeof ERROR_HINTS[number];

/** Whether a value is one of the hints, so diagnostics only ever log one of them. */
export function isErrorHint(value: unknown): value is LlmErrorHint {
  return (ERROR_HINTS as readonly unknown[]).indexOf(value) >= 0;
}

export class LlmError extends Error {
  constructor(
    public readonly reason: LlmFailureReason,
    message: string,
    public readonly status = 0,
    public readonly retryAfterMs = 0,
    public readonly hint: LlmErrorHint = '',
    // For a 'context' failure, the context size the server named; 0 when it didn't.
    public readonly contextTokens = 0,
    // For an 'output-cap' failure, the most the server lets a reply be.
    public readonly outputTokens = 0,
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
  // Absent for a plain-text reply.
  schema?: NamedSchema;
  mode: StructuredMode | 'text';
  // Sent as reasoning_effort; '' sends none.
  effort?: ReasoningEffort | '';
  // chat_template_kwargs, which LAN servers' chat templates read to skip a model's thinking.
  thinkingFields?: boolean;
  // Names the output budget max_completion_tokens instead of max_tokens.
  maxCompletionTokens?: boolean;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  // The reply's text parts, thinking removed.
  text: string;
  usage: TokenUsage | null;
  // The server needed max_completion_tokens.
  maxCompletionTokens: boolean;
  finishReason: string;
  // The reply used the server's last request for a moment; hold others this long.
  pauseMs: number;
  // The model still thought (reasoning beside or inside the reply), for diagnostics only.
  thought: boolean;
}

const THINKING_FIELDS = { chat_template_kwargs: { enable_thinking: false } };
// Some servers answer a missing or bad key with 400, not 401, so the error's
// wording decides.
const KEY_REJECTED_RE = /\bapi[ _-]?key[^.]{0,60}?(invalid|not valid|missing|incorrect|expired|required)|\b(invalid|valid|missing|incorrect|expired|provided?|no)\b[^.]{0,60}?\bapi[ _-]?key|\bapi key\b|authenticat|authoriz|\bbearer\b/i;
const AUTH_TYPE_RE = /\bauthentication_error\b/i;
const PERMISSION_RE = /permission|access denied|real[ -]?name|实名|model access|access (to|the) (this |the )?model|not enabled for (this |the |your )?(project|organization|account)|unsupported_country|\b(country|region|territory|location)\b[^.]{0,40}\b(not supported|unsupported|not available)\b|not (supported|available) in your (country|region|territory|location)/i;
// "Blocked" or "flagged" counts only beside what was blocked, so a firewall's
// "you have been blocked" or a blocked key isn't read as a content block.
const SAFETY_RE = /content[_ ]policy|content[ _-]?filter|safety (system|filter|settings)|usage polic|responsible ai|inappropriate content|data_inspection_failed|sensitive (information|content)|SensitiveContentDetected|\b(content|prompt|output|response|input|completion)\b[^.]{0,40}\b(blocked|flagged)\b|\b(blocked|flagged)\b[^.]{0,40}\b(safety|content|policy)\b/i;
const SAFETY_STATUSES = [400, 403, 422];
const MODEL_MISSING_RE = /model_not_found|\bmodel\b[^.]{0,80}?(does not exist|not found|not exist)|invalid model|unknown model/i;
const TOO_LARGE_RE = /request too large/i;
const LIMIT_RE = /\blimit\b\D{0,10}(\d+)/i;
const REQUESTED_RE = /\brequested\b\D{0,10}(\d+)/i;
const THROTTLE_RE = /rate[ _-]?limit|throttl|too many requests|capacity exceeded|resource[ _]exhausted|\bper[ _-]?min(ute)?\b|\btpm\b/i;
const TIMEOUT_RE = /timed out|timeout/i;
const TEMPLATE_RE = /template|jinja|raise_exception/i;
const THINKING_NAMED_RE = /reasoning|effort|thinking/i;
const MAX_TOKENS_RE = /max_completion_tokens|\bmax_tokens\b[^.]{0,80}(not supported|unsupported|unknown|unrecognized|not allowed|not permitted|deprecated)|(not supported|unsupported|unknown|unrecognized)[^.]{0,80}\bmax_tokens\b/i;
const FIELDS_RE = /chat_template_kwargs|enable_thinking/i;
const EFFORT_RE = /reasoning|effort|thinking|\bnone\b/i;
const RESPONSE_FORMAT_RE = /response_format|json_schema|json_object|structured output/i;
const UNKNOWN_FIELD_RE = /unknown (field|parameter|argument|name)|unrecognized|extra (fields|inputs)|additional propert|not permitted|unexpected (field|keyword|property|argument)|cannot find field/i;
const OVERLOADED_RE = /overloaded|temporarily unavailable|out of capacity/i;
const CONTEXT_RE = /exceed_context_size_error|context_length_exceeded|maximum context length|context[ _](size|length|window|limit)|prompt is too long|input is too long|too many (input )?tokens|exceeds?\b[^.]{0,60}\b(context|maximum number of tokens)|length is \d+ while limit is \d+|maximum input length|\btoken limit\b|\binputs?`?\s+tokens\b[^.]{0,60}must be <= \d+|input length should be|range of input length|maximum model length|\bprompt\b[^.]{0,40}\+[^.]{0,40}\bmax_\w*tokens|\bmax_\w*tokens\b[^.]{0,40}\+[^.]{0,40}\bprompt|\binputs?`?\s+must have less than \d+ tokens|input tokens exceed[^.]{0,40}\blimit\b/i;
// A 429 is a throttle unless it names a context overflow outright.
const EXPLICIT_CONTEXT_RE = /context_length_exceeded|exceed_context_size_error|maximum context length/i;
// The reply budget's own bound, which names the context only in passing.
const BUDGET_FIELD_RE = /\b(max_tokens|max_new_tokens|max_completion_tokens)\b`?\s*(must|should|is too|exceeds?|cannot|can't|is greater)/i;
const INPUT_RE = /\binputs?`?\s+tokens\b|\binput length\b|\bprompt\b|\bmessages?\b/i;
const OUTPUT_FIELD_RE = /\b(max_tokens|max_new_tokens|max_completion_tokens|maxOutputTokens|max_output_tokens)\b/i;
// How an output cap is worded right after the field: "<= 2048", "[1, 8192]",
// "at most 16384", "less than or equal to `8192`", "100000 > 64000",
// "between 1 and 4000", "cannot exceed 4000", "to 65537 (exclusive)".
const OUTPUT_BOUND_RES: Array<[RegExp, number]> = [
  [/<=\s*`?(\d+)/, 0],
  [/\[\s*\d+\s*,\s*(\d+)\s*\]/, 0],
  [/\bat most\s*`?(\d+)/i, 0],
  [/less than or equal to\s*`?(\d+)/i, 0],
  [/\d+\s*>\s*(\d+)/, 0],
  [/\bbetween\s+\d+\s+and\s+(\d+)/i, 0],
  [/\b(?:cannot|can't|must not|may not) exceed\s*`?(\d+)/i, 0],
  // The gap names no context, window, input, or prompt: that limit isn't the reply's.
  [/\b(?:exceeds?|greater than)\b(?:(?!context|window|input|prompt)[^.;]){0,30}?\b(?:limit|maximum)\b[:\s]*(?:of\s*)?`?(\d+)/i, 0],
  [/\bmaximum\b(?:(?!context|window|input|prompt)[^.;]){0,40}?\bis\s*`?(\d+)/i, 0],
  [/\bto\s+(\d+)\s*\(exclusive\)/i, -1],
  [/\bto\s+(\d+)\s*\(inclusive\)/i, 0],
];
// Another request field named before the bound: the bound is that field's.
const OTHER_FIELD_RE = /\b(temperature|top_p|top_k|presence_penalty|frequency_penalty|seed|n|stop|logprobs)\b|\b[a-z]+_[a-z_]+\b/i;
// Smaller than any real output cap: a bound of something else, not learned.
const MIN_OUTPUT_CAP = 64;

// A limit per minute or per day, of the account, or of the context: not the model's output cap.
function namesOtherLimit(text: string): boolean {
  return THROTTLE_RE.test(text) || namesAccountLimit(text) || /\bcontext\b|\bwindow\b/i.test(text);
}

function boundIn(text: string): number {
  for (const [re, offset] of OUTPUT_BOUND_RES) {
    const match = re.exec(text);
    if (match && Number(match[1]) > 0) return Number(match[1]) + offset;
  }
  return 0;
}

/**
 * The output cap a refused reply budget names, read only right after the
 * output field: in its clause, or the next sentence when that names no other
 * field. A validation error's `loc` ending in the field gives its `ctx.le`
 * (`lt` is one more). 0 when none, or one too small to be an output cap.
 */
function namedOutputCap(body: string): number {
  let found = 0;
  // Validation errors, at the top or inside `message`/`error`, also in a list.
  const details: unknown[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, depth + 1));
      return;
    }
    const fields = value as Record<string, unknown>;
    if (Array.isArray(fields.detail)) fields.detail.forEach((item) => details.push(item));
    collect(fields.message, depth + 1);
    collect(fields.error, depth + 1);
  };
  try {
    collect(JSON.parse(body.trim()), 0);
  } catch {
    // Not JSON; the text below may still name it.
  }
  details.forEach((item) => {
    const entry = item as { loc?: unknown; ctx?: { le?: unknown; lt?: unknown }; msg?: unknown };
    const loc = entry && Array.isArray(entry.loc) ? entry.loc : [];
    if (found || !OUTPUT_FIELD_RE.test(String(loc[loc.length - 1] ?? ''))) return;
    const ctx = entry.ctx || {};
    if (typeof ctx.le === 'number') found = ctx.le;
    else if (typeof ctx.lt === 'number') found = ctx.lt - 1;
    else if (typeof entry.msg === 'string') {
      const below = /less than\s+(\d+)/i.exec(entry.msg);
      found = boundIn(entry.msg) || (below ? Number(below[1]) - 1 : 0);
    }
  });
  if (!found) {
    const prose = errorMessageOf(body, true);
    const field = OUTPUT_FIELD_RE.exec(prose);
    if (field) {
      const before = prose.slice(0, field.index);
      const clauseStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf(';')) + 1;
      const rest = prose.slice(field.index + field[0].length);
      const clauseEnd = rest.search(/[.;]\s|;|$/);
      const clause = rest.slice(0, clauseEnd);
      // The prompt in the same clause: the context, not the output cap.
      const own = before.slice(clauseStart) + clause;
      if (!INPUT_RE.test(own) && !namesOtherLimit(own)) {
        found = boundIn(clause);
        if (!found) {
          const next = rest.slice(clauseEnd).replace(/^[.;]\s*/, '').split(/[.;]\s/)[0];
          // A sentence that names another field gives that field's bound; the output field itself may recur.
          const others = next.replace(new RegExp(OUTPUT_FIELD_RE.source, 'gi'), '');
          if (!OTHER_FIELD_RE.test(others) && !INPUT_RE.test(next) && !namesOtherLimit(next)) found = boundIn(next);
        }
      }
    }
  }
  return found >= MIN_OUTPUT_CAP ? found : 0;
}
const LIMIT_REACHED_RE = /\blimit\b|exceeded|reached|exhausted/i;
// A field value over its own length limit, not the prompt over the context.
const FIELD_TOO_LONG_RE = /string too long|string_above_max_length/i;
const CONTEXT_SIZE_RES = [
  /limit is (\d{3,})/i,
  /maximum (?:context|input) length is (\d{3,})/i,
  /context[ _](?:size|length|window|limit)[^\d]{0,40}(\d{3,})/i,
  /(\d{3,})\s*(?:tokens?\s*)?(?:maximum )?context (?:length|size|window)/i,
  /token limit\D{0,5}(\d{3,})/i,
  /must be <= (\d{3,})/i,
  /input length should be \[\s*\d+\s*,\s*(\d{3,})\s*\]/i,
  /maximum model length of (\d{3,})/i,
  /must have less than (\d{3,}) tokens/i,
  /input tokens exceed[^.]{0,40}\blimit of (\d{3,})/i,
  /\blimit\s*(?:of|:)\s*`?(\d{3,})/i,
];
const TIMEOUT_STATUSES = [408, 504, 522, 524];
const OVERLOADED_STATUSES = [502, 503, 529];

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

// Keys whose strings a person wrote, as opposed to codes and types.
const PROSE_KEYS = ['error', 'message', 'detail', 'msg'];
const ERROR_KEYS = ['error', 'message', 'detail', 'msg', 'loc', 'code', 'status', 'type', 'param', 'metadata', 'error_type'];

/**
 * The text of an error body in any common shape (a list of errors, `error`
 * as an object or a string, top-level message/detail/code/type, metadata, a
 * validation error's `detail[].msg` and `loc`), or the body itself when it
 * isn't JSON. With `prose`, only the human-written strings: no codes,
 * statuses, or types, whose numbers aren't sizes. Used only to classify the failure.
 */
export function errorMessageOf(body: string, prose = false): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return body;
  }
  const parts: string[] = [];
  const keys = prose ? PROSE_KEYS : ERROR_KEYS;
  const collect = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number') {
      if (!prose) parts.push(String(value));
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const fields = value as Record<string, unknown>;
      keys.forEach((key) => collect(fields[key]));
    }
  };
  collect(parsed);
  return parts.join(' ');
}

interface Failure {
  reason: LlmFailureReason;
  hint: LlmErrorHint;
  retryAfterMs: number;
  contextTokens?: number;
  outputTokens?: number;
}

/** The context size an overflow error names, as an n_ctx field or in its text; 0 when none. */
function namedContext(body: string): number {
  const message = errorMessageOf(body, true);
  let found = 0;
  try {
    const walk = (value: unknown, depth: number): void => {
      if (found || depth > 6 || !value || typeof value !== 'object') return;
      const fields = value as Record<string, unknown>;
      if (typeof fields.n_ctx === 'number' && fields.n_ctx > 0) found = Math.floor(fields.n_ctx);
      Object.keys(fields).forEach((key) => walk(fields[key], depth + 1));
    };
    walk(JSON.parse(body.trim()), 0);
  } catch {
    // Not JSON; the text may still name it.
  }
  if (found) return found;
  for (const re of CONTEXT_SIZE_RES) {
    const match = re.exec(message);
    if (match) return Number(match[1]);
  }
  return 0;
}

/**
 * Why a request failed, from its status, error body, and the wait its headers
 * ask for: the body's codes, types, and params first (they are part of the
 * text read here), then its wording, then the status alone. Only the
 * classification is kept, never the body.
 */
export function classifyFailure(status: number, body: string, headerWait = 0): Failure {
  const message = errorMessageOf(body);
  const failure = (reason: LlmFailureReason, hint: LlmErrorHint = '', retryAfterMs = 0): Failure =>
    ({ reason, hint, retryAfterMs });
  const rate = (): Failure => {
    const verdict = rateVerdict(status, body, headerWait);
    return verdict.exhausted ? failure('quota') : failure('rate', '', verdict.waitMs);
  };
  if (status === 401) return failure('auth');
  if (status < 500 && AUTH_TYPE_RE.test(message)) return failure('auth');
  // A blocked prompt: nothing else about the request will get it through.
  if (SAFETY_STATUSES.indexOf(status) >= 0 && SAFETY_RE.test(message)) return failure('blocked');
  if (status === 400 && KEY_REJECTED_RE.test(message)) return failure('auth');
  // A spent account before anything about the request: a "token limit" per day, month, or plan isn't the context.
  if (status === 402 || hasQuotaCode(body) || (status === 403 && namesQuota(body))) return rate();
  // One request over a per-request token cap: smaller batches, not a wait. A
  // limit merely reached ("Limit 200000, Used 199000, Requested 3200") is a throttle.
  const limit = LIMIT_RE.exec(message);
  const requested = REQUESTED_RE.exec(message);
  const overCap = !!limit && !!requested && Number(requested[1]) > Number(limit[1]);
  if ((status === 400 || status === 429 || status === 413) && (TOO_LARGE_RE.test(message) || (status === 429 && overCap))) {
    return { ...failure('context', 'too-large'), contextTokens: limit ? Number(limit[1]) : 0 };
  }
  // The reply budget over the model's output cap: the request goes again within it.
  const outputCap = status === 400 || status === 422 ? namedOutputCap(body) : 0;
  if (outputCap) return { ...failure('http', 'output-cap'), outputTokens: outputCap };
  const overflow = (status === 429 ? EXPLICIT_CONTEXT_RE.test(message) : CONTEXT_RE.test(message))
    && !FIELD_TOO_LONG_RE.test(message)
    && !namesAccountLimit(message)
    // A per-minute limit is a throttle, whatever it counts.
    && !(status !== 429 && THROTTLE_RE.test(message) && !EXPLICIT_CONTEXT_RE.test(message))
    && !(BUDGET_FIELD_RE.test(message) && !INPUT_RE.test(message));
  if (overflow) {
    return { ...failure('context'), contextTokens: namedContext(body) };
  }
  const code429 = /"code"\s*:\s*"?429\b/.test(body);
  if (status === 429 || code429) return rate();
  // Arrears often read "access denied": the money decides first.
  if (status >= 400 && status < 500 && namesMoney(message)) return failure('quota');
  if (status === 403 || PERMISSION_RE.test(message)) {
    return status !== 403 || (!AUTH_TYPE_RE.test(message) && PERMISSION_RE.test(message))
      ? failure('config', 'permission')
      : failure('auth');
  }
  if (status === 404 || MODEL_MISSING_RE.test(message)) return failure('config', status === 404 ? '' : 'model');
  if (TIMEOUT_STATUSES.indexOf(status) >= 0) return failure('timeout', '', headerWait);
  if (THROTTLE_RE.test(message)) return rate();
  // A gateway's 502/503 that mentions its upstream timing out is still worth a retry.
  if (OVERLOADED_STATUSES.indexOf(status) >= 0 || OVERLOADED_RE.test(message)) {
    return failure('http', 'overloaded', headerWait);
  }
  if (status >= 500 && TIMEOUT_RE.test(message)) return failure('timeout', '', headerWait);
  if (status >= 500) {
    // A chat template that throws on a thinking control it doesn't know is a ladder step, not an outage.
    if (FIELDS_RE.test(message)) return failure('http', 'thinking-fields');
    if (THINKING_NAMED_RE.test(message)) return failure('http', 'effort');
    return failure('http', TEMPLATE_RE.test(message) ? 'template' : 'internal');
  }
  const hint = status >= 400 ? shapeHint(message) : '';
  // A 4xx about the account's money or limits that names no part of the request.
  if (!hint && status >= 400 && (namesMoney(message) || (namesAccountLimit(message) && LIMIT_REACHED_RE.test(message)))) {
    return failure('quota');
  }
  return failure('http', hint);
}

// Which part of the request a rejected request's error names.
function shapeHint(message: string): LlmErrorHint {
  if (MAX_TOKENS_RE.test(message)) return 'max-tokens';
  if (FIELDS_RE.test(message)) return 'thinking-fields';
  if (RESPONSE_FORMAT_RE.test(message)) return 'response-format';
  // A field the server doesn't know at all: no other value of it will do.
  if (UNKNOWN_FIELD_RE.test(message)) return 'unknown-field';
  if (EFFORT_RE.test(message)) return 'effort';
  return '';
}

interface Answer {
  text: string;
  // How long to hold requests because this one used the server's last.
  pauseMs: number;
}

async function send(endpoint: Endpoint, path: string, init: RequestInit, signal?: AbortSignal): Promise<Answer> {
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
      const failure = classifyFailure(response.status, text, headerWaitMs(response.headers, Date.now()));
      throw new LlmError(failure.reason, `HTTP ${response.status}`, response.status, failure.retryAfterMs, failure.hint,
        failure.contextTokens || 0, failure.outputTokens || 0);
    }
    return { text, pauseMs: exhaustedResetMs(response.headers) };
  } finally {
    session.close();
  }
}

export function buildChatBody(request: ChatRequest): Record<string, unknown> {
  const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
  if (request.schema && request.mode !== 'json_schema' && request.mode !== 'text') {
    // json_object mode also needs the word "JSON" in the prompt on some servers.
    // Some chat templates reject any system message but a single leading one.
    const instruction = schemaInstruction(request.schema.schema);
    if (messages.length && messages[0].role === 'system') {
      messages[0].content = `${messages[0].content}\n\n${instruction}`;
    } else {
      messages.unshift({ role: 'system', content: instruction });
    }
  }
  const body: Record<string, unknown> = { model: request.model, messages, stream: false };
  body[request.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens;
  if (request.schema && request.mode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.schema.name, schema: request.schema.schema, strict: true },
    };
  } else if (request.mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (request.effort) body.reasoning_effort = request.effort;
  if (request.thinkingFields) {
    Object.keys(THINKING_FIELDS).forEach((key) => {
      body[key] = THINKING_FIELDS[key as keyof typeof THINKING_FIELDS];
    });
  }
  return body;
}

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'];

function hasText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return Array.isArray(value) ? value.length > 0 : !!value && typeof value === 'object';
}

// Only the text parts: reasoning parts and fields beside `content` are skipped.
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part as { type?: unknown; text?: unknown } | null;
      return item && item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    }).join('');
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
  let maxCompletionTokens = request.maxCompletionTokens === true;
  let answer: Answer;
  try {
    answer = await postChat(endpoint, { ...request, maxCompletionTokens });
  } catch (error) {
    if (maxCompletionTokens || !(error instanceof LlmError) || error.hint !== 'max-tokens') throw error;
    maxCompletionTokens = true;
    answer = await postChat(endpoint, { ...request, maxCompletionTokens });
  }
  const text = answer.text;
  let parsed: { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: unknown }>; usage?: unknown };
  try {
    parsed = JSON.parse(text.trim()) as typeof parsed;
  } catch {
    throw new LlmError('http', 'Response is not JSON');
  }
  const choice = parsed.choices && parsed.choices[0];
  if (choice && choice.finish_reason === 'content_filter') throw new LlmError('blocked', 'Reply was filtered', 200);
  const message = choice && choice.message;
  const raw = contentText(message && message.content);
  return {
    text: stripThinking(raw),
    usage: usageOf(parsed.usage),
    maxCompletionTokens,
    finishReason: choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
    pauseMs: answer.pauseMs,
    thought: /<\/?think>/.test(raw) || (!!message && REASONING_FIELDS.some((field) => hasText(message[field]))),
  };
}

function postChat(endpoint: Endpoint, request: ChatRequest): Promise<Answer> {
  return send(endpoint, '/chat/completions', {
    method: 'POST',
    headers: headersFor(endpoint, true),
    body: JSON.stringify(buildChatBody(request)),
  }, request.signal);
}

export interface ModelList {
  ids: string[];
  // Context window per model id, where the server reports one.
  contexts: Record<string, number>;
  // Output cap per model id, where the server reports one.
  outputs: Record<string, number>;
  // The training maximum per model id, where that is all the server reports.
  trainingContexts: Record<string, number>;
}

// Fields servers use for a model's context window, a loaded size before its maximum.
// The per-slot size a server runs with comes first.
const CONTEXT_FIELDS = [
  'meta.n_ctx', 'max_model_len', 'loaded_context_length', 'context_length', 'context_window', 'max_context_length',
  'max_input_tokens', 'model_info.context_window', 'top_provider.context_length', 'inputTokenLimit',
];
// The model's training maximum: a last resort, after /props.
const TRAINING_CONTEXT_FIELDS = ['meta.n_ctx_train'];
const OUTPUT_FIELDS = [
  'max_output_tokens', 'outputTokenLimit', 'max_completion_tokens', 'max_tokens',
  'model_info.max_output_tokens', 'top_provider.max_completion_tokens',
];

type ModelEntry = Record<string, unknown>;

function firstCount(entry: ModelEntry, fields: readonly string[]): number {
  for (const field of fields) {
    let value: unknown = entry;
    field.split('.').forEach((key) => {
      value = value && typeof value === 'object' ? (value as ModelEntry)[key] : undefined;
    });
    if (typeof value === 'number' && isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

export async function listModelsDetailed(endpoint: Endpoint, signal?: AbortSignal): Promise<ModelList> {
  const { text } = await send(endpoint, '/models', { method: 'GET', headers: headersFor(endpoint, false) }, signal);
  let parsed: { data?: ModelEntry[]; models?: ModelEntry[] };
  try {
    parsed = JSON.parse(text.trim()) as typeof parsed;
  } catch {
    throw new LlmError('http', 'Response is not JSON');
  }
  const entries: Array<{ id: string; entry: ModelEntry }> = [];
  (Array.isArray(parsed.data) ? parsed.data : []).forEach((m) => {
    if (m && typeof m.id === 'string') entries.push({ id: m.id, entry: m });
  });
  // Some servers answer with a `models` list keyed by model or name instead.
  if (!entries.length) {
    (Array.isArray(parsed.models) ? parsed.models : []).forEach((m) => {
      const id = m && (typeof m.id === 'string' ? m.id : typeof m.model === 'string' ? m.model : m.name);
      if (typeof id === 'string') entries.push({ id, entry: m });
    });
  }
  const contexts: Record<string, number> = {};
  const outputs: Record<string, number> = {};
  const trainingContexts: Record<string, number> = {};
  entries.forEach(({ id, entry }) => {
    // Some servers list ids as "models/<id>" but take the bare id in requests.
    const bare = id.replace(/^models\//, '');
    const context = firstCount(entry, CONTEXT_FIELDS);
    if (context && !contexts[bare]) contexts[bare] = context;
    const training = firstCount(entry, TRAINING_CONTEXT_FIELDS);
    if (training && !trainingContexts[bare]) trainingContexts[bare] = training;
    const output = firstCount(entry, OUTPUT_FIELDS);
    if (output && !outputs[bare]) outputs[bare] = output;
  });
  const ids = entries.map(({ id }) => id.replace(/^models\//, ''))
    .filter((id, i, all) => all.indexOf(id) === i).sort();
  return { ids, contexts, outputs, trainingContexts };
}

export async function listModels(endpoint: Endpoint, signal?: AbortSignal): Promise<string[]> {
  return (await listModelsDetailed(endpoint, signal)).ids;
}

/** The per-slot context a server reports on /props, beside the /v1 path; 0 when unknown. */
// /props is an optional extra: a server without it shouldn't hold Test connection for a whole timeout.
const PROPS_TIMEOUT_MS = 5000;

export async function propsContext(endpoint: Endpoint, signal?: AbortSignal): Promise<number> {
  const root = { ...endpoint, baseUrl: endpoint.baseUrl.replace(/\/v1$/, ''), timeoutMs: Math.min(endpoint.timeoutMs, PROPS_TIMEOUT_MS) };
  const { text } = await send(root, '/props', { method: 'GET', headers: headersFor(endpoint, false) }, signal);
  try {
    const props = JSON.parse(text.trim()) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
    const value = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}
