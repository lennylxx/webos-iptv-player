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

export interface SearchIndexRequest {
  sessionId: number;
  reset?: boolean;
  channels?: string[][];
  programmes?: string[][];
  movies?: string[];
  series?: string[];
}

export interface SearchIndexResponse {
  accepted: boolean;
}

export interface SearchQueryRequest {
  sessionId: number;
  query: string;
  limit: number;
  includeCatalog: boolean;
}

export interface SearchRankedIndices {
  indices: number[];
  hasMore: boolean;
}

export interface SearchQueryResponse {
  channels: SearchRankedIndices;
  programmes: SearchRankedIndices;
  movies: SearchRankedIndices;
  series: SearchRankedIndices;
}

export interface AppWorkerTasks {
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
  };
  'search.index': {
    request: SearchIndexRequest;
    response: SearchIndexResponse;
  };
  'search.query': {
    request: SearchQueryRequest;
    response: SearchQueryResponse | null;
  };
}
