import {
  foldSearchText,
  prepareFoldedSearchItem,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import { CONFIG } from '../config';
import { catalogConcealmentTest } from '../utils/catalog-concealment';
import type { SeriesItem, VodItem } from '../types';
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
  sourceIndexValue,
  type SourceIndex,
} from './search-source-index';
import type {
  CatalogMembersRequest,
  CatalogMembersResponse,
  SearchCacheRecord,
  SearchCatalogRecord,
  SearchDeliveredItems,
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

interface CatalogRead {
  source: 'movies' | 'series';
  record: SearchCatalogRecord;
  idField: 'streamId' | 'seriesId';
}

// A posted name index takes precedence over the catalog record of its group.
function catalogReads(request: SearchIndexRequest): CatalogRead[] {
  const reads: CatalogRead[] = [];
  if (request.catalogMovies && !request.cachedMovies) {
    reads.push({ source: 'movies', record: request.catalogMovies, idField: 'streamId' });
  }
  if (request.catalogSeries && !request.cachedSeries) {
    reads.push({ source: 'series', record: request.catalogSeries, idField: 'seriesId' });
  }
  return reads;
}

export class SearchWorkerIndex {
  private sessionId: number | null = null;
  private channels: PreparedSearchItem<number>[] = [];
  // Folded channel documents, which cached programme documents are joined with.
  private channelDocuments: string[][] = [];
  private programmes: PreparedSearchItem<number>[] = [];
  private movies = emptyNames();
  private series = emptyNames();
  // The record items behind each catalog name when the worker read the
  // catalog itself; null when the page posted the names.
  private movieItems: VodItem[] | null = null;
  private seriesItems: SeriesItem[] | null = null;
  // Which of those items the page has been sent since the epoch began.
  private delivery = newDelivery(0);
  // The latest catalog record read or written, by key prefix, for this worker's life.
  private readonly catalogRecords = new Map<string, CachedRecord>();
  private pending: Promise<void> | null = null;
  // Bumped by each reset and catalog request, so an older read never swaps in.
  private readonly catalogTickets = { movies: 0, series: 0 };
  private readonly catalogReadsInFlight = new Map<string, Promise<CachedRecord>>();
  private staging: Partial<Record<SearchIndexSource, { documents: string[][]; names: string[] }>> = {};
  // The latest index of each source record, by key prefix, for this worker's life.
  private readonly sources = new Map<string, SourceIndex>();
  // Index keys already stored or offered for storing, so none is offered twice.
  private readonly offered = new Set<string>();

  constructor(private readonly cache: SearchCacheReader | null = null) {}

  // Requests run in arrival order, so a query never sees a half-read cache.
  // A catalog record is read outside that order, so queries keep ranking the
  // other sources meanwhile, and only its swap-in waits for its turn.
  index(request: SearchIndexRequest): SearchIndexResponse | Promise<SearchIndexResponse> {
    const catalogs = catalogReads(request);
    if (!catalogs.length) return this.serialize(() => this.applyIndex(request));
    let tickets: number[] = [];
    const head = this.serialize(() => {
      const response = this.applyIndex(request);
      if (request.sessionId === this.sessionId) {
        tickets = catalogs.map(catalog => ++this.catalogTickets[catalog.source]);
      }
      return response;
    });
    return Promise.resolve(head).then(response => (
      response.accepted ? this.indexCatalogs(request, catalogs, tickets, response) : response
    ));
  }

  query(request: SearchQueryRequest): SearchQueryResponse | null | Promise<SearchQueryResponse | null> {
    return this.serialize(() => this.runQuery(request));
  }

  // One source per turn, so a Search open waits behind at most one build.
  async prewarm(request: SearchPrewarmRequest): Promise<SearchPrewarmResponse> {
    const persist: SearchIndexCandidate[] = [];
    const skipped: NonNullable<SearchPrewarmResponse['skipped']> = [];
    for (const source of request.sources) {
      const record = await this.serialize(() => this.prewarmSource(source, persist, skipped));
      if (record) await this.prewarmCatalog(record, persist, skipped);
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
      this.catalogTickets.movies++;
      this.catalogTickets.series++;
      this.staging = {};
      this.channels = [];
      this.channelDocuments = [];
      this.programmes = [];
      this.clear('movies');
      this.clear('series');
    } else if (request.sessionId !== this.sessionId) {
      return { accepted: false };
    }
    // Names that arrive another way supersede a catalog read in flight.
    if (request.cachedMovies) this.catalogTickets.movies++;
    if (request.cachedSeries) this.catalogTickets.series++;

    if (request.chunk && !this.applyChunk(request.chunk)) return { accepted: false };
    if (!request.cachedChannels && !request.cachedProgrammes
        && !request.cachedMovies && !request.cachedSeries
        && !request.catalogMovies && !request.catalogSeries) {
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
        const names = foldedNames(cachedNameDocuments(await load(cachedMovies.record), cachedMovies));
        this.clear('movies');
        this.movies = names;
      });
    }
    if (cachedSeries) {
      await resolve('series', async () => {
        const names = foldedNames(cachedNameDocuments(await load(cachedSeries.record), cachedSeries));
        this.clear('series');
        this.series = names;
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

  private async indexCatalogs(
    request: SearchIndexRequest,
    catalogs: CatalogRead[],
    tickets: number[],
    head: SearchIndexResponse,
  ): Promise<SearchIndexResponse> {
    const persist = head.persist ? head.persist.slice() : [];
    const loaded = head.loaded ? { ...head.loaded } : { persisted: 0, built: 0 };
    const unresolved = head.unresolved ? head.unresolved.slice() : [];
    for (let i = 0; i < catalogs.length; i++) {
      const { source, record, idField } = catalogs[i];
      let catalog: { names: PreparedNameSearchIndex<number>; items: unknown[] } | null = null;
      let reason = '';
      try {
        catalog = await this.readCatalog(record, idField, persist, loaded);
      } catch (error) {
        reason = failureReason(error);
      }
      await this.serialize(() => {
        if (this.sessionId !== request.sessionId || this.catalogTickets[source] !== tickets[i]) return;
        if (!catalog) {
          unresolved.push({ source, reason });
        } else if (source === 'movies') {
          this.clear('movies');
          this.movies = catalog.names;
          this.movieItems = catalog.items as VodItem[];
        } else {
          this.clear('series');
          this.series = catalog.names;
          this.seriesItems = catalog.items as SeriesItem[];
        }
      });
    }
    const response: SearchIndexResponse = { accepted: true, loaded };
    if (unresolved.length) response.unresolved = unresolved;
    if (persist.length) response.persist = persist;
    return response;
  }

  // The names come from the record's search index and the items from the
  // record itself, which is read once and kept for later sessions.
  private async readCatalog(
    request: SearchCatalogRecord,
    idField: 'streamId' | 'seriesId',
    persist: SearchIndexCandidate[],
    loaded: { persisted: number; built: number },
  ): Promise<{ names: PreparedNameSearchIndex<number>; items: unknown[] }> {
    const record = await this.catalogRecord(request.record);
    // The stored record may be newer than the page's reference; its names
    // must come from the same version as its items.
    const ref = { ...request.record, timestamp: cacheRecordTimestamp(record) };
    // A large record can take the whole cache-read budget, so its index gets
    // the catalog's own and does not fail the other sources' reads.
    const read: ReadSource = async (key) => {
      if (key.store === ref.store && key.key === ref.key) return record;
      if (!this.cache) throw new SearchCacheError('unavailable');
      try {
        return await this.cache.read(key, CONFIG.SEARCH.CATALOG_READ_TIMEOUT_MS);
      } catch (error) {
        throw error instanceof SearchCacheError ? error : new SearchCacheError('read_failed');
      }
    };
    const index = await this.loadSource(ref, read, persist, loaded);
    const list = record.data as Array<Record<string, unknown>>;
    if (index.length !== list.length) throw new SearchCacheError('record_changed');
    if (!request.concealment) {
      const names: string[] = new Array(list.length);
      for (let i = 0; i < list.length; i++) names[i] = sourceIndexValue(index, i, 0);
      return { names: foldedNames(names), items: list };
    }
    const concealed = catalogConcealmentTest(request.concealment);
    const names: string[] = [];
    const items: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (concealed(String(item[idField]), String(item.categoryId ?? ''))) continue;
      names.push(sourceIndexValue(index, i, 0));
      items.push(item);
    }
    return { names: foldedNames(names), items };
  }

  /** The catalog list stored under `ref`, or null when it is gone or unreadable. */
  async catalogList(ref: SearchCacheRecord): Promise<unknown[] | null> {
    try {
      return (await this.catalogRecord(ref)).data as unknown[];
    } catch {
      return null;
    }
  }

  async catalogMembers(request: CatalogMembersRequest): Promise<CatalogMembersResponse | null> {
    const list = await this.catalogList(request.record);
    if (!list) return null;
    const wanted = new Set(request.ids);
    const members: Array<[string, string]> = [];
    for (const item of list as Array<Record<string, unknown>>) {
      const id = String(item[request.idField]);
      if (wanted.has(id)) members.push([id, String(item.categoryId ?? '')]);
    }
    return { members };
  }

  /** Keeps a catalog record the worker just wrote, so search need not read it back. */
  // Writes arrive in order, so the one just written wins even if a clock
  // moved backwards gave it an older timestamp.
  retainCatalogRecord(store: string, record: CachedRecord): void {
    if (store !== CATALOG_RECORD_STORE || !Array.isArray(record.data)) return;
    const prefix = sourceIndexPrefix(store, String(record.key));
    this.catalogRecords.delete(prefix);
    this.keepCatalogRecord(prefix, record);
  }

  // A prewarm reads without keeping, so the record stays only once Search uses it.
  private async catalogRecord(ref: SearchCacheRecord, keep = true): Promise<CachedRecord> {
    const prefix = sourceIndexPrefix(ref.store, ref.key);
    const kept = this.catalogRecords.get(prefix);
    // A newer kept version serves as well; readCatalog takes its timestamp.
    if (kept && cacheRecordTimestamp(kept) >= ref.timestamp) return kept;
    // Two reads of one record at once would hold two copies of it.
    const id = `${prefix}|${String(ref.timestamp)}`;
    let read = this.catalogReadsInFlight.get(id);
    if (!read) {
      const started = this.readCatalogRecord(ref);
      read = started;
      this.catalogReadsInFlight.set(id, started);
      const done = (): void => { this.catalogReadsInFlight.delete(id); };
      started.then(done, done);
    }
    const record = await read;
    if (keep) this.keepCatalogRecord(prefix, record);
    return record;
  }

  private async readCatalogRecord(ref: SearchCacheRecord): Promise<CachedRecord> {
    if (!this.cache) throw new SearchCacheError('unavailable');
    let raw: CachedRecord | null;
    try {
      raw = await this.cache.read(ref, CONFIG.SEARCH.CATALOG_READ_TIMEOUT_MS);
    } catch (error) {
      throw error instanceof SearchCacheError ? error : new SearchCacheError('read_failed');
    }
    if (!raw) throw new SearchCacheError('record_missing');
    if (!Array.isArray(raw.data)) throw new SearchCacheError('record_invalid');
    return raw;
  }

  // One account's movie and series lists; older ones go. A slow read of an
  // older version never replaces a newer one kept meanwhile.
  private keepCatalogRecord(prefix: string, record: CachedRecord): void {
    const kept = this.catalogRecords.get(prefix);
    if (kept && cacheRecordTimestamp(kept) > cacheRecordTimestamp(record)) return;
    this.catalogRecords.delete(prefix);
    this.catalogRecords.set(prefix, record);
    while (this.catalogRecords.size > CATALOG_RECORD_LIMIT) {
      this.catalogRecords.delete(this.catalogRecords.keys().next().value as string);
    }
  }

  private offer(index: SourceIndex, persist: SearchIndexCandidate[]): void {
    if (this.offered.has(index.key)) return;
    this.offered.add(index.key);
    persist.push(sourceIndexCandidate(index));
  }

  // A catalog record it must read comes back, to be read outside the queue.
  private async prewarmSource(
    source: SearchPrewarmSource,
    persist: SearchIndexCandidate[],
    skipped: NonNullable<SearchPrewarmResponse['skipped']>,
  ): Promise<SearchCacheRecord | undefined> {
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
      if (source.store === CATALOG_RECORD_STORE && timestamp !== undefined) {
        return { store: source.store, key: source.key, timestamp };
      }
      const raw = await cache.read(source, timeout);
      if (!raw) {
        skipped.push({ store: source.store, reason: 'missing' });
        return undefined;
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
    return undefined;
  }

  // Through catalogRecord, so a Search open reading the record meanwhile
  // shares this read; only the build waits in the queue.
  private async prewarmCatalog(
    ref: SearchCacheRecord,
    persist: SearchIndexCandidate[],
    skipped: NonNullable<SearchPrewarmResponse['skipped']>,
  ): Promise<void> {
    let raw: CachedRecord;
    try {
      raw = await this.catalogRecord(ref, false);
    } catch (error) {
      const missing = error instanceof SearchCacheError && error.reason === 'record_missing';
      skipped.push({ store: ref.store, reason: missing ? 'missing' : failureReason(error) });
      return;
    }
    await this.serialize(() => {
      const key = sourceIndexKey({ ...ref, timestamp: cacheRecordTimestamp(raw) });
      const known = this.sources.get(sourceIndexPrefix(ref.store, ref.key));
      if (known?.key === key) {
        this.offer(known, persist);
        return;
      }
      const built = buildSourceIndex({ ...ref, timestamp: cacheRecordTimestamp(raw) }, raw);
      this.sources.set(built.prefix, built);
      this.offer(built, persist);
    });
  }

  // Channels and programmes are empty from their first slice until their
  // last, as the page already ranks against its new rows. The catalog keeps
  // its previous names until the swap, which the page tracks per source.
  private applyChunk(chunk: SearchIndexChunk): boolean {
    const { source } = chunk;
    if (chunk.start === 0) {
      if (source === 'channels' || source === 'programmes') this.clear(source);
      else this.catalogTickets[source]++;
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
    else if (source === 'movies') {
      this.clear('movies');
      this.movies = foldedNames(staged.names.map(foldSearchText));
    } else {
      this.clear('series');
      this.series = foldedNames(staged.names.map(foldSearchText));
    }
    return true;
  }

  private clear(source: SearchIndexSource): void {
    if (source === 'channels') this.setChannels([]);
    else if (source === 'programmes') this.programmes = [];
    else if (source === 'movies') {
      this.movies = emptyNames();
      if (this.movieItems) this.delivery = newDelivery(this.delivery.epoch + 1);
      this.movieItems = null;
    } else {
      this.series = emptyNames();
      if (this.seriesItems) this.delivery = newDelivery(this.delivery.epoch + 1);
      this.seriesItems = null;
    }
  }

  private setChannels(documents: string[][]): void {
    this.channelDocuments = foldDocuments(documents);
    this.channels = prepareFolded(this.channelDocuments);
  }

  private runQuery(request: SearchQueryRequest): SearchQueryResponse | null {
    if (request.sessionId !== this.sessionId) return null;
    const response: SearchQueryResponse = {
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
    if (this.movieItems || this.seriesItems) response.items = this.deliver(request, response);
    return response;
  }

  // Sends each ranked record item once per epoch. The page counts what it
  // kept; a count that differs means an answer went missing, so a new epoch
  // starts and the page drops its items.
  private deliver(request: SearchQueryRequest, response: SearchQueryResponse): SearchDeliveredItems {
    const known = request.delivered;
    let delivery = this.delivery;
    if (!known || known.epoch !== delivery.epoch
        || known.movies !== delivery.movies.size || known.series !== delivery.series.size) {
      delivery = newDelivery(delivery.epoch + 1);
      this.delivery = delivery;
    }
    return {
      epoch: delivery.epoch,
      movies: this.movieItems ? newItems(response.movies.indices, this.movieItems, delivery.movies) : [],
      series: this.seriesItems ? newItems(response.series.indices, this.seriesItems, delivery.series) : [],
    };
  }
}

const CATALOG_RECORD_STORE = 'catalog-cache';
const CATALOG_RECORD_LIMIT = 2;

function newDelivery(epoch: number): { epoch: number; movies: Set<number>; series: Set<number> } {
  return { epoch, movies: new Set(), series: new Set() };
}

function newItems<T>(indices: number[], items: T[], sent: Set<number>): Array<[number, T]> {
  const fresh: Array<[number, T]> = [];
  for (const index of indices) {
    if (sent.has(index) || index >= items.length) continue;
    sent.add(index);
    fresh.push([index, items[index]]);
  }
  return fresh;
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
