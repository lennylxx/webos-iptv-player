import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, type Page, pressAndReadPlayer, liveLoaded } from './helpers';
import { seedXtream } from './fixtures/xtream';

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
  await liveLoaded(page);
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

// Back hides an OSD the user paused, so pause through the app's Pause key for
// tests that need the overlay, not the OSD, to take Back. The mock file never
// plays, so the element first gets a play state the Pause key can toggle.
async function userPause(page: Page): Promise<void> {
  await page.locator('#video-player').evaluate((video: HTMLVideoElement) => {
    let paused = false;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.play = () => { paused = false; return Promise.resolve(); };
    video.pause = () => { paused = true; };
  });
  const s = await pressAndReadPlayer(page, [19]);
  expect(s).toMatchObject({ osd: true, player: true, paused: true });
}

// Open the right-edge VOD menu, dive into Subtitles, and pick "Search online…"
// to raise the search overlay; the menu closes as the overlay opens.
async function openSearchOverlay(page: Page): Promise<void> {
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Playback Speed
  await page.keyboard.press('ArrowDown'); // Playback Speed -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu (focus lands on "Off")
  await expect(menu).toContainText('Search online');
  await page.keyboard.press('ArrowDown'); // Off -> Search online…
  await page.keyboard.press('Enter');     // open the search overlay
  // The container collapses (its .subs-overlay is absolutely positioned), so
  // anchor visibility on the overlay itself.
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

test('"Search online…" closes the menu and hands the D-pad to the first result', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => ['a', 'b'].map((id, i) =>
    assrtSub({ id: `30${String(i)}`, langDesc: '英', name: `Release ${id}`, downloads: 20 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const rows = page.locator('#subtitle-search .subs-row');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#player-menu')).not.toHaveClass(/visible/);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'player.subtitle_search');
  await expect(rows.nth(0)).toHaveClass(/focused/);

  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toHaveClass(/focused/);
});

test('Right over the overlay stays with it while the OSD is hidden', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => [
    assrtSub({ id: '401', langDesc: '英', name: 'Release a', downloads: 10 }),
  ]);
  await startVodPlayback(page);
  const osd = page.locator('#player-osd');
  const menu = page.locator('#player-menu');
  await page.keyboard.press('Enter'); // no duration, so OK hides the OSD
  await expect(osd).toHaveClass(/hidden/);
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Playback Speed
  await page.keyboard.press('ArrowDown'); // Playback Speed -> Subtitles
  await page.keyboard.press('Enter');
  await expect(menu).toContainText('Search online');
  await page.keyboard.press('ArrowDown'); // Off -> Search online…
  await page.keyboard.press('Enter');
  const overlay = page.locator('#subtitle-search .subs-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('#subtitle-search .subs-row')).toHaveCount(1);
  await expect(osd).toHaveClass(/hidden/);

  await page.keyboard.press('ArrowRight');
  // Read once: a retrying check would also pass after the menu auto-hides.
  await page.waitForTimeout(400);
  expect(await menu.getAttribute('class')).not.toMatch(/visible/);
  await expect(overlay).toBeVisible();
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'player.subtitle_search');
});

test('the overlay ring follows the pointer, and the D-pad steps on from it', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => ['a', 'b', 'c', 'd'].map((id, i) =>
    assrtSub({ id: `40${String(i)}`, langDesc: '英', name: `Release ${id}`, downloads: 40 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const rows = page.locator('#subtitle-search .subs-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveClass(/focused/);

  const box = await rows.nth(2).boundingBox();
  if (!box) throw new Error('result row has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(3)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('a row hovered while the search box has the caret stays dark until Down lands on it', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => ['a', 'b', 'c', 'd'].map((id, i) =>
    assrtSub({ id: `60${String(i)}`, langDesc: '英', name: `Release ${id}`, downloads: 60 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const rows = page.locator('#subtitle-search .subs-row');
  const input = page.locator('.subs-search-input');
  await expect(rows).toHaveCount(4);
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();

  const box = await rows.nth(2).boundingBox();
  if (!box) throw new Error('result row has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  await expect(page.locator('.focused')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(input).not.toBeFocused();
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the menu opened at the screen edge takes the arrow keys from the search box', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => ['a', 'b', 'c'].map((id, i) =>
    assrtSub({ id: `70${String(i)}`, langDesc: '英', name: `Release ${id}`, downloads: 70 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const input = page.locator('.subs-search-input');
  const menu = page.locator('#player-menu');
  const menuRows = menu.locator('.menu-item');
  const rows = page.locator('#subtitle-search .subs-row');
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  const box = await rows.nth(2).boundingBox();
  if (!box) throw new Error('result row has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.focused')).toHaveCount(0);

  await page.mouse.move(1900, 540);
  await expect(menu).toHaveClass(/visible/);
  await expect(input).not.toBeFocused();
  await expect(menuRows.nth(0)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(menuRows.nth(1)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(menu).not.toHaveClass(/visible/);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'player.subtitle_search');
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('taking the caret from the search box with a click leaves the list where it is', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => Array.from({ length: 20 }, (_, i) =>
    assrtSub({ id: `8${String(i).padStart(2, '0')}`, langDesc: '英', name: `Release ${String(i)}`, downloads: 100 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const rows = page.locator('#subtitle-search .subs-row');
  const list = page.locator('#subtitle-search .subs-list');
  await expect(rows).toHaveCount(20);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.subs-search-input')).toBeFocused();

  // A point on the visible part of the row the list's bottom edge cuts.
  const point = await list.evaluate((el) => {
    const l = el.getBoundingClientRect();
    for (const row of Array.from(el.querySelectorAll('.subs-row'))) {
      const r = row.getBoundingClientRect();
      if (r.top < l.bottom - 4 && r.bottom > l.bottom + 1) {
        return { x: r.left + r.width / 2, y: (r.top + l.bottom) / 2 };
      }
    }
    return null;
  });
  if (!point) throw new Error('no row is cut by the list edge');
  await page.mouse.move(point.x, point.y);
  const before = await list.evaluate((el) => el.scrollTop);
  await page.mouse.down();
  await expect(page.locator('.subs-search-input')).not.toBeFocused();
  await page.waitForTimeout(200);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  await page.mouse.up();
});

test('the D-pad keeps the focused result in view down a long list', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => Array.from({ length: 20 }, (_, i) =>
    assrtSub({ id: `5${String(i).padStart(2, '0')}`, langDesc: '英', name: `Release ${String(i)}`, downloads: 100 - i })));
  await startVodPlayback(page);
  await openSearchOverlay(page);
  const rows = page.locator('#subtitle-search .subs-row');
  await expect(rows).toHaveCount(20);

  for (let i = 0; i < 19; i++) await page.keyboard.press('ArrowDown');
  await expect(rows.nth(19)).toHaveClass(/focused/);
  const inView = () => page.locator('#subtitle-search .subs-list').evaluate((list) => {
    const row = list.querySelector('.subs-row.focused');
    if (!row) return false;
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
  });
  await expect.poll(inView).toBe(true);
  for (let i = 0; i < 19; i++) await page.keyboard.press('ArrowUp');
  await expect(rows.nth(0)).toHaveClass(/focused/);
  await expect.poll(inView).toBe(true);
});

test('the subtitle sync adjuster keeps the keys, and the screen edge keeps the menu shut', async ({ page }) => {
  await seedXtream(page);
  await startVodPlayback(page);
  const menu = page.locator('#player-menu');
  const settled = () => expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBe(1920);
  await page.mouse.move(1900, 540);
  await expect(menu).toHaveClass(/visible/);
  await settled();
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_track__"][data-track-index="2000"]').click();
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_offset__"]').click();
  await expect(page.locator('#subtitle-offset:not(.hidden)')).toBeVisible();
  await expect(menu).not.toHaveClass(/visible/);
  const owner = page.locator('[data-ring-owner]');
  await expect(owner).toHaveAttribute('data-focus-scope', 'player.subtitle_offset');

  await page.mouse.move(1700, 540);
  await page.mouse.move(1900, 540);
  // Past the slide-in, read once: a retrying check would also pass once the
  // menu's own auto-hide closes it.
  await page.waitForTimeout(400);
  expect(await menu.getAttribute('class')).not.toMatch(/visible/);
  await expect(owner).toHaveAttribute('data-focus-scope', 'player.subtitle_offset');

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#subtitle-offset')).toBeHidden();
  await page.mouse.move(1700, 540);
  await page.mouse.move(1900, 540);
  await expect(menu).toHaveClass(/visible/);
  await expect(owner).toHaveAttribute('data-focus-scope', 'player.menu');
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('Back closes the search overlay over a shown OSD and leaves the OSD up', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => [
    assrtSub({ id: '601', langDesc: '英', name: 'Release a', downloads: 10 }),
  ]);
  await startVodPlayback(page);
  await userPause(page);
  await openSearchOverlay(page);
  await expect(page.locator('#subtitle-search .subs-row')).toHaveCount(1);
  await expect(page.locator('#subtitle-search .subs-search-input')).not.toBeFocused();

  const s = await pressAndReadPlayer(page, [461]);
  expect(s).toMatchObject({ osdBefore: true, osd: true, player: true, paused: true });
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeHidden();
});

test('Back closes the subtitle sync adjuster over a shown OSD and leaves the OSD up', async ({ page }) => {
  await seedXtream(page);
  await startVodPlayback(page);
  await userPause(page);
  const menu = page.locator('#player-menu');
  await page.mouse.move(1900, 540);
  await expect(menu).toHaveClass(/visible/);
  await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBe(1920);
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_track__"][data-track-index="2000"]').click();
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_offset__"]').click();
  await expect(page.locator('#subtitle-offset:not(.hidden)')).toBeVisible();

  // Up (unused by the adjuster) hands the keys back from the pointer first.
  const s = await pressAndReadPlayer(page, [38, 461]);
  expect(s).toMatchObject({ osdBefore: true, osd: true, player: true, menu: false, paused: true });
  await expect(page.locator('#subtitle-offset')).toBeHidden();
});

test('picking a result downloads it into the application subtitle track', async ({ page }) => {
  await seedVod(page);
  await routeAssrtSearch(page, () => [
    assrtSub({ id: '201', langDesc: '英', name: 'Popular Release', downloads: 100 }),
  ]);
  await startVodPlayback(page);
  await openSearchOverlay(page);
  await expect(page.locator('#subtitle-search .subs-row')).toContainText('Popular Release');

  // Hand the D-pad to the overlay, then select the (focused) first result.
  await page.keyboard.press('Enter');

  // The pick applies: a toast, the overlay closes, and the downloaded subtitle
  // becomes the showing application-created text track with parsed cues.
  await expect(page.locator('.toast')).toContainText('Subtitles: Popular Release');
  await expect(page.locator('#subtitle-search .subs-overlay')).toBeHidden();
  await expect.poll(async () => page.evaluate(() => {
    const v = document.getElementById('video-player') as HTMLVideoElement;
    const t = Array.from(v.textTracks).find((x) => x.mode === 'showing');
    return t ? { label: t.label, cues: t.cues?.length ?? 0 } : null;
  })).toEqual({ label: 'Popular Release', cues: 2 });
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
