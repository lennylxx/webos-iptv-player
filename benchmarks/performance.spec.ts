import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertGroupBenchmarkScale,
  assertColdLoadBenchmark,
  assertM3USearchBenchmark,
  assertPointerBenchmark,
  assertRetainedMemory,
  assertBenchmarkScale,
  buildM3UFixture,
  cleanupBenchmarkFixture,
  installBenchmarkFixture,
  installColdLoadFixture,
  installM3USearchFixture,
  installUniqueGroupFixture,
  inspectPointerBenchmark,
  preparePointerBenchmark,
  runGroupBenchmark,
  runM3USearchBenchmark,
  runRawParserBenchmarks,
  runBenchmarkSuites,
  runViewReopenCycle,
  summarizeRetainedMemory,
} from './benchmark-suite.mjs';

const SCALE = Number(process.env.BENCHMARK_SCALE ?? '50000');
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const CPU_RATE = Number(process.env.BENCHMARK_CPU_RATE ?? '4');
const FIXTURE = {
  scale: SCALE,
  accountId: 'benchmark-x1',
  epgUrl: 'http://host/benchmark-epg',
  backupKey: '__tv_benchmark_backup__',
};
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';

test('records 50,000-item application benchmarks', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The benchmark uses Chromium heap metrics');
  await page.route('**/benchmark-seed.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Benchmark seed</title>',
  }));
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
  const coldPlaylist = buildM3UFixture(SCALE);
  await page.route('http://host/**', (route) => {
    const url = route.request().url();
    if (url === COLD_PLAYLIST_URL) {
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: coldPlaylist,
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
    const media = HTMLMediaElement.prototype;
    media.load = function () { /* no-op */ };
    media.play = function () { return Promise.resolve(); };
  });
  const cdp = await page.context().newCDPSession(page);
  if (CPU_RATE !== 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
  }

  await page.goto('/benchmark-seed.html');
  const fixtureStarted = Date.now();
  await page.evaluate(installBenchmarkFixture, FIXTURE);
  const fixtureSetupMs = Date.now() - fixtureStarted;

  try {
    const startupStarted = Date.now();
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-item').first()).toBeVisible();
    const startupReadyMs = Date.now() - startupStarted;
    await page.addScriptTag({
      content: await readFile('test-output/benchmarks/parser-bundle.js', 'utf8'),
    });
    const parsers = await page.evaluate(runRawParserBenchmarks, { scale: SCALE });
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
    assertBenchmarkScale(suites, SCALE);

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
    await page.evaluate(installM3USearchFixture);
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    suites.search.m3u = await page.evaluate(
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    await page.evaluate(installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
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
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-item').first()).toBeVisible();
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
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
        },
      },
    };
    const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'latest.json');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Benchmark report: ${outputPath}`);
  } finally {
    await page.goto('/benchmark-seed.html');
    await page.evaluate(cleanupBenchmarkFixture, {
      accountId: FIXTURE.accountId,
      epgUrl: FIXTURE.epgUrl,
      backupKey: FIXTURE.backupKey,
    });
  }
});
