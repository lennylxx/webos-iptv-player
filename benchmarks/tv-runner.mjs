#!/usr/bin/env node
// Node/CDP orchestration for the LG webOS TV benchmark. Connects to the
// already-running, already-installed app over the CDP endpoint used by
// `scripts/tv.sh`, injects the shared fixtures/measurements from
// `benchmark-suite.mjs` via `Runtime.evaluate`, and writes the TV report.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CdpClient,
  resolveCdpWebSocketUrl,
  resolveConfiguredDeviceIp,
} from '../scripts/cdp-client.mjs';
import {
  installBenchmarkFixture,
  installColdLoadFixture,
  buildM3UFixture,
  cleanupBenchmarkFixture,
  measureXMLTVCatalogBenchmark,
  runRawParserBenchmarks,
  runViewReopenCycle,
  installUniqueGroupFixture,
  installM3USearchFixture,
  measureHostedXMLTVPipelineComparison,
  runM3USearchBenchmark,
  assertM3USearchBenchmark,
  assertPointerBenchmark,
  assertStartupHoverBenchmark,
  runGroupBenchmark,
  summarizeRetainedMemory,
  assertRetainedMemory,
  assertXMLTVCatalogBenchmark,
  assertGroupBenchmarkScale,
  runBenchmarkSuites,
  inspectPointerBenchmark,
  measureStartupHoverBenchmark,
  preparePointerBenchmark,
  assertBenchmarkScale,
  assertColdLoadBenchmark,
} from './benchmark-suite.mjs';

const APP_ID = 'com.lennylxx.iptv';
const ACCOUNT_ID = 'benchmark-x1';
const EPG_URL = 'http://host/benchmark-epg';
const BACKUP_KEY = '__tv_benchmark_backup__';
const COLD_PLAYLIST_URL = 'http://host/cold-list.m3u';
const SCALE = Number(process.env.BENCHMARK_SCALE ?? '50000');
const KEY_SAMPLES = Number(process.env.BENCHMARK_KEY_SAMPLES ?? '30');
const QUERY_SAMPLES = Number(process.env.BENCHMARK_QUERY_SAMPLES ?? '5');
const PORT = Number(process.env.TV_CDP_PORT ?? '9998');
const cleanupOnly = process.argv.includes('--cleanup');

for (const [name, value] of [
  ['BENCHMARK_SCALE', SCALE],
  ['BENCHMARK_KEY_SAMPLES', KEY_SAMPLES],
  ['BENCHMARK_QUERY_SAMPLES', QUERY_SAMPLES],
  ['TV_CDP_PORT', PORT],
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

async function connect() {
  const ip = resolveConfiguredDeviceIp();
  const wsUrl = await resolveCdpWebSocketUrl({
    host: ip,
    port: PORT,
    target: APP_ID,
    targetSelection: 'legacy-tv-app',
  });
  return CdpClient.connect(wsUrl);
}

async function evaluate(client, fn, argument) {
  const expression = `(${fn.toString()})(${JSON.stringify(argument)})`;
  const { result, exceptionDetails } = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description
        || exceptionDetails.text
        || 'TV evaluation failed',
    );
  }
  return result.value;
}

async function installParserBundle(client) {
  const parserBundle = await readFile(
    path.join(process.cwd(), 'test-output', 'benchmarks', 'parser-bundle.js'),
    'utf8',
  );
  const parserInstall = await client.call('Runtime.evaluate', {
    expression: parserBundle,
    returnByValue: true,
  });
  if (parserInstall.exceptionDetails) {
    throw new Error(
      parserInstall.exceptionDetails.exception?.description
        || parserInstall.exceptionDetails.text
        || 'Parser benchmark bundle injection failed',
    );
  }
}

async function readDevice(client) {
  return evaluate(client, async () => {
    const info = await new Promise((resolve) => {
      if (!window.webOS || !window.webOS.deviceInfo) {
        resolve({});
        return;
      }
      const timer = setTimeout(() => resolve({}), 2000);
      window.webOS.deviceInfo((value) => {
        clearTimeout(timer);
        resolve(value || {});
      });
    });
    return {
      modelName: info.modelName || '',
      sdkVersion: info.sdkVersion || '',
      screen: `${String(screen.width)}x${String(screen.height)}`,
      userAgent: navigator.userAgent,
    };
  });
}

async function waitForLoad(client, action) {
  await client.call('Page.enable');
  let removeListener = () => {};
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeListener();
      reject(new Error('Timed out waiting for the TV app to reload'));
    }, 30_000);
    removeListener = client.on('Page.loadEventFired', () => {
      clearTimeout(timer);
      removeListener();
      resolve();
    });
  });
  await action();
  await loaded;
}

async function reloadApp(client, selectors = ['#view-channels']) {
  await waitForLoad(client, () => client.call('Page.reload', { ignoreCache: true }));
  await evaluate(client, async (readySelectors) => {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      for (const selector of readySelectors) {
        const element = document.querySelector(selector);
        if (element && !element.classList.contains('hidden')) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${readySelectors.join(' or ')}`);
  }, selectors);
}

async function installFixture(client) {
  return evaluate(client, installBenchmarkFixture, {
    scale: SCALE,
    accountId: ACCOUNT_ID,
    epgUrl: EPG_URL,
    backupKey: BACKUP_KEY,
    directStorage: true,
  });
}

async function cleanupFixture(client) {
  return evaluate(client, cleanupBenchmarkFixture, {
    accountId: ACCOUNT_ID,
    epgUrl: EPG_URL,
    backupKey: BACKUP_KEY,
  });
}

async function runSuites(client) {
  return evaluate(client, runBenchmarkSuites, {
    keySamples: KEY_SAMPLES,
    querySamples: QUERY_SAMPLES,
  });
}

async function runColdLoad(client) {
  const body = Buffer.from(buildM3UFixture(SCALE)).toString('base64');
  await evaluate(client, installColdLoadFixture, {
    accountId: ACCOUNT_ID,
    url: COLD_PLAYLIST_URL,
  });
  await client.call('Fetch.enable', {
    patterns: [{ urlPattern: 'http://host/*', requestStage: 'Request' }],
  });
  const pending = new Set();
  const removeListener = client.on('Fetch.requestPaused', (event) => {
    const operation = event.request.url === COLD_PLAYLIST_URL
      ? client.call('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [{
            name: 'Content-Type',
            value: 'application/vnd.apple.mpegurl',
          }],
          body,
        })
      : client.call('Fetch.continueRequest', { requestId: event.requestId });
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
  });
  try {
    const started = performance.now();
    await reloadApp(client);
    const result = await evaluate(client, () => {
      const totalSize = parseFloat(
        document.querySelector('.channel-list-spacer')?.style.height || '0',
      );
      return {
        rendered: document.querySelectorAll('.channel-item').length,
        channels: Math.round(totalSize / 88),
      };
    });
    return {
      readyMs: Math.round((performance.now() - started) * 10) / 10,
      ...result,
    };
  } finally {
    removeListener();
    await Promise.allSettled([...pending]);
    await client.call('Fetch.disable');
  }
}

function readRendererMemory() {
  try {
    const command =
      `pid=$(ps -ef | grep -- '--app-id=${APP_ID}' | grep -v grep | awk 'NR==1{print $2}'); `
      + "[ -n \"$pid\" ] && grep -E '^(VmRSS|VmHWM):' /proc/$pid/status";
    const output = execFileSync(
      path.join(process.cwd(), 'scripts', 'tv.sh'),
      ['run', command],
      { encoding: 'utf8', timeout: 120_000 },
    );
    const value = (name) => {
      const match = output.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'));
      return match ? Math.round(Number(match[1]) / 1024 * 10) / 10 : null;
    };
    return { rssMiB: value('VmRSS'), highWaterMiB: value('VmHWM') };
  } catch {
    return { rssMiB: null, highWaterMiB: null };
  }
}

async function verifyInstalledBuild(client) {
  const installed = await evaluate(client, async () => {
    const appInfoResponse = await fetch(`appinfo.json?benchmark=${String(Date.now())}`);
    if (!appInfoResponse.ok) throw new Error('Cannot read installed appinfo.json');
    const appInfo = await appInfoResponse.json();
    const bundleResponse = await fetch(`js/app.js?benchmark=${String(Date.now())}`);
    if (!bundleResponse.ok) throw new Error('Cannot read installed js/app.js');
    const digest = await crypto.subtle.digest('SHA-256', await bundleResponse.arrayBuffer());
    const bundleSha256 = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return {
      version: String(appInfo.version || ''),
      bundleSha256,
    };
  });
  const packageJson = JSON.parse(await readFile(
    path.join(process.cwd(), 'package.json'),
    'utf8',
  ));
  const localBundle = await readFile(
    path.join(process.cwd(), 'dist', 'js', 'app.js'),
  );
  const localBundleSha256 = createHash('sha256').update(localBundle).digest('hex');
  if (installed.version !== packageJson.version) {
    throw new Error(
      `Installed app version ${installed.version} does not match local ${packageJson.version}`,
    );
  }
  if (installed.bundleSha256 !== localBundleSha256) {
    throw new Error(
      'Installed app bundle does not match dist/js/app.js. Reinstall before benchmarking.',
    );
  }
  return {
    appVersion: installed.version,
    bundleSha256: installed.bundleSha256,
  };
}

async function runTvBenchmark() {
  let client = await connect();
  if (cleanupOnly) {
    const cleanup = await cleanupFixture(client);
    await reloadApp(client, ['#view-channels', '#view-settings']);
    console.log(JSON.stringify(cleanup, null, 2));
    client.close();
    return;
  }
  let fixtureAttempted = false;
  try {
    const build = await verifyInstalledBuild(client);
    fixtureAttempted = true;
    const fixtureStarted = Date.now();
    await installFixture(client);
    const fixtureSetupMs = Date.now() - fixtureStarted;
    const startupStarted = Date.now();
    await reloadApp(client);
    const startupReadyMs = Date.now() - startupStarted;
    const startupHover = await evaluate(client, measureStartupHoverBenchmark);
    assertStartupHoverBenchmark(startupHover);
    await installParserBundle(client);
    const parsers = await evaluate(client, runRawParserBenchmarks, { scale: SCALE });
    await client.call('HeapProfiler.collectGarbage');
    const suites = await runSuites(client);
    suites.parsers = parsers;
    const pointer = await evaluate(client, preparePointerBenchmark);
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pointer.x,
      y: pointer.y,
    });
    await client.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pointer.x,
      y: pointer.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await client.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pointer.x,
      y: pointer.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    const pointerReport = await evaluate(client, inspectPointerBenchmark);
    assertPointerBenchmark(pointerReport, SCALE);
    suites.interactions.magicRemote = pointerReport;
    assertBenchmarkScale(suites, SCALE);
    await client.call('HeapProfiler.collectGarbage');
    const beforeReopen = await client.call('Runtime.getHeapUsage');
    const reopenHeap = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await evaluate(client, runViewReopenCycle);
      await client.call('HeapProfiler.collectGarbage');
      reopenHeap.push((await client.call('Runtime.getHeapUsage')).usedSize);
    }
    const retained = summarizeRetainedMemory(beforeReopen.usedSize, reopenHeap);
    assertRetainedMemory(retained);
    const heap = await client.call('Runtime.getHeapUsage');
    const xmltvPipeline = await measureHostedXMLTVPipelineComparison({
      scale: SCALE,
      deviceIp: resolveConfiguredDeviceIp(),
      appId: APP_ID,
    }, {
      evaluate: (fn, arg) => evaluate(client, fn, arg),
      collectGarbage: () => client.call('HeapProfiler.collectGarbage'),
      memoryUsed: () => client.call('Runtime.getHeapUsage'),
      delay: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    parsers.xmltvPipelineBuffered = xmltvPipeline.buffered;
    parsers.xmltvPipeline = xmltvPipeline.streaming;
    // Runs last of the in-page work: its multi-megabyte feed would otherwise
    // skew the reopen heap samples measured above.
    parsers.xmltvCatalog = await measureXMLTVCatalogBenchmark(SCALE, {
      evaluate: (fn, arg) => evaluate(client, fn, arg),
      collectGarbage: () => client.call('HeapProfiler.collectGarbage'),
      heapUsed: async () => (await client.call('Runtime.getHeapUsage')).usedSize,
    });
    assertXMLTVCatalogBenchmark(parsers.xmltvCatalog);
    await evaluate(client, installM3USearchFixture);
    await reloadApp(client);
    suites.search.m3u = await evaluate(
      client,
      runM3USearchBenchmark,
      { querySamples: QUERY_SAMPLES },
    );
    assertM3USearchBenchmark(suites.search.m3u);
    await evaluate(client, installUniqueGroupFixture, SCALE);
    const groupStartupStarted = Date.now();
    await reloadApp(client);
    const groups = await evaluate(client, runGroupBenchmark, { keySamples: KEY_SAMPLES });
    groups.startupMs = Date.now() - groupStartupStarted;
    assertGroupBenchmarkScale(groups, SCALE);
    suites.groups = groups;
    const coldLoad = await runColdLoad(client);
    assertColdLoadBenchmark(coldLoad, SCALE);
    suites.coldLoad = coldLoad;
    const device = await readDevice(client);
    const report = {
      version: 1,
      target: 'webos-tv',
      generatedAt: new Date().toISOString(),
      scale: SCALE,
      keySamples: KEY_SAMPLES,
      querySamples: QUERY_SAMPLES,
      cpuRate: 'native',
      appVersion: build.appVersion,
      bundleSha256: build.bundleSha256,
      browser: device.userAgent,
      device,
      fixtureSetupMs,
      suites: {
        startup: {
          readyMs: startupReadyMs,
          rendered: suites.channelList.rendered,
          ...startupHover,
        },
        ...suites,
        memory: {
          usedHeapMiB: Math.round(heap.usedSize / 1_048_576 * 10) / 10,
          totalHeapMiB: Math.round(heap.totalSize / 1_048_576 * 10) / 10,
          retained,
          ...readRendererMemory(),
        },
      },
    };
    const outputDir = path.join(process.cwd(), 'test-output', 'benchmarks');
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'tv-latest.json');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`TV benchmark report: ${outputPath}`);
  } finally {
    if (fixtureAttempted) {
      try {
        await cleanupFixture(client);
        await reloadApp(client, ['#view-channels', '#view-settings']);
        const restored = await evaluate(client, async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('iptv');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction('playlist-cache', 'readonly');
          const cached = await new Promise((resolve, reject) => {
            const request = tx.objectStore('playlist-cache').get('combined');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return cached?.data?.channels?.length ?? 0;
        });
        console.log(`Restored TV playlist cache: ${String(restored)} channels`);
      } catch (error) {
        console.error(`Automatic cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
    client.close();
  }
}

runTvBenchmark().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
