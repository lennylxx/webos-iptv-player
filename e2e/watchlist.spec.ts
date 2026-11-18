import {
  test,
  expect,
  routeLiveManifest,
  neuterVideo,
  SAMPLE_M3U,
  enterTab,
  readUserDataStore,
  type Page,
} from './helpers';

// Resume, Play, and the round title actions share one row and one midline.
const DETAIL_ACTIONS = '#view-movies .detail-btn[data-action="resume"], #view-movies .detail-btn[data-action="play"], #view-movies .detail-icon-circle';

function midlines(els: Element[]): number[] {
  return els.map((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

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
  return (await readUserDataStore<SeedWatchlistEntry>(page, 'watchlist'))
    .map(record => record.value);
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
  await expect.poll(async () =>
    (await storedWatchlist(page)).map((entry) => `${entry.kind}:${entry.itemId}`))
    .toEqual(['vod:10']);
  await page.locator('#view-movies [data-action="watchlist"]').click();
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toContainText('Add to Watchlist');
  await expect.poll(() => storedWatchlist(page)).toEqual([]);

  await enterTab(page, 'series');
  await focusAndSelect(page, '#view-series .catalog-tile[data-item-id="1"]');
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Add to Watchlist');
  await page.locator('#view-series [data-action="watchlist"]').click();
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Remove from Watchlist');
  await expect.poll(async () =>
    (await storedWatchlist(page)).map((entry) => `${entry.kind}:${entry.itemId}`))
    .toEqual(['series:1']);
  await page.locator('#view-series [data-action="watchlist"]').click();
  await expect(page.locator('#view-series [data-action="watchlist"]')).toContainText('Add to Watchlist');
  await expect.poll(() => storedWatchlist(page)).toEqual([]);
});

test('shows Resume on return, keeps playback actions aligned, and offers progress removal', async ({ page }) => {
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
  const actions = page.locator(DETAIL_ACTIONS);
  await expect(actions).toHaveCount(6);
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toContainText('Remove from Continue Watching');
  expect(spread(await actions.evaluateAll(midlines))).toBeLessThanOrEqual(1);
  const textButtons = await page.locator('#view-movies .detail-btn').evaluateAll((buttons) => buttons.map((button) => ({
    height: (button as HTMLElement).offsetHeight,
    whiteSpace: getComputedStyle(button).whiteSpace,
  })));
  expect(new Set(textButtons.map((item) => item.height)).size).toBe(1);
  expect(textButtons.every((item) => item.whiteSpace === 'nowrap')).toBe(true);
});

test('keeps pseudo-localized detail actions unclipped, wrapping the round ones whole and flush', async ({ page }) => {
  await seedWatchlistCatalog(page, [movieEntry('10', 'Movie One', 1000)]);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_resume', JSON.stringify({
      'x1|vod|10': {
        accountId: 'x1',
        kind: 'vod',
        itemId: '10',
        name: 'Movie One',
        poster: '',
        ext: 'mp4',
        position: 20,
        duration: 120,
        updatedAt: 1000,
      },
    }));
  });
  await routeLiveManifest(page);
  await page.goto('/?pseudo=1');

  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies [data-watchlist-item="10"]');

  const actions = page.locator(DETAIL_ACTIONS);
  await expect(actions).toHaveCount(6);
  await expect(actions.first()).toContainText('[!!');
  const layout = await page.locator('#view-movies .detail-actions').evaluate((row) => ({
    clientWidth: row.clientWidth,
    scrollWidth: row.scrollWidth,
    buttons: Array.from(row.querySelectorAll<HTMLElement>('.detail-btn')).map((button) => ({
      clientWidth: button.clientWidth,
      scrollWidth: button.scrollWidth,
    })),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  expect(layout.buttons.every(button => button.scrollWidth <= button.clientWidth + 1)).toBe(true);
  const circles = page.locator('#view-movies .detail-icon-circle');
  expect(spread(await circles.evaluateAll(midlines))).toBeLessThanOrEqual(1);
  // Wrapped, the round actions start their own line flush with Resume.
  const placed = await page.locator('#view-movies .detail-actions').evaluate((row) => {
    const resume = (row.querySelector('[data-action="resume"]') as HTMLElement).offsetTop;
    const circle = row.querySelector('.detail-icon-circle')!.getBoundingClientRect();
    return { below: (row.querySelector('.detail-icon-row') as HTMLElement).offsetTop > resume,
      rowLeft: row.getBoundingClientRect().left, circleLeft: circle.left };
  });
  // Where a row is short of room for the names, it starts a line of its own.
  if (placed.below) expect(placed.circleLeft).toBeCloseTo(placed.rowLeft, 0);
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toBeVisible();
});

async function seedResumedMovie(page: Page): Promise<void> {
  await seedWatchlistCatalog(page, [movieEntry('10', 'Movie One', 1000)]);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_resume', JSON.stringify({
      'x1|vod|10': {
        accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '',
        ext: 'mp4', position: 20, duration: 120, updatedAt: 1000,
      },
    }));
  });
  await routeLiveManifest(page);
}

test('at the largest text size an opening name neither moves the round actions to another line nor is cut', async ({ page }) => {
  await seedResumedMovie(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
    localStorage.setItem('iptv_animation_mode', JSON.stringify('essential'));
  });
  await page.goto('/?pseudo=1');
  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies [data-watchlist-item="10"]');
  await expect(page.locator('#view-movies .detail-plot')).toBeVisible();
  await expect(page.locator('#view-movies .detail-icon-circle')).toHaveCount(4);
  // Each circle's midline against Play's, so a scroll can't pass for a wrap.
  const offsets = () => page.locator('#view-movies .detail-actions').evaluate((row) => {
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const play = mid(row.querySelector('[data-action="play"]')!);
    return Array.from(row.querySelectorAll('.detail-icon-circle')).map((el) => Math.round(mid(el) - play));
  });
  const rest = await offsets();
  // Long names put the round actions on a line of their own, below Resume.
  const keysTo = async (action: string, key: string) => {
    await page.keyboard.press(key);
    await expect(page.locator(`#view-movies [data-action="${action}"]`)).toHaveClass(/\bfocused\b/);
  };
  // Left from Resume stays on its line, past the round actions wrapped below.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-movies [data-action="resume"]')).toHaveClass(/\bfocused\b/);
  await keysTo('play', 'ArrowRight');
  // Down from Play enters the wrapped row at its start, never at Remove below Play.
  for (const [action, key] of [['watchlist', 'ArrowDown'], ['watched', 'ArrowRight'], ['hide', 'ArrowRight'], ['remove-resume', 'ArrowRight']]) {
    await keysTo(action, key);
    expect(await offsets()).toEqual(rest);
    const label = await page.locator(`#view-movies [data-action="${action}"] .detail-icon-label`)
      .evaluate((el) => ({ right: el.getBoundingClientRect().right, cut: el.scrollWidth > el.clientWidth + 1 }));
    expect(label.right).toBeLessThanOrEqual(1920);
    expect(label.cut).toBe(false);
  }
});

async function openResumedMovie(page: Page, animation?: 'full' | 'essential'): Promise<void> {
  await seedResumedMovie(page);
  if (animation) {
    await page.addInitScript((mode) => localStorage.setItem('iptv_animation_mode', JSON.stringify(mode)), animation);
  }
  await page.goto('/');
  await enterTab(page, 'movies');
  await focusAndSelect(page, '#view-movies [data-watchlist-item="10"]');
  // Measure only once the loaded info has laid the row out where it stays.
  await expect(page.locator('#view-movies .detail-plot')).toContainText('Movie 10 plot.');
  await expect(page.locator('#view-movies .detail-icon-circle')).toHaveCount(4);
}

const circleOf = (action: string) => `#view-movies [data-action="${action}"] .detail-icon-circle`;

async function circleCenter(page: Page, action: string): Promise<{ x: number; y: number }> {
  return page.locator(circleOf(action)).evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function actionAt(page: Page, point: { x: number; y: number }): Promise<string | null> {
  return page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('[data-action]')?.getAttribute('data-action') ?? null, point);
}

test('every name in a row opens to the longest one\'s width, with the keys and the pointer alike', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  const nameWidth = (action: string) => page.locator(`#view-movies [data-action="${action}"] .detail-icon-label`)
    .evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
  const restHide = (await circleCenter(page, 'hide')).x;

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toHaveClass(/focused/);
  // The closed names' own widths; Remove from Continue Watching is the longest.
  const longest = await page.locator('#view-movies .detail-icon-btn:not(.focused) .detail-icon-label')
    .evaluateAll((labels) => Math.max(...labels.map((el) => el.scrollWidth)));
  expect(longest).toBeGreaterThan(100);
  expect(await nameWidth('watchlist')).toBeCloseTo(longest, 0);
  expect((await circleCenter(page, 'hide')).x).toBeGreaterThan(restHide + longest);

  await page.mouse.move(960, 950);
  await page.mouse.move(970, 950);
  const hide = await circleCenter(page, 'hide');
  await page.mouse.move(hide.x, hide.y, { steps: 4 });
  await expect(page.locator('#view-movies [data-action="hide"]')).toHaveClass(/focused/);
  expect(await nameWidth('hide')).toBeCloseTo(longest, 0);
});

test('the pointer moving from a long name to a short one under full animation stays on its target', async ({ page }) => {
  await openResumedMovie(page, 'full');
  await page.mouse.move(960, 950);
  const watched = await circleCenter(page, 'watched');
  await page.mouse.move(watched.x, watched.y, { steps: 4 });
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  await page.waitForTimeout(400);
  // Resting between the open name and the next circle keeps the name open.
  const hideBefore = await circleCenter(page, 'hide');
  const between = { x: hideBefore.x - 31 - 6, y: hideBefore.y };
  await page.mouse.move(between.x, between.y, { steps: 2 });
  await page.waitForTimeout(400);
  expect(await actionAt(page, between)).toBe('watched');
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  expect(await circleCenter(page, 'hide')).toEqual(hideBefore);
  const hide = await circleCenter(page, 'hide');
  await page.mouse.move(hide.x, hide.y, { steps: 2 });
  await expect(page.locator('#view-movies [data-action="hide"]')).toHaveClass(/focused/);
  await page.waitForTimeout(400);
  expect(await actionAt(page, hide)).toBe('hide');
  await expect(page.locator('#view-movies [data-action="hide"]')).toHaveClass(/focused/);
});

test('a pointer slipping off a round action keeps its name open long enough to reach the next one', async ({ page }) => {
  await openResumedMovie(page);
  await page.mouse.move(960, 950);
  const watched = await circleCenter(page, 'watched');
  await page.mouse.move(watched.x, watched.y, { steps: 3 });
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  await page.waitForTimeout(400);
  const hide = await circleCenter(page, 'hide');
  // A wobble off the row above the open name.
  await page.mouse.move(hide.x - 120, hide.y - 60, { steps: 2 });
  expect(await circleCenter(page, 'hide')).toEqual(hide);
  await page.mouse.move(hide.x, hide.y, { steps: 2 });
  await expect(page.locator('#view-movies [data-action="hide"]')).toHaveClass(/focused/);
  expect(await actionAt(page, hide)).toBe('hide');
  // Off the row for good, the name closes.
  await page.mouse.move(960, 950, { steps: 2 });
  await expect.poll(() => page.locator('#view-movies [data-action="hide"] .detail-icon-label')
    .evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
});

test('marking a resumed movie watched refits its open name to the row that remains', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toHaveCount(0);
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  // The open name is exactly as wide as the longest name still in the row.
  const fit = await page.locator('#view-movies .detail-icon-row').evaluate((row) => {
    const texts = Array.from(row.querySelectorAll('.detail-icon-label')).map((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getBoundingClientRect().width;
    });
    const open = row.querySelector<HTMLElement>('.focused .detail-icon-label')!;
    const style = getComputedStyle(open);
    return {
      open: open.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      longest: Math.max(...texts),
    };
  });
  expect(Math.abs(fit.open - fit.longest)).toBeLessThanOrEqual(2);
});

test('a focused round action that is on still shows a ring apart from its fill', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  // On the Watchlist already, so its circle is on.
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toHaveClass(/\bon\b/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toHaveClass(/\bfocused\b/);
  await page.waitForTimeout(400);
  const colors = await page.locator(circleOf('watchlist')).evaluate((el) => {
    const style = getComputedStyle(el);
    return { ring: style.borderTopColor, fill: style.backgroundColor };
  });
  expect(colors.ring).not.toBe(colors.fill);
});

test('a name opened before the text grew fits again when the keys come back from the tab bar', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  // The longest name, so a fit left over from the smaller text would cut it.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toHaveClass(/focused-parked/);
  await page.evaluate(() => { document.documentElement.dataset.textSize = '130'; });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-movies [data-action="remove-resume"]')).toHaveClass(/focused/);
  const cut = await page.locator('#view-movies [data-action="remove-resume"] .detail-icon-label')
    .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(cut).toBe(false);
});

test('a name still opening when the next one takes focus switches at once', async ({ page }) => {
  await openResumedMovie(page, 'full');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="play"]')).toHaveClass(/focused/);
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  const widths = await page.evaluate(() => new Promise<number[]>((resolve) => requestAnimationFrame(() =>
    resolve(['watchlist', 'watched'].map((action) =>
      document.querySelector(`#view-movies [data-action="${action}"] .detail-icon-label`)!.getBoundingClientRect().width)))));
  const slot = await page.locator('#view-movies .detail-icon-row')
    .evaluate((row) => parseFloat(row.style.getPropertyValue('--name-width')) + 22);
  expect(widths[0]).toBe(0);
  expect(widths[1]).toBeCloseTo(slot, 0);
});

test('the round actions share Play\'s line wherever there is just room, on either engine', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  // Narrow the actions to exactly what Resume, Play, and the round row need.
  const fits = await page.locator('#view-movies .detail-actions').evaluate((row) => {
    const play = row.querySelector('[data-action="play"]')!.getBoundingClientRect();
    const icons = row.querySelector<HTMLElement>('.detail-icon-row')!;
    // The flex gap plus Play's own margin keep the two groups 24px apart.
    const need = play.right - row.getBoundingClientRect().left + 24 + parseFloat(getComputedStyle(icons).minWidth);
    row.style.maxWidth = `${Math.ceil(need) + 1}px`;
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    return new Promise<boolean>((resolve) => requestAnimationFrame(() =>
      resolve(Math.abs(mid(icons) - mid(row.querySelector('[data-action="play"]')!)) < 2)));
  });
  expect(fits).toBe(true);
});

test('picking up the pointer after the keys moves no round action', async ({ page }) => {
  await openResumedMovie(page, 'essential');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-movies [data-action="watched"]')).toHaveClass(/focused/);
  const before = await circleCenter(page, 'hide');
  await page.mouse.move(960, 950);
  await page.mouse.move(970, 950);
  await expect(page.locator('html')).not.toHaveClass(/keyboard-nav/);
  expect(await circleCenter(page, 'hide')).toEqual(before);
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
  await expect.poll(async () =>
    (await storedWatchlist(page)).map((entry) => entry.itemId))
    .toEqual(['11']);
  await expect(page.locator('#player-osd .osd-next-episode')).toContainText('Movie Two');
  await expect(page.locator('#player-osd .osd-next-episode')).toHaveCount(0);
  await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Movie Two');

  await finishCurrentVideo(page);
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect.poll(() => storedWatchlist(page)).toEqual([]);
});

test('auto-plays the next episode and removes a series only after its final episode', async ({ page }) => {
  await seedWatchlistCatalog(page, [seriesEntry()]);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.goto('/');

  await enterTab(page, 'series');
  await focusAndSelect(page, '#view-series .catalog-tile[data-item-id="1"]');
  await focusAndSelect(page, '#view-series .episode-row[data-episode-id="101"]');
  await expect(page.locator('#player-osd .osd-vod-detail')).toContainText('Episode One');

  await finishCurrentVideo(page);
  await expect.poll(async () =>
    (await storedWatchlist(page)).map((entry) => entry.itemId))
    .toEqual(['1']);
  await expect(page.locator('#player-osd .osd-next-episode')).toContainText('Episode Two');
  await expect(page.locator('#player-osd .osd-next-episode')).toHaveCount(0);
  await expect(page.locator('#player-osd .osd-vod-detail')).toContainText('Episode Two');

  await finishCurrentVideo(page);
  await expect(page.locator('#view-series')).toBeVisible();
  await expect.poll(() => storedWatchlist(page)).toEqual([]);
});
