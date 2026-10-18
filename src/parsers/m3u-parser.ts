import type {
  Channel,
  ParsedPlaylist,
  PlaylistFormatDetection,
  PlaylistParseIssue,
} from '../types';
import { UNCATEGORIZED_GROUP } from '../types';
import {
  xtreamCatchupSource,
  xtreamCredentialsFromLiveUrl,
} from '../utils/xtream-url';
import { isMpdText } from '../utils/url';
import { catchupTemplate, normalizeCatchupMode } from '../utils/catchup-url';

export interface M3UParseOptions {
  maxChannels?: number;
  maxIssues?: number;
  streamLocationPrefilter?: (location: string) => boolean;
  channelPostfilter?: (channel: Channel) => boolean;
  channelBatchSize?: number;
  onChannelBatch?: (channels: Channel[]) => void;
}

type PendingDirectiveKind =
  | 'group'
  | 'vlc-option'
  | 'kodi-property'
  | 'http-headers';

/** Catch-up defaults an `#EXTM3U` header declares for every channel. */
interface HeaderCatchup {
  mode: string;
  source: string;
  days: number;
}

const NO_HEADER_CATCHUP: HeaderCatchup = { mode: '', source: '', days: 0 };

interface PendingChannelDirective {
  kind: PendingDirectiveKind;
  body: string;
  lineNo: number;
}

/* The first pending directive stays in parser fields so the common Xtream
 * entry shape does not allocate a per-record array or wrapper object. */
const DEFAULT_MAX_ISSUES = 500;
const SAMPLE_CHARS = 64 * 1024;
const STRING_DETACH_BATCH_SIZE = 512;

export function parseM3U(
  input: string,
  sourceUrl = '',
  options: M3UParseOptions = {},
): ParsedPlaylist {
  const parser = new M3UStreamParser(sourceUrl, options);
  parser.writeComplete(input);
  return parser.finish();
}

export class M3UStreamParser {
  private readonly headerAttributes: Record<string, string> = {};
  private headerCatchup: HeaderCatchup = NO_HEADER_CATCHUP;
  private readonly channels: Channel[] = [];
  private readonly groupSet = new Set<string>();
  private readonly groupPool = new Map<string, string>();
  private readonly pendingStringDetach: Channel[] = [];
  private readonly issues: PlaylistParseIssue[] = [];
  private readonly maxIssues: number;
  private readonly maxChannels: number;
  private readonly streamLocationPrefilter?: (location: string) => boolean;
  private readonly channelPostfilter?: (channel: Channel) => boolean;
  private readonly channelBatchSize: number;
  private readonly onChannelBatch?: (channels: Channel[]) => void;
  private readonly pendingLines: string[] = [];
  private lineBuffer = '';
  private sample = '';
  private detection: PlaylistFormatDetection | null = null;
  private current: Channel | null = null;
  private pendingExtInfBody: string | null = null;
  private pendingDirectiveKind: PendingDirectiveKind | null = null;
  private pendingDirectiveBody = '';
  private pendingDirectiveLineNo = 0;
  private additionalPendingDirectives: PendingChannelDirective[] | null = null;
  private epgUrls: string[] = [];
  private maxConnections: number | undefined;
  private playlistName: string | undefined;
  private lineNo = 0;
  private sawHeader = false;
  private stopped = false;
  private finished = false;
  private acceptedChannels = 0;

  constructor(
    private readonly sourceUrl = '',
    options: M3UParseOptions = {},
  ) {
    this.maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
    this.maxChannels = options.maxChannels ?? 0;
    this.streamLocationPrefilter = options.streamLocationPrefilter;
    this.channelPostfilter = options.channelPostfilter;
    this.channelBatchSize = options.channelBatchSize ?? 0;
    this.onChannelBatch = options.onChannelBatch;
  }

  write(chunk: string): void {
    if (this.finished) throw new Error('M3U parser is already finished');
    if (!chunk || this.stopped) return;
    if (!this.detection && this.sample.length < SAMPLE_CHARS) {
      this.sample += chunk.slice(0, SAMPLE_CHARS - this.sample.length);
    }
    this.lineBuffer += chunk;
    this.drainLines(false);
    if (!this.detection && this.sample.length >= SAMPLE_CHARS) this.activate();
  }

  writeComplete(input: string): void {
    if (this.finished) throw new Error('M3U parser is already finished');
    if (this.lineBuffer || this.pendingLines.length || this.detection) {
      throw new Error('M3U parser already contains streamed input');
    }
    this.sample = input.slice(0, SAMPLE_CHARS);
    this.detection = detectPlaylistFormat(this.sample);
    let position = 0;
    while (position < input.length && !this.stopped) {
      const lineStart = position;
      while (position < input.length) {
        const code = input.charCodeAt(position);
        if (code === 10 || code === 13) break;
        position++;
      }
      this.processLine(input.slice(lineStart, position));
      if (position < input.length && input.charCodeAt(position) === 13
          && input.charCodeAt(position + 1) === 10) {
        position += 2;
      } else if (position < input.length) {
        position++;
      }
    }
  }

  finish(): ParsedPlaylist {
    if (this.finished) throw new Error('M3U parser is already finished');
    this.finished = true;
    this.drainLines(true);
    if (!this.detection) this.activate();
    const detection = this.detection!;
    this.detachPlaylistMetadata();

    if (isWrappedStreamFormat(detection.format)) {
      if (this.sourceUrl) {
        const channel = emptyChannel(nameFromUrl(this.sourceUrl));
        channel.url = this.sourceUrl;
        return result(
          [channel],
          [UNCATEGORIZED_GROUP],
          this.epgUrls,
          this.headerAttributes,
          detection.format,
          this.issues,
          this.maxConnections,
          this.playlistName,
        );
      }
      const streamType = detection.format === 'dash' ? 'DASH' : 'HLS';
      this.addIssue(
        'error',
        `${detection.format === 'dash' ? 'dash' : 'hls'}-without-source`,
        `${streamType} input requires its source URL`,
        1,
      );
      return result(
        [],
        [],
        this.epgUrls,
        this.headerAttributes,
        detection.format,
        this.issues,
        this.maxConnections,
        this.playlistName,
      );
    }

    if (isWrongDocumentFormat(detection.format)) {
      this.addIssue(
        'error',
        'wrong-format',
        `Expected an M3U playlist but received ${detection.format}`,
        1,
      );
      return result([], [], [], this.headerAttributes, detection.format, this.issues);
    }

    if (this.current || this.pendingExtInfBody !== null) {
      this.addIssue(
        'warning',
        'orphan-extinf',
        `"${this.pendingChannelName()}" has no stream URL; skipped`,
        this.lineNo,
      );
    }
    if (!this.sawHeader) {
      this.addIssue('warning', 'missing-extm3u', 'Playlist has no #EXTM3U header', 1);
    }
    if (!this.acceptedChannels) {
      this.addIssue('error', 'no-channels', 'No playable entries were found', 1);
    }
    this.detachPendingChannelStrings();
    this.flushChannelBatch();

    return result(
      this.channels,
      Array.from(this.groupSet),
      this.epgUrls,
      this.headerAttributes,
      detection.format,
      this.issues,
      this.maxConnections,
      this.playlistName,
    );
  }

  private drainLines(final: boolean): void {
    let start = 0;
    let index = 0;
    while (index < this.lineBuffer.length) {
      const code = this.lineBuffer.charCodeAt(index);
      if (code === 10) {
        this.queueLine(this.lineBuffer.slice(start, index));
        start = ++index;
        continue;
      }
      if (code === 13) {
        if (index + 1 === this.lineBuffer.length && !final) break;
        this.queueLine(this.lineBuffer.slice(start, index));
        index += this.lineBuffer.charCodeAt(index + 1) === 10 ? 2 : 1;
        start = index;
        continue;
      }
      index++;
    }
    if (final && start < this.lineBuffer.length) {
      this.queueLine(this.lineBuffer.slice(start));
      start = this.lineBuffer.length;
    }
    this.lineBuffer = this.lineBuffer.slice(start);
  }

  private queueLine(rawLine: string): void {
    if (this.stopped) return;
    if (!this.detection) this.pendingLines.push(rawLine);
    else this.processLine(rawLine);
  }

  private activate(): void {
    this.detection = detectPlaylistFormat(this.sample);
    const pending = this.pendingLines.splice(0);
    for (const line of pending) this.processLine(line);
  }

  private processLine(rawLine: string): void {
    if (this.stopped) return;
    this.lineNo++;
    const line = (this.lineNo === 1 ? stripBom(rawLine) : rawLine).trim();
    if (!line) return;
    const detection = this.detection!;
    if (detection.format === 'dash' || isWrongDocumentFormat(detection.format)) return;

    const tagEnd = directiveEnd(line);
    const tag = tagEnd > 0 ? line.slice(0, tagEnd).toUpperCase() : '';
    const hasColon = tagEnd > 0 && line.charCodeAt(tagEnd) === 58;
    const body = tagEnd > 0 ? line.slice(tagEnd + (hasColon ? 1 : 0)) : '';

    if (isWrappedStreamFormat(detection.format)) {
      if (tag === '#EXTM3U') this.applyHeader(body);
      else if (tag === '#PLAYLIST') this.playlistName = body.trim() || undefined;
      return;
    }

    switch (tag) {
      case '#EXTM3U':
        this.sawHeader = true;
        this.applyHeader(body);
        break;
      case '#EXTINF':
        if (this.current || this.pendingExtInfBody !== null) {
          this.addIssue(
            'warning',
            'orphan-extinf',
            `"${this.pendingChannelName()}" has no stream URL; skipped`,
            this.lineNo - 1,
          );
        }
        if (this.streamLocationPrefilter) {
          this.current = null;
          if (this.pendingExtInfBody !== null) this.clearPendingChannel();
          this.pendingExtInfBody = body;
        } else {
          this.current = parseExtInf(body, this.headerCatchup);
        }
        break;
      case '#EXTGRP':
        if (this.pendingExtInfBody !== null) {
          this.queuePendingDirective('group', body);
        } else if (this.current) {
          applyGroups(this.current, body.trim(), true);
        }
        break;
      case '#EXTVLCOPT':
        if (this.pendingExtInfBody !== null) {
          this.queuePendingDirective('vlc-option', body);
        } else if (this.current) {
          addExtra(this.current, body, false);
        }
        break;
      case '#KODIPROP':
        if (this.pendingExtInfBody !== null) {
          this.queuePendingDirective('kodi-property', body);
        } else if (this.current) {
          addExtra(this.current, body, true);
        }
        break;
      case '#EXTHTTP':
        if (this.pendingExtInfBody !== null) {
          this.queuePendingDirective('http-headers', body, this.lineNo);
        } else if (this.current) {
          parseHttpHeaders(
            this.current,
            body,
            this.lineNo,
            (level, code, message, lineNo) =>
              this.addIssue(level, code, message, lineNo),
          );
        }
        break;
      case '#PLAYLIST':
        this.playlistName = body.trim() || undefined;
        break;
      default:
        this.processLocation(line, detection.format);
        break;
    }
  }

  private applyHeader(body: string): void {
    const attrs = scanAttributes(body, 0).values;
    Object.assign(this.headerAttributes, attrs);
    this.epgUrls = collectEpgUrls(this.headerAttributes);
    this.headerCatchup = headerCatchup(this.headerAttributes);
    const maxConn = parseInt(attrs['max-conn'] || '', 10);
    if (maxConn > 0) this.maxConnections = maxConn;
  }

  private processLocation(line: string, format: ParsedPlaylist['format']): void {
    if (line.charCodeAt(0) === 35) return;
    if (!this.current && format === 'unknown' && !isPlaylistLocation(line)) {
      this.addIssue(
        'warning',
        'unrecognized-line',
        'Ignored a line that is not a stream location',
        this.lineNo,
      );
      return;
    }
    if (
      this.streamLocationPrefilter
      && !this.streamLocationPrefilter(line)
    ) {
      this.current = null;
      this.clearPendingChannel();
      return;
    }
    if (this.pendingExtInfBody !== null) {
      this.current = this.materializePendingChannel();
    }
    if (!this.current) this.current = emptyChannel(nameFromUrl(line));
    this.current.url = line;
    if (this.current.catchup === 'xc' && !this.current.catchupSource) {
      const inferred = xtreamCredentialsFromLiveUrl(line);
      if (inferred) {
        this.current.catchupSource = xtreamCatchupSource(
          inferred.credentials,
          inferred.streamId,
          inferred.output,
        );
        this.current.catchup = 'xtream';
        this.current.catchupStreamId = inferred.streamId;
      }
    } else {
      this.current.catchupSource = catchupTemplate(
        this.current.catchup,
        line,
        this.current.catchupSource,
      );
    }
    const channel = this.current;
    this.current = null;
    if (this.channelPostfilter && !this.channelPostfilter(channel)) return;
    channel.group = this.internGroup(channel.group);
    if (channel.sourceGroups) {
      channel.sourceGroups = channel.sourceGroups.map(group => this.internGroup(group));
    }
    if (channel.group) this.groupSet.add(channel.group);
    for (const group of channel.sourceGroups ?? []) this.groupSet.add(group);
    this.channels.push(channel);
    this.pendingStringDetach.push(channel);
    if (this.pendingStringDetach.length >= STRING_DETACH_BATCH_SIZE) {
      this.detachPendingChannelStrings();
    }
    this.acceptedChannels++;
    if (this.onChannelBatch
        && this.channelBatchSize > 0
        && this.channels.length >= this.channelBatchSize) {
      this.flushChannelBatch();
    }
    if (this.maxChannels > 0 && this.acceptedChannels >= this.maxChannels) {
      this.addIssue(
        'warning',
        'channel-limit',
        `Stopped after ${String(this.maxChannels)} channels`,
        this.lineNo,
      );
      this.stopped = true;
    }
  }

  private pendingChannelName(): string {
    return this.current?.name
      ?? (this.pendingExtInfBody !== null
        ? parseExtInf(this.pendingExtInfBody).name
        : '');
  }

  private queuePendingDirective(
    kind: PendingDirectiveKind,
    body: string,
    lineNo = 0,
  ): void {
    if (this.pendingDirectiveKind === null) {
      this.pendingDirectiveKind = kind;
      this.pendingDirectiveBody = body;
      this.pendingDirectiveLineNo = lineNo;
      return;
    }
    if (!this.additionalPendingDirectives) this.additionalPendingDirectives = [];
    const directive: PendingChannelDirective = { kind, body, lineNo };
    this.additionalPendingDirectives.push(directive);
  }

  private materializePendingChannel(): Channel {
    const channel = parseExtInf(this.pendingExtInfBody!, this.headerCatchup);
    if (this.pendingDirectiveKind !== null) {
      this.applyPendingDirective(
        channel,
        this.pendingDirectiveKind,
        this.pendingDirectiveBody,
        this.pendingDirectiveLineNo,
      );
    }
    if (this.additionalPendingDirectives) {
      for (const directive of this.additionalPendingDirectives) {
        this.applyPendingDirective(channel, directive.kind, directive.body, directive.lineNo);
      }
    }
    this.clearPendingChannel();
    return channel;
  }

  private applyPendingDirective(
    channel: Channel,
    kind: PendingDirectiveKind,
    body: string,
    lineNo: number,
  ): void {
    if (kind === 'group') applyGroups(channel, body.trim(), true);
    else if (kind === 'vlc-option') addExtra(channel, body, false);
    else if (kind === 'kodi-property') addExtra(channel, body, true);
    else if (kind === 'http-headers') {
      parseHttpHeaders(
        channel,
        body,
        lineNo,
        (level, code, message, issueLineNo) =>
          this.addIssue(level, code, message, issueLineNo),
      );
    }
  }

  private clearPendingChannel(): void {
    this.pendingExtInfBody = null;
    this.pendingDirectiveKind = null;
    this.pendingDirectiveBody = '';
    this.pendingDirectiveLineNo = 0;
    this.additionalPendingDirectives = null;
  }

  private flushChannelBatch(): void {
    if (!this.onChannelBatch || !this.channels.length) return;
    this.detachPendingChannelStrings();
    const batch = this.channels.splice(0);
    this.onChannelBatch(batch);
  }

  private detachPendingChannelStrings(): void {
    if (!this.pendingStringDetach.length) return;
    detachChannelStrings(this.pendingStringDetach);
    this.pendingStringDetach.length = 0;
  }

  private addIssue(
    level: PlaylistParseIssue['level'],
    code: string,
    message: string,
    line: number,
  ): void {
    if (this.issues.length < this.maxIssues) {
      this.issues.push({ level, code, message, line });
    }
  }

  private internGroup(group: string): string {
    const existing = this.groupPool.get(group);
    if (existing) return existing;
    const detached = copyRetainedStrings([group])[0];
    this.groupPool.set(detached, detached);
    return detached;
  }

  private detachPlaylistMetadata(): void {
    const keys = Object.keys(this.headerAttributes);
    const values = copyRetainedStrings(keys.map(key => this.headerAttributes[key]));
    for (let index = 0; index < keys.length; index++) {
      this.headerAttributes[keys[index]] = values[index];
    }
    this.epgUrls = copyRetainedStrings(this.epgUrls);
    if (this.playlistName) {
      this.playlistName = copyRetainedStrings([this.playlistName])[0];
    }
  }
}

function isWrappedStreamFormat(format: ParsedPlaylist['format']): boolean {
  return format === 'dash' || format === 'hls-master' || format === 'hls-media';
}

function isWrongDocumentFormat(format: ParsedPlaylist['format']): boolean {
  return format === 'xmltv' || format === 'json' || format === 'html';
}

const CHANNEL_STRING_KEYS = [
  'id',
  'name',
  'logo',
  'url',
  'catchup',
  'catchupSource',
] as const;
const OPTIONAL_CHANNEL_STRING_KEYS = [
  'sourceName',
  'sourceGroup',
  'groupKey',
  'catchupAccountId',
  'catchupStreamId',
  'catchupTimeZone',
] as const;

function detachChannelStrings(channels: readonly Channel[]): void {
  const values: string[] = [];
  for (const channel of channels) {
    for (const key of CHANNEL_STRING_KEYS) {
      if (channel[key]) values.push(channel[key]);
    }
    for (const key of OPTIONAL_CHANNEL_STRING_KEYS) {
      if (channel[key]) values.push(channel[key]!);
    }
    if (channel.extras) {
      for (const key of Object.keys(channel.extras)) {
        const value = channel.extras[key];
        if (value) values.push(value);
      }
    }
    if (channel.sourceAttributes) {
      for (const key of Object.keys(channel.sourceAttributes)) {
        const value = channel.sourceAttributes[key];
        if (value) values.push(value);
      }
    }
    if (channel.httpHeaders) {
      for (const key of Object.keys(channel.httpHeaders)) {
        const value = channel.httpHeaders[key];
        if (value) values.push(value);
      }
    }
  }
  const copies = copyRetainedStrings(values);
  let index = 0;
  for (const channel of channels) {
    for (const key of CHANNEL_STRING_KEYS) {
      if (channel[key]) channel[key] = copies[index++];
    }
    for (const key of OPTIONAL_CHANNEL_STRING_KEYS) {
      if (channel[key]) channel[key] = copies[index++];
    }
    if (channel.extras) {
      for (const key of Object.keys(channel.extras)) {
        if (channel.extras[key]) channel.extras[key] = copies[index++];
      }
    }
    if (channel.sourceAttributes) {
      for (const key of Object.keys(channel.sourceAttributes)) {
        if (channel.sourceAttributes[key]) {
          channel.sourceAttributes[key] = copies[index++];
        }
      }
    }
    if (channel.httpHeaders) {
      for (const key of Object.keys(channel.httpHeaders)) {
        if (channel.httpHeaders[key]) channel.httpHeaders[key] = copies[index++];
      }
    }
  }
}

function copyRetainedStrings(values: readonly string[]): string[] {
  if (!values.length) return [];
  const joined = `\0${values.join('\0')}\0`;
  const copies = new Array<string>(values.length);
  let offset = 1;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    copies[index] = joined.slice(offset, offset + value.length);
    offset += value.length + 1;
  }
  return copies;
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
  if (isMpdText(trimmed)) {
    return { format: 'dash', confidence: 0.98, reason: 'DASH MPD markup', hadBom };
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

function headerCatchup(attrs: Record<string, string>): HeaderCatchup {
  const seconds = parseInt(attrs['catchup-time'] || '', 10) || 0;
  return {
    mode: normalizeCatchupMode(attrs.catchup || attrs['catchup-type'] || ''),
    source: attrs['catchup-source'] || '',
    days: parseInt(attrs['catchup-days'] || '', 10) || Math.ceil(Math.max(0, seconds) / 86400),
  };
}

function parseExtInf(body: string, header: HeaderCatchup = NO_HEADER_CATCHUP): Channel {
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
  applyCatchupAttributes(channel, attrs, header);
  applyGroups(channel, attrs['group-title'] || UNCATEGORIZED_GROUP, false);

  const channelNumberRaw = attrs['tvg-chno']
    || attrs['channel-number']
    || attrs['tvg-num'];
  if (channelNumberRaw) {
    const channelNumber = parseInt(channelNumberRaw, 10);
    if (Number.isFinite(channelNumber)) channel.channelNumber = channelNumber;
  }
  const tvgShiftRaw = attrs['tvg-shift'];
  if (tvgShiftRaw) {
    const tvgShift = parseFloat(tvgShiftRaw);
    if (Number.isFinite(tvgShift)) channel.tvgShift = tvgShift;
  }
  if (attrs.radio === 'true' || attrs.radio === '1') channel.radio = true;
  preserveUnknownAttributes(channel, attrs);
  return channel;
}

/* Mode, source and days follow Kodi's pvr.iptvsimple: the entry's own tags win
 * over the header's. SIPTV's `timeshift="<days>"` (or `tvg-rec`) predates the
 * catch-up tags and implies shift mode when nothing else names one. */
function applyCatchupAttributes(
  channel: Channel,
  attrs: Record<string, string>,
  header: HeaderCatchup,
): void {
  const ownMode = normalizeCatchupMode(attrs.catchup || attrs['catchup-type'] || '');
  const siptvDays = parseInt(attrs.timeshift || '', 10) || parseInt(attrs['tvg-rec'] || '', 10) || 0;
  channel.catchup = ownMode || header.mode || (siptvDays > 0 ? 'shift' : '');
  channel.catchupSource = attrs['catchup-source']
    || (channel.catchup === header.mode ? header.source : '');
  channel.catchupDays = parseInt(attrs['catchup-days'] || '', 10)
    || siptvDays
    || header.days;
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
    group: UNCATEGORIZED_GROUP,
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
    if (override || channel.group === UNCATEGORIZED_GROUP) channel.group = value;
    return;
  }

  const groups = value.split(';').map(group => group.trim()).filter(Boolean);
  if (!groups.length) return;
  const existing = override
    ? []
    : channel.sourceGroups ?? (channel.group === UNCATEGORIZED_GROUP ? [] : [channel.group]);
  for (const group of groups) {
    if (!existing.includes(group)) existing.push(group);
  }
  channel.sourceGroups = existing;
  if (override || channel.group === UNCATEGORIZED_GROUP) channel.group = groups[0];
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
