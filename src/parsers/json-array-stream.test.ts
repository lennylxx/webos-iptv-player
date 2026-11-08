import { describe, expect, it } from 'vitest';
import { JsonArrayStream, JsonArrayStreamError } from './json-array-stream';

function parseInPieces(text: string, size: number): unknown[] {
  const values: unknown[] = [];
  const stream = new JsonArrayStream(value => values.push(value));
  for (let i = 0; i < text.length; i += size) stream.write(text.slice(i, i + size));
  stream.finish();
  return values;
}

describe('JsonArrayStream', () => {
  const text = '\uFEFF [ {"a":"x,]}\\"{[","n":[1,{"b":2}]} , 7, "s]", null,{"e":{}} ]  ';
  const expected = [{ a: 'x,]}"{[', n: [1, { b: 2 }] }, 7, 's]', null, { e: {} }];

  it('yields the same elements however the text is split', () => {
    for (let size = 1; size <= text.length; size++) {
      expect(parseInPieces(text, size)).toEqual(expected);
    }
  });

  it('accepts an empty array', () => {
    expect(parseInPieces(' [ ] ', 1)).toEqual([]);
  });

  it.each([
    ['an object response', '{"user_info":{}}'],
    ['a truncated array', '[{"a":1},{"a":'],
    ['a missing element', '[1,,2]'],
    ['a trailing comma', '[1,]'],
    ['a leading comma', '[,1]'],
    ['an invalid element', '[{"a":}]'],
    ['data after the array', '[1] 2'],
    ['no data', ''],
  ])('rejects %s', (_name, input) => {
    expect(() => parseInPieces(input, 3)).toThrow(JsonArrayStreamError);
  });
});
