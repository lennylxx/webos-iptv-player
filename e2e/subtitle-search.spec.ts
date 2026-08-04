import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, type Page } from './helpers';

// Online-subtitle search for Xtream VOD. The player's "Search online…" subtitle
// entry (always present for VOD — Assrt is a zero-config provider) opens a
// results overlay backed by the aggregator. We route the Assrt API so the whole
// menu → overlay → pick/apply path runs without any real network.

const MOVIE_ID = 10;
const SRT_BODY =
  '1\n00:00:01,000 --> 00:00:04,000\nCue one\n\n2\n00:00:05,000 --> 00:00:07,000\nCue two\n';

// One Assrt `sub` row. `langDesc` is the Chinese language description the client
// maps to a code ('英' → en); `name` becomes the release label.
function assrtSub(o: { id: string; langDesc: string; name: string; downloads: number }): unknown {
  return {
    id: o.id,
    lang: { desc: o.langDesc },
    native_name: o.name,
    videoname: `${o.name}.srt`,
    down_count: o.downloads,
  };
}

// Seed one Xtream account + a single movie, neuter <video> so the empty mock
// file can't fire `error` and eject VOD, and route the Assrt *detail*/download
// endpoints (the .srt serves SRT_BODY). The Assrt *search* endpoint is routed
// per-test via routeAssrtSearch so each test controls its own results.
async function seedVod(page: Page): Promise<void> {
  await page.route('**/get.php*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { stream_id: MOVIE_ID, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]) });
    }
    if (url.includes('get_vod_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ info: { plot: 'A plot.', duration_secs: 3600 } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The movie file itself: a small response so play() doesn't hang the test.
  await page.route('**/movie/**', (r) => r.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  // Assrt detail: hand back a directly-downloadable .srt via the filelist.
  await page.route(/\/v1\/sub\/detail/, (route) => {
    const id = new URL(route.request().url()).searchParams.get('id') || '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      sub: { subs: [{ url: '', filelist: [{ url: `http://host.example.com:8080/onlinesub/${id}.srt`, f: `${id}.srt` }] }] },
    }) });
  });
  await page.route('**/onlinesub/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/x-subrip', body: SRT_BODY }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
  // Keep VOD alive: the empty mock file must not fire `error` and eject.
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
}

// Route the Assrt search endpoint; `forQuery` returns the `subs` array for a `q`.
async function routeAssrtSearch(page: Page, forQuery: (q: string) => unknown[]): Promise<void> {
  await page.route(/\/v1\/sub\/search/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 0, sub: { subs: forQuery(q) } }) });
  });
}

// Browse Movies, open the one movie's detail, and start VOD playback.
async function startVodPlayback(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'movies');
  await page.locator(`.catalog-tile[data-item-id="${MOVIE_ID}"]`)
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // VOD OSD (paused) shows the title and stays up — a stable settle point.
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();
}

// Open the right-edge VOD menu, dive into Subtitles, and pick "Search online…"
// to raise the search overlay. Leaves the (now redundant) menu open behind it.
async function openSearchOverlay(page: Page): Promise<void> {
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu (focus lands on "Off")
  await expect(menu).toContainText('Search online');
  await page.keyboard.press('ArrowDown'); // Off -> Search online…
  await page.keyboard.press('Enter');     // open the search overlay
  // The container collapses (its .subs-overlay is absolutely positioned), so
  // anchor visibility on the overlay itself.
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeVisible();
}

// The menu stays open behind the overlay and captures D-pad input; one Back
// dismisses it (the overlay survives) so the overlay owns the D-pad afterwards.
async function dismissMenuBehindOverlay(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#player-menu')).not.toHaveClass(/visible/);
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeVisible();
}

test('"Search online…" opens the results overlay, ranked and provider-labeled', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, (q) => q.includes('Movie One') ? [
    assrtSub({ id: '201', langDesc: '英', name: 'Popular Release', downloads: 100 }),
    assrtSub({ id: '202', langDesc: '英', name: 'Rare Release', downloads: 5 }),
  ] : []);
  await startVodPlayback(page);
  await openSearchOverlay(page);

  // The box is prefilled with the auto-detected title.
  await expect(page.locator('.subs-search-input')).toHaveValue('Movie One');

  const rows = page.locator('#subtitle-search .subs-row');
  await expect(rows).toHaveCount(2);
  // Ranked by download count (no preferred language set): the popular one first,
  // labeled provider · language · release, with its download-count badge.
  await expect(rows.nth(0)).toContainText('Assrt');
  await expect(rows.nth(0)).toContainText('English');
  await expect(rows.nth(0)).toContainText('Popular Release');
  await expect(rows.nth(0).locator('.subs-count')).toContainText('100');
  await expect(rows.nth(1)).toContainText('Rare Release');
});

test('picking a result downloads it and shows it as a native subtitle track', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => [
    assrtSub({ id: '201', langDesc: '英', name: 'Popular Release', downloads: 100 }),
  ]);
  await startVodPlayback(page);
  await openSearchOverlay(page);
  await expect(page.locator('#subtitle-search .subs-row')).toContainText('Popular Release');

  // Hand the D-pad to the overlay, then select the (focused) first result.
  await dismissMenuBehindOverlay(page);
  await page.keyboard.press('Enter');

  // The pick applies: a toast, the overlay closes, and the downloaded subtitle
  // becomes the showing native text track.
  await expect(page.locator('.toast')).toContainText('Subtitles: Popular Release');
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const v = document.getElementById('video-player') as HTMLVideoElement;
    const t = Array.from(v.textTracks).find((x) => x.mode === 'showing');
    return t ? t.label : null;
  })).toBe('Popular Release');
});

test('an empty search keeps the box open for a manual retry that finds results', async ({ page }) => {
  await seedVod(page);
  // The auto-detected title misses; a manual query hits (echoed into the label).
  await routeAssrtSearch(page, (q) => q.toLowerCase().includes('manual')
    ? [assrtSub({ id: '301', langDesc: '英', name: q, downloads: 3 })]
    : []);
  await startVodPlayback(page);
  await openSearchOverlay(page);

  // Empty result renders inline and does NOT auto-close — the box stays for a retry.
  await expect(page.locator('#subtitle-search .subs-status')).toContainText('No subtitles found');
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeVisible();
  await expect(page.locator('.subs-search-input')).toHaveValue('Movie One');

  // Refine the query in the box; Enter re-runs the search with the manual query.
  const input = page.locator('.subs-search-input');
  await input.fill('Manual Hit');
  await input.press('Enter');

  await expect(page.locator('#subtitle-search .subs-row')).toContainText('Manual Hit');
});

test('the overlay is dismissed on a view change (colored-button jump)', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => [
    assrtSub({ id: '201', langDesc: '英', name: 'Popular Release', downloads: 100 }),
  ]);
  await startVodPlayback(page);
  await openSearchOverlay(page);
  await expect(page.locator('#subtitle-search .subs-row')).toContainText('Popular Release');

  // Blue jumps to Settings; App.showView must close the overlay so it can't linger.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeHidden();
});
