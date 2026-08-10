/**
 * Shared LAN HTTP server for phone setup and M3U uploads. The Luna registration
 * entry point lives in index.ts; lan/service.ts passes the resolved data
 * directory and fans change events out over Luna.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomInt } from 'crypto';
import {
  parseSetupAction,
  SetupActionStore,
} from '../setup/actions';
import { isValidUploadId, UploadStore } from '../upload/store';

export type ServiceChangeEvent = 'uploads-changed' | 'setup-changed';

const PAIRING_MAX_FAILURES = 5;
const PAIRING_LOCK_MS = 60 * 1000;

function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}

function send(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function isLoopback(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' ||
    address === '::ffff:127.0.0.1';
}

function readBody(req: http.IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Upload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// The setup page HTML lives in the sibling setup module so it can be
// edited as real HTML. The file is copied into the build output by build.sh.
let _setupPageCache: string | null = null;
function setupPageHtml(): string {
  if (_setupPageCache !== null) return _setupPageCache;
  _setupPageCache = fs.readFileSync(path.join(__dirname, '../setup/setup-page.html'), 'utf-8');
  return _setupPageCache;
}

/**
 * Bind the HTTP server on all interfaces. Pass `0` to let the OS assign a
 * free ephemeral port (typical production use — the bound port is returned
 * via the resolved promise and reported to the in-app client through Luna).
 *
 * `dataDir` is where uploaded .m3u files and their .json metadata live; pass
 * the result of resolveDataDir() (or any writable directory for tests).
 *
 * `onChange` is invoked synchronously after a successful upload mutation
 * (POST /uploads or DELETE /uploads/:id) or setup-action submission
 * (POST /setup-actions). Use it to fan out a push notification to subscribers
 * through the `serviceEvents` channel.
 */
export function startServer(
  port: number,
  dataDir: string,
  onChange?: (event: ServiceChangeEvent) => void,
  setupActions = new SetupActionStore(),
): Promise<{ server: http.Server; port: number }> {
  let boundPort = port;
  const setupToken = randomBytes(6).toString('hex');
  const pairingCode = String(randomInt(0, 10000)).padStart(4, '0');
  const pairingAttempts = new Map<string, { failures: number; blockedUntil: number }>();
  const uploads = new UploadStore(dataDir);

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlObj = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const pathname = urlObj.pathname;
    const query = urlObj.searchParams;
    const host = req.headers.host || ('localhost:' + boundPort);

    try {
      if (pathname === '/info') {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'Local access only' });
          return;
        }
        const ip = getLanIp();
        const hostPort = host.indexOf(':') >= 0 ? host.split(':')[1] : String(boundPort);
        sendJson(res, 200, {
          ip,
          port: parseInt(hostPort, 10) || boundPort,
          setupUrl: 'http://' + ip + ':' + hostPort + '/setup?token=' + setupToken,
          manualUrl: 'http://' + ip + ':' + hostPort,
          pairingCode,
          dataDir,
        });
      } else if ((pathname === '/' || pathname === '/setup') && req.method === 'GET') {
        send(res, 200, 'text/html; charset=utf-8', setupPageHtml());
      } else if (pathname === '/pair' && req.method === 'POST') {
        const client = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let current = pairingAttempts.get(client);
        if (current && current.blockedUntil > now) {
          sendJson(res, 429, {
            error: 'Too many pairing attempts',
            retryAfter: Math.ceil((current.blockedUntil - now) / 1000),
          });
          return;
        }
        if (current && current.blockedUntil > 0) {
          pairingAttempts.delete(client);
          current = undefined;
        }
        let submitted = '';
        try {
          const body = JSON.parse(await readBody(req, 1024)) as { code?: unknown };
          submitted = typeof body.code === 'string' ? body.code : '';
        } catch {
          sendJson(res, 400, { error: 'Invalid pairing request' });
          return;
        }
        if (submitted !== pairingCode) {
          const failures = (current?.failures || 0) + 1;
          const blockedUntil = failures >= PAIRING_MAX_FAILURES ? now + PAIRING_LOCK_MS : 0;
          pairingAttempts.set(client, { failures, blockedUntil });
          sendJson(res, blockedUntil ? 429 : 401, {
            error: blockedUntil ? 'Too many pairing attempts' : 'Invalid pairing code',
            retryAfter: blockedUntil ? Math.ceil(PAIRING_LOCK_MS / 1000) : undefined,
          });
          return;
        }
        pairingAttempts.delete(client);
        sendJson(res, 200, { token: setupToken });
      } else if (pathname === '/setup-actions' && req.method === 'POST') {
        if (query.get('token') !== setupToken) {
          sendJson(res, 403, { error: 'Invalid setup token' });
          return;
        }
        try {
          const action = setupActions.add(parseSetupAction(JSON.parse(await readBody(req, 64 * 1024))));
          try { onChange?.('setup-changed'); } catch (cbErr) {
            console.error('[lan] onChange callback threw:', cbErr);
          }
          sendJson(res, 201, { id: action.id, type: action.type });
        } catch (e) {
          sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      } else if (pathname === '/setup-actions' && req.method === 'GET') {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'Local access only' });
          return;
        }
        sendJson(res, 200, setupActions.list());
      } else if (pathname.indexOf('/setup-actions/') === 0 && req.method === 'GET') {
        if (query.get('token') !== setupToken) {
          sendJson(res, 403, { error: 'Invalid setup token' });
          return;
        }
        const id = Number(pathname.slice('/setup-actions/'.length));
        const pending = Number.isSafeInteger(id) &&
          setupActions.list().some(action => action.id === id);
        sendJson(res, 200, { id, pending });
      } else if (pathname.indexOf('/setup-actions/') === 0 && req.method === 'DELETE') {
        if (!isLoopback(req)) {
          sendJson(res, 403, { error: 'Local access only' });
          return;
        }
        const id = Number(pathname.slice('/setup-actions/'.length));
        const deleted = Number.isSafeInteger(id) && setupActions.remove(id);
        sendJson(res, deleted ? 200 : 404, { deleted, id });
      } else if (pathname === '/uploads' && req.method === 'POST') {
        if (query.get('token') !== setupToken) {
          sendJson(res, 403, { error: 'Invalid setup token' });
          return;
        }
        try {
          const content = await readBody(req);
          const meta = uploads.save(query.get('name') || 'playlist.m3u', content);
          console.log('[upload] saved "' + meta.name + '" (' + meta.count + ' channels) as ' + meta.id + '.m3u');
          try { onChange?.('uploads-changed'); } catch (cbErr) { console.error('[lan] onChange callback threw:', cbErr); }
          sendJson(res, 200, meta);
        } catch (e) {
          sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      } else if (pathname === '/uploads') {
        const base = 'http://' + host;
        const items = uploads.list().map((m) => ({
          ...m,
          url: base + '/uploads/' + encodeURIComponent(m.id) + '.m3u',
        }));
        sendJson(res, 200, items);
      } else if (pathname.indexOf('/uploads/') === 0) {
        let id: string;
        try {
          id = decodeURIComponent(pathname.slice('/uploads/'.length)).replace(/\.m3u$/i, '');
        } catch {
          sendJson(res, 400, { error: 'Invalid upload id' });
          return;
        }
        if (!isValidUploadId(id)) {
          sendJson(res, 400, { error: 'Invalid upload id' });
          return;
        }
        if (req.method === 'DELETE') {
          if (!isLoopback(req) && query.get('token') !== setupToken) {
            sendJson(res, 403, { error: 'Invalid setup token' });
            return;
          }
          const ok = uploads.delete(id);
          if (ok) { try { onChange?.('uploads-changed'); } catch (cbErr) { console.error('[lan] onChange callback threw:', cbErr); } }
          sendJson(res, ok ? 200 : 404, { deleted: ok, id });
        } else {
          try {
            send(res, 200, 'audio/mpegurl; charset=utf-8', uploads.read(id));
          } catch {
            send(res, 404, 'text/plain; charset=utf-8', 'Upload not found: ' + id);
          }
        }
      } else {
        send(res, 404, 'text/plain; charset=utf-8',
          'Not found. Use /setup, /setup-actions, /uploads, or /info');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.indexOf('EPIPE') >= 0 || msg.indexOf('ECONNRESET') >= 0) return;
      try { send(res, 500, 'text/plain; charset=utf-8', 'Internal error: ' + msg); } catch { /* ignore */ }
    }
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch(() => {
        try { res.writeHead(500); res.end('Internal Server Error'); } catch { /* ignore */ }
      });
    });
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      boundPort = actualPort;
      console.log('[lan] listening on http://0.0.0.0:' + actualPort);
      console.log('[lan] setup page: http://' + getLanIp() + ':' + actualPort + '/setup');
      // Permanent error handler so post-listen errors don't crash the process.
      server.on('error', (e) => console.error('[lan] server error:', e));
      resolve({ server, port: actualPort });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '0.0.0.0');
  });
}
