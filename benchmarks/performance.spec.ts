import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import {
  assertGroupBenchmarkScale,
  assertColdLoadBenchmark,
  assertM3USearchBenchmark,
  assertParentalBenchmark,
  assertPointerBenchmark,
  assertStartupHoverBenchmark,
  assertRetainedMemory,
  assertXMLTVCatalogBenchmark,
  assertBenchmarkScale,
  buildM3UFixture,
  buildXMLTVPipelineFixture,
  cleanupBenchmarkFixture,
  installBenchmarkFixture,
  installColdLoadFixture,
  installM3USearchFixture,
  installUniqueGroupFixture,
  inspectPointerBenchmark,
  measureDerivedIndexBenchmark,
  measureStartupHoverBenchmark,
  waitForStartupSettled,
  preparePointerBenchmark,
  rebuildBenchmarkDatabase,
  runGroupBenchmark,
  runM3USearchBenchmark,
  runParentalBenchmark,
  measureXMLTVPipelineComparison,
  measureXMLTVCatalogBenchmark,
  runRawParserBenchmarks,
  runBenchmarkSuites,
  runViewReopenCycle,
  summarizeRetainedMemory,
  waitForPlaylistLoaded,
} from './benchmark-suite.mjs';
import {
  largePlaylistCategoryFilter,
  largePlaylistFilteredChannels,
  measureLargePlaylistMemory,
} from './large-playlist-suite.mjs';
import type { LargePlaylistBenchmarkOptions } from './large-playlist-suite.mjs';
import { mergeProfiles, observeWorkers, workerBusySamples } from './worker-observer.mjs';
import {
  listEnv,
  nonNegativeIntegerEnv,
  numberOverride,
  positiveIntegerEnv,
} from './benchmark-shared.mjs';
import {
  INTERACTIVE_DEFAULT_NETWORKS,
  INTERACTIVE_DEVICES,
  INTERACTIVE_FLOWS,
  INTERACTIVE_FSYNC_MS,
  INTERACTIVE_NEEDLE,
  INTERACTIVE_NETWORKS,
  aggregateInteractiveRuns,
  assertInteractiveFlow,
  installIdbLatency,
  installInteractiveProbe,
  interactiveBaseFlow,
  interactivePlaylists,
  readInteractiveProbe,
  readInteractiveProbeStatus,
  startInteractiveBenchmarkServer,
  summarizeInteractiveRun,
} from './interactive-suite.mjs';
import type {
  InteractiveFlow,
  InteractiveProbeConfig,
  InteractiveServer,
} from './interactive-suite.mjs';

const SCALE = Number(process.env.BENCHMARK_SCALE ?? '50000');
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const CPU_RATE = Number(process.env.BENCHMARK_CPU_RATE ?? '4');
const FIXTURE = {
  scale: SCALE,
  accountId: 'benchmark-x1',
  epgUrl: 'http://host/benchmark-epg',
  backupKey: '__tv_benchmark_backup__',
  directStorage: true,
};
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';
const XMLTV_PIPELINE_URL = 'http://host/benchmark-guide.xml.gz';
const PLAYLIST_LOADED = { timeoutMs: 120_000 };
const LARGE_PLAYLIST_ENTRIES = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_ENTRIES',
  400_000,
);
const LARGE_PLAYLIST_LIVE = positiveIntegerEnv(
  'BENCHMARK_LARGE_PLAYLIST_LIVE',
  50_000,
);
const LARGE_PLAYLIST = {
  totalEntries: LARGE_PLAYLIST_ENTRIES,
  liveEntries: LARGE_PLAYLIST_LIVE,
  playlistBytes: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_BYTES',
    128 * 1024 * 1024,
  ),
  sampleIntervalMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_SAMPLE_MS', 25),
  chunkBytes: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_BYTES', 64 * 1024),
  chunkDelayMs: nonNegativeIntegerEnv('BENCHMARK_LARGE_PLAYLIST_CHUNK_DELAY_MS', 0),
  expectedChannels: positiveIntegerEnv(
    'BENCHMARK_LARGE_PLAYLIST_EXPECTED_CHANNELS',
    LARGE_PLAYLIST_LIVE,
  ),
  timeoutMs: positiveIntegerEnv('BENCHMARK_LARGE_PLAYLIST_TIMEOUT_MS', 600_000),
  accountId: 'benchmark-large-playlist',
};
const LARGE_PLAYLIST_FILTER = largePlaylistCategoryFilter();
const LARGE_PLAYLIST_FILTERED = {
  ...LARGE_PLAYLIST,
  liveCategories: LARGE_PLAYLIST_FILTER,
  expectedChannels: largePlaylistFilteredChannels(LARGE_PLAYLIST_LIVE, LARGE_PLAYLIST_FILTER),
};
const LARGE_PLAYLIST_ONLY = process.env.BENCHMARK_LARGE_PLAYLIST_ONLY === '1';
const INTERACTIVE_DEVICE_NAME = process.env.BENCHMARK_INTERACTIVE_DEVICE ?? 'webos4';
if (!(INTERACTIVE_DEVICE_NAME in INTERACTIVE_DEVICES)) {
  throw new Error(`Unknown interactive device ${INTERACTIVE_DEVICE_NAME}`);
}
const INTERACTIVE_DEVICE = {
  ...INTERACTIVE_DEVICES[INTERACTIVE_DEVICE_NAME],
  ...numberOverride('cpuRate', 'BENCHMARK_INTERACTIVE_CPU_RATE'),
  ...numberOverride('idbReadMs', 'BENCHMARK_INTERACTIVE_IDB_READ_MS'),
  ...numberOverride('idbCommitMs', 'BENCHMARK_INTERACTIVE_IDB_COMMIT_MS'),
  fsyncMs: INTERACTIVE_FSYNC_MS,
  ...numberOverride('fsyncMs', 'BENCHMARK_INTERACTIVE_IDB_FSYNC_MS'),
};
const INTERACTIVE_RUNS = positiveIntegerEnv('BENCHMARK_INTERACTIVE_RUNS', 5);
// Chromium cannot throttle a worker, so by default the worker runs at desktop
// speed and its critical-path CPU is projected to the device. Throttling it
// through the debugger instead shows ordering effects but inflates its CPU.
const INTERACTIVE_WORKER_THROTTLE = process.env.BENCHMARK_INTERACTIVE_WORKER_THROTTLE === '1';
const INTERACTIVE_FIXTURE = {
  liveEntries: positiveIntegerEnv('BENCHMARK_INTERACTIVE_LIVE', 50_000),
  movies: positiveIntegerEnv('BENCHMARK_INTERACTIVE_MOVIES', 200_000),
  series: positiveIntegerEnv('BENCHMARK_INTERACTIVE_SERIES', 200_000),
  categories: positiveIntegerEnv('BENCHMARK_INTERACTIVE_CATEGORIES', 5_000),
  m3uChannels: positiveIntegerEnv('BENCHMARK_INTERACTIVE_M3U_CHANNELS', 200_000),
  epgProgrammes: positiveIntegerEnv('BENCHMARK_INTERACTIVE_EPG_PROGRAMMES', 2),
};
const INTERACTIVE_NETWORK_NAMES = listEnv(
  'BENCHMARK_INTERACTIVE_NETWORKS',
  INTERACTIVE_DEFAULT_NETWORKS,
);
for (const network of INTERACTIVE_NETWORK_NAMES) {
  if (!(network in INTERACTIVE_NETWORKS)) throw new Error(`Unknown network ${network}`);
}
const INTERACTIVE_FLOW_NAMES = listEnv(
  'BENCHMARK_INTERACTIVE_FLOWS',
  INTERACTIVE_FLOWS,
) as InteractiveFlow[];
// A directory here makes every interactive run save a main-thread .cpuprofile.
const INTERACTIVE_PROFILE_DIR = process.env.BENCHMARK_INTERACTIVE_PROFILE_DIR;
const INTERACTIVE_RUN_TIMEOUT_MS = positiveIntegerEnv(
  'BENCHMARK_INTERACTIVE_RUN_TIMEOUT_MS',
  600_000,
);
const INTERACTIVE_PROBE: Omit<InteractiveProbeConfig, 'flow'> = {
  needle: INTERACTIVE_NEEDLE,
  watchTimeoutMs: INTERACTIVE_RUN_TIMEOUT_MS,
  keyIntervalMs: 500,
  quietMs: 3_000,
  quietMaxBusyMs: 1_000,
  minSettleMs: 6_000,
  settleTimeoutMs: 180_000,
};
const INTERACTIVE_ONLY = process.env.BENCHMARK_INTERACTIVE_ONLY === '1';

test('records 50,000-item application benchmarks', async ({
  browser,
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The benchmark uses Chromium heap metrics');
  if (LARGE_PLAYLIST_ONLY) {
    const result = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    console.log(`Large playlist benchmark result: ${JSON.stringify(result)}`);
    const filtered = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST_FILTERED);
    console.log(`Filtered large playlist benchmark result: ${JSON.stringify(filtered)}`);
    return;
  }
  // The cold-launch phase takes many minutes at full scale, so it runs only on
  // request.
  if (INTERACTIVE_ONLY) {
    test.setTimeout(0);
    const { config, suite } = await runDesktopInteractiveBenchmark(browser);
    await writeBenchmarkReport('interactive-latest.json', {
      version: 1,
      target: 'desktop-chromium',
      generatedAt: new Date().toISOString(),
      browser: config.browser,
      interactive: config,
      suites: { interactive: suite },
    });
    return;
  }
  await page.route('**/benchmark-seed.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Benchmark seed</title>',
  }));
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
  const coldPlaylist = buildM3UFixture(SCALE);
  const xmltvPipelineFixture = buildXMLTVPipelineFixture(SCALE);
  const compressedXMLTV = gzipSync(Buffer.from(xmltvPipelineFixture.text));
  await page.route('http://host/**', (route) => {
    const url = route.request().url();
    if (url === COLD_PLAYLIST_URL) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: coldPlaylist,
      });
    }
    if (url === XMLTV_PIPELINE_URL) {
      return route.fulfill({
        contentType: 'application/gzip',
        body: compressedXMLTV,
      });
    }
    if (/^\/\d+$/.test(new URL(url).pathname)) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => {
    // Lets the Search samples wait until the app worker has exited.
    const workers = { live: 0 };
    (window as unknown as { __benchmarkAppWorkers: typeof workers }).__benchmarkAppWorkers = workers;
    const log = console.log;
    console.log = function (...args: unknown[]) {
      if (args.indexOf('event=worker.lifecycle.created') !== -1) workers.live++;
      if (args.indexOf('event=worker.lifecycle.terminated') !== -1) {
        workers.live = Math.max(0, workers.live - 1);
      }
      return log.apply(this, args);
    };
    const error = console.error;
    console.error = function (...args: unknown[]) {
      if (args.indexOf('event=worker.lifecycle.failed') !== -1) {
        workers.live = Math.max(0, workers.live - 1);
      }
      return error.apply(this, args);
    };
  });
  await page.addInitScript(() => {
    const media = HTMLMediaElement.prototype;
    media.load = function () { /* no-op */ };
    media.play = function () { return Promise.resolve(); };
  });
  const cdp = await page.context().newCDPSession(page);
  if (CPU_RATE !== 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }

  await page.goto('/benchmark-seed.html');
  await page.evaluate(rebuildBenchmarkDatabase);
  const fixtureStarted = Date.now();
  await page.evaluate(installBenchmarkFixture, FIXTURE);
  const fixtureSetupMs = Date.now() - fixtureStarted;

  try {
    const startupStarted = Date.now();
    await page.goto('/');
    await page.evaluate(waitForPlaylistLoaded, PLAYLIST_LOADED);
    const startupReadyMs = Date.now() - startupStarted;
    const startupSettle = await page.evaluate(waitForStartupSettled, {});
    const startupHover = await page.evaluate(measureStartupHoverBenchmark);
    assertStartupHoverBenchmark(startupHover);
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    const parsers = await page.evaluate(runRawParserBenchmarks, { scale: SCALE });
    await cdp.send('HeapProfiler.collectGarbage');
    const xmltvPipelineOptions = {
      url: XMLTV_PIPELINE_URL,
      compressedBytes: compressedXMLTV.byteLength,
      uncompressedBytes: Buffer.byteLength(xmltvPipelineFixture.text),
      channelIds: xmltvPipelineFixture.channelIds,
      channelNames: xmltvPipelineFixture.channelNames,
    };
    const xmltvPipelineIo = {
      evaluate: (fn: unknown, arg?: unknown) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      memoryUsed: () => cdp.send('Runtime.getHeapUsage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    };
    const xmltvPipeline = await measureXMLTVPipelineComparison(
      xmltvPipelineOptions,
      xmltvPipelineIo,
    );
    parsers.xmltvPipelineBuffered = xmltvPipeline.buffered;
    parsers.xmltvPipeline = xmltvPipeline.streaming;
    await cdp.send('HeapProfiler.collectGarbage');
    const suites = await page.evaluate(runBenchmarkSuites, {
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
    });
    suites.parsers = parsers;
    const pointer = await page.evaluate(preparePointerBenchmark);
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.mouse.up();
    const pointerReport = await page.evaluate(inspectPointerBenchmark);
    assertPointerBenchmark(pointerReport, SCALE);
    suites.interactions.magicRemote = pointerReport;

    await cdp.send('HeapProfiler.collectGarbage');
    const beforeReopen = await cdp.send('Runtime.getHeapUsage');
    const reopenHeap: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(runViewReopenCycle);
      await cdp.send('HeapProfiler.collectGarbage');
      reopenHeap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    }
    const retained = summarizeRetainedMemory(beforeReopen.usedSize, reopenHeap);
    assertRetainedMemory(retained);
    const heap = await cdp.send('Runtime.getHeapUsage');
    // Runs last of the in-page work: its multi-megabyte feed would otherwise
    // skew the reopen heap samples measured above.
    parsers.xmltvCatalog = await measureXMLTVCatalogBenchmark(SCALE, {
      evaluate: (fn, arg) => page.evaluate(fn as never, arg),
      collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      heapUsed: async () => (await cdp.send('Runtime.getHeapUsage')).usedSize,
    });
    assertXMLTVCatalogBenchmark(parsers.xmltvCatalog);
    const parental = await runDesktopParentalBenchmark(page);
    assertParentalBenchmark(parental, SCALE);
    suites.parental = parental;
    await page.evaluate(installM3USearchFixture);
    await page.reload();
    await page.evaluate(waitForPlaylistLoaded, PLAYLIST_LOADED);
    suites.search.m3u = await page.evaluate(
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    await page.evaluate(installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await page.reload();
    await page.evaluate(waitForPlaylistLoaded, PLAYLIST_LOADED);
    const groups = await page.evaluate(runGroupBenchmark, { keySamples: KEY_SAMPLES });
    groups.startupMs = Date.now() - groupStartupStarted;
    assertGroupBenchmarkScale(groups, SCALE);
    suites.groups = groups;
    await page.evaluate(installColdLoadFixture, {
      accountId: FIXTURE.accountId,
      url: COLD_PLAYLIST_URL,
    });
    const coldStarted = performance.now();
    await page.reload();
    await page.evaluate(waitForPlaylistLoaded, PLAYLIST_LOADED);
    const coldResult = await page.evaluate(() => {
      const totalSize = parseFloat(
        document.querySelector<HTMLElement>('.channel-list-spacer')?.style.height || '0',
      );
      return {
        rendered: document.querySelectorAll('.channel-item').length,
        channels: Math.round(totalSize / 88),
      };
    });
    const coldLoad = {
      readyMs: Math.round((performance.now() - coldStarted) * 10) / 10,
      ...coldResult,
    };
    assertColdLoadBenchmark(coldLoad, SCALE);
    suites.coldLoad = coldLoad;
    const largePlaylist = await runDesktopLargePlaylistBenchmark(browser, LARGE_PLAYLIST);
    const largePlaylistFiltered = await runDesktopLargePlaylistBenchmark(
      browser,
      LARGE_PLAYLIST_FILTERED,
    );
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    parsers.derivedIndexes = await measureDerivedIndexBenchmark(
      { scale: SCALE },
      {
        evaluate: (fn, arg) => page.evaluate(fn as never, arg),
        collectGarbage: () => cdp.send('HeapProfiler.collectGarbage'),
      },
    );
    assertBenchmarkScale(suites, SCALE);
    const report = {
      version: 1,
      target: 'desktop-chromium',
      generatedAt: new Date().toISOString(),
      scale: SCALE,
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
      cpuRate: CPU_RATE,
      browser: await page.evaluate(() => navigator.userAgent),
      fixtureSetupMs,
      suites: {
        startup: {
          readyMs: startupReadyMs,
          rendered: suites.channelList.rendered,
          ...startupHover,
          settle: startupSettle,
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
          largePlaylist,
          largePlaylistFiltered,
        },
      },
    };
    await writeBenchmarkReport('latest.json', report);
  } finally {
    await page.goto('/benchmark-seed.html');
    await page.evaluate(cleanupBenchmarkFixture, {
      accountId: FIXTURE.accountId,
      epgUrl: FIXTURE.epgUrl,
      backupKey: FIXTURE.backupKey,
    });
  }
});

// The PIN is set through the UI, and parental controls are turned off again
// afterwards so the later suites run without them. The TV uses runParental
// in tv-runner.mjs, which restores the device's own record.
async function runDesktopParentalBenchmark(page: Page) {
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  const report = await page.evaluate(runParentalBenchmark, { keySamples: KEY_SAMPLES });
  await page.locator('[data-parental-tab="options"]').click();
  const power = page.locator('#view-parental-controls .source-toggle');
  await power.click();
  await expect(power).toHaveAttribute('aria-pressed', 'false');
  await page.locator('[data-parental-back]').click();
  return report;
}

async function runDesktopLargePlaylistBenchmark(
  browser: Browser,
  options: LargePlaylistBenchmarkOptions,
) {
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.PREVIEW_PORT || 3000}`,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const page = await context.newPage();
    const browserCdp = await browser.newBrowserCDPSession();
    const pageCdp = await context.newCDPSession(page);
    return await measureLargePlaylistMemory(options, {
      page,
      browserCdp,
      pageCdp,
      collectGarbage: () => pageCdp.send('HeapProfiler.collectGarbage'),
      delay: (milliseconds: number) =>
        new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    });
  } finally {
    await context.close();
  }
}

async function writeBenchmarkReport(name: string, report: unknown) {
  const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, name);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Benchmark report: ${outputPath}`);
}

// Cold-launch time-to-interactive: each flow starts the app with an empty
// profile against a local Xtream/M3U/XMLTV server at TV CPU and storage speed.
async function runDesktopInteractiveBenchmark(browser: Browser) {
  const server = await startInteractiveBenchmarkServer(INTERACTIVE_FIXTURE);
  console.log(`Interactive fixture: ${JSON.stringify(server.fixture)}`);
  console.log(
    `Interactive device: ${INTERACTIVE_DEVICE_NAME} ${JSON.stringify(INTERACTIVE_DEVICE)}`,
  );
  let userAgent = '';
  try {
    const suite: Record<string, Record<string, unknown>> = {};
    for (const network of INTERACTIVE_NETWORK_NAMES) {
      const flows: Record<string, unknown> = {};
      for (const flow of INTERACTIVE_FLOW_NAMES) {
        const runs = [];
        for (let run = 0; run < INTERACTIVE_RUNS; run++) {
          const label = `${network}-${flow}-${String(run + 1)}`;
          const result = await runInteractiveFlow(browser, server, flow, network, label);
          // The app-only launch below resets the request stats.
          const { byRoute, timeline } = server.stats;
          const app = await runInteractiveFlow(browser, server, flow, network, label, true);
          userAgent = result.userAgent;
          runs.push(withCatalogRequestRates(
            summarizeInteractiveRun(result.raw, app.raw),
            byRoute,
          ));
          console.log(
            `Interactive ${network} ${flow} run ${String(run + 1)}/${String(INTERACTIVE_RUNS)}: `
              + JSON.stringify(runs[runs.length - 1]),
          );
          console.log(`Interactive requests: ${JSON.stringify(byRoute)}`);
          if (INTERACTIVE_PROFILE_DIR) {
            console.log(`Interactive request timeline: ${JSON.stringify(timeline)}`);
          }
        }
        const report = aggregateInteractiveRuns(runs);
        if (!process.env.BENCHMARK_INTERACTIVE_ALLOW_INCOMPLETE) {
          assertInteractiveFlow(flow, report, server.fixture);
        }
        flows[flow] = report;
      }
      suite[network] = flows;
    }
    return {
      config: {
        browser: userAgent,
        device: INTERACTIVE_DEVICE_NAME,
        cpuRate: INTERACTIVE_DEVICE.cpuRate,
        workerThrottle: INTERACTIVE_WORKER_THROTTLE,
        idbLatency: {
          readMs: INTERACTIVE_DEVICE.idbReadMs,
          commitMs: INTERACTIVE_DEVICE.idbCommitMs,
          fsyncMs: INTERACTIVE_DEVICE.fsyncMs,
        },
        runs: INTERACTIVE_RUNS,
        fixture: server.fixture,
        networks: INTERACTIVE_NETWORK_NAMES,
        flows: INTERACTIVE_FLOW_NAMES,
      },
      suite,
    };
  } finally {
    await server.close();
  }
}

// Each run starts from a fresh context with no playlist, catalog, EPG, or
// Search index cache. A Warm flow then launches once at full CPU speed over an
// unthrottled link to fill those caches, and measures the second launch.
async function runInteractiveFlow(
  browser: Browser,
  server: InteractiveServer,
  flow: InteractiveFlow,
  network: string,
  label: string,
  appOnly = false,
) {
  const context = await browser.newContext({
    baseURL: `http://localhost:${process.env.PREVIEW_PORT || 3000}`,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    await context.route('**/benchmark-seed.html', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Benchmark seed</title>',
    }));
    await context.route('http://127.0.0.1:8890/**', route => route.abort());
    const page = await context.newPage();
    await page.goto('/benchmark-seed.html');
    await page.evaluate((playlists) => {
      localStorage.clear();
      localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
    }, interactivePlaylists(server.origin, flow));
    await page.addInitScript(installIdbLatency, INTERACTIVE_DEVICE);
    await page.addInitScript(installInteractiveProbe, { ...INTERACTIVE_PROBE, flow, appOnly });
    await page.addInitScript(() => {
      const media = HTMLMediaElement.prototype;
      media.load = function () { /* no-op */ };
      media.play = function () { return Promise.resolve(); };
    });
    const cdp = await context.newCDPSession(page);
    let sampleWorkerHeap: (() => Promise<number>) | null = null;
    const waitForProbe = async (heap?: { peak: number; workerPeak: number; totalPeak: number }) => {
      const started = Date.now();
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const status = await page.evaluate(readInteractiveProbeStatus);
        if (heap) {
          const { usedSize } = await cdp.send('Runtime.getHeapUsage');
          const workerUsed = sampleWorkerHeap ? await sampleWorkerHeap() : 0;
          heap.peak = Math.max(heap.peak, usedSize);
          heap.workerPeak = Math.max(heap.workerPeak, workerUsed);
          heap.totalPeak = Math.max(heap.totalPeak, usedSize + workerUsed);
        }
        if (status?.done) return (await page.evaluate(readInteractiveProbe))!;
        if (Date.now() - started > INTERACTIVE_RUN_TIMEOUT_MS) {
          const raw = await page.evaluate(readInteractiveProbe);
          throw new Error(`Interactive ${flow} run timed out: ${JSON.stringify(raw?.marks)}`);
        }
      }
    };
    if (interactiveBaseFlow(flow) !== flow) {
      server.setNetwork(INTERACTIVE_NETWORKS.unthrottled);
      await page.goto('/', { waitUntil: 'commit' });
      const seeded = await waitForProbe();
      if (seeded.error) throw new Error(`Interactive ${flow} seed launch failed: ${seeded.error}`);
      if (!seeded.seeded) {
        throw new Error(`Interactive ${flow} seed launch did not settle with its caches written`);
      }
      // Unload the seeded app at full speed, so its teardown and last writes
      // stay out of the measured launch, which then starts from a blank page
      // as a cold flow's does.
      await page.goto('/benchmark-seed.html');
    }
    server.setNetwork(INTERACTIVE_NETWORKS[network]);
    if (INTERACTIVE_DEVICE.cpuRate !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: INTERACTIVE_DEVICE.cpuRate });
    if (INTERACTIVE_PROFILE_DIR) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
      await cdp.send('Profiler.start');
    }
    const workers = await observeWorkers(cdp, {
      cpuRate: INTERACTIVE_WORKER_THROTTLE ? INTERACTIVE_DEVICE.cpuRate : 1,
    });
    sampleWorkerHeap = () => workers.sampleHeap();
    await page.goto('/', { waitUntil: 'commit' });
    const heap = { peak: 0, workerPeak: 0, totalPeak: 0 };
    const raw = await waitForProbe(heap);
    sampleWorkerHeap = null;
    if (appOnly) {
      await workers.stop();
      if (INTERACTIVE_PROFILE_DIR) await cdp.send('Profiler.stop');
      return { raw, userAgent: '' };
    }
    // Taken before the observer detaches; a worker the app already stopped
    // when idle retains nothing.
    const workerRetained = await workers.sampleHeap({ collect: true });
    const workerProfiles = await workers.stop();
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const navigationStart = metrics.find(metric => metric.name === 'NavigationStart')?.value ?? 0;
    raw.workerBusy = workerBusySamples(workerProfiles.flatMap(worker => worker.chunks), navigationStart);
    raw.workerCpu = {
      cpuMs: workerProfiles.reduce((sum, worker) => sum + worker.cpuMs, 0),
      pausedMs: workerProfiles.reduce((sum, worker) => sum + worker.pausedMs, 0),
      rate: INTERACTIVE_DEVICE.cpuRate,
      throttled: INTERACTIVE_WORKER_THROTTLE,
    };
    if (INTERACTIVE_PROFILE_DIR) {
      const { profile } = await cdp.send('Profiler.stop');
      await mkdir(INTERACTIVE_PROFILE_DIR, { recursive: true });
      await writeFile(path.join(INTERACTIVE_PROFILE_DIR, `${label}.cpuprofile`), JSON.stringify(profile));
      for (const [index, worker] of workerProfiles.entries()) {
        const merged = mergeProfiles(worker.chunks);
        if (!merged) continue;
        await writeFile(
          path.join(INTERACTIVE_PROFILE_DIR, `${label}-worker${String(index + 1)}.cpuprofile`),
          JSON.stringify(merged),
        );
      }
    }
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10;
    raw.heap = {
      peakMiB: mib(Math.max(heap.peak, usedSize)),
      retainedMiB: mib(usedSize),
      workerPeakMiB: mib(heap.workerPeak),
      workerRetainedMiB: mib(workerRetained),
      totalPeakMiB: mib(heap.totalPeak),
      totalRetainedMiB: mib(usedSize + workerRetained),
    };
    return { raw, userAgent: await page.evaluate(() => navigator.userAgent) };
  } finally {
    await context.close();
  }
}

// A Search load stops at its time budget, so a faster app fetches more
// categories and does more IndexedDB work; per-request rates stay comparable.
function withCatalogRequestRates(
  run: Record<string, any>,
  byRoute: Record<string, number>,
): Record<string, any> {
  const requests = (byRoute['get_vod_streams&category_id'] ?? 0)
    + (byRoute['get_series&category_id'] ?? 0);
  if (!run.search || !run.idb || !requests) return run;
  const rate = (count: number) => Math.round(count / requests * 100) / 100;
  run.idb.catalogRequests = requests;
  run.idb.readsPerCatalogRequest = rate(run.idb.reads);
  run.idb.commitsPerCatalogRequest = rate(run.idb.commits);
  return run;
}
