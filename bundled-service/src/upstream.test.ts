import { describe, expect, it } from 'vitest';
import * as http from 'http';
import * as https from 'https';
import * as nodeUrl from 'url';
import { MAX_REDIRECTS, isRedirect, nextHop, transport, upstreamOptions, type NextHop } from './upstream';

const carried = { referer: 'http://host/r', cookie: 'c=1', authorization: 'Basic x' };

function hop(from: string, location: string, redirects = 0, auth = 'u1:p1'): NextHop {
  const next = nextHop(nodeUrl.parse(from), location, redirects, carried, auth);
  if (typeof next === 'string') throw new Error(next);
  return next;
}

describe('nextHop', () => {
  it('drops credentials and auth on a cross-origin redirect', () => {
    const next = hop('http://host-a/a.m3u8', 'http://host-b/b.m3u8');
    expect(next.url.href).toBe('http://host-b/b.m3u8');
    expect(next.carried).toEqual({ referer: 'http://host/r' });
    expect(next.auth).toBe('');
  });

  it('keeps credentials within the origin and takes the new user:password', () => {
    const relative = hop('http://host-a/x/a.m3u8', 'b.m3u8');
    expect(relative.url.href).toBe('http://host-a/x/b.m3u8');
    expect(relative.carried).toBe(carried);
    expect(relative.auth).toBe('u1:p1');

    expect(hop('http://host-a/a.m3u8', 'http://u2:p2@HOST-A:80/b.m3u8').auth).toBe('u2:p2');
  });

  it('stops at the redirect limit', () => {
    expect(hop('http://host-a/a', '/b', MAX_REDIRECTS - 1).url.path).toBe('/b');
    expect(nextHop(nodeUrl.parse('http://host-a/a'), '/b', MAX_REDIRECTS, carried, '')).toBe('too_many_redirects');
  });

  it('rejects a Location outside http and https', () => {
    expect(nextHop(nodeUrl.parse('http://host-a/a'), 'file:///etc/passwd', 0, carried, '')).toBe('bad_url');
  });

  it('detects a redirect only with a Location', () => {
    expect(isRedirect(302, '/b')).toBe(true);
    expect(isRedirect(302, '')).toBe(false);
    expect(isRedirect(200, '/b')).toBe(false);
  });
});

describe('upstreamOptions', () => {
  it('skips the certificate check and Basic auth over https', () => {
    const url = nodeUrl.parse('https://u1:p1@host-a:8443/a.m3u8?x=1');
    const options = upstreamOptions(url, 'GET', { referer: 'http://host/r' }, 'u1:p1', false);
    expect(options).toEqual({
      method: 'GET', hostname: 'host-a', port: 8443, path: '/a.m3u8?x=1',
      headers: { referer: 'http://host/r' }, agent: false, rejectUnauthorized: false,
    });
    expect(transport(url)).toBe(https);
  });

  it('sends Basic auth over http and defaults the path', () => {
    const url = nodeUrl.parse('http://host-a');
    const agent = new http.Agent();
    const options = upstreamOptions(url, 'HEAD', {}, 'u1:p1', agent);
    expect(options).toEqual({
      method: 'HEAD', hostname: 'host-a', port: undefined, path: '/',
      headers: {}, agent: agent, auth: 'u1:p1',
    });
    expect(transport(url)).toBe(http);
  });
});
