// Shared browser-side fixture, measurement, and assertion functions used by
// both the Desktop Playwright benchmark (performance.spec.ts) and the TV CDP
// benchmark (tv-runner.mjs). These run inside the app page via
// `fn.toString()`, so they must stay self-contained — no closures over
// module-level state, no Node APIs.

export async function installBenchmarkFixture(options) {
    const directStorage = options.directStorage === true;
    const openDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('iptv');
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('epg-cache')) {
          db.createObjectStore('epg-cache', { keyPath: 'url' });
        }
        if (!db.objectStoreNames.contains('catalog-cache')) {
          db.createObjectStore('catalog-cache', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('subtitle-cache')) {
          db.createObjectStore('subtitle-cache', { keyPath: 'key' });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transactionDone = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const cacheEntries = [];
    const cacheRecord = (
      store,
      category,
      value,
      expiresAt = Date.now() + 6 * 60 * 60 * 1000,
    ) => {
      if (!directStorage) return value;
      const timestamp = typeof value.timestamp === 'number' ? value.timestamp : Date.now();
      const record = {
        ...value,
        cacheCategory: category,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAccessedAt: timestamp,
        expiresAt,
        byteSize: 0,
      };
      record.byteSize = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      cacheEntries.push({ store, record });
      return record;
    };

    const db = await openDb();
    const existingTx = db.transaction('catalog-cache', 'readonly');
    const existing = await requestValue(
      existingTx.objectStore('catalog-cache').get(options.backupKey),
    );
    if (existing) {
      db.close();
      throw new Error(
        'An interrupted TV benchmark backup exists. Run npm run benchmark:tv:cleanup first.',
      );
    }

    const backup = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null) backup[key] = localStorage.getItem(key);
    }
    let playlistCache = null;
    if (db.objectStoreNames.contains('playlist-cache')) {
      const playlistTx = db.transaction('playlist-cache', 'readonly');
      playlistCache = await requestValue(
        playlistTx.objectStore('playlist-cache').get('combined'),
      ) || null;
    }
    let cacheMeta = null;
    if (db.objectStoreNames.contains('cache-meta')) {
      const metaTx = db.transaction('cache-meta', 'readonly');
      cacheMeta = await requestValue(metaTx.objectStore('cache-meta').getAll());
    }
    let recentlyWatched = null;
    if (db.objectStoreNames.contains('recently-watched')) {
      const recentTx = db.transaction('recently-watched', 'readonly');
      recentlyWatched = await requestValue(
        recentTx.objectStore('recently-watched').getAll(),
      );
    }
    let playbackProgress = null;
    if (db.objectStoreNames.contains('playback-progress')) {
      const progressTx = db.transaction('playback-progress', 'readonly');
      playbackProgress = await requestValue(
        progressTx.objectStore('playback-progress').getAll(),
      );
    }
    const backupTx = db.transaction('catalog-cache', 'readwrite');
    backupTx.objectStore('catalog-cache').put(cacheRecord('catalog-cache', 'catalog', {
      key: options.backupKey,
      timestamp: Date.now(),
      data: {
        localStorage: backup,
        playlistCache,
        cacheMeta,
        recentlyWatched,
        playbackProgress,
      },
    }));
    await transactionDone(backupTx);

    let firstUrl = 'http://host/0';
    try {
      const cached = JSON.parse(backup.iptv_cached_playlist || 'null');
      firstUrl = cached && cached.channels && cached.channels[0]
        ? cached.channels[0].url || firstUrl
        : firstUrl;
    } catch {
      // Keep the synthetic fallback.
    }
    localStorage.clear();
    const channels = Array.from({ length: options.scale }, (_, index) => ({
      ...(index < 2 ? { id: `ch${String(index)}` } : {}),
      name: index === options.scale - 1 ? 'RareChannelNeedle' : `Channel ${String(index)}`,
      group: index === 0 ? 'Small Group' : `Group ${String(index % 100)}`,
      url: index === 0 ? firstUrl : `http://host/${String(index)}`,
      playlistIds: [options.accountId],
    }));
    const fnv1a = (value) => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    const recentLive = [];
    const catchupProgress = {};
    const recentNow = Date.now();
    for (let rank = 0; rank < 50; rank++) {
      const channel = channels[rank];
      const channelKey = fnv1a(channel.url);
      const updatedAt = recentNow - rank * 1000;
      if (rank % 2 === 0) {
        recentLive.push({ channelKey, updatedAt });
      } else {
        channel.catchupSource = 'http://host/catchup';
        channel.catchupDays = 7;
        const progStart = recentNow - (rank + 1) * 60_000;
        const progEnd = progStart + 30 * 60_000;
        catchupProgress[`${channelKey}|${String(progStart)}`] = {
          channelKey,
          progStart,
          progEnd,
          title: `Program ${String(rank)}`,
          description: `Description ${String(rank)}`,
          icon: '',
          position: 120,
          duration: 1800,
          updatedAt,
          completed: false,
          expiresAt: progEnd + 7 * 24 * 60 * 60 * 1000,
        };
      }
    }
    const account = {
      id: options.accountId,
      name: 'Benchmark',
      url: 'http://host',
      source: 'xtream',
      xtream: { username: 'u', password: 'p' },
    };
    const serializedPlaylists = JSON.stringify([account]);
    localStorage.setItem('iptv_playlists', serializedPlaylists);
    localStorage.setItem('iptv_selectedXtream', JSON.stringify(options.accountId));
    let sourceHash = 2166136261;
    for (let index = 0; index < serializedPlaylists.length; index++) {
      sourceHash ^= serializedPlaylists.charCodeAt(index);
      sourceHash = Math.imul(sourceHash, 16777619);
    }
    const epgSources = [{
        url: options.epgUrl,
        playlistIds: [options.accountId],
        kind: 'm3u',
    }];
    if (!directStorage) {
      localStorage.setItem('iptv_cached_playlist', JSON.stringify({
        version: 2,
        channels,
        epgSources,
        timestamp: Date.now(),
      }));
      localStorage.setItem('iptv_recently_watched_live', JSON.stringify(recentLive));
      localStorage.setItem('iptv_catchup_progress', JSON.stringify(catchupProgress));
    }

    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const base = day.getTime();
    const programs = Array.from({ length: options.scale }, (_, index) => ({
      start: new Date(base + index),
      stop: new Date(base + 60_000 + index),
      title: index === options.scale - 1 ? 'RareProgramNeedle' : `Program ${String(index)}`,
      description: '',
      category: '',
      icon: '',
    }));
    const transitionPrograms = [-1, 0, 1].map((dayOffset) => ({
      start: new Date(base + dayOffset * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000),
      stop: new Date(base + dayOffset * 24 * 60 * 60 * 1000 + 13 * 60 * 60 * 1000),
      title: `Transition ${String(dayOffset + 2)}`,
      description: '',
      category: '',
      icon: '',
    }));
    const categories = Array.from({ length: options.scale }, (_, index) => ({
      id: String(index + 7),
      name: `Category ${String(index + 7)}`,
    }));
    const movies = Array.from({ length: options.scale }, (_, index) => ({
      accountId: options.accountId,
      streamId: String(index),
      name: index === options.scale - 1 ? 'RareMovieNeedle' : `Movie ${String(index)}`,
      poster: '',
      rating: '',
      categoryId: '13',
      containerExtension: 'mp4',
    }));
    const series = Array.from({ length: options.scale }, (_, index) => ({
      accountId: options.accountId,
      seriesId: `s${String(index)}`,
      name: `Series ${String(index)}`,
      poster: '',
      rating: '',
      categoryId: '13',
    }));
    const episodes = Array.from({ length: options.scale }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Episode ${String(index)}`,
      season: 1,
      episode: index + 1,
      containerExtension: 'mp4',
      durationSecs: 1500,
      plot: '',
      poster: '',
      subtitles: [],
    }));

    const fixtureStores = [
      'epg-cache',
      'catalog-cache',
    ];
    if (directStorage) {
      fixtureStores.push(
        'playlist-cache',
        'playback-progress',
        'recently-watched',
        'user-meta',
      );
    }
    const fixtureTx = db.transaction(fixtureStores, 'readwrite');
    fixtureTx.objectStore('epg-cache').put(cacheRecord('epg-cache', 'epg', {
      url: options.epgUrl,
      timestamp: Date.now(),
      data: {
        channels: {
          ch0: { name: 'Channel 0', icon: '' },
          ch1: { name: 'Channel 1', icon: '' },
        },
        programmes: { ch0: programs, ch1: transitionPrograms },
        tzOffsetMinutes: null,
      },
    }));
    if (directStorage) {
      fixtureTx.objectStore('playlist-cache').put(cacheRecord(
        'playlist-cache',
        'playlist',
        {
        key: 'combined',
        timestamp: Date.now(),
        data: {
          version: 2,
          sourceSignature: (sourceHash >>> 0).toString(16),
          channels,
          epgSources,
          timestamp: Date.now(),
        },
        },
      ));
    }
    const catalog = fixtureTx.objectStore('catalog-cache');
    const put = (suffix, data) => catalog.put(cacheRecord('catalog-cache', 'catalog', {
      key: `${options.accountId}|${suffix}`,
      timestamp: Date.now(),
      data,
    }));
    put('vod_categories', categories);
    put('vod_streams|13', movies);
    put('vod_all', movies);
    put('series_categories', categories);
    put('series|13', series);
    put('series_all', series);
    put('series_info|s0', { seasons: [1], episodesBySeason: { 1: episodes } });
    for (let category = 7; category <= 12; category++) {
      put(`vod_streams|${String(category)}`, []);
      put(`series|${String(category)}`, []);
    }
    if (directStorage) {
      const progressStore = fixtureTx.objectStore('playback-progress');
      for (const key of Object.keys(catchupProgress)) {
        const entry = catchupProgress[key];
        progressStore.put({
          key: `catchup:${entry.channelKey}|${String(entry.progStart)}`,
          value: entry,
          updatedAt: entry.updatedAt,
          expiresAt: entry.expiresAt,
        });
      }
      const recentStore = fixtureTx.objectStore('recently-watched');
      for (const entry of recentLive) {
        recentStore.put({
          key: `live:${entry.channelKey}`,
          value: entry,
          updatedAt: entry.updatedAt,
        });
      }
      const userMeta = fixtureTx.objectStore('user-meta');
      for (const key of [
        'favorites',
        'reminders',
        'channel_custom',
        'audio_prefs',
        'subtitle_prefs',
        'subtitle_offsets',
        'resume',
        'watchlist',
        'online_sub_picks',
        'catchup_progress',
        'recently_watched_live',
      ]) {
        userMeta.put({ key: `migration:${key}`, migratedAt: Date.now() });
      }
    }
    await transactionDone(fixtureTx);

    if (directStorage) {
      const usage = {
        playlist: { bytes: 0, entries: 0 },
        epg: { bytes: 0, entries: 0 },
        catalog: { bytes: 0, entries: 0 },
        subtitle: { bytes: 0, entries: 0 },
      };
      for (const { record } of cacheEntries) {
        usage[record.cacheCategory].bytes += record.byteSize;
        usage[record.cacheCategory].entries++;
      }
      const total = Object.keys(usage).reduce((sum, category) => ({
        bytes: sum.bytes + usage[category].bytes,
        entries: sum.entries + usage[category].entries,
      }), { bytes: 0, entries: 0 });
      const metaTx = db.transaction('cache-meta', 'readwrite');
      const meta = metaTx.objectStore('cache-meta');
      const now = Date.now();
      for (const category of Object.keys(usage)) {
        meta.put({ category, ...usage[category], updatedAt: now });
      }
      meta.put({ category: 'total', ...total, updatedAt: now });
      for (const { store, record } of cacheEntries) {
        const key = store === 'epg-cache' ? record.url : record.key;
        meta.put({
          category: `entry:${store}:${String(key)}`,
          cacheCategory: record.cacheCategory,
          store,
          key,
          byteSize: record.byteSize,
          expiresAt: record.expiresAt,
          lastAccessedAt: record.lastAccessedAt,
        });
      }
      meta.put({ category: 'entry-index', version: 1, updatedAt: now });
      await transactionDone(metaTx);
    }
    db.close();
    return { channels: channels.length };
}

export async function rebuildBenchmarkDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iptv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => reject(new Error('Benchmark database rebuild was blocked'));
  });
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('iptv', 4);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cacheStores = [
        ['epg-cache', 'url'],
        ['catalog-cache', 'key'],
        ['subtitle-cache', 'key'],
        ['playlist-cache', 'key'],
        ['stream-mime-cache', 'key'],
      ];
      for (const [name, keyPath] of cacheStores) {
        const store = db.createObjectStore(name, { keyPath });
        store.createIndex('expiresAt', 'expiresAt');
        store.createIndex('lastAccessedAt', 'lastAccessedAt');
      }
      db.createObjectStore('cache-meta', { keyPath: 'category' });
      for (const name of [
        'favorites',
        'reminders',
        'channel-state',
        'watchlist',
        'playback-progress',
        'recently-watched',
        'online-sub-picks',
      ]) {
        const store = db.createObjectStore(name, { keyPath: 'key' });
        if (name === 'watchlist') store.createIndex('scope', 'scope');
        if (name === 'playback-progress') {
          store.createIndex('expiresAt', 'expiresAt');
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (name === 'recently-watched') store.createIndex('updatedAt', 'updatedAt');
      }
      db.createObjectStore('user-meta', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

export function buildM3UFixture(scale) {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < scale; index++) {
    lines.push(
      `#EXTINF:-1 tvg-id="ch${String(index)}" group-title="Group ${String(index % 100)}",Channel ${String(index)}`,
      `http://host/${String(index)}`,
    );
  }
  return lines.join('\n');
}

export function installColdLoadFixture(options) {
  localStorage.setItem('iptv_playlists', JSON.stringify([{
    id: options.accountId,
    name: 'Benchmark',
    url: options.url,
    source: 'url',
  }]));
  localStorage.removeItem('iptv_selectedXtream');
  localStorage.removeItem('iptv_cached_playlist');
  localStorage.removeItem('iptv_epg_sources');
  return { playlists: 1 };
}

export async function measureStartupHoverBenchmark() {
  const target = document.querySelector('.channel-main .channel-item');
  if (!target) throw new Error('Missing channel row for startup hover benchmark');
  const started = performance.now();
  target.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  const focusedSynchronously = target.classList.contains('focused');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return {
    hoverFrameMs: Math.round((performance.now() - started) * 10) / 10,
    focusedSynchronously,
    focusedAtFrame: target.classList.contains('focused'),
  };
}

export function assertStartupHoverBenchmark(report) {
  if (!report.focusedSynchronously || !report.focusedAtFrame) {
    throw new Error('Startup hover did not focus the channel row before its next frame');
  }
  if (!Number.isFinite(report.hoverFrameMs) || report.hoverFrameMs < 0) {
    throw new Error(`Invalid startup hover frame time: ${String(report.hoverFrameMs)}`);
  }
}

export async function preparePointerBenchmark() {
  const waitFor = async (selector, timeout = 30_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = document.querySelector(selector);
      if (element && !element.classList.contains('hidden')) return element;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${selector}`);
  };
  const live = document.querySelector('[data-section="live"]');
  if (!live) throw new Error('Missing Live section for pointer benchmark');
  const liveRect = live.getBoundingClientRect();
  live.dispatchEvent(new MouseEvent('click', {
    clientX: liveRect.left + liveRect.width / 2,
    clientY: liveRect.top + liveRect.height / 2,
    bubbles: true,
  }));
  await waitFor('#view-channels:not(.hidden)');
  const target = document.querySelector('.group-item[data-group="source:Group 1"]');
  if (!target) throw new Error('Missing large group for pointer benchmark');
  const eventNames = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
  ];
  window.__IPTV_POINTER_EVENTS__ = [];
  for (const name of eventNames) {
    document.addEventListener(name, (event) => {
      const eventTarget = event.target instanceof Element
        ? event.target.closest('.group-item[data-group="source:Group 1"]')
        : null;
      if (eventTarget) {
        window.__IPTV_POINTER_EVENTS__.push({
          name,
          trusted: event.isTrusted,
        });
      }
    }, { capture: true, once: true });
  }
  const rect = target.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

export async function inspectPointerBenchmark() {
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const totalSize = parseFloat(
    document.querySelector('.channel-list-spacer')?.style.height || '0',
  );
  return {
    events: window.__IPTV_POINTER_EVENTS__ || [],
    activeGroup: document.querySelector(
      '.group-item.active[data-group="source:Group 1"]',
    ) !== null,
    channels: Math.round(totalSize / 88),
    rendered: document.querySelectorAll('.channel-main .channel-item').length,
    documentAlive: document.documentElement.isConnected,
  };
}

export function assertPointerBenchmark(report, scale) {
  const expectedEvents = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click',
  ];
  const actualEvents = report.events.map((event) => event.name);
  if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) {
    throw new Error(`Pointer event sequence mismatch: ${JSON.stringify(actualEvents)}`);
  }
  if (report.events.some((event) => !event.trusted)) {
    throw new Error('Pointer benchmark did not receive trusted browser input');
  }
  if (!report.activeGroup || report.channels !== Math.ceil((scale - 1) / 100)
      || report.rendered < 1) {
    throw new Error('Pointer activation did not select the large channel group');
  }
  if (!report.documentAlive) throw new Error('App document terminated during pointer benchmark');
}

export async function cleanupBenchmarkFixture(options) {
    const openDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('iptv');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const requestValue = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transactionDone = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    const db = await openDb();
    const readTx = db.transaction('catalog-cache', 'readonly');
    const backupEntry = await requestValue(
      readTx.objectStore('catalog-cache').get(options.backupKey),
    );
    if (backupEntry && backupEntry.data) {
      const backupData = backupEntry.data.localStorage
        ? backupEntry.data.localStorage
        : backupEntry.data;
      localStorage.clear();
      for (const key of Object.keys(backupData)) {
        const value = backupData[key];
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }

    const cleanupStores = ['epg-cache', 'catalog-cache'];
    for (const store of [
      'playlist-cache',
      'recently-watched',
      'playback-progress',
      'cache-meta',
    ]) {
      if (db.objectStoreNames.contains(store)) cleanupStores.push(store);
    }
    const cleanupTx = db.transaction(cleanupStores, 'readwrite');
    cleanupTx.objectStore('epg-cache').delete(options.epgUrl);
    const catalog = cleanupTx.objectStore('catalog-cache');
    const cursorRequest = catalog.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const key = String(cursor.key);
      if (key === options.backupKey || key.indexOf(`${options.accountId}|`) === 0) {
        cursor.delete();
      }
      cursor.continue();
    };
    if (cleanupStores.indexOf('playlist-cache') >= 0) {
      const playlist = cleanupTx.objectStore('playlist-cache');
      const savedPlaylist = backupEntry?.data?.playlistCache;
      if (savedPlaylist) playlist.put(savedPlaylist);
      else playlist.delete('combined');
    }
    if (cleanupStores.indexOf('cache-meta') >= 0
        && Array.isArray(backupEntry?.data?.cacheMeta)) {
      const meta = cleanupTx.objectStore('cache-meta');
      meta.clear();
      for (const record of backupEntry.data.cacheMeta) meta.put(record);
    }
    const benchmarkChannelKeys = new Set();
    const fnv1a = (value) => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    for (let index = 0; index < 50; index++) {
      benchmarkChannelKeys.add(fnv1a(`http://host/${String(index)}`));
    }
    if (cleanupStores.indexOf('recently-watched') >= 0
        && Array.isArray(backupEntry?.data?.recentlyWatched)) {
      const recent = cleanupTx.objectStore('recently-watched');
      recent.clear();
      for (const record of backupEntry.data.recentlyWatched) recent.put(record);
    } else if (cleanupStores.indexOf('recently-watched') >= 0) {
      const recent = cleanupTx.objectStore('recently-watched');
      for (const key of benchmarkChannelKeys) recent.delete(`live:${key}`);
    }
    if (cleanupStores.indexOf('playback-progress') >= 0
        && Array.isArray(backupEntry?.data?.playbackProgress)) {
      const progress = cleanupTx.objectStore('playback-progress');
      progress.clear();
      for (const record of backupEntry.data.playbackProgress) progress.put(record);
    } else if (cleanupStores.indexOf('playback-progress') >= 0) {
      const progressCursor = cleanupTx.objectStore('playback-progress').openCursor();
      progressCursor.onsuccess = () => {
        const cursor = progressCursor.result;
        if (!cursor) return;
        const channelKey = cursor.value?.value?.channelKey;
        if (benchmarkChannelKeys.has(channelKey)) cursor.delete();
        cursor.continue();
      };
    }
    await transactionDone(cleanupTx);
    db.close();
    return { restored: Boolean(backupEntry) };
}

export function runRawParserBenchmarks(options) {
    const api = window.__IPTV_BENCHMARK__;
    if (!api) throw new Error('Benchmark parser API is unavailable');
    const round = (value) => Math.round(value * 10) / 10;
    const two = (value) => `0${String(value)}`.slice(-2);
    const xmltvTime = (value) => {
      const date = new Date(value);
      return `${String(date.getUTCFullYear())}${two(date.getUTCMonth() + 1)}`
        + `${two(date.getUTCDate())}${two(date.getUTCHours())}`
        + `${two(date.getUTCMinutes())}${two(date.getUTCSeconds())} +0000`;
    };

    const m3uLines = ['#EXTM3U'];
    for (let index = 0; index < options.scale; index++) {
      m3uLines.push(
        `#EXTINF:-1 tvg-id="ch${String(index)}" group-title="Group ${String(index % 100)}",Channel ${String(index)}`,
        `http://host/${String(index)}`,
      );
    }
    const m3uText = m3uLines.join('\n');
    let started = performance.now();
    const m3uResult = api.parseM3U(m3uText);
    const m3uDuration = performance.now() - started;

    const base = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const xmltvParts = [
      '<tv><channel id="ch1"><display-name>Alpha</display-name></channel>',
    ];
    for (let index = 0; index < options.scale; index++) {
      const start = base + index * 20_000;
      xmltvParts.push(
        `<programme start="${xmltvTime(start)}" stop="${xmltvTime(start + 20_000)}" channel="ch1">`,
        `<title>Program ${String(index)}</title><desc>Description ${String(index)}</desc></programme>`,
      );
    }
    xmltvParts.push('</tv>');
    const xmltvText = xmltvParts.join('');
    started = performance.now();
    const xmltvResult = api.parseXMLTV(xmltvText);
    const xmltvDuration = performance.now() - started;

    return {
      m3u: {
        durationMs: round(m3uDuration),
        bytes: m3uText.length,
        channels: m3uResult.channels,
        groups: m3uResult.groups || 0,
      },
      xmltv: {
        durationMs: round(xmltvDuration),
        bytes: xmltvText.length,
        channels: xmltvResult.channels,
        programmes: xmltvResult.programmes || 0,
      },
    };
}

/**
 * Build a provider-shaped guide once: many channels, realistic programme
 * bodies, and the subset of channels a playlist would keep. The feed and the
 * parse result are retained on `window` so the caller can force GC between
 * steps and attribute retained heap to each pass.
 */
export function prepareXMLTVCatalogBenchmark(options) {
    const two = (value) => `0${String(value)}`.slice(-2);
    const xmltvTime = (value) => {
      const date = new Date(value);
      return `${String(date.getUTCFullYear())}${two(date.getUTCMonth() + 1)}`
        + `${two(date.getUTCDate())}${two(date.getUTCHours())}`
        + `${two(date.getUTCMinutes())}${two(date.getUTCSeconds())} +0000`;
    };
    const sourceChannels = Math.max(2, Math.round(options.scale / 25));
    const slots = Math.max(1, Math.round(options.scale / sourceChannels));
    const keptChannels = Math.max(1, Math.round(sourceChannels * 0.15));
    const base = Date.now() - 6 * 24 * 60 * 60 * 1000;

    const parts = ['<tv>'];
    for (let index = 0; index < sourceChannels; index++) {
      parts.push(
        `<channel id="ch${String(index)}"><display-name>Channel ${String(index)}</display-name>`,
        `<icon src="http://host/logo/${String(index)}.png" /></channel>`,
      );
    }
    for (let index = 0; index < sourceChannels; index++) {
      for (let slot = 0; slot < slots; slot++) {
        const start = base + slot * 20_000;
        parts.push(
          `<programme start="${xmltvTime(start)}" stop="${xmltvTime(start + 20_000)}"`,
          ` channel="ch${String(index)}"><title>Program ${String(index)}-${String(slot)}</title>`,
          `<desc>Synthetic description for slot ${String(slot)} of channel ${String(index)}, `,
          'padded to the length a real guide carries so programme bodies cost ',
          'what they cost in production.</desc>',
          `<category>Category ${String(index % 12)}</category>`,
          `<icon src="http://host/img/${String(index)}-${String(slot)}.png" /></programme>`,
        );
      }
    }
    parts.push('</tv>');

    // Half the retained playlist carries no tvg-id, so it must match by name.
    const channelIds = [];
    const channelNames = [];
    for (let index = 0; index < keptChannels; index++) {
      if (index % 2 === 0) channelIds.push(`ch${String(index)}`);
      channelNames.push(`channel ${String(index)}`);
    }

    const state = { text: parts.join(''), channelIds, channelNames, retained: null };
    window.__IPTV_CATALOG_BENCHMARK__ = state;
    return {
      bytes: state.text.length,
      sourceChannels,
      keptChannels,
      programmes: sourceChannels * slots,
    };
}

export function runXMLTVCatalogPass(options) {
    const api = window.__IPTV_BENCHMARK__;
    const state = window.__IPTV_CATALOG_BENCHMARK__;
    if (!api || !state) throw new Error('Catalog benchmark was not prepared');
    const filter = options.filtered
      ? { channelIds: state.channelIds, channelNames: state.channelNames }
      : undefined;
    const started = performance.now();
    const result = api.parseXMLTV(state.text, filter);
    const durationMs = performance.now() - started;
    state.retained = result.retained;
    return {
      durationMs: Math.round(durationMs * 10) / 10,
      channels: result.channels,
      programmes: result.programmes || 0,
      programmesSeen: result.programmesSeen || 0,
    };
}

export function releaseXMLTVCatalogPass() {
    const state = window.__IPTV_CATALOG_BENCHMARK__;
    if (state) state.retained = null;
    return { released: true };
}

export function disposeXMLTVCatalogBenchmark() {
    window.__IPTV_CATALOG_BENCHMARK__ = undefined;
    return { disposed: true };
}

/**
 * Drive the catalog passes from the runner so each parse can be bracketed by a
 * forced GC and a heap reading; retained heap is the point of the filter.
 */
export async function measureXMLTVCatalogBenchmark(scale, io) {
  const meta = await io.evaluate(prepareXMLTVCatalogBenchmark, { scale });
  const pass = async (filtered) => {
    await io.collectGarbage();
    const before = await io.heapUsed();
    const result = await io.evaluate(runXMLTVCatalogPass, { filtered });
    await io.collectGarbage();
    result.retainedBytes = (await io.heapUsed()) - before;
    await io.evaluate(releaseXMLTVCatalogPass);
    return result;
  };
  const unfiltered = await pass(false);
  const filtered = await pass(true);
  await io.evaluate(disposeXMLTVCatalogBenchmark);
  await io.collectGarbage();
  return {
    bytes: meta.bytes,
    sourceChannels: meta.sourceChannels,
    keptChannels: meta.keptChannels,
    unfiltered,
    filtered,
    speedup: unfiltered.durationMs / filtered.durationMs,
    retainedHeapReductionPct: unfiltered.retainedBytes > 0
      ? (1 - filtered.retainedBytes / unfiltered.retainedBytes) * 100
      : 0,
  };
}

export async function runViewReopenCycle() {
    const waitFor = async (selector, timeout = 30_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const element = document.querySelector(selector);
        if (element && !element.classList.contains('hidden')) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${selector}`);
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
    const key = (name, code) => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: name,
        keyCode: code,
        bubbles: true,
      }));
    };
    const settle = () => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)));

    click('[data-section="live"]');
    await waitFor('#view-channels:not(.hidden)');
    key('Enter', 13);
    await waitFor('#view-player:not(.hidden)');
    key('Backspace', 461);
    await waitFor('#view-channels:not(.hidden)');
    key('', 403);
    await waitFor('#view-epg:not(.hidden)');
    key('Backspace', 461);
    await waitFor('#view-channels:not(.hidden)');

    click('[data-section="movies"]');
    await waitFor('#view-movies:not(.hidden)');
    click('[data-section="series"]');
    await waitFor('#view-series:not(.hidden)');
    if (document.querySelector('.tab-bar-search')?.classList.contains('expanded')) {
      click('[data-section="search"]');
      await settle();
    }
    click('[data-section="search"]');
    const searchInput = document.querySelector('.tab-bar-search-input');
    searchInput.value = 'zzzz-no-match';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor('#view-search:not(.hidden)');
    click('[data-section="live"]');
    await waitFor('#view-channels:not(.hidden)');
    await settle();
    return { nodes: document.getElementsByTagName('*').length };
}

export async function installUniqueGroupFixture(scale) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('iptv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const tx = db.transaction('playlist-cache', 'readwrite');
  const store = tx.objectStore('playlist-cache');
  const cached = await new Promise((resolve, reject) => {
    const request = store.get('combined');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  if (!cached || !cached.data || !Array.isArray(cached.data.channels)
      || cached.data.channels.length !== scale) {
    db.close();
    throw new Error('Cannot install unique groups without the channel fixture');
  }
  for (let index = 0; index < cached.data.channels.length; index++) {
    cached.data.channels[index].group = `Group ${String(index)}`;
  }
  cached.byteSize = 0;
  cached.byteSize = new TextEncoder().encode(JSON.stringify(cached)).byteLength;
  store.put(cached);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return {
    channels: cached.data.channels.length,
    groups: cached.data.channels.length,
  };
}

export async function installM3USearchFixture() {
  const playlists = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
  if (!Array.isArray(playlists) || playlists.length !== 1) {
    throw new Error('M3U Search benchmark requires one fixture playlist');
  }
  const playlist = {
    id: playlists[0].id,
    name: playlists[0].name,
    url: 'http://host/list.m3u',
    source: 'url',
  };
  const serializedPlaylists = JSON.stringify([playlist]);
  localStorage.setItem('iptv_playlists', serializedPlaylists);
  localStorage.removeItem('iptv_selectedXtream');

  let hash = 2166136261;
  for (let index = 0; index < serializedPlaylists.length; index++) {
    hash ^= serializedPlaylists.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const sourceSignature = (hash >>> 0).toString(16);
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('iptv');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const tx = db.transaction('playlist-cache', 'readwrite');
  const store = tx.objectStore('playlist-cache');
  const cached = await new Promise((resolve, reject) => {
    const request = store.get('combined');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  if (!cached || !cached.data || !Array.isArray(cached.data.channels)) {
    db.close();
    throw new Error('M3U Search benchmark requires a cached playlist fixture');
  }
  cached.data.sourceSignature = sourceSignature;
  cached.byteSize = 0;
  cached.byteSize = new TextEncoder().encode(JSON.stringify(cached)).byteLength;
  store.put(cached);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return { playlists: 1 };
}

export async function runM3USearchBenchmark(options) {
  if (document.querySelector('[data-section="movies"]')
      || document.querySelector('[data-section="series"]')) {
    throw new Error('M3U Search fixture unexpectedly exposes Xtream sections');
  }
  const round = (value) => Math.round(value * 10) / 10;
  const distribution = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      p50: round(sorted[Math.floor(sorted.length * 0.5)] || 0),
      p95: round(sorted[Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      )] || 0),
      max: round(sorted[sorted.length - 1] || 0),
      mean: round(sum / Math.max(1, values.length)),
    };
  };
  const waitFor = async (selector, timeout = 30_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = document.querySelector(selector);
      if (element && !element.classList.contains('hidden')) return element;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${selector}`);
  };
  const icon = document.querySelector('[data-section="search"]');
  if (!icon) throw new Error('Missing M3U Search icon');
  const clickIcon = () => {
    const rect = icon.getBoundingClientRect();
    icon.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
    }));
  };
  const initialOpenStarted = performance.now();
  clickIcon();
  const initialOpenMs = round(performance.now() - initialOpenStarted);
  const input = document.querySelector('.tab-bar-search-input');
  const openValues = [];
  for (let index = 0; index < options.querySamples; index++) {
    if (document.querySelector('.tab-bar-search')?.classList.contains('expanded')) {
      clickIcon();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const started = performance.now();
    clickIcon();
    openValues.push(performance.now() - started);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  const queryDistribution = async (query) => {
    const values = [];
    for (let index = 0; index < options.querySamples; index++) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      input.value = query;
      const started = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => {
        values.push(performance.now() - started);
        resolve();
      }));
    }
    return distribution(values);
  };
  input.value = 'channel';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor('#view-search:not(.hidden)');
  input.value = 'rareprogramneedle';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor('#view-search .search-program-row');
  const queries = {
    channelsBroad: await queryDistribution('channel'),
    channelsSparse: await queryDistribution('rarechannelneedle'),
    programsBroad: await queryDistribution('program'),
    programsSparse: await queryDistribution('rareprogramneedle'),
    noMatch: await queryDistribution('zzzz-no-match'),
  };
  input.value = 'rarechannelneedle';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const sparseSearch = {
    channels: document.querySelectorAll('.search-channel-row').length,
    programs: 0,
  };
  input.value = 'rareprogramneedle';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  sparseSearch.programs = document.querySelectorAll('.search-program-row').length;
  input.value = 'program';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return {
    initialOpenMs,
    open: distribution(openValues),
    queries,
    renderedChannels: document.querySelectorAll('.search-channel-row').length,
    renderedPrograms: document.querySelectorAll('.search-program-row').length,
    sparseSearch,
    renderedCatalogSections: document.querySelectorAll(
      '[data-search-virtual="movies"], [data-search-virtual="series"]',
    ).length,
  };
}

export function assertM3USearchBenchmark(report) {
  if (!(report.renderedPrograms > 0 && report.renderedPrograms < 30)) {
    throw new Error(
      `M3U Search mounted ${String(report.renderedPrograms)} program rows; expected 1-29`,
    );
  }
  if (report.renderedCatalogSections !== 0) {
    throw new Error('M3U Search rendered Xtream catalog sections');
  }
  if (report.sparseSearch.channels !== 1 || report.sparseSearch.programs !== 1) {
    throw new Error('M3U Search sparse queries did not return exactly one result');
  }
}

export async function runGroupBenchmark(options) {
  const round = (value) => Math.round(value * 10) / 10;
  const distribution = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      p50: round(sorted[Math.floor(sorted.length * 0.5)] || 0),
      p95: round(sorted[Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      )] || 0),
      max: round(sorted[sorted.length - 1] || 0),
      mean: round(sum / Math.max(1, values.length)),
    };
  };
  const pixelSize = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return '';
    const numeric = parseFloat(element.style.height);
    return `${String(Math.round(numeric)).replace(/\B(?=(\d{3})+(?!\d))/g, '_')}px`;
  };
  const waitFor = async (selector, timeout = 30_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = document.querySelector(selector);
      if (element && !element.classList.contains('hidden')) return element;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${selector}`);
  };
  const key = (name, code) => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: name,
      keyCode: code,
      bubbles: true,
    }));
  };
  const measureKeys = async (name, code) => {
    const handlerValues = [];
    const frameValues = [];
    for (let index = 0; index < options.keySamples; index++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const started = performance.now();
      key(name, code);
      handlerValues.push(performance.now() - started);
      await new Promise((resolve) => requestAnimationFrame(() => {
        frameValues.push(performance.now() - started);
        resolve();
      }));
    }
    return {
      ...distribution(handlerValues),
      frame: distribution(frameValues),
      framesOver50Ms: frameValues.filter(value => value > 50).length,
    };
  };

  const firstGroup = document.querySelector('.group-item[data-group-position="0"]');
  if (!firstGroup) throw new Error('Channel List group window is empty');
  firstGroup.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  const channelList = {
    rendered: document.querySelectorAll('.group-list .group-item').length,
    totalSize: pixelSize('.group-list-spacer'),
    navigation: await measureKeys('ArrowDown', 40),
  };

  document.querySelector('.channel-item')?.dispatchEvent(
    new CustomEvent('nav:hover', { bubbles: true }),
  );
  key('Enter', 13);
  await waitFor('#view-player:not(.hidden)');
  key('ArrowLeft', 37);
  await waitFor('#player-sidebar:not(.hidden)');
  key('ArrowLeft', 37);
  const sidebar = {
    rendered: document.querySelectorAll('.sidebar-group-item').length,
    totalSize: pixelSize('.sidebar-group-spacer'),
    navigation: await measureKeys('ArrowDown', 40),
  };
  key('ArrowRight', 39);
  key('Backspace', 461);
  key('Backspace', 461);
  await waitFor('#view-channels:not(.hidden)');

  key('', 403);
  await waitFor('#view-epg:not(.hidden)');
  key('ArrowLeft', 37);
  await waitFor('.epg-group-menu');
  const epg = {
    rendered: document.querySelectorAll('.epg-group-option').length,
    totalSize: pixelSize('.epg-group-options-spacer'),
    navigation: await measureKeys('ArrowDown', 40),
  };
  key('Backspace', 461);
  key('Backspace', 461);
  await waitFor('#view-channels:not(.hidden)');

  return { channelList, sidebar, epg };
}

export function summarizeRetainedMemory(beforeBytes, cycleBytes) {
  const toMiB = (value) => Math.round(value / 1_048_576 * 10) / 10;
  const samplesMiB = cycleBytes.map(toMiB);
  return {
    cycles: cycleBytes.length,
    beforeMiB: toMiB(beforeBytes),
    samplesMiB,
    growthMiB: samplesMiB.length > 1
      ? Math.round((samplesMiB[samplesMiB.length - 1] - samplesMiB[0]) * 10) / 10
      : 0,
  };
}

export function assertXMLTVCatalogBenchmark(catalog) {
  if (catalog.unfiltered.channels !== catalog.sourceChannels
      || catalog.filtered.programmesSeen !== catalog.unfiltered.programmes) {
    throw new Error('Filtered XMLTV benchmark did not read the same source feed');
  }
  if (catalog.filtered.channels !== catalog.keptChannels
      || catalog.filtered.programmes >= catalog.unfiltered.programmes) {
    throw new Error('XMLTV channel filter did not retain the expected playlist subset');
  }
  if (!(catalog.filtered.retainedBytes < catalog.unfiltered.retainedBytes)) {
    throw new Error('Filtered XMLTV parse did not reduce retained heap');
  }
}

export function assertRetainedMemory(report) {
  if (report.samplesMiB.length < 3) {
    throw new Error('Retained-memory validation requires at least three reopen cycles');
  }
  const allowance = Math.max(5, report.samplesMiB[0] * 0.05);
  if (report.growthMiB > allowance) {
    throw new Error(
      `View reopen retained ${String(report.growthMiB)} MiB; allowance is ${allowance.toFixed(1)} MiB`,
    );
  }
}

export function assertGroupBenchmarkScale(report, scale) {
  const closeTo = (actual, expected) => {
    const numeric = parseFloat(String(actual).replace(/_/g, ''));
    if (Math.abs(numeric - expected) > 32) {
      throw new Error(`Expected group extent ${String(expected)}, received ${actual}`);
    }
  };
  const bounded = (name, count) => {
    if (!(count > 0 && count < 60)) {
      throw new Error(`${name} mounted ${String(count)} group nodes; expected 1-59`);
    }
  };
  bounded('Channel List', report.channelList.rendered);
  bounded('Sidebar', report.sidebar.rendered);
  bounded('EPG', report.epg.rendered);
  closeTo(report.channelList.totalSize, (scale + 3) * 68);
  closeTo(report.sidebar.totalSize, (scale + 3) * 64);
  closeTo(report.epg.totalSize, (scale + 2) * 44);
}

export async function runBenchmarkSuites(options) {
    const watchdogIntervalMs = 100;
    let watchdogLast = performance.now();
    let watchdogMaxGapMs = 0;
    let watchdogHeartbeats = 0;
    const watchdogTimer = setInterval(() => {
      const now = performance.now();
      watchdogMaxGapMs = Math.max(watchdogMaxGapMs, now - watchdogLast);
      watchdogLast = now;
      watchdogHeartbeats++;
    }, watchdogIntervalMs);
    const round = (value) => Math.round(value * 10) / 10;
    const distribution = (values) => {
      const sorted = values.slice().sort((a, b) => a - b);
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        p50: round(sorted[Math.floor(sorted.length * 0.5)] || 0),
        p95: round(sorted[Math.min(
          sorted.length - 1,
          Math.floor(sorted.length * 0.95),
        )] || 0),
        max: round(sorted[sorted.length - 1] || 0),
        mean: round(sum / Math.max(1, values.length)),
      };
    };
    const pixelSize = (selector, property) => {
      const element = document.querySelector(selector);
      if (!element) return '';
      const numeric = parseFloat(element.style[property]);
      if (!Number.isFinite(numeric)) return element.style[property] || '';
      const formatted = String(Math.round(numeric)).replace(
        /\B(?=(\d{3})+(?!\d))/g,
        '_',
      );
      return `${formatted}px`;
    };
    const waitFor = async (selector, timeout = 30_000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const element = document.querySelector(selector);
        if (element && !element.classList.contains('hidden')) return element;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for ${selector}`);
    };
    const key = (name, code) => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: name,
        keyCode: code,
        bubbles: true,
      }));
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
    const settle = () => new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const assertWindow = (selector, name) => {
      const mounted = document.querySelectorAll(selector);
      if (!mounted.length) throw new Error(`${name} virtual window is blank`);
      return mounted.length;
    };
    const activateGroup = async (group) => {
      const item = document.querySelector(`.group-item[data-group="${group}"]`);
      if (!item) throw new Error(`Missing benchmark group ${group}`);
      item.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      key('Enter', 13);
      await settle();
      return {
        group,
        rendered: assertWindow('.channel-main .channel-item', `Group ${group}`),
        totalSize: pixelSize('.channel-list-spacer', 'height'),
        channels: Math.round(
          parseFloat(
            document.querySelector('.channel-list-spacer')?.style.height || '0',
          ) / 88,
        ),
      };
    };
    const longTaskDurations = [];
    let longTaskObserver = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => longTaskDurations.push(entry.duration));
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    }
    const measureKeys = async (name, code) => {
      const handlerValues = [];
      const frameValues = [];
      for (let i = 0; i < options.keySamples; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const started = performance.now();
        key(name, code);
        handlerValues.push(performance.now() - started);
        await new Promise((resolve) => requestAnimationFrame(() => {
          frameValues.push(performance.now() - started);
          resolve();
        }));
      }
      return {
        ...distribution(handlerValues),
        frame: distribution(frameValues),
        framesOver50Ms: frameValues.filter(value => value > 50).length,
      };
    };
    const queryDistribution = async (query) => {
      const input = document.querySelector('.tab-bar-search-input');
      const values = [];
      for (let i = 0; i < options.querySamples; i++) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        input.value = query;
        const started = performance.now();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => {
          values.push(performance.now() - started);
          resolve();
        }));
      }
      return distribution(values);
    };
    const searchOpenDistribution = async () => {
      const icon = document.querySelector('[data-section="search"]');
      const slot = document.querySelector('.tab-bar-search');
      const values = [];
      const clickIcon = () => {
        const rect = icon.getBoundingClientRect();
        icon.dispatchEvent(new MouseEvent('click', {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
        }));
      };
      for (let i = 0; i < options.querySamples; i++) {
        if (slot.classList.contains('expanded')) clickIcon();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const started = performance.now();
        clickIcon();
        values.push(performance.now() - started);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return distribution(values);
    };

    const channelList = {
      rendered: document.querySelectorAll('#view-channels .channel-item').length,
      totalSize: pixelSize('.channel-list-spacer', 'height'),
      navigation: await measureKeys('ArrowDown', 40),
    };
    for (let i = 0; i < options.keySamples; i++) key('ArrowUp', 38);
    const channelScroller = document.querySelector('.channel-main');
    const wheelTarget = document.querySelector('.channel-main .channel-item');
    if (!wheelTarget) throw new Error('Channel List virtual window is blank before wheel scrolling');
    wheelTarget.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    channelScroller.scrollTop = 88 * 10_000;
    channelScroller.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 88 * 10_000,
      bubbles: true,
    }));
    channelScroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    key('ArrowDown', 40);
    await settle();
    const wheelFocus = document.querySelector('.channel-main .channel-item.focused');
    const wheelToDpad = {
      rendered: assertWindow(
        '.channel-main .channel-item',
        'Channel List after wheel-to-D-pad',
      ),
      focusedConnected: Boolean(wheelFocus?.isConnected),
    };
    if (!wheelToDpad.focusedConnected) {
      throw new Error('Wheel-to-D-pad navigation left focus detached');
    }
    channelScroller.scrollTop = 0;
    channelScroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    const groupSwitchValues = [];
    const groupSwitchStates = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const group of ['builtin:all', 'source:Group 1', 'source:Small Group']) {
        const started = performance.now();
        groupSwitchStates.push(await activateGroup(group));
        groupSwitchValues.push(performance.now() - started);
      }
    }
    await activateGroup('builtin:all');
    const groupSwitching = {
      ...distribution(groupSwitchValues),
      states: groupSwitchStates,
    };

    const recentGroup = document.querySelector(
      '.group-item[data-group="builtin:recently-watched"]',
    );
    recentGroup.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    key('Enter', 13);
    await waitFor('.recent-item');
    const recentlyWatched = {
      rendered: document.querySelectorAll('.recent-item').length,
      liveRendered: document.querySelectorAll('.recent-live').length,
      catchupRendered: document.querySelectorAll('.recent-catchup').length,
      navigation: await measureKeys('ArrowDown', 40),
    };
    const allGroup = document.querySelector('.group-item[data-group="builtin:all"]');
    allGroup.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    key('Enter', 13);
    await waitFor('.channel-item:not(.recent-item)');

    document.querySelector('.channel-item:not(.recent-item)').dispatchEvent(
      new CustomEvent('nav:hover', { bubbles: true }),
    );
    key('Enter', 13);
    await waitFor('#view-player:not(.hidden)');
    const sidebarStarted = performance.now();
    key('ArrowLeft', 37);
    await waitFor('#player-sidebar:not(.hidden)');
    document.querySelectorAll('#player-sidebar .ch-logo-wrap')
      .forEach((spacer, index) => {
        if (index >= 12) return;
        spacer.textContent = '';
        spacer.dataset.logoSrc =
          `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=#${String(index)}`;
      });
    const initialLogoSpacers = document.querySelectorAll(
      '#player-sidebar .ch-logo-wrap[data-logo-src]',
    ).length;
    const initialLogoImages = document.querySelectorAll(
      '#player-sidebar img.ch-logo[src]',
    ).length;
    const invalidLogoImages = document.querySelectorAll(
      '#player-sidebar img.ch-logo:not([src])',
    ).length;
    const sidebarElement = document.querySelector('#player-sidebar');
    const transitionEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(transitionEnd, 'propertyName', { value: 'transform' });
    sidebarElement.dispatchEvent(transitionEnd);
    const logoFrameValues = [];
    const logoCounts = [document.querySelectorAll(
      '#player-sidebar img.ch-logo[src]',
    ).length];
    for (let frame = 0; frame < 24; frame++) {
      const started = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      logoFrameValues.push(performance.now() - started);
      logoCounts.push(document.querySelectorAll(
        '#player-sidebar img.ch-logo[src]',
      ).length);
    }
    let maxLogosPerFrame = 0;
    for (let index = 1; index < logoCounts.length; index++) {
      maxLogosPerFrame = Math.max(
        maxLogosPerFrame,
        logoCounts[index] - logoCounts[index - 1],
      );
    }
    const sidebar = {
      openMs: round(performance.now() - sidebarStarted),
      rendered: document.querySelectorAll('.sidebar-ch-item').length,
      totalSize: pixelSize('.sidebar-channel-spacer', 'height'),
      navigation: await measureKeys('ArrowDown', 40),
      logoReveal: {
        initialSpacers: initialLogoSpacers,
        initialImages: initialLogoImages,
        invalidImages: invalidLogoImages,
        revealed: logoCounts[logoCounts.length - 1],
        maxPerFrame: maxLogosPerFrame,
        frame: distribution(logoFrameValues),
      },
    };
    key('Backspace', 461);
    key('Backspace', 461);
    await waitFor('#view-channels:not(.hidden)');

    const epgLongTasks = [];
    let epgLongTaskObserver = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        epgLongTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => epgLongTasks.push(entry.duration));
        });
        epgLongTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        epgLongTaskObserver = null;
      }
    }
    const epgStarted = performance.now();
    key('', 403);
    await waitFor('#view-epg:not(.hidden)');
    const epgOpenMs = round(performance.now() - epgStarted);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const epgFirstFrameMs = round(performance.now() - epgStarted);
    if (epgLongTaskObserver) {
      epgLongTaskObserver.takeRecords()
        .forEach((entry) => epgLongTasks.push(entry.duration));
      epgLongTaskObserver.disconnect();
    }
    const epgMaxLongTaskMs = round(
      epgLongTasks.length ? Math.max(...epgLongTasks) : 0,
    );
    await waitFor('.epg-programme-item');
    click('#epg-channels [data-channel-idx="1"]');
    await settle();
    const epgChannelTransition = {
      selected: document.querySelector(
        '#epg-channels [data-channel-idx="1"].selected',
      ) !== null,
      renderedPrograms: assertWindow(
        '#epg-programmes .epg-programme-item',
        'EPG channel transition',
      ),
    };
    const dateItems = document.querySelectorAll('#epg-dates [data-day-index]');
    if (dateItems.length < 3) throw new Error('EPG benchmark requires three date options');
    const epgDateTitles = [];
    for (let dayIndex = 0; dayIndex < 3; dayIndex++) {
      click(`#epg-dates [data-day-index="${String(dayIndex)}"]`);
      await settle();
      epgDateTitles.push(
        document.querySelector('#epg-programmes .epg-prog-title')?.textContent?.trim() || '',
      );
    }
    if (new Set(epgDateTitles).size !== 3) {
      throw new Error('EPG date transitions did not render three distinct schedules');
    }
    click('#epg-dates [data-day-index="1"]');
    click('#epg-channels [data-channel-idx="0"]');
    await settle();
    key('ArrowRight', 39);
    const epgPrograms = {
      rendered: document.querySelectorAll('.epg-programme-item').length,
      totalSize: pixelSize(
        '#epg-programmes .epg-virtual-spacer',
        'height',
      ),
      navigation: await measureKeys('ArrowDown', 40),
    };
    key('ArrowLeft', 37);
    const epgChannels = {
      rendered: document.querySelectorAll('.epg-channel-item').length,
      totalSize: pixelSize(
        '#epg-channels .epg-virtual-spacer',
        'height',
      ),
      navigation: await measureKeys('ArrowDown', 40),
    };
    key('Backspace', 461);
    await waitFor('#view-channels:not(.hidden)');

    const moviesStarted = performance.now();
    click('[data-section="movies"]');
    await waitFor('#view-movies:not(.hidden)');
    await waitFor('#view-movies .catalog-cat[data-category-id="13"]');
    const moviesOpenMs = round(performance.now() - moviesStarted);
    const movieCategoryRendered = document.querySelectorAll(
      '#view-movies .catalog-category-rail-cell',
    ).length;
    const movieCategoryTotalSize = pixelSize(
      '#view-movies .catalog-category-rail-spacer',
      'width',
    );
    const moviesGridStarted = performance.now();
    click('#view-movies .catalog-cat[data-category-id="13"]');
    await waitFor('#view-movies .catalog-grid-cell');
    const movies = {
      openMs: moviesOpenMs,
      gridLoadMs: round(performance.now() - moviesGridStarted),
      categoryRendered: movieCategoryRendered,
      categoryTotalSize: movieCategoryTotalSize,
      rendered: document.querySelectorAll('#view-movies .catalog-grid-cell').length,
      totalSize: pixelSize(
        '#view-movies .catalog-grid-track',
        'height',
      ),
      navigation: await measureKeys('ArrowDown', 40),
    };

    const seriesStarted = performance.now();
    click('[data-section="series"]');
    await waitFor('#view-series:not(.hidden)');
    await waitFor('#view-series .catalog-cat[data-category-id="13"]');
    const seriesOpenMs = round(performance.now() - seriesStarted);
    const seriesGridStarted = performance.now();
    click('#view-series .catalog-cat[data-category-id="13"]');
    await waitFor('#view-series .catalog-grid-cell');
    const seriesGridLoadMs = round(performance.now() - seriesGridStarted);
    const detailStarted = performance.now();
    click('#view-series .catalog-tile[data-item-id="s0"]');
    await waitFor('#view-series .episode-row');
    const detailLoadMs = round(performance.now() - detailStarted);
    document.querySelector('#view-series .episode-row').dispatchEvent(
      new CustomEvent('nav:hover', { bubbles: true }),
    );
    const episodes = {
      rendered: document.querySelectorAll('#view-series .episode-row').length,
      totalSize: pixelSize(
        '#view-series .series-episodes-spacer',
        'height',
      ),
      navigation: await measureKeys('ArrowDown', 40),
    };
    key('Backspace', 461);
    await waitFor('#view-series .catalog-grid');
    const series = {
      openMs: seriesOpenMs,
      gridLoadMs: seriesGridLoadMs,
      detailLoadMs,
      rendered: document.querySelectorAll('#view-series .catalog-grid-cell').length,
      totalSize: pixelSize(
        '#view-series .catalog-grid-track',
        'height',
      ),
      navigation: await measureKeys('ArrowDown', 40),
      episodes,
    };

    const searchInitialStarted = performance.now();
    click('[data-section="search"]');
    const searchInitialOpenMs = round(performance.now() - searchInitialStarted);
    const input = document.querySelector('.tab-bar-search-input');
    input.value = 'movie';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor('#view-search:not(.hidden)');
    await waitFor(
      '#view-search [data-search-virtual="movies"] .search-virtual-rail-spacer',
    );
    input.value = 'rareprogramneedle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor('#view-search .search-program-row');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const searchOpen = await searchOpenDistribution();
    const queries = {
      channelsBroad: await queryDistribution('channel'),
      channelsSparse: await queryDistribution('rarechannelneedle'),
      moviesBroad: await queryDistribution('movie'),
      moviesSparse: await queryDistribution('raremovieneedle'),
      programsBroad: await queryDistribution('program'),
      programsSparse: await queryDistribution('rareprogramneedle'),
      noMatch: await queryDistribution('zzzz-no-match'),
    };
    input.value = 'rarechannelneedle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const sparseCounts = {
      channels: document.querySelectorAll(
        '#view-search .search-channel-row, #view-search .search-channel-tile',
      ).length,
      movies: 0,
      programs: 0,
    };
    input.value = 'raremovieneedle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    sparseCounts.movies = document.querySelectorAll(
      '#view-search [data-search-virtual="movies"] .catalog-tile',
    ).length;
    input.value = 'rareprogramneedle';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    sparseCounts.programs = document.querySelectorAll(
      '#view-search .search-program-row',
    ).length;
    if (sparseCounts.channels !== 1 || sparseCounts.movies !== 1
        || sparseCounts.programs !== 1) {
      throw new Error(`Sparse search rendered unexpected counts: ${JSON.stringify(sparseCounts)}`);
    }
    input.value = 'program';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const search = {
      initialOpenMs: searchInitialOpenMs,
      open: searchOpen,
      queries,
      renderedPrograms: document.querySelectorAll(
        '#view-search .search-program-row',
      ).length,
      programTotalSize: pixelSize(
        '#view-search [data-search-virtual="programmes"] .search-virtual-list-spacer',
        'height',
      ),
    };

    if (longTaskObserver) {
      longTaskObserver.takeRecords()
        .forEach((entry) => longTaskDurations.push(entry.duration));
      longTaskObserver.disconnect();
    }
    await settle();
    clearInterval(watchdogTimer);
    const stress = {
      watchdogIntervalMs,
      heartbeats: watchdogHeartbeats,
      maxEventLoopGapMs: round(watchdogMaxGapMs),
      freezeThresholdMs: 5000,
      documentAlive: document.documentElement.isConnected,
    };
    return {
      channelList,
      recentlyWatched,
      sidebar,
      epg: {
        openMs: epgOpenMs,
        firstFrameMs: epgFirstFrameMs,
        maxLongTaskMs: epgMaxLongTaskMs,
        channelList: epgChannels.navigation,
        programList: epgPrograms.navigation,
        renderedChannels: epgChannels.rendered,
        renderedPrograms: epgPrograms.rendered,
        channelTotalSize: epgChannels.totalSize,
        programTotalSize: epgPrograms.totalSize,
      },
      movies,
      series,
      search: { xtream: search },
      interactions: {
        wheelToDpad,
        groupSwitching,
        epgChannelTransition,
        epgDateTitles,
        sparseSearch: sparseCounts,
      },
      stress,
      longTasks: {
        count: longTaskDurations.length,
        totalMs: round(longTaskDurations.reduce((total, value) => total + value, 0)),
        maxMs: round(longTaskDurations.length ? Math.max(...longTaskDurations) : 0),
      },
      nodes: document.getElementsByTagName('*').length,
    };
}

export function assertBenchmarkScale(report, scale) {
  const closeTo = (actual, expected, tolerance = 0) => {
    const numeric = parseFloat(String(actual).replace(/_/g, ''));
    if (Math.abs(numeric - expected) > tolerance) {
      throw new Error(`Expected extent ${String(expected)}, received ${actual}`);
    }
  };
  const bounded = (name, count, limit) => {
    if (!(count > 0 && count < limit)) {
      throw new Error(`${name} mounted ${String(count)} nodes; expected 1-${String(limit - 1)}`);
    }
  };
  bounded('Channel List', report.channelList.rendered, 60);
  if (report.recentlyWatched.rendered !== 50) {
    throw new Error(
      `Recently Watched mounted ${String(report.recentlyWatched.rendered)} rows; expected 50`,
    );
  }
  bounded('Sidebar', report.sidebar.rendered, 60);
  if (report.sidebar.logoReveal.initialSpacers < 2
      || report.sidebar.logoReveal.initialImages !== 0
      || report.sidebar.logoReveal.invalidImages !== 0
      || report.sidebar.logoReveal.revealed < 2
      || report.sidebar.logoReveal.maxPerFrame > 1) {
    throw new Error(
      `Sidebar logo reveal did not remain blank and frame-paced: ${JSON.stringify(
        report.sidebar.logoReveal,
      )}`,
    );
  }
  bounded('EPG channels', report.epg.renderedChannels, 50);
  bounded('EPG programs', report.epg.renderedPrograms, 40);
  bounded('Movies', report.movies.rendered, 60);
  bounded('Series', report.series.rendered, 60);
  bounded('Episodes', report.series.episodes.rendered, 20);
  bounded('Search programs', report.search.xtream.renderedPrograms, 30);
  if (!report.interactions.wheelToDpad.focusedConnected) {
    throw new Error('Wheel-to-D-pad focus is detached');
  }
  if (!report.interactions.epgChannelTransition.selected
      || report.interactions.epgChannelTransition.renderedPrograms < 1) {
    throw new Error('EPG channel transition did not render its schedule');
  }
  if (report.interactions.epgDateTitles.length !== 3
      || new Set(report.interactions.epgDateTitles).size !== 3) {
    throw new Error('EPG date transition coverage is incomplete');
  }
  const sparse = report.interactions.sparseSearch;
  if (sparse.channels !== 1 || sparse.movies !== 1 || sparse.programs !== 1) {
    throw new Error('Sparse search did not retain exactly one result per collection');
  }
  const expectedGroupCounts = {
    'builtin:all': scale,
    'source:Group 1': Math.ceil((scale - 1) / 100),
    'source:Small Group': 1,
  };
  if (report.interactions.groupSwitching.states.length !== 9
      || report.interactions.groupSwitching.states.some((state) =>
        state.rendered < 1 || state.channels !== expectedGroupCounts[state.group])) {
    throw new Error('Repeated group switching rendered an incorrect collection');
  }
  if (!report.stress.documentAlive) {
    throw new Error('App document terminated during the benchmark');
  }
  if (report.stress.heartbeats < 1) {
    throw new Error('Event-loop watchdog did not run');
  }
  if (report.stress.maxEventLoopGapMs >= report.stress.freezeThresholdMs) {
    throw new Error(
      `Event loop froze for ${String(report.stress.maxEventLoopGapMs)}ms`,
    );
  }
  if (report.parsers.m3u.channels !== scale || report.parsers.xmltv.programmes !== scale) {
    throw new Error('Raw parser benchmark did not produce the requested scale');
  }
  closeTo(report.channelList.totalSize, scale * 88);
  if (!report.recentlyWatched.liveRendered || !report.recentlyWatched.catchupRendered) {
    throw new Error('Recently Watched did not render both mixed-height row types');
  }
  closeTo(report.sidebar.totalSize, scale * 88);
  closeTo(report.epg.channelTotalSize, scale * 72);
  closeTo(report.epg.programTotalSize, scale * 80, 2048);
  closeTo(report.movies.categoryTotalSize, (scale - 6) * 320, 32);
  closeTo(report.movies.totalSize, Math.ceil(scale / 7) * 395, 32);
  closeTo(report.series.totalSize, Math.ceil(scale / 7) * 395, 32);
  closeTo(report.series.episodes.totalSize, scale * 138);
  closeTo(report.search.programTotalSize, scale * 109);
}

export function assertColdLoadBenchmark(report, scale) {
  if (report.channels !== scale) {
    throw new Error(
      `Cold load rendered ${String(report.channels)} channels; expected ${String(scale)}`,
    );
  }
  if (!(report.rendered > 0 && report.rendered < 60)) {
    throw new Error(
      `Cold load mounted ${String(report.rendered)} channel rows; expected 1-59`,
    );
  }
  if (!(report.readyMs > 0)) throw new Error('Cold load timing was not recorded');
}
