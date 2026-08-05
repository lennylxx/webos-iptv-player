#!/usr/bin/env node
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  CdpClient,
  resolveCdpTarget,
} from './cdp-client.mjs';
import {
  enableCdpLogs,
  normalizeCdpLogEvent,
  subscribeCdpLogs,
} from './cdp-logs.mjs';

const DEFAULT_APP_ID = 'com.lennylxx.iptv';
const DEFAULT_PORT = 9998;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DURATION_MS = 15000;
const PREVIEW_BYTES = 2048;
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

const requiredValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`Missing value for ${flag}.`);
  return value;
};

export function parseDiagnosticArgs(argv = []) {
  const options = {
    appId: DEFAULT_APP_ID,
    device: process.env.TV_DEVICE || '',
    host: '',
    port: DEFAULT_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    durationMs: DEFAULT_DURATION_MS,
    durationSpecified: false,
    attach: false,
    playChannel: null,
    outputPath: '',
    full: false,
    summaryPath: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--app') {
      options.appId = requiredValue(argv, i, token);
      i++;
    } else if (token === '--device') {
      options.device = requiredValue(argv, i, token);
      i++;
    } else if (token === '--host') {
      options.host = requiredValue(argv, i, token);
      i++;
    } else if (token === '--port') {
      options.port = Number(requiredValue(argv, i, token));
      i++;
    } else if (token === '--timeout') {
      options.timeoutMs = Number(requiredValue(argv, i, token)) * 1000;
      i++;
    } else if (token === '--attach') {
      options.attach = true;
    } else if (token === '--duration') {
      options.durationMs = Number(requiredValue(argv, i, token)) * 1000;
      options.durationSpecified = true;
      i++;
    } else if (token === '--play-channel') {
      options.playChannel = Number(requiredValue(argv, i, token));
      i++;
    } else if (token === '--output') {
      options.outputPath = requiredValue(argv, i, token);
      i++;
    } else if (token === '--summary') {
      options.summaryPath = requiredValue(argv, i, token);
      i++;
    } else if (token === '--full') {
      options.full = true;
    } else if (token === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Invalid value for --port.');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Invalid value for --timeout.');
  }
  if (!Number.isInteger(options.durationMs)
      || options.durationMs < 1000 || options.durationMs > 3600000) {
    throw new Error('Invalid value for --duration.');
  }
  if (options.playChannel !== null
      && (!Number.isInteger(options.playChannel) || options.playChannel < 0)) {
    throw new Error('Invalid value for --play-channel.');
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
    for (const secret of this.secrets) text = text.split(secret).join(valueSummary(secret));
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

export function extractPlaybackTimeline(logs) {
  const timeline = [];
  for (const entry of logs) {
    const code = entry.text.match(/\bevent=([a-z0-9_.-]+)/i)?.[1];
    if (!code) continue;
    const session = Number(entry.text.match(/\bsession=(\d+)/)?.[1] ?? NaN);
    const load = Number(entry.text.match(/\bload=(\d+)/)?.[1] ?? NaN);
    timeline.push({
      observedAt: entry.observedAt,
      code,
      session: Number.isFinite(session) ? session : null,
      load: Number.isFinite(load) ? load : null,
      level: entry.level,
      text: entry.text,
    });
  }
  return timeline;
}

export function assembleDiagnosticReport({
  capturedAt,
  full,
  app,
  environment,
  probe,
  native,
  nativeMetrics = null,
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
    } : null,
  }));
  const safeLogs = logs.map((entry) => ({ ...entry, text: redactor.text(entry.text) }));
  const probeState = probe?.state ?? {};
  const media = probeState.media ? {
    ...probeState.media,
    src: redactor.url(probeState.media.src ?? ''),
    error: probeState.media.error ? {
      ...probeState.media.error,
      message: redactor.text(probeState.media.error.message ?? ''),
    } : null,
  } : null;
  return {
    schemaVersion: 1,
    capturedAt,
    redacted: !full,
    app,
    environment,
    state: { ...probeState, media },
    storage: probe?.storage ?? {},
    nativeMetrics,
    playlists,
    playback: extractPlaybackTimeline(safeLogs),
    logs: safeLogs,
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
  const lines = [
    `Diagnostics captured: ${report.capturedAt}`,
    `App: ${report.app?.id ?? '?'} ${report.app?.version ?? '?'}`,
    `Environment: ${report.environment?.userAgent ?? '?'}`,
    `State: ${report.state?.view ?? '?'} | channels=${String(report.state?.channels ?? 0)}`,
    `Playlists: ${String(report.playlists?.length ?? 0)}`,
  ];
  if (report.state?.media) {
    const media = report.state.media;
    lines.push(
      `Media: ${media.paused ? 'paused' : 'playing'} | ready=${String(media.readyState)}`
      + ` network=${String(media.networkState)} time=${String(media.currentTime)}s`,
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
    for (const process of metrics.processes ?? []) {
      lines.push(
        `- ${process.kind} pid=${String(process.pid)}`
        + ` cpu=${process.cpuPercent == null ? '?' : process.cpuPercent.toFixed(1)}%`
        + ` rss=${process.rssKb == null ? '?' : (process.rssKb / 1024).toFixed(1)}MiB`
        + ` threads=${String(process.threads ?? '?')}`
        + ` wait=${process.schedulerWaitMs == null ? '?' : process.schedulerWaitMs.toFixed(1)}ms`
        + `${process.startedDuringWindow ? ' new' : ''}`,
      );
    }
  }
  for (const playlist of report.playlists ?? []) {
    const webview = playlist.webview ?? {};
    const native = playlist.native ?? {};
    lines.push(
      `- ${playlist.source}: webview=${outcome(webview, 'unknown')}`
      + ` native=${outcome(native, 'not-run')} ${playlist.url}`,
    );
  }
  lines.push(`Playback events: ${String(report.playback?.length ?? 0)}`);
  for (const event of report.playback ?? []) {
    lines.push(
      `- ${event.code} session=${String(event.session ?? '?')} load=${String(event.load ?? '?')}`,
    );
  }
  lines.push(`Network requests: ${String(report.network?.length ?? 0)}`);
  lines.push(
    `Warnings: ${String((report.logs ?? []).filter((entry) => entry.level === 'warning').length)}`,
  );
  lines.push(`Errors: ${String((report.logs ?? []).filter((entry) => entry.level === 'error').length)}`);
  return lines.join('\n');
}

const activeProbeExpression = `(${function activeProbe(previewBytes) {
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
    try {
      const response = await fetch(url);
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        contentLength: response.headers.get('content-length') || '',
        bodyPreview: await readPreview(response),
        error: '',
      };
    } catch (error) {
      return { status: null, contentType: '', contentLength: '', bodyPreview: '', error: String(error) };
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
        webview: await fetchProbe(url),
        xtreamAuth,
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
    return {
      app: { id: app.id || '', version: app.version || '' },
      state: {
        view: visible ? visible.id : '',
        loading: (() => {
          const loading = document.querySelector('#view-loading');
          return loading ? !loading.classList.contains('hidden') : false;
        })(),
        channels: document.querySelectorAll('.channel-item').length,
        media: video ? {
          src: video.currentSrc || video.src || '',
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          currentTime: Math.round(video.currentTime * 100) / 100,
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
}.toString()})(${String(PREVIEW_BYTES)})`;

export function inspectorWebSocketUrl(output) {
  const match = String(output).match(/https?:\/\/[^\s]+\/devtools\/inspector\.html\?ws=([^\s&]+)/);
  if (!match) return null;
  const wsTarget = decodeURIComponent(match[1]);
  return `ws://${wsTarget}`;
}

export function startAresInspector(
  appId,
  device,
  { spawn = spawnChild, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const deviceArgs = device ? ['-d', device] : [];
  const child = spawn('ares-inspect', ['-a', appId, ...deviceArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const wsUrl = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for ares-inspect'));
    }, timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    const onData = (chunk) => {
      output += String(chunk);
      const parsed = inspectorWebSocketUrl(output);
      if (parsed) finish(resolve, parsed);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (!inspectorWebSocketUrl(output)) {
        finish(reject, new Error(`ares-inspect exited before publishing a target (${String(code)})`));
      }
    });
  });
  return { child, wsUrl };
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

const nativeMetricCommand = (durationMs) => {
  const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
  return [
    'sample_native() {',
    'phase="$1"',
    'ticks=$(getconf CLK_TCK 2>/dev/null || echo 100)',
    'printf "@ticks|%s|%s\\n" "$phase" "$ticks"',
    'for p in $(pidof starfish-media-pipeline umediaserver 2>/dev/null); do',
    'comm=$(cat "/proc/$p/comm" 2>/dev/null)',
    'case "$comm" in starfish*) kind=starfish;; umediaserver*) kind=umediaserver;; *) continue;; esac',
    'set -- $(cat "/proc/$p/stat" 2>/dev/null); utime="${14}"; stime="${15}"; threads="${20}"',
    'rss=$(awk \'/^VmRSS:/ {print $2}\' "/proc/$p/status" 2>/dev/null)',
    'set -- $(cat "/proc/$p/schedstat" 2>/dev/null); run_ns="$1"; wait_ns="$2"',
    'printf "@proc|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n" "$phase" "$p" "$kind" "$utime" "$stime" "${rss:-0}" "${threads:-0}" "${run_ns:-0}" "${wait_ns:-0}"',
    'done',
    'for resource in cpu memory io; do',
    'awk -v phase="$phase" -v resource="$resource" \'$1 == "some" { avg=""; total=""; for (i=2;i<=NF;i++) { split($i,a,"="); if (a[1]=="avg10") avg=a[2]; if (a[1]=="total") total=a[2] } printf "@psi|%s|%s|%s|%s\\n", phase, resource, avg, total }\' "/proc/pressure/$resource" 2>/dev/null',
    'done',
    'awk -v phase="$phase" \'/:/ { gsub(":", "", $1); if ($1 != "lo") { rx += $2; tx += $10 } } END { printf "@net|%s|%.0f|%.0f\\n", phase, rx, tx }\' /proc/net/dev',
    'awk -v phase="$phase" \'$1 == "Tcp:" { if (!seen) { for (i=2;i<=NF;i++) key[i]=$i; seen=1 } else { for (i=2;i<=NF;i++) if (key[i]=="RetransSegs") value=$i; printf "@tcp|%s|%s\\n", phase, value; exit } }\' /proc/net/snmp',
    '}',
    'sample_native before',
    'printf "@native-ready\\n"',
    `sleep ${String(durationSeconds)}`,
    'sample_native after',
  ].join('\n');
};

const finiteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseNativeMetricOutput(output, durationMs) {
  const snapshots = {
    before: { ticks: 100, processes: [], psi: {}, network: null, tcpRetrans: null },
    after: { ticks: 100, processes: [], psi: {}, network: null, tcpRetrans: null },
  };
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.startsWith('@')) continue;
    const [type, phase, ...values] = line.slice(1).split('|');
    const snapshot = snapshots[phase];
    if (!snapshot) continue;
    if (type === 'ticks') {
      snapshot.ticks = finiteNumber(values[0]) ?? 100;
    } else if (type === 'proc') {
      const [pid, kind, utime, stime, rssKb, threads, runNs, waitNs] = values;
      snapshot.processes.push({
        pid: finiteNumber(pid),
        kind,
        cpuTicks: (finiteNumber(utime) ?? 0) + (finiteNumber(stime) ?? 0),
        rssKb: finiteNumber(rssKb),
        threads: finiteNumber(threads),
        runNs: finiteNumber(runNs),
        waitNs: finiteNumber(waitNs),
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
      rssKb: process.rssKb,
      threads: process.threads,
      schedulerRunMs: Math.max(0, process.runNs - (before?.runNs ?? 0)) / 1e6,
      schedulerWaitMs: Math.max(0, process.waitNs - (before?.waitNs ?? 0)) / 1e6,
    };
  });
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
  return {
    durationMs,
    processes,
    stoppedProcessIds: snapshots.before.processes
      .filter((process) => !snapshots.after.processes.some((item) => item.pid === process.pid))
      .map((process) => process.pid),
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
  { spawn = spawnChild, timeoutMs = durationMs + 30000 } = {},
) {
  const child = spawn(
    path.join('scripts', 'tv.sh'),
    ['run', nativeMetricCommand(durationMs)],
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
    'body=/tmp/iptv-diag-body-$$',
    'headers=/tmp/iptv-diag-headers-$$',
    `curl -L -sS --connect-timeout 10 --max-time 20 --range 0-${String(PREVIEW_BYTES - 1)}`
      + ` -D "$headers" -o "$body" ${shellQuote(url)}`,
    'rc=$?',
    `head -c ${String(PREVIEW_BYTES)} "$body" 2>/dev/null`,
    'status=$(awk \'/^HTTP\\// {code=$2} END {print code}\' "$headers" 2>/dev/null)',
    'content_type=$(awk \'BEGIN {IGNORECASE=1} /^Content-Type:/ {sub(/^[^:]*:[[:space:]]*/, ""); sub(/\\r$/, ""); value=$0} END {print value}\' "$headers" 2>/dev/null)',
    'printf \'\\n__IPTV_DIAG__%s|%s\' "$status" "$content_type"',
    'rm -f "$body" "$headers"',
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

const evaluate = async (client, expression) => {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
};

async function waitForSettle(client, timeoutMs, delayFn) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const settled = await evaluate(
      client,
      `(() => {
        var loading = document.querySelector('#view-loading');
        return Boolean(loading && loading.classList.contains('hidden'));
      })()`,
    ).catch(() => false);
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
    if (inspector?.child && !inspector.child.killed) inspector.child.kill();
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
  try {
    await enableCdpLogs(client, { history: true });
    await client.call('Network.enable');
    await client.call('Page.enable');
    let nativeMetrics = null;
    if (!options.attach) {
      await client.call('Page.reload', { ignoreCache: true });
      await waitForSettle(client, options.timeoutMs, dependencies.delay);
    }
    if (options.attach || options.playChannel !== null) {
      try {
        nativeMetricSession = dependencies.startNativeMetrics(options.durationMs);
        await nativeMetricSession.ready;
      } catch (error) {
        void nativeMetricSession?.result.catch(() => {});
        nativeMetrics = { error: toErrorMessage(error) };
        nativeMetricSession = null;
      }
    }
    if (options.playChannel !== null) {
      const activation = await evaluate(client, playbackActivationExpression(options.playChannel));
      if (!activation?.ok) {
        throw new Error(
          `Cannot play channel ${String(options.playChannel)}: ${activation?.error || 'unknown error'}`,
        );
      }
    }
    if (options.attach || options.playChannel !== null) {
      if (!nativeMetricSession) {
        await dependencies.delay(options.durationMs);
      } else {
        try {
          nativeMetrics = await nativeMetricSession.result;
        } catch (error) {
          nativeMetrics = { error: toErrorMessage(error) };
        }
      }
    }
    const probe = await evaluate(client, activeProbeExpression);
    const native = probe.playlists.map((playlist) =>
      runNativeProbe(playlist.__url, { execFile: dependencies.execFile }));
    return assembleDiagnosticReport({
      capturedAt: dependencies.now().toISOString(),
      full: options.full,
      app: { id: probe.app?.id || options.appId, version: probe.app?.version || '' },
      environment: {
        userAgent: probe.environment?.userAgent ?? '',
        viewport: probe.environment?.viewport ?? '',
        targetTitle: target.target?.title ?? '',
        targetDescription: target.target?.description ?? '',
      },
      probe,
      native,
      nativeMetrics,
      logs,
      networkEvents,
    });
  } finally {
    for (const unsubscribe of [...unsubLogs, ...unsubNetwork]) unsubscribe();
    client.close();
    if (nativeMetricSession?.child && !nativeMetricSession.child.killed) {
      nativeMetricSession.child.kill();
    }
    if (inspector?.child && !inspector.child.killed) inspector.child.kill();
  }
}

const HELP_TEXT = `Usage: scripts/tv.sh diag [options]

Capture a redacted TV diagnostics report with CDP logs, network activity,
playlist probes, playback events, media state, and optional native metrics.

Options:
  --app <id>             webOS app id (default: ${DEFAULT_APP_ID})
  --device <name>        Configured TV device (default: default device)
  --host <host>          Existing CDP discovery host instead of ares-inspect
  --port <port>          CDP discovery port with --host (default: ${String(DEFAULT_PORT)})
  --timeout <seconds>    App/inspector startup timeout (default: 30)
  --play-channel <index> Cold-start, then activate the rendered channel index
  --attach               Observe the running app without close, reload, or input
  --duration <seconds>   Playback/native metric window (default: 15; max: 3600)
  --output <path>        JSON report path (default: timestamped filename)
  --full                 Disable redaction; the report may contain secrets
  --summary <path>       Print a readable summary of an existing JSON report
  --help                 Show this help

--duration requires --attach or --play-channel. Those two modes cannot be
combined. Reports stay local and are never uploaded.`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseDiagnosticArgs(argv);
    if (options.help) {
      console.log(HELP_TEXT);
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
