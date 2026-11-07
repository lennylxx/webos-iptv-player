/**
 * One bounded GET of a stream manifest with the channel's HTTP headers, for
 * the app's Luna playback path: the page cannot send Referer or User-Agent,
 * so a hotlink-protected origin refuses its own fetch. Stateless: nothing
 * outlives the response.
 */

import * as http from 'http';
import * as https from 'https';
import * as nodeUrl from 'url';
import * as zlib from 'zlib';

export const MANIFEST_FETCH_HARD_MAX_BYTES = 1024 * 1024;
export const MANIFEST_FETCH_DEFAULT_TIMEOUT_MS = 5000;
export const MANIFEST_FETCH_MAX_TIMEOUT_MS = 10000;
export const MANIFEST_FETCH_MAX_REDIRECTS = 5;

const MAX_HEADERS = 32;
const MAX_HEADER_VALUE_LENGTH = 8192;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNSAFE_VALUE = /[\r\n\0]/;
// Hop-by-hop, framing, and routing headers belong to this request, not the channel.
const DROPPED_HEADERS = [
  'accept-encoding',
  'connection',
  'content-encoding',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
// As on the app's Luna path, UMS does not verify TLS certificates, so
// credentials never travel over https; they also never leave their origin.
const CREDENTIAL_HEADERS = ['authorization', 'cookie'];
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

export interface ManifestFetchRequest {
  url?: unknown;
  headers?: unknown;
  maxBytes?: unknown;
  timeoutMs?: unknown;
}

export interface ManifestFetchSuccess {
  returnValue: true;
  status: number;
  url: string;
  text: string;
}

/** errorCode: bad_url, denied, timeout, too_large, too_many_redirects, network, decode, or http_NNN. */
export interface ManifestFetchFailure {
  returnValue: false;
  errorCode: string;
  errorText: string;
  status?: number;
}

export type ManifestFetchResult = ManifestFetchSuccess | ManifestFetchFailure;

export function manifestFetchFailure(errorCode: string, errorText: string, status?: number): ManifestFetchFailure {
  const result: ManifestFetchFailure = { returnValue: false, errorCode: errorCode, errorText: errorText };
  if (status !== undefined) result.status = status;
  return result;
}

export function httpUrl(input: unknown): nodeUrl.Url | null {
  if (typeof input !== 'string' || !input || /[\0-\x20\x7f]/.test(input)) return null;
  const parsed = nodeUrl.parse(input);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname ? parsed : null;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

/** The channel headers this service forwards, by lower-case name; anything unsafe is dropped. */
export function sanitizeHeaders(input: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!input || typeof input !== 'object') return headers;
  const source = input as Record<string, unknown>;
  const names = Object.keys(source);
  let count = 0;
  for (let i = 0; i < names.length && count < MAX_HEADERS; i++) {
    const name = names[i];
    const value = source[name];
    if (typeof value !== 'string' || !value || value.length > MAX_HEADER_VALUE_LENGTH
        || UNSAFE_VALUE.test(value) || !HEADER_NAME.test(name)) continue;
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.indexOf(key) >= 0 || key.indexOf('proxy-') === 0) continue;
    headers[key === 'referrer' ? 'referer' : key] = value;
    count++;
  }
  return headers;
}

export function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  Object.keys(headers).forEach((name) => {
    if (CREDENTIAL_HEADERS.indexOf(name) < 0) kept[name] = headers[name];
  });
  return kept;
}

/** The headers one request sends: credentials stay off https. */
export function requestHeaders(protocol: string, carried: Record<string, string>): Record<string, string> {
  const headers = protocol === 'https:' ? withoutCredentials(carried) : carried;
  const outgoing: Record<string, string> = { 'accept-encoding': 'gzip, deflate' };
  Object.keys(headers).forEach((name) => { outgoing[name] = headers[name]; });
  return outgoing;
}

// The URL's user:password goes out as Basic auth over http only, as Cookie
// and Authorization do; a redirect carries it only within its origin.

export function requestAuth(url: nodeUrl.Url, carried: string): string | undefined {
  return url.protocol === 'https:' || !carried ? undefined : carried;
}

// The final URL as reported back to the app, without its user:password.
function reportedHref(url: nodeUrl.Url): string {
  const href = url.href || '';
  return url.auth ? href.replace(/^(https?:\/\/)[^@\/?#]*@/i, '$1') : href;
}

export function origin(url: nodeUrl.Url): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return url.protocol + '//' + (url.hostname || '').toLowerCase() + ':' + port;
}

/**
 * GET one http(s) URL with the given headers. Redirects are followed up to
 * MANIFEST_FETCH_MAX_REDIRECTS times, and the timeout covers the whole chain.
 * `done` runs exactly once.
 */
export function fetchManifest(input: ManifestFetchRequest, done: (result: ManifestFetchResult) => void): void {
  const first = httpUrl(input.url);
  if (!first) {
    done(manifestFetchFailure('bad_url', 'Only http and https URLs are allowed'));
    return;
  }
  const maxBytes = boundedInteger(input.maxBytes, MANIFEST_FETCH_HARD_MAX_BYTES, MANIFEST_FETCH_HARD_MAX_BYTES);
  const timeoutMs = boundedInteger(input.timeoutMs, MANIFEST_FETCH_DEFAULT_TIMEOUT_MS,
    MANIFEST_FETCH_MAX_TIMEOUT_MS);
  let finished = false;
  let active: http.ClientRequest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (result: ManifestFetchResult): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    const req = active;
    active = null;
    if (req) req.abort();
    done(result);
  };
  timer = setTimeout(() => {
    finish(manifestFetchFailure('timeout', 'Request timed out'));
  }, timeoutMs);

  const hop = (url: nodeUrl.Url, redirects: number, carried: Record<string, string>, auth: string): void => {
    const secure = url.protocol === 'https:';
    const options: https.RequestOptions = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.path || '/',
      headers: requestHeaders(url.protocol || '', carried),
      agent: false,
    };
    const basic = requestAuth(url, auth);
    if (basic) options.auth = basic;
    // UMS plays the stream without verifying the certificate either; no
    // credential header is ever sent over https.
    if (secure) options.rejectUnauthorized = false;
    let req: http.ClientRequest;
    try {
      req = (secure ? https : http).request(options);
    } catch (e) {
      finish(manifestFetchFailure('bad_url', e instanceof Error ? e.message : String(e)));
      return;
    }
    active = req;
    req.on('error', (e: Error) => {
      if (active === req) finish(manifestFetchFailure('network', e.message));
    });
    req.on('response', (res: http.IncomingMessage) => {
      if (finished || active !== req) {
        res.resume();
        return;
      }
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (REDIRECT_STATUSES.indexOf(status) >= 0 && typeof location === 'string' && location) {
        res.resume();
        active = null;
        if (redirects >= MANIFEST_FETCH_MAX_REDIRECTS) {
          finish(manifestFetchFailure('too_many_redirects', 'Too many redirects', status));
          return;
        }
        const next = httpUrl(nodeUrl.resolve(url.href || '', location));
        if (!next) {
          finish(manifestFetchFailure('bad_url', 'Redirect left http and https', status));
          return;
        }
        const sameOrigin = origin(next) === origin(url);
        hop(next, redirects + 1, sameOrigin ? carried : withoutCredentials(carried),
          sameOrigin ? next.auth || auth : '');
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(manifestFetchFailure('http_' + String(status), 'HTTP ' + String(status), status));
        return;
      }
      const tooLarge = (): void => {
        finish(manifestFetchFailure('too_large', 'Response exceeds ' + String(maxBytes) + ' bytes', status));
      };
      const declared = Number(res.headers['content-length'] || 0);
      if (isFinite(declared) && declared > maxBytes) {
        tooLarge();
        return;
      }
      const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      let body: NodeJS.ReadableStream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') body = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') body = res.pipe(zlib.createInflate());
      else if (encoding && encoding !== 'identity') {
        finish(manifestFetchFailure('decode', 'Unsupported content encoding', status));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      // Counts decoded bytes, so a compressed body cannot expand past the cap.
      body.on('data', (chunk: Buffer) => {
        if (finished) return;
        length += chunk.length;
        if (length > maxBytes) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      if (body !== res) {
        body.on('error', (e: Error) => {
          finish(manifestFetchFailure('decode', e.message, status));
        });
      }
      res.on('aborted', () => {
        finish(manifestFetchFailure('network', 'Response aborted', status));
      });
      body.on('end', () => {
        if (finished) return;
        active = null;
        let text = Buffer.concat(chunks, length).toString('utf8');
        // Dropped as the page's TextDecoder drops it.
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        finish({ returnValue: true, status: status, url: reportedHref(url), text: text });
      });
    });
    req.end();
  };

  hop(first, 0, sanitizeHeaders(input.headers), first.auth || '');
}
