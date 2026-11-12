import {
  liveLoaded,
  test,
  expect,
  type Page,
  routePlaylist,
  routeLiveManifest,
  seedPlaylist,
  neuterVideo,
  measureRowTextFit,
  enterTab,
  SEARCH_M3U,
  pressStepsAndReadPlayer,
  seedPointer,
} from './helpers';

// The player view: playback start, sidebar, action menu, OSD, and live DVR.

async function gotoGroupedPlayer(page: Page): Promise<void> {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Alpha News');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // Beta News
  await expect(page.locator('#view-player')).toBeVisible();
}

async function pressRemoteBack(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
}

const [ENTER, RIGHT, BACK, YELLOW] = [13, 39, 461, 405];

test('remote arrow keys move focus and Enter starts playback', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');

  await liveLoaded(page);

  // Initial focus is the first channel (search + settings now live in the tab bar).
  const focused = page.locator('.channel-main .channel-item.focused');
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText('Channel One');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Channel Two');

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Channel One');

  // Enter on the focused channel starts playback (switches to the player view).
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
});

test('live playback retries the current channel before switching', async ({ page }) => {
  await neuterVideo(page);
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="advanced"]').click();
  const attempts = page.locator('#live-reconnect-attempts');
  await attempts.locator('.dropdown-trigger').click();
  await attempts.locator('[data-dropdown-value="1"]').click();
  await page.locator('#save-settings').click();
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel One');

  const video = page.locator('#video-player');
  await video.evaluate(el => {
    el.dataset.originalStream = 'true';
    el.dispatchEvent(new Event('error'));
  });
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_last_channel')!).index)).toBe(0);
  await expect(video).not.toHaveAttribute('data-original-stream', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_last_channel')!).index)).toBe(0);
  await video.dispatchEvent('error');
  await expect.poll(() =>
    page.evaluate(() => JSON.parse(localStorage.getItem('iptv_last_channel')!).index)).toBe(1);
});

test('player sidebar focuses the playing channel; search still filters', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);

  // Search box holds initial focus; Arrow Down enters the list, then Enter plays.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toBeVisible();
  const search = page.locator('.sidebar-search-input');
  await expect(search).toBeVisible();
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Beta News');
  await expect(search).not.toHaveClass(/focused/);
  await expect(search).not.toBeFocused();

  // Up from the first channel reaches search; OK gives it the caret.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await search.fill('alpha');
  await expect(sidebar.locator('.sidebar-ch-item')).toHaveCount(2);
});

test('large sidebar decodes visible logos before revealing one per frame', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < 900; index++) {
    lines.push(
      `#EXTINF:-1 tvg-logo="http://host/logo/${String(index)}.png" group-title="Group",Channel ${String(index)}`,
      `http://host/${String(index)}.m3u8`,
    );
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await page.route('http://host/logo/*.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  }));
  await page.addInitScript(() => {
    const pending: Array<() => void> = [];
    class DeferredImage {
      decoding = 'auto';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private value = '';

      set src(value: string) {
        this.value = value;
        Promise.resolve().then(() => this.onload?.());
      }

      get src(): string {
        return this.value;
      }

      decode(): Promise<void> {
        return new Promise(resolve => pending.push(resolve));
      }
    }
    Object.defineProperty(window, 'Image', { configurable: true, value: DeferredImage });
    const controls = window as unknown as {
      pendingSidebarLogoDecodes: () => number;
      resolveSidebarLogoDecodes: () => number;
    };
    controls.pendingSidebarLogoDecodes = () => pending.length;
    controls.resolveSidebarLogoDecodes = () => {
        const ready = pending.splice(0);
        ready.forEach(resolve => resolve());
        return ready.length;
      };
  });
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toBeVisible();
  const pending = sidebar.locator('.ch-logo-wrap[data-logo-src]');
  expect(await pending.count()).toBeGreaterThan(0);
  await expect(sidebar.locator('img.ch-logo:not([src])')).toHaveCount(0);
  await expect(sidebar.locator('.ch-logo-placeholder')).toHaveCount(0);
  expect(await sidebar.locator('.sidebar-ch-item').count()).toBeLessThan(60);
  expect(await sidebar.locator('.sidebar-channel-spacer').evaluate(
    element => parseFloat((element as HTMLElement).style.height),
  )).toBe(900 * 88);

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { pendingSidebarLogoDecodes: () => number })
      .pendingSidebarLogoDecodes())).toBeGreaterThan(1);
  const counts = await page.evaluate(async () => {
    const resolved = (window as unknown as { resolveSidebarLogoDecodes: () => number })
      .resolveSidebarLogoDecodes();
    const shown: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      shown.push(document.querySelectorAll('#player-sidebar img.ch-logo[src]').length);
    }
    return { resolved, shown };
  });
  expect(counts.resolved).toBeGreaterThan(1);
  expect(counts.shown[counts.shown.length - 1]).toBeGreaterThan(1);
  for (let index = 1; index < counts.shown.length; index++) {
    expect(counts.shown[index] - counts.shown[index - 1]).toBeLessThanOrEqual(1);
  }

  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  expect(await sidebar.locator('img.ch-logo[src]').count()).toBeGreaterThan(1);

  await page.keyboard.press('ArrowLeft');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('img.ch-logo[src]')).toHaveCount(0);
  expect(await pending.count()).toBeGreaterThan(0);

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { pendingSidebarLogoDecodes: () => number })
      .pendingSidebarLogoDecodes())).toBeGreaterThan(1);
  const reopened = await page.evaluate(async () => {
    (window as unknown as { resolveSidebarLogoDecodes: () => number })
      .resolveSidebarLogoDecodes();
    const shown: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      shown.push(document.querySelectorAll('#player-sidebar img.ch-logo[src]').length);
    }
    return shown;
  });
  expect(reopened[reopened.length - 1]).toBeGreaterThan(1);
  for (let index = 1; index < reopened.length; index++) {
    expect(reopened[index] - reopened[index - 1]).toBeLessThanOrEqual(1);
  }
});

// The row has a fixed height because the list is virtualized, so its two text
// lines can overflow into the neighbouring row instead of growing the row.
test('player sidebar channel rows fit both text lines in their fixed box', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const fit = await measureRowTextFit(
    page,
    '#player-sidebar .sidebar-ch-item',
    'ch-info',
    'ch-now',
  );
  expect(fit.needed).toBeLessThanOrEqual(fit.available);
});

test('dark player overlay keeps sidebar scrollbar dark on a light theme', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_theme', JSON.stringify('daylight'));
    localStorage.setItem('iptv_overlay_style', JSON.stringify('dark'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const list = page.locator('#player-sidebar .sidebar-channel-list');
  await expect(list).toBeVisible();
  const colors = await list.evaluate((element) => ({
    track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
    thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
  }));
  expect(colors.track).toBe('rgb(18, 18, 26)');
  expect(colors.thumb).toBe('rgb(102, 102, 128)');
});

test('player sidebar expands groups and retains a selected group after tuning', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Alpha News');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // Beta News
  await expect(page.locator('#view-player')).toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await expect(sidebar.locator('.sidebar-group-panel')).toBeVisible();
  await expect(sidebar.locator('.sidebar-group-item.focused')).toContainText('All');
  const groupLayout = await sidebar.locator('.sidebar-group-panel').evaluate((panel) => {
    const recent = panel.querySelector<HTMLElement>(
      '[data-group-id="builtin:recently-watched"] .sidebar-group-name',
    )!;
    return {
      width: panel.getBoundingClientRect().width,
      recentWidth: recent.clientWidth,
      recentScrollWidth: recent.scrollWidth,
    };
  });
  expect(groupLayout.width).toBeGreaterThan(280);
  expect(groupLayout.width).toBeLessThanOrEqual(440);
  expect(groupLayout.recentScrollWidth).toBeLessThanOrEqual(groupLayout.recentWidth);

  await page.keyboard.press('ArrowDown'); // Favorites
  await page.keyboard.press('ArrowDown'); // Recently Watched
  await page.keyboard.press('ArrowDown'); // News
  await page.keyboard.press('Enter');
  await expect(sidebar.locator('.sidebar-ch-item')).toHaveCount(2);
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('News');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter'); // Alpha News
  await expect(sidebar).not.toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('News');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Alpha News');
});

test('player sidebar collapses the group panel before closing', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(sidebar).toHaveClass(/groups-expanded/);

  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).not.toHaveClass(/groups-expanded/);
  await expect(sidebar).toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await pressRemoteBack(page);
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).toBeVisible();

  await pressRemoteBack(page);
  await expect(sidebar).not.toBeVisible();
});

test('player sidebar falls back to All after playback leaves the retained group', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown'); // Favorites
  await page.keyboard.press('ArrowDown'); // Recently Watched
  await page.keyboard.press('ArrowDown'); // News
  await page.keyboard.press('Enter');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('News');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Beta News');
  await page.keyboard.press('Enter'); // Tune Beta News and close.
  await expect(page.locator('.osd-channel-name')).toHaveText('Beta News');

  // A direct channel number is always a deliberate global jump, regardless
  // of the channel-cycle-mode setting — the reliable way to leave News here.
  await page.keyboard.press('3'); // Tune Alpha Movies outside News.
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha Movies');
  await page.keyboard.press('ArrowLeft');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('All');
  await expect(sidebar.locator('.sidebar-ch-item')).toHaveCount(4);
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Alpha Movies');
});

test('channel_up/channel_down stay within the group a channel was tuned from, when Active is on', async ({ page }) => {
  // Scoping is opt-in (settings.channelCycleMode), defaulting to Global.
  await page.addInitScript(() => {
    localStorage.setItem('iptv_channel_cycle_mode', JSON.stringify('active'));
  });
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown'); // Favorites
  await page.keyboard.press('ArrowDown'); // Recently Watched
  await page.keyboard.press('ArrowDown'); // News
  await page.keyboard.press('Enter');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('News');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Beta News');
  await page.keyboard.press('Enter'); // Tune Beta News (scoped to News) and close.
  await expect(page.locator('.osd-channel-name')).toHaveText('Beta News');

  // News has only Alpha News and Beta News — channel_up must wrap within
  // that pair, not spill into Alpha Movies/Delta Sports from other groups.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha News');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.osd-channel-name')).toHaveText('Beta News');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha News');
});

test('channel_up/channel_down cycle the full list by default, even when tuned from a group', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown'); // Favorites
  await page.keyboard.press('ArrowDown'); // Recently Watched
  await page.keyboard.press('ArrowDown'); // News
  await page.keyboard.press('Enter');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Beta News');
  await page.keyboard.press('Enter'); // Tune Beta News (default: Global) and close.
  await expect(page.locator('.osd-channel-name')).toHaveText('Beta News');

  // settings.channelCycleMode defaults to Global — existing users see no
  // change: channel_up steps to the next channel in the full list (Alpha
  // Movies), spilling past News, same as before PR58.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha Movies');
});

test('Magic Remote pointer opens groups and filters the channel panel', async ({ page }) => {
  await gotoGroupedPlayer(page);
  await page.keyboard.press('ArrowLeft');
  const sidebar = page.locator('#player-sidebar');

  await sidebar.locator('[data-open-groups]').click();
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await sidebar.locator('.sidebar-group-item').filter({ hasText: 'Sports' }).click();

  await expect(sidebar).toHaveClass(/groups-expanded/);
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('Sports');
  await expect(sidebar.locator('.sidebar-ch-item')).toHaveCount(1);
  await expect(sidebar.locator('.sidebar-ch-item')).toContainText('Delta Sports');
});

async function gotoLongSidebar(page: Page): Promise<void> {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < 40; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`, `http://host/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // The pointer rests over the video before the keys take over.
  await page.mouse.move(1500, 900);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar .sidebar-ch-item.focused')).toHaveCount(1);
  // Aim only once the panel has slid in.
  const left = () => page.locator('#player-sidebar').evaluate(element => element.getBoundingClientRect().left);
  let last = NaN;
  await expect.poll(async () => {
    const now = await left();
    const settled = now === last;
    last = now;
    return settled;
  }, { intervals: [100] }).toBe(true);
}

test('the first pointer move after a key lights a half-hidden row without scrolling', async ({ page }) => {
  await gotoLongSidebar(page);
  const list = page.locator('#player-sidebar .sidebar-channel-list');
  const target = await list.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>('.sidebar-ch-item')).find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.top < box.bottom - 8 && rect.bottom > box.bottom + 8;
    });
    if (!row) throw new Error('No half-hidden row');
    const rect = row.getBoundingClientRect();
    return { key: row.dataset.key!, x: rect.left + rect.width / 2, y: (rect.top + box.bottom) / 2, top: element.scrollTop };
  });

  await page.mouse.move(target.x, target.y);
  await expect(list.locator(`[data-key="${target.key}"]`)).toHaveClass(/focused/);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  expect(await list.evaluate(element => element.scrollTop)).toBe(target.top);
});

test('the first pointer move after a key that leaves the sidebar hides its ring', async ({ page }) => {
  await gotoLongSidebar(page);
  const sidebar = page.locator('#player-sidebar');
  const row = sidebar.locator('.sidebar-ch-item').nth(2);
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(row).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(sidebar.locator('.sidebar-ch-item').nth(3)).toHaveClass(/focused/);

  // Just past its edge, inside the margin that keeps it open.
  const panel = (await sidebar.boundingBox())!;
  await page.mouse.move(panel.x + panel.width + 4, 540);
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('.focused')).toHaveCount(0);
});

test('Magic Remote dwell expands groups and stages pointer dismissal', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await seedPointer(page);
  await page.mouse.move(30, 540);
  await expect(sidebar).toHaveClass(/groups-expanded/);

  await page.mouse.move(800, 540);
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('.focused')).toHaveCount(0);
  await page.mouse.move(300, 540);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 550)));
  await expect(sidebar).toBeVisible();

  await page.mouse.move(30, 540);
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await page.mouse.move(800, 540);
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).not.toBeVisible();
});

test('the group panel lights the group it slides in under a pointer moved mid-slide', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');
  const groups = sidebar.locator('.sidebar-group-panel');
  const target = sidebar.locator('.sidebar-group-item').nth(3);
  await seedPointer(page);
  await page.mouse.move(30, 540);
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await panelSettled(sidebar);
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(800, 540);
  await expect(sidebar).toHaveClass(/channels-only/);
  await page.mouse.move(300, 540);
  await panelSettled(sidebar);
  // A slow slide leaves time to move while the channels still lie under the pointer.
  await sidebar.evaluate((el) => { el.style.transition = 'transform 4s linear'; });

  await page.mouse.move(30, y);
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await expect.poll(() => groups.evaluate(el => el.getBoundingClientRect().right), { intervals: [20] })
    .toBeGreaterThan(0);
  expect(await groups.evaluate(el => el.getBoundingClientRect().right)).toBeLessThan(x - 40);
  await page.mouse.move(x, y);
  await expect(target).not.toHaveClass(/focused/);
  // webOS fires no mouseover once the panel stops under the resting pointer.
  await noHoverWithoutMove(page);
  await panelSettled(sidebar);
  await expect(target).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the right-edge player menu opens and lists its color actions', async ({ page }) => {
  // Smoke-exercises player-menu.ts at runtime (it has no other e2e coverage).
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter the list and start playback, then ArrowRight opens the action menu.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowRight');

  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu-item')).toHaveCount(4);
  await expect(menu).toContainText('Program Guide');
  await expect(menu).toContainText('Settings');

  // The first item is focused on open; Down moves focus to the second.
  const focused = menu.locator('.menu-item.focused');
  await expect(focused).toHaveCount(1);
  const gutter = await focused.evaluate((element) => {
    const list = element.parentElement;
    if (!list) throw new Error('Player menu item has no list');
    const listRect = list.getBoundingClientRect();
    const itemRect = element.getBoundingClientRect();
    return {
      left: itemRect.left - listRect.left,
      right: listRect.right - itemRect.right,
      top: itemRect.top - listRect.top,
    };
  });
  expect(gutter.left).toBeGreaterThanOrEqual(20);
  expect(gutter.right).toBeGreaterThanOrEqual(20);
  expect(gutter.top).toBeGreaterThanOrEqual(20);
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('.menu-item').nth(1)).toHaveClass(/focused/);
});

async function gotoLivePlayer(page: Page): Promise<void> {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
}

async function moveOnto(page: Page, row: ReturnType<Page['locator']>, dx = 0): Promise<void> {
  const box = await row.boundingBox();
  if (!box) throw new Error('row has no bounding box');
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2);
}

// Chromium 53 fires no pointer events: the edge panels must open from mousemove.
test('the pointer at the right edge opens the live player menu', async ({ page }) => {
  await gotoLivePlayer(page);
  await seedPointer(page);
  await page.mouse.move(1900, 300);
  await expect(page.locator('#player-menu')).toHaveClass(/visible/);
});

test('the pointer at the left edge opens the live channel sidebar', async ({ page }) => {
  await gotoLivePlayer(page);
  await seedPointer(page);
  await page.mouse.move(20, 300);
  await expect(page.locator('#player-sidebar')).toHaveClass(/visible/);
});

test('the player menu reopens with one ring, on its first row', async ({ page }) => {
  await gotoLivePlayer(page);
  const menu = page.locator('#player-menu');
  const rows = menu.locator('.menu-item');
  await page.keyboard.press('ArrowRight');
  await expect(menu).toHaveClass(/visible/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await pressRemoteBack(page);
  await expect(menu).not.toHaveClass(/visible/);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'view.player');

  await page.keyboard.press('ArrowRight');
  await expect(menu).toHaveClass(/visible/);
  await expect(page.locator('[data-ring-owner]')).toHaveAttribute('data-focus-scope', 'player.menu');
  await expect(rows.nth(0)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the player menu ring follows the pointer and the D-pad, and returns to the row it rests on', async ({ page }) => {
  await gotoLivePlayer(page);
  await seedPointer(page);
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  const rows = menu.locator('.menu-item');
  await expect(menu).toHaveClass(/visible/);
  // Let the panel finish sliding in before aiming at a row.
  await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBe(1920);

  await moveOnto(page, rows.nth(1));
  await expect(rows.nth(1)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
  // A small move that stays on the same row takes the ring back to it.
  await moveOnto(page, rows.nth(1), 2);
  await expect(rows.nth(1)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

// webOS fires no mouseover as a panel slides in under a resting cursor;
// desktop Chromium sends one late, from its own hover update.
async function noHoverWithoutMove(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.addEventListener('mouseover', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);
  });
}

async function panelSettled(panel: ReturnType<Page['locator']>): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const now = await panel.evaluate((el) => JSON.stringify(el.getBoundingClientRect()));
    const still = now === last;
    last = now;
    return still;
  }, { intervals: [100] }).toBe(true);
}

test('the player menu lights the row it slides out under', async ({ page }) => {
  await gotoLivePlayer(page);
  const menu = page.locator('#player-menu');
  const rows = menu.locator('.menu-item');
  await page.mouse.move(960, 300);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBe(1920);
  const box = await rows.nth(2).boundingBox();
  if (!box) throw new Error('row has no bounding box');
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveClass(/visible/);
  // Let it finish sliding out, or the pointer lands on a row still on screen.
  await expect.poll(() => menu.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width === 0 || rect.left >= 1920;
  })).toBe(true);

  // From the D-pad, the pointer stops at the edge and the panel slides in beneath it.
  await noHoverWithoutMove(page);
  await page.mouse.move(1860, box.y + box.height / 2);
  await expect(menu).toHaveClass(/visible/);
  await expect(rows.nth(2)).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the channel panel lights the channel it slides out under', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 0; index < 200; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`, `http://host/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  const sidebar = page.locator('#player-sidebar');
  const target = sidebar.locator('.sidebar-ch-item[data-sidebar-index="3"]');
  await page.mouse.move(960, 300);
  await page.keyboard.press('ArrowLeft');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Channel 0');
  await panelSettled(sidebar);
  const box = await target.boundingBox();
  if (!box) throw new Error('row has no bounding box');
  await page.keyboard.press('Escape');
  await expect(sidebar).not.toBeVisible();

  // From the D-pad, the pointer stops at the edge and the panel slides in beneath it.
  await noHoverWithoutMove(page);
  // Inside the 80 px open edge, but past the 48 px dwell that opens the groups.
  await page.mouse.move(64, box.y + box.height / 2);
  await expect(sidebar).toBeVisible();
  await expect(target).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
  // Resting there neither opens the groups nor takes the ring away.
  await page.waitForTimeout(1000);
  await expect(sidebar).not.toHaveClass(/groups-expanded/);
  await expect(target).toHaveClass(/focused/);
});

test('the channel panel keeps one ring while its search box has the caret', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');
  const search = page.locator('.sidebar-search-input');
  await page.keyboard.press('ArrowLeft');
  await panelSettled(sidebar);
  // A pointer that never moved can't tell itself from the D-pad; seed it first.
  await moveOnto(page, sidebar.locator('.sidebar-ch-item').first());
  await search.click();
  await expect(search).toBeFocused();
  // The box under the pointer that clicked it is lit.
  await page.waitForTimeout(100);
  await expect(search).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);

  // Another hovered row is only tracked: the box goes dark and nothing lights.
  await moveOnto(page, sidebar.locator('.sidebar-ch-item').filter({ hasText: 'Alpha News' }));
  await page.waitForTimeout(100);
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toHaveCount(0);
  await expect(page.locator('.focused')).toHaveCount(0);
  // Down leaves the box for the first channel, not the hovered row.
  await page.keyboard.press('ArrowDown');
  await expect(search).not.toBeFocused();
  await expect(sidebar.locator('.sidebar-ch-item').first()).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the channel panel search box lights when clicked under a still pointer after OK gave it the caret', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');
  const search = page.locator('.sidebar-search-input');
  await page.keyboard.press('ArrowLeft');
  // Under load the slide may not have started when the panel first holds still.
  await expect(search).toBeInViewport({ ratio: 1 });
  await panelSettled(sidebar);
  // A pointer that never moved can't tell itself from the D-pad; seed it first.
  await moveOnto(page, sidebar.locator('.sidebar-ch-item').first());
  await moveOnto(page, search);
  await expect(search).toHaveClass(/focused/);
  // OK gives the box the caret from the keys; its ring stays concealed.
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await expect(page.locator('.focused')).toHaveCount(0);
  // A click without a move fires no focusin, yet lights the box.
  await page.mouse.down();
  await page.mouse.up();
  await expect(search).toBeFocused();
  await expect(search).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(search).not.toBeFocused();
  await expect(sidebar.locator('.sidebar-ch-item').first()).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the live subtitle sync adjuster keeps the channel panel shut at the screen edge', async ({ page }) => {
  // The webOS native path self-renders a manifest subtitle, which is what makes
  // Subtitle Sync available on a live channel.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Web0S Chrome/53.0' });
    // Native Chromium cannot decode the synthetic stream; keep it from zapping.
    document.addEventListener('error', (event) => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  });
  await routePlaylist(page);
  await routeLiveManifest(page);
  await page.route('**/one.m3u8', (route) => route.fulfill({
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 1",LANGUAGE="l1",URI="http://host/s1.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,SUBTITLES="s"',
      'http://host/v.m3u8',
    ].join('\n'),
  }));
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  const menu = page.locator('#player-menu');
  const sidebar = page.locator('#player-sidebar');
  await seedPointer(page);
  await page.mouse.move(1900, 540);
  await expect(menu).toHaveClass(/visible/);
  await expect.poll(() => menu.evaluate((el) => el.getBoundingClientRect().right)).toBe(1920);
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_track__"][data-track-index="0"]').click();
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await menu.locator('[data-menu-action="__subs_offset__"]').click();
  await expect(page.locator('#subtitle-offset:not(.hidden)')).toBeVisible();
  const owner = page.locator('[data-ring-owner]');
  await expect(owner).toHaveAttribute('data-focus-scope', 'player.subtitle_offset');

  await page.mouse.move(400, 540);
  await page.mouse.move(10, 540);
  // Past the slide-in, read once: a retrying check would also pass once the
  // panel closes on its own.
  await page.waitForTimeout(400);
  expect(await sidebar.isVisible()).toBe(false);
  await expect(owner).toHaveAttribute('data-focus-scope', 'player.subtitle_offset');
});

test('the OSD band keeps its edge controls ahead of pointer-triggered panels', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');

  const osd = page.locator('#player-osd');
  await expect(osd).toBeVisible();
  const box = await osd.boundingBox();
  if (!box) throw new Error('player OSD has no bounding box');

  await page.mouse.move(2, box.y + box.height / 2);
  await expect(page.locator('#player-sidebar')).not.toBeVisible();

  await page.mouse.move(1918, 1078);
  await expect(page.locator('#player-menu')).not.toBeVisible();
});

test('pointer-opened player panels do not reveal or hide the OSD', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');

  const osd = page.locator('#player-osd');
  await expect(osd).toBeVisible();
  await page.mouse.move(1890, 1000);
  await page.keyboard.press('Enter');
  await expect(osd).not.toBeVisible();

  await page.mouse.move(1891, 1000);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(osd).not.toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(menu).toBeVisible();
  await expect(osd).toBeVisible();
  await page.keyboard.press('ArrowRight');

  await page.mouse.move(30, 1000);
  await page.keyboard.press('Enter');
  await expect(osd).not.toBeVisible();
  await page.mouse.move(29, 1000);
  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(osd).not.toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(sidebar).toBeVisible();
  await expect(osd).toBeVisible();
});

test('keeps pseudo-localized player menu labels within the panel', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');

  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const search = page.locator('.sidebar-search-input');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('placeholder', /^\[!! /);
  await expect(search).toHaveCSS('text-overflow', 'ellipsis');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu-item')).toHaveCount(4);
  await expect(menu.locator('.menu-item').first()).toContainText('[!!');
  const menuWidth = await menu.evaluate(element => element.getBoundingClientRect().width);
  expect(menuWidth).toBeGreaterThan(340);
  expect(menuWidth).toBeLessThanOrEqual(440);
  const overflow = await menu.locator('.menu-header h2, .menu-subtitle, .menu-item')
    .evaluateAll((elements) => elements
      .filter((element) => element.scrollWidth > element.clientWidth + 1
        || element.scrollHeight > element.clientHeight + 1)
      .map((element) => element.textContent?.trim() ?? ''));
  expect(overflow).toEqual([]);
});

test('a long player-menu list scrolls with the Magic-Remote wheel, not the channel', async ({ page }) => {
  // The subtitle/audio submenus share `.menu-items`; with many tracks the list must
  // scroll (overflow-y:auto) and the wheel handler must let it scroll natively instead
  // of zapping the channel. A fake stream can't supply many tracks, so we stub a long
  // list into the same container and drive a real wheel over it.
  await routePlaylist(page);
  // Minimal live manifest so hls.js doesn't fatal → no auto-zap to the next channel.
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-number')).toHaveText('1');

  await page.keyboard.press('ArrowRight');
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();

  // Stub a long list (clone the first row 30×) so the container overflows.
  const list = menu.locator('.menu-items');
  await list.evaluate((el) => {
    const row = el.querySelector('.menu-item');
    for (let i = 0; i < 30 && row; i++) el.appendChild(row.cloneNode(true));
  });

  // It's a scroll container that now overflows.
  expect(await list.evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);

  // A real Magic-Remote-style wheel over the list scrolls it natively...
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  // ...and the channel did NOT change: native scroll means the wheel handler returned
  // before its preventDefault/channel-zap branch (key-handler.ts hasScrollableAncestor).
  await expect(page.locator('.osd-channel-number')).toHaveText('1');
});

test('starting playback shows the OSD with channel info; the yellow key re-opens it', async ({ page }) => {
  // Smoke-exercises the player OSD render path (player.ts renderOSD) at runtime.
  await routePlaylist(page);
  // Serve a minimal segment-less *live* manifest so hls.js reaches MANIFEST_PARSED
  // and just polls for live segments — no fatal error. Otherwise the unreachable
  // stream fatals, onError swaps the OSD to the error message, and the channel-info
  // assertions below fail.
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();

  // play() auto-shows the OSD; with no EPG it still renders the channel header.
  const osd = page.locator('#player-osd');
  await expect(osd).toBeVisible();
  await expect(osd.locator('.osd-channel-name')).toHaveText('Channel One');
  await expect(osd.locator('.osd-channel-number')).toHaveText('1');

  // The yellow remote key (Channel Info) re-renders/re-shows the OSD.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(osd).toBeVisible();
  await expect(osd.locator('.osd-channel-name')).toHaveText('Channel One');
});

test.describe('DVR', () => {
  // Live DVR pointer controls activate on click — a regression guard for the
  // on-device bug where the pause / Go-to-Live controls did nothing.

  /**
   * Real live playback with a DVR window can't be relied on in headless Chromium,
   * so turn the actual <video> into a controllable live-DVR stand-in in the page
   * (Infinity duration + a seekable window + a paused flag), then re-render the OSD
   * so its DVR bar and controls appear. The real player code drives everything.
   */
  async function fakeLiveDvrOsd(page: Page): Promise<void> {
    await page.evaluate(() => {
      const v = document.getElementById('video-player') as HTMLVideoElement;
      let paused = false;
      let ct = 0;
      Object.defineProperty(v, 'duration', { configurable: true, get: () => Infinity });
      Object.defineProperty(v, 'currentTime', { configurable: true, get: () => ct, set: (t: number) => { ct = t; } });
      Object.defineProperty(v, 'seekable', {
        configurable: true,
        get: () => ({ length: 1, start: () => 0, end: () => 60 }),
      });
      Object.defineProperty(v, 'paused', { configurable: true, get: () => paused });
      (v as unknown as { play: () => Promise<void> }).play = () => { paused = false; return Promise.resolve(); };
      (v as unknown as { pause: () => void }).pause = () => { paused = true; };
      // Yellow (Channel Info) re-shows/re-renders the OSD; the DVR bar now appears.
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true }));
    });
  }

  /** Fire a pointer click at a control's center and read the video state back in
   *  the SAME synchronous browser task, so the fake stream's retry churn (which
   *  calls video.play()) can't intervene between the action and the assertion.
   *  Re-shows the OSD first (it auto-hides). */
  async function okAndReadVideo(page: Page, selector: string): Promise<{ paused: boolean; currentTime: number }> {
    return page.evaluate((sel) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })); // yellow → showOSD (sync render)
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no control ${sel}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }));
      const v = document.getElementById('video-player') as HTMLVideoElement;
      return { paused: v.paused, currentTime: v.currentTime };
    }, selector);
  }

  async function gotoDvrPlayer(page: Page): Promise<void> {
    await routePlaylist(page);
    await routeLiveManifest(page);
    await seedPlaylist(page);
    await page.goto('/');
    await liveLoaded(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#view-player')).toBeVisible();
    await fakeLiveDvrOsd(page);
  }

  test('pause control pauses on a Magic-Remote pointer click', async ({ page }) => {
    await gotoDvrPlayer(page);
    await expect(page.locator('[data-playpause]')).toBeVisible();

    const state = await okAndReadVideo(page, '[data-playpause]');

    expect(state.paused).toBe(true);
  });

  test('Go-to-Live control seeks to the live edge on a pointer release', async ({ page }) => {
    await gotoDvrPlayer(page);
    // Rewind inside the oldest edge, then jump to live by pointer; read seek back
    // in the same task that dispatches it (window 0–60, both pads 3).
    const rewound = await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 412, bubbles: true }));
      return (document.getElementById('video-player') as HTMLVideoElement).currentTime;
    });
    expect(rewound).toBe(3);

    const state = await okAndReadVideo(page, '[data-golive]');

    expect(state.currentTime).toBe(57);
  });

  test('Back leaves a playing DVR stream even with the OSD up', async ({ page }) => {
    await gotoDvrPlayer(page);
    const [shown, left] = await pressStepsAndReadPlayer(page, [[YELLOW], [BACK]]);
    expect(shown).toMatchObject({ osd: true, paused: false });
    expect(left).toMatchObject({ osdBefore: true, player: false });
    await liveLoaded(page);
  });

  test('Back hides a paused DVR OSD, so Right reaches the menu, then leaves', async ({ page }) => {
    await gotoDvrPlayer(page);
    const [paused, hidden, menu, closed, left] = await pressStepsAndReadPlayer(page, [
      [YELLOW, ENTER], [BACK], [RIGHT], [BACK], [BACK],
    ]);
    expect(paused).toMatchObject({ osd: true, message: false, paused: true });
    expect(hidden).toMatchObject({ osdBefore: true, osd: false, player: true, paused: true });
    expect(menu).toMatchObject({ osd: false, menu: true, paused: true, currentTime: paused.currentTime });
    expect(closed).toMatchObject({ menu: false, player: true });
    expect(left.player).toBe(false);
    await liveLoaded(page);
  });
});

// Direct channel entry from the player view (issue #40): the digits are
// buffered by KeyHandler and delivered as a single `number` action.
// The `[Key]`/`[App]` console lines are what `scripts/tv.sh diag` prints in
// its input timeline, so these tests assert the emitted text too.
function captureKeyLogs(page: Page): () => string[] {
  const lines: string[] = [];
  page.on('console', (message) => lines.push(message.text()));
  return () => lines.filter((line) => line.includes('event=key.'));
}

async function playFirstChannel(page: Page, body: string): Promise<void> {
  await routePlaylist(page, body);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-number')).toHaveText('1');
}

test('a number key tunes that channel directly from the player view', async ({ page }) => {
  await playFirstChannel(page, SEARCH_M3U);

  await page.keyboard.press('3');

  await expect(page.locator('.osd-channel-number')).toHaveText('3');
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha Movies');
});

test('consecutive digits tune the multi-digit channel number', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 12; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`,
      `http://streams.example.com/${String(index)}.m3u8`);
  }
  await playFirstChannel(page, lines.join('\n'));

  await page.keyboard.press('1');
  await page.keyboard.press('2');

  await expect(page.locator('.osd-channel-number')).toHaveText('12');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel 12');
});

test('a channel number past the end of the list keeps the current channel', async ({ page }) => {
  const keyLogs = captureKeyLogs(page);
  await playFirstChannel(page, SEARCH_M3U);

  await page.keyboard.press('9');

  // Wait for the rejection itself, so this can't pass by asserting before the
  // digit-buffer timeout has even fired.
  await expect.poll(() => keyLogs().some((line) => line.includes('event=key.number.rejected')))
    .toBe(true);
  await expect(page.locator('.osd-channel-number')).toHaveText('1');
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha News');
});

// The whole point of the key logging is that `scripts/tv.sh diag` can report a
// dead button, so assert the fields its input timeline reads.
test('direct channel entry lands in the tv-diag input timeline', async ({ page }) => {
  const keyLogs = captureKeyLogs(page);
  await playFirstChannel(page, SEARCH_M3U);

  await page.keyboard.press('3');
  await expect(page.locator('.osd-channel-number')).toHaveText('3');

  const text = keyLogs().join('\n');
  expect(text).toContain('event=key.down code=51 action=number');
  expect(text).toContain('event=key.number number=3');
  expect(text).toContain(
    'event=key.action action=number view=player owner=view.player number=3',
  );
  expect(text).toContain('event=key.number.accepted number=3 index=2');
});

test('an unmapped remote code is reported instead of vanishing', async ({ page }) => {
  const keyLogs = captureKeyLogs(page);
  await playFirstChannel(page, SEARCH_M3U);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 1234, bubbles: true })));

  await expect.poll(() => keyLogs().join('\n'))
    .toContain('event=key.down code=1234 action=unmapped');
});

test('typing digits echoes them on screen until they tune', async ({ page }) => {
  await playFirstChannel(page, SEARCH_M3U);
  const indicator = page.locator('.number-entry');
  const digits = page.locator('.number-entry-digits');
  await expect(indicator).toHaveCount(0);

  await page.keyboard.press('3');
  // `.visible` drives opacity, and an opacity-0 node still counts as visible
  // to Playwright — so assert the state class, not toBeVisible().
  await expect(indicator).toHaveClass(/visible/);
  await expect(digits).toHaveText('3');

  // The indicator clears when the buffered digits finally tune.
  await expect(page.locator('.osd-channel-number')).toHaveText('3');
  await expect(indicator).not.toHaveClass(/visible/);
});

test('the digit echo grows with each key of a multi-digit number', async ({ page }) => {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 12; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`,
      `http://streams.example.com/${String(index)}.m3u8`);
  }
  await playFirstChannel(page, lines.join('\n'));
  const indicator = page.locator('.number-entry');
  const digits = page.locator('.number-entry-digits');

  await page.keyboard.press('1');
  await expect(digits).toHaveText('1');
  await page.keyboard.press('2');
  await expect(digits).toHaveText('12');

  await expect(page.locator('.osd-channel-number')).toHaveText('12');
  await expect(indicator).not.toHaveClass(/visible/);
});

// A "dead button" report is only answerable if every press is in the log —
// including the ones a focused component swallows before they can bubble.
test('every key press is logged, not just the digits', async ({ page }) => {
  const keyLogs = captureKeyLogs(page);
  await playFirstChannel(page, SEARCH_M3U);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // A code this remote map has no entry for — the "dead button" case.
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 457, bubbles: true })));

  await expect.poll(() => keyLogs()).toEqual(expect.arrayContaining([
    expect.stringContaining('event=key.down code=40 action=down target=app'),
    expect.stringContaining('event=key.down code=13 action=select target=app'),
    expect.stringContaining('event=key.down code=457 action=unmapped target=app'),
  ]));
});

test('a press swallowed by the search box is still logged, without its code',
  async ({ page }) => {
    const keyLogs = captureKeyLogs(page);
    await playFirstChannel(page, SEARCH_M3U);

    await pressRemoteBack(page);
    await liveLoaded(page);
    await enterTab(page, 'search');
    await page.locator('.tab-bar-search-input').press('7');

    // The digit reaches the query, so its code must stay out of the report.
    await expect.poll(() => keyLogs().filter((line) => line.includes('target=text_input')))
      .toEqual([expect.stringContaining('event=key.down code=hidden')]);
  });

async function playFarChannel(page: Page): Promise<void> {
  const lines = ['#EXTM3U'];
  for (let index = 1; index <= 200; index++) {
    lines.push(`#EXTINF:-1 group-title="Group",Channel ${String(index)}`, `http://host/${String(index)}.m3u8`);
  }
  await routePlaylist(page, lines.join('\n'));
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('1');
  await page.keyboard.press('5');
  await page.keyboard.press('0');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel 150');
}

async function expectInList(row: ReturnType<Page['locator']>, list: ReturnType<Page['locator']>): Promise<void> {
  await expect.poll(async () => {
    const [r, l] = await Promise.all([row.boundingBox(), list.boundingBox()]);
    return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
  }).toBe(true);
}

test('the channel panel opened by key shows the far channel that is playing', async ({ page }) => {
  await playFarChannel(page);
  await page.keyboard.press('ArrowLeft');
  const sidebar = page.locator('#player-sidebar');
  await panelSettled(sidebar);
  const playing = sidebar.locator('.sidebar-ch-item.playing');
  await expect(playing).toContainText('Channel 150');
  await expect(playing).toHaveClass(/focused/);
  await expectInList(playing, sidebar.locator('.sidebar-channel-list'));
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the channel panel opened by pointer shows the far channel that is playing', async ({ page }) => {
  await playFarChannel(page);
  const sidebar = page.locator('#player-sidebar');
  await noHoverWithoutMove(page);
  await page.mouse.move(960, 540);
  await page.mouse.move(30, 540);
  await expect(sidebar).toBeVisible();
  await panelSettled(sidebar);
  const playing = sidebar.locator('.sidebar-ch-item.playing');
  await expect(playing).toContainText('Channel 150');
  await expectInList(playing, sidebar.locator('.sidebar-channel-list'));
  // The ring follows the resting pointer, which sits over a row of this window.
  await expect(page.locator('.focused')).toHaveCount(1);
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toHaveCount(1);
});
