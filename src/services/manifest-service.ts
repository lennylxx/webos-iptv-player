import { CONFIG } from '../config';
import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';

const REASON = /^[a-z0-9_]{1,32}$/;

export interface ServiceManifestSuccess {
  ok: true;
  status: number;
  url: string;
  text: string;
}

/** reason: the service's error code (e.g. http_403, timeout), or unavailable, aborted, invalid. */
export interface ServiceManifestFailure {
  ok: false;
  reason: string;
}

export type ServiceManifestResult = ServiceManifestSuccess | ServiceManifestFailure;

interface FetchManifestResponse extends LunaResponse {
  status?: unknown;
  url?: unknown;
  text?: unknown;
}

export interface ServiceManifestOptions {
  maxBytes: number;
  timeoutMs: number;
  // Added to the app-side wait: the service may still be starting.
  graceMs: number;
  signal?: AbortSignal;
}

function failureReason(response: LunaResponse): string {
  const code: unknown = response.errorCode;
  // A string code is the service's own; a numeric one is the Luna bus's.
  return typeof code === 'string' && REASON.test(code) ? code : 'unavailable';
}

/**
 * GET a master playlist or MPD through the bundled service, which can send
 * the channel's headers. Never rejects: an unreachable service is a failure.
 */
export function fetchManifestViaService(
  url: string,
  headers: Record<string, string>,
  options: ServiceManifestOptions,
): Promise<ServiceManifestResult> {
  return new Promise<ServiceManifestResult>(resolve => {
    const signal = options.signal;
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'aborted' });
      return;
    }
    if (!isLunaAvailable()) {
      resolve({ ok: false, reason: 'unavailable' });
      return;
    }
    let settled = false;
    let request: { cancel(): void } | null = null;
    const onAbort = (): void => settle({ ok: false, reason: 'aborted' });
    const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }),
      options.timeoutMs + options.graceMs);
    function settle(result: ServiceManifestResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      request?.cancel();
      resolve(result);
    }
    signal?.addEventListener('abort', onAbort);
    try {
      request = lunaRequest<FetchManifestResponse>(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'fetchManifest',
        parameters: { url, headers, maxBytes: options.maxBytes, timeoutMs: options.timeoutMs },
        onSuccess: response => {
          const { status, url: finalUrl, text } = response;
          if (typeof status !== 'number' || typeof finalUrl !== 'string' || !finalUrl
              || typeof text !== 'string') {
            settle({ ok: false, reason: 'invalid' });
            return;
          }
          settle({ ok: true, status, url: finalUrl, text });
        },
        onFailure: response => settle({ ok: false, reason: failureReason(response) }),
      });
    } catch {
      settle({ ok: false, reason: 'unavailable' });
    }
  });
}
