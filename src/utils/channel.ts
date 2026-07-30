import type { Channel } from '../types';

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

function stableStreamUrl(url: string): string {
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

/** Existing token-stable identity used by released persisted channel data. */
export function channelKey(ch: Channel): string {
  return fnv1a((ch.url || '').split('#')[0].split('?')[0]);
}

/** Query-aware identity for channel editing and precise autoplay restoration. */
export function channelStreamKey(ch: Channel): string {
  return fnv1a(stableStreamUrl(ch.url || ''));
}

export function channelCustomizationKey(ch: Channel): string {
  return channelStreamKey(ch);
}
