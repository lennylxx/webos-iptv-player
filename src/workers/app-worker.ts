import { fetchAndParseXMLTVInWorker } from '../parsers/xmltv-loader';
import { exposeWorkerTasks, type WorkerTaskHandlers } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';

const handlers: WorkerTaskHandlers<AppWorkerTasks> = {
  'xmltv.load': request => fetchAndParseXMLTVInWorker(request),
};

exposeWorkerTasks(
  self as unknown as Parameters<typeof exposeWorkerTasks<AppWorkerTasks>>[0],
  handlers,
);
