// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StallWatchdog, type StallProbe } from './stall-watchdog';

// A scriptable probe: each call returns the next state, repeating the last one
// once the script is exhausted (a stream that stays in its final state).
function scriptedProbe(states: StallProbe[]): () => StallProbe {
  let i = 0;
  return () => states[Math.min(i++, states.length - 1)];
}

const playing = (t: number, readyState = 4): StallProbe =>
  ({ currentTime: t, readyState, networkState: 2, paused: false, seeking: false });
const frozen = (t: number, readyState = 1): StallProbe =>
  ({ currentTime: t, readyState, networkState: 2, paused: false, seeking: false });

const OPTS = { pollMs: 1000, freezeTicks: 3, maxReloads: 2 };

let onReload: ReturnType<typeof vi.fn>;
let onEscalate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  onReload = vi.fn();
  onEscalate = vi.fn();
});
afterEach(() => { vi.useRealTimers(); });

function run(probe: () => StallProbe, ticks: number): StallWatchdog {
  const wd = new StallWatchdog({ probe, onReload, onEscalate, ...OPTS });
  wd.start();
  vi.advanceTimersByTime(OPTS.pollMs * ticks);
  return wd;
}

describe('StallWatchdog', () => {
  it('does nothing while currentTime keeps advancing', () => {
    run(scriptedProbe([playing(1), playing(2), playing(3), playing(4), playing(5)]), 5);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('reloads once after freezeTicks frozen ticks, no escalate', () => {
    // advance once to baseline, then freeze at 5
    run(scriptedProbe([playing(5), frozen(5), frozen(5), frozen(5)]), 4);
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('refills the reload budget after recovery', () => {
    const wd = new StallWatchdog({
      probe: scriptedProbe([
        playing(5), frozen(5), frozen(5), frozen(5),  // -> reload #1 (reloadCount=1)
        playing(0, 4), playing(1), playing(2),         // recovered: time advances from reset baseline
        frozen(2, 1), frozen(2, 1), frozen(2, 1),      // freezes again -> should reload, NOT escalate
      ]),
      onReload, onEscalate, ...OPTS,
    });
    wd.start();
    vi.advanceTimersByTime(OPTS.pollMs * 10);
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('escalates after maxReloads, then stops polling', () => {
    // Dead stream: probe stays frozen forever (onReload is a no-op spy).
    run(scriptedProbe([playing(5), frozen(5)]), 20);
    expect(onReload).toHaveBeenCalledTimes(OPTS.maxReloads);
    expect(onEscalate).toHaveBeenCalledTimes(1);
    onReload.mockClear();
    onEscalate.mockClear();
    vi.advanceTimersByTime(OPTS.pollMs * 20); // stopped after escalate
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('treats paused as not-a-stall', () => {
    const paused = { currentTime: 5, readyState: 1, networkState: 2, paused: true, seeking: false };
    run(scriptedProbe([playing(5), paused]), 20);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('treats seeking as not-a-stall', () => {
    const seeking = { currentTime: 5, readyState: 1, networkState: 2, paused: false, seeking: true };
    run(scriptedProbe([playing(5), seeking]), 20);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('does not count a frozen time with high readyState as a stall', () => {
    // time frozen but fully buffered (readyState 4) -> not a stall
    run(scriptedProbe([playing(5), frozen(5, 4)]), 20);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('stop() halts polling', () => {
    const wd = run(scriptedProbe([playing(5), frozen(5)]), 1);
    wd.stop();
    vi.advanceTimersByTime(OPTS.pollMs * 20);
    expect(onReload).not.toHaveBeenCalled();
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('reports the frozen media state and recovery attempt', () => {
    run(scriptedProbe([playing(5), frozen(5), frozen(5), frozen(5)]), 4);
    expect(onReload).toHaveBeenCalledWith({
      probe: frozen(5),
      frozenMs: 3000,
      reloadCount: 1,
      maxReloads: 2,
    });
  });

  it('keeps a restarting onEscalate\'s watchdog alive (escalation must not kill the next channel)', () => {
    // Production wiring: onEscalate -> channelUp -> play -> stop()+start(). Model
    // that by having onEscalate restart THIS watchdog and point it at a fresh,
    // also-frozen stream. The restarted timer must survive and detect the freeze.
    let probeState = frozen(5);
    let escalated = 0;
    const reload = vi.fn();
    const wd = new StallWatchdog({
      probe: () => probeState,
      onReload: reload,
      onEscalate: () => {
        escalated++;
        wd.start();             // next channel's fresh watchdog
        probeState = frozen(0); // next channel is frozen from the start
      },
      ...OPTS,
    });
    wd.start();
    vi.advanceTimersByTime(OPTS.pollMs * 11); // channel 1: reload, reload, escalate
    expect(escalated).toBe(1);
    const reloadsAtEscalation = reload.mock.calls.length;
    vi.advanceTimersByTime(OPTS.pollMs * 5);  // channel 2 freeze must be detected
    expect(reload.mock.calls.length).toBeGreaterThan(reloadsAtEscalation);
    expect(escalated).toBe(1);
  });
});
