import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, type Page, pressStepsAndReadPlayer, seedPointer, liveLoaded, startClock, runTimers, afterQueuedTasks, CONFIG } from './helpers';
import { seedXtream } from './fixtures/xtream';

const FOCUS_REPEAT_WINDOW_MS = CONFIG.NAVIGATION.FOCUS_REPEAT_WINDOW_MS;

// A minimal ASS body with one dialogue active from t=0, so assjs renders it as
// soon as it initializes over the (paused, t=0) video.
const SAMPLE_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:05:00.00,Default,,0,0,0,,ASS Cue 1',
  '',
].join('\n');

// Seed one Xtream account (enables the tab bar) and stub the player_api.php
// catalog calls + the get.php/xmltv.php the live path uses. With `subtitles`,
// get_vod_info advertises an SRT sidecar; with `ass`, an ASS sidecar. The routed
// .srt/.ass URLs serve small bodies.
async function seedMovies(
  page: import('@playwright/test').Page,
  opts: { subtitles?: boolean; ass?: boolean; streams?: number; backdrop?: boolean; name?: string } = {},
): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_categories')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ category_id: '1', category_name: 'Cat A' }]) });
    }
    if (url.includes('get_vod_streams')) {
      const streams = opts.streams
        ? Array.from({ length: opts.streams }, (_, i) => (
          { stream_id: 100 + i, name: `Movie ${String(i)}`, stream_icon: '', container_extension: 'mp4', category_id: '1' }))
        : [{ stream_id: 10, name: opts.name ?? 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(streams) });
    }
    if (url.includes('get_vod_info')) {
      const info: Record<string, unknown> = { plot: 'A plot.', duration_secs: 3600 };
      const subs: unknown[] = [];
      if (opts.subtitles) subs.push({ subtitle_id: '1', title: 'Track 1', language: 'l1',
        url: 'http://host.example.com:8080/subs/10.srt' });
      if (opts.ass) subs.push({ subtitle_id: '2', title: 'ASS 1', language: 'l2',
        url: 'http://host.example.com:8080/subs/10.ass' });
      if (subs.length) info.subtitles = subs;
      if (opts.backdrop) info.backdrop_path = ['http://host.example.com:8080/b.jpg'];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  if (opts.subtitles || opts.ass) {
    await page.route('**/subs/**', (route) => {
      if (route.request().url().split('?')[0].endsWith('.ass')) {
        return route.fulfill({ status: 200, contentType: 'text/plain', body: SAMPLE_ASS });
      }
      return route.fulfill({ status: 200, contentType: 'application/x-subrip',
        body: '1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:07,000\nWorld\n' });
    });
  }
  // A 1x1 PNG, so the backdrop preload succeeds.
  if (opts.backdrop) {
    await page.route('**/b.jpg', (route) => route.fulfill({ status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
  }
  // The movie file itself: a small response so play() doesn't hang the test.
  await page.route('**/movie/**', (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

// Chromium before 91 drops a flex scroller's end padding from its scroll
// width. No engine Playwright drives has that quirk, so claim it the way
// src/engine-quirks.ts would on such an engine.
async function claimScrollEndQuirk(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add('q-scroll-end-padding'));
}

test('keeps the focus ring clear of the rail edge at See all', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await claimScrollEndQuirk(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  const seeAll = page.locator('#view-movies .catalog-see-all');
  await expect(seeAll).toHaveClass(/focused/);
  await expect(seeAll).toContainText('30 movies');
  // The ring (2px offset + 3px outline + 6px glow) must sit inside the track.
  await expect.poll(() => seeAll.evaluate((el) => {
    const track = el.parentElement!.getBoundingClientRect();
    return Math.round(track.right - el.getBoundingClientRect().right);
  })).toBeGreaterThanOrEqual(11);
  // On such an engine the room past the last tile must come from content.
  // Drop the padding here to measure what it would scroll to.
  expect(await seeAll.evaluate((el: HTMLElement) => {
    const track = el.parentElement!;
    track.style.paddingRight = '0';
    const room = track.scrollWidth - (el.offsetLeft + el.offsetWidth - track.offsetLeft);
    track.style.paddingRight = '';
    return room;
  })).toBeGreaterThanOrEqual(12);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
});

test('Back to See all jumps straight to it under full animation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  await seedXtream(page, { catalog: 'large' });
  await startClock(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  // Walk the rail with the remote, as a viewer would, so See all is scrolled
  // into view before it opens its grid. Below the screen the rail is still
  // loading; resting on it loads it.
  const rail = page.locator('#view-movies [data-rail-key="cat:4"]');
  await rail.locator('.catalog-tile').first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(rail.locator('.catalog-tile[data-item-id]').first()).toHaveClass(/focused/);
  await rail.locator('.catalog-tile[data-item-id]').first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  const seeAll = page.locator('#view-movies .catalog-see-all[data-category-id="4"]');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await expect(seeAll).toHaveClass(/focused/);
  await expect.poll(() => seeAll.evaluate((el) => {
    const track = el.parentElement!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.left >= track.left && box.right <= track.right && box.top >= 0
      && box.bottom <= window.innerHeight;
  })).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat D');
  // Linger past FOCUS_REPEAT_WINDOW_MS, inside which SpatialNav scrolls
  // instantly anyway, as a held key would.
  await page.clock.runFor(FOCUS_REPEAT_WINDOW_MS * 2);
  // Read the layout in the same task as Back: the resident browse must have
  // the tile in place already, with no scroll left to replay.
  const placement = await page.evaluate(() => {
    const back = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(back, 'keyCode', { get: () => 27 });
    document.dispatchEvent(back);
    const tile = document.querySelector<HTMLElement>('#view-movies .catalog-see-all[data-category-id="4"]')!;
    const track = tile.parentElement!.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    return {
      focused: tile.classList.contains('focused'),
      inTrack: box.left >= track.left && box.right <= track.right,
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });
  expect(placement).toEqual({ focused: true, inTrack: true, onScreen: true });
});

test('loads browse rails only as the remote walks down to them', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  const requested = new Set<string>();
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const category = url.searchParams.get('category_id');
    if (url.searchParams.get('action') === 'get_vod_streams' && category) requested.add(category);
    return route.fallback();
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id="10"]')).toBeVisible();
  // Every rail keeps its place; the ones below the screen wait to load.
  await expect(movies.locator('[data-rail-key^="cat:"]')).toHaveCount(6);
  await expect(movies.locator('[data-rail-key="cat:6"]')).toHaveAttribute('data-rail-pending', '');
  expect(requested.has('6')).toBe(false);
  await page.keyboard.press('ArrowDown');
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id="10"]')).toHaveClass(/focused/);
  for (let rail = 2; rail <= 6; rail++) {
    await page.keyboard.press('ArrowDown');
    await expect(movies.locator(`[data-rail-key="cat:${String(rail)}"] .catalog-tile[data-item-id]`).first())
      .toHaveClass(/focused/);
  }
  expect([...requested].sort()).toEqual(['1', '2', '3', '4', '5', '6']);
  await expect(movies.locator('[data-rail-pending]')).toHaveCount(0);
});

test('holds the rails on screen still when the rail at the top fails', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  let failRail: () => void = () => {};
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'get_vod_streams' || url.searchParams.get('category_id') !== '3') {
      return route.fallback();
    }
    return new Promise<void>((done) => {
      failRail = () => { void route.fulfill({ status: 500, body: '' }).then(done); };
    });
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  const fifth = movies.locator('[data-rail-key="cat:5"] .catalog-tile[data-item-id]').first();
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id]').first()).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(fifth).toHaveClass(/focused/);
  const topOf = () => fifth.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // The rails stand where they stay once every rail but the held one has loaded.
  await expect(movies.locator('[data-rail-pending]')).toHaveCount(1);
  await expect(movies.locator('[data-rail-key="cat:3"]')).toHaveAttribute('data-rail-pending', '');
  // The loading rail is the topmost one on screen, so it anchors the scroll.
  const anchored = await movies.locator('.catalog-rails').evaluate((rails) => {
    const top = rails.getBoundingClientRect().top;
    const first = Array.from(rails.querySelectorAll<HTMLElement>('[data-rail-key]'))
      .find((rail) => rail.getBoundingClientRect().bottom > top);
    return first?.dataset.railKey;
  });
  expect(anchored).toBe('cat:3');
  const before = await topOf();
  failRail();
  await expect(movies.locator('[data-rail-key="cat:3"]')).toHaveCount(0);
  expect(await topOf()).toBe(before);
  await expect(fifth).toHaveClass(/focused/);
});

test('Down from mid-rail steps onto a loading rail and keeps its column', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  let releaseRail: () => void = () => {};
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'get_vod_streams' || url.searchParams.get('category_id') !== '2') {
      return route.fallback();
    }
    return new Promise<void>((done) => { releaseRail = () => { void route.fallback().then(done); }; });
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id]').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id="1004"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(movies.locator('[data-rail-key="cat:2"] [data-key="pending:2:4"]')).toHaveClass(/focused/);
  releaseRail();
  await expect(movies.locator('[data-rail-key="cat:2"] .catalog-tile[data-item-id="2004"]')).toHaveClass(/focused/);
});

test('Back holds the rails still when a rail above failed while a detail was open', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  let failRail: () => void = () => {};
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'get_vod_streams' || url.searchParams.get('category_id') !== '3') {
      return route.fallback();
    }
    return new Promise<void>((done) => {
      failRail = () => { void route.fulfill({ status: 500, body: '' }).then(done); };
    });
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  const fifth = movies.locator('[data-rail-key="cat:5"] .catalog-tile[data-item-id]').first();
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id]').first()).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(fifth).toHaveClass(/focused/);
  const topOf = () => fifth.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // The rails stand where they stay once every rail but the held one has loaded.
  await expect(movies.locator('[data-rail-pending]')).toHaveCount(1);
  await expect(movies.locator('[data-rail-key="cat:3"]')).toHaveAttribute('data-rail-pending', '');
  const before = await topOf();
  await page.keyboard.press('Enter');
  await expect(movies.locator('.catalog-layer-detail')).not.toHaveClass(/catalog-layer-hidden/);
  const failed = page.waitForResponse((r) => r.url().includes('category_id=3'));
  failRail();
  await failed;
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(movies.locator('[data-rail-key="cat:3"]')).toHaveCount(0);
  await expect(fifth).toHaveClass(/focused/);
  expect(await topOf()).toBe(before);
});

test('Back holds the rails still when the detail added the Watchlist rail above', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  const fourth = movies.locator('[data-rail-key="cat:4"] .catalog-tile[data-item-id]').first();
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id]').first()).toBeVisible();
  // Scrolled, with the focused title mid-screen where no reveal moves it.
  const onFourth = () => movies.locator('[data-rail-key="cat:4"] .catalog-rail-track .focused').count();
  for (let i = 0; i < 6 && !(await onFourth()); i++) await page.keyboard.press('ArrowDown');
  await expect(fourth).toHaveClass(/focused/);
  const topOf = () => fourth.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  // The rails stand where they stay once every rail down to the fourth has
  // loaded; those below it load only when scrolled near.
  for (let n = 1; n <= 4; n++) {
    await expect(movies.locator(`[data-rail-key="cat:${n}"]`)).not.toHaveAttribute('data-rail-pending', '');
  }
  const before = await topOf();
  await page.keyboard.press('Enter');
  const watchlist = movies.locator('.catalog-layer-detail .detail-icon-btn[data-key="watchlist"]');
  // The detail re-renders once its info arrives; hover the final button.
  await expect(movies.locator('.detail-plot')).toContainText('A plot.');
  await expect(watchlist).toBeVisible();
  const label = await watchlist.textContent();
  await watchlist.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(watchlist).not.toHaveText(label ?? '');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(movies.locator('[data-rail-key="watchlist"]')).toHaveCount(1);
  await expect(fourth).toHaveClass(/focused/);
  expect(await topOf()).toBe(before);
});

test('a rail that lands under the open sort menu shows once a click closes it', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  let releaseRail: () => void = () => {};
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'get_vod_streams' || url.searchParams.get('category_id') !== '2') {
      return route.fallback();
    }
    return new Promise<void>((done) => { releaseRail = () => { void route.fallback().then(done); }; });
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const movies = page.locator('#view-movies');
  await expect(movies.locator('[data-rail-key="cat:1"] .catalog-tile[data-item-id]').first()).toBeVisible();
  const trigger = movies.locator('.catalog-sort .dropdown-trigger');
  const rail = movies.locator('[data-rail-key="cat:2"]');
  await trigger.click();
  await expect(movies.locator('.catalog-sort .dropdown.open')).toHaveCount(1);
  // The catalog logs the rail's list once it has it, just before handing it on.
  const landed = page.waitForEvent('console', (msg) => /\bfetched \S+\|vod_streams[^|]*\|2 \(/.test(msg.text()));
  releaseRail();
  await landed;
  await afterQueuedTasks(page);
  await expect(rail).toHaveAttribute('data-rail-pending', '');
  await trigger.click();
  await expect(movies.locator('.catalog-sort .dropdown.open')).toHaveCount(0);
  await expect(rail).not.toHaveAttribute('data-rail-pending');
  await expect(rail.locator('.catalog-tile[data-item-id]').first()).toBeAttached();
});

test('the See all of a rail takes Up from its tiles and gives Down back, and Down between rails skips it', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const focusedKey = () => page.locator('#view-movies .focused').getAttribute('data-key');
  const tile = page.locator('#view-movies [data-rail-key="cat:2"] .catalog-tile[data-item-id]').nth(2);
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  const key = await tile.getAttribute('data-key');
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedKey).toBe('see-all:2');
  // Alone on its line, Left and Right keep it.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect.poll(focusedKey).toBe('see-all:2');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedKey).toBe(key);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-movies [data-rail-key="cat:3"] .catalog-rail-track .focused')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat C');
});

test('gives a scroll-end spacer only to flex containers', async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await liveLoaded(page);
  await claimScrollEndQuirk(page);
  // Outside a flex container the spacer is an inline box with margins, which
  // Chromium 53 lays out as an extra line that overflows a fixed-height rail.
  const misplaced = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('*')]
    .filter((el) => {
      const after = getComputedStyle(el, '::after');
      return after.content !== 'none' && after.content !== 'normal' && after.flexBasis === '1px'
        && !/flex/.test(getComputedStyle(el).display);
    })
    .map((el) => el.className));
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies [data-rail-key^="cat:"] .catalog-rail-track').first()).toBeVisible();
  expect(await misplaced()).toEqual([]);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg .epg-date-list')).toBeVisible();
  expect(await misplaced()).toEqual([]);
});

test('browse Movies, open a detail, and start playback', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock movie file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter Movies via the docked tab bar.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await expect(page.locator('#view-movies .catalog-rail-title')).toContainText('Cat A');
  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toContainText('Movie One');

  // Focus the poster and open its detail. Dispatch an explicit bubbling
  // nav:hover so SpatialNav's container-bound listener receives it.
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  // Play, then Back returns to the Movies view.
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Back key (CONFIG.KEYS.BACK = 461). press('Escape') is swallowed by Chromium
  // in this combo, so dispatch a raw keydown like the other specs do.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-movies')).toBeVisible();
  // The detail screen survives the player round-trip (Movies isn't re-rendered on return).
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
});

test('the tab bar turns transparent over catalog art and solid again in Live', async ({ page }) => {
  await seedMovies(page, { backdrop: true });
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  const barBackground = () => page.locator('.tab-bar')
    .evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
  expect(await barBackground()).toBe('none');

  await enterTab(page, 'movies');
  await expect(page.locator('body')).toHaveClass(/tabbar-over-art/);
  expect(await barBackground()).toContain('gradient');

  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  const backdrop = page.locator('#view-movies .detail-backdrop');
  await expect(backdrop).toHaveAttribute('style', /b\.jpg/);
  // The art reaches up under the bar to the top of the screen.
  expect((await backdrop.boundingBox())!.y).toBe(0);
  await expect(page.locator('body')).toHaveClass(/tabbar-over-art/);

  await enterTab(page, 'live');
  await expect(page.locator('body')).not.toHaveClass(/tabbar-over-art/);
  expect(await barBackground()).toBe('none');
});

test('a long title at the largest text size stays clear of the tab bar', async ({ page }) => {
  await seedMovies(page, { backdrop: true, name: 'An Exceptionally Long Movie Title '.repeat(6).trim() });
  await page.addInitScript(() => { localStorage.setItem('iptv_text_size', JSON.stringify('150')); });
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  expect((await page.locator('#view-movies .detail-title').boundingBox())!.y).toBeGreaterThanOrEqual(96);
});

test('Back walks Movies detail -> browse -> Live instead of ejecting', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter Movies via the docked tab bar.
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toContainText('Movie One');

  // Open the movie detail.
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  // First Back steps detail -> browse: still inside Movies, not ejected to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-browse')).toBeVisible();
  await expect(page.locator('#view-channels')).toBeHidden();

  // Second Back from the browse top level returns to Live.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
  await liveLoaded(page);
});

test('Back from a detail finds browse scrolled and focused as it was left', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
  await seedMovies(page, { streams: 20 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await expect(page.locator('html')).toHaveAttribute('data-animation', 'full');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="115"]');
  await expect(tile).toHaveClass(/focused/);
  const track = page.locator('#view-movies .catalog-browse .catalog-rail-track').first();
  // Let the smooth scroll settle before recording where browse was left.
  let left = -1;
  await expect.poll(async () => {
    const now = await track.evaluate((el) => el.scrollLeft);
    const settled = now > 0 && now === left;
    left = now;
    return settled;
  }, { intervals: [150] }).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  // Read in the same task as Back: a rebuilt browse would sit at offset 0
  // and only glide back to the tile afterward.
  const back = await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true }));
    const el = document.querySelector<HTMLElement>('#view-movies .catalog-tile[data-item-id="115"]')!;
    return {
      focused: el.classList.contains('focused'),
      scrollLeft: el.parentElement!.scrollLeft,
    };
  });
  expect(back).toEqual({ focused: true, scrollLeft: left });
});

test('VOD playback suppresses the live channel sidebar and shows a VOD-only menu at the pointer edges', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive in the player: neuter the <video> so the empty mock movie
  // file doesn't fire `error` and eject back to Movies before we probe the edges.
  await neuterVideo(page);
  await startClock(page);
  await page.goto('/');
  await liveLoaded(page);

  // Enter Movies, open a detail, and start playback (VOD mode).
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  // Wait until VOD playback has fully settled (the VOD OSD shows the title and,
  // being paused, stays up) so the pointer probe isn't racing the transition.
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // The left edge opens the channel switcher during live playback; VOD has no
  // channels, so the pointer must not summon it. Check once (not a retrying
  // wait) — the sidebar auto-hides, which would mask a wrong show.
  await seedPointer(page);
  await page.mouse.move(10, 540);
  await runTimers(page, 200);
  expect(await page.locator('#player-sidebar.visible').count()).toBe(0);

  // The right edge opens the VOD menu with playback speed, but never the live
  // channel rows or the "Playing:" channel name.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  await expect(menu).toContainText('Settings');
  await expect(menu).toContainText('Playback Speed');
  expect(await menu.textContent()).not.toContain('Program Guide');
  expect(await menu.textContent()).not.toContain('Toggle Favorite');
  expect(await menu.textContent()).not.toContain('Playing:');

  await menu.locator('[data-menu-action="__speed_open__"]').click();
  await menu.locator('[data-playback-rate="1.5"]').click();
  await expect.poll(() => page.locator('#video-player')
    .evaluate((video: HTMLVideoElement) => video.playbackRate)).toBe(1.5);
});

test('VOD Right opens the menu while the OSD is hidden and seeks while it shows', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  const osd = page.locator('#player-osd');
  await expect(osd.locator('.osd-channel-name')).toBeVisible();

  // With no duration yet canSeek() is false, so OK toggles the (paused, so
  // persistent) OSD off instead of pausing.
  await page.keyboard.press('Enter');
  await expect(osd).toHaveClass(/hidden/);
  await page.locator('#video-player').evaluate((video) => {
    const seeks: number[] = [];
    (window as unknown as { seeks: number[] }).seeks = seeks;
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
    Object.defineProperty(video, 'currentTime', {
      configurable: true, get: () => 0, set: (t: number) => { seeks.push(t); },
    });
  });
  const seeks = () => page.evaluate(() => (window as unknown as { seeks: number[] }).seeks);

  const menu = page.locator('#player-menu');
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  expect(await seeks()).toEqual([]);

  // Right closes the open menu, as during live playback.
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeHidden();
  expect(await seeks()).toEqual([]);

  // OK with the OSD hidden reveals it: canSeek() is false while the OSD is
  // hidden, so OK runs osd.toggle() rather than pausing. With the OSD up,
  // Right marks a seek target, leaves the menu shut, and seeks once the
  // presses settle.
  await page.keyboard.press('Enter');
  await expect(osd).not.toHaveClass(/hidden/);
  await page.keyboard.press('ArrowRight');
  await expect(osd.locator('.osd-scrub-time')).toHaveText('0:10');
  await expect.poll(seeks).toEqual([10]);
  await expect(menu).toBeHidden();
});

async function startFakeVod(page: Page): Promise<void> {
  await seedMovies(page);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate((video: HTMLVideoElement) => {
    let paused = false;
    let time = 0;
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
    Object.defineProperty(video, 'currentTime', {
      configurable: true, get: () => time, set: (t: number) => { time = t; },
    });
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
    video.play = () => { paused = false; return Promise.resolve(); };
    video.pause = () => { paused = true; };
  });
}

// Chromium 53 fires no pointer events: the edge panels must open from mousemove.
test('the pointer at the right edge opens the VOD player menu', async ({ page }) => {
  await startFakeVod(page);
  await seedPointer(page);
  await page.mouse.move(1900, 300);
  await expect(page.locator('#player-menu')).toHaveClass(/visible/);
});

const [ENTER, RIGHT, BACK, YELLOW] = [13, 39, 461, 405];
const SEEK_COMMIT_DELAY_MS = CONFIG.PLAYER.SEEK_COMMIT_DELAY;

test('VOD Back leaves playback even with the OSD up', async ({ page }) => {
  await startFakeVod(page);
  const [shown, left] = await pressStepsAndReadPlayer(page, [[YELLOW], [BACK]]);
  expect(shown).toMatchObject({ osd: true, paused: false });
  expect(left).toMatchObject({ osdBefore: true, player: false });
  await expect(page.locator('#view-movies')).toBeVisible();
});

test('VOD Back drops a pending seek and keeps playing in place', async ({ page }) => {
  await startClock(page);
  await startFakeVod(page);
  const [, marked, dropped] = await pressStepsAndReadPlayer(page, [[YELLOW], [RIGHT, RIGHT], [BACK]]);
  expect(marked).toMatchObject({ osd: true, menu: false, currentTime: 0 });
  expect(dropped).toMatchObject({ osd: true, player: true, currentTime: 0 });
  const osd = page.locator('#player-osd');
  await expect(osd.locator('.osd-scrub')).toHaveCount(0);
  await runTimers(page, SEEK_COMMIT_DELAY_MS * 2); // well past the commit delay
  expect(await page.locator('#video-player').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(0);
});

test('VOD Back hides a paused OSD, so Right reaches the menu, then leaves', async ({ page }) => {
  await startFakeVod(page);
  const [paused, hidden, menu, closed, left] = await pressStepsAndReadPlayer(page, [
    [YELLOW, ENTER], [BACK], [RIGHT], [BACK], [BACK],
  ]);
  expect(paused).toMatchObject({ osd: true, paused: true, currentTime: 0 });
  expect(hidden).toMatchObject({ osdBefore: true, osd: false, player: true, paused: true });
  expect(menu).toMatchObject({ osd: false, menu: true, paused: true, currentTime: 0 });
  expect(closed).toMatchObject({ menu: false, player: true });
  expect(left.player).toBe(false);
  await expect(page.locator('#view-movies')).toBeVisible();
});

test('a VOD sidecar subtitle creates its application track when selected', async ({ page }) => {
  await seedMovies(page, { subtitles: true });
  await routeLiveManifest(page);
  // Keep VOD alive so the neutered <video> doesn't eject before we probe tracks.
  await neuterVideo(page);
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // Sidecars are synthetic picker entries, so the reusable renderer track is
  // not created until the first selection.
  const initialTrackCount = await page.evaluate(() => {
    const v = document.getElementById('video-player') as HTMLVideoElement;
    return v.textTracks.length;
  });
  expect(initialTrackCount).toBe(0);

  // Open the right-edge menu into the Subtitles sub-menu; the sidecar is listed.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu
  await expect(menu).toContainText('Track 1');

  // Select the sidecar; it starts showing and its cues load from the routed SRT.
  await page.keyboard.press('ArrowDown'); // Off -> Track 1
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.evaluate(() => {
    const t = (document.getElementById('video-player') as HTMLVideoElement).textTracks[0];
    return t && t.mode === 'showing' && t.cues
      ? { count: t.cues.length, label: t.label }
      : null;
  })).toEqual({ count: 2, label: 'Track 1' });
});

test('a VOD ASS sidecar renders through the assjs overlay when selected', async ({ page }) => {
  await seedMovies(page, { ass: true });
  await routeLiveManifest(page);
  // Keep VOD alive so the neutered <video> doesn't eject before we probe the overlay.
  await page.addInitScript(() => {
    const P = HTMLMediaElement.prototype;
    P.load = function () { /* no-op */ };
    P.play = function () { return Promise.resolve(); };
    Object.defineProperty(P, 'src', { configurable: true, set() { /* no-op */ }, get() { return ''; } });
  });
  await page.goto('/');
  await liveLoaded(page);

  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('[data-action="play"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();

  // Open the right-edge menu into the Subtitles sub-menu; the ASS sidecar is listed
  // (it never becomes a native <track>, so this proves the synthetic-option path).
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown'); // Title Info -> Settings
  await page.keyboard.press('ArrowDown'); // Settings -> Subtitles
  await page.keyboard.press('Enter');     // open the Subtitles sub-menu
  await expect(menu).toContainText('ASS 1');

  // Select the ASS sidecar; assjs lazily loads and draws its cue into #ass-overlay.
  await page.keyboard.press('ArrowDown'); // Off -> ASS 1
  await page.keyboard.press('Enter');
  await expect(page.locator('#ass-overlay')).toContainText('ASS Cue 1');
});

// Opening a detail with no remembered key focuses its first control in DOM
// order, with no geometry to fall back on, so measurement is the only thing
// keeping focus off a hidden one. A stylesheet rule is the case no selector on
// the element itself can catch, and jsdom applies no CSS.
test('a detail whose first control is hidden focuses the next visible one', async ({ page }) => {
  await seedMovies(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await expect(page.locator('#view-movies')).toBeVisible();

  await page.addStyleTag({
    content: '#view-movies .detail-btn[data-key="play"] { display: none; }',
  });

  await page.locator('.catalog-tile[data-item-id="10"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');

  const focused = await page.evaluate(() =>
    document.querySelector('#view-movies .focused')?.getAttribute('data-key') ?? null);
  expect(focused).toBe('watchlist');
});

// Hover a row, then let the pointer leave it: the highlight hides but focus stays.
async function hoverThenLeave(el: import('@playwright/test').Locator): Promise<void> {
  await el.evaluate((node) => {
    node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
  });
}

test('after the pointer leaves a grid tile, the first key shows it and the next one moves', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = (index: number) => page.locator(`#view-movies [data-grid-index="${String(index)}"] .catalog-tile`);
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowRight');
  await expect(tile(1)).toHaveClass(/\bfocused\b/);
});

test('CH+/CH- leave a pointer-hidden tile hidden in the catalog', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = (index: number) => page.locator(`#view-movies [data-grid-index="${String(index)}"] .catalog-tile`);
  await hoverThenLeave(tile(0));
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);

  // The movies view ignores CH+/CH- (a wheel over the tab bar sends them).
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageDown');
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(tile(0)).toHaveClass(/\bfocused\b/);
});

test('a revealed grid tile keeps its ring after the reveal scrolls the grid', async ({ page }) => {
  await seedMovies(page, { streams: 60 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="100"]')
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');

  const tile = page.locator('#view-movies [data-grid-index="0"] .catalog-tile');
  await hoverThenLeave(tile);
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(0);
  // A wheel with the pointer in a gap scrolls the tile out of view, still rendered.
  const grid = page.locator('#view-movies .catalog-grid');
  const box = await tile.boundingBox();
  if (!box) throw new Error('no layout');
  await grid.evaluate((el, top) => { el.scrollTop = top; }, box.height + 40);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  await expect(tile).toHaveCount(1);

  await page.keyboard.press('ArrowDown');
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeLessThan(box.height);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  await expect(tile).toHaveClass(/\bfocused\b/);
});

test('Up into the tab bar takes the ring off the catalog tile', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="100"]');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await expect(tile).toHaveClass(/\bfocused\b/);

  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .focused')).toHaveCount(0);
});

test('Down from the tab bar rings the remembered control, and Down walks on to a tile', async ({ page }) => {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const tile = page.locator('#view-movies .catalog-tile[data-item-id="100"]');
  await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 4 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .focused')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#view-movies .focused');
  await expect(focused).toHaveCount(1);
  const first = await focused.getAttribute('data-key');
  // All Categories, then the sort row, then the first rail.
  expect(first).toBe('all-categories');
  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveCount(1);
  await expect(focused).not.toHaveAttribute('data-key', first ?? '');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-movies .catalog-tile.focused')).toHaveCount(1);
});

async function upToTabBar(page: Page): Promise<void> {
  for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
}

async function openCategoryGrid(page: Page): Promise<void> {
  await seedMovies(page, { streams: 30 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const seeAll = page.locator('#view-movies .catalog-see-all');
  await seeAll.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
  await expect(gridFocus(page)).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
}

const gridFocus = (page: Page) => page.locator('#view-movies .catalog-grid .catalog-tile.focused');

test.describe('Down from the tab bar resumes Movies as Up left it', () => {
  test('in a category grid', async ({ page }) => {
    await openCategoryGrid(page);
    await upToTabBar(page);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
    await expect(page.locator('#view-movies .catalog-grid #movies-grid-sort .dropdown-trigger')).toHaveClass(/focused/);
    await page.keyboard.press('ArrowDown');
    await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
  });

  test('with the tile it left scrolled half out of view', async ({ page }) => {
    await seedXtream(page, { catalog: 'large' });
    await page.goto('/');
    await liveLoaded(page);
    await enterTab(page, 'movies');
    const tile = page.locator('#view-movies .catalog-tile').first();
    await tile.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await expect(tile).toHaveClass(/\bfocused\b/);
    // Follow the item Up leaves by its key: the catalog can still re-render
    // once the tab bar has the keys, and that drops its parked ring class.
    let key: string | null = null;
    for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
      key = await page.evaluate(() => document.querySelector('#view-movies .focused')?.getAttribute('data-key') ?? null) ?? key;
      await page.keyboard.press('ArrowUp');
    }
    await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
    // Scroll the item it left half under the top edge of the catalog.
    const left = page.locator(`#view-movies [data-key="${key}"]`);
    await expect(left).toHaveCount(1);
    const clipped = await left.evaluate((el) => {
      let scroller = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      if (!scroller) return false;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += top + el.getBoundingClientRect().height / 2;
      return el.getBoundingClientRect().top < scroller.getBoundingClientRect().top;
    });
    expect(clipped).toBe(true);

    await page.keyboard.press('ArrowDown');
    const focused = page.locator('#view-movies .focused');
    await expect(focused).toHaveCount(1);
    await expect.poll(() => focused.evaluate((el) => {
      let scroller = el.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
      return el.getBoundingClientRect().top >= (scroller?.getBoundingClientRect().top ?? 0) - 1;
    })).toBe(true);
  });

  test('in a category grid Search was opened over', async ({ page }) => {
    await openCategoryGrid(page);
    await enterTab(page, 'search');
    await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tab-bar-search.expanded')).toHaveCount(0);
    await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
    await expect(gridFocus(page)).toHaveAttribute('data-item-id', '101');
  });
});

async function openAccountMenuOverMovies(page: Page): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  await routeLiveManifest(page);
  await page.goto('/');
  await liveLoaded(page);
  // Reach Movies from the tab bar with keys alone.
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 8 && !(await page.locator('.tab-bar-item.focused').count()); i++) {
    await page.keyboard.press('ArrowUp');
  }
  for (let i = 0; i < 6 && !(await page.locator('.tab-bar-item[data-section="movies"].focused').count()); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.locator('.tab-bar-item[data-section="movies"].focused')).toHaveCount(1);
  await expect(page.locator('#view-movies .catalog-tile').first()).toBeVisible();
  const avatar = (await page.locator('.account-avatar').boundingBox())!;
  await page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect(page.locator('.account-menu')).toBeVisible();
}

test('a tile lights under the pointer while the account menu stays open', async ({ page }) => {
  await openAccountMenuOverMovies(page);
  const tile = page.locator('#view-movies .catalog-tile').first();
  const box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);

  await expect(tile).toHaveClass(/\bfocused\b/);
  await expect(page.locator('.account-menu')).toBeVisible();
});

test('a tile the pointer left under the account menu stays dark once the menu closes', async ({ page }) => {
  await openAccountMenuOverMovies(page);
  const tile = page.locator('#view-movies .catalog-tile').first();
  const box = (await tile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await expect(tile).toHaveClass(/\bfocused\b/);
  // Off the tiles onto empty catalog space, then the avatar closes the menu.
  await page.mouse.move(960, 300);
  const avatar = (await page.locator('.account-avatar').boundingBox())!;
  await page.mouse.click(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2);
  await expect(page.locator('.account-menu')).toBeHidden();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#view-movies .focused:not(.focused-parked)')).toHaveCount(0);
});

async function openCatalogGrid(page: Page, seed: (page: Page) => Promise<unknown> = async () => {}): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  await seed(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const seeAll = page.locator('#view-movies .catalog-see-all[data-category-id="1"]');
  await seeAll.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
  await expect(page.locator('#view-movies .catalog-grid .catalog-tile.focused')).toHaveCount(1);
}

const sidebarRing = (page: Page) => page.locator('#view-movies .catalog-sidebar-item.focused');
const gridRing = (page: Page) => page.locator('#view-movies .catalog-grid .focused');

test('the grid sidebar stays clear of the grid and switches category on OK', async ({ page }) => {
  await openCatalogGrid(page);
  const title = page.locator('#view-movies .catalog-grid-title');
  const side = (await page.locator('#view-movies .catalog-sidebar').boundingBox())!;
  const cells = page.locator('#view-movies .catalog-grid-cell');
  const first = (await cells.first().boundingBox())!;
  // The grid starts a fixed gap past the sidebar's measured width.
  expect(Math.round(first.x - (side.x + side.width))).toBe(40);
  const lastRight = await cells.evaluateAll(els => Math.max(...els.map(el => el.getBoundingClientRect().right)));
  expect(lastRight).toBeLessThanOrEqual(1920 - 56);

  await page.keyboard.press('ArrowLeft');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:1');
  await page.keyboard.press('ArrowDown');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:2');
  await page.waitForTimeout(600);
  await expect(title).toHaveText('Cat A');
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('Cat B');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:2');
  await expect(page.locator('#view-movies .catalog-sidebar-item.active')).toHaveAttribute('data-sidebar-key', 'side:c:2');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies .catalog-grid .catalog-tile.focused')).toHaveAttribute('data-category-id', '2');
});

test('the grid sidebar hands the keys to the tab bar, the sort row, a detail, and browse and back', async ({ page }) => {
  await openCatalogGrid(page);
  // Up from the first row reaches the tab bar; Down returns to that row.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(sidebarRing(page)).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:1');

  // Left from the sort row's first control returns to the category shown.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-movies .catalog-sort .focused')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:1');

  // A detail opened from the grid returns to its tile, the sidebar beside it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const tile = await gridRing(page).getAttribute('data-key');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .movies-detail .detail-plot')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(gridRing(page)).toHaveAttribute('data-key', tile!);
  await expect(page.locator('#view-movies .catalog-sidebar-item.active')).toHaveAttribute('data-sidebar-key', 'side:c:1');

  // Back from the sidebar leaves the grid for browse, on the See all it came from.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(sidebarRing(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-layer-browse:not(.catalog-layer-hidden) .catalog-see-all.focused'))
    .toHaveAttribute('data-category-id', '1');
});

test('a grid row the header pushes below the screen scrolls in whole, and the first row brings the header back', async ({ page }) => {
  await openCatalogGrid(page, (p) => p.addInitScript(() => localStorage.setItem('iptv_text_size', JSON.stringify('150'))));
  const view = page.locator('#view-movies .catalog-grid');
  const focusedBox = () => page.locator('#view-movies .catalog-grid .catalog-tile.focused').boundingBox();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => {
    const box = (await focusedBox())!;
    return box.y + box.height <= 1080;
  }).toBe(true);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => view.evaluate((el) => el.scrollTop)).toBe(0);
});

test('a scrolling grid sidebar takes no width for a scrollbar', async ({ page }) => {
  await openCatalogGrid(page, (p) => p.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'get_vod_categories') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({ category_id: String(i + 1), category_name: i ? `Cat ${String(i + 1)}` : 'Cat A' }))) });
  }));
  const list = page.locator('#view-movies .catalog-sidebar-list');
  // Headless Chromium hides scrollbars, so the rule hiding the list's is what shows.
  const sizes = await list.evaluate((el: HTMLElement) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    gutter: el.offsetWidth - el.clientWidth,
    scrollbar: getComputedStyle(el).getPropertyValue('scrollbar-width'),
  }));
  expect(sizes.scrolls).toBe(true);
  expect(sizes.gutter).toBe(0);
  if (test.info().project.name === 'chromium') expect(sizes.scrollbar).toBe('none');
});

test('a held key steps the smooth-scrolling grid sidebar without blanking it or dropping the ring', async ({ page }) => {
  await openCatalogGrid(page, async (p) => {
    await p.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
    await p.route('**/player_api.php*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('action') !== 'get_vod_categories') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        Array.from({ length: 40 }, (_, i) => ({ category_id: String(i + 1), category_name: i ? `Cat ${String(i + 1)}` : 'Cat A' }))) });
    });
  });
  await page.keyboard.press('ArrowLeft');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:1');
  // Every frame, a row covers the list's top and the focused row is in the DOM.
  await page.evaluate(() => {
    const win = window as unknown as { __sidebarFaults: string[]; __sidebarSampling: boolean };
    win.__sidebarFaults = [];
    win.__sidebarSampling = true;
    const sample = (): void => {
      if (!win.__sidebarSampling) return;
      const list = document.querySelector<HTMLElement>('#view-movies .catalog-sidebar-list')!;
      const probe = list.getBoundingClientRect().top + 24;
      const covered = Array.from(list.querySelectorAll('.catalog-sidebar-slot')).some((slot) => {
        const r = slot.getBoundingClientRect();
        return r.top <= probe && r.bottom >= probe;
      });
      if (!covered) win.__sidebarFaults.push(`blank top at ${String(list.scrollTop)}`);
      if (!list.querySelector('.catalog-sidebar-item.focused')) win.__sidebarFaults.push(`no ring at ${String(list.scrollTop)}`);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(40);
  }
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:21');
  await page.waitForTimeout(400);
  const faults = await page.evaluate(() => {
    const win = window as unknown as { __sidebarFaults: string[]; __sidebarSampling: boolean };
    win.__sidebarSampling = false;
    return win.__sidebarFaults;
  });
  expect(faults).toEqual([]);
});

test('the grid sidebar keeps the whole ring of its first and a scrolled-to row in view', async ({ page }) => {
  await openCatalogGrid(page, async (p) => {
    await p.addInitScript(() => localStorage.setItem('iptv_text_size', JSON.stringify('150')));
    await p.route('**/player_api.php*', (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('action') !== 'get_vod_categories') return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        Array.from({ length: 40 }, (_, i) => ({ category_id: String(i + 1), category_name: i ? `Cat ${String(i + 1)}` : 'Cat A' }))) });
    });
  });
  // The ring's glow reaches past the row; the list clips whatever passes its padding box.
  const ringClearance = () => page.evaluate(() => new Promise<{ top: number; bottom: number }>((resolve) => {
    setTimeout(() => {
      const list = document.querySelector('#view-movies .catalog-sidebar-list')!.getBoundingClientRect();
      const ring = document.querySelector('#view-movies .catalog-sidebar-item.focused')!.getBoundingClientRect();
      resolve({ top: ring.top - list.top, bottom: list.bottom - ring.bottom });
    }, 400);
  }));
  await page.keyboard.press('ArrowLeft');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:1');
  expect((await ringClearance()).top).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:26');
  expect((await ringClearance()).bottom).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp');
  await expect(sidebarRing(page)).toHaveAttribute('data-sidebar-key', 'side:c:14');
  expect((await ringClearance()).top).toBeGreaterThanOrEqual(3);
});
