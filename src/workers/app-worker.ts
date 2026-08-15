import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import { SearchWorkerIndex } from './search-index';
import type { AppWorkerTasks } from './tasks';

const searchIndex = new SearchWorkerIndex();
const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'xmltv.load': request => fetchAndParseXMLTVInWorker(request),
  'search.index': request => searchIndex.index(request),
  'search.query': request => searchIndex.query(request),
};

exposeWorkerTasks(
  self as unknown as Parameters<typeof exposeWorkerTasks<AppWorkerTasks>>[0],
  handlers,
);
