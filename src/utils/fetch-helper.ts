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
  ) {
    super(message);
    this.name = 'FetchTextError';
  }
}

export type FetchPrefixVerdict = 'match' | 'mismatch' | 'undecided';
export type FetchPrefixValidator = (
  bytes: Uint8Array,
  complete: boolean,
) => FetchPrefixVerdict;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, timeout = 30000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPlaylistText(url: string, timeout = 30000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { decodePlaylistBytes } = await import('../parsers/m3u-parser');
    return decodePlaylistBytes(bytes);
  } finally {
    clearTimeout(timer);
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
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const onTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  const timer = setTimeout(onTimeout, timeout);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort);

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

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let complete = false;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new FetchTextError('http', `HTTP ${response.status}: ${response.statusText}`);
    }
    const declaredLength = Number(response.headers?.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
    }
    reader = typeof response.body?.getReader === 'function'
      ? response.body.getReader()
      : null;
    if (!reader) {
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
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
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
    if (signal?.aborted) throw new FetchTextError('aborted', 'Request was cancelled');
    if (timedOut) throw new FetchTextError('timeout', 'Request timed out');
    throw err;
  } finally {
    if (reader && !complete) void reader.cancel().catch(() => {});
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchMaybeGzipText(url: string, timeout = 30000): Promise<string> {
  const response = await fetchWithTimeout(url, {}, timeout);
  let bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const { gunzipSync } = await import('fflate');
    bytes = gunzipSync(bytes);
  }

  return new TextDecoder().decode(bytes);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2,
  timeout = 30000
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url, options, timeout);
    } catch (err) {
      lastError = err as Error;
      if (i < retries) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}
