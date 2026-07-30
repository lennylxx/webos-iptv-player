import { test, expect, routePlaylist, seedPlaylist, SEARCH_M3U, enterTab, type Page } from './helpers';

// Channel customization: the in-place edit mode on the Live channel list —
// reorder, hide, rename, regroup — plus its Settings entry point,
// show-hidden toggle, and reset.

const RED = 403;
const GREEN = 404;
const YELLOW = 405;
const BLUE = 406;
const ENTER = 13;
const UP = 38;
const DOWN = 40;
const BACK = 461;

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })),
    keyCode,
  );
}

function names(page: Page): Promise<string[]> {
  return page.locator('.channel-main .channel-name').allInnerTexts();
}

/** Boot into the Live list with the four-channel sample playlist. */
async function boot(page: Page): Promise<void> {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(4);
}

/** Move focus onto a channel row by pointer, as the Magic Remote would. */
async function focusChannel(page: Page, index: number): Promise<void> {
  await page.locator('.channel-main .channel-item').nth(index).hover();
  await expect(page.locator('.channel-main .channel-item').nth(index)).toHaveClass(/focused/);
}

test('yellow enters edit mode and shows the color-key hints; yellow again leaves', async ({ page }) => {
  await boot(page);

  await key(page, YELLOW);
  await expect(page.locator('.edit-hints')).toBeVisible();

  await key(page, YELLOW);
  await expect(page.locator('.edit-hints')).toHaveCount(0);
});

test('back leaves edit mode instead of leaving the channel list', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await expect(page.locator('.edit-hints')).toBeVisible();

  await key(page, BACK);
  await expect(page.locator('.edit-hints')).toHaveCount(0);
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('grab and move reorders a channel, and the order survives a reload', async ({ page }) => {
  await boot(page);
  expect(await names(page)).toEqual(['Alpha News', 'Beta News', 'Alpha Movies', 'Delta Sports']);

  await key(page, YELLOW);
  await focusChannel(page, 3);
  await key(page, ENTER);
  await expect(page.locator('.channel-main .channel-item').nth(3)).toHaveClass(/grabbed/);

  await key(page, UP);
  await key(page, UP);
  await key(page, UP);
  expect(await names(page)).toEqual(['Delta Sports', 'Alpha News', 'Beta News', 'Alpha Movies']);

  // Dropping keeps the row where it was moved to.
  await key(page, ENTER);
  await expect(page.locator('.grabbed')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('#view-channels')).toBeVisible();
  expect(await names(page)).toEqual(['Delta Sports', 'Alpha News', 'Beta News', 'Alpha Movies']);
  // Channel numbers follow the custom order.
  await expect(page.locator('.channel-main .channel-item').first()).toContainText('1');
});

test('green hides a channel in edit mode and toggles a favorite outside it', async ({ page }) => {
  await boot(page);

  // Outside edit mode green is still the favorite toggle.
  await focusChannel(page, 0);
  await key(page, GREEN);
  await expect(page.locator('.channel-main .channel-name').first()).toContainText('★');

  await key(page, YELLOW);
  await focusChannel(page, 1);
  await key(page, ENTER);
  await key(page, GREEN);
  // Hidden channels stay listed while editing, marked, so they can be brought back.
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(4);
  await expect(page.locator('.channel-main .channel-item').nth(1)).toHaveClass(/hidden-entry/);

  await key(page, YELLOW);
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(3);
  expect(await names(page)).not.toContain('Beta News');
  await expect(page.locator('.channel-count')).toHaveText('3 channels');

  await page.reload();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(3);
});

test('leaving edit mode through the tab bar keeps hidden channels out of Search', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 1);
  await key(page, ENTER);
  await key(page, GREEN);
  await expect(page.locator('.channel-main .channel-item').nth(1)).toHaveClass(/hidden-entry/);

  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('Beta News');

  await expect(page.locator('.search-channel-row')).toHaveCount(0);
  await expect(page.locator('.edit-hints')).toHaveCount(0);
});

test('blue renames a channel, and an empty rename restores the source name', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);

  await key(page, BLUE);
  await page.locator('.edit-text-input').fill('My Channel');
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel-main .channel-name').first()).toHaveText('My Channel');
  // The source name stays visible while editing so the origin is still clear.
  await expect(page.locator('.channel-main .channel-item').first()
    .locator('.channel-source-name')).toContainText('Alpha News');

  await page.reload();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-name').first()).toHaveText('My Channel');

  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);
  await key(page, BLUE);
  await page.locator('.edit-text-input').fill('');
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel-main .channel-name').first()).toHaveText('Alpha News');
});

test('a renamed channel is escaped, not executed', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);
  await key(page, BLUE);
  await page.locator('.edit-text-input').fill('<img src=x onerror="window.__xssfired=true">');
  await key(page, ENTER);

  await expect(page.locator('.channel-main .channel-name').first())
    .toContainText('<img src=x onerror=');
  await expect(page.locator('.channel-main img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xssfired?: boolean }).__xssfired))
    .toBeUndefined();
});

test('back cancels an open rename without changing the name', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);
  await key(page, BLUE);
  await page.locator('.edit-text-input').fill('Discarded');

  await key(page, BACK);
  await expect(page.locator('.edit-text-input')).toHaveCount(0);
  await expect(page.locator('.channel-main .channel-name').first()).toHaveText('Alpha News');
  // Still editing — one back closes the field, not the mode.
  await expect(page.locator('.edit-hints')).toBeVisible();
});

test('red moves a channel into another group', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);

  await key(page, RED);
  await expect(page.locator('.group-picker')).toBeVisible();
  await page.locator('.group-picker-option[data-group-choice="Sports"]').hover();
  await key(page, ENTER);
  await expect(page.locator('.group-picker')).toHaveCount(0);

  await key(page, YELLOW);
  await page.locator('[data-group="source:Sports"]').click();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  await expect(page.locator('.channel-main')).toContainText('Alpha News');
  await page.locator('[data-group="source:News"]').click();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(1);
});

test('red can place a channel in a new custom group', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);

  await key(page, RED);
  await page.locator('.group-picker-option[data-group-choice="new"]').hover();
  await key(page, ENTER);
  await page.locator('.edit-text-input').fill('Favorites Plus');
  await key(page, ENTER);

  await key(page, YELLOW);
  await expect(page.locator('[data-group="source:Favorites Plus"]')).toBeVisible();
  await page.locator('[data-group="source:Favorites Plus"]').click();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(1);
  await expect(page.locator('.channel-main')).toContainText('Alpha News');
});

test('a group row can be reordered, renamed, and hidden', async ({ page }) => {
  await boot(page);
  await key(page, YELLOW);

  // Reorder: grab Sports (last source group) and move it above Entertainment.
  await page.locator('[data-group="source:Sports"]').hover();
  await key(page, ENTER);
  await key(page, UP);
  const groups = page.locator('.group-item[data-group^="source:"] .group-name');
  await expect(groups).toHaveText(['News', 'Sports', 'Entertainment']);
  await key(page, ENTER);

  // Rename: the label changes, the channels stay in the group.
  await page.locator('[data-group="source:News"]').hover();
  await key(page, ENTER);
  await key(page, BLUE);
  await page.locator('.edit-text-input').fill('Headlines');
  await key(page, ENTER);
  await expect(page.locator('[data-group="source:Headlines"]')).toBeVisible();

  // Hide: every channel of the group drops out once edit mode ends.
  await page.locator('[data-group="source:Headlines"]').hover();
  await key(page, GREEN);
  await key(page, YELLOW);
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);
  expect(await names(page)).toEqual(['Alpha Movies', 'Delta Sports']);
});

test('Settings enters edit mode, reveals hidden channels, and resets everything', async ({ page }) => {
  await boot(page);

  // Hide one channel, then leave edit mode.
  await key(page, YELLOW);
  await focusChannel(page, 1);
  await key(page, ENTER);
  await key(page, GREEN);
  await key(page, YELLOW);
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(3);

  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
  await expect(page.locator('#channel-customization-settings')).toBeVisible();

  // Show hidden reveals the hidden channel in the normal list, marked.
  await page.locator('#show-hidden [data-value="on"]').click();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(4);
  await expect(page.locator('.channel-main .hidden-entry')).toHaveCount(1);

  // Reset clears the customization after a confirmation.
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
  await page.locator('#reset-customization').click();
  await expect(page.locator('.confirmation-prompt')).toBeVisible();
  await page.locator('.confirmation-btn').first().click();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .hidden-entry')).toHaveCount(0);
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(4);
});

test('the Settings edit-channel-list button jumps to the Live list in edit mode', async ({ page }) => {
  await boot(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
  await page.locator('#edit-channel-list').click();

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.edit-hints')).toBeVisible();
});

test('playback follows a channel reordered while it is playing', async ({ page }) => {
  await boot(page);
  await page.route('**/*.m3u8', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n',
    }));

  await focusChannel(page, 0);
  await key(page, ENTER);
  await expect(page.locator('#view-player')).toBeVisible();
  await key(page, BACK);
  await expect(page.locator('#view-channels')).toBeVisible();

  // Move the playing channel to the end; it stays marked as playing.
  await key(page, YELLOW);
  await focusChannel(page, 0);
  await key(page, ENTER);
  await key(page, DOWN);
  await key(page, DOWN);
  await key(page, DOWN);
  await key(page, ENTER);
  await key(page, YELLOW);

  expect(await names(page)).toEqual(['Beta News', 'Alpha Movies', 'Delta Sports', 'Alpha News']);
  await expect(page.locator('.channel-main .channel-item.playing .channel-name'))
    .toHaveText('Alpha News');
});
