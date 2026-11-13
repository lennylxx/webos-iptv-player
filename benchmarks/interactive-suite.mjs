import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  bytesToMiB,
  formatUrlHost,
  resolveLocalAddress,
  writeBenchmarkResponse,
} from './benchmark-shared.mjs';
import { summarizeWorkerWork } from './worker-observer.mjs';

// Time-to-interactive after a cold launch over a very large provider: when a
// user can first operate Live (M3U and Xtream), Movies, and Search. The
// fixture server and the in-page probe are shared by the desktop and TV
// runners. Browser functions run in the app page via `fn.toString()`, so they
// stay self-contained.

// A `Warm` flow first launches once at full CPU speed to fill the playlist,
// EPG, and catalog caches, then measures a second launch that boots from them.
export const INTERACTIVE_FLOWS = [
  'm3u',
  'm3uWarm',
  'xtreamMovies',
  'xtreamMoviesWarm',
  'searchCold',
  'searchSteady',
];

export function interactiveBaseFlow(flow) {
  return flow.endsWith('Warm') ? flow.slice(0, -'Warm'.length) : flow;
}

// rttMs delays each response's headers, as a round trip to a remote
// provider would; the `-rtt` profiles are opt-in via BENCHMARK_INTERACTIVE_NETWORKS.
export const INTERACTIVE_NETWORKS = {
  unthrottled: { bytesPerSecond: 0, rttMs: 0 },
  '50mbps': { bytesPerSecond: 50_000_000 / 8, rttMs: 0 },
  '50mbps-rtt50': { bytesPerSecond: 50_000_000 / 8, rttMs: 50 },
  '50mbps-rtt150': { bytesPerSecond: 50_000_000 / 8, rttMs: 150 },
};

export const INTERACTIVE_DEFAULT_NETWORKS = ['unthrottled', '50mbps'];

// Desktop stand-ins for TV hardware, calibrated on a desktop host. CPU throttling
// slows the renderer but not the browser-process IndexedDB backend, so each
// profile also delays IndexedDB by the host's own cost (about 0.07ms per read
// and 0.3ms per write commit) times (cpuRate - 1).
// - c5: an OLED C5 (webOS 25) measured about 14x slower than that host across the
//   performance suite, including its unthrottled large-playlist load.
// - webos4: a 2018 entry model; A53-class cores put the CPU gap near 20x.
//   Unmeasured, so treat it as a lower bound.
export const INTERACTIVE_DEVICES = {
  c5: { cpuRate: 14, idbReadMs: 1, idbCommitMs: 4 },
  webos4: { cpuRate: 20, idbReadMs: 1.5, idbCommitMs: 6 },
};

// Chromium before M124 syncs every IndexedDB commit that wrote data
// (LevelDB sync writes -> fdatasync), but Playwright's IndexedDB lives in
// memory. Synchronous LevelDB inserts on phone eMMC take about 2ms; 5ms is an
// unmeasured TV estimate, overridable with
// BENCHMARK_INTERACTIVE_IDB_FSYNC_MS.
export const INTERACTIVE_FSYNC_MS = 5;

// Synthetic needle titles: one channel, movie, and series sit at the very end
// of their catalogs, so the first Search candidate needs the whole index.
export const INTERACTIVE_NEEDLE = 'needle';

const CHUNK_BYTES = 64 * 1024;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

export async function startInteractiveBenchmarkServer(options) {
  const publicHost = options.advertisedHost ?? (
    options.deviceIp ? await resolveLocalAddress(options.deviceIp) : '127.0.0.1'
  );
  const bindHost = options.deviceIp ? '0.0.0.0' : '127.0.0.1';
  const server = createServer();
  server.listen(options.port ?? 0, bindHost);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Interactive benchmark server did not bind to a TCP port');
  }
  const origin = `http://${formatUrlHost(publicHost)}:${String(address.port)}`;
  const generated = generateInteractiveFixture(origin, options);
  const link = { bytesPerSecond: 0, rttMs: 0, nextFree: 0 };
  const stats = { requests: 0, bytes: 0, byRoute: {}, timeline: {} };
  let since = performance.now();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', (request, response) => {
    const url = new URL(request.url || '/', 'http://host');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    stats.requests++;
    const route = requestRoute(url);
    stats.byRoute[route] = (stats.byRoute[route] ?? 0) + 1;
    // Per-10s request counts show whether a catalog load slows as it grows.
    const bucket = String(Math.floor((performance.now() - since) / 10_000) * 10);
    const counts = stats.timeline[route] ??= {};
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    const body = routeInteractiveRequest(url, generated);
    const respond = () => {
      if (response.destroyed) return;
      if (!body) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': body.type,
        'Content-Length': String(body.data.byteLength),
      });
      stats.bytes += body.data.byteLength;
      void sendThrottled(response, body.data, link);
    };
    if (link.rttMs) setTimeout(respond, link.rttMs);
    else respond();
  });
  return {
    origin,
    stats,
    fixture: generated.summary,
    // Every response shares one link, as a household connection would.
    setNetwork(network) {
      link.bytesPerSecond = network.bytesPerSecond;
      link.rttMs = network.rttMs;
      link.nextFree = 0;
      stats.requests = 0;
      stats.bytes = 0;
      stats.byRoute = {};
      stats.timeline = {};
      since = performance.now();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

function requestRoute(url) {
  if (url.pathname !== '/player_api.php') {
    return url.pathname.startsWith('/img/') ? '/img' : url.pathname;
  }
  const action = url.searchParams.get('action') ?? 'account';
  return url.searchParams.has('category_id') ? `${action}&category_id` : action;
}

function routeInteractiveRequest(url, generated) {
  const json = (data) => ({ type: 'application/json', data });
  if (url.pathname.startsWith('/img/')) return { type: 'image/png', data: PNG_1X1 };
  if (url.pathname === '/list.m3u') {
    return { type: 'application/x-mpegURL', data: generated.m3u };
  }
  if (url.pathname === '/get.php') {
    return { type: 'application/octet-stream', data: generated.xtreamPlaylist };
  }
  if (url.pathname === '/xmltv.php' || url.pathname === '/epg.xml') {
    return { type: 'application/xml', data: generated.epg };
  }
  if (url.pathname !== '/player_api.php') return null;
  const category = url.searchParams.get('category_id');
  switch (url.searchParams.get('action')) {
    case null:
      return json(generated.account);
    case 'get_live_streams':
      return json(generated.liveStreams);
    case 'get_live_categories':
      return json(generated.liveCategories);
    case 'get_vod_categories':
      return json(generated.vodCategories);
    case 'get_series_categories':
      return json(generated.seriesCategories);
    case 'get_vod_streams':
      return json(category === null
        ? Buffer.concat(['[', ...joinJsonParts(generated.vodByCategory), ']'].map(toBuffer))
        : generated.vodByCategory[Number(category)] ?? Buffer.from('[]'));
    case 'get_series':
      return json(category === null
        ? Buffer.concat(['[', ...joinJsonParts(generated.seriesByCategory), ']'].map(toBuffer))
        : generated.seriesByCategory[Number(category)] ?? Buffer.from('[]'));
    case 'get_simple_data_table':
    case 'get_simple_date_table':
      return json(Buffer.from('{"epg_listings":[]}'));
    default:
      return json(Buffer.from('[]'));
  }
}

function toBuffer(value) {
  return typeof value === 'string' ? Buffer.from(value) : value;
}

function joinJsonParts(arrays) {
  const parts = [];
  for (const array of arrays) {
    const inner = array.subarray(1, array.byteLength - 1);
    if (!inner.byteLength) continue;
    if (parts.length) parts.push(',');
    parts.push(inner);
  }
  return parts;
}

async function sendThrottled(response, data, link) {
  if (!link.bytesPerSecond) {
    response.end(data);
    return;
  }
  for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
    const chunk = data.subarray(offset, Math.min(data.byteLength, offset + CHUNK_BYTES));
    const now = performance.now();
    const start = Math.max(now, link.nextFree);
    link.nextFree = start + chunk.byteLength / link.bytesPerSecond * 1000;
    const wait = link.nextFree - now;
    if (wait >= 1) await new Promise(resolve => setTimeout(resolve, wait));
    if (response.destroyed) return;
    if (!await writeBenchmarkResponse(response, chunk)) return;
  }
  response.end();
}

// Builds every response once; the runs then only pay for serving bytes.
export function generateInteractiveFixture(origin, options) {
  const {
    liveEntries, movies, series, categories, m3uChannels, epgProgrammes,
  } = options;
  const pad = (value, width = 6) => String(value).padStart(width, '0');
  const category = (index) => index % categories;
  const categoryName = (prefix, index) => `${prefix} ${pad(index, 4)}`;
  const named = (prefix, index, total) => (
    index === total - 1
      ? `${prefix} ${pad(index)} ${INTERACTIVE_NEEDLE}`
      : `${prefix} ${pad(index)}`
  );
  const liveId = (index) => String(index + 1);
  const movieId = (index) => String(1_000_000 + index);
  const seriesId = (index) => String(2_000_000 + index);
  const now = Date.now();

  const categoryList = (prefix) => Buffer.from(JSON.stringify(
    Array.from({ length: categories }, (_, index) => ({
      category_id: String(index),
      category_name: categoryName(prefix, index),
      parent_id: 0,
    })),
  ));

  const liveParts = [];
  for (let index = 0; index < liveEntries; index++) {
    liveParts.push(JSON.stringify({
      num: index + 1,
      name: named('Channel', index, liveEntries),
      stream_type: 'live',
      stream_id: liveId(index),
      stream_icon: `${origin}/img/l${liveId(index)}.png`,
      epg_channel_id: `ch${String(index)}`,
      category_id: String(category(index)),
      // A quarter of the channels keep a week of catch-up, as panels often do.
      tv_archive: index % 4 === 0 ? 1 : 0,
      tv_archive_duration: index % 4 === 0 ? '7' : '0',
    }));
  }

  const buckets = (count, build) => {
    const parts = Array.from({ length: categories }, () => []);
    for (let index = 0; index < count; index++) parts[category(index)].push(build(index));
    return parts.map(items => Buffer.from(`[${items.join(',')}]`));
  };
  const added = String(Math.floor(now / 1000) - 86_400);
  const vodByCategory = buckets(movies, index => JSON.stringify({
    num: index + 1,
    name: named('Movie', index, movies),
    stream_type: 'movie',
    stream_id: movieId(index),
    stream_icon: `${origin}/img/m${movieId(index)}.png`,
    rating: '7.1',
    added,
    category_id: String(category(index)),
    container_extension: 'mp4',
  }));
  const seriesByCategory = buckets(series, index => JSON.stringify({
    num: index + 1,
    name: named('Series', index, series),
    series_id: seriesId(index),
    cover: `${origin}/img/s${seriesId(index)}.png`,
    rating: '7.1',
    last_modified: added,
    category_id: String(category(index)),
  }));

  // get.php lists Live, movies, and series like a provider's full export.
  // The panel's url-tvg is the same feed the app derives from the account.
  const xtreamLines = [`#EXTM3U url-tvg="${origin}/xmltv.php?username=u&password=p"\n`];
  for (let index = 0; index < liveEntries; index++) {
    xtreamLines.push(
      `#EXTINF:-1 tvg-id="ch${String(index)}" tvg-name="${named('Channel', index, liveEntries)}" `
        + `tvg-logo="${origin}/img/l${liveId(index)}.png" `
        + `group-title="${categoryName('Live', category(index))}",${named('Channel', index, liveEntries)}\n`
        + `${origin}/live/u/p/${liveId(index)}.ts\n`,
    );
  }
  for (let index = 0; index < movies; index++) {
    xtreamLines.push(
      `#EXTINF:-1 tvg-name="${named('Movie', index, movies)}" `
        + `tvg-logo="${origin}/img/m${movieId(index)}.png" `
        + `group-title="${categoryName('Movies', category(index))}",${named('Movie', index, movies)}\n`
        + `${origin}/movie/u/p/${movieId(index)}.mp4\n`,
    );
  }
  for (let index = 0; index < series; index++) {
    xtreamLines.push(
      `#EXTINF:-1 tvg-name="${named('Series', index, series)} S01 E01" `
        + `tvg-logo="${origin}/img/s${seriesId(index)}.png" `
        + `group-title="${categoryName('Series', category(index))}",${named('Series', index, series)} S01 E01\n`
        + `${origin}/series/u/p/${seriesId(index)}.mkv\n`,
    );
  }

  const m3uLines = [`#EXTM3U url-tvg="${origin}/epg.xml"\n`];
  for (let index = 0; index < m3uChannels; index++) {
    m3uLines.push(
      `#EXTINF:-1 tvg-id="ch${String(index)}" tvg-logo="${origin}/img/l${String(index)}.png" `
        + `group-title="${categoryName('Group', category(index))}",${named('Channel', index, m3uChannels)}\n`
        + `${origin}/stream/${String(index)}.ts\n`,
    );
  }

  const slotMs = 2 * 60 * 60 * 1000;
  const firstSlot = Math.floor(now / slotMs) * slotMs - Math.floor(epgProgrammes / 2) * slotMs;
  const two = (value) => String(value).padStart(2, '0');
  const xmltvTime = (value) => {
    const date = new Date(value);
    return `${String(date.getUTCFullYear())}${two(date.getUTCMonth() + 1)}`
      + `${two(date.getUTCDate())}${two(date.getUTCHours())}`
      + `${two(date.getUTCMinutes())}00 +0000`;
  };
  const slotTimes = Array.from({ length: epgProgrammes + 1 }, (_, slot) =>
    xmltvTime(firstSlot + slot * slotMs));
  const epgParts = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'];
  for (let index = 0; index < liveEntries; index++) {
    epgParts.push(
      `<channel id="ch${String(index)}"><display-name>${named('Channel', index, liveEntries)}`
        + '</display-name></channel>\n',
    );
  }
  for (let index = 0; index < liveEntries; index++) {
    for (let slot = 0; slot < epgProgrammes; slot++) {
      epgParts.push(
        `<programme start="${slotTimes[slot]}" stop="${slotTimes[slot + 1]}" channel="ch${String(index)}">`
          + `<title>Program ${String(index)}-${String(slot)}</title>`
          + `<desc>Synthetic episode ${String(slot)} of channel ${String(index)}.</desc>`
          + '</programme>\n',
      );
    }
  }
  epgParts.push('</tv>\n');

  const result = {
    account: Buffer.from(JSON.stringify({
      user_info: {
        auth: 1,
        status: 'Active',
        exp_date: null,
        max_connections: 1,
        active_cons: 0,
        allowed_output_formats: ['m3u8', 'ts'],
      },
      server_info: { timezone: 'UTC' },
    })),
    liveStreams: Buffer.from(`[${liveParts.join(',')}]`),
    liveCategories: categoryList('Live'),
    vodCategories: categoryList('Movies'),
    seriesCategories: categoryList('Series'),
    vodByCategory,
    seriesByCategory,
    xtreamPlaylist: Buffer.from(xtreamLines.join('')),
    m3u: Buffer.from(m3uLines.join('')),
    epg: Buffer.from(epgParts.join('')),
  };
  const sum = (buffers) => buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
  result.summary = {
    liveEntries,
    movies,
    series,
    categories,
    m3uChannels,
    epgProgrammes,
    m3uMiB: bytesToMiB(result.m3u.byteLength),
    xtreamPlaylistMiB: bytesToMiB(result.xtreamPlaylist.byteLength),
    epgMiB: bytesToMiB(result.epg.byteLength),
    liveStreamsMiB: bytesToMiB(result.liveStreams.byteLength),
    vodMiB: bytesToMiB(sum(vodByCategory)),
    seriesMiB: bytesToMiB(sum(seriesByCategory)),
  };
  return result;
}

export function interactivePlaylists(origin, flow) {
  if (interactiveBaseFlow(flow) === 'm3u') {
    return [{ id: 'interactive-m3u', name: 'Interactive', url: `${origin}/list.m3u`, source: 'url' }];
  }
  return [{
    id: 'interactive-xtream',
    name: 'Interactive',
    url: origin,
    source: 'xtream',
    xtream: { username: 'u', password: 'p', liveOutput: 'ts' },
  }];
}

// Runs before the app's own scripts. The rAF loop below records every frame
// gap and resolves watchers one frame after their condition holds, i.e. once
// the frame showing it has been produced. Each flow then chains its probe
// actions in-page, so no runner round trip sits inside a measurement.
export function installInteractiveProbe(config) {
  if (window.top !== window) return;
  // The runner parks on the blank seed page between a Warm flow's launches.
  if (location.pathname.endsWith('/benchmark-seed.html')) return;
  const now = () => performance.now();
  const baseFlow = config.flow.endsWith('Warm') ? config.flow.slice(0, -4) : config.flow;
  // sessionStorage survives the runner's second navigation in the same tab.
  const launch = Number(sessionStorage.getItem('__interactiveLaunch') || '0') + 1;
  sessionStorage.setItem('__interactiveLaunch', String(launch));
  const probe = {
    flow: config.flow,
    phase: baseFlow !== config.flow && launch === 1 ? 'seed' : 'measure',
    keyLatencies: [],
    marks: {},
    events: {},
    gaps: [],
    longTasks: [],
    longTaskSupported: false,
    workerTasks: [],
    workers: 0,
    loadedChannels: null,
    done: false,
    error: null,
    result: null,
  };
  window.__interactiveProbe = probe;

  const recordEvents = (args) => {
    for (const arg of args) {
      if (typeof arg !== 'string' || arg.indexOf('event=') !== 0) continue;
      const name = arg.slice(6);
      const entry = probe.events[name] || (probe.events[name] = { first: now(), last: 0, count: 0 });
      entry.count++;
      entry.last = now();
      if (name === 'playlist.load.completed') {
        const field = args.find(value => typeof value === 'string' && value.indexOf('channels=') === 0);
        if (field) probe.loadedChannels = Number(field.slice(9));
      }
      if (name === 'worker.lifecycle.created') probe.workers++;
      if (name === 'worker.lifecycle.terminated' || name === 'worker.lifecycle.failed') {
        probe.workers = Math.max(0, probe.workers - 1);
      }
    }
  };
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level];
    console[level] = function (...args) {
      recordEvents(args);
      return original.apply(this, args);
    };
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push([entry.startTime, entry.duration]);
    }).observe({ entryTypes: ['longtask'] });
    probe.longTaskSupported = true;
  } catch { /* Chromium 53 has no Long Tasks API; frame gaps still cover it. */ }

  // Times every worker RPC request, from postMessage until its success or
  // failure is dispatched, as [task, start, end, ok].
  if (typeof Worker === 'function') {
    const NativeWorker = Worker;
    const open = new WeakMap();
    const close = (worker, id, ok) => {
      const byId = open.get(worker);
      const request = byId && byId.get(id);
      if (!request) return;
      byId.delete(id);
      probe.workerTasks.push([request[0], request[1], now(), ok]);
    };
    const post = NativeWorker.prototype.postMessage;
    NativeWorker.prototype.postMessage = function (message, ...rest) {
      if (message && message.kind === 'request' && typeof message.task === 'string') {
        let byId = open.get(this);
        if (!byId) open.set(this, byId = new Map());
        byId.set(message.id, [message.task, now()]);
      }
      return post.call(this, message, ...rest);
    };
    const terminate = NativeWorker.prototype.terminate;
    NativeWorker.prototype.terminate = function () {
      const byId = open.get(this);
      if (byId) for (const id of Array.from(byId.keys())) close(this, id, 0);
      return terminate.call(this);
    };
    window.Worker = function (url, options) {
      const worker = new NativeWorker(url, options);
      worker.addEventListener('message', (event) => {
        const data = event.data;
        if (data && (data.kind === 'success' || data.kind === 'failure')) {
          close(worker, data.id, data.kind === 'success' ? 1 : 0);
        }
      });
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;
  }

  const watchers = [];
  let lastFrame = 0;
  const tick = () => {
    const time = now();
    if (lastFrame && time - lastFrame > 50) probe.gaps.push([lastFrame, time - lastFrame]);
    lastFrame = time;
    for (let index = watchers.length - 1; index >= 0; index--) {
      const watcher = watchers[index];
      if (watcher.seenAt) {
        watchers.splice(index, 1);
        probe.marks[watcher.name] = time;
        probe.marks[`${watcher.name}Dom`] = watcher.seenAt;
        watcher.resolve(time);
        continue;
      }
      let met = false;
      try {
        met = watcher.predicate();
      } catch { /* The DOM may be mid-render. */ }
      if (met) watcher.seenAt = time;
      else if (time - watcher.armedAt > config.watchTimeoutMs) {
        watchers.splice(index, 1);
        watcher.reject(new Error(`Timed out waiting for ${watcher.name}`));
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Main-thread stretches with no idle period. Sliced background work yields
  // between short tasks, so neither a long task nor a log event shows it,
  // but its tasks run back to back for seconds; rendering and key handling
  // leave idle time between frames.
  const busySpans = [];
  let idleUntil = now();
  const onIdle = (deadline) => {
    const time = now();
    if (time > idleUntil) busySpans.push([idleUntil, time]);
    idleUntil = time + deadline.timeRemaining();
    requestIdleCallback(onIdle);
  };
  requestIdleCallback(onIdle);
  const longestBusyMs = (windowMs) => {
    const time = now();
    while (busySpans.length && busySpans[0][1] <= time - windowMs) busySpans.shift();
    let longest = Math.max(0, time - idleUntil);
    for (const [start, end] of busySpans) longest = Math.max(longest, end - start);
    return longest;
  };
  const watch = (name, predicate) => new Promise((resolve, reject) => {
    watchers.push({ name, predicate, resolve, reject, armedAt: now(), seenAt: 0 });
  });
  // Queued as a task, the probe input waits behind whatever holds the main
  // thread, as a real key or keystroke would.
  const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
  const visible = (element) => !!element
    && !element.classList.contains('hidden')
    && element.style.display !== 'none';
  const ringSignature = () => Array.from(document.querySelectorAll('.focused'))
    .map(element => element.getAttribute('data-key') || element.id || element.className)
    .join('|');
  const pressKey = async (name, key, keyCode) => {
    await nextTask();
    const before = ringSignature();
    probe.marks[`${name}KeyAt`] = now();
    document.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true }));
    await watch(name, () => ringSignature() !== before);
  };
  const click = (selector) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Missing ${selector}`);
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }));
  };
  const searchView = () => document.querySelector('#view-search .search-view');
  const searchSettled = (query) => {
    const view = searchView();
    return !!view
      && visible(document.getElementById('view-search'))
      && view.getAttribute('data-search-query') === query
      && view.getAttribute('data-search-pending') === 'false';
  };
  const SEARCH_RESULTS = '.catalog-tile, .search-channel-row, .search-channel-tile, .search-program-row';
  const typeQuery = async (name, query, ready) => {
    await nextTask();
    const input = document.querySelector('.tab-bar-search-input');
    input.value = query;
    probe.marks[`${name}TypedAt`] = now();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const echoed = watch(`${name}Echo`, () => input.value === query);
    await Promise.all([echoed, watch(name, ready)]);
  };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  // Background work after launch (EPG, cache writes, Search prewarm) has gone
  // quiet: true, false on timeout, or null while it is still running.
  const busy = /^(search\.|epg\.|xmltv\.|worker\.|playlist\.|xtream\.)/;
  const quietSince = (started) => {
    const lastEvent = Object.keys(probe.events)
      .filter(name => busy.test(name))
      .reduce((latest, name) => Math.max(latest, probe.events[name].last), 0);
    const quiet = probe.workers === 0 && now() - lastEvent >= config.quietMs
      && longestBusyMs(config.quietMs) <= config.quietMaxBusyMs;
    if (now() - started >= config.minSettleMs && quiet) return true;
    if (now() - started >= config.settleTimeoutMs) return false;
    return null;
  };
  const waitForQuiet = async () => {
    const started = now();
    for (;;) {
      await sleep(250);
      const settled = quietSince(started);
      if (settled !== null) return settled;
    }
  };
  // Presses Up and Down in turn every keyIntervalMs until the background goes
  // quiet. Each latency runs from when the key was due, so a key that waits
  // behind a long task counts that wait, as a user's would.
  const pressKeysUntilQuiet = async () => {
    const started = now();
    probe.marks.keysStart = started;
    let due = started + config.keyIntervalMs;
    for (let index = 0; ; index++) {
      await sleep(Math.max(0, due - now()));
      const before = ringSignature();
      const up = index % 2 === 0;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: up ? 'ArrowUp' : 'ArrowDown',
        keyCode: up ? 38 : 40,
        bubbles: true,
      }));
      const shown = await watch('keyTrain', () => ringSignature() !== before);
      probe.keyLatencies.push(shown - due);
      const settled = quietSince(started);
      if (settled !== null) {
        probe.marks.keysEnd = now();
        probe.marks.settled = settled ? 1 : 0;
        return;
      }
      due = Math.max(due + config.keyIntervalMs, now());
    }
  };
  // The first launch of a Warm flow only fills the caches the measured
  // launch boots from, then reports whether its background work finished.
  const seed = async () => {
    await watch('liveVisible', liveReady);
    if (baseFlow === 'xtreamMovies') {
      await nextTask();
      click('[data-section="movies"]');
      await watch('moviesVisible', moviesReady);
    }
    probe.seeded = await waitForQuiet()
      && !!probe.events['playlist.cache.write.completed'];
  };

  // The app's own UI is up: the docked tab bar over a real view, rows or not.
  const appReady = () => document.body.classList.contains('tabbar-docked')
    && Array.from(document.querySelectorAll('.view')).some(visible);

  const liveReady = () => visible(document.getElementById('view-channels'))
    && !!document.querySelector('#view-channels .channel-item');

  const moviesReady = () => {
    const view = document.getElementById('view-movies');
    return visible(view)
      && !view.querySelector('.catalog-loading')
      && !!view.querySelector('.catalog-tile[data-item-id]');
  };

  const run = async () => {
    if (probe.phase === 'seed') {
      await seed();
      return;
    }
    // A launch of its own: the key would change what the other metrics time.
    if (config.appOnly) {
      await watch('appVisible', appReady);
      // The first key the app answers, rows or not: Up reaches the tab bar.
      await pressKey('appInteractive', 'ArrowUp', 38);
      return;
    }
    await watch('liveVisible', liveReady);
    await pressKey('liveInteractive', 'ArrowDown', 40);
    if (baseFlow === 'm3u') {
      await pressKeysUntilQuiet();
      return;
    }
    if (baseFlow === 'xtreamMovies') {
      await nextTask();
      probe.marks.moviesClickAt = now();
      click('[data-section="movies"]');
      await watch('moviesVisible', moviesReady);
      await pressKey('moviesInteractive', 'ArrowDown', 40);
      await pressKeysUntilQuiet();
      return;
    }
    if (config.flow === 'searchSteady') {
      probe.marks.settled = await waitForQuiet() ? 1 : 0;
    }
    await nextTask();
    probe.marks.searchClickAt = now();
    click('[data-section="search"]');
    await watch('searchInputReady', () => {
      const input = document.querySelector('.tab-bar-search-input');
      return !!document.querySelector('.tab-bar-search.expanded')
        && document.activeElement === input;
    });
    await typeQuery('firstCandidate', config.needle, () =>
      searchSettled(config.needle) && !!searchView().querySelector(SEARCH_RESULTS));
    // Channels and programs answer first; movies and series join once indexed.
    await watch('allResults', () => searchSettled(config.needle)
      && searchView().getAttribute('data-search-partial') === 'false');
    probe.hits = {
      channels: document.querySelectorAll(
        '#view-search .search-channel-row, #view-search .search-channel-tile',
      ).length,
      movies: document.querySelectorAll('#view-search [data-search-virtual="movies"] .catalog-tile').length,
      series: document.querySelectorAll('#view-search [data-search-virtual="series"] .catalog-tile').length,
    };
    await typeQuery('broadQuery', 'movie', () =>
      searchSettled('movie') && !!searchView().querySelector(SEARCH_RESULTS));
    await typeQuery('noMatchQuery', 'zzzz-no-match', () =>
      searchSettled('zzzz-no-match') && !!searchView().querySelector('.search-empty'));
  };

  run().then(() => {
    probe.done = true;
  }, (error) => {
    probe.error = String(error && error.stack || error);
    probe.done = true;
  });
}

// Page init script: delays IndexedDB read results and write commits to model
// a TV's slower CPU and storage. Cursor steps run at once because cursor.continue()
// must be called while the transaction is still active. Workers are not
// covered; Playwright init scripts run only in the page.
export function installIdbLatency(config) {
  if (typeof IDBRequest === 'undefined') return;
  const counts = { reads: 0, commits: 0 };
  window.__idbLatency = counts;
  // Only a transaction that wrote something reaches the disk on commit.
  const dirty = new WeakSet();
  const store = IDBObjectStore.prototype;
  for (const name of ['put', 'add', 'delete', 'clear']) {
    const original = store[name];
    store[name] = function (...args) {
      const request = original.apply(this, args);
      dirty.add(this.transaction);
      return request;
    };
  }
  if (typeof IDBCursor !== 'undefined') {
    for (const name of ['update', 'delete']) {
      const original = IDBCursor.prototype[name];
      IDBCursor.prototype[name] = function (...args) {
        const request = original.apply(this, args);
        dirty.add(request.transaction);
        return request;
      };
    }
  }
  const delayFor = (target, type) => {
    if (type === 'success' && target instanceof IDBRequest) {
      if (typeof IDBCursor !== 'undefined' && target.result instanceof IDBCursor) return 0;
      if (target.transaction && target.transaction.mode !== 'readonly') return 0;
      counts.reads++;
      return config.idbReadMs;
    }
    if (type === 'complete' && target instanceof IDBTransaction && dirty.has(target)) {
      dirty.delete(target);
      counts.commits++;
      return config.idbCommitMs + config.fsyncMs;
    }
    return 0;
  };
  const wrapped = new WeakMap();
  const wrap = (type, listener) => {
    if (typeof listener !== 'function') return listener;
    let byType = wrapped.get(listener);
    if (!byType) wrapped.set(listener, byType = {});
    if (!byType[type]) {
      byType[type] = function (event) {
        const ms = delayFor(this, type);
        if (ms <= 0) return listener.call(this, event);
        setTimeout(() => listener.call(this, event), ms);
        return undefined;
      };
    }
    return byType[type];
  };
  const patch = (proto, type) => {
    const handler = 'on' + type;
    const descriptor = Object.getOwnPropertyDescriptor(proto, handler);
    const originals = new WeakMap();
    Object.defineProperty(proto, handler, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() { return originals.has(this) ? originals.get(this) : descriptor.get.call(this); },
      set(listener) {
        originals.set(this, listener);
        descriptor.set.call(this, wrap(type, listener));
      },
    });
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    proto.addEventListener = function (eventType, listener, options) {
      return add.call(this, eventType, eventType === type ? wrap(type, listener) : listener, options);
    };
    proto.removeEventListener = function (eventType, listener, options) {
      return remove.call(this, eventType, eventType === type ? wrap(type, listener) : listener, options);
    };
  };
  patch(IDBRequest.prototype, 'success');
  patch(IDBTransaction.prototype, 'complete');
}

// Polled while the run is in flight, so it copies as little as it can on the
// throttled page thread.
export function readInteractiveProbeStatus() {
  const probe = window.__interactiveProbe;
  return probe ? { done: probe.done === true, error: probe.error } : null;
}

export function readInteractiveProbe() {
  const probe = window.__interactiveProbe;
  if (!probe) return null;
  // The app renders only the current view, so a Live list hidden behind
  // another view may still hold the rows it had when it was left; the
  // count the playlist load reported stands in for it then.
  const live = document.getElementById('view-channels');
  return {
    done: probe.done,
    error: probe.error,
    flow: probe.flow,
    phase: probe.phase,
    seeded: probe.seeded === true,
    keyLatencies: probe.keyLatencies,
    marks: probe.marks,
    events: probe.events,
    gaps: probe.gaps,
    longTasks: probe.longTasks,
    longTaskSupported: probe.longTaskSupported,
    workerTasks: probe.workerTasks,
    hits: probe.hits || null,
    idb: window.__idbLatency || null,
    channels: live && !live.classList.contains('hidden')
      ? Math.round(Number.parseFloat(
        live.querySelector('.channel-list-spacer')?.style.height || '0',
      ) / 88)
      : probe.loadedChannels ?? null,
  };
}

// Turns one run's raw marks into the metrics it reports, all in milliseconds
// from navigation start unless named as a latency. The app metrics come from
// a separate launch, `appRaw`.
export function summarizeInteractiveRun(raw, appRaw) {
  if (raw.error) throw new Error(`Interactive ${raw.flow} run failed: ${raw.error}`);
  if (appRaw?.error) throw new Error(`Interactive ${raw.flow} app run failed: ${appRaw.error}`);
  const m = raw.marks;
  const a = appRaw?.marks;
  const flow = interactiveBaseFlow(raw.flow);
  const round = value => Math.round(value * 10) / 10;
  const within = (from, to) => {
    let maxGap = 0;
    for (const [start, gap] of raw.gaps) {
      if (start + gap > from && start < to) maxGap = Math.max(maxGap, gap);
    }
    let longest = 0;
    let total = 0;
    for (const [start, duration] of raw.longTasks) {
      if (start + duration > from && start < to) {
        longest = Math.max(longest, duration);
        total += duration;
      }
    }
    return { maxFrameGapMs: round(maxGap), maxLongTaskMs: round(longest), longTaskTotalMs: round(total) };
  };
  // From the first interaction until background work went quiet.
  const afterReady = () => {
    const latencies = raw.keyLatencies.slice().sort((a, b) => a - b);
    const pick = fraction => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))];
    return {
      durationMs: round(m.keysEnd - m.keysStart),
      settled: m.settled === 1,
      keys: latencies.length,
      keyLatencyP95Ms: latencies.length ? round(pick(0.95)) : null,
      keyLatencyMaxMs: latencies.length ? round(latencies[latencies.length - 1]) : null,
      ...within(m.keysStart, m.keysEnd),
    };
  };
  const live = {
    ...(a ? {
      appVisibleMs: round(a.appVisible),
      appInteractiveMs: round(a.appInteractive),
      appKeyLatencyMs: round(a.appInteractive - a.appInteractiveKeyAt),
    } : {}),
    visibleMs: round(m.liveVisible),
    interactiveMs: round(m.liveInteractive),
    keyLatencyMs: round(m.liveInteractive - m.liveInteractiveKeyAt),
    loading: within(0, m.liveVisible),
    loadedMs: raw.events?.['playlist.load.completed']
      ? round(raw.events['playlist.load.completed'].first)
      : null,
    channels: raw.channels,
  };
  const run = { flow: raw.flow, live };
  if (raw.idb) run.idb = { ...raw.idb };
  if (raw.heap) run.heap = { ...raw.heap };
  if (flow === 'm3u') live.afterReady = afterReady();
  if (flow === 'xtreamMovies') {
    run.movies = {
      visibleMs: round(m.moviesVisible - m.moviesClickAt),
      interactiveMs: round(m.moviesInteractive - m.moviesClickAt),
      keyLatencyMs: round(m.moviesInteractive - m.moviesInteractiveKeyAt),
      fromLaunchMs: round(m.moviesInteractive),
      loading: within(m.moviesClickAt, m.moviesVisible),
      afterReady: afterReady(),
    };
  }
  if (raw.workerBusy) run.work = summarizeWork(raw, within);
  if (flow === 'searchCold' || flow === 'searchSteady') {
    const indexReady = raw.events['search.index.ready'];
    const partial = raw.events['xtream.catalog.partial'];
    run.search = {
      settled: raw.flow === 'searchSteady' ? m.settled === 1 : undefined,
      inputReadyMs: round(m.searchInputReady - m.searchClickAt),
      inputEchoMs: round(m.firstCandidateEcho - m.firstCandidateTypedAt),
      firstCandidateMs: round(m.firstCandidate - m.firstCandidateTypedAt),
      firstCandidateFromOpenMs: round(m.firstCandidate - m.searchClickAt),
      fromLaunchMs: round(m.firstCandidate),
      allResultsMs: round(m.allResults - m.firstCandidateTypedAt),
      indexReadyFromOpenMs: indexReady ? round(indexReady.last - m.searchClickAt) : null,
      broadQueryMs: round(m.broadQuery - m.broadQueryTypedAt),
      noMatchQueryMs: round(m.noMatchQuery - m.noMatchQueryTypedAt),
      typing: within(m.firstCandidateTypedAt, m.firstCandidate),
      partialCatalogs: partial ? partial.count : 0,
      hits: raw.hits,
    };
  }
  return run;
}

// Where the CPU went: the main thread's long tasks and the worker's sampled
// CPU, before the user could first act and from then until the run ended.
function summarizeWork(raw, within) {
  const m = raw.marks;
  const flow = interactiveBaseFlow(raw.flow);
  const readyMs = flow === 'm3u'
    ? m.liveInteractive
    : flow === 'xtreamMovies' ? m.moviesInteractive : m.firstCandidate;
  const endMs = m.keysEnd ?? m.noMatchQuery ?? readyMs;
  const worker = summarizeWorkerWork({
    busy: raw.workerBusy,
    tasks: raw.workerTasks,
    longTasks: raw.longTasks,
    readyMs,
    endMs,
  });
  // An unthrottled worker ran its critical-path CPU at desktop speed; on the
  // device each of those milliseconds takes the page's rate.
  const rate = raw.workerCpu?.rate ?? 1;
  const projectedDelayMs = raw.workerCpu && !raw.workerCpu.throttled && rate > 1
    ? Math.round(worker.criticalMs * (rate - 1))
    : null;
  return {
    readyMs: Math.round(readyMs),
    main: {
      beforeReadyMs: within(0, readyMs).longTaskTotalMs,
      afterReadyMs: within(readyMs, endMs).longTaskTotalMs,
    },
    worker: {
      beforeReadyMs: worker.beforeReadyMs,
      afterReadyMs: worker.afterReadyMs,
      criticalMs: worker.criticalMs,
      ...(raw.workerCpu && {
        cpuMs: Math.round(raw.workerCpu.cpuMs),
        // How much the throttle stretched the worker's CPU; the page's rate
        // is the target.
        throttle: raw.workerCpu.cpuMs
          ? Math.round((raw.workerCpu.cpuMs + raw.workerCpu.pausedMs) / raw.workerCpu.cpuMs * 10) / 10
          : null,
      }),
      ...(projectedDelayMs !== null && { projectedDelayMs }),
    },
    ...(projectedDelayMs !== null && { projectedReadyMs: Math.round(readyMs + projectedDelayMs) }),
    workerTasks: worker.tasks,
  };
}

export function aggregateInteractiveRuns(runs) {
  const distribution = (values) => {
    const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
    if (!sorted.length) return null;
    const pick = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    return {
      p50: pick(0.5),
      p95: pick(0.95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      samples: values,
    };
  };
  // Numbers become distributions; other leaves keep every run's value.
  const merge = (items) => {
    const first = items.find(item => item !== undefined && item !== null);
    if (typeof first === 'number') return distribution(items);
    if (first && typeof first === 'object') {
      const keys = new Set(items.flatMap(item => item ? Object.keys(item) : []));
      return Object.fromEntries(Array.from(keys).map(key => [key, merge(items.map(item => item?.[key]))]));
    }
    return items;
  };
  return merge(runs);
}

export function assertInteractiveFlow(name, report, fixture) {
  const flow = interactiveBaseFlow(name);
  const live = report.live;
  const expectedChannels = flow === 'm3u' ? fixture.m3uChannels : fixture.liveEntries;
  if (!live.interactiveMs || !(live.interactiveMs.p50 > 0)) {
    throw new Error(`Interactive ${name} recorded no Live time`);
  }
  // A run that ended away from Live reports no count; aggregating only such
  // runs leaves a plain array instead of a distribution.
  const counts = Array.isArray(live.channels) ? live.channels : live.channels?.samples ?? [];
  for (const count of counts) {
    if (count !== null && count !== expectedChannels) {
      throw new Error(`Interactive ${name} showed ${String(count)} of ${String(expectedChannels)} channels`);
    }
  }
  if (flow === 'xtreamMovies' && !(report.movies?.interactiveMs?.p50 > 0)) {
    throw new Error('Interactive Movies time was not recorded');
  }
  const afterReady = flow === 'm3u' ? live.afterReady : report.movies?.afterReady;
  if ((flow === 'm3u' || flow === 'xtreamMovies') && !(afterReady?.keys?.min > 0)) {
    throw new Error(`Interactive ${name} pressed no keys after it became interactive`);
  }
  const settled = [...(afterReady?.settled ?? []), ...(report.search?.settled ?? [])];
  if (settled.includes(false)) {
    throw new Error(`Interactive ${name} never went quiet; its after-ready numbers are cut short`);
  }
  if (flow === 'searchCold' || flow === 'searchSteady') {
    if (!(report.search?.firstCandidateMs?.p50 > 0)) {
      throw new Error(`Interactive ${name} recorded no first candidate`);
    }
    // A run whose catalogs loaded only in part reports partialCatalogs and
    // cannot find every movie or series; any other run must find each needle.
    const partial = report.search.partialCatalogs?.samples ?? [];
    for (const kind of ['channels', 'movies', 'series']) {
      report.search.hits[kind].samples.forEach((count, run) => {
        if (kind !== 'channels' && partial[run] > 0) return;
        if (count < 1) throw new Error(`Interactive ${name} found no ${kind} needle`);
      });
    }
  }
}
