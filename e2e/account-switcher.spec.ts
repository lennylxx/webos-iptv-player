import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, type Page } from './helpers';

// Two Xtream accounts on distinct hosts so player_api.php can serve a different
// catalog per account: Alpha (a1) -> "Alpha Movie" under "Cat Alpha"; Bravo (a2)
// -> "Bravo Movie" under "Cat Bravo". Both get.php serve the sample M3U so the
// channels view loads normally for either.
async function seedTwoAccounts(page: Page): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const bravo = url.includes('host2.example.com');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) {
      return json([{ category_id: '1', category_name: bravo ? 'Cat Bravo' : 'Cat Alpha' }]);
    }
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: bravo ? 20 : 10, name: bravo ? 'Bravo Movie' : 'Alpha Movie',
        stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    return json({});
  });
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'a1', name: 'Alpha', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u1', password: 'p' } },
      { id: 'a2', name: 'Bravo', url: 'http://host2.example.com:8080',
        source: 'xtream', xtream: { username: 'u2', password: 'p' } },
    ]));
  });
}

// Open the avatar dropdown with a coordinate mouse press (the switcher activates
// on a click hit-test), then wait for the menu.
async function openAccountMenu(page: Page): Promise<void> {
  const avatar = page.locator('.account-avatar');
  await expect(avatar).toBeVisible();
  const box = await avatar.boundingBox();
  if (!box) throw new Error('account avatar has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('.account-menu')).toBeVisible();
}

// Choose an account row by id with a coordinate mouse press (same reason as above).
async function pickAccount(page: Page, id: string): Promise<void> {
  const row = page.locator(`.account-menu-item[data-account-id="${id}"]`);
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  if (!box) throw new Error(`account row ${id} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

test('the account avatar shows the active account initial, to the right of Search', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Default active account is the first (Alpha) -> initial "A".
  const avatar = page.locator('.account-avatar');
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveText('A');
  await avatar.hover();
  await expect(avatar).toHaveCSS('transform', 'matrix(1.06, 0, 0, 1.06, 0, 0)');

  // It sits to the right of the Search magnifier.
  const avatarBox = await avatar.boundingBox();
  const searchBox = await page.locator('.tab-bar-search .search-icon').boundingBox();
  if (!avatarBox || !searchBox) throw new Error('missing bounding box');
  expect(avatarBox.x).toBeGreaterThan(searchBox.x);
});

test('no account avatar for an M3U-only setup', async ({ page }) => {
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
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.account-avatar')).toHaveCount(0);
});

test('the dropdown lists every account with the active one marked', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item .account-menu-name')).toHaveText(['Alpha', 'Bravo']);
  // Alpha (the active account) carries the current marker.
  await expect(page.locator('.account-menu-item.current .account-menu-name')).toHaveText('Alpha');
});

test('switching account in the dropdown reloads Movies and updates the avatar', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Enter Movies for the default (Alpha) account.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Alpha');
  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toContainText('Alpha Movie');

  // Switch to Bravo from the avatar dropdown; Movies reloads for Bravo.
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
  await expect(page.locator('.catalog-tile[data-item-id="20"]')).toContainText('Bravo Movie');
  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toHaveCount(0);

  // The avatar now shows Bravo's initial, and the menu is closed.
  await expect(page.locator('.account-avatar')).toHaveText('B');
  await expect(page.locator('.account-menu')).toHaveCount(0);
});

test('the selected account persists across a reload', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Switch to Bravo, then reload the app.
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('.account-avatar')).toHaveText('B');

  await page.reload();
  await expect(page.locator('#view-channels')).toBeVisible();
  // The stored choice is restored: avatar is still Bravo and Movies serves Bravo.
  await expect(page.locator('.account-avatar')).toHaveText('B');
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
});

test('switching on Live only persists, then applies when Movies is next opened', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Switch to Bravo while on the Live view (no Movies loaded yet).
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('.account-avatar')).toHaveText('B');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Entering Movies now uses the selected (Bravo) account.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
  await expect(page.locator('.catalog-tile[data-item-id="20"]')).toContainText('Bravo Movie');
});
