import { WorkerRpcClient } from './worker-rpc';
import type { AppWorkerTasks } from './tasks';
import { createLogger } from '../utils/logger';

const IDLE_TERMINATION_MS = 1000;
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
): Promise<AppWorkerTasks[TaskName]['response']> {
  clearIdleTimer();
  activeRequests++;
  try {
    return await appWorkerClient().request(task, payload);
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

export function isAppWorkerRunning(): boolean {
  return client !== null;
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
  idleTimer = setTimeout(() => terminateAppWorker('idle'), IDLE_TERMINATION_MS);
}
