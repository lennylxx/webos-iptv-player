import { endHoldingUpNext, enterTab, test, expect, isChromium53, neuterVideo, routeLiveManifest, routePlaylist, routeFakeAi, type FakeAiServer, type Page, liveLoaded, settled } from './helpers';
import { type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { findGappedLooseText, measureLooseText, newLegacyPage, pixelDiff } from './pixel-parity';
import { seedXtream } from './fixtures/xtream';
import { channelKey } from '../src/utils/channel';
import { type Channel } from '../src/types';

// Every box's layout and scroll position: two equal reads mean nothing is still
// moving. Transforms are left out, since a looping CSS animation never rests and
// screenshots finish CSS animation themselves; this waits out scripted motion.
function layoutOf(p: Page): Promise<string> {
  return p.evaluate(() => {
    const els = document.querySelectorAll<HTMLElement>('*');
    let hash = 0;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      for (const n of [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight, el.scrollLeft, el.scrollTop]) {
        hash = (hash * 31 + Math.round(n || 0)) | 0;
      }
    }
    return `${String(els.length)}:${String(hash)}`;
  });
}

// Narrows a flex row for a scene so it wraps, through a stylesheet, which a
// re-render keeps, unlike an inline style.
async function narrowRow(p: Page, selector: string, width: number): Promise<void> {
  await p.evaluate(({ selector, width }) => {
    const style = document.createElement('style');
    style.id = 'parity-narrow';
    style.textContent = `${selector} { max-width: ${String(width)}px; }`;
    document.head.appendChild(style);
  }, { selector, width });
}

const widenRow = (p: Page) => p.evaluate(() => document.getElementById('parity-narrow')?.remove());

// Walk Right with the keys from `from` until `to` holds the focus.
async function focusByKeys(p: Page, from: string, to: string): Promise<void> {
  await p.locator(from).evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  for (let i = 0; i < 6 && !await p.locator(to).evaluate((el) => el.classList.contains('focused')); i++) {
    await p.keyboard.press('ArrowRight');
  }
  await expect(p.locator(to)).toHaveClass(/focused/);
  await expect(p.locator('html')).toHaveClass(/keyboard-nav/);
}

async function expectNameShown(p: Page, button: string): Promise<void> {
  await expect.poll(() => p.locator(`${button} .detail-icon-label`)
    .evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(40);
}

async function hoverCircle(p: Page, button: string): Promise<void> {
  // Leave the keys first, so the measured circle is the one the pointer meets.
  await p.mouse.move(10, 300);
  await p.mouse.move(20, 300);
  await expect(p.locator('html')).not.toHaveClass(/keyboard-nav/);
  const box = (await p.locator(`${button} .detail-icon-circle`).boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(p.locator(button)).toHaveClass(/focused/);
  await expect(p.locator('html')).not.toHaveClass(/keyboard-nav/);
}

// webOS 4/5/6 lack flex `gap`, CSS Grid and backdrop-filter, so the app ships a
// second layout built from `> * + *` margins and float/inline-block fallbacks.
// Those fallbacks are meant to *reproduce* the modern layout, not merely to
// avoid collapsing — but nothing checked that they land in the same place.
//
// Both engines here are the same headless Chromium with the same fonts, so text
// rasterizes identically and every differing pixel is a layout difference. That
// makes this the one comparison that is trustworthy pixel-wise: the real TV
// ships a wider font, which shifts glyphs on its own and drowns the signal.

// Rendered frames land here so a run can be eyeballed, not just read as
// percentages.
const DIFF_DIR = 'test-output/legacy-parity';

// A fixed clock keeps the EPG's "now" marker, the header time and every
// relative timestamp identical between the two pages.
const NOW = new Date('2024-03-05T12:00:00.000Z');

const at = (hours: number): string =>
  new Date(NOW.getTime() + hours * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<channel id="two"><display-name>Channel Two</display-name></channel>
<programme channel="one" start="${at(-2)}" stop="${at(-1)}"><title>Earlier Show</title><desc>An earlier description.</desc></programme>
<programme channel="one" start="${at(-1)}" stop="${at(1)}"><title>Current Show</title><desc>A current description.</desc></programme>
<programme channel="one" start="${at(1)}" stop="${at(3)}"><title>Later Show</title><desc>A later description.</desc></programme>
<programme channel="two" start="${at(-1)}" stop="${at(2)}"><title>Other Current</title><desc>Another description.</desc></programme>
</tv>`;

// The audio and subtitle pickers fall back to the parsed master manifest when
// the pipeline exposes no native track, so renditions alone populate them.
const MASTER_MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="l2"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Sub 1",LANGUAGE="l1",URI="http://host/s1.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Sub 2",LANGUAGE="l2",URI="http://host/s2.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",SUBTITLES="s"',
  'http://host/v.m3u8',
  '',
].join('\n');

// The desktop preview has no LAN service, so the device-setup panel in the
// general pane renders a placeholder and its QR and instructions are never
// compared. Answer the calls the app makes at boot so it renders for real.
async function stubLanService(page: Page): Promise<void> {
  await page.route('http://127.0.0.1:9999/info', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ip: '192.168.1.2',
      port: 9999,
      setupUrl: 'http://192.168.1.2:9999/setup?token=abc123',
      manualUrl: 'http://192.168.1.2:9999',
      pairingCode: '1234',
    }),
  }));
  await page.route('http://127.0.0.1:9999/uploads', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('http://127.0.0.1:9999/setup-state', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '{"updated":true}' }));
  await page.addInitScript(() => {
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;

      call(uri: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const response = method === 'start'
          ? { running: true, port: 9999 }
          : method === 'serviceEvents'
            ? { subscribed: true }
            : { returnValue: false, errorText: 'unmocked: ' + method };
        setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
      }

      cancel(): void {
        this.onservicecallback = null;
      }
    }
    (window as unknown as {
      PalmServiceBridge?: unknown;
    }).PalmServiceBridge = FakePalmServiceBridge;
  });
}

async function prepareM3U(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await routePlaylist(page, [
    '#EXTM3U url-tvg="http://epg.example.com/guide.xml"',
    '#EXTINF:-1 tvg-id="one" group-title="News" catchup="default" catchup-source="http://streams.example.com/one.m3u8?start=${start}",Channel One',
    'http://streams.example.com/one.m3u8',
    '#EXTINF:-1 tvg-id="two" group-title="Movies",Channel Two',
    'http://streams.example.com/two.m3u8',
  ].join('\n'));
  await routeLiveManifest(page);
  await page.route('**/one.m3u8', (r) => r.fulfill({
    status: 200, contentType: 'application/vnd.apple.mpegurl', body: MASTER_MANIFEST }));
  await neuterVideo(page);
  await page.route('**/guide.xml', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await stubLanService(page);
  await page.addInitScript((key) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'p1', name: 'Source 1', url: 'http://host/playlist.m3u' },
      {
        id: 'p2', name: 'Source 2', url: 'http://host/secondary.m3u',
        enabled: false,
      },
    ]));
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: key,
      channelName: 'Channel One',
      title: 'Later Show',
      startMs: Date.now() + 3600_000,
      stopMs: Date.now() + 7200_000,
    }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://epg.example.com/guide.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_favorites', JSON.stringify([key]));
    // A half-watched past program, so the EPG offers to resume it.
    const start = Date.now() - 2 * 3600_000;
    const end = start + 3600_000;
    localStorage.setItem('iptv_catchup_progress', JSON.stringify({
      [`${key}|${start}`]: {
        channelKey: key, progStart: start, progEnd: end,
        position: 1800, duration: 3600, updatedAt: start,
        completed: false, expiresAt: end + 7 * 86400_000,
      },
    }));
  }, channelKey({ url: 'http://streams.example.com/one.m3u8' } as Channel));
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('.channel-item')).toHaveCount(2);
}

// Three episodes with stills, so the series player has a live skip on each
// side of play/pause and Up Next lays a still beside its text.
async function routeSeriesEpisodes(page: Page): Promise<void> {
  await page.route('**/player_api.php*action=get_series_info*', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      info: { name: 'Series One', plot: 'A series plot.' },
      episodes: { 1: [1, 2, 3].map((n) => ({
        id: String(10 + n), title: `Episode ${String(n)}`, season: 1, episode_num: n,
        container_extension: 'mp4',
        info: { duration_secs: 600, plot: 'An episode.', movie_image: `http://host/still/${String(n)}.svg` },
      })) },
    }),
  }));
  await page.route('http://host/still/**', (r) => r.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#468"/></svg>',
  }));
}

async function imagesLoaded(p: Page, selector: string): Promise<void> {
  await expect.poll(() => p.locator(selector).evaluateAll((images) =>
    images.every((img) => (img as HTMLImageElement).complete))).toBe(true);
}

async function prepareXtream(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await seedXtream(page, { catalog: 'large' });
  await routeSeriesEpisodes(page);
  await stubLanService(page);
  await page.goto('/');
  await liveLoaded(page);
}

// Wait out a smooth scroll so both engines are sampled at rest.
async function railAtRest(p: Page, selector: string): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const now = await p.locator(selector).evaluate((el) => `${String(el.scrollLeft)},${String(el.scrollTop)}`);
    const settled = now === last;
    last = now;
    return settled;
  }, { intervals: [100] }).toBe(true);
}

interface Screen {
  name: string;
  /** Budget as a fraction of the viewport; see the calibration note below. */
  budget: number;
  go: (page: Page) => Promise<void>;
  /** Boxes that must match exactly where a budget allows antialiasing residue. */
  geometry?: (page: Page) => Promise<string[]>;
}

async function openSettingsPane(p: Page, pane: string): Promise<void> {
  await enterTab(p, 'settings');
  // The stubbed service makes the panel render for real and refreshes the
  // upload list; both land after the view opens, so wait for them before
  // placing the column.
  await expect(p.locator('.setup-qr')).toBeVisible();
  await expect(p.locator('#upload-entries .empty-hint')).toBeVisible();
  // Clicking the nav item starts the app's scroll animation, which can still
  // be running when the frame is taken; that behavior has its own spec.
  // Place the column where the animation would rest instead — sampling the
  // top of every pane would be steadier, but then nothing below the fold is
  // ever compared.
  await p.evaluate((name) => {
    const scroll = document.querySelector('.settings-scroll') as HTMLElement;
    const target = document.querySelector(`#settings-${name}`)!;
    // The scroller sets `scroll-behavior: smooth`, so even assigning
    // scrollTop animates. Go through `setProperty`: the simulation deletes
    // the CSSOM reflection but cannot take the property away from the real
    // engine.
    scroll.style.setProperty('scroll-behavior', 'auto');
    scroll.scrollTop += target.getBoundingClientRect().top
      - scroll.getBoundingClientRect().top;
  }, pane);
  await expect(p.locator(`.settings-nav-item.active[data-settings-target="${pane}"]`))
    .toBeVisible();
}

// Turning parental controls on persists across reloads, so these screens run
// after every screen that would otherwise meet a PIN prompt.
const PIN = '1234';

async function enterPin(p: Page): Promise<void> {
  await p.locator('.parental-pin-prompt .parental-pin-input').fill(PIN);
}

/** Leave the manager with an unlock duration of "Once", so locks apply. */
async function leaveParentalLocked(p: Page): Promise<void> {
  await p.locator('[data-parental-tab="options"]').click();
  await p.locator('#parental-duration [data-value="once"]').click();
  await expect(p.locator('#parental-duration .active')).toHaveAttribute('data-value', 'once');
  await p.locator('[data-parental-back]').click();
  await expect(p.locator('#view-parental-controls')).toBeHidden();
}

const M3U_SCREENS: Screen[] = [
  { name: 'live', budget: 0, go: async () => { /* the landing view */ } },
  { name: 'guide', budget: 0, go: (p) => enterTab(p, 'epg') },
  {
    name: 'guide-groups',
    budget: 0,
    go: async (p) => {
      await p.locator('[data-epg-group-toggle]').click();
      await expect(p.locator('.epg-group-menu')).toBeVisible();
      await p.locator('[data-epg-group-toggle]').click();
      await expect(p.locator('.epg-group-menu')).toHaveCount(0);
    },
  },
  ...(['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'advanced', 'data']
    .map((pane) => ({
      name: `settings-${pane}`,
      // The data pane prints a storage budget, and `storage.estimate()` is
      // Chromium 61 — so webOS 4 budgets from the prefixed quota API.
      // Environment, not layout.
      budget: pane === 'data' ? 0.0005 : 0,
      go: (p: Page) => openSettingsPane(p, pane),
    }))),
  {
    name: 'settings-dropdown-open',
    budget: 0,
    go: async (p) => {
      await openSettingsPane(p, 'appearance');
      await p.locator('#text-size [data-dropdown-trigger]').click();
      await expect(p.locator('#text-size.open .dropdown-menu')).toBeVisible();
    },
  },
  {
    name: 'settings-guide-multi-source',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#text-size.open')).toHaveCount(0);
      await enterTab(p, 'settings');
      await p.locator('[data-settings-target="guide"]').click();
      await p.locator('#add-epg-source').click();
      const sources = p.locator('[data-manual-epg-source]');
      await expect(sources).toHaveCount(2);
      await sources.nth(1).locator('.manual-epg-url').fill('http://host/guide-2.xml');
      const firstScope = sources.nth(0).locator('[data-playlist-id]').first();
      const secondScope = sources.nth(1).locator('[data-playlist-id]').nth(1);
      await firstScope.click();
      await secondScope.click();
      await expect(firstScope).toHaveClass(/active/);
      await expect(secondScope).toHaveClass(/active/);
      await p.locator('.epg-scope-option.focused').evaluateAll((options) => {
        options.forEach(option => option.classList.remove('focused'));
      });
      await p.evaluate(() => {
        const scroll = document.querySelector('.settings-scroll') as HTMLElement;
        const target = document.querySelector('#settings-guide')!;
        scroll.style.setProperty('scroll-behavior', 'auto');
        scroll.scrollTop += target.getBoundingClientRect().top
          - scroll.getBoundingClientRect().top;
      });
      await expect(sources.nth(1).locator('.manual-epg-scope-options')).toBeVisible();
    },
  },
  {
    name: 'search',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'search');
      // The results view only covers the current one once a query is typed.
      await p.locator('.tab-bar-search-input').fill('channel');
      await expect(p.locator('#view-search')).toBeVisible();
    },
  },
  {
    name: 'favorites-manage',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      await p.locator('[data-group="builtin:favorites"]').click();
      await p.locator('[data-favorite-manage]').click();
      await expect(p.locator('.edit-hints.favorite-hints')).toBeVisible();
      await p.keyboard.press('Escape');
      await expect(p.locator('.edit-hints.favorite-hints')).toHaveCount(0);
      await p.locator('[data-group="builtin:all"]').click();
    },
  },
  {
    name: 'channel-editor',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      await p.locator('[data-edit-channels]').click();
      await expect(p.locator('.channel-view.editing .edit-hints')).toBeVisible();
    },
  },
  {
    name: 'player-osd',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.locator('.channel-item').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
    },
  },
  {
    // Geometry matches exactly; the residue is the backdrop-filter fallback's
    // opaque panel, which shifts glyph antialiasing against the video plane.
    name: 'player-menu',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('ArrowRight');
      await expect(p.locator('#player-menu')).toBeVisible();
    },
  },
  {
    name: 'menu-audio',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__audio_open__"]').click();
      await expect(p.locator('[data-menu-action="__audio_track__"]').first()).toBeVisible();
    },
  },
  {
    name: 'menu-subtitles',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__menu_back__"]').click();
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await expect(p.locator('[data-menu-action="__subs_track__"]').first()).toBeVisible();
    },
  },
  {
    name: 'player-sidebar',
    budget: 0.001, // same opaque-panel residue as the menu
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('ArrowLeft');
      await p.keyboard.press('ArrowLeft');
      await expect(p.locator('#player-sidebar')).toBeVisible();
    },
  },
  {
    name: 'sidebar-search',
    budget: 0.001,
    go: async (p) => {
      await p.locator('.sidebar-search-input').fill('one');
      await expect(p.locator('#player-sidebar .sidebar-ch-item')).toHaveCount(1);
    },
  },
  {
    name: 'sidebar-groups',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-open-groups]').click();
      await expect(p.locator('#player-sidebar .sidebar-group-item').first()).toBeVisible();
    },
  },
  {
    name: 'number-entry',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      await enterTab(p, 'live');
      await p.keyboard.press('2');
      await p.keyboard.press('4');
      await expect(p.locator('.number-entry.visible')).toBeVisible();
    },
  },
  {
    name: 'search-empty',
    budget: 0,
    go: async (p) => {
      // Abandon the number typed before this: left to its debounce, it tunes
      // or still shows on whichever page a loaded machine slows down.
      await p.keyboard.press('Shift');
      await expect(p.locator('.number-entry.visible')).toHaveCount(0);
      await enterTab(p, 'search');
      await p.locator('.tab-bar-search-input').fill('zzqqxx');
      await expect(p.locator('#view-search')).toBeVisible();
      await expect(p.locator('#view-search .catalog-tile')).toHaveCount(0);
    },
  },
  {
    name: 'reminders',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'settings');
      await p.locator('#manage-reminders').click();
      await expect(p.locator('.reminder-manager-view')).toBeVisible();
    },
  },
  {
    name: 'confirm-clear-reminders',
    budget: 0,
    go: async (p) => {
      await p.locator('.reminder-manager-clear').click();
      await expect(p.locator('.confirmation-prompt')).toBeVisible();
    },
  },
  {
    // A past program only offers to resume when a checkpoint exists for it;
    // prepareM3U seeds one. After the pointer entry the first RIGHT only
    // shows the focus; the next enters the program column on program 0,
    // which is the past show, and ENTER activates it.
    name: 'catchup-resume',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      await enterTab(p, 'epg');
      await expect(p.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
      await p.keyboard.press('ArrowRight');
      await p.keyboard.press('ArrowRight');
      await p.keyboard.press('Enter');
      await expect(p.locator('.catchup-resume-prompt')).toBeVisible();
    },
  },
  {
    // Reload with the setting enabled, then advance the neutered video to a
    // stable playing frame so the expanded layout stays visible in the shot.
    name: 'live-preview',
    budget: 0,
    go: async (p) => {
      await p.evaluate(() => localStorage.setItem('iptv_live_preview', 'true'));
      await p.reload();
      await expect(p.locator('.channel-item')).toHaveCount(2);
      await p.locator('.channel-item').first().click();
      await p.locator('#video-player').evaluate((video) => {
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('playing'));
      });
      await expect(p.locator('#live-preview')).toBeVisible();
      await expect(p.locator('.live-preview-title')).toHaveText('Current Show');
      await expect(p.locator('.live-preview-message')).toHaveCount(0);
    },
  },
  {
    // The layout is read at boot, so it arrives through a reload. No later
    // screen opens the guide.
    name: 'guide-timeline',
    budget: 0,
    go: async (p) => {
      await p.evaluate(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
      await p.reload();
      await liveLoaded(p);
      await enterTab(p, 'epg');
      await expect(p.locator('.epg-tl-surface')).toBeVisible();
    },
  },
  {
    // The keys put the ring on a program cell of the pooled surface.
    name: 'guide-timeline-focus',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('ArrowDown');
      await expect(p.locator('.epg-tl-focus')).toHaveClass(/focused/);
    },
  },
  {
    // A due reminder prompts at boot, so this one arrives through a reload.
    name: 'reminder-prompt',
    budget: 0,
    go: async (p) => {
      await p.addInitScript((k) => {
        localStorage.setItem('iptv_reminders', JSON.stringify([{
          channelKey: k, channelName: 'Channel One', title: 'Later Show',
          startMs: Date.now() - 60_000, stopMs: Date.now() + 3600_000,
        }]));
      }, channelKey({ url: 'http://streams.example.com/one.m3u8' } as Channel));
      await p.reload();
      await expect(p.locator('.reminder-prompt:not(.hidden)')).toBeVisible();
    },
  },
  {
    name: 'parental-pin-create',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.reminder-prompt:not(.hidden)')).toHaveCount(0);
      await openSettingsPane(p, 'general');
      await p.locator('#manage-parental-controls').click();
      await expect(p.locator('.parental-pin-prompt .parental-pin-dialog')).toBeVisible();
    },
  },
  {
    name: 'parental-controls',
    budget: 0,
    go: async (p) => {
      await enterPin(p);
      await expect(p.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await enterPin(p);
      await expect(p.locator('#view-parental-controls')).toBeVisible();
      const news = p.locator('[data-parental-group]').filter({ hasText: 'News' });
      await news.click();
      await expect(news.locator('.lock-badge.is-locked')).toBeVisible();
    },
  },
  {
    name: 'parental-options',
    budget: 0,
    go: async (p) => {
      await p.locator('[data-parental-tab="options"]').click();
      await expect(p.locator('#parental-duration')).toBeVisible();
    },
  },
  {
    name: 'settings-parental-on',
    budget: 0,
    go: async (p) => {
      await leaveParentalLocked(p);
      await openSettingsPane(p, 'general');
      await expect(p.locator('.parental-entry-status.is-on')).toBeVisible();
    },
  },
  {
    name: 'live-locked',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'live');
      await expect(p.locator('#view-channels .group-item .lock-badge.is-locked').first()).toBeVisible();
      await expect(p.locator('#view-channels .channel-item .lock-badge.is-locked').first()).toBeVisible();
    },
  },
  {
    name: 'parental-pin-challenge',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-channels .channel-main .channel-item').filter({ hasText: 'Channel One' }).click();
      await expect(p.locator('.parental-pin-prompt .parental-pin-dialog')).toBeVisible();
    },
  },
  {
    // Last two: both reload with the playlist state rewritten.
    name: 'loading',
    budget: 0,
    go: async (p) => {
      await p.route('**/playlist.m3u', (r) => new Promise(() => { void r; }));
      // Without its cached copy, the playlist loads from the hanging request.
      await p.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('iptv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('playlist-cache', 'readwrite');
          tx.objectStore('playlist-cache').clear();
          tx.oncomplete = () => { open.result.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }));
      await p.reload();
      await expect(p.locator('#view-channels .empty-state')).toHaveText('Loading channels…');
    },
  },
  {
    name: 'first-run',
    budget: 0,
    go: async (p) => {
      // prepareM3U's init script re-seeds the playlist on every navigation, so
      // drop it from a later one, which runs after it.
      await p.addInitScript(() => localStorage.removeItem('iptv_playlists'));
      await p.reload();
      await expect(p.locator('#view-settings')).toBeVisible();
    },
  },
];

const XTREAM_SCREENS: Screen[] = [
  {
    name: 'account-switcher',
    budget: 0,
    go: async (p) => {
      await p.locator('.account-avatar').click();
      await expect(p.locator('.account-menu-item').first()).toBeVisible();
      await p.locator('.account-avatar').click();
      await expect(p.locator('.account-menu-item')).toHaveCount(0);
    },
  },
  {
    name: 'movies',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile[data-item-id="10"]').first()).toBeVisible();
    },
  },
  {
    // The rail's last tile, focused from the D-pad: its ring and the end
    // gutter beside it.
    name: 'movies-see-all',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'movies');
      const first = p.locator('#view-movies [data-rail-key="cat:1"] .catalog-tile').first();
      await expect(first).toBeVisible();
      await first.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
      for (let i = 0; i < 20; i++) await p.keyboard.press('ArrowRight');
      await expect(p.locator('#view-movies .catalog-see-all[data-category-id="1"]')).toHaveClass(/focused/);
      await railAtRest(p, '#view-movies [data-rail-key="cat:1"] .catalog-rail-track');
    },
  },
  {
    name: 'movies-all-categories',
    budget: 0,
    go: async (p) => {
      const cat = p.locator('#view-movies .catalog-cat[data-category-id="1"]');
      await cat.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
      await p.keyboard.press('ArrowRight');
      await expect(p.locator('#view-movies .catalog-cat[data-category-id="2"]')).toHaveClass(/focused/);
      await railAtRest(p, '#view-movies .catalog-rails');
      await railAtRest(p, '#view-movies .catalog-category-rail');
    },
  },
  {
    // A category grid's sort row with its filters, held narrow so it wraps:
    // the legacy margins must space the second line as flex gap does.
    name: 'movies-grid-filters',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Enter');
      await expect(p.locator('#view-movies .catalog-grid-title')).toHaveText('Cat B');
      const row = p.locator('#view-movies .catalog-grid .catalog-sort');
      await expect(row.locator('.catalog-filter-input')).toBeVisible();
      await narrowRow(p, '#view-movies .catalog-grid .catalog-sort', 900);
      await expect.poll(() => row.locator('.catalog-filter-search').evaluate((search) =>
        search.getBoundingClientRect().top > search.parentElement!.getBoundingClientRect().top + 20)).toBe(true);
    },
  },
  {
    name: 'movie-detail',
    budget: 0,
    go: async (p) => {
      await widenRow(p);
      await p.keyboard.press('Escape');
      await expect(p.locator('#view-movies .catalog-grid')).toBeHidden();
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
    },
  },
  {
    // The detail actions wrap onto a second line.
    name: 'movie-detail-actions',
    budget: 0,
    go: async (p) => {
      await narrowRow(p, '#view-movies .detail-actions', 700);
    },
  },
  {
    name: 'watchlist-toast',
    budget: 0,
    go: async (p) => {
      await widenRow(p);
      await p.locator('#view-movies [data-action="watchlist"]').click();
      await expect(p.locator('.toast.visible')).toBeVisible();
    },
  },
  {
    // With the keys, the focused round action's name pushes the rest along.
    name: 'movie-detail-icon-name',
    budget: 0,
    go: async (p) => {
      await focusByKeys(p, '#view-movies [data-action="play"]', '#view-movies [data-action="watched"]');
      await expectNameShown(p, '#view-movies [data-action="watched"]');
    },
  },
  {
    // Under the pointer the name opens the same way, as wide as the row's longest.
    name: 'movie-detail-icon-pointer-name',
    budget: 0,
    go: async (p) => {
      await hoverCircle(p, '#view-movies [data-action="hide"]');
      await expectNameShown(p, '#view-movies [data-action="hide"]');
    },
  },
  {
    name: 'series',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await enterTab(p, 'series');
      await expect(p.locator('#view-series .catalog-tile[data-item-id="20"]').first()).toBeVisible();
    },
  },
  {
    name: 'series-detail',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-series .catalog-tile[data-item-id="20"]').first().click();
      await expect(p.locator('#view-series .episode-row')).toHaveCount(3);
      await imagesLoaded(p, '#view-series img');
    },
  },
  {
    // The season's watched action wraps onto a second line.
    name: 'series-detail-seasons',
    budget: 0,
    go: async (p) => {
      const row = p.locator('#view-series .series-seasons');
      await narrowRow(p, '#view-series .series-seasons', 200);
      await expect.poll(() => row.locator('.detail-icon-row').evaluate((mark) =>
        mark.getBoundingClientRect().top > mark.parentElement!.getBoundingClientRect().top + 20)).toBe(true);
    },
  },
  {
    name: 'series-detail-season-name',
    budget: 0,
    go: async (p) => {
      await widenRow(p);
      await focusByKeys(p, '#view-series .series-season-btn', '#view-series [data-action="season-watched"]');
      await expectNameShown(p, '#view-series [data-action="season-watched"]');
    },
  },
  {
    // The middle episode, so both skips flank play/pause.
    name: 'series-osd',
    budget: 0.001, // opaque-panel residue, as on the movie player
    go: async (p) => {
      await widenRow(p);
      await p.locator('#view-series .episode-row[data-episode-id="12"]')
        .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
      await p.keyboard.press('Enter');
      await expect(p.locator('#player-osd .osd-vod-detail')).toContainText('S1 E2');
      await expect(p.locator('#player-osd [data-skip-episode="-1"]')).toBeEnabled();
      await expect(p.locator('#player-osd [data-skip-episode="1"]')).toBeEnabled();
    },
  },
  {
    name: 'series-up-next',
    budget: 0.001,
    go: async (p) => {
      await endHoldingUpNext(p);
      await expect(p.locator('#player-osd .osd-next-episode')).toContainText('S1 E3');
      await imagesLoaded(p, '#player-osd .osd-next-episode-thumb');
    },
  },
  {
    name: 'series-continue-watching',
    budget: 0,
    go: async (p) => {
      await seedUserData(p, 'playback-progress', [1, 2, 3].map((n) => ({
        key: `resume:x1|episode|e${String(n)}`,
        value: {
          accountId: 'x1', kind: 'episode', itemId: `e${String(n)}`, name: `Series ${String(n)} — S1E1`,
          poster: '', ext: 'mp4', position: 100, duration: 600, updatedAt: Date.now() - n,
          season: 1, episode: 1,
          watchlistOwner: { kind: 'series', itemId: `s${String(n)}`, name: `Series ${String(n)}`, poster: '' },
        },
        updatedAt: Date.now() - n,
      })));
      await expect(p.locator('.tab-bar-item[data-section="series"]')).toBeVisible();
      await enterTab(p, 'series');
      await expect(p.locator('#view-series [data-rail-key="continue"] .catalog-tile-stack').nth(2))
        .toBeVisible();
    },
  },
  {
    name: 'vod-osd',
    budget: 0.001, // opaque-panel residue, as on the live player
    go: async (p) => {
      await p.keyboard.press('Escape');
      await enterTab(p, 'movies');
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
      await p.locator('#view-movies .detail-btn').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
    },
  },
  {
    name: 'vod-menu',
    budget: 0.001,
    go: async (p) => {
      await p.mouse.move(1900, 540);
      await expect(p.locator('#player-menu')).toBeVisible();
    },
  },
  {
    name: 'vod-menu-speed',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__speed_open__"]').click();
      await expect(p.locator('#player-menu [data-playback-rate="1.5"]')).toBeVisible();
    },
  },
  {
    name: 'vod-menu-subtitles',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__menu_back__"]').click();
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await expect(p.locator('[data-menu-action="__subs_search__"]')).toBeVisible();
    },
  },
  {
    // Subtitle Sync only lists once a shiftable subtitle is on, so the pane has
    // to be reopened after picking the sidecar.
    name: 'vod-subtitle-offset',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__subs_track__"][data-track-index="2000"]').click();
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await p.locator('[data-menu-action="__subs_offset__"]').click();
      await expect(p.locator('#subtitle-offset:not(.hidden)')).toBeVisible();
    },
  },
  {
    // The live player's subtitle offset stays uncovered: the desktop preview
    // drives HLS through hls.js, whose subtitle track can't activate while the
    // neutered <video> keeps the media from ever attaching.
    name: 'vod-subtitle-search',
    budget: 0.001,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.mouse.move(1900, 540);
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await p.locator('[data-menu-action="__subs_search__"]').click();
      await expect(p.locator('#subtitle-search .subs-count').first()).toBeVisible();
    },
  },
  {
    name: 'movies-continue-watching',
    budget: 0,
    go: async (p) => {
      await seedUserData(p, 'playback-progress', [{
        key: 'resume:x1|vod|10',
        value: {
          accountId: 'x1', kind: 'vod', itemId: '10', name: 'Movie One',
          poster: '', ext: 'mp4', position: 600, duration: 3600, updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      }]);
      await expect(p.locator('.tab-bar-item[data-section="movies"]')).toBeVisible();
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile').first()).toBeVisible();
      await expect(p.locator('#view-movies .catalog-rail-title').first())
        .toHaveText('Continue Watching');
    },
  },
  {
    // A resumed title: Resume's progress bar runs along its whole foot.
    name: 'movie-detail-resume',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies [data-rail-key="continue"] .catalog-tile').first().click();
      await expect(p.locator('#view-movies .detail-btn-progress')).toBeVisible();
      await expect.poll(() => p.locator('#view-movies .detail-btn-progress').evaluate((bar) =>
        Math.round(bar.getBoundingClientRect().left - bar.parentElement!.getBoundingClientRect().left))).toBe(3);
    },
  },
  {
    name: 'movies-continue-management',
    budget: 0,
    go: async p => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#view-movies [data-collection-manage="continue"]')).toBeVisible();
      await p.locator('#view-movies [data-collection-manage="continue"]').click();
      await expect(p.locator('#view-movies .catalog-managing')).toBeVisible();
      await p.locator('#view-movies .catalog-remove-mark').hover();
      await expect(p.locator('#view-movies .catalog-remove-mark')).toHaveClass(/focused/);
    },
  },
  {
    // The Movies kind drops the playlist column and docks the account slot.
    name: 'parental-controls-movies',
    budget: 0,
    go: async (p) => {
      // The Xtream setup has no LAN stub, and the entry sits at the top of
      // the first pane anyway.
      await enterTab(p, 'settings');
      await p.locator('#manage-parental-controls').click();
      await enterPin(p);
      await expect(p.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await enterPin(p);
      const view = p.locator('#view-parental-controls');
      await view.locator('#parental-kind [data-value="vod"]').click();
      const category = view.locator('[data-parental-group]').filter({ hasText: 'Cat A' });
      await category.click();
      await expect(category.locator('.lock-badge.is-locked')).toBeVisible();
      await expect(view.locator('[data-parental-item]').filter({ hasText: 'Movie One' })).toBeVisible();
    },
  },
  {
    name: 'movies-locked',
    budget: 0,
    go: async (p) => {
      await leaveParentalLocked(p);
      await enterTab(p, 'movies');
      await expect(p.locator('#view-movies .catalog-tile .lock-badge.is-locked').first()).toBeVisible();
    },
  },
  {
    name: 'movies-sort-directions',
    budget: 0,
    go: async (p) => {
      const row = p.locator('#view-movies .catalog-layer-browse .catalog-sort');
      await row.locator('.dropdown-trigger').click();
      await row.locator('[data-dropdown-value="name"]').click();
      await row.locator('[data-sort-direction="desc"]').hover();
      await expect(row.locator('[data-sort-direction="asc"]')).toHaveAttribute('aria-checked', 'true');
    },
  },
  {
    name: 'movies-sort-menu',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies .catalog-layer-browse .dropdown-trigger').click();
      await p.mouse.move(1850, 1040);
      await expect(p.locator('#view-movies .dropdown.open')).toBeVisible();
    },
  },
  {
    // An Xtream card's fields grow to fill each line.
    name: 'settings-sources-xtream',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#view-movies .dropdown.open')).toHaveCount(0);
      await enterTab(p, 'settings');
      await expect(p.locator('.setup-qr')).toBeVisible();
      await p.locator('[data-settings-target="sources"]').click();
      await railAtRest(p, '.settings-scroll');
      await expect(p.locator('.xtream-card .xtream-fields')).toBeVisible();
    },
  },
];

// The AI features' surfaces, against one fake AI server per page that
// answers each request by its shape. The "(l2)" suffix marks a translation.
// An AI search for "talk" fails, as does a probe while `failProbe` is set;
// any other request it doesn't know fails too, and is logged.
interface FakeAi { server: FakeAiServer; failProbe: boolean }

const fakeAi = new WeakMap<Page, FakeAi>();

async function routeParityAi(page: Page): Promise<void> {
  const state: FakeAi = { server: { sent: [] }, failProbe: false };
  state.server = await routeFakeAi(page, (user) => answerAi(user, state));
  fakeAi.set(page, state);
}

function answerAi(user: string, state: FakeAi): unknown {
  if (/^\[[TD]?1\] /.test(user)) return user.split('\n').map((line) => `${line} (l2)`).join('\n');
  if (/^Channel: /m.test(user)) return { matches: [{ number: 1, confidence: 'high' }] };
  if (user.indexOf('Return ok=true') >= 0) return state.failProbe ? 500 : { ok: true, word: 'bravo' };
  let sent: { items?: Array<{ i: number; name?: string }>; types?: unknown; query?: unknown } = {};
  try {
    sent = JSON.parse(user) as typeof sent;
  } catch { /* answered below */ }
  if (sent.items) {
    return sent.items[0]?.name === undefined
      ? { items: sent.items.map((item) => ({ i: item.i, g: 'sports' })) }
      : { flagged: sent.items.flatMap((item) => item.name === 'Group B' ? [{ i: item.i, verdict: 'adult', confidence: 'high' }]
        : item.name === 'Group A' ? [{ i: item.i, verdict: 'mature', confidence: 'low' }] : []) };
  }
  if (sent.types) {
    if (sent.query === 'talk') return 400;
    return { types: ['program'], keywords: [], groups: [], genres: ['Sports'], time: 'any', from_hour: -1, to_hour: -1 };
  }
  if (typeof sent.query === 'string' && Object.keys(sent).length === 1) {
    return { alternatives: [{ text: 'bravo', lang: 'l1', kind: 'translation' }] };
  }
  console.log(`legacy layout parity: unexpected AI request ${JSON.stringify(user.slice(0, 120))}`);
  return 500;
}

// Where the player menu's rows, labels, and AI icons sit, to the pixel.
function menuGeometry(p: Page): Promise<string[]> {
  return p.locator('#player-menu').evaluate((menu) => Array.from(
    menu.querySelectorAll('.menu-item, .menu-track-label, .ai-icon'),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.className}@${[r.left, r.top, r.width, r.height].map(Math.round).join(',')}`;
  }));
}

function pressKeyCode(p: Page, keyCode: number): Promise<void> {
  return p.evaluate((k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true }));
  }, keyCode);
}

const RED = 403;
const GREEN = 404;
const YELLOW = 405;

// Only the guide's own pick contains Alpha One's name, so the EPG picker
// lists a similar name after it; two programs have no category for AI
// program genres to fill.
const AI_EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="c1"><display-name>Alpha-One Plus HD</display-name></channel>
<channel id="c2"><display-name>Bravo-Two Plus HD</display-name></channel>
<channel id="c3"><display-name>Alpha-Oneworld</display-name></channel>
<programme channel="c1" start="${at(-1)}" stop="${at(1)}"><title>Alpha Show Time Cup</title><desc>A synthetic description.</desc></programme>
<programme channel="c1" start="${at(1)}" stop="${at(2)}"><title>Alpha Show Time Final</title><desc>A later description.</desc></programme>
<programme channel="c2" start="${at(-1)}" stop="${at(2)}"><title>Alpha Show Time Talk</title><desc>Another description.</desc><category>Genre B</category></programme>
</tv>`;

async function prepareAiM3U(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="c1" group-title="Group A",Alpha One', 'http://host/a.m3u8',
    '#EXTINF:-1 tvg-id="c2" group-title="Group B",Bravo Two', 'http://host/b.m3u8',
  ].join('\n'));
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.route('**/guide.xml', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: AI_EPG }));
  await stubLanService(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'Source 1', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
  });
  // routeFakeAi writes its config on every navigation; keep what Settings
  // saved since (AI program genres on) across the scenes' reloads.
  await page.addInitScript(() => {
    (window as { parityLlm?: string | null }).parityLlm = localStorage.getItem('iptv_llm');
  });
  await routeParityAi(page);
  await page.addInitScript(() => {
    const kept = (window as { parityLlm?: string | null }).parityLlm;
    const config = JSON.parse(kept || localStorage.getItem('iptv_llm') || '{}') as { features?: Record<string, boolean> };
    if (!kept) config.features = { 'search-expansion': true };
    localStorage.setItem('iptv_llm', JSON.stringify(config));
  });
  // Test connection lists the models before it probes.
  await page.route('http://ai.test/v1/models', (r) => r.fulfill({
    status: r.request().method() === 'OPTIONS' ? 204 : 200,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'm1' }] }),
  }));
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('.channel-item')).toHaveCount(2);
}

async function reloadWith(p: Page, items: Record<string, string | null>): Promise<void> {
  await p.evaluate((entries) => {
    Object.keys(entries).forEach((name) => {
      const value = entries[name];
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, JSON.stringify(value));
    });
  }, items);
  await p.reload();
  await liveLoaded(p);
}

async function askProgramGenres(p: Page): Promise<void> {
  await p.locator('#ai-program-genres .toggle-option[data-value="on"]').click();
  const prompt = p.locator('.confirmation-prompt');
  await expect(prompt.locator('[data-confirm-action="confirm"]')).toBeEnabled();
  await expect(prompt.locator('.confirmation-message')).toContainText(/\d/);
}

const AI_M3U_SCREENS: Screen[] = [
  {
    name: 'ai-settings',
    budget: 0,
    go: async (p) => {
      await openSettingsPane(p, 'ai');
      await p.locator('#ai-test-connection').click();
      await expect(p.locator('#ai-status.ok')).toBeVisible();
    },
  },
  {
    name: 'ai-settings-test-failed',
    budget: 0,
    go: async (p) => {
      fakeAi.get(p)!.failProbe = true;
      await p.locator('#ai-test-connection').click();
      await expect(p.locator('#ai-status.err')).toBeVisible();
    },
  },
  {
    // The ready state, with its request estimate.
    name: 'ai-genres-confirm',
    budget: 0,
    go: async (p) => {
      fakeAi.get(p)!.failProbe = false;
      await askProgramGenres(p);
    },
  },
  {
    // The estimate's lines grow with the text size and must stay whole.
    name: 'ai-genres-confirm-zh-150',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.confirmation-prompt')).toBeHidden();
      await reloadWith(p, { iptv_locale: 'zh-CN', iptv_text_size: '150' });
      await openSettingsPane(p, 'ai');
      await askProgramGenres(p);
    },
  },
  {
    // AI program genres on: the hint and the status line below it.
    name: 'ai-settings-genres',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.confirmation-prompt')).toBeHidden();
      await reloadWith(p, { iptv_locale: null, iptv_text_size: null });
      await openSettingsPane(p, 'ai');
      await askProgramGenres(p);
      await p.locator('.confirmation-prompt [data-confirm-action="confirm"]').click();
      await p.locator('#save-settings').click();
      await expect(p.locator('#ai-program-genres-status')).toHaveText('Programs with an AI genre: 2');
      await p.evaluate(() => {
        const scroll = document.querySelector('.settings-scroll') as HTMLElement;
        const status = document.querySelector('#ai-program-genres-status')!;
        scroll.style.setProperty('scroll-behavior', 'auto');
        scroll.scrollTop += status.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 600;
      });
    },
  },
  {
    // The AI's alternative spelling's band, the AI search action, and
    // program rows with their AI genres.
    name: 'ai-search',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'search');
      await p.locator('.tab-bar-search-input').fill('alpha');
      await expect(p.locator('#view-search .search-expanded')).toContainText('bravo');
      await expect(p.locator('#view-search .search-ask-action')).toBeVisible();
      await expect(p.locator('#view-search .search-program-channel .ai-icon').first()).toBeVisible();
    },
  },
  {
    // An AI search filtered by an AI genre.
    name: 'ai-search-results',
    budget: 0,
    go: async (p) => {
      await p.locator('.tab-bar-search-input').press('ArrowDown');
      await p.keyboard.press('ArrowUp');
      await expect(p.locator('#view-search .search-ask-action')).toHaveClass(/\bfocused\b/);
      await p.keyboard.press('Enter');
      await expect(p.locator('#view-search .search-ask-summary')).toContainText('Sports');
      await expect(p.locator('#view-search .search-program-row')).toHaveCount(2);
    },
  },
  {
    // The AI server fails this one: all results stay, and the note says so.
    name: 'ai-search-failed',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#view-search .search-ask-summary')).toHaveCount(0);
      const input = p.locator('.tab-bar-search-input');
      await input.fill('talk');
      await expect(p.locator('#view-search .search-program-row')).toHaveCount(1);
      await input.press('ArrowDown');
      await p.keyboard.press('ArrowUp');
      await expect(p.locator('#view-search .search-ask-action')).toHaveClass(/\bfocused\b/);
      await p.keyboard.press('Enter');
      await expect(p.locator('#view-search .search-ask-note')).toHaveText('AI search failed. Showing all results.');
    },
  },
  {
    name: 'ai-search-text-150',
    budget: 0,
    go: async (p) => {
      await reloadWith(p, { iptv_text_size: '150' });
      await enterTab(p, 'search');
      await p.locator('.tab-bar-search-input').fill('alpha show');
      await expect(p.locator('#view-search .search-program-channel .ai-icon').first()).toBeVisible();
      await expect(p.locator('#view-search .search-expanded')).toContainText('bravo');
    },
  },
  {
    name: 'epg-mapping-similar',
    budget: 0,
    go: async (p) => {
      await reloadWith(p, { iptv_text_size: null });
      await p.mouse.move(1, 1);
      await pressKeyCode(p, YELLOW);
      const channel = p.locator('.channel-main .channel-item').first();
      await channel.hover();
      await expect(channel).toHaveClass(/focused/);
      await pressKeyCode(p, 13);
      await p.locator('[data-epg-action]').click();
      await expect(p.locator('.epg-mapping-caption')).toHaveText('Similar names');
      const suggestion = p.locator('[data-epg-position="1"]');
      await expect(suggestion.locator('.epg-mapping-ai')).toBeVisible();
      // Down onto the AI suggestion. In the search box, the field's focus
      // style is the accepted :focus-within fallback (a glow on the input,
      // not the wrapper; see legacy-webos-overrides.css), which no layout
      // fix can match.
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('ArrowDown');
      await expect(suggestion).toBeFocused();
    },
  },
  {
    // Green on the program airing now: its translation and the hint's new name.
    name: 'guide-translate',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('.epg-mapping-picker')).toHaveCount(0);
      await pressKeyCode(p, YELLOW);
      await expect(p.locator('.channel-view.editing')).toHaveCount(0);
      await enterTab(p, 'epg');
      await expect(p.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
      await p.keyboard.press('ArrowRight');
      await p.keyboard.press('ArrowRight');
      await pressKeyCode(p, RED);
      await expect(p.locator('#epg-programmes .epg-programme-item.focused')).toContainText('Alpha Show Time Cup');
      await pressKeyCode(p, GREEN);
      await expect(p.locator('#epg-programmes .epg-programme-item.focused .program-translation-label')).toBeVisible();
      await expect(p.locator('#view-epg .epg-hints [data-epg-translate]')).toHaveText('Show original');
    },
  },
  {
    // Translation stays on for the session, so the player's info opens translated.
    name: 'player-info-translate',
    budget: 0.001, // opaque-panel residue, as on the M3U player
    go: async (p) => {
      await enterTab(p, 'live');
      await p.locator('.channel-main .channel-item').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
      await expect(p.locator('.osd-description .program-translation-label')).toBeVisible();
      await expect(p.locator('[data-osd-translate]')).toHaveText('Show original');
    },
  },
  {
    // Last: parental controls stay on once a PIN is set.
    name: 'parental-find-ai',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#view-channels')).toBeVisible();
      await openSettingsPane(p, 'general');
      await p.locator('#manage-parental-controls').click();
      await enterPin(p);
      await expect(p.locator('.parental-pin-prompt h2')).toContainText('Confirm');
      await enterPin(p);
      await expect(p.locator('#view-parental-controls [data-parental-ai] .ai-icon svg')).toHaveCount(1);
    },
  },
  {
    name: 'parental-ai-estimate',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-parental-controls [data-parental-ai]').click();
      await expect(p.locator('.confirmation-prompt')).toContainText('request');
    },
  },
  {
    // The shared SuggestionReview dialog: a likely and a possible AI pick.
    name: 'parental-ai-review',
    budget: 0,
    go: async (p) => {
      await p.locator('.confirmation-prompt [data-confirm-action="confirm"]').click();
      const review = p.locator('.suggestion-review');
      await expect(review.locator('.suggestion-review-row')).toHaveCount(2);
      await expect(review.locator('em.is-accent').first()).toBeVisible();
    },
  },
];

// Two minutes of 8 kHz mono silence: media every engine decodes, so the
// otherwise empty <video> reaches metadata and draws its active cues.
function silentWav(): Buffer {
  const samples = 8000 * 120;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return wav;
}

// A positioned sign and a line with an italic word.
const AI_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 640',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
  'Style: Sign,Arial,20,&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,7,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:10:00.00,Sign,,0,0,0,,{\\pos(40,30)}Bravo Store',
  'Dialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,I {\\i1}really{\\i0} mean it.',
].join('\n');

async function prepareAiXtream(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await seedXtream(page);
  // No preferred subtitle language, so subtitles translate into the UI's.
  await page.addInitScript(() => {
    const config = JSON.parse(localStorage.getItem('iptv_online_subtitles') || '{}') as { preferredLanguage?: string };
    config.preferredLanguage = '';
    localStorage.setItem('iptv_online_subtitles', JSON.stringify(config));
  });
  // Without the canvas font metrics (Chromium 87), assjs sizes text from a
  // DOM line box, which includes the font's line gap: the same Arial draws
  // about 3% smaller. That is font measurement, not layout, and the TV's own
  // font decides it, so both engines take the DOM path here.
  await page.addInitScript(() => {
    const metrics = TextMetrics.prototype as unknown as Record<string, unknown>;
    delete metrics.fontBoundingBoxAscent;
    delete metrics.fontBoundingBoxDescent;
  });
  // A text and an ASS sidecar, each with a cue on screen at the paused start.
  await page.route('**/player_api.php*', (route) => {
    if (!route.request().url().includes('get_vod_info')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info: {
      plot: 'A plot.', duration_secs: 3600, subtitles: [
        { id: '1', title: 'Sub 1', language: 'l1', url: 'http://host/sub1.srt' },
        { id: '2', title: 'Sub 2', language: 'l1', url: 'http://host/sub2.ass' },
      ] } }) });
  });
  await page.route('**/sub1.srt', (r) => r.fulfill({ status: 200, contentType: 'text/plain',
    body: '1\n00:00:00,000 --> 00:10:00,000\nA <i>styled</i> line.\n' }));
  await page.route('http://host/silence.wav', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }));
  await page.route('**/sub2.ass', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: AI_ASS }));
  await routeParityAi(page);
  await page.goto('/');
  await liveLoaded(page);
}

async function openVodSubtitles(p: Page): Promise<void> {
  await p.mouse.move(960, 540);
  await p.mouse.move(1900, 540);
  await expect(p.locator('#player-menu')).toBeVisible();
  await p.locator('[data-menu-action="__subs_open__"]').click();
}

// neuterVideo keeps the app's src from loading, so the <video> never reaches
// metadata and draws no cue. Its attribute still loads natively: load the
// silence, held paused at the start, before any subtitle is picked.
async function loadSilence(p: Page): Promise<void> {
  const video = p.locator('#video-player');
  await video.evaluate((el) => {
    (el as HTMLVideoElement).autoplay = false;
    el.setAttribute('src', 'http://host/silence.wav');
  });
  await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState)).toBeGreaterThan(0);
  await video.evaluate((el) => {
    (el as HTMLVideoElement).pause();
    (el as HTMLVideoElement).currentTime = 0;
  });
}

async function closePlayerMenu(p: Page): Promise<void> {
  // The class drops at once; visibility waits out the fade, and one Back
  // too many leaves the player.
  const open = () => p.locator('#player-menu').evaluate((menu) => menu.classList.contains('visible'));
  for (let i = 0; i < 3 && await open(); i++) await p.keyboard.press('Escape');
  await expect(p.locator('#player-menu')).toBeHidden();
  await expect(p.locator('#view-player')).toBeVisible();
}

const AI_XTREAM_SCREENS: Screen[] = [
  {
    name: 'ai-movie-detail',
    budget: 0,
    go: async (p) => {
      await enterTab(p, 'movies');
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
      await expect(p.locator('#view-movies [data-key="translate"]')).toBeVisible();
    },
  },
  {
    name: 'ai-movie-detail-translated',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies [data-key="translate"]').click();
      await expect(p.locator('#view-movies .detail-plot')).toHaveText('AI translation · A plot. (l2)');
      await expect(p.locator('#view-movies .detail-title')).toHaveText('Movie One (l2)');
    },
  },
  {
    // The shown sidecar offers its translation in one press, or into another language.
    name: 'ai-menu-subtitles',
    // The geometry check pins every row, label, and AI icon; the budget then
    // allows only the opaque-panel residue of the other menus, which scales
    // with the text on the panel, and these lists hold twice the rows.
    budget: 0.002,
    geometry: menuGeometry,
    go: async (p) => {
      await p.locator('#view-movies .detail-btn').first().click();
      await expect(p.locator('#player-osd')).toBeVisible();
      await loadSilence(p);
      await openVodSubtitles(p);
      await p.locator('[data-menu-action="__subs_track__"][data-track-index="2000"]').click();
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await expect(p.locator('[data-menu-action="__subs_translate__"]')).toHaveText('Translate to English');
      await expect(p.locator('[data-menu-action="__subs_translate_open__"]'))
        .toHaveText('Translate to another language…');
    },
  },
  {
    name: 'ai-menu-translation-language',
    budget: 0.002,
    geometry: menuGeometry,
    go: async (p) => {
      await p.locator('[data-menu-action="__subs_translate_open__"]').click();
      await expect(p.locator('#player-menu h2')).toHaveText('Translation language');
    },
  },
  {
    // The finished translation's entry, tagged with its target.
    name: 'ai-menu-subtitles-translated',
    budget: 0.002,
    geometry: menuGeometry,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await expect(p.locator('#player-menu h2')).toHaveText('Subtitles');
      await p.locator('[data-menu-action="__subs_translate__"]').click();
      await expect.poll(() => fakeAi.get(p)!.server.sent.some((user) => user.startsWith('[1] A'))).toBe(true);
      await expect(p.locator('.osd-stream-info')).toContainText('AI translation (English)');
      await openVodSubtitles(p);
      const entry = p.locator('#player-menu .menu-item').filter({ hasText: 'AI · EN' });
      await expect(entry).toBeVisible();
      // While it runs, the row shows its progress.
      await expect(entry.locator('.menu-item-value')).toHaveCount(0);
    },
  },
  {
    // The translated cue, drawn by the engine with its italic word.
    name: 'ai-subtitle-translated',
    budget: 0,
    go: async (p) => {
      await closePlayerMenu(p);
      await expect.poll(() => p.evaluate(() => {
        const video = document.getElementById('video-player') as HTMLVideoElement;
        const track = Array.from(video.textTracks).find((t) => t.mode === 'showing');
        return track?.activeCues?.length ? (track.activeCues[0] as VTTCue).text : '';
      })).toContain('(l2)');
      // Reported as playing while held at the start, the player lets its
      // info fade off the cue.
      await p.locator('#video-player').evaluate((video) => {
        Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
        video.dispatchEvent(new Event('play'));
        video.dispatchEvent(new Event('playing'));
      });
      await expect(p.locator('#player-osd')).toBeHidden({ timeout: 15_000 });
    },
  },
  {
    // The translated ASS sidecar keeps the sign's style and place and the
    // line's italic word.
    name: 'ai-ass-translated',
    budget: 0,
    go: async (p) => {
      const overlay = p.locator('#ass-overlay');
      await p.locator('#video-player').evaluate((video) => {
        delete (video as { paused?: boolean }).paused;
        video.dispatchEvent(new Event('pause'));
      });
      await openVodSubtitles(p);
      await p.locator('[data-menu-action="__subs_track__"]').filter({ hasText: 'Sub 2' }).click();
      await expect(overlay.locator('.ASS-dialogue').filter({ hasText: 'Bravo Store' })).toBeVisible();
      await openVodSubtitles(p);
      await p.locator('[data-menu-action="__subs_translate__"]').click();
      await expect.poll(() => fakeAi.get(p)!.server.sent.some((user) => user.startsWith('[1] Bravo Store'))).toBe(true);
      await expect(overlay.locator('.ASS-dialogue').filter({ hasText: 'Bravo Store (l2)' })).toBeVisible();
      await expect(overlay.locator('.ASS-dialogue').filter({ hasText: 'mean it. (l2)' })).toBeVisible();
      await closePlayerMenu(p);
    },
  },
];

/** Write user-data records straight into the already-created IndexedDB, then
 *  reload — the preview's media pipeline never advances, so nothing the player
 *  would normally persist (resume position, catchup progress) ever appears. */
async function seedUserData(
  page: Page,
  store: string,
  records: { key: string; value: unknown; updatedAt: number }[],
): Promise<void> {
  await page.evaluate(([name, rows]) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(name as string, 'readwrite');
      (rows as unknown[]).forEach((row) => tx.objectStore(name as string).put(row));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), [store, records] as const);
  await page.reload();
}

async function looseTextGaps(modern: Page, legacy: Page): Promise<string[]> {
  return measureLooseText(legacy, await findGappedLooseText(modern));
}

// The generated flex gap margins are scoped to `html.q-no-flex-gap`, which
// makes each one more specific than the component rule it used to yield to —
// a `margin-left: auto` push, most often. Unscope every quirk rule in place
// and report each element whose margins differ from the scoped cascade.
async function quirkScopeMarginShifts(page: Page): Promise<{ rewritten: number; shifts: string[] }> {
  return page.evaluate(() => {
    const QUIRK = 'html.q-no-flex-gap ';
    const sheets = [...document.styleSheets].filter((sheet) => /legacy-webos-/.test(sheet.href || ''));
    const elements = [...document.querySelectorAll<HTMLElement>('body *')];
    const margins = () => elements.map((el) => {
      const style = getComputedStyle(el);
      return `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`;
    });
    const scoped = margins();
    const swapped: [CSSStyleSheet, number, string][] = [];
    for (const sheet of sheets) {
      for (let i = 0; i < sheet.cssRules.length; i++) {
        const rule = sheet.cssRules[i];
        if (!(rule instanceof CSSStyleRule) || rule.selectorText.indexOf(QUIRK) < 0) continue;
        // A wrapping row's generated take-back margin is its own declared
        // margin less the gap, so it means to beat that rule; the build
        // refuses any other bottom margin for the row, and the pixel diff
        // checks where it lands.
        if (/legacy-webos-base/.test(sheet.href || '') && rule.selectorText.indexOf('>') < 0) continue;
        swapped.push([sheet, i, rule.cssText]);
        sheet.deleteRule(i);
        sheet.insertRule(rule.cssText.split(QUIRK).join(''), i);
      }
    }
    const unscoped = margins();
    for (const [sheet, i, text] of swapped) {
      sheet.deleteRule(i);
      sheet.insertRule(text, i);
    }
    // An SVG element's className is an SVGAnimatedString, not its classes.
    const name = (node: Element | null) => node?.getAttribute('class') || node?.tagName.toLowerCase();
    const shifts: string[] = [];
    elements.forEach((el, i) => {
      if (scoped[i] !== unscoped[i]) {
        shifts.push(`.${name(el)} in .${name(el.parentElement)}: ${scoped[i]} vs ${unscoped[i]}`);
      }
    });
    return { rewritten: swapped.length, shifts };
  });
}

async function walk(
  page: Page,
  browser: Browser,
  setUp: (p: Page) => Promise<void>,
  screens: Screen[],
): Promise<void> {
  const legacy = await newLegacyPage(browser);
  await mkdir(DIFF_DIR, { recursive: true });
  try {
    await Promise.all([setUp(page), setUp(legacy.page)]);

    const report: string[] = [];
    const failures: string[] = [];

    for (const screen of screens) {
      await screen.go(page);
      await screen.go(legacy.page);
      const quirkScope = await quirkScopeMarginShifts(legacy.page);
      // Zero means the legacy sheets went unmatched, not that nothing moved.
      expect(quirkScope.rewritten, `${screen.name}: quirk rules unscoped`).toBeGreaterThan(0);
      for (const shift of quirkScope.shifts) {
        const entry = `${screen.name}: quirk scope moved ${shift}`;
        if (failures.indexOf(entry) < 0) failures.push(entry);
      }
      // A toast from an earlier screen fades on a schedule the two pages do
      // not share.
      if (screen.name !== 'watchlist-toast') {
        await Promise.all([page, legacy.page].map((p) =>
          p.locator('.toast.visible').evaluateAll((toasts) => {
            toasts.forEach((toast) => toast.classList.remove('visible'));
          })));
      }
      // Let both settle before sampling.
      await Promise.all([page, legacy.page].map((p) => settled(() => layoutOf(p))));

      if (screen.geometry) {
        const [modernBoxes, legacyBoxes] = await Promise.all([screen.geometry(page), screen.geometry(legacy.page)]);
        expect(modernBoxes.length, `${screen.name}: geometry measured`).toBeGreaterThan(0);
        modernBoxes.forEach((box, i) => {
          if (legacyBoxes[i] !== box) failures.push(`${screen.name}: ${box} vs ${String(legacyBoxes[i])}`);
        });
        if (legacyBoxes.length !== modernBoxes.length) {
          failures.push(`${screen.name}: ${String(modernBoxes.length)} boxes vs ${String(legacyBoxes.length)}`);
        }
      }

      const shot = (p: Page) => p.screenshot({ animations: 'disabled', caret: 'hide' });
      const [modernPng, legacyPng] = await Promise.all([shot(page), shot(legacy.page)]);
      const diff = await pixelDiff(page, modernPng, legacyPng, { render: true });

      // Keep the rendered diff for every screen so a passing run stays
      // browsable; the two source frames only when something actually moved.
      if (diff.png) await writeFile(`${DIFF_DIR}/${screen.name}-diff.png`, diff.png);
      if (diff.bbox) {
        await writeFile(`${DIFF_DIR}/${screen.name}-modern.png`, modernPng);
        await writeFile(`${DIFF_DIR}/${screen.name}-legacy.png`, legacyPng);
      }

      // The screen budget is a whole-frame ratio, so a single mis-spaced label
      // can hide under it. Measure that one case directly.
      //
      // Under a loaded suite one page can still be settling when the other is
      // read, which reports a gap that isn't there. A real one does not heal, so
      // only a hit that survives a second look counts.
      const tight = await looseTextGaps(page, legacy.page);
      if (tight.length) {
        await Promise.all([page, legacy.page].map((p) => settled(() => layoutOf(p))));
        const again = await looseTextGaps(page, legacy.page);
        for (const offender of again) {
          const entry = `${screen.name}: ${offender}`;
          if (tight.indexOf(offender) >= 0 && failures.indexOf(entry) < 0) failures.push(entry);
        }
      }

      const pct = (diff.ratio * 100).toFixed(3);
      report.push(`${screen.name}: ${pct}%${diff.bbox ? ` bbox=${JSON.stringify(diff.bbox)}` : ''}`);
      if (diff.ratio <= screen.budget) continue;

      failures.push(`${screen.name}: ${pct}% > ${(screen.budget * 100).toFixed(3)}%`);
      // Attach all three so the report shows what moved, and where.
      await test.info().attach(`${screen.name}-modern`, { body: modernPng, contentType: 'image/png' });
      await test.info().attach(`${screen.name}-legacy`, { body: legacyPng, contentType: 'image/png' });
      if (diff.png) {
        await test.info().attach(`${screen.name}-diff`, { body: diff.png, contentType: 'image/png' });
      }
    }

    console.log(`\nlegacy layout parity:\n  ${report.join('\n  ')}\n  → ${DIFF_DIR}/\n`);
    expect(failures, 'the legacy fallback moved something the modern engine places elsewhere').toEqual([]);
  } finally {
    await legacy.close();
  }
}

test('the webOS 4 fallbacks lay out where the modern engine does, with an M3U playlist only', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.slow();
  await walk(page, browser, prepareM3U, M3U_SCREENS);
});

// An Xtream account adds the Movies/Series sections and docks the avatar in the
// tab bar — a second tab-bar layout, and the one that exposed its missing gap.
test('the webOS 4 fallbacks lay out where the modern engine does, with an Xtream account', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.slow();
  await walk(page, browser, prepareXtream, XTREAM_SCREENS);
});

// Every AI feature's surface: Settings, the genres prompt, Search, the EPG
// picker, program translation and Find with AI on an M3U playlist; movie
// info and subtitle translation on an Xtream account.
test('the webOS 4 fallbacks lay out the AI features where the modern engine does, with an M3U playlist', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.slow();
  await walk(page, browser, prepareAiM3U, AI_M3U_SCREENS);
});

test('the webOS 4 fallbacks lay out the AI features where the modern engine does, with an Xtream account', async ({ page, browser }) => {
  test.skip(isChromium53(), 'this test drives both engines itself, so it runs once');
  test.slow();
  await walk(page, browser, prepareAiXtream, AI_XTREAM_SCREENS);
});
