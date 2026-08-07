import { test as base, expect, type Page } from '@playwright/test';

export { expect, type Page };

export const PLAYLIST_URL = 'http://host.example.com/playlist.m3u';

export const SAMPLE_M3U = [
  '#EXTM3U url-tvg="http://epg.example.com/guide.xml"',
  '#EXTINF:-1 tvg-id="one" group-title="News",Channel One',
  'http://streams.example.com/one.m3u8',
  '#EXTINF:-1 tvg-id="two" group-title="Movies",Channel Two',
  'http://streams.example.com/two.m3u8',
].join('\n');

export const SEARCH_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="News",Alpha News',
  'http://streams.example.com/1.m3u8',
  '#EXTINF:-1 group-title="News",Beta News',
  'http://streams.example.com/2.m3u8',
  '#EXTINF:-1 group-title="Entertainment",Alpha Movies',
  'http://streams.example.com/3.m3u8',
  '#EXTINF:-1 group-title="Sports",Delta Sports',
  'http://streams.example.com/4.m3u8',
].join('\n');

// A minimal segment-less *live* HLS manifest: hls.js reaches MANIFEST_PARSED and
// just polls for live segments — no fatal error, so no auto-zap to the next
// channel and the OSD keeps showing channel info.
export const LIVE_MANIFEST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';

/**
 * The app polls the bundled webOS upload service at 127.0.0.1:8890 (see
 * UploadClient.reconcile). It is not running in the preview/e2e environment, so
 * chromium would spend hundreds of ms per probe waiting for the connection to be
 * refused — enough to push toast/view assertions past their 5s timeout on slower
 * runs. Aborting these requests immediately keeps every test snappy; it runs
 * automatically via the extended `test` below.
 */
export async function stubUploadService(page: Page): Promise<void> {
  await page.route('http://127.0.0.1:8890/**', (route) => route.abort());
}

/** Serve an M3U body for the configured playlist URL (glob-matched by filename). */
export async function routePlaylist(page: Page, body = SAMPLE_M3U): Promise<void> {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body }));
}

/** Serve the minimal live manifest for any *.m3u8 stream. */
export async function routeLiveManifest(page: Page): Promise<void> {
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST }));
}

export async function readUserDataStore<T>(
  page: Page,
  storeName: string,
): Promise<{ key: string; value: T }[]> {
  return page.evaluate((store) => new Promise((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      tx.oncomplete = () => db.close();
    };
  }), storeName) as Promise<{ key: string; value: T }[]>;
}

/**
 * Keep VOD alive in the player by neutering the <video> element so an empty mock
 * movie/episode body can't fire `error` and auto-eject back to the catalog. The
 * player's VOD error handler (player.ts `onError`) calls the very `onBack()` the
 * Back key uses, so without this the eject races the test's own scripted
 * navigation and drops the detail screen. Must run before the page loads.
 */
export async function neuterVideo(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
}

/** Pre-seed one configured URL playlist so the app boots into the channel list. */
export async function seedPlaylist(page: Page, url = PLAYLIST_URL): Promise<void> {
  await page.addInitScript((u) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url: u }]));
  }, url);
}

/** Enter a section via the docked tab bar (always visible for an Xtream account).
 *  Uses a coordinate mouse press so the click carries clientX/clientY for the tab
 *  bar's coordinate hit-test. */
export async function enterTab(
  page: Page,
  section: 'live' | 'epg' | 'movies' | 'series' | 'settings' | 'search',
): Promise<void> {
  const tab = page.locator(`.tab-bar-item[data-section="${section}"]`);
  await expect(tab).toBeVisible();
  const box = await tab.boundingBox();
  if (!box) throw new Error(`tab ${section} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

// Both channel rows have a fixed height because their lists are virtualized, so
// their two text lines overflow into the neighbouring row instead of growing it.
// Returns the row's inner height and the height its text actually needs, adding
// the secondary line first when the fixture has no EPG data for it.
export async function measureRowTextFit(
  page: Page,
  rowSelector: string,
  infoClass: string,
  secondLineClass: string,
): Promise<{ available: number; needed: number }> {
  const row = page.locator(rowSelector).first();
  await expect(row).toBeVisible();
  return row.evaluate(
    (el: HTMLElement, [info, second]) => {
      const box = el.querySelector<HTMLElement>(`.${info}`);
      if (!box) throw new Error(`row has no .${info}`);
      if (!box.querySelector(`.${second}`)) {
        const line = document.createElement('div');
        line.className = second;
        line.textContent = 'Programme';
        box.appendChild(line);
      }
      const style = getComputedStyle(el);
      const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      return {
        available: el.getBoundingClientRect().height - chrome,
        needed: box.scrollHeight,
      };
    },
    [infoClass, secondLineClass],
  );
}

// Every spec imports `test` from here; it auto-stubs the service probe
// before each test so no file has to repeat it.
export const test = base.extend({
  page: async ({ page }, use) => {
    await stubUploadService(page);
    await use(page);
  },
});
