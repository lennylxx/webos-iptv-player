#!/usr/bin/env node
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  CdpClient,
  inspectorWebSocketUrl,
  resolveCdpTarget,
  startAresInspector,
} from './cdp-client.mjs';
import {
  enableCdpLogs,
  isLegacyCdpEngine,
  normalizeCdpLogEvent,
  subscribeCdpLogs,
} from './cdp-logs.mjs';
import { formatOptions, parseArgs } from './cli-args.mjs';

const DEFAULT_APP_ID = 'com.lennylxx.iptv';
const DEFAULT_PORT = 9998;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DURATION_MS = 15000;

export const DIAGNOSTIC_SPEC = {
  maxPositionals: 0,
  options: {
    app: {
      type: 'string',
      default: DEFAULT_APP_ID,
      valueName: '<id>',
      description: 'webOS app id',
    },
    device: {
      type: 'string',
      valueName: '<name>',
      description: 'Configured TV device (default: default device)',
    },
    host: {
      type: 'string',
      default: '',
      valueName: '<host>',
      description: 'Existing CDP discovery host instead of ares-inspect',
    },
    port: {
      type: 'integer',
      min: 1,
      max: 65535,
      default: DEFAULT_PORT,
      valueName: '<port>',
      description: 'CDP discovery port with --host',
    },
    timeout: {
      type: 'number',
      positive: true,
      default: DEFAULT_TIMEOUT_MS / 1000,
      valueName: '<seconds>',
      description: 'App/inspector startup timeout',
    },
    'play-channel': {
      type: 'integer',
      min: 0,
      default: null,
      valueName: '<index>',
      description: 'Cold-start, then activate the rendered channel index',
    },
    attach: {
      type: 'boolean',
      default: false,
      description: 'Observe the running app without close, reload, or input',
    },
    duration: {
      type: 'number',
      min: 1,
      max: 3600,
      default: DEFAULT_DURATION_MS / 1000,
      valueName: '<seconds>',
      description: 'Playback/native metric window',
    },
    output: {
      type: 'string',
      default: '',
      valueName: '<path>',
      description: 'JSON report path (default: timestamped filename)',
    },
    full: {
      type: 'boolean',
      default: false,
      description: 'Disable redaction; the report may contain secrets',
    },
    summary: {
      type: 'string',
      default: '',
      valueName: '<path>',
      description: 'Print a readable summary of an existing JSON report',
    },
    help: { type: 'boolean', short: 'h', default: false, description: 'Show this help' },
  },
};

export const DIAGNOSTIC_HELP = `Usage: scripts/tv.sh diag [options]

Capture a redacted TV diagnostics report with CDP logs, network activity,
playlist probes, diagnostic events, remote-control input, media state, and
optional native metrics.

${formatOptions(DIAGNOSTIC_SPEC)}

--duration requires --attach or --play-channel. Those two modes cannot be
combined. Reports stay local and are never uploaded.`;

const PREVIEW_BYTES = 2048;
const SERVICE_LOG_LINES = 500;
// Mirrors serviceLogDir() in bundled-service/src/service-log.ts.
const SERVICE_LOG_TEMP_ROOT = [
  'node_major=$(node -e \'process.stdout.write(process.versions.node.split(".")[0])\')',
  'if [ "$node_major" -ge 20 ]; then temp_root=/media/developer/temp; else temp_root=/tmp; fi',
].join('; ');
const NO_SERVICE_LOG = '__IPTV_NO_SERVICE_LOG__';
const PLAYLIST_PROBE_TIMEOUT_MS = 5000;
const SINGLE_CONNECTION_SKIP_REASON = 'xtream-max-connections-at-most-one';
const SAFE_QUERY_VALUES = new Set([
  'action',
  'category_id',
  'output',
  'output_format',
  'series_id',
  'stream_id',
  'type',
  'vod_id',
]);
const SAFE_PATH_SEGMENTS = new Set([
  'catchup',
  'get.php',
  'live',
  'movie',
  'playlist.m3u',
  'playlist.m3u8',
  'epg.xml',
  'play',
  'player_api.php',
  'series',
  'uploads',
  'xmltv.php',
]);

const toErrorMessage = (value) => {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return String(value);
};

export function parseDiagnosticArgs(argv = []) {
  const { values, seen } = parseArgs(argv, DIAGNOSTIC_SPEC);
  const options = {
    appId: values.app,
    device: values.device ?? (process.env.TV_DEVICE || ''),
    host: values.host,
    port: values.port,
    timeoutMs: values.timeout * 1000,
    durationMs: values.duration * 1000,
    durationSpecified: seen.includes('duration'),
    attach: values.attach,
    playChannel: values['play-channel'],
    outputPath: values.output,
    full: values.full,
    summaryPath: values.summary,
    help: values.help,
  };
  if (!Number.isInteger(options.durationMs)) {
    throw new Error('Invalid value for --duration.');
  }
  if (options.attach && options.playChannel !== null) {
    throw new Error('--attach cannot be combined with --play-channel.');
  }
  if (options.durationSpecified && !options.attach && options.playChannel === null) {
    throw new Error('--duration requires --attach or --play-channel.');
  }
  return options;
}

function valueSummary(value) {
  const text = String(value);
  let kind = 'alnum';
  if (/[^\x00-\x7f]/.test(text)) kind = 'nonascii';
  else if (/\s/.test(text)) kind = 'space';
  else if (!/^[a-z0-9]*$/i.test(text)) kind = 'mixed';
  return `~redacted-${String(text.length)}-${kind}~`;
}

function urlPathSecrets(value) {
  try {
    const parsed = new URL(String(value));
    const values = [parsed.username, parsed.password];
    for (const segment of parsed.pathname.split('/').filter(Boolean)) {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch {}
      if (!SAFE_PATH_SEGMENTS.has(decoded.toLowerCase())
          && !/^\d+(?:\.[a-z0-9]+)?$/i.test(decoded)) {
        values.push(decoded);
      }
    }
    return values.filter(Boolean);
  } catch {
    return [];
  }
}

export class DiagnosticRedactor {
  constructor({ full = false, secrets = [] } = {}) {
    this.full = full;
    this.secrets = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret))];
    this.hosts = new Map();
  }

  host(value) {
    if (this.full || !value) return value;
    if (!this.hosts.has(value)) {
      this.hosts.set(value, `<host-${String.fromCharCode(97 + this.hosts.size)}>`);
    }
    return this.hosts.get(value);
  }

  url(value) {
    if (this.full) return String(value);
    try {
      const parsed = new URL(String(value));
      const originalHost = parsed.hostname;
      const safeHost = this.host(originalHost);
      parsed.hostname = 'redacted.invalid';
      if (parsed.username) parsed.username = valueSummary(parsed.username);
      if (parsed.password) parsed.password = valueSummary(parsed.password);
      const redactPath = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      const segments = parsed.pathname.split('/').map((segment) => {
        let decoded = segment;
        try { decoded = decodeURIComponent(segment); } catch {}
        if (!decoded
            || !redactPath
            || SAFE_PATH_SEGMENTS.has(decoded.toLowerCase())
            || /^\d+(?:\.[a-z0-9]+)?$/i.test(decoded)) {
          return segment;
        }
        return valueSummary(decoded);
      });
      parsed.pathname = segments.join('/');
      for (const [key, queryValue] of [...parsed.searchParams.entries()]) {
        if (!SAFE_QUERY_VALUES.has(key)) parsed.searchParams.set(key, valueSummary(queryValue));
      }
      parsed.hash = '';
      return parsed.toString().replace('redacted.invalid', safeHost);
    } catch {
      return this.text(value);
    }
  }

  text(value) {
    if (this.full) return String(value);
    let text = String(value);
    // A secret counts only as a whole token, so a short path segment cannot
    // eat letters out of ordinary words.
    for (const secret of this.secrets) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g'),
        () => valueSummary(secret));
    }
    text = text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => this.url(url));
    for (const [host, replacement] of this.hosts) {
      text = text.split(host).join(replacement);
    }
    return text
      .replace(/\b(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, '$1[redacted]')
      .replace(/(["']?(?:username|password|token|api[_-]?key|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[redacted]');
  }
}

const selectedHeaders = (headers = {}) => {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (['content-length', 'content-type', 'location', 'server'].includes(normalized)) {
      result[normalized] = value;
    }
  }
  return result;
};

export function normalizeNetworkRecords(events, redactor) {
  const records = new Map();
  for (const event of events) {
    const params = event.params ?? {};
    const requestId = params.requestId;
    if (!requestId) continue;
    const existing = records.get(requestId) ?? {
      requestId,
      startedAt: event.observedAt,
      method: '',
      url: '',
      status: null,
      headers: {},
      encodedBytes: null,
      error: '',
      blockedReason: '',
    };
    if (event.method === 'Network.requestWillBeSent') {
      existing.method = params.request?.method ?? '';
      existing.url = redactor.url(params.request?.url ?? '');
      if (params.redirectResponse) {
        existing.redirectStatus = params.redirectResponse.status ?? null;
      }
    } else if (event.method === 'Network.responseReceived') {
      existing.status = params.response?.status ?? null;
      existing.url = redactor.url(params.response?.url ?? existing.url);
      existing.mimeType = params.response?.mimeType ?? '';
      existing.headers = Object.fromEntries(
        Object.entries(selectedHeaders(params.response?.headers))
          .map(([key, value]) => [key, redactor.text(value)]),
      );
    } else if (event.method === 'Network.loadingFinished') {
      existing.encodedBytes = params.encodedDataLength ?? null;
      existing.finishedAt = event.observedAt;
    } else if (event.method === 'Network.loadingFailed') {
      existing.error = redactor.text(params.errorText ?? '');
      existing.blockedReason = params.blockedReason ?? params.corsErrorStatus?.corsError ?? '';
      existing.finishedAt = event.observedAt;
    }
    if (existing.finishedAt) {
      existing.durationMs = Math.max(
        0,
        Date.parse(existing.finishedAt) - Date.parse(existing.startedAt),
      );
    }
    records.set(requestId, existing);
  }
  return [...records.values()];
}

// JSON-quoted messages are evidence, not structured diagnostic fields.
const QUOTED_TEXT = /"(?:\\[\s\S]|[^"\\])*(?:"|$)/g;
const SUMMARY_FIELDS_MAX = 240;

// Blank quoted text with spaces so match indexes still line up with the original.
const unquoted = (text) => text.replace(QUOTED_TEXT, (quoted) => ' '.repeat(quoted.length));

function findEvent(text) {
  const match = unquoted(text).match(/\bevent=([a-z0-9_.-]+)/i);
  if (!match) return null;
  return { name: match[1], fields: text.slice(match.index + match[0].length).trim() };
}

export const eventField = (text, key) => unquoted(text ?? '')
  .match(new RegExp(`\\b${key}=([a-z0-9_.-]+)`, 'i'))?.[1] ?? null;

function extractEvents(logs, accept, nameKey) {
  const timeline = [];
  for (const entry of logs) {
    const found = findEvent(entry.text);
    if (!found || !accept(found.name)) continue;
    timeline.push({
      observedAt: entry.observedAt,
      [nameKey]: found.name,
      level: entry.level,
      text: entry.text,
    });
  }
  return timeline;
}

// Input events get their own timeline: one line per press would bury the
// playback/EPG events this list exists for.
export const extractDiagnosticTimeline = (logs) =>
  extractEvents(logs, (name) => !name.startsWith('key.'), 'code');

export const extractXtreamTimeline = (logs) =>
  extractEvents(logs, (name) => name.startsWith('xtream.'), 'event');

export const extractInputTimeline = (logs) =>
  extractEvents(logs, (name) => name.startsWith('key.'), 'event');

export function assembleDiagnosticReport({
  capturedAt,
  full,
  capture = { complete: true, phase: 'complete', error: '' },
  app,
  environment,
  probe,
  native,
  nativeMetrics = null,
  serviceLog = null,
  logs,
  networkEvents,
}) {
  const secrets = (probe?.playlists ?? []).flatMap((playlist) => [
    ...(playlist.__secrets ?? []),
    ...urlPathSecrets(playlist.__url),
  ]);
  const redactor = new DiagnosticRedactor({ full, secrets });
  const bodyPreview = (value) => {
    const text = String(value ?? '');
    if (full) return text;
    const trimmed = text.trim();
    if (!trimmed) return '';
    const lines = trimmed.split(/\r?\n/).length;
    if (/^#EXTM3U\b/i.test(trimmed)) return `#EXTM3U <${String(lines - 1)} preview lines redacted>`;
    if (/^(?:<\?xml\b|<tv\b)/i.test(trimmed)) {
      return `<XML preview redacted chars=${String(trimmed.length)}>`;
    }
    if (/^[{[]/.test(trimmed)) return `<JSON preview redacted chars=${String(trimmed.length)}>`;
    return `<body preview redacted chars=${String(trimmed.length)}>`;
  };
  const playlists = (probe?.playlists ?? []).map((playlist, index) => ({
    index,
    source: playlist.source,
    name: redactor.text(playlist.name),
    url: redactor.url(playlist.__url),
    webview: {
      status: playlist.webview?.status ?? null,
      contentType: playlist.webview?.contentType ?? '',
      contentLength: playlist.webview?.contentLength ?? '',
      bodyPreview: bodyPreview(playlist.webview?.bodyPreview),
      error: redactor.text(playlist.webview?.error ?? ''),
      skipped: playlist.webview?.skipped ?? false,
      skipReason: playlist.webview?.skipReason ?? '',
    },
    xtreamAuth: playlist.xtreamAuth ? {
      ...playlist.xtreamAuth,
      error: redactor.text(playlist.xtreamAuth.error ?? ''),
    } : null,
    native: native[index] ? {
      status: native[index].status,
      contentType: native[index].contentType,
      bodyPreview: bodyPreview(native[index].bodyPreview),
      error: redactor.text(native[index].error),
      skipped: native[index].skipped ?? false,
      skipReason: native[index].skipReason ?? '',
    } : null,
  }));
  const safeLogs = logs.map((entry) => ({ ...entry, text: redactor.text(entry.text) }));
  const safeNativeMetrics = nativeMetrics ? {
    ...nativeMetrics,
    oomEvents: (nativeMetrics.oomEvents ?? []).map((event) => redactor.text(event)),
  } : null;
  const probeState = probe?.state ?? {};
  const media = probeState.media ? {
    ...probeState.media,
    src: redactor.url(probeState.media.src ?? ''),
    sources: (probeState.media.sources ?? []).map((source) => ({
      ...source,
      src: redactor.url(source.src ?? ''),
    })),
    error: probeState.media.error ? {
      ...probeState.media.error,
      message: redactor.text(probeState.media.error.message ?? ''),
    } : null,
  } : null;
  return {
    schemaVersion: 5,
    capturedAt,
    redacted: !full,
    capture,
    app,
    environment,
    state: { ...probeState, media },
    storage: probe?.storage ?? {},
    nativeMetrics: safeNativeMetrics,
    playlists,
    diagnostics: extractDiagnosticTimeline(safeLogs),
    input: extractInputTimeline(safeLogs),
    xtream: extractXtreamTimeline(safeLogs),
    logs: safeLogs,
    serviceLog: serviceLog ? {
      lines: serviceLog.lines.map((line) => redactor.text(line)),
      error: redactor.text(serviceLog.error),
    } : null,
    network: normalizeNetworkRecords(networkEvents, redactor),
  };
}

export function formatDiagnosticSummary(report) {
  const outcome = (result, fallback) => {
    if (result?.status != null) return String(result.status);
    const error = String(result?.error || fallback);
    const firstLine = error.split(/\r?\n/)[0];
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  };
  const state = report.state ?? {};
  const countText = (value) => (value == null ? '?' : String(value));
  const loads = (report.diagnostics ?? [])
    .filter((event) => event.code === 'playlist.load.completed');
  const lastLoad = loads.length ? loads[loads.length - 1].text : '';
  const loadSource = eventField(lastLoad, 'source');
  const lines = [
    `Diagnostics captured: ${report.capturedAt}`,
    ...report.capture?.complete === false
      ? [`Capture: incomplete at ${report.capture.phase || 'unknown'}`
        + ` (${report.capture.error || 'unknown error'})`]
      : [],
    `App: ${report.app?.id ?? '?'} ${report.app?.version ?? '?'}`,
    `Environment: ${report.environment?.userAgent ?? '?'}`,
    `State: ${state.view ?? '?'} | channels=${countText(eventField(lastLoad, 'channels'))}`
    + `${loadSource ? ` (${loadSource})` : ''}`
    + ` rendered=${countText(state.channelsRendered ?? state.channels)}`,
    `Playlists: ${String(report.playlists?.length ?? 0)}`,
  ];
  if (report.state?.media) {
    const media = report.state.media;
    lines.push(
      `Media: ${media.paused ? 'paused' : 'playing'} | ready=${String(media.readyState)}`
      + ` network=${String(media.networkState)} time=${String(media.currentTime)}s`
      + `${media.playbackRate != null && media.playbackRate !== 1
        ? ` rate=${String(media.playbackRate)}` : ''}`,
    );
    for (const source of media.sources ?? []) {
      const verdict = source.canPlayType
        ? `canPlayType=${source.canPlayType}`
        : 'canPlayType="" — source skipped without an error event';
      lines.push(`Media source: type=${source.type || '(none)'} ${verdict}`);
    }
  }
  const codecSupport = state.codecSupport ?? null;
  if (codecSupport) {
    const types = Object.keys(codecSupport);
    const rejected = types.filter((type) => !codecSupport[type]);
    lines.push(
      `Codec support: ${String(types.length - rejected.length)}/${String(types.length)} playable`
      + `${rejected.length ? ` | rejected: ${rejected.join(', ')}` : ''}`,
    );
  }
  if (report.nativeMetrics?.error) {
    lines.push(`Native metrics: unavailable (${report.nativeMetrics.error})`);
  } else if (report.nativeMetrics) {
    const metrics = report.nativeMetrics;
    lines.push(
      `System native window: ${String(metrics.durationMs / 1000)}s`
      + ` | rx=${String(metrics.network?.rxBytes ?? '?')}B`
      + ` tx=${String(metrics.network?.txBytes ?? '?')}B`
      + ` retrans=${String(metrics.tcpRetransmits ?? '?')}`,
    );
    lines.push(
      `System pressure: cpu=${String(metrics.pressure?.cpu?.stallMs ?? '?')}ms`
      + ` memory=${String(metrics.pressure?.memory?.stallMs ?? '?')}ms`
      + ` io=${String(metrics.pressure?.io?.stallMs ?? '?')}ms`,
    );
    if (metrics.memory) {
      lines.push(
        `System memory: total=${String(metrics.memory.totalKb ?? '?')}KiB`
        + ` used=${String(metrics.memory.usedBeforeKb ?? '?')}KiB`
        + ` -> ${String(metrics.memory.usedAfterKb ?? '?')}KiB`
        + ` max=${String(metrics.memory.maximumUsedKb ?? '?')}KiB`
        + ` | available=${String(metrics.memory.availableBeforeKb ?? '?')}KiB`
        + ` -> ${String(metrics.memory.availableAfterKb ?? '?')}KiB`
        + ` min=${String(metrics.memory.minimumAvailableKb ?? '?')}KiB`
        + ` | swap min=${String(metrics.memory.minimumSwapFreeKb ?? '?')}KiB`,
      );
    }
    if (metrics.appMemory) {
      lines.push(
        `IPTV web app memory: rss=${String(metrics.appMemory.rssBeforeKb ?? '?')}KiB`
        + ` -> ${String(metrics.appMemory.rssAfterKb ?? '?')}KiB`
        + ` peak=${String(metrics.appMemory.peakObservedRssKb ?? '?')}KiB`
        + ` lifetime-hwm=${String(metrics.appMemory.lifetimeHighWaterKb ?? '?')}KiB`
        + ` swap=${String(metrics.appMemory.swapAfterKb ?? '?')}KiB`
        + ` system=${String(metrics.appMemory.percentOfSystemAtPeak ?? '?')}%`,
      );
    }
    if (metrics.memoryManager) {
      lines.push(
        `webOS memory manager: ${metrics.memoryManager.available ? 'available' : 'unavailable'}`
        + ` | level=${metrics.memoryManager.levelBefore || '?'}`
        + ` -> ${metrics.memoryManager.levelAfter || '?'}`
        + ` usable=${String(metrics.memoryManager.usableBeforeMb ?? '?')}MB`
        + ` -> ${String(metrics.memoryManager.usableAfterMb ?? '?')}MB`
        + ` min=${String(metrics.memoryManager.minimumUsableMb ?? '?')}MB`,
      );
    }
    for (const process of metrics.processes ?? []) {
      lines.push(
        `- ${process.kind} pid=${String(process.pid)}`
        + ` cpu=${process.cpuPercent == null ? '?' : process.cpuPercent.toFixed(1)}%`
        + ` rss=${process.rssKb == null ? '?' : (process.rssKb / 1024).toFixed(1)}MiB`
        + ` peak=${process.peakRssKb == null ? '?' : (process.peakRssKb / 1024).toFixed(1)}MiB`
        + ` threads=${String(process.threads ?? '?')}`
        + ` oom_score=${String(process.oomScore ?? '?')}`
        + ` wait=${process.schedulerWaitMs == null ? '?' : process.schedulerWaitMs.toFixed(1)}ms`
        + `${process.startedDuringWindow ? ' new' : ''}`,
      );
    }
    for (const process of metrics.stoppedProcesses ?? []) {
      lines.push(
        `- stopped ${process.kind} pid=${String(process.pid)}`
        + ` initial=${process.initialRssKb == null
          ? '?' : (process.initialRssKb / 1024).toFixed(1)}MiB`
        + ` peak=${process.peakRssKb == null ? '?' : (process.peakRssKb / 1024).toFixed(1)}MiB`
        + ` oom_score=${String(process.initialOomScore ?? '?')}`,
      );
    }
    lines.push(
      `OOM events: ${String(metrics.oomEvents?.length ?? 0)}`
      + `${metrics.oomLogAvailable ? '' : ' (kernel log unavailable)'}`,
    );
    for (const event of metrics.oomEvents ?? []) lines.push(`- ${event}`);
  }
  for (const playlist of report.playlists ?? []) {
    const webview = playlist.webview ?? {};
    const native = playlist.native ?? {};
    lines.push(
      `- ${playlist.source}: webview=${outcome(webview, 'unknown')}`
      + ` native=${outcome(native, 'not-run')} ${playlist.url}`,
    );
  }
  const listEvents = (title, events, nameKey) => {
    lines.push(`${title}: ${String(events.length)}`);
    for (const event of events) {
      const name = event[nameKey];
      let fields = findEvent(event.text)?.fields ?? '';
      if (fields.length > SUMMARY_FIELDS_MAX) fields = `${fields.slice(0, SUMMARY_FIELDS_MAX - 3)}...`;
      lines.push(`- ${name}${fields ? ` ${fields}` : ''}`);
    }
  };
  listEvents('Diagnostic events', report.diagnostics ?? [], 'code');
  listEvents('Input events', report.input ?? [], 'event');
  listEvents('Xtream events', report.xtream ?? [], 'event');
  lines.push(`Network requests: ${String(report.network?.length ?? 0)}`);
  lines.push(
    `Warnings: ${String((report.logs ?? []).filter((entry) => entry.level === 'warning').length)}`,
  );
  lines.push(`Errors: ${String((report.logs ?? []).filter((entry) => entry.level === 'error').length)}`);
  if (report.serviceLog?.error) {
    lines.push(`Service log: unavailable (${report.serviceLog.error.split(/\r?\n/)[0]})`);
  } else if (report.serviceLog) {
    const serviceLines = report.serviceLog.lines;
    const countLevel = (level) => serviceLines.filter((line) => line.split(' ')[1] === level).length;
    // The file outlives app sessions, so show which time the lines cover.
    const span = serviceLines.length
      ? `, ${serviceLines[0].split(' ')[0]} to ${serviceLines[serviceLines.length - 1].split(' ')[0]}`
      : '';
    lines.push(
      `Service log: ${String(serviceLines.length)} lines${span}`
      + ` | warnings=${String(countLevel('warn'))}`
      + ` errors=${String(countLevel('error'))}`,
    );
  }
  return lines.join('\n');
}

export const activeProbeExpression = `(${function activeProbe(
  previewBytes,
  probeTimeoutMs,
  singleConnectionSkipReason,
) {
  // The containers the app hands to <source type>, plus the codecs a webOS
  // pipeline can refuse silently. A rejected type makes the resource selection
  // algorithm skip the source without firing `error` — a black screen with no
  // diagnosis unless the verdict is captured here.
  const CODEC_PROBES = [
    'video/mp4',
    'video/x-matroska',
    'video/x-msvideo',
    'video/quicktime',
    'video/webm',
    'video/mp2t',
    'video/x-flv',
    'application/vnd.apple.mpegurl',
    'video/mp4; codecs="avc1.640028"',
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="dvh1.05.06"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="ac-3"',
    'audio/mp4; codecs="ec-3"',
  ];
  const getPlaylists = () => {
    try { return JSON.parse(localStorage.getItem('iptv_playlists') || '[]'); } catch { return []; }
  };
  const readPreview = async (response) => {
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) return '';
    const chunks = [];
    let length = 0;
    try {
      while (length < previewBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.length) continue;
        const take = value.subarray(0, Math.min(value.length, previewBytes - length));
        chunks.push(take);
        length += take.length;
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  };
  const fetchProbe = async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=0-${String(previewBytes - 1)}` },
        signal: controller.signal,
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        contentLength: response.headers.get('content-length') || '',
        bodyPreview: await readPreview(response),
        error: '',
      };
    } catch (error) {
      return { status: null, contentType: '', contentLength: '', bodyPreview: '', error: String(error) };
    } finally {
      clearTimeout(timeout);
    }
  };
  return (async () => {
    let app = {};
    try { app = await (await fetch('appinfo.json')).json(); } catch {}
    const source = getPlaylists();
    const playlists = [];
    for (const entry of source) {
      if (entry.source === 'upload') continue;
      let url = entry.url || '';
      let xtreamAuth = null;
      let isolateSingleConnection = false;
      const secrets = [];
      if (entry.source === 'xtream' && entry.xtream) {
        const username = entry.xtream.username || '';
        const password = entry.xtream.password || '';
        secrets.push(username, password);
        const base = url.replace(/\/+$/, '');
        const authUrl = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
        try {
          const authResponse = await fetch(authUrl);
          const payload = await authResponse.json();
          const user = payload && payload.user_info ? payload.user_info : {};
          xtreamAuth = {
            httpStatus: authResponse.status,
            auth: user.auth == null ? null : user.auth,
            status: user.status || '',
            expDate: user.exp_date == null ? null : user.exp_date,
            maxConnections: user.max_connections == null ? null : user.max_connections,
            activeConnections: user.active_cons == null ? null : user.active_cons,
            allowedOutputFormats: Array.isArray(user.allowed_output_formats)
              ? user.allowed_output_formats.filter((item) => typeof item === 'string')
              : [],
          };
        } catch (error) {
          xtreamAuth = { error: String(error) };
        }
        const maxConnectionsValue = xtreamAuth && xtreamAuth.maxConnections;
        const maxConnections = maxConnectionsValue != null
          && String(maxConnectionsValue).trim() !== ''
          ? Number(maxConnectionsValue)
          : NaN;
        isolateSingleConnection = Number.isFinite(maxConnections) && maxConnections <= 1;
        const preferred = entry.xtream.liveOutput === 'm3u8'
          || (entry.xtream.liveOutput === 'auto'
            && xtreamAuth
            && xtreamAuth.allowedOutputFormats
            && xtreamAuth.allowedOutputFormats.includes('m3u8'))
          ? 'm3u8' : 'ts';
        url = `${base}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=${preferred}`;
      }
      playlists.push({
        source: entry.source === 'xtream' ? 'xtream' : 'm3u',
        name: entry.name || '',
        __url: url,
        __secrets: secrets,
        webview: isolateSingleConnection
          ? {
            status: null,
            contentType: '',
            contentLength: '',
            bodyPreview: '',
            error: '',
            skipped: true,
            skipReason: singleConnectionSkipReason,
          }
          : await fetchProbe(url),
        xtreamAuth,
        __skipNativeProbe: isolateSingleConnection ? singleConnectionSkipReason : '',
      });
    }
    let storageEstimate = {};
    try {
      if (navigator.storage && navigator.storage.estimate) {
        storageEstimate = await navigator.storage.estimate();
      }
    } catch {}
    let storageChars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        storageChars += key.length + (localStorage.getItem(key) || '').length;
      }
    } catch {}
    const visible = [...document.querySelectorAll('.view')]
      .find((element) => !element.classList.contains('hidden'));
    const video = document.querySelector('video');
    const capabilityVideo = video || document.createElement('video');
    const canPlay = (type) => {
      if (!type) return '';
      try { return capabilityVideo.canPlayType(type) || ''; } catch { return ''; }
    };
    const codecSupport = {};
    for (const type of CODEC_PROBES) codecSupport[type] = canPlay(type);
    const sources = video
      ? [...video.querySelectorAll('source')].map((element) => {
        const type = element.getAttribute('type') || '';
        return { src: element.src || element.getAttribute('src') || '', type, canPlayType: canPlay(type) };
      })
      : [];
    return {
      app: { id: app.id || '', version: app.version || '' },
      state: {
        view: visible ? visible.id : '',
        loading: (() => {
          const loading = document.querySelector('#view-loading');
          return loading ? !loading.classList.contains('hidden') : false;
        })(),
        // Rendered rows only — the channel list is virtualized, so the loaded
        // catalog size comes from the playlist.load.completed event instead.
        channelsRendered: document.querySelectorAll('.channel-item').length,
        media: video ? {
          src: video.currentSrc || video.src || '',
          sources,
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          currentTime: Math.round(video.currentTime * 100) / 100,
          playbackRate: video.playbackRate,
          duration: Number.isFinite(video.duration)
            ? Math.round(video.duration * 100) / 100
            : null,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          error: video.error ? {
            code: video.error.code,
            message: video.error.message || '',
          } : null,
        } : null,
        codecSupport,
      },
      storage: {
        localStorageChars: storageChars,
        usage: storageEstimate.usage == null ? null : storageEstimate.usage,
        quota: storageEstimate.quota == null ? null : storageEstimate.quota,
        indexedDb: typeof indexedDB !== 'undefined',
      },
      environment: {
        userAgent: navigator.userAgent,
        viewport: `${String(window.innerWidth)}x${String(window.innerHeight)}`,
      },
      playlists,
    };
  })();
}.toString()})(${String(PREVIEW_BYTES)},${String(PLAYLIST_PROBE_TIMEOUT_MS)},`
  + `${JSON.stringify(SINGLE_CONNECTION_SKIP_REASON)})`;

export const snapshotProbeExpression = `(${function snapshotProbe() {
  const source = (() => {
    try { return JSON.parse(localStorage.getItem('iptv_playlists') || '[]'); } catch { return []; }
  })();
  const playlists = source
    .filter((entry) => entry.source !== 'upload')
    .map((entry) => ({
      source: entry.source === 'xtream' ? 'xtream' : 'm3u',
      name: entry.name || '',
      __url: entry.url || '',
      __secrets: entry.xtream
        ? [entry.xtream.username || '', entry.xtream.password || '']
        : [],
      webview: null,
      xtreamAuth: null,
    }));
  const visible = [...document.querySelectorAll('.view')]
    .find((element) => !element.classList.contains('hidden'));
  const video = document.querySelector('video');
  return {
    app: {},
    state: {
      view: visible ? visible.id : '',
      loading: (() => {
        const loading = document.querySelector('#view-loading');
        return loading ? !loading.classList.contains('hidden') : false;
      })(),
      channelsRendered: document.querySelectorAll('.channel-item').length,
      media: video ? {
        src: video.currentSrc || video.src || '',
        sources: [...video.querySelectorAll('source')].map((element) => ({
          src: element.src || element.getAttribute('src') || '',
          type: element.getAttribute('type') || '',
          canPlayType: '',
        })),
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        currentTime: Math.round(video.currentTime * 100) / 100,
        playbackRate: video.playbackRate,
        duration: Number.isFinite(video.duration)
          ? Math.round(video.duration * 100) / 100
          : null,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        error: video.error ? {
          code: video.error.code,
          message: video.error.message || '',
        } : null,
      } : null,
      codecSupport: {},
    },
    storage: {},
    environment: {
      userAgent: navigator.userAgent,
      viewport: `${String(window.innerWidth)}x${String(window.innerHeight)}`,
    },
    playlists,
  };
}.toString()})()`;

export { inspectorWebSocketUrl, startAresInspector };

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

const memoryManagerProbeScript = `
var Module=require("module"),originalLoad=Module._load;
function noop(){}
function logger(){return{log:noop,info:noop,warning:noop,error:noop};}
var pmloglib={log:noop,info:noop,warning:noop,error:noop,Console:logger,Context:logger};
Module._load=function(request,parent,isMain){
  if(request==="pmloglib")return pmloglib;
  return originalLoad.apply(this,arguments);
};
function createHandle(pb){
  var major=Number(String(process.versions.node||"0").split(".")[0]);
  if(major>=20){
    try{return new pb.Handle("");}
    catch(singleArgumentError){return new pb.Handle("",true);}
  }
  return new pb.Handle("",true);
}
var phase=process.argv[1]||"unknown";
var pb=require("palmbus"),handle=createHandle(pb);
handle.call("luna://com.webos.memorymanager/getCurrentMemState","{}")
.on("response",function(message){
  var result;
  try{result=JSON.parse(message.payload());}catch(error){result={};}
  console.log([
    "@mm",phase,result.currentLevel||"",result.prevLevel||"",
    result.usable==null?"":result.usable,result.returnValue===true?"1":"0"
  ].join("|"));
  process.exit(0);
});
setTimeout(function(){process.exit(1);},3000);
`.trim();

const nativeMetricCommand = (durationMs, appId) => {
  const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
  return [
    `app_id=${shellQuote(appId)}`,
    'process_kind() {',
    'p="$1"',
    'comm=$(cat "/proc/$p/comm" 2>/dev/null)',
    'case "$comm" in',
    'WebAppMgr*|WebAppManager*|gwam*)',
    'cmdline=$(tr "\\000" " " < "/proc/$p/cmdline" 2>/dev/null)',
    'case "$cmdline" in *"--app-id=$app_id"*) printf webapp;; *) return 1;; esac',
    ';;',
    'starfish*) printf starfish;;',
    'umediaserver*) printf umediaserver;;',
    '*) return 1;;',
    'esac',
    '}',
    'sample_memory_manager() {',
    `NODE_PATH=/usr/lib/node_modules:/usr/lib/nodejs node -e ${shellQuote(memoryManagerProbeScript)} "$1" 2>/dev/null`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then printf "@mm|%s||||0\\n" "$1"; fi',
    '}',
    'sample_oom() {',
    'phase="$1"',
    'oom_output=$(dmesg 2>/dev/null); oom_status=$?',
    'printf "@oom-access|%s|%s\\n" "$phase" "$([ "$oom_status" -eq 0 ] && echo 1 || echo 0)"',
    'if [ "$oom_status" -eq 0 ]; then',
    'printf "%s\\n" "$oom_output" | grep -Ei "out of memory|oom-kill|killed process" | tail -n 20 | while IFS= read -r line; do',
    'printf "@oom|%s|%s\\n" "$phase" "$line"',
    'done',
    'fi',
    '}',
    'sample_memory() {',
    'phase="$1"',
    'awk -v phase="$phase" \'',
    '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 }',
    '/^SwapTotal:/ { swap_total=$2 } /^SwapFree:/ { swap_free=$2 }',
    'END { printf "@mem|%s|%s|%s|%s|%s\\n", phase, total, available, swap_total, swap_free }',
    '\' /proc/meminfo 2>/dev/null',
    '}',
    'sample_peak() {',
    'sample="$1"',
    'for p in $(pidof WebAppMgr WebAppManager gwam starfish-media-pipeline umediaserver 2>/dev/null); do',
    'kind=$(process_kind "$p") || continue',
    'rss=$(awk \'/^VmRSS:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'threads=$(awk \'/^Threads:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'printf "@peak|%s|%s|%s|%s|%s\\n" "$sample" "$p" "$kind" "${rss:-0}" "${threads:-0}"',
    'done',
    'awk -v sample="$sample" \'',
    '/^MemAvailable:/ { available=$2 } /^SwapFree:/ { swap_free=$2 }',
    'END { printf "@mem-sample|%s|%s|%s\\n", sample, available, swap_free }',
    '\' /proc/meminfo 2>/dev/null',
    '}',
    'sample_native() {',
    'phase="$1"',
    'ticks=$(getconf CLK_TCK 2>/dev/null || echo 100)',
    'printf "@ticks|%s|%s\\n" "$phase" "$ticks"',
    'for p in $(pidof WebAppMgr WebAppManager gwam starfish-media-pipeline umediaserver 2>/dev/null); do',
    'kind=$(process_kind "$p") || continue',
    'set -- $(cat "/proc/$p/stat" 2>/dev/null); utime="${14}"; stime="${15}"; threads="${20}"',
    'rss=$(awk \'/^VmRSS:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'vm_peak=$(awk \'/^VmPeak:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'vm_size=$(awk \'/^VmSize:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'vm_hwm=$(awk \'/^VmHWM:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'rss_anon=$(awk \'/^RssAnon:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'rss_file=$(awk \'/^RssFile:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'rss_shmem=$(awk \'/^RssShmem:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'vm_swap=$(awk \'/^VmSwap:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'oom_score=$(cat "/proc/$p/oom_score" 2>/dev/null)',
    'oom_adj=$(cat "/proc/$p/oom_score_adj" 2>/dev/null)',
    'set -- $(cat "/proc/$p/schedstat" 2>/dev/null); run_ns="$1"; wait_ns="$2"',
    'printf "@proc|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" "$phase" "$p" "$kind" "$utime" "$stime" "${rss:-0}" "${threads:-0}" "${run_ns:-0}" "${wait_ns:-0}" "${oom_score:-0}" "${oom_adj:-0}" "${vm_peak:-0}" "${vm_size:-0}" "${vm_hwm:-0}" "${rss_anon:-0}" "${rss_file:-0}" "${rss_shmem:-0}" "${vm_swap:-0}"',
    'done',
    'for resource in cpu memory io; do',
    'awk -v phase="$phase" -v resource="$resource" \'$1 == "some" { avg=""; total=""; for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]=="avg10") avg=a[2]; if (a[1]=="total") total=a[2] } printf "@psi|%s|%s|%s|%s\\n", phase, resource, avg, total }\' "/proc/pressure/$resource" 2>/dev/null',
    'done',
    'awk -v phase="$phase" \'/:/ { gsub(":", "", $1); if ($1 != "lo") { rx += $2; tx += $10 } } END { printf "@net|%s|%.0f|%.0f\\n", phase, rx, tx }\' /proc/net/dev',
    'awk -v phase="$phase" \'$1 == "Tcp:" { if (!seen) { for (i=2;i<=NF;i++) key[i]=$i; seen=1 } else { for (i=2;i<=NF;i++) if (key[i]=="RetransSegs") value=$i; printf "@tcp|%s|%s\\n", phase, value; exit } }\' /proc/net/snmp',
    'sample_memory "$phase"',
    'sample_memory_manager "$phase"',
    'sample_oom "$phase"',
    '}',
    'sample_native before',
    'printf "@native-ready\\n"',
    'sample=0',
    `while [ "$sample" -lt ${String(durationSeconds)} ]; do`,
    'sleep 1',
    'sample=$((sample + 1))',
    'sample_peak "$sample"',
    'done',
    'sample_native after',
  ].join('\n');
};

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseNativeMetricOutput(output, durationMs) {
  const snapshots = {
    before: {
      ticks: 100, processes: [], psi: {}, network: null, tcpRetrans: null,
      memory: null, memoryManager: null, oomAccess: false, oom: [],
    },
    after: {
      ticks: 100, processes: [], psi: {}, network: null, tcpRetrans: null,
      memory: null, memoryManager: null, oomAccess: false, oom: [],
    },
  };
  const peakByPid = new Map();
  const memorySamples = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.startsWith('@')) continue;
    const [type, phase, ...values] = line.slice(1).split('|');
    if (type === 'peak') {
      const [pidValue, kind, rssValue, threadsValue] = values;
      const pid = finiteNumber(pidValue);
      if (pid == null) continue;
      const rssKb = finiteNumber(rssValue);
      const existing = peakByPid.get(pid);
      peakByPid.set(pid, {
        pid,
        kind,
        peakRssKb: Math.max(existing?.peakRssKb ?? 0, rssKb ?? 0),
        peakThreads: Math.max(existing?.peakThreads ?? 0, finiteNumber(threadsValue) ?? 0),
        firstSample: Math.min(existing?.firstSample ?? Number(phase), Number(phase)),
        lastSample: Math.max(existing?.lastSample ?? Number(phase), Number(phase)),
      });
      continue;
    }
    if (type === 'mem-sample') {
      memorySamples.push({
        sample: finiteNumber(phase),
        availableKb: finiteNumber(values[0]),
        swapFreeKb: finiteNumber(values[1]),
      });
      continue;
    }
    const snapshot = snapshots[phase];
    if (!snapshot) continue;
    if (type === 'ticks') {
      snapshot.ticks = finiteNumber(values[0]) ?? 100;
    } else if (type === 'proc') {
      const [
        pid, kind, utime, stime, rssKb, threads, runNs, waitNs, oomScore, oomScoreAdj,
        vmPeakKb, vmSizeKb, vmHwmKb, rssAnonKb, rssFileKb, rssShmemKb, swapKb,
      ] = values;
      snapshot.processes.push({
        pid: finiteNumber(pid),
        kind,
        cpuTicks: (finiteNumber(utime) ?? 0) + (finiteNumber(stime) ?? 0),
        rssKb: finiteNumber(rssKb),
        threads: finiteNumber(threads),
        runNs: finiteNumber(runNs),
        waitNs: finiteNumber(waitNs),
        oomScore: finiteNumber(oomScore),
        oomScoreAdj: finiteNumber(oomScoreAdj),
        vmPeakKb: finiteNumber(vmPeakKb),
        vmSizeKb: finiteNumber(vmSizeKb),
        vmHwmKb: finiteNumber(vmHwmKb),
        rssAnonKb: finiteNumber(rssAnonKb),
        rssFileKb: finiteNumber(rssFileKb),
        rssShmemKb: finiteNumber(rssShmemKb),
        swapKb: finiteNumber(swapKb),
      });
    } else if (type === 'psi') {
      const [resource, avg10, totalUs] = values;
      snapshot.psi[resource] = {
        avg10: finiteNumber(avg10),
        totalUs: finiteNumber(totalUs),
      };
    } else if (type === 'net') {
      snapshot.network = {
        rxBytes: finiteNumber(values[0]),
        txBytes: finiteNumber(values[1]),
      };
    } else if (type === 'tcp') {
      snapshot.tcpRetrans = finiteNumber(values[0]);
    } else if (type === 'mem') {
      snapshot.memory = {
        totalKb: finiteNumber(values[0]),
        availableKb: finiteNumber(values[1]),
        swapTotalKb: finiteNumber(values[2]),
        swapFreeKb: finiteNumber(values[3]),
      };
    } else if (type === 'mm') {
      snapshot.memoryManager = {
        currentLevel: values[0] || '',
        previousLevel: values[1] || '',
        usableMb: finiteNumber(values[2]),
        available: values[3] === '1',
      };
    } else if (type === 'oom-access') {
      snapshot.oomAccess = values[0] === '1';
    } else if (type === 'oom') {
      snapshot.oom.push(values.join('|'));
    }
  }
  const beforeByPid = new Map(snapshots.before.processes.map((process) => [process.pid, process]));
  const seconds = durationMs / 1000;
  const processes = snapshots.after.processes.map((process) => {
    const before = beforeByPid.get(process.pid);
    const cpuTicks = Math.max(0, process.cpuTicks - (before?.cpuTicks ?? 0));
    return {
      pid: process.pid,
      kind: process.kind,
      startedDuringWindow: !before,
      cpuPercent: seconds > 0
        ? (cpuTicks / snapshots.after.ticks / seconds) * 100
        : null,
      initialRssKb: before?.rssKb ?? null,
      rssKb: process.rssKb,
      peakRssKb: Math.max(
        before?.rssKb ?? 0,
        process.rssKb ?? 0,
        peakByPid.get(process.pid)?.peakRssKb ?? 0,
      ),
      threads: process.threads,
      peakThreads: Math.max(
        before?.threads ?? 0,
        process.threads ?? 0,
        peakByPid.get(process.pid)?.peakThreads ?? 0,
      ),
      initialOomScore: before?.oomScore ?? null,
      oomScore: process.oomScore,
      oomScoreAdj: process.oomScoreAdj,
      vmPeakKb: process.vmPeakKb,
      vmSizeKb: process.vmSizeKb,
      vmHwmKb: process.vmHwmKb,
      rssAnonKb: process.rssAnonKb,
      rssFileKb: process.rssFileKb,
      rssShmemKb: process.rssShmemKb,
      swapKb: process.swapKb,
      schedulerRunMs: Math.max(0, process.runNs - (before?.runNs ?? 0)) / 1e6,
      schedulerWaitMs: Math.max(0, process.waitNs - (before?.waitNs ?? 0)) / 1e6,
    };
  });
  const afterPids = new Set(snapshots.after.processes.map((process) => process.pid));
  const stoppedByPid = new Map();
  for (const process of snapshots.before.processes) {
    if (!afterPids.has(process.pid)) {
      stoppedByPid.set(process.pid, {
        pid: process.pid,
        kind: process.kind,
        initialRssKb: process.rssKb,
        peakRssKb: Math.max(process.rssKb ?? 0, peakByPid.get(process.pid)?.peakRssKb ?? 0),
        initialThreads: process.threads,
        peakThreads: Math.max(process.threads ?? 0, peakByPid.get(process.pid)?.peakThreads ?? 0),
        initialOomScore: process.oomScore,
        oomScoreAdj: process.oomScoreAdj,
        vmPeakKb: process.vmPeakKb,
        vmSizeKb: process.vmSizeKb,
        vmHwmKb: process.vmHwmKb,
        rssAnonKb: process.rssAnonKb,
        rssFileKb: process.rssFileKb,
        rssShmemKb: process.rssShmemKb,
        swapKb: process.swapKb,
        observedAtStart: true,
      });
    }
  }
  for (const sampled of peakByPid.values()) {
    if (!afterPids.has(sampled.pid) && !stoppedByPid.has(sampled.pid)) {
      stoppedByPid.set(sampled.pid, {
        pid: sampled.pid,
        kind: sampled.kind,
        initialRssKb: null,
        peakRssKb: sampled.peakRssKb,
        initialThreads: null,
        peakThreads: sampled.peakThreads,
        initialOomScore: null,
        oomScoreAdj: null,
        vmPeakKb: null,
        vmSizeKb: null,
        vmHwmKb: null,
        rssAnonKb: null,
        rssFileKb: null,
        rssShmemKb: null,
        swapKb: null,
        observedAtStart: false,
      });
    }
  }
  const stoppedProcesses = [...stoppedByPid.values()];
  const pressure = {};
  for (const resource of ['cpu', 'memory', 'io']) {
    const before = snapshots.before.psi[resource];
    const after = snapshots.after.psi[resource];
    pressure[resource] = {
      avg10: after?.avg10 ?? null,
      stallMs: before?.totalUs != null && after?.totalUs != null
        ? Math.max(0, after.totalUs - before.totalUs) / 1000
        : null,
    };
  }
  const delta = (after, before) => (
    after != null && before != null ? Math.max(0, after - before) : null
  );
  const minimum = (values) => {
    const finite = values.filter((value) => value != null);
    return finite.length ? Math.min(...finite) : null;
  };
  const beforeOom = new Set(snapshots.before.oom);
  const sum = (items, field) => items.reduce(
    (total, item) => total + (item[field] ?? 0),
    0,
  );
  const beforeWebapps = snapshots.before.processes.filter((process) => process.kind === 'webapp');
  const afterWebapps = snapshots.after.processes.filter((process) => process.kind === 'webapp');
  const sampledWebapps = [...peakByPid.values()].filter((process) => process.kind === 'webapp');
  const totalKb = snapshots.after.memory?.totalKb ?? snapshots.before.memory?.totalKb ?? null;
  const appPeakRssKb = Math.max(
    sum(beforeWebapps, 'rssKb'),
    sum(afterWebapps, 'rssKb'),
    sum(sampledWebapps, 'peakRssKb'),
  );
  const usedBeforeKb = totalKb != null && snapshots.before.memory?.availableKb != null
    ? Math.max(0, totalKb - snapshots.before.memory.availableKb)
    : null;
  const usedAfterKb = totalKb != null && snapshots.after.memory?.availableKb != null
    ? Math.max(0, totalKb - snapshots.after.memory.availableKb)
    : null;
  const minimumAvailableKb = minimum([
    snapshots.before.memory?.availableKb,
    ...memorySamples.map((sample) => sample.availableKb),
    snapshots.after.memory?.availableKb,
  ]);
  return {
    durationMs,
    processes,
    stoppedProcessIds: stoppedProcesses.map((process) => process.pid),
    stoppedProcesses,
    appMemory: {
      processCountBefore: beforeWebapps.length,
      processCountAfter: afterWebapps.length,
      rssBeforeKb: sum(beforeWebapps, 'rssKb'),
      rssAfterKb: sum(afterWebapps, 'rssKb'),
      peakObservedRssKb: appPeakRssKb,
      lifetimeHighWaterKb: Math.max(
        sum(beforeWebapps, 'vmHwmKb'),
        sum(afterWebapps, 'vmHwmKb'),
      ),
      virtualSizeAfterKb: sum(afterWebapps, 'vmSizeKb'),
      anonymousRssAfterKb: sum(afterWebapps, 'rssAnonKb'),
      fileRssAfterKb: sum(afterWebapps, 'rssFileKb'),
      sharedRssAfterKb: sum(afterWebapps, 'rssShmemKb'),
      swapAfterKb: sum(afterWebapps, 'swapKb'),
      percentOfSystemAtPeak: totalKb && appPeakRssKb
        ? Math.round((appPeakRssKb / totalKb) * 10000) / 100
        : null,
    },
    memoryManager: {
      available: Boolean(
        snapshots.before.memoryManager?.available
        || snapshots.after.memoryManager?.available
      ),
      levelBefore: snapshots.before.memoryManager?.currentLevel ?? '',
      levelAfter: snapshots.after.memoryManager?.currentLevel ?? '',
      previousLevelBefore: snapshots.before.memoryManager?.previousLevel ?? '',
      previousLevelAfter: snapshots.after.memoryManager?.previousLevel ?? '',
      usableBeforeMb: snapshots.before.memoryManager?.usableMb ?? null,
      usableAfterMb: snapshots.after.memoryManager?.usableMb ?? null,
      minimumUsableMb: minimum([
        snapshots.before.memoryManager?.usableMb,
        snapshots.after.memoryManager?.usableMb,
      ]),
    },
    memory: {
      totalKb,
      availableBeforeKb: snapshots.before.memory?.availableKb ?? null,
      availableAfterKb: snapshots.after.memory?.availableKb ?? null,
      minimumAvailableKb,
      usedBeforeKb,
      usedAfterKb,
      maximumUsedKb: totalKb != null && minimumAvailableKb != null
        ? Math.max(0, totalKb - minimumAvailableKb)
        : null,
      swapTotalKb: snapshots.after.memory?.swapTotalKb
        ?? snapshots.before.memory?.swapTotalKb ?? null,
      swapFreeBeforeKb: snapshots.before.memory?.swapFreeKb ?? null,
      swapFreeAfterKb: snapshots.after.memory?.swapFreeKb ?? null,
      minimumSwapFreeKb: minimum([
        snapshots.before.memory?.swapFreeKb,
        ...memorySamples.map((sample) => sample.swapFreeKb),
        snapshots.after.memory?.swapFreeKb,
      ]),
    },
    oomLogAvailable: snapshots.before.oomAccess || snapshots.after.oomAccess,
    oomEvents: snapshots.after.oom.filter((event) => !beforeOom.has(event)),
    pressure,
    network: {
      rxBytes: delta(snapshots.after.network?.rxBytes, snapshots.before.network?.rxBytes),
      txBytes: delta(snapshots.after.network?.txBytes, snapshots.before.network?.txBytes),
    },
    tcpRetransmits: delta(snapshots.after.tcpRetrans, snapshots.before.tcpRetrans),
    error: '',
  };
}

export function startNativeMetricWindow(
  durationMs,
  {
    spawn = spawnChild,
    timeoutMs = durationMs + 30000,
    appId = DEFAULT_APP_ID,
  } = {},
) {
  const child = spawn(
    path.join('scripts', 'tv.sh'),
    ['run', nativeMetricCommand(durationMs, appId)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let settledReady = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error('Timed out collecting native playback metrics');
      if (!settledReady) rejectReady(error);
      reject(error);
    }, timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      if (!settledReady && output.includes('@native-ready')) {
        settledReady = true;
        resolveReady();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settledReady) rejectReady(error);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`Native metric collector exited with ${String(code)}`);
        if (!settledReady) rejectReady(error);
        reject(error);
        return;
      }
      if (!settledReady) {
        const error = new Error('Native metric collector did not publish its baseline');
        rejectReady(error);
        reject(error);
        return;
      }
      resolve(parseNativeMetricOutput(output, durationMs));
    });
  });
  return { child, ready, result };
}

export function runNativeProbe(url, { execFile = execFileSync } = {}) {
  if (!url) return { status: null, contentType: '', bodyPreview: '', error: 'missing URL' };
  const command = [
    'node_major=$(node -e \'process.stdout.write(process.versions.node.split(".")[0])\')',
    'if [ "$node_major" -ge 20 ]; then temp_root=/media/developer/temp; else temp_root=/tmp; fi',
    'body="$temp_root/iptv-diag-body-$$"',
    'headers="$temp_root/iptv-diag-headers-$$"',
    'curl_error="$temp_root/iptv-diag-curl-error-$$"',
    'curl_rc="$temp_root/iptv-diag-curl-rc-$$"',
    `(curl -L -sS --connect-timeout 10 --max-time 20`
      + ` --range 0-${String(PREVIEW_BYTES - 1)} -D "$headers" ${shellQuote(url)}`
      + ` 2>"$curl_error"; printf '%s' "$?" > "$curl_rc")`
      + ` | head -c ${String(PREVIEW_BYTES)} > "$body"`,
    'rc=$(cat "$curl_rc" 2>/dev/null || printf 1)',
    `size=$(wc -c < "$body" 2>/dev/null || printf 0)`,
    `if [ "$rc" -eq 23 ] && [ "$size" -eq ${String(PREVIEW_BYTES)} ]; then rc=0; fi`,
    'if [ "$rc" -ne 0 ]; then cat "$curl_error" >&2; fi',
    'cat "$body" 2>/dev/null',
    'status=$(awk \'/^HTTP\\// {code=$2} END {print code}\' "$headers" 2>/dev/null)',
    'content_type=$(awk \'BEGIN {IGNORECASE=1} /^Content-Type:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\\r$/, ""); value=$0} END {print value}\' "$headers" 2>/dev/null)',
    'printf \'\\n__IPTV_DIAG__%s|%s\' "$status" "$content_type"',
    'rm -f "$body" "$headers" "$curl_error" "$curl_rc"',
    'exit $rc',
  ].join('; ');
  try {
    const output = execFile(
      path.join('scripts', 'tv.sh'),
      ['run', command],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const markerText = '\n__IPTV_DIAG__';
    const marker = output.lastIndexOf(markerText);
    const bodyPreview = (marker >= 0 ? output.slice(0, marker) : output)
      .replace(/^\s*Enter passphrase for key '[^']+':\s*/i, '');
    const [statusText = '', contentType = ''] = marker >= 0
      ? output.slice(marker + markerText.length).trim().split('|') : [];
    return {
      status: Number(statusText) || null,
      contentType,
      bodyPreview,
      error: '',
    };
  } catch (error) {
    const detail = error?.stderr || error?.stdout || toErrorMessage(error);
    const text = String(detail).trim() || toErrorMessage(error);
    return { status: null, contentType: '', bodyPreview: '', error: text };
  }
}

export function readServiceLog({ execFile = execFileSync } = {}) {
  const command = [
    SERVICE_LOG_TEMP_ROOT,
    'log="$temp_root/com.lennylxx.iptv.service.log"',
    'if [ -e "$log" ] || [ -e "$log.1" ]; then'
      + ` cat "$log.1" "$log" 2>/dev/null | tail -n ${String(SERVICE_LOG_LINES)};`
      + ` else echo ${NO_SERVICE_LOG}; fi`,
    'exit 0',
  ].join('; ');
  try {
    const output = execFile(
      path.join('scripts', 'tv.sh'),
      ['run', command],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = output.replace(/^\s*Enter passphrase for key '[^']+':\s*/i, '')
      .split(/\r?\n/).filter((line) => line.trim());
    if (lines.indexOf(NO_SERVICE_LOG) >= 0) {
      return { lines: [], error: 'no service log on the TV; has the service started?' };
    }
    return { lines, error: '' };
  } catch (error) {
    const detail = error?.stderr || error?.stdout || toErrorMessage(error);
    return { lines: [], error: String(detail).trim() || toErrorMessage(error) };
  }
}

export function runNativePlaylistProbe(playlist, options = {}) {
  if (playlist?.__skipNativeProbe) {
    return {
      status: null,
      contentType: '',
      bodyPreview: '',
      error: '',
      skipped: true,
      skipReason: playlist.__skipNativeProbe,
    };
  }
  return runNativeProbe(playlist?.__url, options);
}

async function pollForTarget(options, dependencies) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < options.timeoutMs) {
    try {
      return await dependencies.resolveTarget({
        host: options.host,
        port: options.port,
        target: options.appId,
        targetSelection: 'legacy-tv-app',
      });
    } catch (error) {
      lastError = error;
      await dependencies.delay(500);
    }
  }
  throw lastError ?? new Error('Timed out waiting for app inspector');
}

const evaluationError = (result) => (result.exceptionDetails
  ? new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  : null);

const LEGACY_EVALUATION_TIMEOUT_MS = 60000;
const LEGACY_EVALUATION_POLL_MS = 100;
let legacyEvaluations = 0;

// Chromium 53 can't parse the probes' ES2017+ syntax and returns a pending
// Promise for awaitPromise, so the probe is lowered to its engine, parks its
// result on window, and is polled.
export async function evaluateOnLegacyEngine(client, expression, wait = delay) {
  const slot = `__iptvDiag${String(++legacyEvaluations)}`;
  const wrapped = `window.${slot} = { done: false };
Promise.resolve(${expression}).then(
  (value) => { window.${slot} = { done: true, value }; },
  (error) => { window.${slot} = { done: true, error: String((error && error.stack) || error) }; },
);`;
  // Loaded on demand: esbuild can't start under the jsdom test environment.
  const { transformSync } = await import('esbuild');
  const started = await client.call('Runtime.evaluate', {
    expression: transformSync(wrapped, { loader: 'js', target: 'chrome53' }).code,
  });
  const startError = evaluationError(started);
  if (startError) throw startError;
  const deadline = Date.now() + LEGACY_EVALUATION_TIMEOUT_MS;
  for (;;) {
    const polled = await client.call('Runtime.evaluate', {
      expression: `(function () { var r = window.${slot}; if (r && r.done) delete window.${slot}; return r; })()`,
      returnByValue: true,
    });
    const state = polled.result?.value;
    if (state?.done) {
      if (state.error) throw new Error(state.error);
      return state.value;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a page probe');
    await wait(LEGACY_EVALUATION_POLL_MS);
  }
}

const evaluate = async (client, expression) => {
  if (isLegacyCdpEngine(client)) return evaluateOnLegacyEngine(client, expression);
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const error = evaluationError(result);
  if (error) throw error;
  return result.result?.value;
};

async function waitForSettle(client, timeoutMs, delayFn) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let settled = false;
    try {
      settled = await evaluate(
        client,
        `(() => {
          var loading = document.querySelector('#view-loading');
          return Boolean(loading && loading.classList.contains('hidden'));
        })()`,
      );
    } catch (error) {
      if (client.closed) throw error;
    }
    if (settled) {
      await delayFn(1000);
      return;
    }
    await delayFn(250);
  }
}

const playbackActivationExpression = (channelIndex) => `(() => {
  var item = document.querySelector('[data-channel-index="${String(channelIndex)}"]');
  if (!item) return { ok: false, error: 'Channel is not currently rendered' };
  var rect = item.getBoundingClientRect();
  item.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  }));
  return { ok: true };
})()`;

export async function captureDiagnostics(options, overrides = {}) {
  const dependencies = {
    execFile: execFileSync,
    resolveTarget: resolveCdpTarget,
    connect: CdpClient.connect,
    startInspector: startAresInspector,
    startNativeMetrics: startNativeMetricWindow,
    delay,
    now: () => new Date(),
    ...overrides,
  };
  const deviceArgs = options.device ? ['-d', options.device] : [];
  const useExistingCdp = Boolean(options.host);
  let inspector = null;
  let client = null;
  let nativeMetricSession = null;
  let nativeMetrics = null;
  let probe = null;
  let phase = 'connecting';
  if (!options.attach) {
    try {
      dependencies.execFile('ares-launch', ['-c', options.appId, ...deviceArgs], { stdio: 'ignore' });
    } catch {}
  }
  let target;
  try {
    if (useExistingCdp) {
      target = await pollForTarget(options, dependencies);
    } else {
      inspector = dependencies.startInspector(options.appId, options.device, {
        timeoutMs: options.timeoutMs,
      });
      target = { target: null, wsUrl: await inspector.wsUrl };
    }
    client = await dependencies.connect(target.wsUrl);
  } catch (error) {
    inspector?.close();
    throw error;
  }
  const logs = [];
  const networkEvents = [];
  const unsubLogs = subscribeCdpLogs(client, (method, params) => {
    logs.push(normalizeCdpLogEvent(method, params));
  });
  const networkMethods = [
    'Network.requestWillBeSent',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
  ];
  const unsubNetwork = networkMethods.map((method) => client.on(method, (params) => {
    networkEvents.push({ method, params, observedAt: dependencies.now().toISOString() });
  }));
  const finishNativeMetrics = async () => {
    if (!nativeMetricSession || nativeMetrics) return;
    try {
      nativeMetrics = await nativeMetricSession.result;
    } catch (error) {
      nativeMetrics = { error: toErrorMessage(error) };
    }
  };
  const buildReport = (capture) => {
    const effectiveProbe = probe ?? {
      app: {},
      environment: {},
      state: {},
      storage: {},
      playlists: [],
    };
    const native = capture.complete
      ? effectiveProbe.playlists.map((playlist) =>
        runNativePlaylistProbe(playlist, { execFile: dependencies.execFile }))
      : effectiveProbe.playlists.map(() => null);
    return assembleDiagnosticReport({
      capturedAt: dependencies.now().toISOString(),
      full: options.full,
      capture,
      app: {
        id: effectiveProbe.app?.id || options.appId,
        version: effectiveProbe.app?.version || '',
      },
      environment: {
        userAgent: effectiveProbe.environment?.userAgent ?? '',
        viewport: effectiveProbe.environment?.viewport ?? '',
        targetTitle: target.target?.title ?? '',
        targetDescription: target.target?.description ?? '',
      },
      probe: effectiveProbe,
      native,
      nativeMetrics,
      serviceLog: readServiceLog({ execFile: dependencies.execFile }),
      logs,
      networkEvents,
    });
  };
  try {
    phase = 'enabling-cdp';
    await enableCdpLogs(client, { history: true });
    await client.call('Network.enable');
    await client.call('Page.enable');
    if (!options.attach) {
      phase = 'reloading-app';
      await client.call('Page.reload', { ignoreCache: true });
      await waitForSettle(client, options.timeoutMs, dependencies.delay);
    }
    if (options.attach || options.playChannel !== null) {
      phase = 'capturing-baseline';
      probe = await evaluate(client, snapshotProbeExpression);
      phase = 'starting-native-metrics';
      try {
        nativeMetricSession = dependencies.startNativeMetrics(
          options.durationMs,
          { appId: options.appId },
        );
        await nativeMetricSession.ready;
      } catch (error) {
        void nativeMetricSession?.result.catch(() => {});
        nativeMetrics = { error: toErrorMessage(error) };
        nativeMetricSession = null;
      }
    }
    if (options.playChannel !== null) {
      phase = 'activating-playback';
      const activation = await evaluate(client, playbackActivationExpression(options.playChannel));
      if (!activation?.ok) {
        throw new Error(
          `Cannot play channel ${String(options.playChannel)}: ${activation?.error || 'unknown error'}`,
        );
      }
    }
    if (options.attach || options.playChannel !== null) {
      phase = 'observing';
      if (!nativeMetricSession) {
        await dependencies.delay(options.durationMs);
      } else {
        await finishNativeMetrics();
      }
    }
    phase = 'capturing-final-state';
    probe = await evaluate(client, activeProbeExpression);
    return buildReport({ complete: true, phase: 'complete', error: '' });
  } catch (error) {
    const message = toErrorMessage(error);
    if (!/CDP connection closed/i.test(message)) throw error;
    const interruptedPhase = phase;
    await finishNativeMetrics();
    return buildReport({
      complete: false,
      phase: interruptedPhase,
      error: message,
    });
  } finally {
    for (const unsubscribe of [...unsubLogs, ...unsubNetwork]) unsubscribe();
    client.close();
    if (nativeMetricSession?.child && !nativeMetricSession.child.killed) {
      nativeMetricSession.child.kill();
    }
    inspector?.close();
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseDiagnosticArgs(argv);
    if (options.help) {
      console.log(DIAGNOSTIC_HELP);
      return 0;
    }
    if (options.summaryPath) {
      const report = JSON.parse(await (dependencies.readFile ?? readFile)(options.summaryPath, 'utf8'));
      console.log(formatDiagnosticSummary(report));
      return 0;
    }
    const report = await captureDiagnostics(options, dependencies);
    const stamp = report.capturedAt.replace(/[:.]/g, '-');
    const outputPath = options.outputPath || `diagnostics-${stamp}.json`;
    await (dependencies.writeFile ?? writeFile)(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(formatDiagnosticSummary(report));
    console.log(`Report written to ${outputPath}`);
    return 0;
  } catch (error) {
    console.error(`tv-diag: ${toErrorMessage(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
