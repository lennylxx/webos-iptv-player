import type { ParsedEpg, Programme, EpgChannel } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('XMLTV');
const DAY_MS = 24 * 60 * 60 * 1000;
const BUFFER_COMPACT_THRESHOLD = 256 * 1024;
const TARGET_TAGS = new Set(['channel', 'programme']);
const MAX_RETAINED_DISPLAY_NAMES = 4;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface XMLTVParseOptions {
  nowMs?: number;
  /** Keep only these XMLTV channel ids (plus any matched by `channelNames`). */
  channelIds?: ReadonlySet<string>;
  /** Lowercased display names that also select a channel, for id-less playlists. */
  channelNames?: ReadonlySet<string>;
}

export interface XMLTVParseStats {
  channelsSeen: number;
  channelsKept: number;
  programmesSeen: number;
  /** Programmes admitted by the channel filter, before date/range checks. */
  programmesMatched: number;
  programmesKept: number;
  skippedDate: number;
  skippedRange: number;
  skippedFilter: number;
  malformed: number;
}

interface ElementRange {
  name: 'channel' | 'programme';
  tagStart: number;
  tagEnd: number;
  bodyStart: number;
  bodyEnd: number;
  elementEnd: number;
}

interface ParsedTimestamp {
  time: number;
  offsetMinutes: number | null;
}

interface ProgrammeAttributes {
  channelId: string | undefined;
  start: string | undefined;
  stop: string | undefined;
}

export class XMLTVStreamParser {
  readonly stats: XMLTVParseStats = {
    channelsSeen: 0,
    channelsKept: 0,
    programmesSeen: 0,
    programmesMatched: 0,
    programmesKept: 0,
    skippedDate: 0,
    skippedRange: 0,
    skippedFilter: 0,
    malformed: 0,
  };

  private buffer = '';
  private cursor = 0;
  private ended = false;
  private readonly channels: Record<string, EpgChannel> = {};
  private readonly programmes: Record<string, Programme[]> = {};
  private readonly lastStartByChannel = new Map<string, number>();
  private readonly unsortedChannels = new Set<string>();
  private readonly declaredIds = new Set<string>();
  private readonly programmesBeforeDeclaration = new Set<string>();
  /** Ids the filter accepts: the configured ids plus name-matched channels. */
  private readonly acceptedIds: Set<string> | null;
  private readonly minTime: number;
  private readonly maxTime: number;
  private tzOffsetMinutes: number | null = null;
  private sourceName: string | undefined;

  constructor(private readonly options: XMLTVParseOptions = {}) {
    const now = options.nowMs ?? Date.now();
    this.minTime = now - 7 * DAY_MS;
    this.maxTime = now + 7 * DAY_MS;
    const { channelIds, channelNames } = options;
    const filtering = (channelIds?.size ?? 0) > 0 || (channelNames?.size ?? 0) > 0;
    this.acceptedIds = filtering ? new Set(channelIds ?? []) : null;
  }

  write(chunk: string): void {
    if (this.ended) throw new Error('Cannot write XMLTV after finish');
    if (!chunk) return;
    this.buffer += chunk;
    this.drain(false);
  }

  finish(): ParsedEpg {
    if (this.ended) throw new Error('XMLTV parser already finished');
    this.ended = true;
    this.drain(true);
    this.sortUnorderedProgrammes();
    this.logStats();
    this.buffer = '';
    this.cursor = 0;
    return {
      channels: this.channels,
      programmes: this.programmes,
      sourceName: this.sourceName,
      tzOffsetMinutes: this.tzOffsetMinutes,
    };
  }

  needsOrderRetry(): boolean {
    if (!this.acceptedIds) return false;
    for (const id of this.programmesBeforeDeclaration) {
      if (this.acceptedIds.has(id)) return true;
    }
    return false;
  }

  acceptedChannelIds(): ReadonlySet<string> {
    return this.acceptedIds ?? new Set();
  }

  private drain(final: boolean): void {
    while (true) {
      const element = this.findNextElement(final);
      if (!element) break;
      if (element.name === 'channel') this.handleChannel(element);
      else this.handleProgramme(element);
      this.cursor = element.elementEnd;
      if (this.cursor >= BUFFER_COMPACT_THRESHOLD) this.compact();
    }
    if (this.cursor > 0 && (final || this.cursor >= BUFFER_COMPACT_THRESHOLD)) {
      this.compact();
    }
    if (final && this.buffer.trim()) this.stats.malformed++;
  }

  private findNextElement(final: boolean): ElementRange | null {
    while (true) {
      const tagStart = this.buffer.indexOf('<', this.cursor);
      if (tagStart === -1) {
        if (final) this.cursor = this.buffer.length;
        else this.cursor = Math.max(this.cursor, this.buffer.length - 10);
        return null;
      }

      if (this.buffer.startsWith('<!--', tagStart)) {
        const end = this.buffer.indexOf('-->', tagStart + 4);
        if (end === -1) return this.incomplete(final);
        this.cursor = end + 3;
        continue;
      }
      if (this.buffer.startsWith('<?', tagStart)) {
        const end = this.buffer.indexOf('?>', tagStart + 2);
        if (end === -1) return this.incomplete(final);
        this.cursor = end + 2;
        continue;
      }
      if (this.buffer.startsWith('<!', tagStart)) {
        const end = findDeclarationEnd(this.buffer, tagStart + 2);
        if (end === -1) return this.incomplete(final);
        this.cursor = end + 1;
        continue;
      }

      const tagEnd = findTagEnd(this.buffer, tagStart + 1);
      if (tagEnd === -1) return this.incomplete(final);
      const name = readTagName(this.buffer, tagStart + 1, tagEnd);
      if (!TARGET_TAGS.has(name)) {
        if (name === 'tv' && this.sourceName === undefined) {
          this.sourceName = readAttribute(
            this.buffer,
            'source-info-name',
            tagStart + 1,
            tagEnd + 1,
          )?.trim() || readAttribute(
            this.buffer,
            'generator-info-name',
            tagStart + 1,
            tagEnd + 1,
          )?.trim() || undefined;
        }
        this.cursor = tagEnd + 1;
        continue;
      }

      const target = name as 'channel' | 'programme';
      if (isSelfClosing(this.buffer, tagStart, tagEnd)) {
        return {
          name: target,
          tagStart,
          tagEnd,
          bodyStart: tagEnd,
          bodyEnd: tagEnd,
          elementEnd: tagEnd + 1,
        };
      }

      const closing = findClosingTag(this.buffer, target, tagEnd + 1);
      if (!closing) return this.incomplete(final);
      return {
        name: target,
        tagStart,
        tagEnd,
        bodyStart: tagEnd + 1,
        bodyEnd: closing.start,
        elementEnd: closing.end + 1,
      };
    }
  }

  private incomplete(final: boolean): null {
    if (final) {
      this.stats.malformed++;
      this.cursor = this.buffer.length;
    }
    return null;
  }

  private handleChannel(element: ElementRange): void {
    this.stats.channelsSeen++;
    const rawId = readAttribute(
      this.buffer,
      'id',
      element.tagStart + 1,
      element.tagEnd + 1,
    );
    if (!rawId) {
      this.stats.malformed++;
      return;
    }
    const id = copyString(rawId);
    this.declaredIds.add(id);
    const body = this.buffer.slice(element.bodyStart, element.bodyEnd);
    const displayNames = readElementTexts(body, 'display-name');
    if (this.acceptedIds && !this.acceptedIds.has(id)) {
      const names = this.options.channelNames;
      if (!names?.size || !displayNames.some((value) => names.has(value.toLowerCase()))) {
        this.stats.skippedFilter++;
        return;
      }
      this.acceptedIds.add(id);
    }
    const retainedNames = retainDisplayNames(displayNames, this.options.channelNames);
    const names = copyStrings(retainedNames.length ? retainedNames : [id]);
    const icon = copyString(readElementAttribute(body, 'icon', 'src') ?? '');
    this.channels[id] = {
      name: names[0],
      icon,
      ...(names.length > 1 ? { aliases: names.slice(1) } : {}),
    };
    this.stats.channelsKept++;
  }

  private handleProgramme(element: ElementRange): void {
    this.stats.programmesSeen++;
    const attributes = readProgrammeAttributes(
      this.buffer,
      element.tagStart + 1,
      element.tagEnd + 1,
      this.acceptedIds,
    );
    const channelId = attributes.channelId;
    if (!channelId) {
      this.stats.malformed++;
      return;
    }
    if (this.acceptedIds && !this.acceptedIds.has(channelId)) {
      if (!this.declaredIds.has(channelId)) this.programmesBeforeDeclaration.add(channelId);
      this.stats.skippedFilter++;
      return;
    }
    this.stats.programmesMatched++;

    const start = parseTimestamp(attributes.start);
    const stop = parseTimestamp(attributes.stop);
    if (!start || !stop) {
      this.stats.skippedDate++;
      return;
    }
    if (stop.time < this.minTime || start.time > this.maxTime) {
      this.stats.skippedRange++;
      return;
    }
    if (this.tzOffsetMinutes === null && start.offsetMinutes !== null) {
      this.tzOffsetMinutes = start.offsetMinutes;
    }

    const body = this.buffer.slice(element.bodyStart, element.bodyEnd);
    const [title, description, category, icon] = copyStrings([
      readElementText(body, 'title'),
      readElementText(body, 'desc'),
      readElementText(body, 'category'),
      readElementAttribute(body, 'icon', 'src') ?? '',
    ]);
    const programme: Programme = {
      start: new Date(start.time),
      stop: new Date(stop.time),
      title,
      description,
      category,
      icon,
    };
    const list = this.programmes[channelId] ?? (this.programmes[channelId] = []);
    const previousStart = this.lastStartByChannel.get(channelId);
    if (previousStart !== undefined && start.time < previousStart) {
      this.unsortedChannels.add(channelId);
    }
    this.lastStartByChannel.set(channelId, start.time);
    list.push(programme);
    this.stats.programmesKept++;
  }

  private sortUnorderedProgrammes(): void {
    for (const id of this.unsortedChannels) {
      const list = this.programmes[id];
      const ordered = list.map((programme, index) => ({ programme, index }));
      ordered.sort((a, b) =>
        a.programme.start.getTime() - b.programme.start.getTime() || a.index - b.index);
      for (let i = 0; i < ordered.length; i++) list[i] = ordered[i].programme;
    }
  }

  private compact(): void {
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
  }

  private logStats(): void {
    log.info(`Parsed ${String(Object.keys(this.channels).length)} channels, `
      + `${String(this.stats.programmesSeen)} programme elements`);
    if (this.stats.skippedDate) {
      log.warn(`Skipped ${String(this.stats.skippedDate)} programmes with unparseable dates`);
    }
    if (this.stats.skippedRange) {
      log.info(`Skipped ${String(this.stats.skippedRange)} programmes outside time range`);
    }
    if (this.stats.skippedFilter) {
      log.info(`Skipped ${String(this.stats.skippedFilter)} elements outside the channel filter`);
    }
    if (this.stats.malformed) {
      log.warn(`Skipped ${String(this.stats.malformed)} malformed XMLTV elements`);
    }
    log.info(`Loaded programmes for ${String(Object.keys(this.programmes).length)} channels`);
  }
}

export function parseXMLTV(xmlString: string, options: XMLTVParseOptions = {}): ParsedEpg {
  return parseXMLTVWithStats(xmlString, options).data;
}

export function parseXMLTVWithStats(
  xmlString: string,
  options: XMLTVParseOptions = {},
): { data: ParsedEpg; stats: XMLTVParseStats } {
  const parser = new XMLTVStreamParser(options);
  parser.write(xmlString);
  let data = parser.finish();
  if (!parser.needsOrderRetry()) return { data, stats: parser.stats };

  const retry = new XMLTVStreamParser({
    ...options,
    channelIds: parser.acceptedChannelIds(),
  });
  retry.write(xmlString);
  data = retry.finish();
  return { data, stats: retry.stats };
}

function retainDisplayNames(
  displayNames: string[],
  matchedNames: ReadonlySet<string> | undefined,
): string[] {
  const retained = displayNames.slice(0, MAX_RETAINED_DISPLAY_NAMES);
  if (!matchedNames?.size) return retained;
  for (let i = MAX_RETAINED_DISPLAY_NAMES; i < displayNames.length; i++) {
    const value = displayNames[i];
    if (matchedNames.has(value.toLowerCase())) retained.push(value);
  }
  return retained;
}

function readTagName(value: string, start: number, end: number): string {
  let cursor = start;
  if (value[cursor] === '/') cursor++;
  while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
  const nameStart = cursor;
  while (cursor < end && isNameChar(value.charCodeAt(cursor))) cursor++;
  return value.slice(nameStart, cursor);
}

function findTagEnd(value: string, start: number): number {
  let quote = 0;
  for (let i = start; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 62) {
      return i;
    }
  }
  return -1;
}

function findDeclarationEnd(value: string, start: number): number {
  let quote = 0;
  let brackets = 0;
  for (let i = start; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 91) {
      brackets++;
    } else if (code === 93 && brackets) {
      brackets--;
    } else if (code === 62 && brackets === 0) {
      return i;
    }
  }
  return -1;
}

function findClosingTag(
  value: string,
  name: 'channel' | 'programme',
  start: number,
): { start: number; end: number } | null {
  const needle = `</${name}`;
  let cursor = start;
  while (true) {
    const closeStart = value.indexOf(needle, cursor);
    if (closeStart === -1) return null;
    const afterName = closeStart + needle.length;
    const code = value.charCodeAt(afterName);
    if (code === 62 || isSpace(code)) {
      const closeEnd = findTagEnd(value, afterName);
      return closeEnd === -1 ? null : { start: closeStart, end: closeEnd };
    }
    cursor = afterName;
  }
}

function isSelfClosing(value: string, start: number, end: number): boolean {
  let cursor = end - 1;
  while (cursor > start && isSpace(value.charCodeAt(cursor))) cursor--;
  return value.charCodeAt(cursor) === 47;
}

function readAttribute(
  value: string,
  target: string,
  start = 1,
  end = value.length,
): string | undefined {
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    const nameStart = cursor;
    while (cursor < end && isNameChar(value.charCodeAt(cursor))) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = value.slice(nameStart, cursor);
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    if (value.charCodeAt(cursor) !== 61) continue;
    cursor++;
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    const quote = value.charCodeAt(cursor);
    if (quote !== 34 && quote !== 39) continue;
    const valueStart = ++cursor;
    while (cursor < end && value.charCodeAt(cursor) !== quote) cursor++;
    if (name === target) {
      return decodeEntities(value.slice(valueStart, cursor));
    }
    cursor++;
  }
  return undefined;
}

function readProgrammeAttributes(
  value: string,
  start: number,
  end: number,
  acceptedIds: ReadonlySet<string> | null,
): ProgrammeAttributes {
  const result: ProgrammeAttributes = {
    channelId: undefined,
    start: undefined,
    stop: undefined,
  };
  let cursor = start;
  let remaining = 3;
  while (cursor < end && remaining > 0) {
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    const nameStart = cursor;
    while (cursor < end && isNameChar(value.charCodeAt(cursor))) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = value.slice(nameStart, cursor);
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    if (value.charCodeAt(cursor) !== 61) continue;
    cursor++;
    while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
    const quote = value.charCodeAt(cursor);
    if (quote !== 34 && quote !== 39) continue;
    const valueStart = ++cursor;
    while (cursor < end && value.charCodeAt(cursor) !== quote) cursor++;
    const attributeValue = decodeEntities(value.slice(valueStart, cursor));
    if (name === 'channel') {
      result.channelId = attributeValue;
      remaining--;
      if (acceptedIds && !acceptedIds.has(attributeValue)) return result;
    } else if (name === 'start') {
      result.start = attributeValue;
      remaining--;
    } else if (name === 'stop') {
      result.stop = attributeValue;
      remaining--;
    }
    cursor++;
  }
  return result;
}

function readElementText(body: string, target: string): string {
  const range = findChildElement(body, target);
  if (!range) return '';
  return readRangeText(body, range);
}

/** Every `<target>` text in document order, optionally capped at `limit` entries. */
function readElementTexts(body: string, target: string, limit?: number): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (limit === undefined || result.length < limit) {
    const range = findChildElement(body, target, cursor);
    if (!range) break;
    const text = readRangeText(body, range);
    if (text) result.push(text);
    cursor = range.elementEnd;
  }
  return result;
}

function readRangeText(body: string, range: ElementRange): string {
  let cursor = range.bodyStart;
  let plainStart = cursor;
  let result = '';
  while (cursor < range.bodyEnd) {
    const markup = body.indexOf('<', cursor);
    if (markup === -1 || markup >= range.bodyEnd) break;
    result += decodeEntities(body.slice(plainStart, markup));
    if (body.startsWith('<![CDATA[', markup)) {
      const markupEnd = body.indexOf(']]>', markup + 9);
      if (markupEnd === -1 || markupEnd > range.bodyEnd) {
        result += body.slice(markup + 9, range.bodyEnd);
        plainStart = range.bodyEnd;
        break;
      }
      result += body.slice(markup + 9, markupEnd);
      cursor = markupEnd + 3;
    } else if (body.startsWith('<!--', markup)) {
      const markupEnd = body.indexOf('-->', markup + 4);
      cursor = markupEnd === -1 || markupEnd > range.bodyEnd
        ? range.bodyEnd
        : markupEnd + 3;
    } else {
      const tagEnd = findTagEnd(body, markup + 1);
      cursor = tagEnd === -1 || tagEnd >= range.bodyEnd ? range.bodyEnd : tagEnd + 1;
    }
    plainStart = cursor;
  }
  if (plainStart < range.bodyEnd) {
    result += decodeEntities(body.slice(plainStart, range.bodyEnd));
  }
  return result.trim();
}

function readElementAttribute(
  body: string,
  target: string,
  attribute: string,
): string | undefined {
  const range = findChildElement(body, target);
  if (!range) return undefined;
  return readAttribute(body, attribute, range.tagStart + 1, range.tagEnd + 1);
}

function findChildElement(body: string, target: string, from = 0): ElementRange | null {
  const needle = `<${target}`;
  let cursor = from;
  while (true) {
    const tagStart = body.indexOf(needle, cursor);
    if (tagStart === -1) return null;
    const afterName = tagStart + needle.length;
    const code = body.charCodeAt(afterName);
    if (code !== 62 && code !== 47 && !isSpace(code)) {
      cursor = afterName;
      continue;
    }
    const tagEnd = findTagEnd(body, afterName);
    if (tagEnd === -1) return null;
    if (isSelfClosing(body, tagStart, tagEnd)) {
      return {
        name: 'channel',
        tagStart,
        tagEnd,
        bodyStart: tagEnd,
        bodyEnd: tagEnd,
        elementEnd: tagEnd + 1,
      };
    }
    const closing = findGenericClosingTag(body, target, tagEnd + 1);
    if (!closing) return null;
    return {
      name: 'channel',
      tagStart,
      tagEnd,
      bodyStart: tagEnd + 1,
      bodyEnd: closing.start,
      elementEnd: closing.end + 1,
    };
  }
}

function findGenericClosingTag(
  body: string,
  target: string,
  start: number,
): { start: number; end: number } | null {
  const needle = `</${target}`;
  let cursor = start;
  while (true) {
    const closeStart = body.indexOf(needle, cursor);
    if (closeStart === -1) return null;
    const afterName = closeStart + needle.length;
    const code = body.charCodeAt(afterName);
    if (code === 62 || isSpace(code)) {
      const closeEnd = findTagEnd(body, afterName);
      return closeEnd === -1 ? null : { start: closeStart, end: closeEnd };
    }
    cursor = afterName;
  }
}

function decodeEntities(value: string): string {
  if (value.indexOf('&') === -1) return value;
  return value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity.charCodeAt(0) === 35) {
      const hex = entity.charCodeAt(1) === 120 || entity.charCodeAt(1) === 88;
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    switch (entity.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

function copyString(value: string): string {
  if (value.length < 13) return value;
  return textDecoder.decode(textEncoder.encode(value));
}

function copyStrings(values: readonly string[]): string[] {
  // Retained slices share this compact parent instead of pinning the XML buffer.
  const joined = values.join('\0');
  const copies = new Array<string>(values.length);
  let offset = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    copies[i] = value.length < 13 ? value : joined.slice(offset, offset + value.length);
    offset += value.length + 1;
  }
  return copies;
}

function parseTimestamp(value: string | undefined): ParsedTimestamp | null {
  if (!value) return null;
  let start = 0;
  let end = value.length;
  while (start < end && isSpace(value.charCodeAt(start))) start++;
  while (end > start && isSpace(value.charCodeAt(end - 1))) end--;
  if (end - start < 14) return null;

  const year = readDigits(value, start, 4);
  const month = readDigits(value, start + 4, 2);
  const day = readDigits(value, start + 6, 2);
  const hour = readDigits(value, start + 8, 2);
  const minute = readDigits(value, start + 10, 2);
  const second = readDigits(value, start + 12, 2);
  if (year < 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  let cursor = start + 14;
  while (cursor < end && isSpace(value.charCodeAt(cursor))) cursor++;
  let offsetMinutes: number | null = null;
  if (cursor < end) {
    const sign = value.charCodeAt(cursor);
    if ((sign !== 43 && sign !== 45) || cursor + 5 !== end) return null;
    const offsetHours = readDigits(value, cursor + 1, 2);
    const offsetMins = readDigits(value, cursor + 3, 2);
    if (offsetHours < 0 || offsetHours > 23 || offsetMins < 0 || offsetMins > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetMins) * (sign === 45 ? -1 : 1);
  }

  const localUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return {
    time: localUtc - (offsetMinutes ?? 0) * 60000,
    offsetMinutes,
  };
}

function readDigits(value: string, start: number, length: number): number {
  let result = 0;
  for (let i = 0; i < length; i++) {
    const digit = value.charCodeAt(start + i) - 48;
    if (digit < 0 || digit > 9) return -1;
    result = result * 10 + digit;
  }
  return result;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isNameChar(code: number): boolean {
  return (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57)
    || code === 45 || code === 95 || code === 58 || code === 46;
}
