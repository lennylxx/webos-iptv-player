import {
  expect,
  enterTab,
  routeLiveManifest,
  routePlaylist,
  SAMPLE_M3U,
  seedPlaylist,
  test,
} from './helpers';

test('disabling every M3U source hides channels until the source is enabled again', async ({
  page,
}) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);

  await enterTab(page, 'settings');
  await page.locator('#playlist-entries .source-toggle').click();
  await page.locator('#save-settings').click();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
  await expect(page.locator('.empty-state'))
    .toContainText('No sources are enabled. Enable one in Settings.');
  await expect.poll(() => page.evaluate(() => {
    const sources = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
    return sources[0]?.enabled;
  })).toBe(false);

  await enterTab(page, 'settings');
  await page.locator('#playlist-entries .source-toggle').click();
  await page.locator('#save-settings').click();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => {
    const sources = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
    return 'enabled' in sources[0];
  })).toBe(false);
});

test('disabling the only Xtream account hides its sections until re-enabled', async ({
  page,
}) => {
  await page.route('**/get.php*', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: SAMPLE_M3U,
  }));
  await page.route('**/xmltv.php*', route => route.fulfill({
    status: 200,
    contentType: 'application/xml',
    body: '<tv></tv>',
  }));
  await page.route('**/player_api.php*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1',
      name: 'Account 1',
      url: 'http://host.example.com:8080',
      source: 'xtream',
      xtream: { username: 'u1', password: 'p1' },
    }]));
  });
  await page.goto('/');
  await expect(page.locator('[data-section="movies"]')).toBeVisible();
  await expect(page.locator('[data-section="series"]')).toBeVisible();
  await expect(page.locator('.account-avatar')).toBeVisible();

  await enterTab(page, 'settings');
  await page.locator('#xtream-entries .source-toggle').click();
  await page.locator('#save-settings').click();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('[data-section="movies"]')).toHaveCount(0);
  await expect(page.locator('[data-section="series"]')).toHaveCount(0);
  await expect(page.locator('.account-avatar')).toHaveCount(0);

  await enterTab(page, 'settings');
  await page.locator('#xtream-entries .source-toggle').click();
  await page.locator('#save-settings').click();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('[data-section="movies"]')).toBeVisible();
  await expect(page.locator('[data-section="series"]')).toBeVisible();
  await expect(page.locator('.account-avatar')).toBeVisible();
});
