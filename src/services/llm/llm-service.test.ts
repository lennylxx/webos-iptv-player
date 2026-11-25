// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cache = new Map<string, unknown>();
vi.mock('../idb-cache', () => ({
  getCachedLlmResult: vi.fn(async (key: string) => cache.get(key)),
  setCachedLlmResult: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
}));

import { StorageService } from '../storage-service';
import { recorded } from '../../test/llm-responses';
import { capabilitySignature, defaultLlmConfig, normalizeLlmConfig } from './config';
import { LlmService, resetLlmServiceForTests, type LlmTask } from './llm-service';
import type { LlmCapabilities, LlmConfig, StructuredMode } from './types';

const task: LlmTask = {
  feature: 'f1',
  priority: 'foreground',
  system: 'Classify.',
  user: 'ch1',
  promptVersion: 1,
  maxTokens: 100,
  schema: {
    name: 'genre',
    schema: {
      type: 'object',
      properties: { genre: { type: 'string', enum: ['news', 'sports'] } },
      required: ['genre'],
      additionalProperties: false,
    },
  },
};

function reply(content: string, usage = { prompt_tokens: 10, completion_tokens: 2 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
}

const REMOTE = 'https://api.host.test/v1';
const SIGNATURE = capabilitySignature({ ...defaultLlmConfig(), baseUrl: REMOTE, model: 'm1' });
// Stands for the signature of the config it is saved with.
const MATCHING = 'matching';

/** Fresh capabilities for the config they are saved with. */
function caps(structured: StructuredMode = 'json_schema', patch: Partial<LlmCapabilities> = {}): LlmCapabilities {
  return {
    signature: MATCHING,
    structured,
    effort: '',
    thinkingFields: false,
    maxCompletionTokens: false,
    maxOutputTokens: 0,
    checkedAt: Date.now(),
    ...patch,
  };
}

function save(patch: Partial<LlmConfig>): LlmConfig {
  const config: LlmConfig = {
    ...defaultLlmConfig(),
    enabled: true,
    baseUrl: REMOTE,
    model: 'm1',
    features: { f1: true },
    ...patch,
  };
  if (config.capabilities && config.capabilities.signature === MATCHING) {
    config.capabilities = { ...config.capabilities, signature: capabilitySignature(config) };
  }
  StorageService.setLlmConfig(config);
  return config;
}

/** Whether a request body is one of the detection probes. */
function isProbe(init: unknown): boolean {
  return String((init as RequestInit).body).indexOf('bravo') >= 0;
}

const PROBE_REPLY = '{"ok":true,"word":"bravo"}';

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  cache.clear();
  resetLlmServiceForTests();
  vi.restoreAllMocks();
});

describe('LlmService', () => {
  it('sends nothing while the feature is off', async () => {
    save({ features: {} });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
    expect(LlmService.isReady('f1')).toBe(false);
  });

  it('runs a feature the user starts by hand on the AI switch alone', async () => {
    save({ features: {}, capabilities: caps('json_schema') });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    expect(LlmService.isReady('subtitle-translation')).toBe(true);
    await expect(LlmService.run({ ...task, feature: 'subtitle-translation' })).resolves.toMatchObject({ value: { genre: 'news' } });

    save({ enabled: false, features: {} });
    expect(LlmService.isReady('subtitle-translation')).toBe(false);
    await expect(LlmService.run({ ...task, feature: 'subtitle-translation' })).rejects.toMatchObject({ reason: 'disabled' });
  });

  it('falls back to json_object when the server rejects json_schema, and remembers it', async () => {
    save({});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(new Response('{"error":"response_format json_schema unsupported"}', { status: 400 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(recorded.prefixedModels())
      .mockResolvedValueOnce(reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' }, cached: false });
    const strict = bodyOf(spy.mock.calls[1]).response_format as { json_schema: { strict: boolean } };
    expect(strict.json_schema.strict).toBe(true);
    const sent = bodyOf(spy.mock.calls[4]);
    expect((sent.response_format as { type: string }).type).toBe('json_object');
    expect((sent.messages as Array<{ content: string }>)[0].content).toContain('JSON');
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ signature: SIGNATURE, structured: 'json_object' });
  });

  it('works with a local model that thinks before answering', async () => {
    save({ baseUrl: 'http://host:8080/v1' });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/models')) return new Response('{"data":[]}');
      return isProbe(init)
        ? reply('<think>easy</think>{"ok":true,"word":"bravo"}')
        : reply('<think>news channel</think>\n```json\n{"genre":"news"}\n```');
    });
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    const sent = bodyOf(spy.mock.calls[3]);
    expect(sent).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' });
    expect(sent).not.toHaveProperty('think');
    expect(spy.mock.calls[3][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('serves a repeat request from the cache without calling the API', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"sports"}'));
    await LlmService.run(task);
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'sports' }, cached: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(LlmService.usageToday().features.f1).toEqual({ requests: 1, inputTokens: 10, outputTokens: 2 });
  });

  it('counts a request stopped after it was sent, but not one stopped before', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = LlmService.run({ ...task, signal: controller.signal });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    expect(LlmService.usageToday().features.f1).toEqual({ requests: 1, inputTokens: 0, outputTokens: 0 });

    await expect(LlmService.run({ ...task, user: 'ch2', signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(LlmService.usageToday().features.f1.requests).toBe(1);
  });

  it('stops at the daily request cap unless the user confirms', async () => {
    save({ dailyRequestCap: 1, capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    await expect(LlmService.run({ ...task, user: 'ch2' })).rejects.toMatchObject({ reason: 'cap' });
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(LlmService.run({ ...task, user: 'ch2', ignoreCap: true })).resolves.toMatchObject({ cached: false });
  });

  it('retries a foreground reply that misses the schema once, then fails and logs it', async () => {
    save({ capabilities: caps('prompt') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"cooking"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.failed', 'feature=f1', 'reason=schema');
  });

  it('logs an auth failure without the key', async () => {
    save({ apiKey: 'k1', capabilities: caps('json_schema') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"bad"}', { status: 401 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'auth' });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.failed', 'feature=f1', 'reason=auth', 'status=401');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('k1');
  });

  it('moves past a mode a local chat template fails on with a 500', async () => {
    save({ baseUrl: 'http://host:8080/v1' });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(new Response('{"error":"template error"}', { status: 500 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(recorded.prefixedModels())
      .mockResolvedValueOnce(reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(5);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'json_object', effort: 'none' });
  });

  it('waits out a briefly overloaded server instead of downgrading the mode', async () => {
    vi.useFakeTimers();
    try {
      save({});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(reply(PROBE_REPLY))
        .mockResolvedValueOnce(recorded.overloaded529())
        .mockImplementation(async (url, init) => (String(url).endsWith('/models')
          ? new Response('{"data":[]}')
          : reply(isProbe(init) ? PROBE_REPLY : '{"genre":"news"}')));
      const pending = LlmService.run(task);
      await vi.advanceTimersByTimeAsync(1999);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ value: { genre: 'news' } });
      expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'json_schema' });
      expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.retry', 'feature=probe',
        'reason=overloaded', 'status=529', 'wait_ms=2000', 'attempt=1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks the daily cap when a queued request is sent, not when it is queued', async () => {
    save({ dailyRequestCap: 2, capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    const results = await Promise.allSettled(['ch1', 'ch2', 'ch3'].map((user) =>
      LlmService.run({ ...task, user, priority: 'background' })));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ reason: 'cap' });
  });

  it('keeps a shared detection going when the caller that started it cancels', async () => {
    save({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { messages: Array<{ content: string }> };
      if (body.messages.some((m) => m.content.indexOf('bravo') >= 0)) {
        await gate;
        return reply('{"ok":true,"word":"bravo"}');
      }
      return reply('{"genre":"news"}');
    });
    const controller = new AbortController();
    const first = LlmService.run({ ...task, signal: controller.signal });
    const second = LlmService.run({ ...task, user: 'ch2' });
    await Promise.resolve();
    controller.abort();
    release();
    await expect(first).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(second).resolves.toMatchObject({ value: { genre: 'news' } });
  });

  it('keeps a server\'s 429 pause when another model on it is used', async () => {
    vi.useFakeTimers();
    try {
      save({ capabilities: caps('json_schema') });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(recorded.plain429({ 'Retry-After': '20' }))
        .mockImplementation(async () => reply('{"genre":"news"}'));
      const first = LlmService.run(task);
      await vi.advanceTimersByTimeAsync(0);
      save({ model: 'm2', capabilities: caps('json_schema') });
      const next = LlmService.run({ ...task, user: 'ch2' });
      await vi.advanceTimersByTimeAsync(19000);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(first).resolves.toMatchObject({ value: { genre: 'news' } });
      await expect(next).resolves.toMatchObject({ value: { genre: 'news' } });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells a wrong server address apart from a missing model', async () => {
    const config = save({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('not found', { status: 404 }));
    await expect(LlmService.testConnection(config)).rejects.toMatchObject({ reason: 'config', hint: 'address' });
  });

  it('remembers that a model takes max_completion_tokens, and sends it directly next time', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.maxTokensUnsupported400())
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ maxCompletionTokens: true });
    await LlmService.run({ ...task, user: 'ch2' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(bodyOf(spy.mock.calls[2])).toMatchObject({ max_completion_tokens: 100 });
    expect(bodyOf(spy.mock.calls[2])).not.toHaveProperty('max_tokens');
  });

  it('reports a failing server after its retries instead of saving a prompt-only fallback', async () => {
    vi.useFakeTimers();
    try {
      save({});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"down"}', { status: 500 }));
      const pending = LlmService.run(task).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toMatchObject({ reason: 'http', status: 500, hint: 'internal' });
      // A feature's detection retries like any request: twice, 2 s and 4 s apart.
      expect(spy).toHaveBeenCalledTimes(3);
      expect(StorageService.getLlmConfig().capabilities).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to prompt-only JSON when replies come but none validates', async () => {
    save({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('I cannot do JSON.'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.capability.fallback', 'mode=prompt');
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'prompt' });
  });

  it('tests a connection: lists models and detects structured output', async () => {
    const config = save({ enabled: false });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1', max_output_tokens: 4096 }] }), { status: 200 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(reply(PROBE_REPLY));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({
      models: ['m1'],
      capabilities: { structured: 'json_schema', effort: 'none', thinkingFields: false, maxOutputTokens: 4096 },
    });
  });

  it('reads the context size a server reports for the model', async () => {
    const config = save({ enabled: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm0', max_model_len: 4096 }, { id: 'm1', context_length: 32768 }] }), { status: 200 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(reply(PROBE_REPLY));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({ contextTokens: 32768 });
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=models', 'tokens=32768');
  });

  it('reads the per-slot context from /props when /models names none, and reports none where neither does', async () => {
    const config = save({ enabled: false, baseUrl: 'http://host:8080/v1' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1', owned_by: 'o1', meta: { n_ctx_train: 262144 } }] }), { status: 200 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 }));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({ contextTokens: 8192 });
    expect(String(spy.mock.calls[3][0])).toBe('http://host:8080/props');
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=props', 'tokens=8192');

    resetLlmServiceForTests();
    const remote = save({ enabled: false });
    spy.mockReset();
    spy
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(LlmService.testConnection(remote)).resolves.toMatchObject({ contextTokens: 0 });
    expect(String(spy.mock.calls[3][0])).toBe('https://api.host.test/props');
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=none', 'tokens=0');
  });

  it('runs a plain-text task without a response format, and caches only accepted replies', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => reply('<think>hm</think>not usable'))
      .mockImplementation(async () => reply('[1] A\n'));
    const textTask = { ...task, accept: (text: string) => text.indexOf('[1]') === 0 };

    await expect(LlmService.runText(textTask)).resolves.toEqual({ text: 'not usable', cached: false });
    const body = bodyOf(spy.mock.calls[0]);
    expect(body.response_format).toBeUndefined();
    expect((body.messages as Array<{ content: string }>)[0].content).toBe('Classify.');

    await expect(LlmService.runText(textTask)).resolves.toEqual({ text: '[1] A', cached: false });
    await expect(LlmService.runText(textTask)).resolves.toEqual({ text: '[1] A', cached: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers a plain-text task from a stored reply without sending it, apart per model', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(LlmService.cachedText(task)).resolves.toBeUndefined();
    await LlmService.storeText(task, '[1] A');

    await expect(LlmService.cachedText(task)).resolves.toBe('[1] A');
    await expect(LlmService.cachedText({ ...task, user: 'ch0' })).resolves.toBeUndefined();
    await expect(LlmService.runText(task)).resolves.toEqual({ text: '[1] A', cached: true });
    expect(spy).not.toHaveBeenCalled();

    save({ model: 'm2', capabilities: caps('json_schema') });
    await expect(LlmService.cachedText(task)).resolves.toBeUndefined();
  });

  it('answers an identical plain-text request still out without sending it again', async () => {
    save({ capabilities: caps('json_schema') });
    let answer: (response: Response) => void = () => {};
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const first = LlmService.runText(task);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const second = LlmService.runText(task);

    answer(reply('[1] A'));

    await expect(first).resolves.toEqual({ text: '[1] A', cached: false });
    await expect(second).resolves.toEqual({ text: '[1] A', cached: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sends a shared request anew when its first caller dropped it from the queue', async () => {
    save({
      baseUrl: 'http://host:8080/v1',
      capabilities: caps('json_schema'),
    });
    let answer: (response: Response) => void = () => {};
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    // A local server takes one request at a time, so the second waits in the queue.
    const busy = LlmService.runText({ ...task, user: 'ch0' });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const dropped = LlmService.runText({ ...task, signal: controller.signal, finishStarted: true });
    const joined = LlmService.runText(task);
    controller.abort();
    await expect(dropped).rejects.toMatchObject({ reason: 'cancelled' });

    answer(reply('[1] busy'));
    await busy;
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    answer(reply('[1] A'));
    await expect(joined).resolves.toEqual({ text: '[1] A', cached: false });
  });

  it('finishes and caches a sent request when finishStarted is set and the caller stops', async () => {
    save({ capabilities: caps('json_schema') });
    let answer: (response: Response) => void = () => {};
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
      answer = resolve;
      (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = LlmService.runText({ ...task, signal: controller.signal, finishStarted: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());

    controller.abort();
    answer(reply('[1] A'));

    await expect(pending).resolves.toEqual({ text: '[1] A', cached: false });
    await expect(LlmService.runText(task)).resolves.toEqual({ text: '[1] A', cached: true });
  });

  it('lets a confirmed request past a reached cap without waiting behind refused ones', async () => {
    vi.useFakeTimers();
    try {
      const server = 'http://ai.test/v1';
      save({
        baseUrl: server,
        dailyRequestCap: 2,
        capabilities: caps('json_schema'),
      });
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
      // All queued while under the cap; it trips after the first two are sent.
      const queued = Array.from({ length: 20 }, (_, i) =>
        LlmService.run({ ...task, user: `b${i}`, priority: 'background' }).then(() => null, (error: unknown) => error));
      await vi.advanceTimersByTimeAsync(0);
      const outcomes = await Promise.all(queued);
      expect(outcomes.filter((o) => o === null)).toHaveLength(2);
      expect(outcomes.filter((o) => (o as { reason?: string } | null)?.reason === 'cap')).toHaveLength(18);
      // Refused jobs left the queue, so this goes now.
      const confirmed = LlmService.run({ ...task, user: 'f1', ignoreCap: true });
      await vi.advanceTimersByTimeAsync(0);
      await expect(confirmed).resolves.toMatchObject({ cached: false });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new detection after a failed one, and for a corrected key', async () => {
    save({ apiKey: 'old' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockImplementation(async () => reply('{"ok":true,"word":"bravo"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'auth' });
    save({ apiKey: 'new' });
    spy.mockImplementation(async (_url, init) => {
      const body = String((init as RequestInit).body);
      return reply(body.indexOf('bravo') >= 0 ? '{"ok":true,"word":"bravo"}' : '{"genre":"news"}');
    });
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
  });

  it('does not save a finished detection over a config saved for another model', async () => {
    save({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate;
      return reply('{"ok":true,"word":"bravo"}');
    });
    const running = LlmService.run(task).catch(() => undefined);
    save({ model: 'm2' });
    release();
    await running;
    expect(StorageService.getLlmConfig()).toMatchObject({ model: 'm2', capabilities: null });
  });

  it('walks a LAN server that answers every probe with a bare 500 without retrying each rung', async () => {
    vi.useFakeTimers();
    try {
      const config = save({ baseUrl: 'http://192.168.1.20:8080/v1' });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"data":[{"id":"m1"}]}'))
        .mockImplementation(async () => new Response('{"error":"Internal Server Error"}', { status: 500 }));
      const pending = LlmService.testConnection(config).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject({ reason: 'http', status: 500 });
      // The model list, five thinking rungs, and three response formats.
      expect(spy).toHaveBeenCalledTimes(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Test connection short on a throttled or overloaded server', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const models = () => new Response('{"data":[{"id":"m1"}]}');
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(models())
        .mockResolvedValueOnce(recorded.plain429({ 'Retry-After': '45' }));
      let config = save({});
      await expect(LlmService.testConnection(config)).rejects.toMatchObject({ reason: 'rate' });
      expect(spy).toHaveBeenCalledTimes(2);

      resetLlmServiceForTests();
      spy.mockReset();
      spy.mockResolvedValueOnce(models())
        .mockResolvedValueOnce(new Response('{"error":"busy"}', { status: 503, headers: { 'Retry-After': '50' } }));
      config = save({});
      await expect(LlmService.testConnection(config)).rejects.toMatchObject({ reason: 'http', status: 503 });
      expect(spy).toHaveBeenCalledTimes(2);

      // Pressed again during the pause the first try set: no wait in the paused queue.
      spy.mockReset();
      spy.mockResolvedValueOnce(models()).mockImplementation(async () => reply(PROBE_REPLY));
      const again = LlmService.testConnection(config).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(await again).toMatchObject({ reason: 'rate' });
      expect(spy).toHaveBeenCalledTimes(1);

      // A short wait is waited once.
      resetLlmServiceForTests();
      spy.mockReset();
      spy.mockResolvedValueOnce(models()).mockImplementation(async () => recorded.plain429({ 'Retry-After': '5' }));
      config = save({});
      const pending = LlmService.testConnection(config).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ reason: 'rate' });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a feature\'s detection wait out a paused queue that Test connection would not', async () => {
    vi.useFakeTimers();
    try {
      save({ capabilities: caps('json_schema', { checkedAt: Date.now() - 8 * 24 * 3600000 }) });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(recorded.plain429({ 'Retry-After': '30' }))
        .mockImplementation(async (url, init) => (String(url).endsWith('/models')
          ? new Response('{"data":[]}')
          : reply(isProbe(init) ? PROBE_REPLY : '{"genre":"news"}')));
      // A background job hit a throttle: the server's queue holds for 30 s.
      const first = LlmService.run({ ...task, user: 'b1', priority: 'background' });
      await vi.advanceTimersByTimeAsync(0);
      // A foreground request whose capabilities expired runs detection, and waits instead of failing.
      const second = LlmService.run(task);
      await vi.advanceTimersByTimeAsync(30000);
      await expect(second).resolves.toMatchObject({ value: { genre: 'news' } });
      await expect(first).resolves.toMatchObject({ value: { genre: 'news' } });
      expect(spy.mock.calls.length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects with a probe budget within an output cap below it, and keeps that cap', async () => {
    const config = save({ enabled: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cap = () => new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 512. Given: 1000', error_type: 'validation' }), { status: 422 });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"data":[{"id":"m1"}]}'))
      .mockResolvedValueOnce(cap())
      .mockImplementation(async () => reply(PROBE_REPLY));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({
      capabilities: { structured: 'json_schema', effort: 'none', maxOutputTokens: 512 },
    });
    expect(spy.mock.calls.slice(1, 4).map((call) => bodyOf(call).max_tokens)).toEqual([1000, 512, 512]);
  });

  it('reports a remote server error during Test connection instead of falling back', async () => {
    vi.useFakeTimers();
    try {
      const config = save({});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
        .mockImplementation(async () => new Response('{}', { status: 500 }));
      const pending = LlmService.testConnection(config).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toMatchObject({ reason: 'http', status: 500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('steps a LAN server\'s reasoning_effort down when its chat template throws, keeping chat_template_kwargs', async () => {
    save({ baseUrl: 'http://host:11434/v1' });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"reasoning_effort: none is not a valid value"}', { status: 400 }))
      .mockResolvedValueOnce(recorded.templateException500())
      .mockResolvedValueOnce(recorded.reply(PROBE_REPLY, { reasoning_content: 'thinking' }))
      .mockResolvedValueOnce(recorded.reply(PROBE_REPLY, { reasoning_content: 'thinking' }))
      .mockResolvedValueOnce(new Response('{"data":[{"id":"m1","max_output_tokens":2048}]}'))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    expect(spy.mock.calls.slice(0, 3).map((call) => bodyOf(call).reasoning_effort)).toEqual(['none', 'minimal', 'low']);
    for (const call of spy.mock.calls.slice(0, 4)) {
      expect(bodyOf(call)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
      expect(bodyOf(call)).not.toHaveProperty('think');
    }
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ effort: 'low', thinkingFields: true, maxOutputTokens: 2048 });
    expect(info).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.capability.detected', 'profile=local',
      'mode=json_schema', 'effort=low', 'thinking_fields=true', 'still_thinking=true', 'max_field=max_tokens', 'max_output=2048');
    info.mockRestore();
  });

  it('logs a reached daily cap once, not for every refused request', async () => {
    save({ dailyRequestCap: 1, capabilities: caps('json_schema') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    for (const user of ['ch2', 'ch3', 'ch4']) await LlmService.run({ ...task, user }).catch(() => undefined);
    const capEvents = warn.mock.calls.filter((call) => call.indexOf('event=llm.cap.reached') >= 0);
    expect(capEvents).toEqual([['[LLM]', expect.any(String), 'event=llm.cap.reached', 'kind=requests']]);
  });

  it('drops queued background requests after a quota 429 instead of trying each', async () => {
    vi.useFakeTimers();
    try {
      save({ baseUrl: 'http://host:8080/v1', capabilities: caps('json_schema') });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(recorded.insufficientQuota429())
        .mockImplementation(async () => reply('{"genre":"news"}'));
      const jobs = ['b1', 'b2', 'b3'].map((user) =>
        LlmService.run({ ...task, user, priority: 'background' }).then(() => null, (error: unknown) => error));
      await vi.advanceTimersByTimeAsync(0);
      const outcomes = await Promise.all(jobs);
      expect(outcomes.map((o) => (o as { reason?: string } | null)?.reason)).toEqual(['quota', 'quota', 'quota']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.queue.rejected', 'reason=quota', 'count=2');
      // One request was refused, so diag shows one failure, not one per dropped job.
      expect(warn.mock.calls.filter((call) => call.indexOf('event=llm.request.failed') >= 0)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not join a detection still running with an older key', async () => {
    save({ apiKey: 'old' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = ((init as RequestInit).headers as Record<string, string>).Authorization;
      if (auth === 'Bearer old') {
        await gate;
        return new Response('{}', { status: 401 });
      }
      const body = String((init as RequestInit).body);
      return reply(body.indexOf('bravo') >= 0 ? '{"ok":true,"word":"bravo"}' : '{"genre":"news"}');
    });
    const stale = LlmService.run(task).catch((error: unknown) => error);
    save({ apiKey: 'new' });
    await expect(LlmService.run({ ...task, user: 'ch2' })).resolves.toMatchObject({ value: { genre: 'news' } });
    release();
    expect(await stale).toMatchObject({ reason: 'auth' });
  });

  it('does not let a capped detection fail a request the user confirmed past the cap', async () => {
    save({ dailyRequestCap: 1 });
    StorageService.setLlmUsage({ day: LlmService.usageToday().day, features: { f1: { requests: 0, inputTokens: 0, outputTokens: 0 } } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls++;
      if (calls === 1) {
        await gate;
        return new Response('{"error":"response_format json_schema unsupported"}', { status: 400 });
      }
      const body = String((init as RequestInit).body);
      return reply(body.indexOf('bravo') >= 0 ? '{"ok":true,"word":"bravo"}' : '{"genre":"news"}');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capped = LlmService.run({ ...task, priority: 'background' }).catch((error: unknown) => error);
    const confirmed = LlmService.run({ ...task, user: 'ch2', ignoreCap: true });
    release();
    await expect(confirmed).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(await capped).toMatchObject({ reason: 'cap' });
  });

  it('logs a shared detection failure once, not once per waiting request', async () => {
    save({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 401 }));
    const results = await Promise.all(['ch1', 'ch2', 'ch3'].map((user) => LlmService.run({ ...task, user }).catch((e: unknown) => e)));
    expect(results.map((r) => (r as { reason?: string }).reason)).toEqual(['auth', 'auth', 'auth']);
    expect(warn.mock.calls.filter((call) => call.indexOf('event=llm.request.failed') >= 0)).toHaveLength(1);
  });
});

describe('LlmService capability ladders', () => {
  const answer = async (url: unknown, init: unknown): Promise<Response> => {
    if (String(url).endsWith('/models')) return new Response('{"data":[]}');
    return reply(isProbe(init) ? PROBE_REPLY : '{"genre":"news"}');
  };

  it('steps a hosted server from reasoning_effort "none" to "minimal" on a generic invalid-argument 400', async () => {
    save({});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockImplementation(answer);
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(bodyOf(spy.mock.calls[0])).toMatchObject({ reasoning_effort: 'none' });
    expect(bodyOf(spy.mock.calls[0])).not.toHaveProperty('chat_template_kwargs');
    expect(bodyOf(spy.mock.calls[1])).toMatchObject({ reasoning_effort: 'minimal' });
    expect(bodyOf(spy.mock.calls[4])).toMatchObject({ reasoning_effort: 'minimal' });
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ effort: 'minimal', thinkingFields: false });
  });

  it('leaves reasoning_effort out after every value is refused', async () => {
    save({});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockImplementation(answer);
    await LlmService.run(task);
    expect(bodyOf(spy.mock.calls[3])).not.toHaveProperty('reasoning_effort');
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ effort: '' });
  });

  it('does not treat a chat template exception as an outage: it steps on at once, with no wait', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockResolvedValueOnce(recorded.templateException500())
      .mockImplementation(answer);
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy.mock.calls.slice(0, 3).map((call) => bodyOf(call).reasoning_effort)).toEqual(['none', 'minimal', 'low']);
    expect(warn.mock.calls.filter((call) => call.indexOf('event=llm.request.retry') >= 0)).toHaveLength(0);
  });

  it('drops chat_template_kwargs where a LAN server refuses it by name, and remembers that', async () => {
    save({ baseUrl: 'http://127.0.0.1:8080/v1' });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.unknownName400('chat_template_kwargs'))
      .mockImplementation(answer);
    await LlmService.run(task);
    expect(bodyOf(spy.mock.calls[0])).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'none' });
    expect(bodyOf(spy.mock.calls[1])).not.toHaveProperty('chat_template_kwargs');
    expect(bodyOf(spy.mock.calls[1])).toMatchObject({ reasoning_effort: 'none' });
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ effort: 'none', thinkingFields: false });
  });

  it('goes to prompt-only when json_object is refused with a string error body', async () => {
    save({});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockResolvedValueOnce(new Response('{"error":"\'response_format.type\' must be \'json_schema\' or \'text\'"}', { status: 400 }))
      .mockImplementation(answer);
    await LlmService.run(task);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'prompt', effort: 'none' });
    expect(bodyOf(spy.mock.calls[3])).not.toHaveProperty('response_format');
  });

  it('counts a reply that ignores json_object and is not JSON as a failed rung', async () => {
    save({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(reply('Sure! Here it is.'))
      .mockResolvedValueOnce(reply('ok: true, word: bravo'))
      .mockImplementation(answer);
    await LlmService.run(task);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'prompt' });
  });

  it('counts an empty structured reply as a failed one', async () => {
    save({ capabilities: caps('json_object') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('  \n'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a reply the model spent thinking with twice the budget, within the model\'s output cap', async () => {
    save({ capabilities: caps('json_schema', { maxOutputTokens: 150 }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply(null, { reasoning_content: 'long thought' }, 'length'))
      .mockResolvedValueOnce(recorded.reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(bodyOf(spy.mock.calls[0]).max_tokens).toBe(100);
    expect(bodyOf(spy.mock.calls[1]).max_tokens).toBe(150);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.reply.truncated', 'feature=f1',
      'max_tokens=100', 'retry_max_tokens=150');
  });

  it('keeps the cut-off reply when the doubled budget is refused, without touching Context size', async () => {
    save({ contextTokens: 32000, capabilities: caps('json_schema') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply(null, { reasoning_content: 'long thought' }, 'length'))
      .mockResolvedValueOnce(new Response('{"error":{"message":"max_tokens is too large: 200. This model supports at most 150."}}', { status: 400 }))
      .mockResolvedValueOnce(recorded.reply(null, { reasoning_content: 'long thought' }, 'length'))
      .mockResolvedValueOnce(new Response('{"error":{"message":"prompt plus max_tokens exceeds the context window"}}', { status: 400 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    await expect(LlmService.run({ ...task, user: 'ch2' })).rejects.toMatchObject({ reason: 'schema' });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(LlmService.contextTokens()).toBe(32000);
  });

  it('keeps the cut-off reply when a validation error refuses the doubled budget', async () => {
    save({ capabilities: caps('json_schema') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply(null, { reasoning_content: 'long thought' }, 'length'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: [{ type: 'less_than_equal', loc: ['body', 'max_tokens'], msg: 'Input should be less than or equal to 150' }],
      }), { status: 422 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('learns an output cap a server refuses the budget with, sends once more within it, and caps later requests up front', async () => {
    save({ capabilities: caps() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 64. Given: 100', error_type: 'validation' }), { status: 422 }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy.mock.calls.map((call) => bodyOf(call).max_tokens)).toEqual([100, 64]);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ maxOutputTokens: 64 });
    expect(LlmService.outputCap()).toBe(64);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.output.capped', 'feature=f1', 'max_tokens=100', 'cap=64');

    await LlmService.run({ ...task, user: 'ch2' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(bodyOf(spy.mock.calls[2]).max_tokens).toBe(64);
  });

  it('fails a reply still cut off at a learned output cap as too long, once and without lowering Context size', async () => {
    save({ contextTokens: 32000, capabilities: caps('prompt') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 64. Given: 100', error_type: 'validation' }), { status: 422 }))
      .mockResolvedValueOnce(recorded.reply('{"genre":', {}, 'length'));
    const warn = vi.mocked(console.warn);
    await expect(LlmService.run({ ...task, splittable: true })).rejects.toMatchObject({ reason: 'context', hint: 'output-cap' });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.failed', 'feature=f1', 'reason=context',
      'hint=output-cap');
    // No second schema attempt with the same budget.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(LlmService.contextTokens()).toBe(32000);
  });

  it('gives a single item cut off at the output cap its cut-off reply, not a failure to split', async () => {
    save({ capabilities: caps('json_schema') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 64. Given: 100', error_type: 'validation' }), { status: 422 }))
      .mockResolvedValueOnce(recorded.reply('[1] Lin', {}, 'length'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 64. Given: 100', error_type: 'validation' }), { status: 422 }))
      .mockResolvedValueOnce(recorded.reply('{"genre":', {}, 'length'));
    await expect(LlmService.runText({ ...task, user: 'ch2' })).resolves.toEqual({ text: '[1] Lin', cached: false, truncated: true });
    // Never kept, so a later request asks again.
    await expect(LlmService.cachedText({ ...task, user: 'ch2' })).resolves.toBeUndefined();
    resetLlmServiceForTests();
    save({ capabilities: caps('json_schema') });
    await expect(LlmService.run({ ...task, user: 'ch3' })).rejects.toMatchObject({ reason: 'schema' });
  });

  it('uses but never keeps a reply cut off at its budget, plain text or JSON', async () => {
    save({ capabilities: caps('json_schema') });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply('[1] Hallo, wie ge', {}, 'length'))
      .mockResolvedValueOnce(recorded.reply('{"genre":"news"}', {}, 'length'))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.runText({ ...task, accept: () => true })).resolves.toMatchObject({ truncated: true });
    await expect(LlmService.cachedText(task)).resolves.toBeUndefined();
    await expect(LlmService.run({ ...task, user: 'ch2' })).resolves.toMatchObject({ value: { genre: 'news' }, cached: false });
    await expect(LlmService.run({ ...task, user: 'ch2' })).resolves.toMatchObject({ cached: false });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('sends a request waiting in line within an output cap another request just learned', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1', capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Input validation error: `max_new_tokens` must be <= 64. Given: 100', error_type: 'validation' }), { status: 422 }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await Promise.all([LlmService.run(task), LlmService.run({ ...task, user: 'ch2' })]);
    expect(spy.mock.calls.map((call) => bodyOf(call).max_tokens)).toEqual([100, 64, 64]);
  });

  it('keeps an output cap another request learned when one with older capabilities saves', async () => {
    save({ capabilities: caps() });
    let answer: (response: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    const pending = LlmService.run(task);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // Meanwhile another request learned the cap.
    const config = StorageService.getLlmConfig();
    StorageService.setLlmConfig({ ...config, capabilities: { ...config.capabilities!, maxOutputTokens: 64 } });
    answer(recorded.maxTokensUnsupported400());
    await pending;
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ maxOutputTokens: 64, maxCompletionTokens: true });
  });

  it('caps the budget at the model\'s reported output limit', async () => {
    save({ capabilities: caps('json_schema', { maxOutputTokens: 64 }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    expect(bodyOf(spy.mock.calls[0]).max_tokens).toBe(64);
  });
});

describe('LlmService capability cache', () => {
  it('sends the learned rungs directly on the next request, also after a restart', async () => {
    save({ apiKey: 'k1' });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.genericInvalidArgument400())
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockResolvedValueOnce(recorded.maxTokensUnsupported400())
      .mockResolvedValueOnce(reply(PROBE_REPLY))
      .mockImplementation(async (url) => (String(url).endsWith('/models') ? new Response('{"data":[]}') : reply('{"genre":"news"}')));
    await LlmService.run(task);
    const before = spy.mock.calls.length;

    await LlmService.run({ ...task, user: 'ch2' });
    expect(spy.mock.calls.length - before).toBe(1);

    // A restart reads the config back from storage.
    resetLlmServiceForTests();
    StorageService.setLlmConfig(normalizeLlmConfig(JSON.parse(JSON.stringify(StorageService.getLlmConfig()))));
    await LlmService.run({ ...task, user: 'ch3' });
    expect(spy.mock.calls.length - before).toBe(2);
    const sent = bodyOf(spy.mock.calls[spy.mock.calls.length - 1]);
    expect(sent).toMatchObject({ reasoning_effort: 'minimal', max_completion_tokens: 100, response_format: { type: 'json_schema' } });
    expect(sent).not.toHaveProperty('max_tokens');
  });

  it('probes again for another key on the same server and model', async () => {
    save({ apiKey: 'k1', capabilities: caps('json_object') });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      (String(url).endsWith('/models') ? new Response('{"data":[]}') : reply(isProbe(init) ? PROBE_REPLY : '{"genre":"news"}')));
    save({ apiKey: 'k2', capabilities: StorageService.getLlmConfig().capabilities });
    await LlmService.run(task);
    expect(spy.mock.calls.filter((call) => isProbe(call[1]))).toHaveLength(2);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'json_schema' });
  });

  it('steps a saved rung the server now refuses down once, and saves it', async () => {
    save({ capabilities: caps('json_schema', { effort: 'none' }) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":{"message":"Unsupported value: reasoning_effort none"}}', { status: 400 }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bodyOf(spy.mock.calls[1])).toMatchObject({ reasoning_effort: 'minimal' });
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ effort: 'minimal', structured: 'json_schema' });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.capability.stepped', 'mode=json_schema',
      'effort=minimal', 'thinking_fields=false');
  });

  it('drops chat_template_kwargs at run time when a validation error points at it', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1', capabilities: caps('json_schema', { effort: 'none', thinkingFields: true }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: [{ type: 'extra_forbidden', loc: ['body', 'chat_template_kwargs'], msg: 'Extra inputs are not permitted' }],
      }), { status: 422 }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(bodyOf(spy.mock.calls[1])).not.toHaveProperty('chat_template_kwargs');
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ thinkingFields: false, effort: 'none' });
  });

  it('steps a saved response format down once, without restarting the ladder', async () => {
    save({ capabilities: caps('json_schema') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"response_format json_schema unsupported"}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{"error":"response_format json_object unsupported"}', { status: 400 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'http', status: 400 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'json_object' });
  });

  it('probes from the best rung again once the saved capabilities are a week old', async () => {
    save({ capabilities: caps('prompt', { effort: 'low', checkedAt: Date.now() - 8 * 24 * 3600000 }) });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      (String(url).endsWith('/models') ? new Response('{"data":[]}') : reply(isProbe(init) ? PROBE_REPLY : '{"genre":"news"}')));
    await LlmService.run(task);
    expect(bodyOf(spy.mock.calls[0])).toMatchObject({ reasoning_effort: 'none' });
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ structured: 'json_schema', effort: 'none' });
  });
});

describe('LlmService rate limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('waits out a per-minute throttle worded as a quota for its retry delay, then retries', async () => {
    save({ capabilities: caps() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.perMinute429())
      .mockImplementation(async () => reply('{"genre":"news"}'));
    const pending = LlmService.run(task);
    await vi.advanceTimersByTimeAsync(23999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.retry', 'feature=f1',
      'reason=rate', 'status=429', 'wait_ms=24000', 'attempt=1');
  });

  it('fails a spent daily quota at once and drops queued background work', async () => {
    save({ baseUrl: 'http://host:8080/v1', capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.perDay429())
      .mockImplementation(async () => reply('{"genre":"news"}'));
    const jobs = ['b1', 'b2'].map((user) =>
      LlmService.run({ ...task, user, priority: 'background' }).then(() => null, (error: unknown) => error));
    await vi.advanceTimersByTimeAsync(0);
    expect((await Promise.all(jobs)).map((o) => (o as { reason?: string } | null)?.reason)).toEqual(['quota', 'quota']);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails a 402 as a spent quota without retrying', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(recorded.balance402());
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'quota', status: 402 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('backs off 2 s, 4 s, 8 s, 16 s without a named wait, then fails as rate-limited', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => recorded.plain429());
    const pending = LlmService.run(task).catch((error: unknown) => error);
    for (const [wait, calls] of [[2000, 2], [4000, 3], [8000, 4], [16000, 5]]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(spy).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await pending).toMatchObject({ reason: 'rate', status: 429 });
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('honors retry-after-ms and a 503 Retry-After', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.plain429({ 'retry-after-ms': '1500' }))
      .mockResolvedValueOnce(new Response('{"error":"queue full"}', { status: 503, headers: { 'Retry-After': '3' } }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    const pending = LlmService.run(task);
    await vi.advanceTimersByTimeAsync(1500);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(spy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ value: { genre: 'news' } });
  });

  it('retries a dropped connection twice, then reports it as a network failure', async () => {
    save({ capabilities: caps() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const pending = LlmService.run(task).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toMatchObject({ reason: 'network', status: 0 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.retry', 'feature=f1',
      'reason=network', 'status=0', 'wait_ms=2000', 'attempt=1');
  });

  it('does not send a timed-out request again', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'timeout', status: 504 });
    expect(spy).toHaveBeenCalledTimes(1);

    // The app's own timeout on a server that never answers.
    const hanging = LlmService.run({ ...task, user: 'ch2' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90000);
    expect(await hanging).toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sends no retry once the caller stops during the backoff, even for a request it lets finish', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => recorded.plain429());
    const controller = new AbortController();
    const pending = LlmService.runText({ ...task, signal: controller.signal, finishStarted: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toMatchObject({ reason: 'cancelled' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails new requests at once while a throttle asks for more than a minute, instead of holding them', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.plain429({ 'Retry-After': '300' }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'rate', retryAfterMs: 300000 });
    await expect(LlmService.run({ ...task, user: 'ch2' })).rejects.toMatchObject({ reason: 'rate' });
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300000);
    await expect(LlmService.run({ ...task, user: 'ch3' })).resolves.toMatchObject({ value: { genre: 'news' } });
  });

  it('drops the requests queued behind a throttle that asks for more than a minute, and logs it', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1', capabilities: caps() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let answer: (response: Response) => void = () => {};
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const first = LlmService.run(task).catch((error: unknown) => error);
    const queued = LlmService.run({ ...task, user: 'ch2' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    answer(recorded.plain429({ 'Retry-After': '300' }));
    expect(await first).toMatchObject({ reason: 'rate' });
    expect(await queued).toMatchObject({ reason: 'rate' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.queue.rejected', 'reason=rate', 'count=1');
  });

  it('refuses only the key a long throttle or a spent quota came for, not another key on the server', async () => {
    save({ apiKey: 'k1', capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.plain429({ 'Retry-After': '300' }))
      .mockResolvedValueOnce(recorded.perDay429())
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'rate' });
    save({ apiKey: 'k2', capabilities: caps() });
    await expect(LlmService.run({ ...task, user: 'b1', priority: 'background' })).rejects.toMatchObject({ reason: 'quota' });
    save({ apiKey: 'k3', capabilities: caps() });
    await expect(LlmService.run({ ...task, user: 'ch2' })).resolves.toMatchObject({ value: { genre: 'news' } });
    await expect(LlmService.run({ ...task, user: 'b2', priority: 'background' })).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(4);
    // The refused keys stay refused.
    save({ apiKey: 'k1', capabilities: caps() });
    await expect(LlmService.run({ ...task, user: 'ch3' })).rejects.toMatchObject({ reason: 'rate' });
    save({ apiKey: 'k2', capabilities: caps() });
    await expect(LlmService.run({ ...task, user: 'b3', priority: 'background' })).rejects.toMatchObject({ reason: 'quota' });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('after a spent quota, fails background work at once but lets a foreground action try right away', async () => {
    save({ capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.perDay429())
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'quota' });
    await expect(LlmService.run({ ...task, user: 'b1', priority: 'background' })).rejects.toMatchObject({ reason: 'quota' });
    expect(spy).toHaveBeenCalledTimes(1);
    // E.g. after a top-up: no 30 s wait.
    await expect(LlmService.run({ ...task, user: 'ch2' })).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('lets another request use a LAN server\'s only slot while a dropped connection backs off', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1', capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    const first = LlmService.run(task);
    const second = LlmService.run({ ...task, user: 'ch2' });
    await vi.advanceTimersByTimeAsync(0);
    // The second request went during the first's 2 s backoff.
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toMatchObject({ value: { genre: 'news' } });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('puts a retry ahead of requests of its priority that came after it', async () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1', capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const users: string[] = [];
    let failed = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const user = (bodyOf([null, init]).messages as Array<{ content: string }>)[1].content;
      users.push(user);
      if (user === 'ch1' && !failed) {
        failed = true;
        return recorded.plain429({ 'Retry-After': '1' });
      }
      return reply('{"genre":"news"}');
    });
    const jobs = ['ch1', 'ch2', 'ch3'].map((user) => LlmService.run({ ...task, user, priority: 'background' }));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(jobs);
    expect(users).toEqual(['ch1', 'ch1', 'ch2', 'ch3']);
  });

  it('holds the server\'s queue until a used-up short limit resets', async () => {
    save({ capabilities: caps() });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(recorded.reply('{"genre":"news"}', {}, 'stop',
        { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '45s' }))
      .mockImplementation(async () => reply('{"genre":"sports"}'));
    await LlmService.run(task);
    const next = LlmService.run({ ...task, user: 'ch2' });
    await vi.advanceTimersByTimeAsync(44999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ value: { genre: 'sports' } });
  });
});

describe('LlmService context size', () => {
  it('lowers Context size to what an overflow error names', async () => {
    save({ contextTokens: 32000, detectedContextTokens: 32000, capabilities: caps() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 8192,
        message: 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it' },
    }), { status: 400 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'context', contextTokens: 8192 });
    expect(LlmService.contextTokens()).toBe(8192);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.lowered', 'tokens=8192', 'named=8192');
  });

  it('keeps Context size through per-minute token throttles', async () => {
    vi.useFakeTimers();
    try {
      save({ contextTokens: 32000, detectedContextTokens: 32000, capabilities: caps() });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(recorded.tokensPerMinute429())
        .mockResolvedValueOnce(recorded.tooManyTokens429())
        .mockImplementation(async () => reply('{"genre":"news"}'));
      const pending = LlmService.run(task);
      await vi.advanceTimersByTimeAsync(660);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toMatchObject({ value: { genre: 'news' } });
      expect(LlmService.contextTokens()).toBe(32000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('halves Context size when the overflow error names no size', async () => {
    save({ contextTokens: 32000, capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{"message":"prompt is too long"}}', { status: 400 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'context' });
    expect(LlmService.contextTokens()).toBe(16000);
  });

  it('halves Context size once for overflows of requests sent together', async () => {
    save({ contextTokens: 32000, capabilities: caps() });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":{"message":"prompt is too long"}}', { status: 400 }));
    const results = await Promise.all(['ch1', 'ch2', 'ch3'].map((user) =>
      LlmService.run({ ...task, user, priority: 'background' }).catch((error: unknown) => error)));
    expect(results.map((r) => (r as { reason?: string }).reason)).toEqual(['context', 'context', 'context']);
    expect(LlmService.contextTokens()).toBe(16000);
  });

  it('sizes requests to 8192 on a LAN server that reports no context', () => {
    save({ baseUrl: 'http://192.168.1.20:8080/v1' });
    expect(LlmService.contextTokens()).toBe(8192);
    save({ baseUrl: 'http://192.168.1.20:8080/v1', contextTokens: 16000 });
    expect(LlmService.contextTokens()).toBe(16000);
    save({});
    expect(LlmService.contextTokens()).toBe(16000);
  });
});
