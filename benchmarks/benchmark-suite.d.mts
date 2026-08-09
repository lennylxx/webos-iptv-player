export interface BenchmarkFixtureOptions {
  scale: number;
  accountId: string;
  epgUrl: string;
  backupKey: string;
  directStorage?: boolean;
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

export function rebuildBenchmarkDatabase(): Promise<void>;

export function buildM3UFixture(scale: number): string;

export function installColdLoadFixture(
  options: ColdLoadFixtureOptions,
): { playlists: number };

export interface StartupHoverBenchmark {
  hoverFrameMs: number;
  focusedSynchronously: boolean;
  focusedAtFrame: boolean;
}

export function measureStartupHoverBenchmark(): Promise<StartupHoverBenchmark>;

export function assertStartupHoverBenchmark(report: StartupHoverBenchmark): void;

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
  xmltvCatalog?: XMLTVCatalogBenchmark;
};

export interface XMLTVCatalogPass {
  durationMs: number;
  channels: number;
  programmes: number;
  programmesSeen: number;
  retainedBytes: number;
}

export interface XMLTVCatalogBenchmark {
  bytes: number;
  sourceChannels: number;
  keptChannels: number;
  unfiltered: XMLTVCatalogPass;
  filtered: XMLTVCatalogPass;
  speedup: number;
  retainedHeapReductionPct: number;
}

export interface XMLTVCatalogBenchmarkIo {
  evaluate: (fn: unknown, arg?: unknown) => Promise<never>;
  collectGarbage: () => Promise<unknown>;
  heapUsed: () => Promise<number>;
}

export function assertXMLTVCatalogBenchmark(catalog: XMLTVCatalogBenchmark): void;

export function measureXMLTVCatalogBenchmark(
  scale: number,
  io: XMLTVCatalogBenchmarkIo,
): Promise<XMLTVCatalogBenchmark>;

export function runViewReopenCycle(): Promise<{ nodes: number }>;

export function installUniqueGroupFixture(
  scale: number,
): Promise<{ channels: number; groups: number }>;

export function installM3USearchFixture(): Promise<{ playlists: number }>;

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
