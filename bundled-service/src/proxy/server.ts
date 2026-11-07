/**
 * The loopback stream proxy: a separate HTTP server on 127.0.0.1 that
 * fetches a channel's manifests and segments with its HTTP headers, so the
 * page's own players (the <video> element, Shaka) can play a header-gated
 * stream. Each session is a 128-bit token naming one stream's headers,
 * which live only in this process's memory, never in a URL.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as nodeUrl from 'url';
import * as zlib from 'zlib';
import {
  MANIFEST_FETCH_MAX_REDIRECTS,
  REDIRECT_STATUSES,
  httpUrl,
  origin,
  requestAuth,
  requestHeaders,
  sanitizeHeaders,
  withoutCredentials,
} from '../fetch/manifest-fetch';
import { createCookieJar, type CookieJar } from './cookie-jar';
import { proxyUrl, rewriteDash, rewriteHls, sniffManifest, targetFromPath, type ManifestKind } from './rewrite';
import { bufferFrom } from '../compat';
import { createLogger } from '../logger';

const log = createLogger('proxy');

export const PROXY_SESSION_IDLE_MS = 2 * 60 * 1000;
export const PROXY_MAX_SESSIONS = 8;
// Larger than fetchManifest's cap: a long live DVR window or a multi-period MPD.
export const PROXY_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULTS = {
  sessionIdleMs: PROXY_SESSION_IDLE_MS,
  serverIdleMs: 30 * 1000,
  headerTimeoutMs: 10 * 1000,
  bodyIdleMs: 30 * 1000,
  maxPerOrigin: 6,
};
const MAX_CONTROL_BODY = 64 * 1024;
// Headers a player may set itself; the channel's own headers win otherwise.
const CLIENT_HEADERS = ['range', 'if-range'];
const PASSED_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'last-modified', 'etag', 'cache-control', 'expires',
];
// Bodies a player never needs decompressed, so they stay byte-identical.
const MEDIA_PATH = /\.(?:ts|m4s|mp4|m4a|m4v|m4f|fmp4|cmf[av]|aac|mp3|ac3|ec3|webm|mkv|mov|flv)$/i;
const MANIFEST_TYPE = /mpegurl|dash\+xml/i;
const CORS_EXPOSE = 'Content-Length, Content-Range, Accept-Ranges, Content-Type';

export interface ProxyOptions {
  /** 0 picks an ephemeral port. */
  port?: number;
  /** Serve POST /open and /close for a desktop preview; never on webOS. */
  control?: boolean;
  sessionIdleMs?: number;
  serverIdleMs?: number;
  headerTimeoutMs?: number;
  bodyIdleMs?: number;
  maxPerOrigin?: number;
  /** Tests and the E2E fixture only: allow loopback upstreams other than this proxy's own port. */
  allowLoopback?: boolean;
  /** The server started serving, or closed after idling; webOS holds an activity meanwhile. */
  onBusyChange?: (busy: boolean) => void;
}

/** A session's upstream outcome, for the app's diagnostics; 0 means none yet. */
export interface ProxySessionStatus {
  alive: boolean;
  lastStatus: number;
  manifestStatus: number;
  /** Set-Cookie lines the jar did not keep, per reason. */
  cookies: { [reason: string]: number };
}

export interface ProxyCloseResult {
  closed: boolean;
  cookies: { [reason: string]: number };
}

export interface ProxyOpenSuccess {
  returnValue: true;
  url: string;
  token: string;
}

/** errorCode: bad_url, denied, or unavailable. */
export interface ProxyOpenFailure {
  returnValue: false;
  errorCode: string;
  errorText: string;
}

export type ProxyOpenResult = ProxyOpenSuccess | ProxyOpenFailure;

interface SessionStats {
  requests: number;
  bytes: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  aborts: number;
  rewrites: number;
}

interface Session {
  token: string;
  /** The opened URL's proxy path, to tell the entry manifest's status from the rest. */
  entry: string;
  origin: string;
  auth: string;
  jar: CookieJar;
  lastStatus: number;
  manifestStatus: number;
  headers: Record<string, string>;
  lastUsed: number;
  active: number;
  stats: SessionStats;
}

interface Slot {
  start: () => void;
  cancelled: boolean;
}

interface OriginQueue {
  active: number;
  waiting: Slot[];
}

export interface StreamProxy {
  open(payload: { url?: unknown; headers?: unknown }, done: (result: ProxyOpenResult) => void): void;
  close(token: unknown): boolean;
  /** Ends a session and reports what close() does, plus the cookies its jar did not keep. */
  closeWithStatus(token: unknown): ProxyCloseResult;
  /** Keeps a session from expiring while the player holds it, and reports its upstream outcome. */
  touch(token: unknown): ProxySessionStatus;
  /** Bind now (standalone); webOS binds on the first open. */
  listen(done: (error: Error | null, port: number) => void): void;
  stop(): void;
  port(): number;
  sessionCount(): number;
}

function failure(errorCode: string, errorText: string): ProxyOpenFailure {
  return { returnValue: false, errorCode: errorCode, errorText: errorText };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE);
}

function plain(res: http.ServerResponse, status: number): void {
  if (res.headersSent) return;
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': '0', 'Cache-Control': 'no-store' });
  res.end();
}

// Only the desktop preview's own pages may drive the control endpoint.
function controlOrigin(value: unknown): string | null {
  if (value === undefined) return '';
  return typeof value === 'string' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(value)
    ? value : null;
}

// 127/8, 0/8, ::1, ::, and their IPv4-mapped forms.
export function isLoopbackAddress(address: string): boolean {
  let host = String(address || '').toLowerCase();
  if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') host = host.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) host = mapped[1];
  if (net.isIPv4(host)) {
    const first = Number(host.split('.')[0]);
    return first === 127 || first === 0;
  }
  if (!net.isIPv6(host)) return false;
  const halves = host.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = head.concat(new Array(Math.max(0, 8 - head.length - tail.length) + 1).join('0').split(''), tail)
    .map(group => parseInt(group || '0', 16));
  if (groups.length !== 8) return false;
  for (let i = 0; i < 5; i++) {
    if (groups[i] !== 0) return false;
  }
  if (groups[5] === 0xffff) return (groups[6] >> 8) === 127 || (groups[6] >> 8) === 0;
  return groups[5] === 0 && groups[6] === 0 && groups[7] <= 1;
}

export function createStreamProxy(options: ProxyOptions = {}): StreamProxy {
  const sessionIdleMs = options.sessionIdleMs || DEFAULTS.sessionIdleMs;
  const serverIdleMs = options.serverIdleMs || DEFAULTS.serverIdleMs;
  const headerTimeoutMs = options.headerTimeoutMs || DEFAULTS.headerTimeoutMs;
  const bodyIdleMs = options.bodyIdleMs || DEFAULTS.bodyIdleMs;
  const maxPerOrigin = options.maxPerOrigin || DEFAULTS.maxPerOrigin;
  const sessions: Record<string, Session> = {};
  const origins: Record<string, OriginQueue> = {};
  let sessionTotal = 0;
  let server: http.Server | null = null;
  let boundPort = 0;
  let binding: Array<(error: Error | null, port: number) => void> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: maxPerOrigin } as http.AgentOptions);
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: maxPerOrigin } as https.AgentOptions);

  const unref = (timer: { unref?: () => void }): void => {
    if (typeof timer.unref === 'function') timer.unref();
  };

  function summary(session: Session, reason: string): void {
    const s = session.stats;
    log.info('session closed reason=' + reason + ' requests=' + String(s.requests) + ' bytes=' + String(s.bytes)
      + ' s2xx=' + String(s.s2xx) + ' s3xx=' + String(s.s3xx) + ' s4xx=' + String(s.s4xx)
      + ' s5xx=' + String(s.s5xx) + ' aborts=' + String(s.aborts) + ' rewrites=' + String(s.rewrites));
    const drops = session.jar.drops();
    Object.keys(drops).forEach((cause) => {
      log.info('event=playback.proxy.cookie reason=' + cause + ' count=' + String(drops[cause]));
    });
  }

  // A request back into this proxy would wait on its own origin queue.
  function refused(address: string, port: number): boolean {
    return isLoopbackAddress(address) && (!options.allowLoopback || port === boundPort);
  }

  function setBusy(value: boolean): void {
    if (busy === value) return;
    busy = value;
    if (options.onBusyChange) options.onBusyChange(value);
  }

  function scheduleIdleClose(): void {
    if (options.control || idleTimer || sessionTotal > 0 || !server) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (sessionTotal === 0) closeServer();
    }, serverIdleMs);
    unref(idleTimer);
  }

  function removeSession(token: string, reason: string): boolean {
    if (!hasOwn(sessions, token)) return false;
    const session = sessions[token];
    delete sessions[token];
    sessionTotal--;
    summary(session, reason);
    if (sessionTotal === 0) scheduleIdleClose();
    return true;
  }

  function sweep(): void {
    const now = Date.now();
    Object.keys(sessions).forEach((token) => {
      const session = sessions[token];
      if (session.active === 0 && now - session.lastUsed >= sessionIdleMs) removeSession(token, 'expired');
    });
  }

  function closeServer(): void {
    const closing = server;
    server = null;
    boundPort = 0;
    setBusy(false);
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    if (closing) {
      try {
        closing.close();
      } catch {
        // Already closed.
      }
    }
    [httpAgent, httpsAgent].forEach((agent) => {
      const destroy = (agent as unknown as { destroy?: () => void }).destroy;
      if (typeof destroy === 'function') destroy.call(agent);
    });
  }

  function acquire(key: string, start: () => void): Slot {
    const queue = origins[key] || (origins[key] = { active: 0, waiting: [] });
    const slot: Slot = { start: start, cancelled: false };
    if (queue.active < maxPerOrigin) {
      queue.active++;
      start();
    } else {
      queue.waiting.push(slot);
    }
    return slot;
  }

  function release(key: string): void {
    const queue = origins[key];
    if (!queue) return;
    queue.active--;
    while (queue.waiting.length && queue.active < maxPerOrigin) {
      const next = queue.waiting.shift() as Slot;
      if (next.cancelled) continue;
      queue.active++;
      next.start();
    }
    if (queue.active <= 0 && !queue.waiting.length) delete origins[key];
  }

  function count(session: Session, status: number): void {
    const s = session.stats;
    if (status >= 500) s.s5xx++;
    else if (status >= 400) s.s4xx++;
    else if (status >= 300) s.s3xx++;
    else s.s2xx++;
  }

  function prefixFor(token: string): string {
    return 'http://127.0.0.1:' + String(boundPort) + '/p/' + token;
  }

  function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    const target = targetFromPath(path);
    const session = target && hasOwn(sessions, target.token) ? sessions[target.token] : null;
    if (!target || !session) {
      plain(res, 404);
      return;
    }
    const method = req.method || 'GET';
    if (method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, If-Range, Accept, Content-Type',
        'Access-Control-Max-Age': '600',
        'Content-Length': '0',
      });
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      plain(res, 405);
      return;
    }
    const first = httpUrl(target.url);
    if (!first) {
      plain(res, 400);
      return;
    }
    session.stats.requests++;
    session.lastUsed = Date.now();
    session.active++;
    const entry = path === session.entry;
    let finished = false;
    let upstream: http.ClientRequest | null = null;
    let headerTimer: ReturnType<typeof setTimeout> | null = null;
    let bodyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastData = 0;
    let draining = false;
    let slotKey = '';
    let slot: Slot | null = null;
    let holding = false;

    const done = (): void => {
      if (finished) return;
      finished = true;
      if (headerTimer) clearTimeout(headerTimer);
      if (bodyTimer) clearTimeout(bodyTimer);
      session.active--;
      session.lastUsed = Date.now();
      if (holding) {
        holding = false;
        release(slotKey);
      } else if (slot) {
        slot.cancelled = true;
      }
    };
    const fail = (status: number): void => {
      if (upstream) {
        const req2 = upstream;
        upstream = null;
        req2.abort();
      }
      if (!res.headersSent) {
        record(status);
        plain(res, status);
      } else if (res.socket) {
        res.socket.destroy();
      }
      done();
    };
    const record = (status: number): void => {
      count(session, status);
      session.lastStatus = status;
      if (entry) session.manifestStatus = status;
    };
    // Counts only time the upstream is silent, never time spent waiting for a paused player.
    const watchBody = (): void => {
      lastData = Date.now();
      const check = (): void => {
        bodyTimer = null;
        if (finished) return;
        const quiet = Date.now() - lastData;
        if (!draining && quiet >= bodyIdleMs) {
          fail(504);
          return;
        }
        bodyTimer = setTimeout(check, draining ? bodyIdleMs : bodyIdleMs - quiet);
      };
      bodyTimer = setTimeout(check, bodyIdleMs);
    };
    res.on('finish', done);
    res.on('close', () => {
      if (finished) return;
      session.stats.aborts++;
      if (upstream) {
        const req2 = upstream;
        upstream = null;
        req2.abort();
      }
      done();
    });

    const range = req.headers.range;
    const hop = (url: nodeUrl.Url, redirects: number, carried: Record<string, string>, auth: string): void => {
      const secure = url.protocol === 'https:';
      const port = url.port ? Number(url.port) : secure ? 443 : 80;
      if (refused(url.hostname || '', port)) {
        fail(403);
        return;
      }
      const headers = requestHeaders(url.protocol || '', carried);
      const cookie = session.jar.header(url, headers.cookie);
      if (cookie) headers.cookie = cookie;
      else delete headers.cookie;
      if (range || MEDIA_PATH.test(url.pathname || '')) headers['accept-encoding'] = 'identity';
      CLIENT_HEADERS.forEach((name) => {
        const value = req.headers[name];
        if (typeof value === 'string' && value) headers[name] = value;
      });
      const accept = req.headers.accept;
      if (!hasOwn(headers, 'accept') && typeof accept === 'string' && accept) headers.accept = accept;
      const requestOptions: https.RequestOptions = {
        method: method,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.path || '/',
        headers: headers,
        agent: secure ? httpsAgent : httpAgent,
      };
      const basic = requestAuth(url, auth);
      if (basic) requestOptions.auth = basic;
      // As fetchManifest: no certificate check, and so no credential over https.
      if (secure) requestOptions.rejectUnauthorized = false;
      let upReq: http.ClientRequest;
      try {
        upReq = (secure ? https : http).request(requestOptions);
      } catch {
        fail(502);
        return;
      }
      upstream = upReq;
      upReq.on('error', () => {
        if (upstream === upReq) fail(502);
      });
      // A host name that resolves to loopback is refused before it connects.
      upReq.on('socket', (socket: net.Socket) => {
        // A reused keep-alive socket already passed this check; `_connecting` is Node.js 0.12's name.
        const state = socket as unknown as { connecting?: boolean; _connecting?: boolean };
        if (!state.connecting && !state._connecting) return;
        socket.once('lookup', (error: Error | null, address: string) => {
          if (error || upstream !== upReq || !refused(address, port)) return;
          fail(403);
          socket.destroy();
        });
      });
      upReq.on('response', (upRes: http.IncomingMessage) => {
        if (finished || upstream !== upReq) {
          upRes.resume();
          return;
        }
        const status = upRes.statusCode || 0;
        const location = upRes.headers.location;
        session.jar.store(upRes.headers['set-cookie'], url);
        if (REDIRECT_STATUSES.indexOf(status) >= 0 && typeof location === 'string' && location) {
          upRes.resume();
          const next = redirects < MANIFEST_FETCH_MAX_REDIRECTS
            ? httpUrl(nodeUrl.resolve(url.href || '', location)) : null;
          if (!next) {
            fail(502);
            return;
          }
          const sameOrigin = origin(next) === origin(url);
          hop(next, redirects + 1, sameOrigin ? carried : withoutCredentials(carried),
            sameOrigin ? next.auth || auth : '');
          return;
        }
        if (headerTimer) clearTimeout(headerTimer);
        headerTimer = null;
        watchBody();
        respond(upReq, upRes, status, url);
      });
      upReq.end();
    };

    const respond = (upReq: http.ClientRequest, upRes: http.IncomingMessage, status: number,
      finalUrl: nodeUrl.Url): void => {
      const passed: Record<string, string> = {};
      PASSED_RESPONSE_HEADERS.forEach((name) => {
        const value = upRes.headers[name];
        if (typeof value === 'string') passed[name] = value;
      });
      const encoding = String(upRes.headers['content-encoding'] || '').trim().toLowerCase();
      let body: NodeJS.ReadableStream = upRes;
      if (encoding === 'gzip' || encoding === 'x-gzip') body = upRes.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') body = upRes.pipe(zlib.createInflate());
      else if (encoding && encoding !== 'identity') {
        upRes.resume();
        fail(502);
        return;
      }
      const decoded = body !== upRes;
      if (decoded) delete passed['content-length'];
      const contentType = passed['content-type'] || '';
      upRes.on('aborted', () => {
        if (upstream === upReq) fail(502);
      });
      if (decoded) {
        body.on('error', () => {
          if (upstream === upReq) fail(502);
        });
      }
      const finishUpstream = (): void => {
        if (upstream === upReq) upstream = null;
      };

      const passThrough = (head: Buffer[], ended: boolean): void => {
        record(status);
        setCors(res);
        res.writeHead(status, passed);
        if (method === 'HEAD') {
          finishUpstream();
          upRes.resume();
          res.end();
          return;
        }
        let flowing = true;
        const write = (chunk: Buffer): void => {
          session.stats.bytes += chunk.length;
          if (!res.write(chunk)) flowing = false;
        };
        head.forEach(write);
        if (ended) {
          finishUpstream();
          res.end();
          return;
        }
        // A manual pump rather than pipe(), so a paused player is not mistaken for a stalled upstream.
        const pump = (): void => {
          if (flowing || finished) {
            body.resume();
            return;
          }
          if (draining) return;
          draining = true;
          body.pause();
          res.once('drain', () => {
            draining = false;
            lastData = Date.now();
            flowing = true;
            pump();
          });
        };
        body.on('data', (chunk: Buffer) => {
          if (finished) return;
          lastData = Date.now();
          write(chunk);
          if (!flowing) pump();
        });
        body.on('end', () => {
          finishUpstream();
          if (!finished) res.end();
        });
        pump();
      };

      if (method === 'HEAD') {
        // A manifest's length changes when it is rewritten.
        if (MANIFEST_TYPE.test(contentType)) delete passed['content-length'];
        passThrough([], true);
        return;
      }
      if (status !== 200) {
        passThrough([], false);
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      let kind: ManifestKind | '' | null = null;
      const onData = (chunk: Buffer): void => {
        if (finished) return;
        lastData = Date.now();
        chunks.push(chunk);
        length += chunk.length;
        if (length > PROXY_MANIFEST_MAX_BYTES && kind !== '') {
          stopListening();
          fail(502);
          return;
        }
        if (kind === null) {
          kind = sniffManifest(Buffer.concat(chunks, length), false);
          if (kind === '') {
            stopListening();
            body.pause();
            passThrough(chunks, false);
          }
        }
      };
      const onEnd = (): void => {
        if (finished) return;
        stopListening();
        finishUpstream();
        if (kind === null) kind = sniffManifest(Buffer.concat(chunks, length), true);
        if (!kind) {
          passThrough(chunks, true);
          return;
        }
        let text = Buffer.concat(chunks, length).toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const base = finalUrl.href || '';
        const map = (absolute: string): string | null => proxyUrl(prefixFor(session.token), absolute);
        const rewritten = kind === 'hls' ? rewriteHls(text, base, map)
          : rewriteDash(text, base, base !== first.href, map);
        const out = bufferFrom(rewritten, 'utf8');
        session.stats.rewrites++;
        session.stats.bytes += out.length;
        record(status);
        setCors(res);
        res.writeHead(status, {
          'Content-Type': contentType || (kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml'),
          'Content-Length': String(out.length),
          'Cache-Control': 'no-cache',
        });
        res.end(out);
      };
      const stopListening = (): void => {
        body.removeListener('data', onData);
        body.removeListener('end', onEnd);
      };
      body.on('data', onData);
      body.on('end', onEnd);
    };

    const target0 = first;
    const sessionOrigin = origin(target0) === session.origin;
    const carried = sessionOrigin ? session.headers : withoutCredentials(session.headers);
    const auth = sessionOrigin ? session.auth : '';
    slotKey = origin(target0);
    slot = acquire(slotKey, () => {
      holding = true;
      // The wait for a slot does not count toward the header timeout.
      headerTimer = setTimeout(() => fail(504), headerTimeoutMs);
      hop(target0, 0, carried, auth);
    });
  }

  function readJson(req: http.IncomingMessage, done: (value: unknown) => void): void {
    const chunks: Buffer[] = [];
    let length = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_CONTROL_BODY) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) {
        done(null);
        return;
      }
      try {
        done(JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
      } catch {
        done(null);
      }
    });
  }

  function handleControl(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    const allowed = controlOrigin(req.headers.origin);
    if (allowed === null) {
      plain(res, 403);
      return;
    }
    const cors: Record<string, string> = allowed ? { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      cors['Access-Control-Allow-Headers'] = 'Content-Type';
      if (req.headers['access-control-request-private-network']) {
        cors['Access-Control-Allow-Private-Network'] = 'true';
      }
      cors['Content-Length'] = '0';
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      plain(res, 405);
      return;
    }
    const reply = (status: number, value: unknown): void => {
      const body = bufferFrom(JSON.stringify(value), 'utf8');
      cors['Content-Type'] = 'application/json';
      cors['Content-Length'] = String(body.length);
      cors['Cache-Control'] = 'no-store';
      res.writeHead(status, cors);
      res.end(body);
    };
    readJson(req, (value) => {
      const payload = value && typeof value === 'object' ? value as Record<string, unknown> : null;
      if (!payload) {
        reply(400, failure('bad_request', 'Expected a JSON object'));
        return;
      }
      if (path === '/close') {
        const result = api.closeWithStatus(payload.token);
        reply(200, { returnValue: true, closed: result.closed, cookies: result.cookies });
        return;
      }
      if (path === '/touch') {
        const status = api.touch(payload.token);
        reply(200, { returnValue: true, alive: status.alive, lastStatus: status.lastStatus,
          manifestStatus: status.manifestStatus, cookies: status.cookies });
        return;
      }
      api.open({ url: payload.url, headers: payload.headers }, (result) => {
        reply(result.returnValue ? 200 : 400, result);
      });
    });
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // A page on another host name that resolves here (DNS rebinding) is refused.
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== '127.0.0.1:' + String(boundPort) && host !== 'localhost:' + String(boundPort)) {
      plain(res, 403);
      return;
    }
    const path = req.url || '/';
    if (options.control && (path === '/open' || path === '/close' || path === '/touch')) {
      handleControl(req, res, path);
      return;
    }
    if (path.indexOf('/p/') !== 0) {
      plain(res, 404);
      return;
    }
    handleProxy(req, res, path);
  }

  function listen(done: (error: Error | null, port: number) => void): void {
    if (server && boundPort) {
      done(null, boundPort);
      return;
    }
    if (binding) {
      binding.push(done);
      return;
    }
    binding = [done];
    const candidate = http.createServer(handle);
    // Node's default 2-minute socket timeout would cut a paused player's response.
    candidate.setTimeout(0);
    const settle = (error: Error | null): void => {
      const waiting = binding || [];
      binding = null;
      waiting.forEach((callback) => callback(error, boundPort));
    };
    candidate.on('error', (error: Error) => {
      if (server === candidate) return;
      log.warn('proxy server bind failed:', error.message);
      settle(error);
    });
    candidate.listen(options.port || 0, '127.0.0.1', () => {
      server = candidate;
      boundPort = (candidate.address() as { port: number }).port;
      log.info('listening port=' + String(boundPort));
      sweepTimer = setInterval(sweep, Math.max(1000, Math.min(30000, Math.floor(sessionIdleMs / 4))));
      unref(sweepTimer);
      settle(null);
    });
  }

  const api: StreamProxy = {
    open(payload, done) {
      const target = httpUrl(payload.url);
      if (!target) {
        done(failure('bad_url', 'Only http and https URLs are allowed'));
        return;
      }
      listen((error) => {
        if (error || !server) {
          done(failure('unavailable', 'Proxy server is not listening'));
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (refused(target.hostname || '', target.port ? Number(target.port)
          : target.protocol === 'https:' ? 443 : 80)) {
          done(failure('blocked', 'Loopback addresses are not allowed'));
          return;
        }
        if (sessionTotal >= PROXY_MAX_SESSIONS) {
          // A streaming session outlives any idle one.
          let oldest: Session | null = null;
          Object.keys(sessions).forEach((key) => {
            const candidate = sessions[key];
            const current = oldest as Session | null;
            if (!current || (candidate.active === 0 && current.active > 0)
              || ((candidate.active === 0) === (current.active === 0) && candidate.lastUsed < current.lastUsed)) {
              oldest = candidate;
            }
          });
          if (oldest) removeSession((oldest as Session).token, 'evicted');
        }
        const token = crypto.randomBytes(16).toString('hex');
        const url = proxyUrl(prefixFor(token), target.href || '');
        if (!url) {
          done(failure('bad_url', 'URL cannot be proxied'));
          return;
        }
        sessions[token] = {
          token: token,
          entry: url.slice(('http://127.0.0.1:' + String(boundPort)).length),
          origin: origin(target),
          auth: target.auth || '',
          jar: createCookieJar(),
          lastStatus: 0,
          manifestStatus: 0,
          headers: sanitizeHeaders(payload.headers),
          lastUsed: Date.now(),
          active: 0,
          stats: { requests: 0, bytes: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, aborts: 0, rewrites: 0 },
        };
        sessionTotal++;
        setBusy(true);
        done({ returnValue: true, url: url, token: token });
      });
    },
    close(token) {
      return typeof token === 'string' && removeSession(token, 'closed');
    },
    closeWithStatus(token) {
      const cookies = typeof token === 'string' && hasOwn(sessions, token) ? sessions[token].jar.drops() : {};
      return { closed: typeof token === 'string' && removeSession(token, 'closed'), cookies: cookies };
    },
    touch(token) {
      if (typeof token !== 'string' || !hasOwn(sessions, token)) {
        return { alive: false, lastStatus: 0, manifestStatus: 0, cookies: {} };
      }
      const session = sessions[token];
      session.lastUsed = Date.now();
      return { alive: true, lastStatus: session.lastStatus, manifestStatus: session.manifestStatus,
        cookies: session.jar.drops() };
    },
    listen: listen,
    stop() {
      Object.keys(sessions).forEach((token) => removeSession(token, 'stopped'));
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      closeServer();
    },
    port() {
      return boundPort;
    },
    sessionCount() {
      return sessionTotal;
    },
  };
  return api;
}
