import { Gunzip } from 'fflate';
import { XMLTVStreamParser, type XMLTVParseOptions } from './xmltv-parser';
import { runAppWorkerTask } from '../workers/app-worker-client';
import type { XMLTVWorkerRequest, XMLTVWorkerResponse } from '../workers/tasks';
import { createLogger } from '../utils/logger';

export type XMLTVLoadResult = XMLTVWorkerResponse;
const log = createLogger('XMLTVLoad');

export async function fetchAndParseXMLTV(
  url: string,
  timeout = 30000,
  options: XMLTVParseOptions = {},
): Promise<XMLTVLoadResult> {
  try {
    const result = await runAppWorkerTask('xmltv.load', {
      url,
      timeout,
      options: {
        nowMs: options.nowMs ?? Date.now(),
        channelIds: options.channelIds ? Array.from(options.channelIds) : undefined,
        channelNames: options.channelNames ? Array.from(options.channelNames) : undefined,
        retainChannelCatalog: options.retainChannelCatalog,
      },
    });
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
        `elapsed=${String(details.elapsedMs)}ms`,
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
    `elapsed=${String(metrics.elapsedMs)}ms`,
  );
}

function workerFailureDetails(error: unknown): {
  pass: string;
  stage: string;
  reason: string;
  elapsedMs: number;
  retried: boolean;
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
    ? {
        pass: value.pass,
        stage: value.stage,
        reason: value.reason,
        elapsedMs: value.elapsedMs,
        retried: value.retried,
      }
    : null;
}

interface XMLTVWorkerFailureDetails {
  pass: 'initial' | 'retry';
  stage: string;
  reason: 'timeout' | 'http' | 'exception';
  elapsedMs: number;
  retried: boolean;
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
): Promise<XMLTVWorkerResponse> {
  const started = Date.now();
  const options = deserializeOptions(request);
  const first = await parsePass(request.url, request.timeout, options, 'initial', false);
  if (!first.parser.needsOrderRetry()) {
    return createResponse(first, 1, Date.now() - started);
  }
  const retry = await parsePass(request.url, request.timeout, {
    ...options,
    channelIds: first.parser.acceptedChannelIds(),
  }, 'retry', true);
  retry.inputBytes += first.inputBytes;
  retry.chunks += first.chunks;
  return createResponse(retry, 2, Date.now() - started);
}

async function parsePass(
  url: string,
  timeout: number,
  options: XMLTVParseOptions,
  pass: 'initial' | 'retry',
  retried: boolean,
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
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    stage = 'read';
    reader = typeof response.body?.getReader === 'function'
      ? response.body.getReader()
      : null;
    const parser = new XMLTVStreamParser(options);
    if (!reader) {
      transport = 'array_buffer';
      stage = 'decode_parse';
      const bytes = new Uint8Array(await response.arrayBuffer());
      inputBytes = bytes.length;
      chunks = bytes.length ? 1 : 0;
      encoding = isGzip(bytes) ? 'gzip' : 'plain';
      consumeBytes(bytes, encoding === 'gzip', parser);
    } else {
      let prefix: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      while (prefix.length < 2) {
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
      stage = 'decode_parse';
      if (prefix.length) {
        inputBytes += prefix.length;
        chunks++;
        consumeChunk(prefix, parser, decoder, gunzip);
      }
      while (!complete) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        if (next.value?.length) {
          inputBytes += next.value.length;
          chunks++;
          consumeChunk(next.value, parser, decoder, gunzip);
        }
      }
      if (gunzip) gunzip.push(new Uint8Array(0), true);
      const tail = decoder.decode();
      if (tail) parser.write(tail);
    }
    stage = 'finish';
    return {
      data: parser.finish(),
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
    });
  } finally {
    if (reader && !complete) void reader.cancel().catch(() => {});
    clearTimeout(timer);
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
