import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, type Page } from './helpers';
import { hover } from './navigation-helpers';

const TRAILER = 'abcDEF12_-z';

// Movie 10 has a trailer and movie 11 has none. Off webOS the trailer opens in
// a browser tab, so `window.open` records each launch.
interface Options {
  noticeSeen?: boolean;
  // Run as on the TV, with a Luna bridge whose app check answers `exist`
  // (or waits for `__answerYoutube`) and whose launch fails with `launchError`.
  tv?: { exist: boolean | 'later'; launchError?: number };
}

async function openMovie(page: Page, itemId: '10' | '11', options: Options = {}): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (url.includes('get_vod_streams')) {
      return json([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
        { stream_id: 11, name: 'Movie Two', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]);
    }
    if (url.includes('get_vod_info')) {
      return json({ info: { plot: 'A plot.', duration_secs: 3600,
        youtube_trailer: url.includes('vod_id=10') ? TRAILER : '' } });
    }
    return json([]);
  });
  if (options.tv) await installLuna(page, options.tv);
  await page.addInitScript((noticeSeen) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'x1', name: 'X Account',
      url: 'http://host.example.com:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } }]));
    localStorage.setItem('iptv_animation_mode', JSON.stringify('essential'));
    if (noticeSeen) localStorage.setItem('iptv_trailer_notice_seen', 'true');
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = (url?: string | URL) => { opened.push(String(url)); return null; };
  }, options.noticeSeen ?? false);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await hover(page.locator(`#view-movies .catalog-tile[data-item-id="${itemId}"]`).last());
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-actions [data-key="play"]')).toBeVisible();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
}

async function installLuna(page: Page, tv: NonNullable<Options['tv']>): Promise<void> {
  await page.addInitScript((config) => {
    const win = window as unknown as {
      PalmServiceBridge?: unknown;
      __luna: Array<{ method: string; parameters: unknown }>;
      __answerYoutube?: (exist: boolean) => void;
    };
    win.__luna = [];
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private respond(response: unknown): void {
        setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
      }
      call(uri: string, payload: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as unknown;
        if (method === 'getAppLoadStatus') {
          win.__luna.push({ method, parameters });
          if (config.exist === 'later') win.__answerYoutube = (exist) => this.respond({ returnValue: true, exist });
          else this.respond({ returnValue: true, exist: config.exist });
        } else if (method === 'launch') {
          win.__luna.push({ method, parameters });
          this.respond(config.launchError === undefined ? { returnValue: true }
            : { returnValue: false, errorCode: config.launchError, errorText: 'The app was not found' });
        } else {
          this.respond({ returnValue: false, errorText: 'unmocked method: ' + method });
        }
      }
      cancel(): void {
        this.onservicecallback = null;
      }
    }
    win.PalmServiceBridge = FakePalmServiceBridge;
  }, tv);
}

const lunaCalls = (page: Page) => page.evaluate(() =>
  (window as unknown as { __luna: Array<{ method: string; parameters: unknown }> }).__luna);

const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
const trailerButton = (page: Page) => page.locator('#view-movies .detail-actions [data-key="trailer"]');

test('the first trailer says it opens in YouTube, later ones open at once', async ({ page }) => {
  await openMovie(page, '10');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-movies .detail-actions .focused')).toHaveAttribute('data-key', 'play');
  await page.keyboard.press('ArrowRight');
  await expect(trailerButton(page)).toHaveClass(/focused/);
  await expect(trailerButton(page)).toHaveAttribute('aria-label', 'Watch trailer');

  await page.keyboard.press('Enter');
  const prompt = page.locator('.confirmation-prompt:not(.hidden)');
  await expect(prompt.locator('.confirmation-title')).toHaveText('Watch on YouTube?');
  await expect(prompt.locator('[data-key="confirm"]')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  expect(await opened(page)).toEqual([`https://www.youtube.com/watch?v=${TRAILER}`]);
  await expect(trailerButton(page)).toHaveClass(/focused/);

  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  expect(await opened(page)).toHaveLength(2);
});

test('canceling the trailer notice opens nothing and asks again next time', async ({ page }) => {
  await openMovie(page, '10');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const prompt = page.locator('.confirmation-prompt:not(.hidden)');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(trailerButton(page)).toHaveClass(/focused/);
  expect(await opened(page)).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(prompt).toBeVisible();
});

test('a pointer click on the trailer opens it once the notice was read', async ({ page }) => {
  await openMovie(page, '10', { noticeSeen: true });
  await trailerButton(page).click();
  await expect.poll(() => opened(page)).toEqual([`https://www.youtube.com/watch?v=${TRAILER}`]);
});

test('a movie without a trailer has no trailer button', async ({ page }) => {
  await openMovie(page, '11');
  await expect(page.locator('#view-movies .detail-actions [data-key="watchlist"]')).toBeVisible();
  await expect(trailerButton(page)).toHaveCount(0);
});

// The app's log lines, so a test can tell the check's answer from its timeout.
function collectLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on('console', (message) => logs.push(message.text()));
  return logs;
}

test('on the TV the trailer waits for the YouTube check, then launches YouTube', async ({ page }) => {
  const logs = collectLogs(page);
  await openMovie(page, '10', { noticeSeen: true, tv: { exist: 'later' } });
  await expect.poll(() => lunaCalls(page)).toEqual([
    { method: 'getAppLoadStatus', parameters: { appId: 'youtube.leanback.v4' } }]);
  await expect(trailerButton(page)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __answerYoutube: (exist: boolean) => void }).__answerYoutube(true));
  // Well inside the check's timeout, which would show the button on its own.
  await expect(trailerButton(page)).toBeVisible({ timeout: 1000 });
  expect(logs.filter((line) => line.includes('event=trailer.youtube'))).toEqual([]);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(trailerButton(page)).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await lunaCalls(page)).slice(1)).toEqual([{ method: 'launch', parameters: {
    id: 'youtube.leanback.v4', params: { contentTarget: `https://www.youtube.com/tv?v=${TRAILER}` },
  } }]);
});

test('a TV without YouTube shows no trailer', async ({ page }) => {
  const logs = collectLogs(page);
  await openMovie(page, '10', { tv: { exist: false } });
  await expect.poll(() => logs.some((line) => line.includes('event=trailer.youtube exist=false'))).toBe(true);
  await expect(page.locator('#view-movies .detail-actions [data-key="watchlist"]')).toBeVisible();
  await expect(trailerButton(page)).toHaveCount(0);
});

test('a launch that finds no YouTube says so and takes the trailer away', async ({ page }) => {
  await openMovie(page, '10', { noticeSeen: true, tv: { exist: true, launchError: -101 } });
  await expect(trailerButton(page)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(trailerButton(page)).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast.visible')).toHaveText("Couldn't open YouTube.");
  await expect(trailerButton(page)).toHaveCount(0);
  await expect(page.locator('#view-movies .detail-actions .focused')).toHaveCount(1);
});
