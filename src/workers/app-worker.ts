import '../polyfills';
import { fetchAndParseM3UInWorker } from '../parsers/m3u-loader';
import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { loadLiveStreamsCatalog } from '../services/xtream-client';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import { IdbSearchCacheReader } from './search-cache-reader';
import { ScopedSearchIndex } from './scoped-search-index';
import type { AppWorkerTasks } from './tasks';

const searchIndex = new SearchWorkerIndex(new IdbSearchCacheReader(
  typeof indexedDB === 'undefined' ? undefined : indexedDB,
));
const scopedSearchIndex = new ScopedSearchIndex();
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'm3u.load': (request, emitChunk) => fetchAndParseM3UInWorker(request, emitChunk),
  'xmltv.load': (request, emitChunk) => fetchAndParseXMLTVInWorker(request, emitChunk),
  'xtream.live-streams': request => loadLiveStreamsCatalog(request),
  'search.index': request => searchIndex.index(request),
  'search.query': request => searchIndex.query(request),
  'search.prewarm': request => searchIndex.prewarm(request),
  'search.persist': request => searchIndex.persist(request),
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
