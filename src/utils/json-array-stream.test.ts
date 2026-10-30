import { describe, it, expect } from 'vitest';
import { JsonArrayStream } from './json-array-stream';

function parse(pieces: string[]): unknown[] {
  const items: unknown[] = [];
  const stream = new JsonArrayStream(value => items.push(value));
  for (const piece of pieces) stream.push(piece);
  stream.finish();
  return items;
}

function splitEverywhere(text: string): string[][] {
  const splits: string[][] = [];
  for (let i = 1; i < text.length; i++) splits.push([text.slice(0, i), text.slice(i)]);
  return splits;
}

describe('JsonArrayStream', () => {
  const tricky = [
    { stream_id: 1, name: 'A, "B" [C] {D}', icon: 'http://host/a' },
    { stream_id: 2, name: 'back\\slash\\', tags: [1, [2, { x: ']' }]] },
    'plain',
    3,
    null,
  ];
  const text = ` \n${JSON.stringify(tricky, null, 1)}\n`;

  it('emits each element as it closes, wherever the pieces are split', () => {
    expect(parse([text])).toEqual(tricky);
    for (const pieces of splitEverywhere(text)) expect(parse(pieces)).toEqual(tricky);
  });

  it('emits elements before the array has finished arriving', () => {
    const items: unknown[] = [];
    const stream = new JsonArrayStream(value => items.push(value));
    stream.push('[{"stream_id":1},{"stream_id"');
    expect(items).toEqual([{ stream_id: 1 }]);
    stream.push(':2}]');
    stream.finish();
    expect(items).toEqual([{ stream_id: 1 }, { stream_id: 2 }]);
  });

  it('accepts an empty array and a leading byte order mark', () => {
    expect(parse(['[', ' ]'])).toEqual([]);
    expect(parse(['﻿[1]'])).toEqual([1]);
  });

  it('tells valid JSON that is not an array from invalid text', () => {
    expect(() => parse(['{"user_info":', '{}}'])).toThrow(expect.objectContaining({ code: 'not_array' }));
    expect(() => parse(['<html>', 'x</html>'])).toThrow(expect.objectContaining({ code: 'invalid_json' }));
  });

  it('rejects truncated, malformed, and trailing content', () => {
    for (const bad of ['[{"a":1}', '[1,,2]', '[1,]', '[{"a":}]', '[1]x', '[1}]']) {
      expect(() => parse([bad]), bad).toThrow(expect.objectContaining({ code: 'invalid_json' }));
    }
  });
});
