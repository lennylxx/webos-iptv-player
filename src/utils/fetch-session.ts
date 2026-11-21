import { CONFIG } from '../config';

export type FetchStopReason = 'timeout' | 'cancelled';

export class FetchStopError extends Error {
  constructor(public readonly reason: FetchStopReason) {
    super(reason === 'timeout' ? 'Request timed out' : 'Request was cancelled');
    this.name = 'FetchStopError';
  }
}

export interface FetchSessionOptions {
  /** The whole download, headers and body. */
  timeout: number;
  /** Stop when the headers take this long. */
  headersTimeout?: number;
  /** Stop when the body sends nothing for this long. */
  idleTimeout?: number;
  signal?: AbortSignal;
}

/**
 * Ends a download that makes no progress for `timeout`, before or after its
 * headers, so a slow but steady body still finishes.
 */
export function progressTimeouts(timeout: number, signal?: AbortSignal | null): FetchSessionOptions {
  return {
    timeout: Math.max(timeout, CONFIG.NETWORK.DOWNLOAD_CAP_MS),
    headersTimeout: timeout,
    idleTimeout: timeout,
    ...(signal ? { signal } : {}),
  };
}

/**
 * One download's abort, timers, and body reader. Chromium 53's polyfilled
 * AbortController only fails a fetch still waiting for its headers, so
 * stopping also cancels the reader, or a stalled body would hang forever.
 */
export class FetchSession {
  private readonly controller = new AbortController();
  private response: Response | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private complete = false;
  private reason: FetchStopReason | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private readonly onExternalAbort = (): void => this.stop('cancelled');

  constructor(private readonly url: string, private readonly options: FetchSessionOptions) {}

  get stopReason(): FetchStopReason | null {
    return this.reason;
  }

  /** False when the engine gives no body stream; read the body with readAll(). */
  get streaming(): boolean {
    return typeof this.response?.body?.getReader === 'function';
  }

  async open(init: RequestInit = {}): Promise<Response> {
    const { timeout, headersTimeout, signal } = this.options;
    this.deadline = Date.now() + timeout;
    this.totalTimer = setTimeout(() => this.stop('timeout'), timeout);
    if (headersTimeout !== undefined) this.armIdle(Math.min(headersTimeout, timeout));
    if (signal?.aborted) this.stop('cancelled');
    else signal?.addEventListener('abort', this.onExternalAbort);
    if (this.reason) throw new FetchStopError(this.reason);
    try {
      this.response = await fetch(this.url, { ...init, signal: this.controller.signal });
    } catch (error) {
      throw this.reason ? new FetchStopError(this.reason) : error;
    }
    if (this.reason) throw new FetchStopError(this.reason);
    this.touch();
    return this.response;
  }

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const response = this.opened();
    if (!this.reader) this.reader = response.body!.getReader();
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await this.reader.read();
    } catch (error) {
      throw this.reason ? new FetchStopError(this.reason) : error;
    }
    // A cancelled read ends as `done`, which must not pass for a whole body.
    if (this.reason) throw new FetchStopError(this.reason);
    if (next.done) this.finish();
    else this.touch();
    return next;
  }

  async readAll(): Promise<Uint8Array> {
    const response = this.opened();
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw this.reason ? new FetchStopError(this.reason) : error;
    }
    if (this.reason) throw new FetchStopError(this.reason);
    this.finish();
    return bytes;
  }

  /** Up to `maxBytes` of the body; close() releases the rest. */
  async readPrefix(maxBytes: number): Promise<Uint8Array> {
    if (!this.streaming) {
      const all = await this.readAll();
      return all.length > maxBytes ? all.subarray(0, maxBytes) : all;
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (length < maxBytes) {
      const next = await this.read();
      if (next.done) break;
      if (!next.value?.length) continue;
      chunks.push(next.value);
      length += next.value.length;
    }
    return joinBytes(chunks, Math.min(length, maxBytes));
  }

  async readBody(): Promise<Uint8Array> {
    if (!this.streaming) return this.readAll();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await this.read();
      if (next.done) return joinBytes(chunks, length);
      if (!next.value?.length) continue;
      chunks.push(next.value);
      length += next.value.length;
    }
  }

  /** Holds the timeouts; the returned call resumes them, the whole one with the time left. */
  pause(): () => void {
    if (this.totalTimer === null) return () => undefined;
    clearTimeout(this.totalTimer);
    this.totalTimer = null;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const remaining = Math.max(0, this.deadline - Date.now());
    return () => {
      if (this.reason || this.totalTimer !== null) return;
      this.deadline = Date.now() + remaining;
      this.totalTimer = setTimeout(() => this.stop('timeout'), remaining);
      if (!this.complete) this.touch();
    };
  }

  stop(reason: FetchStopReason): void {
    if (!this.reason) this.reason = reason;
    this.controller.abort();
    this.cancelBody();
  }

  close(): void {
    if (this.totalTimer !== null) clearTimeout(this.totalTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.totalTimer = null;
    this.idleTimer = null;
    this.options.signal?.removeEventListener('abort', this.onExternalAbort);
    if (!this.complete) {
      this.controller.abort();
      this.cancelBody();
    }
  }

  private opened(): Response {
    if (!this.response) throw new Error('FetchSession read before open');
    return this.response;
  }

  // The idle wait guards the body only; work after it is the total timeout's.
  private finish(): void {
    this.complete = true;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch(): void {
    if (this.options.idleTimeout !== undefined) this.armIdle(this.options.idleTimeout);
    else if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle(ms: number): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('timeout'), ms);
  }

  // A body nobody reads keeps the connection open where abort can't reach it.
  // Never throws: it runs from close() in a finally.
  private cancelBody(): void {
    try {
      if (this.reader) {
        void this.reader.cancel().catch(() => undefined);
      } else if (this.response?.body && !this.response.bodyUsed
        && typeof this.response.body.cancel === 'function') {
        void this.response.body.cancel().catch(() => undefined);
      }
    } catch { /* already released */ }
  }
}

function joinBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const take = Math.min(chunk.length, length - offset);
    bytes.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return bytes;
}
