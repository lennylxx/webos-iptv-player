import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedSchema } from './llm/types';

const { run, contextTokens, outputCap } = vi.hoisted(() => ({
  outputCap: vi.fn(() => 0),
  run: vi.fn(),
  contextTokens: vi.fn(() => 16000),
}));
vi.mock('./llm/llm-service', () => ({ LlmService: { run, contextTokens, outputCap } }));

import { LlmError } from './llm/client';
import { validate } from './llm/json';
import { planBatches, suggestAdultGroups, type ParentalAiGroup } from './parental-ai-suggestions';

interface Task {
  feature: string;
  user: string;
  schema: NamedSchema;
  maxTokens: number;
}

const group = (name: string, samples?: string[]): ParentalAiGroup => ({ key: `k:${name}`, name, samples });
const task = (call: number): Task => run.mock.calls[call][0] as Task;
const reply = (flagged: unknown[], cached = false) => ({ value: { flagged }, dropped: 0, cached });

let lines: string[] = [];

beforeEach(() => {
  run.mockReset();
  contextTokens.mockReturnValue(16000);
  outputCap.mockReset();
  outputCap.mockReturnValue(0);
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
});

afterEach(() => vi.restoreAllMocks());

describe('planBatches', () => {
  it('orders by name, so the same groups make the same batches', () => {
    const a = planBatches([group('Charlie'), group('Alpha'), group('Bravo')], 16000);
    const b = planBatches([group('Bravo'), group('Charlie'), group('Alpha')], 16000);
    expect(a).toEqual(b);
    expect(a[0].map(g => g.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('splits by item count and by the context size', () => {
    const many = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    expect(planBatches(many, 16000).map(batch => batch.length)).toEqual([200, 200, 50]);
    // A larger context takes more a batch, as long as every item could be flagged within 8192 reply tokens.
    expect(planBatches(many, 32000).map(batch => batch.length)).toEqual([338, 112]);
    expect(planBatches(many, 128000).map(batch => batch.length)).toEqual([338, 112]);
    const small = planBatches(many, 2048);
    expect(small.length).toBeGreaterThan(3);
    expect(small.reduce((sum, batch) => sum + batch.length, 0)).toBe(450);
  });
});

describe('suggestAdultGroups', () => {
  it('sends names and up to three samples, never keys, and maps verdicts to keys', async () => {
    run.mockResolvedValue(reply([
      { i: 1, verdict: 'adult', confidence: 'high' },
      { i: 0, verdict: 'mature', confidence: 'low' },
    ]));
    const result = await suggestAdultGroups('live', [
      group('Bravo', ['ch1', 'ch2', 'ch3', 'ch4']),
      group('Alpha'),
    ]);
    expect(task(0).feature).toBe('parental-suggestions');
    expect(JSON.parse(task(0).user)).toEqual({
      kind: 'live',
      items: [{ i: 0, name: 'Alpha' }, { i: 1, name: 'Bravo', samples: ['ch1', 'ch2', 'ch3'] }],
    });
    expect(task(0).user).not.toContain('k:');
    expect(result).toEqual({
      checked: ['k:Alpha', 'k:Bravo'],
      flagged: { 'k:Alpha': 'mature-low', 'k:Bravo': 'adult-high' },
      batches: 1,
      failedBatches: 0,
      failure: null,
    });
    expect(lines.some(line => line.includes('event=parental.ai.run') && line.includes('kind=live')
      && line.includes('sent=2') && line.includes('flagged=2') && line.includes('reason=none'))).toBe(true);
    expect(lines.join('\n')).not.toContain('Alpha');
  });

  it('drops indexes outside the batch, unknown verdicts, and repeated indexes', async () => {
    run.mockImplementation(async (sent: Task) => {
      const checked = validate(sent.schema.schema, {
        flagged: [
          { i: 0, verdict: 'adult', confidence: 'high' },
          { i: 0, verdict: 'mature', confidence: 'low' },
          { i: 2, verdict: 'adult', confidence: 'high' },
          { i: 1, verdict: 'unsafe', confidence: 'high' },
        ],
      });
      return { value: checked!.value, dropped: checked!.dropped, cached: false };
    });
    const result = await suggestAdultGroups('vod', [group('Alpha'), group('Bravo')]);
    expect(result.flagged).toEqual({ 'k:Alpha': 'adult-high' });
    expect(lines.some(line => line.includes('event=parental.ai.run') && line.includes('dropped=3'))).toBe(true);
  });

  it('stops at the first failed batch and keeps what finished before it', async () => {
    const groups = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    contextTokens.mockReturnValue(16000);
    run.mockResolvedValueOnce(reply([{ i: 0, verdict: 'adult', confidence: 'low' }], true))
      .mockRejectedValueOnce(new LlmError('quota', 'quota'));
    const progress = vi.fn();
    const result = await suggestAdultGroups('series', groups, { onProgress: progress });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.checked).toHaveLength(200);
    expect(result.flagged).toEqual({ 'k:Group 1000': 'adult-low' });
    expect(result).toMatchObject({ batches: 3, failedBatches: 2, failure: 'quota' });
    expect(progress).toHaveBeenLastCalledWith(1, 3);
    expect(lines.some(line => line.includes('event=parental.ai.run') && line.includes('cached=1')
      && line.includes('failed=2') && line.includes('reason=quota'))).toBe(true);
  });

  it('sends a batch that overflowed the context again in smaller batches', async () => {
    const groups = Array.from({ length: 150 }, (_, i) => group(`Group ${1000 + i}`));
    run.mockRejectedValueOnce(new LlmError('context', 'HTTP 400', 400, 0, '', 2048))
      .mockImplementation(async () => {
        contextTokens.mockReturnValue(2048);
        return reply([]);
      });
    contextTokens.mockReturnValueOnce(16000).mockReturnValue(2048);
    const result = await suggestAdultGroups('live', groups);
    expect(task(0).user).toContain('Group 1149');
    expect(run.mock.calls.length).toBeGreaterThan(2);
    expect(result.checked).toHaveLength(150);
    expect(result.failure).toBeNull();
  });

  it('plans the later batches for a Context size an overflow lowered, so they don\'t overflow first', async () => {
    const groups = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    let context = 16000;
    contextTokens.mockImplementation(() => context);
    let overflows = 0;
    run.mockImplementation(async (task: Task) => {
      const items = (JSON.parse(task.user) as { items: unknown[] }).items;
      if (context === 16000 || items.length > 150) {
        context = 2048;
        overflows++;
        throw new LlmError('context', 'HTTP 400', 400);
      }
      return reply([]);
    });
    const result = await suggestAdultGroups('live', groups);
    expect(overflows).toBe(1);
    expect(result.checked).toHaveLength(450);
    expect(result.failure).toBeNull();
  });

  it('keeps every batch\'s reply within the model\'s output cap, also one learned mid-run', async () => {
    const groups = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    run.mockImplementation(async () => {
      outputCap.mockReturnValue(1000);
      return reply([]);
    });
    const result = await suggestAdultGroups('live', groups);
    expect(task(0).maxTokens).toBe(64 + 24 * 200);
    expect((run.mock.calls[0][0] as { splittable?: boolean }).splittable).toBe(true);
    expect(run.mock.calls.slice(1).every((_, i) => task(i + 1).maxTokens <= 1000)).toBe(true);
    expect(result.checked).toHaveLength(450);

    run.mockClear();
    await suggestAdultGroups('live', groups);
    expect(run.mock.calls.every((_, i) => task(i).maxTokens <= 1000)).toBe(true);
  });

  it('skips a single group whose reply is unusable and goes on, but stops at an unusable batch of several', async () => {
    outputCap.mockReturnValue(64 + 24);
    run.mockRejectedValueOnce(new LlmError('schema', 'Reply did not match the schema')).mockResolvedValue(reply([]));
    const result = await suggestAdultGroups('live', [group('Alpha'), group('Bravo'), group('Charlie')]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ failure: null, failedBatches: 1 });
    expect(result.checked).toHaveLength(2);

    outputCap.mockReturnValue(0);
    run.mockReset();
    run.mockRejectedValue(new LlmError('schema', 'Reply did not match the schema'));
    expect((await suggestAdultGroups('live', [group('Alpha'), group('Bravo')])).failure).toBe('schema');
  });

  it('fails a single group that overflows the context instead of splitting it', async () => {
    run.mockRejectedValue(new LlmError('context', 'HTTP 400', 400));
    const result = await suggestAdultGroups('live', [group('Alpha')]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.failure).toBe('context');
  });

  it('skips a batch the content policy blocks and goes on with the rest', async () => {
    const groups = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    run.mockRejectedValueOnce(new LlmError('blocked', 'HTTP 400', 400))
      .mockResolvedValue(reply([]));
    const result = await suggestAdultGroups('live', groups);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.checked).toHaveLength(250);
    expect(result).toMatchObject({ batches: 3, failedBatches: 1, failure: null });
  });

  it('rechecks each batch before sending it, and skips one left empty', async () => {
    const groups = Array.from({ length: 450 }, (_, i) => group(`Group ${1000 + i}`));
    contextTokens.mockReturnValue(16000);
    const locked = new Set<string>();
    run.mockImplementation(async () => {
      // Locked while the first batch runs: the second half of batch 2 and all of batch 3.
      groups.slice(300).forEach(g => locked.add(g.key));
      return reply([]);
    });
    const result = await suggestAdultGroups('vod', groups, { eligible: key => !locked.has(key) });
    expect(run).toHaveBeenCalledTimes(2);
    const names = JSON.parse(task(1).user).items.map((item: { name: string }) => item.name);
    expect(names).toHaveLength(100);
    expect(names).not.toContain('Group 1300');
    expect(result.checked).toHaveLength(300);
    expect(lines.some(line => line.includes('event=parental.ai.run') && line.includes('sent=300'))).toBe(true);
  });

  it('logs nothing when the user cancels', async () => {
    run.mockRejectedValue(new LlmError('cancelled', 'cancelled'));
    const result = await suggestAdultGroups('live', [group('Alpha')]);
    expect(result.failure).toBe('cancelled');
    expect(lines.some(line => line.includes('event=parental.ai.run'))).toBe(false);
  });
});
