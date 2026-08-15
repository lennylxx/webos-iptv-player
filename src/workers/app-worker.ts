import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import { ScopedSearchIndex } from './scoped-search-index';
import type { AppWorkerTasks } from './tasks';

const searchIndex = new SearchWorkerIndex();
const scopedSearchIndex = new ScopedSearchIndex();
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'xmltv.load': request => fetchAndParseXMLTVInWorker(request),
  'search.index': request => searchIndex.index(request),
  'search.query': request => searchIndex.query(request),
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
