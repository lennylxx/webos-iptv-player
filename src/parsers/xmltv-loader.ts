import { Gunzip } from 'fflate';
import {
  XMLTVStreamParser,
  type XMLTVParseOptions,
  type XMLTVRecordSink,
} from './xmltv-parser';
import { runAppWorkerTask } from '../workers/app-worker-client';
import { holdEpg } from '../workers/held-values';
import { PACKED_EPG_FORMAT, packEpg, unpackEpgSliced } from '../services/epg-cache-codec';
import { holdWorkerValue } from '../services/worker-held-records';
import { releaseHeldRecord } from '../services/held-records';
import type {
  XMLTVWorkerChunk,
  XMLTVWorkerRequest,
  XMLTVWorkerResponse,
} from '../workers/tasks';
import type { EpgChannel, ParsedEpg, Programme } from '../types';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { yieldToEventLoop } from '../utils/yield';

export type XMLTVLoadResult = XMLTVWorkerResponse;
const log = createLogger('XMLTVLoad');
// Each message is one short clone on the page; the whole guide at once
// would be one long task there.
const GUIDE_MESSAGE_CHARS = 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024;

export async function fetchAndParseXMLTV(
  url: string,
  timeout = 30000,
  options: XMLTVParseOptions = {},
  holdForCache = false,
): Promise<XMLTVLoadResult> {
  const started = Date.now();
  log.info(
    'XMLTV stream load started',
    'event=epg.xmltv.load.started',
    `filter=${options.channelIds || options.channelNames ? 'channel_subset' : 'none'}`,
    `items=${String(options.channelIds?.size ?? options.channelNames?.size ?? 0)}`,
    `timeoutMs=${String(timeout)}`,
  );
  let decodeFailed = false;
  try {
    const blocks: Record<'channels' | 'programmes', string[]> = { channels: [], programmes: [] };
    const result = await runAppWorkerTask('xmltv.load', {
      url,
      timeout,
      options: {
        nowMs: options.nowMs ?? Date.now(),
        channelIds: options.channelIds ? Array.from(options.channelIds) : undefined,
        channelNames: options.channelNames ? Array.from(options.channelNames) : undefined,
        retainChannelCatalog: options.retainChannelCatalog,
        maxProgrammes: options.maxProgrammes,
      },
      ...(holdForCache ? { holdForCache } : {}),
    }, chunk => {
      if (chunk.kind === 'progress') {
        log.info(
          'XMLTV stream load progress',
          'event=epg.xmltv.load.progress',
          `attempt=${String(chunk.attempt)}`,
          `encoding=${chunk.encoding}`,
          `bytes=${String(chunk.inputBytes)}`,
          `chunks=${String(chunk.chunks)}`,
        );
        return;
      }
      for (const block of chunk.blocks) blocks[chunk.part].push(block);
    });
    if (result.metrics.attempts > 1) logRetry();
    const data = result.data;
    // Held before the decode: holding retains the worker, which would
    // otherwise stop idle while the page decodes, and lose the guide.
    if (result.held) {
      holdWorkerValue(data, result.held, false);
      delete result.held;
    }
    const decodeStarted = Date.now();
    try {
      const guide = await unpackEpgSliced(
        { format: PACKED_EPG_FORMAT, meta: {}, ...blocks },
        yieldToEventLoop,
        CONFIG.EPG.CACHE_DECODE_SLICE_MS,
      );
      data.channels = guide.channels;
      data.programmes = guide.programmes;
    } catch (error) {
      decodeFailed = true;
      releaseHeldRecord(data);
      const { metrics } = result;
      log.error(
        'XMLTV guide decode failed',
        'event=epg.xmltv.load.failed',
        'stage=decode',
        'reason=exception',
        `attempts=${String(metrics.attempts)}`,
        `transport=${metrics.transport}`,
        `encoding=${metrics.encoding}`,
        `bytes=${String(metrics.inputBytes)}`,
        `chunks=${String(metrics.chunks)}`,
        `elapsedMs=${String(Date.now() - started)}`,
        error,
      );
      throw error;
    }
    logCompleted(result, Date.now() - decodeStarted, Date.now() - started);
    return result;
  } catch (error) {
    if (decodeFailed) throw error;
    const details = workerFailureDetails(error);
    if (details?.retried) logRetry();
    if (details) {
      log.error(
        'XMLTV stream load failed',
        'event=epg.xmltv.load.failed',
        `pass=${details.pass}`,
        `stage=${details.stage}`,
        `reason=${details.reason}`,
        `transport=${details.transport}`,
        `encoding=${details.encoding}`,
        `bytes=${String(details.inputBytes)}`,
        `chunks=${String(details.chunks)}`,
        `elapsedMs=${String(details.elapsedMs)}`,
        error,
      );
    } else {
      log.error(
        'XMLTV stream load failed',
        'event=epg.xmltv.load.failed',
        'stage=worker',
        'reason=exception',
        `elapsedMs=${String(Date.now() - started)}`,
        error,
      );
    }
    throw error;
  }
}

function logRetry(): void {
  log.info(
    'XMLTV stream requires a second pass',
    'event=epg.xmltv.load.retry',
    'reason=programme_before_channel',
  );
}

function logCompleted(result: XMLTVWorkerResponse, decodeMs: number, totalMs: number): void {
  const { metrics } = result;
  log.info(
    'XMLTV stream loaded',
    'event=epg.xmltv.load.completed',
    `transport=${metrics.transport}`,
    `encoding=${metrics.encoding}`,
    `attempts=${String(metrics.attempts)}`,
    `bytes=${String(metrics.inputBytes)}`,
    `chunks=${String(metrics.chunks)}`,
    `programmes=${String(result.stats.programmesKept)}`,
    `dropped=${String(result.stats.droppedBudget)}`,
    `elapsedMs=${String(metrics.elapsedMs)}`,
    `decodeMs=${String(decodeMs)}`,
    `totalMs=${String(totalMs)}`,
  );
}

function workerFailureDetails(error: unknown): {
  pass: string;
  stage: string;
  reason: string;
  elapsedMs: number;
  retried: boolean;
  transport: 'stream' | 'array_buffer';
  encoding: 'gzip' | 'plain';
  inputBytes: number;
  chunks: number;
} | null {
  if (!(error instanceof Error) || !('details' in error)) return null;
  const details = error.details;
  if (!details || typeof details !== 'object') return null;
  const value = details as Record<string, unknown>;
  return typeof value.pass === 'string'
    && typeof value.stage === 'string'
    && typeof value.reason === 'string'
    && typeof value.elapsedMs === 'number'
    && typeof value.retried === 'boolean'
    && (value.transport === 'stream' || value.transport === 'array_buffer')
    && (value.encoding === 'gzip' || value.encoding === 'plain')
    && typeof value.inputBytes === 'number'
    && typeof value.chunks === 'number'
    ? {
        pass: value.pass,
        stage: value.stage,
        reason: value.reason,
        elapsedMs: value.elapsedMs,
        retried: value.retried,
        transport: value.transport,
        encoding: value.encoding,
        inputBytes: value.inputBytes,
        chunks: value.chunks,
      }
    : null;
}

interface XMLTVWorkerFailureDetails {
  pass: 'initial' | 'retry';
  stage: string;
  reason: 'timeout' | 'http' | 'exception';
  elapsedMs: number;
  retried: boolean;
  transport: 'stream' | 'array_buffer';
  encoding: 'gzip' | 'plain';
  inputBytes: number;
  chunks: number;
}

class XMLTVWorkerError extends Error {
  constructor(
    message: string,
    readonly details: XMLTVWorkerFailureDetails,
  ) {
    super(message);
    this.name = 'XMLTVWorkerError';
  }
}

export async function fetchAndParseXMLTVInWorker(
  request: XMLTVWorkerRequest,
  emitChunk: (chunk: XMLTVWorkerChunk) => void,
): Promise<XMLTVWorkerResponse> {
  const started = Date.now();
  const options = deserializeOptions(request);
  let first: PassResult | null = await parsePass(
    request.url,
    request.timeout,
    options,
    'initial',
    false,
    emitChunk,
    1,
  );
  if (!first.parser.needsOrderRetry()) {
    return deliverGuide(createResponse(first, 1, Date.now() - started), first.guide, request, emitChunk);
  }
  const channelIds = first.parser.acceptedChannelIds();
  const { inputBytes, chunks } = first;
  // Its parser's sink holds the whole first guide, which the retry rebuilds.
  first = null;
  const retry = await parsePass(request.url, request.timeout, {
    ...options,
    channelIds,
  }, 'retry', true, emitChunk, 2);
  retry.inputBytes += inputBytes;
  retry.chunks += chunks;
  return deliverGuide(createResponse(retry, 2, Date.now() - started), retry.guide, request, emitChunk);
}

// The page gets the guide once, as packed text blocks: cloning strings is
// cheap, and the page decodes them a slice at a time. The same blocks are
// held for the cache write, which only a complete guide with programmes gets.
function deliverGuide(
  response: XMLTVWorkerResponse,
  guide: ParsedEpg,
  request: XMLTVWorkerRequest,
  emitChunk: (chunk: XMLTVWorkerChunk) => void,
): XMLTVWorkerResponse {
  const cacheable = request.holdForCache
    && response.stats.droppedBudget === 0
    && response.stats.programmesKept > 0;
  const packed = packEpg(guide);
  sendBlocks('channels', packed.channels, emitChunk);
  sendBlocks('programmes', packed.programmes, emitChunk);
  return cacheable ? { ...response, held: { token: holdEpg(() => packed) } } : response;
}

function sendBlocks(
  part: 'channels' | 'programmes',
  blocks: string[],
  emitChunk: (chunk: XMLTVWorkerChunk) => void,
): void {
  let batch: string[] = [];
  let chars = 0;
  for (const block of blocks) {
    batch.push(block);
    chars += block.length;
    if (chars >= GUIDE_MESSAGE_CHARS) {
      emitChunk({ kind: 'guide', part, blocks: batch });
      batch = [];
      chars = 0;
    }
  }
  if (batch.length) emitChunk({ kind: 'guide', part, blocks: batch });
}

interface PassResult {
  data: XMLTVWorkerResponse['data'];
  guide: ParsedEpg;
  parser: XMLTVStreamParser;
  encoding: 'gzip' | 'plain';
  transport: 'stream' | 'array_buffer';
  inputBytes: number;
  chunks: number;
}

async function parsePass(
  url: string,
  timeout: number,
  options: XMLTVParseOptions,
  pass: 'initial' | 'retry',
  retried: boolean,
  emitChunk: (chunk: XMLTVWorkerChunk) => void,
  attempt = 1,
): Promise<PassResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let complete = false;
  let stage = 'fetch';
  let encoding: 'gzip' | 'plain' = 'plain';
  let transport: 'stream' | 'array_buffer' = 'stream';
  let inputBytes = 0;
  let chunks = 0;
  let nextProgressBytes = PROGRESS_INTERVAL_BYTES;
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    stage = 'read';
    reader = typeof response.body?.getReader === 'function'
      ? response.body.getReader()
      : null;
    const accumulator = new XMLTVAccumulator();
    const parser = new XMLTVStreamParser(options, accumulator);
    if (!reader) {
      transport = 'array_buffer';
      stage = 'decode_parse';
      const bytes = new Uint8Array(await response.arrayBuffer());
      inputBytes = bytes.length;
      chunks = bytes.length ? 1 : 0;
      encoding = isGzip(bytes) ? 'gzip' : 'plain';
      emitProgress();
      consumeBytes(bytes, encoding === 'gzip', parser);
    } else {
      let prefix: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      while (prefix.length < 2) {
        stage = 'read';
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        if (next.value?.length) prefix = appendBytes(prefix, next.value);
      }
      encoding = isGzip(prefix) ? 'gzip' : 'plain';
      const decoder = new TextDecoder();
      const gunzip = encoding === 'gzip'
        ? new Gunzip(chunk => writeDecoded(parser, decoder, chunk))
        : null;
      const consume = (bytes: Uint8Array): void => {
        consumeChunk(bytes, parser, decoder, gunzip);
      };
      stage = 'decode_parse';
      if (prefix.length) {
        inputBytes += prefix.length;
        chunks++;
        emitProgress();
        stage = 'decode_parse';
        consume(prefix);
      }
      while (!complete) {
        stage = 'read';
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        if (next.value?.length) {
          inputBytes += next.value.length;
          chunks++;
          emitProgress();
          stage = 'decode_parse';
          consume(next.value);
        }
      }
      stage = 'decode_parse';
      if (gunzip) gunzip.push(new Uint8Array(0), true);
      const tail = decoder.decode();
      if (tail) parser.write(tail);
    }
    stage = 'finish';
    const data = parser.finish();
    return {
      data,
      guide: accumulator.complete(data),
      parser,
      encoding,
      transport,
      inputBytes,
      chunks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = controller.signal.aborted
      ? 'timeout'
      : stage === 'fetch' && message.startsWith('HTTP ')
        ? 'http'
        : 'exception';
    throw new XMLTVWorkerError(message, {
      pass,
      stage,
      reason,
      elapsedMs: Date.now() - started,
      retried,
      transport,
      encoding,
      inputBytes,
      chunks,
    });
  } finally {
    if (reader && !complete) void reader.cancel().catch(() => {});
    clearTimeout(timer);
  }

  function emitProgress(): void {
    if (inputBytes < nextProgressBytes) return;
    emitChunk({
      kind: 'progress',
      attempt,
      encoding,
      inputBytes,
      chunks,
    });
    while (nextProgressBytes <= inputBytes) {
      nextProgressBytes += PROGRESS_INTERVAL_BYTES;
    }
  }
}

class XMLTVAccumulator implements XMLTVRecordSink {
    private channels: Record<string, EpgChannel> = {};
    private programmes: Record<string, Programme[]> = {};
    private unsortedChannels = new Set<string>();

    channel(id: string, channel: EpgChannel): void {
      this.channels[id] = channel;
    }

    programme(id: string, programme: Programme): void {
      const list = this.programmes[id] ?? (this.programmes[id] = []);
      const previous = list[list.length - 1];
      if (previous && programme.start.getTime() < previous.start.getTime()) {
        this.unsortedChannels.add(id);
      }
      list.push(programme);
    }

    complete(metadata: ParsedEpg): ParsedEpg {
      for (const id of this.unsortedChannels) {
        const list = this.programmes[id];
        const ordered = list.map((programme, index) => ({ programme, index }));
        ordered.sort((left, right) =>
          left.programme.start.getTime() - right.programme.start.getTime()
          || left.index - right.index);
        for (let index = 0; index < ordered.length; index++) {
          list[index] = ordered[index].programme;
        }
      }
      return {
        ...metadata,
        channels: this.channels,
        programmes: this.programmes,
      };
    }
}

function consumeBytes(
  bytes: Uint8Array,
  gzip: boolean,
  parser: XMLTVStreamParser,
): void {
  const decoder = new TextDecoder();
  const gunzip = gzip
    ? new Gunzip(chunk => writeDecoded(parser, decoder, chunk))
    : null;
  consumeChunk(bytes, parser, decoder, gunzip);
  if (gunzip) gunzip.push(new Uint8Array(0), true);
  const tail = decoder.decode();
  if (tail) parser.write(tail);
}

function consumeChunk(
  bytes: Uint8Array,
  parser: XMLTVStreamParser,
  decoder: TextDecoder,
  gunzip: Gunzip | null,
): void {
  if (gunzip) gunzip.push(bytes);
  else writeDecoded(parser, decoder, bytes);
}

function writeDecoded(
  parser: XMLTVStreamParser,
  decoder: TextDecoder,
  bytes: Uint8Array,
): void {
  const text = decoder.decode(bytes, { stream: true });
  if (text) parser.write(text);
}

function deserializeOptions(request: XMLTVWorkerRequest): XMLTVParseOptions {
  return {
    ...request.options,
    channelIds: request.options.channelIds
      ? new Set(request.options.channelIds)
      : undefined,
    channelNames: request.options.channelNames
      ? new Set(request.options.channelNames)
      : undefined,
  };
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function createResponse(
  pass: PassResult,
  attempts: number,
  elapsed: number,
): XMLTVWorkerResponse {
  return {
    data: pass.data,
    stats: pass.parser.stats,
    metrics: {
      transport: pass.transport,
      encoding: pass.encoding,
      attempts,
      inputBytes: pass.inputBytes,
      chunks: pass.chunks,
      elapsedMs: elapsed,
    },
  };
}
