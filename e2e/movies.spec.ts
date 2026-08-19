import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab } from './helpers';

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
  opts: { subtitles?: boolean; ass?: boolean } = {},
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' },
      ]) });
    }
    if (url.includes('get_vod_info')) {
      const info: Record<string, unknown> = { plot: 'A plot.', duration_secs: 3600 };
      const subs: unknown[] = [];
      if (opts.subtitles) subs.push({ subtitle_id: '1', title: 'Track 1', language: 'l1',
        url: 'http://host.example.com:8080/subs/10.srt' });
      if (opts.ass) subs.push({ subtitle_id: '2', title: 'ASS 1', language: 'l2',
        url: 'http://host.example.com:8080/subs/10.ass' });
      if (subs.length) info.subtitles = subs;
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

test('browse Movies, open a detail, and start playback', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive so the empty mock movie file doesn't fire `error` and
  // auto-eject the player, which would race this test's own Back navigation.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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

test('Back walks Movies detail -> browse -> Live instead of ejecting', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(page.locator('#view-channels')).toBeVisible();
});

test('VOD playback suppresses the live channel sidebar and shows a VOD-only menu at the pointer edges', async ({ page }) => {
  await seedMovies(page);
  await routeLiveManifest(page);
  // Keep VOD alive in the player: neuter the <video> so the empty mock movie
  // file doesn't fire `error` and eject back to Movies before we probe the edges.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await page.mouse.move(10, 540);
  await page.waitForTimeout(200);
  expect(await page.locator('#player-sidebar.visible').count()).toBe(0);

  // The right edge opens the menu for VOD too, but as the VOD variant: Title
  // Info and Settings only (this VOD exposes no audio/subtitle tracks) — never
  // the live channel rows or the "Playing:" channel name.
  await page.mouse.move(1900, 540);
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Title Info');
  await expect(menu).toContainText('Settings');
  expect(await menu.textContent()).not.toContain('Program Guide');
  expect(await menu.textContent()).not.toContain('Toggle Favorite');
  expect(await menu.textContent()).not.toContain('Playing:');
});

test('a VOD sidecar subtitle attaches as a native text track and loads its cues when selected', async ({ page }) => {
  await seedMovies(page, { subtitles: true });
  await routeLiveManifest(page);
  // Keep VOD alive so the neutered <video> doesn't eject before we probe tracks.
  await neuterVideo(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

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

  // The sidecar becomes a real subtitles text track on the <video>, off by default.
  const attached = await page.evaluate(() => {
    const v = document.getElementById('video-player') as HTMLVideoElement;
    const t = v.textTracks[0];
    return t ? { count: v.textTracks.length, label: t.label, kind: t.kind, mode: t.mode } : null;
  });
  expect(attached).toEqual({ count: 1, label: 'Track 1', kind: 'subtitles', mode: 'disabled' });

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
    return t.mode === 'showing' && t.cues ? t.cues.length : 0;
  })).toBe(2);
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
  await expect(page.locator('#view-channels')).toBeVisible();

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
  await expect(page.locator('#view-channels')).toBeVisible();
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
