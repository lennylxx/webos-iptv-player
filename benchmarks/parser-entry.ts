import { parseM3U } from '../src/parsers/m3u-parser';
import { parseXMLTV } from '../src/parsers/xmltv-parser';

interface BenchmarkParseResult {
  channels: number;
  groups?: number;
  programmes?: number;
}

interface BenchmarkParserApi {
  parseM3U(text: string): BenchmarkParseResult;
  parseXMLTV(text: string): BenchmarkParseResult;
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
  parseXMLTV(text) {
    const parsed = parseXMLTV(text);
    let programmes = 0;
    for (const list of Object.values(parsed.programmes)) programmes += list.length;
    return {
      channels: Object.keys(parsed.channels).length,
      programmes,
    };
  },
};
