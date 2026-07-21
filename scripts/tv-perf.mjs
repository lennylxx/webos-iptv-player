#!/usr/bin/env node
// Sample a webOS app's performance counters (CPU, JS heap, DOM nodes, …) over the
// Chrome DevTools Protocol, capture CPU profiles and heap snapshots, or force
// GC — the headless counterpart of DevTools' Performance Monitor and panels.
//
// Usage:
//   node scripts/tv-perf.mjs [--app <id>] [--port 9998] [options]
// With neither --host nor --url, the TV device IP comes from `ares-setup-device`
// (default device, or TV_DEVICE=<name>), like tv-logs.mjs / tv-eval.mjs.
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  CdpClient,
  normalizeDeviceConfigurationError,
  resolveCdpTarget,
  resolveConfiguredDeviceIp,
} from './cdp-client.mjs';

// ---------------------------------------------------------------------------
// Pure metric + argument logic (no I/O). Isolated as functions and exported so
// the runtime below stays thin and these can be unit-tested directly.
// ---------------------------------------------------------------------------

const MiB = 1048576;
const SAMPLE_STATE = Symbol('cdpPerformanceSampleState');
const CPU_PROFILE_THRESHOLD_PERCENT = 80;
const CPU_PROFILE_TRIGGER_MS = 3000;
const CPU_PROFILE_DURATION_MS = 30000;
const CPU_PROFILE_PART_DURATION_MS = 5000;
const CPU_PROFILE_PART_COUNT = CPU_PROFILE_DURATION_MS / CPU_PROFILE_PART_DURATION_MS;
const TRACE_BUFFER_SIZE_KB = 4096;
const TRACE_CATEGORY_CANDIDATES = [
  'devtools.timeline',
  'blink.user_timing',
  'v8',
  'v8.execute',
  'media',
  'renderer',
  'renderer.scheduler',
  'scheduler',
  'scheduler.long_tasks',
  'sequence_manager',
  'toplevel',
  'loading',
  'gpu',
];
const traceCategoryCache = new WeakMap();

const SAMPLE_FIELDS = [
  { key: 'observedAt', label: 'Observed At', kind: 'date', width: 24 },
  { key: 'timestamp', label: 'Timestamp', kind: 'scalar', width: 13 },
  { key: 'cpuPercent', label: 'CPU %', kind: 'rate', width: 6 },
  { key: 'jsHeapUsedBytes', label: 'JS Heap Used', kind: 'bytes', width: 12 },
  { key: 'jsHeapTotalBytes', label: 'JS Heap Total', kind: 'bytes', width: 13 },
  { key: 'nodes', label: 'Nodes', kind: 'count', width: 8 },
  { key: 'eventListeners', label: 'Event Listeners', kind: 'count', width: 15 },
  { key: 'documents', label: 'Documents', kind: 'count', width: 9 },
  { key: 'frames', label: 'Frames', kind: 'count', width: 6 },
  { key: 'layoutsPerSecond', label: 'Layouts/s', kind: 'rate', width: 9 },
  { key: 'styleRecalcsPerSecond', label: 'Style Recalcs/s', kind: 'rate', width: 15 },
];

export const CSV_HEADER = SAMPLE_FIELDS.map((field) => field.key).join(',');

const getSampleState = (sample) => sample?.[SAMPLE_STATE] ?? null;

const defineSampleState = (sample, state) => {
  Object.defineProperty(sample, SAMPLE_STATE, {
    value: state,
    enumerable: false,
  });
  return sample;
};

const asFiniteNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  return null;
};

const parseRequiredStringValue = (argv, index, flag) => {
  if (index + 1 >= argv.length) {
    throw new Error(`Missing value for ${flag}.`);
  }

  const value = argv[index + 1];
  if (typeof value === 'string' && value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
};

const parseRequiredNumericValue = (argv, index, flag) => {
  if (index + 1 >= argv.length) {
    throw new Error(`Missing value for ${flag}.`);
  }

  const value = argv[index + 1];
  if (typeof value === 'string' && value.startsWith('-') && !Number.isFinite(Number(value))) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
};

const parsePositiveInteger = (value, flag, { max = Number.POSITIVE_INFINITY } = {}) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0 || numeric > max) {
    throw new Error(`Invalid value for ${flag}.`);
  }

  return numeric;
};

const parsePositiveMilliseconds = (value, flag) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid value for ${flag}.`);
  }

  const milliseconds = Math.round(numeric * 1000);
  if (milliseconds <= 0) {
    throw new Error(`Invalid value for ${flag}.`);
  }

  return milliseconds;
};

const parseNonEmptyString = (value, flag) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid value for ${flag}.`);
  }

  return value;
};

const buildSerializableSample = (sample) => {
  const record = {};
  for (const field of SAMPLE_FIELDS) {
    record[field.key] = sample?.[field.key] ?? null;
  }
  return record;
};

const formatTerminalValue = (field, sample) => {
  const value = sample?.[field.key] ?? null;

  if (value == null) return 'N/A';
  if (field.kind === 'date') {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
  if (field.kind === 'bytes') {
    const numeric = asFiniteNumber(value);
    return numeric == null ? 'N/A' : `${(numeric / MiB).toFixed(1)} MiB`;
  }
  if (field.kind === 'rate') {
    const numeric = asFiniteNumber(value);
    return numeric == null ? 'N/A' : numeric.toFixed(1);
  }

  return String(value);
};

const formatCsvValue = (value) => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();

  const text = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
};

const normalizeStatePair = (pair, legacyTimestamp) => {
  if (
    pair != null
    && typeof pair === 'object'
    && Number.isFinite(pair.value)
    && Number.isFinite(pair.timestamp)
  ) {
    return pair;
  }

  if (Number.isFinite(pair) && Number.isFinite(legacyTimestamp)) {
    return { value: pair, timestamp: legacyTimestamp };
  }

  return null;
};

const extractPreviousState = (previous) => {
  const state = getSampleState(previous);
  if (state == null || typeof state !== 'object') {
    return null;
  }

  return {
    taskDuration: normalizeStatePair(state.taskDuration, state.timestamp),
    layoutCount: normalizeStatePair(state.layoutCount, state.timestamp),
    recalcStyleCount: normalizeStatePair(state.recalcStyleCount, state.timestamp),
  };
};

const normalizeRate = (current, previous, elapsed) => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || !Number.isFinite(elapsed) || elapsed <= 0) {
    return null;
  }

  return (current - previous) / elapsed;
};

const normalizeDerivedRate = (current, previousPair, currentTimestamp) => {
  if (previousPair == null || !Number.isFinite(currentTimestamp)) {
    return null;
  }

  return normalizeRate(current, previousPair.value, currentTimestamp - previousPair.timestamp);
};

const nextStatePair = (current, previousPair, currentTimestamp) => {
  if (!Number.isFinite(currentTimestamp) || !Number.isFinite(current)) {
    return previousPair;
  }

  return {
    value: current,
    timestamp: currentTimestamp,
  };
};

export function parsePerformanceArgs(argv = []) {
  const options = {
    host: null,
    port: 9998,
    url: null,
    target: null,
    targetSelection: 'strict',
    intervalMs: 1000,
    durationMs: null,
    jsonlPath: null,
    csvPath: null,
    cpuProfilePath: null,
    tracePath: null,
    mode: 'monitor',
    snapshotPath: null,
    gcBefore: false,
    help: false,
  };

  let sawCollectGarbage = false;
  let sawSnapshot = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case '--host':
        options.host = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--port':
        options.port = parsePositiveInteger(parseRequiredNumericValue(argv, index, token), token, { max: 65535 });
        index += 1;
        break;
      case '--url':
        options.url = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--target':
        options.target = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--app':
        options.target = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        options.targetSelection = 'legacy-tv-app';
        index += 1;
        break;
      case '--interval':
        options.intervalMs = parsePositiveMilliseconds(parseRequiredNumericValue(argv, index, token), token);
        index += 1;
        break;
      case '--duration':
        options.durationMs = parsePositiveMilliseconds(parseRequiredNumericValue(argv, index, token), token);
        index += 1;
        break;
      case '--jsonl':
        options.jsonlPath = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--csv':
        options.csvPath = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--cpu-profile':
        options.cpuProfilePath = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--trace':
        options.tracePath = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--collect-garbage':
        options.mode = 'gc';
        sawCollectGarbage = true;
        break;
      case '--snapshot':
        options.mode = 'snapshot';
        sawSnapshot = true;
        options.snapshotPath = parseNonEmptyString(parseRequiredStringValue(argv, index, token), token);
        index += 1;
        break;
      case '--gc-before':
        options.gcBefore = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Unknown option: ${token}`);
        }
        throw new Error(`Unexpected argument: ${token}`);
    }
  }

  if (options.gcBefore && !sawSnapshot) {
    throw new Error('--gc-before requires --snapshot.');
  }

  if (sawCollectGarbage && sawSnapshot) {
    throw new Error('--collect-garbage cannot be combined with --snapshot.');
  }

  if (options.mode === 'gc' && (
    options.durationMs != null || options.jsonlPath != null || options.csvPath != null
    || options.cpuProfilePath != null || options.tracePath != null
  )) {
    throw new Error('--collect-garbage cannot be combined with duration or recording options.');
  }

  if (options.mode === 'snapshot' && (
    options.durationMs != null || options.jsonlPath != null || options.csvPath != null
    || options.cpuProfilePath != null || options.tracePath != null
  )) {
    throw new Error('--snapshot cannot be combined with duration or recording options.');
  }

  return options;
}

export function normalizeMetrics(metrics, previous, observedAt) {
  const metricMap = new Map((metrics ?? []).map((metric) => [metric?.name, metric?.value]));
  const previousState = extractPreviousState(previous);
  const timestamp = asFiniteNumber(metricMap.get('Timestamp'));
  const taskDuration = asFiniteNumber(metricMap.get('TaskDuration'));
  const jsHeapUsedBytes = asFiniteNumber(metricMap.get('JSHeapUsedSize'));
  const jsHeapTotalBytes = asFiniteNumber(metricMap.get('JSHeapTotalSize'));
  const nodes = asFiniteNumber(metricMap.get('Nodes'));
  const eventListeners = asFiniteNumber(metricMap.get('JSEventListeners'));
  const documents = asFiniteNumber(metricMap.get('Documents'));
  const frames = asFiniteNumber(metricMap.get('Frames'));
  const layoutCount = asFiniteNumber(metricMap.get('LayoutCount'));
  const recalcStyleCount = asFiniteNumber(metricMap.get('RecalcStyleCount'));

  const cpuRate = normalizeDerivedRate(taskDuration, previousState?.taskDuration ?? null, timestamp);
  const layoutsPerSecond = normalizeDerivedRate(layoutCount, previousState?.layoutCount ?? null, timestamp);
  const styleRecalcsPerSecond = normalizeDerivedRate(
    recalcStyleCount,
    previousState?.recalcStyleCount ?? null,
    timestamp,
  );

  const sample = {
    observedAt: observedAt instanceof Date ? new Date(observedAt.getTime()) : new Date(observedAt),
    timestamp,
    cpuPercent: cpuRate == null ? null : cpuRate * 100,
    jsHeapUsedBytes,
    jsHeapTotalBytes,
    nodes,
    eventListeners,
    documents,
    frames,
    layoutsPerSecond,
    styleRecalcsPerSecond,
  };

  return defineSampleState(sample, {
    taskDuration: nextStatePair(taskDuration, previousState?.taskDuration ?? null, timestamp),
    layoutCount: nextStatePair(layoutCount, previousState?.layoutCount ?? null, timestamp),
    recalcStyleCount: nextStatePair(recalcStyleCount, previousState?.recalcStyleCount ?? null, timestamp),
  });
}

// Pad a cell to its column width so rows align: dates left, numbers right.
const padField = (text, field) => (
  field.kind === 'date' ? text.padEnd(field.width) : text.padStart(field.width)
);

export function formatTerminalHeader() {
  return SAMPLE_FIELDS.map((field) => padField(field.label, field)).join(' | ');
}

export function formatTerminalRow(sample) {
  return SAMPLE_FIELDS.map((field) => padField(formatTerminalValue(field, sample), field)).join(' | ');
}

export function serializeJsonl(sample) {
  return `${JSON.stringify(buildSerializableSample(sample))}\n`;
}

export function serializeCsvRow(sample) {
  return SAMPLE_FIELDS.map((field) => formatCsvValue(sample?.[field.key] ?? null)).join(',');
}

const formatMiB = (bytes) => (Number.isFinite(bytes) ? `${(bytes / MiB).toFixed(1)}` : 'N/A');

// Renders the one-line context banner shown above the live table: which page is
// being monitored (`app`) plus static device context (CPU cores, approximate
// RAM, GPU, JS heap limit) from gatherDeviceInfo. Either may be null/absent (e.g.
// under the test doubles); an empty banner is returned when both are.
export function formatDeviceInfo(info, app) {
  const parts = [];
  if (app) parts.push(`App: ${app}`);
  if (info) {
    parts.push(`CPU: ${info.cores ?? 'N/A'} cores`);
    parts.push(`RAM: ${Number.isFinite(info.deviceMemoryGb) ? `~${info.deviceMemoryGb}GB` : 'N/A'}`);
    if (info.gpu) parts.push(`GPU: ${info.gpu}`);
    parts.push(`JS heap limit: ${Number.isFinite(info.jsHeapLimit) ? `${formatMiB(info.jsHeapLimit)} MiB` : 'N/A'}`);
  }
  return parts.join(' | ');
}

// A human label for the resolved CDP page target — on webOS the app id
// (description); otherwise the page title or URL. Most useful when no --app was
// given and the tool fell back to the first inspectable page.
export function formatMonitorTarget(target) {
  if (!target) return null;
  return target.description || target.title || target.url || null;
}

// ---------------------------------------------------------------------------
// Runtime: CDP connection, recording, heap snapshots, and the CLI entry point.
// ---------------------------------------------------------------------------

const HELP_TEXT = `Usage: node scripts/tv-perf.mjs [--app <id>] [options]

Sample a webOS app's performance counters (CPU, JS heap, DOM nodes, listeners)
over the Chrome DevTools Protocol, capture CPU profiles, timeline traces, or
heap snapshots, and force GC.

Options:
  --host <host>          CDP discovery host (default: configured TV device)
  --port <port>          CDP discovery port (default: 9998)
  --url <url>            CDP discovery or direct WebSocket URL
  --app <id>             webOS app id to target (TV DevTools page selection)
  --target <filter>      Page target id, title, description, or URL filter
  --interval <seconds>   Sampling interval in seconds (default: 1)
  --duration <seconds>   Stop after the given duration
  --jsonl <path>         Record samples as JSONL
  --csv <path>           Record samples as CSV
  --cpu-profile <path>   At 80% CPU for 3s, record six 5s .cpuprofile parts
  --trace <path>         At 80% CPU for 3s, record six 5s Chrome Trace parts
  --collect-garbage      Force a garbage collection and exit
  --snapshot <path>      Capture a heap snapshot to <path> and exit
  --gc-before            With --snapshot, force garbage collection first
  --help                 Show this help
`;

const toError = (value) => {
  if (value instanceof Error) return value;
  if (typeof value?.message === 'string' && value.message) return new Error(value.message);
  return new Error(String(value));
};

const monotonicNowMs = () => Number(process.hrtime.bigint()) / 1e6;
const defaultWait = (intervalMs, { signal } = {}) => delay(intervalMs, undefined, { signal });

const writeChunk = async (stream, chunk) => {
  if (!stream.write(chunk)) await once(stream, 'drain');
};

const createStopState = () => {
  const controller = new AbortController();
  let stopped = false;

  return {
    get stopped() {
      return stopped;
    },
    signal: controller.signal,
    stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  };
};

const registerSignalHandlers = (stopState, signalSource) => {
  const listener = () => {
    stopState.stop();
  };

  signalSource.on('SIGINT', listener);
  signalSource.on('SIGTERM', listener);

  return () => {
    signalSource.off('SIGINT', listener);
    signalSource.off('SIGTERM', listener);
  };
};

const waitOrStop = async (intervalMs, stopState, wait = delay) => {
  if (stopState.stopped) return;
  try {
    await wait(intervalMs, { signal: stopState.signal });
  } catch (error) {
    if (
      stopState.stopped &&
      typeof error === 'object' &&
      error &&
      (error.name === 'AbortError' || error.code === 'ABORT_ERR')
    ) {
      return;
    }
    throw error;
  }
};

const closeWritable = async (stream) => {
  if (!stream || stream.destroyed || stream.writableFinished || stream.writableEnded) return;
  stream.end();
  await once(stream, 'finish');
};

// Closing the underlying fd (whether after a graceful 'finish' or after
// destroy()) happens through a real async fs operation, not a microtask —
// so it can still emit a stray 'error' well after 'finish'/'writes' settle.
// Wait for the stream to actually reach 'close' before removing its last
// error listener, or that stray event would crash the process instead of
// being observed.
const waitForStreamClosed = async (stream) => {
  if (!stream || stream.closed) return;
  await once(stream, 'close').catch(() => {});
};

const buildTempSnapshotPath = (destination) => `${destination}.${process.pid}.${Date.now()}.tmp`;

const writeJsonAtomically = async (
  destination,
  value,
  { writeFileImpl = writeFile, renameImpl = rename, rmImpl = rm } = {},
) => {
  const tempPath = buildTempSnapshotPath(destination);
  await mkdir(path.dirname(destination), { recursive: true });

  try {
    await writeFileImpl(tempPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await renameImpl(tempPath, destination);
  } catch (error) {
    await rmImpl(tempPath, { force: true });
    throw error;
  }
};

export async function startCpuProfile(client) {
  await client.call('Profiler.enable');
  await client.call('Profiler.start');
}

export async function stopCpuProfile(client, destination, dependencies = {}) {
  const response = await client.call('Profiler.stop');
  if (response?.profile == null) {
    throw new Error('CDP returned no CPU profile.');
  }
  await writeJsonAtomically(destination, response.profile, dependencies);
}

export function formatCpuProfilePartPath(destination, partNumber) {
  const extension = path.extname(destination);
  const stem = extension ? destination.slice(0, -extension.length) : destination;
  const suffix = String(partNumber).padStart(2, '0');
  return `${stem}.part${suffix}${extension || '.cpuprofile'}`;
}

export async function resolveTraceCategories(client) {
  let categoriesPromise = traceCategoryCache.get(client);
  if (!categoriesPromise) {
    categoriesPromise = client.call('Tracing.getCategories').then((response) => {
      const supported = new Set(response?.categories ?? []);
      const selected = TRACE_CATEGORY_CANDIDATES.filter((category) => supported.has(category));
      if (!selected.length) {
        throw new Error('The target exposes no supported diagnostic trace categories.');
      }
      return selected;
    });
    traceCategoryCache.set(client, categoriesPromise);
  }
  return categoriesPromise;
}

export async function startTrace(client) {
  const categories = await resolveTraceCategories(client);
  const traceEvents = [];
  let maxBufferUsage = 0;
  let resolveComplete;
  const complete = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const unsubscribeData = client.on('Tracing.dataCollected', ({ value }) => {
    if (Array.isArray(value)) traceEvents.push(...value);
  });
  const unsubscribeBufferUsage = client.on('Tracing.bufferUsage', ({ percentFull = 0 }) => {
    maxBufferUsage = Math.max(maxBufferUsage, percentFull);
  });
  const unsubscribeComplete = client.on('Tracing.tracingComplete', resolveComplete);

  try {
    await client.call('Tracing.start', {
      bufferUsageReportingInterval: 1000,
      traceConfig: {
        recordMode: 'recordUntilFull',
        traceBufferSizeInKb: TRACE_BUFFER_SIZE_KB,
        enableSampling: false,
        includedCategories: categories,
      },
    });
  } catch (error) {
    unsubscribeData();
    unsubscribeBufferUsage();
    unsubscribeComplete();
    throw error;
  }

  return {
    traceEvents,
    categories,
    complete,
    get maxBufferUsage() {
      return maxBufferUsage;
    },
    close() {
      unsubscribeData();
      unsubscribeBufferUsage();
      unsubscribeComplete();
    },
  };
}

export async function stopTrace(client, session, destination, dependencies = {}) {
  try {
    await client.call('Tracing.end');
    const completion = await session.complete;
    await writeJsonAtomically(destination, {
      traceEvents: session.traceEvents,
      displayTimeUnit: 'ms',
      tvPerf: {
        bufferSizeKb: TRACE_BUFFER_SIZE_KB,
        categories: session.categories,
        maxBufferUsage: session.maxBufferUsage,
        dataLossOccurred: completion?.dataLossOccurred ?? false,
      },
    }, dependencies);
  } finally {
    session.close();
  }
}

// Attaches the persistent 'error' listener synchronously, in the same tick the
// stream is created, so there is never a tick where the stream can emit
// 'error' with zero listeners (which would crash the process). The 'open'
// race uses its own once()-scoped listeners layered on top; only the
// returned `detach()` removes the persistent one, once its caller is done
// with the stream.
const openExclusiveWriteStream = (filePath, { createWriteStreamImpl = createWriteStream } = {}) => {
  const stream = createWriteStreamImpl(filePath, { flags: 'wx' });
  const state = { error: null };
  const onStreamError = (error) => {
    if (!state.error) state.error = toError(error);
  };
  stream.on('error', onStreamError);

  const opened = new Promise((resolve, reject) => {
    const onOpen = () => {
      stream.off('error', onOpenError);
      resolve();
    };
    const onOpenError = (error) => {
      stream.off('open', onOpen);
      reject(toError(error));
    };
    stream.once('open', onOpen);
    stream.once('error', onOpenError);
  });

  return opened.then(
    () => ({ stream, state, detach: () => stream.off('error', onStreamError) }),
    (error) => {
      stream.off('error', onStreamError);
      throw error;
    },
  );
};

export async function collectGarbage(client) {
  await client.call('HeapProfiler.enable');
  await client.call('HeapProfiler.collectGarbage');
}

export async function takeHeapSnapshot(client, destination, { gcBefore = false } = {}, dependencies = {}) {
  const tempPath = buildTempSnapshotPath(destination);
  let stream = null;
  let streamState = { error: null };
  let detachStreamError = null;
  let unsubscribe = null;
  let aborted = false;
  let writes = Promise.resolve();

  try {
    ({ stream, state: streamState, detach: detachStreamError } = await openExclusiveWriteStream(
      tempPath,
      dependencies,
    ));

    await client.call('HeapProfiler.enable');
    if (gcBefore) {
      await client.call('HeapProfiler.collectGarbage');
    }

    unsubscribe = client.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
      writes = writes.then(async () => {
        // Once the snapshot is being aborted, stop touching the stream:
        // queued chunks are dropped instead of writing into a destroyed
        // stream, which is what the drained `writes` chain observes below.
        if (aborted) return;
        if (streamState.error) throw streamState.error;
        await writeChunk(stream, chunk);
      });
    });

    await client.call('HeapProfiler.takeHeapSnapshot');
    await writes;
    if (streamState.error) throw streamState.error;

    unsubscribe();
    unsubscribe = null;
    await closeWritable(stream);
    if (streamState.error) throw streamState.error;

    await waitForStreamClosed(stream);
    detachStreamError();
    detachStreamError = null;
    await rename(tempPath, destination);
  } catch (error) {
    aborted = true;
    // Unsubscribe first so no further chunks are queued onto `writes`.
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }

    const abortError = toError(streamState.error ?? error);
    // Destroy with the concrete error so any write already in flight (e.g.
    // blocked awaiting 'drain') rejects immediately instead of hanging.
    stream?.destroy(abortError);
    client.close();

    // Drain the queued chunk-write chain here, deterministically, so a
    // rejection caused by the abort (or any write still in flight) is
    // observed now instead of surfacing later as an unhandled rejection.
    await writes.catch(() => {});

    // Only detach once the stream has actually finished closing: closing
    // the fd is a real async operation, so a stray 'error' can still land
    // after `writes` settles, and removing the last listener too early
    // would turn that into an unhandled 'error' event crash instead.
    await waitForStreamClosed(stream);
    if (detachStreamError) {
      detachStreamError();
      detachStreamError = null;
    }

    await rm(tempPath, { force: true });
    throw abortError;
  }
}

const runWithSignalAbort = async (options, dependencies, action) => {
  const signalSource = dependencies.signalSource ?? process;
  let client = null;
  const onSignal = () => {
    client?.close();
  };

  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);

  try {
    ({ client } = await connectClient(options, dependencies));
    await action(client);
  } finally {
    signalSource.off('SIGINT', onSignal);
    signalSource.off('SIGTERM', onSignal);
    client?.close();
  }
};

const createRecorder = async (filePath, { createWriteStreamImpl = createWriteStream } = {}) => {
  if (!filePath) return null;

  await mkdir(path.dirname(filePath), { recursive: true });
  const stream = createWriteStreamImpl(filePath, { encoding: 'utf8' });
  let streamError = null;
  stream.on('error', (error) => {
    streamError = toError(error);
  });
  await once(stream, 'open');

  return {
    stream,
    get error() {
      return streamError;
    },
    async write(chunk) {
      if (streamError) throw streamError;
      await writeChunk(stream, chunk);
      if (streamError) throw streamError;
    },
    async close() {
      if (streamError && stream.destroyed) throw streamError;
      await closeWritable(stream);
      if (streamError) throw streamError;
    },
  };
};

const closeRecorders = async (recorders) => {
  const settled = await Promise.allSettled(recorders.filter(Boolean).map((recorder) => recorder.close()));
  const rejection = settled.find((result) => result.status === 'rejected');
  if (rejection) throw rejection.reason;
};

const openRecorders = async (options, dependencies) => {
  const recorders = [];

  try {
    const jsonl = await createRecorder(options.jsonlPath, dependencies);
    if (jsonl) recorders.push(jsonl);

    const csv = await createRecorder(options.csvPath, dependencies);
    if (csv) {
      recorders.push(csv);
      await csv.write(`${CSV_HEADER}\n`);
    }

    return { jsonl, csv, all: recorders };
  } catch (error) {
    await Promise.allSettled(recorders.map((recorder) => recorder.close()));
    throw error;
  }
};

// Read slowly-changing device context (CPU cores, approximate RAM, GPU, and the
// JS heap used/limit) from the page over CDP. Only what CDP/JS actually exposes
// on webOS — CPU model/frequency and exact total RAM are not reachable this way.
const DEVICE_INFO_EXPRESSION = `(() => {
  const m = (typeof performance !== 'undefined' && performance.memory) || {};
  const info = {
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    jsHeapLimit: m.jsHeapSizeLimit ?? null,
    gpu: null,
  };
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      info.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
  } catch {}
  return JSON.stringify(info);
})()`;

const gatherDeviceInfo = async (client) => {
  try {
    const response = await client.call('Runtime.evaluate', {
      expression: DEVICE_INFO_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = response?.result?.value;
    return typeof value === 'string' ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const createRenderer = async (output) => {
  const header = formatTerminalHeader();
  const isTty = Boolean(output?.isTTY);
  let cursorHidden = false;
  let headerWritten = false;
  let banner = '';

  if (isTty) {
    await writeChunk(output, '\u001B[?25l');
    cursorHidden = true;
  }

  return {
    // Set a static banner drawn above the table; folded into the redrawn frame
    // so it survives the tty screen-clear, and emitted once in non-tty output.
    setBanner(text) {
      banner = text ? `${text}\n` : '';
    },
    async render(sample) {
      const row = formatTerminalRow(sample);
      if (isTty) {
        await writeChunk(output, `\u001B[2J\u001B[H${banner}${header}\n${row}`);
        return;
      }

      if (!headerWritten) {
        await writeChunk(output, `${banner}${header}\n`);
        headerWritten = true;
      }
      await writeChunk(output, `${row}\n`);
    },
    async close() {
      if (cursorHidden) {
        await writeChunk(output, '\u001B[?25h\n');
      }
    },
  };
};

const connectClient = async (
  options,
  { fetchImpl, WebSocketImpl, resolveDeviceIp = resolveConfiguredDeviceIp } = {},
) => {
  let resolved;
  let host = options.host;
  try {
    // With neither --host nor --url, fall back to the configured TV device IP
    // (ares-setup-device), mirroring tv-logs.mjs / tv-eval.mjs.
    if (!host && !options.url) {
      try {
        host = resolveDeviceIp();
      } catch (error) {
        throw normalizeDeviceConfigurationError(error);
      }
    }
    resolved = await resolveCdpTarget({
      url: options.url,
      host,
      port: options.port,
      target: options.target,
      targetSelection: options.targetSelection,
      fetchImpl,
    });
  } catch (error) {
    throw error;
  }

  try {
    const client = await CdpClient.connect(resolved.wsUrl, { WebSocketImpl });
    return { client, target: resolved.target };
  } catch (error) {
    throw error;
  }
};

export async function runMonitor(options, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const signalSource = dependencies.signalSource ?? process;
  const wait = dependencies.wait ?? defaultWait;
  const nowMs = dependencies.nowMs ?? monotonicNowMs;
  const stopState = createStopState();
  const startedAt = nowMs();
  const deadlineAt = options.durationMs != null ? startedAt + options.durationMs : null;
  let recorders = { jsonl: null, csv: null, all: [] };
  let renderer = null;
  let removeSignalHandlers = () => {};
  let client = null;
  let cpuProfilerStarted = false;
  let traceSession = null;
  let captureTriggered = false;
  let capturePartNumber = 0;
  const cpuProfilePaths = [];
  const tracePaths = [];
  let captureDeadlineAt = null;
  let consecutiveHighCpuSamples = 0;
  let previousSample = null;
  let firstError = null;

  const rememberError = (error) => {
    if (!firstError) {
      firstError = toError(error);
    }
  };

  const captureStarted = () => cpuProfilerStarted || traceSession != null;

  const startCapturePart = async () => {
    if (options.cpuProfilePath) {
      await startCpuProfile(client);
      cpuProfilerStarted = true;
    }
    if (options.tracePath) {
      traceSession = await startTrace(client);
    }
    captureDeadlineAt = nowMs() + CPU_PROFILE_PART_DURATION_MS;
  };

  const finishCapturePart = async () => {
    if (!captureStarted()) return;
    capturePartNumber += 1;
    let captureError = null;

    if (cpuProfilerStarted) {
      cpuProfilerStarted = false;
      const destination = formatCpuProfilePartPath(options.cpuProfilePath, capturePartNumber);
      try {
        await stopCpuProfile(client, destination, dependencies);
        cpuProfilePaths.push(destination);
      } catch (error) {
        captureError = error;
      }
    }

    if (traceSession) {
      const activeTraceSession = traceSession;
      traceSession = null;
      const destination = formatCpuProfilePartPath(options.tracePath, capturePartNumber);
      try {
        await stopTrace(client, activeTraceSession, destination, dependencies);
        tracePaths.push(destination);
      } catch (error) {
        if (!captureError) captureError = error;
      }
    }

    if (captureError) throw captureError;
  };

  try {
    recorders = await openRecorders(options, dependencies);
    renderer = await createRenderer(stdout);
    removeSignalHandlers = registerSignalHandlers(stopState, signalSource);
    let target;
    ({ client, target } = await connectClient(options, dependencies));
    await client.call('Performance.enable');
    renderer.setBanner(formatDeviceInfo(await gatherDeviceInfo(client), formatMonitorTarget(target)));

    while (!stopState.stopped) {
      if (captureStarted() && nowMs() >= captureDeadlineAt) {
        await finishCapturePart();
        if (capturePartNumber >= CPU_PROFILE_PART_COUNT) {
          break;
        }
        await startCapturePart();
      }
      if (!captureStarted() && deadlineAt != null && nowMs() >= deadlineAt) {
        break;
      }

      const metrics = await client.call('Performance.getMetrics');
      const sample = normalizeMetrics(metrics.metrics, previousSample, new Date());
      previousSample = sample;

      await renderer.render(sample);
      if (recorders.jsonl) {
        await recorders.jsonl.write(serializeJsonl(sample));
      }
      if (recorders.csv) {
        await recorders.csv.write(`${serializeCsvRow(sample)}\n`);
      }

      if ((options.cpuProfilePath || options.tracePath) && !captureTriggered) {
        if (sample.cpuPercent != null && sample.cpuPercent >= CPU_PROFILE_THRESHOLD_PERCENT) {
          consecutiveHighCpuSamples += 1;
        } else {
          consecutiveHighCpuSamples = 0;
        }

        const requiredSamples = Math.max(1, Math.ceil(CPU_PROFILE_TRIGGER_MS / options.intervalMs));
        if (consecutiveHighCpuSamples >= requiredSamples) {
          await startCapturePart();
          captureTriggered = true;
        }
      }

      const activeDeadlineAt = captureStarted() ? captureDeadlineAt : deadlineAt;
      if (activeDeadlineAt != null) {
        const remainingMs = activeDeadlineAt - nowMs();
        if (remainingMs <= 0) {
          continue;
        }

        await waitOrStop(Math.min(options.intervalMs, remainingMs), stopState, wait);
        continue;
      }

      if (stopState.stopped) {
        break;
      }

      await waitOrStop(options.intervalMs, stopState, wait);
    }
  } catch (error) {
    rememberError(error);
  } finally {
    removeSignalHandlers();

    try {
      await finishCapturePart();
    } catch (error) {
      rememberError(error);
    }

    try {
      client?.close();
    } catch (error) {
      rememberError(error);
    }

    try {
      await closeRecorders(recorders.all);
    } catch (error) {
      rememberError(error);
    }

    try {
      await renderer?.close();
    } catch (error) {
      rememberError(error);
    }
  }

  if (firstError) throw firstError;
  return { captureTriggered, cpuProfilePaths, tracePaths };
}

export async function main(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  let options;
  try {
    options = parsePerformanceArgs(argv);
  } catch (error) {
    await writeChunk(stderr, `tv-perf: ${toError(error).message}\n`);
    return 2;
  }

  if (options.help) {
    await writeChunk(stdout, HELP_TEXT);
    return 0;
  }

  if (options.mode === 'gc') {
    try {
      await runWithSignalAbort(options, dependencies, (client) => collectGarbage(client));
      await writeChunk(stdout, 'Garbage collection complete\n');
      return 0;
    } catch (error) {
      await writeChunk(stderr, `tv-perf: ${toError(error).message}\n`);
      return 1;
    }
  }

  if (options.mode === 'snapshot') {
    try {
      await runWithSignalAbort(options, dependencies, (client) =>
        takeHeapSnapshot(client, options.snapshotPath, { gcBefore: options.gcBefore }));
      await writeChunk(stdout, `Heap snapshot written to ${options.snapshotPath}\n`);
      return 0;
    } catch (error) {
      await writeChunk(stderr, `tv-perf: ${toError(error).message}\n`);
      return 1;
    }
  }

  try {
    const result = await runMonitor(options, dependencies);
    if (options.cpuProfilePath) {
      const message = result.cpuProfilePaths.length
        ? `CPU profile parts written:\n${result.cpuProfilePaths.map((filePath) => `  ${filePath}`).join('\n')}\n`
        : `CPU stayed below ${CPU_PROFILE_THRESHOLD_PERCENT}% for the trigger window; no profile written\n`;
      await writeChunk(stdout, message);
    }
    if (options.tracePath) {
      const message = result.tracePaths.length
        ? `Trace parts written:\n${result.tracePaths.map((filePath) => `  ${filePath}`).join('\n')}\n`
        : `CPU stayed below ${CPU_PROFILE_THRESHOLD_PERCENT}% for the trigger window; no trace written\n`;
      await writeChunk(stdout, message);
    }
    return 0;
  } catch (error) {
    await writeChunk(stderr, `tv-perf: ${toError(error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
