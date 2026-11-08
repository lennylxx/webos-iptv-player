import type { Channel } from '../types';
import { DRM_OPTION_KEYS } from '../services/drm-option-keys';

// FNV-1a (32-bit) — fast, dependency-free, non-cryptographic. Good enough for a
// stable short identity key; collisions are negligible at playlist scale.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // padStart is a JS polyfill on Chromium 53, and this runs per channel.
  return HEX[h >>> 28] + HEX[(h >>> 24) & 15] + HEX[(h >>> 20) & 15] + HEX[(h >>> 16) & 15]
    + HEX[(h >>> 12) & 15] + HEX[(h >>> 8) & 15] + HEX[(h >>> 4) & 15] + HEX[h & 15];
}

const HEX = '0123456789abcdef';

const VOLATILE_QUERY_PARAMS = new Set([
  'access_token',
  'auth',
  'auth_token',
  'e',
  'exp',
  'expires',
  'expiry',
  'hdnea',
  'hdnts',
  'key',
  'mac',
  'signature',
  'sig',
  'token',
  'wmsauthsign',
]);

function queryParamName(part: string): string {
  const raw = part.split('=', 1)[0].replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export function stableStreamUrl(url: string): string {
  const withoutFragment = url.split('#')[0];
  const queryAt = withoutFragment.indexOf('?');
  if (queryAt < 0) return withoutFragment;
  const base = withoutFragment.slice(0, queryAt);
  const query = withoutFragment.slice(queryAt + 1)
    .split('&')
    .filter(part => part && !VOLATILE_QUERY_PARAMS.has(queryParamName(part)))
    .sort()
    .join('&');
  return query ? `${base}?${query}` : base;
}

/** The location line as the playlist wrote it, header suffix included, so
 *  splitting headers off `url` never changes a channel's identity. */
export function channelIdentityUrl(ch: Channel): string {
  const url = ch.url || '';
  return ch.urlSuffix ? `${url}|${ch.urlSuffix}` : url;
}

interface KeyMemo {
  identity: string;
  key?: string;
  legacy?: string;
}

// Every boot keys each channel several times (customization, indexes, EPG);
// hashing 200k URLs once per pass dominated the main thread.
const keyMemos = new WeakMap<Channel, KeyMemo>();

function keyMemo(ch: Channel): KeyMemo {
  const identity = channelIdentityUrl(ch);
  let memo = keyMemos.get(ch);
  if (!memo || memo.identity !== identity) {
    memo = { identity };
    keyMemos.set(ch, memo);
  }
  return memo;
}

// TODO(cleanup, post-1.9.0): remove after the released query-stripped keys no
// longer need migration or compatibility lookup.
export function legacyChannelKey(ch: Channel): string {
  const memo = keyMemo(ch);
  if (memo.legacy === undefined) memo.legacy = fnv1a(memo.identity.split('#')[0].split('?')[0]);
  return memo.legacy;
}

/** Stable per-stream identity used by all channel-scoped data. */
export function channelKey(ch: Channel): string {
  const memo = keyMemo(ch);
  if (memo.key === undefined) memo.key = fnv1a(stableStreamUrl(memo.identity));
  return memo.key;
}

/** Every HTTP header the channel declares; parsed headers win over the
 *  EXTVLCOPT extras that older playlist caches carry on their own. */
export function channelHttpHeaders(ch: Channel): Record<string, string> {
  const headers: Record<string, string> = {};
  const referer = ch.extras?.['http-referrer'];
  const userAgent = ch.extras?.['http-user-agent'];
  if (referer) headers.Referer = referer;
  if (userAgent) headers['User-Agent'] = userAgent;
  const declared = ch.httpHeaders ?? {};
  for (const name of Object.keys(declared)) {
    const lower = name.toLowerCase();
    if (lower === 'referer' || lower === 'referrer') delete headers.Referer;
    else if (lower === 'user-agent') delete headers['User-Agent'];
    if (declared[name]) headers[name] = declared[name];
  }
  return headers;
}

function streamIdentity(ch: Channel, url: string): string {
  const headers = channelHttpHeaders(ch);
  const fields = Object.keys(headers)
    .map(name => `header:${name.toLowerCase()}:${headers[name]}`);
  const extras = ch.extras ?? {};
  for (const name of DRM_OPTION_KEYS) {
    if (extras[name]) fields.push(`option:${name}:${extras[name]}`);
  }
  return fields.length ? `${url}\n${fields.sort().join('\n')}` : url;
}

/** What plays: the location plus its effective headers and DRM options.
 *  Unlike channelKey, two entries for one URL that play differently are
 *  different streams; an option playback ignores (caching, reconnect) is not.
 *  Volatile query params are dropped, so a rotated token keeps the identity;
 *  the pipe suffix is kept whole, so its headers still tell entries apart. */
export function channelStreamIdentity(ch: Channel): string {
  // Built from the parsed fields: the location's own query may hold a '|'.
  const url = stableStreamUrl(ch.url || '');
  return streamIdentity(ch, ch.urlSuffix ? `${url}|${ch.urlSuffix}` : url);
}

/** channelStreamIdentity with the location exactly as written, tokens
 *  included: playlist merging keeps entries that differ only by a token. */
export function channelExactStreamIdentity(ch: Channel): string {
  return streamIdentity(ch, channelIdentityUrl(ch));
}

/** A short hash of channelStreamIdentity, safe to persist: it carries no
 *  header or license value. */
export function channelStreamKey(ch: Channel): string {
  return fnv1a(channelStreamIdentity(ch));
}

/** A short hash of channelExactStreamIdentity: tells apart copies that
 *  differ only by a token, such as one channel on two accounts. */
export function channelExactStreamKey(ch: Channel): string {
  return fnv1a(channelExactStreamIdentity(ch));
}
