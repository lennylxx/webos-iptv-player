// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StartupWatchdog, type StartupProbe } from './startup-watchdog';

function scriptedProbe(states: StartupProbe[]): () => StartupProbe {
  let i = 0;
  return () => states[Math.min(i++, states.length - 1)];
}

const empty: StartupProbe = { readyState: 0, networkState: 0 };
const loading: StartupProbe = { readyState: 0, networkState: 2 };
const noSource: StartupProbe = { readyState: 0, networkState: 3 };
const started: StartupProbe = { readyState: 3, networkState: 1 };

const OPTS = { pollMs: 500, timeoutMs: 5000 };

let onFailure: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  onFailure = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

function run(probe: () => StartupProbe, ms: number): StartupWatchdog {
  const watchdog = new StartupWatchdog({ probe, onFailure, ...OPTS });
  watchdog.start();
  vi.advanceTimersByTime(ms);
  return watchdog;
}

describe('StartupWatchdog', () => {
  it('stays quiet once the stream produces a frame', () => {
    run(scriptedProbe([loading, loading, started]), OPTS.timeoutMs * 2);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports an unsupported source as soon as the element gives up', () => {
    run(scriptedProbe([loading, noSource]), OPTS.pollMs * 2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('unsupported', noSource, 1000);
  });

  it('stays quiet while no source has been attached yet', () => {
    run(scriptedProbe([empty]), OPTS.timeoutMs - OPTS.pollMs);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a timeout when the stream keeps loading without a frame', () => {
    run(scriptedProbe([loading]), OPTS.timeoutMs);
    expect(onFailure).toHaveBeenCalledWith('timeout', loading, OPTS.timeoutMs);
  });

  it('does not report before the timeout elapses', () => {
    run(scriptedProbe([loading]), OPTS.timeoutMs - OPTS.pollMs);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports once and stops polling', () => {
    run(scriptedProbe([noSource]), OPTS.timeoutMs * 3);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('restarts its budget on the next load', () => {
    const watchdog = run(scriptedProbe([loading]), OPTS.timeoutMs - OPTS.pollMs);
    watchdog.start();
    vi.advanceTimersByTime(OPTS.timeoutMs - OPTS.pollMs);
    expect(onFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OPTS.pollMs);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('stops when the player stops', () => {
    const watchdog = run(scriptedProbe([loading]), OPTS.pollMs);
    watchdog.stop();
    vi.advanceTimersByTime(OPTS.timeoutMs * 2);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
