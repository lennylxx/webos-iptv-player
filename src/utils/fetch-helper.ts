import { FetchSession } from './fetch-session';

export type FetchTextErrorCode =
  | 'aborted'
  | 'timeout'
  | 'too_large'
  | 'http'
  | 'invalid_content';

export class FetchTextError extends Error {
  constructor(
    public readonly code: FetchTextErrorCode,
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'FetchTextError';
  }
}

/** Diagnostic reason for a failed fetch; never carries the URL. */
export function fetchFailureReason(error: unknown): string {
  if (error instanceof FetchTextError) {
    if (error.code === 'http') return `http_${String(error.status)}`;
    return error.code === 'invalid_content' ? 'parse' : error.code;
  }
  return 'network';
}

export type FetchPrefixVerdict = 'match' | 'mismatch' | 'undecided';
export type FetchPrefixValidator = (
  bytes: Uint8Array,
  complete: boolean,
) => FetchPrefixVerdict;

const NULL_BODY_STATUSES = [204, 205];

/** Resolves with the body already read, so the timeout covers it too. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 30000
): Promise<Response> {
  const session = new FetchSession(url, { timeout, signal: options.signal ?? undefined });
  try {
    const response = await session.open(options);
    if (!response.ok) {
      throw new FetchTextError('http', `HTTP ${response.status}: ${response.statusText}`, response.status);
    }
    const bytes = await session.readBody();
    const nullBody = NULL_BODY_STATUSES.indexOf(response.status) >= 0;
    return new Response(nullBody ? null : bytes as Uint8Array<ArrayBuffer>, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    session.close();
  }
}

export interface TextResult {
  ok: boolean;
  status: number;
  /** After redirects, to resolve relative URIs against. */
  url: string;
  /** Empty for an error status, whose body is not read. */
  text: string;
}

export async function fetchTextResult(
  url: string,
  timeout: number,
  init: { headers?: Record<string, string>; signal?: AbortSignal | null } = {},
): Promise<TextResult> {
  const session = new FetchSession(url, { timeout, signal: init.signal ?? undefined });
  try {
    const response = await session.open(init.headers ? { headers: init.headers } : {});
    const text = response.ok ? new TextDecoder().decode(await session.readBody()) : '';
    return { ok: response.ok, status: response.status, url: response.url || url, text };
  } catch (err) {
    if (session.stopReason === 'cancelled') throw new FetchTextError('aborted', 'Request was cancelled');
    if (session.stopReason === 'timeout') throw new FetchTextError('timeout', 'Request timed out');
    throw err;
  } finally {
    session.close();
  }
}

export async function fetchText(url: string, timeout = 30000): Promise<string> {
  const session = new FetchSession(url, { timeout });
  try {
    const response = await session.open();
    if (!response.ok) {
      throw new FetchTextError('http', `HTTP ${response.status}: ${response.statusText}`, response.status);
    }
    return new TextDecoder().decode(await session.readBody());
  } finally {
    session.close();
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

// Longest run of bytes that could still be leading BOM without being one yet.
function bomLength(bytes: readonly number[]): number {
  for (let i = 0; i < UTF8_BOM.length; i++) {
    if (i >= bytes.length) return -1; // undecided — need more bytes
    if (bytes[i] !== UTF8_BOM[i]) return 0;
  }
  return UTF8_BOM.length;
}

// Compare bytes against ASCII candidate prefixes after an optional UTF-8 BOM;
// byte-wise matching keeps prefix checks independent of text decoding.
function matchPrefixes(bytes: readonly number[], prefixes: readonly string[]): FetchPrefixVerdict {
  const bom = bomLength(bytes);
  if (bom < 0) return 'undecided';
  const body = bytes.slice(bom);
  let undecided = false;
  for (const prefix of prefixes) {
    let ok = true;
    for (let i = 0; i < prefix.length; i++) {
      if (i >= body.length) { undecided = true; ok = false; break; }
      if (body[i] !== prefix.charCodeAt(i)) { ok = false; break; }
    }
    if (ok) return 'match';
  }
  return undecided ? 'undecided' : 'mismatch';
}

export async function fetchLimitedText(
  url: string,
  maxBytes: number,
  timeout: number,
  signal?: AbortSignal,
  requiredPrefix?: string | readonly string[] | FetchPrefixValidator,
): Promise<string> {
  const session = new FetchSession(url, { timeout, signal });
  const validator = typeof requiredPrefix === 'function' ? requiredPrefix : null;
  const prefixes: readonly string[] = typeof requiredPrefix === 'string'
    ? [requiredPrefix]
    : requiredPrefix === undefined || typeof requiredPrefix === 'function'
      ? []
      : requiredPrefix;
  const prefixError = () => new FetchTextError(
    'invalid_content',
    validator
      ? 'Response has an invalid opening'
      : `Response does not begin with ${prefixes.join(' or ')}`,
  );
  const hasPrefixCheck = !!validator || prefixes.length > 0;
  const prefixProbeLength = validator
    ? 8192
    : prefixes.reduce((n, p) => Math.max(n, p.length), 0) + UTF8_BOM.length;
  const checkPrefix = (bytes: Uint8Array, complete: boolean): FetchPrefixVerdict =>
    validator
      ? validator(bytes, complete)
      : matchPrefixes(Array.from(bytes), prefixes);

  try {
    const response = await session.open();
    if (!response.ok) {
      throw new FetchTextError(
        'http', `HTTP ${response.status}: ${response.statusText}`, response.status);
    }
    const declaredLength = Number(response.headers?.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
    }
    if (!session.streaming) {
      throw new FetchTextError(
        'too_large',
        'Response size cannot be bounded without a stream reader',
      );
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    const head: number[] = [];
    let prefixSettled = !hasPrefixCheck;
    while (true) {
      const { done, value } = await session.read();
      if (done) break;
      if (!value?.length) continue;
      length += value.length;
      if (length > maxBytes) {
        throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
      if (!prefixSettled) {
        for (let i = 0; i < value.length && head.length < prefixProbeLength; i++) {
          head.push(value[i]);
        }
        const verdict = checkPrefix(new Uint8Array(head), false);
        if (verdict === 'mismatch') throw prefixError();
        if (verdict === 'match') prefixSettled = true;
        if (verdict === 'undecided' && head.length === prefixProbeLength) {
          throw prefixError();
        }
      }
    }
    if (!prefixSettled
        && checkPrefix(new Uint8Array(head), true) !== 'match') throw prefixError();

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof FetchTextError) throw err;
    if (session.stopReason === 'cancelled') throw new FetchTextError('aborted', 'Request was cancelled');
    if (session.stopReason === 'timeout') throw new FetchTextError('timeout', 'Request timed out');
    throw err;
  } finally {
    session.close();
  }
}
