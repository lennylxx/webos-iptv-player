import { test, expect, type Page } from './helpers';

test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');
const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="News",Channel 1',
  'http://host.example.com:8080/live/u1/p1/101.ts',
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

async function setup(page: Page, hasArchive = true): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.route('**/get.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: M3U }));
  await page.route('**/xmltv.php*', route =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    let body: unknown;
    if (url.includes('action=get_live_streams')) {
      body = [{ stream_id: 101, tv_archive: 1, tv_archive_duration: 7 }];
    } else if (url.includes('action=get_simple_data_table')) {
      body = {
        epg_listings: [{
          start_timestamp: 1709978400,
          stop_timestamp: 1709982000,
          has_archive: hasArchive ? 1 : 0,
        }],
      };
    } else {
      body = {
          user_info: { auth: 1, status: 'Active' },
          server_info: {
            timezone: 'Etc/GMT-2',
            timestamp_now: 1709985600,
            time_now: '2024-03-09 14:00:00',
          },
      };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/timeshift/**', route =>
    route.fulfill({ status: 200, contentType: 'video/mp2t', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1',
      name: 'Account 1',
      url: 'http://host.example.com:8080',
      source: 'xtream',
      xtream: { username: 'u1', password: 'p1' },
    }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  });
}

test('plays an archived Xtream program through the provider timeshift endpoint', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const archiveRequest = page.waitForRequest(request =>
    request.url().includes('action=get_simple_data_table'));
  await key(page, 403); // RED opens the EPG
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#epg-programmes [data-prog-idx="0"]')).toContainText('Earlier Show');
  await archiveRequest;

  const timeshiftRequest = page.waitForRequest(request => request.url().includes('/timeshift/'));
  await key(page, 39); // RIGHT focuses programs
  await key(page, 13); // ENTER plays the selected archived program

  await expect(page.locator('#view-player')).toBeVisible();
  expect((await timeshiftRequest).url()).toBe(
    'http://host.example.com:8080/timeshift/u1/p1/60/2024-03-09:12-00/101.ts',
  );
});

test('blocks an Xtream program whose archive recording is unavailable', async ({ page }) => {
  await setup(page, false);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const archiveResponse = page.waitForResponse(response =>
    response.url().includes('action=get_simple_data_table'));
  await key(page, 403);
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#epg-programmes [data-prog-idx="0"]')).toContainText('Earlier Show');
  await archiveResponse;
  await key(page, 39);
  await key(page, 13);

  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator('.toast.visible')).toHaveText('Program is not available for catch-up');
});
