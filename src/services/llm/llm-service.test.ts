// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = new Map<string, unknown>();
vi.mock('../idb-cache', () => ({
  getCachedLlmResult: vi.fn(async (key: string) => cache.get(key)),
  setCachedLlmResult: vi.fn(async (key: string, value: unknown) => { cache.set(key, value); }),
}));

import { StorageService } from '../storage-service';
import { defaultLlmConfig } from './config';
import { LlmService, resetLlmServiceForTests, type LlmTask } from './llm-service';
import type { LlmConfig } from './types';

const task: LlmTask = {
  feature: 'f1',
  priority: 'foreground',
  system: 'Classify.',
  user: 'ch1',
  promptVersion: 1,
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
const SIGNATURE = `${REMOTE}|m1`;

function save(patch: Partial<LlmConfig>): LlmConfig {
  const config: LlmConfig = {
    ...defaultLlmConfig(),
    enabled: true,
    baseUrl: REMOTE,
    model: 'm1',
    features: { f1: true },
    ...patch,
  };
  StorageService.setLlmConfig(config);
  return config;
}

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
    save({ features: {}, capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
      .mockResolvedValueOnce(new Response('{"error":"response_format json_schema unsupported"}', { status: 400 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'))
      .mockResolvedValueOnce(reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' }, cached: false });
    expect((bodyOf(spy.mock.calls[2]).response_format as { type: string }).type).toBe('json_object');
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ signature: SIGNATURE, structured: 'json_object' });
  });

  it('works with a local model that thinks before answering', async () => {
    save({ baseUrl: 'http://host:8080/v1' });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply('<think>easy</think>{"ok":true,"word":"bravo"}'))
      .mockResolvedValueOnce(reply('<think>news channel</think>\n```json\n{"genre":"news"}\n```'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(bodyOf(spy.mock.calls[1]).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(spy.mock.calls[1][1]!.headers).not.toHaveProperty('Authorization');
  });

  it('serves a repeat request from the cache without calling the API', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"sports"}'));
    await LlmService.run(task);
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'sports' }, cached: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(LlmService.usageToday().features.f1).toEqual({ requests: 1, inputTokens: 10, outputTokens: 2 });
  });

  it('counts a request stopped after it was sent, but not one stopped before', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
    save({ dailyRequestCap: 1, capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    await expect(LlmService.run({ ...task, user: 'ch2' })).rejects.toMatchObject({ reason: 'cap' });
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(LlmService.run({ ...task, user: 'ch2', ignoreCap: true })).resolves.toMatchObject({ cached: false });
  });

  it('retries a foreground reply that misses the schema once, then fails and logs it', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'prompt', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply('{"genre":"cooking"}'));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'schema' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.failed', 'feature=f1', 'reason=schema');
  });

  it('logs an auth failure without the key', async () => {
    save({ apiKey: 'k1', capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"bad"}', { status: 401 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'auth' });
    expect(warn).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.request.failed', 'feature=f1', 'reason=auth', 'status=401');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('k1');
  });

  it('moves past a mode a local chat template fails on with a 500', async () => {
    save({ baseUrl: 'http://host:8080/v1' });
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"template error"}', { status: 500 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'))
      .mockResolvedValueOnce(reply('{"genre":"news"}'));
    await expect(LlmService.run(task)).resolves.toMatchObject({ value: { genre: 'news' } });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not downgrade the mode when a remote server is briefly overloaded', async () => {
    save({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"overloaded"}', { status: 503 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'http', status: 503 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(StorageService.getLlmConfig().capabilities).toBeNull();
  });

  it('checks the daily cap when a queued request is sent, not when it is queued', async () => {
    save({ dailyRequestCap: 2, capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
      save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '20' } }))
        .mockImplementation(async () => reply('{"genre":"news"}'));
      await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'quota' });
      save({ model: 'm2', capabilities: { signature: `${REMOTE}|m2`, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
      const next = LlmService.run(task);
      await vi.advanceTimersByTimeAsync(19000);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(next).resolves.toMatchObject({ value: { genre: 'news' } });
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

  it('remembers that a model needs reasoning parameters', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":{"message":"Unsupported value: \'temperature\' does not support 0 with this model."}}', { status: 400 }))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ reasoningParams: true });
  });

  it('reports a failing server instead of saving a prompt-only fallback', async () => {
    save({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"down"}', { status: 502 }));
    await expect(LlmService.run(task)).rejects.toMatchObject({ reason: 'http', status: 502 });
    expect(StorageService.getLlmConfig().capabilities).toBeNull();
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({
      models: ['m1'],
      capabilities: { structured: 'json_schema', thinkingOff: false },
    });
  });

  it('reads the context size a server reports for the model', async () => {
    const config = save({ enabled: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm0', max_model_len: 4096 }, { id: 'm1', context_length: 32768 }] }), { status: 200 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({ contextTokens: 32768 });
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=models', 'tokens=32768');
  });

  it('reads llama.cpp’s context from /props, and reports none for other servers', async () => {
    const config = save({ enabled: false, baseUrl: 'http://host:8080/v1' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1', owned_by: 'llamacpp', meta: { n_ctx_train: 262144 } }] }), { status: 200 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 }));
    await expect(LlmService.testConnection(config)).resolves.toMatchObject({ contextTokens: 8192 });
    expect(String(spy.mock.calls[2][0])).toBe('http://host:8080/props');
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=props', 'tokens=8192');

    resetLlmServiceForTests();
    const remote = save({ enabled: false });
    spy.mockReset();
    spy
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'));
    await expect(LlmService.testConnection(remote)).resolves.toMatchObject({ contextTokens: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.context.detected', 'source=none', 'tokens=0');
  });

  it('runs a plain-text task without a response format, and caches only accepted replies', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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

  it('answers an identical plain-text request still out without sending it again', async () => {
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
      capabilities: { signature: 'http://host:8080/v1|m1', structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 },
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
    save({ capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
        capabilities: { signature: `${server}|m1`, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 },
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

  it('reports a remote server error during Test connection instead of falling back', async () => {
    const config = save({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }))
      .mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(LlmService.testConnection(config)).rejects.toMatchObject({ reason: 'http', status: 500 });
  });

  it('turns a local model\'s thinking off with reasoning_effort, and drops it where it is rejected', async () => {
    save({ baseUrl: 'http://host:11434/v1' });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"reasoning_effort: none is not a valid value"}', { status: 400 }))
      .mockResolvedValueOnce(reply('{"ok":true,"word":"bravo"}'))
      .mockImplementation(async () => reply('{"genre":"news"}'));
    await LlmService.run(task);
    const first = bodyOf(spy.mock.calls[0]);
    const second = bodyOf(spy.mock.calls[1]);
    expect(first).toMatchObject({ reasoning_effort: 'none', think: false, chat_template_kwargs: { enable_thinking: false } });
    expect(second).not.toHaveProperty('reasoning_effort');
    expect(second).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(StorageService.getLlmConfig().capabilities).toMatchObject({ thinkingOff: true, effortOff: false });
    expect(info).toHaveBeenCalledWith('[LLM]', expect.any(String), 'event=llm.capability.detected', 'profile=local',
      'mode=json_schema', 'thinking_off=true', 'effort_off=false', 'reasoning_params=false');
    info.mockRestore();
  });

  it('logs a reached daily cap once, not for every refused request', async () => {
    save({ dailyRequestCap: 1, capabilities: { signature: SIGNATURE, structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
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
      save({ baseUrl: 'http://host:8080/v1', capabilities: { signature: 'http://host:8080/v1|m1', structured: 'json_schema', thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1 } });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 429 }))
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
