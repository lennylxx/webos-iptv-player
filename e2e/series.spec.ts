import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, liveLoaded } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// series calls + the get.php/xmltv.php the live path uses.
async function seedSeries(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_series_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_series_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        episodes: { '1': [
          { id: 10, title: 'Episode One', season: 1, episode_num: 1, container_extension: 'mp4', info: { plot: 'Ep plot.', duration_secs: 1500, movie_image: '' } },
        ] },
      }) });
    }
    if (url.includes('get_series')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { series_id: 1, name: 'Series One', cover: '', category_id: '1' },
      ]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // The episode file itself: a small response so play() doesn't hang the test.
  await page.route('**/series/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

test('Continue Watching updates the hero from saved episodes by pointer and remote without loading details', async ({ page }) => {
  await seedSeries(page);
  const details: string[] = [];
  page.on('request', request => {
    if (request.url().includes('action=get_series_info')) details.push(request.url());
  });
  await page.route('http://host/hero/**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#468"/></svg>',
  }));
  await page.addInitScript(() => {
    const resume: Record<string, unknown> = {};
    for (const n of [1, 2]) {
      resume[`x1|episode|e${n}`] = {
        accountId: 'x1', kind: 'episode', itemId: `e${n}`, name: `Episode ${n}`,
        poster: `http://host/hero/${n}.svg`, ext: 'mp4',
        position: 100, duration: 600, updatedAt: 3 - n,
      };
    }
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  });
  await page.goto('/');
  await enterTab(page, 'series');
  const view = page.locator('#view-series');
  const hero = view.locator('.catalog-hero');
  const first = view.locator('[data-resume-episode="e1"]');
  const second = view.locator('[data-resume-episode="e2"]');
  await first.hover();
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 1');
  await expect(hero).toHaveCSS('background-image', /\/hero\/1\.svg/);
  await second.hover();
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 2');
  await expect(hero).toHaveCSS('background-image', /\/hero\/2\.svg/);
  await page.keyboard.press('ArrowLeft');
  await expect(first).toHaveClass(/focused/);
  await expect(view.locator('.catalog-hero-title')).toHaveText('Episode 1');
  await expect(hero).toHaveCSS('background-image', /\/hero\/1\.svg/);
  expect(details).toEqual([]);
});

test('a Continue Watching series opens its detail on Resume, and Back returns there', async ({ page }) => {
  await seedSeries(page);
  await neuterVideo(page);
  await page.addInitScript(() => {
    const resume: Record<string, unknown> = {};
    for (const [itemId, label, updatedAt] of [['10', 'S1E1 — Episode One', 2], ['9', 'S1E0', 1]] as const) {
      resume[`x1|episode|${itemId}`] = {
        accountId: 'x1', kind: 'episode', itemId, name: `Series One — ${label}`, poster: '', ext: 'mp4',
        categoryId: '1', position: 100, duration: 600, updatedAt,
        watchlistOwner: { kind: 'series', itemId: '1', name: 'Series One', poster: '' },
      };
    }
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  });
  await page.goto('/');
  await enterTab(page, 'series');
  const view = page.locator('#view-series');
  const tile = view.locator('[data-rail-key="continue"] .catalog-tile');
  await expect(tile).toHaveCount(1);
  await expect(tile.locator('.catalog-tile-name')).toHaveText('Series One');
  await expect(tile.locator('.catalog-tile-sub')).toHaveText('S1 E1');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');

  const resume = view.locator('[data-action="resume"]');
  await expect(resume).toHaveClass(/focused/);
  await expect(resume).toContainText('S1 E1');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(view.locator('.series-detail')).toBeVisible();
  await expect(resume).toHaveClass(/focused/);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(tile).toHaveClass(/focused/);
});

test('stepping right along Continue Watching keeps a series\' stacked cards in view', async ({ page }) => {
  await seedSeries(page);
  await page.addInitScript(() => {
    const resume: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      resume[`x1|episode|e${i}`] = {
        accountId: 'x1', kind: 'episode', itemId: `e${i}`, name: `Series ${i} — S1E1`, poster: '', ext: 'mp4',
        position: 100, duration: 600, updatedAt: 20 - i, season: 1, episode: 1,
        watchlistOwner: { kind: 'series', itemId: `s${i}`, name: `Series ${i}`, poster: '' },
      };
    }
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  });
  await page.goto('/');
  await enterTab(page, 'series');
  const track = page.locator('#view-series [data-rail-key="continue"] .catalog-rail-track');
  const tiles = track.locator('.catalog-tile-stack');
  await tiles.first().evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('ArrowRight');
  for (let i = 1; i < 8; i++) {
    await page.keyboard.press('ArrowRight');
    await expect(tiles.nth(i + 1)).toHaveClass(/focused/);
  }
  await expect.poll(() => track.evaluate((el) => {
    const tile = el.querySelector<HTMLElement>('.catalog-tile.focused')!;
    const back = parseFloat(getComputedStyle(tile, '::after').width);
    return el.getBoundingClientRect().right - (tile.getBoundingClientRect().left + back);
  })).toBeGreaterThanOrEqual(0);
});

test('CH+ and CH- step through a series\' episodes, as the OSD skips do', async ({ page }) => {
  await seedSeries(page);
  await neuterVideo(page);
  await page.route('**/player_api.php*action=get_series_info*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      episodes: { '1': [1, 2, 3].map((n) => ({
        id: 10 + n, title: `Episode ${n}`, season: 1, episode_num: n, container_extension: 'mp4',
        info: { plot: '', duration_secs: 1500, movie_image: '' },
      })) },
    }),
  }));
  await page.goto('/');
  await enterTab(page, 'series');
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await page.locator('.episode-row[data-episode-id="12"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');

  const osd = page.locator('#player-osd');
  const title = osd.locator('.osd-vod-detail');
  const previous = osd.locator('[data-skip-episode="-1"]');
  const next = osd.locator('[data-skip-episode="1"]');
  await expect(title).toContainText('S1 E2');
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();

  await page.keyboard.press('PageUp');
  await expect(title).toContainText('S1 E3');
  await expect(next).toBeDisabled();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect(title).toContainText('S1 E1');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(title).toContainText('S1 E2');
});

test('browse Series, open a detail, and play an episode', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock episode file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter Series via the docked tab bar.
  await enterTab(page, 'series');
  await expect(page.locator('#view-series')).toBeVisible();

  await expect(page.locator('#view-series .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('.catalog-tile[data-item-id="1"]')).toContainText('Series One');

  // Open the series detail. Dispatch an explicit bubbling nav:hover so
  // SpatialNav's container-bound listener focuses the tile before OK.
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-series .series-season-btn[data-season="1"]')).toContainText('Season 1');
  await expect(page.locator('#view-series .episode-row[data-episode-id="10"]')).toContainText('Episode One');

  // Play the episode, then Back returns to the Series view.
  await page.locator('.episode-row[data-episode-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Back key (CONFIG.KEYS.BACK = 461; Backspace is unmapped); dispatch a raw
  // keydown like the other specs do.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-series')).toBeVisible();
  // The detail survives the player round-trip (Series isn't re-rendered on return).
  await expect(page.locator('#view-series .episode-row[data-episode-id="10"]')).toContainText('Episode One');
});

test('Back walks Series detail -> browse -> Live instead of ejecting', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter Series via the docked tab bar.
  await enterTab(page, 'series');
  await expect(page.locator('#view-series')).toBeVisible();

  await expect(page.locator('.catalog-tile[data-item-id="1"]')).toContainText('Series One');

  // Open the series detail.
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-series .series-season-btn[data-season="1"]')).toContainText('Season 1');

  // First Back steps detail -> browse: still inside Series, not ejected to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-series')).toBeVisible();
  await expect(page.locator('#view-series .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('#view-channels')).toBeHidden();

  // Second Back from the browse top level returns to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await liveLoaded(page);
});

test('episode playback suppresses the live channel sidebar and shows a VOD-only menu at the pointer edges', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  // Keep VOD alive in the player: neuter the <video> so the empty mock episode
  // file doesn't fire `error` and eject back to Series before we probe the edges.
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
  await page.goto('/');
  await liveLoaded(page);

  // Enter Series, open a detail, and play an episode (VOD mode).
  await enterTab(page, 'series');
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await page.locator('.episode-row[data-episode-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Wait until VOD playback has fully settled (the VOD OSD shows the title and,
  // being paused, stays up) so the pointer probe isn't racing the transition.
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // The left edge opens the channel switcher during live playback; an episode
  // has no channels, so the pointer must not summon it. Check once (not a
  // retrying wait) — the sidebar auto-hides, which would mask a wrong show.
  await page.mouse.move(10, 540);
  await page.waitForTimeout(200);
  expect(await page.locator('#player-sidebar.visible').count()).toBe(0);

  // The right edge opens the VOD menu for an episode too, including playback
  // speed but never the live channel rows or the "Playing:" channel name.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  await expect(menu).toContainText('Settings');
  await expect(menu).toContainText('Playback Speed');
  expect(await menu.textContent()).not.toContain('Program Guide');
  expect(await menu.textContent()).not.toContain('Toggle Favorite');
  expect(await menu.textContent()).not.toContain('Playing:');
});

test('Down from the tab bar resumes the Series detail Up left', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'series');
  await page.locator('.catalog-tile[data-item-id="1"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  const season = page.locator('#view-series .series-season-btn[data-season="1"]');
  await expect(season).toContainText('Season 1');

  for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item[data-section="series"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(season).toBeVisible();
  await expect(page.locator('#view-series .focused')).toHaveCount(1);
});

const settled = (page: import('@playwright/test').Page) => page.evaluate(() =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// How far the element sticks out of the catalog's vertical scroller, in px.
const overhang = (el: Element): number => {
  let scroller = el.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  const box = el.getBoundingClientRect();
  const clip = scroller?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  return Math.max(0, clip.top - box.top, box.bottom - Math.min(clip.bottom, innerHeight));
};

test('a key that only shows the ring brings a clipped tile into view', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'series');
  const tile = page.locator('#view-series .catalog-tile').first();
  await expect(tile).toBeVisible();
  await settled(page);

  // Larger text leaves the tile hanging off the bottom at the resting offset.
  const clip = await tile.evaluate((el) => {
    const rails = el.closest<HTMLElement>('.catalog-rails')!;
    rails.style.scrollBehavior = 'auto';
    rails.scrollTop = 0;
    rails.style.scrollBehavior = '';
    return el.getBoundingClientRect().bottom - innerHeight;
  });
  expect(clip).toBeGreaterThan(8);
  await settled(page);
  const box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await expect(tile).toHaveClass(/\bfocused\b/);
  const key = await tile.getAttribute('data-key');
  await settled(page);

  await page.keyboard.press('ArrowRight');
  const focused = page.locator('#view-series .focused');
  await expect(focused).toHaveCount(1);
  await expect.poll(() => focused.evaluate(overhang)).toBeLessThanOrEqual(1);
  expect(await focused.getAttribute('data-key')).toBe(key);
});

test('opening the section with the pointer leaves the catalog where it loads', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'series');
  const first = page.locator('#view-series .catalog-tile').first();
  await expect(first).toBeVisible();
  await settled(page);
  await settled(page);

  expect(await page.locator('#view-series .catalog-rails').evaluate((el) => el.scrollTop)).toBe(0);
  // Focus waits on the first tile, without a ring, for the first key.
  await expect(page.locator('#view-series .focused')).toHaveCount(0);
  const parked = page.locator('#view-series .focused-parked');
  await expect(parked).toHaveCount(1);
  expect(await parked.getAttribute('data-key')).toBe(await first.getAttribute('data-key'));
});
