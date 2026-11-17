import { liveLoaded, test, expect, type Page, routePlaylist, LIVE_MANIFEST } from './helpers';

// A legacy `timeshift="7"` channel has shift catch-up: a past program plays
// the live URL with utc (program start) and lutc (now) added.
test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');
const PAST_START = Date.parse('2024-03-09T10:00:00Z') / 1000;

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="News" timeshift="7",Channel 1',
  'http://host/ch1/live.m3u8?token=t1',
].join('\n');

const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="20240309100000 +0000" stop="20240309110000 +0000"><title>Earlier Show</title></programme>
<programme channel="ch1" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
</tv>`;

async function setup(page: Page, m3u = M3U, epg = EPG): Promise<string[]> {
  const requested: string[] = [];
  await routePlaylist(page, m3u);
  await page.route(/\/ch[12]\/(?:live|vod)\.m3u8/, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST });
  });
  await page.route('**/epg.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml', body: epg }));
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  });
  return requested;
}

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    (k) => { document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })); },
    keyCode,
  );
}

test('a past program on a timeshift channel requests utc and lutc', async ({ page }) => {
  const requested = await setup(page);
  await page.goto('/');
  await liveLoaded(page);
  await key(page, 403); // red → guide
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.locator('#epg-programmes [data-prog-idx="0"]').waitFor();
  await expect(page.locator('#epg-programmes [data-prog-idx="0"]')).toContainText('Earlier Show');

  await key(page, 39); // RIGHT → programs, the past one focused
  await key(page, 13); // ENTER → play it
  await expect(page.locator('#view-player')).toBeVisible();

  const catchup = `http://host/ch1/live.m3u8?token=t1&utc=${PAST_START}&lutc=${NOW.getTime() / 1000}`;
  await expect.poll(() => requested).toContain(catchup);
});

// A vod channel plays each program by the catch-up id its XMLTV entry carries.
const VOD_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch2" group-title="News" catchup="vod" '
    + 'catchup-source="http://host/ch2/vod.m3u8?id={catchup-id}",Channel 2',
  'http://host/ch2/live.m3u8',
].join('\n');

const VOD_EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch2"><display-name>Channel 2</display-name></channel>
<programme channel="ch2" start="20240309090000 +0000" stop="20240309100000 +0000"><title>Earliest Show</title></programme>
<programme channel="ch2" start="20240309100000 +0000" stop="20240309110000 +0000" catchup-id="p1"><title>Earlier Show</title></programme>
<programme channel="ch2" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
</tv>`;

test('a past program on a vod channel requests its XMLTV catch-up id', async ({ page }) => {
  const requested = await setup(page, VOD_M3U, VOD_EPG);
  await page.goto('/');
  await liveLoaded(page);
  await key(page, 403);
  await expect(page.locator('#view-epg')).toBeVisible();
  const withoutId = page.locator('#epg-programmes [data-prog-idx="0"]');
  const withId = page.locator('#epg-programmes [data-prog-idx="1"]');
  await expect(withId).toContainText('Earlier Show');
  // Only the aired program the archive can play carries the replay glyph.
  await expect(withId.locator('.epg-replay-glyph')).toHaveCount(1);
  await expect(withoutId).toHaveClass(/state-past/);
  await expect(withoutId.locator('.epg-replay-glyph')).toHaveCount(0);

  await key(page, 39); // RIGHT → programs, the earliest focused
  await key(page, 40); // DOWN → the one with a catch-up id
  await key(page, 13);
  await expect(page.locator('#view-player')).toBeVisible();
  await expect.poll(() => requested).toContain('http://host/ch2/vod.m3u8?id=p1');
});
