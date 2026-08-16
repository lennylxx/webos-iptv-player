import { parseUrl } from '../compat';

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
  let parsed: ReturnType<typeof parseUrl>;
  try {
    parsed = parseUrl(text);
  } catch {
    throw new Error(`Invalid ${field}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error(`Invalid ${field}`);
  }
  return text;
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${field}`);
  return value;
}

const SUBTITLE_LANGUAGES = [
  '', 'en', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt', 'ru', 'ja', 'ko',
];

export function subtitleLanguage(value: unknown): string {
  if (typeof value !== 'string' || SUBTITLE_LANGUAGES.indexOf(value) < 0) {
    throw new Error('Invalid preferred subtitle language');
  }
  return value;
}
