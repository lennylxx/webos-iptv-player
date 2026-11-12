import { describe, expect, it } from 'vitest';
import { exposeWorkerTasks, PROGRESS_WINDOW, WorkerRpcClient } from './worker-rpc';

interface TestTasks {
  add: {
    request: { left: number; right: number };
    response: number;
    chunk: number;
  };
  fail: {
    request: undefined;
    response: never;
  };
}

class LinkedEndpoint {
  peer: LinkedEndpoint | null = null;
  terminated = false;
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: (() => void) | null = null;

  postMessage(message: unknown): void {
    queueMicrotask(() => {
      this.peer?.messageListener?.({ data: message } as MessageEvent<unknown>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  emitMessageError(): void {
    this.messageErrorListener?.();
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
      | (() => void),
  ): void {
    if (type === 'message') {
      this.messageListener = listener as (event: MessageEvent<unknown>) => void;
    } else if (type === 'error') {
      this.errorListener = listener as (event: ErrorEvent) => void;
    } else {
      this.messageErrorListener = listener as () => void;
    }
  }
}

function linkedEndpoints(): [LinkedEndpoint, LinkedEndpoint] {
  const client = new LinkedEndpoint();
  const worker = new LinkedEndpoint();
  client.peer = worker;
  worker.peer = client;
  return [client, worker];
}

describe('WorkerRpcClient', () => {
  it('matches concurrent responses by request id', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: async ({ left, right }) => {
        await new Promise(resolve => setTimeout(resolve, 0));
        return left + right;
      },
      fail: () => {
        throw new Error('failed task');
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);

    await expect(Promise.all([
      client.request('add', { left: 1, right: 2 }),
      client.request('add', { left: 4, right: 5 }),
    ])).resolves.toEqual([3, 9]);
    await expect(client.request('fail', undefined)).rejects.toThrow('failed task');
  });

  it('delivers ordered progress without completing the request', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    let finish!: () => void;
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: async ({ left, right }, emitChunk) => {
        emitChunk(left);
        await new Promise<void>(resolve => {
          finish = resolve;
        });
        emitChunk(right);
        return left + right;
      },
      fail: () => {
        throw new Error('failed task');
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);
    const chunks: number[] = [];
    const result = client.request('add', { left: 2, right: 3 }, chunk => {
      chunks.push(chunk);
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(chunks).toEqual([2]);
    finish();

    await expect(result).resolves.toBe(5);
    expect(chunks).toEqual([2, 3]);
  });

  it('paces progress by acknowledgement and completes after the last chunk', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    const heldAcks: unknown[] = [];
    const send = clientEndpoint.postMessage.bind(clientEndpoint);
    clientEndpoint.postMessage = (message: unknown) => {
      if ((message as { kind?: string }).kind === 'ack') heldAcks.push(message);
      else send(message);
    };
    const releaseAck = (): void => send(heldAcks.shift());
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: ({ left, right }, emitChunk) => {
        for (let i = 0; i < 5; i++) emitChunk(i);
        return left + right;
      },
      fail: () => {
        throw new Error('failed task');
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);
    const chunks: number[] = [];
    let settled = false;
    const result = client.request('add', { left: 2, right: 3 }, chunk => {
      chunks.push(chunk);
    }).finally(() => (settled = true));
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    await flush();
    expect(chunks).toEqual([0, 1]);
    expect(heldAcks).toHaveLength(PROGRESS_WINDOW);
    expect(settled).toBe(false);
    releaseAck();
    await flush();
    expect(chunks).toEqual([0, 1, 2]);
    while (heldAcks.length && chunks.length < 5) {
      releaseAck();
      await flush();
    }
    expect(chunks).toEqual([0, 1, 2, 3, 4]);
    expect(settled).toBe(true);
    await expect(result).resolves.toBe(5);
  });

  it('acknowledges progress for a request it no longer waits on', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const posted: unknown[] = [];
    clientEndpoint.postMessage = (message: unknown) => posted.push(message);
    new WorkerRpcClient<TestTasks>(clientEndpoint);
    clientEndpoint.peer!.postMessage({ kind: 'progress', id: 41, chunk: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(posted).toEqual([{ kind: 'ack', id: 41 }]);
  });

  it('rejects pending work and terminates explicitly', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);
    const pending = client.request('add', { left: 1, right: 2 });

    client.terminate();

    await expect(pending).rejects.toThrow('terminated');
    await expect(client.request('add', { left: 1, right: 2 }))
      .rejects.toThrow('terminated');
    expect(clientEndpoint.terminated).toBe(true);
  });

  it('surfaces worker execution errors', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const fatals: string[] = [];
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint, {
      onFatal: (_error, reason) => fatals.push(reason),
    });
    const pending = client.request('add', { left: 1, right: 2 });
    clientEndpoint.emitError('worker crashed');

    await expect(pending).rejects.toThrow('worker crashed');
    expect(fatals).toEqual(['execution_error']);
  });

  it('identifies response deserialization failures', async () => {
    const [clientEndpoint] = linkedEndpoints();
    const fatals: string[] = [];
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint, {
      onFatal: (_error, reason) => fatals.push(reason),
    });
    const pending = client.request('add', { left: 1, right: 2 });
    clientEndpoint.emitMessageError();

    await expect(pending).rejects.toThrow('could not be deserialized');
    expect(fatals).toEqual(['message_error']);
  });

  it('preserves structured worker error details', async () => {
    const [clientEndpoint, workerEndpoint] = linkedEndpoints();
    exposeWorkerTasks<TestTasks>(workerEndpoint, {
      add: ({ left, right }) => left + right,
      fail: () => {
        const error = new Error('failed task');
        Object.assign(error, { details: { stage: 'parse' } });
        throw error;
      },
    });
    const client = new WorkerRpcClient<TestTasks>(clientEndpoint);

    await expect(client.request('fail', undefined)).rejects.toMatchObject({
      message: 'failed task',
      details: { stage: 'parse' },
    });
  });
});
