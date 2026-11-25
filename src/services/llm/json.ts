import type { JsonSchema } from './types';

/**
 * Drops `<think>…</think>` blocks, an unclosed one a truncated reply leaves,
 * and the thinking before a lone `</think>` whose opening tag the server ate.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '')
    .replace(/<think>[\s\S]*$/, '').trim();
}

/** Finds the first complete JSON object or array in a reply, past fences and chatter. */
export function extractJson(text: string): unknown {
  const body = stripThinking(text);
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    // Fall through to scanning for an embedded value.
  }
  for (let start = 0; start < body.length; start++) {
    const open = body.charAt(start);
    if (open !== '{' && open !== '[') continue;
    const end = matchingClose(body, start);
    if (end < 0) continue;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // Keep scanning; a brace in prose can precede the real value.
    }
  }
  return undefined;
}

function matchingClose(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

export interface Validated {
  value: unknown;
  // Array items that failed and were dropped, so one bad row doesn't sink a batch.
  dropped: number;
}

/** Checks a value against the schema subset we send; extra object keys are stripped. */
export function validate(schema: JsonSchema, value: unknown): Validated | null {
  const counter = { dropped: 0 };
  const result = check(schema, value, counter);
  return result.ok ? { value: result.value, dropped: counter.dropped } : null;
}

type Checked = { ok: true; value: unknown } | { ok: false };
const FAIL: Checked = { ok: false };

function check(schema: JsonSchema, value: unknown, counter: { dropped: number }): Checked {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return FAIL;
      if (schema.enum && schema.enum.indexOf(value) < 0) return FAIL;
      return { ok: true, value };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : FAIL;
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !isFinite(value)) return FAIL;
      if (schema.type === 'integer' && Math.floor(value) !== value) return FAIL;
      if (schema.minimum !== undefined && value < schema.minimum) return FAIL;
      if (schema.maximum !== undefined && value > schema.maximum) return FAIL;
      return { ok: true, value };
    }
    case 'array': {
      if (!Array.isArray(value)) return FAIL;
      const items: unknown[] = [];
      for (const item of value) {
        const result = check(schema.items, item, counter);
        if (result.ok) items.push(result.value);
        else counter.dropped++;
      }
      return { ok: true, value: schema.maxItems !== undefined ? items.slice(0, schema.maxItems) : items };
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return FAIL;
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(schema.properties)) {
        if (!(key in source)) {
          if (schema.required.indexOf(key) >= 0) return FAIL;
          continue;
        }
        const result = check(schema.properties[key], source[key], counter);
        if (!result.ok) return FAIL;
        out[key] = result.value;
      }
      return { ok: true, value: out };
    }
  }
}

/** A compact description of the schema for endpoints that can't enforce one. */
export function schemaInstruction(schema: JsonSchema): string {
  return 'Reply with only a JSON value, no prose or code fences, matching this JSON Schema:\n' +
    JSON.stringify(schema);
}
