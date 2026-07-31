// Detects a silently frozen native stream (currentTime stuck, no `error` event)
// and recovers it: reload in place, escalate to the next channel after
// `maxReloads` failures. DOM-free — the <video> element is injected via `probe`.

export interface StallProbe {
  currentTime: number;
  readyState: number; // HTMLMediaElement.readyState
  networkState: number; // HTMLMediaElement.networkState
  paused: boolean;
  seeking: boolean;
}

export interface StallRecovery {
  probe: StallProbe;
  frozenMs: number;
  reloadCount: number;
  maxReloads: number;
}

export interface StallWatchdogOptions {
  probe: () => StallProbe;
  onReload: (recovery: StallRecovery) => void;
  onEscalate: (recovery: StallRecovery) => void;
  pollMs: number;
  freezeTicks: number;
  maxReloads: number;
}

// = HTMLMediaElement.HAVE_FUTURE_DATA (3), inlined because this module is DOM-free
// and unit-tested in the node env where HTMLMediaElement is undefined. readyState
// below it == not enough buffered to play the next frame forward.
const HAVE_FUTURE_DATA = 3;

export class StallWatchdog {
  private readonly probe: () => StallProbe;
  private readonly onReload: (recovery: StallRecovery) => void;
  private readonly onEscalate: (recovery: StallRecovery) => void;
  private readonly pollMs: number;
  private readonly freezeTicks: number;
  private readonly maxReloads: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTime = -1;
  private frozenTicks = 0;
  private reloadCount = 0;

  constructor(opts: StallWatchdogOptions) {
    this.probe = opts.probe;
    this.onReload = opts.onReload;
    this.onEscalate = opts.onEscalate;
    this.pollMs = opts.pollMs;
    this.freezeTicks = opts.freezeTicks;
    this.maxReloads = opts.maxReloads;
  }

  start(): void {
    this.stop();
    this.lastTime = -1;
    this.frozenTicks = 0;
    this.reloadCount = 0;
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frozenTicks = 0;
  }

  private tick(): void {
    const p = this.probe();

    // A paused or scrubbing stream isn't a stall.
    if (p.paused || p.seeking) {
      this.lastTime = p.currentTime;
      this.frozenTicks = 0;
      return;
    }

    // Strictly forward progress == healthy. Refill the reload budget.
    if (p.currentTime > this.lastTime) {
      this.lastTime = p.currentTime;
      this.frozenTicks = 0;
      this.reloadCount = 0;
      return;
    }

    // Not advancing (frozen, or reset to ~0 by an in-place reload). Re-baseline
    // so a post-reload reset isn't misread as progress next tick.
    this.lastTime = p.currentTime;

    // Frozen but fully buffered is a momentary hiccup, not a stall.
    if (p.readyState >= HAVE_FUTURE_DATA) {
      this.frozenTicks = 0;
      return;
    }

    this.frozenTicks++;
    if (this.frozenTicks < this.freezeTicks) return;

    this.frozenTicks = 0;
    const recovery = {
      probe: p,
      frozenMs: this.freezeTicks * this.pollMs,
      reloadCount: this.reloadCount,
      maxReloads: this.maxReloads,
    };
    if (this.reloadCount < this.maxReloads) {
      this.reloadCount++;
      recovery.reloadCount = this.reloadCount;
      this.onReload(recovery);
    } else {
      // onEscalate (channelUp → play) synchronously starts a fresh watchdog for
      // the next channel, so tear down THIS run first — stopping after would
      // clear the timer the escalation just created.
      this.stop();
      this.onEscalate(recovery);
    }
  }
}
