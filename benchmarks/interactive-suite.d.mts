export type InteractiveFlow =
  | 'm3u'
  | 'm3uWarm'
  | 'xtreamMovies'
  | 'xtreamMoviesWarm'
  | 'searchCold'
  | 'searchSteady';

export const INTERACTIVE_FLOWS: InteractiveFlow[];

export function interactiveBaseFlow(flow: InteractiveFlow): InteractiveFlow;

export interface InteractiveNetwork {
  bytesPerSecond: number;
  rttMs: number;
}

export const INTERACTIVE_NETWORKS: Record<string, InteractiveNetwork>;

export interface InteractiveDevice {
  cpuRate: number;
  idbReadMs: number;
  idbCommitMs: number;
}

export const INTERACTIVE_DEVICES: Record<string, InteractiveDevice>;

export const INTERACTIVE_FSYNC_MS: number;

export function installIdbLatency(config: InteractiveDevice & { fsyncMs: number }): void;

export const INTERACTIVE_DEFAULT_NETWORKS: string[];

export const INTERACTIVE_NEEDLE: string;

export interface InteractiveFixtureOptions {
  liveEntries: number;
  movies: number;
  series: number;
  categories: number;
  m3uChannels: number;
  epgProgrammes: number;
}

export interface InteractiveFixtureSummary extends InteractiveFixtureOptions {
  m3uMiB: number;
  xtreamPlaylistMiB: number;
  epgMiB: number;
  liveStreamsMiB: number;
  vodMiB: number;
  seriesMiB: number;
}

export interface InteractiveServer {
  origin: string;
  stats: {
    requests: number;
    bytes: number;
    byRoute: Record<string, number>;
    timeline: Record<string, Record<string, number>>;
  };
  fixture: InteractiveFixtureSummary;
  setNetwork(network: InteractiveNetwork): void;
  close(): Promise<void>;
}

export function startInteractiveBenchmarkServer(
  options: InteractiveFixtureOptions & {
    deviceIp?: string;
    advertisedHost?: string;
    port?: number;
  },
): Promise<InteractiveServer>;

export function interactivePlaylists(origin: string, flow: InteractiveFlow): unknown[];

export interface InteractiveProbeConfig {
  flow: InteractiveFlow;
  needle: string;
  watchTimeoutMs: number;
  keyIntervalMs: number;
  quietMs: number;
  quietMaxBusyMs: number;
  minSettleMs: number;
  settleTimeoutMs: number;
  /** Measure only when the app shows and answers its first key, then stop. */
  appOnly?: boolean;
}

export function installInteractiveProbe(config: InteractiveProbeConfig): void;

export interface InteractiveProbeRaw {
  done: boolean;
  error: string | null;
  flow: InteractiveFlow;
  phase: 'seed' | 'measure';
  seeded: boolean;
  keyLatencies: number[];
  marks: Record<string, number>;
  events: Record<string, { first: number; last: number; count: number }>;
  gaps: Array<[number, number]>;
  longTasks: Array<[number, number]>;
  longTaskSupported: boolean;
  /** Worker RPC requests as [task, startMs, endMs, ok]. */
  workerTasks: Array<[string, number, number, number]>;
  hits: Record<string, number> | null;
  idb: { reads: number; commits: number } | null;
  /** Null when the run ended away from the Live view. */
  channels: number | null;
  /** Main-thread JS heap, added by the runner. */
  heap?: {
    peakMiB: number;
    retainedMiB: number;
    workerPeakMiB?: number;
    workerRetainedMiB?: number;
    totalPeakMiB?: number;
    totalRetainedMiB?: number;
  };
  /** Worker busy CPU samples as [startMs, durationMs], added by the runner. */
  workerBusy?: Array<[number, number]>;
  workerCpu?: { cpuMs: number; pausedMs: number; rate: number; throttled: boolean };
}

export function readInteractiveProbeStatus(): { done: boolean; error: string | null } | null;

export function readInteractiveProbe(): InteractiveProbeRaw | null;

export function summarizeInteractiveRun(
  raw: InteractiveProbeRaw,
  appRaw?: InteractiveProbeRaw,
): Record<string, any>;

export function aggregateInteractiveRuns(runs: Record<string, any>[]): Record<string, any>;

export function assertInteractiveFlow(
  flow: InteractiveFlow,
  report: Record<string, any>,
  fixture: InteractiveFixtureSummary,
): void;
