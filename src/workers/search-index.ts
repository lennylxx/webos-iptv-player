import {
  foldSearchText,
  prepareFoldedSearchItem,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import { CONFIG } from '../config';
import {
  cacheEntryMetaId,
  CACHE_META_STORE,
  cacheRecordTimestamp,
  SEARCH_INDEX_STORE,
} from '../services/idb-schema';
import {
  cachedChannelDocuments,
  cachedNameDocuments,
  cachedProgrammeRuns,
  checkProgrammeRuns,
  foldDocuments,
  joinProgrammeRuns,
} from './search-cache-documents';
import {
  SearchCacheError,
  type CachedRecord,
  type SearchCacheKey,
  type SearchCacheReader,
} from './search-cache-reader';
import {
  buildSourceIndex,
  parseSourceIndex,
  sourceIndexCandidate,
  sourceIndexKey,
  sourceIndexPrefix,
  sourceIndexRecord,
  type SourceIndex,
} from './search-source-index';
import type {
  SearchCacheRecord,
  SearchIndexCandidate,
  SearchIndexChunk,
  SearchIndexPersistRequest,
  SearchIndexPersistResponse,
  SearchIndexRequest,
  SearchIndexResponse,
  SearchIndexSource,
  SearchIndexUnresolved,
  SearchPrewarmRequest,
  SearchPrewarmResponse,
  SearchPrewarmSource,
  SearchQueryRequest,
  SearchQueryResponse,
  SearchRankedIndices,
} from './tasks';


type ReadSource = (ref: SearchCacheKey) => Promise<CachedRecord | null>;

export class SearchWorkerIndex {
  private sessionId: number | null = null;
  private channels: PreparedSearchItem<number>[] = [];
  // Folded channel documents, which cached programme documents are joined with.
  private channelDocuments: string[][] = [];
  private programmes: PreparedSearchItem<number>[] = [];
  private movies = emptyNames();
  private series = emptyNames();
  private pending: Promise<void> | null = null;
  private staging: Partial<Record<SearchIndexSource, { documents: string[][]; names: string[] }>> = {};
  // The latest index of each source record, by key prefix, for this worker's life.
  private readonly sources = new Map<string, SourceIndex>();
  // Index keys already stored or offered for storing, so none is offered twice.
  private readonly offered = new Set<string>();

  constructor(private readonly cache: SearchCacheReader | null = null) {}

  // Requests run in arrival order, so a query never sees a half-read cache.
  index(request: SearchIndexRequest): SearchIndexResponse | Promise<SearchIndexResponse> {
    return this.serialize(() => this.applyIndex(request));
  }

  query(request: SearchQueryRequest): SearchQueryResponse | null | Promise<SearchQueryResponse | null> {
    return this.serialize(() => this.runQuery(request));
  }

  // One source per turn, so a Search open waits behind at most one build.
  async prewarm(request: SearchPrewarmRequest): Promise<SearchPrewarmResponse> {
    const persist: SearchIndexCandidate[] = [];
    const skipped: NonNullable<SearchPrewarmResponse['skipped']> = [];
    for (const source of request.sources) {
      await this.serialize(() => this.prewarmSource(source, persist, skipped));
    }
    return skipped.length ? { persist, skipped } : { persist };
  }

  async persist(request: SearchIndexPersistRequest): Promise<SearchIndexPersistResponse> {
    const written: string[] = [];
    const failed: NonNullable<SearchIndexPersistResponse['failed']> = [];
    for (const entry of request.entries) {
      const index = this.sources.get(entry.prefix);
      if (!this.cache || !index || index.key !== entry.key) continue;
      try {
        await this.cache.write(
          SEARCH_INDEX_STORE,
          { ...sourceIndexRecord(index), ...entry.fields },
          CONFIG.SEARCH.INDEX_WRITE_TIMEOUT_MS,
        );
        written.push(entry.key);
      } catch (error) {
        failed.push({ key: entry.key, reason: failureReason(error) });
      }
    }
    return failed.length ? { written, failed } : { written };
  }

  private serialize<T>(work: () => T | Promise<T>): T | Promise<T> {
    if (this.pending) return this.track(this.pending.then(work));
    const result = work();
    return result instanceof Promise ? this.track(result) : result;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const pending = work.then(() => undefined, () => undefined);
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) this.pending = null;
    });
    return work;
  }

  private applyIndex(request: SearchIndexRequest): SearchIndexResponse | Promise<SearchIndexResponse> {
    if (request.reset) {
      this.sessionId = request.sessionId;
      this.staging = {};
      this.channels = [];
      this.channelDocuments = [];
      this.programmes = [];
      this.movies = emptyNames();
      this.series = emptyNames();
    } else if (request.sessionId !== this.sessionId) {
      return { accepted: false };
    }

    if (request.chunk && !this.applyChunk(request.chunk)) return { accepted: false };
    if (!request.cachedChannels && !request.cachedProgrammes
        && !request.cachedMovies && !request.cachedSeries) {
      return { accepted: true };
    }
    return this.applyCached(request);
  }

  private async applyCached(request: SearchIndexRequest): Promise<SearchIndexResponse> {
    const deadline = Date.now() + CONFIG.SEARCH.CACHE_READ_TIMEOUT_MS;
    let readFailure: string | null = null;
    // Each record is read on its own and dropped once its text is extracted,
    // so at most one raw record is alive at a time.
    const read: ReadSource = async (ref) => {
      if (readFailure) throw new SearchCacheError(readFailure);
      const remaining = deadline - Date.now();
      try {
        if (!this.cache) throw new SearchCacheError('unavailable');
        if (remaining <= 0) throw new SearchCacheError('read_timeout');
        return await this.cache.read(ref, remaining);
      } catch (error) {
        const reason = failureReason(error);
        if (reason !== 'store_missing') readFailure = reason;
        throw error;
      }
    };
    const persist: SearchIndexCandidate[] = [];
    const loaded = { persisted: 0, built: 0 };
    const load = (ref: SearchCacheRecord) => this.loadSource(ref, read, persist, loaded);
    const unresolved: SearchIndexUnresolved[] = [];
    const resolve = async (source: SearchIndexSource, build: () => Promise<void>): Promise<void> => {
      try {
        await build();
      } catch (error) {
        // The page posts this source next; until then queries must not rank
        // previous channels or programmes against its new rows.
        if (source === 'channels' || source === 'programmes') this.clear(source);
        unresolved.push({ source, reason: failureReason(error) });
      }
    };
    const { cachedChannels, cachedProgrammes, cachedMovies, cachedSeries } = request;
    if (cachedChannels) {
      await resolve('channels', async () => {
        const documents = cachedChannelDocuments(await load(cachedChannels.record), cachedChannels);
        this.channelDocuments = documents;
        this.channels = prepareFolded(documents);
      });
    }
    if (cachedProgrammes) {
      if (unresolved.some(entry => entry.source === 'channels')) {
        this.clear('programmes');
        unresolved.push({ source: 'programmes', reason: 'channels_unresolved' });
      } else {
        await resolve('programmes', async () => {
          checkProgrammeRuns(cachedProgrammes);
          const runs: Array<string[][] | undefined> = [];
          for (let record = 0; record < cachedProgrammes.records.length; record++) {
            cachedProgrammeRuns(
              await load(cachedProgrammes.records[record]),
              record,
              cachedProgrammes,
              this.channelDocuments,
              runs,
            );
          }
          this.programmes = prepareFolded(joinProgrammeRuns(runs, cachedProgrammes));
        });
      }
    }
    if (cachedMovies) {
      await resolve('movies', async () => {
        this.movies = foldedNames(cachedNameDocuments(await load(cachedMovies.record), cachedMovies));
      });
    }
    if (cachedSeries) {
      await resolve('series', async () => {
        this.series = foldedNames(cachedNameDocuments(await load(cachedSeries.record), cachedSeries));
      });
    }
    const response: SearchIndexResponse = { accepted: true, loaded };
    if (unresolved.length) response.unresolved = unresolved;
    if (persist.length) response.persist = persist;
    return response;
  }

  // A stored index skips reading and folding the source record; a missing or
  // outdated one is rebuilt from the record and offered for storing.
  private async loadSource(
    ref: SearchCacheRecord,
    read: ReadSource,
    persist: SearchIndexCandidate[],
    loaded: { persisted: number; built: number },
  ): Promise<SourceIndex> {
    const known = this.sources.get(sourceIndexPrefix(ref.store, ref.key));
    if (known && known.sourceTimestamp === ref.timestamp) {
      loaded.persisted++;
      return known;
    }
    const stored = parseSourceIndex(ref, await readOptional(read, sourceIndexKey(ref)));
    if (stored) {
      this.offered.add(stored.key);
      this.sources.set(stored.prefix, stored);
      loaded.persisted++;
      return stored;
    }
    const built = buildSourceIndex(ref, await read(ref));
    this.sources.set(built.prefix, built);
    this.offer(built, persist);
    loaded.built++;
    return built;
  }

  private offer(index: SourceIndex, persist: SearchIndexCandidate[]): void {
    if (this.offered.has(index.key)) return;
    this.offered.add(index.key);
    persist.push(sourceIndexCandidate(index));
  }

  private async prewarmSource(
    source: SearchPrewarmSource,
    persist: SearchIndexCandidate[],
    skipped: NonNullable<SearchPrewarmResponse['skipped']>,
  ): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    const timeout = CONFIG.SEARCH.PREWARM_READ_TIMEOUT_MS;
    const prefix = sourceIndexPrefix(source.store, source.key);
    try {
      let timestamp = source.timestamp;
      if (timestamp === undefined) {
        const meta = await cache.read({
          store: CACHE_META_STORE,
          key: cacheEntryMetaId(source.store, source.key),
        }, timeout);
        if (meta && typeof meta.timestamp === 'number') timestamp = meta.timestamp;
      }
      if (timestamp !== undefined) {
        const ref: SearchCacheRecord = { store: source.store, key: source.key, timestamp };
        const key = sourceIndexKey(ref);
        const known = this.sources.get(prefix);
        if (this.offered.has(key) && known?.key === key) return;
        if (await cache.count({ store: SEARCH_INDEX_STORE, key }, timeout) > 0) {
          this.offered.add(key);
          return;
        }
        if (known?.key === key) {
          this.offer(known, persist);
          return;
        }
      }
      const raw = await cache.read(source, timeout);
      if (!raw) {
        skipped.push({ store: source.store, reason: 'missing' });
        return;
      }
      const built = buildSourceIndex({
        store: source.store,
        key: source.key,
        timestamp: timestamp ?? cacheRecordTimestamp(raw),
      }, raw);
      this.sources.set(built.prefix, built);
      this.offer(built, persist);
    } catch (error) {
      skipped.push({ store: source.store, reason: failureReason(error) });
    }
  }

  // Channels and programmes are empty from their first slice until their
  // last, as the page already ranks against its new rows. The catalog keeps
  // its previous names until the swap, which the page tracks per source.
  private applyChunk(chunk: SearchIndexChunk): boolean {
    const { source } = chunk;
    if (chunk.start === 0) {
      if (source === 'channels' || source === 'programmes') this.clear(source);
      this.staging[source] = { documents: [], names: [] };
    }
    const staged = this.staging[source];
    const incoming = chunk.documents ?? chunk.names ?? [];
    const count = staged ? staged.documents.length + staged.names.length : -1;
    if (!staged || count !== chunk.start || count + incoming.length > chunk.total) {
      delete this.staging[source];
      return false;
    }
    if (chunk.documents) for (const fields of chunk.documents) staged.documents.push(fields);
    if (chunk.names) for (const name of chunk.names) staged.names.push(name);
    if (count + incoming.length < chunk.total) return true;
    delete this.staging[source];
    if (source === 'channels') this.setChannels(staged.documents);
    else if (source === 'programmes') this.programmes = prepareFolded(foldDocuments(staged.documents));
    else if (source === 'movies') this.movies = foldedNames(staged.names.map(foldSearchText));
    else this.series = foldedNames(staged.names.map(foldSearchText));
    return true;
  }

  private clear(source: SearchIndexSource): void {
    if (source === 'channels') this.setChannels([]);
    else if (source === 'programmes') this.programmes = [];
    else if (source === 'movies') this.movies = emptyNames();
    else this.series = emptyNames();
  }

  private setChannels(documents: string[][]): void {
    this.channelDocuments = foldDocuments(documents);
    this.channels = prepareFolded(this.channelDocuments);
  }

  private runQuery(request: SearchQueryRequest): SearchQueryResponse | null {
    if (request.sessionId !== this.sessionId) return null;
    return {
      channels: rankedFields(this.channels, request.query, request.limit),
      programmes: request.includeProgrammes === false
        ? emptyResult()
        : rankedFields(this.programmes, request.query, request.limit),
      movies: request.includeCatalog
        ? rankedNames(this.movies, request.query, request.limit)
        : emptyResult(),
      series: request.includeCatalog
        ? rankedNames(this.series, request.query, request.limit)
        : emptyResult(),
    };
  }
}

function failureReason(error: unknown): string {
  return error instanceof SearchCacheError ? error.reason : 'read_failed';
}

async function readOptional(read: ReadSource, key: string): Promise<CachedRecord | null> {
  try {
    return await read({ store: SEARCH_INDEX_STORE, key });
  } catch (error) {
    if (failureReason(error) === 'store_missing') return null;
    throw error;
  }
}

function prepareFolded(documents: string[][]): PreparedSearchItem<number>[] {
  return documents.map((fields, index) => prepareFoldedSearchItem(index, fields));
}

function foldedNames(values: string[]): PreparedNameSearchIndex<number> {
  const items: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) items[i] = i;
  return { items, values };
}

function rankedFields(
  index: PreparedSearchItem<number>[],
  query: string,
  limit: number,
): SearchRankedIndices {
  const result = rankPreparedTopK(index, query, limit);
  return { indices: result.items, hasMore: result.hasMore };
}

function rankedNames(
  index: PreparedNameSearchIndex<number>,
  query: string,
  limit: number,
): SearchRankedIndices {
  const result = rankPreparedNamesTopK(index, query, limit);
  return { indices: result.items, hasMore: result.hasMore };
}

function emptyNames(): PreparedNameSearchIndex<number> {
  return { items: [], values: [] };
}

function emptyResult(): SearchRankedIndices {
  return { indices: [], hasMore: false };
}
