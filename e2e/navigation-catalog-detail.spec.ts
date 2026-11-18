import { test, expect, routeLiveManifest, neuterVideo, SAMPLE_M3U, enterTab, type Page } from './helpers';
import {
  KEYS, OPPOSITE, DIRECTIONS, seededRandom, installNavBox, focusedKey as focusedKeyIn, hover, hoverKey,
  type Direction, type NavBoxWindow,
} from './navigation-helpers';

// Every focusable on the Movie and Series detail screens, pressed every way,
// and then long keyboard-only walks, against the screen's navigation rules
// worked out from what is on screen:
//   1. Left and Right stay on their line and stop at its ends.
//   2. Up and Down step to the adjacent line, to the element with the
//      smallest gap across (what overlaps the column has none), then to the
//      nearest center.
//   3. The opposite key after crossing into another block goes back, while
//      the way back still lies that way.
//   4. Up off the top line reaches the tab bar; Down off the bottom stays.
//   5. Down onto the round actions wrapped below enters at the first one.
//   7. Down from the actions enters the seasons at the season shown.
//   9. Down from the last season line enters the first episode's row.
//  10. An episode's row and mark swap with Left and Right; Up and Down keep
//      to the column, one episode at a time.
//  11. Up from the first episode reaches the season shown.

interface Setup {
  kind: 'movie' | 'series';
  resume: boolean;
  // Whether the round actions sit on a line below the text ones.
  wraps: boolean;
  seasons?: number;
  episodes?: number;
  emptySeasons?: number[];
  // The season mark sits alone on a line of its own.
  markAlone?: boolean;
  // The series details never arrive.
  loading?: boolean;
  locale?: string;
  pseudo?: boolean;
  textSize?: string;
}

const episodeId = (season: number, index: number) => season * 1000 + index + 1;

async function seed(page: Page, setup: Setup): Promise<void> {
  await page.route('**/get.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    if (url.includes('get_vod_info')) return json({ info: { plot: 'A plot.', duration_secs: 3600 } });
    if (url.includes('get_series_categories')) return json([{ category_id: '2', category_name: 'Cat B' }]);
    if (url.includes('get_series_info')) {
      if (setup.loading) return new Promise<void>(() => {});
      const episodes: Record<string, unknown[]> = {};
      for (let season = 1; season <= (setup.seasons ?? 1); season++) {
        const count = setup.emptySeasons?.includes(season) ? 0 : (setup.episodes ?? 3);
        episodes[String(season)] = Array.from({ length: count }, (_, i) => ({
          id: String(episodeId(season, i)), title: `Episode ${i + 1}`, season, episode_num: i + 1,
          container_extension: 'mp4', info: { duration_secs: 1500 },
        }));
      }
      return json({ info: { name: 'Series One', plot: 'A series plot.' }, episodes });
    }
    if (url.includes('get_series')) return json([{ series_id: 20, name: 'Series One', cover: '', category_id: '2' }]);
    return json({});
  });
  await page.addInitScript((s) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'x1', name: 'X Account',
      url: 'http://host.example.com:8080', source: 'xtream', xtream: { username: 'u', password: 'p' } }]));
    localStorage.setItem('iptv_animation_mode', JSON.stringify('essential'));
    if (s.textSize) localStorage.setItem('iptv_text_size', JSON.stringify(s.textSize));
    if (s.locale) localStorage.setItem('iptv_locale', JSON.stringify(s.locale));
    if (!s.resume) return;
    localStorage.setItem('iptv_resume', JSON.stringify(s.kind === 'movie'
      ? { 'x1|vod|10': { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4',
        position: 600, duration: 3600, updatedAt: 1 } }
      : { 'x1|episode|1001': { accountId: 'x1', kind: 'episode', itemId: '1001', name: 'Series One — S1E1', poster: '',
        ext: 'mp4', position: 100, duration: 600, updatedAt: 1, season: 1, episode: 1, categoryId: '2',
        watchlistOwner: { kind: 'series', itemId: '20', name: 'Series One', poster: '' } } }));
  }, setup);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await installNavBox(page);
}

async function openDetail(page: Page, setup: Setup): Promise<string> {
  await seed(page, setup);
  await page.goto(setup.pseudo ? '/?pseudo=1' : '/');
  const section = setup.kind === 'movie' ? 'movies' : 'series';
  await enterTab(page, section);
  const view = `#view-${section}`;
  await hover(page.locator(`${view} .catalog-tile[data-item-id="${setup.kind === 'movie' ? '10' : '20'}"]`).last());
  await page.keyboard.press('Enter');
  await expect(page.locator(`${view} .detail-actions`)).toBeVisible();
  if (setup.kind === 'series') {
    const settled = setup.loading || !setup.seasons ? `${view} .catalog-hint`
      : setup.emptySeasons?.includes(1) ? `${view} .series-episodes .catalog-hint` : `${view} .episode-row`;
    await expect(page.locator(settled).first()).toBeVisible();
  }
  return `${view} .catalog-layer-detail`;
}

// What each setup is there to cover, so a layout change cannot quietly
// leave a rule untested.
async function expectLayout(page: Page, detail: string, setup: Setup): Promise<void> {
  const layout = await page.evaluate((root) => {
    const el = document.querySelector(root)!;
    const { __navBox } = window as unknown as NavBoxWindow;
    const circles = (selector: string) => Array.from(el.querySelectorAll<HTMLElement>(selector)).map(__navBox);
    const text = circles('.detail-actions > [data-focusable]');
    const icons = circles('.detail-actions .detail-icon-row [data-focusable]');
    const mark = circles('[data-action="season-watched"]')[0];
    const seasons = circles('.series-season-btn');
    return {
      wraps: text.length > 0 && icons.length > 0
        && Math.min(...icons.map((r) => r.top)) >= Math.max(...text.map((r) => r.bottom)) - 1,
      markAlone: !!mark && seasons.every((r) => r.bottom <= mark.top || r.top >= mark.bottom),
    };
  }, detail);
  expect(layout.wraps).toBe(setup.wraps);
  expect(layout.markAlone).toBe(!!setup.markAlone);
}

const TAB_BAR = 'tab bar';

interface Spot {
  key: string; block: 'A' | 'S' | 'E'; container: string; remember: boolean;
  top: number; bottom: number; left: number; right: number; cx: number; cy: number;
  icon: boolean; index: number;
}

interface Screen { spots: Spot[]; active: string | null }

async function readScreen(page: Page, detail: string): Promise<Screen> {
  return page.evaluate((root) => {
    const detail = document.querySelector(root)!;
    const { __navBox } = window as unknown as NavBoxWindow;
    const containers: Element[] = [];
    const spots: Spot[] = [];
    const take = (block: Spot['block'], selector: string) => {
      for (const el of Array.from(detail.querySelectorAll<HTMLElement>(selector))) {
        const box = __navBox(el);
        const container = el.closest('[data-nav-container]')!;
        if (!containers.includes(container)) containers.push(container);
        spots.push({ key: el.dataset.key!, block, container: String(containers.indexOf(container)),
          remember: container.hasAttribute('data-nav-remember'),
          top: box.top, bottom: box.bottom, left: box.left, right: box.right,
          cx: box.left + box.width / 2, cy: box.top + box.height / 2,
          icon: el.classList.contains('detail-icon-btn') && !!el.closest('.detail-actions'),
          index: Number(el.closest<HTMLElement>('.series-episode-cell')?.dataset.episodeIndex ?? -1) });
      }
    };
    take('A', '.detail-actions [data-focusable]');
    take('S', '.series-seasons [data-focusable]');
    take('E', '.series-episodes [data-focusable]');
    const active = detail.querySelector<HTMLElement>('.series-season-btn.active')?.dataset.key ?? null;
    return { spots, active };
  }, detail);
}

// Where the rules send `key` the `direction` way, remembering nothing.
function expected(screen: Screen, setup: Setup, key: string, direction: Direction): string {
  const { spots, active } = screen;
  const me = spots.find((s) => s.key === key)!;
  if (me.block === 'E') {
    const column = key.slice(0, key.indexOf(':'));
    if (direction === 'left') return column === 'ep-mark' ? key.replace('ep-mark:', 'ep:') : key;
    if (direction === 'right') return column === 'ep' ? key.replace('ep:', 'ep-mark:') : key;
    const season = Number(active!.slice('season:'.length));
    const next = me.index + (direction === 'down' ? 1 : -1);
    if (next < 0) return active!;
    return next < (setup.episodes ?? 3) ? `${column}:${episodeId(season, next)}` : key;
  }
  const block = spots.filter((s) => s.block === me.block);
  // Lines: elements sharing a vertical band, top to bottom.
  const lines: Spot[][] = [];
  for (const s of [...block].sort((a, b) => a.top - b.top)) {
    const line = lines.find((l) => l.some((o) => o.top < s.bottom && o.bottom > s.top));
    if (line) line.push(s); else lines.push([s]);
  }
  lines.forEach((line) => line.sort((a, b) => a.left - b.left));
  const at = lines.findIndex((line) => line.includes(me));
  const line = lines[at];
  const apart = (s: Spot) => Math.max(s.left - me.right, me.left - s.right, 0);
  const nearest = (to: Spot[]) => to.reduce((a, c) =>
    (apart(c) < apart(a) || (apart(c) === apart(a) && Math.abs(c.cx - me.cx) < Math.abs(a.cx - me.cx)) ? c : a)).key;

  if (direction === 'left' || direction === 'right') {
    return line[line.indexOf(me) + (direction === 'right' ? 1 : -1)]?.key ?? key;
  }
  const down = direction === 'down';
  const adjacent = lines[at + (down ? 1 : -1)];
  if (me.block === 'A') {
    if (down) {
      if (adjacent) return adjacent.find((s) => s.icon)?.key ?? nearest(adjacent);
      return active ?? key;
    }
    return adjacent ? nearest(adjacent) : TAB_BAR;
  }
  if (adjacent) return nearest(adjacent);
  if (down) {
    const first = spots.find((s) => s.block === 'E' && s.index === 0 && s.key.startsWith('ep:'));
    return first?.key ?? key;
  }
  const actions = spots.filter((s) => s.block === 'A');
  const lowest = Math.max(...actions.map((s) => s.top));
  return nearest(actions.filter((s) => s.bottom > lowest));
}

function focusedKey(page: Page, detail: string): Promise<string | null> {
  return focusedKeyIn(page, detail, TAB_BAR);
}

// Every control, every key, from a fresh start each time.
async function everyKey(page: Page, detail: string, setup: Setup): Promise<string[]> {
  const keys = (await readScreen(page, detail)).spots.map((s) => s.key);
  const away = (key: string) => keys.find((k) => k !== key && !/^ep/.test(k));
  const misses: string[] = [];
  let ran = 0;
  for (const key of keys) {
    for (const direction of DIRECTIONS) {
      // Through another control first, so nothing remembered carries over.
      const other = away(key);
      if (!other || !await hoverKey(page, detail, other)) {
        misses.push(`${key}: no other control to start from`);
        continue;
      }
      if (!await hoverKey(page, detail, key)) {
        // Only an episode the list has scrolled out of view may be gone.
        if (!/^ep/.test(key)) misses.push(`${key}: gone from the screen`);
        continue;
      }
      ran++;
      await expect.poll(() => focusedKey(page, detail)).toBe(key);
      const before = await readScreen(page, detail);
      const want = expected(before, setup, key, direction);
      await page.keyboard.press(KEYS[direction]);
      const got = await focusedKey(page, detail);
      if (got !== want) {
        misses.push(`${key} ${direction}: expected ${want}, got ${got}`);
        continue;
      }
      const from = before.spots.find((s) => s.key === key)!;
      const to = before.spots.find((s) => s.key === want);
      if (!to || to.container === from.container || !to.remember) continue;
      await page.keyboard.press(KEYS[OPPOSITE[direction]]);
      const back = await focusedKey(page, detail);
      if (back !== key) misses.push(`${key} ${direction} then ${OPPOSITE[direction]}: expected ${key}, got ${back}`);
    }
  }
  if (ran < keys.length * 2) misses.push(`only ${ran} key presses ran for ${keys.length} controls`);
  return misses;
}

// A long run of keys only, OK on the actions that re-render in place
// included, with rule 3 tracked as the walk goes.
// OK on these re-renders in place: a season shows its episodes, Watched on
// a resumed title drops the resume buttons and so can unwrap the row.
const RE_RENDERS = /^(watchlist|watched|season:\d+|ep-mark:\d+)$/;

async function keyWalk(page: Page, detail: string, setup: Setup, presses: number): Promise<{ misses: string[]; oks: string[] }> {
  const random = seededRandom(7);
  let current: string;
  const start = await focusedKey(page, detail);
  if (start === null || start === TAB_BAR) {
    current = (await readScreen(page, detail)).spots[0].key;
    await hoverKey(page, detail, current);
  } else {
    current = start;
  }
  let last: { from: string; to: string; direction: Direction } | null = null;
  const trail: string[] = [];
  const oks: string[] = [];
  for (let i = 0; i < presses; i++) {
    const screen = await readScreen(page, detail);
    const me = screen.spots.find((s) => s.key === current)!;
    const kind = current.replace(/:.*/, '');
    // The first time on each kind always presses OK, so every walk re-renders.
    if (RE_RENDERS.test(current) && current !== screen.active
        && (!oks.some((k) => k.replace(/:.*/, '') === kind) || random() < 0.15)) {
      await page.keyboard.press('Enter');
      trail.push(`${current} OK`);
      oks.push(current);
      await expect.poll(() => focusedKey(page, detail)).toBe(current);
      continue;
    }
    const options = DIRECTIONS.filter((d) => expected(screen, setup, current, d) !== TAB_BAR);
    // Mostly keys that go somewhere, so the walk covers the screen, not one end.
    const moving = options.filter((d) => expected(screen, setup, current, d) !== current);
    const pool = moving.length && random() < 0.8 ? moving : options;
    const direction = pool[Math.floor(random() * pool.length)];
    const source: Spot | undefined = last && last.to === current && direction === OPPOSITE[last.direction]
      ? screen.spots.find((s) => s.key === last!.from) : undefined;
    const back: boolean = !!source && (direction === 'up' ? source.cy < me.cy - 5 : direction === 'down' ? source.cy > me.cy + 5
      : direction === 'left' ? source.cx < me.cx - 5 : source.cx > me.cx + 5);
    const want: string = back ? source!.key : expected(screen, setup, current, direction);
    await page.keyboard.press(KEYS[direction]);
    const got = await focusedKey(page, detail);
    trail.push(`${current} ${direction}`);
    if (got !== want) {
      return { misses: [`after ${trail.slice(-6).join(', ')}: expected ${want}, got ${got}`], oks };
    }
    if (back) {
      last = null;
    } else if (want !== current) {
      const to: Spot | undefined = screen.spots.find((s) => s.key === want);
      last = to && to.container !== me.container && to.remember ? { from: current, to: want, direction } : null;
    }
    current = want;
  }
  return { misses: [], oks };
}

const SETUPS: Array<[string, Setup]> = [
  ['a movie with nothing to resume', { kind: 'movie', resume: false, wraps: false }],
  ['a resumed movie', { kind: 'movie', resume: true, wraps: false }],
  ['a resumed movie whose round actions wrap', { kind: 'movie', resume: true, wraps: true, pseudo: true, textSize: '150' }],
  ['a resumed movie in Polish at 140%', { kind: 'movie', resume: true, wraps: true, locale: 'pl', textSize: '140' }],
  ['a resumed movie in Turkish at 130%', { kind: 'movie', resume: true, wraps: true, locale: 'tr', textSize: '130' }],
  ['a series still loading', { kind: 'series', resume: true, wraps: false, seasons: 1, loading: true }],
  ['a series with no seasons', { kind: 'series', resume: false, wraps: false, seasons: 0 }],
  ['a series whose season shown has no episodes', { kind: 'series', resume: false, wraps: false, seasons: 2, emptySeasons: [1] }],
  ['a series of one season', { kind: 'series', resume: false, wraps: false, seasons: 1 }],
  ['a series of one season, its round actions at 150%', { kind: 'series', resume: false, wraps: false, seasons: 1, pseudo: true, textSize: '150' }],
  ['a resumed series of two seasons', { kind: 'series', resume: true, wraps: false, seasons: 2 }],
  ['a resumed series of twenty episodes a season', { kind: 'series', resume: true, wraps: false, seasons: 2, episodes: 20 }],
  ['a resumed series of twelve seasons', { kind: 'series', resume: true, wraps: false, seasons: 12, markAlone: true }],
  ['a resumed series whose round actions wrap', { kind: 'series', resume: true, wraps: true, seasons: 2, markAlone: true,
    pseudo: true, textSize: '150' }],
  ['a resumed series in Turkish at 150%', { kind: 'series', resume: true, wraps: true, seasons: 2, locale: 'tr', textSize: '150' }],
];

for (const [name, setup] of SETUPS) {
  test(`every key from every control of ${name} lands where the rules say`, async ({ page }) => {
    test.setTimeout(240_000);
    const detail = await openDetail(page, setup);
    await expectLayout(page, detail, setup);
    expect(await everyKey(page, detail, setup)).toEqual([]);
  });

  test(`a long keyboard-only walk on ${name} lands where the rules say`, async ({ page }) => {
    test.setTimeout(240_000);
    const detail = await openDetail(page, setup);
    const hasWatched = (await readScreen(page, detail)).spots.some((s) => s.key === 'watched');
    const { misses, oks } = await keyWalk(page, detail, setup, 150);
    expect(misses).toEqual([]);
    // The walk got to change what is on screen under its feet.
    const switched = oks.some((k) => k.startsWith('season:'));
    expect(switched).toBe(!setup.loading && (setup.seasons ?? 1) > 1);
    expect(oks.includes('watched')).toBe(hasWatched);
  });
}

// Landmarks written out by hand, so a mistake the rules' worked-out version
// shares with the code still shows.
const LANDMARKS: Array<[string, Setup, Array<[string, Direction, string]>]> = [
  ['a resumed movie', { kind: 'movie', resume: true, wraps: false }, [
    ['resume', 'right', 'play'], ['play', 'right', 'watchlist'], ['watchlist', 'left', 'play'],
    ['remove-resume', 'right', 'remove-resume'], ['resume', 'left', 'resume'], ['watched', 'down', 'watched'],
  ]],
  ['a resumed movie in Turkish at 130%', { kind: 'movie', resume: true, wraps: true, locale: 'tr', textSize: '130' }, [
    ['resume', 'down', 'watchlist'], ['play', 'down', 'watchlist'], ['remove-resume', 'up', 'play'],
    ['watchlist', 'left', 'watchlist'], ['play', 'right', 'play'],
  ]],
  ['a resumed series of two seasons', { kind: 'series', resume: true, wraps: false, seasons: 2 }, [
    ['resume', 'right', 'watchlist'], ['watchlist', 'down', 'season:1'], ['resume', 'down', 'season:1'],
    ['season:2', 'down', 'ep:1001'], ['ep:1001', 'up', 'season:1'], ['ep-mark:1001', 'up', 'season:1'],
    ['ep:1001', 'right', 'ep-mark:1001'], ['ep-mark:1001', 'down', 'ep-mark:1002'], ['ep:1003', 'down', 'ep:1003'],
    ['season-watched', 'right', 'season-watched'], ['season:1', 'left', 'season:1'],
  ]],
];

for (const [name, setup, steps] of LANDMARKS) {
  test(`landmarks on ${name}`, async ({ page }) => {
    const detail = await openDetail(page, setup);
    await expectLayout(page, detail, setup);
    const misses: string[] = [];
    for (const [from, direction, to] of steps) {
      expect(await hoverKey(page, detail, from === 'hide' ? 'resume' : 'hide')).toBe(true);
      expect(await hoverKey(page, detail, from)).toBe(true);
      await expect.poll(() => focusedKey(page, detail)).toBe(from);
      await page.keyboard.press(KEYS[direction]);
      const got = await focusedKey(page, detail);
      if (got !== to) misses.push(`${from} ${direction}: expected ${to}, got ${got}`);
    }
    expect(misses).toEqual([]);
  });
}

test('landmarks on the season mark alone on its line, among twelve seasons', async ({ page }) => {
  const setup: Setup = { kind: 'series', resume: true, wraps: false, seasons: 12, markAlone: true };
  const detail = await openDetail(page, setup);
  await expectLayout(page, detail, setup);
  const left = (key: string) => page.locator(`${detail} [data-key="${key}"]`).evaluate((el) => {
    const box = (window as unknown as NavBoxWindow).__navBox(el);
    return { left: Math.round(box.left), top: Math.round(box.top) };
  });
  // The mark starts a line of its own; the season straight above it shares
  // its left edge.
  const mark = await left('season-watched');
  let above = '';
  for (let n = 12; n >= 1 && !above; n--) {
    const box = await left(`season:${n}`);
    if (box.left === mark.left && box.top < mark.top) above = `season:${n}`;
  }
  expect(above).not.toBe('');
  await hoverKey(page, detail, 'resume');
  await hoverKey(page, detail, 'season-watched');
  await page.keyboard.press('ArrowUp');
  expect(await focusedKey(page, detail)).toBe(above);
  await hoverKey(page, detail, 'resume');
  await hoverKey(page, detail, 'season-watched');
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey(page, detail)).toBe('ep:1001');
});

for (const kind of ['movie', 'series'] as const) {
  test(`the ${kind} actions keep their nodes when the details arrive, so a hover lands`, async ({ page }) => {
    const setup: Setup = { kind, resume: true, wraps: false, seasons: 1 };
    let release = () => {};
    const arrived = new Promise<void>((resolve) => { release = resolve; });
    const action = kind === 'movie' ? 'get_vod_info' : 'get_series_info';
    // Registered after seed's routes, so it wins: plot and cast come late.
    await seed(page, setup);
    await page.route(`**/player_api.php*action=${action}*`, async (route) => {
      await arrived;
      const info = { plot: 'A plot.', cast: 'Cast One', director: 'Director One', duration_secs: 3600 };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(kind === 'movie'
        ? { info } : { info, episodes: { 1: [{ id: '1001', title: 'Episode 1', season: 1, episode_num: 1,
          container_extension: 'mp4', info: { duration_secs: 1500 } }] } }) });
    });
    await page.goto('/');
    const section = kind === 'movie' ? 'movies' : 'series';
    await enterTab(page, section);
    const view = `#view-${section}`;
    await hover(page.locator(`${view} .catalog-tile[data-item-id="${kind === 'movie' ? '10' : '20'}"]`).last());
    await page.keyboard.press('Enter');
    const watchlist = page.locator(`${view} .detail-actions [data-key="watchlist"]`);
    await expect(watchlist).toBeVisible();
    await watchlist.evaluate((el) => { (window as unknown as { __watchlist: Element }).__watchlist = el; });
    release();
    await expect(page.locator(`${view} .detail-plot`)).toBeVisible();
    await expect(page.locator(`${view} .detail-cast`).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __watchlist: Element }).__watchlist.isConnected)).toBe(true);
    await page.evaluate(() => (window as unknown as { __watchlist: Element }).__watchlist
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await expect(watchlist).toHaveClass(/\bfocused\b/);
  });
}
