import { parseM3U } from '../src/parsers/m3u-parser';
import { parseXMLTVWithStats } from '../src/parsers/xmltv-parser';

interface BenchmarkParseResult {
  channels: number;
  groups?: number;
  programmes?: number;
  programmesSeen?: number;
  /** The parsed data itself, so a caller can hold it and measure retained heap. */
  retained?: unknown;
}

interface BenchmarkXMLTVOptions {
  channelIds?: string[];
  channelNames?: string[];
}

interface BenchmarkParserApi {
  parseM3U(text: string): BenchmarkParseResult;
  parseXMLTV(text: string, options?: BenchmarkXMLTVOptions): BenchmarkParseResult;
}

declare global {
  const __ENABLE_PSEUDO_LOCALE__: boolean;

  interface Window {
    __IPTV_BENCHMARK__?: BenchmarkParserApi;
  }
}

window.__IPTV_BENCHMARK__ = {
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
    });
    return {
      channels: Object.keys(data.channels).length,
      programmes: stats.programmesKept,
      programmesSeen: stats.programmesSeen,
      retained: data,
    };
  },
};
