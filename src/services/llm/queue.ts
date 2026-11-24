import { LlmError } from './client';
import type { LlmPriority } from './types';

export interface QueueLimits {
  concurrency: number;
}

interface Job {
  priority: LlmPriority;
  // Rejects the job as it would leave the queue, before it takes a slot.
  precheck?: () => Error | null;
  start: () => void;
  cancel: () => void;
  fail: (error: Error) => void;
}

/** Runs requests foreground-first within the endpoint's concurrency, pausing after a 429. */
export class LlmQueue {
  private readonly pending: Job[] = [];
  private active = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private limits: QueueLimits, private readonly now: () => number = Date.now) {}

  setLimits(limits: QueueLimits): void {
    this.limits = limits;
    this.pump();
  }

  /** Holds every job, e.g. after a 429 with Retry-After. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    this.pump();
  }

  /** Fails every queued job of a priority, e.g. background work after a quota error. */
  rejectPending(priority: LlmPriority, error: Error): number {
    const kept: Job[] = [];
    const failed: Job[] = [];
    this.pending.forEach((job) => (job.priority === priority ? failed : kept).push(job));
    this.pending.length = 0;
    kept.forEach((job) => this.pending.push(job));
    failed.forEach((job) => job.fail(error));
    return failed.length;
  }

  get size(): number {
    return this.pending.length + this.active;
  }

  run<T>(
    priority: LlmPriority,
    task: () => Promise<T>,
    signal?: AbortSignal,
    precheck?: () => Error | null,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LlmError('cancelled', 'Request was cancelled'));
        return;
      }
      const onAbort = (): void => job.cancel();
      const job: Job = {
        priority,
        precheck,
        fail: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          task().then(resolve, reject).then(() => {
            this.active--;
            this.pump();
          });
        },
        cancel: () => {
          const at = this.pending.indexOf(job);
          if (at < 0) return;
          this.pending.splice(at, 1);
          reject(new LlmError('cancelled', 'Request was cancelled'));
        },
      };
      signal?.addEventListener('abort', onAbort);
      if (priority === 'foreground') {
        let at = 0;
        while (at < this.pending.length && this.pending[at].priority === 'foreground') at++;
        this.pending.splice(at, 0, job);
      } else {
        this.pending.push(job);
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.length && this.active < Math.max(1, this.limits.concurrency)) {
      const head = this.pending[0];
      const refused = head.precheck ? head.precheck() : null;
      if (refused) {
        this.pending.shift();
        head.fail(refused);
        continue;
      }
      const wait = this.waitMs();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.pending.shift()!.start();
    }
  }

  private waitMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }
}
