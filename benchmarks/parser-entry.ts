import { parseM3U } from '../src/parsers/m3u-parser';
import { parseXMLTVWithStats } from '../src/parsers/xmltv-parser';
import { fetchAndParseXMLTV } from '../src/parsers/xmltv-loader';
import { appWorkerGeneration } from '../src/workers/app-worker-client';
import { PlaylistService } from '../src/services/playlist-service';

interface BenchmarkParseResult {
  channels: number;
  catalogChannels?: number;
  groups?: number;
  programmes?: number;
  programmesSeen?: number;
  /** The parsed data itself, so a caller can hold it and measure retained heap. */
  retained?: unknown;
}

interface BenchmarkXMLTVOptions {
  channelIds?: string[];
  channelNames?: string[];
  retainChannelCatalog?: boolean;
}

interface BenchmarkParserApi {
  parseM3U(text: string): BenchmarkParseResult;
  prepareDerivedIndexes(scale: number): BenchmarkParseResult;
  measureDerivedIndexes(): BenchmarkDerivedIndexSample;
  clearDerivedIndexes(): void;
  parseXMLTV(text: string, options?: BenchmarkXMLTVOptions): BenchmarkParseResult;
  loadXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkXMLTVLoadResult>;
  profileXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkParseResult>;
  workerRunning(): boolean;
}

interface BenchmarkDerivedIndexSample {
  durationMs: number;
  channels: number;
  groups: number;
}

interface BenchmarkXMLTVLoadResult extends BenchmarkParseResult {
  durationMs: number;
}

type BenchmarkChannels = ReturnType<typeof parseM3U>['channels'];

interface DerivedIndexTarget {
  channels: BenchmarkChannels;
  groups: string[];
  reset(): void;
  buildDerivedIndexes(): void;
}

let derivedIndexChannels: BenchmarkChannels | null = null;

function derivedIndexTarget(): DerivedIndexTarget {
  return PlaylistService as unknown as DerivedIndexTarget;
}

declare global {
  const __APP_ID__: string;
  const __APP_VERSION__: string;
  const __SERVICE_ID__: string;
  const __ENABLE_PSEUDO_LOCALE__: boolean;

  interface Window {
    __IPTV_BENCHMARK__?: BenchmarkParserApi;
  }
}

window.__IPTV_BENCHMARK__ = {
  workerRunning() {
    return appWorkerGeneration() !== null;
  },
  parseM3U(text) {
    const parsed = parseM3U(text, 'http://host/list.m3u');
    return {
      channels: parsed.channels.length,
      groups: parsed.groups.length,
    };
  },
  prepareDerivedIndexes(scale) {
    const lines = ['#EXTM3U'];
    for (let index = 0; index < scale; index++) {
      lines.push(
        `#EXTINF:-1 tvg-id="ch${String(index)}" group-title="Group ${String(index % 100)}",Channel ${String(index)}`,
        `http://host/${String(index)}`,
      );
    }
    const parsed = parseM3U(lines.join('\n'), 'http://host/list.m3u');
    for (const channel of parsed.channels) channel.playlistIds = ['benchmark'];
    derivedIndexChannels = parsed.channels;
    derivedIndexTarget().reset();
    return {
      channels: parsed.channels.length,
      groups: parsed.groups.length,
    };
  },
  measureDerivedIndexes() {
    if (!derivedIndexChannels) throw new Error('Derived-index fixture is unavailable');
    const target = derivedIndexTarget();
    target.reset();
    target.channels = derivedIndexChannels;
    const started = performance.now();
    target.buildDerivedIndexes();
    return {
      durationMs: performance.now() - started,
      channels: target.channels.length,
      groups: target.groups.length,
    };
  },
  clearDerivedIndexes() {
    derivedIndexTarget().reset();
    derivedIndexChannels = null;
  },
  parseXMLTV(text, options) {
    const { data, stats } = parseXMLTVWithStats(text, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      channels: Object.keys(data.programmes).length,
      catalogChannels: Object.keys(data.channels).length,
      programmes: stats.programmesKept,
      programmesSeen: stats.programmesSeen,
      retained: data,
    };
  },
  async loadXMLTV(url, options) {
    const parseOptions = {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    };
    const started = performance.now();
    const parsed = await fetchAndParseXMLTV(url, 120000, parseOptions);
    return {
      durationMs: performance.now() - started,
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
  async profileXMLTV(url, options) {
    const parsed = await fetchAndParseXMLTV(url, 120000, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
};
