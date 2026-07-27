import {
  test,
  expect,
  type Page,
  routePlaylist,
  routeLiveManifest,
  seedPlaylist,
  neuterVideo,
  SEARCH_M3U,
} from './helpers';

// The player view: playback start, sidebar, action menu, OSD, and live DVR.

async function gotoGroupedPlayer(page: Page): Promise<void> {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Alpha News');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // Beta News
  await expect(page.locator('#view-player')).toBeVisible();
}

async function pressRemoteBack(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
}

test('remote arrow keys move focus and Enter starts playback', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');

  await expect(page.locator('#view-channels')).toBeVisible();

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

test('player sidebar focuses the playing channel; search still filters', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  // Search box holds initial focus; Arrow Down enters the list, then Enter plays.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');

  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toBeVisible();
  const search = page.locator('.sidebar-search-input');
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

test('player sidebar expands groups and retains a selected group after tuning', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
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

  await page.keyboard.press('ArrowDown'); // Favorites
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
  await page.keyboard.press('ArrowDown'); // News
  await page.keyboard.press('Enter');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('News');
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Beta News');
  await page.keyboard.press('Enter'); // Tune Beta News and close.
  await expect(page.locator('.osd-channel-name')).toHaveText('Beta News');

  await page.keyboard.press('ArrowUp'); // Tune Alpha Movies outside News.
  await expect(page.locator('.osd-channel-name')).toHaveText('Alpha Movies');
  await page.keyboard.press('ArrowLeft');
  await expect(sidebar.locator('.sidebar-channel-title')).toHaveText('All');
  await expect(sidebar.locator('.sidebar-ch-item')).toHaveCount(4);
  await expect(sidebar.locator('.sidebar-ch-item.focused')).toContainText('Alpha Movies');
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

test('Magic Remote dwell expands groups and stages pointer dismissal', async ({ page }) => {
  await gotoGroupedPlayer(page);
  const sidebar = page.locator('#player-sidebar');

  await page.mouse.move(30, 540);
  await expect(sidebar).toHaveClass(/groups-expanded/);

  await page.mouse.move(800, 540);
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).toBeVisible();
  await page.mouse.move(300, 540);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 550)));
  await expect(sidebar).toBeVisible();

  await page.mouse.move(30, 540);
  await expect(sidebar).toHaveClass(/groups-expanded/);
  await page.mouse.move(800, 540);
  await expect(sidebar).toHaveClass(/channels-only/);
  await expect(sidebar).not.toBeVisible();
});

test('the right-edge player menu opens and lists its color actions', async ({ page }) => {
  // Smoke-exercises player-menu.ts at runtime (it has no other e2e coverage).
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(menu.locator('.menu-item.focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('.menu-item').nth(1)).toHaveClass(/focused/);
});

test('keeps pseudo-localized player menu labels within the panel', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');

  await expect(page.locator('#view-channels')).toBeVisible();
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
  await page.setViewportSize({ width: 1920, height: 1080 }); // panel is 1080px tall
  await routePlaylist(page);
  // Minimal live manifest so hls.js doesn't fatal → no auto-zap to the next channel.
  await routeLiveManifest(page);
  await neuterVideo(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(page.locator('#view-channels')).toBeVisible();

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
    await expect(page.locator('#view-channels')).toBeVisible();
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
    // Rewind to the oldest point, then jump to live by pointer; read seek back in the
    // same task that dispatches it (seekable.end 60 minus the go-live pad 3 = 57).
    const rewound = await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 412, bubbles: true }));
      return (document.getElementById('video-player') as HTMLVideoElement).currentTime;
    });
    expect(rewound).toBe(0);

    const state = await okAndReadVideo(page, '[data-golive]');

    expect(state.currentTime).toBe(57);
  });
});
