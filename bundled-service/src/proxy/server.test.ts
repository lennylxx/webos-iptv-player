import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as http from 'http';
import type * as https from 'https';
import { createRequire, syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import * as zlib from 'zlib';
import { createStreamProxy, isLoopbackAddress, type ProxyOpenResult, type StreamProxy } from './server';
import { registerProxyService, type ProxyLunaMsg } from './service';

type Seen = { url: string; headers: http.IncomingHttpHeaders };
type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

const SEGMENT = Buffer.alloc(4096, 7);
const BIG = Buffer.alloc(16 * 1024 * 1024, 3);
// Over fetchManifest's 1 MiB cap, under the proxy's 4 MiB one.
const LONG_PLAYLIST = '#EXTM3U\n' + new Array(40000).join('#EXTINF:4,\nsegment-with-a-long-name.ts\n');
const APP_ID = 'com.example.app';

let primary: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';
const seen: Seen[] = [];
const sockets: { aborted: boolean }[] = [];
const proxies: StreamProxy[] = [];

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The fixtures listen on loopback, which a real proxy refuses.
function proxy(options: Parameters<typeof createStreamProxy>[0] = {}): StreamProxy {
  const created = createStreamProxy({ allowLoopback: true, ...options });
  proxies.push(created);
  return created;
}

function open(p: StreamProxy, url: string, headers?: Record<string, string>): Promise<ProxyOpenResult> {
  return new Promise(resolve => p.open({ url: url, headers: headers }, resolve));
}

async function openOk(p: StreamProxy, url: string, headers?: Record<string, string>): Promise<string> {
  const result = await open(p, url, headers);
  if (!result.returnValue) throw new Error(result.errorCode);
  return result.url;
}

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}):
  Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function upstreamPath(proxied: string): string {
  return proxied.replace(/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/http\/[^/]+/, '');
}

beforeAll(async () => {
  other = await listen((req, res) => {
    seen.push({ url: 'other' + (req.url || ''), headers: req.headers });
    if (req.url === '/seg.ts') res.end(SEGMENT);
    else res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n');
  });
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  primary = await listen((req, res) => {
    seen.push({ url: req.url || '', headers: req.headers });
    const path = req.url || '';
    if (path.indexOf('/gated/') === 0 && req.headers.referer !== 'http://ref/') {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (path === '/gated/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",URI="a/index.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv/index.m3u8\n' + otherBase + '/abs.m3u8\n');
    } else if (path === '/gated/v/index.m3u8') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\n../seg.ts\n'));
    } else if (path === '/gated/seg.ts') {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${SEGMENT.length}`);
        res.end(SEGMENT.subarray(start, end + 1));
      } else {
        res.end(SEGMENT);
      }
    } else if (path === '/redirect.m3u8') {
      res.statusCode = 302;
      res.setHeader('Location', '/moved/live/index.m3u8');
      res.end();
    } else if (path === '/moved/live/index.m3u8') {
      res.end('#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
    } else if (path === '/cross.m3u8') {
      res.statusCode = 302;
      res.setHeader('Location', otherBase + '/list.m3u8');
      res.end();
    } else if (path === '/redirect.mpd') {
      res.statusCode = 301;
      res.setHeader('Location', '/dash/final.mpd');
      res.end();
    } else if (path === '/dash/final.mpd') {
      res.setHeader('Content-Type', 'application/dash+xml');
      res.end('<?xml version="1.0"?><MPD><Period><AdaptationSet>'
        + '<ContentProtection><clearkey:Laurl>https://license/ck</clearkey:Laurl></ContentProtection>'
        + '<SegmentTemplate media="$Number$.m4s" initialization="init.mp4"/></AdaptationSet></Period></MPD>');
    } else if (path === '/slow.ts') {
      const tracked = { aborted: false };
      sockets.push(tracked);
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(SEGMENT);
      req.socket.on('close', () => { tracked.aborted = true; });
    } else if (path === '/hang.ts') {
      // Never answers.
    } else if (path === '/big.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': String(BIG.length) });
      res.end(BIG);
    } else if (path === '/long.m3u8') {
      res.end(LONG_PLAYLIST);
    } else if (path.indexOf('/to-port/') === 0) {
      res.statusCode = 302;
      res.setHeader('Location', `http://127.0.0.1:${path.slice(9)}/p/${'a'.repeat(32)}/http/h/x.ts`);
      res.end();
    } else if (path === '/cookie/master.m3u8') {
      res.setHeader('Set-Cookie', [
        'sid=s1; Path=/cookie', 'theme=jar', 'broken', 'x=1; Domain=elsewhere.invalid', 's=1; Secure',
      ]);
      res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n');
    } else if (path === '/cookie/redirect.m3u8') {
      res.statusCode = 302;
      res.setHeader('Set-Cookie', 'hop=h1; Path=/');
      res.setHeader('Location', '/cookie/after.m3u8');
      res.end();
    } else if (path.indexOf('/cookie/') === 0) {
      res.end('#EXTM3U\n');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  base = `http://127.0.0.1:${(primary.address() as AddressInfo).port}`;
});

afterEach(() => {
  seen.length = 0;
  while (proxies.length) proxies.pop()!.stop();
  vi.restoreAllMocks();
});

afterAll(() => {
  primary.close();
  other.close();
});

describe('stream proxy', () => {
  it('rewrites a header-gated HLS master and variant and serves segments with the Referer', async () => {
    const p = proxy();
    const master = await openOk(p, base + '/gated/master.m3u8', { Referer: 'http://ref/' });
    expect(master).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/http\/127\.0\.0\.1:\d+\/gated\/master\.m3u8$/);
    const prefix = master.slice(0, master.indexOf('/http/'));
    const body = await request(master);
    expect(body.status).toBe(200);
    expect(body.headers['access-control-allow-origin']).toBe('*');
    const text = body.body.toString();
    expect(text).toContain(`URI="${prefix}/http/${base.slice(7)}/gated/a/index.m3u8"`);
    expect(text).toContain(`\n${prefix}/http/${base.slice(7)}/gated/v/index.m3u8\n`);
    expect(text).toContain(`\n${prefix}/http/${otherBase.slice(7)}/abs.m3u8\n`);
    expect(Number(body.headers['content-length'])).toBe(body.body.length);

    const variant = await request(`${prefix}/http/${base.slice(7)}/gated/v/index.m3u8`);
    expect(variant.headers['content-encoding']).toBeUndefined();
    expect(variant.body.toString()).toContain(`URI="${prefix}/http/${base.slice(7)}/gated/v/init.mp4"`);
    expect(variant.body.toString()).toContain(`${prefix}/http/${base.slice(7)}/gated/seg.ts`);

    const segment = await request(`${prefix}/http/${base.slice(7)}/gated/seg.ts`);
    expect(segment.status).toBe(200);
    expect(segment.body.equals(SEGMENT)).toBe(true);
    expect(seen.filter(s => s.url.indexOf('/gated/') === 0).every(s => s.headers.referer === 'http://ref/')).toBe(true);
  });

  it('resolves URIs against the final URL after a redirect', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/redirect.m3u8');
    const prefix = url.slice(0, url.indexOf('/http/'));
    const body = (await request(url)).body.toString();
    expect(body).toContain(`${prefix}/http/${base.slice(7)}/moved/live/seg1.ts`);
  });

  it('inserts a BaseURL after a DASH redirect and leaves templates and license URLs alone', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/redirect.mpd', { Referer: 'http://ref/' });
    const prefix = url.slice(0, url.indexOf('/http/'));
    const reply = await request(url);
    const body = reply.body.toString();
    expect(reply.headers['content-type']).toBe('application/dash+xml');
    expect(body).toContain(`<MPD><BaseURL>${prefix}/http/${base.slice(7)}/dash/final.mpd</BaseURL>`);
    expect(body).toContain('<clearkey:Laurl>https://license/ck</clearkey:Laurl>');
    expect(body).toContain('media="$Number$.m4s" initialization="init.mp4"');
  });

  it('sends credentials only to the session origin, and the channel headers elsewhere', async () => {
    const p = proxy();
    const url = await openOk(p, base.replace('http://', 'http://u:pw@') + '/cross.m3u8',
      { Referer: 'http://ref/', Cookie: 'c=1', Authorization: 'Bearer t' });
    const prefix = url.slice(0, url.indexOf('/http/'));
    await request(url);
    const first = seen.find(s => s.url === '/cross.m3u8')!;
    expect(first.headers.cookie).toBe('c=1');
    expect(first.headers.authorization).toBe('Bearer t');
    const redirected = seen.find(s => s.url === 'other/list.m3u8')!;
    expect(redirected.headers.referer).toBe('http://ref/');
    expect(redirected.headers.cookie).toBeUndefined();
    expect(redirected.headers.authorization).toBeUndefined();

    seen.length = 0;
    await request(`${prefix}/http/${otherBase.slice(7)}/seg.ts`, { headers: { Cookie: 'client=1' } });
    expect(seen[0].headers.referer).toBe('http://ref/');
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('never sends Cookie or Authorization over https', async () => {
    const options: https.RequestOptions[] = [];
    const httpsModule = createRequire(import.meta.url)('https') as typeof https;
    const original = httpsModule.request;
    onTestFinished(() => {
      httpsModule.request = original;
      syncBuiltinESMExports();
    });
    httpsModule.request = ((opts: https.RequestOptions) => {
      options.push(opts);
      const fake = new http.ClientRequest('http://127.0.0.1:1/');
      fake.on('error', () => { /* the stub never connects */ });
      return fake;
    }) as typeof https.request;
    syncBuiltinESMExports();
    const p = proxy({ headerTimeoutMs: 50 });
    const url = await openOk(p, 'https://u:pw@secure.invalid/a.m3u8', { Referer: 'http://ref/', Cookie: 'c=1' });
    await request(url);
    expect(options).toHaveLength(1);
    const headers = options[0].headers as Record<string, string>;
    expect(headers.referer).toBe('http://ref/');
    expect(headers.cookie).toBeUndefined();
    expect(options[0].auth).toBeUndefined();
    expect(options[0].rejectUnauthorized).toBe(false);
  });

  it('passes Range through and answers 206 with the upstream Content-Range', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/gated/seg.ts', { Referer: 'http://ref/' });
    const reply = await request(url, { headers: { Range: 'bytes=10-19' } });
    expect(reply.status).toBe(206);
    expect(reply.headers['content-range']).toBe(`bytes 10-19/${SEGMENT.length}`);
    expect(reply.headers['accept-ranges']).toBe('bytes');
    expect(reply.body.length).toBe(10);
    expect(seen[0].headers.range).toBe('bytes=10-19');
    expect(seen[0].headers['accept-encoding']).toBe('identity');
  });

  it('aborts the upstream request when the client goes away', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/slow.ts');
    await new Promise<void>((resolve) => {
      const req = http.get(url, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => { /* destroyed */ });
    });
    await vi.waitFor(() => expect(sockets[sockets.length - 1].aborted).toBe(true));
  });

  it('answers 504 when upstream sends no headers in time', async () => {
    const p = proxy({ headerTimeoutMs: 50 });
    const url = await openOk(p, base + '/hang.ts');
    expect((await request(url)).status).toBe(504);
  });

  it('refuses an unknown token, a foreign Host, and other methods', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/gated/seg.ts');
    const port = p.port();
    expect((await request(url.replace(/\/p\/[0-9a-f]{32}\//, '/p/' + 'b'.repeat(32) + '/'))).status).toBe(404);
    expect((await request(url, { headers: { Host: 'evil.example:' + port } })).status).toBe(403);
    expect((await request(url, { headers: { Host: 'localhost:' + port } })).status).toBe(403);
    expect((await request(url, { headers: { Host: '127.0.0.1:' + (port + 1) } })).status).toBe(403);
    expect((await request(url, { method: 'POST' })).status).toBe(405);
    expect((await request(`http://127.0.0.1:${port}/open`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('answers a CORS preflight that asks for Range', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/gated/seg.ts');
    const reply = await request(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Headers': 'range' },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe('*');
    expect(String(reply.headers['access-control-allow-headers'])).toMatch(/Range/);
    expect(seen).toHaveLength(0);
  });

  it('expires an idle session and closes the server once none remain', async () => {
    const p = proxy({ sessionIdleMs: 30, serverIdleMs: 30 });
    const busy: boolean[] = [];
    const tracked = proxy({ sessionIdleMs: 30, serverIdleMs: 30, onBusyChange: b => busy.push(b) });
    const url = await openOk(tracked, base + '/gated/seg.ts');
    expect(busy).toEqual([true]);
    expect(p.sessionCount()).toBe(0);
    await vi.waitFor(() => expect(tracked.sessionCount()).toBe(0), { timeout: 3000 });
    await vi.waitFor(() => expect(tracked.port()).toBe(0), { timeout: 3000 });
    expect(busy).toEqual([true, false]);
    await expect(request(url)).rejects.toThrow();
  });

  it('closes a session by token', async () => {
    const p = proxy();
    const result = await open(p, base + '/gated/seg.ts');
    expect(result.returnValue).toBe(true);
    if (!result.returnValue) return;
    expect(p.close(result.token)).toBe(true);
    expect(p.close(result.token)).toBe(false);
    expect((await request(result.url)).status).toBe(404);
  });

  it('rejects a non-http URL', async () => {
    const result = await open(proxy(), 'file:///etc/passwd');
    expect(result).toMatchObject({ returnValue: false, errorCode: 'bad_url' });
  });

  it('serves POST /open and /close for a local origin only, in control mode', async () => {
    const p = proxy({ control: true });
    const port = await new Promise<number>(resolve => p.listen((_e, bound) => resolve(bound)));
    const control = `http://127.0.0.1:${port}`;
    const preflight = await request(control + '/open', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const denied = await request(control + '/open', {
      method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}',
    });
    expect(denied.status).toBe(403);
    const opened = await request(control + '/open', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: base + '/gated/seg.ts', headers: { Referer: 'http://ref/' } }),
    });
    const result = JSON.parse(opened.body.toString());
    expect(result).toMatchObject({ returnValue: true });
    expect((await request(result.url)).body.equals(SEGMENT)).toBe(true);
    const closed = await request(control + '/close', { method: 'POST', body: JSON.stringify({ token: result.token }) });
    expect(JSON.parse(closed.body.toString())).toEqual({ returnValue: true, closed: true, cookies: {} });
    expect(upstreamPath(result.url)).toBe('/gated/seg.ts');
  });
});

describe('stream proxy sessions', () => {
  it('keeps streaming to a paused player past the body idle timeout', async () => {
    const p = proxy({ bodyIdleMs: 100 });
    const url = await openOk(p, base + '/big.ts');
    const received = await new Promise<number>((resolve, reject) => {
      http.get(url, (res) => {
        let length = 0;
        res.pause();
        setTimeout(() => {
          res.on('data', (chunk: Buffer) => { length += chunk.length; });
          res.on('end', () => resolve(length));
          res.on('aborted', () => resolve(length));
          res.resume();
        }, 400);
      }).on('error', reject);
    });
    expect(received).toBe(BIG.length);
  });

  it('still answers 504 when the upstream body stalls', async () => {
    const p = proxy({ bodyIdleMs: 50 });
    const url = await openOk(p, base + '/slow.ts');
    const reply = await new Promise<string>((resolve) => {
      http.get(url, (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve('end'));
        res.on('aborted', () => resolve('aborted'));
        res.on('close', () => resolve('closed'));
      }).on('error', () => resolve('error'));
    });
    expect(reply).not.toBe('end');
  });

  it('evicts an idle session before a streaming one at the session cap', async () => {
    const p = proxy({ headerTimeoutMs: 5000 });
    const streaming = await open(p, base + '/hang.ts');
    if (!streaming.returnValue) throw new Error('open failed');
    const pending = http.get(streaming.url);
    pending.on('error', () => { /* torn down by the proxy's stop */ });
    await vi.waitFor(() => expect(seen.some(s => s.url === '/hang.ts')).toBe(true));
    const idle: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await open(p, base + '/gated/seg.ts');
      if (r.returnValue) idle.push(r.url);
    }
    await openOk(p, base + '/gated/seg.ts');
    expect(p.sessionCount()).toBe(8);
    expect(p.touch(streaming.token).alive).toBe(true);
    expect((await request(idle[0])).status).toBe(404);
    pending.destroy();
  });

  it('holds one busy period across a zap, releasing it only when the server idles out', async () => {
    const busy: boolean[] = [];
    const p = proxy({ serverIdleMs: 30, onBusyChange: b => busy.push(b) });
    const first = await open(p, base + '/gated/seg.ts');
    if (!first.returnValue) throw new Error('open failed');
    p.close(first.token);
    await openOk(p, base + '/gated/seg.ts');
    expect(busy).toEqual([true]);
    p.stop();
    expect(busy).toEqual([true, false]);
  });

  it('serves a manifest up to 4 MiB', async () => {
    const p = proxy();
    const url = await openOk(p, base + '/long.m3u8');
    const reply = await request(url);
    expect(LONG_PLAYLIST.length).toBeGreaterThan(1024 * 1024);
    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toContain('/segment-with-a-long-name.ts');
  });

  it('reports the entry manifest and last upstream status on touch', async () => {
    const p = proxy();
    const result = await open(p, base + '/gated/master.m3u8', { Referer: 'http://ref/' });
    if (!result.returnValue) throw new Error('open failed');
    expect(p.touch(result.token)).toEqual({ alive: true, lastStatus: 0, manifestStatus: 0, cookies: {} });
    await request(result.url);
    const prefix = result.url.slice(0, result.url.indexOf('/http/'));
    await request(`${prefix}/http/${base.slice(7)}/gated/missing.ts`);
    expect(p.touch(result.token)).toEqual({ alive: true, lastStatus: 404, manifestStatus: 200, cookies: {} });
    p.close(result.token);
    expect(p.touch(result.token)).toEqual({ alive: false, lastStatus: 0, manifestStatus: 0, cookies: {} });
    expect(p.touch(42)).toMatchObject({ alive: false });
  });

  it('keeps a touched session past its idle expiry', async () => {
    const p = proxy({ sessionIdleMs: 200 });
    const result = await open(p, base + '/gated/seg.ts');
    if (!result.returnValue) throw new Error('open failed');
    // The sweep runs once a second at most.
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(p.touch(result.token).alive).toBe(true);
    }
  });
});

describe('stream proxy address checks', () => {
  it('flags loopback and unspecified addresses, but not LAN ones', () => {
    ['127.0.0.1', '127.9.9.9', '0.0.0.0', '::1', '[::1]', '::', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1',
      '::ffff:7f00:1', '::ffff:0.0.0.0'].forEach(address => expect(isLoopbackAddress(address), address).toBe(true));
    ['10.0.2.2', '192.168.1.10', '172.16.0.1', '::2', 'fe80::1', '::ffff:10.0.0.1', 'host.invalid']
      .forEach(address => expect(isLoopbackAddress(address), address).toBe(false));
  });

  it('refuses to open a loopback upstream', async () => {
    const p = createStreamProxy();
    proxies.push(p);
    for (const url of ['http://127.0.0.1:1/a.m3u8', 'http://[::1]/a.m3u8', 'http://0.0.0.0/a.m3u8']) {
      expect(await open(p, url), url).toMatchObject({ returnValue: false, errorCode: 'blocked' });
    }
    expect(p.sessionCount()).toBe(0);
  });

  it('refuses a host name that resolves to loopback before connecting', async () => {
    const p = createStreamProxy();
    proxies.push(p);
    const url = await openOk(p, base.replace('127.0.0.1', 'localhost') + '/gated/seg.ts');
    expect((await request(url)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses a redirect back into the proxy itself, even when loopback is allowed', async () => {
    const p = proxy();
    const port = await new Promise<number>(resolve => p.listen((_e, bound) => resolve(bound)));
    const url = await openOk(p, base + '/to-port/' + String(port));
    expect((await request(url)).status).toBe(403);
    expect(await open(p, `http://127.0.0.1:${port}/x.m3u8`)).toMatchObject({ errorCode: 'blocked' });
  });
});

describe('stream proxy cookie jar', () => {
  it('sends upstream cookies on later requests, and the channel Cookie wins a clash', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const p = proxy();
    const result = await open(p, base + '/cookie/master.m3u8', { Cookie: 'theme=own' });
    if (!result.returnValue) throw new Error('open failed');
    const prefix = result.url.slice(0, result.url.indexOf('/http/'));
    await request(result.url);
    await request(`${prefix}/http/${base.slice(7)}/cookie/seg.ts`);
    expect(seen[1].headers.cookie).toBe('theme=own; sid=s1');
    await request(`${prefix}/http/${base.slice(7)}/elsewhere.ts`);
    expect(seen[2].headers.cookie).toBe('theme=own');
    const drops = { malformed: 1, domain: 1, https: 1 };
    expect(p.touch(result.token).cookies).toEqual(drops);
    expect(p.closeWithStatus(result.token)).toEqual({ closed: true, cookies: drops });
    const logged = info.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('event=playback.proxy.cookie reason=malformed count=1');
    expect(logged).toContain('event=playback.proxy.cookie reason=domain count=1');
    expect(logged).toContain('event=playback.proxy.cookie reason=https count=1');
    expect(logged).not.toMatch(/sid|s1|theme|elsewhere/);
  });

  it('carries a cookie set on a redirect, and never into another session', async () => {
    const p = proxy();
    const first = await openOk(p, base + '/cookie/redirect.m3u8');
    await request(first);
    expect(seen.find(s => s.url === '/cookie/after.m3u8')!.headers.cookie).toBe('hop=h1');
    seen.length = 0;
    const second = await openOk(p, base + '/cookie/after.m3u8');
    await request(second);
    expect(seen[0].headers.cookie).toBeUndefined();
  });
});

describe('proxy Luna methods', () => {
  type Handler = (msg: ProxyLunaMsg) => void;

  function register(): { handlers: Record<string, Handler>; proxy: StreamProxy } {
    const handlers: Record<string, Handler> = {};
    const created = registerProxyService({ register: (m, h) => { handlers[m] = h; } }, APP_ID, proxy());
    return { handlers, proxy: created };
  }

  function call(handler: Handler, payload: ProxyLunaMsg['payload'], sender: string): Promise<Record<string, unknown>> {
    return new Promise(resolve => handler({
      payload,
      sender,
      respond: (r: unknown) => resolve(r as Record<string, unknown>),
    }));
  }

  it('denies another caller and logs the denial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { handlers, proxy: p } = register();
    const opened = await call(handlers.openProxy, { url: base + '/gated/seg.ts' }, 'com.example.other');
    expect(opened).toMatchObject({ returnValue: false, errorCode: 'denied' });
    expect(p.sessionCount()).toBe(0);
    const closed = await call(handlers.closeProxy, { token: 'x' }, 'com.example.other');
    expect(closed).toMatchObject({ returnValue: false, errorCode: 'denied' });
    expect(warn.mock.calls.map(c => c.join(' ')).join('\n')).toMatch(/openProxy outcome=denied/);
  });

  it('completes the keep-alive activity it created once the proxy goes idle', async () => {
    const live = new Set<number>();
    const activityManager = {
      create(_name: string, callback: (activity: unknown) => void) {
        setTimeout(() => {
          live.add(7);
          callback({ activityId: 7 });
        }, 1);
      },
      complete(activity: unknown, callback: () => void) {
        const id = (activity as { activityId?: number }).activityId;
        if (id !== undefined) live.delete(id);
        callback();
      },
    };
    const handlers: Record<string, Handler> = {};
    const created = registerProxyService({ register: (m, h) => { handlers[m] = h; }, activityManager }, APP_ID);
    proxies.push(created);
    expect(await call(handlers.openProxy, { url: 'http://host.invalid/a.m3u8' }, APP_ID)).toMatchObject({
      returnValue: true,
    });
    await vi.waitFor(() => expect(live.size).toBe(1));
    created.stop();
    expect(live.size).toBe(0);
  });

  it('touches a session for the app', async () => {
    const { handlers } = register();
    const opened = await call(handlers.openProxy, { url: base + '/gated/seg.ts' }, APP_ID);
    expect(await call(handlers.touchProxy, { token: opened.token }, APP_ID))
      .toEqual({ returnValue: true, alive: true, lastStatus: 0, manifestStatus: 0, cookies: {} });
    expect(await call(handlers.touchProxy, { token: opened.token }, 'com.example.other'))
      .toMatchObject({ returnValue: false, errorCode: 'denied' });
  });

  it('opens and closes a session for the app', async () => {
    const { handlers, proxy: p } = register();
    const opened = await call(handlers.openProxy, { url: base + '/gated/seg.ts', headers: { Referer: 'http://ref/' } },
      APP_ID + ' 1234');
    expect(opened).toMatchObject({ returnValue: true });
    expect(p.sessionCount()).toBe(1);
    expect(await call(handlers.closeProxy, { token: opened.token }, APP_ID)).toEqual({ returnValue: true, closed: true, cookies: {} });
    expect(p.sessionCount()).toBe(0);
  });
});
