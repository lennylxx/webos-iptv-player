import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, type Page, liveLoaded } from './helpers';

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
  await liveLoaded(page);

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
  await liveLoaded(page);
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.account-avatar')).toHaveCount(0);
});

test('the dropdown lists every account with the active one marked', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item .account-menu-name')).toHaveText(['Alpha', 'Bravo']);
  // Alpha (the active account) carries the current marker.
  await expect(page.locator('.account-menu-item.current .account-menu-name')).toHaveText('Alpha');
});

test('an open account menu holds the only ring, which returns to the avatar on close', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item.focused')).toHaveCount(1);
  await expect(page.locator('.account-avatar')).not.toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.account-menu-item.focused .account-menu-name')).toHaveText('Bravo');
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.account-avatar')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('a menu opened with the remote holds the only ring, which returns to the avatar on Back', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  const avatar = page.locator('.account-avatar');
  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  for (let i = 0; i < 10 && !(await avatar.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(avatar).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.account-menu')).toBeVisible();
  await expect(page.locator('.account-menu-item.focused')).toHaveCount(1);
  await expect(avatar).not.toHaveClass(/\bfocused\b/);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(avatar).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('switching account in the dropdown reloads Movies and updates the avatar', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

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
  await liveLoaded(page);

  // Switch to Bravo, then reload the app.
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('.account-avatar')).toHaveText('B');

  await page.reload();
  await liveLoaded(page);
  // The stored choice is restored: avatar is still Bravo and Movies serves Bravo.
  await expect(page.locator('.account-avatar')).toHaveText('B');
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
});

test('switching on Live only persists, then applies when Movies is next opened', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  // Switch to Bravo while on the Live view (no Movies loaded yet).
  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('.account-avatar')).toHaveText('B');
  await liveLoaded(page);

  // Entering Movies now uses the selected (Bravo) account.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat Bravo');
  await expect(page.locator('.catalog-tile[data-item-id="20"]')).toContainText('Bravo Movie');
});

// Regression: with an empty query, recent searches drop down over Live, so the
// view stack never reaches 'search' and a switch left Search on the old account.
// Regression: recent searches waited out the box's slide, then opened over
// an account menu opened meanwhile.
test('an account menu opened while the search box slides out keeps recent searches closed', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['movie']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  await openAccountMenu(page);
  await expect(page.locator('.search-history-panel')).toBeHidden();

  // Past the slide and its fallback timer.
  await page.waitForTimeout(600);
  await expect(page.locator('.account-menu')).toBeVisible();
  await expect(page.locator('.search-history-panel')).toBeHidden();
});

test('closing an account menu over the search box hands the remote back to it', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['movie']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  await expect(page.locator('.search-history-panel')).toBeVisible();

  await openAccountMenu(page);
  const avatar = await page.locator('.account-avatar').boundingBox();
  await page.mouse.click(avatar!.x + avatar!.width / 2, avatar!.y + avatar!.height / 2);
  await expect(page.locator('.account-menu')).toHaveCount(0);

  await expect(page.locator('.tab-bar-search-input')).toBeFocused();
  await expect(page.locator('.search-history-panel')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.search-history-tile').first()).toHaveClass(/focused/);
});

test('a click past an account menu over recent searches leaves search, not into the view', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['movie']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  await expect(page.locator('.search-history-panel')).toBeVisible();

  await openAccountMenu(page);
  await expect(page.locator('.search-history-panel')).toBeHidden();
  await expect(page.locator('.search-history-scrim')).toBeVisible();
  await page.mouse.click(400, 600);
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
  await expect(page.locator('.search-history-dropdown')).toBeHidden();
  await liveLoaded(page);
  await expect(page.locator('#view-player')).toBeHidden();
});

test('switching account while recent searches are open moves Search to the new account', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['movie']));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  await expect(page.locator('.search-history-panel')).toBeVisible();

  await openAccountMenu(page);
  await pickAccount(page, 'a2');
  await expect(page.locator('.account-avatar')).toHaveText('B');

  // The pointer took focus to the avatar; the box gets the remote back.
  const input = page.locator('.tab-bar-search-input');
  await expect(input).toBeFocused();
  await expect(page.locator('.search-history-panel')).toBeVisible();
  await page.keyboard.type('Movie');
  await expect(page.locator('#view-search')).toContainText('Bravo Movie');
  await expect(page.locator('#view-search')).not.toContainText('Alpha Movie');
});

test('a channel-list click that dismisses a pointer-opened menu hands the remote to the list', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await openAccountMenu(page);
  await expect(page.locator('.account-menu-item.focused')).toHaveCount(1);
  await page.locator('#view-channels .group-item').first().click();
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.account-avatar')).not.toHaveClass(/focused/);

  // D-pad now moves in the list instead of reopening the menu from the avatar.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('#view-channels .focused')).not.toHaveCount(0);
});

test('the pointer moves the account menu ring, and Back from a remote-opened menu returns to the avatar', async ({ page }) => {
  await seedTwoAccounts(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await openAccountMenu(page);
  const bravo = page.locator('.account-menu-item[data-account-id="a2"]');
  const box = (await bravo.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(bravo).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  // The content under the open menu lights where the pointer rests, but the
  // keys stay in the menu.
  const row = page.locator('#view-channels .channel-main [data-channel-index]').nth(1);
  const r = (await row.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2 + 2, r.y + r.height / 2);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await expect(row).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'tabbar.accounts');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.account-menu-item[data-account-id="a1"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await expect(page.locator('.account-avatar')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  // Back resumes the list on the row the pointer rested on.
  await expect(row).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-channels .channel-main [data-channel-index]').first()).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});
