import { describe, expect, it } from 'vitest';
import { extractJson, stripThinking, validate } from './json';
import type { JsonSchema } from './types';

const ROWS: JsonSchema = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, genre: { type: 'string', enum: ['news', 'sports'] } },
        required: ['id', 'genre'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

describe('LLM reply parsing', () => {
  it('drops thinking blocks, closed or truncated', () => {
    expect(stripThinking('<think>plan</think>\n{"a":1}')).toBe('{"a":1}');
    expect(stripThinking('{"a":1}<think>cut off')).toBe('{"a":1}');
  });

  it('finds JSON inside code fences and prose', () => {
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! {not json} Here: {"a":"}"} done')).toEqual({ a: '}' });
    expect(extractJson('<think>{"draft":1}</think>[3]')).toEqual([3]);
    expect(extractJson('no json here')).toBeUndefined();
  });

  it('keeps valid rows, drops bad ones, and strips unknown keys', () => {
    const result = validate(ROWS, {
      rows: [
        { id: 1, genre: 'news', extra: 'x' },
        { id: 2, genre: 'cooking' },
        { id: 2.5, genre: 'sports' },
        { id: 3, genre: 'sports' },
      ],
      note: 'ignored',
    });
    expect(result).toEqual({
      value: { rows: [{ id: 1, genre: 'news' }, { id: 3, genre: 'sports' }] },
      dropped: 2,
    });
  });

  it('rejects a reply missing a required field', () => {
    expect(validate(ROWS, { items: [] })).toBeNull();
    expect(validate(ROWS, [])).toBeNull();
  });
});
