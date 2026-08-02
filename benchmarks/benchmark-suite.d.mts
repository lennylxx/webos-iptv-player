export interface BenchmarkFixtureOptions {
  scale: number;
  accountId: string;
  epgUrl: string;
  backupKey: string;
}

export interface BenchmarkRunOptions {
  keySamples: number;
  querySamples: number;
}

export interface RawParserBenchmarkOptions {
  scale: number;
}

export interface ColdLoadFixtureOptions {
  accountId: string;
  url: string;
}

export interface BenchmarkSuites {
  channelList: {
    rendered: number;
  };
  interactions: Record<string, any>;
  search: {
    xtream: Record<string, any>;
    m3u?: Record<string, any>;
  };
  [key: string]: unknown;
}

export function installBenchmarkFixture(
  options: BenchmarkFixtureOptions,
): Promise<{ channels: number }>;

export function buildM3UFixture(scale: number): string;

export function installColdLoadFixture(
  options: ColdLoadFixtureOptions,
): { playlists: number };

export function preparePointerBenchmark(): Promise<{ x: number; y: number }>;

export function inspectPointerBenchmark(): Promise<Record<string, any>>;

export function assertPointerBenchmark(
  report: Record<string, any>,
  scale: number,
): void;

export function cleanupBenchmarkFixture(
  options: Omit<BenchmarkFixtureOptions, 'scale'>,
): Promise<{ restored: boolean }>;

export function runBenchmarkSuites(
  options: BenchmarkRunOptions,
): Promise<BenchmarkSuites>;

export function runRawParserBenchmarks(
  options: RawParserBenchmarkOptions,
): {
  m3u: { durationMs: number; bytes: number; channels: number; groups: number };
  xmltv: { durationMs: number; bytes: number; channels: number; programmes: number };
};

export function runViewReopenCycle(): Promise<{ nodes: number }>;

export function installUniqueGroupFixture(
  scale: number,
): { channels: number; groups: number };

export function installM3USearchFixture(): { playlists: number };

export function runM3USearchBenchmark(
  options: { querySamples: number },
): Promise<Record<string, any>>;

export function assertM3USearchBenchmark(
  report: Record<string, any>,
): void;

export function runGroupBenchmark(
  options: { keySamples: number },
): Promise<Record<string, any>>;

export function summarizeRetainedMemory(
  beforeBytes: number,
  cycleBytes: number[],
): {
  cycles: number;
  beforeMiB: number;
  samplesMiB: number[];
  growthMiB: number;
};

export function assertRetainedMemory(report: {
  samplesMiB: number[];
  growthMiB: number;
}): void;

export function assertGroupBenchmarkScale(
  report: Record<string, any>,
  scale: number,
): void;

export function assertBenchmarkScale(
  report: BenchmarkSuites,
  scale: number,
): void;

export function assertColdLoadBenchmark(
  report: { readyMs: number; rendered: number; channels: number },
  scale: number,
): void;
