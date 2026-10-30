import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { CatalogColumnsBuilder } from '../services/catalog-table';
import { cachedChannelsRequest, ProgrammeRuns, sampleDocuments } from '../components/search-cache-source';
import type { Channel } from '../types';
import type { CachedRecord, SearchCacheKey, SearchCacheReader } from './search-cache-reader';
import { SearchCacheError } from './search-cache-reader';
import { SearchWorkerIndex } from './search-index';
import type {
  SearchCacheRecord,
  SearchCachedNames,
  SearchIndexRequest,
  SearchQueryRequest,
} from './tasks';

interface PostedSources {
  channels?: string[][];
  programmes?: string[][];
  movies?: string[];
  series?: string[];
}

// Posts each source as one chunk, the way the page posts a small source.
function post(index: SearchWorkerIndex, sessionId: number, sources: PostedSources, reset = true): boolean {
  let accepted = true;
  const take = (response: unknown): void => {
    if (!(response as { accepted?: boolean }).accepted) accepted = false;
  };
  if (reset) take(index.index({ sessionId, reset: true }));
  for (const source of ['channels', 'programmes', 'movies', 'series'] as const) {
    const documents = sources[source];
    if (!documents) continue;
    const named = source === 'movies' || source === 'series';
    take(index.index({
      sessionId,
      chunk: named
        ? { source, start: 0, total: documents.length, names: documents as string[] }
        : { source, start: 0, total: documents.length, documents: documents as string[][] },
    }));
  }
  return accepted;
}

class MemoryReader implements SearchCacheReader {
  reads = 0;
  failure: string | null = null;
  gate: Promise<void> | null = null;
  readonly log: string[] = [];
  readonly timeouts: number[] = [];
  // Simulates a read that takes this long (fake timers).
  delayMs = 0;

  constructor(readonly records: Map<string, CachedRecord>) {}

  async read(ref: SearchCacheKey, timeoutMs: number): Promise<CachedRecord | null> {
    this.reads++;
    this.log.push(`read:${ref.store === 'search-index-cache' ? 'index' : ref.key}`);
    this.timeouts.push(timeoutMs);
    if (this.gate) await this.gate;
    if (this.delayMs) vi.advanceTimersByTime(this.delayMs);
    if (this.failure) throw new SearchCacheError(this.failure);
    return this.records.get(`${ref.store}|${ref.key}`) ?? null;
  }

  async count(ref: SearchCacheKey): Promise<number> {
    this.log.push(`count:${ref.store}`);
    if (this.failure) throw new SearchCacheError(this.failure);
    return this.records.has(`${ref.store}|${ref.key}`) ? 1 : 0;
  }

  async write(store: string, value: CachedRecord): Promise<void> {
    this.log.push(`write:${store}`);
    if (this.writeFailure) throw new SearchCacheError(this.writeFailure);
    this.records.set(`${store}|${String(value.key)}`, value);
  }

  writeFailure: string | null = null;
}

const PLAYLIST_REF: SearchCacheRecord = { store: 'playlist-cache', key: 'combined', timestamp: 10 };
const EPG_REF = { url: 'http://host/epg', timestamp: 20 };
const VOD_REF: SearchCacheRecord = { store: 'catalog-cache', key: 'a|vod_all', timestamp: 30 };

function channel(id: string, name: string, group: string): Channel {
  return { id, name, group, url: `http://host/${id}` } as Channel;
}

// Source playlist as the playlist-cache record stores it.
const sourceChannels = [
  channel('ch1', 'Alpha News', 'News'),
  channel('ch2', 'Bravo Sports', 'Sports'),
  channel('ch3', 'Charlie Movies', 'Movies'),
  channel('ch4', 'Alpha Kids', 'Kids'),
  channel('ch5', 'Bravo Alpha', 'News'),
];

const programmes: Record<string, Array<Record<string, string>>> = {
  e1: [
    { title: 'Alpha Report', category: 'News', description: 'Daily' },
    { title: 'Evening', category: 'News', description: 'Alpha recap' },
  ],
  e3: [{ title: 'Feature', category: 'Film', description: 'Bravo story' }],
};

const vod = [{ name: 'Alpha Movie' }, { name: 'Hidden Alpha' }, { name: 'Bravo Movie' }];

function reader(): MemoryReader {
  return new MemoryReader(new Map<string, CachedRecord>([
    ['playlist-cache|combined', { key: 'combined', timestamp: 10, data: { channels: sourceChannels } }],
    ['epg-cache|http://host/epg', { url: EPG_REF.url, timestamp: 20, data: { programmes } }],
    ['catalog-cache|a|vod_all', { key: 'a|vod_all', timestamp: 30, data: vod }],
  ]));
}

// Displayed channels: customized (ch5 renamed, ch2 regrouped), reordered,
// with ch3 hidden.
function displayedChannels(): { channels: Channel[]; selection: Uint32Array } {
  const renamed = { ...sourceChannels[4], name: 'Delta Alpha', sourceName: 'Bravo Alpha' };
  const regrouped = { ...sourceChannels[1], group: 'Favorites', sourceGroup: 'Sports' };
  return {
    channels: [renamed, { ...sourceChannels[0] }, regrouped, { ...sourceChannels[3] }],
    selection: new Uint32Array([4, 0, 1, 3]),
  };
}

function postedDocuments(channels: Channel[]): string[][] {
  return channels.map(item => [item.name, item.group, item.sourceName ?? '']);
}

function programmeDocuments(channels: Channel[], ids: Array<string | null>): string[][] {
  const documents: string[][] = [];
  channels.forEach((item, index) => {
    const id = ids[index];
    for (const programme of id ? programmes[id] ?? [] : []) {
      documents.push([
        programme.title,
        programme.category,
        programme.description,
        item.name,
        item.group,
      ]);
    }
  });
  return documents;
}

function query(sessionId: number, text: string): SearchQueryRequest {
  return { sessionId, query: text, limit: 10, includeCatalog: true };
}

function cachedNames(selection: Uint32Array | null, names: string[]): SearchCachedNames {
  return {
    record: VOD_REF,
    length: vod.length,
    selection,
    samples: sampleDocuments(names.length, index => [names[index]]),
  };
}

const EPG_IDS: Array<string | null> = ['e5', 'e1', null, 'e3'];

function cachedRequest(channels: Channel[], selection: Uint32Array): SearchIndexRequest {
  const runs = new ProgrammeRuns();
  const programmeDocs = programmeDocuments(channels, EPG_IDS);
  // ch5 has no programmes in the record (e5 is absent), so no run.
  runs.add(1, { url: EPG_REF.url, id: 'e1', timestamp: EPG_REF.timestamp }, 2);
  runs.add(3, { url: EPG_REF.url, id: 'e3', timestamp: EPG_REF.timestamp }, 1);
  const cachedChannels = cachedChannelsRequest(channels, {
    record: PLAYLIST_REF,
    length: sourceChannels.length,
    selection,
  });
  if (!cachedChannels) throw new Error('expected cached channels');
  const movies = ['Alpha Movie', 'Bravo Movie'];
  return {
    sessionId: 1,
    cachedChannels,
    cachedProgrammes: runs.request(
      sampleDocuments(programmeDocs.length, index => programmeDocs[index]),
    ) ?? undefined,
    cachedMovies: cachedNames(new Uint32Array([0, 2]), movies),
  };
}

describe('SearchWorkerIndex with cached documents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears failed programmes but keeps the previous catalog until its post lands', async () => {
    const { channels, selection } = displayedChannels();
    const index = new SearchWorkerIndex(reader());
    post(index, 1, {
      channels: postedDocuments(channels),
      programmes: [['Old Alpha', '', '', 'Old', '']],
      movies: ['Old Alpha Movie'],
      series: ['Old Alpha Series'],
    });
    const request = cachedRequest(channels, selection);
    const changed = { ...VOD_REF, timestamp: 31 };

    const indexed = index.index({
      sessionId: 1,
      cachedProgrammes: {
        ...request.cachedProgrammes!,
        records: [{ ...request.cachedProgrammes!.records[0], timestamp: 21 }],
      },
      cachedMovies: { ...request.cachedMovies!, record: changed },
      cachedSeries: { ...cachedNames(null, vod.map(item => item.name)), record: changed },
    });
    // Queued before the page's fallback post arrives.
    const answered = index.query(query(1, 'alpha'));

    expect((await indexed).unresolved).toEqual([
      { source: 'programmes', reason: 'record_changed' },
      { source: 'movies', reason: 'record_changed' },
      { source: 'series', reason: 'record_changed' },
    ]);
    const result = await answered;
    expect(result?.programmes.indices).toEqual([]);
    // The page maps catalog indices onto the list it last saw indexed.
    expect(result?.movies.indices).toEqual([0]);
    expect(result?.series.indices).toEqual([0]);
    expect(result?.channels.indices.length).toBeGreaterThan(0);
  });

  it('clears channels and programmes when the channel record fails', async () => {
    const { channels, selection } = displayedChannels();
    const index = new SearchWorkerIndex(reader());
    post(index, 1, {
      channels: [['Old Alpha', '', '']],
      programmes: [['Old Alpha', '', '', 'Old', '']],
    });
    const request = cachedRequest(channels, selection);

    const indexed = index.index({
      sessionId: 1,
      cachedChannels: { ...request.cachedChannels!, length: 6 },
      cachedProgrammes: request.cachedProgrammes,
    });
    const answered = index.query(query(1, 'alpha'));

    expect((await indexed).unresolved?.map(entry => entry.source)).toEqual(['channels', 'programmes']);
    expect((await answered)?.channels.indices).toEqual([]);
    expect((await answered)?.programmes.indices).toEqual([]);
  });

  it('extracts each EPG record before reading the next one', async () => {
    const { channels } = displayedChannels();
    const memory = reader();
    const second = { url: 'http://host/epg2', timestamp: 22 };
    const record = (url: string, timestamp: number, data: object): CachedRecord => {
      const raw: CachedRecord = { url, timestamp };
      Object.defineProperty(raw, 'data', {
        get: () => {
          memory.log.push(`extract:${url}`);
          return data;
        },
      });
      return raw;
    };
    memory.records.set(
      `epg-cache|${EPG_REF.url}`,
      record(EPG_REF.url, EPG_REF.timestamp, { programmes: { e1: programmes.e1 } }),
    );
    memory.records.set(
      `epg-cache|${second.url}`,
      record(second.url, second.timestamp, { programmes: { e3: programmes.e3 } }),
    );
    const runs = new ProgrammeRuns();
    runs.add(1, { url: EPG_REF.url, id: 'e1', timestamp: EPG_REF.timestamp }, 2);
    runs.add(3, { url: second.url, id: 'e3', timestamp: second.timestamp }, 1);
    const docs = programmeDocuments(channels, EPG_IDS);
    const index = new SearchWorkerIndex(memory);
    post(index, 1, { channels: postedDocuments(channels) });

    expect(await index.index({
      sessionId: 1,
      cachedProgrammes: runs.request(sampleDocuments(docs.length, i => docs[i])) ?? undefined,
    })).toMatchObject({ accepted: true, persist: [{}, {}] });
    expect(memory.log).toEqual([
      'read:index',
      `read:${EPG_REF.url}`,
      `extract:${EPG_REF.url}`,
      'read:index',
      `read:${second.url}`,
      `extract:${second.url}`,
    ]);
    expect((await index.query(query(1, 'bravo')))?.programmes.indices).toEqual([2]);
  });

  it('gives up on the cache once the read budget is spent', async () => {
    vi.useFakeTimers();
    const { channels, selection } = displayedChannels();
    const memory = reader();
    memory.delayMs = CONFIG.SEARCH.CACHE_READ_TIMEOUT_MS;
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });

    expect((await index.index(cachedRequest(channels, selection))).unresolved).toEqual([
      { source: 'channels', reason: 'read_timeout' },
      { source: 'programmes', reason: 'channels_unresolved' },
      { source: 'movies', reason: 'read_timeout' },
    ]);
    expect(memory.reads).toBe(1);
    expect(memory.timeouts).toEqual([CONFIG.SEARCH.CACHE_READ_TIMEOUT_MS]);
  });

  it('ranks cached documents exactly like posted documents', async () => {
    const { channels, selection } = displayedChannels();
    const posted = new SearchWorkerIndex();
    post(posted, 1, {
      channels: postedDocuments(channels),
      programmes: programmeDocuments(channels, EPG_IDS),
      movies: ['Alpha Movie', 'Bravo Movie'],
    });

    const cached = new SearchWorkerIndex(reader());
    cached.index({ sessionId: 1, reset: true });
    expect(await cached.index(cachedRequest(channels, selection))).toEqual({
      accepted: true,
      loaded: { persisted: 0, built: 3 },
      persist: expect.any(Array),
    });

    for (const text of ['alpha', 'bravo', 'delta', 'favorites', 'sports', 'news', 'recap']) {
      expect(await cached.query(query(1, text))).toEqual(posted.query(query(1, text)));
    }
    expect((await cached.query(query(1, 'alpha')))?.channels.indices.length).toBeGreaterThan(0);
  });

  it('reads catalog names without a selection', async () => {
    const index = new SearchWorkerIndex(reader());
    index.index({ sessionId: 1, reset: true });
    const names = vod.map(item => item.name);
    expect(await index.index({ sessionId: 1, cachedMovies: cachedNames(null, names) })).toEqual({
      accepted: true,
      loaded: { persisted: 0, built: 1 },
      persist: expect.any(Array),
    });
    expect((await index.query(query(1, 'alpha')))?.movies.indices).toEqual([0, 1]);
  });

  it('reads catalog names from a record stored by column', async () => {
    const builder = new CatalogColumnsBuilder('vod', 'a');
    vod.forEach((item, i) => builder.add({ id: `m${i}`, name: item.name, poster: '', rating: '', categoryId: '1' }));
    const memory = reader();
    memory.records.set('catalog-cache|a|vod_all', { key: 'a|vod_all', timestamp: 30, data: builder.build() });
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });
    const names = vod.map(item => item.name);
    expect(await index.index({ sessionId: 1, cachedMovies: cachedNames(null, names) })).toMatchObject({
      accepted: true,
      loaded: { persisted: 0, built: 1 },
    });
    expect((await index.query(query(1, 'alpha')))?.movies.indices).toEqual([0, 1]);
    expect((await index.query(query(1, 'bravo')))?.movies.indices).toEqual([2]);
  });

  it('reports a changed record so the page posts that source', async () => {
    const { channels, selection } = displayedChannels();
    const request = cachedRequest(channels, selection);
    request.cachedMovies = { ...request.cachedMovies!, record: { ...VOD_REF, timestamp: 31 } };
    const index = new SearchWorkerIndex(reader());
    index.index({ sessionId: 1, reset: true });

    expect(await index.index(request)).toEqual({
      accepted: true,
      unresolved: [{ source: 'movies', reason: 'record_changed' }],
      loaded: { persisted: 0, built: 2 },
      persist: expect.any(Array),
    });
    expect((await index.query(query(1, 'delta')))?.channels.indices).toEqual([0]);
  });

  it('rejects a record whose length or samples drifted', async () => {
    const { channels, selection } = displayedChannels();
    const request = cachedRequest(channels, selection);
    request.cachedChannels = { ...request.cachedChannels!, length: 6 };
    const shuffled = cachedRequest(channels, selection);
    shuffled.cachedMovies = cachedNames(new Uint32Array([2, 0]), ['Alpha Movie', 'Bravo Movie']);
    const index = new SearchWorkerIndex(reader());
    index.index({ sessionId: 1, reset: true });

    expect(await index.index(request)).toEqual({
      accepted: true,
      unresolved: [
        { source: 'channels', reason: 'record_changed' },
        { source: 'programmes', reason: 'channels_unresolved' },
      ],
      loaded: { persisted: 0, built: 2 },
      persist: expect.any(Array),
    });
    expect((await index.index(shuffled)).unresolved)
      .toEqual([{ source: 'movies', reason: 'sample_mismatch' }]);
  });

  it('rejects a programme run whose list no longer matches', async () => {
    const { channels, selection } = displayedChannels();
    const runs = new ProgrammeRuns();
    runs.add(1, { url: EPG_REF.url, id: 'e1', timestamp: EPG_REF.timestamp }, 3);
    const index = new SearchWorkerIndex(reader());
    post(index, 1, { channels: postedDocuments(channels) });

    expect((await index.index({
      sessionId: 1,
      cachedProgrammes: runs.request(sampleDocuments(0, () => [])) ?? undefined,
    })).unresolved).toEqual([{ source: 'programmes', reason: 'record_changed' }]);
  });

  it('reports every source when the database is unavailable', async () => {
    const { channels, selection } = displayedChannels();
    const memory = reader();
    memory.failure = 'upgrade_needed';
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });

    expect((await index.index(cachedRequest(channels, selection))).unresolved).toEqual([
      { source: 'channels', reason: 'upgrade_needed' },
      { source: 'programmes', reason: 'channels_unresolved' },
      { source: 'movies', reason: 'upgrade_needed' },
    ]);
  });

  it('reports cached sources when the worker has no reader', async () => {
    const index = new SearchWorkerIndex();
    index.index({ sessionId: 1, reset: true });
    expect((await index.index({
      sessionId: 1,
      cachedMovies: cachedNames(null, vod.map(item => item.name)),
    })).unresolved).toEqual([{ source: 'movies', reason: 'unavailable' }]);
  });

  it('answers a query only after a pending cached index', async () => {
    const { channels, selection } = displayedChannels();
    const memory = reader();
    let open: () => void = () => undefined;
    memory.gate = new Promise((resolve) => { open = resolve; });
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });

    const indexed = index.index(cachedRequest(channels, selection));
    const answered = index.query(query(1, 'delta'));
    open();

    expect(await indexed).toMatchObject({ accepted: true });
    expect((await indexed).unresolved).toBeUndefined();
    expect((await answered)?.channels.indices).toEqual([0]);
  });

  it('rejects a cached index for a stale session without reading', async () => {
    const { channels, selection } = displayedChannels();
    const memory = reader();
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 2, reset: true });

    expect(await index.index(cachedRequest(channels, selection))).toEqual({ accepted: false });
    expect(memory.reads).toBe(0);
  });
});

describe('SearchWorkerIndex with persisted source indexes', () => {
  // Builds, offers and stores every index, as the page's persist step would.
  async function persisted(memory: MemoryReader): Promise<void> {
    const { channels, selection } = displayedChannels();
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });
    const response = await index.index(cachedRequest(channels, selection));
    const entries = (response.persist ?? [])
      .map(candidate => ({ key: candidate.key, prefix: candidate.prefix, fields: {} }));
    expect(entries).toHaveLength(3);
    expect((await index.persist({ entries })).written).toEqual(entries.map(entry => entry.key));
  }

  function sourceReads(memory: MemoryReader): string[] {
    return memory.log.filter(entry => entry.startsWith('read:') && entry !== 'read:index');
  }

  it('ranks from stored indexes without reading the source records', async () => {
    const memory = reader();
    await persisted(memory);
    memory.log.length = 0;
    const { channels, selection } = displayedChannels();
    const posted = new SearchWorkerIndex();
    post(posted, 1, {
      channels: postedDocuments(channels),
      programmes: programmeDocuments(channels, EPG_IDS),
      movies: ['Alpha Movie', 'Bravo Movie'],
    });

    const cached = new SearchWorkerIndex(memory);
    cached.index({ sessionId: 1, reset: true });
    expect(await cached.index(cachedRequest(channels, selection)))
      .toEqual({ accepted: true, loaded: { persisted: 3, built: 0 } });
    expect(sourceReads(memory)).toEqual([]);
    for (const text of ['alpha', 'bravo', 'delta', 'favorites', 'sports', 'news', 'recap']) {
      expect(await cached.query(query(1, text))).toEqual(posted.query(query(1, text)));
    }
  });

  it('rebuilds from the source when the record was replaced since indexing', async () => {
    const memory = reader();
    await persisted(memory);
    memory.records.set('catalog-cache|a|vod_all', {
      key: 'a|vod_all', timestamp: 31, data: [{ name: 'Echo' }, { name: 'Alpha Two' }],
    });
    memory.log.length = 0;
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });

    const response = await index.index({
      sessionId: 1,
      cachedMovies: {
        record: { ...VOD_REF, timestamp: 31 },
        length: 2,
        selection: null,
        samples: sampleDocuments(2, i => [['Echo', 'Alpha Two'][i]]),
      },
    });
    expect(response.unresolved).toBeUndefined();
    expect(response.persist?.map(candidate => candidate.key)).toEqual(['catalog-cache|a|vod_all|31|v1']);
    expect(sourceReads(memory)).toEqual(['read:a|vod_all']);
    expect((await index.query(query(1, 'alpha')))?.movies.indices).toEqual([1]);
  });

  it('ignores a stored index of another format or a broken shape', async () => {
    const memory = reader();
    await persisted(memory);
    const key = 'catalog-cache|a|vod_all|30|v1';
    const stored = memory.records.get(`search-index-cache|${key}`)!;
    for (const broken of [
      { ...stored, format: 0 },
      { ...stored, ends: Array.from(stored.ends as Uint32Array) },
      { ...stored, text: `${String(stored.text)}x` },
    ]) {
      memory.records.set(`search-index-cache|${key}`, broken);
      memory.log.length = 0;
      const index = new SearchWorkerIndex(memory);
      index.index({ sessionId: 1, reset: true });
      const response = await index.index({
        sessionId: 1,
        cachedMovies: cachedNames(null, vod.map(item => item.name)),
      });
      expect(response.persist?.map(candidate => candidate.key)).toEqual([key]);
      expect(sourceReads(memory)).toEqual(['read:a|vod_all']);
      expect((await index.query(query(1, 'alpha')))?.movies.indices).toEqual([0, 1]);
    }
  });

  it('reads the source when the index store does not exist yet', async () => {
    const memory = reader();
    const read = memory.read.bind(memory);
    memory.read = async (ref, timeoutMs) => {
      if (ref.store === 'search-index-cache') throw new SearchCacheError('store_missing');
      return read(ref, timeoutMs);
    };
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });
    const response = await index.index({
      sessionId: 1,
      cachedMovies: cachedNames(null, vod.map(item => item.name)),
    });
    expect(response.unresolved).toBeUndefined();
    expect((await index.query(query(1, 'alpha')))?.movies.indices).toEqual([0, 1]);
  });

  it('keeps the in-memory index when the write fails and never offers it again', async () => {
    const memory = reader();
    memory.writeFailure = 'quota_exceeded';
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });
    const names = vod.map(item => item.name);
    const first = await index.index({ sessionId: 1, cachedMovies: cachedNames(null, names) });
    const entries = first.persist!.map(candidate => ({ ...candidate, fields: {} }));

    expect(await index.persist({ entries })).toEqual({
      written: [],
      failed: [{ key: entries[0].key, reason: 'quota_exceeded' }],
    });
    expect([...memory.records.keys()].some(key => key.startsWith('search-index-cache|'))).toBe(false);
    memory.log.length = 0;
    index.index({ sessionId: 2, reset: true });
    const second = await index.index({ sessionId: 2, cachedMovies: cachedNames(null, names) });
    expect(second).toEqual({ accepted: true, loaded: { persisted: 1, built: 0 } });
    expect(memory.log).toEqual([]);
    expect((await index.query(query(2, 'alpha')))?.movies.indices).toEqual([0, 1]);
  });

  it('writes only the entries the page reserved, with the reserved fields', async () => {
    const memory = reader();
    const index = new SearchWorkerIndex(memory);
    index.index({ sessionId: 1, reset: true });
    const response = await index.index({
      sessionId: 1,
      cachedMovies: cachedNames(null, vod.map(item => item.name)),
    });
    const candidate = response.persist![0];

    expect(await index.persist({
      entries: [
        { key: candidate.key, prefix: candidate.prefix, fields: { expiresAt: 5, bytes: 9 } },
        { key: 'catalog-cache|other|1|v1', prefix: 'catalog-cache|other|', fields: {} },
      ],
    })).toEqual({ written: [candidate.key] });
    expect(memory.records.get(`search-index-cache|${candidate.key}`))
      .toMatchObject({ key: candidate.key, expiresAt: 5, bytes: 9, format: 1 });
  });

  it('prewarms with the timestamp the cache metadata records', async () => {
    const memory = reader();
    memory.records.set('cache-meta|entry:catalog-cache:a|vod_all', { id: 'x', timestamp: 30 });
    const index = new SearchWorkerIndex(memory);

    const response = await index.prewarm({
      sources: [{ store: 'catalog-cache', key: 'a|vod_all' }],
    });
    expect(response.persist.map(candidate => candidate.key)).toEqual(['catalog-cache|a|vod_all|30|v1']);
    expect(memory.log).toEqual(['read:entry:catalog-cache:a|vod_all', 'count:search-index-cache', 'read:a|vod_all']);
  });

  it('prewarms nothing for a source whose index is already stored', async () => {
    const memory = reader();
    await persisted(memory);
    memory.log.length = 0;
    const index = new SearchWorkerIndex(memory);

    expect(await index.prewarm({
      sources: [
        { ...PLAYLIST_REF },
        { store: 'epg-cache', key: EPG_REF.url, timestamp: EPG_REF.timestamp },
        { ...VOD_REF },
      ],
    })).toEqual({ persist: [] });
    expect(sourceReads(memory)).toEqual([]);
  });

  it('skips a prewarm source that is missing or unreadable', async () => {
    const memory = reader();
    const index = new SearchWorkerIndex(memory);
    expect(await index.prewarm({
      sources: [{ store: 'catalog-cache', key: 'a|series_all', timestamp: 1 }],
    })).toEqual({ persist: [], skipped: [{ store: 'catalog-cache', reason: 'missing' }] });
    memory.failure = 'open_failed';
    expect(await index.prewarm({ sources: [{ ...VOD_REF }] }))
      .toEqual({ persist: [], skipped: [{ store: 'catalog-cache', reason: 'open_failed' }] });
  });
});
