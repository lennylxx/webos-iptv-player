import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, type Page } from './helpers';

interface SeedWatchlistEntry {
  accountId: string;
  kind: 'vod' | 'series';
  itemId: string;
  name: string;
  poster: string;
  rating: string;
  categoryId: string;
  containerExtension?: string;
  addedAt: number;
}

const movieEntry = (id: string, name: string, addedAt: number): SeedWatchlistEntry => ({
  accountId: 'x1',
  kind: 'vod',
  itemId: id,
  name,
  poster: '',
  rating: '',
  categoryId: '1',
  containerExtension: 'mp4',
  addedAt,
});

const seriesEntry = (): SeedWatchlistEntry => ({
  accountId: 'x1',
  kind: 'series',
  itemId: '1',
  name: 'Series One',
  poster: '',
  rating: '',
  categoryId: '1',
  addedAt: 1000,
});

async function seedWatchlistCatalog(page: Page, entries: SeedWatchlistEntry[] = []): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (action === 'get_vod_categories' || action === 'get_series_categories') {
      return json([{ category_id: '1', category_name: 'Category One' }]);
    }
    if (action === 'get_vod_streams') {
      return json([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
        { stream_id: 11, name: 'Movie Two', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]);
    }
    if (action === 'get_vod_info') {
      const id = url.searchParams.get('vod_id');
      return json({ info: { plot: `Movie ${id} plot.`, duration_secs: 120 } });
    }
    if (action === 'get_series') {
      return json([{ series_id: 1, name: 'Series One', cover: '', category_id: '1' }]);
    }
    if (action === 'get_series_info') {
      return json({
        episodes: {
          '1': [
            {
              id: 101, title: 'Episode One', season: 1, episode_num: 1,
              container_extension: 'mp4', info: { plot: '', duration_secs: 60, movie_image: '' },
            },
            {
              id: 102, title: 'Episode Two', season: 1, episode_num: 2,
              container_extension: 'mp4', info: { plot: '', duration_secs: 60, movie_image: '' },
            },
          ],
        },
      });
    }
    return json({});
  });
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.route('**/series/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript((seed) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      {
        id: 'x1',
        name: 'Account One',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u', password: 'p' },
      },
    ]));
    const stored: Record<string, SeedWatchlistEntry> = {};
    for (const entry of seed) {
      stored[`${entry.accountId}|${entry.kind}|${entry.itemId}`] = entry;
    }
    localStorage.setItem('iptv_watchlist', JSON.stringify(stored));

    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number) =>
      nativeSetInterval(handler, timeout === 1000 ? 50 : timeout)) as typeof window.setInterval;
  }, entries);
}

async function focusAndSelect(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first()
    .evaluate((element) => element.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
}

async function storedWatchlist(page: Page): Promise<SeedWatchlistEntry[]> {
  return page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iptv_watchlist') ?? '{}') as Record<string, SeedWatchlistEntry>;
    return Object.keys(stored).map((key) => stored[key]);
  });
}

async function finishCurrentVideo(page: Page): Promise<void> {
  await page.locator('#video-player').evaluate((video) =>
    video.dispatchEvent(new Event('ended')));
}

test('adds and removes Movies and Series through their detail screens', async ({ page }) => {
  await seedWatchlistCatalog(page);
  await routeLiveManifest(page);
  await page.goto('/');

  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies .catalog-tile[data-item-id="10"]');
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toContainText('Add to Watchlist');
  await page.locator('#view-movies [data-action="watchlist"]').click();
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toContainText('Remove from Watchlist');
  expect((await storedWatchlist(page)).map((entry) => `${entry.kind}:${entry.itemId}`)).toEqual(['vod:10']);
  await page.locator('#view-movies [data-action="watchlist"]').click();
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toContainText('Add to Watchlist');
  expect(await storedWatchlist(page)).toEqual([]);

  await enterTab(page, 'series');
  await focusAndSelect(page, '#view-series .catalog-tile[data-item-id="1"]');
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Add to Watchlist');
  await page.locator('#view-series [data-action="watchlist"]').click();
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Remove from Watchlist');
  expect((await storedWatchlist(page)).map((entry) => `${entry.kind}:${entry.itemId}`)).toEqual(['series:1']);
  await page.locator('#view-series [data-action="watchlist"]').click();
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Add to Watchlist');
  expect(await storedWatchlist(page)).toEqual([]);
});

test('shows Resume on return and keeps three movie actions at a stable height', async ({ page }) => {
  await seedWatchlistCatalog(page, [movieEntry('10', 'Movie One', 1000)]);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');

  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies [data-watchlist-item="10"]');
  await focusAndSelect(page, '#view-movies [data-action="play"]');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate((video) => {
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 120 });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 20 });
  });
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));

  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies [data-action="resume"]')).toBeVisible();
  const actions = page.locator('#view-movies .detail-btn');
  await expect(actions).toHaveCount(3);
  const layout = await actions.evaluateAll((buttons) => buttons.map((button) => ({
    height: button.getBoundingClientRect().height,
    top: button.getBoundingClientRect().top,
    whiteSpace: getComputedStyle(button).whiteSpace,
  })));
  expect(new Set(layout.map((item) => item.height)).size).toBe(1);
  expect(new Set(layout.map((item) => item.top)).size).toBe(1);
  expect(layout.every((item) => item.whiteSpace === 'nowrap')).toBe(true);
});

test('auto-plays the next Watchlist movie and removes each completed movie', async ({ page }) => {
  await seedWatchlistCatalog(page, [
    movieEntry('10', 'Movie One', 2000),
    movieEntry('11', 'Movie Two', 1000),
  ]);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');

  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies [data-watchlist-item="10"]');
  await focusAndSelect(page, '#view-movies [data-action="play"]');
  await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Movie One');

  await finishCurrentVideo(page);
  expect((await storedWatchlist(page)).map((entry) => entry.itemId)).toEqual(['11']);
  await expect(page.locator('#player-osd .osd-next-episode')).toContainText('Movie Two');
  await expect(page.locator('#player-osd .osd-next-episode')).toHaveCount(0);
  await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Movie Two');

  await finishCurrentVideo(page);
  await expect(page.locator('#view-movies')).toBeVisible();
  expect(await storedWatchlist(page)).toEqual([]);
});

test('auto-plays the next episode and removes a series only after its final episode', async ({ page }) => {
  await seedWatchlistCatalog(page, [seriesEntry()]);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');

  await enterTab(page, 'series');
  await focusAndSelect(page, '#view-series .catalog-tile[data-item-id="1"]');
  await focusAndSelect(page, '#view-series .episode-row[data-episode-id="101"]');
  await expect(page.locator('#player-osd .osd-channel-name')).toContainText('Episode One');

  await finishCurrentVideo(page);
  expect((await storedWatchlist(page)).map((entry) => entry.itemId)).toEqual(['1']);
  await expect(page.locator('#player-osd .osd-next-episode')).toContainText('Episode Two');
  await expect(page.locator('#player-osd .osd-next-episode')).toHaveCount(0);
  await expect(page.locator('#player-osd .osd-channel-name')).toContainText('Episode Two');

  await finishCurrentVideo(page);
  await expect(page.locator('#view-series')).toBeVisible();
  expect(await storedWatchlist(page)).toEqual([]);
});
