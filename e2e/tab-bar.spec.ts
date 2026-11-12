import { test, expect, routeLiveManifest, SAMPLE_M3U, enterTab, liveLoaded } from './helpers';

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
  await liveLoaded(page);

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
  await liveLoaded(page);

  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();
});

test('the Guide tab opens the EPG below the docked bar, and Back returns to Live', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  // The guide is a section now: the bar stays docked with Guide active.
  await expect(page.locator('.tab-bar')).toBeVisible();
  await expect(page.locator('.tab-bar-item[data-section="epg"].active')).toHaveCount(1);
  const bar = (await page.locator('.tab-bar').boundingBox())!;
  const epg = (await page.locator('#view-epg .epg-view').boundingBox())!;
  expect(epg.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);

  await page.keyboard.press('Escape');
  await liveLoaded(page);
  await expect(page.locator('.tab-bar-item[data-section="live"].active')).toHaveCount(1);
});

test('the Settings tab (after Series) opens the settings view', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
});

test('the tab bar is hidden during full-screen playback', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
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
  await liveLoaded(page);

  // Open the search box from the channels view.
  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();

  // No results view yet (no "Type to search" hint covering the content).
  await expect(page.locator('#view-search')).toBeHidden();
  await liveLoaded(page);

  // Typing shows the results view over the current one.
  await page.locator('.tab-bar-search-input').fill('Channel');
  await expect(page.locator('#view-search')).toBeVisible();

  // Clearing the box restores the underlying view.
  await page.locator('.tab-bar-search-input').fill('');
  await expect(page.locator('#view-search')).toBeHidden();
  await liveLoaded(page);
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
  await liveLoaded(page);

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
  await liveLoaded(page);

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
  await liveLoaded(page);

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Settings');

  // Cancel returns to the channel list — and the active tab follows.
  await page.locator('#cancel-settings').click();
  await liveLoaded(page);
  await expect(page.locator('.tab-bar-item.active')).toHaveText('Live');
});

// Resolve a theme token to its computed rgb() through a transition-free probe.
function tokenColor(page: import('@playwright/test').Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

test('the Search magnifier rests bare and draws the focus circle on hover and D-pad focus', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  const icon = page.locator('.tab-bar-search .search-icon');
  const look = () => icon.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, shadow: s.boxShadow, transform: s.transform };
  });
  const rest = await look();
  expect(rest.border).toBe('rgba(0, 0, 0, 0)');
  expect(rest.shadow).toBe('none');
  // Its parent must not clip the glow.
  expect(await page.locator('.tab-bar-search').evaluate((el) => getComputedStyle(el).overflow)).toBe('visible');

  const box = (await icon.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const ring = await tokenColor(page, '--focus-ring');
  await expect.poll(async () => (await look()).border).toBe(ring);
  const hover = await look();
  expect(hover.shadow).not.toBe('none');
  expect(hover.transform).toBe('none');
  await page.mouse.move(960, 1070);
  await expect.poll(async () => (await look()).shadow).toBe('none');

  // D-pad: Up onto the bar, then Right along the ring to the magnifier.
  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  for (let i = 0; i < 8 && !(await icon.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(icon).toHaveClass(/focused/);
  await expect.poll(async () => (await look()).border).toBe(ring);
  expect((await look()).transform).toBe('none');
});

test('a hovered text tab brightens to the active tab color', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  const color = (section: string) => page.locator(`.tab-bar-item[data-section="${section}"]`)
    .evaluate((el) => getComputedStyle(el).color);
  const active = await color('live');
  expect(await color('movies')).not.toBe(active);
  const box = (await page.locator('.tab-bar-item[data-section="movies"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => color('movies')).toBe(active);
});

test('the open Search shows the text tabs\' accent underline under the magnifier', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  const icon = page.locator('.tab-bar-search .search-icon');
  const underline = () => icon.evaluate((el) => getComputedStyle(el, '::after').content);
  expect(await underline()).toBe('none');

  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
  await page.mouse.move(960, 1070); // off the icon, so hover doesn't hide the underline
  await expect.poll(underline).not.toBe('none');
  expect(await icon.evaluate((el) => getComputedStyle(el, '::after').backgroundColor))
    .toBe(await tokenColor(page, '--accent'));
  // Only the straight bar: the circle's own border stays clear.
  await expect.poll(() => icon.evaluate((el) => getComputedStyle(el).borderBottomColor)).toBe('rgba(0, 0, 0, 0)');
  // The underline sits on the same baseline as the text tabs' underline.
  const iconBottom = (await icon.boundingBox())!;
  const tab = (await page.locator('.tab-bar-item[data-section="live"]').boundingBox())!;
  expect(Math.abs((iconBottom.y + iconBottom.height) - (tab.y + tab.height))).toBeLessThanOrEqual(1.5);
});

test('switching to the D-pad drops a resting pointer\'s hover circle on the magnifier', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  const icon = page.locator('.tab-bar-search .search-icon');
  const look = () => icon.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopColor, shadow: s.boxShadow };
  });
  const box = (await icon.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await look()).border).toBe(await tokenColor(page, '--focus-ring'));

  // The pointer stays put while the D-pad moves focus into the list.
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await look()).shadow).toBe('none');
  expect((await look()).border).toBe('rgba(0, 0, 0, 0)');

  // Moving the pointer brings the hover look back.
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await expect.poll(async () => (await look()).shadow).not.toBe('none');

  // The avatar's hover lift drops the same way.
  const avatar = page.locator('.account-avatar');
  const filter = () => avatar.evaluate((el) => getComputedStyle(el).filter);
  const a = (await avatar.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await expect.poll(filter).not.toBe('none');
  await page.keyboard.press('ArrowDown');
  await expect.poll(filter).toBe('none');
});

// KeyHandler takes a pointer's first move as its resting position, so move
// twice for a hover to register.
async function pointAt(page: import('@playwright/test').Page, target: import('@playwright/test').Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('no layout');
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

function pressGreen(page: import('@playwright/test').Page): Promise<void> {
  return page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 404, bubbles: true })));
}

test.describe('a pointer click on a section tab', () => {
  test('shows no ring in Live until a key, which only reveals the entry point', async ({ page }) => {
    const events: string[] = [];
    page.on('console', (msg) => events.push(msg.text()));
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    await expect(rows.nth(1)).toBeVisible();
    await pointAt(page, rows.nth(1));
    await expect(rows.nth(1)).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    const item = page.locator('#view-settings .settings-nav-item').nth(1);
    await pointAt(page, item);
    await expect(item).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'live');
    await liveLoaded(page);
    await expect(page.locator('#view-channels')).toHaveAttribute('data-ring-owner', 'deferred');
    await expect(page.locator('#view-channels .focused')).toHaveCount(0);
    await expect(rows.first()).toHaveClass(/\bfocused-parked\b/);

    await page.keyboard.press('ArrowDown');
    await expect(rows.first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-channels .focused')).toHaveCount(1);
    await expect(page.locator('#view-channels')).toHaveAttribute('data-ring-owner', '');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.tab-bar-item.focused')).toHaveCount(0);

    expect(events.some((text) => /event=nav\.focus\.deferred view=settings\b/.test(text))).toBe(true);
    expect(events.some((text) => /event=nav\.focus\.deferred view=channels\b/.test(text))).toBe(true);
    expect(events.some((text) =>
      /event=nav\.focus\.shown via=key action=down consumed=yes/.test(text))).toBe(true);
  });

  test('from the hovered edit button, shows no ring in Live until a key', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    const edit = page.locator('#view-channels .channel-edit-btn');
    await expect(rows.first()).toBeVisible();
    await pointAt(page, edit);
    await expect(edit).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'live');
    await expect(page.locator('#view-channels .focused')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(rows.first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  });

  test('shows no ring in the Guide until a key', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

    await enterTab(page, 'epg');
    await expect(page.locator('#view-epg .epg-channel-item').first()).toBeVisible();
    await expect(page.locator('#view-epg .focused')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-epg .epg-channel-item.focused')).toHaveCount(1);
    await expect(page.locator('#view-epg .epg-channel-item').first()).toHaveClass(/\bfocused\b/);
  });

  test('shows no ring in Settings until a key', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

    await enterTab(page, 'settings');
    const first = page.locator('#view-settings .settings-nav-item').first();
    await expect(first).toBeVisible();
    await expect(page.locator('#view-settings .focused')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(first).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-settings .focused')).toHaveCount(1);
  });

  test('takes Green as the first key to show the row, not to favorite it', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    await expect(rows.first()).toBeVisible();

    await enterTab(page, 'live');
    await expect(page.locator('#view-channels .focused')).toHaveCount(0);
    await pressGreen(page);
    await expect(rows.first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-channels .favorite-glyph')).toHaveCount(0);

    await pressGreen(page);
    await expect(rows.first().locator('.favorite-glyph')).toBeVisible();
  });
});

test('a clicked tab draws no native focus ring', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  // After a key press the engine draws a ring for any focused button.
  await page.keyboard.press('Shift');
  const outline = await page.locator('.tab-bar-item[data-section="live"]').evaluate((el) => {
    (el as HTMLElement).focus();
    return getComputedStyle(el).outlineStyle;
  });
  expect(outline).toBe('none');
});

test.describe('hovering content after D-pad Up onto the tab bar', () => {
  test('hands the keys back to the Live list', async ({ page }) => {
    const events: string[] = [];
    page.on('console', (msg) => events.push(msg.text()));
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    await expect(rows.first()).toHaveClass(/\bfocused\b/);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="live"].focused')).toHaveCount(1);

    await pointAt(page, rows.nth(1));
    await expect(rows.nth(1)).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.tab-bar-item.focused')).toHaveCount(0);
    await expect(page.locator('#view-channels')).toHaveAttribute('data-ring-owner', '');

    // Right acts in the list instead of switching the bar to Guide.
    await page.keyboard.press('ArrowRight');
    await liveLoaded(page);
    await expect(page.locator('#view-epg')).toBeHidden();
    await expect(page.locator('.tab-bar-item[data-section="live"].active')).toHaveCount(1);
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
    await expect(page.locator('#view-channels')).toHaveAttribute('data-ring-owner', '');
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toHaveClass(/\bfocused\b/);
    expect(events.some((text) => /event=tab_bar\.blur reason=hover\b/.test(text))).toBe(true);
  });

  test('hands the keys back to Settings', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

    // Up onto Live, then Right along the bar to Settings.
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tab-bar-item[data-section="settings"].focused')).toHaveCount(1);
    await expect(page.locator('#view-settings')).toBeVisible();
    const items = page.locator('#view-settings .settings-nav-item');

    await pointAt(page, items.nth(1));
    await expect(items.nth(1)).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.tab-bar-item.focused')).toHaveCount(0);

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
    await expect(page.locator('#view-settings')).toHaveAttribute('data-ring-owner', '');
    await expect(page.locator('#view-settings .focused')).toHaveCount(1);
  });
});

test.describe('D-pad Up in Settings', () => {
  async function openSettings(page: import('@playwright/test').Page) {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
    await enterTab(page, 'settings');
    const first = page.locator('#view-settings .settings-nav-item').first();
    await page.keyboard.press('ArrowDown');
    await expect(first).toHaveClass(/\bfocused\b/);
    return first;
  }

  test('reaches the tab bar from the first category', async ({ page }) => {
    const first = await openSettings(page);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="settings"].focused')).toHaveCount(1);
    await expect(page.locator('#view-settings .focused')).toHaveCount(0);
    await expect(page.locator('#view-settings .dropdown.open')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(first).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  });

  test('reaches the tab bar from the top of the pane', async ({ page }) => {
    await openSettings(page);
    await page.keyboard.press('ArrowRight');
    const language = page.locator('#view-settings [data-dropdown-trigger]').first();
    await expect(language).toHaveClass(/\bfocused\b/);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="settings"].focused')).toHaveCount(1);
    await expect(page.locator('#view-settings .focused')).toHaveCount(0);
  });

  test('keeps Up inside an open dropdown', async ({ page }) => {
    await openSettings(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const menu = page.locator('#view-settings .dropdown.open');
    await expect(menu).toHaveCount(1);
    const options = menu.locator('.dropdown-option');
    await options.first().evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await expect(options.first()).toHaveClass(/\bfocused\b/);

    await page.keyboard.press('ArrowUp');
    await expect(menu).toHaveCount(1);
    await expect(options.first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  });
});

test.describe('the Guide channel column under the pointer', () => {
  test('a click after a Guide tab click shows the ring, and keys go on from it', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

    await enterTab(page, 'epg');
    const channels = page.locator('#view-epg .epg-channel-item');
    await expect(channels.nth(1)).toBeVisible();
    await expect(page.locator('#view-epg .focused')).toHaveCount(0);

    await channels.nth(1).click();
    await expect(channels.nth(1)).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg')).toHaveAttribute('data-ring-owner', '');

    await page.keyboard.press('ArrowUp');
    await expect(channels.first()).toHaveClass(/\bfocused\b/);
  });

  test('hovering it takes the keys from the tab bar', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.tab-bar-item[data-section="epg"].focused')).toHaveCount(1);
    const channels = page.locator('#view-epg .epg-channel-item');
    await expect(channels.nth(1)).toBeVisible();

    await pointAt(page, channels.nth(1));
    await expect(page.locator('.tab-bar-item.focused')).toHaveCount(0);
    await expect(channels.first()).toHaveClass(/\bfocused\b/);

    // Right stays in the Guide instead of switching the bar to the next
    // section; with no programmes to move to, the ring stays on the channel.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#view-epg')).toBeVisible();
    await expect(page.locator('.tab-bar-item[data-section="epg"].active')).toHaveCount(1);
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
    await expect(page.locator('#view-epg')).toHaveAttribute('data-ring-owner', '');
    await expect(page.locator('#epg-programmes .epg-no-data')).toBeVisible();
    await expect(channels.first()).toHaveClass(/\bfocused\b/);
  });
});

test('Up to the tab bar and back keeps unsaved Settings and their position', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
  await enterTab(page, 'settings');

  const active = page.locator('#auto-play .toggle-option.active');
  const changed = await active.getAttribute('data-value') === 'on' ? 'off' : 'on';
  await page.locator(`#auto-play .toggle-option[data-value="${changed}"]`).click();
  await expect(active).toHaveAttribute('data-value', changed);

  // Back to the top of the pane by keys, then out to the bar and down again.
  await page.keyboard.press('ArrowLeft');
  const nav = page.locator('#view-settings .settings-nav-item');
  await expect(page.locator('#view-settings .settings-nav-item.focused')).toHaveCount(1);
  for (let i = 0; i < 8; i++) {
    if (await nav.first().evaluate((el) => el.classList.contains('focused'))) break;
    await page.keyboard.press('ArrowUp');
  }
  await expect(nav.first()).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowRight');
  const language = page.locator('#view-settings [data-dropdown-trigger]').first();
  await expect(language).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item[data-section="settings"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(language).toHaveClass(/\bfocused\b/);
  await expect(nav.first()).toHaveClass(/\bactive\b/);
  await expect(active).toHaveAttribute('data-value', changed);
});

test('a channel number that lands while the bar owns the keys still clears its readout', async ({ page }) => {
  await seedXtream(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-main [data-channel-index]').first()).toBeVisible();
  const committed = page.waitForEvent('console', (m) => m.text().includes('event=key.number '));
  await page.keyboard.press('2');
  await expect(page.locator('.number-entry')).toHaveClass(/\bvisible\b/);
  await enterTab(page, 'search');
  await expect(page.locator('.tab-bar-search-input')).toBeFocused();
  await committed;
  // Read at once: the readout's own fallback timer would hide it a moment later.
  expect(await page.locator('.number-entry').evaluate((el) => el.classList.contains('visible'))).toBe(false);
});

test.describe('switching sections from the bar with the D-pad', () => {
  test('Down onto Live rings its entry point, not the bar, and never two rings', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    await expect(rows.first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="settings"]')).toHaveClass(/\bfocused\b/);
    for (const section of ['series', 'movies', 'epg', 'live']) {
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator(`.tab-bar-item[data-section="${section}"]`)).toHaveClass(/\bfocused\b/);
      await expect(page.locator('.focused:visible')).toHaveCount(1);
    }
    await liveLoaded(page);

    await page.keyboard.press('ArrowDown');
    await expect(rows.first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.focused:visible')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveClass(/\bfocused\b/);
  });

  test('a tab click between keys leaves the content dark until the next key', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    const rows = page.locator('#view-channels .channel-main [data-channel-index]');
    await expect(rows.first()).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="live"]')).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect(page.locator('.focused:visible')).toHaveCount(0);
    await expect(page.locator('#view-settings')).toHaveAttribute('data-ring-owner', 'deferred');

    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-settings .settings-nav-item').first()).toHaveClass(/\bfocused\b/);
    await expect(page.locator('.focused:visible')).toHaveCount(1);
  });

  test('Up from a Search result reaches the box, and Down from the box returns to the results', async ({ page }) => {
    await seedXtream(page);
    await routeLiveManifest(page);
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 6 && !(await page.locator('.tab-bar-item[data-section="search"].focused').count()); i++) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Enter');
    const input = page.locator('.tab-bar-search-input');
    await expect(input).toBeFocused();
    await page.keyboard.type('Channel');
    const result = page.locator('#view-search [data-focusable].focused');
    await page.keyboard.press('ArrowDown');
    await expect(result).toHaveCount(1);

    await page.keyboard.press('ArrowUp');
    await expect(input).toBeFocused();
    await expect(page.locator('#view-search .focused')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(result).toHaveCount(1);
    await expect(page.locator('.focused:visible')).toHaveCount(1);
  });
});

test('a hover on the Guide under its open group menu hands the bar\'s keys back without moving the grid', async ({ page }) => {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const now = Date.now();
  const hour = 3_600_000;
  const xmltv = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="${stamp(now - hour)}" stop="${stamp(now + hour)}"><title>Show 1</title></programme>
<programme channel="one" start="${stamp(now + hour)}" stop="${stamp(now + 2 * hour)}"><title>Show 2</title></programme>
<programme channel="one" start="${stamp(now + 2 * hour)}" stop="${stamp(now + 3 * hour)}"><title>Show 3</title></programme>
</tv>`;
  await seedXtream(page);
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: xmltv }));
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  const cell = page.locator('#epg-programmes [data-prog-idx="1"]');
  await expect(cell).toBeVisible();

  await page.locator('[data-epg-group-toggle]').click();
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await page.locator('.account-avatar').click();
  await expect(page.locator('.account-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  const owner = page.locator('[data-ring-owner]');
  await expect(owner).toHaveAttribute('data-focus-scope', 'tabbar');

  await cell.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await expect(owner).toHaveAttribute('data-focus-scope', 'guide.groups');
  await expect(page.locator('.focused:visible')).toHaveCount(1);
  await expect(page.locator('.epg-group-option.focused')).toHaveCount(1);
  // The grid's focus stays where the menu opened from.
  await expect(cell).not.toHaveAttribute('data-ring-hover');
  await expect(page.locator('#epg-programmes')).not.toHaveClass(/\bpane-focused\b/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.epg-group-menu')).toHaveCount(0);
  await expect(page.locator('[data-epg-group-toggle]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});

test('a hover under the account menu stays out of the Guide while its group menu is open', async ({ page }) => {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const now = Date.now();
  const hour = 3_600_000;
  const xmltv = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="${stamp(now - hour)}" stop="${stamp(now + hour)}"><title>Show 1</title></programme>
<programme channel="one" start="${stamp(now + hour)}" stop="${stamp(now + 2 * hour)}"><title>Show 2</title></programme>
<programme channel="one" start="${stamp(now + 2 * hour)}" stop="${stamp(now + 3 * hour)}"><title>Show 3</title></programme>
</tv>`;
  await seedXtream(page);
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: xmltv }));
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  const cell = page.locator('#epg-programmes [data-prog-idx="1"]');
  await expect(cell).toBeVisible();

  await page.locator('[data-epg-group-toggle]').click();
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await page.locator('.account-avatar').click();
  await expect(page.locator('.account-menu')).toBeVisible();
  const owner = page.locator('[data-ring-owner]');
  await expect(owner).toHaveAttribute('data-focus-scope', 'tabbar.accounts');

  const box = (await cell.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The group menu below the account menu keeps the Guide dark.
  await expect(page.locator('.account-menu')).toBeVisible();
  await expect(owner).toHaveAttribute('data-focus-scope', 'tabbar.accounts');
  await expect(cell).not.toHaveAttribute('data-ring-hover');
  await expect(cell).not.toHaveClass(/\bfocused\b/);
  await expect(page.locator('#epg-programmes')).not.toHaveClass(/\bpane-focused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('.account-menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(owner).toHaveAttribute('data-focus-scope', 'guide.groups');
  await page.keyboard.press('Escape');
  await expect(page.locator('.epg-group-menu')).toHaveCount(0);
  await expect(owner).toHaveAttribute('data-focus-scope', 'guide.grid');
  await expect(page.locator('[data-epg-group-toggle]')).toHaveClass(/\bfocused\b/);
  await expect(cell).not.toHaveClass(/\bfocused\b/);
  await expect(page.locator('.focused:visible')).toHaveCount(1);
});
