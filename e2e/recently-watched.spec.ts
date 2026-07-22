import { test, expect, type Page, enterTab, LIVE_MANIFEST } from './helpers';

test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');
const LIVE_URL = 'http://host/b.m3u8';
const CATCHUP_CHANNEL_URL = 'http://host/a.m3u8';
const CATCHUP_URL = 'http://host/catchup.m3u8?start={utc}&end={utcend}';
const PROGRAM_START = Date.parse('2024-03-09T10:00:00Z');
const PROGRAM_END = Date.parse('2024-03-09T11:00:00Z');

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1" catchup="default" ' +
    `catchup-source="${CATCHUP_URL}" catchup-days="7",Channel Alpha`,
  CATCHUP_CHANNEL_URL,
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 2",Channel Bravo',
  LIVE_URL,
].join('\n');

function stableChannelKey(url: string): string {
  const stable = url.split('#')[0].split('?')[0];
  let hash = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function setup(page: Page, seedHistory = true): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.route('**/playlist.m3u', route =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: M3U }));
  await page.route('**/*.m3u8*', route =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST }));
  await page.addInitScript((seed) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'p1',
      name: 'Playlist 1',
      url: 'http://host/playlist.m3u',
      source: 'url',
    }]));
    if (!seed.seedHistory) return;
    localStorage.setItem('iptv_recently_watched_live', JSON.stringify([{
      channelKey: seed.liveKey,
      updatedAt: seed.now - 2000,
    }]));
    localStorage.setItem('iptv_catchup_progress', JSON.stringify({
      [`${seed.catchupKey}|${seed.start}`]: {
        channelKey: seed.catchupKey,
        progStart: seed.start,
        progEnd: seed.end,
        title: 'Program Alpha',
        description: 'Summary',
        icon: '',
        position: 1800,
        duration: 3600,
        updatedAt: seed.now - 1000,
        completed: false,
        expiresAt: seed.end + 7 * 86400 * 1000,
      },
    }));
    localStorage.setItem('iptv_resume', JSON.stringify({
      'x1|vod|m1': {
        accountId: 'x1',
        kind: 'vod',
        itemId: 'm1',
        name: 'Movie Alpha',
        poster: '',
        ext: 'mp4',
        position: 600,
        duration: 3600,
        updatedAt: seed.now,
      },
    }));
  }, {
    liveKey: stableChannelKey(LIVE_URL),
    catchupKey: stableChannelKey(CATCHUP_CHANNEL_URL),
    start: PROGRAM_START,
    end: PROGRAM_END,
    now: NOW.getTime(),
    seedHistory,
  });
}

async function openRecentlyWatched(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.locator('[data-group="Recently Watched"]').click();
}

test('mixes live and resumable Catch-up rows in recency order', async ({ page }) => {
  await setup(page);
  await openRecentlyWatched(page);

  const rows = page.locator('.channel-main .recent-item');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveClass(/recent-catchup/);
  await expect(rows.nth(0)).toContainText('Program Alpha');
  await expect(rows.nth(0)).toContainText('Resume at 30:00');
  await expect(rows.nth(1)).toHaveClass(/recent-live/);
  await expect(rows.nth(1)).toContainText('Channel Bravo');
});

test('adds a live channel only after confirmed playback', async ({ page }) => {
  await setup(page, false);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.locator('.channel-item').filter({ hasText: 'Channel Bravo' }).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#video-player')!;
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
    video.dispatchEvent(new Event('playing'));
  });
  await page.clock.fastForward(5000);

  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('iptv_recently_watched_live') ?? '[]').length,
  )).toBe(1);

  await page.keyboard.press('Escape');
  await page.locator('[data-group="Recently Watched"]').click();
  await expect(page.locator('.recent-live')).toContainText('Channel Bravo');
});

test('starts live and resumes Catch-up directly from Recently Watched', async ({ page }) => {
  await setup(page);
  await openRecentlyWatched(page);

  const liveRequest = page.waitForRequest(request => request.url().includes('/b.m3u8'));
  await page.locator('.recent-live').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await liveRequest;

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels')).toBeVisible();
  const catchupRequest = page.waitForRequest(request =>
    request.url().includes('/catchup.m3u8') &&
    request.url().includes(`start=${String(PROGRAM_START / 1000)}`));
  await page.locator('.recent-catchup').click();

  await expect(page.locator('#view-player')).toBeVisible();
  await catchupRequest;
  await expect(page.locator('.catchup-resume-prompt')).toHaveCount(0);
});

test('clears Recently Watched without clearing VOD resume', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await enterTab(page, 'settings');

  await page.locator('#clear-recently-watched').click();
  await expect(page.locator('.confirmation-prompt')).toBeVisible();
  await page.locator('[data-confirm-action="confirm"]').click();
  await expect(page.locator('.toast.visible')).toHaveText('Recently Watched cleared');

  const stored = await page.evaluate(() => ({
    live: localStorage.getItem('iptv_recently_watched_live'),
    catchup: localStorage.getItem('iptv_catchup_progress'),
    vod: localStorage.getItem('iptv_resume'),
  }));
  expect(stored.live).toBeNull();
  expect(stored.catchup).toBeNull();
  expect(stored.vod).toContain('Movie Alpha');
});

test('filters Recently Watched by the selected playlist', async ({ page }) => {
  await page.route('**/p1.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Group 1",Channel Alpha\nhttp://host/a.m3u8',
  }));
  await page.route('**/p2.m3u', route => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: '#EXTM3U\n#EXTINF:-1 group-title="Group 2",Channel Bravo\nhttp://host/b.m3u8',
  }));
  await page.addInitScript((keys) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Playlist 1', url: 'http://host/p1.m3u', source: 'url' },
      { id: 'p2', name: 'Playlist 2', url: 'http://host/p2.m3u', source: 'url' },
    ]));
    localStorage.setItem('iptv_recently_watched_live', JSON.stringify([
      { channelKey: keys.bravo, updatedAt: 2000 },
      { channelKey: keys.alpha, updatedAt: 1000 },
    ]));
  }, {
    alpha: stableChannelKey(CATCHUP_CHANNEL_URL),
    bravo: stableChannelKey(LIVE_URL),
  });

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.locator('[data-playlist="p1"]').click();
  await page.locator('[data-group="Recently Watched"]').click();

  await expect(page.locator('.recent-item')).toHaveCount(1);
  await expect(page.locator('.recent-item')).toContainText('Channel Alpha');
  await expect(page.locator('.recent-item')).not.toContainText('Channel Bravo');
  await expect(page.locator('[data-group="Recently Watched"] .group-count')).toHaveText('1');
});
