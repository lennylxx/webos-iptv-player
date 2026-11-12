import {
  liveLoaded,
  test,
  expect,
  enterTab,
  neuterVideo,
  routeLiveManifest,
  routePlaylist,
  seedPlaylist,
  PLAYLIST_URL,
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

// A reminder that comes due on the first scan after the clock runs past it,
// so it pops up over whatever owns the keys by then.
async function seedLaterReminder(page: Page): Promise<void> {
  await page.addInitScript((k) => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([
      { channelKey: k, channelName: 'Channel One', title: 'Alpha', startMs: now + 10000, stopMs: now + 3600000 },
    ]));
  }, channelKey(CHAN_ONE));
}

async function setup(page: Page): Promise<void> {
  await page.clock.install();
  await neuterVideo(page);
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page, PLAYLIST_URL);
  await seedLaterReminder(page);
  await page.goto('/');
  await liveLoaded(page);
}

const owner = (page: Page) => page.locator('[data-ring-owner]');

async function reminderComesDue(page: Page): Promise<void> {
  await page.clock.runFor(35000);
  await expect(page.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
}

test('the parental PIN keeps the keys over a reminder that comes due under it', async ({ page }) => {
  await setup(page);
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  await expect(page.locator('.parental-pin-prompt')).toBeVisible();
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.parental_pin');

  await reminderComesDue(page);
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.parental_pin');

  await page.keyboard.press('Escape');
  await expect(page.locator('.parental-pin-prompt')).toBeHidden();
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.reminder');
});

test('the parental PIN paints above a reminder that comes due under it', async ({ page }) => {
  await setup(page);
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  await expect(page.locator('.parental-pin-prompt')).toBeVisible();
  await reminderComesDue(page);

  const onTop = await page.evaluate(() => {
    const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return !!hit?.closest('.parental-pin-prompt');
  });
  expect(onTop).toBe(true);
});

test('watching a reminder that comes due over the Clear all confirmation closes it', async ({ page }) => {
  await setup(page);
  await enterTab(page, 'epg');
  await page.locator('.epg-reminder-entry').click();
  await expect(page.locator('#view-reminders')).toBeVisible();
  await page.locator('.reminder-manager-clear').click();
  await expect(page.locator('.confirmation-prompt:not(.hidden)')).toBeVisible();

  await reminderComesDue(page);
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.reminder');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.confirmation-prompt:not(.hidden)')).toHaveCount(0);
  await expect(owner(page)).not.toHaveAttribute('data-focus-scope', 'prompt.reminder_manager');
});

test('a reminder takes the keys from the tab bar and gives them back', async ({ page }) => {
  await setup(page);
  await page.keyboard.press('ArrowUp');
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'tabbar');

  await reminderComesDue(page);
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.reminder');

  await page.keyboard.press('Escape');
  await expect(page.locator('.reminder-prompt:not(.hidden)')).toHaveCount(0);
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'tabbar');
});

const rings = (page: Page) => page.locator('.focused');

async function hoverCenter(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  // Seed the pointer first: a pointer that never moved cannot hover in key mode.
  await page.mouse.move(1, 1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test('a hover reaching a reminder covered by the parental PIN leaves it dark and keeps its focus', async ({ page }) => {
  await setup(page);
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  await expect(page.locator('.parental-pin-prompt')).toBeVisible();
  await reminderComesDue(page);

  // The PIN's backdrop covers the reminder, so no pointer reaches it; send
  // the hover to the covered button as KeyHandler would.
  await page.locator('.reminder-btn[data-key="cancel"]').evaluate((el) => {
    el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  });
  await expect(page.locator('.reminder-btn.focused')).toHaveCount(0);
  await expect(page.locator('[data-ring-hover]')).toHaveCount(0);
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.parental_pin');

  await page.keyboard.press('Escape');
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.reminder');
  await expect(rings(page)).toHaveCount(1);
  await expect(page.locator('.reminder-btn.focused')).toHaveAttribute('data-key', 'ok');
});

test('the reminder ring follows the pointer and the D-pad', async ({ page }) => {
  await setup(page);
  await reminderComesDue(page);
  await expect(page.locator('.reminder-btn.focused')).toHaveAttribute('data-key', 'ok');

  await hoverCenter(page, '.reminder-btn[data-key="cancel"]');
  await expect(page.locator('.reminder-btn.focused')).toHaveAttribute('data-key', 'cancel');
  await expect(rings(page)).toHaveCount(1);

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.reminder-btn.focused')).toHaveAttribute('data-key', 'ok');
  await expect(rings(page)).toHaveCount(1);
});

test('closing a reminder gives the ring back to the player sidebar', async ({ page }) => {
  await setup(page);
  // Up to just before the scan that raises the reminder.
  await page.clock.runFor(28000);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  const sidebarRing = page.locator('#player-sidebar .sidebar-ch-item.focused');
  await expect(sidebarRing).toHaveCount(1);
  const key = await sidebarRing.getAttribute('data-key');

  await page.clock.runFor(3000);
  await expect(page.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'prompt.reminder');
  await expect(sidebarRing).toHaveCount(0);
  await expect(rings(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(owner(page)).toHaveAttribute('data-focus-scope', 'player.sidebar');
  await expect(sidebarRing).toHaveAttribute('data-key', key!);
  await expect(rings(page)).toHaveCount(1);
});
