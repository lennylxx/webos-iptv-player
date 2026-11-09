import type { CDPSession } from '@playwright/test';

export interface CpuProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; scriptId: string; url: string; lineNumber: number; columnNumber: number };
    hitCount?: number;
    children?: number[];
  }>;
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface WorkerObserver {
  sampleHeap(options?: { collect?: boolean }): Promise<number>;
  stop(): Promise<Array<{ url: string; chunks: CpuProfile[]; cpuMs: number; pausedMs: number }>>;
}

export function observeWorkers(cdp: CDPSession, options: { cpuRate: number }): Promise<WorkerObserver>;

export function chunkCpu(
  profile: CpuProfile,
  pauses: Array<[number, number]>,
): { cpuMs: number; pausedMs: number };

export function mergeProfiles(chunks: CpuProfile[]): CpuProfile | null;

export function workerBusySamples(
  chunks: CpuProfile[],
  navigationStartSeconds: number,
): Array<[number, number]>;

export interface WorkerTaskWork {
  count: number;
  spanMs: number;
  busyMs: number;
  beforeReadyMs: number;
  lastEndMs: number;
}

export function summarizeWorkerWork(input: {
  busy: Array<[number, number]>;
  tasks: Array<[string, number, number, number]>;
  longTasks: Array<[number, number]>;
  readyMs: number;
  endMs: number;
}): {
  beforeReadyMs: number;
  afterReadyMs: number;
  criticalMs: number;
  tasks: Record<string, WorkerTaskWork>;
};
