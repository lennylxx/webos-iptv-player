import { CONFIG } from '../config';
import type { Channel, ChannelHealthRecord, ChannelHealthStatus } from '../types';
import { channelKey } from '../utils/channel';
import { createLogger } from '../utils/logger';
import { isMpdText } from '../utils/url';
import {
  clearCachedChannelHealth,
  getCachedChannelHealth,
  setCachedChannelHealth,
} from './idb-cache';

const log = createLogger('ChannelHealth');

export interface ChannelHealthSummary {
  total: number;
  unknown: number;
  healthy: number;
  suspect: number;
  unavailable: number;
}

export interface ChannelHealthProgress extends ChannelHealthSummary {
  completed: number;
}

interface CheckOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ChannelHealthProgress) => void;
  waitWhilePaused?: () => Promise<void>;
}

interface ProbeResponse {
  bytes: Uint8Array;
  contentType: string;
  url: string;
}

function isStatus(value: unknown): value is ChannelHealthStatus {
  return value === 'healthy' || value === 'suspect' || value === 'unavailable';
}

function validateRecords(stored: unknown): Record<string, ChannelHealthRecord> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const records: Record<string, ChannelHealthRecord> = {};
  for (const key of Object.keys(stored)) {
    const value = (stored as Record<string, unknown>)[key];
    if (!value || typeof value !== 'object') continue;
    const item = value as Partial<ChannelHealthRecord>;
    if (!isStatus(item.status)
        || typeof item.consecutiveFailures !== 'number'
        || typeof item.lastCheckedAt !== 'number') continue;
    records[key] = item as ChannelHealthRecord;
  }
  return records;
}

function summaryFor(
  channels: Channel[],
  records: Record<string, ChannelHealthRecord>,
): ChannelHealthSummary {
  const summary: ChannelHealthSummary = {
    total: channels.length,
    unknown: 0,
    healthy: 0,
    suspect: 0,
    unavailable: 0,
  };
  for (const channel of channels) {
    const status = records[channelKey(channel)]?.status;
    if (status) summary[status]++;
    else summary.unknown++;
  }
  return summary;
}

function resolveUrl(path: string, base: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    throw new Error('invalid_url');
  }
}

function firstManifestUri(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.charAt(0) !== '#') return trimmed;
  }
  return '';
}

async function requestPrefix(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProbeResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONFIG.CHANNEL_HEALTH.TIMEOUT_MS);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(url, {
      headers: { ...headers, Range: `bytes=0-${CONFIG.CHANNEL_HEALTH.MAX_PROBE_BYTES - 1}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);

    reader = typeof response.body?.getReader === 'function'
      ? response.body.getReader()
      : null;
    let bytes: Uint8Array;
    if (reader) {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (length < CONFIG.CHANNEL_HEALTH.MAX_PROBE_BYTES) {
        const result = await reader.read();
        if (result.done) break;
        if (!result.value?.length) continue;
        const remaining = CONFIG.CHANNEL_HEALTH.MAX_PROBE_BYTES - length;
        const chunk = result.value.length > remaining
          ? result.value.slice(0, remaining)
          : result.value;
        chunks.push(chunk);
        length += chunk.length;
      }
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      const raw = new Uint8Array(await response.arrayBuffer());
      bytes = raw.length > CONFIG.CHANNEL_HEALTH.MAX_PROBE_BYTES
        ? raw.slice(0, CONFIG.CHANNEL_HEALTH.MAX_PROBE_BYTES)
        : raw;
    }
    if (!bytes.length) throw new Error('empty_response');
    return {
      bytes,
      contentType: response.headers?.get('content-type')?.toLowerCase() ?? '',
      url: response.url || url,
    };
  } catch (err) {
    if (signal?.aborted) throw new Error('aborted');
    if (timedOut) throw new Error('timeout');
    throw err;
  } finally {
    if (reader) void reader.cancel().catch(() => {});
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function probeUrl(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  depth = 0,
): Promise<void> {
  const response = await requestPrefix(url, headers, signal);
  const text = new TextDecoder().decode(response.bytes).replace(/^\uFEFF/, '').replace(/^\s+/, '');
  const lower = text.slice(0, 64).toLowerCase();
  if (response.contentType.indexOf('text/html') >= 0
      || response.contentType.indexOf('application/json') >= 0
      || lower.indexOf('<!doctype html') === 0
      || lower.indexOf('<html') === 0
      || lower.indexOf('{"') === 0) {
    throw new Error('invalid_content');
  }
  // XML media probes accept MPD roots; other XML responses are provider errors.
  if (text.indexOf('<') === 0 && !isMpdText(text)) throw new Error('invalid_content');
  // MPD segment URLs are template-derived, so manifest validation completes the probe.
  if (text.indexOf('#EXTM3U') !== 0) return;
  if (depth >= CONFIG.CHANNEL_HEALTH.MAX_MANIFEST_DEPTH) {
    throw new Error('manifest_depth');
  }
  const next = firstManifestUri(text);
  if (!next) throw new Error('empty_manifest');
  await probeUrl(resolveUrl(next, response.url), headers, signal, depth + 1);
}

function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown';
  const message = err.message.toLowerCase();
  if (message.indexOf('http_') === 0
      || message === 'timeout'
      || message === 'empty_response'
      || message === 'invalid_content'
      || message === 'empty_manifest'
      || message === 'manifest_depth'
      || message === 'invalid_url') return message;
  return 'network';
}

class ChannelHealthServiceImpl {
  private records: Record<string, ChannelHealthRecord> = {};
  private initializePromise: Promise<void> | null = null;

  private data(): Record<string, ChannelHealthRecord> {
    return this.records;
  }

  initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = getCachedChannelHealth<unknown>()
        .then(records => {
          this.records = validateRecords(records);
        });
    }
    return this.initializePromise;
  }

  getRecord(channel: Channel): ChannelHealthRecord | null {
    return this.data()[channelKey(channel)] ?? null;
  }

  getSummary(channels: Channel[]): ChannelHealthSummary {
    return summaryFor(channels, this.data());
  }

  async clear(): Promise<void> {
    this.reset();
    await clearCachedChannelHealth();
  }

  reset(): void {
    this.records = {};
    this.initializePromise = Promise.resolve();
  }

  async checkAll(channels: Channel[], options: CheckOptions = {}): Promise<ChannelHealthSummary> {
    await this.initialize();
    const unique: Channel[] = [];
    const seen = new Set<string>();
    for (const channel of channels) {
      const key = channelKey(channel);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(channel);
    }

    let completed = 0;
    for (let offset = 0; offset < unique.length; offset += CONFIG.CHANNEL_HEALTH.CONCURRENCY) {
      await options.waitWhilePaused?.();
      if (options.signal?.aborted) break;
      const batch = unique.slice(offset, offset + CONFIG.CHANNEL_HEALTH.CONCURRENCY);
      const changed: Record<string, ChannelHealthRecord> = {};
      await Promise.all(batch.map(async (channel) => {
        if (options.signal?.aborted) return;
        const key = channelKey(channel);
        const previous = this.data()[key];
        const started = Date.now();
        try {
          await probeUrl(channel.url, channel.httpHeaders ?? {}, options.signal);
          if (options.signal?.aborted) return;
          if (this.data()[key] === previous) {
            this.recordSuccess(key, Date.now() - started);
            changed[key] = this.data()[key];
          }
        } catch (err) {
          if (options.signal?.aborted) return;
          if (this.data()[key] === previous) {
            this.recordFailure(key, errorCode(err));
            changed[key] = this.data()[key];
          }
        }
        completed++;
        options.onProgress?.({
          ...summaryFor(unique, this.data()),
          completed,
        });
      }));
      const current: Record<string, ChannelHealthRecord> = {};
      for (const key of Object.keys(changed)) {
        if (this.data()[key] === changed[key]) current[key] = changed[key];
      }
      if (Object.keys(current).length) await setCachedChannelHealth(current);
    }
    return summaryFor(unique, this.data());
  }

  async recordPlaybackFailure(channel: Channel, error: string): Promise<void> {
    await this.initialize();
    const key = channelKey(channel);
    const previous = this.data()[key];
    const consecutiveFailures = Math.max(
      CONFIG.CHANNEL_HEALTH.FAILURES_UNTIL_UNAVAILABLE,
      (previous?.consecutiveFailures ?? 0) + 1,
    );
    this.data()[key] = {
      status: 'unavailable',
      consecutiveFailures,
      lastCheckedAt: Date.now(),
      lastHealthyAt: previous?.lastHealthyAt,
      error,
    };
    await setCachedChannelHealth({ [key]: this.data()[key] });
    log.warn(
      'Playback marked channel unavailable',
      'event=channel.health.playback.failed',
      `reason=${error}`,
    );
  }

  async recordPlaybackSuccess(channel: Channel, latencyMs: number): Promise<boolean> {
    await this.initialize();
    const key = channelKey(channel);
    if (!this.data()[key]) return false;
    this.recordSuccess(key, latencyMs);
    await setCachedChannelHealth({ [key]: this.data()[key] });
    return true;
  }

  private recordSuccess(key: string, latencyMs: number): void {
    const now = Date.now();
    this.data()[key] = {
      status: 'healthy',
      consecutiveFailures: 0,
      lastCheckedAt: now,
      lastHealthyAt: now,
      latencyMs,
    };
  }

  private recordFailure(key: string, error: string): void {
    const previous = this.data()[key];
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    this.data()[key] = {
      status: consecutiveFailures >= CONFIG.CHANNEL_HEALTH.FAILURES_UNTIL_UNAVAILABLE
        ? 'unavailable'
        : 'suspect',
      consecutiveFailures,
      lastCheckedAt: Date.now(),
      lastHealthyAt: previous?.lastHealthyAt,
      error,
    };
    log.warn(
      'Channel health probe failed',
      'event=channel.health.probe.failed',
      `reason=${error}`,
      `failures=${consecutiveFailures}`,
    );
  }
}

export const ChannelHealthService = new ChannelHealthServiceImpl();
