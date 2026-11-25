import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recorded } from '../../test/llm-responses';
import { buildChatBody, chatCompletion, classifyFailure, isErrorHint, listModels, listModelsDetailed, LlmError, propsContext, type ChatRequest, type Endpoint } from './client';
import {
  batchItemLimit,
  completeServerUrl,
  defaultLlmConfig,
  effectiveContextTokens,
  endpointProfile,
  isConfigured,
  normalizeBaseUrl,
  normalizeLlmConfig,
  parseExtraHeaders,
} from './config';
import type { NamedSchema } from './types';

const SCHEMA: NamedSchema = {
  name: 's1',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};
const endpoint: Endpoint = { baseUrl: 'http://host/v1', apiKey: 'k1', headers: { 'X-Test': 'a' }, timeoutMs: 5000 };
const REQUEST: ChatRequest = { model: 'm1', messages: [], schema: SCHEMA, mode: 'prompt', maxTokens: 64 };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('OpenAI-compatible client', () => {
  it('asks for JSON per structured mode and adds thinking controls only when asked', () => {
    const base = { model: 'm1', messages: [{ role: 'user' as const, content: 'hi' }], schema: SCHEMA, maxTokens: 64 };
    const strict = buildChatBody({ ...base, mode: 'json_schema' });
    expect(strict.response_format).toEqual({ type: 'json_schema', json_schema: { name: 's1', schema: SCHEMA.schema, strict: true } });
    expect(strict.messages).toHaveLength(1);
    expect(strict).not.toHaveProperty('chat_template_kwargs');
    expect(strict).not.toHaveProperty('reasoning_effort');

    const object = buildChatBody({ ...base, mode: 'json_object', effort: 'minimal', thinkingFields: true });
    expect(object.response_format).toEqual({ type: 'json_object' });
    expect((object.messages as Array<{ content: string }>)[0].content).toContain('JSON');
    expect(object.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(object.reasoning_effort).toBe('minimal');
    expect(object).not.toHaveProperty('think');
    expect(object).not.toHaveProperty('thinking');

    const prompt = buildChatBody({ ...base, mode: 'prompt' });
    expect(prompt).not.toHaveProperty('response_format');
  });

  it('always sends an output budget and no sampling parameters', () => {
    const body = buildChatBody({ model: 'm1', messages: [], mode: 'text', maxTokens: 300 });
    expect(body).toEqual({ model: 'm1', messages: [], stream: false, max_tokens: 300 });
    expect(buildChatBody({ model: 'm1', messages: [], mode: 'text', maxTokens: 300, maxCompletionTokens: true }))
      .toEqual({ model: 'm1', messages: [], stream: false, max_completion_tokens: 300 });
  });

  it('keeps a single leading system message, as some chat templates require', () => {
    const body = buildChatBody({
      model: 'm1',
      messages: [{ role: 'system', content: 'Classify.' }, { role: 'user', content: 'ch1' }],
      schema: SCHEMA,
      mode: 'prompt',
      maxTokens: 64,
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toMatch(/^Classify\.\n\n.*JSON Schema/s);
  });

  it('posts to chat/completions with the bearer key and extra headers', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }));
    const result = await chatCompletion(endpoint, { ...REQUEST, mode: 'json_schema' });
    expect(String(spy.mock.calls[0][0])).toBe('http://host/v1/chat/completions');
    const headers = spy.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k1');
    expect(headers['X-Test']).toBe('a');
    expect(result).toEqual({
      text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 3 }, maxCompletionTokens: false, finishReason: '',
      pauseMs: 0, thought: false,
    });
  });

  it('lets the API key win over an extra authorization header in any case', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await listModels({ ...endpoint, headers: { authorization: 'Basic x', 'X-Test': 'a' } });
    expect(spy.mock.calls[0][1]!.headers).toEqual({ 'X-Test': 'a', Authorization: 'Bearer k1' });
  });

  it('reads the loaded context before the model maximum', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [
      { id: 'm1', max_context_length: 32768, loaded_context_length: 4096 },
      { id: 'models/m2', max_context_length: 32768 },
    ] }));
    await expect(listModelsDetailed(endpoint)).resolves.toEqual({
      ids: ['m1', 'm2'],
      contexts: { m1: 4096, m2: 32768 },
      outputs: {},
      trainingContexts: {},
    });
  });

  it('sends no Authorization header for a keyless local server', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await listModels({ ...endpoint, apiKey: ' ' });
    expect(spy.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('maps auth errors, and a throttle with the wait its Retry-After names', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'bad key' }, 401))
      .mockResolvedValueOnce(json({ error: 'slow down' }, 429, { 'Retry-After': '7' }));
    const call = () => chatCompletion(endpoint, REQUEST);
    await expect(call()).rejects.toMatchObject({ reason: 'auth', status: 401 });
    await expect(call()).rejects.toMatchObject({ reason: 'rate', retryAfterMs: 7000 });
  });

  it('treats a 400 that names a bad or missing API key as an auth failure and keeps no response body', async () => {
    const answers: Array<[unknown, string]> = [
      [{ error: { message: 'Invalid API key.' } }, 'auth'],
      [[{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }], 'auth'],
      [{ error: { message: 'You didn\'t provide an API key.', type: 'invalid_request_error' } }, 'auth'],
      [{ error: { code: 'API_KEY_INVALID' } }, 'auth'],
      [{ detail: 'Missing API key' }, 'auth'],
      [{ error: { message: 'Unknown parameter: api_key_name.' } }, 'http'],
      [{ error: { message: 'Model m1 does not exist.' } }, 'config'],
    ];
    for (const [body, reason] of answers) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(body, 400));
      const error = await listModels(endpoint).catch((e: unknown) => e) as LlmError;
      expect(error).toMatchObject({ reason, status: 400, message: 'HTTP 400' });
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('invalid api key', { status: 400 }));
    await expect(listModels(endpoint)).rejects.toMatchObject({ reason: 'auth', status: 400 });
  });

  it('keeps an echoed key out of the error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'Incorrect API key provided: sk-k1' } }, 401));
    const error = await listModels(endpoint).catch((e: unknown) => e) as LlmError;
    expect(error.message).not.toContain('sk-k1');
    expect(JSON.stringify(error)).not.toContain('sk-k1');
  });

  it('switches to max_completion_tokens on a 400 that names it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.maxTokensUnsupported400())
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const result = await chatCompletion(endpoint, { ...REQUEST, mode: 'json_schema', maxTokens: 50 });
    const retried = JSON.parse(String(spy.mock.calls[1][1]!.body)) as Record<string, unknown>;
    expect(retried.max_completion_tokens).toBe(50);
    expect(retried).not.toHaveProperty('max_tokens');
    expect(result.maxCompletionTokens).toBe(true);
  });

  it('does not switch the budget field when only the response format is rejected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } }, 400));
    await expect(chatCompletion(endpoint, { ...REQUEST, mode: 'json_schema', maxTokens: 50 }))
      .rejects.toMatchObject({ reason: 'http', hint: 'response-format' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up on /props after a few seconds rather than the endpoint timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const pending = propsContext({ ...endpoint, timeoutMs: 180000 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed fetch as a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await listModels(endpoint).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ reason: 'network' });
  });

  it('reads the common model list formats', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ id: 'models/m2' }, { id: 'm1' }, { id: 'm1' }] }))
      .mockResolvedValueOnce(json({ models: [{ name: 'q1:8b' }, { model: 'q2' }] }));
    expect(await listModels(endpoint)).toEqual(['m1', 'm2']);
    expect(await listModels(endpoint)).toEqual(['q1:8b', 'q2']);
  });
});

describe('recorded server responses', () => {
  async function failure(response: Response): Promise<LlmError> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    return chatCompletion(endpoint, REQUEST).then(() => { throw new Error('resolved'); }, (e: unknown) => e as LlmError);
  }

  it('classifies a per-minute throttle worded as a quota as a throttle with its retry delay', async () => {
    await expect(failure(recorded.perMinute429())).resolves.toMatchObject({ reason: 'rate', status: 429, retryAfterMs: 24000 });
  });

  it('classifies spent daily, billing, and balance quotas as exhausted', async () => {
    await expect(failure(recorded.perDay429())).resolves.toMatchObject({ reason: 'quota', status: 429 });
    await expect(failure(recorded.insufficientQuota429())).resolves.toMatchObject({ reason: 'quota' });
    await expect(failure(recorded.balance402())).resolves.toMatchObject({ reason: 'quota', status: 402 });
    await expect(failure(recorded.balance403())).resolves.toMatchObject({ reason: 'quota', status: 403 });
  });

  it('counts a throttle whose wait is over an hour as a spent quota', async () => {
    await expect(failure(recorded.plain429({ 'Retry-After': '7200' }))).resolves.toMatchObject({ reason: 'quota' });
    await expect(failure(recorded.plain429())).resolves.toMatchObject({ reason: 'rate', retryAfterMs: 0 });
  });

  it('marks an overloaded server for a retry', async () => {
    await expect(failure(recorded.overloaded529())).resolves.toMatchObject({ reason: 'http', status: 529, hint: 'overloaded' });
  });

  it('reads a rejected key from every error shape, and a 403 without permission wording as auth', async () => {
    for (const response of [
      recorded.invalidKey400(), recorded.invalidKeyStringError400(), recorded.invalidKey401(), recorded.authType400(),
      recorded.forbidden403(),
    ]) {
      await expect(failure(response)).resolves.toMatchObject({ reason: 'auth' });
    }
  });

  it('reports a 403 for a model the account may not use as a setup problem, not a bad key', async () => {
    await expect(failure(recorded.permission403())).resolves.toMatchObject({ reason: 'config', status: 403, hint: 'permission' });
  });

  it('names the refused thinking control or field', async () => {
    await expect(failure(recorded.genericInvalidArgument400())).resolves.toMatchObject({ reason: 'http', status: 400, hint: '' });
    await expect(failure(recorded.templateException500())).resolves.toMatchObject({ reason: 'http', status: 500, hint: 'effort' });
    await expect(failure(recorded.unknownName400('chat_template_kwargs'))).resolves.toMatchObject({ hint: 'thinking-fields' });
    await expect(failure(recorded.unknownName400('reasoning_effort'))).resolves.toMatchObject({ hint: 'unknown-field' });
  });

  it('keeps only the text parts of a reply and drops its reasoning', async () => {
    const answers: Array<[Response, string, boolean]> = [
      [recorded.reply('{"ok":true}', { reasoning_content: 'r1' }), '{"ok":true}', true],
      [recorded.reply('{"ok":true}', { reasoning: 'r1', reasoning_details: [{ type: 'reasoning.text', text: 'r2' }] }), '{"ok":true}', true],
      [recorded.reply([{ type: 'thinking', thinking: 'r1' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }]), '{"ok":true}', false],
      [recorded.reply('<think>r1</think>\n{"ok":true}'), '{"ok":true}', true],
      [recorded.reply('r1</think>{"ok":true}'), '{"ok":true}', true],
      [recorded.reply('{"ok":true}<think>r1 cut off'), '{"ok":true}', true],
      [recorded.reply('{"ok":true}', { extra_content: { e1: { thought_signature: 's1' } } }), '{"ok":true}', false],
    ];
    for (const [response, text, thought] of answers) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
      await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ text, thought });
    }
  });

  it('reports an empty reply cut off by the budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(recorded.reply('', { reasoning_content: 'r1' }, 'length'));
    await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ text: '', finishReason: 'length' });
  });

  it('reads replies and model lists past leading blank lines', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('\n\n  {"choices":[{"message":{"content":"{}"}}]}'))
      .mockResolvedValueOnce(new Response('\ufeff\r\n{"data":[{"id":"m1"}]}'));
    await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ text: '{}' });
    await expect(listModels(endpoint)).resolves.toEqual(['m1']);
  });

  it('asks to hold requests when one used the last of a short limit', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply('{}', {}, 'stop', { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1.5s' }))
      .mockResolvedValueOnce(recorded.reply('{}', {}, 'stop', { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6h0m0s' }))
      .mockResolvedValueOnce(recorded.reply('{}', {}, 'stop', { 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-reset-requests': '1s' }));
    await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ pauseMs: 1500 });
    await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ pauseMs: 0 });
    await expect(chatCompletion(endpoint, REQUEST)).resolves.toMatchObject({ pauseMs: 0 });
  });

  it('reads context and output limits from every /models shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ data: [
      { id: 'm1', max_input_tokens: 200000, max_output_tokens: 8192 },
      { id: 'm2', model_info: { context_window: 64000, max_output_tokens: 4096 } },
      { id: 'm3', top_provider: { context_length: 131072, max_completion_tokens: 16384 } },
      { id: 'models/m4', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
    ] }));
    await expect(listModelsDetailed(endpoint)).resolves.toEqual({
      ids: ['m1', 'm2', 'm3', 'm4'],
      contexts: { m1: 200000, m2: 64000, m3: 131072, m4: 1048576 },
      outputs: { m1: 8192, m2: 4096, m3: 16384, m4: 65536 },
      trainingContexts: {},
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(recorded.prefixedModels());
    await expect(listModelsDetailed(endpoint)).resolves.toMatchObject({ ids: ['m1'], contexts: {}, outputs: {} });
  });
});

describe('failure classification', () => {
  const classify = (status: number, body: unknown, headerWait = 0) =>
    classifyFailure(status, typeof body === 'string' ? body : JSON.stringify(body), headerWait);

  it('reads a throttle from a 5xx whose body code is 429 and from throttle wording', () => {
    expect(classify(500, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.' } }))
      .toMatchObject({ reason: 'rate' });
    expect(classify(400, { error: { message: 'Too many requests, please slow down' } })).toMatchObject({ reason: 'rate' });
    expect(classify(503, { error: { message: 'Capacity exceeded for m1' } })).toMatchObject({ reason: 'rate' });
  });

  it('reads a reached per-minute token limit as a throttle with its wait, not as a request too large', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(recorded.tokensPerMinute429());
    await expect(chatCompletion(endpoint, REQUEST)).rejects.toMatchObject({ reason: 'rate', retryAfterMs: 660, contextTokens: 0 });
  });

  it('reads a 429 as a context overflow only when it says so outright', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.tooManyTokens429())
      .mockResolvedValueOnce(recorded.contextExceeded429());
    await expect(chatCompletion(endpoint, REQUEST)).rejects.toMatchObject({ reason: 'rate' });
    await expect(chatCompletion(endpoint, REQUEST)).rejects.toMatchObject({ reason: 'context', contextTokens: 8192 });
  });

  it('reads one request over a per-request token cap as too large, not a throttle', () => {
    expect(classify(429, { error: { message: 'Request too large for m1 on tokens per min (TPM): Limit 30000, Requested 45000.' } }))
      .toMatchObject({ reason: 'context', hint: 'too-large', contextTokens: 30000 });
  });

  it('reads a gateway 502/503 that mentions a timeout as overloaded, worth a retry', () => {
    expect(classify(503, 'upstream connect error or disconnect/reset before headers. reset reason: connection timeout'))
      .toMatchObject({ reason: 'http', hint: 'overloaded' });
    expect(classify(502, { error: 'upstream timed out' }, 2000)).toMatchObject({ reason: 'http', hint: 'overloaded', retryAfterMs: 2000 });
    expect(classify(504, { error: 'upstream timed out' })).toMatchObject({ reason: 'timeout' });
  });

  it('reads a timeout from its status or wording', () => {
    for (const status of [408, 504, 522, 524]) expect(classify(status, '')).toMatchObject({ reason: 'timeout' });
    expect(classify(500, { error: 'upstream timed out' })).toMatchObject({ reason: 'timeout' });
  });

  it('reads permission and model problems as setup problems', () => {
    expect(classify(400, { error: { message: 'This API method is not enabled for this project.' } }))
      .toMatchObject({ reason: 'config', hint: 'permission' });
    expect(classify(400, { error: { code: 'model_not_found', message: 'The model m9 does not exist' } }))
      .toMatchObject({ reason: 'config', hint: 'model' });
    expect(classify(404, { error: 'Not Found' })).toMatchObject({ reason: 'config', hint: '' });
  });

  it('reads a context overflow and the limit it names, but not a field that is too long', () => {
    expect(classify(400, { error: { code: 'context_length_exceeded', message: "This model's maximum context length is 8192 tokens." } }))
      .toMatchObject({ reason: 'context', contextTokens: 8192 });
    expect(classify(400, { error: { message: 'Input length is 9000 while limit is 4096' } }))
      .toMatchObject({ reason: 'context', contextTokens: 4096 });
    expect(classify(413, { error: { message: 'input is too long for requested model' } })).toMatchObject({ reason: 'context' });
    expect(classify(400, { error: { type: 'string_above_max_length', message: 'string too long, context window irrelevant' } }))
      .not.toMatchObject({ reason: 'context' });
  });

  it('reads a blocked key as a bad key, not a content block', () => {
    expect(classify(401, { error: { message: 'Your API key has been blocked.' } })).toMatchObject({ reason: 'auth' });
  });

  it('reads a firewall\'s block page as a refused request, not a content block', () => {
    expect(classify(403, '<html><title>Attention Required</title><h1>Sorry, you have been blocked</h1></html>'))
      .toMatchObject({ reason: 'auth' });
  });

  it('reads arrears worded as "access denied" as a spent quota, not a permission problem', () => {
    expect(classify(400, { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }))
      .toMatchObject({ reason: 'quota' });
    expect(classify(403, { error: { message: 'Access denied for model m1' } })).toMatchObject({ reason: 'config', hint: 'permission' });
  });

  it('reads a region block as a permission problem, not a bad key', () => {
    expect(classify(403, { error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' } }))
      .toMatchObject({ reason: 'config', hint: 'permission' });
    expect(classify(403, '<html><body><h1>403</h1><p>This service is not available in your region.</p></body></html>'))
      .toMatchObject({ reason: 'config', hint: 'permission' });
    expect(classify(400, { error: { message: 'User location is not supported for the API use.' } }))
      .toMatchObject({ reason: 'config', hint: 'permission' });
  });

  it('reads missing permissions as a permission problem, not a spent quota', () => {
    expect(classify(403, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: model.request' } }))
      .toMatchObject({ reason: 'config', hint: 'permission' });
    expect(classify(403, { error: { message: 'Insufficient balance' } })).toMatchObject({ reason: 'quota' });
    expect(classify(400, { error: { message: 'The response was blocked by the content filter.' } })).toMatchObject({ reason: 'blocked' });
  });

  it('reads a context size only from what the error says, never from its code or status', () => {
    expect(classify(400, { error: { message: 'Context length exceeded', code: 400 } }))
      .toMatchObject({ reason: 'context', contextTokens: 0 });
    expect(classify(400, { error: { code: 500, type: 'server_error',
      message: 'the request exceeds the available context size. try increasing the context size or enable context shift' } }))
      .toMatchObject({ reason: 'context', contextTokens: 0 });
    expect(classify(400, { error: { code: '3051', message: 'Input is 40000 tokens, over the 32768 maximum context length' } }))
      .toMatchObject({ reason: 'context', contextTokens: 32768 });
  });

  it('reads more context overflow wordings and the size each names', () => {
    expect(classify(400, { error: { message: 'Your request exceeded model token limit: 8192 (requested: 9000)' } }))
      .toMatchObject({ reason: 'context', contextTokens: 8192 });
    expect(classify(422, { error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8193. Given: 9000 `inputs` tokens and 512 `max_new_tokens`' }))
      .toMatchObject({ reason: 'context', contextTokens: 8193 });
    expect(classify(400, { code: 'InvalidParameter', message: 'Range of input length should be [1, 30720]' }))
      .toMatchObject({ reason: 'context', contextTokens: 30720 });
  });

  it('reads a token limit of the account (per day, month, plan, or payment) as a spent quota, not the context', () => {
    expect(classify(402, { error: { message: 'Token limit exceeded', code: 'payment_required' } })).toMatchObject({ reason: 'quota' });
    expect(classify(403, { error: { message: 'Monthly token limit reached for your plan', type: 'insufficient_quota' } }))
      .toMatchObject({ reason: 'quota' });
    expect(classify(403, { error: { message: 'You have reached your daily token limit' } })).toMatchObject({ reason: 'quota' });
    expect(classify(400, { error: { message: 'Token limit exceeded for free tier today' } })).toMatchObject({ reason: 'quota' });
  });

  it('reads a reply budget over the model\'s output cap, and the cap it names, not the context', () => {
    const cases: Array<[number, unknown, number]> = [
      [400, { error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }, 8192],
      [400, { error: { message: 'max_tokens is too large: 50000. This model supports at most 16384 completion tokens, whereas you provided 50000.' } }, 16384],
      [400, { error: { message: '`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model' } }, 8192],
      [400, { error: { message: 'max_tokens is too large, max_tokens must be less than or equal to 4096' } }, 4096],
      [422, { error: 'Input validation error: `max_new_tokens` must be <= 2048. Given: 4096', error_type: 'validation' }, 2048],
    ];
    for (const [status, body, cap] of cases) {
      expect(classify(status, body)).toMatchObject({ reason: 'http', hint: 'output-cap', outputTokens: cap });
    }
    // The prompt and the reply together: the context, not the output cap.
    expect(classify(422, { error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8193. Given: 9000 `inputs` tokens and 512 `max_new_tokens`' }))
      .toMatchObject({ reason: 'context', contextTokens: 8193 });
  });

  it('reads an output cap only from right after the output field, and never a tiny one', () => {
    expect(classify(400, { error: { message: 'temperature must be in [0, 2]; max_tokens must be positive' } }))
      .not.toMatchObject({ hint: 'output-cap' });
    expect(classify(400, { error: { message: 'top_p must be <= 1; max_tokens must be an integer' } }))
      .not.toMatchObject({ hint: 'output-cap' });
    expect(classify(400, { error: { message: 'max_tokens must be <= 16' } })).toMatchObject({ reason: 'http', hint: '' });
  });

  it('reads more output cap wordings', () => {
    const cases: Array<[number, unknown, number]> = [
      [422, { detail: [{ type: 'less_than_equal', loc: ['body', 'max_tokens'], msg: 'Input should be less than or equal to 4096', input: 9000, ctx: { le: 4096 } }] }, 4096],
      [422, { detail: [{ type: 'less_than', loc: ['body', 'max_tokens'], msg: 'Input should be less than 4097', input: 9000, ctx: { lt: 4097 } }] }, 4096],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for m1' } }, 64000],
      [400, { error: { code: 400, message: 'Unable to submit request because it has a maxOutputTokens value of 70000 but the supported range is from 1 (inclusive) to 65537 (exclusive). Update the value and try again.', status: 'INVALID_ARGUMENT' } }, 65536],
      [400, { error: { message: 'max_tokens must be between 1 and 4000' } }, 4000],
      [400, { error: { message: 'max_tokens cannot exceed 4000' } }, 4000],
    ];
    for (const [status, body, cap] of cases) {
      expect(classify(status, body)).toMatchObject({ reason: 'http', hint: 'output-cap', outputTokens: cap });
    }
  });

  it('does not read a per-minute, daily, or context limit beside the output field as its output cap', () => {
    expect(classify(400, { error: { message: 'max_tokens exceeds the per-minute limit of 8192' } })).toMatchObject({ reason: 'rate' });
    expect(classify(400, { error: { message: 'max_tokens exceeds the daily limit of 100000 tokens' } })).toMatchObject({ reason: 'quota' });
    expect(classify(400, { error: { message: 'max_tokens exceeds the context limit of 8192' } })).toMatchObject({ reason: 'http', hint: '' });
    expect(classify(400, { error: { message: 'max_tokens exceeds the context window limit of 8192' } })).toMatchObject({ reason: 'http', hint: '' });
    expect(classify(400, { error: { message: 'max_tokens is too large. The maximum context length is 8192 tokens.' } }))
      .toMatchObject({ reason: 'http', hint: '' });
    expect(classify(400, { error: { message: 'max_tokens too large. Maximum is 1000000 tokens per day' } })).toMatchObject({ reason: 'http', hint: '' });
  });

  it('reads the prompt plus the reply budget over the model limit as the context, and a colon-worded output cap', () => {
    expect(classify(400, { error: { message: 'prompt tokens + max_tokens exceeds the model limit of 8192' } }))
      .toMatchObject({ reason: 'context', contextTokens: 8192 });
    expect(classify(400, { error: { message: 'max_tokens + prompt tokens exceeds the model limit: 8192' } }))
      .toMatchObject({ reason: 'context', contextTokens: 8192 });
    expect(classify(400, { error: { message: 'max_tokens exceeds model limit: 8192 tokens' } })).toMatchObject({ hint: 'output-cap', outputTokens: 8192 });
  });

  it('lets diagnostics log only the closed set of hints, never other text', () => {
    expect(isErrorHint('output-cap')).toBe(true);
    expect(isErrorHint('internal')).toBe(true);
    expect(isErrorHint('')).toBe(false);
    expect(isErrorHint('Invalid key sk-1')).toBe(false);
    expect(isErrorHint(undefined)).toBe(false);
  });

  it('reads an output cap the next sentence names with the output field again', () => {
    expect(classify(400, { error: { message: 'max_tokens is too large. Please set max_tokens <= 4096.' } }))
      .toMatchObject({ hint: 'output-cap', outputTokens: 4096 });
    expect(classify(400, { error: { message: 'max_tokens is too large. The maximum max_tokens for this model is 4096.' } }))
      .toMatchObject({ hint: 'output-cap', outputTokens: 4096 });
  });

  it('reads a validation error nested in message or error, also in a list', () => {
    const detail = [{ type: 'less_than_equal', loc: ['body', 'max_tokens'], msg: 'Input should be less than or equal to 32768', ctx: { le: 32768 } }];
    expect(classify(400, { object: 'error', message: { detail } })).toMatchObject({ hint: 'output-cap', outputTokens: 32768 });
    expect(classify(422, { error: { detail } })).toMatchObject({ hint: 'output-cap', outputTokens: 32768 });
    expect(classify(422, [{ error: { detail } }])).toMatchObject({ hint: 'output-cap', outputTokens: 32768 });
  });

  it('reads more output cap wordings, and the prompt only in the field\'s own clause', () => {
    expect(classify(400, { error: { message: 'max_tokens exceeds the model limit of 8192' } })).toMatchObject({ hint: 'output-cap', outputTokens: 8192 });
    expect(classify(400, { error: { message: 'max_tokens (9000) exceeds the maximum of 8192' } })).toMatchObject({ hint: 'output-cap', outputTokens: 8192 });
    expect(classify(400, { error: { message: 'max_tokens is greater than the model limit 8192' } })).toMatchObject({ hint: 'output-cap', outputTokens: 8192 });
    expect(classify(400, { error: { message: 'max_tokens must be <= 8192 for this model; prompt tokens 100' } }))
      .toMatchObject({ hint: 'output-cap', outputTokens: 8192 });
    // Still the context, the account, and the per-minute limit first.
    expect(classify(422, { error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8193. Given: 9000' }))
      .toMatchObject({ reason: 'context', contextTokens: 8193 });
    expect(classify(402, { error: { message: 'max_tokens exceeds the limit of 8192 on your plan' } })).toMatchObject({ reason: 'quota' });
    expect(classify(429, { error: { message: 'max_tokens exceeds the per-minute limit of 8192' } })).toMatchObject({ reason: 'rate' });
  });

  it('reads input tokens over a per-minute limit as a throttle, not the context', () => {
    expect(classify(400, { error: { message: 'Input tokens exceed the per-minute limit of 30000 tokens' } })).toMatchObject({ reason: 'rate' });
    expect(classify(429, { error: { message: 'Input tokens exceed the per-minute limit of 30000 tokens' } })).toMatchObject({ reason: 'rate' });
    expect(classify(400, { error: { message: 'Input tokens exceed the configured limit of 272000 tokens.' } }))
      .toMatchObject({ reason: 'context', contextTokens: 272000 });
  });

  it('reads the prompt over the model length, in more wordings, with the size each names', () => {
    expect(classify(400, { object: 'error', type: 'BadRequestError', code: 400,
      message: 'The decoder prompt (length 5000) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.' }))
      .toMatchObject({ reason: 'context', contextTokens: 4096 });
    expect(classify(422, { error: 'Input validation error: `inputs` must have less than 4096 tokens. Given: 5000', error_type: 'validation' }))
      .toMatchObject({ reason: 'context', contextTokens: 4096 });
    expect(classify(400, { error: { message: 'Input tokens exceed the configured limit of 272000 tokens. Your messages resulted in 300000 tokens. Please reduce the length of the messages.', type: 'invalid_request_error' } }))
      .toMatchObject({ reason: 'context', contextTokens: 272000 });
    // The account's limits still come first.
    expect(classify(400, { error: { message: 'Input tokens exceed the daily limit of 100000 tokens' } })).toMatchObject({ reason: 'quota' });
  });

  it('reads more content filter wordings as a block', () => {
    expect(classify(400, { error: { code: 'data_inspection_failed', message: 'Input data may contain inappropriate content.' } }))
      .toMatchObject({ reason: 'blocked' });
    expect(classify(400, { error: { code: 'SensitiveContentDetected', message: 'The request failed because the input text may contain sensitive information.' } }))
      .toMatchObject({ reason: 'blocked' });
  });

  it('reads a 400 about the account\'s money as a spent quota', () => {
    expect(classify(400, { type: 'error', error: { type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the API. Please go to Plans & Billing to upgrade or purchase credits.' } }))
      .toMatchObject({ reason: 'quota' });
    expect(classify(400, { error: { message: 'Unsupported value for response_format' } })).toMatchObject({ reason: 'http' });
  });

  it('names the field a validation error points at', () => {
    expect(classify(422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'chat_template_kwargs'], msg: 'Extra inputs are not permitted' }] }))
      .toMatchObject({ reason: 'http', hint: 'thinking-fields' });
  });

  it('reads a content policy block, which no retry fixes', () => {
    expect(classify(400, { error: { code: 'content_policy_violation', message: 'Your request was rejected by the safety system.' } }))
      .toMatchObject({ reason: 'blocked' });
    expect(classify(400, { error: { message: 'The prompt was flagged.' } })).toMatchObject({ reason: 'blocked' });
  });

  it('names the parameter a server refuses through error.param', () => {
    expect(classify(400, { error: { message: 'Unsupported value', param: 'reasoning_effort', code: 'unsupported_value' } }))
      .toMatchObject({ reason: 'http', hint: 'effort' });
    expect(classify(422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'chat_template_kwargs'], msg: 'Extra inputs are not permitted' }], param: 'chat_template_kwargs' }))
      .toMatchObject({ hint: 'thinking-fields' });
  });

  it('tells overloaded, internal, and chat-template server errors apart', () => {
    expect(classify(502, '<html>Bad Gateway</html>', 3000)).toMatchObject({ reason: 'http', hint: 'overloaded', retryAfterMs: 3000 });
    expect(classify(500, { error: 'The service is temporarily unavailable' })).toMatchObject({ hint: 'overloaded' });
    expect(classify(500, { error: 'Internal server error' })).toMatchObject({ reason: 'http', hint: 'internal' });
    expect(classify(500, { error: { message: 'Error rendering prompt with jinja template' } })).toMatchObject({ hint: 'template' });
  });

  it('turns a content-filtered reply into a blocked failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(recorded.reply('', {}, 'content_filter'));
    await expect(chatCompletion(endpoint, REQUEST)).rejects.toMatchObject({ reason: 'blocked' });
  });
});

describe('endpoint settings', () => {
  it('starts with no server or model, so AI stays unavailable until one is entered', () => {
    expect(defaultLlmConfig()).toMatchObject({ baseUrl: '', model: '' });
    expect(isConfigured(defaultLlmConfig())).toBe(false);
    expect(isConfigured(normalizeLlmConfig({ baseUrl: 'http://ai.test/v1', model: '' }))).toBe(false);
    expect(isConfigured(normalizeLlmConfig({ baseUrl: 'http://ai.test/v1', model: 'm1' }))).toBe(true);
  });

  it('adds the http:// a remote-typed server address leaves out', () => {
    expect(completeServerUrl(' 192.168.1.5:11434/v1 ')).toBe('http://192.168.1.5:11434/v1');
    expect(completeServerUrl('https://api.host.test/v1')).toBe('https://api.host.test/v1');
    expect(completeServerUrl('')).toBe('');
  });

  it('uses the base URL as entered, without trailing slashes or a pasted /chat/completions', () => {
    expect(normalizeBaseUrl(' http://ai.test/v1/ ')).toBe('http://ai.test/v1');
    expect(normalizeBaseUrl('http://ai.test/v1/chat/completions/')).toBe('http://ai.test/v1');
    expect(completeServerUrl(' ai.test:8080/api/chat/completions ')).toBe('http://ai.test:8080/api');
    expect(normalizeBaseUrl('http://ai.test')).toBe('http://ai.test');
    expect(normalizeBaseUrl('http://ai.test/api/compat//')).toBe('http://ai.test/api/compat');
    expect(completeServerUrl('ai.test:8080')).toBe('http://ai.test:8080');
  });

  it('posts to the base URL as entered, with no /v1 added', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await listModels({ ...endpoint, baseUrl: 'http://ai.test/api' });
    expect(String(spy.mock.calls[0][0])).toBe('http://ai.test/api/models');
  });

  it('infers limits and local-model handling from the server address', () => {
    for (const url of [
      'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.20.0.2/v1', 'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1', 'http://host:8080/v1', 'http://box.local/v1', 'http://[::1]:8080/v1',
      'http://user@192.168.1.20/v1',
    ]) {
      expect(endpointProfile(url)).toMatchObject({ kind: 'local', concurrency: 1, preferThinkingOff: true });
    }
    for (const url of ['https://api.host.test/v1', 'https://172.32.0.1/v1', 'http://203.0.113.5/v1', '']) {
      expect(endpointProfile(url)).toMatchObject({ kind: 'remote', concurrency: 2, preferThinkingOff: false });
    }
  });

  it('defaults Context size to 16000 online and 8192 on the LAN, and keeps a saved one', () => {
    expect(effectiveContextTokens(normalizeLlmConfig({ baseUrl: 'http://192.168.1.20:8080/v1' }))).toBe(8192);
    expect(effectiveContextTokens(normalizeLlmConfig({ baseUrl: 'https://api.host.test/v1' }))).toBe(16000);
    expect(effectiveContextTokens(normalizeLlmConfig({ baseUrl: 'https://api.host.test/v1', contextTokens: 32000 }))).toBe(32000);
    // A size picked for a LAN server stays, 16000 included.
    expect(effectiveContextTokens(normalizeLlmConfig({ baseUrl: 'http://192.168.1.20:8080/v1', contextTokens: 16000 }))).toBe(16000);
  });

  it('clamps a saved Context size to what Settings offers', () => {
    expect(normalizeLlmConfig({ contextTokens: 1000000 }).contextTokens).toBe(128000);
    expect(normalizeLlmConfig({ contextTokens: 262144 }).contextTokens).toBe(128000);
    expect(normalizeLlmConfig({ contextTokens: 100 }).contextTokens).toBe(2048);
  });

  it('lets a batch job send more items with a larger context, within its reply limit', () => {
    expect(batchItemLimit(2048, 14, 64)).toBe(200);
    expect(batchItemLimit(16000, 14, 64)).toBe(200);
    expect(batchItemLimit(32000, 14, 64)).toBe(400);
    expect(batchItemLimit(128000, 14, 64)).toBe(580);
    expect(batchItemLimit(128000, 24, 64)).toBe(338);
  });

  it('parses extra headers and skips malformed lines', () => {
    expect(parseExtraHeaders('api-key: k2\nbad line\n: x\nX\r\nInjected\nBad Name: v\nX-Empty:')).toEqual({ 'api-key': 'k2' });
    expect(parseExtraHeaders('api-key: k2; X-Org: o1;')).toEqual({ 'api-key': 'k2', 'X-Org': 'o1' });
    expect(parseExtraHeaders('X-Opts: a=1; b=2; X-Org: o1')).toEqual({ 'X-Opts': 'a=1; b=2', 'X-Org': 'o1' });
    expect(parseExtraHeaders('X-Name: 名称')).toEqual({});
  });
});
