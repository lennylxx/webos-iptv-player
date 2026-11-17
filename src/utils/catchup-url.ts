// Builds M3U catch-up playback URLs from a channel's catch-up type, its
// `catchup-source` template, and the program's times. Written from the
// documented behavior of the M3U catch-up attributes; Xtream timeshift URLs
// are built separately in xtream-url.ts.

import type { Channel } from '../types';

export type CatchupMode =
  | 'default'
  | 'append'
  | 'shift'
  | 'archive'
  | 'timeshift'
  | 'flussonic-hls'
  | 'flussonic-dash'
  | 'flussonic-ts'
  | 'vod';

export interface CatchupPlan {
  mode: CatchupMode;
  /** The URL or template the mode's rule starts from. */
  base: string;
  /** The declared type was not recognized and the source is used as a template. */
  unknownType: boolean;
  /** The archive URL ends with the program. An unbounded one plays on into
   *  live, so its start must carry any resume or seek offset. */
  bounded: boolean;
}

export interface CatchupRequest {
  liveUrl: string;
  type: string;
  source: string;
  /** Program start and end, Unix seconds. */
  start: number;
  end: number;
  /** Current time, Unix seconds. */
  now: number;
  catchupId?: string;
  /** The value for `{channel-id}`, already URL-encoded. */
  channelId?: string;
  /** Hours added to every time the URL carries. */
  correctionHours?: number;
}

interface CatchupTimes {
  start: number;
  end: number;
  now: number;
  catchupId: string;
  channelId: string;
}

const RULE_TYPES: Record<string, CatchupMode | 'flussonic'> = {
  shift: 'shift',
  archive: 'archive',
  timeshift: 'timeshift',
  flussonic: 'flussonic',
  'flussonic-hls': 'flussonic-hls',
  'flussonic-dash': 'flussonic-dash',
  'flussonic-ts': 'flussonic-ts',
  fs: 'flussonic-ts',
};

function plan(mode: CatchupMode, base: string, unknownType = false): CatchupPlan {
  return { mode, base, unknownType, bounded: isBounded(mode) };
}

function isBounded(mode: CatchupMode): boolean {
  switch (mode) {
    case 'shift':
    case 'archive':
    case 'timeshift':
      return false;
    default:
      return true;
  }
}

/** How a catch-up URL is built for this type and source, or null when the
 *  channel declares no catch-up this app can build. Xtream is not covered. */
export function catchupPlan(type: string | undefined, source: string | undefined, liveUrl: string): CatchupPlan | null {
  const resolved = resolvePlan(type, source, liveUrl);
  if (resolved && (resolved.mode === 'default' || resolved.mode === 'append' || resolved.mode === 'vod')) {
    resolved.bounded = templateBounded(planTemplate(resolved, liveUrl));
  }
  return resolved;
}

const START_VARIABLES: Record<string, true> = {
  utc: true, start: true, start_iso: true, offset: true,
};
const END_VARIABLES: Record<string, true> = {
  utcend: true, end: true, end_iso: true, duration: true, durmin: true,
};

// A template that names the program's start but not its end or length asks
// the server for everything from the start on, which runs into live.
function templateBounded(template: string): boolean {
  if (/\{\{shift:end:/i.test(template)) return true;
  let start = false;
  let end = false;
  template.replace(VARIABLE, (match, rawName: string) => {
    if (rawName.length === 1) {
      if (DATE_LETTERS.indexOf(rawName) >= 0) start = true;
      return match;
    }
    const name = rawName.toLowerCase();
    if (END_VARIABLES[name] || /^end-/.test(name)) end = true;
    else if (START_VARIABLES[name] || /^start-/.test(name)) start = true;
    return match;
  });
  return end || !start;
}

function resolvePlan(type: string | undefined, source: string | undefined, liveUrl: string): CatchupPlan | null {
  const kind = (type || '').trim().toLowerCase();
  const src = (source || '').trim();
  // A source that is not a URL or path is ignored, except where it is a suffix
  // (append) or a bare `{catchup-id}` (vod).
  const usableSource = src.indexOf('/') >= 0 ? src : '';

  if (kind === 'append') return src ? plan('append', src) : null;
  if (kind === 'vod') return plan('vod', src || '{catchup-id}');
  if (kind === 'default') {
    return usableSource ? plan('default', usableSource) : plan('shift', liveUrl);
  }
  const rule = RULE_TYPES[kind];
  if (rule) {
    // A source with variables is already a full template; a plain one replaces
    // the stream URL that the type's rule rewrites.
    if (usableSource && usableSource.indexOf('{') >= 0) return plan('default', usableSource);
    const base = usableSource || liveUrl;
    if (rule === 'flussonic' || rule.indexOf('flussonic-') === 0) {
      // Only a Flussonic playback file names the stream directory to archive.
      const shaped = flussonicMode(base);
      if (!shaped) return null;
      return plan(rule === 'flussonic' ? shaped : rule, base);
    }
    return plan(rule, base);
  }
  if (!src) return null;
  return plan('default', src, kind !== '' && kind !== 'xc' && kind !== 'xtream');
}

type CatchupChannel = { catchup?: string; catchupSource?: string; url: string };

interface ChannelCatchup {
  kind: string;
  source: string;
  url: string;
  playable: boolean;
  needsId: boolean;
}

// The guide asks once per visible program row; the answers are per channel.
const channelMemo = new WeakMap<object, ChannelCatchup>();

function channelCatchup(channel: CatchupChannel): ChannelCatchup {
  const kind = channel.catchup || '';
  const source = channel.catchupSource || '';
  const memo = channelMemo.get(channel);
  if (memo && memo.kind === kind && memo.source === source && memo.url === channel.url) return memo;
  let playable: boolean;
  let needsId = false;
  if (kind.toLowerCase() === 'xtream') {
    playable = !!source;
  } else {
    const resolved = catchupPlan(kind, source, channel.url);
    playable = resolved !== null;
    needsId = !!resolved && CATCHUP_ID.test(planTemplate(resolved, channel.url));
  }
  const result = { kind, source, url: channel.url, playable, needsId };
  channelMemo.set(channel, result);
  return result;
}

/** Whether a channel can play past programs: its catch-up URL can be built.
 *  A program still needs its own `catchup-id` when the URL uses one; see
 *  catchupNeedsId. */
export function hasCatchup(channel: CatchupChannel): boolean {
  return channelCatchup(channel).playable;
}

/** Catch-up only archive days implied, or the #EXTM3U header gave: an
 *  Xtream account's archive for the stream decides it instead. */
export function catchupYieldsToArchive(channel: Channel): boolean {
  return !!channel.catchupDerived || !!channel.catchupInherited;
}

/** Drops catch-up that yields to the archive, once an Xtream catalog says the
 *  stream has none. */
export function clearDerivedCatchup(channel: Channel): void {
  if (!catchupYieldsToArchive(channel)) return;
  channel.catchup = '';
  channel.catchupSource = '';
  channel.catchupDays = 0;
  delete channel.catchupDerived;
  delete channel.catchupInherited;
}

/** Clears catch-up a channel took from the #EXTM3U header once a channel
 *  with its own catch-up attribute showed the header applies to none. An
 *  Xtream account's own archive for the stream stays. */
export function revokeInheritedCatchup(channel: Channel): void {
  if (!channel.catchupInherited) return;
  delete channel.catchupInherited;
  if (channel.catchup === 'xtream') {
    if (channel.catchupAccountId) return;
    // Inferred from the header's `xc` with the stream URL.
    delete channel.catchupStreamId;
  }
  channel.catchup = '';
  channel.catchupSource = '';
  channel.catchupDays = 0;
  delete channel.catchupDerived;
}

const CATCHUP_ID = /\$?\{catchup-id\}/i;

/** catchupNeedsId without the per-channel memo, for one pass over a whole
 *  playlist: a channel that is neither `vod` nor names `catchup-id` in its
 *  source is ruled out before any URL work. */
export function catchupNeedsIdUncached(channel: CatchupChannel): boolean {
  const kind = channel.catchup || '';
  const source = channel.catchupSource || '';
  const vod = kind.length === 3 && kind.toLowerCase() === 'vod';
  if (!vod && !/catchup-id/i.test(source)) return false;
  if (kind.toLowerCase() === 'xtream') return false;
  const resolved = catchupPlan(kind, source, channel.url);
  return !!resolved && CATCHUP_ID.test(planTemplate(resolved, channel.url));
}

/** Whether the channel's catch-up URL is built from each program's XMLTV
 *  `catchup-id`, so a program without one cannot be played. */
export function catchupNeedsId(channel: CatchupChannel): boolean {
  return channelCatchup(channel).needsId;
}

/** The catch-up playback URL, or null when the request cannot build one. */
export function buildCatchupUrl(request: CatchupRequest): string | null {
  const resolved = catchupPlan(request.type, request.source, request.liveUrl);
  if (!resolved) return null;
  const template = planTemplate(resolved, request.liveUrl);
  if (!request.catchupId && CATCHUP_ID.test(template)) return null;
  const correction = Math.round((request.correctionHours || 0) * 3600);
  const url = expandCatchupTemplate(template, {
    start: request.start + correction,
    end: request.end + correction,
    now: request.now + correction,
    catchupId: request.catchupId || '',
    channelId: request.channelId || '',
  });
  // An id or template that is not a full URL would resolve against the app.
  return /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url : null;
}

/** Fills only the current-time variables some providers put in a live URL. */
export function expandLiveUrl(url: string, now: number): string {
  if (url.indexOf('{') < 0) return url;
  return url.replace(VARIABLE, (match, rawName: string, arg: string | undefined) => {
    const name = rawName.toLowerCase();
    if (!NOW_NAMES[name]) return match;
    return timeValue(match, name, arg, now) ?? match;
  });
}

function planTemplate(target: CatchupPlan, liveUrl: string): string {
  switch (target.mode) {
    case 'default':
    case 'vod':
      return target.base;
    case 'append':
      return appendSuffix(liveUrl, target.base);
    case 'shift':
      return addQuery(target.base, 'utc={utc}&lutc={lutc}');
    case 'archive':
      return addQuery(target.base, 'archive={utc}&archive_end={utcend}');
    case 'timeshift':
      return addQuery(target.base, 'timeshift={utc}&timenow={lutc}');
    case 'flussonic-hls':
      // Flussonic's fixed-window archive playlist: `<name>-<from>-<duration>.m3u8`.
      return replaceLastSegment(target.base, last => {
        const stem = /\.m3u8$/i.test(last) ? last.slice(0, -5) : '';
        return `${stem || 'index'}-{utc}-{duration}.m3u8`;
      });
    case 'flussonic-dash':
      return replaceLastSegment(target.base, () => 'archive-{utc}-{duration}.mpd');
    case 'flussonic-ts':
      // Flussonic's fixed-window MPEG-TS archive file.
      return replaceLastSegment(target.base, () => 'archive-{utc}-{duration}.ts');
  }
}

interface UrlParts {
  path: string;
  query: string;
  hash: string;
}

function splitUrl(url: string): UrlParts {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = rest.indexOf('?');
  return {
    path: queryAt >= 0 ? rest.slice(0, queryAt) : rest,
    query: queryAt >= 0 ? rest.slice(queryAt) : '',
    hash,
  };
}

function lastSegment(url: string): string {
  const path = splitUrl(url).path;
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

function flussonicMode(url: string): CatchupMode | null {
  const last = lastSegment(url);
  if (/.\.mpd$/.test(last)) return 'flussonic-dash';
  if (/.\.ts$/.test(last) || last === 'mpegts') return 'flussonic-ts';
  if (/.\.m3u8$/.test(last)) return 'flussonic-hls';
  return null;
}

function addQuery(url: string, params: string): string {
  const parts = splitUrl(url);
  let query = parts.query;
  if (!query) query = '?';
  else if (query !== '?' && !/&$/.test(query)) query += '&';
  return parts.path + query + params + parts.hash;
}

function appendSuffix(url: string, suffix: string): string {
  const first = suffix.charAt(0);
  if (first !== '?' && first !== '&') return url + suffix;
  const parts = splitUrl(url);
  const body = suffix.slice(1);
  const base = parts.path + parts.query;
  if (!parts.query) return base + '?' + body + parts.hash;
  if (parts.query === '?' || /&$/.test(parts.query)) return base + body + parts.hash;
  return base + '&' + body + parts.hash;
}

function replaceLastSegment(url: string, file: (last: string) => string): string {
  const parts = splitUrl(url);
  const scheme = parts.path.indexOf('://');
  const hostEnd = scheme >= 0 ? parts.path.indexOf('/', scheme + 3) : 0;
  if (hostEnd < 0) return `${parts.path}/${file('')}${parts.query}${parts.hash}`;
  const slash = parts.path.lastIndexOf('/');
  const dir = parts.path.slice(0, slash + 1);
  return dir + file(parts.path.slice(slash + 1)) + parts.query + parts.hash;
}

// `{name}`, `${name}`, and either with a `:argument`.
const VARIABLE = /\$?\{([A-Za-z_][\w-]*)(?::([^{}]*))?\}/g;
const URL_SHIFT = /\{\{shift:(start|end):([+-]?\d+[mhd]?)\}\}/gi;
const OFFSET_ARG = /^([+-]?)(\d+)([mhd]?)$/;
const DATE_LETTERS = 'YmdHMS';

const START_NAMES: Record<string, true> = { utc: true, start: true };
const END_NAMES: Record<string, true> = { utcend: true, end: true };
const NOW_NAMES: Record<string, true> = {
  lutc: true, now: true, timestamp: true, current_utc: true, now_iso: true,
};

function offsetSeconds(arg: string): number | null {
  const match = OFFSET_ARG.exec(arg);
  if (!match) return null;
  const unit = match[3] === 'm' ? 60 : match[3] === 'h' ? 3600 : match[3] === 'd' ? 86400 : 1;
  return (match[1] === '-' ? -1 : 1) * parseInt(match[2], 10) * unit;
}

function pad(value: number, size = 2): string {
  let text = String(value);
  while (text.length < size) text = '0' + text;
  return text;
}

function localPart(seconds: number, letter: string): string {
  const date = new Date(seconds * 1000);
  switch (letter) {
    case 'Y': return pad(date.getFullYear(), 4);
    case 'm': return pad(date.getMonth() + 1);
    case 'd': return pad(date.getDate());
    case 'H': return pad(date.getHours());
    case 'M': return pad(date.getMinutes());
    default: return pad(date.getSeconds());
  }
}

function formatLocal(seconds: number, format: string): string {
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format.charAt(i);
    out += DATE_LETTERS.indexOf(ch) >= 0 ? localPart(seconds, ch) : ch;
  }
  return out;
}

function isoUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// A time variable takes either a shift (`-5m`) or a date format (`YmdHM`).
function timeValue(match: string, name: string, arg: string | undefined, at: number): string | null {
  let time = at;
  let format: string | null = null;
  if (arg !== undefined) {
    const shift = offsetSeconds(arg);
    if (shift !== null) time += shift;
    else format = arg;
  }
  time = Math.floor(time);
  if (/_iso$/.test(name)) return format === null ? isoUtc(time) : null;
  if (format !== null) return format ? formatLocal(time, format) : match;
  return String(time);
}

const PART_LETTERS: Record<string, string> = {
  year: 'Y', mon: 'm', day: 'd', hour: 'H', min: 'M', sec: 'S',
};

// A zero or non-integer divider counts as 1.
function divided(value: number, arg: string | undefined): string {
  const divisor = arg !== undefined && /^\d+$/.test(arg) ? parseInt(arg, 10) : 1;
  return String(Math.floor(value / Math.max(1, divisor)));
}

/** Expands every catch-up variable in a template; unknown ones stay as written. */
export function expandCatchupTemplate(template: string, times: CatchupTimes): string {
  let start = times.start;
  let end = times.end;
  let shifted = false;
  let text = template.replace(URL_SHIFT, (_match, which: string, arg: string) => {
    if (shifted) return '';
    shifted = true;
    const shift = offsetSeconds(arg) || 0;
    if (which.toLowerCase() === 'start') start += shift;
    else end += shift;
    return '';
  });
  const now = times.now;
  const duration = Math.max(0, end - start);
  text = text.replace(VARIABLE, (match, rawName: string, arg: string | undefined) => {
    if (rawName.length === 1) {
      return arg === undefined && DATE_LETTERS.indexOf(rawName) >= 0 && match.charAt(0) === '{'
        ? localPart(start, rawName)
        : match;
    }
    const name = rawName.toLowerCase();
    let result: string | null = null;
    if (START_NAMES[name] || name === 'start_iso') result = timeValue(match, name, arg, start);
    else if (END_NAMES[name] || name === 'end_iso') result = timeValue(match, name, arg, end);
    else if (NOW_NAMES[name]) result = timeValue(match, name, arg, now);
    else if (name === 'duration') result = divided(duration, arg);
    else if (name === 'durmin') result = arg === undefined ? String(Math.floor(duration / 60)) : null;
    else if (name === 'offset') result = divided(Math.max(0, now - start), arg);
    else if (name === 'catchup-id') result = arg === undefined ? times.catchupId : null;
    else if (name === 'channel-id') result = arg === undefined ? times.channelId : null;
    else {
      const part = /^(start|end)-(year|mon|day|hour|min|sec)$/.exec(name);
      if (part) {
        const shift = arg === undefined ? 0 : offsetSeconds(arg);
        if (shift !== null) {
          result = localPart((part[1] === 'start' ? start : end) + shift, PART_LETTERS[part[2]]);
        }
      }
    }
    return result === null ? match : result;
  });
  return text;
}
