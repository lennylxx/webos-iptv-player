// Observes the page's dedicated workers over CDP: samples their CPU profile,
// reads their heap, and on request throttles their CPU. Chromium applies
// Emulation.setCPUThrottlingRate to pages only (crbug.com/383348380), so a
// worker otherwise runs at full desktop speed beside a 20x slower page.

const SEND_TIMEOUT_MS = 5000;
// Profiles restart this often because the app terminates an idle worker,
// which discards an unstopped profile; only the idle tail is lost.
const PROFILE_CHUNK_MS = 500;
// Each throttle cycle lets the worker run this long, then pauses it for
// (rate - 1) times as long as it ran, as Chromium suspends a throttled page
// thread. Every pause costs the worker CPU of its own, so shorter slots
// inflate it further: 25ms measured about 1.8x, 5ms about 5x.
const THROTTLE_SLOT_MS = 25;
// A pause that lands later than this hit an idle worker.
const IDLE_PAUSE_MS = 3;
// A slot's work before the worker went idle escapes its pause, so each
// profile chunk settles the pause the worker really owed; the balance is
// added to later pauses, up to this many times their own length.
const MAX_CATCH_UP = 1;

export async function observeWorkers(cdp, { cpuRate }) {
  let nextId = 0;
  const pending = new Map();
  const workers = new Map();
  let stopped = false;
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  // Profile times are Chromium monotonic microseconds, which on this host
  // differ from Node's clock by a constant offset.
  await cdp.send('Performance.enable');
  let ticksOffsetUs = 0;
  let bestRoundTrip = Infinity;
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = now();
    const { metrics } = await cdp.send('Performance.getMetrics');
    const after = now();
    const timestamp = metrics.find(metric => metric.name === 'Timestamp')?.value ?? 0;
    if (after - before < bestRoundTrip) {
      bestRoundTrip = after - before;
      ticksOffsetUs = timestamp * 1e6 - (before + after) / 2 * 1000;
    }
  }
  const ticks = ms => ms * 1000 + ticksOffsetUs;

  const send = (worker, method, params = {}) => new Promise((resolve) => {
    if (worker.detached) return resolve(null);
    const id = ++nextId;
    const timer = setTimeout(() => settle(id, null), SEND_TIMEOUT_MS);
    pending.set(id, { resolve, timer, sessionId: worker.sessionId });
    cdp.send('Target.sendMessageToTarget', {
      sessionId: worker.sessionId,
      message: JSON.stringify({ id, method, params }),
    }).catch(() => settle(id, null));
  });
  const settle = (id, message) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(message && !message.error ? message.result : null);
  };

  const armPause = (worker) => {
    clearTimeout(worker.timer);
    worker.timer = setTimeout(() => {
      worker.pauseRequestedAt = now();
      void send(worker, 'Debugger.pause');
    }, THROTTLE_SLOT_MS);
  };
  const onPaused = (worker) => {
    const at = now();
    const late = at - worker.pauseRequestedAt;
    let pauseMs = 0;
    if (late > IDLE_PAUSE_MS) {
      // Idle time pays off what the worker still owed: on a slower CPU
      // that work would have run into the idle gap.
      const paid = Math.min(Math.max(0, worker.owedMs), late);
      worker.owedMs -= paid;
      worker.idlePaidMs += paid;
    } else {
      pauseMs = Math.min(at - worker.resumedAt, THROTTLE_SLOT_MS * 2) * (cpuRate - 1);
      const catchUp = Math.max(-pauseMs, Math.min(worker.owedMs, pauseMs * MAX_CATCH_UP));
      worker.owedMs -= catchUp;
      pauseMs += catchUp;
    }
    const pause = [ticks(at), ticks(at + pauseMs)];
    worker.pauses.push(pause);
    clearTimeout(worker.timer);
    worker.timer = setTimeout(() => {
      pause[1] = ticks(now());
      void send(worker, 'Debugger.resume');
    }, pauseMs);
  };

  // Charges the worker for the CPU a profile chunk shows it really used.
  const settleChunk = (worker, profile) => {
    const { cpuMs, pausedMs } = chunkCpu(profile, worker.pauses);
    worker.cpuMs += cpuMs;
    worker.pausedMs += pausedMs;
    if (cpuRate > 1) worker.owedMs += cpuMs * (cpuRate - 1) - pausedMs;
    worker.pauses = worker.pauses.filter(pause => pause[1] > profile.endTime);
  };

  const rotateProfile = async (worker) => {
    if (worker.detached) return;
    const stoppedProfile = await send(worker, 'Profiler.stop');
    if (stoppedProfile?.profile) {
      worker.chunks.push(stoppedProfile.profile);
      settleChunk(worker, stoppedProfile.profile);
    }
    if (!stopped && !worker.detached) await send(worker, 'Profiler.start');
  };

  const onAttached = async ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') return;
    const worker = {
      sessionId,
      url: targetInfo.url,
      chunks: [],
      detached: false,
      timer: null,
      chunkTimer: null,
      resumedAt: now(),
      pauseRequestedAt: 0,
      pauses: [],
      owedMs: 0,
      idlePaidMs: 0,
      cpuMs: 0,
      pausedMs: 0,
      peakHeap: 0,
    };
    workers.set(sessionId, worker);
    await send(worker, 'Profiler.enable');
    await send(worker, 'Profiler.setSamplingInterval', { interval: 1000 });
    await send(worker, 'Profiler.start');
    if (cpuRate > 1) await send(worker, 'Debugger.enable');
    await send(worker, 'Runtime.runIfWaitingForDebugger');
    if (cpuRate > 1) {
      worker.resumedAt = now();
      armPause(worker);
    }
    worker.chunkTimer = setInterval(() => void rotateProfile(worker), PROFILE_CHUNK_MS);
  };
  const onDetached = ({ sessionId }) => {
    const worker = workers.get(sessionId);
    if (!worker) return;
    worker.detached = true;
    clearTimeout(worker.timer);
    clearInterval(worker.chunkTimer);
    for (const [id, entry] of pending) if (entry.sessionId === sessionId) settle(id, null);
  };
  const onMessage = ({ sessionId, message }) => {
    const parsed = JSON.parse(message);
    if (parsed.id) return settle(parsed.id, parsed);
    const worker = workers.get(sessionId);
    if (!worker || cpuRate <= 1 || stopped) return;
    if (parsed.method === 'Debugger.paused') onPaused(worker);
    else if (parsed.method === 'Debugger.resumed') {
      worker.resumedAt = now();
      armPause(worker);
    }
  };

  cdp.on('Target.attachedToTarget', onAttached);
  cdp.on('Target.detachedFromTarget', onDetached);
  cdp.on('Target.receivedMessageFromTarget', onMessage);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });

  return {
    // Sums the heap of every live worker, as the TV holds them all at once.
    // With `collect`, each worker collects garbage first, so the sum is what
    // the workers retain.
    async sampleHeap({ collect = false } = {}) {
      let total = 0;
      for (const worker of workers.values()) {
        if (worker.detached) continue;
        if (collect) await send(worker, 'HeapProfiler.collectGarbage');
        const usage = await send(worker, 'Runtime.getHeapUsage');
        if (usage) {
          total += usage.usedSize;
          worker.peakHeap = Math.max(worker.peakHeap, usage.usedSize);
        }
      }
      return total;
    },
    // Stops throttling and profiling and returns each worker's profile.
    async stop() {
      stopped = true;
      const live = Array.from(workers.values());
      for (const worker of live) {
        clearTimeout(worker.timer);
        clearInterval(worker.chunkTimer);
      }
      await Promise.all(live.map(async (worker) => {
        if (worker.detached) return;
        await send(worker, 'Debugger.resume');
        await rotateProfile(worker);
        await send(worker, 'Debugger.disable');
      }));
      // Turning auto-attach off detaches every worker, so it waits for the
      // last profile chunks.
      await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: false })
        .catch(() => {});
      cdp.off('Target.attachedToTarget', onAttached);
      cdp.off('Target.detachedFromTarget', onDetached);
      cdp.off('Target.receivedMessageFromTarget', onMessage);
      return live.map(worker => ({
        url: worker.url,
        chunks: worker.chunks,
        cpuMs: worker.cpuMs,
        pausedMs: worker.pausedMs + worker.idlePaidMs,
      }));
    },
  };
}

// Splits a profile chunk's busy samples into the CPU the worker used and the
// time the throttle held it paused, which the profile charges to the paused
// function. Pauses are [start, end] in profile microseconds.
export function chunkCpu(profile, pauses) {
  const idle = idleNodes(profile);
  let busyUs = 0;
  let time = profile.startTime;
  const times = profile.timeDeltas.map((delta) => (time += delta));
  profile.samples.forEach((sample, index) => {
    if (idle.has(sample)) return;
    const end = index + 1 < times.length ? times[index + 1] : profile.endTime;
    busyUs += Math.max(0, end - times[index]);
  });
  let pausedUs = 0;
  for (const [start, end] of pauses) {
    pausedUs += Math.max(0, Math.min(end, profile.endTime) - Math.max(start, profile.startTime));
  }
  return { cpuMs: Math.max(0, busyUs - pausedUs) / 1000, pausedMs: pausedUs / 1000 };
}

function idleNodes(profile) {
  return new Set(profile.nodes
    .filter(node => node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(root)')
    .map(node => node.id));
}

// Joins a worker's profile chunks into one profile under a shared root.
export function mergeProfiles(chunks) {
  if (!chunks.length) return null;
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 0, children: [] }];
  const samples = [];
  const timeDeltas = [];
  let offset = 1;
  let previous = chunks[0].startTime;
  for (const chunk of chunks) {
    let maxId = 0;
    for (const node of chunk.nodes) {
      maxId = Math.max(maxId, node.id);
      const copy = { ...node, id: node.id + offset };
      if (node.children) copy.children = node.children.map(child => child + offset);
      nodes.push(copy);
    }
    const root = chunk.nodes.find(node => node.callFrame.functionName === '(root)');
    if (root) nodes[0].children.push(root.id + offset);
    let time = chunk.startTime;
    chunk.samples.forEach((sample, index) => {
      time += chunk.timeDeltas[index];
      samples.push(sample + offset);
      timeDeltas.push(time - previous);
      previous = time;
    });
    offset += maxId;
  }
  return {
    nodes,
    startTime: chunks[0].startTime,
    endTime: chunks[chunks.length - 1].endTime,
    samples,
    timeDeltas,
  };
}

// Flattens profile chunks to the busy samples, as [pageMs, durationMs] pairs
// relative to navigation start. Profile times are monotonic microseconds
// on the same clock as the page's NavigationStart metric.
export function workerBusySamples(chunks, navigationStartSeconds) {
  const busy = [];
  const origin = navigationStartSeconds * 1000;
  for (const profile of chunks) {
    const idle = idleNodes(profile);
    let time = profile.startTime;
    const times = profile.timeDeltas.map((delta) => (time += delta));
    profile.samples.forEach((sample, index) => {
      const end = index + 1 < times.length ? times[index + 1] : profile.endTime;
      const duration = (end - times[index]) / 1000;
      if (idle.has(sample) || duration <= 0) return;
      busy.push([Math.round((times[index] / 1000 - origin) * 10) / 10, Math.round(duration * 100) / 100]);
    });
  }
  return busy.sort((a, b) => a[0] - b[0]);
}

// Splits worker CPU around the moment the user could first act, and blames it
// on the RPC tasks in flight. A sample inside several tasks' spans is shared.
export function summarizeWorkerWork({ busy, tasks, longTasks, readyMs, endMs }) {
  const round = value => Math.round(value * 10) / 10;
  let beforeReady = 0;
  let afterReady = 0;
  let critical = 0;
  const byTask = {};
  const entry = name => byTask[name] || (byTask[name] = {
    count: 0, spanMs: 0, busyMs: 0, beforeReadyMs: 0, lastEndMs: 0,
  });
  for (const [name, start, end] of tasks) {
    const task = entry(name);
    task.count++;
    task.spanMs += Math.max(0, Math.min(end, endMs) - start);
    task.lastEndMs = Math.max(task.lastEndMs, end);
  }
  const mainBusy = (time) => longTasks.some(([start, duration]) => time >= start && time < start + duration);
  for (const [time, duration] of busy) {
    if (time >= endMs) break;
    const before = time < readyMs;
    if (before) {
      beforeReady += duration;
      if (!mainBusy(time)) critical += duration;
    } else afterReady += duration;
    const owners = tasks.filter(([, start, end]) => time >= start && time < end);
    const names = owners.length ? owners.map(([name]) => name) : ['(between tasks)'];
    for (const name of names) {
      const task = entry(name);
      task.busyMs += duration / names.length;
      if (before) task.beforeReadyMs += duration / names.length;
    }
  }
  for (const task of Object.values(byTask)) {
    for (const key of Object.keys(task)) task[key] = round(task[key]);
  }
  return {
    beforeReadyMs: round(beforeReady),
    afterReadyMs: round(afterReady),
    criticalMs: round(critical),
    tasks: byTask,
  };
}
