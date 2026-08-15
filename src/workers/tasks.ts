import type { ParsedEpg } from '../types';
import type { XMLTVParseStats } from '../parsers/xmltv-parser';

export interface XMLTVWorkerRequest {
  url: string;
  timeout: number;
  options: {
    nowMs?: number;
    channelIds?: string[];
    channelNames?: string[];
    retainChannelCatalog?: boolean;
  };
}

export interface XMLTVWorkerResponse {
  data: ParsedEpg;
  stats: XMLTVParseStats;
  metrics: {
    transport: 'stream' | 'array_buffer';
    encoding: 'gzip' | 'plain';
    attempts: number;
    inputBytes: number;
    chunks: number;
    elapsedMs: number;
  };
}

export interface AppWorkerTasks {
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
  };
}
