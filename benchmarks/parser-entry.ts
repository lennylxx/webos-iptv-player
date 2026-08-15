import { parseM3U } from '../src/parsers/m3u-parser';
import { parseXMLTVWithStats, XMLTVStreamParser } from '../src/parsers/xmltv-parser';
import { fetchAndParseXMLTV } from '../src/parsers/xmltv-loader';
import { fetchMaybeGzipText } from '../src/utils/fetch-helper';
import { isAppWorkerRunning } from '../src/workers/app-worker-client';

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
  parseXMLTV(text: string, options?: BenchmarkXMLTVOptions): BenchmarkParseResult;
  loadXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkXMLTVLoadResult>;
  profileXMLTV(url: string, options?: BenchmarkXMLTVOptions): Promise<BenchmarkParseResult>;
  loadXMLTVBuffered(url: string, options?: BenchmarkXMLTVOptions):
    Promise<BenchmarkXMLTVLoadResult>;
  profileXMLTVBuffered(url: string, options?: BenchmarkXMLTVOptions):
    Promise<BenchmarkParseResult>;
  workerRunning(): boolean;
}

interface BenchmarkXMLTVLoadResult extends BenchmarkParseResult {
  durationMs: number;
}

declare global {
  const __ENABLE_PSEUDO_LOCALE__: boolean;

  interface Window {
    __IPTV_BENCHMARK__?: BenchmarkParserApi;
  }
}

window.__IPTV_BENCHMARK__ = {
  workerRunning() {
    return isAppWorkerRunning();
  },
  parseM3U(text) {
    const parsed = parseM3U(text, 'http://host/list.m3u');
    return {
      channels: parsed.channels.length,
      groups: parsed.groups.length,
    };
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
  async loadXMLTVBuffered(url, options) {
    const started = performance.now();
    const text = await fetchMaybeGzipText(url, 120000);
    const parsed = parseXMLTVWithStats(text, {
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    return {
      durationMs: performance.now() - started,
      channels: Object.keys(parsed.data.programmes).length,
      catalogChannels: Object.keys(parsed.data.channels).length,
      programmes: parsed.stats.programmesKept,
      programmesSeen: parsed.stats.programmesSeen,
      retained: parsed.data,
    };
  },
  async profileXMLTVBuffered(url, options) {
    const text = await fetchMaybeGzipText(url, 120000);
    const parser = new XMLTVStreamParser({
      channelIds: options?.channelIds ? new Set(options.channelIds) : undefined,
      channelNames: options?.channelNames ? new Set(options.channelNames) : undefined,
      retainChannelCatalog: options?.retainChannelCatalog,
    });
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      parser.write(text.slice(offset, offset + chunkSize));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const data = parser.finish();
    return {
      channels: Object.keys(data.programmes).length,
      catalogChannels: Object.keys(data.channels).length,
      programmes: parser.stats.programmesKept,
      programmesSeen: parser.stats.programmesSeen,
      retained: data,
    };
  },
};
