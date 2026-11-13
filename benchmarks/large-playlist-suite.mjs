import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  bytesToMiB,
  formatUrlHost,
  resolveLocalAddress,
  roundHundredths,
  writeBenchmarkResponse,
} from './benchmark-shared.mjs';

// Streams a synthetic Xtream playlist of up to hundreds of thousands of
// entries and samples renderer RSS and page heap while the app loads it.

export const LARGE_PLAYLIST_CATEGORIES = 605;
const LARGE_PLAYLIST_KEPT_CATEGORIES = 30;

// Keeps about 5% of the large playlist's Live categories, as a user trimming
// a provider catalog down to a few countries would.
export function largePlaylistCategoryFilter() {
  return {
    mode: 'include',
    ids: Array.from({ length: LARGE_PLAYLIST_KEPT_CATEGORIES }, (_, index) => String(index)),
  };
}

export function largePlaylistFilteredChannels(liveEntries, filter) {
  const kept = new Set(filter.ids.map(Number));
  let channels = 0;
  for (let index = 0; index < liveEntries; index++) {
    if (kept.has(index % LARGE_PLAYLIST_CATEGORIES)) channels++;
  }
  return channels;
}

export async function measureLargePlaylistMemory(options, io) {
  if (options.liveEntries > options.totalEntries) {
    throw new Error('Large playlist Live count cannot exceed total entries');
  }
  const server = await startLargePlaylistBenchmarkServer(options);
  try {
    await io.page.goto('/');
    await io.page.evaluate(installLargePlaylistSource, {
      id: 'benchmark-control',
      name: 'Control',
      url: `${server.origin}/tiny.m3u`,
      source: 'url',
    });
    await io.page.reload({ waitUntil: 'domcontentloaded' });
    await io.page.evaluate(waitForLargePlaylistChannelCount, {
      expected: 1,
      timeoutMs: options.timeoutMs,
    });
    await io.delay(1500);
    await io.collectGarbage();
    const baseline = await sampleChromiumMemory(io);

    await io.page.evaluate(installLargePlaylistSource, {
      id: options.accountId,
      name: 'Large Playlist',
      url: server.origin,
      source: 'xtream',
      xtream: {
        username: 'u',
        password: 'p',
        liveOutput: 'ts',
        ...(options.liveCategories ? { liveCategories: options.liveCategories } : {}),
      },
    });

    const samples = [baseline];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        await io.delay(options.sampleIntervalMs);
        const sample = await sampleChromiumMemory(io).catch(() => null);
        if (sample) samples.push(sample);
      }
    })();
    let readyMs;
    try {
      const started = performance.now();
      await io.page.reload({ waitUntil: 'domcontentloaded' });
      await io.page.evaluate(waitForLargePlaylistChannelCount, {
        expected: options.expectedChannels ?? options.liveEntries,
        timeoutMs: options.timeoutMs,
      });
      readyMs = performance.now() - started;
      await io.delay(1500);
      await io.collectGarbage();
      samples.push(await sampleChromiumMemory(io));
    } finally {
      sampling = false;
      await sampler;
    }

    const retained = samples[samples.length - 1];
    const peakRssBytes = Math.max(...samples.map(sample => sample.rssBytes));
    const peakHeapBytes = Math.max(...samples.map(sample => sample.heapUsedBytes));
    return {
      totalEntries: options.totalEntries,
      liveEntries: options.liveEntries,
      keptCategories: options.liveCategories?.ids.length ?? LARGE_PLAYLIST_CATEGORIES,
      playlistBytes: options.playlistBytes,
      playlistMiB: bytesToMiB(options.playlistBytes),
      catalogBytes: server.stats.catalogBytes,
      catalogMiB: bytesToMiB(server.stats.catalogBytes),
      chunkBytes: options.chunkBytes,
      chunkDelayMs: options.chunkDelayMs,
      playlistDurationMs: roundHundredths(server.stats.playlistDurationMs),
      readyMs: roundHundredths(readyMs),
      channels: await io.page.evaluate(readLargePlaylistChannelCount),
      samples: samples.length,
      baselineRendererProcesses: baseline.rendererCount,
      peakRendererProcesses: Math.max(...samples.map(sample => sample.rendererCount)),
      baselineRssMiB: bytesToMiB(baseline.rssBytes),
      peakRssMiB: bytesToMiB(peakRssBytes),
      peakRssDeltaMiB: bytesToMiB(peakRssBytes - baseline.rssBytes),
      retainedRssMiB: bytesToMiB(retained.rssBytes),
      retainedRssDeltaMiB: bytesToMiB(retained.rssBytes - baseline.rssBytes),
      baselineHeapMiB: bytesToMiB(baseline.heapUsedBytes),
      peakHeapMiB: bytesToMiB(peakHeapBytes),
      peakHeapDeltaMiB: bytesToMiB(peakHeapBytes - baseline.heapUsedBytes),
      retainedHeapMiB: bytesToMiB(retained.heapUsedBytes),
      retainedHeapDeltaMiB: bytesToMiB(retained.heapUsedBytes - baseline.heapUsedBytes),
    };
  } finally {
    await server.close();
  }
}

export async function startLargePlaylistBenchmarkServer(options) {
  const publicHost = options.advertisedHost ?? (
    options.deviceIp ? await resolveLocalAddress(options.deviceIp) : '127.0.0.1'
  );
  const bindHost = options.deviceIp ? '0.0.0.0' : '127.0.0.1';
  const stats = {
    catalogBytes: 0,
    playlistDurationMs: 0,
  };
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://host');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/tiny.m3u') {
      response.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
      response.end('#EXTM3U\n#EXTINF:-1,Control\nhttp://host/control\n');
      return;
    }
    if (url.pathname === '/xmltv.php') {
      response.writeHead(200, { 'Content-Type': 'application/xml' });
      response.end('<?xml version="1.0"?><tv></tv>');
      return;
    }
    if (url.pathname === '/player_api.php') {
      const action = url.searchParams.get('action');
      if (action === 'get_live_streams') {
        void streamLargeLiveCatalog(response, options, stats);
        return;
      }
      if (action === 'get_live_categories') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(Array.from({ length: LARGE_PLAYLIST_CATEGORIES }, (_, index) => ({
          category_id: String(index),
          category_name: `Group ${String(index).padStart(3, '0')}`,
        }))));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        user_info: {
          auth: 1,
          status: 'Active',
          max_connections: 1,
          allowed_output_formats: ['m3u8', 'ts'],
        },
        server_info: { timezone: 'UTC' },
      }));
      return;
    }
    if (url.pathname === '/get.php') {
      void streamLargePlaylist(response, origin, options, stats);
      return;
    }
    response.writeHead(404).end('Not found');
  });
  server.listen(options.port ?? 0, bindHost);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Large playlist server did not bind to a TCP port');
  }
  origin = `http://${formatUrlHost(publicHost)}:${String(address.port)}`;
  return {
    origin,
    stats,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function streamLargeLiveCatalog(response, options, stats) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  let batch = '[';
  let total = 0;
  for (let index = 0; index < options.liveEntries; index++) {
    batch += `${index ? ',' : ''}{"stream_id":"${largePlaylistEntryId(index)}",`
      + `"category_id":"${String(index % LARGE_PLAYLIST_CATEGORIES)}"}`;
    if (batch.length >= options.chunkBytes) {
      total += Buffer.byteLength(batch);
      if (!await writeBenchmarkResponse(response, batch)) return;
      batch = '';
    }
  }
  batch += ']';
  total += Buffer.byteLength(batch);
  if (!await writeBenchmarkResponse(response, batch)) return;
  stats.catalogBytes = total;
  response.end();
}

async function streamLargePlaylist(response, origin, options, stats) {
  const started = performance.now();
  const header = '#EXTM3U\n';
  const payloadBytes = options.playlistBytes - Buffer.byteLength(header);
  const recordBytes = Math.floor(payloadBytes / options.totalEntries);
  const largerRecords = payloadBytes % options.totalEntries;
  response.writeHead(200, {
    'Content-Length': String(options.playlistBytes),
    'Content-Type': 'application/octet-stream',
  });
  if (!await writeBenchmarkResponse(response, header)) return;
  let batch = '';
  for (let index = 0; index < options.totalEntries; index++) {
    const targetBytes = recordBytes + (index < largerRecords ? 1 : 0);
    batch += buildLargePlaylistRecord(index, targetBytes, origin, options.liveEntries);
    if (batch.length >= options.chunkBytes) {
      if (!await writeBenchmarkResponse(response, batch)) return;
      batch = '';
      if (options.chunkDelayMs > 0) await new Promise(
        resolve => setTimeout(resolve, options.chunkDelayMs),
      );
    }
  }
  if (batch && !await writeBenchmarkResponse(response, batch)) return;
  stats.playlistDurationMs = performance.now() - started;
  response.end();
}

function buildLargePlaylistRecord(index, targetBytes, origin, liveEntries) {
  const id = largePlaylistEntryId(index < liveEntries
    ? index
    : (index - liveEntries) % liveEntries);
  const group = String(index % LARGE_PLAYLIST_CATEGORIES).padStart(3, '0');
  const kind = index < liveEntries
    ? 'live'
    : ['movie', 'series', 'vod'][index % 3];
  const extension = kind === 'live' ? 'ts' : kind === 'series' ? 'mkv' : 'mp4';
  const base = [
    `#EXTINF:-1 tvg-id="ch${id}" tvg-name="Channel ${id}" `
      + `group-title="Group ${group}" catchup="xc" catchup-days="7" `
      + `custom="v${id}",Channel ${id}\n`,
    '#EXTVLCOPT:http-user-agent=BenchmarkAgent\n',
    `${origin}/${kind}/u/p/${id}.${extension}\n`,
  ].join('');
  const paddingBytes = targetBytes - Buffer.byteLength(base);
  if (paddingBytes < 2) {
    throw new Error(
      `Large playlist record ${String(index)} needs ${String(Buffer.byteLength(base))} bytes, `
      + `but its target is ${String(targetBytes)}`,
    );
  }
  return `${base}#${'x'.repeat(paddingBytes - 2)}\n`;
}

function largePlaylistEntryId(index) {
  return String(index + 1).padStart(6, '0');
}

export function installLargePlaylistSource(playlist) {
  localStorage.setItem('iptv_playlists', JSON.stringify([playlist]));
  localStorage.removeItem('iptv_selectedXtream');
  localStorage.removeItem('iptv_cached_playlist');
}

export async function waitForLargePlaylistChannelCount(options) {
  const started = Date.now();
  while (Date.now() - started < options.timeoutMs) {
    const spacer = document.querySelector('.channel-list-spacer');
    const height = Number.parseFloat(spacer?.style.height || '0');
    // A newer app reaches the count before its load ends; an older one has no progress bar.
    if (Math.round(height / 88) === options.expected
        && !document.querySelector('.tab-bar-progress.active')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${String(options.expected)} channels`);
}

export function readLargePlaylistChannelCount() {
  const spacer = document.querySelector('.channel-list-spacer');
  return Math.round(Number.parseFloat(spacer?.style.height || '0') / 88);
}

async function sampleChromiumMemory(io) {
  const [processes, heap] = await Promise.all([
    io.browserCdp.send('SystemInfo.getProcessInfo'),
    io.pageCdp.send('Runtime.getHeapUsage'),
  ]);
  const pids = processes.processInfo
    .filter(info => info.type.toLowerCase() === 'renderer')
    .map(info => info.id)
    .filter(pid => Number.isInteger(pid) && pid > 0);
  return {
    rssBytes: await processRss(pids),
    heapUsedBytes: heap.usedSize,
    rendererCount: pids.length,
  };
}

async function processRss(pids) {
  if (!pids.length) return 0;
  const output = await new Promise((resolve, reject) => {
    execFile('ps', ['-o', 'rss=', '-p', pids.join(',')], {
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  return output.trim().split(/\s+/)
    .filter(Boolean)
    .reduce((total, value) => total + Number(value) * 1024, 0);
}
