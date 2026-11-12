import {
  liveLoaded,
  test,
  expect,
  enterTab,
  seedPlaylist,
  routePlaylist,
  routeLiveManifest,
  SAMPLE_M3U,
  type Page,
} from './helpers';

// channelKey mirrors src/utils/channel.ts (fnv1a of the URL sans query/fragment).
function channelKey(url: string): string {
  const stable = url.split('#')[0].split('?')[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const CHAN_ONE = 'http://streams.example.com/one.m3u8';

async function seedDueReminder(page: Page): Promise<void> {
  await page.addInitScript((k) => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey: k, channelName: 'Channel One', title: 'Alpha', startMs: now - 60000, stopMs: now + 3600000 },
    ]));
  }, channelKey(CHAN_ONE));
}

test('a due reminder prompts on open and Watch now opens the player', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await seedDueReminder(page);

  await page.goto('/');

  await expect(page.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
  await expect(page.locator('.reminder-message')).toContainText('Alpha');

  await page.locator('.reminder-btn[data-reminder-action="ok"]').click();
  await expect(page.locator('#view-player')).toBeVisible();
});

test('Cancel dismisses the prompt and stays on the channel list', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await seedDueReminder(page);

  await page.goto('/');
  await expect(page.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
  await page.locator('.reminder-btn[data-reminder-action="cancel"]').click();
  await expect(page.locator('.reminder-prompt.hidden')).toHaveCount(1);
  await liveLoaded(page);

  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await expect(page.locator('#manage-reminders')).toContainText('(0)');
});

test('the EPG reminder legend opens management and Back returns to it', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');

  await enterTab(page, 'epg');
  const entry = page.locator('.epg-reminder-entry');
  await expect(entry).toBeVisible();
  await entry.hover();
  await expect(entry).toHaveCSS('font-size', '15px');
  await expect(entry).toHaveCSS('font-weight', '600');
  await expect(entry).toHaveCSS('box-shadow', 'none');
  await expect(entry).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
  await expect(entry).toHaveCSS('transform', 'none');
  await entry.click();
  await expect(page.locator('#view-reminders')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(entry).toHaveClass(/focused/);
});

test('long reminder text stays on one line inside the card', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript((k) => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: k,
      channelName: `Channel ${'Bravo '.repeat(30)}`,
      title: `Program ${'Alpha '.repeat(30)}`,
      startMs: now + 60 * 60 * 1000,
      stopMs: now + 2 * 60 * 60 * 1000,
    }]));
  }, channelKey(CHAN_ONE));

  await page.goto('/');
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-reminders').click();

  for (const selector of ['.reminder-manager-program', '.reminder-manager-channel']) {
    const metrics = await page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics).toMatchObject({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
  }

  const row = page.locator('.reminder-manager-row');
  await expect(row).toHaveCSS('overflow', 'hidden');
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  await page.evaluate(() => { document.documentElement.dataset.textSize = '150'; });
  const timeFits = await page.locator('.reminder-manager-time').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    text: element.textContent?.trim(),
  }));
  expect(timeFits.text).toMatch(/^\d{2}:\d{2}$/);
  expect(timeFits.scrollWidth).toBeLessThanOrEqual(timeFits.clientWidth);
});

test('reminder manager icons scale with the text size', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript((k) => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey: k, channelName: 'Channel One', title: 'Alpha', startMs: now + 3600000, stopMs: now + 7200000 },
    ]));
  }, channelKey(CHAN_ONE));

  await page.goto('/');
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-reminders').click();
  await expect(page.locator('.reminder-manager-row')).toBeVisible();

  const icons = [
    '.reminder-manager-back .reminder-manager-button-icon',
    '.reminder-manager-clear .reminder-manager-button-icon',
    '.reminder-manager-time-icon',
    '.reminder-manager-remove .reminder-manager-button-icon',
  ];
  const measure = () => page.evaluate((selectors) => selectors.map((selector) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }), icons);

  await page.evaluate(() => { document.documentElement.dataset.textSize = '100'; });
  const base = await measure();
  await page.evaluate(() => { document.documentElement.dataset.textSize = '150'; });
  const large = await measure();

  base.forEach((size, i) => {
    expect(size.width, icons[i]).toBeGreaterThan(0);
    expect(large[i].width / size.width, icons[i]).toBeCloseTo(1.5, 1);
    expect(large[i].height / size.height, icons[i]).toBeCloseTo(1.5, 1);
  });
});

test('reminder card columns fit their text at text size 150', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript((k) => {
    localStorage.setItem('iptv_locale', JSON.stringify('de'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey: k, channelName: 'Channel One', title: 'Alpha', startMs: now + 3 * 86400000, stopMs: now + 3 * 86400000 + 3600000 },
    ]));
  }, channelKey(CHAN_ONE));

  await page.goto('/');
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-reminders').click();
  await expect(page.locator('.reminder-manager-row')).toBeVisible();

  for (const selector of ['.reminder-day-label', '.reminder-manager-time', '.reminder-manager-remove']) {
    const fit = await page.locator(selector).evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(fit.scrollWidth, selector).toBeLessThanOrEqual(fit.clientWidth);
  }
  const row = await page.locator('.reminder-manager-row').boundingBox();
  const remove = await page.locator('.reminder-manager-remove').boundingBox();
  expect(remove!.x + remove!.width).toBeLessThanOrEqual(row!.x + row!.width);
});

test('the empty-state hint wraps to a readable width at text size 150', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript(() => { localStorage.setItem('iptv_locale', JSON.stringify('de')); });

  await page.goto('/');
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-reminders').click();
  await page.evaluate(() => { document.documentElement.dataset.textSize = '150'; });

  const hint = page.locator('.reminder-manager-empty-hint');
  await expect(hint).toBeVisible();
  const box = await hint.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
    return { width: rect.width, left: rect.left, right: rect.right, lines: Math.round(rect.height / lineHeight) };
  });
  expect(box.width).toBeLessThanOrEqual(1100);
  expect(box.lines).toBe(2);
  expect(Math.abs((box.left + box.right) / 2 - 960)).toBeLessThan(2);
});

test('reminders opened while the playlist loads survive and list once it arrives', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/playlist.m3u', async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U });
  });
  await seedPlaylist(page);
  await page.addInitScript((k) => {
    if (localStorage.getItem('iptv_reminders')) return;
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey: k, channelName: 'Channel One', title: 'Alpha', startMs: now + 3600000, stopMs: now + 7200000 },
    ]));
  }, channelKey(CHAN_ONE));

  await page.goto('/');
  await page.locator('.tab-bar-item[data-section="settings"]').click();
  await page.locator('#manage-reminders').click();
  await expect(page.locator('.reminder-manager-view')).toBeVisible();
  await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);

  release();
  await expect(page.locator('.reminder-manager-row')).toHaveCount(1);
});
