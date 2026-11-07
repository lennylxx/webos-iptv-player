/**
 * A proxy session's cookie jar (RFC 6265): what the upstream sets with
 * Set-Cookie goes back on the session's later requests, redirects included.
 * It never crosses sessions, and nothing is sent over https, where the proxy
 * does not check certificates and so sends no credential at all.
 */

export const COOKIE_JAR_MAX = 50;

/** Why a Set-Cookie was not honored. */
export type CookieDrop = 'https' | 'domain' | 'malformed' | 'cap';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expires: number;
  created: number;
}

export interface CookieJar {
  store(setCookie: unknown, url: { protocol?: string | null; hostname?: string | null; pathname?: string | null }): void;
  /** The Cookie header for a request: the channel's own value first, then the jar's other names. */
  header(url: { protocol?: string | null; hostname?: string | null; pathname?: string | null },
    channelCookie: string | undefined): string;
  drops(): { [reason: string]: number };
  size(): number;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function trim(value: string): string {
  return value.replace(/^[\s\t]+|[\s\t]+$/g, '');
}

function defaultPath(path: string): string {
  if (!path || path.charAt(0) !== '/') return '/';
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return !IPV4.test(host) && host.indexOf(':') < 0 && host.length > domain.length
    && host.slice(-domain.length - 1) === '.' + domain;
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.indexOf(cookiePath) !== 0) return false;
  return cookiePath.charAt(cookiePath.length - 1) === '/' || requestPath.charAt(cookiePath.length) === '/';
}

function lines(setCookie: unknown): string[] {
  if (typeof setCookie === 'string') return [setCookie];
  if (Object.prototype.toString.call(setCookie) !== '[object Array]') return [];
  return (setCookie as unknown[]).filter((line): line is string => typeof line === 'string');
}

function cookieNames(header: string): string[] {
  return header.split(';').map((pair) => {
    const eq = pair.indexOf('=');
    return trim(eq < 0 ? pair : pair.slice(0, eq));
  }).filter(name => !!name);
}

export function createCookieJar(now: () => number = Date.now): CookieJar {
  let cookies: Cookie[] = [];
  const dropped: { [reason: string]: number } = {};

  const drop = (reason: CookieDrop): void => {
    dropped[reason] = (dropped[reason] || 0) + 1;
  };

  const live = (): Cookie[] => {
    const time = now();
    cookies = cookies.filter(cookie => cookie.expires > time);
    return cookies;
  };

  function parse(line: string, host: string, requestPath: string, secure: boolean): void {
    const parts = line.split(';');
    const pair = parts[0];
    const eq = pair.indexOf('=');
    const name = eq < 0 ? '' : trim(pair.slice(0, eq));
    if (!name || !TOKEN.test(name)) {
      drop('malformed');
      return;
    }
    const value = trim(pair.slice(eq + 1));
    const time = now();
    let expires = Infinity;
    let maxAge: number | null = null;
    let domain = '';
    let path = '';
    let secureOnly = false;
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i];
      const at = attr.indexOf('=');
      const key = trim(at < 0 ? attr : attr.slice(0, at)).toLowerCase();
      const attrValue = at < 0 ? '' : trim(attr.slice(at + 1));
      if (key === 'expires') {
        const parsed = Date.parse(attrValue);
        if (!isNaN(parsed)) expires = parsed;
      } else if (key === 'max-age') {
        if (/^-?\d+$/.test(attrValue)) maxAge = Number(attrValue);
      } else if (key === 'domain') {
        domain = attrValue.replace(/^\./, '').toLowerCase();
      } else if (key === 'path') {
        path = attrValue.charAt(0) === '/' ? attrValue : '';
      } else if (key === 'secure') {
        secureOnly = true;
      }
    }
    if (maxAge !== null) expires = maxAge <= 0 ? 0 : time + maxAge * 1000;
    if (secure || secureOnly) {
      drop('https');
      return;
    }
    let hostOnly = true;
    if (domain) {
      if (!domainMatch(host, domain)) {
        drop('domain');
        return;
      }
      hostOnly = false;
    } else {
      domain = host;
    }
    if (!path) path = defaultPath(requestPath);
    const existing = live();
    let index = -1;
    for (let i = 0; i < existing.length; i++) {
      const c = existing[i];
      if (c.name === name && c.domain === domain && c.path === path) index = i;
    }
    const created = index >= 0 ? existing[index].created : time;
    if (index >= 0) existing.splice(index, 1);
    if (expires <= time) return;
    if (existing.length >= COOKIE_JAR_MAX) {
      drop('cap');
      return;
    }
    existing.push({ name: name, value: value, domain: domain, hostOnly: hostOnly, path: path,
      expires: expires, created: created });
  }

  return {
    store(setCookie, url) {
      const host = String(url.hostname || '').toLowerCase();
      if (!host) return;
      const secure = url.protocol === 'https:';
      lines(setCookie).forEach(line => parse(line, host, url.pathname || '/', secure));
    },
    header(url, channelCookie) {
      const own = channelCookie ? trim(channelCookie) : '';
      if (url.protocol === 'https:') return own;
      const host = String(url.hostname || '').toLowerCase();
      const path = url.pathname || '/';
      const taken = cookieNames(own);
      const matching = live().filter(cookie => (cookie.hostOnly ? host === cookie.domain
        : domainMatch(host, cookie.domain)) && pathMatch(path, cookie.path) && taken.indexOf(cookie.name) < 0);
      matching.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
      const pairs = matching.map(cookie => cookie.name + '=' + cookie.value);
      if (own) pairs.unshift(own);
      return pairs.join('; ');
    },
    drops() {
      const copy: { [reason: string]: number } = {};
      Object.keys(dropped).forEach((reason) => { copy[reason] = dropped[reason]; });
      return copy;
    },
    size() {
      return live().length;
    },
  };
}
