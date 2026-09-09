import { readFileSync } from 'node:fs';
import { test, expect, routePlaylist, seedPlaylist } from './helpers';
import { DASH_URL, DASH_M3U, DASH_MPD, installShakaStub } from './shaka-fixture';

const shakaVersion = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies['shaka-player'];

test('routes an MPD through Shaka and renders its stream info', async ({ page }) => {
  await installShakaStub(page);
  await routePlaylist(page, DASH_M3U);
  await page.route(DASH_URL, route => route.fulfill({
    status: 200,
    contentType: 'application/dash+xml',
    body: DASH_MPD,
  }));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.waitForFunction(() =>
    (window as unknown as { __shakaE2E?: { loadedUrl: string } })
      .__shakaE2E?.loadedUrl === 'http://host/a.mpd');

  const state = await page.evaluate(() =>
    (window as unknown as {
      __shakaE2E: {
        attached: boolean;
        loadedUrl: string;
        settings: {
          streaming?: { bufferingGoal?: number };
        } | null;
        currentText: unknown;
      };
    }).__shakaE2E);
  expect(state.attached).toBe(true);
  expect(state.loadedUrl).toBe(DASH_URL);
  expect(state.settings?.streaming?.bufferingGoal).toBe(30);
  expect(state.currentText).toBeNull();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  const info = page.locator('#player-osd .osd-stream-info');
  await expect(info).toBeVisible();
  await expect(info).toContainText('720p');
  await expect(info).toContainText('H.264');
  await expect(info).toContainText('AAC');
  await expect(info).toContainText('Track 1');
});

test('loads the real Shaka engine in the desktop preview', async ({ page }) => {
  let manifestRequests = 0;
  await routePlaylist(page, DASH_M3U);
  await page.route(DASH_URL, route => {
    manifestRequests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: DASH_MPD,
    });
  });
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.waitForFunction(() =>
    typeof (window as unknown as { __shaka?: { Player?: unknown } })
      .__shaka?.Player === 'function');
  expect(await page.evaluate(() =>
    (window as unknown as { __shaka: { Player: { version: string } } })
      .__shaka.Player.version)).toBe(`v${shakaVersion}`);

  // PlayerPipeline fetches track metadata first; the real Shaka instance then
  // makes its own manifest request while initializing playback.
  await expect.poll(() => manifestRequests).toBeGreaterThanOrEqual(2);
});
