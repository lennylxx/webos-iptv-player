import {
  liveLoaded,
  test,
  expect,
  routeLiveManifest,
  SAMPLE_M3U,
  enterTab,
  readUserDataStore,
  settled,
  routeFakeAi,
  fakeAiConfig,
  NOW,
  HOUR_MS,
  startClock,
  xmltvTime,
  runAiTimers,
  TRANSLATION_DWELL_MS,
  CONFIG,
} from './helpers';

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// catalog calls + the get.php/xmltv.php the live path uses. get_vod_streams /
// get_series with no category return the whole catalog Search matches against;
// get_vod_info backs the movie deep-link into the Movies detail. Action names
// that are substrings of others are routed most-specific-first (get_series_*
// before get_series, get_vod_info/get_vod_categories before get_vod_streams).
async function seedSearch(page: import('@playwright/test').Page): Promise<void> {
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <programme channel="one" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
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

test('M3U channel results retain visible space above matching programmes', async ({ page }) => {
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <programme channel="one" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Programme One</title>
    </programme>
  </tv>`;
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/guide.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('one');

  const channel = page.locator('#view-search .search-channel-tile').first();
  const programme = page.locator('#view-search .search-program-row').first();
  await expect(channel).toContainText('Channel One');
  await expect(programme).toContainText('Programme One');
  await expect.poll(async () => {
    const channelBox = await channel.boundingBox();
    const programmeBox = await programme.boundingBox();
    if (!channelBox || !programmeBox) return false;
    return channelBox.height >= 80
      && channelBox.y + channelBox.height <= programmeBox.y;
  }).toBe(true);
});

test('M3U-only results show channels as a rail, one Down above the programs', async ({ page }) => {
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 40; i++) lines.push(`#EXTINF:-1 tvg-id="c${i}",Show ${i}`, `http://host/${i}.m3u8`);
  const programmes = [1, 2, 3].map(i => `
    <channel id="c${i}"><display-name>Show ${i}</display-name></channel>
    <programme channel="c${i}" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Show Hour ${i}</title>
    </programme>`).join('');
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: lines.join('\n') }));
  await page.route('**/guide.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: `<tv>${programmes}</tv>` }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P', url: 'http://host/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('show');

  const tiles = page.locator('#view-search .search-channel-rail .search-channel-tile');
  await expect(page.locator('#view-search .search-program-row').first()).toBeVisible();
  await expect.poll(() => tiles.count()).toBeGreaterThan(3);
  const boxes = await tiles.evaluateAll(els => els.slice(0, 4).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }));
  expect(new Set(boxes.map(b => b.y)).size).toBe(1);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThan(boxes[i - 1].x);

  await input.press('ArrowDown');
  const focused = page.locator('#view-search .focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveClass(/\bsearch-channel-tile\b/);
  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveClass(/\bsearch-program-row\b/);
});

test('a query matching over 100 channels shows 100, and Right stops at the last', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 120; i++) lines.push(`#EXTINF:-1,Show ${i}`, `http://host/${i}.m3u8`);
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: lines.join('\n') }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'P', url: 'http://host/playlist.m3u' },
    ]));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('show');
  const rail = page.locator('#view-search [data-search-virtual="channels-rail"]');
  await expect(rail.locator('.search-virtual-rail-spacer')).toHaveAttribute('style', /width:\s*24000px/);

  await input.press('ArrowDown');
  const focusedIndex = () => page.locator('#view-search .focused').evaluate(el =>
    el.closest<HTMLElement>('[data-search-index]')?.dataset.searchIndex);
  await expect.poll(focusedIndex).toBe('0');
  for (let i = 0; i < 99; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(focusedIndex).toBe('99');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(focusedIndex).toBe('99');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);
  await expect(rail.locator('.search-virtual-rail-spacer')).toHaveAttribute('style', /width:\s*24000px/);
});

test('unified search matches channels, movies, and series; a channel result plays', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
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

test('a query typed while the catalog indexes shows partial results, then all', async ({ page }) => {
  await seedSearch(page);
  let releaseCatalog!: () => void;
  const catalogHeld = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  await page.route(/get_vod_streams/, async (route) => {
    await catalogHeld;
    await route.fallback();
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('one');
  // Channels answer while the catalog still indexes, with a loading note.
  const loadingMore = page.locator('#view-search .search-loading-more');
  await expect(page.locator('#view-search .catalog-tile[data-channel-index="0"]')).toContainText('Channel One');
  await expect(loadingMore).toBeVisible();
  await expect(page.locator('#view-search .catalog-tile[data-stream-id]')).toHaveCount(0);
  // A query with no partial answer yet says the index is still preparing.
  const hint = page.locator('#view-search .search-results .search-empty');
  await page.locator('.tab-bar-search-input').fill('zzz');
  await expect(hint).toHaveText('Preparing search…');
  await page.locator('.tab-bar-search-input').fill('one');

  releaseCatalog();
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(page.locator('#view-search .catalog-tile[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .search-empty')).toHaveCount(0);
  await expect(loadingMore).toHaveCount(0);
});

test('a wide virtual search rail keeps its full scrollable width', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
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
  // Past 2^23px a scroll offset is float-rounded, so allow 1px either way.
  expect(Math.abs(metrics.scrollLeft - (metrics.scrollWidth - metrics.clientWidth)))
    .toBeLessThanOrEqual(1);
});

test('program search shows XMLTV metadata and toggles a future reminder', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('report');
  const result = page.locator('#view-search .search-program-row');
  await expect(result).toContainText('Future Report');
  await expect(result).toContainText('Channel One');
  await expect(result).toContainText('Set reminder');
  // Only the poster rails bleed; a list keeps both screen margins.
  const box = await result.boundingBox();
  expect(Math.round(box!.x)).toBe(80);
  expect(Math.round(1920 - box!.x - box!.width)).toBe(80);

  await result.click();
  await expect(result).toContainText('Reminder set');
  await expect.poll(async () =>
    (await readUserDataStore(page, 'reminders')).length).toBe(1);
});

test('program results at the largest text size do not overlap, and Down keeps the focused one in view', async ({ page }) => {
  await startClock(page);
  const base = NOW.getTime() + HOUR_MS;
  const programmes = Array.from({ length: 6 }, (_, i) => {
    const start = new Date(base + i * 60 * 60 * 1000);
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    return `<programme channel="one" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Report ${i}</title><category>News</category></programme>`;
  }).join('');
  await seedSearch(page);
  await page.route('**/xmltv.php*', route => route.fulfill({
    status: 200,
    contentType: 'application/xml',
    body: `<tv><channel id="one"><display-name>Channel One</display-name></channel>${programmes}</tv>`,
  }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('report');
  const rows = page.locator('#view-search .search-program-row');
  await expect(rows.nth(2)).toBeVisible();

  // The rows keep the 8px gap the list's stride reserves, so CSS and JS
  // drifting apart either way shows.
  const gaps = () => rows.evaluateAll((els) => {
    const rects = els.map(el => el.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    return rects.slice(1).map((rect, i) => rect.top - rects[i].bottom);
  });
  const expectGaps = async () => {
    const found = await gaps();
    expect(found.length).toBeGreaterThan(1);
    for (const gap of found) expect(gap).toBeCloseTo(8, 0);
  };
  await expectGaps();
  // Each row holds its own lines.
  const contained = await rows.first().evaluate((row) => {
    const box = row.getBoundingClientRect();
    return Array.from(row.querySelectorAll('.search-program-time, .search-program-channel'))
      .every(el => el.getBoundingClientRect().bottom <= box.bottom);
  });
  expect(contained).toBe(true);

  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  const focused = page.locator('#view-search .search-program-row.focused');
  await expect(focused).toContainText('Report 5');
  const [focusBox, scrollBox] = await Promise.all([
    focused.boundingBox(),
    page.locator('[data-search-virtual="programmes"]').boundingBox(),
  ]);
  expect(focusBox!.y + focusBox!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height + 1);
  await expectGaps();
});

test('tile names in the result rails at the largest text size stay inside their rail', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('one');
  for (const key of ['channels-rail', 'movies', 'series']) {
    const rail = page.locator(`#view-search [data-search-virtual="${key}"]`);
    await expect(rail.locator('.catalog-tile-name').first()).toBeVisible();
    const overhang = await rail.evaluate((el) => {
      const spacer = el.querySelector('.search-virtual-rail-spacer')!.getBoundingClientRect();
      const name = el.querySelector('.catalog-tile-name')!.getBoundingClientRect();
      return name.bottom - spacer.bottom;
    });
    expect(overhang, key).toBeLessThanOrEqual(0.5);
  }
});

test('a reminder set in Search shows in the timeline guide it returns to', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  const detail = page.locator('#view-epg .epg-tl-detail');
  await expect(detail).toContainText('Future Report');
  await expect(detail.locator('.epg-bell-glyph.set')).toHaveCount(0);

  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('report');
  const result = page.locator('#view-search .search-program-row');
  await result.click();
  await expect(result).toContainText('Reminder set');
  await expect.poll(async () => {
    await pressBack(page);
    return page.locator('#view-epg').isVisible();
  }).toBe(true);

  await expect(detail.locator('.epg-bell-glyph.set')).toHaveCount(1);
});

test('a movie search result deep-links into its Movies detail and Back returns to Search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
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

// Open the movie result for the query, deep-linking into the Movies detail.
async function openMovieResult(page: import('@playwright/test').Page, query: string): Promise<void> {
  const input = page.locator('.tab-bar-search-input');
  await input.fill(query);
  const tile = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(tile).toContainText('Movie One');
  await input.press('ArrowDown');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie plot.');
}

// Regression: emptying the box from a result's detail dropped recent searches
// over that detail instead of returning to the view Search opened over.
test('emptying the box on a result detail returns to the view Search opened over', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await openMovieResult(page, 'one');

  const input = page.locator('.tab-bar-search-input');
  await input.focus();
  await input.fill('');
  await liveLoaded(page);
  await expect(page.locator('#view-movies')).toBeHidden();
  await expect(page.locator('.search-history-dropdown .search-history-tile')).toHaveText(['one']);
});

test('emptying the box on a result detail over Movies brings back its browse', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail')).not.toHaveCount(0);
  // The resident browse must come back as the same node, not be rebuilt by a
  // reload (morph keeps the node but drops unknown attributes, so use a property).
  await page.locator('#view-movies .catalog-browse')
    .evaluate((el) => { (el as HTMLElement & { testMark?: boolean }).testMark = true; });
  await enterSearch(page);
  await openMovieResult(page, 'one');

  const input = page.locator('.tab-bar-search-input');
  await input.focus();
  await input.fill('');
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .detail-plot')).toHaveCount(0);
  await expect(page.locator('#view-movies .catalog-rail')).not.toHaveCount(0);
  expect(await page.locator('#view-movies .catalog-browse')
    .evaluate((el) => (el as HTMLElement & { testMark?: boolean }).testMark)).toBe(true);
});

test('clearing Search reloads a Movies browse its deep link interrupted', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  // Hold the first Movies category load so the deep link interrupts it.
  let held = false;
  await page.route('**/player_api.php*', (route) => {
    if (!held && route.request().url().includes('get_vod_categories')) {
      held = true;
      return;
    }
    return route.fallback();
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-loading')).toBeVisible();
  await enterSearch(page);

  await openMovieResult(page, 'one');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-search')).toBeVisible();

  await page.locator('.tab-bar-search-input').fill('');
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-browse .catalog-tile[data-item-id="10"]'))
    .toContainText('Movie One');
});

test('a movie result opened by POINTER can then be played by pointer (tab-bar focus is dropped)', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
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

const BACK = 461;
async function pressBack(page: import('@playwright/test').Page): Promise<void> {
  // Back reaches the app even from the search box (an input passthrough key).
  await page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true }));
  }, BACK);
}

test('a search finishing under an open account menu leaves the keys in the menu', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]');
    playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
      source: 'xtream', xtream: { username: 'v', password: 'q' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
    // Hold search queries on their way to the worker until the test lets them go.
    const held: Array<() => void> = [];
    const w = window as unknown as { holdQueries: boolean; releaseQueries: () => void };
    w.holdQueries = false;
    w.releaseQueries = () => { w.holdQueries = false; held.splice(0).forEach(post => post()); };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      const send = () => (post as (...args: unknown[]) => void).call(this, message, ...rest);
      if (w.holdQueries && (message as { task?: string } | null)?.task === 'search.query') held.push(send);
      else send();
    };
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');

  await page.evaluate(() => { (window as unknown as { holdQueries: boolean }).holdQueries = true; });
  await input.fill('zzz');
  // Down waits for the query in flight, which matches nothing.
  await input.press('ArrowDown');
  await page.locator('.account-avatar').click();
  const menu = page.locator('.account-menu');
  await expect(menu).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseQueries: () => void }).releaseQueries());
  await expect(page.locator('#view-search .catalog-tile')).toHaveCount(0);

  await expect(menu).toBeVisible();
  await expect(menu.locator('.account-menu-item[data-account-id="x1"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('.account-menu-item[data-account-id="x2"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('recent searches drop down over the current view, refill the query, and clear without confirming', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one', 'Movie']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  const dropdown = page.locator('.search-history-dropdown');
  const tiles = dropdown.locator('.search-history-tile');
  const input = page.locator('.tab-bar-search-input');
  await expect(tiles).toHaveText(['one', 'Movie']);
  await liveLoaded(page);
  await expect(page.locator('#view-search')).toBeHidden();

  // Down from the box focuses the first recent search; Up from the top row
  // goes straight back to the box, past the clear button, which Right reaches.
  await input.press('ArrowDown');
  await expect(tiles.first()).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  await expect(dropdown.locator('[data-history-clear]')).not.toHaveClass(/focused/);
  await input.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(tiles.nth(1)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(dropdown.locator('[data-history-clear]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(input).toBeFocused();
  await expect(dropdown.locator('.search-history-panel')).toBeVisible();

  // OK on a recent search refills the query and shows its results.
  await input.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect(dropdown.locator('.search-history-panel')).toBeHidden();

  // Emptying the box restores the view underneath and drops the recent
  // searches back down; clearing them puts focus back in the box.
  await input.fill('');
  await liveLoaded(page);
  await expect(tiles).toHaveCount(2);
  await dropdown.locator('[data-history-clear]').click();
  await expect(page.locator('.confirmation-prompt:not(.hidden)')).toHaveCount(0);
  await expect(dropdown.locator('.search-history-panel')).toBeHidden();
  await liveLoaded(page);
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBeNull();

  // With nothing left below, Down and OK keep the remote in the box.
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toBeFocused();
  await page.keyboard.type('one');
  await expect(input).toHaveValue('one');
});

test('picking a recent search that matches nothing keeps the remote in the box', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['zzz']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await expect(page.locator('.search-history-tile')).toHaveText(['zzz']);
  await input.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('zzz');
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(input).toBeFocused();
});

test('a click on the dimmed view leaves search and restores the tab underneath', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const dropdown = page.locator('.search-history-dropdown');
  await expect(dropdown.locator('.search-history-tile')).toHaveCount(1);

  await page.mouse.click(200, 800);
  await expect(dropdown.locator('.search-history-panel')).toBeHidden();
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
  await liveLoaded(page);
  await expect(page.locator('.tab-bar-item[data-section="live"]')).toHaveClass(/active/);
  await expect(page.locator('.tab-bar .search-icon')).not.toHaveClass(/active/);
});

test('recent searches line up with the search input, not the icon', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const panel = page.locator('.search-history-panel');
  await expect(panel).toBeVisible();
  const [panelBox, inputBox] = await settled(() => Promise.all([
    panel.boundingBox(), page.locator('.tab-bar-search-input').boundingBox(),
  ]));
  expect(Math.abs(panelBox!.x - inputBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((panelBox!.x + panelBox!.width) - (inputBox!.x + inputBox!.width))).toBeLessThanOrEqual(1);
});

// Regression: at 150% text the French "clear" label spilled past the panel.
test('a long clear label at the largest text size widens recent searches to fit', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
    localStorage.setItem('iptv_locale', JSON.stringify('fr'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const panel = page.locator('.search-history-panel');
  await expect(panel).toBeVisible();
  const [panelBox, clearBox] = await Promise.all([
    panel.boundingBox(), page.locator('.search-history-clear').boundingBox(),
  ]);
  expect(clearBox!.x + clearBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
});

test('Right after the pointer hid the ring in recent searches shows it, not the clear button', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one', 'Movie', 'abc']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  const dropdown = page.locator('.search-history-dropdown');
  const first = dropdown.locator('.search-history-tile').first();
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  await expect(first).toHaveClass(/\bfocused\b/);
  // Onto the tile, then off it inside the panel: the ring hides.
  await first.hover();
  await dropdown.locator('.search-history-title').hover();
  await expect(first).not.toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowRight');
  await expect(first).toHaveClass(/\bfocused\b/);
  await expect(dropdown.locator('.search-history-clear')).not.toHaveClass(/\bfocused\b/);
});

// Regression: Back from a recent search or a result used to jump to Live.
test('Back steps from recent searches and results to the box, then to the view search opened over', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  await enterSearch(page);

  const dropdown = page.locator('.search-history-dropdown');
  const input = page.locator('.tab-bar-search-input');
  await input.press('ArrowDown');
  await expect(dropdown.locator('.search-history-tile').first()).toHaveClass(/focused/);
  await pressBack(page);
  await expect(dropdown.locator('.search-history-panel')).toBeHidden();
  await expect(input).toBeFocused();
  await expect(page.locator('#view-epg')).toBeVisible();

  await input.fill('one');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);
  await pressBack(page);
  await expect(input).toBeFocused();
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);

  await pressBack(page);
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('opening a search result records the query as a recent search', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('one');
  const channel = page.locator('#view-search .catalog-tile[data-channel-index="0"]');
  await expect(channel).toContainText('Channel One');
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  await channel.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBe('["one"]');
});

test('a poster clicked to dismiss the account menu over an empty search box still opens', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const poster = page.locator('#view-movies .catalog-tile[data-item-id="10"]');
  await expect(poster).toContainText('Movie One');
  await enterSearch(page);

  await page.locator('.account-avatar').click();
  await expect(page.locator('.account-menu')).toBeVisible();
  await poster.click();
  await expect(page.locator('.account-menu')).toHaveCount(0);
  // The click's select reaches the poster instead of the refocused search box.
  await expect(page.locator('#view-movies .detail-btn-primary')).toBeVisible();
  await expect(page.locator('.search-history-panel')).toBeHidden();
  await expect(page.locator('.tab-bar-item.focused, .account-avatar.focused')).toHaveCount(0);
});

test('a scrim click that dismisses the account menu leaves search like it does without the menu', async ({ page }) => {
  await seedSearch(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await expect(page.locator('.search-history-dropdown .search-history-panel')).toBeVisible();

  await page.locator('.account-avatar').click();
  await expect(page.locator('.account-menu')).toBeVisible();
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await page.mouse.click(200, 800);
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
  await liveLoaded(page);
  // The bar's ring must not be left on the avatar, where Down reopens the menu.
  await expect(page.locator('.account-avatar.focused')).toHaveCount(0);
  // The click that dismisses search must not flash recent searches back open.
  expect(events.some((text) => text.includes('event=search.box.collapsed reason=dismiss'))).toBe(true);
  expect(events.filter((text) => text.includes('event=search.history.opened'))).toEqual([]);
});

for (const target of ['magnifier', 'Movies tab'] as const) {
  test(`a ${target} click that dismisses the account menu does not flash recent searches`, async ({ page }) => {
    await seedSearch(page);
    await page.addInitScript(() => {
      localStorage.setItem('iptv_search_history', JSON.stringify(['one']));
    });
    await page.goto('/');
    await liveLoaded(page);
    await enterSearch(page);
    await expect(page.locator('.search-history-dropdown .search-history-panel')).toBeVisible();

    await page.locator('.account-avatar').click();
    await expect(page.locator('.account-menu')).toBeVisible();
    const events: string[] = [];
    page.on('console', (msg) => events.push(msg.text()));
    const item = target === 'magnifier'
      ? page.locator('.tab-bar-item.search-icon')
      : page.locator('.tab-bar-item[data-section="movies"]');
    await item.click();
    await expect(page.locator('.account-menu')).toHaveCount(0);
    await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
    expect(events.some((text) => text.includes('event=account.menu.closed reason=bar'))).toBe(true);
    expect(events.filter((text) => text.includes('event=search.history.opened'))).toEqual([]);
  });
}

test('a blank click that dismisses the account menu keeps the remote in the search box', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const heading = page.locator('#view-movies .catalog-rail-title').first();
  await expect(heading).toBeVisible();
  await enterSearch(page);

  await page.locator('.account-avatar').click();
  await expect(page.locator('.account-menu')).toBeVisible();
  await heading.click();
  await expect(page.locator('.account-menu')).toHaveCount(0);

  // The click fired no select, so Back still closes search rather than
  // reaching Movies underneath.
  await pressBack(page);
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
  await expect(page.locator('#view-movies')).toBeVisible();
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('after the pointer leaves a result, the first key shows it and the next one moves', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('channel');
  const tile = (index: number) => page.locator(`#view-search .catalog-tile[data-channel-index="${String(index)}"]`);
  await expect(tile(1)).toBeVisible();
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  // Step along the channel results, which search moves through by itself.
  const section = await tile(0).evaluate((el) =>
    el.closest<HTMLElement>('[data-search-section]')?.dataset.searchSection ?? '');
  const along = section === 'channels-rail' ? 'ArrowRight' : 'ArrowDown';
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-search .focused')).toHaveCount(0);

  await page.keyboard.press(along);
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press(along);
  await expect(tile(1)).toHaveClass(/\bfocused\b/);
});

test('Up back to the box leaves no ring on a result, while typing too', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('on');
  const tile = page.locator('#view-search .catalog-tile[data-channel-index="0"]');
  await expect(tile).toContainText('Channel One');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .focused')).toHaveCount(1);

  for (let i = 0; i < 4; i++) {
    if (await input.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowUp');
  }
  await expect(input).toBeFocused();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);
  await page.keyboard.type('e');
  await expect(page.locator('#view-search [data-search-query]')).toHaveAttribute('data-search-query', 'one');
  await expect(tile).toBeVisible();
  await expect(page.locator('#view-search .focused')).toHaveCount(0);
});

test('Down from the box after Up rings a result at once, and one Right moves', async ({ page }) => {
  await seedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  // Two channel tiles, so Right has a neighbor on the line.
  await input.fill('channel');
  await expect(page.locator('#view-search .search-channel-tile')).toHaveCount(2);
  await expect(page.locator('#view-search .search-view')).toHaveAttribute('data-search-partial', 'false');
  await input.press('ArrowDown');
  const focused = page.locator('#view-search .focused');
  await expect(focused).toHaveCount(1);
  const first = await focused.getAttribute('data-key');

  for (let i = 0; i < 4; i++) {
    if (await input.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowUp');
  }
  await expect(input).toBeFocused();
  await expect(focused).toHaveCount(0);

  await input.press('ArrowDown');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', first ?? '');
  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-key', first ?? '');
});

test('Left and Right keep a program result on its line, past the channel tiles above', async ({ page }) => {
  await seedSearch(page);
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 8; i++) lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="News",One ${i}`, `http://host/${i}.m3u8`);
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: lines.join('\n') }));
  await page.route('**/xmltv.php*', (route) => route.fulfill({ status: 200, contentType: 'application/xml', body: `<tv>
    <channel id="c1"><display-name>One 1</display-name></channel>
    <programme channel="c1" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}"><title>One Show</title></programme>
  </tv>` }));
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('one');
  const row = page.locator('#view-search .search-program-row');
  await expect(row).toContainText('One Show');
  await expect(page.locator('#view-search .search-channel-tile')).toHaveCount(8);
  await input.press('ArrowDown');
  await row.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(row).toHaveClass(/\bfocused\b/);

  const focused = page.locator('#view-search .focused');
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    await page.keyboard.press(key);
    await expect(focused).toHaveCount(1);
    await expect(row).toHaveClass(/\bfocused\b/);
  }
});

test('Left and Right keep a recent search on its line', async ({ page }) => {
  await seedSearch(page);
  const history = Array.from({ length: 10 }, (_, i) => `query number ${String(i + 1)} ${'x'.repeat(i % 3 * 6)}`);
  await page.addInitScript((list) => {
    localStorage.setItem('iptv_search_history', JSON.stringify(list));
  }, history);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const tiles = page.locator('.search-history-dropdown .search-history-tile');
  await expect(tiles).toHaveCount(10);
  const tops = await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  const lineStarts = tops.map((top, i) => (i > 0 && top !== tops[i - 1] ? i : -1)).filter((i) => i > 0);
  // The tiles wrap onto at least three lines.
  expect(lineStarts.length).toBeGreaterThanOrEqual(2);

  await page.locator('.tab-bar-search-input').press('ArrowDown');
  await expect(tiles.first()).toHaveClass(/\bfocused\b/);
  const ringOn = async (i: number) => {
    await tiles.nth(i).evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await expect(tiles.nth(i)).toHaveClass(/\bfocused\b/);
  };
  // The start of the second line, and the end of the second line.
  await ringOn(lineStarts[0]);
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.nth(lineStarts[0])).toHaveClass(/\bfocused\b/);
  await ringOn(lineStarts[1] - 1);
  await page.keyboard.press('ArrowRight');
  await expect(tiles.nth(lineStarts[1] - 1)).toHaveClass(/\bfocused\b/);
});

// AI query expansion waits for typing to pause this long.
const EXPANSION_DELAY_MS = CONFIG.SEARCH.EXPANSION_DELAY_MS;
// The AI client retries a server error twice, after about 2 s and 4 s.
const AI_RETRIES_MS = 10_000;

// An OpenAI-compatible server at http://ai.test/v1 that offers `alternatives`
// for every query (or fails), recording the user messages it was sent.
async function routeSearchAi(
  page: import('@playwright/test').Page,
  alternatives: string[] | null,
  features: Record<string, boolean> = { 'search-expansion': true },
): Promise<string[]> {
  await page.addInitScript((config) => {
    localStorage.setItem('iptv_llm', config);
  }, fakeAiConfig({ features }));
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    sent.push(body.messages.find(m => m.role === 'user')?.content || '');
    if (!alternatives) return route.fulfill({ status: 500, headers: cors, body: 'down' });
    const content = JSON.stringify({ alternatives: alternatives.map(text => ({ text, lang: 'l1', kind: 'translation' })) });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  return sent;
}

test('AI alternatives append results after the exact matches without moving focus', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  const sent = await routeSearchAi(page, ['series']);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('movie');
  const movie = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(movie).toContainText('Movie One');
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  const focused = page.locator('#view-search .focused');
  await expect(focused).toHaveCount(1);
  const key = await focused.getAttribute('data-key');

  const hint = page.locator('#view-search .search-expanded');
  await expect(hint).toContainText('series');
  await expect(hint).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#view-search .catalog-tile[data-series-id="1"]')).toContainText('Series One');
  await expect(focused).toHaveAttribute('data-key', key ?? '');
  expect(sent).toEqual([JSON.stringify({ query: 'movie' })]);
});

test('a failing AI server leaves the search results as they were', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  const sent = await routeSearchAi(page, null);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('movie');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  await runAiTimers(page, AI_RETRIES_MS);
  await expect(page.locator('#view-search .search-expanded')).toHaveCount(0);
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
});

test('search sends nothing to the AI server until Search in other languages is on', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  const sent = await routeSearchAi(page, ['series'], {});
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('movie');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="10"]')).toContainText('Movie One');
  await runAiTimers(page, 2 * EXPANSION_DELAY_MS);
  expect(sent).toEqual([]);

  await enterTab(page, 'settings');
  await page.locator('#ai-search-expansion .toggle-option[data-value="on"]').click();
  await page.locator('#save-settings').click();
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('iptv_llm') || '{}').features?.['search-expansion'])).toBe(true);
});

test('a Cyrillic query finds a channel written in Latin letters without AI', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('чаннел');
  await expect(page.locator('#view-search .catalog-tile[data-channel-index="0"]')).toContainText('Channel One');
  await expect(page.locator('#view-search .search-expanded')).toContainText('channel');
});

// One channel and its guide: "zorb" finds the movie and one program; "quix"
// (the AI alternative) adds the channel and five more of its programs.
async function seedGrowingResults(page: import('@playwright/test').Page, zorbChannel = false): Promise<void> {
  await seedSearch(page);
  await routeLiveManifest(page);
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const titles = ['Zorb Report', 'Quix Report 1', 'Quix Report 2', 'Quix Report 3', 'Quix Report 4', 'Quix Report 5'];
  const programmes = titles.map((title, i) => {
    const from = new Date(start.getTime() + i * 30 * 60 * 1000);
    const to = new Date(from.getTime() + 30 * 60 * 1000);
    return `<programme channel="q1" start="${xmltvTime(from)}" stop="${xmltvTime(to)}"><title>${title}</title></programme>`;
  }).join('');
  await page.route('**/get.php*', (route) => route.fulfill({
    status: 200, contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 tvg-id="q1" group-title="News",Alpha\nhttp://streams.example.com/q1.m3u8\n'
      + '#EXTINF:-1 group-title="News",Quix TV\nhttp://streams.example.com/q2.m3u8'
      + (zorbChannel ? '\n#EXTINF:-1 group-title="News",Zorb TV\nhttp://streams.example.com/q3.m3u8' : ''),
  }));
  await page.route('**/xmltv.php*', (route) => route.fulfill({
    status: 200, contentType: 'application/xml',
    body: `<tv><channel id="q1"><display-name>Alpha</display-name></channel>${programmes}</tv>`,
  }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (!url.includes('get_vod_streams')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { stream_id: 10, name: 'Zorb Movie', stream_icon: '', container_extension: 'mp4', category_id: '1' },
    ]) });
  });
}

const searchScrollTop = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('#view-search .search-view')?.scrollTop ?? -1);

test('a section AI alternatives add goes after the shown ones, in view, and focus stays put', async ({ page }) => {
  await seedGrowingResults(page);
  await routeSearchAi(page, ['quix']);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('zorb');
  await expect(page.locator('#view-search .search-program-row')).toHaveCount(1);
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  const focused = page.locator('#view-search .focused');
  await expect(focused).toHaveCount(1);
  const key = await focused.getAttribute('data-key');
  const before = (await focused.boundingBox())?.y;

  const channel = page.locator('#view-search .catalog-tile[data-channel-index]');
  await expect(channel).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', key ?? '');
  expect(Math.abs(((await focused.boundingBox())?.y ?? 0) - (before ?? 0))).toBeLessThan(2);
  const titles = await page.locator('#view-search .catalog-rail-title').allTextContents();
  expect(titles[titles.length - 1]).toBe('Channels');
  expect(await searchScrollTop(page)).toBe(0);
  await expect(page.locator('#view-search .search-expanded')).toBeInViewport({ ratio: 1 });

  // The new section is reachable from focus.
  for (let i = 0; i < 12 && !(await channel.evaluate(el => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(channel).toHaveClass(/focused/);
  await expect(channel).toBeInViewport();
});

test('a focused movie that programs added above would push off screen stays put', async ({ page }) => {
  await seedGrowingResults(page, true);
  await routeSearchAi(page, ['quix']);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('zorb');
  const movie = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(movie).toBeVisible();
  await page.locator('.tab-bar-search-input').press('ArrowDown');
  for (let i = 0; i < 4 && !(await movie.evaluate(el => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(movie).toHaveClass(/focused/);
  const before = (await movie.boundingBox())?.y;

  await expect(page.locator('#view-search .search-program-row')).toHaveCount(6);
  await expect(movie).toHaveClass(/focused/);
  // At most lifted clear of the hint's band below the results, never pushed down.
  const after = await movie.boundingBox();
  const band = await page.locator('#view-search .search-expanded').boundingBox();
  expect(after!.y).toBeLessThanOrEqual(before ?? 0);
  expect((before ?? 0) - after!.y).toBeLessThanOrEqual(band!.height);
  expect(after!.y + after!.height).toBeLessThanOrEqual(band!.y);
});

test('results growing while focus is back in the search box do not scroll the view', async ({ page }) => {
  await seedGrowingResults(page, true);
  await routeSearchAi(page, ['quix']);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  const input = page.locator('.tab-bar-search-input');
  await input.fill('zorb');
  const movie = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(movie).toBeVisible();
  await input.press('ArrowDown');
  for (let i = 0; i < 4 && !(await movie.evaluate(el => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(movie).toHaveClass(/focused/);
  for (let i = 0; i < 4 && !(await input.evaluate(el => el === document.activeElement)); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(input).toBeFocused();

  await expect(page.locator('#view-search .search-program-row')).toHaveCount(6);
  await expect(page.locator('#view-search .search-expanded')).toBeVisible();
  expect(await searchScrollTop(page)).toBe(0);
});

test('results growing under the pointer do not scroll the view', async ({ page }) => {
  await seedGrowingResults(page, true);
  await routeSearchAi(page, ['quix']);
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);

  await page.locator('.tab-bar-search-input').fill('zorb');
  const movie = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(movie).toBeVisible();
  await movie.hover();
  await expect(page.locator('#view-search .search-program-row')).toHaveCount(6);
  await expect(page.locator('#view-search .search-expanded')).toBeVisible();
  expect(await searchScrollTop(page)).toBe(0);
});

test('a long list of AI alternatives stays on one line', async ({ page }) => {
  await seedSearch(page);
  await routeLiveManifest(page);
  await routeSearchAi(page, Array.from({ length: 6 }, (_, i) => `series${'x'.repeat(40)}${i}`));
  await page.route('**/player_api.php*', async (route) => {
    if (!route.request().url().includes('get_series')) return route.fallback();
    if (route.request().url().includes('get_series_')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      Array.from({ length: 6 }, (_, i) => ({ series_id: i + 1, name: `Series${'x'.repeat(40)}${i}`, cover: '', category_id: '1' })),
    ) });
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  await page.locator('.tab-bar-search-input').fill('movie');
  const hint = page.locator('#view-search .search-expanded');
  await expect(hint).toBeVisible();
  const box = await hint.evaluate((el) => ({
    oneLine: el.scrollHeight <= el.clientHeight,
    clipped: el.scrollWidth > el.clientWidth,
  }));
  expect(box).toEqual({ oneLine: true, clipped: true });
});

// Two groups with one upcoming program each, and a fake AI server answering
// with `filter`, or failing with `status`.
async function seedAiSearch(
  page: import('@playwright/test').Page,
  reply: { status?: number; filter?: Record<string, unknown> },
): Promise<string[]> {
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="c1" group-title="Group A",Alpha One', 'http://host/a',
    '#EXTINF:-1 tvg-id="c2" group-title="Group B",Bravo Two', 'http://host/b',
  ].join('\n');
  const epg = `<tv>
    <channel id="c1"><display-name>Alpha One</display-name></channel>
    <channel id="c2"><display-name>Bravo Two</display-name></channel>
    <programme channel="c1" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Alpha Show Time Cup</title><category>Genre A</category>
    </programme>
    <programme channel="c2" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Alpha Show Time Talk</title><category>Genre B</category>
    </programme>
  </tv>`;
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: m3u }));
  await page.route('**/guide.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.addInitScript((config) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_llm', config);
  }, fakeAiConfig());
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    sent.push(body.messages.find(m => m.role === 'user')?.content || '');
    if (reply.status) return route.fulfill({ status: reply.status, headers: cors, body: 'Server error' });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply.filter) } }] }) });
  });
  return sent;
}

test('AI search shows the programs of the named group and sets a reminder from them', async ({ page }) => {
  const sent = await seedAiSearch(page, { filter: {
    types: ['program'], keywords: ['alpha'], groups: ['Group A'], genres: [],
    time: 'any', from_hour: -1, to_hour: -1,
  } });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('alpha show time');
  const ask = page.locator('#view-search .search-ask-action');
  await expect(ask).toHaveText('Search with AI: “alpha show time”');
  expect(sent).toEqual([]);

  // Down from the box opens the results; the AI search sits above them.
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .search-program-row').first()).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowUp');
  await expect(ask).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-search .search-ask-summary'))
    .toHaveText('AI search · Group A · “alpha”');
  const rows = page.locator('#view-search .search-program-row');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Alpha Show Time Cup');
  // Only the query and the names in the lists leave the device.
  expect(sent.map(user => JSON.parse(user) as unknown)).toEqual([{
    query: 'alpha show time',
    types: ['channel', 'program'],
    groups: expect.arrayContaining(['Group A', 'Group B']) as unknown,
    genres: expect.arrayContaining(['Genre A', 'Genre B']) as unknown,
  }]);

  await page.keyboard.press('ArrowDown');
  await expect(rows.first()).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText('Reminder set');

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-search .search-ask-summary')).toHaveCount(0);
  await expect(page.locator('#view-search .search-program-row')).toHaveCount(2);
  await expect(ask).toHaveText('Search with AI: “alpha show time”');
});

test('a failed AI search keeps all results and says so', async ({ page }) => {
  await seedAiSearch(page, { status: 400 });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('alpha show time');
  await input.press('ArrowDown');
  await expect(page.locator('#view-search .search-program-row').first()).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-search .search-ask-action')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-search .search-ask-note')).toHaveText('AI search failed. Showing all results.');
  await expect(page.locator('#view-search .search-program-row')).toHaveCount(2);
  await expect(page.locator('#view-search .search-ask-action')).toHaveClass(/\bfocused\b/);
});

test('AI search sits on the first heading\'s line, and its summary shares a line with Show all results', async ({ page }) => {
  await seedAiSearch(page, { filter: {
    types: ['program'], keywords: ['alpha'], groups: ['Group A'], genres: [],
    time: 'any', from_hour: -1, to_hour: -1,
  } });
  await page.goto('/');
  await liveLoaded(page);
  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('alpha');
  const ask = page.locator('#view-search .search-ask-action');
  await expect(ask).toHaveText('Search with AI: “alpha”');
  const heading = page.locator('#view-search .catalog-rail-title').first();
  const middle = async (locator: import('@playwright/test').Locator): Promise<number> => {
    const box = await locator.boundingBox();
    return box ? box.y + box.height / 2 : NaN;
  };
  // Beside the first heading, not in a row of its own above it.
  expect(Math.abs(await middle(ask) - await middle(heading))).toBeLessThanOrEqual(2);
  const results = await page.locator('#view-search .search-results').boundingBox();
  expect((await heading.boundingBox())?.y).toBeLessThanOrEqual((results?.y ?? 0) + 2);

  await input.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(ask).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  const summary = page.locator('#view-search .search-ask-summary');
  await expect(summary).toHaveText('AI search · Group A · “alpha”');
  await expect(ask).toHaveText('Show all results');
  expect(Math.abs(await middle(ask) - await middle(summary))).toBeLessThanOrEqual(4);

  await input.fill('zulu');
  const empty = page.locator('#view-search .search-empty');
  await expect(empty).toHaveText('No results found.');
  await expect(ask).toHaveText('Search with AI: “zulu”');
  expect(Math.abs(await middle(ask) - await middle(empty))).toBeLessThanOrEqual(4);
  await input.press('Enter');
  await expect(ask).toHaveClass(/\bfocused\b/);
});

// AI program genres off, one upcoming program without a category and one
// with, and a fake AI server: genres for the genre requests, `filter` for AI search.
async function seedGenreSearch(
  page: import('@playwright/test').Page,
  filter: Record<string, unknown>,
): Promise<string[]> {
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="c1" group-title="Group A",Alpha One', 'http://host/a',
    '#EXTINF:-1 tvg-id="c2" group-title="Group B",Bravo Two', 'http://host/b',
  ].join('\n');
  const epg = `<tv>
    <channel id="c1"><display-name>Alpha One</display-name></channel>
    <channel id="c2"><display-name>Bravo Two</display-name></channel>
    <programme channel="c1" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Alpha Show Time Cup</title><desc>Synthetic description.</desc>
    </programme>
    <programme channel="c2" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}">
      <title>Alpha Show Time Talk</title><category>Genre B</category>
    </programme>
  </tv>`;
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: m3u }));
  await page.route('**/guide.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  });
  const server = await routeFakeAi(page, (user) => {
    const sent = JSON.parse(user) as { items?: Array<{ i: number }> };
    return sent.items ? { items: sent.items.map(item => ({ i: item.i, g: 'sports' })) } : filter;
  });
  return server.sent;
}

// The prompt grows with the text size, so at 150 a Chinese line doesn't split a word.
test('the AI program genres estimate keeps each line whole at the largest text size', async ({ page }) => {
  await seedGenreSearch(page, {});
  await page.addInitScript(() => {
    localStorage.setItem('iptv_locale', JSON.stringify('zh-CN'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'settings');
  await page.locator('#view-settings .settings-nav-item[data-settings-target="ai"]').click();
  await page.locator('#ai-program-genres .toggle-option[data-value="on"]').click();
  const message = page.locator('.confirmation-prompt .confirmation-message');
  await expect(page.locator('.confirmation-prompt [data-confirm-action="confirm"]')).toBeEnabled();
  const lines = await message.evaluate((el) => {
    const style = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight));
  });
  expect(lines).toBe(2);
});

test('AI program genres ask before the first run, then Search shows and filters by them', async ({ page }) => {
  const sent = await seedGenreSearch(page, {
    types: ['program'], keywords: [], groups: [], genres: ['Sports'], time: 'any', from_hour: -1, to_hour: -1,
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'settings');
  await page.locator('#view-settings .settings-nav-item[data-settings-target="ai"]').click();
  await page.locator('#ai-program-genres .toggle-option[data-value="on"]').click();
  const prompt = page.locator('.confirmation-prompt');
  await expect(prompt.locator('.confirmation-title')).toHaveText('AI program genres');
  await expect(prompt.locator('.confirmation-message')).toHaveText(
    'Programs without a genre in the next 24 hours: 1 About 1 request will be sent to your AI server.');
  // Cancel leaves it off.
  await page.keyboard.press('Escape');
  await expect(page.locator('#ai-program-genres .toggle-option.active')).toHaveAttribute('data-value', 'off');
  await page.locator('#ai-program-genres .toggle-option[data-value="on"]').click();
  await prompt.locator('[data-confirm-action="confirm"]').click();
  await expect(page.locator('#ai-program-genres .toggle-option.active')).toHaveAttribute('data-value', 'on');
  expect(sent).toEqual([]);
  await page.locator('#save-settings').click();

  await expect.poll(() => sent.length).toBe(1);
  // Only the program without a category is sent: its title and description.
  expect((JSON.parse(sent[0]) as { items: unknown }).items)
    .toEqual([{ i: 0, t: 'Alpha Show Time Cup', d: 'Synthetic description.' }]);
  expect(sent[0]).not.toContain('Alpha One');
  await expect(page.locator('#ai-program-genres-status')).toHaveText('Programs with an AI genre: 1');

  await enterSearch(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('alpha show time');
  const rows = page.locator('#view-search .search-program-row');
  await expect(rows).toHaveCount(2);
  const cup = rows.filter({ hasText: 'Alpha Show Time Cup' }).locator('.search-program-channel');
  await expect(cup).toHaveText('Alpha One · Sports');
  await expect(cup.locator('.ai-icon svg')).toHaveCount(1);
  const talk = rows.filter({ hasText: 'Alpha Show Time Talk' }).locator('.search-program-channel');
  await expect(talk).toHaveText('Bravo Two · Genre B');
  await expect(talk.locator('.ai-icon')).toHaveCount(0);

  // AI search offers the AI genre with the guide's and filters by it.
  await input.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-search .search-ask-action')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Alpha Show Time Cup');
  expect((JSON.parse(sent[1]) as { genres: string[] }).genres.sort()).toEqual(['Genre B', 'Sports']);
});


// Two upcoming programs that match "report" and one that matches "movie", and an AI server that adds " (de)"
// to every "[Tn]"/"[Dn]" line it is sent.
async function seedTranslatedSearch(page: import('@playwright/test').Page): Promise<string[]> {
  await seedSearch(page);
  await routeLiveManifest(page);
  await startClock(page);
  const start = new Date(NOW.getTime() + HOUR_MS);
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const epg = `<tv>
    <channel id="one"><display-name>Channel One</display-name></channel>
    <channel id="two"><display-name>Channel Two</display-name></channel>
    <programme channel="one" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}"><title>Future Report</title></programme>
    <programme channel="two" start="${xmltvTime(start)}" stop="${xmltvTime(stop)}"><title>Later Report</title></programme>
    <programme channel="two" start="${xmltvTime(stop)}" stop="${xmltvTime(new Date(stop.getTime() + 60 * 60 * 1000))}"><title>Movie Night</title></programme>
  </tv>`;
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.addInitScript((config) => {
    localStorage.setItem('iptv_llm', config);
  }, fakeAiConfig());
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(m => m.role === 'user')?.content || '';
    sent.push(user);
    const content = user.split('\n').map(line => `${line} (de)`).join('\n');
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  return sent;
}

// Translate on a movie result's detail turns on the session's translation; Back returns to Search.
async function translateFromMovieResult(page: import('@playwright/test').Page): Promise<void> {
  await enterSearch(page);
  await openMovieResult(page, 'movie');
  const button = page.locator('#view-movies [data-key="translate"]');
  for (let i = 0; i < 6 && !(await button.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-label', 'Show original');
  // The movie's own translation lands first, so nothing it brings re-renders Search.
  await expect(page.locator('#view-movies .detail-title')).toHaveText('Movie One (de)');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-search')).toBeVisible();
}

test('with translation on, the program rows on screen translate in one request once typing settles', async ({ page }) => {
  const sent = await seedTranslatedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await translateFromMovieResult(page);
  const programRequests = () => sent.filter(user => user.includes('Report'));

  const input = page.locator('.tab-bar-search-input');
  await input.fill('');
  // Typed 60 ms apart on held time, so no partial query outlasts the dwell on a slow machine.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 2000));
  for (const letter of 'report') {
    await input.press(letter);
    await page.clock.runFor(60);
  }
  await page.clock.resume();
  const titles = page.locator('#view-search .search-program-title');
  await expect(titles).toHaveCount(2);
  await expect.poll(async () => (await titles.allTextContents()).sort())
    .toEqual(['Future Report (de)', 'Later Report (de)']);
  expect(programRequests()).toHaveLength(1);
  expect(programRequests()[0]).toMatch(/^\[T1\] (Future|Later) Report\n\[T2\] (Future|Later) Report$/);

  // The AI mark is the title's size, half of it from the title, in the title's color.
  const mark = await titles.first().locator('.ai-icon.is-title-mark').evaluate((el) => {
    const style = getComputedStyle(el);
    const title = getComputedStyle(el.parentElement!);
    return { width: style.width, height: style.height, gap: style.marginRight, title: title.fontSize, sameColor: style.color === title.color };
  });
  expect(mark).toEqual({ width: '28px', height: '28px', gap: '14px', title: '28px', sameColor: true });
  await expect(titles.locator('.ai-icon svg')).toHaveCount(2);

  // The same rows again come from what was kept: nothing is sent.
  await input.fill('');
  await input.fill('report');
  await expect.poll(async () => (await titles.allTextContents()).sort())
    .toEqual(['Future Report (de)', 'Later Report (de)']);
  await runAiTimers(page, 2 * TRANSLATION_DWELL_MS);
  expect(programRequests()).toHaveLength(1);
});

test('after a reload, program rows translated before come back without a request', async ({ page }) => {
  const sent = await seedTranslatedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await translateFromMovieResult(page);
  const input = page.locator('.tab-bar-search-input');
  await input.fill('report');
  const titles = page.locator('#view-search .search-program-title');
  await expect.poll(async () => (await titles.allTextContents()).sort())
    .toEqual(['Future Report (de)', 'Later Report (de)']);
  const before = sent.length;

  await page.reload();
  await liveLoaded(page);
  await translateFromMovieResult(page);
  await input.fill('report');
  await expect.poll(async () => (await titles.allTextContents()).sort())
    .toEqual(['Future Report (de)', 'Later Report (de)']);
  await runAiTimers(page, 2 * TRANSLATION_DWELL_MS);
  expect(sent).toHaveLength(before);
});

// Regression: rows rendered while translation was off stayed untranslated on return to Search.
test('translation turned on in a result\'s detail translates the Search rows on return', async ({ page }) => {
  const sent = await seedTranslatedSearch(page);
  await page.goto('/');
  await liveLoaded(page);
  await translateFromMovieResult(page);
  const title = page.locator('#view-search .search-program-title', { hasText: 'Movie Night' });
  await expect(title).toHaveText('Movie Night (de)');
  expect(sent.filter(user => user.includes('Movie Night'))).toHaveLength(1);
});
