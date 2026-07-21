import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CSV_HEADER,
  formatCpuProfilePartPath,
  formatDeviceInfo,
  formatMonitorTarget,
  formatTerminalHeader,
  formatTerminalRow,
  main,
  normalizeMetrics,
  parsePerformanceArgs,
  runMonitor,
  serializeCsvRow,
  serializeJsonl,
  startCpuProfile,
  startTrace,
  stopCpuProfile,
  stopTrace,
  takeHeapSnapshot,
} from './tv-perf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const unitOutputRoot = path.join(repoRoot, 'test-output', 'tv-perf-review');

const SAMPLE_METRICS = [
  { name: 'Timestamp', value: 10 },
  { name: 'TaskDuration', value: 2 },
  { name: 'JSHeapUsedSize', value: 1024 },
  { name: 'JSHeapTotalSize', value: 2048 },
  { name: 'Nodes', value: 12 },
  { name: 'JSEventListeners', value: 3 },
  { name: 'Documents', value: 1 },
  { name: 'Frames', value: 1 },
  { name: 'LayoutCount', value: 4 },
  { name: 'RecalcStyleCount', value: 6 },
];

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

class FakeOutput {
  constructor({ isTTY = false, failMessage = null } = {}) {
    this.isTTY = isTTY;
    this.failMessage = failMessage;
    this.chunks = [];
  }

  write(chunk) {
    if (this.failMessage) throw new Error(this.failMessage);
    this.chunks.push(String(chunk));
    return true;
  }
}

class FakeRecorderStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.endCalls = 0;
    queueMicrotask(() => {
      this.emit('open');
    });
  }

  write(chunk) {
    this.writes.push(String(chunk));
    return true;
  }

  end() {
    this.endCalls += 1;
    this.writableEnded = true;
    this.writableFinished = true;
    queueMicrotask(() => {
      this.emit('finish');
    });
  }
}

class FakeWebSocket {
  constructor() {
    this.listeners = new Map();
    this.closed = false;
    this.metricsCalls = 0;
    this.closeCalls = 0;
    this.methods = [];
    this.metricSamples = [SAMPLE_METRICS];
    queueMicrotask(() => {
      this.dispatch('open', {});
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    listeners.delete(listener);
    if (!listeners.size) {
      this.listeners.delete(type);
    }
  }

  send(data) {
    const message = JSON.parse(data);
    this.methods.push(message.method);
    let result = {};

    if (message.method === 'Performance.getMetrics') {
      this.metricsCalls += 1;
      result = {
        metrics: this.metricSamples[Math.min(this.metricsCalls - 1, this.metricSamples.length - 1)],
      };
    }
    if (message.method === 'Profiler.stop') {
      result = {
        profile: {
          nodes: [{ id: 1, callFrame: { functionName: 'alpha' } }],
          startTime: 1,
          endTime: 2,
          samples: [1],
          timeDeltas: [1000],
        },
      };
    }
    if (message.method === 'Tracing.getCategories') {
      result = {
        categories: [
          'devtools.timeline',
          'blink.user_timing',
          'media',
          'renderer.scheduler',
          'unsupported.extra',
        ],
      };
    }
    if (message.method === 'Tracing.end') {
      queueMicrotask(() => {
        this.dispatch('message', {
          data: JSON.stringify({
            method: 'Tracing.dataCollected',
            params: {
              value: [{ name: 'Task', cat: 'devtools.timeline', ph: 'X', ts: 1, dur: 2 }],
            },
          }),
        });
        this.dispatch('message', {
          data: JSON.stringify({
            method: 'Tracing.bufferUsage',
            params: { percentFull: 0.25 },
          }),
        });
        this.dispatch('message', {
          data: JSON.stringify({
            method: 'Tracing.tracingComplete',
            params: { dataLossOccurred: false },
          }),
        });
      });
    }

    queueMicrotask(() => {
      this.dispatch('message', {
        data: JSON.stringify({ id: message.id, result }),
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
    queueMicrotask(() => {
      this.dispatch('close', {});
    });
  }

  dispatch(type, event) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(event);
    }
  }
}

// A minimal CdpClient double whose 'HeapProfiler.takeHeapSnapshot' call
// synchronously emits queued chunks and then rejects, standing in for a
// signal-driven `client.close()` interrupting an in-flight snapshot while
// chunk writes are queued/in-flight.
class FakeAbortingSnapshotClient {
  constructor({ chunks, closeError }) {
    this.chunks = chunks;
    this.closeError = closeError ?? new Error('client closed during snapshot');
    this.listeners = new Map();
    this.closeCalls = 0;
  }

  on(method, listener) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  emit(method, payload) {
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(payload);
  }

  async call(method) {
    if (method === 'HeapProfiler.enable') return {};
    if (method === 'HeapProfiler.takeHeapSnapshot') {
      for (const chunk of this.chunks) {
        this.emit('HeapProfiler.addHeapSnapshotChunk', { chunk });
      }
      this.close();
      throw this.closeError;
    }
    throw new Error(`unexpected method: ${method}`);
  }

  close() {
    this.closeCalls += 1;
  }
}

// Forces real backpressure (stream.write() returning false) so a queued
// chunk write is genuinely in flight, awaiting 'drain', at the moment the
// snapshot aborts.
const createBackpressuredWriteStream = (filePath, options) =>
  createWriteStream(filePath, { ...options, highWaterMark: 1 });

const trackUnhandledRejections = () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  return {
    rejections,
    async stop() {
      // Give any late microtask-scheduled rejection a chance to surface
      // before asserting none occurred.
      await delay(20);
      process.off('unhandledRejection', onUnhandledRejection);
    },
  };
};

afterEach(async () => {
  await rm(unitOutputRoot, { recursive: true, force: true });
});

describe('runMonitor signal cleanup', () => {
  it.each(['SIGINT', 'SIGTERM'])('removes %s handlers and aborts the interval wait', async (signalName) => {
    const signalSource = new EventEmitter();
    const waitStarted = createDeferred();
    let abortCount = 0;
    let socket = null;
    const stdout = new FakeOutput();
    const wait = (_intervalMs, options = {}) => {
      waitStarted.resolve(options.signal ?? null);
      return new Promise((resolve, reject) => {
        if (!options.signal) {
          reject(new Error('expected abort signal'));
          return;
        }

        if (options.signal.aborted) {
          abortCount += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }

        options.signal.addEventListener('abort', () => {
          abortCount += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    };
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        socket = this;
      }
    };

    const outcomePromise = runMonitor({
      url: 'ws://127.0.0.1:9222/devtools/page/test',
      intervalMs: 60_000,
      durationMs: null,
      jsonlPath: null,
      csvPath: null,
    }, {
      stdout,
      signalSource,
      wait,
      WebSocketImpl,
    }).then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    );

    const abortSignal = await waitStarted.promise;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
    expect(signalSource.listenerCount('SIGINT')).toBe(1);
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);

    signalSource.emit(signalName);

    const outcome = await outcomePromise;
    expect(outcome).toEqual({ status: 'resolved' });
    expect(abortCount).toBe(1);
    expect(socket?.metricsCalls).toBe(1);
    expect(socket?.closeCalls).toBe(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('runMonitor duration handling', () => {
  it('bounds the wait by remaining duration and stops before a post-deadline sample', async () => {
    const signalSource = new EventEmitter();
    const stdout = new FakeOutput();
    const waitIntervals = [];
    const clock = { now: 0 };
    let socket = null;
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        socket = this;
      }
    };

    await runMonitor({
      url: 'ws://127.0.0.1:9222/devtools/page/test',
      intervalMs: 5_000,
      durationMs: 1_000,
      jsonlPath: null,
      csvPath: null,
    }, {
      stdout,
      signalSource,
      WebSocketImpl,
      nowMs: () => clock.now,
      wait: async (intervalMs) => {
        waitIntervals.push(intervalMs);
        expect(intervalMs).toBe(1_000);
        clock.now += intervalMs;
      },
    });

    expect(waitIntervals).toEqual([1_000]);
    expect(clock.now).toBe(1_000);
    expect(socket?.metricsCalls).toBe(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('triggered diagnostics', () => {
  it('records six CPU profile and trace parts after CPU stays high for 3 seconds', async () => {
    const signalSource = new EventEmitter();
    const stdout = new FakeOutput();
    const clock = { now: 0 };
    const destination = path.join(unitOutputRoot, 'profiles', 'alpha.cpuprofile');
    const traceDestination = path.join(unitOutputRoot, 'profiles', 'alpha.trace.json');
    let socket = null;
    const WebSocketImpl = class extends FakeWebSocket {
      constructor(url) {
        super(url);
        this.metricSamples = [
          [
            { name: 'Timestamp', value: 1 },
            { name: 'TaskDuration', value: 0 },
          ],
          [
            { name: 'Timestamp', value: 2 },
            { name: 'TaskDuration', value: 0.9 },
          ],
          [
            { name: 'Timestamp', value: 3 },
            { name: 'TaskDuration', value: 1.8 },
          ],
          [
            { name: 'Timestamp', value: 4 },
            { name: 'TaskDuration', value: 2.7 },
          ],
        ];
        socket = this;
      }
    };

    await runMonitor({
      url: 'ws://127.0.0.1:9222/devtools/page/test',
      intervalMs: 1_000,
      durationMs: 10_000,
      jsonlPath: null,
      csvPath: null,
      cpuProfilePath: destination,
      tracePath: traceDestination,
    }, {
      stdout,
      signalSource,
      WebSocketImpl,
      nowMs: () => clock.now,
      wait: async (intervalMs) => {
        clock.now += intervalMs;
      },
    });

    expect(socket?.methods.filter((method) => method === 'Profiler.enable')).toHaveLength(6);
    expect(socket?.methods.filter((method) => method === 'Profiler.start')).toHaveLength(6);
    expect(socket?.methods.filter((method) => method === 'Profiler.stop')).toHaveLength(6);
    expect(socket?.methods.filter((method) => method === 'Tracing.start')).toHaveLength(6);
    expect(socket?.methods.filter((method) => method === 'Tracing.end')).toHaveLength(6);
    expect(socket?.methods.filter((method) => method === 'Tracing.getCategories')).toHaveLength(1);
    expect(socket?.methods.indexOf('Profiler.start'))
      .toBeGreaterThan(socket?.methods.indexOf('Performance.getMetrics') ?? -1);
    expect(socket?.methods.indexOf('Profiler.stop'))
      .toBeGreaterThan(socket?.methods.indexOf('Performance.getMetrics') ?? -1);
    expect(clock.now).toBe(33_000);
    for (let partNumber = 1; partNumber <= 6; partNumber += 1) {
      const partPath = formatCpuProfilePartPath(destination, partNumber);
      expect(JSON.parse(await readFile(partPath, 'utf8'))).toMatchObject({
        nodes: [{ id: 1, callFrame: { functionName: 'alpha' } }],
        samples: [1],
        timeDeltas: [1000],
      });
      const tracePath = formatCpuProfilePartPath(traceDestination, partNumber);
      expect(JSON.parse(await readFile(tracePath, 'utf8'))).toEqual({
        traceEvents: [
          { name: 'Task', cat: 'devtools.timeline', ph: 'X', ts: 1, dur: 2 },
        ],
        displayTimeUnit: 'ms',
        tvPerf: {
          bufferSizeKb: 4096,
          categories: [
            'devtools.timeline',
            'blink.user_timing',
            'media',
            'renderer.scheduler',
          ],
          maxBufferUsage: 0.25,
          dataLossOccurred: false,
        },
      });
    }
  });

  it('does not create a profile when CPU does not reach the trigger threshold', async () => {
    const stdout = new FakeOutput();
    const clock = { now: 0 };
    const destination = path.join(unitOutputRoot, 'profiles', 'idle.cpuprofile');

    const result = await runMonitor({
      url: 'ws://127.0.0.1:9222/devtools/page/test',
      intervalMs: 1_000,
      durationMs: 3_000,
      jsonlPath: null,
      csvPath: null,
      cpuProfilePath: destination,
    }, {
      stdout,
      WebSocketImpl: FakeWebSocket,
      nowMs: () => clock.now,
      wait: async (intervalMs) => {
        clock.now += intervalMs;
      },
    });

    expect(result).toEqual({
      captureTriggered: false,
      cpuProfilePaths: [],
      tracePaths: [],
    });
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('formats numbered part paths while preserving the requested extension', () => {
    expect(formatCpuProfilePartPath('profile.cpuprofile', 1))
      .toBe('profile.part01.cpuprofile');
    expect(formatCpuProfilePartPath('profiles/alpha', 6))
      .toBe('profiles/alpha.part06.cpuprofile');
  });

  it('rejects a missing CDP profile without writing a success-shaped file', async () => {
    const calls = [];
    const client = {
      async call(method) {
        calls.push(method);
        return {};
      },
    };
    const destination = path.join(unitOutputRoot, 'profiles', 'missing.cpuprofile');

    await startCpuProfile(client);
    await expect(stopCpuProfile(client, destination)).rejects.toThrow(/no CPU profile/i);

    expect(calls).toEqual(['Profiler.enable', 'Profiler.start', 'Profiler.stop']);
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up trace listeners when tracing fails to start', async () => {
    const listeners = new Map();
    const client = {
      on(method, listener) {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
      async call() {
        throw new Error('trace unavailable');
      },
    };

    await expect(startTrace(client)).rejects.toThrow('trace unavailable');
    expect(listeners.size).toBe(0);
  });

  it('rejects targets without any supported diagnostic trace category', async () => {
    const client = {
      async call(method) {
        if (method === 'Tracing.getCategories') {
          return { categories: ['unsupported.extra'] };
        }
        return {};
      },
    };

    await expect(startTrace(client)).rejects.toThrow(/no supported diagnostic trace categories/i);
  });

  it('rejects a failed trace end and removes its listeners', async () => {
    const listeners = new Map();
    const client = {
      on(method, listener) {
        listeners.set(method, listener);
        return () => listeners.delete(method);
      },
      async call(method) {
        if (method === 'Tracing.getCategories') {
          return { categories: ['devtools.timeline'] };
        }
        if (method === 'Tracing.end') throw new Error('trace disconnected');
        return {};
      },
    };
    const session = await startTrace(client);

    await expect(stopTrace(
      client,
      session,
      path.join(unitOutputRoot, 'trace.json'),
    )).rejects.toThrow('trace disconnected');
    expect(listeners.size).toBe(0);
  });
});

describe('runMonitor recorder cleanup', () => {
  it('closes opened recorders when renderer setup fails after acquisition', async () => {
    const recorderStreams = [];
    const stdout = new FakeOutput({
      isTTY: true,
      failMessage: 'renderer setup failed',
    });

    await expect(runMonitor({
      url: 'ws://127.0.0.1:9222/devtools/page/test',
      intervalMs: 1000,
      durationMs: null,
      jsonlPath: path.join(unitOutputRoot, 'samples.jsonl'),
      csvPath: path.join(unitOutputRoot, 'samples.csv'),
    }, {
      stdout,
      createWriteStreamImpl: () => {
        const stream = new FakeRecorderStream();
        recorderStreams.push(stream);
        return stream;
      },
    })).rejects.toThrow('renderer setup failed');

    expect(recorderStreams).toHaveLength(2);
    expect(recorderStreams[0].endCalls).toBe(1);
    expect(recorderStreams[1].endCalls).toBe(1);
    expect(recorderStreams[1].writes).toEqual([`${CSV_HEADER}\n`]);
  });
});

describe('main discovery diagnostics', () => {
  it('reports the failed discovery endpoint and actionable fallback diagnostics', async () => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();

    const exitCode = await main([
      '--host', '127.0.0.1',
      '--port', '9222',
      '--target', '/a',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain(
      'CDP discovery failed at http://127.0.0.1:9222/json/list: fetch failed',
    );
    expect(stderr.chunks.join('')).toContain('TV is on, reachable, and the app is open');
  });

  it.each([
    ['ECONNREFUSED', 'connection refused', 'Developer Mode is active'],
    ['EHOSTUNREACH', 'host unreachable', 'same LAN'],
    ['ENETUNREACH', 'network unreachable', 'computer network connection'],
    ['ENOTFOUND', 'host name not found', 'configured TV host name'],
    ['ETIMEDOUT', 'connection timed out', 'firewall'],
    ['ECONNRESET', 'connection reset', 'closed the connection'],
  ])('reports %s discovery failures precisely', async (code, reason, hint) => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();

    const exitCode = await main([
      '--host', '192.0.2.1',
      '--port', '9998',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(reason), { code }),
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain(
      `CDP discovery failed at http://192.0.2.1:9998/json/list: ${reason}`,
    );
    expect(stderr.chunks.join('')).toContain(hint);
  });

  it('preserves discovery failure diagnostics for reachable non-2xx responses', async () => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();

    const exitCode = await main([
      '--host', '127.0.0.1',
      '--port', '9222',
      '--target', '/a',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain('CDP target discovery failed: 503');
    expect(stderr.chunks.join('')).not.toContain('cannot reach CDP endpoint');
  });

  it('resolves the configured TV device IP when neither --host nor --url is given', async () => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();
    const requested = [];

    const exitCode = await main([
      '--app', 'com.example.app',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      resolveDeviceIp: () => '192.0.2.55',
      fetchImpl: async (url) => {
        requested.push(url);
        throw new TypeError('fetch failed');
      },
    });

    expect(exitCode).toBe(1);
    expect(requested[0]).toContain('192.0.2.55:9998');
  });

  it('reports how to repair missing TV device configuration', async () => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();

    const exitCode = await main([
      '--app', 'com.example.app',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      resolveDeviceIp: () => {
        throw new Error('cannot resolve device IP from ares-setup-device');
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain('TV device configuration failed');
    expect(stderr.chunks.join('')).toContain('ares-setup-device -F');
    expect(stderr.chunks.join('')).toContain('TV_DEVICE');
  });

  it('distinguishes a reachable endpoint with no open app page', async () => {
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();

    const exitCode = await main([
      '--host', '192.0.2.1',
      '--port', '9998',
      '--duration', '0.1',
    ], {
      stdout,
      stderr,
      fetchImpl: async () => ({
        ok: true,
        json: async () => [],
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.chunks.join('')).toContain('CDP endpoint is reachable');
    expect(stderr.chunks.join('')).toContain('Open the app on the TV');
  });
});

describe('takeHeapSnapshot abort handling', () => {
  it('drains an in-flight chunk write and skips a queued one without an unhandled rejection, removing the partial file', async () => {
    const outputDir = path.join(unitOutputRoot, 'snapshot-abort');
    await mkdir(outputDir, { recursive: true });
    const destination = path.join(outputDir, 'alpha.heapsnapshot');

    // chunk 1 is small and writes/resolves normally; chunk 2 is large enough
    // to exceed the 1-byte highWaterMark below, so its write is still
    // in-flight (awaiting 'drain') when the snapshot call rejects; chunk 3
    // is queued behind chunk 2 and must never reach a destroyed stream.
    const client = new FakeAbortingSnapshotClient({
      chunks: ['{"snapshot":{}}', 'x'.repeat(1024 * 1024), '"tail-chunk"'],
    });

    const rejections = trackUnhandledRejections();

    await expect(
      takeHeapSnapshot(client, destination, {}, { createWriteStreamImpl: createBackpressuredWriteStream }),
    ).rejects.toThrow('client closed during snapshot');

    await rejections.stop();

    expect(rejections.rejections).toEqual([]);
    expect(client.closeCalls).toBeGreaterThanOrEqual(1);
    await expect(readdir(outputDir)).resolves.toEqual([]);
  });

  it('removes the partial file and rejects cleanly when the client closes before any chunk is queued', async () => {
    const outputDir = path.join(unitOutputRoot, 'snapshot-abort-empty');
    await mkdir(outputDir, { recursive: true });
    const destination = path.join(outputDir, 'alpha.heapsnapshot');

    // No chunks are emitted at all: the CDP call itself is interrupted (e.g.
    // by a signal-driven client.close()) before HeapProfiler ever streams
    // data, so `writes` never leaves its initial resolved state.
    const client = new FakeAbortingSnapshotClient({ chunks: [] });

    const rejections = trackUnhandledRejections();

    await expect(
      takeHeapSnapshot(client, destination, {}, { createWriteStreamImpl: createBackpressuredWriteStream }),
    ).rejects.toThrow('client closed during snapshot');

    await rejections.stop();

    expect(rejections.rejections).toEqual([]);
    await expect(readdir(outputDir)).resolves.toEqual([]);
  });
});

const firstMetrics = [
  { name: 'Timestamp', value: 10 },
  { name: 'TaskDuration', value: 2 },
  { name: 'JSHeapUsedSize', value: 1048576 },
  { name: 'JSHeapTotalSize', value: 2097152 },
  { name: 'Nodes', value: 12 },
  { name: 'JSEventListeners', value: 3 },
  { name: 'Documents', value: 1 },
  { name: 'Frames', value: 1 },
  { name: 'LayoutCount', value: 4 },
  { name: 'RecalcStyleCount', value: 6 },
];

const secondMetrics = [
  { name: 'Timestamp', value: 12 },
  { name: 'TaskDuration', value: 2.5 },
  { name: 'JSHeapUsedSize', value: 1048576 },
  { name: 'JSHeapTotalSize', value: 2097152 },
  { name: 'Nodes', value: 12 },
  { name: 'JSEventListeners', value: 3 },
  { name: 'Documents', value: 1 },
  { name: 'Frames', value: 1 },
  { name: 'LayoutCount', value: 10 },
  { name: 'RecalcStyleCount', value: 8 },
];

describe('parsePerformanceArgs', () => {
  it('applies the default monitor options', () => {
    expect(parsePerformanceArgs([])).toMatchObject({
      host: null,
      port: 9998,
      intervalMs: 1000,
      durationMs: null,
      mode: 'monitor',
    });
  });

  it('maps --app to a legacy-tv-app target selection', () => {
    expect(parsePerformanceArgs(['--app', 'com.example.app'])).toMatchObject({
      target: 'com.example.app',
      targetSelection: 'legacy-tv-app',
    });
  });

  it('parses connection, target, interval, duration, and recording options', () => {
    expect(parsePerformanceArgs([
      '--url', 'http://host/a',
      '--target', 'Alpha',
      '--interval', '0.25',
      '--duration', '2',
      '--jsonl', 'samples.jsonl',
      '--csv', 'samples.csv',
      '--cpu-profile', 'profile.cpuprofile',
      '--trace', 'trace.json',
    ])).toMatchObject({
      url: 'http://host/a',
      target: 'Alpha',
      intervalMs: 250,
      durationMs: 2000,
      jsonlPath: 'samples.jsonl',
      csvPath: 'samples.csv',
      cpuProfilePath: 'profile.cpuprofile',
      tracePath: 'trace.json',
    });
  });

  it('rejects invalid option values and unknown flags', () => {
    expect(() => parsePerformanceArgs(['--interval', '0'])).toThrow(/interval/i);
    expect(() => parsePerformanceArgs(['--duration', '-1'])).toThrow(/duration/i);
    expect(() => parsePerformanceArgs(['--port', 'abc'])).toThrow(/port/i);
    expect(() => parsePerformanceArgs(['--target'])).toThrow(/target/i);
    expect(() => parsePerformanceArgs(['--target', '--bogus'])).toThrow(/target/i);
    expect(() => parsePerformanceArgs(['--cpu-profile', '--bogus'])).toThrow(/cpu-profile/i);
    expect(() => parsePerformanceArgs(['--trace', '--bogus'])).toThrow(/trace/i);
    expect(() => parsePerformanceArgs(['--interval', '--bogus'])).toThrow(/interval/i);
    expect(() => parsePerformanceArgs(['--port', '-1'])).toThrow(/port/i);
    expect(() => parsePerformanceArgs(['--unknown'])).toThrow(/unknown/i);
  });

  it('rejects incompatible heap options', () => {
    expect(() => parsePerformanceArgs(['--gc-before'])).toThrow(/gc-before/i);
    expect(() => parsePerformanceArgs(['--collect-garbage', '--snapshot', 'dump.heapsnapshot']))
      .toThrow(/collect-garbage/i);
    expect(() => parsePerformanceArgs(['--snapshot', 'dump.heapsnapshot', '--duration', '1']))
      .toThrow(/snapshot/i);
    expect(() => parsePerformanceArgs(['--collect-garbage', '--jsonl', 'samples.jsonl']))
      .toThrow(/collect-garbage/i);
    expect(() => parsePerformanceArgs(['--snapshot', 'dump.heapsnapshot', '--cpu-profile', 'profile.cpuprofile']))
      .toThrow(/snapshot/i);
    expect(() => parsePerformanceArgs(['--collect-garbage', '--cpu-profile', 'profile.cpuprofile']))
      .toThrow(/collect-garbage/i);
    expect(() => parsePerformanceArgs(['--snapshot', 'dump.heapsnapshot', '--trace', 'trace.json']))
      .toThrow(/snapshot/i);
  });
});

describe('normalizeMetrics', () => {
  it('normalizes absolute metrics and keeps first-sample rates null', () => {
    const first = normalizeMetrics(firstMetrics, null, new Date('2026-01-01T00:00:00Z'));

    expect(first.observedAt).toBeInstanceOf(Date);
    expect(first.observedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(first.timestamp).toBe(10);
    expect(first.cpuPercent).toBeNull();
    expect(first.layoutsPerSecond).toBeNull();
    expect(first.styleRecalcsPerSecond).toBeNull();
    expect(first.jsHeapUsedBytes).toBe(1048576);
    expect(first.jsHeapTotalBytes).toBe(2097152);
    expect(first.nodes).toBe(12);
    expect(first.eventListeners).toBe(3);
    expect(first.documents).toBe(1);
    expect(first.frames).toBe(1);
  });

  it('derives rates from prior cumulative metrics', () => {
    const first = normalizeMetrics(firstMetrics, null, new Date('2026-01-01T00:00:00Z'));
    const second = normalizeMetrics(secondMetrics, first, new Date('2026-01-01T00:00:02Z'));

    expect(second.cpuPercent).toBe(25);
    expect(second.layoutsPerSecond).toBe(3);
    expect(second.styleRecalcsPerSecond).toBe(1);
  });

  it('suppresses rates when timestamp deltas are zero or negative', () => {
    const first = normalizeMetrics(firstMetrics, null, new Date('2026-01-01T00:00:00Z'));
    const sameTimestamp = normalizeMetrics([
      { name: 'Timestamp', value: 10 },
      { name: 'TaskDuration', value: 2.5 },
      { name: 'LayoutCount', value: 10 },
      { name: 'RecalcStyleCount', value: 8 },
    ], first, new Date('2026-01-01T00:00:01Z'));
    const earlierTimestamp = normalizeMetrics([
      { name: 'Timestamp', value: 9 },
      { name: 'TaskDuration', value: 2.5 },
      { name: 'LayoutCount', value: 10 },
      { name: 'RecalcStyleCount', value: 8 },
    ], first, new Date('2026-01-01T00:00:02Z'));

    expect(sameTimestamp.cpuPercent).toBeNull();
    expect(sameTimestamp.layoutsPerSecond).toBeNull();
    expect(sameTimestamp.styleRecalcsPerSecond).toBeNull();
    expect(earlierTimestamp.cpuPercent).toBeNull();
    expect(earlierTimestamp.layoutsPerSecond).toBeNull();
    expect(earlierTimestamp.styleRecalcsPerSecond).toBeNull();
  });

  it('preserves prior cumulative baselines across sparse samples', () => {
    const first = normalizeMetrics(firstMetrics, null, new Date('2026-01-01T00:00:00Z'));
    const sparse = normalizeMetrics([
      { name: 'Timestamp', value: 12 },
      { name: 'TaskDuration', value: null },
      { name: 'LayoutCount', value: 'NaN' },
    ], first, new Date('2026-01-01T00:00:02Z'));
    const third = normalizeMetrics([
      { name: 'Timestamp', value: 14 },
      { name: 'TaskDuration', value: 3 },
      { name: 'LayoutCount', value: 12 },
      { name: 'RecalcStyleCount', value: 10 },
    ], sparse, new Date('2026-01-01T00:00:04Z'));

    expect(sparse.cpuPercent).toBeNull();
    expect(sparse.layoutsPerSecond).toBeNull();
    expect(sparse.styleRecalcsPerSecond).toBeNull();
    expect(third.cpuPercent).toBe(25);
    expect(third.layoutsPerSecond).toBe(2);
    expect(third.styleRecalcsPerSecond).toBe(1);
  });

  it('keeps omitted metrics null', () => {
    const partial = normalizeMetrics([
      { name: 'Timestamp', value: 13 },
    ], null, new Date('2026-01-01T00:00:03Z'));

    expect(partial).toMatchObject({
      jsHeapUsedBytes: null,
      jsHeapTotalBytes: null,
      nodes: null,
      eventListeners: null,
      documents: null,
      frames: null,
      cpuPercent: null,
      layoutsPerSecond: null,
      styleRecalcsPerSecond: null,
    });
  });

  it('treats nullish and nonnumeric metric values as null without zero coercion', () => {
    const first = normalizeMetrics([
      { name: 'Timestamp', value: null },
      { name: 'TaskDuration', value: undefined },
      { name: 'JSHeapUsedSize', value: 'abc' },
      { name: 'Nodes', value: null },
      { name: 'LayoutCount', value: undefined },
      { name: 'RecalcStyleCount', value: 'NaN' },
    ], null, new Date('2026-01-01T00:00:00Z'));

    expect(first).toMatchObject({
      timestamp: null,
      cpuPercent: null,
      jsHeapUsedBytes: null,
      nodes: null,
      layoutsPerSecond: null,
      styleRecalcsPerSecond: null,
    });

    const second = normalizeMetrics([
      { name: 'Timestamp', value: 12 },
      { name: 'TaskDuration', value: 2.5 },
      { name: 'LayoutCount', value: 10 },
      { name: 'RecalcStyleCount', value: 8 },
    ], first, new Date('2026-01-01T00:00:02Z'));

    expect(second.cpuPercent).toBeNull();
    expect(second.layoutsPerSecond).toBeNull();
    expect(second.styleRecalcsPerSecond).toBeNull();
  });
});

describe('serialization', () => {
  it('formats terminal output, JSONL, and CSV in stable field order', () => {
    const sample = normalizeMetrics(firstMetrics, null, new Date('2026-01-01T00:00:00Z'));
    const terminalHeader = formatTerminalHeader();
    const terminalRow = formatTerminalRow(sample);
    const jsonl = serializeJsonl(sample);

    expect(terminalHeader.split('|').map((column) => column.trim())).toEqual([
      'Observed At', 'Timestamp', 'CPU %', 'JS Heap Used', 'JS Heap Total',
      'Nodes', 'Event Listeners', 'Documents', 'Frames', 'Layouts/s', 'Style Recalcs/s',
    ]);
    expect(terminalRow).toContain('N/A');
    expect(terminalRow).toContain('1.0 MiB');
    expect(terminalRow).toContain('2.0 MiB');
    expect(terminalRow.split(' | ')).toHaveLength(11);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(JSON.parse(jsonl)).toEqual({
      observedAt: '2026-01-01T00:00:00.000Z',
      timestamp: 10,
      cpuPercent: null,
      jsHeapUsedBytes: 1048576,
      jsHeapTotalBytes: 2097152,
      nodes: 12,
      eventListeners: 3,
      documents: 1,
      frames: 1,
      layoutsPerSecond: null,
      styleRecalcsPerSecond: null,
    });
    expect(CSV_HEADER).toBe(
      'observedAt,timestamp,cpuPercent,jsHeapUsedBytes,jsHeapTotalBytes,nodes,eventListeners,documents,frames,layoutsPerSecond,styleRecalcsPerSecond',
    );
  });

  it('escapes CSV fields that contain commas or quotes and leaves nulls empty', () => {
    expect(serializeCsvRow({
      observedAt: 'alpha, "beta"',
      timestamp: 10,
      cpuPercent: 25,
      jsHeapUsedBytes: null,
      jsHeapTotalBytes: null,
      nodes: 12,
      eventListeners: 3,
      documents: 1,
      frames: 1,
      layoutsPerSecond: 3,
      styleRecalcsPerSecond: 1,
    })).toBe('"alpha, ""beta""",10,25,,,12,3,1,1,3,1');
  });
});

describe('formatDeviceInfo', () => {
  it('leads with the monitored app and renders device context', () => {
    expect(formatDeviceInfo({
      cores: 4,
      deviceMemoryGb: 2,
      gpu: 'Mali-G52',
      jsHeapLimit: 468 * 1048576,
    }, 'com.example.app')).toBe(
      'App: com.example.app | CPU: 4 cores | RAM: ~2GB | GPU: Mali-G52 | JS heap limit: 468.0 MiB',
    );
  });

  it('omits the app segment when no app is given', () => {
    expect(formatDeviceInfo({
      cores: 4,
      deviceMemoryGb: 2,
      gpu: 'Mali-G52',
      jsHeapLimit: 468 * 1048576,
    })).toBe('CPU: 4 cores | RAM: ~2GB | GPU: Mali-G52 | JS heap limit: 468.0 MiB');
  });

  it('omits the gpu segment and marks missing fields when unavailable', () => {
    expect(formatDeviceInfo({
      cores: null,
      deviceMemoryGb: null,
      gpu: null,
      jsHeapLimit: null,
    })).toBe('CPU: N/A cores | RAM: N/A | JS heap limit: N/A');
  });

  it('shows the app alone when device info is unavailable', () => {
    expect(formatDeviceInfo(null, 'com.example.app')).toBe('App: com.example.app');
  });

  it('returns an empty banner when neither app nor info is available', () => {
    expect(formatDeviceInfo(null)).toBe('');
    expect(formatDeviceInfo(null, null)).toBe('');
  });
});

describe('formatMonitorTarget', () => {
  it('prefers description, then title, then url', () => {
    expect(formatMonitorTarget({ description: 'com.example.app', title: 'Alpha', url: 'http://host/a' }))
      .toBe('com.example.app');
    expect(formatMonitorTarget({ description: '', title: 'Alpha', url: 'http://host/a' })).toBe('Alpha');
    expect(formatMonitorTarget({ description: '', title: '', url: 'http://host/a' })).toBe('http://host/a');
  });

  it('returns null when there is no target', () => {
    expect(formatMonitorTarget(null)).toBeNull();
  });
});
