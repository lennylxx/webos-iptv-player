import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab } from './helpers';

// Seed one Xtream account so the tab bar is enabled; its get.php serves the
// sample M3U so the channels view loads normally.
async function seedXtream(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

test('the tab bar is docked (always visible) and offsets the content below it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Always visible on the channels view — no pointer reveal needed.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item')).toHaveText(['Live', 'Guide', 'Movies', 'Series', 'Settings', '']);
  // Search is the far-right magnifier icon (no text label).
  await expect(page.locator('.tab-bar-item[data-section="search"] svg')).toBeVisible();
  // Docked → the view sits below the bar (top offset applied via the body class).
  await expect(page.locator('body.tabbar-docked')).toHaveCount(1);
});

test('clicking the Movies tab enters the Movies view', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();
});

test('the Guide tab opens the EPG below the docked bar, and Back returns to Live', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  // The guide is a section now: the bar stays docked with Guide active.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="epg"].active')).toHaveCount(1);
  const bar = (await page.locator('.tab-bar').boundingBox())!;
  const epg = (await page.locator('#view-epg .epg-view').boundingBox())!;
  expect(epg.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="live"].active')).toHaveCount(1);
});

test('the Settings tab (after Series) opens the settings view', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('the tab bar is hidden during full-screen playback', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar')).toBeVisible();

  // Play the focused channel; the player takes over full-screen and the bar hides.
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.tab-bar')).toBeHidden();
  await expect(page.locator('body.tabbar-docked')).toHaveCount(0);
});

test('the search box keeps the current view until a query is typed, then covers it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Open the search box from the channels view.
  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();

  // No results view yet (no "Type to search" hint covering the content).
  await expect(page.locator('#view-search')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();

  // Typing shows the results view over the current one.
  await page.locator('.tab-bar-search-input').fill('Channel');
  await expect(page.locator('#view-search')).toBeVisible();

  // Clearing the box restores the underlying view.
  await page.locator('.tab-bar-search-input').fill('');
  await expect(page.locator('#view-search')).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('opening Search does not cancel the catalog loading underneath it', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  let releaseCategories = () => {};
  let markCategoriesRequested = () => {};
  const categoriesRequested = new Promise<void>((resolve) => {
    markCategoriesRequested = resolve;
  });
  const categoryGate = new Promise<void>((resolve) => {
    releaseCategories = resolve;
  });
  await page.route('**/player_api.php*', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'get_vod_categories') {
      markCategoriesRequested();
      await categoryGate;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]),
      });
      return;
    }
    if (action === 'get_vod_streams') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          stream_id: '10',
          name: 'Movie One',
          category_id: '1',
          container_extension: 'mp4',
        }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'movies');
  await categoriesRequested;
  await enterTab(page, 'search');
  releaseCategories();

  await expect(page.locator('#view-movies')).toContainText('Movie One');
});

test('M3U-only shows a docked bar with Live/Guide/Settings/Search only (no Movies/Series)', async ({ page }) => {
  await page.route('**/playlist.m3u', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { name: 'Test', url: 'http://host.example.com/playlist.m3u' },
    ]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // The bar is docked, but with the reduced M3U section set.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item')).toHaveText(['Live', 'Guide', 'Settings', '']);
  await expect(page.locator('.tab-bar-item[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="series"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="search"] svg')).toBeVisible();
  await expect(page.locator('body.tabbar-docked')).toHaveCount(1);

  // With no Xtream account the account slot is empty and collapses, so the
  // search magnifier stays flush against the bar's right edge (no dangling gap).
  await expect(page.locator('.account-avatar')).toHaveCount(0);
  // Simulate the later-loaded webOS 4 flex-gap fallback. Its sibling margin
  // must not override the search slot's auto margin.
  await page.addStyleTag({
    content: '.tab-bar-inner > * + * { margin-left: 32px; }',
  });
  const inner = (await page.locator('.tab-bar-inner').boundingBox())!;
  const icon = (await page.locator('.tab-bar-search .search-icon').boundingBox())!;
  expect((inner.x + inner.width) - (icon.x + icon.width)).toBeLessThan(4);
});

test('no playlist or account configured shows Live/Guide/Settings/Search only (no Movies/Series)', async ({ page }) => {
  // Seed nothing — first run opens onboarding Settings with the bar docked.
  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();

  // The docked bar must not offer the Xtream-only Movies/Series sections.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item[data-section="series"]')).toHaveCount(0);
  await expect(page.locator('.tab-bar-item')).toHaveText(['Live', 'Guide', 'Settings', '']);
  await expect(page.locator('.account-avatar')).toHaveCount(0);
});

test('leaving Settings (Cancel) moves the active tab back to Live', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Settings');

  // Cancel returns to the channel list — and the active tab follows.
  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Live');
});
