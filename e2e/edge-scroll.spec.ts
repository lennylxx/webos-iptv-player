import {
  liveLoaded,
  test,
  expect,
  enterTab,
  neuterVideo,
  routeLiveManifest,
  routePlaylist,
  seedPlaylist,
  type Page,
} from './helpers';
import type { Locator } from '@playwright/test';
import type { ResumeEntry, WatchlistEntry } from '../src/types';

// Pointer edge-hover scrolling: a horizontal track marked data-edge-scroll
// scrolls itself while the pointer rests near one of its ends, after a dwell,
// and stops on anything that is not that pointer resting there.

const EDGE_INSET = 20;
const DWELL_MS = 400;
const DWELL_PROBE_MS = 150;
const STILL_MS = 800;
// The controller eases from 600px/s up to 2400px/s; anything well past the
// top speed is extra motion (stacked smooth scrolls or hover-driven
// scrollIntoView) riding along.
const MAX_RATE = 3000;
const MIN_RATE = 450;
type EdgeSide = 'left' | 'right' | 'outer-left' | 'outer-right';

const left = (track: Locator): Promise<number> => track.evaluate((el) => el.scrollLeft);
const maxLeft = (track: Locator): Promise<number> =>
  track.evaluate((el) => el.scrollWidth - el.clientWidth);
const ownerScope = (page: Page) =>
  page.locator('[data-ring-owner]').getAttribute('data-focus-scope');

// What a stray scroll of the page itself, rather than the pointed track, would move.
const pageScroll = (page: Page) => page.evaluate(() => ({
  x: window.scrollX,
  y: window.scrollY,
  root: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
  rails: Array.from(document.querySelectorAll('.catalog-rails')).map((el) => el.scrollTop),
}));

async function expectEdgeTrack(track: Locator): Promise<void> {
  await expect(track).toBeVisible();
  await expect(track).toHaveAttribute('data-edge-scroll');
  expect(await maxLeft(track), 'the track must overflow to scroll').toBeGreaterThan(40);
}

// The part of the track on screen: the edge zones sit inside it.
async function visibleBox(track: Locator) {
  return track.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: Math.max(r.left, 0),
      right: Math.min(r.right, window.innerWidth),
      top: Math.max(r.top, 0),
      bottom: Math.min(r.bottom, window.innerHeight),
    };
  });
}

// Genuine mouse movement onto the track's left/right edge zone or its middle.
async function pointAt(
  page: Page,
  track: Locator,
  where: EdgeSide | 'center',
): Promise<{ x: number; y: number }> {
  const box = await visibleBox(track);
  const x = where === 'outer-left' ? 1 : where === 'outer-right' ? 1918
    : where === 'left' ? box.left + EDGE_INSET
    : where === 'right' ? box.right - EDGE_INSET : (box.left + box.right) / 2;
  const y = Math.round((box.top + box.bottom) / 2);
  await page.mouse.move(x, y, { steps: 4 });
  return { x, y };
}

// A small real movement that stays inside the same edge zone.
async function nudge(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y - 3);
  await page.mouse.move(at.x, at.y);
}

async function expectScrolling(track: Locator, dir: 'left' | 'right', from: number, by = 24): Promise<number> {
  await expect.poll(() => left(track), { timeout: 5000 })[dir === 'right' ? 'toBeGreaterThan' : 'toBeLessThan'](
    dir === 'right' ? from + by : from - by);
  return left(track);
}

// Moves at the controller's own speed: not stacked with other motion, and not
// held back by a re-render undoing its writes. The floor applies only while
// enough track remains to keep moving for the whole sample.
// A rail bleeds to the screen's left edge while its first poster rests on
// the 80px keyline, and its scrollbar starts there too.
async function expectLeftBleed(track: Locator): Promise<void> {
  const geometry = await track.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const first = el.querySelector('.catalog-tile')!.getBoundingClientRect();
    return { left: box.left, right: box.right, first: first.left - box.left + el.scrollLeft };
  });
  expect(geometry.left, 'the rail bleeds to the left edge').toBe(0);
  expect(geometry.right, 'the rail reaches the right edge').toBeGreaterThanOrEqual(1912);
  expect(Math.round(geometry.first), 'the first poster rests on the keyline').toBe(80);
}

async function expectSteadyRate(page: Page, track: Locator): Promise<void> {
  const from = await left(track);
  const room = await maxLeft(track) - from;
  const started = Date.now();
  await page.waitForTimeout(500);
  const moved = Math.abs(await left(track) - from);
  const rate = (moved * 1000) / (Date.now() - started);
  expect(rate, 'edge scroll ran faster than its own speed').toBeLessThan(MAX_RATE);
  expect(moved).toBeGreaterThan(0);
  if (room > 600) expect(rate, 'edge scroll fell behind its own speed').toBeGreaterThan(MIN_RATE);
}

// The box stops moving once a sliding panel has come to rest.
async function expectAtRest(track: Locator): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const now = await track.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return `${String(r.left)},${String(r.top)}`;
    });
    const settled = now === last;
    last = now;
    return settled;
  }, { intervals: [100] }).toBe(true);
}

// Settles within a couple of samples (a continuous scroll never does, and
// stacked smooth scrolls would keep drifting), then holds while the pointer
// stays where it is.
async function expectStopped(page: Page, track: Locator): Promise<number> {
  let last = Number.NaN;
  await expect.poll(async () => {
    const now = await left(track);
    const settled = now === last;
    last = now;
    return settled;
  }, { intervals: [150], timeout: 5000 }).toBe(true);
  await page.waitForTimeout(STILL_MS);
  expect(await left(track), 'the track restarted without real pointer movement').toBe(last);
  return last;
}

// Inside the edge, the dwell holds the track still before it moves. Hovering
// a clipped tab may first bring it into view once, so compare two samples
// taken inside the dwell rather than the position before the move.
async function enterEdgeAndDwell(page: Page, track: Locator, side: EdgeSide) {
  const at = await pointAt(page, track, side);
  const arrived = Date.now();
  let from = await left(track);
  while (Date.now() - arrived < DWELL_MS - 60) {
    await page.waitForTimeout(40);
    const now = await left(track);
    if (now === from) break;
    from = now;
  }
  const spare = DWELL_MS - 60 - (Date.now() - arrived);
  if (spare > 80) {
    await page.waitForTimeout(Math.min(DWELL_PROBE_MS, spare));
    expect(await left(track), 'the track scrolled before the dwell').toBe(from);
  }
  return { at, from };
}

// One Xtream account with `categories` movie and series categories of
// `perCategory` titles each, and `channels` live channels. Search matches all
// of them for "alpha".
async function seedCatalog(
  page: Page,
  opts: { categories?: number; perCategory?: number; channels?: number } = {},
): Promise<void> {
  const categories = opts.categories ?? 4;
  const perCategory = opts.perCategory ?? 30;
  const channels = opts.channels ?? 2;
  const m3u = ['#EXTM3U', ...Array.from({ length: channels }, (_, i) => [
    `#EXTINF:-1 tvg-id="ch${String(i)}" group-title="News",Alpha Channel ${String(i)}`,
    `http://streams.example.com/ch${String(i)}.m3u8`,
  ]).flat()].join('\n');
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: m3u }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const category = url.searchParams.get('category_id');
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const cats = Array.from({ length: categories }, (_, i) =>
      ({ category_id: String(i + 1), category_name: `Cat ${String(i + 1)}` }));
    const ids = category ? [category] : cats.map((c) => c.category_id);
    const each = <T>(make: (cid: string, i: number) => T): T[] =>
      ids.flatMap((cid) => Array.from({ length: perCategory }, (_, i) => make(cid, i)));
    if (action === 'get_vod_categories' || action === 'get_series_categories') return json(cats);
    if (action === 'get_vod_streams') {
      return json(each((cid, i) => ({ stream_id: Number(cid) * 1000 + i,
        name: `Alpha Movie ${cid}-${String(i)}`, stream_icon: '', container_extension: 'mp4', category_id: cid })));
    }
    if (action === 'get_series') {
      return json(each((cid, i) => ({ series_id: Number(cid) * 1000 + i,
        name: `Alpha Series ${cid}-${String(i)}`, cover: '', category_id: cid })));
    }
    // Live channels then come from get.php.
    return json({});
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
  });
}

// Thirty Continue Watching and Watchlist entries per kind, as in
// catalog-collections.spec.ts.
async function seedCollections(page: Page, count = 30): Promise<void> {
  await page.addInitScript((n) => {
    if (localStorage.getItem('edge_collection_fixture')) return;
    localStorage.setItem('edge_collection_fixture', '1');
    const watchlist: Record<string, WatchlistEntry> = {};
    const resume: Record<string, ResumeEntry> = {};
    for (const kind of ['vod', 'series'] as const) {
      for (let i = 0; i < n; i++) {
        const itemId = `${kind}${String(i)}`;
        watchlist[`x1|${kind}|${itemId}`] = {
          accountId: 'x1', kind, itemId, name: `Title ${String(i)}`, poster: '',
          rating: '', categoryId: '1', containerExtension: 'mp4', addedAt: n - i,
        };
      }
    }
    for (const kind of ['vod', 'episode'] as const) {
      for (let i = 0; i < n; i++) {
        const itemId = `${kind}${String(i)}`;
        resume[`x1|${kind}|${itemId}`] = {
          accountId: 'x1', kind, itemId, name: `Title ${String(i)}`, poster: '', ext: 'mp4',
          categoryId: '1', position: 100, duration: 600, updatedAt: n - i,
        };
      }
    }
    localStorage.setItem('iptv_watchlist', JSON.stringify(watchlist));
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  }, count);
}

// `count` URL playlists, each its own group of channels, so the Live and
// player-sidebar playlist tabs overflow.
const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWX';
async function seedPlaylists(page: Page, count = 24): Promise<void> {
  await page.route('**/p*.m3u', (route) => {
    const index = Number(/p(\d+)\.m3u/.exec(route.request().url())?.[1] ?? '0');
    const body = ['#EXTM3U', ...[0, 1].map((j) => [
      `#EXTINF:-1 group-title="Group ${GROUP_LETTERS[index]}",Channel ${String(index)}-${String(j)}`,
      `http://streams.example.com/${String(index)}-${String(j)}.m3u8`,
    ]).flat()].join('\n');
    return route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body });
  });
  await page.addInitScript((n) => {
    localStorage.setItem('iptv_playlists', JSON.stringify(Array.from({ length: n }, (_, i) =>
      ({ name: `Playlist ${String(i)}`, url: `http://host/p${String(i)}.m3u` }))));
  }, count);
}

for (const section of ['movies', 'series'] as const) {
  test(`${section}: Continue Watching and Watchlist rails scroll on a dwell, reverse, and stop without activating`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await seedCatalog(page);
    await seedCollections(page);
    // Movies also covers a light theme at the largest text size.
    if (section === 'movies') {
      await page.addInitScript(() => {
        localStorage.setItem('iptv_theme', JSON.stringify('paper-light'));
        localStorage.setItem('iptv_text_size', JSON.stringify('150'));
      });
    }
    await page.goto('/');
    await liveLoaded(page);
    await enterTab(page, section);
    const view = page.locator(`#view-${section}`);
    const resume = view.locator('[data-rail-key="continue"] .catalog-rail-track');
    const watchlist = view.locator('[data-rail-key="watchlist"] .catalog-rail-track');
    await expect(resume.locator('.catalog-tile')).toHaveCount(21);
    await expectEdgeTrack(resume);
    await expectEdgeTrack(watchlist);
    await expectLeftBleed(resume);
    const scope = await ownerScope(page);
    const before = await pageScroll(page);

    await pointAt(page, resume, 'center');
    await expectScrolling(resume, 'right', (await enterEdgeAndDwell(page, resume, 'outer-right')).from);
    const fullWidth = await visibleBox(resume);
    expect(fullWidth.left, 'no unused gutter beside the rail').toBe(0);
    expect(fullWidth.right, 'the rail reaches the viewport scrollbar').toBeGreaterThanOrEqual(1912);
    await expectSteadyRate(page, resume);
    await expect.poll(() => left(resume), { timeout: 10_000 }).toBeGreaterThan(400);
    await page.screenshot({ path: testInfo.outputPath(
      section === 'movies' ? 'movies-paper-light-150-edge-scroll.png' : 'series-edge-scroll.png') });
    expect(await left(watchlist), 'only the pointed rail scrolls').toBe(0);

    // Reverse: through the middle (stop) into the left edge.
    await pointAt(page, resume, 'center');
    const turned = await expectStopped(page, resume);
    await enterEdgeAndDwell(page, resume, 'outer-left');
    await expectScrolling(resume, 'left', turned);
    await pointAt(page, resume, 'center');
    const parked = await expectStopped(page, resume);
    expect(parked).toBeGreaterThan(0);

    expect(await pageScroll(page)).toEqual(before);

    // Watchlist runs to its end and stops there; Continue Watching stays put.
    await watchlist.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const shifted = await pageScroll(page);
    await pointAt(page, watchlist, 'center');
    await expectScrolling(watchlist, 'right', (await enterEdgeAndDwell(page, watchlist, 'outer-right')).from);
    const end = await maxLeft(watchlist);
    await expect.poll(() => left(watchlist), { timeout: 20_000 }).toBeGreaterThanOrEqual(end - 1);
    await expectStopped(page, watchlist);
    expect(await left(resume)).toBe(parked);

    // Scrolling neither opened a title nor scrolled the page.
    await expect(view.locator('.detail-plot')).toHaveCount(0);
    await expect(view.locator('.catalog-grid-title')).toHaveCount(0);
    await expect(page.locator('#view-player')).toBeHidden();
    expect(await ownerScope(page)).toBe(scope);
    expect(await pageScroll(page)).toEqual(shifted);
  });
}

test('a category rail cancels before the dwell, stops on a key or a window blur, and restarts only on real movement', async ({ page }) => {
  test.setTimeout(60_000);
  await seedCatalog(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const track = page.locator('#view-movies [data-rail-key="cat:1"] .catalog-rail-track');
  const next = page.locator('#view-movies [data-rail-key="cat:2"] .catalog-rail-track');
  await expect(track.locator('.catalog-tile').first()).toBeVisible();
  await expectEdgeTrack(track);
  const before = await pageScroll(page);

  // Leaving the edge inside the dwell cancels it.
  await pointAt(page, track, 'center');
  await enterEdgeAndDwell(page, track, 'right');
  await pointAt(page, track, 'center');
  await page.waitForTimeout(STILL_MS);
  expect(await left(track)).toBe(0);

  // A remote key stops it, and the resting pointer does not restart it.
  const { at, from } = await enterEdgeAndDwell(page, track, 'right');
  await expectScrolling(track, 'right', from);
  await page.keyboard.press('ArrowRight');
  const afterKey = await expectStopped(page, track);
  expect(afterKey).toBeLessThan(await maxLeft(track));

  // Real movement inside the edge starts it again.
  await nudge(page, at);
  await expectScrolling(track, 'right', afterKey);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const afterBlur = await expectStopped(page, track);
  expect(afterBlur).toBeLessThan(await maxLeft(track));

  expect(await left(next), 'only the pointed rail scrolls').toBe(0);
  await expect(page.locator('#view-movies .detail-plot')).toHaveCount(0);
  expect((await pageScroll(page)).x).toBe(before.x);
  expect((await pageScroll(page)).y).toBe(before.y);
});

test('All categories scrolls through its virtual window without opening a category, and a wheel stops it', async ({ page }) => {
  test.setTimeout(60_000);
  await seedCatalog(page, { categories: 40, perCategory: 4 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const track = page.locator('#view-movies .catalog-category-rail');
  await expect(track.locator('.catalog-cat').first()).toBeAttached();
  await track.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expectEdgeTrack(track);
  const indices = () => track.locator('[data-category-virtual-index]').evaluateAll((cells) =>
    cells.map((cell) => Number(cell.getAttribute('data-category-virtual-index'))));
  const first = await indices();
  expect(Math.min(...first)).toBe(0);
  const scope = await ownerScope(page);
  const before = await pageScroll(page);

  await pointAt(page, track, 'center');
  await expectScrolling(track, 'right', (await enterEdgeAndDwell(page, track, 'outer-right')).from);
  await expectSteadyRate(page, track);
  await expect.poll(() => left(track), { timeout: 20_000 }).toBeGreaterThan(3000);
  // The virtual window followed the scroll, and the visible part is not blank.
  await expect.poll(async () => Math.min(...await indices())).toBeGreaterThan(0);
  expect(Math.max(...await indices())).toBeGreaterThan(Math.max(...first));
  expect(await track.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return Array.from(el.querySelectorAll('.catalog-cat')).filter((cat) => {
      const box = cat.getBoundingClientRect();
      return box.right > r.left && box.left < r.right;
    }).length;
  })).toBeGreaterThan(2);
  // The page around the rail stayed where it was while the rail scrolled.
  expect(await pageScroll(page)).toEqual(before);

  await page.mouse.wheel(0, 100);
  const stopped = await expectStopped(page, track);
  expect(stopped).toBeLessThan(await maxLeft(track));
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveCount(0);
  expect(await ownerScope(page)).toBe(scope);
});

// After a long edge scroll the remote carries on from what the pointer rests
// on, not from a tile the scroll left far behind.
async function scrollFarThenKey(
  page: Page,
  track: Locator,
  tiles: string,
  how: 'key' | 'cursor-hidden',
  outer = false,
): Promise<void> {
  await pointAt(page, track, 'center');
  await expectScrolling(track, 'right', (await enterEdgeAndDwell(page, track, outer ? 'outer-right' : 'right')).from);
  await expect.poll(() => left(track), { timeout: 20_000 }).toBeGreaterThan(2400);
  if (how === 'cursor-hidden') {
    await page.evaluate(() => document.dispatchEvent(
      new CustomEvent('cursorStateChange', { bubbles: true, detail: { visibility: false } })));
  }
  const far = await left(track);
  await page.keyboard.press('ArrowRight');
  const ring = track.locator(`${tiles}.focused`);
  await expect(ring).toHaveCount(1);
  await expect.poll(() => ring.evaluate((tile) => {
    const r = tile.closest('[data-edge-scroll]')!.getBoundingClientRect();
    const b = tile.getBoundingClientRect();
    return b.left >= r.left - 1 && b.right <= r.right + 1;
  }), { message: 'the ring is on screen in the rail' }).toBe(true);
  await page.waitForTimeout(STILL_MS);
  expect(await left(track), 'the remote jumped back from where the rail was')
    .toBeGreaterThan(far - 300);
}

test('after a long edge scroll, a key or a hidden cursor then a key continues from the pointed tile of a category rail', async ({ page }) => {
  test.setTimeout(90_000);
  await seedCatalog(page, { perCategory: 60 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const rail = (n: number) => page.locator(`#view-movies [data-rail-key="cat:${String(n)}"] .catalog-rail-track`);
  await expect(rail(1).locator('.catalog-tile').first()).toBeVisible();
  await expectEdgeTrack(rail(1));
  await scrollFarThenKey(page, rail(1), '.catalog-tile', 'key', true);
  await rail(2).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expectEdgeTrack(rail(2));
  await scrollFarThenKey(page, rail(2), '.catalog-tile', 'cursor-hidden', true);
  await expect(page.locator('#view-movies .detail-plot')).toHaveCount(0);
});

test('after a long edge scroll, the remote continues from the pointed result of a virtual Search rail', async ({ page }) => {
  test.setTimeout(90_000);
  await seedCatalog(page, { categories: 2, perCategory: 150 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  const input = page.locator('.tab-bar-search-input');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
  await input.fill('alpha');
  const movies = page.locator('#view-search [data-search-virtual="movies"]');
  const series = page.locator('#view-search [data-search-virtual="series"]');
  await expect(movies.locator('.catalog-tile').first()).toBeVisible();
  await input.press('ArrowDown');
  await expect(input).not.toBeFocused();
  await expectEdgeTrack(movies);
  await scrollFarThenKey(page, movies, '.catalog-tile', 'cursor-hidden', true);
  await expectEdgeTrack(series);
  await scrollFarThenKey(page, series, '.catalog-tile', 'key', true);
  await expect(page.locator('#view-movies .detail-plot')).toHaveCount(0);
});

test('Search: a virtual results rail scrolls far and keeps a usable ring; a hidden cursor or document stops a rail', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await seedCatalog(page, { categories: 2, perCategory: 150, channels: 60 });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'search');
  const input = page.locator('.tab-bar-search-input');
  await expect(page.locator('.tab-bar-search.expanded')).toBeVisible();
  await input.fill('alpha');
  const movies = page.locator('#view-search [data-search-virtual="movies"]');
  const channels = page.locator('#view-search [data-search-virtual="channels-rail"]');
  const series = page.locator('#view-search [data-search-virtual="series"]');
  await expect(movies.locator('.catalog-tile').first()).toBeVisible();
  for (const rail of [movies, channels, series]) await expectEdgeTrack(rail);
  await expectLeftBleed(movies);
  // Hand the keys from the box to the results.
  await input.press('ArrowDown');
  await expect(input).not.toBeFocused();
  const firstKey = await movies.locator('.catalog-tile').first().getAttribute('data-key');
  const before = await pageScroll(page);

  await pointAt(page, movies, 'center');
  await expectScrolling(movies, 'right', (await enterEdgeAndDwell(page, movies, 'right')).from);
  await expectSteadyRate(page, movies);
  await expect.poll(() => left(movies), { timeout: 30_000 }).toBeGreaterThan(4800);
  await pointAt(page, movies, 'center');
  const far = await expectStopped(page, movies);
  // The virtual window moved on: the first result is gone and the view is filled.
  await expect(movies.locator(`.catalog-tile[data-key="${firstKey ?? ''}"]`)).toHaveCount(0);
  const visible = movies.locator('.catalog-tile');
  const onScreen = await visible.evaluateAll((tiles) => tiles.filter((tile) => {
    const r = tile.parentElement!.closest('[data-search-virtual]')!.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    return box.left >= r.left - 1 && box.right <= r.right + 1;
  }).map((tile) => tile.getAttribute('data-key')));
  expect(onScreen.length).toBeGreaterThan(2);
  expect(await channels.evaluate((el) => el.scrollLeft)).toBe(0);
  expect(await series.evaluate((el) => el.scrollLeft)).toBe(0);

  // Hover a result where the rail stopped, then the remote moves from it.
  const target = movies.locator(`.catalog-tile[data-key="${onScreen[1] ?? ''}"]`);
  const box = await target.boundingBox();
  if (!box) throw new Error('no on-screen result');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.keyboard.press('ArrowRight');
  const ring = page.locator('#view-search .catalog-tile.focused');
  await expect(ring).toHaveCount(1);
  await expect.poll(() => ring.evaluate((tile) => {
    const r = tile.closest('[data-search-virtual]')!.getBoundingClientRect();
    const b = tile.getBoundingClientRect();
    return b.left >= r.left - 1 && b.right <= r.right + 1;
  })).toBe(true);
  expect(await left(movies), 'the ring stayed in the scrolled window').toBeGreaterThan(far - 1000);
  await page.screenshot({ path: testInfo.outputPath('search-virtual-edge-scroll.png') });

  // A cursor the TV hides stops a rail (webOS cursorStateChange).
  await pointAt(page, channels, 'center');
  await expectScrolling(channels, 'right', (await enterEdgeAndDwell(page, channels, 'right')).from);
  await page.evaluate(() => document.dispatchEvent(
    new CustomEvent('cursorStateChange', { bubbles: true, detail: { visibility: false } })));
  expect(await expectStopped(page, channels)).toBeLessThan(await maxLeft(channels));

  // So does a hidden document.
  await pointAt(page, series, 'center');
  await expectScrolling(series, 'right', (await enterEdgeAndDwell(page, series, 'right')).from);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await expectStopped(page, series)).toBeLessThan(await maxLeft(series));
  await expect(page.locator('#view-movies .detail-plot')).toHaveCount(0);
  expect((await pageScroll(page)).y).toBe(before.y);
});

test('Live playlist tabs scroll and reverse without selecting a playlist, and a press stops them', async ({ page }) => {
  test.setTimeout(60_000);
  await seedPlaylists(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
  const tabs = page.locator('#view-channels .playlist-tabs');
  await expect(tabs.locator('.playlist-tab')).toHaveCount(25);
  await expectEdgeTrack(tabs);
  const active = tabs.locator('.playlist-tab.active');
  await expect(active).toHaveText('All');
  const firstChannel = await page.locator('#view-channels .channel-item').first().textContent();
  const before = await pageScroll(page);

  await pointAt(page, tabs, 'center');
  await expectScrolling(tabs, 'right', (await enterEdgeAndDwell(page, tabs, 'right')).from);
  await expectSteadyRate(page, tabs);
  await expect.poll(() => left(tabs), { timeout: 10_000 }).toBeGreaterThan(300);
  await pointAt(page, tabs, 'center');
  const turned = await expectStopped(page, tabs);
  await enterEdgeAndDwell(page, tabs, 'left');
  await expectScrolling(tabs, 'left', turned);
  await pointAt(page, tabs, 'center');
  await expectStopped(page, tabs);

  await expect(active).toHaveText('All');
  await expect(tabs.locator('.playlist-tab.active')).toHaveCount(1);
  expect(await page.locator('#view-channels .channel-item').first().textContent()).toBe(firstChannel);
  expect(await pageScroll(page)).toEqual(before);

  // Pressing the pointer stops it even before the button comes up.
  const { from } = await enterEdgeAndDwell(page, tabs, 'right');
  await expectScrolling(tabs, 'right', from);
  await page.mouse.down();
  expect(await expectStopped(page, tabs)).toBeLessThan(await maxLeft(tabs));
  await page.mouse.up();
});

test('player sidebar tabs scroll without switching playlists and stop when the pointer leaves the window', async ({ page }) => {
  await neuterVideo(page);
  await routeLiveManifest(page);
  await seedPlaylists(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item.focused')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  const sidebar = page.locator('#player-sidebar');
  await expect(sidebar).toBeVisible();
  const tabs = sidebar.locator('.sidebar-tabs');
  await expectEdgeTrack(tabs);
  await expectAtRest(tabs);
  const active = await sidebar.locator('.sidebar-tab.active').textContent();
  const playing = await sidebar.locator('.sidebar-ch-item.playing').textContent();
  const scope = await ownerScope(page);

  await pointAt(page, tabs, 'center');
  await expectScrolling(tabs, 'right', (await enterEdgeAndDwell(page, tabs, 'right')).from);
  await expectSteadyRate(page, tabs);
  await expect(sidebar).toBeVisible();

  // The pointer leaves the window: a mouseout with no related target.
  await page.evaluate(() => {
    document.documentElement.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: null }));
  });
  expect(await expectStopped(page, tabs)).toBeLessThan(await maxLeft(tabs));
  await expect(sidebar.locator('.sidebar-tab.active')).toHaveText(active ?? '');
  await expect(sidebar.locator('.sidebar-ch-item.playing')).toHaveText(playing ?? '');
  expect(await ownerScope(page)).toBe(scope);
});

test('Guide dates scroll to their end and back without selecting a day', async ({ page }) => {
  const xmltv = (d: Date) => `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const programmes: string[] = [];
  for (const ch of ['ch1', 'ch2']) {
    for (let day = -7; day < 14; day++) {
      for (const hour of [0, 12]) {
        const start = new Date(today.getTime() + (day * 24 + hour) * 3_600_000);
        const stop = new Date(start.getTime() + 12 * 3_600_000);
        programmes.push(`<programme channel="${ch}" start="${xmltv(start)}" stop="${xmltv(stop)}">`
          + `<title>${hour ? 'Bravo' : 'Alpha'}</title></programme>`);
      }
    }
  }
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1",Channel 1',
    'http://streams.example.com/ch1.m3u8',
    '#EXTINF:-1 tvg-id="ch2",Channel 2',
    'http://streams.example.com/ch2.m3u8',
  ].join('\n'));
  await page.route('**/epg.xml', (route) => route.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/><channel id="ch2"/>${programmes.join('')}</tv>` }));
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml')));
  await page.goto('/');
  await liveLoaded(page);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  const dates = page.locator('#view-epg .epg-date-list');
  await expect(dates.locator('.epg-date-item').first()).toBeVisible();
  await expect(page.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
  await expectEdgeTrack(dates);
  const selected = await dates.locator('.epg-date-item.selected').textContent();
  const programme = await page.locator('#epg-programmes .epg-programme-item').first().textContent();
  const scope = await ownerScope(page);
  const before = await pageScroll(page);
  const start = await left(dates);

  await pointAt(page, dates, 'center');
  await enterEdgeAndDwell(page, dates, 'right');
  const end = await maxLeft(dates);
  await expect.poll(() => left(dates), { timeout: 10_000 }).toBeGreaterThanOrEqual(end - 1);
  await expectStopped(page, dates);

  await pointAt(page, dates, 'center');
  await enterEdgeAndDwell(page, dates, 'left');
  await expectScrolling(dates, 'left', end, Math.min(24, end / 2));
  await expect.poll(() => left(dates), { timeout: 10_000 }).toBeLessThanOrEqual(Math.min(start, 1));

  await expect(dates.locator('.epg-date-item.selected')).toHaveCount(1);
  await expect(dates.locator('.epg-date-item.selected')).toHaveText(selected ?? '');
  await expect(page.locator('#epg-programmes .epg-programme-item').first()).toHaveText(programme ?? '');
  expect(await ownerScope(page)).toBe(scope);
  expect(await pageScroll(page)).toEqual(before);
});

// channelKey mirrors src/utils/channel.ts (fnv1a of the URL sans query/fragment).
function channelKey(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

test('a prompt that takes the keys stops the scroll, and the pointer cannot scroll the surface under it', async ({ page }) => {
  test.setTimeout(90_000);
  await neuterVideo(page);
  await routeLiveManifest(page);
  await seedPlaylists(page);
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();

  // A PIN-locked group: a reminder launch into it asks for the PIN.
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(page.locator('#view-parental-controls')).toBeVisible();
  await page.locator('[data-parental-group]').filter({ hasText: 'Group A' }).first().click();
  await page.locator('[data-parental-tab="options"]').click();
  await page.locator('#parental-duration [data-value="once"]').click();
  await page.locator('[data-parental-back]').click();
  await enterTab(page, 'live');
  const tabs = page.locator('#view-channels .playlist-tabs');
  await liveLoaded(page);
  await expectEdgeTrack(tabs);

  await pointAt(page, tabs, 'center');
  const { at, from } = await enterEdgeAndDwell(page, tabs, 'right');
  await expectScrolling(tabs, 'right', from);
  await page.evaluate((reminderChannelKey) => document.dispatchEvent(
    new CustomEvent('webOSRelaunch', { detail: { reminderChannelKey } })),
  channelKey('http://streams.example.com/0-1.m3u8'));
  await expect(prompt).toBeVisible();
  await expect.poll(() => ownerScope(page)).toBe('prompt.parental_pin');
  const stopped = await expectStopped(page, tabs);
  expect(stopped).toBeLessThan(await maxLeft(tabs));

  // Real movement in the edge of a track the prompt covers does nothing.
  await nudge(page, at);
  await page.waitForTimeout(1000);
  expect(await left(tabs)).toBe(stopped);
  await expect(prompt).toBeVisible();
});
