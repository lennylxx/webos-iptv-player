import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tv = process.argv.includes('--tv');
const interactive = process.argv.includes('--interactive');
// BENCHMARK_INTERACTIVE_ONLY=1 writes interactive-latest.json, which is gated
// against, and updates, only the interactive part of baseline.json; the full
// run leaves that part alone.
const latestPrefix = interactive ? 'interactive-' : tv ? 'tv-' : '';
const latestPath = path.join(root, 'test-output', 'benchmarks', `${latestPrefix}latest.json`);
const baselinePath = path.join(root, 'benchmarks', `${tv ? 'tv-' : ''}baseline.json`);
const update = process.argv.includes('--update');
const tolerance = Number(process.env.BENCHMARK_TOLERANCE ?? '0.15');
const absoluteToleranceMs = Number(process.env.BENCHMARK_ABSOLUTE_TOLERANCE_MS ?? '3');
const interactiveAbsoluteToleranceMs = Number(
  process.env.BENCHMARK_INTERACTIVE_ABSOLUTE_TOLERANCE_MS ?? '100',
);
if (!Number.isFinite(tolerance) || tolerance < 0) {
  throw new Error('BENCHMARK_TOLERANCE must be a non-negative number');
}
if (!Number.isFinite(absoluteToleranceMs) || absoluteToleranceMs < 0) {
  throw new Error('BENCHMARK_ABSOLUTE_TOLERANCE_MS must be a non-negative number');
}
if (!Number.isFinite(interactiveAbsoluteToleranceMs) || interactiveAbsoluteToleranceMs < 0) {
  throw new Error('BENCHMARK_INTERACTIVE_ABSOLUTE_TOLERANCE_MS must be a non-negative number');
}

const interactiveMetrics = [
  'm3u.live.interactiveMs',
  'm3u.live.afterReady.keyLatencyP95Ms',
  'm3u.live.afterReady.maxLongTaskMs',
  'm3u.heap.retainedMiB',
  'm3u.work.projectedReadyMs',
  'm3uWarm.live.interactiveMs',
  'm3uWarm.live.afterReady.keyLatencyP95Ms',
  'm3uWarm.live.afterReady.maxLongTaskMs',
  'm3uWarm.heap.retainedMiB',
  'xtreamMovies.live.interactiveMs',
  'xtreamMovies.movies.interactiveMs',
  'xtreamMovies.movies.afterReady.keyLatencyP95Ms',
  'xtreamMovies.movies.afterReady.maxLongTaskMs',
  'xtreamMovies.heap.retainedMiB',
  'xtreamMovies.work.projectedReadyMs',
  'xtreamMoviesWarm.live.interactiveMs',
  'xtreamMoviesWarm.movies.interactiveMs',
  'xtreamMoviesWarm.movies.afterReady.keyLatencyP95Ms',
  'xtreamMoviesWarm.movies.afterReady.maxLongTaskMs',
  'xtreamMoviesWarm.heap.retainedMiB',
  'searchCold.search.inputReadyMs',
  'searchCold.search.firstCandidateMs',
  'searchCold.search.allResultsMs',
  'searchSteady.search.inputReadyMs',
  'searchSteady.search.firstCandidateMs',
  'searchSteady.search.allResultsMs',
  'm3u.idb.reads',
  'm3u.idb.commits',
  'xtreamMovies.idb.reads',
  'xtreamMovies.idb.commits',
  'searchCold.idb.readsPerCatalogRequest',
  'searchCold.idb.commitsPerCatalogRequest',
];
// IndexedDB operation counts are deterministic, so they get a tight floor
// instead of the millisecond allowance.
const countAllowance = 1;
// Retained heap after a forced GC moves by a few MiB between runs.
const heapAllowanceMiB = 8;
const isInteractive = metricPath => metricPath.startsWith('interactive.');
const isCount = metricPath => isInteractive(metricPath) && metricPath.includes('.idb.');
const isHeap = metricPath => isInteractive(metricPath) && metricPath.includes('.heap.');
// Cold launches jitter by tens of milliseconds, so a 3ms floor would be noise.
const allowance = metricPath => {
  if (isCount(metricPath)) return countAllowance;
  if (isHeap(metricPath)) return heapAllowanceMiB;
  return isInteractive(metricPath) ? interactiveAbsoluteToleranceMs : absoluteToleranceMs;
};

const performanceMetricPaths = [
  'startup.hoverFrameMs',
  'startup.settle.maxLongTaskMs',
  'memory.largePlaylist.readyMs',
  'memory.largePlaylistFiltered.readyMs',
  'parsers.derivedIndexes.durationMs',
  'channelList.navigation.p95',
  'channelList.navigation.frame.p95',
  'recentlyWatched.navigation.p95',
  'recentlyWatched.navigation.frame.p95',
  'sidebar.navigation.p95',
  'sidebar.navigation.frame.p95',
  'sidebar.logoReveal.frame.p50',
  'parsers.xmltvCatalog.filtered.durationMs',
  'parsers.xmltvPipeline.durationMs',
  'parsers.xmltvPipeline.maxFrameGapMs',
  'epg.firstFrameMs',
  'epg.maxLongTaskMs',
  'epg.channelList.p95',
  'epg.channelList.frame.p95',
  'epg.programList.p95',
  'epg.programList.frame.p95',
  'movies.navigation.p95',
  'movies.navigation.frame.p95',
  'series.navigation.p95',
  'series.navigation.frame.p95',
  'series.episodes.navigation.p95',
  'series.episodes.navigation.frame.p95',
  'groups.channelList.navigation.p95',
  'groups.channelList.navigation.frame.p95',
  'groups.sidebar.navigation.p95',
  'groups.sidebar.navigation.frame.p95',
  'groups.epg.navigation.p95',
  'groups.epg.navigation.frame.p95',
  'search.xtream.open.p50',
  'search.xtream.indexBuild.maxFrameGapMs',
  'search.xtream.indexBuild.longTaskTotalMs',
  'search.xtream.indexBuild.postMs',
  'search.xtream.indexBuildWarm.maxFrameGapMs',
  'search.xtream.indexBuildWarm.longTaskTotalMs',
  'search.xtream.queries.channelsBroad.p50',
  'search.xtream.queries.channelsSparse.p50',
  'search.xtream.queries.moviesBroad.p50',
  'search.xtream.queries.moviesSparse.p50',
  'search.xtream.queries.programsBroad.p50',
  'search.xtream.queries.programsSparse.p50',
  'search.xtream.queries.noMatch.p50',
  'search.m3u.open.p50',
  'search.m3u.indexBuild.maxFrameGapMs',
  'search.m3u.indexBuild.longTaskTotalMs',
  'search.m3u.indexBuild.postMs',
  'search.m3u.indexBuildWarm.maxFrameGapMs',
  'search.m3u.indexBuildWarm.longTaskTotalMs',
  'search.m3u.queries.channelsBroad.p50',
  'search.m3u.queries.channelsSparse.p50',
  'search.m3u.queries.programsBroad.p50',
  'search.m3u.queries.programsSparse.p50',
  'search.m3u.queries.noMatch.p50',
  'interactions.groupSwitching.p95',
  'parental.live.navigation.p95',
  'parental.live.navigation.frame.p95',
  'parental.live.groupNavigation.p95',
  'parental.live.groupNavigation.frame.p95',
  'parental.live.toggle.handlerMs',
  'parental.vod.open.readyMs',
  'parental.vod.itemsSelect.readyMs',
  'parental.vod.navigation.p95',
  'parental.vod.navigation.frame.p95',
  'parental.vod.groupNavigation.p95',
  'parental.vod.groupNavigation.frame.p95',
  'parental.vod.toggle.handlerMs',
];

function metric(report, metricPath) {
  let value = report.suites;
  for (const part of metricPath.split('.')) value = value?.[part];
  return typeof value === 'number' ? value : null;
}

const latest = JSON.parse(await readFile(latestPath, 'utf8'));
const interactiveMetricPaths = (latest.interactive?.networks ?? []).flatMap((network) =>
  interactiveMetrics.map((metricPath) => `interactive.${network}.${metricPath}.p50`));
const metricPaths = interactive ? interactiveMetricPaths : performanceMetricPaths;
if (update) {
  let report = latest;
  if (interactive) {
    report = JSON.parse(await readFile(baselinePath, 'utf8'));
    report.interactive = latest.interactive;
    report.suites.interactive = latest.suites.interactive;
  } else if (!tv) {
    const previous = JSON.parse(await readFile(baselinePath, 'utf8').catch(() => '{}'));
    if (previous.interactive) {
      report = {
        ...latest,
        interactive: previous.interactive,
        suites: { ...latest.suites, interactive: previous.suites.interactive },
      };
    }
  }
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, baselinePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.target !== latest.target) {
  throw new Error(`Target mismatch: baseline=${baseline.target}, latest=${latest.target}`);
}
// A baseline recorded before the interactive suite existed reports it as new.
if (interactive && baseline.interactive
  && JSON.stringify(baseline.interactive) !== JSON.stringify(latest.interactive)) {
  throw new Error(
    `Interactive configuration mismatch: baseline=${JSON.stringify(baseline.interactive)}, `
      + `latest=${JSON.stringify(latest.interactive)}`,
  );
}
if (!interactive && baseline.scale !== latest.scale) {
  throw new Error(`Benchmark scale mismatch: baseline=${baseline.scale}, latest=${latest.scale}`);
}
if (!interactive && baseline.cpuRate !== latest.cpuRate) {
  throw new Error(`CPU rate mismatch: baseline=${baseline.cpuRate}, latest=${latest.cpuRate}`);
}
const compatibilityFields = interactive
  ? ['version']
  : [
    'version',
    'browser',
    'keySamples',
    'querySamples',
    ...(tv ? ['appVersion', 'device'] : []),
  ];
for (const field of compatibilityFields) {
  if (JSON.stringify(baseline[field]) !== JSON.stringify(latest[field])) {
    throw new Error(
      `Benchmark ${field} mismatch: baseline=${JSON.stringify(baseline[field])}, `
        + `latest=${JSON.stringify(latest[field])}`,
    );
  }
}

let failed = false;
console.log(`Allowed regression: ${(tolerance * 100).toFixed(0)}%`);
console.log(`Minimum absolute allowance: ${absoluteToleranceMs.toFixed(1)}ms`);
if (interactiveMetricPaths.length) {
  console.log(`Minimum interactive allowance: ${interactiveAbsoluteToleranceMs.toFixed(1)}ms`);
}
const width = interactiveMetricPaths.length ? 70 : 40;
console.log('metric'.padEnd(width), 'baseline'.padStart(10), 'latest'.padStart(10), 'change'.padStart(9));
for (const metricPath of metricPaths) {
  const before = metric(baseline, metricPath);
  const after = metric(latest, metricPath);
  // Some metrics exist only in some modes, such as the worker projection.
  if (before === null && after === null) continue;
  if (before === null && after !== null) {
    // A metric added after the baseline was recorded is reported, not gated.
    console.log(metricPath.padEnd(width), 'new'.padStart(10), after.toFixed(1).padStart(10));
    continue;
  }
  if (before === null || after === null) {
    console.error(`Missing metric: ${metricPath}`);
    failed = true;
    continue;
  }
  const change = before === 0 ? 0 : (after - before) / before;
  const allowedIncrease = Math.max(before * tolerance, allowance(metricPath));
  const regression = after - before > allowedIncrease;
  if (regression) failed = true;
  console.log(
    metricPath.padEnd(width),
    before.toFixed(1).padStart(10),
    after.toFixed(1).padStart(10),
    `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`.padStart(9),
    regression ? ' REGRESSION' : '',
  );
}

if (failed) process.exitCode = 1;
