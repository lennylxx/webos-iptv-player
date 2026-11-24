import { test, expect, routeLiveManifest, routeFakeAi, enterTab, liveLoaded, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';
import { channelPlaylist, guide } from './fixtures/live';
import {
  KEYS, DIRECTIONS, seededRandom, installNavBox, hover, type Direction, type NavBoxWindow,
} from './navigation-helpers';

// Generic D-pad invariants on every main screen, with no rules of the
// screen's own (navigation-catalog-detail.spec.ts has those for the detail screens):
//   A. Focus after a key is on screen: laid out, inside the viewport once
//      settled, and not covered, unless it left Up to the tab bar.
//   B. Left and Right land on the source's line, the pressed way, or cross
//      between side-by-side columns listed in a screen's `cross`; they stay
//      only when the source's own nav container holds nothing navigable on
//      its line that way.
//   C. Up and Down change line, the pressed way, never stepping beside the
//      source on its own line, or stay.
//   D. From the screen's first focus, arrow keys reach everything on screen.
//   E. No page or console errors.
// Each screen runs every key from a sample of what is on screen, placed by
// hover with another element hovered first so nothing remembered carries
// over (by keys along the found paths where hover cannot place focus), a
// bounded search over keys from the first focus, and (in the chromium
// project only) a seeded keyboard-only walk.

// --- Confirmed app bugs: each fails the run once fixed, so its entry goes
// with the fix. The sweep must still see each one; walks only tolerate them.
interface Known {
  // The screens it shows on, by name.
  screen: RegExp; invariant: string; direction: Direction | '-';
  // The elements the key starts on (for D, the elements no key reaches).
  from: RegExp;
  observed: string; why: string;
}

const KNOWN_FAILING: Known[] = [];

interface Box { top: number; bottom: number; left: number; right: number }

interface Item {
  id: string; label: string; box: Box; column: string; group: string;
  // Why it is not on screen; empty when it is.
  hidden: string;
  // Its nearest nav container, and whether SpatialNav could move to it
  // (laid out and visible, if maybe scrolled away or covered).
  container: string; navigable: boolean;
  // What it belongs to, by the screen's `tags`.
  tag: string;
}

interface Focus {
  kind: 'item' | 'tab' | 'none' | 'other';
  item: Item | null;
  owner: string;
}

interface ProbeScreen {
  root: string; focusables: string; columns: Array<[string, string]>;
  // A surface that paints its own cells (the guide's timeline): `cells` are
  // its pooled cell nodes, named by their text, or by the `cellRow` beside
  // them when empty; `ring` is the one element that rings the focused cell;
  // and the pointer reaches a cell by moving over `surface`.
  cells?: string; cellRow?: string; ring?: string; surface?: string;
  // [selector, attribute]: the attribute of the first ancestor-or-self an
  // element has matching the selector, tried in order, is its tag.
  tags: Array<[string, string]>;
}

interface Probe {
  scan(s: ProbeScreen): Item[];
  focus(s: ProbeScreen): Focus;
  after(s: ProbeScreen, from: string): Promise<{ focus: Focus; from: Box | null }>;
  place(s: ProbeScreen, id: string, other: string | null): Promise<string>;
  // Notes where every scroller in the screen is, for place to go back to.
  home(s: ProbeScreen): void;
}

type ProbeWindow = Window & { __navProbe: Probe };

// Installed before the app loads, so every probe is one page round trip.
function installProbe(): void {
  const navBox = (el: Element): DOMRect => (window as unknown as NavBoxWindow).__navBox(el);
  const boxOf = (el: Element): Box => {
    const r = navBox(el);
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const nameOf = (el: Element): string => el.getAttribute('data-key') || el.id || '';
  const pathOf = (el: Element, root: Element): string => {
    const parts: number[] = [];
    let node: Element = el;
    while (node !== root && node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node) as number);
      node = node.parentElement;
    }
    return `@${parts.join('.')}`;
  };
  const elements = (s: ProbeScreen) => {
    const root = document.querySelector(s.root);
    const els = root ? Array.from(root.querySelectorAll(s.focusables)) : [];
    // An element's key or id, else its classes and place among their kind.
    const shape = (el: Element) => `${el.tagName.toLowerCase()}.${Array.from(el.classList)
      .filter((c) => c !== 'focused' && c !== 'active' && c !== 'focused-parked').join('.')}`;
    const counts: Record<string, number> = {};
    const seen: Record<string, number> = {};
    const ids = new Map<Element, string>();
    for (const el of els) counts[nameOf(el)] = (counts[nameOf(el)] || 0) + 1;
    for (const el of els) {
      const name = nameOf(el);
      if (name && counts[name] === 1) { ids.set(el, name); continue; }
      const kind = shape(el);
      seen[kind] = (seen[kind] || 0) + 1;
      ids.set(el, `${kind}#${seen[kind] - 1}`);
    }
    // Pooled cells change node as they scroll, so their text names them.
    if (s.cells) {
      const rows = s.cellRow && root ? Array.from(root.querySelectorAll(s.cellRow)) : [];
      for (const el of els) {
        if (!el.matches(s.cells)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = navBox(el);
        const mid = (r.top + r.bottom) / 2;
        const row = rows.find((x) => { const q = navBox(x); return q.top <= mid && q.bottom > mid; });
        const rowText = row ? (row.textContent || '').replace(/\s+/g, ' ').trim() : '';
        ids.set(el, `cell:${rowText}|${text}`);
      }
    }
    const idOf = (el: Element) => ids.get(el) || pathOf(el, root!);
    return { root, els, idOf };
  };
  const describe = (el: Element): string => {
    const name = nameOf(el);
    const text = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}.${Array.from(el.classList).slice(0, 2).join('.')}${
      name ? `[${name}]` : ''}${text ? ` "${text}"` : ''}`;
  };
  const hiddenWhy = (el: Element, s?: ProbeScreen): string => {
    const r = navBox(el);
    if (r.width <= 0 || r.height <= 0) return 'not laid out';
    if (getComputedStyle(el).visibility === 'hidden') return 'visibility hidden';
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      return `off screen at ${Math.round(r.left)},${Math.round(r.top)}`;
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit) return 'nothing at its center';
    if (el.contains(hit)) return '';
    if (hit.contains(el) && getComputedStyle(el).pointerEvents === 'none') return '';
    // The ring drawn over the focused cell does not cover it.
    if (s && s.ring && hit.closest(s.ring)) return '';
    return `covered by ${describe(hit)}`;
  };
  const toItem = (s: ProbeScreen, el: Element, id: string): Item => {
    const parent = el.parentElement;
    const container = el.closest('[data-nav-container]');
    const r = navBox(el);
    let tag = '';
    for (const [selector, attribute] of s.tags) {
      const owner = el.closest(selector);
      if (owner) { tag = owner.getAttribute(attribute) || ''; break; }
    }
    return {
      id,
      label: describe(el),
      box: boxOf(el),
      column: (s.columns.find(([, sel]) => el.closest(sel)) || ['main'])[0],
      group: parent ? pathOf(parent, document.body) : '',
      hidden: hiddenWhy(el, s),
      container: container ? pathOf(container, document.body) : '',
      navigable: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
      tag,
    };
  };
  const settle = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30)));
  });
  const focus = (s: ProbeScreen): Focus => {
    const owner = document.querySelector('[data-ring-owner]');
    const ownerName = owner ? owner.getAttribute('data-focus-scope') || owner.id || owner.className : 'none';
    if (owner && (owner.closest('#tab-bar, .tab-bar') || owner.querySelector('.tab-bar-inner'))) {
      return { kind: 'tab', item: null, owner: ownerName };
    }
    const { root, els, idOf } = elements(s);
    if (!root || !owner || !(owner === root || root.contains(owner) || owner.contains(root))) {
      return { kind: 'other', item: null, owner: ownerName };
    }
    let el: Element | null = null;
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && root.contains(active)) {
      const target = active.closest(s.focusables);
      if (target && els.indexOf(target) >= 0) el = target;
    }
    // A painted surface rings its focused cell: the cell under the ring.
    const ring = s.ring ? root.querySelector(s.ring) : null;
    if (!el && ring && ring.classList.contains('focused') && s.cells) {
      const rb = navBox(ring);
      let best = 0;
      for (const cell of els) {
        if (!cell.matches(s.cells)) continue;
        const cb = navBox(cell);
        const w = Math.min(rb.right, cb.right) - Math.max(rb.left, cb.left);
        const h = Math.min(rb.bottom, cb.bottom) - Math.max(rb.top, cb.top);
        if (w > 0 && h > 0 && w * h > best) { best = w * h; el = cell; }
      }
    }
    if (!el) {
      for (const lit of Array.from(root.querySelectorAll('.focused'))) {
        const target = lit.closest(s.focusables);
        if (target && els.indexOf(target) >= 0) { el = target; break; }
      }
    }
    if (!el) return { kind: 'none', item: null, owner: ownerName };
    return { kind: 'item', item: toItem(s, el, idOf(el)), owner: ownerName };
  };
  const find = (s: ProbeScreen, id: string): Element | null => {
    const { els, idOf } = elements(s);
    return els.find((el) => idOf(el) === id) || null;
  };
  let homes: Array<[Element, number, number]> = [];
  const goHome = () => {
    for (const [el, top, left] of homes) {
      if (el.scrollTop !== top) el.scrollTop = top;
      if (el.scrollLeft !== left) el.scrollLeft = left;
    }
  };
  let hovered: Element | null = null;
  const hover = (el: Element, s: ProbeScreen) => {
    if (hovered && hovered !== el) hovered.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    hovered = el;
    const surface = s.cells && s.surface && el.matches(s.cells) ? document.querySelector(s.surface) : null;
    if (surface) {
      // The surface hit-tests the pointer instead of hovering a cell.
      const r = navBox(el);
      surface.dispatchEvent(new CustomEvent('nav:pointermove', {
        bubbles: true, detail: { clientX: (r.left + r.right) / 2, clientY: (r.top + r.bottom) / 2 },
      }));
      return;
    }
    el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
  };
  const probe: Probe = {
    scan(s) {
      const { els, idOf } = elements(s);
      return els.map((el) => toItem(s, el, idOf(el)));
    },
    focus,
    async after(s, from) {
      await settle();
      let now = focus(s);
      // A list may still be scrolling its focus into view.
      if (now.item && now.item.hidden) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        now = focus(s);
      }
      const source = find(s, from);
      return { focus: now, from: source ? boxOf(source) : null };
    },
    home(s) {
      const root = document.querySelector(s.root);
      const all = root ? [root, ...Array.from(root.querySelectorAll('*'))] : [];
      homes = all.filter((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
        .map((el): [Element, number, number] => [el, el.scrollTop, el.scrollLeft]);
    },
    async place(s, id, other) {
      const active = document.activeElement as HTMLElement | null;
      // A field with the caret only notes what the pointer hovers.
      if (active && active.tagName === 'INPUT' && document.querySelector(s.root)?.contains(active)) active.blur();
      const away = other !== null ? find(s, other) : null;
      if (away) {
        hover(away, s);
        await settle();
      }
      let target = find(s, id);
      // A virtual list scrolled away has dropped it: scroll back, as a wheel
      // would, to where the screen started.
      for (let i = 0; i < 4 && !target && homes.length; i++) {
        goHome();
        await settle();
        target = find(s, id);
      }
      if (!target) return 'gone';
      if (hiddenWhy(target, s)) {
        // Brought on screen first, as a wheel would.
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await settle();
        target = find(s, id);
        if (!target) return 'gone after scrolling into view';
      }
      hover(target, s);
      for (let i = 0; i < 4; i++) {
        await settle();
        const now = focus(s);
        if (now.item && now.item.id === id) return now.item.hidden ? `focused but ${now.item.hidden}` : '';
      }
      const now = focus(s);
      return `hover left focus on ${now.item ? now.item.id : now.kind}`;
    },
  };
  (window as unknown as ProbeWindow).__navProbe = probe;
}

// The focus fuzz's 200 channels and 12-channel guide, with "one" in some
// channel and programme names so a search finds every kind.
async function seed(page: Page): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  const playlist = channelPlaylist(200, { name: (i) => `${i % 20 === 1 ? 'One' : 'Ch'} ${i}` });
  // Registered after the fixture's routes, so these win.
  await page.route('**/get.php*', (r) => r.fulfill({
    status: 200, contentType: 'application/x-mpegurl', body: playlist,
  }));
  const xmltv = guide(12, { title: (c, i) => `${i % 4 ? 'Show' : 'One'} ${c}-${i}` });
  await page.route('**/xmltv.php*', (r) => r.fulfill({ status: 200, contentType: 'application/xml', body: xmltv }));
  await routeLiveManifest(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_animation_mode', JSON.stringify('essential'));
  });
  await installNavBox(page);
  await page.addInitScript(installProbe);
}

// --- Screens

interface Cross {
  from: string; direction: Direction; to: string; why: string;
  // The target must share the source's tag, when the source has one.
  sameTag?: boolean;
}

interface Screen extends ProbeScreen {
  name: string;
  // Seeds more than the shared accounts, after them.
  seed?(page: Page): Promise<void>;
  open(page: Page): Promise<void>;
  // Side-by-side columns, where Left and Right legitimately change line.
  cross: Cross[];
  // Rules of the screen's own, checked in a test of their own.
  check?(page: Page): Promise<void>;
  // D explores what keys scroll into view too, once nothing on screen at the
  // start has keys left: a key leads off screen before the way back.
  followScroll?: boolean;
  // Keys that close the screen by design (the player menu), and how to tell
  // it closed; after one does, `open` shows it again. A key that leaves the
  // screen open but loses focus is still judged.
  closedBy?: { keys: Direction[]; closed(page: Page): Promise<boolean> };
}

const probeOf = (s: Screen): ProbeScreen => ({
  root: s.root, focusables: s.focusables, columns: s.columns, tags: s.tags,
  cells: s.cells, cellRow: s.cellRow, ring: s.ring, surface: s.surface,
});

const readFocus = (page: Page, s: Screen) =>
  page.evaluate((p) => (window as unknown as ProbeWindow).__navProbe.focus(p), probeOf(s));

// Wait until the screen owns the keys with a ring, spending the first key on
// showing a ring a pointer tab click deferred.
async function ownKeys(page: Page, s: Screen): Promise<void> {
  await expect.poll(async () => (await readFocus(page, s)).kind !== 'other', { timeout: 10_000 }).toBe(true);
  const deferred = await page.evaluate(() => document.querySelector('[data-ring-owner]')?.getAttribute('data-ring-owner'));
  const first = await readFocus(page, s);
  if (deferred === 'deferred' || first.kind !== 'item') await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await readFocus(page, s)).kind, { timeout: 5000 }).toBe('item');
}

async function openTab(page: Page, section: 'epg' | 'settings' | 'movies' | 'series' | 'search'): Promise<void> {
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, section);
}

// M3U playlists in place of the Xtream account, each the first `per` of the
// shared channels, and the shared guide as a manual source.
async function seedM3u(page: Page, playlists: number, per: number): Promise<void> {
  const playlist = channelPlaylist(per, { name: (i) => `${i % 20 === 1 ? 'One' : 'Ch'} ${i}` });
  await page.route('**/list*.m3u', (r) => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: playlist }));
  const xmltv = guide(12, { title: (c, i) => `${i % 4 ? 'Show' : 'One'} ${c}-${i}` });
  await page.route('**/guide.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml', body: xmltv }));
  await page.addInitScript((n) => {
    localStorage.setItem('iptv_playlists', JSON.stringify(Array.from({ length: n }, (_, i) =>
      ({ id: `p${i + 1}`, name: `List ${i + 1}`, url: `http://host/list${i + 1}.m3u` }))));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  }, playlists);
}

// Three series categories of 30, so rails fill the screen. Series One stays
// first in Cat B.
async function seedSeries(page: Page): Promise<void> {
  const categories = ['2', '3', '4'];
  await page.route('**/player_api.php*', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'get_series_categories') {
      return json(categories.map((id) => ({ category_id: id, category_name: `Cat ${'ABCD'[Number(id) - 1]}` })));
    }
    if (action !== 'get_series') return route.fallback();
    const asked = url.searchParams.get('category_id');
    return json((asked ? [asked] : categories).flatMap((id) => Array.from({ length: 30 }, (_, i) => (
      id === '2' && i === 0 ? { series_id: 20, name: 'Series One', cover: '', category_id: '2' }
        : { series_id: Number(id) * 1000 + i, name: `Series ${id}-${String(i)}`, cover: '', category_id: id }))));
  });
}

const SETTINGS: Omit<Screen, 'name' | 'open'> = {
  root: '#view-settings',
  focusables: '[data-focusable]',
  columns: [['categories', '.settings-sidebar'], ['actions', '.settings-actions'], ['pane', '.settings-scroll']],
  tags: [['[data-settings-category]', 'data-settings-category'], ['[data-settings-target]', 'data-settings-target']],
  cross: [
    { from: 'categories', direction: 'right', to: 'pane', sameTag: true, why: 'Right enters the category shown' },
    { from: 'pane', direction: 'left', to: 'categories', sameTag: true, why: 'Left returns to the category of the control' },
    { from: 'actions', direction: 'left', to: 'categories', why: 'Left from Cancel returns to the category, as from the pane' },
  ],
  // Right from a category scrolled down to its end enters its first control,
  // above the pane's top.
  followScroll: true,
};

// Each category after General scrolled to the top of the pane, so its own
// controls are what is on screen.
const SETTINGS_CATEGORIES = ['sources', 'guide', 'appearance', 'playback', 'subtitles', 'ai', 'advanced', 'data'];

const LIVE: Omit<Screen, 'name' | 'open'> = {
  root: '#view-channels',
  focusables: '[data-focusable]',
  columns: [['groups', '.sidebar'], ['channels', '.channel-main']],
  tags: [],
  cross: [
    { from: 'groups', direction: 'right', to: 'channels', why: 'Right enters the channel list where it was left' },
    { from: 'channels', direction: 'left', to: 'groups', why: 'Left returns to the group shown' },
  ],
};

const MANY_GROUPS = 45;
// The group a Live many groups screen selects, below the group list's
// rendered window once that is scrolled back to the top.
const FAR_GROUP = 'Group 40';

const ringOn = (page: Page, selector: string) => page.evaluate((sel) =>
  !!document.querySelector(`#view-channels ${sel}`)?.classList.contains('focused'), selector);

async function inGroupList(page: Page, selector: string): Promise<boolean> {
  return page.locator('#view-channels .group-list').evaluate((list, sel) => {
    const el = list.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    return r.height > 0 && r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
  }, selector);
}

const SEARCH: Omit<Screen, 'name' | 'open'> = {
  root: '#view-search',
  focusables: '[data-focusable]',
  columns: [],
  tags: [],
  cross: [],
};

async function searchFor(page: Page, query: string): Promise<void> {
  await openTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill(query);
}

// A fake AI server whose filter searches the keyword alone, so AI search
// shows its filter above every kind of result.
async function seedAiSearch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_llm', JSON.stringify({
      enabled: true,
      baseUrl: 'http://ai.test/v1',
      model: 'm1',
      capabilities: {
        signature: 'http://ai.test/v1|m1', structured: 'json_schema',
        thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1,
      },
    }));
  });
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const filter = {
      types: [], keywords: ['one'], groups: [], categories: [], genres: [], time: 'any', from_hour: -1, to_hour: -1,
    };
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(filter) } }] }) });
  });
}

const SCREENS: Screen[] = [
  {
    ...LIVE,
    name: 'Live',
    async open(page) {
      await page.goto('/');
      await liveLoaded(page);
      await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
    },
  },
  {
    ...LIVE,
    name: 'Live many groups',
    followScroll: true,
    async seed(page) {
      const playlist = channelPlaylist(200, {
        name: (i) => `Ch ${i}`,
        group: (i) => `Group ${String((i - 1) % MANY_GROUPS + 1).padStart(2, '0')}`,
      });
      await page.route('**/get.php*', (r) => r.fulfill({
        status: 200, contentType: 'application/x-mpegurl', body: playlist,
      }));
    },
    async open(page) {
      await page.goto('/');
      await liveLoaded(page);
      const list = page.locator('#view-channels .group-list');
      const far = page.locator(`#view-channels .group-item[data-group="source:${FAR_GROUP}"]`);
      // Scrolled down to it, as a wheel would, and picked by OK, so no
      // pointer stays over the list to hover what scrolls under it.
      await expect.poll(async () => {
        await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        return far.count();
      }).toBe(1);
      await hover(far);
      await expect(far).toHaveClass(/\bfocused\b/);
      await page.keyboard.press('Enter');
      await expect(far).toHaveClass(/\bactive\b/);
      await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
      await hover(page.locator('#view-channels .channel-main [data-list-position="0"]'));
      await expect.poll(async () => {
        await list.evaluate((el) => { el.scrollTop = 0; });
        return far.count();
      }).toBe(0);
    },
    async check(page) {
      const list = page.locator('#view-channels .group-list');
      const group = (n: number) => `.group-item[data-group="source:Group ${String(n)}"]`;
      const far = group(Number(FAR_GROUP.slice(-2)));
      const fromEdit = async () => {
        await expect.poll(async () => {
          await list.evaluate((el) => { el.scrollTop = 0; });
          return page.locator(`#view-channels ${far}`).count();
        }).toBe(0);
        await hover(page.locator('#view-channels [data-edit-channels]'));
        await expect.poll(() => ringOn(page, '[data-edit-channels]')).toBe(true);
      };
      await fromEdit();
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => ringOn(page, far)).toBe(true);
      await expect.poll(() => inGroupList(page, far)).toBe(true);
      // Keys straight after the reveal, while its scroll is still settling.
      await fromEdit();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
      const next = Number(FAR_GROUP.slice(-2)) + 2;
      await expect.poll(() => ringOn(page, group(next)), `Down to Group ${String(next)}`).toBe(true);
      await expect.poll(() => inGroupList(page, group(next))).toBe(true);
      // One group a key on to the real last group, which Down keeps.
      for (let n = next + 1; n <= MANY_GROUPS; n++) {
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => ringOn(page, group(n)), `Down to Group ${String(n)}`).toBe(true);
      }
      const last = group(MANY_GROUPS);
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press('ArrowDown');
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        expect(await ringOn(page, last), 'Down at the last group').toBe(true);
      }
      await expect.poll(() => inGroupList(page, last)).toBe(true);
      await expect(page.locator('#view-channels .focused')).toHaveCount(1);
    },
  },
  {
    ...LIVE,
    name: 'Live playlist tabs',
    seed: (page) => seedM3u(page, 3, 70),
    async open(page) {
      await page.goto('/');
      await liveLoaded(page);
      await expect(page.locator('#view-channels .playlist-tab')).toHaveCount(4);
      await expect(page.locator('#view-channels .channel-item').first()).toBeVisible();
    },
  },
  {
    name: 'Guide',
    root: '#view-epg',
    // The guide lights its own rows: no [data-focusable] there.
    focusables: '[data-hover-target], .epg-search-wrap, [data-epg-reminders]',
    columns: [['menu', '.epg-group-menu'], ['channels', '.epg-channels-pane'], ['programs', '.epg-right-pane']],
    tags: [],
    cross: [
      { from: 'channels', direction: 'left', to: 'menu', why: 'Left opens the group menu over the channels' },
      { from: 'menu', direction: 'left', to: 'channels', why: 'Left closes the group menu' },
      { from: 'channels', direction: 'right', to: 'programs', why: 'Right enters the programs of the channel' },
      { from: 'programs', direction: 'left', to: 'channels', why: 'Left returns to the channel' },
    ],
    async open(page) {
      await openTab(page, 'epg');
      await expect(page.locator('#view-epg .epg-programme-item').first()).toBeVisible();
    },
  },
  {
    ...SETTINGS,
    name: 'Settings',
    async open(page) {
      await openTab(page, 'settings');
      await expect(page.locator('#view-settings .settings-nav-item').first()).toBeVisible();
    },
  },
  ...SETTINGS_CATEGORIES.map((category): Screen => ({
    ...SETTINGS,
    name: `Settings ${category}`,
    async open(page) {
      await openTab(page, 'settings');
      const item = page.locator(`#view-settings .settings-nav-item[data-settings-target="${category}"]`);
      await item.click();
      await expect(item).toHaveClass(/\bactive\b/);
      const pane = page.locator('#view-settings .settings-scroll');
      // Scrolled until the category heads the pane, or the pane can go no further.
      await expect.poll(() => pane.evaluate((el, id) => {
        const section = document.getElementById(`settings-${id}`)!;
        const atTop = Math.abs(section.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 2;
        return atTop || el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      }, category)).toBe(true);
      // The last category on to the end of the pane, as a wheel would, so
      // its last line shows above the actions bar.
      if (category === SETTINGS_CATEGORIES[SETTINGS_CATEGORIES.length - 1]) {
        await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await expect.poll(() => pane.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
      }
    },
  })),
  {
    name: 'Player translation language',
    root: '#player-menu',
    focusables: '.menu-item',
    columns: [],
    tags: [],
    cross: [],
    // Left and Right close the player menu.
    closedBy: {
      keys: ['left', 'right'],
      closed: (page) => page.locator('#player-menu').evaluate((el) => !el.classList.contains('visible')),
    },
    async seed(page) {
      await routeFakeAi(page, () => ({}));
    },
    async open(page) {
      const menu = page.locator('#player-menu');
      if (!await page.locator('#view-player').isVisible()) {
        await openTab(page, 'movies');
        await hover(page.locator('#view-movies .catalog-tile[data-item-id="10"]').first());
        await page.keyboard.press('Enter');
        await expect(page.locator('#view-movies .detail-plot')).toBeVisible();
        await hover(page.locator('#view-movies [data-action="play"]'));
        await page.keyboard.press('Enter');
        await expect(page.locator('#player-osd .osd-channel-name')).toBeVisible();
      }
      const openSubtitles = async () => {
        await page.mouse.move(960, 540);
        await page.mouse.move(1900, 540);
        await expect(menu).toBeVisible();
        await hover(menu.locator('[data-menu-action="__subs_open__"]'));
        await page.keyboard.press('Enter');
      };
      await openSubtitles();
      const sub = menu.locator('.menu-item[data-menu-action="__subs_track__"]:not([data-track-index="-1"])').first();
      if (!(await sub.textContent())?.includes('✓')) {
        await hover(sub);
        await page.keyboard.press('Enter');
        await openSubtitles();
      }
      await hover(menu.locator('[data-menu-action="__subs_translate_open__"]'));
      await page.keyboard.press('Enter');
      await expect(menu.locator('[data-menu-action="__subs_translate_pick__"]').first()).toBeVisible();
      // Done sliding in, so every row is where the probe measures it.
      await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).transform))
        .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    },
  },
  {
    name: 'Parental suggestion review',
    root: '.suggestion-review',
    focusables: '[data-focusable]',
    columns: [['actions', '.suggestion-review-actions'], ['list', '.suggestion-review-list']],
    tags: [],
    cross: [],
    followScroll: true,
    async seed(page) {
      // Every group flagged, half of them high-confidence, so the list scrolls.
      await routeFakeAi(page, (user) => ({
        flagged: (JSON.parse(user) as { items: Array<{ i: number }> }).items.map((item) => ({
          i: item.i, verdict: item.i % 3 ? 'mature' : 'adult', confidence: item.i % 2 ? 'low' : 'high',
        })),
      }));
    },
    async open(page) {
      await openTab(page, 'settings');
      await page.locator('#manage-parental-controls').click();
      const prompt = page.locator('.parental-pin-prompt .parental-pin-input');
      await prompt.fill('1234');
      await expect(page.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await prompt.fill('1234');
      await page.locator('#view-parental-controls [data-parental-ai]').click();
      await page.locator('.confirmation-prompt [data-confirm-action="confirm"]').click();
      await page.mouse.move(1, 1);
      await expect(page.locator('.suggestion-review .focused')).toHaveCount(1);
    },
  },
  {
    name: 'Guide timeline',
    root: '#view-epg',
    // The timeline paints its own cells and one ring over the focused one.
    focusables: '[data-hover-target]:not(.epg-tl-surface), .epg-search-wrap, [data-epg-reminders], .tl-cell',
    cells: '.tl-cell',
    cellRow: '.tl-name',
    ring: '.epg-tl-focus',
    surface: '.epg-tl-surface',
    columns: [['menu', '.epg-group-menu'], ['timeline', '.epg-tl']],
    tags: [],
    cross: [],
    async seed(page) {
      await page.addInitScript(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
    },
    async open(page) {
      await openTab(page, 'epg');
      await expect(page.locator('#view-epg .epg-tl-surface .tl-cell').first()).toBeVisible();
    },
  },
  {
    name: 'Theme editor',
    root: '.theme-editor-host',
    focusables: '[data-focusable]',
    columns: [['heading', '.theme-editor-heading'], ['list', '.theme-editor-list']],
    tags: [],
    cross: [],
    followScroll: true,
    async open(page) {
      await openTab(page, 'settings');
      await page.locator('#view-settings .settings-nav-item[data-settings-target="appearance"]').click();
      await page.locator('[data-theme-new]').click();
      await page.mouse.move(1, 1);
      await expect(page.locator('.theme-editor [data-color-seed="accent"]')).toHaveClass(/focused/);
    },
  },
  {
    name: 'Theme color picker',
    root: '.theme-color-picker',
    focusables: '[data-focusable]',
    columns: [['palette', '.theme-picker-grid'], ['fine', '.theme-picker-dialog']],
    tags: [],
    cross: [],
    async open(page) {
      await openTab(page, 'settings');
      await page.locator('#view-settings .settings-nav-item[data-settings-target="appearance"]').click();
      await page.locator('[data-theme-new]').click();
      await page.mouse.move(1, 1);
      await page.keyboard.press('Enter');
      await expect(page.locator('.theme-color-picker .theme-picker-cell').first()).toHaveClass(/focused/);
    },
  },
  {
    ...SEARCH,
    name: 'Search',
    async open(page) {
      await searchFor(page, 'one');
      const view = page.locator('#view-search');
      await expect(view.locator('.search-channel-tile').first()).toBeVisible();
      await expect(view.locator('.search-program-row').first()).toBeVisible();
      await expect(view.locator('.catalog-tile[data-stream-id="10"]')).toHaveCount(1);
      await expect(view.locator('.catalog-tile[data-series-id="20"]')).toHaveCount(1);
      await page.locator('.tab-bar-search-input').press('ArrowDown');
    },
  },
  {
    ...SEARCH,
    name: 'Search AI search',
    seed: seedAiSearch,
    async open(page) {
      await searchFor(page, 'one tonight');
      const view = page.locator('#view-search');
      const ask = view.locator('.search-ask-action');
      await expect(ask).toBeVisible();
      await page.locator('.tab-bar-search-input').press('ArrowDown');
      await expect(ask).toHaveClass(/focused/);
      await page.keyboard.press('Enter');
      await expect(view.locator('.search-ask-summary')).toBeVisible();
      await expect(view.locator('.search-channel-tile').first()).toBeVisible();
      await expect(view.locator('.search-program-row').first()).toBeVisible();
    },
  },
  {
    ...SEARCH,
    name: 'Search with AI search offered',
    seed: seedAiSearch,
    async open(page) {
      await searchFor(page, 'one');
      const view = page.locator('#view-search');
      await expect(view.locator('.search-ask-action')).toBeVisible();
      await expect(view.locator('.search-channel-tile').first()).toBeVisible();
      await expect(view.locator('.search-program-row').first()).toBeVisible();
      await page.locator('.tab-bar-search-input').press('ArrowDown');
    },
  },
  {
    ...SEARCH,
    name: 'Search M3U',
    seed: (page) => seedM3u(page, 1, 200),
    async open(page) {
      await searchFor(page, 'one');
      const view = page.locator('#view-search');
      await expect(view.locator('.search-channel-rail .search-channel-tile').first()).toBeVisible();
      await expect(view.locator('.search-program-row').first()).toBeVisible();
      await page.locator('.tab-bar-search-input').press('ArrowDown');
    },
  },
  {
    name: 'Search Recent searches',
    root: '.search-history-dropdown',
    focusables: '[data-focusable]',
    columns: [['clear', '.search-history-clear'], ['searches', '.search-history-tiles']],
    tags: [],
    cross: [
      { from: 'searches', direction: 'right', to: 'clear', why: 'Right from the end of the top line reaches Clear above it' },
      { from: 'clear', direction: 'left', to: 'searches', why: 'Left from Clear returns to the end of the top line' },
    ],
    async seed(page) {
      await page.addInitScript(() => {
        localStorage.setItem('iptv_search_history', JSON.stringify(
          ['one', 'Ch 2', 'Show 3', 'Movie', 'Series', 'Alpha', 'Bravo', 'Charlie', 'Ch 40', 'One 21']));
      });
    },
    async open(page) {
      await openTab(page, 'search');
      const tiles = page.locator('.search-history-dropdown .search-history-tile');
      await expect(tiles.first()).toBeVisible();
      await page.locator('.tab-bar-search-input').press('ArrowDown');
      await expect(tiles.first()).toHaveClass(/focused/);
    },
  },
  {
    ...SEARCH,
    name: 'Movies',
    root: '#view-movies',
    async open(page) {
      await openTab(page, 'movies');
      await expect(page.locator('#view-movies .catalog-see-all[data-category-id="2"]')).toHaveCount(1);
    },
  },
  {
    ...SEARCH,
    name: 'Movies See all',
    root: '#view-movies',
    async open(page) {
      await openTab(page, 'movies');
      const seeAll = page.locator('#view-movies .catalog-see-all[data-category-id="1"]');
      await expect(seeAll).toHaveCount(1);
      await ownKeys(page, this);
      await hover(seeAll);
      await page.keyboard.press('Enter');
      await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
      await expect(page.locator('#view-movies .catalog-grid .catalog-tile').first()).toBeVisible();
    },
  },
  {
    ...SEARCH,
    name: 'Series',
    root: '#view-series',
    seed: seedSeries,
    async open(page) {
      await openTab(page, 'series');
      await expect(page.locator('#view-series .catalog-tile[data-item-id="20"]').first()).toBeVisible();
    },
  },
];

// --- Checking one key

interface Violation { invariant: string; from: string; direction: Direction | '-'; detail: string }

const vkey = (v: { invariant: string; from: string; direction: string }) => `${v.invariant} ${v.from} ${v.direction}`;
const knows = (k: Known, v: Violation) =>
  k.invariant === v.invariant && k.direction === v.direction && k.from.test(v.from);
const isKnown = (s: Screen, v: Violation) => KNOWN_FAILING.some((k) => k.screen.test(s.name) && knows(k, v));

const fmt = (b: Box) => `${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}`;

interface Verdict { violations: Violation[]; allowed: string[] }

function judge(s: Screen, from: Item, direction: Direction, pre: Item[], focus: Focus, fromAfter: Box | null): Verdict {
  const violations: Violation[] = [];
  const allowed: string[] = [];
  const fail = (invariant: string, detail: string) => violations.push({ invariant, from: from.id, direction, detail });
  const lineInvariant = direction === 'left' || direction === 'right' ? 'B' : 'C';
  if (focus.kind === 'tab') {
    if (direction !== 'up') fail(lineInvariant, 'left to the tab bar');
    return { violations, allowed };
  }
  if (focus.kind !== 'item') {
    fail('A', focus.kind === 'none' ? 'no element has focus' : `the keys went to ${focus.owner}`);
    return { violations, allowed };
  }
  const to = focus.item!;
  if (to.hidden) fail('A', `${to.label} is ${to.hidden}`);
  const cx = (b: Box) => (b.left + b.right) / 2;
  const cy = (b: Box) => (b.top + b.bottom) / 2;
  if (to.id === from.id) {
    if (lineInvariant !== 'B') return { violations, allowed };
    // As the key found it: anything navigable on the line that way, within
    // the source's own nav container, is where Left or Right should have
    // gone. A screen that moves its own focus (the guide) has none.
    const source = pre.find((i) => i.id === from.id) ?? from;
    const S = source.box;
    const ahead = source.container && pre.find((i) => i.id !== source.id && i.navigable && i.container === source.container
      && Math.min(S.bottom, i.box.bottom) - Math.max(S.top, i.box.top) > 0.5
      && (direction === 'right' ? cx(i.box) - cx(S) > 5 : cx(S) - cx(i.box) > 5));
    if (ahead) fail('B', `stayed, with ${ahead.label} on its line that way (${fmt(S)} to ${fmt(ahead.box)})`);
    return { violations, allowed };
  }
  // Both boxes as the key found them, so a pane scrolling its new focus into
  // view under a fixed source cannot turn the move around; after the key
  // only for an element a virtual list adds.
  const before = pre.find((i) => i.id === to.id);
  const [S, T] = before ? [from.box, before.box] : [fromAfter ?? from.box, to.box];
  const overlap = Math.min(S.bottom, T.bottom) - Math.max(S.top, T.top);
  let wrong = '';
  if (lineInvariant === 'B') {
    const way = direction === 'right' ? cx(T) > cx(S) : cx(T) < cx(S);
    if (overlap <= 0.5) wrong = `off its line (${fmt(S)} to ${fmt(T)})`;
    else if (!way) wrong = `the wrong way (${fmt(S)} to ${fmt(T)})`;
  } else {
    const way = direction === 'down' ? cy(T) > cy(S) : cy(T) < cy(S);
    const sameLine = overlap >= 0.5 * Math.min(S.bottom - S.top, T.bottom - T.top);
    const beside = T.left >= S.right - 1 || T.right <= S.left + 1;
    if (sameLine && beside) wrong = `beside it on its line (${fmt(S)} to ${fmt(T)})`;
    else if (!way) wrong = `the wrong way (${fmt(S)} to ${fmt(T)})`;
  }
  if (!wrong) return { violations, allowed };
  const rule = s.cross.find((c) => c.from === from.column && c.to === to.column && c.direction === direction);
  if (!rule) fail(lineInvariant, `-> ${to.label} [${to.column}], ${wrong}`);
  else if (rule.sameTag && from.tag && to.tag !== from.tag) {
    fail(lineInvariant, `-> ${to.label} [${to.column}], which is ${to.tag || 'untagged'}, not ${from.tag}`);
  } else allowed.push(`${from.label} ${direction} -> ${to.label} (${rule.from} -> ${rule.to})`);
  return { violations, allowed };
}

interface Run {
  violations: Violation[];
  allowed: Set<string>;
  pairs: number;
  skipped: string[];
  // (from, direction) -> where the key went, for travel by keys.
  edges: Map<string, Map<Direction, string>>;
}

const newRun = (): Run => ({ violations: [], allowed: new Set(), pairs: 0, skipped: [], edges: new Map() });

const TAB = '<tab bar>';

// Press one key from the focused `from`, and judge where it went.
async function step(page: Page, s: Screen, from: Item, direction: Direction, run: Run): Promise<Focus> {
  const p = probeOf(s);
  const pre = await page.evaluate((q) => (window as unknown as ProbeWindow).__navProbe.scan(q), p);
  await page.keyboard.press(KEYS[direction]);
  const { focus, from: fromAfter } = await page.evaluate(([q, id]) =>
    (window as unknown as ProbeWindow).__navProbe.after(q, id), [p, from.id] as const);
  run.pairs++;
  if (focus.kind !== 'item' && focus.kind !== 'tab' && s.closedBy?.keys.includes(direction)
    && await s.closedBy.closed(page)) {
    run.allowed.add(`${from.label} ${direction} closes the screen`);
    if (!run.edges.has(from.id)) run.edges.set(from.id, new Map());
    run.edges.get(from.id)!.set(direction, '<closed>');
    await s.open(page);
    return { kind: 'other', item: null, owner: 'closed' };
  }
  const verdict = judge(s, from, direction, pre, focus, fromAfter);
  run.violations.push(...verdict.violations);
  for (const a of verdict.allowed) run.allowed.add(a);
  const to = focus.kind === 'item' ? focus.item!.id : focus.kind === 'tab' ? TAB : `<${focus.kind}>`;
  if (!run.edges.has(from.id)) run.edges.set(from.id, new Map());
  run.edges.get(from.id)!.set(direction, to);
  return focus;
}

// Back from the tab bar into the screen.
async function leaveTabBar(page: Page, s: Screen): Promise<Focus> {
  let focus = await readFocus(page, s);
  if (focus.kind === 'tab') {
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (focus = await readFocus(page, s)).kind).not.toBe('tab');
  }
  return focus;
}

// Keys along the shortest known path from where focus is to `id`. With no
// known path, a key not yet tried from where focus is finds more (an open
// menu takes no hover outside it, but a key closes it).
async function travel(page: Page, s: Screen, id: string, run: Run): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const focus = await leaveTabBar(page, s);
    if (focus.kind !== 'item') return false;
    const at = focus.item!;
    if (at.id === id) return true;
    const back = new Map<string, { prev: string; direction: Direction }>();
    const queue = [at.id];
    const seen = new Set(queue);
    while (queue.length && !seen.has(id)) {
      const from = queue.shift()!;
      for (const [direction, to] of run.edges.get(from) ?? []) {
        if (seen.has(to) || to.startsWith('<')) continue;
        seen.add(to);
        back.set(to, { prev: from, direction });
        queue.push(to);
      }
    }
    if (!seen.has(id)) {
      const known = run.edges.get(at.id);
      const untried = DIRECTIONS.find((d) => !known?.has(d));
      if (!untried) return false;
      await step(page, s, at, untried, run);
      continue;
    }
    const path: string[] = [];
    for (let to = id; back.has(to); to = back.get(to)!.prev) path.unshift(to);
    // Where a key goes can depend on the way there: note what each one did,
    // and plan again from wherever a key strays.
    let from = at.id;
    for (const to of path) {
      const direction = back.get(to)!.direction;
      await page.keyboard.press(KEYS[direction]);
      const now = await readFocus(page, s);
      const got = now.kind === 'item' ? now.item!.id : now.kind === 'tab' ? TAB : `<${now.kind}>`;
      run.edges.get(from)!.set(direction, got);
      if (got !== to) break;
      from = to;
    }
  }
  const focus = await readFocus(page, s);
  return focus.item?.id === id;
}

// Focus `id` by hover with `other` hovered first, else by keys.
async function place(page: Page, s: Screen, id: string, other: string | null, run: Run): Promise<string> {
  await leaveTabBar(page, s);
  const why = await page.evaluate(([q, target, away]) =>
    (window as unknown as ProbeWindow).__navProbe.place(q, target, away), [probeOf(s), id, other] as const);
  if (!why) return '';
  if (await travel(page, s, id, run)) {
    const focus = await readFocus(page, s);
    return focus.item?.hidden ? `reached by keys but ${focus.item.hidden}` : '';
  }
  return `${why}, and keys found no way there`;
}

// Every visible element, capped at `cap` but always the first and last of
// each run of siblings.
function sample(items: Item[], cap: number): Item[] {
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const must = new Set<Item>();
  for (const group of groups.values()) { must.add(group[0]); must.add(group[group.length - 1]); }
  const rest = items.filter((i) => !must.has(i));
  const room = Math.max(cap - must.size, 0);
  const picked = new Set<Item>(must);
  for (let i = 0; i < Math.min(room, rest.length); i++) picked.add(rest[Math.floor((i * rest.length) / Math.min(room, rest.length))]);
  return items.filter((i) => picked.has(i));
}

async function onScreen(page: Page, s: Screen): Promise<Item[]> {
  const all = await page.evaluate((q) => (window as unknown as ProbeWindow).__navProbe.scan(q), probeOf(s));
  return all.filter((i) => !i.hidden);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The LAN service probe helpers.ts aborts on purpose.
    if (m.location().url.startsWith('http://127.0.0.1:8890')) return;
    errors.push(`console error: ${m.text()}`);
  });
  return errors;
}

// NAV_REPORT=1 prints what each test covered.
function report(s: Screen, kind: string, lines: string[]): void {
  test.info().annotations.push({ type: `${s.name} ${kind}`, description: lines.join('\n') });
  if (process.env.NAV_REPORT) console.log(`[${test.info().project.name}] ${s.name} ${kind}\n  ${lines.join('\n  ')}`);
}

function expectClean(s: Screen, run: Run, errors: string[], requireKnown: boolean): void {
  const unexpected = run.violations.filter((v) => !isKnown(s, v));
  const unique = new Map(unexpected.map((v) => [`${vkey(v)}: ${v.detail}`, v]));
  expect([...unique.keys()], `${s.name}: navigation invariants`).toEqual([]);
  if (requireKnown) {
    const fixed = KNOWN_FAILING.filter((k) => k.screen.test(s.name) && !run.violations.some((v) => knows(k, v)));
    expect(fixed.map((k) => `${k.invariant} ${String(k.from)} ${k.direction} no longer fails: remove it from KNOWN_FAILING`)).toEqual([]);
  }
  expect(errors, `${s.name}: page and console errors`).toEqual([]);
}

const CAP = 40;
const SEARCH_PRESSES = 400;
const WALK_PRESSES = 150;

for (const s of SCREENS) {
  test.describe(s.name, () => {
    test(`every arrow key from what ${s.name} shows, and arrow keys reach all of it`, async ({ page }) => {
      test.setTimeout(240_000);
      const errors = watchErrors(page);
      await seed(page);
      await s.seed?.(page);
      await s.open(page);
      await ownKeys(page, s);
      await page.evaluate((q) => (window as unknown as ProbeWindow).__navProbe.home(q), probeOf(s));
      const visible = await onScreen(page, s);
      const start = (await readFocus(page, s)).item!;
      expect(visible.length).toBeGreaterThan(0);
      const run = newRun();

      // D: explore by keys from the first focus, pressing every key from
      // wherever focus is, and placing focus (by hover, else by keys along
      // found paths) on a reached element with keys left to try.
      const want = new Set(visible.map((i) => i.id));
      const reached = [start.id];
      const tried = new Map<string, Direction[]>();
      const untried = (id: string) => DIRECTIONS.filter((d) => !(tried.get(id) ?? []).includes(d));
      const missing = () => visible.some((i) => !reached.includes(i.id));
      const open = (id: string) => untried(id).length > 0 && (want.has(id) || (!!s.followScroll && missing()
        && !reached.some((r) => want.has(r) && untried(r).length)));
      // Off screen, every key from the open element nearest a missing one
      // as laid out now, so the search heads back rather than walking the
      // whole of what scrolls.
      const nearestOpen = async (here?: string): Promise<string | undefined> => {
        const candidates = reached.filter(open);
        if (here) candidates.unshift(...candidates.splice(candidates.indexOf(here), 1));
        if (candidates.length < 2) return candidates[0];
        const now = new Map((await page.evaluate((q) => (window as unknown as ProbeWindow).__navProbe.scan(q), probeOf(s)))
          .map((i) => [i.id, i.box]));
        const targets = visible.filter((i) => !reached.includes(i.id)).map((i) => now.get(i.id) ?? i.box);
        const gap = (a: Box) => Math.min(...targets.map((b) => Math.hypot(
          Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom))));
        let best = candidates[0];
        let bestGap = Infinity;
        for (const id of candidates) {
          const box = now.get(id);
          const g = box ? gap(box) : Infinity;
          if (g < bestGap) { best = id; bestGap = g; }
        }
        return best;
      };
      let presses = 0;
      while (presses < SEARCH_PRESSES) {
        const at = (await leaveTabBar(page, s)).item;
        const here = at && reached.includes(at.id) && open(at.id) ? at.id : undefined;
        const next = here && want.has(here) ? here
          : reached.find((id) => want.has(id) && open(id)) ?? await nearestOpen(here);
        if (!next) break;
        if (at && next === here) {
          const direction = untried(at.id)[0];
          tried.set(at.id, [...(tried.get(at.id) ?? []), direction]);
          const focus = await step(page, s, at, direction, run);
          presses++;
          const to = focus.item?.id;
          if (to && (want.has(to) || s.followScroll) && !reached.includes(to)) reached.push(to);
          continue;
        }
        const away = visible.find((i) => i.id !== next)?.id ?? null;
        const why = await place(page, s, next, away, run);
        if (why) {
          run.skipped.push(`search: ${next}: ${why}`);
          tried.set(next, DIRECTIONS);
        }
      }
      const unreachable = visible.filter((i) => !reached.includes(i.id));
      if (presses >= SEARCH_PRESSES && unreachable.length) {
        throw new Error(`${s.name}: search budget exhausted after ${presses} presses; `
          + `still missing: ${unreachable.map((i) => i.label).join(', ')}`);
      }
      for (const i of unreachable) {
        run.violations.push({ invariant: 'D', from: i.id, direction: '-', detail: `${i.label} is not reached by keys` });
      }
      const searchPairs = run.pairs;

      // Every key from a sample, each placed afresh.
      const picked = sample(visible, CAP);
      let ran = 0;
      for (const item of picked) {
        for (const direction of DIRECTIONS) {
          // Through an element of another column or line first.
          const away = picked.find((i) => i.id !== item.id && i.group !== item.group)?.id
            ?? picked.find((i) => i.id !== item.id)?.id ?? null;
          const why = await place(page, s, item.id, away, run);
          if (why) { run.skipped.push(`sweep: ${item.id} ${direction}: ${why}`); continue; }
          const from = (await readFocus(page, s)).item!;
          await step(page, s, from, direction, run);
          ran++;
        }
      }
      report(s, 'coverage', [
        `${visible.length} on screen, ${visible.length - unreachable.length} reached by keys, `
          + `${reached.filter((id) => !want.has(id)).length} more scrolled into view, search ${searchPairs} key presses (${presses} of the ${SEARCH_PRESSES} budget)`,
        `sweep ${ran} key x element pairs over ${picked.length} elements, ${run.skipped.length} skipped`,
        ...run.skipped.map((k) => `skipped ${k}`),
        ...[...run.allowed].map((a) => `allowed ${a}`),
      ]);
      expect(ran, 'no key ran from a placed element').toBeGreaterThan(0);
      expectClean(s, run, errors, true);
    });

    if (s.check) {
      test(`${s.name}'s own rules`, async ({ page }) => {
        const errors = watchErrors(page);
        await seed(page);
        await s.seed?.(page);
        await s.open(page);
        await ownKeys(page, s);
        await s.check!(page);
        expect(errors, `${s.name}: page and console errors`).toEqual([]);
      });
    }

    test(`a seeded keyboard-only walk on ${s.name}`, async ({ page }, testInfo) => {
      // The per-key sweep covers the legacy engine; the walk adds no engine-specific path.
      test.skip(testInfo.project.name === 'chromium-53-simulation', 'walks run in chromium only');
      test.setTimeout(240_000);
      const errors = watchErrors(page);
      await seed(page);
      await s.seed?.(page);
      await s.open(page);
      await ownKeys(page, s);
      const run = newRun();
      const random = seededRandom(11);
      for (let i = 0; i < WALK_PRESSES; i++) {
        const focus = await leaveTabBar(page, s);
        if (focus.kind !== 'item') {
          run.violations.push({ invariant: 'A', from: '<walk>', direction: '-', detail: `step ${i}: ${focus.kind} ${focus.owner}` });
          break;
        }
        const direction = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
        await step(page, s, focus.item!, direction, run);
      }
      report(s, 'walk', [`${run.pairs} key presses`, ...[...run.allowed].map((a) => `allowed ${a}`)]);
      expectClean(s, run, errors, false);
    });
  });
}
