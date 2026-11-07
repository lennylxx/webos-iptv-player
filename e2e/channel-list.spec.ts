import {
  test,
  expect,
  routePlaylist,
  seedPlaylist,
  SEARCH_M3U,
  enterTab,
  routeLiveManifest,
  measureRowTextFit,
  type Page,
} from './helpers';
import { seedXtream } from './fixtures/xtream';

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
  // A starved headless page renders no frames, so the focus transition can sit
  // at its start value; suspending it reads the settled style on both engines.
  const channelSourceFocus = await channelSource.evaluate(element => {
    const el = element as HTMLElement;
    el.style.transition = 'none';
    const style = getComputedStyle(el);
    const settled = {
      background: style.backgroundColor,
      borderBottom: style.borderBottomColor,
      boxShadow: style.boxShadow,
    };
    el.style.transition = '';
    return settled;
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

test('returning to a far playing channel keeps it focused under full animation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 300; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`,
      `http://streams.example.com/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('2');
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await expect(page.locator('.osd-channel-number')).toHaveText('215');

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  // A smooth far jump would pass through windows that drop the focused row.
  await page.waitForTimeout(1000);
  const focused = page.locator('.channel-main .channel-item.focused');
  await expect(focused).toContainText('Channel 215');
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

function longPlaylist(count: number): string {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= count; i++) {
    lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="Alpha",Ch ${i}`);
    lines.push(`http://host/${i}.m3u8`);
  }
  return lines.join('\n');
}

async function focusFirstChannelRow(page: Page): Promise<void> {
  const row0 = page.locator('#view-channels .channel-main [data-list-position="0"]');
  await expect(row0).toBeVisible();
  for (let i = 0; i < 4; i++) {
    if (await row0.evaluate((el) => el.classList.contains('focused'))) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(row0).toHaveClass(/\bfocused\b/);
}

// A key that scrolled the list holds its offset for two frames and reverts
// any scroll in between, so a test scroll waits the hold out.
async function settleVirtualScroll(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
}

test('Down after the focused row scrolls out of view stays in the channel list', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);

  // Scroll without the pointer following the rows (cursor hidden, or the wheel
  // over the list padding): the focused row leaves the rendered window.
  const main = page.locator('#view-channels .channel-main');
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 3000; });
  await expect(main.locator('[data-list-position="0"]')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#view-channels .focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-list-position', /^\d+$/);
  const view = await main.boundingBox();
  const row = await focused.boundingBox();
  if (!view || !row) throw new Error('no layout');
  expect(row.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(row.y + row.height).toBeLessThanOrEqual(view.y + view.height + 1);
  expect(repairedIn(events, 'channel', 'nearest')).toBe(true);
});

test('a stationary pointer over the channel list does not trap D-pad Down', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  const main = page.locator('#view-channels .channel-main');
  const start = main.locator('[data-list-position="5"]');
  await expect(start).toBeVisible();
  const box = await start.boundingBox();
  if (!box) throw new Error('no layout');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(start).toHaveClass(/\bfocused\b/);

  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
    // Leave time for the hover the browser fires as rows slide under the pointer.
    await page.waitForTimeout(150);
  }
  await expect(main.locator('[data-list-position="25"]')).toHaveClass(/\bfocused\b/);

  // Moving the pointer hands focus back to the row under it.
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
  const hovered = main.locator('.focused');
  await expect(hovered).toHaveCount(1);
  await expect(hovered).not.toHaveAttribute('data-list-position', '25');
  expect(events.some((text) => text.includes('event=nav.hover.resumed'))).toBe(true);
});

test('rapid D-pad under full animation moves one row per key press', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  await routePlaylist(page, longPlaylist(900));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  await focusFirstChannelRow(page);
  const main = page.locator('#view-channels .channel-main');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-list-position="10"]')).toHaveClass(/\bfocused\b/);

  // Each press lands while the previous smooth scroll is still running.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
  }
  await expect(main.locator('[data-list-position="22"]')).toHaveClass(/\bfocused\b/);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(250);
  }
  await expect(main.locator('[data-list-position="14"]')).toHaveClass(/\bfocused\b/);
  expect(events.filter((text) => text.includes('event=nav.focus.repaired'))).toEqual([]);
});

test('Up at the top of the sidebar goes to the tab bar, not the scrolled list', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-channels .channel-main [data-list-position="40"]'))
    .toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowLeft');
  const group = page.locator('#view-channels .sidebar [data-group-position].focused');
  await expect(group).toHaveCount(1);
  for (let i = 0; i < 10 && !(await page.locator('[data-edit-channels].focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('[data-edit-channels]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item[data-section="live"].focused')).toHaveCount(1);
  await expect(page.locator('#view-channels .focused')).toHaveCount(0);

  // Edit mode has no edit button: the top group hands off the same way.
  await page.keyboard.press('ArrowDown');
  await enterEditMode(page);
  const sidebarRing = page.locator('#view-channels .sidebar .focused');
  if (!(await sidebarRing.count())) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 10 && (await sidebarRing.getAttribute('data-group-position')) !== '0'; i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(sidebarRing).toHaveAttribute('data-group-position', '0');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item[data-section="live"].focused')).toHaveCount(1);
  await expect(page.locator('#view-channels .focused')).toHaveCount(0);
});

// One channel per group, so the group sidebar reaches below the short list.
function manyGroupsPlaylist(): string {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 12; i++) {
    lines.push(`#EXTINF:-1 tvg-id="c${i}" group-title="G${i}",Ch ${i}`);
    lines.push(`http://host/${i}.m3u8`);
  }
  return lines.join('\n');
}

test('Down and CH- at the last channel and CH+ at the first stay in the list', async ({ page }) => {
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  const main = page.locator('#view-channels .channel-main');
  const focused = page.locator('#view-channels .focused');

  await page.keyboard.press('PageUp');
  await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);
  await expect(focused).toHaveCount(1);

  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  const last = main.locator('[data-list-position="11"]');
  await expect(last).toHaveClass(/\bfocused\b/);
  for (const key of ['ArrowDown', 'PageDown']) {
    await page.keyboard.press(key);
    await expect(last).toHaveClass(/\bfocused\b/);
    await expect(focused).toHaveCount(1);
  }
});

function channelKey(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function pressKeyCode(page: Page, keyCode: number): Promise<void> {
  await page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })),
    keyCode,
  );
}

// Clicks a group, then takes the keys back to its first row.
async function openGroupByPointer(page: Page, group: string): Promise<void> {
  await page.locator(`[data-group="${group}"]`).click();
  await page.mouse.move(0, 0);
  await focusFirstChannelRow(page);
}

test('Down and CH- at the last Recently Watched item and CH+ at the first stay in the list', async ({
  page,
}) => {
  await page.addInitScript((keys) => {
    localStorage.setItem('iptv_recently_watched_live', JSON.stringify([
      { channelKey: keys[0], updatedAt: 2000 },
      { channelKey: keys[1], updatedAt: 1000 },
    ]));
  }, [channelKey('http://host/1.m3u8'), channelKey('http://host/2.m3u8')]);
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await openGroupByPointer(page, 'builtin:recently-watched');
  const main = page.locator('#view-channels .channel-main');
  const focused = page.locator('#view-channels .focused');

  await page.keyboard.press('PageUp');
  await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  const last = main.locator('[data-list-position="1"]');
  await expect(last).toHaveClass(/\bfocused\b/);
  for (const key of ['ArrowDown', 'PageDown']) {
    await page.keyboard.press(key);
    await expect(last).toHaveClass(/\bfocused\b/);
    await expect(focused).toHaveCount(1);
  }
});

test('Down from the last Favorites row reaches Manage favorites', async ({ page }) => {
  await page.addInitScript((keys) => {
    localStorage.setItem('iptv_favorites', JSON.stringify(keys));
  }, [channelKey('http://host/1.m3u8'), channelKey('http://host/2.m3u8')]);
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await openGroupByPointer(page, 'builtin:favorites');
  const main = page.locator('#view-channels .channel-main');

  await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-list-position="1"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-favorite-manage]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  for (const key of ['ArrowDown', 'PageDown', 'PageUp']) {
    await page.keyboard.press(key);
    await expect(page.locator('[data-favorite-manage]')).toHaveClass(/\bfocused\b/);
  }
  await page.keyboard.press('ArrowUp');
  await expect(main.locator('[data-list-position="1"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
});

test('Down from the last row in edit mode reaches the edit actions', async ({ page }) => {
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await pressKeyCode(page, 405);
  await expect(page.locator('.channel-view.editing .edit-hints')).toBeVisible();
  const main = page.locator('#view-channels .channel-main');

  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-list-position="11"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  const actions = page.locator('#view-channels .edit-hints');
  await expect(actions.locator('.focused')).toHaveCount(1);
  for (let i = 0; i < 6 && !(await actions.locator('[data-epg-action].focused').count()); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(actions.locator('[data-epg-action]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(main.locator('[data-list-position="11"]')).toHaveClass(/\bfocused\b/);
});

test('Favorite management keeps Up, Down, and CH+/CH- inside the list', async ({ page }) => {
  await page.addInitScript((keys) => {
    localStorage.setItem('iptv_favorites', JSON.stringify(keys));
  }, [channelKey('http://host/1.m3u8'), channelKey('http://host/2.m3u8')]);
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await openGroupByPointer(page, 'builtin:favorites');
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-channels .favorite-hints')).toBeVisible();
  await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);

  for (const key of ['ArrowUp', 'PageUp']) {
    await page.keyboard.press(key);
    await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);
  }
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  await expect(main.locator('[data-list-position="1"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  const actions = page.locator('#view-channels .favorite-hints');
  await expect(actions.locator('.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(actions.locator('.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(main.locator('[data-list-position="1"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
});

test('Up from the edit actions skips a remembered row scrolled out of view', async ({ page }) => {
  await routePlaylist(page, manyGroupsPlaylist());
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await pressKeyCode(page, 405);
  await expect(page.locator('.channel-view.editing .edit-hints')).toBeVisible();
  const main = page.locator('#view-channels .channel-main');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-channels .edit-hints .focused')).toHaveCount(1);

  await main.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowUp');
  await expect(main.locator('[data-list-position].focused')).toHaveCount(1);
  await expect(main.locator('[data-list-position="11"]')).not.toHaveClass(/\bfocused\b/);
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
});

test('Up from the edit actions forgets a row left before switching groups', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 32; i++) {
    lines.push(`#EXTINF:-1 group-title="${i <= 11 ? 'A' : 'B'}",Ch ${i}`);
    lines.push(`http://host/${i}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await openGroupByPointer(page, 'source:A');
  await pressKeyCode(page, 405);
  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  const actions = page.locator('#view-channels .edit-hints');
  await expect(actions.locator('.focused')).toHaveCount(1);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-channels .sidebar .focused')).toHaveCount(1);
  await pressKeyCode(page, 405);
  await expect(page.locator('.channel-view.editing')).toHaveCount(0);
  await page.locator('[data-group="source:B"]').click();
  await page.mouse.move(0, 0);
  await focusFirstChannelRow(page);
  await pressKeyCode(page, 405);
  await expect(page.locator('.channel-view.editing .edit-hints')).toBeVisible();
  await actions.locator('[data-edit-action="green"]').click();
  await expect(actions.locator('[data-edit-action="green"]')).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowUp');
  const main = page.locator('#view-channels .channel-main');
  const row = main.locator('[data-list-position].focused');
  await expect(row).toHaveCount(1);
  const footerTop = (await actions.boundingBox())!.y;
  const box = (await row.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(footerTop + 1);
});

// The list moved focus scrolled out of view to a row of `list`.
function repairedIn(events: string[], list: 'channel' | 'group', target: 'nearest' | 'grabbed'): boolean {
  const fields = [
    /(^|\s)event=nav\.focus\.repaired(\s|$)/,
    /(^|\s)reason=detached(\s|$)/,
    /(^|\s)scope=live\.channels(\s|$)/,
    /(^|\s)distance=\d+(\s|$)/,
    new RegExp(`(^|\\s)list=${list}(\\s|$)`),
    new RegExp(`(^|\\s)target=${target}(\\s|$)`),
  ];
  return events.some((text) => fields.every((field) => field.test(text)));
}

function rowInView(row: { y: number; height: number }, view: { y: number; height: number }): boolean {
  return row.y >= view.y - 1 && row.y + row.height <= view.y + view.height + 1;
}

test('Down after the focused group scrolls out of view stays in the group list', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 200; i++) {
    lines.push(`#EXTINF:-1 group-title="Group ${String(i)}",Ch ${String(i)}`, `http://host/${String(i)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  const groups = page.locator('#view-channels .group-list');
  for (let i = 0; i < 4 && (await groups.locator('.focused').count()) === 0; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  const start = groups.locator('.focused');
  await expect(start).toHaveAttribute('data-group-position', /^\d+$/);
  const startPosition = await start.getAttribute('data-group-position');

  await settleVirtualScroll(page);
  await groups.evaluate((el) => { el.scrollTop = 5000; });
  await expect(groups.locator(`[data-group-position="${String(startPosition)}"]`)).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#view-channels .focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-group-position', /^\d+$/);
  const view = await groups.boundingBox();
  const row = await focused.boundingBox();
  if (!view || !row) throw new Error('no layout');
  expect(rowInView(row, view)).toBe(true);
  expect(repairedIn(events, 'group', 'nearest')).toBe(true);
});

// The first OK only brings focus back into view, as it does outside edit mode.
test('OK in edit mode after the focused row scrolls away does not grab the hidden row', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('.edit-hints')).toBeVisible();
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('ArrowDown');
  const hidden = main.locator('[data-list-position="1"]');
  await expect(hidden).toHaveClass(/\bfocused\b/);

  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 3000; });
  await expect(hidden).toHaveCount(0);

  await page.keyboard.press('Enter');
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  const view = await main.boundingBox();
  const row = await focused.boundingBox();
  if (!view || !row) throw new Error('no layout');
  expect(rowInView(row, view)).toBe(true);

  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 0; });
  await expect(hidden).toBeVisible();
  await expect(page.locator('.grabbed')).toHaveCount(0);
});

test('OK in edit mode with a grabbed row scrolled away brings the grabbed row back', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('.edit-hints')).toBeVisible();
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('ArrowDown');
  const grabbed = main.locator('[data-list-position="1"]');
  await expect(grabbed).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(grabbed).toHaveClass(/\bgrabbed\b/);

  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 3000; });
  await expect(grabbed).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(grabbed).toHaveClass(/\bgrabbed\b/);
  await expect(grabbed).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.grabbed')).toHaveCount(1);
  const view = await main.boundingBox();
  const row = await grabbed.boundingBox();
  if (!view || !row) throw new Error('no layout');
  expect(rowInView(row, view)).toBe(true);
  expect(repairedIn(events, 'channel', 'grabbed')).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page.locator('.grabbed')).toHaveCount(0);
});

async function enterEditMode(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('.edit-hints')).toBeVisible();
}

test('a focused row scrolled just out of view, still rendered, is not acted on', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('ArrowDown');
  const hidden = main.locator('[data-list-position="1"]');
  await expect(hidden).toHaveClass(/\bfocused\b/);

  // Within the virtual list's overscan: the row stays in the DOM.
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 500; });
  await expect(hidden).toHaveCount(1);
  const view = await main.boundingBox();
  if (!view) throw new Error('no layout');
  expect(((await hidden.boundingBox())?.y ?? 0) + 88).toBeLessThanOrEqual(view.y);

  await page.keyboard.press('Enter');
  await expect(page.locator('.grabbed')).toHaveCount(0);
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  const row = await focused.boundingBox();
  if (!row) throw new Error('no layout');
  expect(rowInView(row, view)).toBe(true);
  expect(repairedIn(events, 'channel', 'nearest')).toBe(true);

  await page.keyboard.press('Escape');
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 0; });
  await page.keyboard.press('ArrowDown');
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 500; });
  const before = await main.evaluate((el) => el.scrollTop);
  await page.keyboard.press('ArrowDown');
  // The list stays where it was scrolled instead of snapping back.
  expect(Math.abs((await main.evaluate((el) => el.scrollTop)) - before)).toBeLessThan(100);
});

test('OK in edit mode with a grabbed group scrolled away brings the group back', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 200; i++) {
    lines.push(`#EXTINF:-1 group-title="Group ${String(i)}",Ch ${String(i)}`, `http://host/${String(i)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const groups = page.locator('#view-channels .group-list');
  for (let i = 0; i < 4 && (await groups.locator('.focused').count()) === 0; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  for (let i = 0; i < 6 && !(await groups.locator('.focused').getAttribute('data-group') ?? '').startsWith('source:'); i++) {
    await page.keyboard.press('ArrowDown');
  }
  const start = groups.locator('.focused');
  await expect(start).toHaveAttribute('data-group', /^source:/);
  const key = await start.getAttribute('data-key');
  const grabbed = groups.locator(`[data-key="${String(key)}"]`);
  await page.keyboard.press('Enter');
  await expect(grabbed).toHaveClass(/\bgrabbed\b/);

  await settleVirtualScroll(page);
  await groups.evaluate((el) => { el.scrollTop = 5000; });
  await expect(grabbed).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(grabbed).toHaveClass(/\bfocused\b/);
  await expect(groups.locator('.grabbed')).toHaveCount(1);
  await expect(grabbed).toHaveClass(/\bgrabbed\b/);

  // Down only brings it back, like Up; the next Down moves it. Scroll after
  // the virtual list's own scroll settles, as a user would.
  const position = await grabbed.getAttribute('data-group-position');
  await settleVirtualScroll(page);
  await groups.evaluate((el) => { el.scrollTop = 5000; });
  await expect(grabbed).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(grabbed).toHaveClass(/\bfocused\b/);
  await expect(grabbed).toHaveAttribute('data-group-position', String(position));
  await page.keyboard.press('ArrowDown');
  await expect(grabbed).toHaveClass(/\bfocused\b/);
  await expect(grabbed).not.toHaveAttribute('data-group-position', String(position));
  await page.keyboard.press('Enter');
  await expect(page.locator('.grabbed')).toHaveCount(0);
});

test('focus resumed in edit mode is not hidden under the hints bar', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const main = page.locator('#view-channels .channel-main');
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-list-position="40"]')).toHaveClass(/\bfocused\b/);

  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 0; });
  await expect(main.locator('[data-list-position="40"]')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  const row = await focused.boundingBox();
  const hints = await page.locator('.edit-hints').boundingBox();
  if (!row || !hints) throw new Error('no layout');
  expect(row.y + row.height).toBeLessThanOrEqual(hints.y + 1);
});

test('Up on a focused first row just out of view resumes instead of leaving the list', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  const main = page.locator('#view-channels .channel-main');
  const row0 = main.locator('[data-list-position="0"]');
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 500; });
  await expect(row0).toHaveCount(1);

  // Up on row 0 would otherwise hand focus to the tab bar.
  await page.keyboard.press('ArrowUp');
  const focused = page.locator('#view-channels .channel-main .focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-list-position', '0');
  const view = await main.boundingBox();
  const row = await focused.boundingBox();
  if (!view || !row) throw new Error('no layout');
  expect(rowInView(row, view)).toBe(true);
});

test('Green on a focused row just out of view resumes instead of toggling its favorite', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  const main = page.locator('#view-channels .channel-main');
  const favorites = page.locator('#view-channels [data-group="builtin:favorites"]');
  const before = await favorites.textContent();
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 500; });
  await expect(main.locator('[data-list-position="0"]')).toHaveCount(1);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 404, bubbles: true })));
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-list-position', '0');
  expect(await favorites.textContent()).toBe(before);
});

test('OK commits a rename even after the renamed row scrolls out of view', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('Enter');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
  const field = page.locator('.edit-text-input');
  await field.fill('Renamed');
  // Closing the on-screen keyboard leaves the field open but unfocused, so
  // the remote's OK reaches the list.
  await field.evaluate((el) => { (el as HTMLInputElement).blur(); });
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 500; });

  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 0; });
  await expect(main.locator('[data-list-position="0"] .channel-name')).toHaveText('Renamed');
});

test('OK on a rename whose row left the rendered list brings it back with the typed name', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(msg.text()));
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const main = page.locator('#view-channels .channel-main');
  const row0 = main.locator('[data-list-position="0"]');
  await page.keyboard.press('Enter');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
  const field = page.locator('.edit-text-input');
  await field.fill('Renamed');
  await field.evaluate((el) => { (el as HTMLInputElement).blur(); });
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 3000; });
  await expect(row0).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(row0.locator('.edit-text-input')).toHaveValue('Renamed');
  expect(events.some((text) => text.includes('event=channel_edit.rename.restored kind=channel'))).toBe(true);
  await row0.locator('.edit-text-input').evaluate((el) => { (el as HTMLInputElement).blur(); });
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(row0.locator('.channel-name')).toHaveText('Renamed');
});

test('Blue on a grabbed row scrolled out of view opens the rename on that row', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  await enterEditMode(page);
  const main = page.locator('#view-channels .channel-main');
  await page.keyboard.press('ArrowDown');
  const row1 = main.locator('[data-list-position="1"]');
  await expect(row1).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(row1).toHaveClass(/\bgrabbed\b/);
  await settleVirtualScroll(page);
  await main.evaluate((el) => { el.scrollTop = 3000; });
  await expect(row1).toHaveCount(0);

  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
  await expect(row1.locator('.edit-text-input')).toHaveCount(1);
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('after the pointer leaves, the first Down shows the row and the next one moves', async ({ page }) => {
  await routePlaylist(page, longPlaylist(30));
  await seedPlaylist(page);
  await page.goto('/');
  const main = page.locator('#view-channels .channel-main');
  const row = main.locator('[data-list-position="5"]');
  await expect(row).toBeVisible();
  await hoverThenLeave(row);
  await expect(main.locator('.focused')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await expect(row).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(main.locator('[data-list-position="6"]')).toHaveClass(/\bfocused\b/);
});

function stableChannelKey(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Recently Watched renders every row and skips the scroll re-render, so a row
// the pointer left stays hidden, rendered, and out of view.
test('Down after the wheel scrolls a pointer-left row away resumes in view', async ({ page }) => {
  await routePlaylist(page, longPlaylist(30));
  await seedPlaylist(page);
  const now = Date.now();
  await page.addInitScript((entries) => {
    localStorage.setItem('iptv_recently_watched_live', JSON.stringify(entries));
  }, Array.from({ length: 30 }, (_, i) => ({
    channelKey: stableChannelKey(`http://host/${String(i + 1)}.m3u8`),
    updatedAt: now - i * 1000,
  })));
  await page.goto('/');
  await page.locator('[data-group="builtin:recently-watched"]').click();
  const main = page.locator('#view-channels .channel-main');
  await expect(main.locator('.recent-item')).toHaveCount(30);
  const row = main.locator('[data-list-position="5"]');
  const box = await row.boundingBox();
  const list = await main.boundingBox();
  if (!box || !list) throw new Error('no layout');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(row).toHaveClass(/\bfocused\b/);
  // Onto the list's side padding: off the row, still over the list.
  await page.mouse.move(list.x + list.width - 4, box.y + box.height / 2);
  await expect(main.locator('.focused')).toHaveCount(0);

  const offset = box.y + box.height - list.y + 40;
  await main.evaluate((el, top) => { el.scrollTop = top; }, offset);
  await settleVirtualScroll(page);

  await page.keyboard.press('ArrowDown');
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(offset - 1);
  const now2 = await focused.boundingBox();
  if (!now2) throw new Error('no layout');
  expect(rowInView(now2, list)).toBe(true);
});

test('a wheel step below a short list moves the pointer-left row at once', async ({ page }) => {
  await routePlaylist(page, longPlaylist(3));
  await seedPlaylist(page);
  await page.goto('/');
  const main = page.locator('#view-channels .channel-main');
  const row = main.locator('[data-list-position="0"]');
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  const list = await main.boundingBox();
  if (!box || !list) throw new Error('no layout');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(row).toHaveClass(/\bfocused\b/);
  // Onto the empty list area under the rows, which has nothing to scroll.
  await page.mouse.move(box.x + box.width / 2, list.y + list.height - 20);
  await expect(main.locator('.focused')).toHaveCount(0);

  await page.mouse.wheel(0, 120);
  await expect(main.locator('[data-list-position="1"]')).toHaveClass(/\bfocused\b/);
});

test('Down from the tab bar resumes in view after the list scrolled meanwhile', async ({ page }) => {
  await routePlaylist(page, longPlaylist(60));
  await seedPlaylist(page);
  await page.goto('/');
  const main = page.locator('#view-channels .channel-main');
  await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);
  const list = await main.boundingBox();
  if (!list) throw new Error('no layout');

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item[data-section="live"].focused')).toHaveCount(1);
  await main.evaluate((el) => { el.scrollTop = 1500; });
  await settleVirtualScroll(page);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  const box = await focused.boundingBox();
  if (!box) throw new Error('no layout');
  expect(rowInView(box, list)).toBe(true);
});

test('the Live tab clicked from another section shows the far channel that is playing', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 200; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`, `http://host/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await page.keyboard.press('0');
  await expect(page.locator('.osd-channel-number')).toHaveText('150');
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();
  await enterTab(page, 'live');
  await expect(page.locator('#view-channels')).toBeVisible();

  const playing = page.locator('.channel-main .channel-item.playing');
  await expect(playing).toContainText('Channel 150');
  await expect(playing).toHaveClass(/focused/);
  const list = page.locator('.channel-main');
  await expect.poll(async () => {
    const [r, l] = await Promise.all([playing.boundingBox(), list.boundingBox()]);
    return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
  }).toBe(true);
});

test('Back from the Guide resumes the row you left, brought into view', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  const main = page.locator('#view-channels .channel-main');
  const row = main.locator('[data-list-position="6"]');
  await expect(row).toHaveClass(/\bfocused\b/);
  const key = await row.getAttribute('data-key');

  // Scroll the row just above the viewport, where it stays rendered.
  await settleVirtualScroll(page);
  await row.evaluate((el) => {
    const list = el.closest<HTMLElement>('.channel-main')!;
    list.scrollTop = el.offsetTop + el.offsetHeight + 20;
  });
  await settleVirtualScroll(page);
  await expect(row).toHaveCount(1);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', key!);
  await settleVirtualScroll(page);
  await expect.poll(async () => {
    const [r, l] = await Promise.all([focused.boundingBox(), main.boundingBox()]);
    return !!r && !!l && rowInView(r, l);
  }).toBe(true);
});

test('Back from the Guide resumes a group scrolled out of view, brought into view', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 200; i++) {
    lines.push(`#EXTINF:-1 group-title="Group ${String(i)}",Ch ${String(i)}`, `http://host/${String(i)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  const groups = page.locator('#view-channels .group-list');
  for (let i = 0; i < 4 && (await groups.locator('.focused').count()) === 0; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  const start = groups.locator('.focused');
  await expect(start).toHaveAttribute('data-group-position', /^\d+$/);
  const key = await start.getAttribute('data-key');

  await settleVirtualScroll(page);
  await groups.evaluate((el) => { el.scrollTop = 5000; });
  await expect(groups.locator(`[data-key="${String(key)}"]`)).toHaveCount(0);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  const focused = page.locator('#view-channels .focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', key!);
  await settleVirtualScroll(page);
  await expect.poll(async () => {
    const [r, l] = await Promise.all([focused.boundingBox(), groups.boundingBox()]);
    return !!r && !!l && rowInView(r, l);
  }).toBe(true);
});

test('Down from the tab bar resumes the row you left after a preview was stopped and retuned', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_live_preview', 'true'));
  await page.goto('/');
  await focusFirstChannelRow(page);
  const main = page.locator('#view-channels .channel-main');
  const preview = page.locator('#view-channels #live-preview');

  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(preview.locator('.live-preview-channel')).toHaveText('Ch 3');
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 413, bubbles: true })));
  await expect(preview).toBeHidden();
  await expect(main.locator('[data-list-position="2"]')).toHaveClass(/\bfocused\b/);
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(preview.locator('.live-preview-channel')).toHaveText('Ch 5');
  await expect(page.locator('#view-player')).toBeHidden();

  // The list tuned Ch 5 itself, so the row you leave it from is the one to resume.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  await expect(main.locator('[data-list-position="0"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar .focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');

  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute('data-key', 'ch:0');
  await expect(preview.locator('.live-preview-channel')).toHaveText('Ch 5');
});

test('Back from the Guide lands on a channel tuned elsewhere, not the row you left', async ({ page }) => {
  await routePlaylist(page, longPlaylist(300));
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await page.goto('/');
  await focusFirstChannelRow(page);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  const main = page.locator('#view-channels .channel-main');
  await expect(main.locator('[data-list-position="6"]')).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-number')).toHaveText('7');

  // Tune far away from the player, then open the Guide from there.
  await page.keyboard.press('4');
  await page.keyboard.press('0');
  await expect(page.locator('.osd-channel-number')).toHaveText('40');
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-channels')).toBeVisible();

  const focused = main.locator('.focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveClass(/\bplaying\b/);
  await expect(focused).toHaveAttribute('data-key', 'ch:39');
  await settleVirtualScroll(page);
  await expect.poll(async () => {
    const [r, l] = await Promise.all([focused.boundingBox(), main.boundingBox()]);
    return !!r && !!l && rowInView(r, l);
  }).toBe(true);
});

async function hoverCenter(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
}

test('a control hovered while the account menu held the keys lights once it hands them back', async ({ page }) => {
  await seedXtream(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .group-item').first()).toBeVisible();

  await page.locator('.account-avatar').click();
  await hoverCenter(page, '#view-channels .group-item[data-group-position="0"]');
  // Enter goes to the open menu, which closes and leaves the keys with the bar.
  await page.keyboard.press('Enter');
  await hoverCenter(page, '#view-channels .channel-edit-btn');
  await expect(page.locator('#view-channels .channel-edit-btn')).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-channels .channel-edit-btn')).not.toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-channels .focused')).toHaveCount(1);
});
