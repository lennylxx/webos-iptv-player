// Detects a stream that never starts. The resource selection algorithm skips a
// <source> whose type the pipeline rejects, and skipping fires no `error` event,
// so nothing else in the player reports it. DOM-free — the <video> element is
// injected via `probe`, like StallWatchdog.

export interface StartupProbe {
  readyState: number; // HTMLMediaElement.readyState
  networkState: number; // HTMLMediaElement.networkState
}

/**
 * `unsupported` — the element gave up on every source it was offered, a
 * terminal verdict available immediately. `timeout` — it is still loading but
 * has produced no frame within the budget, which points at the network or the
 * provider rather than the container.
 */
export type StartupFailure = 'unsupported' | 'timeout';

export interface StartupWatchdogOptions {
  probe: () => StartupProbe;
  onFailure: (failure: StartupFailure, probe: StartupProbe, elapsedMs: number) => void;
  pollMs: number;
  timeoutMs: number;
}

// = HTMLMediaElement.HAVE_CURRENT_DATA (2) and NETWORK_NO_SOURCE (3), inlined
// because this module is unit-tested in the node env where HTMLMediaElement is
// undefined.
const HAVE_CURRENT_DATA = 2;
const NETWORK_NO_SOURCE = 3;

export class StartupWatchdog {
  private readonly probe: () => StartupProbe;
  private readonly onFailure: StartupWatchdogOptions['onFailure'];
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private elapsedMs = 0;

  constructor(opts: StartupWatchdogOptions) {
    this.probe = opts.probe;
    this.onFailure = opts.onFailure;
    this.pollMs = opts.pollMs;
    this.timeoutMs = opts.timeoutMs;
  }

  start(): void {
    this.stop();
    this.elapsedMs = 0;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.elapsedMs = 0;
  }

  private tick(): void {
    const probe = this.probe();
    this.elapsedMs += this.pollMs;

    // Playback produced a frame: nothing here left to watch.
    if (probe.readyState >= HAVE_CURRENT_DATA) {
      this.stop();
      return;
    }
    // A source that was never attached leaves NETWORK_EMPTY, not NO_SOURCE, so
    // this stays quiet until the element has actually rejected something.
    if (probe.networkState === NETWORK_NO_SOURCE) {
      this.report('unsupported', probe);
      return;
    }
    if (this.elapsedMs >= this.timeoutMs) this.report('timeout', probe);
  }

  private report(failure: StartupFailure, probe: StartupProbe): void {
    const elapsedMs = this.elapsedMs;
    this.stop();
    this.onFailure(failure, probe, elapsedMs);
  }
}
