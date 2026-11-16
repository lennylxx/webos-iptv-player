/**
 * One upstream http(s) request, shared by fetchManifest and the loopback
 * proxy: its request options, and where a redirect leads with which
 * credentials.
 */

import * as http from 'http';
import * as https from 'https';
import * as nodeUrl from 'url';

export const MAX_REDIRECTS = 5;
export const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
// As on the app's Luna path, UMS does not verify TLS certificates, so
// credentials never travel over https; they also never leave their origin.
const CREDENTIAL_HEADERS = ['authorization', 'cookie'];

export function httpUrl(input: unknown): nodeUrl.Url | null {
  if (typeof input !== 'string' || !input || /[\0-\x20\x7f]/.test(input)) return null;
  const parsed = nodeUrl.parse(input);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname ? parsed : null;
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

export function origin(url: nodeUrl.Url): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return url.protocol + '//' + (url.hostname || '').toLowerCase() + ':' + port;
}

export function transport(url: nodeUrl.Url): { request(options: https.RequestOptions): http.ClientRequest } {
  return url.protocol === 'https:' ? https : http;
}

export function upstreamOptions(
  url: nodeUrl.Url,
  method: string,
  headers: Record<string, string>,
  auth: string,
  agent: http.Agent | false,
): https.RequestOptions {
  const options: https.RequestOptions = {
    method: method,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: url.path || '/',
    headers: headers,
    agent: agent,
  };
  const basic = requestAuth(url, auth);
  if (basic) options.auth = basic;
  // UMS plays the stream without verifying the certificate either; no
  // credential is ever sent over https.
  if (url.protocol === 'https:') options.rejectUnauthorized = false;
  return options;
}

export function isRedirect(status: number, location: unknown): location is string {
  return REDIRECT_STATUSES.indexOf(status) >= 0 && typeof location === 'string' && !!location;
}

export interface NextHop {
  url: nodeUrl.Url;
  carried: Record<string, string>;
  auth: string;
}

export type HopFailure = 'too_many_redirects' | 'bad_url';

/** Where a redirect from `url` after `redirects` hops leads, and what it carries there. */
export function nextHop(
  url: nodeUrl.Url,
  location: string,
  redirects: number,
  carried: Record<string, string>,
  auth: string,
): NextHop | HopFailure {
  if (redirects >= MAX_REDIRECTS) return 'too_many_redirects';
  const next = httpUrl(nodeUrl.resolve(url.href || '', location));
  if (!next) return 'bad_url';
  const sameOrigin = origin(next) === origin(url);
  return {
    url: next,
    carried: sameOrigin ? carried : withoutCredentials(carried),
    auth: sameOrigin ? next.auth || auth : '',
  };
}
