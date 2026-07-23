import { test, expect, routePlaylist, seedPlaylist, SEARCH_M3U, enterTab, routeLiveManifest } from './helpers';

// The channel list: rendering safety (XSS), group filtering, and the fact that
// search + settings now live in the docked tab bar (not the sidebar).

test('a malicious channel name from the playlist is escaped, not executed', async ({ page }) => {
  const EVIL = '<img src=x onerror="window.__xssfired=true">';
  const evilM3u = [
    '#EXTM3U',
    `#EXTINF:-1 tvg-id="evil" group-title="News",${EVIL}`,
    'http://streams.example.com/evil.m3u8',
  ].join('\n');

  await routePlaylist(page, evilM3u);
  await seedPlaylist(page);
  await page.goto('/');

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(1);

  // The name is rendered as literal text, escaped...
  await expect(page.locator('.channel-main .channel-name')).toContainText('<img src=x onerror=');
  // ...so no injected <img> element exists and its onerror never fired.
  await expect(page.locator('.channel-main img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xssfired?: boolean }).__xssfired)).toBeUndefined();
});

test('the sidebar has no inline search magnifier or settings gear (moved to the tab bar)', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('#view-channels .search-icon')).toHaveCount(0);
  await expect(page.locator('#view-channels .channel-search')).toHaveCount(0);
  await expect(page.locator('#view-channels .settings-btn')).toHaveCount(0);
  await expect(page.locator('.sidebar-title')).toHaveCount(0);
  // The channel count remains in the sidebar.
  await expect(page.locator('.channel-count')).toBeVisible();
});

test('selecting a group filters the channel list', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(4);

  await page.locator('[data-group="source:News"]').click();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  await expect(page.locator('.channel-main')).toContainText('Alpha News');
  await expect(page.locator('.channel-main')).not.toContainText('Delta Sports');
});

test('M3U-only Search (via the tab bar) filters channels into a vertical list', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
  await page.locator('.tab-bar-search-input').fill('alpha');
  // Channels-only, rendered as a vertical list (no poster rails).
  await expect(page.locator('.search-channel-row')).toHaveCount(2);
  await expect(page.locator('#view-search')).toBeVisible();
  await expect(page.locator('.search-results')).toContainText('Alpha News');
  await expect(page.locator('.catalog-rail')).toHaveCount(0);
});

test('M3U-only Search: a pointer click plays the channel', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
  await page.locator('.tab-bar-search-input').fill('alpha');
  await expect(page.locator('.search-channel-row')).toHaveCount(2);

  // Dispatch a click at the row's center, which the view activates by coordinate
  // hit-test.
  await page.locator('.search-channel-row').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', {
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true,
    }));
  });
  await expect(page.locator('#view-player')).toBeVisible();
});
