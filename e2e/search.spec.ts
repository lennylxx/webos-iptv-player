import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab } from './helpers';

function xmltvDate(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
}

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// catalog calls + the get.php/xmltv.php the live path uses. get_vod_streams /
// get_series with no category return the whole catalog Search matches against;
// get_vod_info backs the movie deep-link into the Movies detail. Action names
// that are substrings of others are routed most-specific-first (get_series_*
// before get_series, get_vod_info/get_vod_categories before get_vod_streams).
async function seedSearch(page: import('@playwright/test').Page): Promise<void> {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <programme channel="one" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
      <title>Future Report</title><category>News</category>
    </programme>
  </tv>`;
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_vod_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info: { plot: 'Movie plot.', duration_secs: 3600, movie_image: '' } }) });
    }
    if (url.includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]) });
    }
    if (url.includes('get_series_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_series_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ episodes: {} }) });
    }
    if (url.includes('get_series')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { series_id: 1, name: 'Series One', cover: '', category_id: '1' },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The movie file itself: a small response so play() doesn't hang the test.
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

// Open the tab bar's search box (results appear once a query is typed).
async function enterSearch(page: import('@playwright/test').Page): Promise<void> {
  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
}

test('unified search matches channels, movies, and series; a channel result plays', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  // One query matches "Channel One" (live, from SAMPLE_M3U), "Movie One", and
  // "Series One". The catalogs load asynchronously on open, so the movie/series
  // groups appear once loaded; the assertions retry until then.
  await page.locator('.tab-bar-search-input').fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(page.locator('#view-search .catalog-tile[data-series-id="1"]')).toContainText('Series One');

  // Hand off from the tab-bar box to the results (Down), then focus the channel
  // tile via a bubbling nav:hover before OK.
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  await page.locator('#view-search .catalog-tile[data-channel-index="0"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
});

test('a wide virtual search rail keeps its full scrollable width', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('one');

  const rail = page.locator('[data-search-virtual="movies"]');
  await expect(rail.locator('.search-virtual-rail-spacer')).toBeVisible();
  const metrics = await rail.evaluate((element) => {
    const spacer = element.querySelector<HTMLElement>('.search-virtual-rail-spacer');
    if (!spacer) throw new Error('virtual rail spacer not found');
    spacer.style.width = '12000000px';
    element.scrollLeft = element.scrollWidth;
    return {
      flexShrink: getComputedStyle(spacer).flexShrink,
      spacerWidth: spacer.getBoundingClientRect().width,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
    };
  });

  expect(metrics.flexShrink).toBe('0');
  expect(metrics.spacerWidth).toBe(12_000_000);
  expect(metrics.scrollWidth).toBeGreaterThanOrEqual(12_000_000);
  expect(metrics.scrollLeft).toBe(metrics.scrollWidth - metrics.clientWidth);
});

test('program search shows XMLTV metadata and toggles a future reminder', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('report');
  const result = page.locator('#view-search .search-program-row');
  await expect(result).toContainText('Future Report');
  await expect(result).toContainText('Channel One');
  await expect(result).toContainText('Set reminder');

  await result.click();
  await expect(result).toContainText('Reminder set');
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('iptv_reminders') || '[]').length)).toBe(1);
});

test('a movie search result deep-links into its Movies detail and Back returns to Search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');

  // Hand off to the results (Down), then open the movie result (deep-links into
  // the Movies detail).
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  await page.locator('#view-search .catalog-tile[data-stream-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie plot.');

  // Back from the deep-linked detail returns to Search (CONFIG.KEYS.BACK = 461;
  // dispatch a raw keydown like the other section specs do).
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-search')).toBeVisible();
});

test('a movie result opened by POINTER can then be played by pointer (tab-bar focus is dropped)', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');

  // Open the movie by a POINTER click on the result — no ArrowDown hand-off, so
  // the tab-bar search box stays expanded (the pointer path). Before the fix this
  // left the tab bar's `_focused` flag stale-true.
  await page.locator('#view-search .catalog-tile[data-stream-id="10"]').click();
  await expect(page.locator('#view-movies .detail-btn-primary')).toBeVisible();

  // Play by a POINTER click on the detail button. Regression guard: a stale
  // tab-bar focus swallowed this select before the fix (the detail Play routed
  // into the tab bar's expanded-search branch and vanished). We assert the movie
  // stream is actually requested — proof the select reached play() — rather than
  // the player view staying up (the stubbed empty video errors back to Movies).
  const streamRequested = page.waitForRequest('**/movie/**', { timeout: 5000 });
  await page.locator('#view-movies .detail-btn-primary').click();
  await streamRequested;
});
