import { Gunzip } from 'fflate';
import {
  XMLTVStreamParser,
  type XMLTVParseOptions,
  type XMLTVRecordSink,
} from './xmltv-parser';
import { runAppWorkerTask } from '../workers/app-worker-client';
import { holdEpg } from '../workers/held-values';
import { packEpg } from '../services/epg-cache-codec';
import { holdWorkerValue } from '../services/worker-held-records';
import type {
  XMLTVWorkerChunk,
  XMLTVWorkerRequest,
  XMLTVWorkerResponse,
} from '../workers/tasks';
import type { EpgChannel, ParsedEpg, Programme } from '../types';
import { createLogger } from '../utils/logger';

export type XMLTVLoadResult = XMLTVWorkerResponse;
const log = createLogger('XMLTVLoad');
const CHANNEL_BATCH_SIZE = 128;
const PROGRAMME_BATCH_SIZE = 256;
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
  try {
    const accumulator = new XMLTVAccumulator();
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
      accumulator.accept(chunk);
    });
    result.data = accumulator.complete(result.data);
    if (result.held) {
      holdWorkerValue(result.data, result.held, false);
      delete result.held;
    }
    if (result.metrics.attempts > 1) logRetry();
    logCompleted(result);
    return result;
  } catch (error) {
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

function logCompleted(result: XMLTVWorkerResponse): void {
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
  emitChunk?: (chunk: XMLTVWorkerChunk) => void,
): Promise<XMLTVWorkerResponse> {
  const started = Date.now();
  const options = deserializeOptions(request);
  // The worker keeps every batch it sends, already cloned to the page, so
  // the page's cache write can rebuild the same guide here.
  let kept: XMLTVWorkerChunk[] | null = null;
  const emit = request.holdForCache && emitChunk
    ? (chunk: XMLTVWorkerChunk): void => {
        if (chunk.kind === 'reset') kept = [chunk];
        else if (chunk.kind !== 'progress') kept?.push(chunk);
        emitChunk(chunk);
      }
    : emitChunk;
  // Past the ceiling the guide is never cached, so its batches can go now.
  const dropKeptPastBudget = (parser: XMLTVStreamParser): void => {
    if (parser.stats.droppedBudget) kept = null;
  };
  const first = await parsePass(
    request.url,
    request.timeout,
    options,
    'initial',
    false,
    emit,
    1,
    dropKeptPastBudget,
  );
  if (!first.parser.needsOrderRetry()) {
    return withHeldGuide(createResponse(first, 1, Date.now() - started), kept);
  }
  const retry = await parsePass(request.url, request.timeout, {
    ...options,
    channelIds: first.parser.acceptedChannelIds(),
  }, 'retry', true, emit, 2, dropKeptPastBudget);
  retry.inputBytes += first.inputBytes;
  retry.chunks += first.chunks;
  return withHeldGuide(createResponse(retry, 2, Date.now() - started), kept);
}

// A truncated or empty guide is never cached, so it is not kept.
function withHeldGuide(
  response: XMLTVWorkerResponse,
  kept: XMLTVWorkerChunk[] | null,
): XMLTVWorkerResponse {
  if (!kept || response.stats.droppedBudget > 0 || !response.stats.programmesKept) return response;
  let chunks: XMLTVWorkerChunk[] | null = kept;
  const metadata = response.data;
  return {
    ...response,
    held: {
      token: holdEpg(() => {
        const accumulator = new XMLTVAccumulator();
        for (const chunk of chunks!) accumulator.accept(chunk);
        const guide = packEpg(accumulator.complete(metadata));
        // Built once, so the batch arrays can go while the guide waits.
        chunks = null;
        return guide;
      }),
    },
  };
}

async function parsePass(
  url: string,
  timeout: number,
  options: XMLTVParseOptions,
  pass: 'initial' | 'retry',
  retried: boolean,
  emitChunk?: (chunk: XMLTVWorkerChunk) => void,
  attempt = 1,
  afterInput?: (parser: XMLTVStreamParser) => void,
): Promise<{
  data: XMLTVWorkerResponse['data'];
  parser: XMLTVStreamParser;
  encoding: 'gzip' | 'plain';
  transport: 'stream' | 'array_buffer';
  inputBytes: number;
  chunks: number;
}> {
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
    emitChunk?.({ kind: 'reset', attempt });
    const batcher = emitChunk ? new XMLTVBatcher(attempt, emitChunk) : undefined;
    const parser = new XMLTVStreamParser(options, batcher);
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
        afterInput?.(parser);
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
    batcher?.flush();
    return {
      data,
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
    if (!emitChunk || inputBytes < nextProgressBytes) return;
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

class XMLTVBatcher implements XMLTVRecordSink {
    private channels: Array<[string, EpgChannel]> = [];
    private programmes = new Map<string, Programme[]>();
    private programmeCount = 0;

    constructor(
      private readonly attempt: number,
      private readonly emit: (chunk: XMLTVWorkerChunk) => void,
    ) {}

    channel(id: string, channel: EpgChannel): void {
      this.channels.push([id, channel]);
      if (this.channels.length >= CHANNEL_BATCH_SIZE) this.flushChannels();
    }

    programme(id: string, programme: Programme): void {
      const list = this.programmes.get(id);
      if (list) list.push(programme);
      else this.programmes.set(id, [programme]);
      this.programmeCount++;
      if (this.programmeCount >= PROGRAMME_BATCH_SIZE) this.flushProgrammes();
    }

    flush(): void {
      this.flushChannels();
      this.flushProgrammes();
    }

    private flushChannels(): void {
      if (!this.channels.length) return;
      this.emit({
        kind: 'channels',
        attempt: this.attempt,
        entries: this.channels,
      });
      this.channels = [];
    }

    private flushProgrammes(): void {
      if (!this.programmeCount) return;
      this.emit({
        kind: 'programmes',
        attempt: this.attempt,
        entries: Array.from(this.programmes),
      });
      this.programmes = new Map();
      this.programmeCount = 0;
    }
  }

class XMLTVAccumulator {
    private attempt = 0;
    private channels: Record<string, EpgChannel> = {};
    private programmes: Record<string, Programme[]> = {};
    private lastStartByChannel = new Map<string, number>();
    private unsortedChannels = new Set<string>();

    accept(chunk: XMLTVWorkerChunk): void {
      if (chunk.kind === 'reset') {
        if (chunk.attempt < this.attempt) return;
        this.attempt = chunk.attempt;
        this.channels = {};
        this.programmes = {};
        this.lastStartByChannel = new Map();
        this.unsortedChannels = new Set();
        return;
      }
      if (chunk.attempt !== this.attempt) return;
      if (chunk.kind === 'channels') {
        for (const [id, channel] of chunk.entries) this.channels[id] = channel;
        return;
      }
      if (chunk.kind === 'progress') return;
      for (const [id, incoming] of chunk.entries) {
        const list = this.programmes[id] ?? (this.programmes[id] = []);
        for (const programme of incoming) {
          const start = programme.start.getTime();
          const previous = this.lastStartByChannel.get(id);
          if (previous !== undefined && start < previous) this.unsortedChannels.add(id);
          this.lastStartByChannel.set(id, start);
          list.push(programme);
        }
      }
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
  pass: {
    data: XMLTVWorkerResponse['data'];
    parser: XMLTVStreamParser;
    encoding: 'gzip' | 'plain';
    transport: 'stream' | 'array_buffer';
    inputBytes: number;
    chunks: number;
  },
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
