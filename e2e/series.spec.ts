import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab } from './helpers';

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

test('browse Series, open a detail, and play an episode', async ({ page }) => {
  await seedSeries(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock episode file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(page.locator('#view-channels')).toBeVisible();
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
  await expect(page.locator('#view-channels')).toBeVisible();

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

  // The right edge opens the menu for an episode too, but as the VOD variant:
  // Title Info and Settings only (this VOD exposes no audio/subtitle tracks) —
  // never the live channel rows or the "Playing:" channel name.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  await expect(menu).toContainText('Settings');
  expect(await menu.textContent()).not.toContain('Program Guide');
  expect(await menu.textContent()).not.toContain('Toggle Favorite');
  expect(await menu.textContent()).not.toContain('Playing:');
});
