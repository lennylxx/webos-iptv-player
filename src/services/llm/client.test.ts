import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChatBody, chatCompletion, listModels, listModelsDetailed, LlmError, type Endpoint } from './client';
import {
  batchItemLimit,
  completeServerUrl,
  defaultLlmConfig,
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('OpenAI-compatible client', () => {
  it('asks for JSON per structured mode and adds thinking-off fields only when asked', () => {
    const base = { model: 'm1', messages: [{ role: 'user' as const, content: 'hi' }], schema: SCHEMA };
    const strict = buildChatBody({ ...base, mode: 'json_schema', thinkingOff: false });
    expect(strict.response_format).toEqual({ type: 'json_schema', json_schema: { name: 's1', schema: SCHEMA.schema } });
    expect(strict.messages).toHaveLength(1);
    expect(strict).not.toHaveProperty('chat_template_kwargs');

    const object = buildChatBody({ ...base, mode: 'json_object', thinkingOff: true });
    expect(object.response_format).toEqual({ type: 'json_object' });
    expect((object.messages as Array<{ content: string }>)[0].content).toContain('JSON');
    expect(object.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(object.think).toBe(false);

    const prompt = buildChatBody({ ...base, mode: 'prompt', thinkingOff: false });
    expect(prompt).not.toHaveProperty('response_format');
  });

  it('keeps a single leading system message, as some chat templates require', () => {
    const body = buildChatBody({
      model: 'm1',
      messages: [{ role: 'system', content: 'Classify.' }, { role: 'user', content: 'ch1' }],
      schema: SCHEMA,
      mode: 'prompt',
      thinkingOff: false,
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
    const result = await chatCompletion(endpoint, {
      model: 'm1', messages: [], schema: SCHEMA, mode: 'json_schema', thinkingOff: false,
    });
    expect(String(spy.mock.calls[0][0])).toBe('http://host/v1/chat/completions');
    const headers = spy.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k1');
    expect(headers['X-Test']).toBe('a');
    expect(result).toEqual({ text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 3 }, reasoningParams: false });
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
      llamaCpp: false,
    });
  });

  it('sends no Authorization header for a keyless local server', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    await listModels({ ...endpoint, apiKey: ' ' });
    expect(spy.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('maps auth and quota errors, with Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: 'bad key' }, 401))
      .mockResolvedValueOnce(json({ error: 'slow down' }, 429, { 'Retry-After': '7' }));
    const call = () => chatCompletion(endpoint, { model: 'm1', messages: [], schema: SCHEMA, mode: 'prompt', thinkingOff: false });
    await expect(call()).rejects.toMatchObject({ reason: 'auth', status: 401 });
    await expect(call()).rejects.toMatchObject({ reason: 'quota', retryAfterMs: 7000 });
  });

  it('treats a 400 that names a bad or missing API key as an auth failure and keeps no response body', async () => {
    const answers: Array<[unknown, string]> = [
      [{ error: { message: 'Invalid API key.' } }, 'auth'],
      [[{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }], 'auth'],
      [{ error: { message: 'You didn\'t provide an API key.', type: 'invalid_request_error' } }, 'auth'],
      [{ error: { code: 'API_KEY_INVALID' } }, 'auth'],
      [{ detail: 'Missing API key' }, 'auth'],
      [{ error: { message: 'Unknown parameter: api_key_name.' } }, 'http'],
      [{ error: { message: 'Model m1 does not exist.' } }, 'http'],
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

  it('retries a reasoning model with max_completion_tokens and no temperature', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const result = await chatCompletion(endpoint, {
      model: 'm1', messages: [], schema: SCHEMA, mode: 'json_schema', thinkingOff: false, maxTokens: 50,
    });
    const retried = JSON.parse(String(spy.mock.calls[1][1]!.body)) as Record<string, unknown>;
    expect(retried.max_completion_tokens).toBe(50);
    expect(retried).not.toHaveProperty('max_tokens');
    expect(retried).not.toHaveProperty('temperature');
    expect(result.reasoningParams).toBe(true);
  });

  it('does not switch to reasoning parameters when only the response format is rejected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } }, 400));
    await expect(chatCompletion(endpoint, {
      model: 'm1', messages: [], schema: SCHEMA, mode: 'json_schema', thinkingOff: false, maxTokens: 50,
    })).rejects.toMatchObject({ reason: 'http', hint: '' });
    expect(spy).toHaveBeenCalledTimes(1);
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

  it('accepts a pasted full completions URL as the base URL', () => {
    expect(normalizeBaseUrl(' http://host/v1/chat/completions/ ')).toBe('http://host/v1');
    expect(normalizeBaseUrl('http://host/v1/')).toBe('http://host/v1');
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

  it('defaults Context size to 16000 for every server and keeps a saved one', () => {
    expect(defaultLlmConfig().contextTokens).toBe(16000);
    expect(normalizeLlmConfig({ baseUrl: 'http://192.168.1.20:8080/v1' }).contextTokens).toBe(16000);
    expect(normalizeLlmConfig({ baseUrl: 'https://api.host.test/v1' }).contextTokens).toBe(16000);
    expect(normalizeLlmConfig({ baseUrl: 'https://api.host.test/v1', contextTokens: 32000 }).contextTokens).toBe(32000);
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
