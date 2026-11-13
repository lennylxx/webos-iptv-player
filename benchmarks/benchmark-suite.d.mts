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

export function waitForPlaylistLoaded(options?: { timeoutMs?: number }): Promise<void>;

export interface StartupSettle {
  settledMs: number;
  maxLongTaskMs: number | null;
  longTaskTotalMs: number | null;
}

export function waitForStartupSettled(
  options?: { quietMs?: number; timeoutMs?: number },
): Promise<StartupSettle>;

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
  derivedIndexes?: DerivedIndexBenchmark;
  xmltv: { durationMs: number; bytes: number; channels: number; programmes: number };
  xmltvCatalog?: XMLTVCatalogBenchmark;
  xmltvPipeline?: XMLTVPipelineBenchmark;
  xmltvPipelineBuffered?: XMLTVPipelineBenchmark;
};

export interface DerivedIndexBenchmark {
  durationMs: number;
  samplesMs: number[];
  channels: number;
  groups: number;
}

export interface DerivedIndexBenchmarkIo {
  evaluate: (fn: unknown, arg?: unknown) => Promise<any>;
  collectGarbage: () => Promise<unknown>;
}

export function measureDerivedIndexBenchmark(
  options: RawParserBenchmarkOptions,
  io: DerivedIndexBenchmarkIo,
): Promise<DerivedIndexBenchmark>;

export interface XMLTVPipelineBenchmark {
  durationMs: number;
  maxFrameGapMs: number;
  memoryScope: string;
  transientParseHeapIncluded: boolean;
  workerTerminatedAfterIdle?: boolean;
  compressedBytes: number;
  uncompressedBytes: number;
  channels: number;
  catalogChannels: number;
  programmes: number;
  programmesSeen: number;
  samples: number;
  startMemoryMiB: number;
  peakMemoryMiB: number;
  averageMemoryMiB: number;
  peakMemoryDeltaMiB: number;
  averageMemoryDeltaMiB: number;
  peakV8HeapMiB: number;
  peakEmbedderHeapMiB: number;
  peakBackingStorageMiB: number;
  rssSamples?: number;
  startRssMiB?: number;
  peakRssMiB?: number;
  averageRssMiB?: number;
  peakRssDeltaMiB?: number;
  rendererHighWaterMiB?: number;
}

export interface XMLTVPipelineBenchmarkOptions {
  url: string;
  compressedBytes: number;
  uncompressedBytes: number;
  channelIds: string[];
  channelNames: string[];
  buffered?: boolean;
}

export interface XMLTVPipelineBenchmarkIo {
  evaluate: (fn: unknown, arg?: unknown) => Promise<any>;
  collectGarbage: () => Promise<unknown>;
  memoryUsed: () => Promise<{
    usedSize: number;
    embedderHeapUsedSize?: number;
    backingStorageSize?: number;
  }>;
  delay: (milliseconds: number) => Promise<void>;
  startProcessMemorySampling?: () => Promise<
    () => Promise<Record<string, number> | null>
  >;
}

export function buildXMLTVPipelineFixture(scale: number): {
  text: string;
  channelIds: string[];
  channelNames: string[];
};

export function measureXMLTVPipelineBenchmark(
  options: XMLTVPipelineBenchmarkOptions,
  io: XMLTVPipelineBenchmarkIo,
): Promise<XMLTVPipelineBenchmark>;

export function measureXMLTVPipelineComparison(
  options: XMLTVPipelineBenchmarkOptions,
  io: XMLTVPipelineBenchmarkIo,
): Promise<{
  buffered: XMLTVPipelineBenchmark;
  streaming: XMLTVPipelineBenchmark;
}>;

export function measureHostedXMLTVPipelineComparison(
  options: {
    scale: number;
    deviceIp: string;
    appId: string;
    chunkBytes?: number;
    chunkDelayMs?: number;
    advertisedHost?: string;
    port?: number;
  },
  io: XMLTVPipelineBenchmarkIo,
): Promise<{
  buffered: XMLTVPipelineBenchmark;
  streaming: XMLTVPipelineBenchmark;
}>;

export function startTvRendererRssSampler(
  appId: string,
  intervalMs?: number,
): Promise<() => Promise<{
  rssSamples: number;
  startRssMiB: number;
  peakRssMiB: number;
  averageRssMiB: number;
  peakRssDeltaMiB: number;
  rendererHighWaterMiB: number;
} | null>>;

export function releaseXMLTVPipelineBenchmark(): void;

export interface XMLTVCatalogPass {
  durationMs: number;
  channels: number;
  catalogChannels: number;
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

export interface BenchmarkAssertOptions {
  /** Warn instead of failing on the known TV-only deviations. */
  tvQuirks?: boolean;
}

export function assertM3USearchBenchmark(
  report: Record<string, any>,
  options?: BenchmarkAssertOptions,
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
  options?: BenchmarkAssertOptions,
): void;

export function assertColdLoadBenchmark(
  report: { readyMs: number; rendered: number; channels: number },
  scale: number,
): void;

export interface ParentalBenchmarkOptions {
  keySamples: number;
}

export function runParentalBenchmark(
  options: ParentalBenchmarkOptions,
): Promise<Record<string, any>>;

export function assertParentalBenchmark(report: Record<string, any>, scale: number): void;

export function clearParentalConfig(): Promise<void>;

export function openParentalControls(options: { pin: string }): Promise<void>;
