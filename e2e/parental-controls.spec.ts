import {
  test,
  expect,
  enterTab,
  isChromium53,
  neuterVideo,
  readUserDataStore,
  routeLiveManifest,
  routePlaylist,
  seedPlaylist,
} from './helpers';
import type { Page } from '@playwright/test';

async function openManagerWithNewPin(page: Page): Promise<void> {
  await neuterVideo(page);
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');

  await enterTab(page, 'settings');
  await expect(page.locator('#manage-parental-controls')).toHaveText('Turn on');
  await expect(page.locator('.parental-entry-title .parental-entry-status')).toHaveText('Off');
  await page.locator('#manage-parental-controls').click();

  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt).toBeVisible();
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  await expect(page.locator('#view-parental-controls')).toBeVisible();
}

async function seedVodAccount(page: Page): Promise<void> {
  const streams = [
    { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
    { stream_id: 20, name: 'Movie Two', stream_icon: '', container_extension: 'mp4', category_id: '2' },
  ];
  await page.route('**/get.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: '#EXTM3U\n' }));
  await page.route('**/xmltv.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const category = url.searchParams.get('category_id');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'get_vod_categories') {
      return json([{ category_id: '1', category_name: 'Cat A' }, { category_id: '2', category_name: 'Cat B' }]);
    }
    if (action === 'get_vod_streams') {
      return json(streams.filter(item => !category || item.category_id === category));
    }
    return json(action ? [] : {});
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

async function routeVodCatalog(
  page: Page,
  categories: Array<{ category_id: string; category_name: string }>,
  streams: (category: string | null) => unknown[],
): Promise<void> {
  await page.route('**/get.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: '#EXTM3U\n' }));
  await page.route('**/xmltv.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const body = action === 'get_vod_categories' ? categories
      : action === 'get_vod_streams' ? streams(url.searchParams.get('category_id'))
        : action ? [] : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

async function createPinFromSettings(page: Page): Promise<void> {
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
}

async function chooseOption(page: Page, id: string, value: string): Promise<void> {
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator(`#${id} [data-value="${value}"]`).click();
  await expect(page.locator(`#${id} .active`)).toHaveAttribute('data-value', value);
}

// Leaving the manager starts an unlock session; "Once" leaves content locked.
// Hide mode disables "Once", so lock again from the tab bar instead.
async function leaveLocked(page: Page): Promise<void> {
  await page.locator('[data-parental-tab="options"]').click();
  if (await page.locator('#parental-duration [data-value="once"]').isDisabled()) {
    await page.locator('[data-parental-back]').click();
    await page.locator('.tab-bar [data-lock-now]').click();
    await expect(page.locator('.tab-bar [data-lock-now]')).toHaveCount(0);
    return;
  }
  await chooseOption(page, 'parental-duration', 'once');
  await page.locator('[data-parental-back]').click();
}

test('disables Turn on where the PIN cannot be stored', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'subtle', { configurable: true, get: () => undefined });
  });
  await neuterVideo(page);
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');

  const turnOn = page.locator('#manage-parental-controls');
  await expect(turnOn).toBeDisabled();
  await expect(turnOn).not.toHaveAttribute('data-focusable', /.*/);
  await expect(turnOn.locator('xpath=following-sibling::div[contains(@class,"settings-item-hint")]'))
    .toHaveText("Parental controls aren't available on this device.");
  await turnOn.click({ force: true });
  await expect(page.locator('.parental-pin-prompt')).toBeHidden();
});

test('protects a live group and unlocks deferred playback with the PIN', async ({ page }) => {
  await openManagerWithNewPin(page);
  const prompt = page.locator('.parental-pin-prompt');
  const news = page.locator('[data-parental-group]').filter({ hasText: 'News' });
  await expect(news).toBeVisible();
  await news.click();
  await expect(news).toContainText('Locked');

  await leaveLocked(page);
  await enterTab(page, 'live');
  await page.locator('.channel-main .channel-item').first().click();

  await expect(prompt).toBeVisible();
  await expect(page.locator('#view-channels')).toBeVisible();
  await prompt.locator('.parental-pin-input').fill('0000');
  await expect(prompt.locator('.parental-pin-error')).toContainText('Incorrect');

  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt).toBeHidden();
  await expect(page.locator('#view-player')).toBeVisible();
});

test('a source added after turning on stays locked until the manager opens it', async ({ page }) => {
  await openManagerWithNewPin(page);
  await leaveLocked(page);
  await page.route('**/second.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Kids",Channel Three\nhttp://streams.example.com/three.m3u8',
  }));

  await enterTab(page, 'settings');
  await page.locator('#add-playlist').click();
  await page.locator('.playlist-name').last().fill('Second');
  await page.locator('.playlist-url').last().fill('http://host.example.com/second.m3u');
  await page.locator('.playlist-url').last().blur();
  await page.evaluate(() => {
    document.getElementById('save-settings')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  });
  await page.keyboard.press('Enter');

  const prompt = page.locator('.parental-pin-prompt');
  const channel = (name: string) =>
    page.locator('.channel-main .channel-item').filter({ hasText: name });
  await expect(channel('Channel Three')).toBeVisible();
  await channel('Channel Three').click();
  await expect(prompt).toBeVisible();
  await prompt.locator('[data-pin-action="cancel"]').click();
  await expect(prompt).toBeHidden();
  await channel('Channel One').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');

  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  await prompt.locator('.parental-pin-input').fill('1234');
  const view = page.locator('#view-parental-controls');
  const second = view.locator('[data-parental-source]').filter({ hasText: 'Second' });
  await expect(second).toContainText('1 locked');
  await second.click();
  const kids = view.locator('[data-parental-group]').filter({ hasText: 'Kids' });
  await expect(kids).toContainText('Locked');
  await kids.click();
  await expect(kids).toContainText('Not locked');
});

test('channels hidden from the list are locked with their source', async ({ page }) => {
  await neuterVideo(page);
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  const pressKey = (keyCode: number) => page.evaluate(
    k => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })),
    keyCode,
  );
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  // Seed the pointer: before its first move, a mouseover can't be told
  // from content sliding under it, so it is ignored after a key.
  await page.mouse.move(1, 1);
  await pressKey(405);
  const second = page.locator('.channel-main .channel-item').nth(1);
  await second.hover();
  await expect(second).toHaveClass(/focused/);
  await pressKey(13);
  await pressKey(404);
  await pressKey(405);
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(1);

  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await prompt.locator('.parental-pin-input').fill('1234');
  const movies = page.locator('[data-parental-group]').filter({ hasText: 'Movies' });
  await movies.click();
  await expect(movies).toHaveClass(/active/);
  await movies.click();
  await expect(movies).toContainText('Locked');
  await leaveLocked(page);

  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
  await page.locator('#show-hidden [data-value="on"]').click();
  await page.locator('#save-settings').click();
  const hidden = page.locator('.channel-main .channel-item').filter({ hasText: 'Channel Two' });
  await expect(hidden).toBeVisible();
  await hidden.click();
  await expect(prompt).toBeVisible();
});

test('pointing a reviewed source at a new address locks it again', async ({ page }) => {
  await openManagerWithNewPin(page);
  await leaveLocked(page);
  await page.route('**/second.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Kids",Channel Three\nhttp://streams.example.com/three.m3u8',
  }));

  await enterTab(page, 'settings');
  await page.locator('.playlist-url').first().fill('http://host.example.com/second.m3u');
  await page.locator('.playlist-url').first().blur();
  await page.evaluate(() => {
    document.getElementById('save-settings')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  });
  await page.keyboard.press('Enter');

  const prompt = page.locator('.parental-pin-prompt');
  const channel = page.locator('.channel-main .channel-item').filter({ hasText: 'Channel Three' });
  await expect(channel).toBeVisible();
  await channel.click();
  await expect(prompt).toBeVisible();
});

test('selects a group with the first click and keeps it while the pointer moves on', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  const group = (name: string) => view.locator('[data-parental-group]').filter({ hasText: name });
  const itemColumn = view.locator('.parental-column-item');
  const item = itemColumn.locator('[data-parental-item]').filter({ hasText: 'Channel Two' });
  const clear = view.locator('[data-parental-action="blue"]');

  // Hover only highlights; the first click selects and the next one locks.
  await group('Movies').hover();
  await expect(group('Movies')).toHaveClass(/\bfocused\b/);
  await expect(group('News')).toHaveClass(/\bactive\b/);
  await expect(itemColumn.locator('h3')).toHaveText('News');

  await group('Movies').click();
  await expect(group('Movies')).toHaveClass(/\bactive\b/);
  await expect(itemColumn.locator('h3')).toHaveText('Movies');
  await expect(group('Movies').locator('.lock-badge')).not.toHaveClass(/is-locked/);
  await expect(item).toContainText('Not locked');
  await expect(clear).toHaveCount(0);

  await group('Movies').click();
  await expect(group('Movies').locator('.lock-badge')).toHaveClass(/is-locked/);
  await expect(group('News').locator('.lock-badge')).not.toHaveClass(/is-locked/);
  await expect(item).toContainText('Locked');

  // An item is either locked or not; unlocking it inside a locked group sets it separately.
  await item.click();
  await expect(item).toContainText('Not locked');
  await expect(item.locator('.parental-exception')).toHaveText('Set separately');
  await expect(itemColumn.locator('.parental-column-head')).toContainText('1 set separately');
  await expect(group('Movies')).toContainText(/\d+ of \d+ locked/);
  await expect(clear).toHaveText('Clear separate settings in "Movies"');
  // With focus in the items, the color keys act on the current group.
  await expect(view.locator('[data-parental-action="red"]')).toHaveText('Lock all in "Movies"');

  // A partial lock is a stored state, not a property of the group whose items are shown.
  await group('News').click();
  await expect(itemColumn.locator('h3')).toHaveText('News');
  await expect(view.locator('[data-parental-action="red"]')).toHaveText('Lock all groups');
  await expect(group('Movies')).toContainText(/\d+ of \d+ locked/);
  await group('Movies').click();
  await expect(clear).toHaveText('Clear separate settings in "Movies"');

  // Crossing another group on the way to the legend must not change the current group.
  await group('News').hover();
  await expect(group('Movies')).toHaveClass(/\bactive\b/);
  await clear.hover();
  await expect(group('Movies')).toHaveClass(/\bactive\b/);
  await clear.click();
  await expect(item).toContainText('Locked');
  await expect(group('Movies')).toContainText('Locked');
  await expect(clear).toHaveCount(0);

  await view.locator('[data-parental-action="green"]').click();
  await expect(view.locator('[data-parental-group] .lock-badge.is-locked')).toHaveCount(0);
  await view.locator('[data-parental-action="red"]').click();
  for (const name of ['News', 'Movies']) {
    await expect(group(name).locator('.lock-badge')).toHaveClass(/is-locked/);
  }
});

test('a clicked group loads its items without the D-pad debounce', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  // Frozen timers: only a load that skips the debounce can show the items.
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await view.locator('[data-parental-group]').filter({ hasText: 'Movies' }).click();
  await expect(view.locator('.parental-column-item [data-parental-item]').filter({ hasText: 'Channel Two' }))
    .toBeVisible();
});

test('logs how many items a group loaded for tv.sh diag', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', message => logs.push(message.text()));
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  await view.locator('[data-parental-group]').filter({ hasText: 'Movies' }).click();
  const rows = view.locator('.parental-column-item [data-parental-item]');
  await expect(rows.filter({ hasText: 'Channel Two' })).toBeVisible();
  const count = await rows.count();
  const event = new RegExp(`\\bevent=parental\\.manager\\.items source=\\S+ items=${count} elapsedMs=\\d+`);
  await expect.poll(() => logs.some(line => event.test(line))).toBe(true);
});

test('locks and unlocks everything in a group from the item column', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  const group = (name: string) => view.locator('[data-parental-group]').filter({ hasText: name });
  const items = view.locator('.parental-column-item [data-parental-item]');
  const red = view.locator('[data-parental-action="red"]');
  const green = view.locator('[data-parental-action="green"]');

  // M3U only: no content-type toggle, avatar, or playlist column.
  await expect(view.locator('#parental-kind')).toHaveCount(0);
  await expect(view.locator('.parental-account')).toBeHidden();
  await expect(view.locator('.parental-column-source')).toHaveCount(0);

  // Left/Right crosses columns even from a row below the shorter item list,
  // and the re-render that follows keeps the D-pad highlight.
  await group('Movies').click();
  await expect(items.first()).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(red).toHaveText('Lock all in "Movies"');
  await expect(items.first()).toHaveClass(/focused/);
  await page.keyboard.press('ArrowLeft');
  await expect(red).toHaveText('Lock all groups');
  await expect(group('Movies')).toHaveClass(/focused/);

  await group('Movies').hover();
  await items.first().click();
  await expect(items.first()).toContainText('Locked');
  await expect(red).toHaveText('Lock all in "Movies"');
  await red.click();
  await expect(group('Movies')).toContainText('Locked');
  await expect(items.locator('.parental-exception')).toHaveCount(0);
  await expect(items.filter({ hasText: 'Not locked' })).toHaveCount(0);
  await expect(group('News')).toContainText('Not locked');

  await items.first().click();
  await expect(items.first().locator('.parental-exception')).toHaveCount(1);
  await expect(green).toHaveText('Unlock all in "Movies"');
  await green.click();
  await expect(group('Movies')).toContainText('Not locked');
  await expect(items.locator('.lock-badge.is-locked')).toHaveCount(0);
  await expect(items.locator('.parental-exception')).toHaveCount(0);
});

test('lists live playlists in a column and switches the Xtream account from the avatar', async ({ page }) => {
  await seedVodAccount(page);
  await page.addInitScript(() => {
    const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]');
    playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
      source: 'xtream', xtream: { username: 'v', password: 'q' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
  });
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  const view = page.locator('#view-parental-controls');
  const playlists = view.locator('.parental-column-source [data-parental-source]');
  await expect(playlists).toHaveText([/X Account/, /Y Account/]);
  await expect(view.locator('.parental-account-name')).toHaveText('X Account');

  // The header rule ends on the groups column's divider, clear of the avatar.
  const edges = await view.evaluate((root) => ({
    rule: root.querySelector('.parental-heading')!.getBoundingClientRect().right,
    divider: root.querySelectorAll('.parental-column')[2]!.getBoundingClientRect().left,
  }));
  expect(Math.abs(edges.rule - edges.divider)).toBeLessThanOrEqual(1);

  // Picking an account in Live selects its playlist.
  await view.locator('.account-avatar').click();
  // Only the manager's own switcher answers, not the tab bar's.
  await expect(page.locator('.tab-bar-account .account-menu')).toHaveCount(0);
  await view.locator('.account-menu-item[data-account-id="x2"]').click();
  await expect(view.locator('.account-menu')).toHaveCount(0);
  await expect(view.locator('.parental-account-name')).toHaveText('Y Account');
  await expect(playlists.filter({ hasText: 'Y Account' })).toHaveClass(/\bactive\b/);

  // Movies has one source per account, so the playlist column goes away.
  await view.locator('#parental-kind [data-value="vod"]').click();
  await expect(view.locator('#parental-kind [data-value="vod"]')).toHaveClass(/\bactive\b/);
  await expect(view.locator('.parental-column-source')).toHaveCount(0);
  await expect(view.locator('.parental-column-group h3')).toHaveText('Categories');
  await expect(view.locator('[data-parental-group]').filter({ hasText: 'Cat A' })).toBeVisible();

  // Back closes the menu without leaving the manager.
  await view.locator('.account-avatar').click();
  await expect(view.locator('.account-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view.locator('.account-menu')).toHaveCount(0);
  await expect(view).toBeVisible();
});

test('the account menu opened from the D-pad shows one ring and Back returns it to the avatar', async ({ page }) => {
  await seedVodAccount(page);
  await page.addInitScript(() => {
    const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]');
    playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
      source: 'xtream', xtream: { username: 'v', password: 'q' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
  });
  await page.goto('/');
  await createPinFromSettings(page);
  await page.mouse.move(0, 0);

  const view = page.locator('#view-parental-controls');
  const avatar = view.locator('.account-avatar');
  await page.keyboard.press('ArrowDown');
  for (let step = 0; step < 8 && !(await avatar.evaluate(el => el.classList.contains('focused'))); step++) {
    await page.keyboard.press(step < 4 ? 'ArrowRight' : 'ArrowUp');
  }
  await expect(avatar).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('Enter');
  await expect(view.locator('.account-menu')).toBeVisible();
  await expect(view.locator('.focused')).toHaveCount(1);
  await expect(view.locator('.account-menu-item.focused')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(view.locator('.account-menu')).toHaveCount(0);
  await expect(avatar).toHaveClass(/\bfocused\b/);
  await expect(view.locator('.focused')).toHaveCount(1);
});

test('closing the account menu with a click on the avatar lights the avatar under the pointer', async ({ page }) => {
  await seedVodAccount(page);
  await page.addInitScript(() => {
    const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]');
    playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
      source: 'xtream', xtream: { username: 'v', password: 'q' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
  });
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  const avatar = view.locator('.account-avatar');
  await avatar.click();
  await expect(view.locator('.account-menu')).toBeVisible();
  await avatar.click();
  await expect(view.locator('.account-menu')).toHaveCount(0);

  await expect(avatar).toHaveClass(/\bfocused\b/);
  await expect(view.locator('.focused')).toHaveCount(1);
});

test('sets options and removes all locks from the Options tab', async ({ page }) => {
  await openManagerWithNewPin(page);
  const news = page.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await expect(news.locator('.lock-badge')).toHaveClass(/is-locked/);

  await page.locator('[data-parental-tab="options"]').click();
  await expect(page.locator('[data-parental-group]')).toHaveCount(0);
  await expect(page.locator('[data-parental-action]')).toHaveCount(0);

  const once = page.locator('#parental-duration [data-value="once"]');
  await expect(page.locator('#parental-duration .active')).toHaveAttribute('data-value', 'once');
  await page.locator('#parental-conceal [data-value="hide-locked"]').click();
  await expect(page.locator('#parental-conceal .active')).toHaveAttribute('data-value', 'hide-locked');
  await expect(page.locator('#parental-conceal [data-value="hide-locked"]')).toHaveClass(/active/);
  await expect(page.locator('#parental-conceal [data-value="hide-locked"]')).toHaveClass(/focused/);
  await expect(once).toBeDisabled();
  await expect(once).not.toHaveAttribute('data-focusable', '');
  await expect(page.locator('#parental-duration .active')).toHaveAttribute('data-value', '5-minutes');
  await page.locator('[data-parental-tab="rules"]').click();
  await page.locator('[data-parental-tab="options"]').click();
  await expect(page.locator('#parental-conceal .active')).toHaveAttribute('data-value', 'hide-locked');

  await expect(page.locator('[data-parental-remove-all]')).toHaveClass(/btn-danger/);
  await expect(page.locator('[data-parental-change-pin]')).not.toHaveClass(/btn-danger/);
  await page.locator('[data-parental-remove-all]').click();
  const confirm = page.locator('.confirmation-prompt');
  await expect(confirm).toContainText('Remove all locks?');
  await confirm.locator('[data-confirm-action="confirm"]').click();
  await expect(page.locator('.toast')).toContainText('All locks removed.');
  await expect(page.locator('.parental-pin-prompt')).toBeHidden();

  await page.locator('[data-parental-tab="rules"]').click();
  await expect(news.locator('.lock-badge')).not.toHaveClass(/is-locked/);
});

test('leaving the manager cancels its catalog loads', async ({ page }) => {
  test.skip(isChromium53(), 'the legacy AbortController rejects the fetch without cancelling it');
  await seedVodAccount(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/player_api.php*', async route => {
    if (new URL(route.request().url()).searchParams.get('action') !== 'get_vod_categories') {
      return route.fallback();
    }
    await held;
    await route.fallback().catch(() => {});
  });
  const aborted = page.waitForEvent('requestfailed', request =>
    request.url().includes('get_vod_categories'));
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await expect(view.locator('#parental-kind [data-value="vod"]')).toHaveClass(/\bactive\b/);
  await view.locator('[data-parental-back]').click();
  await expect(view).toBeHidden();
  await aborted;
  release();
});

test('a reminder launch for a hidden locked channel asks for the PIN and plays', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await leaveLocked(page);

  await page.evaluate(() => {
    const url = 'http://streams.example.com/one.m3u8';
    let h = 0x811c9dc5;
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    const reminderChannelKey = (h >>> 0).toString(16).padStart(8, '0');
    document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail: { reminderChannelKey } }));
  });
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Enter PIN to watch a locked program');
  await expect(prompt).not.toContainText('Channel One');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#view-player')).toContainText('Channel One');
});

test('removing a source with locks asks for the PIN', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await leaveLocked(page);

  await enterTab(page, 'settings');
  const rows = page.locator('#playlist-entries [data-source-entry]');
  await expect(rows).toHaveCount(1);
  await rows.first().locator('.remove-playlist').click();
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt).toContainText('Enter PIN to remove "Test"');
  await expect(rows).toHaveCount(1);
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt).toBeHidden();
  await expect(rows).toHaveCount(0);
});

test('auto-play skips a locked last channel at startup', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await leaveLocked(page);
  await page.evaluate(() => {
    const url = 'http://streams.example.com/one.m3u8';
    let h = 0x811c9dc5;
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    localStorage.setItem('iptv_auto_play', 'true');
    localStorage.setItem('iptv_last_channel_key', JSON.stringify((h >>> 0).toString(16).padStart(8, '0')));
  });
  // seedPlaylist re-seeds without an id on reload; keep the saved one, as a TV would.
  const saved = await page.evaluate(() => localStorage.getItem('iptv_playlists'));
  await page.addInitScript(value => localStorage.setItem('iptv_playlists', value!), saved);
  await page.reload();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-item').first()).toBeVisible();
  await expect(page.locator('.parental-pin-prompt')).toBeHidden();
  await expect(page.locator('#view-player')).toBeHidden();
});

test('turns parental controls off and on from the Options tab', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-tab="options"]').click();
  const power = page.locator('#view-parental-controls .source-toggle');
  await expect(power).toHaveAttribute('aria-pressed', 'true');

  await power.click();
  await expect(power).toHaveAttribute('aria-pressed', 'false');
  await expect(power).toHaveClass(/focused/);
  await expect(page.locator('.parental-options-pane')).toHaveClass(/parental-options-off/);

  await expect(page.locator('[data-parental-change-pin]')).toHaveCount(0);

  // Off clears the PIN, so turning back on asks for a new one.
  const prompt = page.locator('.parental-pin-prompt');
  await power.click();
  await expect(prompt.locator('h2')).toHaveText('Set a PIN to turn on parental controls');
  await prompt.locator('[data-pin-action="cancel"]').click();
  await expect(power).toHaveAttribute('aria-pressed', 'false');

  await power.click();
  await prompt.locator('.parental-pin-input').fill('5678');
  await prompt.locator('.parental-pin-input').fill('5678');
  await expect(power).toHaveAttribute('aria-pressed', 'true');
  await expect(power).toHaveClass(/focused/);
  await expect(page.locator('.parental-options-pane')).not.toHaveClass(/parental-options-off/);
  await expect(page.locator('[data-parental-change-pin]')).toBeVisible();
});

test('turning off clears the PIN so Settings offers to turn it on again', async ({ page }) => {
  await openManagerWithNewPin(page);
  const news = page.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('#view-parental-controls .source-toggle').click();
  await page.locator('[data-parental-back]').click();

  const entry = page.locator('#manage-parental-controls');
  await expect(entry).toHaveText('Turn on');
  await expect(page.locator('.parental-entry-title .parental-entry-status')).toHaveText('Off');
  await entry.click();
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt.locator('h2')).toHaveText('Set a PIN to turn on parental controls');
  await prompt.locator('.parental-pin-input').fill('5678');
  await prompt.locator('.parental-pin-input').fill('5678');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  await expect(news.locator('.lock-badge')).toHaveClass(/is-locked/);
});

test('hides locked content until the manager is left with an unlock session', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  const news = view.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await expect(news).toContainText('Locked');
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await leaveLocked(page);

  await enterTab(page, 'live');
  const groups = page.locator('#view-channels .group-item');
  await expect(groups.filter({ hasText: 'Movies' })).toBeVisible();
  await expect(groups.filter({ hasText: 'News' })).toHaveCount(0);
  await expect(page.locator('#view-channels .channel-item')
    .filter({ hasText: 'Channel One' })).toHaveCount(0);

  await enterTab(page, 'settings');
  const status = page.locator('.parental-entry-title .parental-entry-status');
  await expect(status).toHaveText('On');
  await expect(status).toHaveClass(/is-on/);
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(news).toBeVisible();

  await chooseOption(page, 'parental-duration', 'until-backgrounded');
  await page.locator('[data-parental-back]').click();
  await enterTab(page, 'live');
  await expect(groups.filter({ hasText: 'News' })).toBeVisible();
});

test('marks locked content with a lock that opens during an unlock session', async ({ page }) => {
  await openManagerWithNewPin(page);
  const news = page.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await expect(news).toContainText('Locked');
  await leaveLocked(page);

  await enterTab(page, 'live');
  const groups = page.locator('#view-channels .group-item');
  const channels = page.locator('#view-channels .channel-main .channel-item');
  await expect(groups.filter({ hasText: 'News' }).locator('.lock-badge.is-locked')).toBeVisible();
  await expect(groups.filter({ hasText: 'Movies' }).locator('.lock-badge')).toHaveCount(0);
  await expect(channels.filter({ hasText: 'Channel One' })
    .locator('.lock-badge.is-locked')).toBeVisible();
  await expect(channels.filter({ hasText: 'Channel Two' }).locator('.lock-badge')).toHaveCount(0);

  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await chooseOption(page, 'parental-duration', 'until-backgrounded');
  await page.locator('[data-parental-back]').click();

  await enterTab(page, 'live');
  await expect(channels.filter({ hasText: 'Channel One' })
    .locator('.lock-badge.is-unlocked')).toBeVisible();
  await expect(groups.filter({ hasText: 'News' }).locator('.lock-badge.is-unlocked')).toBeVisible();

  const lockNow = page.locator('.tab-bar [data-lock-now]');
  await expect(lockNow).toHaveText('Lock now');
  await lockNow.click();
  await expect(lockNow).toHaveCount(0);
  await expect(groups.filter({ hasText: 'News' }).locator('.lock-badge.is-locked')).toBeVisible();
});

test('changes the PIN from the Options tab', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('[data-parental-change-pin]').click();
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt.locator('h2')).toHaveText('Enter a new PIN');
  await prompt.locator('.parental-pin-input').fill('5678');
  await expect(prompt.locator('h2')).toHaveText('Confirm the new PIN');
  await prompt.locator('.parental-pin-input').fill('5678');
  await expect(prompt).toBeHidden();
  await expect(page.locator('.toast')).toContainText('PIN changed.');
  await expect(page.locator('#view-parental-controls')).toBeVisible();

  await page.locator('[data-parental-back]').click();
  await expect(page.locator('#manage-parental-controls')).toHaveText('Manage');
  await page.locator('#manage-parental-controls').click();
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('.parental-pin-error')).toContainText('Incorrect');
  await prompt.locator('.parental-pin-input').fill('5678');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
});

test('keeps a catalog category Partly locked after the manager is reopened', async ({ page }) => {
  await neuterVideo(page);
  await routeLiveManifest(page);
  await seedVodAccount(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  const manage = page.locator('#manage-parental-controls');
  const prompt = page.locator('.parental-pin-prompt');
  await manage.click();
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  const view = page.locator('#view-parental-controls');
  const group = (name: string) => view.locator('[data-parental-group]').filter({ hasText: name });
  const openVod = async () => {
    await view.locator('#parental-kind [data-value="vod"]').click();
    await expect(group('Cat B')).toBeVisible();
  };
  await openVod();
  await group('Cat B').click();
  await group('Cat B').click();
  const item = view.locator('[data-parental-item]').filter({ hasText: 'Movie Two' });
  await expect(item).toContainText('Locked');
  await item.click();
  await expect(group('Cat B')).toContainText('Partly locked');

  await leaveLocked(page);
  await manage.click();
  await prompt.locator('.parental-pin-input').fill('1234');
  await openVod();
  // Cat A is current, so only the stored rules can tell that Cat B is Partly locked.
  await expect(group('Cat A')).toHaveClass(/\bactive\b/);
  await expect(group('Cat B')).toContainText('Partly locked');
});

test('the D-pad walks a long list while only nearby rows are mounted', async ({ page }) => {
  const streams = Array.from({ length: 200 }, (_, index) => ({
    stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  const category = view.locator('[data-parental-group]').filter({ hasText: 'Cat A' });
  await category.click();
  const items = view.locator('[data-parental-item]');
  await expect(items.first()).toContainText('Movie 0');
  await page.keyboard.press('ArrowRight');
  await expect(view.locator('[data-parental-item].focused')).toContainText('Movie 0');

  for (let step = 0; step < 40; step++) await page.keyboard.press('ArrowDown');
  const focused = view.locator('[data-parental-item].focused');
  await expect(focused).toHaveAttribute('data-parental-item', '40');
  await expect(focused).toBeInViewport();
  expect(await items.count()).toBeLessThan(60);
  await expect(items.filter({ hasText: /^Movie 0\b/ })).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(focused).toContainText('Not locked');
  await expect(view.locator('.parental-column-item .parental-column-note'))
    .toContainText(['Locked', '1 set separately']);

  for (let step = 0; step < 40; step++) await page.keyboard.press('ArrowUp');
  await expect(view.locator('[data-parental-item].focused')).toHaveAttribute('data-parental-item', '0');
  await expect(items.first()).toContainText('Movie 0');
});

for (const key of ['ArrowLeft', 'Enter'] as const) {
  test(`${key} acts from a focused row that a wheel scroll unmounted`, async ({ page }) => {
    const streams = Array.from({ length: 200 }, (_, index) => ({
      stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
    }));
    await neuterVideo(page);
    await routeLiveManifest(page);
    await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
    await page.goto('/');
    await createPinFromSettings(page);

    const view = page.locator('#view-parental-controls');
    await view.locator('#parental-kind [data-value="vod"]').click();
    await view.locator('[data-parental-group]').filter({ hasText: 'Cat A' }).click();
    await expect(view.locator('[data-parental-item]').first()).toContainText('Movie 0');
    await page.mouse.move(0, 0);
    await page.keyboard.press('ArrowRight');
    for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowDown');
    await expect(view.locator('[data-parental-item].focused')).toHaveAttribute('data-parental-item', '5');

    await expect(async () => {
      await view.locator('[data-parental-list="item"]').evaluate(list => { list.scrollTop = 8000; });
      await expect(view.locator('[data-parental-item="5"]')).toHaveCount(0, { timeout: 200 });
    }).toPass();
    await page.keyboard.press(key);
    if (key === 'ArrowLeft') {
      await expect(view.locator('[data-parental-group].focused')).toContainText('Cat A');
    } else {
      await expect(view.locator('[data-parental-item="5"] .parental-exception')).toHaveText('Set separately');
    }
  });
}

test('the D-pad resumes from a row that a wheel scroll unmounted', async ({ page }) => {
  const streams = Array.from({ length: 200 }, (_, index) => ({
    stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await view.locator('[data-parental-group]').filter({ hasText: 'Cat A' }).click();
  await expect(view.locator('[data-parental-item]').first()).toContainText('Movie 0');
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowDown');
  await expect(view.locator('[data-parental-item].focused')).toHaveAttribute('data-parental-item', '5');

  await expect(async () => {
    await view.locator('[data-parental-list="item"]').evaluate(list => { list.scrollTop = 8000; });
    await expect(view.locator('[data-parental-item="5"]')).toHaveCount(0, { timeout: 200 });
  }).toPass();
  await page.keyboard.press('ArrowDown');
  const focused = view.locator('[data-parental-item].focused');
  await expect(focused).toHaveAttribute('data-parental-item', '6');
  await expect(focused).toBeInViewport();
});

test('a focused row scrolled away and back by the wheel still shows its ring', async ({ page }) => {
  const streams = Array.from({ length: 200 }, (_, index) => ({
    stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await view.locator('[data-parental-group]').filter({ hasText: 'Cat A' }).click();
  await expect(view.locator('[data-parental-item]').first()).toContainText('Movie 0');
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 5; step++) await page.keyboard.press('ArrowDown');
  const row = view.locator('[data-parental-item="5"]');
  await expect(row).toHaveClass(/\bfocused\b/);

  const list = view.locator('[data-parental-list="item"]');
  await expect(async () => {
    await list.evaluate(node => { node.scrollTop = 8000; });
    await expect(row).toHaveCount(0, { timeout: 200 });
  }).toPass();
  await list.evaluate(node => { node.scrollTop = 0; });

  await expect(row).toHaveClass(/\bfocused\b/);
  await expect(view.locator('.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(view.locator('[data-parental-item="6"]')).toHaveClass(/\bfocused\b/);
});

test('a scrolled-away first group still leads Up to Lock suggested', async ({ page }) => {
  const categories = [{ category_id: '1', category_name: 'Adult' }].concat(Array.from(
    { length: 60 }, (_, index) => ({ category_id: String(index + 2), category_name: `Cat ${index + 1}` })));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, categories, () => []);
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await view.locator('[data-parental-group="1"]').click();
  // A resting cursor would hover-focus whatever row scrolls under it.
  await page.mouse.move(0, 0);
  // The pointer left the clicked group, so the first key only shows it.
  await page.keyboard.press('ArrowUp');
  await expect(view.locator('[data-parental-group].focused')).toHaveAttribute('data-parental-group', '1');
  await page.keyboard.press('ArrowUp');
  await expect(view.locator('[data-parental-group].focused')).toHaveAttribute('data-parental-group', '0');

  await expect(async () => {
    await view.locator('[data-parental-list="group"]').evaluate(list => { list.scrollTop = 3000; });
    await expect(view.locator('[data-parental-group="0"]')).toHaveCount(0, { timeout: 200 });
  }).toPass();
  await page.keyboard.press('ArrowUp');
  await expect(view.locator('[data-parental-suggest]')).toHaveClass(/\bfocused\b/);
});

test('Down from a scrolled-away last item leaves the list as it would in view', async ({ page }) => {
  const streams = Array.from({ length: 40 }, (_, index) => ({
    stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  const list = view.locator('[data-parental-list="item"]');
  const last = view.locator('[data-parental-item="39"]');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await view.locator('[data-parental-group]').filter({ hasText: 'Cat A' }).click();
  await page.mouse.move(0, 0);
  await expect(view.locator('[data-parental-item]').first()).toContainText('Movie 0');
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 39; step++) await page.keyboard.press('ArrowDown');
  await expect(last).toHaveClass(/\bfocused\b/);
  const focusedKey = () => page.evaluate(() =>
    document.querySelector('#view-parental-controls .focused')?.getAttribute('data-key') ?? null);

  await page.keyboard.press('ArrowDown');
  const inView = await focusedKey();
  expect(inView).not.toBe('vod:x1:40');
  await page.keyboard.press('ArrowUp');
  await expect(last).toHaveClass(/\bfocused\b/);

  // The scroll guard reverts a scroll that lands while it holds the D-pad's offset.
  await expect(async () => {
    await list.evaluate(element => { element.scrollTop = 0; });
    await expect(last).toHaveCount(0, { timeout: 200 });
  }).toPass();
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedKey).toBe(inView);
});

test('an item listed in two categories marks the one it was last loaded in Partly locked', async ({ page }) => {
  const shared = { stream_id: 10, name: 'Movie Shared', stream_icon: '', container_extension: 'mp4', category_id: '1' };
  const byCategory: Record<string, unknown[]> = {
    1: [shared, { ...shared, stream_id: 20, name: 'Movie One' }],
    // Only the shared item, so reassigning it is the sole change to the item map.
    2: [{ ...shared, category_id: '2' }],
  };
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [
    { category_id: '1', category_name: 'Cat A' },
    { category_id: '2', category_name: 'Cat B' },
  ], category => (category ? byCategory[category] ?? [] : byCategory[1]));
  await page.goto('/');
  await createPinFromSettings(page);

  const view = page.locator('#view-parental-controls');
  const group = (name: string) => view.locator('[data-parental-group]').filter({ hasText: name });
  await view.locator('#parental-kind [data-value="vod"]').click();
  await expect(group('Cat A')).toHaveClass(/\bactive\b/);
  const item = view.locator('[data-parental-item]').filter({ hasText: 'Movie Shared' });
  await expect(item).toContainText('Not locked');
  await item.click();
  await expect(item).toContainText('Locked');
  await expect(group('Cat A')).toContainText('Partly locked');

  await group('Cat B').click();
  await expect(view.locator('.parental-column-item h3')).toHaveText('Cat B');
  await expect(view.locator('[data-parental-item]')).toHaveCount(1);
  await expect(group('Cat B')).toContainText('Partly locked');
  await expect(group('Cat A')).not.toContainText('Partly locked');
});

test('Reset App clears a forgotten PIN', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await page.locator('[data-parental-back]').click();
  await expect(page.locator('#manage-parental-controls')).toHaveText('Manage');
  expect(await readUserDataStore(page, 'parental-control')).toHaveLength(1);

  await page.locator('#reset-app').click();
  await page.locator('[data-confirm-action="confirm"]').click();
  await page.waitForEvent('load');

  expect(await readUserDataStore(page, 'parental-control')).toHaveLength(0);
  await enterTab(page, 'settings');
  await expect(page.locator('#manage-parental-controls')).toHaveText('Turn on');
  await expect(page.locator('.parental-entry-title .parental-entry-status')).toHaveText('Off');
});

test('backgrounding closes an open PIN challenge', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await leaveLocked(page);
  await enterTab(page, 'live');
  await page.locator('.channel-main .channel-item').first().click();
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(prompt).toBeHidden();
});

test('backgrounding closes an open Change PIN prompt', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('[data-parental-change-pin]').click();
  const prompt = page.locator('.parental-pin-prompt');
  await expect(prompt).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(prompt).toBeHidden();
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('relocking drops hidden channels from open search results', async ({ page }) => {
  await openManagerWithNewPin(page);
  const news = page.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await expect(news).toContainText('Locked');
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await chooseOption(page, 'parental-duration', '5-minutes');
  await page.locator('[data-parental-back]').click();

  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('channel');
  const rows = page.locator('#view-search .search-channel-row');
  await expect(rows.filter({ hasText: 'Channel One' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Channel Two' })).toHaveCount(1);

  await page.locator('[data-lock-now]').click();
  await expect(rows.filter({ hasText: 'Channel One' })).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Channel Two' })).toHaveCount(1);
});

test('relocking while recent searches are open keeps movies in the next search', async ({ page }) => {
  await seedVodAccount(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_search_history', JSON.stringify(['Movie']));
  });
  await page.goto('/');
  await createPinFromSettings(page);
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await chooseOption(page, 'parental-duration', '5-minutes');
  await page.locator('[data-parental-back]').click();

  await enterTab(page, 'live');
  await enterTab(page, 'search');
  await expect(page.locator('#view-channels')).toBeVisible();
  const tile = page.locator('.search-history-dropdown .search-history-tile');
  await expect(tile).toHaveText(['Movie']);
  await page.locator('.tab-bar [data-lock-now]').click();
  await expect(page.locator('.tab-bar [data-lock-now]')).toHaveCount(0);

  // The Lock button left, shifting the box; the panel still hangs under it.
  const panel = page.locator('.search-history-panel');
  await expect(panel).toBeVisible();
  await expect.poll(async () => {
    const [box, hung] = await Promise.all([
      page.locator('.tab-bar-search-input').boundingBox(), panel.boundingBox(),
    ]);
    return Math.abs(box!.x + box!.width - (hung!.x + hung!.width));
  }).toBeLessThanOrEqual(1);
  // The click took focus from the box; the remote gets it back, and its
  // first press never lands on the clear button.
  await expect(page.locator('.tab-bar-search-input')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tile.first()).toHaveClass(/focused/);
  await expect(page.locator('[data-history-clear]')).not.toHaveClass(/focused/);

  await page.locator('.tab-bar-search-input').fill('Movie');
  await expect(page.locator('#view-search .catalog-tile[data-stream-id="20"]')).toContainText('Movie Two');
});

test('a search that opened locked content stays out of recent searches', async ({ page }) => {
  await seedVodAccount(page);
  await page.goto('/');
  await createPinFromSettings(page);
  await page.locator('#parental-kind [data-value="vod"]').click();
  const catB = page.locator('[data-parental-group]').filter({ hasText: 'Cat B' });
  await catB.click();
  await catB.click();
  await expect(catB.locator('.lock-badge')).toHaveClass(/is-locked/);
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await chooseOption(page, 'parental-duration', '5-minutes');
  await page.locator('[data-parental-back]').click();

  // The unlock session shows the locked movie; opening it records nothing.
  await enterTab(page, 'live');
  await enterTab(page, 'search');
  const input = page.locator('.tab-bar-search-input');
  await input.fill('Two');
  const locked = page.locator('#view-search .catalog-tile[data-stream-id="20"]');
  await expect(locked).toContainText('Movie Two');
  await locked.click();
  await expect(page.locator('#view-movies')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBeNull();

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-search')).toBeVisible();
  await input.fill('One');
  const open = page.locator('#view-search .catalog-tile[data-stream-id="10"]');
  await expect(open).toContainText('Movie One');
  await open.click();
  await expect(page.locator('#view-movies')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('iptv_search_history'))).toBe('["One"]');
});

test('channel editing and Reset Customization ask for the PIN while live locks apply', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await leaveLocked(page);
  const prompt = page.locator('.parental-pin-prompt');

  await enterTab(page, 'live');
  await page.locator('[data-edit-channels]').click();
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('h2')).toContainText('Edit Channel List');
  await expect(page.locator('.channel-view.editing')).toHaveCount(0);
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('.channel-view.editing .edit-hints')).toBeVisible();
  await page.keyboard.press('Escape');

  await enterTab(page, 'settings');
  await page.locator('#reset-customization').click();
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('h2')).toContainText('Reset Customization');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('[data-confirm-action="confirm"]')).toBeVisible();
});

test('lists copies that differ only by a token as one channel row', async ({ page }) => {
  await neuterVideo(page);
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 group-title="Kids",Channel One',
    'http://streams.example.com/one.m3u8?token=t1',
    '#EXTINF:-1 group-title="Kids",Channel One',
    'http://streams.example.com/one.m3u8?token=t2',
    '#EXTINF:-1 group-title="Kids",Channel Two',
    'http://streams.example.com/two.m3u8',
  ].join('\n'));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  const view = page.locator('#view-parental-controls');
  const kids = view.locator('[data-parental-group]').filter({ hasText: 'Kids' });
  await kids.click();
  const items = view.locator('.parental-column-item [data-parental-item]');
  await expect(items.filter({ hasText: 'Channel Two' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Channel One' })).toHaveCount(1);
  const keys = await view.locator('.parental-column-item [data-key]')
    .evaluateAll(rows => rows.map(row => row.getAttribute('data-key')));
  expect(new Set(keys).size).toBe(keys.length);
});

test('shows a merged channel locked by its group in another playlist', async ({ page }) => {
  await neuterVideo(page);
  await routePlaylist(page);
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Alpha', url: 'http://host.example.com/a/playlist.m3u' },
      { id: 'p2', name: 'Bravo', url: 'http://host.example.com/b/playlist.m3u' },
    ]));
  });
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');

  const view = page.locator('#view-parental-controls');
  const playlists = view.locator('.parental-column-source [data-parental-source]');
  const news = view.locator('[data-parental-group]').filter({ hasText: 'News' });
  const item = view.locator('.parental-column-item [data-parental-item]')
    .filter({ hasText: 'Channel One' });
  await playlists.filter({ hasText: 'Bravo' }).click();
  await news.click();
  await expect(news.locator('.lock-badge')).toHaveClass(/is-locked/);

  await playlists.filter({ hasText: 'Alpha' }).click();
  await expect(news.locator('.lock-badge')).not.toHaveClass(/is-locked/);
  await expect(item).toContainText('Locked');
  await expect(item).not.toContainText('Not locked');

  // Unlocking it here records an exception that also overrides the other playlist's lock.
  await item.click();
  await expect(item).toContainText('Not locked');
});

function remoteKey(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })),
    keyCode,
  );
}

test('the Red and Blue keys act inside the manager instead of leaving it', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  await remoteKey(page, 403);
  for (const name of ['News', 'Movies']) {
    await expect(view.locator('[data-parental-group]').filter({ hasText: name })
      .locator('.lock-badge')).toHaveClass(/is-locked/);
  }
  await remoteKey(page, 406);
  await expect(view).toBeVisible();
  await expect(page.locator('#view-epg')).toBeHidden();
});

test('backgrounding closes the manager and restores concealment', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-group]').filter({ hasText: 'News' }).click();
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await chooseOption(page, 'parental-duration', '5-minutes');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#view-parental-controls')).toBeHidden();
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await enterTab(page, 'live');
  await expect(page.locator('.channel-main .channel-item').filter({ hasText: 'Channel Two' }))
    .toHaveCount(1);
  await expect(page.locator('.channel-main .channel-item').filter({ hasText: 'Channel One' }))
    .toHaveCount(0);

  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  await expect(page.locator('.parental-pin-prompt')).toBeVisible();
});

test('Up in the PIN field does not enter a digit', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-back]').click();
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  const input = prompt.locator('.parental-pin-input');
  await expect(input).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(input).toHaveValue('');
  await expect(prompt.locator('.parental-pin-slots .filled')).toHaveCount(0);
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('a re-render keeps a pointer-hidden highlight hidden until the next key shows it', async ({ page }) => {
  const streams = Array.from({ length: 200 }, (_, index) => ({
    stream_id: index + 1, name: `Movie ${index}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await neuterVideo(page);
  await routeLiveManifest(page);
  await routeVodCatalog(page, [{ category_id: '1', category_name: 'Cat A' }], () => streams);
  await page.goto('/');
  await createPinFromSettings(page);
  const view = page.locator('#view-parental-controls');
  await view.locator('#parental-kind [data-value="vod"]').click();
  await view.locator('[data-parental-group]').filter({ hasText: 'Cat A' }).click();
  const item = (index: number) => view.locator(`[data-parental-item="${String(index)}"]`);
  await expect(item(2)).toContainText('Movie 2');
  // Park the real cursor the clicks left over the lists, or it hovers a row.
  await page.mouse.move(0, 0);

  await hoverThenLeave(item(2));
  // A small scroll re-renders the virtual list with the row still mounted.
  await view.locator('[data-parental-list="item"]').evaluate((list) => { list.scrollTop = 20; });
  await page.waitForTimeout(100);
  await expect(view.locator('.focused')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await expect(item(2)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(item(3)).toHaveClass(/\bfocused\b/);
});

test('the remove-all prompt owns the remote ring, not the manager behind it', async ({ page }) => {
  await openManagerWithNewPin(page);
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('[data-parental-remove-all]').click();
  const confirm = page.locator('.confirmation-prompt');
  await expect(confirm).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(confirm.locator('[data-confirm-action="cancel"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-parental-controls .focused')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(confirm.locator('[data-confirm-action="confirm"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-parental-controls .focused')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(page.locator('[data-parental-remove-all]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('Lock now from the bar resumes Live on a row still shown', async ({ page }) => {
  await openManagerWithNewPin(page);
  const view = page.locator('#view-parental-controls');
  const news = view.locator('[data-parental-group]').filter({ hasText: 'News' });
  await news.click();
  await expect(news).toContainText('Locked');
  await chooseOption(page, 'parental-conceal', 'hide-locked');
  await chooseOption(page, 'parental-duration', 'until-backgrounded');
  await page.locator('[data-parental-back]').click();

  await enterTab(page, 'live');
  const rows = page.locator('#view-channels .channel-main .channel-item');
  const one = rows.filter({ hasText: 'Channel One' });
  await expect(one).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(rows.first()).toHaveClass(/\bfocused\b/);
  await expect(rows.first()).toHaveText(/Channel One/);

  // Up onto the bar, Left onto Lock now, and lock with OK.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  const lockNow = page.locator('.tab-bar [data-lock-now]');
  await expect(lockNow).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(lockNow).toHaveCount(0);
  await expect(one).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  await expect(page.locator('#view-channels .focused')).toBeInViewport();
});

test('the pointer on the account menu keeps one ring, and Back returns to the avatar', async ({ page }) => {
  await seedVodAccount(page);
  await page.addInitScript(() => {
    const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]');
    playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
      source: 'xtream', xtream: { username: 'v', password: 'q' } });
    localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
  });
  await page.goto('/');
  await createPinFromSettings(page);
  const view = page.locator('#view-parental-controls');
  const playlist = view.locator('.parental-column-source [data-parental-source]').first();
  await expect(playlist).toBeVisible();
  const hover = async (target: typeof playlist) => {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  await view.locator('.account-avatar').click();
  await expect(view.locator('.account-menu')).toBeVisible();
  // The pointer crosses the list on its way back to the menu, which keeps
  // the hover outside it dark.
  await hover(playlist);
  await expect(playlist).not.toHaveClass(/\bfocused\b/);
  const bravo = view.locator('.account-menu-item[data-account-id="x2"]');
  await hover(bravo);
  await expect(bravo).toHaveClass(/\bfocused\b/);
  await expect(playlist).not.toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowUp');
  await expect(view.locator('.account-menu-item[data-account-id="x1"]')).toHaveClass(/\bfocused\b/);
  await expect(view.locator('.focused:not(.parental-account-slot)')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(view.locator('.account-menu')).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(view.locator('.account-avatar')).toHaveClass(/\bfocused\b/);
  await expect(view.locator('.focused:not(.parental-account-slot)')).toHaveCount(1);
});
