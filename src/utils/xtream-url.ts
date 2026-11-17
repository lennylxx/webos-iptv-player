// Pure URL derivation for an Xtream Codes / XUI.one portal. A single set of
// credentials (base portal URL + username + password) yields the get.php
// playlist, xmltv.php EPG, and player_api.php JSON endpoints. Kept dependency-
// free and unit-tested so the stateful client/service layers just compose it.

import type { XtreamCatchupSource } from '../types';

export interface XtreamCredentials {
  /** Portal base, e.g. `http://host:8080`. Normalized lazily by each builder. */
  baseUrl: string;
  username: string;
  password: string;
}

export type XtreamLiveOutput = 'ts' | 'm3u8';
export type XtreamLiveOutputPreference = XtreamLiveOutput | 'auto';

export interface XtreamLiveUrlParts {
  credentials: XtreamCredentials;
  streamId: string;
  output: XtreamLiveOutput;
}

export function normalizeXtreamLiveOutputPreference(
  value: unknown,
): XtreamLiveOutputPreference {
  return value === 'auto' || value === 'm3u8' || value === 'ts' ? value : 'ts';
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

/** Resolve an account preference without changing legacy behavior when the
 *  provider does not advertise HLS or its capabilities cannot be checked. */
export function resolveXtreamLiveOutput(
  preference: XtreamLiveOutputPreference | undefined,
  allowedOutputFormats: string[],
): XtreamLiveOutput {
  const normalized = normalizeXtreamLiveOutputPreference(preference);
  if (normalized === 'm3u8' || normalized === 'ts') return normalized;
  return allowedOutputFormats.includes('m3u8') ? 'm3u8' : 'ts';
}

/** M3U playlist (live + VOD + series, flattened). The output controls the live
 *  container while everything downstream remains on the existing M3U path. */
export function xtreamPlaylistUrl(
  c: XtreamCredentials,
  output: XtreamLiveOutput = 'ts',
): string {
  return `${normalizeXtreamBaseUrl(c.baseUrl)}/get.php?${creds(c)}&type=m3u_plus&output=${output}`;
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

/** Live stream URL built from a Player API stream id. */
export function xtreamLiveUrl(c: XtreamCredentials, streamId: string, output: XtreamLiveOutput): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  return `${base}/live/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${encodeURIComponent(streamId)}.${output}`;
}

/** Recover an Xtream account only from unambiguous standard live URL shapes;
 *  `livePath` accepts only `/live/<user>/<pass>/<id>`, not the bare form. */
export function xtreamCredentialsFromLiveUrl(
  url: string,
  baseUrl = '',
  livePath = false,
): XtreamLiveUrlParts | null {
  if (!baseUrl) {
    const simple = simpleLiveUrlParts(url, livePath);
    if (simple !== undefined) return simple;
  }
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname;
    let credentialBase = parsed.origin;
    if (baseUrl) {
      const base = new URL(normalizeXtreamBaseUrl(baseUrl));
      if (parsed.origin !== base.origin) return null;
      const basePath = base.pathname.replace(/\/+$/, '');
      if (basePath && pathname !== basePath
          && !pathname.startsWith(basePath + '/')) return null;
      pathname = pathname.slice(basePath.length);
      credentialBase = `${base.origin}${basePath}`;
    }
    const parts = pathname.split('/').filter(Boolean);
    const prefixed = parts[0]?.toLowerCase() === 'live';
    if ((prefixed && parts.length !== 4) || (!prefixed && parts.length !== 3)) return null;
    if (livePath && !prefixed) return null;
    const usernameIndex = prefixed ? 1 : 0;
    const streamPart = parts[usernameIndex + 2];
    const match = streamPart.match(/^([^/.]+)(?:\.(ts|m3u8))?$/i);
    if (!match || (!prefixed && match[2])) return null;
    if (livePath && !NUMERIC_STREAM_ID.test(match[1])) return null;
    return {
      credentials: {
        baseUrl: credentialBase,
        username: decodeURIComponent(parts[usernameIndex]),
        password: decodeURIComponent(parts[usernameIndex + 1]),
      },
      streamId: decodeURIComponent(match[1]),
      output: match[2]?.toLowerCase() === 'm3u8' ? 'm3u8' : 'ts',
    };
  } catch {
    return null;
  }
}

// A plain http(s) URL, which the URL parser leaves as is past the host: no
// escapes, query, fragment, backslash, or whitespace.
const SIMPLE_HTTP_URL = /^(https?):\/\/([A-Za-z0-9._~!$&'()*+,;=:@-]+)(\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/i;
const STREAM_PART = /^([^/.]+)(?:\.(ts|m3u8))?$/i;
// Xtream stream ids are integers; a playlist that only implies catch-up needs
// one before a /live/ URL counts as Xtream-shaped.
const NUMERIC_STREAM_ID = /^\d+$/;
const ORIGINS = new Map<string, string>();
const MAX_ORIGINS = 64;

// The same answer as the URL-parsing path, for the common plain URL, without
// parsing one per channel: undefined leaves the URL to that path.
function simpleLiveUrlParts(url: string, livePath: boolean): XtreamLiveUrlParts | null | undefined {
  const match = SIMPLE_HTTP_URL.exec(url);
  if (!match) return undefined;
  const parts = (match[3] ?? '').split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') return undefined;
  }
  const prefixed = parts[0]?.toLowerCase() === 'live';
  if ((prefixed && parts.length !== 4) || (!prefixed && parts.length !== 3)) return null;
  if (livePath && !prefixed) return null;
  const usernameIndex = prefixed ? 1 : 0;
  const stream = STREAM_PART.exec(parts[usernameIndex + 2]);
  if (!stream || (!prefixed && stream[2])) return null;
  if (livePath && !NUMERIC_STREAM_ID.test(stream[1])) return null;
  const origin = simpleOrigin(match);
  if (origin === undefined) return undefined;
  return {
    credentials: {
      baseUrl: origin,
      username: parts[usernameIndex],
      password: parts[usernameIndex + 1],
    },
    streamId: stream[1],
    output: stream[2]?.toLowerCase() === 'm3u8' ? 'm3u8' : 'ts',
  };
}

function simpleOrigin(match: RegExpExecArray): string | undefined {
  const authority = `${match[1]}://${match[2]}`;
  let origin = ORIGINS.get(authority);
  if (origin === undefined) {
    try {
      origin = new URL(`${authority}/`).origin;
    } catch {
      return undefined;
    }
    if (ORIGINS.size < MAX_ORIGINS) ORIGINS.set(authority, origin);
  }
  return origin;
}

const DOT_SEGMENT = /\/\.\.?(?:\/|$)/;

/** The pathname the URL parser gives a plain http(s) URL, without parsing
 *  one; undefined leaves the URL to the parser. */
export function simpleUrlPathname(url: string): string | undefined {
  const match = SIMPLE_HTTP_URL.exec(url);
  if (!match) return undefined;
  const path = match[3] || '/';
  if (DOT_SEGMENT.test(path) || simpleOrigin(match) === undefined) return undefined;
  return path;
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
export function xtreamCatchupSource(
  c: XtreamCredentials,
  streamId: string,
  output: XtreamLiveOutput = 'ts',
): string {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  const username = encodeURIComponent(c.username);
  const password = encodeURIComponent(c.password);
  const id = encodeURIComponent(streamId);
  return `${base}/timeshift/${username}/${password}/{duration}/{start}/${id}.${output}`;
}

/** Ordered timeshift variants used by incompatible Xtream panel families. */
export function xtreamCatchupSources(
  c: XtreamCredentials,
  streamId: string,
  preferred: XtreamLiveOutput = 'ts',
): XtreamCatchupSource[] {
  const base = normalizeXtreamBaseUrl(c.baseUrl);
  const username = encodeURIComponent(c.username);
  const password = encodeURIComponent(c.password);
  const id = encodeURIComponent(streamId);
  const first = preferred === 'm3u8'
    ? { extension: 'm3u8', kind: 'hls' as const }
    : { extension: 'ts', kind: 'ts' as const };
  const last = preferred === 'm3u8'
    ? { extension: 'ts', kind: 'ts' as const }
    : { extension: 'm3u8', kind: 'hls' as const };
  const path = `${base}/timeshift/${username}/${password}/{duration}/{start}/${id}`;
  const legacy = `${base}/streaming/timeshift.php?username=${username}&password=${password}` +
    `&stream=${id}&start={start}&duration={duration}`;
  return [
    { kind: `path-${first.kind}`, url: `${path}.${first.extension}` },
    { kind: 'path-bare', url: path },
    { kind: `path-${last.kind}`, url: `${path}.${last.extension}` },
    { kind: `legacy-${first.kind}`, url: `${legacy}&extension=${first.extension}` },
    { kind: 'legacy-bare', url: legacy },
    { kind: `legacy-${last.kind}`, url: `${legacy}&extension=${last.extension}` },
  ];
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
