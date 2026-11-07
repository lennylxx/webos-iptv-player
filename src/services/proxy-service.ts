import { CONFIG } from '../config';
import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';

const REASON = /^[a-z0-9_]{1,32}$/;
const PROXIED = /^http:\/\/127\.0\.0\.1:\d{1,5}\/p\/[0-9a-f]{32}\//;

export interface StreamProxySuccess {
  ok: true;
  url: string;
  token: string;
}

/** reason: the service's error code (e.g. bad_url), or unavailable, timeout, invalid. */
export interface StreamProxyFailure {
  ok: false;
  reason: string;
}

export type StreamProxyResult = StreamProxySuccess | StreamProxyFailure;

interface OpenProxyResponse extends LunaResponse {
  url?: unknown;
  token?: unknown;
}

function failureReason(code: unknown): string {
  // A string code is the service's own; a numeric one is the Luna bus's.
  return typeof code === 'string' && REASON.test(code) ? code : 'unavailable';
}

function parsed(response: OpenProxyResponse): StreamProxyResult {
  const { url, token } = response;
  if (typeof url !== 'string' || !PROXIED.test(url) || typeof token !== 'string' || !token) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, url, token };
}

/** Set-Cookie lines a session's jar did not keep, per reason. */
export type StreamProxyCookies = Record<string, number>;

/** A session's upstream outcome; 0 means no response yet. */
export interface StreamProxyStatus {
  alive: boolean;
  lastStatus: number;
  manifestStatus: number;
  cookies: StreamProxyCookies;
}

interface TouchProxyResponse extends LunaResponse {
  alive?: unknown;
  lastStatus?: unknown;
  manifestStatus?: unknown;
  cookies?: unknown;
}

interface CloseProxyResponse extends LunaResponse {
  cookies?: unknown;
}

// Until the service first answers, an open may be waiting for it to start.
let serviceAnswered = false;

function postControl(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(CONFIG.PLAYER.DEV_PROXY_PORT)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function statusCode(value: unknown): number {
  return typeof value === 'number' && value >= 0 && value < 1000 ? Math.floor(value) : 0;
}

function cookieCounts(value: unknown): StreamProxyCookies {
  const counts: StreamProxyCookies = {};
  if (!value || typeof value !== 'object') return counts;
  const source = value as Record<string, unknown>;
  Object.keys(source).forEach(reason => {
    const count = source[reason];
    if (REASON.test(reason) && typeof count === 'number' && count >= 1 && isFinite(count)) {
      counts[reason] = Math.floor(count);
    }
  });
  return counts;
}

/**
 * Open a loopback proxy session for a header-gated stream: the bundled
 * service over Luna on webOS, or the standalone service's control endpoint
 * in the desktop preview. Never rejects. A session that opens after the
 * timeout is closed, not left to expire.
 */
export function openStreamProxy(
  url: string,
  headers: Record<string, string>,
  timeoutMs = serviceAnswered ? CONFIG.PLAYER.PROXY_OPEN_TIMEOUT : CONFIG.PLAYER.PROXY_FIRST_OPEN_TIMEOUT,
): Promise<StreamProxyResult> {
  return new Promise<StreamProxyResult>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    const answer = (result: StreamProxyResult, fromService: boolean): void => {
      if (fromService) serviceAnswered = true;
      if (settled) {
        if (result.ok) void closeStreamProxy(result.token);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    if (!isLunaAvailable()) {
      // The standalone service answers a failed open with a 4xx and a JSON body.
      postControl('/open', { url, headers }).then(async (response) => {
        const body = await response.json() as OpenProxyResponse;
        answer(body.returnValue === false ? { ok: false, reason: failureReason(body.errorCode) } : parsed(body), true);
      }).catch(() => answer({ ok: false, reason: 'unavailable' }, false));
      return;
    }
    try {
      lunaRequest<OpenProxyResponse>(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'openProxy',
        parameters: { url, headers },
        onSuccess: response => answer(parsed(response), true),
        onFailure: response => answer({ ok: false, reason: failureReason(response.errorCode) },
          typeof response.errorCode === 'string'),
      });
    } catch {
      answer({ ok: false, reason: 'unavailable' }, false);
    }
  });
}

/**
 * Keeps a session from expiring while the player holds it, and reports its
 * upstream outcome. Resolves null when the service cannot say.
 */
export function touchStreamProxy(token: string): Promise<StreamProxyStatus | null> {
  const status = (response: TouchProxyResponse): StreamProxyStatus | null =>
    typeof response.alive === 'boolean' ? {
      alive: response.alive,
      lastStatus: statusCode(response.lastStatus),
      manifestStatus: statusCode(response.manifestStatus),
      cookies: cookieCounts(response.cookies),
    } : null;
  return new Promise<StreamProxyStatus | null>(resolve => {
    const timer = setTimeout(() => resolve(null), CONFIG.PLAYER.PROXY_OPEN_TIMEOUT);
    const answer = (result: StreamProxyStatus | null): void => {
      clearTimeout(timer);
      resolve(result);
    };
    if (!isLunaAvailable()) {
      postControl('/touch', { token }).then(response => response.json() as Promise<TouchProxyResponse>)
        .then(body => answer(status(body)), () => answer(null));
      return;
    }
    try {
      lunaRequest<TouchProxyResponse>(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'touchProxy',
        parameters: { token },
        onSuccess: response => answer(status(response)),
        onFailure: () => answer(null),
      });
    } catch {
      answer(null);
    }
  });
}

/**
 * Ends a session; best effort, since an idle session also expires on its
 * own. Resolves the cookies its jar did not keep, or null when the service
 * cannot say.
 */
export function closeStreamProxy(token: string): Promise<StreamProxyCookies | null> {
  return new Promise<StreamProxyCookies | null>(resolve => {
    const timer = setTimeout(() => resolve(null), CONFIG.PLAYER.PROXY_OPEN_TIMEOUT);
    const answer = (result: StreamProxyCookies | null): void => {
      clearTimeout(timer);
      resolve(result);
    };
    if (!isLunaAvailable()) {
      postControl('/close', { token }).then(response => response.json() as Promise<CloseProxyResponse>)
        .then(body => answer(body.returnValue === false ? null : cookieCounts(body.cookies)), () => answer(null));
      return;
    }
    try {
      lunaRequest<CloseProxyResponse>(`luna://${CONFIG.SERVICE_ID}`, {
        method: 'closeProxy',
        parameters: { token },
        onSuccess: response => answer(cookieCounts(response.cookies)),
        onFailure: () => answer(null),
      });
    } catch {
      // The service is gone, and the session with it.
      answer(null);
    }
  });
}
