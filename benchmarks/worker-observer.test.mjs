import { describe, expect, it } from 'vitest';
import { chunkCpu, mergeProfiles, observeWorkers, summarizeWorkerWork, workerBusySamples } from './worker-observer.mjs';

const frame = functionName => ({ functionName, scriptId: '1', url: '', lineNumber: 0, columnNumber: 0 });
const chunk = (startTime, samples, timeDeltas, endTime) => ({
  nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 3] },
    { id: 2, callFrame: frame('(idle)') },
    { id: 3, callFrame: frame('parse') },
  ],
  startTime,
  endTime,
  samples,
  timeDeltas,
});

describe('worker observer', () => {
  it('keeps busy samples from profile chunks on the page clock', () => {
    // Navigation started at 10 s; chunks are 1 ms samples in microseconds.
    const first = chunk(10_100_000, [3, 2, 3], [0, 1000, 1000], 10_103_000);
    const second = chunk(10_400_000, [3, 3], [0, 1000], 10_402_000);
    const busy = workerBusySamples([first, second], 10);
    // The gap until the next chunk is not charged to a chunk's last sample.
    expect(busy).toEqual([[100, 1], [102, 1], [400, 1], [401, 1]]);
  });

  it('separates the CPU a chunk used from the time the throttle held it paused', () => {
    // Busy from 0 to 10 ms, idle from 10 to 12 ms; paused from 4 to 8 ms
    // and again from 11 ms past the chunk's end.
    const profile = chunk(0, [3, 3, 2], [0, 5000, 5000], 12_000);
    expect(chunkCpu(profile, [[4000, 8000], [11_000, 20_000]])).toEqual({ cpuMs: 5, pausedMs: 5 });
  });

  it('merges profile chunks under one root with continuous sample times', () => {
    const merged = mergeProfiles([
      chunk(1000, [3], [0], 2000),
      chunk(5000, [3, 2], [0, 1000], 7000),
    ]);
    expect(merged.nodes[0].children).toEqual([2, 5]);
    expect(merged.samples).toEqual([4, 7, 6]);
    expect(merged.timeDeltas).toEqual([0, 4000, 1000]);
    expect([merged.startTime, merged.endTime]).toEqual([1000, 7000]);
  });

  it('splits worker CPU at the first interaction and blames tasks in flight', () => {
    const work = summarizeWorkerWork({
      busy: [[10, 20], [40, 20], [70, 20], [150, 10], [300, 10]],
      tasks: [['m3u.load', 0, 100, 1], ['xmltv.load', 30, 200, 1]],
      longTasks: [[35, 30]],
      readyMs: 100,
      endMs: 250,
    });
    expect(work).toEqual({
      beforeReadyMs: 60,
      afterReadyMs: 10,
      // The sample at 40 ms ran while the main thread was busy itself.
      criticalMs: 40,
      tasks: {
        'm3u.load': { count: 1, spanMs: 100, busyMs: 40, beforeReadyMs: 40, lastEndMs: 100 },
        'xmltv.load': { count: 1, spanMs: 170, busyMs: 30, beforeReadyMs: 20, lastEndMs: 200 },
      },
    });
  });

  it('charges work outside every request to the gaps between tasks', () => {
    const work = summarizeWorkerWork({
      busy: [[5, 4]],
      tasks: [['m3u.load', 10, 20, 1]],
      longTasks: [],
      readyMs: 50,
      endMs: 60,
    });
    expect(work.tasks['(between tasks)']).toEqual({
      count: 0, spanMs: 0, busyMs: 4, beforeReadyMs: 4, lastEndMs: 0,
    });
  });

  it('collects the last profile chunk before it detaches from the workers', async () => {
    // Like Chromium, turning auto-attach off detaches every worker session.
    const listeners = new Map();
    const sessions = new Set();
    const emit = (event, params) => { for (const listener of listeners.get(event) ?? []) listener(params); };
    const cdp = {
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      off: (event, listener) => listeners.set(event, (listeners.get(event) ?? []).filter(l => l !== listener)),
      async send(method, params) {
        if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Timestamp', value: 0 }] };
        if (method === 'Target.setAutoAttach' && !params.autoAttach) {
          for (const sessionId of sessions) emit('Target.detachedFromTarget', { sessionId });
          sessions.clear();
        }
        if (method === 'Target.sendMessageToTarget') {
          if (!sessions.has(params.sessionId)) throw new Error('No session');
          const { id, method: inner } = JSON.parse(params.message);
          const result = inner === 'Profiler.stop' ? { profile: chunk(0, [3], [0], 1000) } : {};
          setTimeout(() => emit('Target.receivedMessageFromTarget', {
            sessionId: params.sessionId,
            message: JSON.stringify({ id, result }),
          }));
        }
        return {};
      },
    };
    const observer = await observeWorkers(cdp, { cpuRate: 1 });
    sessions.add('s1');
    emit('Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'worker', url: 'worker.js' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const [worker] = await observer.stop();
    expect(worker.chunks).toHaveLength(1);
    expect(worker.cpuMs).toBe(1);
  });
  it('collects worker garbage before reading the retained heap', async () => {
    const listeners = new Map();
    const emit = (event, params) => { for (const listener of listeners.get(event) ?? []) listener(params); };
    const inner = [];
    let garbage = 5;
    const cdp = {
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      off: () => {},
      async send(method, params) {
        if (method === 'Performance.getMetrics') return { metrics: [{ name: 'Timestamp', value: 0 }] };
        if (method === 'Target.sendMessageToTarget') {
          const { id, method: name } = JSON.parse(params.message);
          inner.push(name);
          if (name === 'HeapProfiler.collectGarbage') garbage = 0;
          const result = name === 'Runtime.getHeapUsage' ? { usedSize: 10 + garbage } : {};
          setTimeout(() => emit('Target.receivedMessageFromTarget', {
            sessionId: params.sessionId,
            message: JSON.stringify({ id, result }),
          }));
        }
        return {};
      },
    };
    const observer = await observeWorkers(cdp, { cpuRate: 1 });
    emit('Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'worker', url: 'worker.js' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await observer.sampleHeap()).toBe(15);
    expect(await observer.sampleHeap({ collect: true })).toBe(10);
    expect(inner.slice(-2)).toEqual(['HeapProfiler.collectGarbage', 'Runtime.getHeapUsage']);
  });
});
