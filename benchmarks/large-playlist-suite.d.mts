import type { CDPSession, Page } from '@playwright/test';

export const LARGE_PLAYLIST_CATEGORIES: number;

export interface LargePlaylistCategoryFilter {
  mode: 'include' | 'exclude';
  ids: string[];
}

export function largePlaylistCategoryFilter(): LargePlaylistCategoryFilter;

export function largePlaylistFilteredChannels(
  liveEntries: number,
  filter: LargePlaylistCategoryFilter,
): number;

export interface LargePlaylistBenchmarkOptions {
  totalEntries: number;
  liveEntries: number;
  playlistBytes: number;
  sampleIntervalMs: number;
  chunkBytes: number;
  chunkDelayMs: number;
  accountId: string;
  expectedChannels?: number;
  liveCategories?: LargePlaylistCategoryFilter;
  timeoutMs: number;
  deviceIp?: string;
  advertisedHost?: string;
  port?: number;
}

export interface LargePlaylistBenchmarkIo {
  page: Page;
  browserCdp: CDPSession;
  pageCdp: CDPSession;
  collectGarbage: () => Promise<unknown>;
  delay: (milliseconds: number) => Promise<void>;
}

export interface LargePlaylistMemoryBenchmark {
  totalEntries: number;
  liveEntries: number;
  keptCategories: number;
  playlistBytes: number;
  playlistMiB: number;
  catalogBytes: number;
  catalogMiB: number;
  chunkBytes: number;
  chunkDelayMs: number;
  playlistDurationMs: number;
  readyMs: number;
  channels: number;
  samples: number;
  baselineRendererProcesses: number;
  peakRendererProcesses: number;
  baselineRssMiB: number;
  peakRssMiB: number;
  peakRssDeltaMiB: number;
  retainedRssMiB: number;
  retainedRssDeltaMiB: number;
  baselineHeapMiB: number;
  peakHeapMiB: number;
  peakHeapDeltaMiB: number;
  retainedHeapMiB: number;
  retainedHeapDeltaMiB: number;
}

export function measureLargePlaylistMemory(
  options: LargePlaylistBenchmarkOptions,
  io: LargePlaylistBenchmarkIo,
): Promise<LargePlaylistMemoryBenchmark>;

export function startLargePlaylistBenchmarkServer(
  options: LargePlaylistBenchmarkOptions,
): Promise<{
  origin: string;
  stats: {
    catalogBytes: number;
    playlistDurationMs: number;
  };
  close: () => Promise<void>;
}>;

export function installLargePlaylistSource(playlist: unknown): void;

export function waitForLargePlaylistChannelCount(options: {
  expected: number;
  timeoutMs: number;
}): Promise<void>;

export function readLargePlaylistChannelCount(): number;
