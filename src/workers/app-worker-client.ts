import { WorkerRpcClient } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';

const log = createLogger('AppWorker');
let client: WorkerRpcClient<AppWorkerTasks> | null = null;
let currentGeneration: number | null = null;
let nextGeneration = 1;
let activeRequests = 0;
let retainCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function appWorkerClient(): WorkerRpcClient<AppWorkerTasks> {
  if (!client) {
    // Legacy webOS has no module workers; esbuild emits this classic IIFE at a stable path.
    const url = new URL('js/app-worker.js', document.baseURI).href;
    const generation = nextGeneration++;
    const nextClient = new WorkerRpcClient<AppWorkerTasks>(new Worker(url), {
      onFatal(error, reason) {
        if (client === nextClient) {
          client = null;
          currentGeneration = null;
        }
        clearIdleTimer();
        log.error(
          'App worker failed',
          'event=worker.lifecycle.failed',
          `reason=${reason}`,
          `generation=${String(generation)}`,
          `active=${String(activeRequests)}`,
          error,
        );
      },
    });
    client = nextClient;
    currentGeneration = generation;
    log.info(
      'App worker created',
      'event=worker.lifecycle.created',
      `generation=${String(generation)}`,
    );
  }
  return client;
}

export async function runAppWorkerTask<TaskName extends keyof AppWorkerTasks & string>(
  task: TaskName,
  payload: AppWorkerTasks[TaskName]['request'],
  onChunk?: (
    chunk: AppWorkerTasks[TaskName] extends { chunk: infer Chunk } ? Chunk : never
  ) => void,
): Promise<AppWorkerTasks[TaskName]['response']> {
  clearIdleTimer();
  activeRequests++;
  const taskClient = appWorkerClient();
  const generation = currentGeneration;
  const started = Date.now();
  let batches = 0;
  let progress = 0;
  const diagnosticTask = task === 'm3u.load' || task === 'xmltv.load';
  const handleChunk = onChunk && diagnosticTask
    ? (chunk: Parameters<NonNullable<typeof onChunk>>[0]) => {
        if (chunk && typeof chunk === 'object' && 'kind' in chunk) {
          const kind = (chunk as { kind?: unknown }).kind;
          if (kind === 'channels' || kind === 'guide') batches++;
          else if (kind === 'progress') progress++;
        }
        onChunk(chunk);
      }
    : onChunk;
  if (diagnosticTask) {
    log.info(
      'App worker task started',
      'event=worker.task.started',
      `task=${task}`,
      `generation=${String(generation ?? 'unknown')}`,
      `active=${String(activeRequests)}`,
    );
  }
  try {
    const response = await taskClient.request(task, payload, handleChunk);
    if (diagnosticTask) {
      log.info(
        'App worker task completed',
        'event=worker.task.completed',
        `task=${task}`,
        `generation=${String(generation ?? 'unknown')}`,
        `batches=${String(batches)}`,
        `progress=${String(progress)}`,
        `elapsedMs=${String(Date.now() - started)}`,
      );
    }
    return response;
  } catch (error) {
    if (diagnosticTask) {
      log.error(
        'App worker task failed',
        'event=worker.task.failed',
        `task=${task}`,
        `generation=${String(generation ?? 'unknown')}`,
        `batches=${String(batches)}`,
        `progress=${String(progress)}`,
        `elapsedMs=${String(Date.now() - started)}`,
        `reason=${error instanceof Error && error.name === 'AbortError'
          ? 'aborted'
          : 'request_failed'}`,
        error,
      );
    }
    throw error;
  } finally {
    activeRequests--;
    scheduleIdleTermination();
  }
}

export function retainAppWorker(): () => void {
  retainCount++;
  clearIdleTimer();
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    retainCount--;
    scheduleIdleTermination();
  };
}

// Each new worker after a termination or crash gets a new generation, so
// state held in a worker can be told apart from its empty successor.
export function appWorkerGeneration(): number | null {
  return currentGeneration;
}

export function terminateAppWorker(reason = 'manual'): void {
  clearIdleTimer();
  if (!client) return;
  const generation = currentGeneration;
  client.terminate(`App worker terminated: ${reason}`);
  client = null;
  currentGeneration = null;
  log.info(
    'App worker terminated',
    'event=worker.lifecycle.terminated',
    `reason=${reason}`,
    `generation=${String(generation ?? 'unknown')}`,
  );
}

function clearIdleTimer(): void {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleTermination(): void {
  if (activeRequests !== 0 || retainCount !== 0 || !client) return;
  clearIdleTimer();
  idleTimer = setTimeout(
    () => terminateAppWorker('idle'),
    CONFIG.WORKER_IDLE_TERMINATION_MS,
  );
}
