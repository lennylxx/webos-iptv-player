import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as zlib from 'zlib';
import {
  MANIFEST_FETCH_HARD_MAX_BYTES,
  fetchManifest,
  requestAuth,
  requestHeaders,
  sanitizeHeaders,
  type ManifestFetchRequest,
  type ManifestFetchResult,
} from './manifest-fetch';
import * as nodeUrl from 'url';
import { isAppCaller, registerManifestFetchService, senderShape, type LunaMsg } from './service';

const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n';

type Seen = { url: string; headers: http.IncomingHttpHeaders };

let primary: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';
const seen: Seen[] = [];

function listen(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fetchResult(request: ManifestFetchRequest): Promise<ManifestFetchResult> {
  return new Promise(resolve => fetchManifest(request, resolve));
}

beforeAll(async () => {
  other = await listen((req, res) => {
    seen.push({ url: req.url || '', headers: req.headers });
    res.end(PLAYLIST);
  });
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  primary = await listen((req, res) => {
    seen.push({ url: req.url || '', headers: req.headers });
    const path = req.url || '';
    if (path === '/a.m3u8') {
      res.end(PLAYLIST);
    } else if (path === '/bom.m3u8') {
      res.end('\ufeff' + PLAYLIST);
    } else if (path === '/gzip.m3u8') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync(PLAYLIST));
    } else if (path === '/deflate.m3u8') {
      res.setHeader('Content-Encoding', 'deflate');
      res.end(zlib.deflateSync(PLAYLIST));
    } else if (path === '/bomb.m3u8') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync('#EXTM3U\n' + 'x'.repeat(4096)));
    } else if (path === '/big.m3u8') {
      res.setHeader('Content-Length', '4096');
      res.end('x'.repeat(4096));
    } else if (path === '/stream.m3u8') {
      // Chunked: no Content-Length to reject up front.
      res.write('#EXTM3U\n');
      res.end('x'.repeat(4096));
    } else if (path === '/hang.m3u8') {
      res.write('#EXTM3U\n');
    } else if (path === '/forbidden.m3u8') {
      res.statusCode = 403;
      res.end('denied');
    } else if (path === '/same') {
      res.writeHead(302, { Location: '/dir/a.m3u8' });
      res.end();
    } else if (path === '/dir/a.m3u8') {
      res.end(PLAYLIST);
    } else if (path === '/auth-same') {
      res.writeHead(302, { Location: '/dir/a.m3u8' });
      res.end();
    } else if (path === '/auth-absolute') {
      res.writeHead(302, { Location: `${base}/dir/a.m3u8` });
      res.end();
    } else if (path === '/%C3%A9/a.m3u8') {
      res.end(PLAYLIST);
    } else if (path === '/cross') {
      res.writeHead(301, { Location: `${otherBase}/x/a.m3u8` });
      res.end();
    } else if (path === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (path === '/scheme') {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  base = `http://127.0.0.1:${(primary.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise(resolve => primary.close(resolve));
  await new Promise(resolve => other.close(resolve));
});

function lastSeen(): Seen {
  return seen[seen.length - 1];
}

describe('fetchManifest', () => {
  it('returns the body, status, and final URL', async () => {
    expect(await fetchResult({ url: `${base}/a.m3u8` })).toEqual({
      returnValue: true, status: 200, url: `${base}/a.m3u8`, text: PLAYLIST,
    });
  });

  it('forwards channel headers and drops unsafe ones', async () => {
    const result = await fetchResult({
      url: `${base}/a.m3u8`,
      headers: {
        Referrer: 'http://host/r',
        'User-Agent': 'Agent 1',
        Cookie: 'c=1',
        Authorization: 'Bearer t1',
        'X-Token': 'v1',
        Host: 'host2',
        'Content-Length': '9',
        Connection: 'upgrade',
        'Transfer-Encoding': 'chunked',
        'Proxy-Authorization': 'p1',
        'X-Split': 'a\r\nX-Injected: 1',
        'Bad Name': 'v2',
        'X-Number': 7,
      },
    });
    expect(result.returnValue).toBe(true);
    const headers = lastSeen().headers;
    expect(headers.referer).toBe('http://host/r');
    expect(headers['user-agent']).toBe('Agent 1');
    expect(headers.cookie).toBe('c=1');
    expect(headers.authorization).toBe('Bearer t1');
    expect(headers['x-token']).toBe('v1');
    expect(headers.host).toBe(base.replace('http://', ''));
    expect(headers.connection).not.toBe('upgrade');
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['proxy-authorization']).toBeUndefined();
    expect(headers['x-split']).toBeUndefined();
    expect(headers['x-injected']).toBeUndefined();
    expect(headers['x-number']).toBeUndefined();
    expect(headers['accept-encoding']).toBe('gzip, deflate');
  });

  it('withholds credentials from https, as the Luna path does', () => {
    const carried = sanitizeHeaders({ Cookie: 'c=1', Authorization: 'Basic a', Referer: 'http://host/r' });
    expect(requestHeaders('https:', carried))
      .toEqual({ 'accept-encoding': 'gzip, deflate', referer: 'http://host/r' });
    expect(requestHeaders('http:', carried)).toEqual({
      'accept-encoding': 'gzip, deflate', cookie: 'c=1', authorization: 'Basic a', referer: 'http://host/r',
    });
  });

  it('follows a same-origin redirect with every header and reports the final URL', async () => {
    const result = await fetchResult({
      url: `${base}/same`,
      headers: { Referer: 'http://host/r', Cookie: 'c=1' },
    });
    expect(result).toMatchObject({ returnValue: true, url: `${base}/dir/a.m3u8`, text: PLAYLIST });
    expect(lastSeen().url).toBe('/dir/a.m3u8');
    expect(lastSeen().headers.cookie).toBe('c=1');
    expect(lastSeen().headers.referer).toBe('http://host/r');
  });

  it('keeps credentials on their origin across a redirect', async () => {
    const result = await fetchResult({
      url: `${base}/cross`,
      headers: { Referer: 'http://host/r', 'User-Agent': 'Agent 1', Cookie: 'c=1', Authorization: 'Basic a' },
    });
    expect(result).toMatchObject({ returnValue: true, url: `${otherBase}/x/a.m3u8` });
    const headers = lastSeen().headers;
    expect(headers.referer).toBe('http://host/r');
    expect(headers['user-agent']).toBe('Agent 1');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('sends URL credentials as Basic auth on its origin only and never reports them', async () => {
    const authed = base.replace('http://', 'http://u1:p1@');
    const basic = `Basic ${Buffer.from('u1:p1').toString('base64')}`;
    expect(await fetchResult({ url: `${authed}/a.m3u8` }))
      .toMatchObject({ returnValue: true, url: `${base}/a.m3u8` });
    expect(lastSeen().headers.authorization).toBe(basic);
    for (const path of ['/auth-same', '/auth-absolute']) {
      expect(await fetchResult({ url: `${authed}${path}` }))
        .toMatchObject({ returnValue: true, url: `${base}/dir/a.m3u8` });
      expect(lastSeen().headers.authorization).toBe(basic);
    }
    expect(await fetchResult({ url: `${authed}/cross` }))
      .toMatchObject({ returnValue: true, url: `${otherBase}/x/a.m3u8` });
    expect(lastSeen().headers.authorization).toBeUndefined();
    expect(requestAuth(nodeUrl.parse('https://u1:p1@host/a'), 'u1:p1')).toBeUndefined();
    expect(requestAuth(nodeUrl.parse('http://u1:p1@host/a'), 'u1:p1')).toBe('u1:p1');
  });

  it('requests a percent-encoded path as given', async () => {
    expect(await fetchResult({ url: `${base}/%C3%A9/a.m3u8` }))
      .toMatchObject({ returnValue: true, text: PLAYLIST });
    expect(lastSeen().url).toBe('/%C3%A9/a.m3u8');
  });

  it('stops after a bounded number of redirects', async () => {
    expect(await fetchResult({ url: `${base}/loop` }))
      .toMatchObject({ returnValue: false, errorCode: 'too_many_redirects' });
  });

  it('rejects anything but http and https, including by redirect', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://host/a', 'data:text/plain,a', 'http://', '', 7]) {
      expect(await fetchResult({ url })).toMatchObject({ returnValue: false, errorCode: 'bad_url' });
    }
    expect(await fetchResult({ url: `${base}/scheme` }))
      .toMatchObject({ returnValue: false, errorCode: 'bad_url' });
  });

  it('reports an HTTP error status', async () => {
    expect(await fetchResult({ url: `${base}/forbidden.m3u8` })).toEqual({
      returnValue: false, errorCode: 'http_403', errorText: 'HTTP 403', status: 403,
    });
  });

  it('decodes gzip and deflate bodies and drops a UTF-8 BOM', async () => {
    expect(await fetchResult({ url: `${base}/gzip.m3u8` })).toMatchObject({ text: PLAYLIST });
    expect(await fetchResult({ url: `${base}/deflate.m3u8` })).toMatchObject({ text: PLAYLIST });
    expect(await fetchResult({ url: `${base}/bom.m3u8` })).toMatchObject({ text: PLAYLIST });
  });

  it('enforces the size cap on declared, streamed, and decoded bodies', async () => {
    for (const path of ['/big.m3u8', '/stream.m3u8', '/bomb.m3u8']) {
      expect(await fetchResult({ url: `${base}${path}`, maxBytes: 1024 }))
        .toMatchObject({ returnValue: false, errorCode: 'too_large', status: 200 });
    }
  });

  it('caps the size limit the caller asks for', async () => {
    const result = await fetchResult({ url: `${base}/a.m3u8`, maxBytes: MANIFEST_FETCH_HARD_MAX_BYTES * 8 });
    expect(result.returnValue).toBe(true);
  });

  it('times out and answers once', async () => {
    const done = vi.fn();
    await new Promise<void>((resolve) => {
      fetchManifest({ url: `${base}/hang.m3u8`, timeoutMs: 100 }, (result) => {
        done(result);
        setTimeout(resolve, 100);
      });
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({ returnValue: false, errorCode: 'timeout' });
  });

  it('reports a refused connection as a network failure', async () => {
    const closed = await listen(() => {});
    const port = (closed.address() as AddressInfo).port;
    await new Promise(resolve => closed.close(resolve));
    expect(await fetchResult({ url: `http://127.0.0.1:${port}/a.m3u8` }))
      .toMatchObject({ returnValue: false, errorCode: 'network' });
  });
});

describe('fetchManifest Luna method', () => {
  const APP = 'com.example.app';

  function call(msg: Partial<LunaMsg>): Promise<Record<string, unknown>> {
    let handler: ((msg: LunaMsg) => void) | null = null;
    registerManifestFetchService({ register: (_name, h) => { handler = h; } }, APP);
    return new Promise((resolve) => {
      handler!({ ...msg, respond: r => resolve(r as Record<string, unknown>) } as LunaMsg);
    });
  }

  it('answers the app', async () => {
    expect(await call({ sender: APP, payload: { url: `${base}/a.m3u8` } }))
      .toMatchObject({ returnValue: true, text: PLAYLIST });
  });

  it('denies every other caller without fetching', async () => {
    const before = seen.length;
    for (const sender of ['com.example.other', `${APP}.service`, `${APP}x`, `${APP}-1x`, `${APP}-2`, '', undefined]) {
      expect(await call({ sender, payload: { url: `${base}/a.m3u8` } }))
        .toMatchObject({ returnValue: false, errorCode: 'denied' });
    }
    expect(seen.length).toBe(before);
  });

  it('logs a denied sender with its digits masked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await call({ sender: 'com.example.other2 1234', payload: { url: `${base}/a.m3u8` } });
      expect(warn).toHaveBeenCalledWith(
        '[fetch]', 'fetchManifest outcome=denied sender="com.example.otherN NNNN" source=sender');
    } finally {
      warn.mockRestore();
    }
    expect(senderShape({
      respond: () => {},
      ls2Message: { applicationID: () => '', senderServiceName: () => 'com.example.app-42' },
    })).toBe('"com.example.app-NN" source=senderServiceName');
    expect(senderShape({
      respond: () => {},
      ls2Message: { applicationID: () => 'com.example.app-2', senderServiceName: () => '' },
    })).toBe('"com.example.app-N" source=applicationID');
    expect(senderShape({ respond: () => {} })).toBe('"" source=none');
  });

  it('recognizes the app in the sender forms webOS reports', () => {
    expect(isAppCaller({ respond: () => {}, sender: APP }, APP)).toBe(true);
    expect(isAppCaller({ respond: () => {}, sender: `${APP} 1234` }, APP)).toBe(true);
    expect(isAppCaller({
      respond: () => {},
      ls2Message: { applicationID: () => `${APP} 1234`, senderServiceName: () => '' },
    }, APP)).toBe(true);
    expect(isAppCaller({
      respond: () => {},
      ls2Message: { applicationID: () => '', senderServiceName: () => `${APP}-1234` },
    }, APP)).toBe(true);
    expect(isAppCaller({
      respond: () => {},
      sender: APP,
      ls2Message: { applicationID: () => `${APP} 1234`, senderServiceName: () => '' },
    }, APP)).toBe(true);
  });

  it('reads the service name when the application id lookup throws', () => {
    const msg: LunaMsg = {
      respond: () => {},
      ls2Message: {
        applicationID: () => { throw new Error('no app id'); },
        senderServiceName: () => `${APP}-1234`,
      },
    };
    expect(isAppCaller(msg, APP)).toBe(true);
    expect(senderShape(msg)).toBe(`"${APP}-NNNN" source=senderServiceName`);
  });

  it('denies another app whose id is the app id plus "-<digits>"', () => {
    // webos-service reports the app id as sender too, so neither form may pass.
    expect(isAppCaller({
      respond: () => {},
      sender: `${APP}-2`,
      ls2Message: { applicationID: () => `${APP}-2`, senderServiceName: () => '' },
    }, APP)).toBe(false);
    expect(isAppCaller({
      respond: () => {},
      ls2Message: { applicationID: () => `${APP}-2 1234`, senderServiceName: () => '' },
    }, APP)).toBe(false);
    expect(isAppCaller({ respond: () => {}, sender: `${APP}-2` }, APP)).toBe(false);
    expect(isAppCaller({
      respond: () => {},
      ls2Message: { applicationID: () => `${APP} x`, senderServiceName: () => '' },
    }, APP)).toBe(false);
    expect(isAppCaller({
      respond: () => {},
      ls2Message: { applicationID: () => '', senderServiceName: () => 'com.example.other' },
    }, APP)).toBe(false);
    expect(isAppCaller({ respond: () => {}, sender: APP }, '')).toBe(false);
  });
});
