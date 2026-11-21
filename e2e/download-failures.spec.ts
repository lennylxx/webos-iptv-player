import { test, expect, enterTab, routePlaylist, seedPlaylist, liveLoaded, type Page } from './helpers';
import { startFaultServer } from './fixtures/fault-server';
import { routeFault } from './fixtures/fault-route';

// Downloads that fail or stall partway. On chromium-53-simulation the app runs
// on its own AbortController polyfill, as on webOS 4, where an abort cannot
// stop a body already arriving; only the app's own timeout can end it.

const VERIFY_FAILED = 'Unable to connect to or verify this account.';

async function checkXtreamAccount(page: Page, baseUrl: string): Promise<void> {
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.click('#add-xtream');
  const card = page.locator('#xtream-entries .xtream-card');
  await card.locator('.xtream-url').fill(baseUrl);
  await card.locator('.xtream-username').fill('u1');
  await card.locator('.xtream-password').fill('p1');
  await card.locator('.check-xtream').click();
}

async function openChannelHealth(page: Page, streamUrl: string): Promise<void> {
  await routePlaylist(page, `#EXTM3U\n#EXTINF:-1 group-title="News",Channel One\n${streamUrl}\n`);
  await seedPlaylist(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="sources"]').click();
}

test('an Xtream account check reports a panel that refuses it', async ({ page }) => {
  await routeFault(page, '**/player_api.php*', { status: 503, body: 'Service Unavailable' });
  await checkXtreamAccount(page, 'http://host.example.com:8080');

  await expect(page.locator('#xtream-entries .xtream-status.err')).toHaveText(VERIFY_FAILED);
});

test('an Xtream account check gives up on a panel that stalls after its headers', async ({ page }) => {
  test.slow();
  const panel = await startFaultServer({
    '/player_api.php': { body: '{"user_info":{"auth":1,"status":"Active"}}', stallAfterBytes: 5 },
  });
  try {
    await checkXtreamAccount(page, panel.url(''));
    await expect(page.locator('#xtream-entries .xtream-status')).toHaveText('Checking…');
    await expect.poll(() => panel.hits('/player_api.php')).toBe(1);

    await expect(page.locator('#xtream-entries .xtream-status.err'))
      .toHaveText(VERIFY_FAILED, { timeout: 25_000 });
  } finally {
    await panel.close();
  }
});

test('a channel check finishes when a stream stalls after its headers', async ({ page }) => {
  const streams = await startFaultServer({
    '/live/ch1.ts': { headers: { 'content-type': 'video/mp2t' }, body: 'G@\u0000\u0010', stallAfterBytes: 1 },
  });
  try {
    await openChannelHealth(page, streams.url('/live/ch1.ts'));
    await page.click('#check-channel-health');
    await expect(page.locator('#cancel-channel-health')).toBeVisible();
    await expect.poll(() => streams.hits('/live/ch1.ts')).toBe(1);

    await expect(page.locator('#check-channel-health')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.channel-health-status.healthy')).toContainText(': 0');
  } finally {
    await streams.close();
  }
});

test('Cancel ends a channel check whose stream stalls after its headers', async ({ page }) => {
  const streams = await startFaultServer({
    '/live/ch1.ts': { headers: { 'content-type': 'video/mp2t' }, body: 'G@\u0000\u0010', stallAfterBytes: 1 },
  });
  try {
    await openChannelHealth(page, streams.url('/live/ch1.ts'));
    await page.click('#check-channel-health');
    await expect.poll(() => streams.hits('/live/ch1.ts')).toBe(1);

    await page.click('#cancel-channel-health');
    await expect(page.locator('#check-channel-health')).toBeVisible({ timeout: 2000 });
  } finally {
    await streams.close();
  }
});

// The guide's own timeout is minutes long, so only failures that end quickly are
// driven here; the unit tests cover a guide server that never answers.
const GUIDE_DAY = (h: number) => `20240310${String(h).padStart(2, '0')}0000 +0000`;
const GUIDE = '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/>'
  + `<programme channel="ch1" start="${GUIDE_DAY(5)}" stop="${GUIDE_DAY(7)}"><title>Alpha Show</title></programme>`
  + `<programme channel="ch1" start="${GUIDE_DAY(7)}" stop="${GUIDE_DAY(9)}"><title>Bravo Show</title></programme>`
  + '</tv>';

async function openGuide(page: Page, guideUrl: string): Promise<void> {
  await routePlaylist(page, '#EXTM3U\n#EXTINF:-1 tvg-id="ch1",Channel 1\nhttp://streams.example.com/ch1.m3u8\n');
  await page.clock.setFixedTime(new Date('2024-03-10T06:00:00Z'));
  await page.addInitScript((url) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url, playlistIds: [] }]));
  }, guideUrl);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg .epg-channel-item')).toHaveCount(1);
}

function guideLog(page: Page, event: string): Promise<unknown> {
  return page.waitForEvent('console', { predicate: message => message.text().includes(event), timeout: 20_000 });
}

test('a guide its server refuses leaves the Guide usable without programmes', async ({ page }) => {
  await routeFault(page, '**/epg.xml', { status: 503, body: 'Service Unavailable' });
  const failed = guideLog(page, 'event=epg.xmltv.load.failed');
  await openGuide(page, 'http://host/epg.xml');
  await failed;

  await expect(page.locator('#epg-programmes .epg-no-data')).toBeVisible();
  await expect(page.locator('#view-epg .epg-channel-item')).toHaveCount(1);
});

test('a guide cut off mid-download shows none of the programmes that arrived', async ({ page }) => {
  const second = GUIDE.indexOf('<programme channel="ch1" start="' + GUIDE_DAY(7));
  const guide = await startFaultServer({ '/epg.xml': { body: GUIDE, resetAfterBytes: second } });
  try {
    const failed = guideLog(page, 'event=epg.xmltv.load.failed');
    await openGuide(page, guide.url('/epg.xml'));
    await failed;

    await expect(page.locator('#epg-programmes .epg-no-data')).toBeVisible();
    await expect(page.locator('#epg-programmes')).not.toContainText('Alpha Show');
  } finally {
    await guide.close();
  }
});

test('a refreshed guide that ends before its closing tag keeps the whole one', async ({ page }) => {
  const cut = GUIDE.slice(0, GUIDE.indexOf('<programme channel="ch1" start="' + GUIDE_DAY(7)));
  const guide = await startFaultServer({ '/epg.xml': [{ body: GUIDE }, { body: cut }] });
  try {
    await openGuide(page, guide.url('/epg.xml'));
    await expect(page.locator('#epg-programmes')).toContainText('Bravo Show');

    const kept = guideLog(page, 'event=epg.feed.incomplete outcome=kept_previous');
    await enterTab(page, 'settings');
    await page.locator('#refresh-data').click();
    await kept;
    expect(guide.hits('/epg.xml')).toBe(2);

    await enterTab(page, 'epg');
    await expect(page.locator('#epg-programmes')).toContainText('Bravo Show');
  } finally {
    await guide.close();
  }
});
