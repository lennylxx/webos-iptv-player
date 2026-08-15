export interface WorkerTask {
  request: unknown;
  response: unknown;
}

export type WorkerTaskMap<Tasks> = {
  [TaskName in keyof Tasks]: WorkerTask;
};

interface WorkerRequest {
  kind: 'request';
  id: number;
  task: string;
  payload: unknown;
}

interface WorkerSuccess {
  kind: 'success';
  id: number;
  result: unknown;
}

interface WorkerFailure {
  kind: 'failure';
  id: number;
  error: {
    name: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: () => void): void;
}

interface WorkerEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
};

export type WorkerRpcFatalReason =
  | 'execution_error'
  | 'message_error'
  | 'protocol_error';

interface WorkerRpcClientOptions {
  onFatal?(error: Error, reason: WorkerRpcFatalReason): void;
}

export type WorkerTaskHandlers<Tasks extends WorkerTaskMap<Tasks>> = {
  [TaskName in keyof Tasks]: (
    payload: Tasks[TaskName]['request'],
  ) => Promise<Tasks[TaskName]['response']> | Tasks[TaskName]['response'];
};

export class WorkerRpcClient<Tasks extends WorkerTaskMap<Tasks>> {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly worker: WorkerLike,
    private readonly options: WorkerRpcClientOptions = {},
  ) {
    worker.addEventListener('message', event => this.handleMessage(event.data));
    worker.addEventListener('error', event => {
      this.failFatal(
        new Error(event.message || 'Worker execution failed'),
        'execution_error',
      );
    });
    worker.addEventListener('messageerror', () => {
      this.failFatal(
        new Error('Worker response could not be deserialized'),
        'message_error',
      );
    });
  }

  request<TaskName extends keyof Tasks & string>(
    task: TaskName,
    payload: Tasks[TaskName]['request'],
  ): Promise<Tasks[TaskName]['response']> {
    if (this.closed) return Promise.reject(new Error('Worker RPC client is terminated'));
    const id = this.nextId++;
    return new Promise<Tasks[TaskName]['response']>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as Tasks[TaskName]['response']),
        reject,
      });
      const message: WorkerRequest = { kind: 'request', id, task, payload };
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  terminate(reason = 'Worker RPC client terminated'): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll(new Error(reason));
  }

  private handleMessage(value: unknown): void {
    if (!isWorkerResponse(value)) {
      this.failFatal(
        new Error('Worker returned an invalid RPC response'),
        'protocol_error',
      );
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.kind === 'success') {
      pending.resolve(value.result);
      return;
    }
    const error = new Error(value.error.message);
    error.name = value.error.name;
    if (value.error.stack) error.stack = value.error.stack;
    if (value.error.details !== undefined) {
      Object.assign(error, { details: value.error.details });
    }
    pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private failFatal(error: Error, reason: WorkerRpcFatalReason): void {
    if (!this.closed) {
      this.closed = true;
      this.worker.terminate();
      this.options.onFatal?.(error, reason);
    }
    this.failAll(error);
  }
}

export function exposeWorkerTasks<Tasks extends WorkerTaskMap<Tasks>>(
  endpoint: WorkerEndpoint,
  handlers: WorkerTaskHandlers<Tasks>,
): void {
  endpoint.addEventListener('message', event => {
    const request = event.data;
    if (!isWorkerRequest(request)) return;
    const handler = handlers[request.task as keyof Tasks] as
      | ((payload: unknown) => unknown)
      | undefined;
    if (typeof handler !== 'function') {
      postFailure(endpoint, request.id, new Error(`Unknown worker task: ${request.task}`));
      return;
    }
    let result: unknown;
    try {
      result = handler(request.payload);
    } catch (error) {
      postFailure(endpoint, request.id, asError(error));
      return;
    }
    void Promise.resolve(result).then(
      result => {
        const response: WorkerSuccess = {
          kind: 'success',
          id: request.id,
          result,
        };
        try {
          endpoint.postMessage(response);
        } catch (error) {
          postFailure(endpoint, request.id, asError(error));
        }
      },
      error => postFailure(endpoint, request.id, asError(error)),
    );
  });
}

function postFailure(endpoint: WorkerEndpoint, id: number, error: Error): void {
  const response: WorkerFailure = {
    kind: 'failure',
    id,
    error: {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...('details' in error ? { details: error.details } : {}),
    },
  };
  endpoint.postMessage(response);
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<WorkerRequest>;
  return request.kind === 'request'
    && typeof request.id === 'number'
    && typeof request.task === 'string';
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<WorkerResponse>;
  if (typeof response.id !== 'number') return false;
  if (response.kind === 'success') return true;
  if (response.kind !== 'failure' || !response.error
      || typeof response.error !== 'object') return false;
  const error = response.error as Partial<WorkerFailure['error']>;
  return typeof error.name === 'string'
    && typeof error.message === 'string'
    && (error.stack === undefined || typeof error.stack === 'string');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
