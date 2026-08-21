import { test, expect, type Page } from './helpers';
import {
  XtreamReferenceServer,
  type XtreamReferenceProfile,
} from './fixtures/xtream-reference-server';

test.use({ timezoneId: 'UTC' });

const NOW = new Date('2024-03-09T12:00:00Z');
const servers: XtreamReferenceServer[] = [];

async function startServer(profile: XtreamReferenceProfile): Promise<XtreamReferenceServer> {
  const server = new XtreamReferenceServer(profile);
  await server.start();
  servers.push(server);
  return server;
}

async function seedAccount(
  page: Page,
  server: XtreamReferenceServer,
  liveOutput: 'ts' | 'm3u8' = 'ts',
): Promise<void> {
  await page.addInitScript(({ baseUrl, output }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1',
      name: 'Account 1',
      url: baseUrl,
      source: 'xtream',
      xtream: { username: 'u1', password: 'p1', liveOutput: output },
    }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
  }, { baseUrl: server.origin, output: liveOutput });
}

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    code => document.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode: code, bubbles: true }),
    ),
    keyCode,
  );
}

async function openEarlierProgramme(page: Page): Promise<void> {
  await key(page, 403);
  await expect(page.locator('#view-epg')).toBeVisible();
  await expect(page.locator('#epg-programmes [data-prog-idx="0"]'))
    .toContainText('Earlier Show');
  await key(page, 39);
  await key(page, 13);
}

test.afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

test('loads live channels from Player API when get.php is unavailable', async ({ page }) => {
  const server = await startServer('player-api-only');
  await seedAccount(page, server);

  await page.goto('/');

  const channels = page.locator('.channel-main .channel-item');
  await expect(channels).toHaveCount(2);
  await expect(channels.nth(0)).toContainText('Alpha');
  await expect(channels.nth(1)).toContainText('Bravo');
  await expect(page.locator('[data-group="source:Group 1"]')).toBeVisible();
  expect(server.actions()).toEqual(expect.arrayContaining([
    'get_live_categories',
    'get_live_streams',
  ]));

  const directRequest = server.waitForRequest(
    request => request.pathname === '/direct/201.m3u8',
  );
  await channels.nth(0).click();
  await directRequest;
});

test('constructs an HLS live URL when categories are unsupported', async ({ page }) => {
  const server = await startServer('uncategorized-hls');
  await seedAccount(page, server, 'm3u8');

  await page.goto('/');

  const channel = page.locator('.channel-main .channel-item').first();
  await expect(channel).toContainText('Alpha');
  const liveRequest = server.waitForRequest(
    request => request.pathname === '/live/u1/p1/201.m3u8',
  );
  await channel.click();
  await liveRequest;
});

test('supports XC M3U catch-up and the legacy action spelling', async ({ page }) => {
  const server = await startServer('legacy-xc');
  await seedAccount(page, server, 'm3u8');
  await page.clock.setFixedTime(NOW);

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const legacyAction = server.waitForRequest(
    request => request.searchParams.get('action') === 'get_simple_date_table',
  );
  const catchupRequest = server.waitForRequest(
    request => request.pathname.endsWith('/101.m3u8'),
  );
  await openEarlierProgramme(page);

  await legacyAction;
  expect((await catchupRequest).pathname).toBe(
    '/timeshift/u1/p1/60/2024-03-09:12-00/101.m3u8',
  );
  const actions = server.actions();
  expect(actions.indexOf('get_simple_data_table'))
    .toBeLessThan(actions.indexOf('get_simple_date_table'));
});

test('falls through failed timeshift path variants in order', async ({ page }) => {
  const server = await startServer('catchup-variants');
  await seedAccount(page, server);
  await page.clock.setFixedTime(NOW);

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await openEarlierProgramme(page);
  const candidates = [
    '/timeshift/u1/p1/60/2024-03-09:12-00/101.ts',
    '/timeshift/u1/p1/60/2024-03-09:12-00/101',
    '/timeshift/u1/p1/60/2024-03-09:12-00/101.m3u8',
  ];
  for (const candidate of candidates.slice(0, 2)) {
    await server.waitForRequest(request => request.pathname === candidate);
    await page.locator('#video-player').dispatchEvent('error');
  }
  await server.waitForRequest(request => request.pathname === candidates[2]);

  expect(server.timeshiftPaths().slice(0, 3)).toEqual(candidates);
});
