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

export async function fetchLimitedText(
  url: string,
  maxBytes: number,
  timeout: number,
  signal?: AbortSignal,
  requiredPrefix?: string,
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
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
      }
      return new TextDecoder().decode(bytes);
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!value?.length) continue;
      length += value.length;
      if (length > maxBytes) {
        throw new FetchTextError('too_large', `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
      if (requiredPrefix && length >= requiredPrefix.length) {
        let offset = 0;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length && offset < requiredPrefix.length; i++, offset++) {
            if (chunk[i] !== requiredPrefix.charCodeAt(offset)) {
              throw new FetchTextError(
                'invalid_content',
                `Response does not begin with ${requiredPrefix}`,
              );
            }
          }
          if (offset === requiredPrefix.length) break;
        }
      }
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    if (requiredPrefix && !text.startsWith(requiredPrefix)) {
      throw new FetchTextError(
        'invalid_content',
        `Response does not begin with ${requiredPrefix}`,
      );
    }
    return text;
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
