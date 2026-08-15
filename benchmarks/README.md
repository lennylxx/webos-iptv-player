# Performance benchmark

The benchmark exercises the real bundled application in Playwright Chromium
with 50,000 channels, groups, programs, movies, series, categories, and episodes. It
uses IndexedDB and localStorage fixtures so network and fixture generation are
excluded from the measured view operations.
Playwright rebuilds the current database schema and seeds current-format
records directly, so schema upgrades and legacy-data migration are not measured.

## Commands

```bash
npm run benchmark          # write test-output/benchmarks/latest.json
npm run benchmark:check    # run and compare with benchmarks/baseline.json
npm run benchmark:update   # run and intentionally replace the baseline
```

The default run uses four-times CPU throttling to make main-thread regressions
more visible on a development computer. The values can be overridden:

```bash
BENCHMARK_SCALE=50000 \
BENCHMARK_CPU_RATE=4 \
BENCHMARK_KEY_SAMPLES=30 \
BENCHMARK_QUERY_SAMPLES=5 \
npm run benchmark
```

`BENCHMARK_TOLERANCE` controls the comparison allowance and defaults to 15%.
`BENCHMARK_ABSOLUTE_TOLERANCE_MS` defaults to 3ms, preventing tiny navigation
metrics from failing on insignificant scheduler jitter. The larger of the
percentage and absolute allowances is used.
The comparator rejects mismatched scale, CPU rate, browser, schema version, or
sample counts instead of comparing incompatible reports.

## What is measured

| Suite | Metrics |
|---|---|
| Startup | Cached playlist, indexes, and EPG restoration until Channels is visible; hover-to-next-frame latency is regression-gated |
| Cold load | Uncached 50,000-channel M3U fetch, production parse, index build, and first useful render |
| Raw parsing | Production M3U and XMLTV parsers plus the production playlist derived-index builder over generated 50,000-item data, and a provider-shaped guide parsed twice — whole feed vs. programmes pre-filtered to the 15% of channels a playlist keeps while retaining the lightweight XMLTV channel catalog for manual mapping, each bracketed by a forced GC so `parsers.xmltvCatalog` reports both duration and retained heap; `parsers.xmltvPipelineBuffered` and `parsers.xmltvPipeline` fetch the same gzip guide through the legacy buffered and production worker-streaming paths, with end-to-end timing, maximum animation-frame gap, and separate forced-GC CDP page-heap sampling; derived-index duration, production XMLTV duration, and frame gap are regression-gated |
| Channel List | Bounded DOM size and D-pad handler p50/p95/max |
| Recently Watched | Full rendering at the 50-entry product maximum, alternating 88px Live and 100px Catch-up rows |
| Player Sidebar | Open-to-visible latency, bounded DOM size, D-pad handler distribution, channel-search query handler/frame distributions, and a separately measured frame-paced reveal of pre-decoded logos |
| EPG open, search, and mapping | Red-key-to-visible and red-key-to-first-frame latency, the longest Long Task during that transition, channel-search query distributions, and manual mapping query distributions over a 50,000-channel guide |
| EPG Channel List | 50,000 channels, bounded DOM/extent, and navigation distribution under `epg.channelList` |
| EPG Program List | 50,000 programs for one channel, bounded DOM/extent, and navigation distribution under `epg.programList` |
| Groups | Repeated All/large/small switching plus a separate 50,000-unique-group reload covering Channel List, Sidebar, and EPG group navigation |
| Movies | Category load, 50,000-item grid load, DOM size, and navigation |
| Series | Category/grid/detail load, grid navigation, and episode navigation |
| Search | Separate Xtream and M3U-only reloads with program-index construction and broad/sparse/no-match query distributions |
| Interaction transitions | Rapid wheel-to-D-pad handoff, trusted Magic Remote-style pointer activation, connected focus, EPG channel/date changes, and non-empty virtual windows |
| Frame/long tasks | Action-to-next-frame distributions, frames over 50ms, and Long Tasks observed during the suites |
| Stress watchdog | Maximum event-loop heartbeat gap and explicit post-interaction document liveness |
| Memory | Used/total V8 heap plus three post-GC reopen cycles to detect retained growth |

The key distributions record both synchronous main-thread handler time and
action-to-next-frame latency. Search-open remains a synchronous handler
measurement; query distributions run through the production worker and measure
input-to-result-frame latency. Long Task totals provide an independent view of
main-thread stalls across the complete suite.
Structural assertions independently require every virtualized collection to
retain a bounded DOM window and the full scale-derived scroll extent.
Large extents use JavaScript-style digit separators, for example
`"3_600_000px"`, instead of browser-generated scientific notation.

Xtream Search uses broad and no-match query shapes:

- `channel`: broad channel and program matches.
- `movie`: 50,000 movie matches, including ranking and sorting.
- `program`: 50,000 EPG program matches.
- `zzzz-no-match`: full scans with no result rendering.

Each collection also uses a unique synthetic needle query to capture the
sparse-result case independently of broad-result sorting and rendering.

Sidebar channel search, EPG channel search, and EPG mapping each record empty,
broad, sparse, and no-match searches separately. Each result includes
synchronous input-handler time and input-to-result-frame latency so worker
ranking, result delivery, and rendering remain visible.
These auxiliary searches run after the existing view and unified-search samples
so their 50,000-item indexes do not change the workload of older metrics.

This separates fixed full-scan cost from broad-result sorting and DOM work. It
also gives future search indexing or worker implementations stable before/after
measurements. The production parser hook is inert unless the isolated benchmark
runner injects its separate Chrome-68-compatible parser bundle. The shipped app
bundle contains no benchmark API.
The M3U-only reload asserts that Movies and Series are absent, then repeats the
channel, program, and no-match shapes without catalog ranking.

## Baselines

`benchmarks/baseline.json` is the checked-in reference. `benchmark:check`
compares repeated distributions and fails when any is more than 15% slower.
Single-sample startup-ready and view-load timings remain informational because
they are sensitive to IndexedDB and host scheduling. The isolated production
derived-index benchmark is regression-gated because it captures deterministic
main-thread work without instrumenting the shipped app. Startup hover-to-frame
and EPG first-frame/Long-Task timings are also gated because they directly
measure interaction responsiveness. Update the baseline only for an intentional
performance change and review the JSON diff. Increment the report schema version
when metric semantics change.

Sidebar uses p95 for its regression gate. Its channel source is cached between
filter changes, and navigation resolves only selected or currently visible
entries instead of allocating an entry for every channel.

Absolute timings vary by host, Chromium version, and thermal state. Use the
same machine and CPU rate for comparisons, close unrelated heavy processes,
and run a second time when a result is near the tolerance. The automated
benchmark catches regressions early; the LG webOS device remains authoritative
for release validation.

The benchmark starts its own freshly built preview server. It intentionally
does not reuse a process already listening on port 3000, because that could
measure a stale bundle.

## LG webOS runner

Install and cold-start the exact build that should be measured, then run:

```bash
./build.sh --install
npm run benchmark:tv
npm run benchmark:tv:update
npm run benchmark:tv:check
```

The TV runner connects directly to the running app's page through the CDP
endpoint used by `scripts/tv.sh`. It does not use Playwright or desktop CPU
throttling. Results are written to
`test-output/benchmarks/tv-latest.json`, and the independent checked-in
reference is `benchmarks/tv-baseline.json`.

`benchmark-suite.mjs` owns the shared, browser-side fixtures, measurements,
and assertions used by both runners. `performance.spec.ts` supplies Playwright
orchestration for the desktop benchmark, while `tv-runner.mjs` owns Node/CDP
orchestration for the TV benchmark — connecting to the device, reloading the
app, injecting the shared functions via `Runtime.evaluate`, and writing the
report.

The desktop XMLTV pipeline uses Playwright's immediate route fulfillment to
isolate CPU and memory cost. The TV run starts a temporary LAN HTTP server on
the benchmark host and sends the same gzip guide in 16 KiB chunks with 1ms
between chunks, measuring real `ReadableStream` delivery and download/parse
overlap. The server closes automatically after both buffered and streaming
passes. Timing also records the largest animation-frame gap. During the
separate memory pass, one persistent SSH session samples renderer RSS every
10ms; this avoids per-sample SSH connection overhead and reports RSS peak,
average, and delta alongside the CDP heap metrics.

CDP page-heap readings do not include the worker's transient parse heap. The
streaming report marks this explicitly and includes only the cloned result once
it reaches the page. These heap readings and RSS deltas/high-water values remain
informational because run order, process lifetime, and allocator reuse
contaminate them. The comparator gates streaming duration and frame gap instead.

Desktop and TV reports are intentionally incompatible. The TV comparator also
requires the same app version, browser user agent, model, SDK version, scale,
and sample counts.

Before injecting fixtures, the runner stores the entire original localStorage
map in a reserved IndexedDB record. It then clears localStorage and writes an
isolated benchmark state, preventing reminders, favorites, Recently Watched,
Last Channel, or future storage keys from being pruned or overwritten. A
`finally` cleanup clears benchmark state, restores every original key, deletes
only benchmark EPG/catalog records, reloads the app, and reports the restored
channel count. If a run is interrupted, use:

```bash
npm run benchmark:tv:cleanup
```

The runner refuses to start while an interrupted backup record exists, so it
cannot silently overwrite the only restore point. It also records V8 heap and,
when TV SSH access is available, renderer RSS and high-water RSS.

Before changing state, the runner hashes the installed `js/app.js` and checks
its version against `appinfo.json`. Both must match the local `dist/js/app.js`
and `package.json`; otherwise the run stops and requests a reinstall. The
reported local commit therefore identifies the bundle actually measured.
