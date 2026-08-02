import type {
  Channel,
  ParsedPlaylist,
  PlaylistFormatDetection,
  PlaylistParseIssue,
} from '../types';

export interface M3UParseOptions {
  maxChannels?: number;
  maxIssues?: number;
}

const DEFAULT_MAX_ISSUES = 500;
const SAMPLE_CHARS = 64 * 1024;

export function parseM3U(
  input: string,
  sourceUrl = '',
  options: M3UParseOptions = {},
): ParsedPlaylist {
  const text = stripBom(input);
  const detection = detectPlaylistFormat(input);
  const headerAttributes: Record<string, string> = {};
  const channels: Channel[] = [];
  const groupSet = new Set<string>();
  const issues: PlaylistParseIssue[] = [];
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const maxChannels = options.maxChannels ?? 0;
  let current: Channel | null = null;
  let epgUrls: string[] = [];
  let maxConnections: number | undefined;
  let playlistName: string | undefined;
  let sawHeader = false;

  const addIssue = (
    level: PlaylistParseIssue['level'],
    code: string,
    message: string,
    line: number,
  ): void => {
    if (issues.length < maxIssues) issues.push({ level, code, message, line });
  };

  if (detection.format === 'hls-master' || detection.format === 'hls-media') {
    const metadata = readPlaylistMetadata(text);
    Object.assign(headerAttributes, metadata.attributes);
    epgUrls = collectEpgUrls(metadata.attributes);
    const maxConn = parseInt(metadata.attributes['max-conn'] || '', 10);
    if (maxConn > 0) maxConnections = maxConn;
    if (sourceUrl) {
      const channel = emptyChannel(nameFromUrl(sourceUrl));
      channel.url = sourceUrl;
      return result(
        [channel],
        ['Uncategorized'],
        epgUrls,
        headerAttributes,
        detection.format,
        issues,
        maxConnections,
        metadata.name,
      );
    }
    addIssue('error', 'hls-without-source', 'HLS input requires its source URL', 1);
    return result(
      [],
      [],
      epgUrls,
      headerAttributes,
      detection.format,
      issues,
      maxConnections,
      metadata.name,
    );
  }

  if (detection.format === 'xmltv' || detection.format === 'json'
      || detection.format === 'html') {
    addIssue(
      'error',
      'wrong-format',
      `Expected an M3U playlist but received ${detection.format}`,
      1,
    );
    return result([], [], [], headerAttributes, detection.format, issues);
  }

  let lineNo = 0;
  let position = 0;
  while (position < text.length) {
    const lineStart = position;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code === 10 || code === 13) break;
      position++;
    }
    const line = text.slice(lineStart, position).trim();
    if (position < text.length && text.charCodeAt(position) === 13
        && text.charCodeAt(position + 1) === 10) position += 2;
    else if (position < text.length) position++;
    lineNo++;
    if (!line) continue;

    const tagEnd = directiveEnd(line);
    const tag = tagEnd > 0 ? line.slice(0, tagEnd).toUpperCase() : '';
    const hasColon = tagEnd > 0 && line.charCodeAt(tagEnd) === 58;
    const body = tagEnd > 0 ? line.slice(tagEnd + (hasColon ? 1 : 0)) : '';

    switch (tag) {
      case '#EXTM3U': {
        sawHeader = true;
        const attrs = scanAttributes(body, 0).values;
        Object.assign(headerAttributes, attrs);
        epgUrls = collectEpgUrls(attrs);
        const maxConn = parseInt(attrs['max-conn'] || '', 10);
        if (maxConn > 0) maxConnections = maxConn;
        break;
      }
      case '#EXTINF':
        if (current) {
          addIssue(
            'warning',
            'orphan-extinf',
            `"${current.name}" has no stream URL; skipped`,
            lineNo - 1,
          );
        }
        current = parseExtInf(body);
        break;
      case '#EXTGRP':
        if (current) applyGroups(current, body.trim(), true);
        break;
      case '#EXTVLCOPT':
        if (current) addExtra(current, body, false);
        break;
      case '#KODIPROP':
        if (current) addExtra(current, body, true);
        break;
      case '#EXTHTTP':
        if (current) parseHttpHeaders(current, body, lineNo, addIssue);
        break;
      case '#PLAYLIST':
        playlistName = body.trim() || undefined;
        break;
      default:
        if (line.charCodeAt(0) === 35) break;
        if (!current && detection.format === 'unknown' && !isPlaylistLocation(line)) {
          addIssue(
            'warning',
            'unrecognized-line',
            'Ignored a line that is not a stream location',
            lineNo,
          );
          break;
        }
        if (!current) current = emptyChannel(nameFromUrl(line));
        current.url = line;
        if (current.group) groupSet.add(current.group);
        for (const group of current.sourceGroups ?? []) groupSet.add(group);
        channels.push(current);
        current = null;
        if (maxChannels > 0 && channels.length >= maxChannels) {
          addIssue(
            'warning',
            'channel-limit',
            `Stopped after ${String(maxChannels)} channels`,
            lineNo,
          );
          position = text.length;
        }
        break;
    }
  }

  if (current) {
    addIssue(
      'warning',
      'orphan-extinf',
      `"${current.name}" has no stream URL; skipped`,
      lineNo,
    );
  }
  if (!sawHeader) {
    addIssue('warning', 'missing-extm3u', 'Playlist has no #EXTM3U header', 1);
  }
  if (!channels.length) {
    addIssue('error', 'no-channels', 'No playable entries were found', 1);
  }

  return result(
    channels,
    Array.from(groupSet),
    epgUrls,
    headerAttributes,
    detection.format,
    issues,
    maxConnections,
    playlistName,
  );
}

export function parseM3UBytes(
  bytes: Uint8Array,
  sourceUrl = '',
  options: M3UParseOptions = {},
): ParsedPlaylist {
  return parseM3U(decodePlaylistBytes(bytes), sourceUrl, options);
}

export function decodePlaylistBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes, 2, true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes, 2, false);
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(bytes.subarray(offset));
}

export function detectPlaylistFormat(input: string): PlaylistFormatDetection {
  const hadBom = input.charCodeAt(0) === 0xfeff;
  const sample = stripBom(input).slice(0, SAMPLE_CHARS);
  const trimmed = sample.replace(/^\s+/, '');
  if (!trimmed) {
    return { format: 'unknown', confidence: 1, reason: 'empty document', hadBom };
  }
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE\s+tv\b[^>]*>\s*)?<tv\b/i.test(trimmed)) {
    return { format: 'xmltv', confidence: 0.95, reason: 'XMLTV markup', hadBom };
  }
  if (/^<(?:!DOCTYPE\s+html|html|head|body)\b/i.test(trimmed)) {
    return { format: 'html', confidence: 0.95, reason: 'HTML document', hadBom };
  }
  if (trimmed.charCodeAt(0) === 123 || trimmed.charCodeAt(0) === 91) {
    return { format: 'json', confidence: 0.8, reason: 'JSON document', hadBom };
  }
  if (/^#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF):/im.test(sample)) {
    return { format: 'hls-master', confidence: 0.98, reason: 'HLS variant tags', hadBom };
  }
  if (/^#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE):/im.test(sample)
      || /^#EXT-X-ENDLIST(?:\s|$)/im.test(sample)) {
    return { format: 'hls-media', confidence: 0.98, reason: 'HLS media tags', hadBom };
  }
  if (/^#EXTINF:/im.test(sample)) {
    return {
      format: 'extended-m3u',
      confidence: /\b(?:tvg-id|group-title|catchup)\s*=/i.test(sample) ? 0.97 : 0.6,
      reason: 'EXTINF entries',
      hadBom,
    };
  }
  if (/^#EXTM3U\b/im.test(sample)) {
    return { format: 'simple-m3u', confidence: 0.7, reason: 'M3U header', hadBom };
  }
  const lines = sample.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  const urlCount = lines.filter(line => /^[a-z][a-z0-9+.-]*:\/\//i.test(line)).length;
  if (lines.length && urlCount / lines.length >= 0.8) {
    return { format: 'simple-m3u', confidence: 0.75, reason: 'URL list', hadBom };
  }
  return { format: 'unknown', confidence: 0.2, reason: 'no recognized markers', hadBom };
}

function result(
  channels: Channel[],
  groups: string[],
  epgUrls: string[],
  headerAttributes: Record<string, string>,
  format: ParsedPlaylist['format'],
  issues: PlaylistParseIssue[],
  maxConnections?: number,
  name?: string,
): ParsedPlaylist {
  return {
    channels,
    groups,
    epgUrl: epgUrls[0] ?? '',
    epgUrls,
    headerAttributes,
    maxConnections,
    name,
    format,
    issues,
  };
}

function readPlaylistMetadata(text: string): {
  attributes: Record<string, string>;
  name?: string;
} {
  const attributes: Record<string, string> = {};
  let name: string | undefined;
  let position = 0;
  while (position < text.length) {
    const start = position;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code === 10 || code === 13) break;
      position++;
    }
    const line = text.slice(start, position).trim();
    if (position < text.length && text.charCodeAt(position) === 13
        && text.charCodeAt(position + 1) === 10) position += 2;
    else if (position < text.length) position++;
    const tagEnd = directiveEnd(line);
    if (tagEnd <= 0) continue;
    const tag = line.slice(0, tagEnd).toUpperCase();
    const body = line.charCodeAt(tagEnd) === 58
      ? line.slice(tagEnd + 1)
      : line.slice(tagEnd);
    if (tag === '#EXTM3U') Object.assign(attributes, scanAttributes(body, 0).values);
    else if (tag === '#PLAYLIST') name = body.trim() || undefined;
  }
  return { attributes, name };
}

function parseExtInf(body: string): Channel {
  let index = 0;
  while (index < body.length && isWhitespace(body.charCodeAt(index))) index++;
  if (body.charCodeAt(index) === 43 || body.charCodeAt(index) === 45) index++;
  while (index < body.length) {
    const code = body.charCodeAt(index);
    if ((code >= 48 && code <= 57) || code === 46) index++;
    else break;
  }
  const scanned = scanAttributes(body, index);
  const attrs = scanned.values;
  const displayName = scanned.titleIndex >= 0
    ? body.slice(scanned.titleIndex + 1).trim()
    : '';
  const channel = emptyChannel(
    attrs['tvg-name'] || displayName || attrs['tvg-id'] || 'Unknown',
  );
  channel.id = attrs['tvg-id'] || '';
  channel.logo = attrs['tvg-logo'] || attrs.logo || '';
  channel.catchup = attrs.catchup || attrs['catchup-type'] || '';
  channel.catchupSource = attrs['catchup-source'] || '';
  channel.catchupDays = parseInt(
    attrs['catchup-days'] || attrs['tvg-rec'] || '0',
    10,
  ) || 0;
  applyGroups(channel, attrs['group-title'] || 'Uncategorized', false);

  const channelNumberRaw = attrs['tvg-chno']
    || attrs['channel-number']
    || attrs['tvg-num'];
  if (channelNumberRaw) {
    const channelNumber = parseInt(channelNumberRaw, 10);
    if (Number.isFinite(channelNumber)) channel.channelNumber = channelNumber;
  }
  const tvgShiftRaw = attrs['tvg-shift'] || attrs.timeshift;
  if (tvgShiftRaw) {
    const tvgShift = parseFloat(tvgShiftRaw);
    if (Number.isFinite(tvgShift)) channel.tvgShift = tvgShift;
  }
  if (attrs.radio === 'true' || attrs.radio === '1') channel.radio = true;
  preserveUnknownAttributes(channel, attrs);
  return channel;
}

interface ScannedAttributes {
  values: Record<string, string>;
  titleIndex: number;
}

function scanAttributes(input: string, start: number): ScannedAttributes {
  const values: Record<string, string> = {};
  let index = start;
  while (index < input.length) {
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    if (input.charCodeAt(index) === 44) return { values, titleIndex: index };

    const keyStart = index;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (isWhitespace(code) || code === 61 || code === 44) break;
      index++;
    }
    const keyEnd = index;
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    if (input.charCodeAt(index) !== 61) continue;

    index++;
    while (index < input.length && isWhitespace(input.charCodeAt(index))) index++;
    const quote = input.charCodeAt(index);
    let valueStart: number;
    let valueEnd: number;
    if (quote === 34 || quote === 39) {
      valueStart = ++index;
      while (index < input.length && input.charCodeAt(index) !== quote) index++;
      valueEnd = index;
      if (index < input.length) index++;
    } else {
      valueStart = index;
      while (index < input.length) {
        const code = input.charCodeAt(index);
        if (isWhitespace(code) || code === 44) break;
        index++;
      }
      valueEnd = index;
    }
    if (keyEnd > keyStart) {
      values[input.slice(keyStart, keyEnd).toLowerCase()] =
        input.slice(valueStart, valueEnd);
    }
  }
  return { values, titleIndex: -1 };
}

function emptyChannel(name: string): Channel {
  return {
    id: '',
    name,
    logo: '',
    group: 'Uncategorized',
    url: '',
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
  };
}

function applyGroups(channel: Channel, raw: string, override: boolean): void {
  const value = raw.trim();
  if (!value) return;
  if (value.indexOf(';') < 0) {
    if (override) channel.sourceGroups = undefined;
    if (override || channel.group === 'Uncategorized') channel.group = value;
    return;
  }

  const groups = value.split(';').map(group => group.trim()).filter(Boolean);
  if (!groups.length) return;
  const existing = override
    ? []
    : channel.sourceGroups ?? (channel.group === 'Uncategorized' ? [] : [channel.group]);
  for (const group of groups) {
    if (!existing.includes(group)) existing.push(group);
  }
  channel.sourceGroups = existing;
  if (override || channel.group === 'Uncategorized') channel.group = groups[0];
}

function preserveUnknownAttributes(
  channel: Channel,
  attributes: Record<string, string>,
): void {
  let unknown: Record<string, string> | undefined;
  for (const key in attributes) {
    if (isKnownAttribute(key)) continue;
    if (!unknown) unknown = {};
    unknown[key] = attributes[key];
  }
  if (unknown) channel.sourceAttributes = unknown;
}

function isKnownAttribute(key: string): boolean {
  switch (key) {
    case 'tvg-id':
    case 'tvg-name':
    case 'tvg-logo':
    case 'logo':
    case 'group-title':
    case 'catchup':
    case 'catchup-type':
    case 'catchup-source':
    case 'catchup-days':
    case 'tvg-rec':
    case 'tvg-chno':
    case 'channel-number':
    case 'tvg-num':
    case 'tvg-shift':
    case 'timeshift':
    case 'radio':
      return true;
    default:
      return false;
  }
}

function addExtra(channel: Channel, body: string, kodi: boolean): void {
  const equals = body.indexOf('=');
  if (equals <= 0) return;
  if (!channel.extras) channel.extras = {};
  const key = body.slice(0, equals).trim().toLowerCase();
  channel.extras[key] = body.slice(equals + 1).trim();
  if (kodi) {
    if (!channel.sourceAttributes) channel.sourceAttributes = {};
    channel.sourceAttributes[`kodiprop:${key}`] = body.slice(equals + 1).trim();
  }
}

function parseHttpHeaders(
  channel: Channel,
  body: string,
  line: number,
  addIssue: (
    level: PlaylistParseIssue['level'],
    code: string,
    message: string,
    line: number,
  ) => void,
): void {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const headers: Record<string, string> = {};
    for (const key of Object.keys(value)) {
      const header = (value as Record<string, unknown>)[key];
      if (typeof header === 'string') headers[key] = header;
    }
    channel.httpHeaders = headers;
    if (!channel.extras) channel.extras = {};
    const userAgent = headerValue(headers, 'user-agent');
    const referrer = headerValue(headers, 'referer') || headerValue(headers, 'referrer');
    if (userAgent) channel.extras['http-user-agent'] = userAgent;
    if (referrer) channel.extras['http-referrer'] = referrer;
  } catch {
    addIssue('warning', 'bad-exthttp', 'EXTHTTP payload is not valid JSON', line);
  }
}

function headerValue(headers: Record<string, string>, wanted: string): string {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return '';
}

function collectEpgUrls(attributes: Record<string, string>): string[] {
  const urls: string[] = [];
  for (const key of ['url-tvg', 'x-tvg-url', 'tvg-url']) {
    for (const part of (attributes[key] || '').split(',')) {
      const url = part.trim();
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

function directiveEnd(line: string): number {
  if (line.charCodeAt(0) !== 35) return -1;
  let index = 1;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    const valid = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 45;
    if (!valid) break;
    index++;
  }
  return index;
}

function nameFromUrl(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const base = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(base.replace(/\.[^./]+$/, '')) || hostname || 'Stream';
  } catch {
    return 'Stream';
  }
}

function isPlaylistLocation(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeUtf16(bytes: Uint8Array, offset: number, littleEndian: boolean): string {
  const chunks: string[] = [];
  const units: number[] = [];
  for (let index = offset; index + 1 < bytes.length; index += 2) {
    units.push(littleEndian
      ? bytes[index] | bytes[index + 1] << 8
      : bytes[index] << 8 | bytes[index + 1]);
    if (units.length === 4096) {
      chunks.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  if (units.length) chunks.push(String.fromCharCode(...units));
  return chunks.join('');
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9;
}
