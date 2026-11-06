import type { Channel } from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import { t } from '../i18n';
import { DRM_OPTION_KEYS } from '../services/drm-config';

// Only the synthetic ungrouped bucket is localized — provider names are data.
export function groupDisplayLabel(group: string): string {
  return group === UNCATEGORIZED_GROUP ? t('channel.uncategorized') : group;
}

// FNV-1a (32-bit) — fast, dependency-free, non-cryptographic. Good enough for a
// stable short identity key; collisions are negligible at playlist scale.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

// TODO(cleanup, post-1.9.0): remove after the released query-stripped keys no
// longer need migration or compatibility lookup.
export function legacyChannelKey(ch: Channel): string {
  return fnv1a(channelIdentityUrl(ch).split('#')[0].split('?')[0]);
}

/** Stable per-stream identity used by all channel-scoped data. */
export function channelKey(ch: Channel): string {
  return fnv1a(stableStreamUrl(channelIdentityUrl(ch)));
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
