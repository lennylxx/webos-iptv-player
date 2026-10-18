import { test, expect, type Page, routePlaylist, LIVE_MANIFEST } from './helpers';

// A SIPTV-style playlist: archive days in `timeshift`, no catch-up tags, so the
// archive URL is the stream URL plus `utc`/`lutc` (catch-up "shift" mode).
test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');
const M3U = [
  '#EXTM3U url-tvg="http://host/epg.xml"',
  '#EXTINF:0 tvg-id="ch1" timeshift="7",Channel 1',
  '#EXTGRP:News',
  'http://streams.example.com/ch1/mono.m3u8?token=t1',
].join('\n');
const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="20240309100000 +0000" stop="20240309110000 +0000"><title>Earlier Show</title></programme>
<programme channel="ch1" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
</tv>`;

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    (code) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })),
    keyCode,
  );
}

test('plays a past program of a SIPTV timeshift channel from its archive', async ({ page }) => {
  await routePlaylist(page, M3U);
  await page.route('**/*.m3u8*', route =>
    route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST }));
  await page.route('**/epg.xml', route =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  });

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await key(page, 403); // RED opens the EPG
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#epg-programmes [data-prog-idx="0"]')).toContainText('Earlier Show');

  const archiveRequest = page.waitForRequest(request => request.url().includes('utc='));
  await key(page, 39); // RIGHT focuses programs
  await key(page, 13); // ENTER plays the selected past program

  await expect(page.locator('#view-player')).toBeVisible();
  expect((await archiveRequest).url()).toBe(
    'http://streams.example.com/ch1/mono.m3u8?token=t1&utc=1709978400&lutc=1709985600',
  );
});
