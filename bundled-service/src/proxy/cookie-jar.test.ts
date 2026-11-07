import { describe, expect, it } from 'vitest';
import { COOKIE_JAR_MAX, createCookieJar } from './cookie-jar';

const at = (href: string) => {
  const url = new URL(href);
  return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname };
};

describe('cookie jar', () => {
  it('matches host-only and Domain cookies by RFC 6265 domain and path rules', () => {
    const jar = createCookieJar();
    jar.store(['a=1', 'b=2; Domain=.example.test; Path=/', 'c=3; Path=/live/'], at('http://cdn.example.test/live/x.m3u8'));
    expect(jar.header(at('http://cdn.example.test/live/seg.ts'), undefined)).toBe('c=3; a=1; b=2');
    expect(jar.header(at('http://edge.cdn.example.test/vod/seg.ts'), undefined)).toBe('b=2');
    expect(jar.header(at('http://notexample.test/live/seg.ts'), undefined)).toBe('');
    expect(jar.header(at('http://cdn.example.test/liveother'), undefined)).toBe('b=2');
    expect(jar.header(at('https://cdn.example.test/live/seg.ts'), 'own=1')).toBe('own=1');
  });

  it('replaces, expires, and deletes cookies', () => {
    let now = 1000;
    const jar = createCookieJar(() => now);
    const url = at('http://h.test/a/b.m3u8');
    jar.store(['a=1; Max-Age=10', 'b=1', 'c=1'], url);
    jar.store(['b=2', 'c=; Max-Age=0', 'd=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], url);
    expect(jar.header(url, undefined)).toBe('a=1; b=2');
    now += 11000;
    expect(jar.header(url, undefined)).toBe('b=2');
    expect(jar.drops()).toEqual({});
  });

  it('counts each cookie it cannot honor by reason', () => {
    const jar = createCookieJar();
    jar.store(['=x', 'noequals', 's=1; Secure', 'x=1; Domain=other.test'], at('http://h.test/'));
    jar.store('t=1', at('https://h.test/'));
    for (let i = 0; i <= COOKIE_JAR_MAX; i++) jar.store('n' + String(i) + '=1', at('http://h.test/'));
    expect(jar.size()).toBe(COOKIE_JAR_MAX);
    expect(jar.drops()).toEqual({ malformed: 2, https: 2, domain: 1, cap: 1 });
  });

  it('refuses a Domain attribute on an IP host other than the host itself', () => {
    const jar = createCookieJar();
    jar.store(['a=1; Domain=0.2.2', 'b=1; Domain=10.0.2.2'], at('http://10.0.2.2/x'));
    expect(jar.header(at('http://10.0.2.2/y'), undefined)).toBe('b=1');
    expect(jar.drops()).toEqual({ domain: 1 });
  });
});
