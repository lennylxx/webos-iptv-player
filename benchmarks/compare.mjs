import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tv = process.argv.includes('--tv');
const latestPath = path.join(
  root,
  'test-output',
  'benchmarks',
  tv ? 'tv-latest.json' : 'latest.json',
);
const baselinePath = path.join(
  root,
  'benchmarks',
  tv ? 'tv-baseline.json' : 'baseline.json',
);
const update = process.argv.includes('--update');
const tolerance = Number(process.env.BENCHMARK_TOLERANCE ?? '0.15');
const absoluteToleranceMs = Number(
  process.env.BENCHMARK_ABSOLUTE_TOLERANCE_MS ?? '3',
);
if (!Number.isFinite(tolerance) || tolerance < 0) {
  throw new Error('BENCHMARK_TOLERANCE must be a non-negative number');
}
if (!Number.isFinite(absoluteToleranceMs) || absoluteToleranceMs < 0) {
  throw new Error('BENCHMARK_ABSOLUTE_TOLERANCE_MS must be a non-negative number');
}

const metricPaths = [
  'channelList.navigation.p95',
  'channelList.navigation.frame.p95',
  'recentlyWatched.navigation.p95',
  'recentlyWatched.navigation.frame.p95',
  'sidebar.navigation.p95',
  'sidebar.navigation.frame.p95',
  'sidebar.logoReveal.frame.p50',
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
  'search.xtream.queries.channelsBroad.p50',
  'search.xtream.queries.channelsSparse.p50',
  'search.xtream.queries.moviesBroad.p50',
  'search.xtream.queries.moviesSparse.p50',
  'search.xtream.queries.programsBroad.p50',
  'search.xtream.queries.programsSparse.p50',
  'search.xtream.queries.noMatch.p50',
  'search.m3u.open.p50',
  'search.m3u.queries.channelsBroad.p50',
  'search.m3u.queries.channelsSparse.p50',
  'search.m3u.queries.programsBroad.p50',
  'search.m3u.queries.programsSparse.p50',
  'search.m3u.queries.noMatch.p50',
  'interactions.groupSwitching.p95',
];

function metric(report, metricPath) {
  let value = report.suites;
  for (const part of metricPath.split('.')) value = value?.[part];
  return typeof value === 'number' ? value : null;
}

const latest = JSON.parse(await readFile(latestPath, 'utf8'));
if (update) {
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, baselinePath)}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.scale !== latest.scale) {
  throw new Error(`Benchmark scale mismatch: baseline=${baseline.scale}, latest=${latest.scale}`);
}
if (baseline.target !== latest.target) {
  throw new Error(`Target mismatch: baseline=${baseline.target}, latest=${latest.target}`);
}
if (baseline.cpuRate !== latest.cpuRate) {
  throw new Error(`CPU rate mismatch: baseline=${baseline.cpuRate}, latest=${latest.cpuRate}`);
}
const compatibilityFields = [
  'version',
  'browser',
  'keySamples',
  'querySamples',
  ...(tv ? ['appVersion', 'device'] : []),
];
for (const field of compatibilityFields) {
  if (JSON.stringify(baseline[field]) !== JSON.stringify(latest[field])) {
    throw new Error(
      `Benchmark ${field} mismatch: baseline=${baseline[field]}, latest=${latest[field]}`,
    );
  }
}

let failed = false;
console.log(`Allowed regression: ${(tolerance * 100).toFixed(0)}%`);
console.log(`Minimum absolute allowance: ${absoluteToleranceMs.toFixed(1)}ms`);
console.log('metric'.padEnd(40), 'baseline'.padStart(10), 'latest'.padStart(10), 'change'.padStart(9));
for (const metricPath of metricPaths) {
  const before = metric(baseline, metricPath);
  const after = metric(latest, metricPath);
  if (before === null || after === null) {
    console.error(`Missing metric: ${metricPath}`);
    failed = true;
    continue;
  }
  const change = before === 0 ? 0 : (after - before) / before;
  const allowedIncrease = Math.max(before * tolerance, absoluteToleranceMs);
  const regression = after - before > allowedIncrease;
  if (regression) failed = true;
  console.log(
    metricPath.padEnd(40),
    before.toFixed(1).padStart(10),
    after.toFixed(1).padStart(10),
    `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`.padStart(9),
    regression ? ' REGRESSION' : '',
  );
}

if (failed) process.exitCode = 1;
