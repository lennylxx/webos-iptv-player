export const JSON_NULL_BYTES = 4;

// Printable ASCII other than `"` and `\` serializes one byte per character.
const JSON_PLAIN_ASCII = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

function jsonStringBytes(value: string): number {
  if (JSON_PLAIN_ASCII.test(value)) return value.length + 2;
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9
        || code === 10 || code === 12 || code === 13) {
      bytes += 2;
    } else if (code < 32) {
      bytes += 6;
    } else if (code < 128) {
      bytes++;
    } else if (code < 2048) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff
        && i + 1 < value.length
        && value.charCodeAt(i + 1) >= 0xdc00
        && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// The record's JSON size, which cache accounting charges it.
export function serializedBytes(value: unknown): number {
  const ancestors: object[] = [];
  // Records repeat the same few field names across every item.
  const keyBytes = new Map<string, number>();

  const measure = (item: unknown, arrayItem: boolean): number => {
    switch (typeof item) {
      case 'string':
        return jsonStringBytes(item);
      case 'number':
        return Number.isFinite(item) ? String(item).length : JSON_NULL_BYTES;
      case 'boolean':
        return item ? 4 : 5;
      case 'bigint':
        throw new TypeError('BigInt cannot be serialized to JSON');
      case 'undefined':
      case 'function':
      case 'symbol':
        return arrayItem ? JSON_NULL_BYTES : 0;
      case 'object':
        break;
    }
    if (item === null) return JSON_NULL_BYTES;
    if (item instanceof Date) {
      return Number.isFinite(item.getTime())
        ? jsonStringBytes(item.toISOString())
        : JSON_NULL_BYTES;
    }
    if (ancestors.indexOf(item) >= 0) throw new TypeError('Circular cache value');
    ancestors.push(item);
    let bytes = 2;
    let entries = 0;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        bytes += measure(item[i], true);
        entries++;
      }
    } else {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const valueBytes = measure(record[key], false);
        if (!valueBytes) continue;
        let nameBytes = keyBytes.get(key);
        if (nameBytes === undefined) {
          nameBytes = jsonStringBytes(key);
          keyBytes.set(key, nameBytes);
        }
        bytes += nameBytes + 1 + valueBytes;
        entries++;
      }
    }
    ancestors.pop();
    return bytes + Math.max(0, entries - 1);
  };

  return measure(value, false);
}
