// Pure URL derivation for an Xtream Codes / XUI.one portal. A single set of
// credentials (base portal URL + username + password) yields the get.php
// playlist, xmltv.php EPG, and player_api.php JSON endpoints. Kept dependency-
// free and unit-tested so the stateful client/service layers just compose it.

export interface XtreamCredentials {
  /** Portal base, e.g. `http://host:8080`. Normalized lazily by each builder. */
  baseUrl: string;
  username: string;
  password: string;
}

/** `scheme://host[:port][/path]` with a default http scheme and no trailing slash. */
export function normalizeXtreamBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

function creds({ username, password }: XtreamCredentials): string {
  return `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
}

/** M3U playlist (live + VOD + series, flattened). `output=ts` keeps live on the
 *  native pipeline; everything downstream is the existing M3U path. */
export function xtreamPlaylistUrl(c: XtreamCredentials): string {
  return `${normalizeXtreamBaseUrl(c.baseUrl)}/get.php?${creds(c)}&type=m3u_plus&output=ts`;
}

/** XMLTV EPG feed. */
export function xtreamEpgUrl(c: XtreamCredentials): string {
  return `${normalizeXtreamBaseUrl(c.baseUrl)}/xmltv.php?${creds(c)}`;
}

/** player_api.php JSON endpoint. Base call (no action) returns account/server
 *  info; an action plus optional params drives the catalog calls. */
export function xtreamPlayerApi(
  c: XtreamCredentials,
  action?: string,
  params?: Record<string, string | number>,
): string {
  let url = `${normalizeXtreamBaseUrl(c.baseUrl)}/player_api.php?${creds(c)}`;
  if (action) url += `&action=${encodeURIComponent(action)}`;
  if (params) {
    for (const key in params) {
      url += `&${key}=${encodeURIComponent(params[key])}`;
    }
  }
  return url;
}

/** VOD (movie) stream URL: `{base}/movie/{user}/{pass}/{streamId}.{ext}`.
 *  Played by the native pipeline; container_extension comes from the catalog. */
export function xtreamVodUrl(c: XtreamCredentials, streamId: string, ext: string): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  return `${base}/movie/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${streamId}.${ext}`;
}

/** Series episode stream URL: `{base}/series/{user}/{pass}/{episodeId}.{ext}`. */
export function xtreamEpisodeUrl(c: XtreamCredentials, episodeId: string, ext: string): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  return `${base}/series/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${episodeId}.${ext}`;
}

/** Xtream archive URL template. Duration is in minutes; start is provider-local
 *  wall-clock time and is resolved when the EPG program is selected. */
export function xtreamCatchupSource(c: XtreamCredentials, streamId: string): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  return `${base}/timeshift/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/{duration}/{start}/${streamId}.ts`;
}

/** Legacy Xtream archive template used by panels without the path-form route. */
export function xtreamCatchupFallbackSource(c: XtreamCredentials, streamId: string): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  return `${base}/streaming/timeshift.php?username=${encodeURIComponent(c.username)}` +
    `&password=${encodeURIComponent(c.password)}&stream=${encodeURIComponent(streamId)}` +
    '&start={start}&duration={duration}&extension=ts';
}

/** Extract the stream id from standard Xtream live URL variants. */
export function xtreamLiveStreamId(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.includes('movie') || parts.includes('series') || parts.length < 3) return '';
    const match = parts[parts.length - 1].match(/^([^/.]+)(?:\.[^/]*)?$/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Format an absolute EPG timestamp for Xtream's YYYY-MM-DD:HH-MM path segment. */
export function formatXtreamCatchupStart(
  utcSeconds: number,
  timeZone = '',
  offsetMinutes?: number,
): string {
  const date = new Date(utcSeconds * 1000);
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(date);
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find(item => item.type === type)?.value || '';
      const hour = part('hour') === '24' ? '00' : part('hour');
      if (part('year') && part('month') && part('day') && hour && part('minute')) {
        return `${part('year')}-${part('month')}-${part('day')}:${hour}-${part('minute')}`;
      }
    } catch {
      // Fall through to the provider offset or UTC.
    }
  }

  const shifted = new Date(date.getTime() + (offsetMinutes ?? 0) * 60000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}:` +
    `${pad2(shifted.getUTCHours())}-${pad2(shifted.getUTCMinutes())}`;
}
