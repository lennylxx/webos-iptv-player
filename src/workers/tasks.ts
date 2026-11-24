import type {
  Channel,
  ParsedEpg,
  ParsedPlaylist,
  SeriesItem,
  VodItem,
} from '../types';
import type { CatalogConcealment } from '../utils/catalog-concealment';
import type { XMLTVParseStats } from '../parsers/xmltv-parser';
import type { XtreamLiveReference } from '../utils/xtream-live-match';
import type { XtreamGroupNameFilter } from '../utils/xtream-category-filter';
import type { XtreamCredentials, XtreamLiveOutput } from '../utils/xtream-url';
import type {
  XtreamClockFailure,
  XtreamLiveStreamsRequest,
  XtreamLiveStreamsResponse,
  XtreamServerClock,
} from '../services/xtream-client';
import type {
  XtreamCatalogStreamChunk,
  XtreamCatalogStreamRequest,
  XtreamCatalogStreamResponse,
} from '../services/xtream-catalog-stream';
import type { HeldWriteResult } from '../services/held-records';
import type { HeldValueWriteRequest } from './held-values';

export interface M3UWorkerRequest {
  url: string;
  timeout: number;
  xtreamLive?: XtreamLiveReference[];
  xtreamBaseUrl?: string;
  xtreamGroupFilter?: XtreamGroupNameFilter;
  /** De-duplicate streams in the worker and stamp each channel with it. */
  playlistId?: string;
  /** Keep the channels in the worker so it can write the playlist cache. */
  holdChannels?: boolean;
  /** Stamp catch-up on channels of archived `xtreamLive` streams. */
  xtreamCatchup?: XtreamCatchupRequest;
}

export interface XtreamCatchupRequest {
  accountId: string;
  credentials: XtreamCredentials;
  output: XtreamLiveOutput;
  /** The whole Live catalog's counts, before any category filter, for the log. */
  catalogStreams?: number;
  catalogArchived?: number;
}

export interface XtreamCatchupCounts {
  streams: number;
  archived: number;
  enabled: number;
  unmatched: number;
  /** `late`: the clock missed the stamping but arrived before the load ended. */
  clock: 'ok' | 'late' | 'missing';
  lateClock?: XtreamServerClock;
  /** Why a needed clock is missing; `wait` when it never answered in time. */
  clockFailure?: XtreamClockFailure | 'wait';
}

export interface M3UWorkerResponse {
  data: ParsedPlaylist;
  metrics: {
    transport: 'stream' | 'array_buffer';
    filter: 'none' | 'unavailable' | 'live_catalog';
    inputBytes: number;
    chunks: number;
    channelsKept: number;
    channelsDropped: number;
    /** Set when the worker de-duplicated the playlist by stream. */
    duplicates?: number;
    /** Set when the worker stamped Xtream catch-up on the channels. */
    catchup?: XtreamCatchupCounts;
    elapsedMs: number;
  };
  /** The worker kept every channel it sent, chunks first, for the cache write. */
  held?: { token: string };
  /** The header's catch-up was revoked: the first this many channels sent in
   *  chunks still carry it and are to be cleared with revokeInheritedCatchup. */
  catchupRevokedBefore?: number;
}

export type M3UWorkerChunk =
  | {
      kind: 'channels';
      channels: Channel[];
      inputBytes: number;
      /** The response's decoded size, when its headers reveal it. */
      totalBytes?: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    }
  | {
      kind: 'progress';
      inputBytes: number;
      totalBytes?: number;
      chunks: number;
      channelsEmitted: number;
      channelsDropped: number;
    }
  | {
      /** The first `before` channels sent took catch-up from the #EXTM3U
       *  header, which a later channel's own attribute revoked. */
      kind: 'catchupRevoked';
      before: number;
    };

export interface XMLTVWorkerRequest {
  url: string;
  timeout: number;
  options: {
    nowMs?: number;
    channelIds?: string[];
    channelNames?: string[];
    retainChannelCatalog?: boolean;
    maxProgrammes?: number;
    catchupIdChannelIds?: string[];
    catchupIdChannelNames?: string[];
  };
  /** Keep the parsed guide so its cache write can run in the worker. */
  holdForCache?: boolean;
}

export interface XMLTVWorkerResponse {
  data: ParsedEpg;
  stats: XMLTVParseStats;
  /** Only for a complete guide with programmes, the one the page caches. */
  held?: { token: string };
  metrics: {
    transport: 'stream' | 'array_buffer';
    encoding: 'gzip' | 'plain';
    attempts: number;
    inputBytes: number;
    chunks: number;
    elapsedMs: number;
  };
}

export type XMLTVWorkerChunk =
  | { kind: 'guide'; part: 'channels' | 'programmes' | 'catchupIds'; blocks: string[] }
  | {
      kind: 'progress';
      attempt: number;
      encoding: 'gzip' | 'plain';
      inputBytes: number;
      chunks: number;
    };

export type SearchIndexSource = 'channels' | 'programmes' | 'movies' | 'series';

export interface SearchCacheRecord {
  store: 'playlist-cache' | 'epg-cache' | 'catalog-cache';
  key: string;
  timestamp: number;
}

/** A few documents as the main thread sees them, to catch a drifted record. */
export interface SearchDocumentSamples {
  indices: number[];
  documents: string[][];
}

/** Channel documents read from the playlist-cache record. */
export interface SearchCachedChannels {
  record: SearchCacheRecord;
  length: number;
  /** Record index of each document, in display order. */
  selection: Uint32Array;
  /** Documents whose display fields differ from the source name and group. */
  overrideIndices: number[];
  overrides: string[][];
  samples: SearchDocumentSamples;
}

/**
 * Programme documents read from epg-cache records: each run is one channel's
 * programme list, joined with that channel document's name and group.
 */
export interface SearchCachedProgrammes {
  records: SearchCacheRecord[];
  runChannels: Uint32Array;
  runRecords: Uint32Array;
  runIds: string[];
  runCounts: Uint32Array;
  samples: SearchDocumentSamples;
}

/** A guide source in priority order; `record` is null while it has no loaded guide. */
export interface SearchGuideSource {
  url: string;
  kind: 'manual' | 'm3u' | 'xtream';
  playlistIds: string[];
  record: SearchCacheRecord | null;
}

/**
 * Programmes the worker matches to the cached channels itself, as the page's
 * EpgService would, so the page walks no channel list for them.
 */
export interface SearchGuideProgrammes {
  sources: SearchGuideSource[];
  /** Saved guide mappings as [channel index, guide channel key]. */
  mappings: Array<[number, string]>;
  /** The page's own matches: channel index, guide channel key ('' for none), programme count. */
  samples: Array<[number, string, number]>;
}

/** Each matched channel's programme run, in the worker's programme order. */
export interface SearchProgrammeRuns {
  channels: Uint32Array;
  counts: Uint32Array;
}

/** Name documents read from a catalog-cache record. */
export interface SearchCachedNames {
  record: SearchCacheRecord;
  length: number;
  /** Record index of each document; null keeps every record item in order. */
  selection: Uint32Array | null;
  samples: SearchDocumentSamples;
}

/**
 * A whole catalog the worker reads, filters, and keeps, so the page holds
 * none of it: query answers carry the ranked items themselves.
 */
/** The categories of the few catalog items that have parental rules. */
export interface CatalogMembersRequest {
  record: SearchCacheRecord;
  idField: 'streamId' | 'seriesId';
  ids: string[];
}

/** [itemId, categoryId] for each requested id in the record; null: unreadable. */
export interface CatalogMembersResponse {
  members: Array<[string, string]>;
}

export interface SearchCatalogRecord {
  record: SearchCacheRecord;
  concealment: CatalogConcealment | null;
}

/**
 * One slice of a source posted from the main thread. The worker stages slices
 * in order and swaps the source in once `total` documents have arrived.
 */
export interface SearchIndexChunk {
  source: SearchIndexSource;
  start: number;
  total: number;
  /** Channel or programme field lists. */
  documents?: string[][];
  /** Movie or series names. */
  names?: string[];
}

export interface SearchIndexRequest {
  sessionId: number;
  reset?: boolean;
  chunk?: SearchIndexChunk;
  cachedChannels?: SearchCachedChannels;
  cachedProgrammes?: SearchCachedProgrammes;
  guideProgrammes?: SearchGuideProgrammes;
  cachedMovies?: SearchCachedNames;
  cachedSeries?: SearchCachedNames;
  catalogMovies?: SearchCatalogRecord;
  catalogSeries?: SearchCatalogRecord;
}

export interface SearchIndexUnresolved {
  source: SearchIndexSource;
  reason: string;
}

export interface SearchIndexResponse {
  accepted: boolean;
  /** Cached sources the worker could not read; post them as arrays instead. */
  unresolved?: SearchIndexUnresolved[];
  /** Source indexes the worker built and could store, pending a reservation. */
  persist?: SearchIndexCandidate[];
  /** Source records served from a prepared index vs folded from the record. */
  loaded?: { persisted: number; built: number };
  /** The runs of a `guideProgrammes` request the worker matched. */
  programmeRuns?: SearchProgrammeRuns;
}

/** A built source index, sized for the page's cache reservation. */
export interface SearchIndexCandidate {
  key: string;
  /** Key prefix shared by every index of the same source record. */
  prefix: string;
  bytes: number;
}

export interface SearchIndexPersistEntry {
  key: string;
  prefix: string;
  /** Cache bookkeeping fields the page reserved for the record. */
  fields: Record<string, unknown>;
}

export interface SearchIndexPersistRequest {
  entries: SearchIndexPersistEntry[];
}

export interface SearchIndexPersistResponse {
  written: string[];
  /** Writes that failed; the worker cannot log to the TV's page console. */
  failed?: Array<{ key: string; reason: string }>;
}

/** A source cache record to index ahead of Search; no timestamp means look it up. */
export interface SearchPrewarmSource {
  store: SearchCacheRecord['store'];
  key: string;
  timestamp?: number;
}

export interface SearchPrewarmRequest {
  sources: SearchPrewarmSource[];
}

export interface SearchPrewarmResponse {
  persist: SearchIndexCandidate[];
  skipped?: Array<{ store: SearchCacheRecord['store']; reason: string }>;
}

export interface SearchQueryRequest {
  sessionId: number;
  query: string;
  limit: number;
  includeCatalog: boolean;
  // False while the page still builds its program list.
  includeProgrammes?: boolean;
  /** The catalog items the page kept from earlier answers. */
  delivered?: SearchDeliveredCount;
}

export interface SearchDeliveredCount {
  epoch: number;
  movies: number;
  series: number;
}

export interface SearchRankedIndices {
  indices: number[];
}

/**
 * Catalog record items the page lacks for this answer's indices. A new epoch
 * means the page drops every item it kept before merging these.
 */
export interface SearchDeliveredItems {
  epoch: number;
  movies: Array<[number, VodItem]>;
  series: Array<[number, SeriesItem]>;
}

export interface SearchQueryResponse {
  channels: SearchRankedIndices;
  programmes: SearchRankedIndices;
  movies: SearchRankedIndices;
  series: SearchRankedIndices;
  items?: SearchDeliveredItems;
}

export interface ListSearchIndexRequest {
  owner: string;
  sessionId: number;
  mode: 'fields' | 'names';
  documents: string[][];
}

export interface ListSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
}

export interface ScopedSearchReleaseRequest {
  owner: string;
  sessionId: number;
}

export interface MappingSearchDocument {
  id: string;
  channelId: string;
  name: string;
  fields: string[];
  sourceIndex: number;
}

export interface MappingSearchIndexRequest {
  owner: string;
  sessionId: number;
  documents: MappingSearchDocument[];
}

export interface MappingSearchQueryRequest {
  owner: string;
  sessionId: number;
  query: string;
  selectedId: string;
  // With nothing but the selected entry containing the query, answer with up
  // to this many entries whose names are most alike it.
  similarLimit?: number;
}

export interface MappingRankedIndices extends SearchRankedIndices {
  // The indices are names alike the query, not ones containing it.
  similar?: boolean;
}

export interface MappingSimilarRequest {
  owner: string;
  sessionId: number;
  name: string;
  limit: number;
}

export interface MappingSimilarResponse {
  indices: number[];
  // The best entry has the same name, tags and spelling aside.
  sameName: boolean;
}

export interface AppWorkerTasks {
  'm3u.load': {
    request: M3UWorkerRequest;
    response: M3UWorkerResponse;
    chunk: M3UWorkerChunk;
  };
  'xmltv.load': {
    request: XMLTVWorkerRequest;
    response: XMLTVWorkerResponse;
    chunk: XMLTVWorkerChunk;
  };
  'xtream.live-streams': {
    request: XtreamLiveStreamsRequest;
    response: XtreamLiveStreamsResponse;
  };
  'xtream.catalog-stream': {
    request: XtreamCatalogStreamRequest;
    response: XtreamCatalogStreamResponse;
    chunk: XtreamCatalogStreamChunk;
  };
  'xtream.catalog-stream.cancel': {
    request: { token: string };
    response: void;
  };
  'cache.write-held': {
    request: HeldValueWriteRequest;
    response: HeldWriteResult;
  };
  'cache.measure-held': {
    request: { token: string };
    response: number | null;
  };
  'cache.release-held': {
    request: { token: string };
    response: void;
  };
  'search.index': {
    request: SearchIndexRequest;
    response: SearchIndexResponse;
  };
  'catalog.members': {
    request: CatalogMembersRequest;
    response: CatalogMembersResponse | null;
  };
  'search.query': {
    request: SearchQueryRequest;
    response: SearchQueryResponse | null;
  };
  'search.prewarm': {
    request: SearchPrewarmRequest;
    response: SearchPrewarmResponse;
  };
  'search.persist': {
    request: SearchIndexPersistRequest;
    response: SearchIndexPersistResponse;
  };
  'list-search.index': {
    request: ListSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'list-search.query': {
    request: ListSearchQueryRequest;
    response: SearchRankedIndices | null;
  };
  'list-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.index': {
    request: MappingSearchIndexRequest;
    response: SearchIndexResponse;
  };
  'mapping-search.query': {
    request: MappingSearchQueryRequest;
    response: MappingRankedIndices | null;
  };
  'mapping-search.similar': {
    request: MappingSimilarRequest;
    response: MappingSimilarResponse | null;
  };
  'mapping-search.release': {
    request: ScopedSearchReleaseRequest;
    response: SearchIndexResponse;
  };
}
