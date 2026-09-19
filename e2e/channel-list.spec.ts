import {
  test,
  expect,
  routePlaylist,
  seedPlaylist,
  SEARCH_M3U,
  enterTab,
  routeLiveManifest,
  measureRowTextFit,
} from './helpers';

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

// The row has a fixed height because the list is virtualized, so its two text
// lines can overflow into the neighbouring row instead of growing the row.
test('channel rows fit both text lines in their fixed box', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const fit = await measureRowTextFit(
    page,
    '.channel-main .channel-item',
    'channel-info',
    'channel-now',
  );
  expect(fit.needed).toBeLessThanOrEqual(fit.available);
});

// Each result section has its own scroll box, so a lone Channels list has to
// fill the view rather than stop at the height a second section would need.
test('M3U-only Search fills the view when Channels is the only section', async ({ page }) => {
  const many = ['#EXTM3U'];
  for (let i = 0; i < 12; i++) {
    many.push(`#EXTINF:-1 group-title="News",Alpha ${i}`, `http://streams.example.com/${i}.m3u8`);
  }
  await routePlaylist(page, many.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('alpha');
  await expect(page.locator('#view-search')).toBeVisible();

  const fill = await page.locator('.search-virtual-scroll').evaluate((el) => {
    const view = el.closest('.search-view') as HTMLElement;
    const available = view.clientHeight
      - (el.getBoundingClientRect().top - view.getBoundingClientRect().top)
      - parseFloat(getComputedStyle(view).paddingBottom);
    return { height: el.getBoundingClientRect().height, available };
  });
  expect(fill.height).toBeGreaterThan(fill.available - 4);
});

test('the list follows the playing channel however it was tuned', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 300; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`,
      `http://streams.example.com/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Tune far down the list, so the virtualized window is centered on 123...
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await page.keyboard.press('3');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-number')).toHaveText('123');

  // ...then tune again from the player, to a channel that window cannot hold.
  await page.keyboard.press('4');
  await expect(page.locator('.osd-channel-number')).toHaveText('4');

  // The sidebar opens on what is playing.
  await page.keyboard.press('ArrowLeft');
  const sidebarFocused = page.locator('#player-sidebar .sidebar-ch-item.focused');
  await expect(sidebarFocused).toContainText('Channel 4');
  await expect(sidebarFocused).toHaveClass(/playing/);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  // And so does the list — not the row it was parked on before.
  const focused = page.locator('.channel-main .channel-item.focused');
  await expect(focused).toContainText('Channel 4');
  await expect(focused).toHaveClass(/playing/);

  const list = page.locator('.channel-main');
  const [row, viewport] = await Promise.all([focused.boundingBox(), list.boundingBox()]);
  expect(row!.y).toBeGreaterThanOrEqual(viewport!.y);
  expect(row!.y + row!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
});

test('player sidebar reaches sources, groups, and channels by the shortest D-pad paths', async ({
  page,
}) => {
  await page.route('**/a.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Alpha",Ch 1\nhttp://host/ch1.m3u8',
  }));
  await page.route('**/b.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Bravo",Ch 2\nhttp://host/ch2.m3u8',
  }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Source 1', url: 'http://host/a.m3u', source: 'url' },
      { id: 'p2', name: 'Source 2', url: 'http://host/b.m3u', source: 'url' },
    ]));
  });
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-channels .group-item.focused')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  const channelSource = page.locator('#view-channels [data-playlist=""].focused');
  await expect(channelSource).toBeVisible();
  await page.waitForTimeout(250);
  const channelSourceFocus = await channelSource.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderBottom: style.borderBottomColor,
      boxShadow: style.boxShadow,
    };
  });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-channels [data-playlist="p1"].focused')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels [data-playlist="p1"].active')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-channels .group-item.active.focused')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-channels .channel-item.focused')).toContainText('Ch 1');

  await page.keyboard.press('1');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar .sidebar-ch-item.focused')).toContainText('Ch 1');

  await page.keyboard.press('ArrowUp');
  const sidebarSource = page.locator('[data-sidebar-playlist=""].focused');
  await expect(sidebarSource).toBeVisible();
  await expect.poll(() => sidebarSource.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      borderBottom: style.borderBottomColor,
      boxShadow: style.boxShadow,
    };
  })).toEqual(channelSourceFocus);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-sidebar-playlist="p1"].focused')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-sidebar-playlist="p2"].focused')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-sidebar-playlist="p1"].focused')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-sidebar-playlist=""].focused')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar .sidebar-group-item.focused')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#player-sidebar .sidebar-ch-item.focused')).toContainText('Ch 1');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-sidebar-playlist=""].focused')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-sidebar-playlist="p2"].focused')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-sidebar-playlist="p2"].active')).toBeVisible();
  await expect(page.locator('#player-sidebar .sidebar-ch-item.focused')).toContainText('Ch 2');

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar .sidebar-group-item.focused')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#player-sidebar .sidebar-ch-item.focused')).toContainText('Ch 2');
});

test('direct channel entry scrolls the list to the tuned channel and keeps it on return', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 300; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`,
      `http://streams.example.com/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  // Channel 215 is far outside the virtualized window rendered at startup.
  await expect(page.locator('.channel-main .channel-item')).not.toHaveCount(300);

  await page.keyboard.press('2');
  await page.keyboard.press('1');
  await page.keyboard.press('5');

  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-number')).toHaveText('215');

  // Back to the list: the tuned row is focused, marked playing, and on screen.
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  const focused = page.locator('.channel-main .channel-item.focused');
  await expect(focused).toContainText('Channel 215');
  await expect(focused).toHaveClass(/playing/);

  const list = page.locator('.channel-main');
  const [row, viewport] = await Promise.all([focused.boundingBox(), list.boundingBox()]);
  expect(row!.y).toBeGreaterThanOrEqual(viewport!.y);
  expect(row!.y + row!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
});

// Geometry alone puts re-entry focus on whichever row sits nearest the
// sidebar, which is not where the eye left off after scrolling. `.channel-main`
// opts into last-focused re-entry so the row you left is the row you return to.
test('returning from the sidebar restores the channel you left', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 40; i++) {
    lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="${i <= 20 ? 'Alpha' : 'Bravo'}",Ch ${i}`);
    lines.push(`http://host/${i}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowDown');

  const key = () => page.evaluate(() =>
    document.querySelector('#view-channels .channel-main .focused')?.getAttribute('data-key') ?? null);
  const left = await key();
  expect(left).not.toBeNull();

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-channels .sidebar .focused')).toHaveCount(1);

  // Right may hop within the sidebar before crossing back into the list.
  for (let i = 0; i < 4 && (await key()) === null; i++) await page.keyboard.press('ArrowRight');
  expect(await key()).toBe(left);
});
