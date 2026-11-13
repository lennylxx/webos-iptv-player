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
more visible on a development computer. The large-playlist memory phase runs
without CPU throttling and is compared only with the matching desktop or TV
baseline. The values can be overridden:

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

The memory phase also streams a synthetic 400,000-entry Xtream playlist with
50,000 Live streams and a 128 MiB `get.php` response. Override its scale for a
quicker run:

```bash
BENCHMARK_LARGE_PLAYLIST_ENTRIES=10000 \
BENCHMARK_LARGE_PLAYLIST_LIVE=1200 \
BENCHMARK_LARGE_PLAYLIST_BYTES=4194304 \
npm run benchmark
```

`BENCHMARK_LARGE_PLAYLIST_CHUNK_DELAY_MS` optionally paces each 64 KiB chunk.
The desktop run uses a separate browser context; the TV runner serves the same
fixture over LAN. The phase then runs again as `memory.largePlaylistFiltered`
with an include Live-category filter keeping 30 of the 605 categories (about
5% of the Live streams). Both `readyMs` values are regression-gated, while
their RSS and heap measurements remain informational because allocator and
process lifetime effects vary between runs.

### Cold-launch time to interactive

The `interactive` phase launches the app with an empty profile against a
local Xtream, M3U, and XMLTV server and measures when the user can first act.
Each run uses a fresh browser context, so nothing is cached unless the flow
is a warm one:

| Flow | Measured |
|---|---|
| `m3u` | A 200,000-channel M3U with EPG until a D-pad key moves focus in Live |
| `xtreamMovies` | An Xtream account until Live, then Movies, answer a key |
| `m3uWarm`, `xtreamMoviesWarm` | The same relaunch after a seed launch filled the caches |
| `searchCold` | Search opened at once: input ready, the first candidate for a typed query, then all results once movies and series are indexed (`allResultsMs`) |
| `searchSteady` | The same after Live is ready |

`live.appVisibleMs` records when the app's own UI (the docked tab bar over
a view) first shows, with or without channel rows; `live.visibleMs` waits
for the first channel row. `live.appInteractiveMs` records when the app
answers its first key, an Up press as soon as the UI shows, and
`live.appKeyLatencyMs` times that press; `live.interactiveMs` presses Down
after the first row. The app metrics come from a second launch of each
run, so the early Up press changes nothing the other metrics time.
Live shows its first channels while the rest of a playlist arrives, so
`live.loadedMs` records when the whole playlist finished loading, which can
come after the first key.

The Xtream fixture holds 50,000 Live streams, 200,000 movies, 200,000 series,
and 5,000 categories per type. Each run also records long tasks, request
counts per route, and IndexedDB read and commit counts.

Each run also reports the Live list's channel count, which must match the
fixture. The app renders only the current view, so a run that ended away
from Live, in Movies or Search, reports the count the playlist load logged
instead, or none if the load had not finished.

Once Live (`m3u`) or Movies (`xtreamMovies`) answers its first key, the
probe keeps pressing Up and Down every `keyIntervalMs` (500 ms) until no
background event has fired for 3 s and the main thread had no idle period
missing for over 1 s in those 3 s, since sliced work such as building the
EPG filter for 200,000 channels runs short tasks back to back and logs
nothing. `afterReady` reports these keys'
latency, each from the moment the key was due to the frame its ring
moved, so a key queued behind a long task counts its wait, plus the long
tasks in that window. Background work the app defers past the first key,
such as the playlist cache write, shows up here. A run that does not go
quiet before the settle timeout fails, since its `afterReady` window would
be cut short. A Search flow fails when it misses a needle, except a movie
or series needle in a run whose catalogs loaded only in part
(`search.partialCatalogs` counts the `xtream.catalog.partial` events).

A warm flow first launches unthrottled in the same browser context and
waits until the background settles and the playlist cache was written;
then it unloads the app to a blank page, still unthrottled, and relaunches
with the device and network profile, measuring only that launch. After every measured launch the runner forces a GC and
records the main-thread heap as `heap.retainedMiB`, with `heap.peakMiB`
sampled every 250 ms; `heap.workerPeakMiB` is the peak sum of the live
Worker heaps, and `heap.workerRetainedMiB` their sum after a forced GC at
the end of the run (0 when the app already terminated an idle Worker).
`heap.totalPeakMiB` is the peak of the main-thread and Worker heaps sampled
together, and `heap.totalRetainedMiB` their retained sum.

Chromium throttles the page's CPU but not a Worker's
([crbug.com/383348380](https://crbug.com/383348380)), so the app Worker
runs at desktop speed and work moved into it would look free. The runner
attaches to each Worker over CDP, samples its CPU profile, and attributes
the samples to the app's Worker requests (`m3u.load`, `xmltv.load`,
`search.prewarm`, …). `work` reports, up to the first key (`readyMs`: Live
for `m3u`, Movies for `xtreamMovies`, the first candidate for Search) and
from then until the run ended:

- `main.beforeReadyMs`, `main.afterReadyMs` — main-thread long-task time;
- `worker.beforeReadyMs`, `worker.afterReadyMs` — Worker CPU, every sample;
- `worker.criticalMs` — Worker CPU before the first key while the main
  thread ran no long task, i.e. time the first key waited on the Worker;
- `worker.projectedDelayMs` — `criticalMs` × (CPU rate − 1), what that wait
  adds on the device, and `projectedReadyMs` — `readyMs` plus it;
- `workerTasks` — per request: count, span, CPU, CPU before the first key,
  and when the last one ended.

`projectedReadyMs` is an estimate: it assumes the Worker's critical-path
CPU is not hidden behind other waits on the device. The main thread's long
tasks count only tasks over 50 ms, while Worker CPU counts every sample.
`BENCHMARK_INTERACTIVE_WORKER_THROTTLE=1` instead throttles the Worker at
the page's rate by pausing it through the debugger, to show how late
results reorder the launch; the debugger inflates the Worker's own CPU
about 1.8x, so this mode reports no projection, and the comparator rejects
a baseline recorded in the other mode.

The phase emulates a TV, not the development computer. `webos4` (default)
and `c5` set the CPU throttling rate from an entry-level webOS 4 SoC and the
OLED77C5 TV baseline, and delay IndexedDB events: each read-only request by
`idbReadMs`, and each transaction that wrote data by `idbCommitMs` plus a
5 ms `fsyncMs`. Chromium before M124 syncs every IndexedDB write transaction
to the TV's eMMC; Playwright's IndexedDB does not. The 5 ms is an estimate,
not a TV measurement, so test the 2–20 ms range when a result depends on it.

The full benchmark skips this phase. `BENCHMARK_INTERACTIVE_ONLY=1` runs
only it and writes
`test-output/benchmarks/interactive-latest.json`, and the `--interactive`
comparator gates and updates only the interactive part of `baseline.json`:

```bash
BENCHMARK_INTERACTIVE_ONLY=1 npm run benchmark
node benchmarks/compare.mjs --interactive            # compare
node benchmarks/compare.mjs --interactive --update   # replace this part
```

At full scale one run of the six flows takes several minutes on a
desktop host, mostly the two Search flows. These variables shrink or change it:

| Variable | Default |
|---|---|
| `BENCHMARK_INTERACTIVE_RUNS` | `5` |
| `BENCHMARK_INTERACTIVE_FLOWS` | `m3u,m3uWarm,xtreamMovies,xtreamMoviesWarm,searchCold,searchSteady` |
| `BENCHMARK_INTERACTIVE_NETWORKS` | `unthrottled,50mbps` (also `50mbps-rtt50`, `50mbps-rtt150`) |
| `BENCHMARK_INTERACTIVE_DEVICE` | `webos4` (or `c5`) |
| `BENCHMARK_INTERACTIVE_CPU_RATE`, `_IDB_READ_MS`, `_IDB_COMMIT_MS`, `_IDB_FSYNC_MS` | From the device |
| `BENCHMARK_INTERACTIVE_LIVE`, `_MOVIES`, `_SERIES`, `_CATEGORIES`, `_M3U_CHANNELS`, `_EPG_PROGRAMMES` | 50,000, 200,000, 200,000, 5,000, 200,000, 2 |
| `BENCHMARK_INTERACTIVE_RUN_TIMEOUT_MS` | `600000` |
| `BENCHMARK_INTERACTIVE_WORKER_THROTTLE` | Unset; `1` throttles the Worker live instead of projecting its CPU |
| `BENCHMARK_INTERACTIVE_PROFILE_DIR` | Unset; a directory saves a page and a per-Worker `.cpuprofile` per run |
| `BENCHMARK_INTERACTIVE_ALLOW_INCOMPLETE` | Unset; set to skip the completeness assertions |

The p50 of every interactive timing is gated with a 100 ms floor
(`BENCHMARK_INTERACTIVE_ABSOLUTE_TOLERANCE_MS`). IndexedDB counts are
deterministic and gated with a floor of one; Search gates reads and commits
per catalog request because a faster app fetches more categories within its
load budget. `heap.retainedMiB` is gated with an 8 MiB floor, and
`heap.peakMiB` is informational. `work.projectedReadyMs` of `m3u` and
`xtreamMovies` is gated like a timing; the rest of `work` is informational. The comparator rejects a baseline recorded with a different
device, Worker throttle mode, fixture, run count, or network list.

## What is measured

| Suite | Metrics |
|---|---|
| Startup | Cached playlist, indexes, and EPG restoration until Live shows the whole list; then `settle` waits until no Long Task for 1 s and gates the longest one (the deferred guide restore), and hover-to-next-frame latency, measured after it, is regression-gated |
| Cold load | Uncached 50,000-channel M3U fetch, production parse, index build, and render of the whole list |
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
| Parental Controls | Live group selection and the 50,000-category VOD manager — category/item load, bounded DOM and extents in both columns, item and group navigation, and lock toggling |
| Search | Separate Xtream and M3U-only reloads with program-index construction, the main-thread cost of building the worker index after open, and broad/sparse/no-match query distributions |
| Interaction transitions | Rapid wheel-to-D-pad handoff, trusted Magic Remote-style pointer activation, connected focus, EPG channel/date changes, and non-empty virtual windows |
| Frame/long tasks | Action-to-next-frame distributions, frames over 50ms, and Long Tasks observed during the suites |
| Stress watchdog | Maximum event-loop heartbeat gap and explicit post-interaction document liveness |
| Memory | Used/total V8 heap, three post-GC reopen cycles, and baseline/peak/retained renderer RSS plus page heap while streaming the large Xtream playlist, unfiltered and with a 5% Live-category filter |

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

`search.{xtream,m3u}.indexBuild` follows the main thread from opening Search
on a cold index — no stored `search-index-cache` record and no running app
worker — until `event=search.worker.index.ready`: the wall time
(`readyMs`), the longest animation-frame gap (`maxFrameGapMs`), Long Task
count/total/max, and the synchronous time spent in `postMessage` for every
`search.index` payload (`postMs`, `posts`, and `postBySource`, which
attributes each post to the channel, programme, movie, and series sources it
carries, posted or read from IndexedDB). `cacheFallbacks` lists any
`event=search.worker.cache.fallback` the app logged, where the worker could
not read or verify a source from IndexedDB and the page posted its documents
instead; it should be empty for the seeded caches. `built` counts the source
indexes the worker built rather than loaded. The frame gap, Long Task total,
and post time are regression-gated.

`search.{xtream,m3u}.indexBuildWarm` repeats the same open once the cold
open's source indexes are stored (`storedIndexes`) and its worker has exited,
so the new worker loads every index from IndexedDB (`built` must be 0). Before
each sample the benchmark waits past the startup prewarm and until no stored
index changes and the app worker has exited; the cold sample then clears the
store. Its frame gap and Long Task total are regression-gated.

## Baselines

`benchmarks/baseline.json` is the checked-in reference. `benchmark:check`
compares repeated distributions and fails when any is more than 15% slower.
Baselines are longitudinal regression references for repeated runs in the same
environment, not benchmarks for comparing or ranking different computers or
TV models.
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

The TV runner connects to the running app's page over CDP using the same
connection flow as `scripts/tv.sh`. It does not use Playwright or desktop CPU
throttling. Results are written to
`test-output/benchmarks/tv-latest.json`, and the independent checked-in
reference is `benchmarks/tv-baseline.json`.

`benchmark-suite.mjs` owns the shared, browser-side fixtures, measurements,
and assertions used by both runners. `performance.spec.ts` supplies Playwright
orchestration for the desktop benchmark, while `tv-runner.mjs` owns Node/CDP
orchestration for the TV benchmark — connecting to the device, reloading the
app, injecting the shared functions via `Runtime.evaluate`, and writing the
report.

Live shows its first channels while the rest of a playlist arrives, under a
progress bar along the tab bar. Every reload that times or counts channels
(`waitForPlaylistLoaded`) waits for a Live row and for that bar to end, so
startup, cold-load, group, and large-playlist times still mean the whole list
is ready; an older build without the bar shows Live only once its list has
loaded, so the same wait measures it alike.

The TV run warns instead of failing on two known device deviations: a warm
Search open that rebuilt an index the TV's small storage quota left unstored,
and a Movies category rail that also lists the fixture's six empty categories,
as an older build does.

The desktop XMLTV pipeline uses Playwright's immediate route fulfillment to
isolate CPU and memory cost. The TV run starts temporary LAN HTTP servers for
the XMLTV and large-playlist phases. XMLTV uses 16 KiB chunks with 1ms between
chunks, measuring real `ReadableStream` delivery and download/parse overlap.
The servers close automatically after their measurements. Timing also records
the largest animation-frame gap. During memory passes, one persistent SSH
session samples renderer RSS; this avoids per-sample SSH connection overhead
and reports RSS peak, average, and delta alongside the CDP heap metrics.

### WSL 2 NAT

Default WSL 2 networking uses NAT and a virtual Ethernet adapter, so services
inside WSL are not directly exposed to devices on the LAN. Advertise the
Windows host's LAN address and choose a fixed port for the two temporary
servers, which run sequentially:

```bash
BENCHMARK_SERVER_HOST=192.0.2.10 \
BENCHMARK_SERVER_PORT=18080 \
npm run benchmark:tv
```

Configure a Windows `portproxy` rule that forwards the port to the current WSL
address, and allow the inbound TCP port through Windows Firewall. The host
override changes only the URLs sent to the TV; the servers still listen inside
WSL. Windows 11 mirrored networking can avoid the NAT forwarding setup when it
is available and permitted by the local network policy.

Without these variables, the runner keeps its original behavior: it derives the
advertised address from the route to the TV, listens on all interfaces for TV
runs, and lets the operating system choose ephemeral ports.

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
channel count. The same backup also holds the TV's own Parental Controls
record, PIN included, which is removed for the run, so the parental suite sets
a throwaway PIN. If a run is interrupted, use:

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
