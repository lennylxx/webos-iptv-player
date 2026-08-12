import {
  test,
  expect,
  enterTab,
  seedPlaylist,
  routePlaylist,
  routeLiveManifest,
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
  await expect(page.locator('#view-channels')).toBeVisible();

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
