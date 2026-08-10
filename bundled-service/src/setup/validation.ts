export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid setup request');
  }
  return value as Record<string, unknown>;
}

export function stringValue(
  value: unknown,
  field: string,
  maxLength: number,
  required = true,
): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) {
    throw new Error(`Invalid ${field}`);
  }
  return text;
}

export function httpUrl(value: unknown, field: string): string {
  const text = stringValue(value, field, 4096);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${field}`);
  }
  return text;
}
