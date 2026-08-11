import { test, expect, type Page } from './helpers';

test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');

function playlist(name: string, stream: string, epgUrl = '', group = 'News'): string {
  return [
    epgUrl ? `#EXTM3U url-tvg="${epgUrl}"` : '#EXTM3U',
    `#EXTINF:-1 tvg-id="shared" group-title="${group}",${name}`,
    stream,
  ].join('\n');
}

function epg(name: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="shared"><display-name>${name}</display-name></channel>
<programme channel="shared" start="20240309110000 +0000" stop="20240309130000 +0000">
  <title>${title}</title>
</programme>
</tv>`;
}

async function setup(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.route('**/list.m3u', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-mpegurl',
    body: playlist('Alpha', 'http://host/a.m3u8', 'http://host/m3u.xml'),
  }));
  await page.route('**/get.php*', (route) => {
    const second = new URL(route.request().url()).port === '8082';
    return route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: second
        ? playlist('Charlie', 'http://host/c.m3u8', '', 'Sports')
        : playlist('Bravo', 'http://host/b.m3u8'),
    });
  });
  await page.route('**/player_api.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/m3u.xml', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: epg('Alpha', 'Alpha Program') }));
  await page.route('**/xmltv.php*', (route) => {
    const second = new URL(route.request().url()).port === '8082';
    return route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: second ? epg('Charlie', 'Charlie Program') : epg('Bravo', 'Bravo Program'),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'm3u', name: 'M3U', url: 'http://host/list.m3u', source: 'url' },
      {
        id: 'x1', name: 'Xtream 1', url: 'http://host:8081', source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      },
      {
        id: 'x2', name: 'Xtream 2', url: 'http://host:8082', source: 'xtream',
        xtream: { username: 'u2', password: 'p2' },
      },
    ]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  });
}

test('each playlist channel uses its own EPG when XMLTV ids collide', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#epg-programmes')).toContainText('Alpha Program');

  const channels = page.locator('#epg-channels .epg-channel-item');
  await expect(channels).toHaveCount(3);

  await channels.filter({ hasText: 'Bravo' }).click();
  await expect(page.locator('#epg-programmes')).toContainText('Bravo Program');
  await expect(page.locator('#epg-programmes')).not.toContainText('Alpha Program');

  await channels.filter({ hasText: 'Charlie' }).click();
  await expect(page.locator('#epg-programmes')).toContainText('Charlie Program');
  await expect(page.locator('#epg-programmes')).not.toContainText('Bravo Program');
});

test('applies the saved time correction only to its EPG source', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_epg_offsets', JSON.stringify({
      'http://host/m3u.xml': 60,
    }));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();

  const alpha = page.locator('.epg-programme-item').filter({ hasText: 'Alpha Program' });
  await expect(alpha.locator('.epg-prog-time')).toHaveText('12:00');

  await page.locator('#epg-channels .epg-channel-item').filter({ hasText: 'Bravo' }).click();
  const bravo = page.locator('.epg-programme-item').filter({ hasText: 'Bravo Program' });
  await expect(bravo.locator('.epg-prog-time')).toHaveText('11:00');
});

test('filters EPG channels by source, group, and channel name', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();

  await page.locator('#epg-playlists [data-playlist="x2"]').click();
  await expect(page.locator('#epg-channels .epg-channel-item')).toHaveCount(1);
  await expect(page.locator('#epg-channels')).toContainText('Charlie');

  await page.locator('#epg-playlists [data-playlist=""]').click();
  await page.locator('[data-epg-group-toggle]').click();
  await page.locator('[data-epg-group="source:Sports"]').click();
  await expect(page.locator('#epg-channels .epg-channel-item')).toHaveCount(1);
  await expect(page.locator('#epg-channels')).toContainText('Charlie');

  await page.locator('[data-epg-group-toggle]').click();
  await page.locator('[data-epg-group="builtin:all"]').click();
  await page.locator('.epg-search-input').fill('Bravo');
  await expect(page.locator('#epg-channels .epg-channel-item')).toHaveCount(1);
  await expect(page.locator('#epg-channels')).toContainText('Bravo');
});

test('Back closes EPG filters before leaving the guide', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();

  await page.locator('[data-epg-group-toggle]').click();
  await expect(page.locator('.epg-group-menu')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.epg-group-menu')).toHaveCount(0);
  await expect(page.locator('#view-epg')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('Blue leaves EPG search without stale keyboard focus', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('.epg-search-input')).toBeFocused();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.epg-search-input')).not.toBeFocused();

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('.epg-group-menu')).toHaveCount(0);
  await expect(page.locator('.epg-search-input')).not.toBeFocused();
});
