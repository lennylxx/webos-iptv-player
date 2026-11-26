import { test, expect, routeLiveManifest, enterTab, NOW, startClock, runTimers, type Page, type RingAuditApi } from './helpers';
import { E2E_ENV } from '../playwright.config';
import { seedXtream } from './fixtures/xtream';
import { channelPlaylist, guide } from './fixtures/live';
import { KEYS, hover } from './navigation-helpers';

// A seeded random walk of D-pad keys, pointer moves and clicks, and wheel
// steps across every section, checking the focus invariants after each step.
//
//   FOCUS_FUZZ_SEED=7,8       seeds to run (default: DEFAULT_SEEDS, SURFACE_SEEDS)
//   FOCUS_FUZZ_STEPS=500      steps per seed (default: DEFAULT_STEPS)
//   FOCUS_FUZZ_SURFACE=a,b    families to run, `walk` for the plain walk (default: all)
//   FOCUS_FUZZ_CONTINUE=1     keep walking after a violation, reporting each kind once
//   FOCUS_FUZZ_REPLAY='[…]'   replay a recorded step list instead of a seed; it
//                             takes its setup from the first FOCUS_FUZZ_SURFACE
//                             family and FOCUS_FUZZ_SEED
//
// Each surface family (SURFACES) keeps the walk on one screen: it adds the
// data that screen needs, re-enters it with a scripted step whenever the walk
// leaves (Back first from where the tab bar is gone), mostly turns Back into
// arrows, never clicks the tab bar, and never activates what its `avoid`
// lists. A prompt the walk dismisses simply opens again.
//
//   detail             Movie and Series details, resumed so every round action
//                      shows; odd seeds use long names at 150%
//   search             typed queries, results, and the recent-searches dropdown
//   settings           every category; only SETTINGS_SAFE controls activate
//   parental           the parental-control manager behind a created PIN
//   parental-accounts  the manager's account menu
//   parental-pin       the PIN prompt; it types wrong digits, never the PIN
//   reminders          the reminder manager, from Settings or the guide
//   reminder-prompt    due reminders; a reload brings dismissed ones back
//   confirm            a confirmation prompt, never confirmed
//   catchup            the guide's resume prompt for a part-watched programme
//   live-categories    the Xtream live-category picker
//   subtitle-search    the VOD player's online-subtitle results
//   subtitle-offset    the VOD player's subtitle sync adjuster
//   channel-editor     the Live list's edit mode, with the color keys
//
// A failure prints the seed and the step log; its JSON steps replay verbatim.
// Timing makes it too noisy for CI, so only `npm run test:fuzz` runs it.

const DEFAULT_SEEDS = [1, 2, 3, 6, 7];
const DEFAULT_DETAIL_SEEDS = [1, 2, 3, 4];
const SURFACE_SEEDS = [1, 2];
const DEFAULT_STEPS = 80;
const LIVENESS_EVERY = 20;
const MAX_PLAYER_STEPS = 4;
// An enter that keeps missing its surface is a broken harness, not a walk.
const MAX_ENTER_MISSES = 3;

// Tests that fail on a confirmed app bug, by title, with the finding that
// blocks them. The change that fixes a bug clears its entries here.
const KNOWN_FAILING: Record<string, string> = {};

type SurfaceName = 'detail' | 'search' | 'settings' | 'parental' | 'parental-accounts' | 'parental-pin' | 'reminders'
  | 'reminder-prompt' | 'confirm' | 'catchup' | 'live-categories' | 'subtitle-search'
  | 'subtitle-offset' | 'channel-editor';

// Data a surface needs on top of the shared Xtream setup.
type Need = 'resume' | 'catchup' | 'reminders' | 'due-reminders' | 'second-account'
  | 'live-categories' | 'search-history';

type Step =
  | { kind: 'key'; key: string }
  | { kind: 'type'; text: string }
  | { kind: 'fill'; text: string }
  | { kind: 'move' | 'click'; x: number; y: number; target: string }
  | { kind: 'wheel'; x: number; y: number; dy: number; target: string }
  | { kind: 'enter'; surface: SurfaceName; variant?: string };

interface Surface {
  // Any visible match means the walk is on the surface.
  shows: string;
  // Where `enter` can start: wherever this shows.
  from: string;
  // Lives in the full-screen player, which the walk otherwise leaves soon.
  player?: boolean;
  needs: Need[];
  enter: (page: Page, variant: string | undefined) => Promise<void>;
  variants?: string[];
  // Never clicked or activated with OK on this surface.
  avoid: string[];
  // Remote keys the walk adds there (REMOTE_KEYS).
  keys?: string[];
  // What the walk puts in a focused text box: replaced, or typed on.
  text?: { kind: 'fill' | 'type'; values: string[] };
  // Odd seeds use long names at 150%.
  pseudo?: boolean;
}

type SurfaceState = 'present' | 'closed' | 'away';

interface Candidate { x: number; y: number; target: string; focusable: boolean; tabBar: boolean; safe: boolean }

interface RingInfo { desc: string; inOwner: boolean; hoverLit: boolean; clipped: string }

interface Probe {
  audit: string | null;
  shown: string[];
  owner: string;
  ownerMark: string | null;
  scope: string | null;
  unresolved: boolean;
  ownerRingless: boolean;
  modal: boolean;
  keyboard: boolean;
  rings: RingInfo[];
  activeTab: string;
  // A prompt's text, so Back that answers one and shows the next counts, and
  // the toasts shown, so Back that only explains why it can't leave counts too.
  modalText: string;
  toasts: number;
  inputFocused: boolean;
  focusSafe: boolean;
  underPointer: {
    desc: string; lit: boolean; inModal: boolean; inTabBar: boolean; cssHover: boolean; behindMenu: boolean; caret: boolean;
  } | null;
}

interface Finding { step: number; violation: string; state: string }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, list: T[]): T {
  return list[Math.floor(rand() * list.length)];
}

const HALF_HOUR = 30 * 60 * 1000;
// The guide's first programme, four before the one airing now.
const GUIDE_START = NOW.getTime() - 4 * HALF_HOUR;
// Part-watched aired programmes, the first one the catchup enter opens.
const CATCHUP_PROGRAMMES = [2, 0, 1, 3];
const GUIDE_CHANNELS = 12;

// Color keys the remote has and a desktop keyboard lacks; dispatched by code.
const REMOTE_KEYS: Record<string, number> = { Red: 403, Green: 404, Yellow: 405, Blue: 406 };

// Settings saves nothing until Save, but some rows act at once: removing or
// switching off a source, clearing data or the cache, resetting, refreshing,
// running the channel health check, and the language (applied on Save, but
// never ours to change). Only these controls are safe to activate there.
// Adding sources is left out, so Save stays the only way to change the setup,
// and so are parental controls and the channel editor, which their own
// families enter.
const SETTINGS_SAFE = [
  '[data-settings-target]',
  '.toggle-group .toggle-option',
  '.dropdown:not(#app-language) .dropdown-trigger',
  '.dropdown:not(#app-language) .dropdown-option',
  '.theme-swatch',
  '.settings-input',
  '.epg-offset-step',
  '.epg-offset-value',
  '.check-xtream',
  '.xtream-live-categories',
  '#manage-reminders',
  '#cancel-settings',
];

const CONFIRM = '[data-confirm-action="confirm"]';
const TAB_BAR = '.tab-bar-item[data-section="settings"]';
const PARENTAL_AVOID = ['[data-parental-change-pin]', '#view-parental-controls .source-toggle', '[data-parental-back]'];

const SURFACES: Record<SurfaceName, Surface> = {
  'detail': {
    shows: '#view-movies .detail-actions, #view-series .detail-actions',
    from: TAB_BAR, needs: ['resume'], enter: enterDetail, variants: ['movies', 'series'], avoid: [], pseudo: true,
  },
  'search': {
    shows: '.tab-bar-search.expanded',
    from: TAB_BAR, needs: ['search-history'], enter: enterSearch,
    // Clearing the recent searches would leave nothing to drop down.
    avoid: ['[data-history-clear]'],
    // An emptied box drops the recent searches down.
    text: { kind: 'fill', values: ['ch', 'Ch 1', 'show', 'Show 2', 'movie', 'Movie 1-', 'series', 'zz', '', '', ''] },
  },
  'settings': {
    shows: '#view-settings',
    from: TAB_BAR, needs: [], enter: enterSettings,
    variants: ['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'advanced', 'data'],
    avoid: [],
  },
  'parental': {
    shows: '#view-parental-controls',
    from: TAB_BAR, needs: ['second-account'], enter: enterParental,
    // Changing the PIN or switching the controls off ends the family.
    avoid: PARENTAL_AVOID,
    keys: ['Red', 'Green', 'Blue'],
  },
  'parental-accounts': {
    shows: '#view-parental-controls .account-menu',
    from: `#view-parental-controls, ${TAB_BAR}`, needs: ['second-account'], enter: enterParentalAccounts, avoid: PARENTAL_AVOID,
  },
  'parental-pin': {
    shows: '.parental-pin-prompt:not(.hidden)',
    from: TAB_BAR, needs: [], enter: enterParentalPin, avoid: [],
    // Wrong digits only, so the prompt errs and locks out but never opens.
    text: { kind: 'type', values: ['5', '7'] },
  },
  'reminders': {
    shows: '#view-reminders',
    from: TAB_BAR, needs: ['reminders'], enter: enterReminders, variants: ['settings', 'epg'], avoid: [CONFIRM],
  },
  'reminder-prompt': {
    shows: '.reminder-prompt:not(.hidden)',
    from: 'body', needs: ['due-reminders'], enter: enterReminderPrompt, avoid: [],
  },
  'confirm': {
    shows: '.confirmation-prompt:not(.hidden)',
    from: TAB_BAR, needs: ['reminders'], enter: enterConfirm, variants: ['settings', 'reminders'], avoid: [CONFIRM],
  },
  'catchup': {
    shows: '.catchup-resume-prompt:not(.hidden)',
    from: TAB_BAR, needs: ['catchup'], enter: enterCatchup,
    // Start over clears the progress the prompt needs.
    avoid: ['.catchup-resume-btn[data-action="start-over"]'],
  },
  'live-categories': {
    shows: '.live-category-picker',
    from: TAB_BAR, needs: ['live-categories', 'second-account'], enter: enterLiveCategories, avoid: [],
    keys: ['Red', 'Green', 'Yellow'],
  },
  'subtitle-search': {
    shows: '#subtitle-search .subs-overlay',
    from: `#view-player, ${TAB_BAR}`, player: true, needs: [], enter: enterSubtitleSearch, avoid: [],
    text: { kind: 'fill', values: ['Movie', 'one', ''] },
  },
  'subtitle-offset': {
    shows: '#subtitle-offset:not(.hidden)',
    from: `#view-player, ${TAB_BAR}`, player: true, needs: [], enter: enterSubtitleOffset, avoid: [],
  },
  'channel-editor': {
    shows: '#view-channels .channel-view.editing',
    from: TAB_BAR, needs: [], enter: enterChannelEditor, variants: ['live', 'settings'], avoid: [],
    keys: ['Red', 'Green', 'Blue', 'Yellow'],
  },
};

// Mirrors channelKey() in src/utils/channel.ts.
function channelKey(url: string): string {
  const stable = url.split('#')[0].split('?')[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < stable.length; i++) {
    h ^= stable.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function channelUrl(i: number): string {
  return `http://host/${i}.m3u8`;
}

async function seed(page: Page, needs: Need[], pseudo: boolean): Promise<void> {
  await seedXtream(page, { catalog: 'large' });
  const has = (need: Need) => needs.includes(need);
  if (has('resume')) {
    // Three seasons of eight, so seasons, their mark and a scrolling list show.
    const episodes: Record<string, unknown[]> = {};
    for (let season = 1; season <= 3; season++) {
      episodes[String(season)] = Array.from({ length: 8 }, (_, i) => ({ id: String(season * 1000 + i + 1),
        title: `Episode ${i + 1}`, season, episode_num: i + 1, container_extension: 'mp4', info: { duration_secs: 600 } }));
    }
    await page.route('**/player_api.php*action=get_series_info*', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ info: { name: 'Series One', plot: 'A series plot.' }, episodes }),
    }));
    // More than one series, so hiding the one a detail shows leaves others.
    const series = Array.from({ length: 8 }, (_, i) => ({ series_id: 20 + i,
      name: i ? `Series ${i + 1}` : 'Series One', cover: '', category_id: '2' }));
    await page.route('**/player_api.php*', (r) => (new URL(r.request().url()).searchParams.get('action') === 'get_series'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(series) })
      : r.fallback()));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_resume', JSON.stringify({
        'x1|vod|10': { accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One', poster: '', ext: 'mp4',
          position: 600, duration: 3600, updatedAt: 2 },
        'x1|episode|1001': { accountId: 'x1', kind: 'episode', itemId: '1001', name: 'Series One — S1E1', poster: '',
          ext: 'mp4', position: 100, duration: 600, updatedAt: 1, season: 1, episode: 1, categoryId: '2',
          watchlistOwner: { kind: 'series', itemId: '20', name: 'Series One', poster: '' } },
      }));
    });
  }
  if (pseudo) await page.addInitScript(() => localStorage.setItem('iptv_text_size', JSON.stringify('150')));
  if (has('second-account')) {
    await page.addInitScript(() => {
      const playlists = JSON.parse(localStorage.getItem('iptv_playlists') ?? '[]') as unknown[];
      playlists.push({ id: 'x2', name: 'Y Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'v', password: 'q' } });
      localStorage.setItem('iptv_playlists', JSON.stringify(playlists));
    });
  }
  if (has('live-categories')) {
    const categories = Array.from({ length: 24 }, (_, i) => ({ category_id: `c${i + 1}`, category_name: `Group ${i + 1}` }));
    await page.route('**/player_api.php*action=get_live_categories*', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(categories),
    }));
  }
  if (has('search-history')) {
    await page.addInitScript(() => localStorage.setItem('iptv_search_history', JSON.stringify(['ch', 'show', 'movie'])));
  }
  const now = NOW.getTime();
  const reminders: unknown[] = [];
  // Spread over three days, so the manager groups them by day.
  if (has('reminders')) {
    for (let i = 0; i < 24; i++) {
      const startMs = GUIDE_START + (8 + i * 6) * HALF_HOUR;
      reminders.push({ channelKey: channelKey(channelUrl(i % GUIDE_CHANNELS + 1)), channelName: `Ch ${i % GUIDE_CHANNELS + 1}`,
        title: `Show ${i + 1}`, startMs, stopMs: startMs + HALF_HOUR });
    }
  }
  // Fixed start times: a reload stores the same reminders again.
  if (has('due-reminders')) {
    for (let i = 0; i < 40; i++) {
      reminders.push({ channelKey: channelKey(channelUrl(i % GUIDE_CHANNELS + 1)), channelName: `Ch ${i % GUIDE_CHANNELS + 1}`,
        title: `Show ${i + 1}`, startMs: now - (i + 1) * 60_000, stopMs: now + 6 * 60 * 60 * 1000 });
    }
  }
  if (reminders.length) {
    await page.addInitScript((list) => localStorage.setItem('iptv_reminders', JSON.stringify(list)), reminders);
  }
  if (has('catchup')) {
    const progress: Record<string, unknown> = {};
    for (let c = 1; c <= GUIDE_CHANNELS; c++) {
      const key = channelKey(channelUrl(c));
      for (const i of CATCHUP_PROGRAMMES) {
        const start = GUIDE_START + i * HALF_HOUR;
        progress[`${key}|${start}`] = { channelKey: key, progStart: start, progEnd: start + HALF_HOUR,
          position: 600, duration: 1800, updatedAt: start, completed: false, expiresAt: start + 7 * 86400 * 1000 };
      }
    }
    await page.addInitScript((p) => localStorage.setItem('iptv_catchup_progress', JSON.stringify(p)), progress);
  }
  // Registered after the fixture's routes, so these win.
  const playlist = channelPlaylist(200, { catchup: has('catchup') });
  await page.route('**/get.php*', (r) => r.fulfill({
    status: 200, contentType: 'application/x-mpegurl', body: playlist,
  }));
  const xmltv = guide(GUIDE_CHANNELS, { start: GUIDE_START });
  await page.route('**/xmltv.php*', (r) => r.fulfill({ status: 200, contentType: 'application/xml', body: xmltv }));
  await routeLiveManifest(page);
  // A second Back on Live closes the app; keep the walk going and note it.
  // Each toast replaces its text, even with the same message: count those.
  await page.addInitScript(() => {
    const w = window as unknown as { __exitRequests: number; __toasts: number };
    w.__exitRequests = 0;
    w.__toasts = 0;
    window.close = () => { w.__exitRequests += 1; };
    new MutationObserver((records) => {
      for (const r of records) if (r.target instanceof Element && r.target.classList.contains('toast')) w.__toasts++;
    }).observe(document, { subtree: true, childList: true });
  });
}

// Probes until two probes a few frames apart agree, so a transition or smooth
// scroll has landed however slow the machine is; a state that never holds
// still is taken as it last stood.
async function stillState(read: () => Promise<Probe>): Promise<Probe> {
  let last = await read();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await read();
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  return last;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 40)));
  }));
  await page.waitForFunction(() => !(window as { __ringPending?: number }).__ringPending,
    null, { timeout: 3000 }).catch(() => undefined);
}

// Elements the pointer can sensibly aim at: on screen and not covered.
async function candidates(page: Page, avoid: string[]): Promise<Candidate[]> {
  return page.evaluate(([avoidList, settingsSafe]) => {
    const api = (window as unknown as { __ringAuditApi: RingAuditApi }).__ringAuditApi;
    const sel = '[data-focusable], [data-hover-target], .tab-bar-item, .account-avatar, .account-menu-item';
    const out: Candidate[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!api.visible(el)) continue;
      const r = el.getBoundingClientRect();
      const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2));
      const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2));
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit))) continue;
      out.push({
        x, y,
        target: api.describe(el),
        focusable: el.matches('[data-focusable], [data-hover-target]'),
        tabBar: !!el.closest('.tab-bar'),
        safe: !avoidList.some((s) => el.closest(s))
          && (!el.closest('#view-settings') || settingsSafe.some((s) => el.matches(s))),
      });
    }
    return out;
  }, [avoid, SETTINGS_SAFE] as const);
}

// On the surface; or else whether its enter can start from here.
async function surfaceState(page: Page, surface: Surface): Promise<SurfaceState> {
  return page.evaluate(([shows, from]) => {
    const api = (window as unknown as { __ringAuditApi: RingAuditApi }).__ringAuditApi;
    const shown = (selector: string) => Array.from(document.querySelectorAll(selector)).some((el) => api.visible(el));
    if (shown(shows)) return 'present';
    return shown(from) ? 'closed' : 'away';
  }, [surface.shows, surface.from] as const);
}

async function probe(page: Page, input: string, pointer: { x: number; y: number } | null, avoid: string[]): Promise<Probe> {
  return page.evaluate(([inp, pt, avoidList, settingsSafe]) => {
    const api = (window as unknown as { __ringAuditApi: RingAuditApi }).__ringAuditApi;
    const report = api.inspect(inp);
    const root = document.documentElement;
    const keyboard = root.classList.contains('keyboard-nav');
    const owner = document.querySelector('[data-ring-owner]');
    const ownerMark = owner ? owner.getAttribute('data-ring-owner') : null;
    const modal = ownerMark === 'modal';
    const hoverLit = (el: Element) => !keyboard && !!owner && !owner.contains(el) && !modal
      && !!el.closest('[data-ring-hover]');

    // The area an element can paint in: the viewport cut by every clipping
    // ancestor, up to the first fixed one.
    const clipOf = (el: Element) => {
      const c = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n);
        const b = n.getBoundingClientRect();
        if (s.overflowX !== 'visible') {
          c.l = Math.max(c.l, b.left + n.clientLeft);
          c.r = Math.min(c.r, b.left + n.clientLeft + n.clientWidth);
        }
        if (s.overflowY !== 'visible') {
          c.t = Math.max(c.t, b.top + n.clientTop);
          c.b = Math.min(c.b, b.top + n.clientTop + n.clientHeight);
        }
        if (s.position === 'fixed') break;
      }
      return c;
    };
    // A ring larger than its scroller only has to fill it. A scroller that is
    // itself off screen (a panel slid away) hides its ring with it.
    const clipped = (el: Element): string => {
      const r = el.getBoundingClientRect();
      const c = clipOf(el);
      if (c.r - c.l <= 0 || c.b - c.t <= 0) return '';
      const slack = 4;
      const w = Math.min(r.right, c.r) - Math.max(r.left, c.l);
      const h = Math.min(r.bottom, c.b) - Math.max(r.top, c.t);
      const needW = Math.min(r.width, Math.max(c.r - c.l, 0));
      const needH = Math.min(r.height, Math.max(c.b - c.t, 0));
      if (w < needW - slack || h < needH - slack) {
        return `rect ${[r.left, r.top, r.right, r.bottom].map(Math.round).join(',')} clip ${
          [c.l, c.t, c.r, c.b].map(Math.round).join(',')}`;
      }
      return '';
    };
    const shownStyle = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const lit = Array.from(document.querySelectorAll('.focused')).filter(shownStyle);
    const top = lit.filter((el) => !lit.some((other) => other !== el && el.contains(other)));
    const rings = top.map((el) => ({
      desc: api.describe(el),
      inOwner: !!owner && owner.contains(el),
      hoverLit: hoverLit(el),
      clipped: clipped(el),
    }));

    let underPointer: Probe['underPointer'] = null;
    if (pt) {
      const hit = document.elementFromPoint(pt.x, pt.y);
      const f = hit && hit.closest('[data-focusable], [data-hover-target]');
      if (f) {
        underPointer = {
          desc: api.describe(f),
          lit: lit.some((el) => el.contains(f) || f.contains(el)),
          inModal: !!owner && modal && owner.contains(f),
          inTabBar: !!f.closest('.tab-bar'),
          cssHover: !!f.closest('#epg-channels, #epg-dates, #view-epg .epg-filter-control'),
          behindMenu: !!document.querySelector('#view-epg .epg-group-button[aria-expanded="true"]'),
          caret: document.activeElement instanceof HTMLInputElement && document.activeElement !== f
            && !!owner && owner.contains(document.activeElement),
        };
      }
    }
    const active = document.activeElement;
    const ownerRingless = !!owner && ownerMark !== 'deferred' && !lit.some((el) => owner.contains(el))
      && Array.from(owner.querySelectorAll('[data-focusable]')).some(shownStyle);
    // OK acts on the focus, lit or parked; it must not land on anything avoided.
    const safe = (el: Element) => !avoidList.some((s) => el.closest(s))
      && (!el.closest('#view-settings') || settingsSafe.some((s) => el.matches(s)));
    return {
      audit: report.kind,
      shown: report.shown,
      owner: owner ? api.describe(owner) : '',
      ownerMark,
      scope: owner ? owner.getAttribute('data-focus-scope') : null,
      unresolved: !!owner && owner.hasAttribute('data-focus-unresolved'),
      ownerRingless,
      modal,
      keyboard,
      rings,
      activeTab: document.querySelector('.tab-bar-item.active')?.getAttribute('data-section') ?? '',
      modalText: modal && owner ? (owner.textContent ?? '').replace(/\s+/g, ' ').trim() : '',
      toasts: (window as unknown as { __toasts: number }).__toasts,
      inputFocused: active instanceof HTMLInputElement,
      focusSafe: Array.from(document.querySelectorAll('.focused, .focused-parked')).every(safe),
      underPointer,
    };
  }, [input, pointer, avoid, SETTINGS_SAFE] as const);
}

function violations(step: Step, p: Probe, pointerSinceKey: boolean): string[] {
  const out: string[] = [];
  // Only a migrated (logical) scope can mark itself unresolved.
  if (p.unresolved) out.push(`focus.unresolved: ${p.scope ?? p.owner}`);
  // A prompt the pointer left hides its ring until the next key, as the
  // shared ring audit, which checks after keys, wheel steps and clicks, allows.
  const promptLeft = p.audit === 'prompt' && step.kind === 'move';
  if (p.audit && p.audit !== 'none' && !promptLeft) out.push(`rings.${p.audit}: ${p.rings.map((r) => r.desc).join(' + ')}`);
  for (const r of p.rings) {
    if (r.hoverLit) continue;
    // The pointer scrolls freely; only the D-pad must keep its ring in view.
    if (r.clipped && p.keyboard) out.push(`ring.clipped: ${r.desc} (${r.clipped})`);
    if (!r.inOwner) out.push(`ring.outside_owner: ${r.desc} (owner ${p.owner || 'none'})`);
  }
  if (step.kind === 'key' && p.keyboard) {
    for (const r of p.rings) if (r.hoverLit) out.push(`ring.outside_owner_after_key: ${r.desc}`);
  }
  if (step.kind === 'move' && pointerSinceKey && p.underPointer && !p.keyboard) {
    const u = p.underPointer;
    // A modal keeps hover dark outside itself; the tab bar shows pointer
    // hover with :hover rather than a ring.
    // A text box with the caret keeps the list ring dark; hover only tracks.
    // The guide's channel and date columns and its filters, like the tab
    // bar, show pointer hover with :hover, and its open group menu keeps the
    // hover to itself.
    const exempt = (p.modal && !u.inModal) || u.inTabBar || u.cssHover || u.behindMenu || u.caret;
    if (!exempt && !u.lit) out.push(`hover.not_lit: ${u.desc} (rings ${p.rings.map((r) => r.desc).join(' + ') || 'none'})`);
  }
  return out;
}

// "Logical focus resolves" for scopes that do not hold a focus key yet: a
// key that leaves the owner with focusables but no ring. Reported, never
// failed, until the scope migrates and the violation above covers it.
function warnings(step: Step, p: Probe): string[] {
  if (step.kind !== 'key' || !p.keyboard || p.inputFocused || !p.ownerRingless) return [];
  return [`focus.unresolved_unmigrated: ${p.scope ?? p.owner}`];
}

function signature(p: Probe): string {
  return JSON.stringify([p.shown, p.owner, p.activeTab, p.rings.map((r) => r.desc), p.inputFocused, p.modalText, p.toasts]);
}

// A press where it lands, as the pointer would: no actionability waits, so a
// covered or moving target is still the walk's to hit.
async function clickAt(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  const el = page.locator(selector).first();
  if (!await el.waitFor({ state: 'visible', timeout }).then(() => true, () => false)) return false;
  await el.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => undefined);
  const box = await el.boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

// For controls that slide in: waits until they stand still and take the click.
async function clickStill(page: Page, selector: string, timeout = 3000): Promise<boolean> {
  return page.locator(selector).first().click({ timeout }).then(() => true, () => false);
}

async function waitShown(page: Page, selector: string, timeout = 5000): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}

async function openTab(page: Page, section: Parameters<typeof enterTab>[1]): Promise<boolean> {
  return enterTab(page, section).then(() => true, () => false);
}

async function openSettings(page: Page, category: string): Promise<boolean> {
  return await openTab(page, 'settings') && clickAt(page, `[data-settings-target="${category}"]`);
}

async function enterDetail(page: Page, section: string | undefined): Promise<void> {
  const view = section === 'series' ? 'series' : 'movies';
  if (!await openTab(page, view)) return;
  const tile = page.locator(`#view-${view} .catalog-tile[data-item-id]`).first();
  if (!await tile.waitFor({ timeout: 5000 }).then(() => true, () => false)) return;
  await hover(tile);
  await page.keyboard.press('Enter');
  // After a click on the shown section's tab, the first key only shows the ring.
  if (!await waitShown(page, `#view-${view} .detail-actions`, 1500)) {
    await page.keyboard.press('Enter');
    await waitShown(page, `#view-${view} .detail-actions`);
  }
}

async function enterSearch(page: Page): Promise<void> {
  if (await openTab(page, 'search')) await waitShown(page, '.tab-bar-search.expanded');
}

async function enterSettings(page: Page, category: string | undefined): Promise<void> {
  await openSettings(page, category ?? 'general');
}

// Types the PIN, twice when the prompt creates it.
async function passPin(page: Page): Promise<void> {
  const input = page.locator('.parental-pin-prompt:not(.hidden) .parental-pin-input');
  for (let i = 0; i < 2; i++) {
    if (!await input.waitFor({ timeout: i ? 1000 : 5000 }).then(() => true, () => false)) return;
    await input.fill('1234');
    // The next stage clears the box; a passed PIN closes the prompt.
    await expect.poll(() => input.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value).join(''))).toBe('');
  }
}

async function enterParental(page: Page): Promise<void> {
  if (!await openSettings(page, 'general') || !await clickAt(page, '#manage-parental-controls')) return;
  await passPin(page);
  await waitShown(page, '#view-parental-controls');
}

async function enterParentalAccounts(page: Page): Promise<void> {
  if (!await page.locator('#view-parental-controls').isVisible()) await enterParental(page);
  // Only the rules tab shows the avatar.
  const avatar = '#view-parental-controls .parental-account-slot .account-avatar';
  if (!await page.locator(avatar).isVisible()) await clickAt(page, '[data-parental-tab="rules"]', 1000);
  if (await clickAt(page, avatar)) await waitShown(page, '#view-parental-controls .account-menu');
}

async function enterParentalPin(page: Page): Promise<void> {
  if (!await openSettings(page, 'general')) return;
  // The first time creates the PIN, so the prompt from then on verifies it.
  if (await page.locator('#manage-parental-controls.btn-primary').count()) {
    await enterParental(page);
    await page.keyboard.press('Escape');
    if (!await waitShown(page, '#view-settings')) return;
  }
  if (await clickAt(page, '#manage-parental-controls')) await waitShown(page, '.parental-pin-prompt:not(.hidden)');
}

async function enterReminders(page: Page, from: string | undefined): Promise<void> {
  const opened = from === 'epg'
    ? await openTab(page, 'epg') && await clickAt(page, '.epg-reminder-entry')
    : await openSettings(page, 'guide') && await clickAt(page, '#manage-reminders');
  if (opened) await waitShown(page, '#view-reminders');
}

// The app scans for due reminders when it becomes visible; once the walk has
// answered them all, a reload stores them again.
async function enterReminderPrompt(page: Page): Promise<void> {
  const prompt = '.reminder-prompt:not(.hidden)';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  if (await waitShown(page, prompt, 1000)) return;
  await page.reload();
  await waitShown(page, '#view-channels [data-list-position="0"]', 10_000);
  await waitShown(page, prompt);
}

async function enterConfirm(page: Page, from: string | undefined): Promise<void> {
  if (from === 'reminders') {
    await enterReminders(page, 'settings');
    if (!await clickAt(page, '.reminder-manager-clear')) return;
  } else if (!await openSettings(page, 'data') || !await clickAt(page, '#clear-recently-watched')) {
    return;
  }
  await waitShown(page, '.confirmation-prompt:not(.hidden)');
}

// Opens the first part-watched programme on a channel with a guide, from
// today or, just after midnight, the day before.
async function enterCatchup(page: Page): Promise<void> {
  if (!await openTab(page, 'epg') || !await waitShown(page, '#epg-channels [data-channel-idx]')) return;
  const channel = await page.evaluate((count) => {
    const guided = (el: Element | null) => !!el && Number(el.getAttribute('data-channel-idx')) < count;
    if (guided(document.querySelector('#epg-channels .epg-channel-item.selected'))) return null;
    const item = Array.from(document.querySelectorAll('#epg-channels [data-channel-idx]')).find(guided);
    return item ? item.getAttribute('data-channel-idx') : null;
  }, GUIDE_CHANNELS);
  if (channel !== null) await clickAt(page, `#epg-channels [data-channel-idx="${channel}"]`);
  const today = Number(await page.locator('#epg-dates .epg-date-item.today').getAttribute('data-day-index')
    .catch(() => null));
  const programme = `#epg-programmes .epg-programme-item[data-key="${GUIDE_START + CATCHUP_PROGRAMMES[0] * HALF_HOUR}"]`;
  for (const day of [today, today - 1]) {
    const date = `#epg-dates .epg-date-item[data-day-index="${day}"]`;
    if (!await page.locator(`${date}.selected`).count()) await clickAt(page, date, 1000);
    if (!await waitShown(page, programme, 1000)) continue;
    if (await clickAt(page, programme)) await waitShown(page, '.catchup-resume-prompt:not(.hidden)');
    return;
  }
}

async function enterLiveCategories(page: Page): Promise<void> {
  if (await openSettings(page, 'sources') && await clickAt(page, '.xtream-card .xtream-live-categories')) {
    await waitShown(page, '.live-category-picker');
  }
}

// Opens the VOD menu's Subtitles pane, playing a movie first unless one
// plays. False when the player shows something else.
async function openSubtitleMenu(page: Page): Promise<boolean> {
  if (!await page.locator('#view-player').isVisible()) {
    await enterDetail(page, 'movies');
    // Played before its info loads, a movie has no sidecar subtitles to sync.
    await waitShown(page, '#view-movies .detail-plot');
    const play = page.locator('#view-movies [data-action="play"]').first();
    if (!await play.waitFor({ timeout: 5000 }).then(() => true, () => false)) return false;
    await hover(play);
    await page.keyboard.press('Enter');
    if (!await waitShown(page, '#player-osd .osd-channel-name')) return false;
  }
  await page.mouse.move(1700, 540);
  await page.mouse.move(1900, 540);
  if (!await waitShown(page, '#player-menu.visible')) return false;
  if (!await page.locator('#player-menu [data-menu-action="__subs_open__"]').count()) {
    await clickStill(page, '#player-menu [data-menu-action="__menu_back__"]');
  }
  if (!await clickStill(page, '#player-menu [data-menu-action="__subs_open__"]')) return false;
  return waitShown(page, '#player-menu [data-menu-action="__subs_search__"]', 1000);
}

// From a live channel's player, Back to where a movie can start.
async function openVodSubtitleMenu(page: Page): Promise<boolean> {
  if (await openSubtitleMenu(page)) return true;
  if (!await page.locator('#view-player').isVisible()) return false;
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  if (!await waitShown(page, '.tab-bar-item[data-section="movies"]')) return false;
  return openSubtitleMenu(page);
}

async function enterSubtitleSearch(page: Page): Promise<void> {
  if (!await openVodSubtitleMenu(page)) return;
  if (await clickStill(page, '#player-menu [data-menu-action="__subs_search__"]')) {
    await waitShown(page, '#subtitle-search .subs-overlay');
  }
}

// Sync lists only once a shiftable subtitle is on: pick the sidecar, reopen.
async function enterSubtitleOffset(page: Page): Promise<void> {
  if (!await openVodSubtitleMenu(page)) return;
  const offset = '#player-menu [data-menu-action="__subs_offset__"]';
  if (!await page.locator(offset).count()) {
    // Without its sidecar, back out, so the next enter plays the movie again.
    if (!await clickStill(page, '#player-menu [data-menu-action="__subs_track__"][data-track-index="2000"]')) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      return;
    }
    await clickStill(page, '#player-menu [data-menu-action="__subs_open__"]');
  }
  if (await clickStill(page, offset)) await waitShown(page, '#subtitle-offset:not(.hidden)');
}

async function enterChannelEditor(page: Page, from: string | undefined): Promise<void> {
  if (from === 'settings') {
    if (!await openSettings(page, 'sources') || !await clickAt(page, '#edit-channel-list')) return;
  } else {
    if (!await openTab(page, 'live') || !await waitShown(page, '#view-channels [data-list-position="0"]')) return;
    // Recently Watched can't be edited, and Favorites picks favorites instead.
    await clickAt(page, '#view-channels .group-item[data-key="g:builtin:all"]', 1000);
    await pressRemote(page, 'Yellow');
  }
  await waitShown(page, '#view-channels .channel-view.editing');
}

async function pressRemote(page: Page, key: string): Promise<void> {
  await page.evaluate((code) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true }));
  }, REMOTE_KEYS[key]);
}

function describeStep(s: Step): string {
  switch (s.kind) {
    case 'key': return `key ${s.key}`;
    case 'type': return `type ${JSON.stringify(s.text)}`;
    case 'fill': return `fill ${JSON.stringify(s.text)}`;
    case 'wheel': return `wheel ${s.dy} at ${s.x},${s.y} (${s.target})`;
    case 'enter': return `enter ${s.surface}${s.variant ? ` (${s.variant})` : ''}`;
    default: return `${s.kind} ${s.x},${s.y} (${s.target})`;
  }
}

async function perform(page: Page, s: Step): Promise<void> {
  switch (s.kind) {
    case 'key':
      if (s.key in REMOTE_KEYS) await pressRemote(page, s.key);
      else await page.keyboard.press(s.key);
      break;
    case 'type': await page.keyboard.type(s.text); break;
    case 'fill': await page.locator('input:focus').fill(s.text, { timeout: 1000 }).catch(() => undefined); break;
    case 'move': await page.mouse.move(s.x, s.y, { steps: 2 }); break;
    case 'click':
      await page.mouse.move(s.x, s.y, { steps: 2 });
      await page.mouse.down();
      await page.mouse.up();
      break;
    case 'wheel':
      await page.mouse.move(s.x, s.y);
      await page.mouse.wheel(0, s.dy);
      break;
    case 'enter': await SURFACES[s.surface].enter(page, s.variant); break;
  }
}

async function chooseStep(page: Page, rand: () => number, p: Probe, playerSteps: number,
  name: SurfaceName | undefined): Promise<Step> {
  const surface = name ? SURFACES[name] : undefined;
  // Leave the full-screen player soon: everything else lives outside it.
  if (playerSteps >= MAX_PLAYER_STEPS && !surface?.player) return { kind: 'key', key: 'Escape' };
  if (name && surface) {
    const state = await surfaceState(page, surface);
    // Out in the player, or under another prompt, say: Back first, then enter.
    if (state !== 'present' && (state === 'away' || p.modal)) return { kind: 'key', key: 'Escape' };
    if (state === 'closed') {
      return { kind: 'enter', surface: name, ...(surface.variants ? { variant: pick(rand, surface.variants) } : {}) };
    }
  }
  if (p.inputFocused && surface?.text) {
    if (rand() < 0.25) return { kind: surface.text.kind, text: pick(rand, surface.text.values) };
  } else if (p.inputFocused && rand() < 0.3) {
    return rand() < 0.7 ? { kind: 'type', text: 'a' } : { kind: 'key', key: 'Backspace' };
  }
  if (surface?.keys && rand() < 0.1) return { kind: 'key', key: pick(rand, surface.keys) };
  const r = rand();
  if (r < 0.45) return { kind: 'key', key: pick(rand, Object.values(KEYS)) };
  if (r < 0.53) {
    if (!p.focusSafe) return { kind: 'key', key: pick(rand, ['ArrowUp', 'ArrowDown']) };
    return { kind: 'key', key: 'Enter' };
  }
  if (r < 0.60) {
    // A family backs out rarely, so it spends its steps on its surface.
    if (surface && rand() < 0.8) return { kind: 'key', key: pick(rand, Object.values(KEYS)) };
    return { kind: 'key', key: 'Escape' };
  }
  const found = await candidates(page, surface?.avoid ?? []);
  // Nor does it click away through the tab bar.
  const all = surface ? found.filter((c) => !c.tabBar) : found;
  if (r < 0.95 && all.length) {
    if (r < 0.76) {
      const c = pick(rand, all);
      return { kind: 'move', x: c.x, y: c.y, target: c.target };
    }
    if (r < 0.79) {
      const x = Math.floor(rand() * 1920);
      const y = Math.floor(rand() * 1080);
      return { kind: 'move', x, y, target: 'point' };
    }
    if (r < 0.88) {
      const safe = all.filter((c) => c.safe);
      // Mostly tabs and the avatar, so sections and the account menu cycle.
      const tabs = safe.filter((c) => c.tabBar);
      const c = pick(rand, tabs.length && rand() < 0.5 ? tabs : safe);
      if (c) return { kind: 'click', x: c.x, y: c.y, target: c.target };
    }
    const content = all.filter((x) => !x.tabBar);
    const c = pick(rand, content.length ? content : all);
    return { kind: 'wheel', x: c.x, y: c.y, dy: rand() < 0.5 ? -120 : 120, target: c.target };
  }
  return { kind: 'key', key: pick(rand, ['ArrowUp', 'ArrowDown']) };
}

async function runWalk(page: Page, label: string,
  opts: { seed?: number; steps: number; replay?: Step[]; surface?: SurfaceName }): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message} @ ${(e.stack ?? '').split('\n').slice(1, 3).join(' | ').trim()}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Aborted stub routes (the LAN service probe) log as resource failures.
    if (/^Failed to load resource/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  const surface = opts.surface ? SURFACES[opts.surface] : undefined;
  const pseudo = !!surface?.pseudo && (opts.seed ?? 0) % 2 === 1;
  const avoid = surface?.avoid ?? [];
  await seed(page, surface?.needs ?? [], pseudo);
  // From NOW, as the guide is built, but running: the walk's key timing reads it.
  await startClock(page);
  await page.goto(pseudo ? '/?pseudo=1' : '/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('#view-channels [data-list-position="0"]')).toBeVisible();

  const rand = mulberry32(opts.seed ?? 0);
  const log: Step[] = [];
  const findings: Finding[] = [];
  const warned = new Map<string, { count: number; step: number }>();
  const seen = new Set<string>();
  const keepGoing = E2E_ENV.fuzzContinue;
  let pointerSinceKey = false;
  let pointer: { x: number; y: number } | null = null;
  let playerSteps = 0;
  let enterMisses = 0;
  let p = await probe(page, 'start', null, avoid);

  const record = (violation: string, state: Probe) => {
    // One report per kind of violation on a kind of element.
    const kind = violation.replace(/\[[^\]]*\]|\([^)]*\)|\d+/g, '');
    if (keepGoing && seen.has(kind)) return;
    seen.add(kind);
    findings.push({ step: log.length, violation, state: JSON.stringify(state) });
  };

  const check = async (step: Step, still: boolean) => {
    await settle(page);
    let state = await probe(page, describeStep(step), pointer, avoid);
    let found = violations(step, state, pointerSinceKey && !still);
    if (found.length) {
      // Panels slide and smooth scrolls land; only a state that stays wrong
      // counts. The app's timers run at once; CSS and scrolls run until still.
      await runTimers(page, 600);
      state = await stillState(() => probe(page, describeStep(step), pointer, avoid));
      found = violations(step, state, pointerSinceKey && !still);
    }
    for (const v of found) record(v, state);
    for (const w of warnings(step, state)) {
      const entry = warned.get(w) ?? { count: 0, step: log.length };
      entry.count++;
      warned.set(w, entry);
    }
    while (errors.length) record(errors.shift()!, state);
    return state;
  };

  const doStep = async (step: Step) => {
    log.push(step);
    // A move to where the pointer already rests fires no events at all.
    const still = step.kind === 'move' && pointer?.x === step.x && pointer.y === step.y;
    await perform(page, step);
    // An enter clicks and presses its way in: the walk no longer says where
    // the pointer rests, and the keys may own the surface.
    if (step.kind === 'enter') pointer = null;
    if (step.kind === 'key' || step.kind === 'type' || step.kind === 'fill' || step.kind === 'enter') pointerSinceKey = false;
    else if (!still) {
      pointerSinceKey = true;
      pointer = { x: step.x, y: step.y };
    }
    p = await check(step, still);
    playerSteps = p.shown.length === 1 && p.shown[0] === 'view-player' ? playerSteps + 1 : 0;
    if (step.kind === 'enter') {
      enterMisses = await surfaceState(page, SURFACES[step.surface]) === 'present' ? 0 : enterMisses + 1;
      if (enterMisses === MAX_ENTER_MISSES) record(`surface.unreachable: ${step.surface}`, p);
    }
  };

  // From anywhere, a few Backs and Ups must change something on screen.
  const liveness = async () => {
    let before = signature(p);
    for (const key of ['Escape', 'ArrowUp', 'Escape', 'ArrowUp', 'Escape', 'ArrowUp']) {
      await doStep({ kind: 'key', key });
      const after = signature(p);
      if (after !== before) return;
      before = after;
    }
    record('trap: Back and Up changed nothing', p);
  };

  const steps = opts.replay ?? [];
  const total = opts.replay ? steps.length : opts.steps;
  for (let i = 0; i < total; i++) {
    if (!keepGoing && findings.length) break;
    if (opts.replay) {
      await doStep(steps[i]);
      continue;
    }
    if (i > 0 && i % LIVENESS_EVERY === 0) await liveness();
    await doStep(await chooseStep(page, rand, p, playerSteps, opts.surface));
  }

  const exits = await page.evaluate(() => (window as unknown as { __exitRequests: number }).__exitRequests);
  test.info().annotations.push({ type: 'focus-fuzz', description: `${label}: ${log.length} steps, ${exits} exit requests` });
  for (const [w, { count, step }] of warned) {
    test.info().annotations.push({ type: 'focus-fuzz-warning', description: `${label}: ${w} x${count}, first at step ${step}` });
  }
  if (findings.length) {
    const lines = log.map((s, i) => `${String(i + 1).padStart(4)} ${describeStep(s)}`);
    const first = findings[0];
    const env = [opts.surface ? `FOCUS_FUZZ_SURFACE=${opts.surface}` : '',
      opts.seed !== undefined ? `FOCUS_FUZZ_SEED=${opts.seed}` : ''].filter(Boolean).join(' ');
    const message = [
      `${label}: ${findings.length} focus invariant violation(s)`,
      ...findings.map((f) => `  step ${f.step}: ${f.violation}\n${log.slice(Math.max(0, f.step - 8), f.step)
        .map((s, i) => `      ${Math.max(0, f.step - 8) + i + 1} ${describeStep(s)}`).join('\n')}`),
      `state at step ${first.step}: ${first.state}`,
      'steps:',
      ...lines,
      `replay: ${env ? `${env} ` : ''}FOCUS_FUZZ_REPLAY='${JSON.stringify(log.slice(0, findings[findings.length - 1].step))}'`,
    ].join('\n');
    expect(findings, message).toEqual([]);
  }
}

const replay = E2E_ENV.fuzzReplay;
const stepCount = E2E_ENV.fuzzSteps || DEFAULT_STEPS;
const chosenSeeds = E2E_ENV.fuzzSeeds;
const families = E2E_ENV.fuzzSurfaces ?? ['walk', ...Object.keys(SURFACES)];

test.describe('focus fuzz', () => {
  if (replay) {
    test('replay', async ({ page }) => {
      test.setTimeout(0);
      const surface = families[0] in SURFACES ? families[0] as SurfaceName : undefined;
      await runWalk(page, 'replay', { seed: chosenSeeds?.[0], steps: 0, replay: JSON.parse(replay) as Step[], surface });
    });
    return;
  }
  for (const family of families) {
    if (family !== 'walk' && !(family in SURFACES)) throw new Error(`unknown FOCUS_FUZZ_SURFACE family: ${family}`);
    const surface = family === 'walk' ? undefined : family as SurfaceName;
    const defaults = !surface ? DEFAULT_SEEDS : surface === 'detail' ? DEFAULT_DETAIL_SEEDS : SURFACE_SEEDS;
    for (const s of chosenSeeds ?? defaults) {
      const title = surface ? `${surface} seed ${s}` : `seed ${s}`;
      test(title, async ({ page }) => {
        test.fixme(!chosenSeeds && title in KNOWN_FAILING, KNOWN_FAILING[title]);
        test.setTimeout(Math.max(60_000, stepCount * 1500));
        await runWalk(page, title, { seed: s, steps: stepCount, surface });
      });
    }
  }
});
