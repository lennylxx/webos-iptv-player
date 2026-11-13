import '../polyfills';
import { fetchAndParseM3UInWorker } from '../parsers/m3u-loader';
import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { loadLiveStreamsCatalog } from '../services/xtream-client';
import { cancelXtreamCatalogStream, streamXtreamCatalogInWorker } from '../services/xtream-catalog-stream';
import { measureHeldValue, releaseHeldValue, writeHeldValue } from './held-values';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import { IdbSearchCacheReader } from './search-cache-reader';
import { ScopedSearchIndex } from './scoped-search-index';
import type { AppWorkerTasks } from './tasks';

const cacheDb = new IdbSearchCacheReader(typeof indexedDB === 'undefined' ? undefined : indexedDB);
const searchIndex = new SearchWorkerIndex(cacheDb);
const scopedSearchIndex = new ScopedSearchIndex();
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'm3u.load': (request, emitChunk) => fetchAndParseM3UInWorker(request, emitChunk),
  'xmltv.load': (request, emitChunk) => fetchAndParseXMLTVInWorker(request, emitChunk),
  'xtream.live-streams': request => loadLiveStreamsCatalog(request),
  'xtream.catalog-stream': (request, emitChunk) =>
    streamXtreamCatalogInWorker(request, emitChunk, ref => searchIndex.catalogList({ store: 'catalog-cache', ...ref })),
  'xtream.catalog-stream.cancel': (request) => {
    cancelXtreamCatalogStream(request.token);
    return Promise.resolve();
  },
  'cache.write-held': request => writeHeldValue(
    request,
    (writes, timeoutMs) => cacheDb.writeAll(writes, timeoutMs),
    (store, value) => searchIndex.retainCatalogRecord(store, value),
  ),
  'cache.measure-held': request => Promise.resolve(measureHeldValue(request.token)),
  // TODO(cleanup, post-1.18.0): remove with migrateLegacyPlaylistCache.
  'cache.migrate-playlist': request => cacheDb.migratePlaylist(request.key, request.keyPath, request.timeoutMs),
  'cache.release-held': (request) => {
    releaseHeldValue(request.token);
    return Promise.resolve();
  },
  'search.index': request => searchIndex.index(request),
  'search.query': request => searchIndex.query(request),
  'search.prewarm': request => searchIndex.prewarm(request),
  'search.persist': request => searchIndex.persist(request),
  'catalog.members': request => searchIndex.catalogMembers(request),
  'list-search.index': request => scopedSearchIndex.indexList(request),
  'list-search.query': request => scopedSearchIndex.queryList(request),
  'list-search.release': request => scopedSearchIndex.releaseList(request),
  'mapping-search.index': request => scopedSearchIndex.indexMapping(request),
  'mapping-search.query': request => scopedSearchIndex.queryMapping(request),
  'mapping-search.release': request => scopedSearchIndex.releaseMapping(request),
};

exposeWorkerTasks(
  self as unknown as Parameters<typeof exposeWorkerTasks<AppWorkerTasks>>[0],
  handlers,
);
