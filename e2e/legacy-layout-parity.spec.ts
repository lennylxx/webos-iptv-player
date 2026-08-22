import { enterTab, test, expect, isChromium53, neuterVideo, routeLiveManifest, routePlaylist, type Page } from './helpers';
import { type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { findGappedLooseText, measureLooseText, newLegacyPage, pixelDiff } from './pixel-parity';
import { seedXtream } from './fixtures/xtream';
import { channelKey } from '../src/utils/channel';
import { type Channel } from '../src/types';

// webOS 4/5/6 lack flex `gap`, CSS Grid and backdrop-filter, so the app ships a
// second layout built from `> * + *` margins and float/inline-block fallbacks.
// Those fallbacks are meant to *reproduce* the modern layout, not merely to
// avoid collapsing — but nothing checked that they land in the same place.
//
// Both engines here are the same headless Chromium with the same fonts, so text
// rasterises identically and every differing pixel is a layout difference. That
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
    type Cb = (resp: unknown) => void;
    type LunaOpts = { method?: string; onSuccess?: Cb; onFailure?: Cb };
    (window as unknown as { webOS?: unknown }).webOS = {
      service: {
        request: (_uri: string, opts: LunaOpts) => {
          if (opts.method === 'start') {
            setTimeout(() => opts.onSuccess?.({ running: true, port: 9999 }), 0);
          } else if (opts.method === 'serviceEvents') {
            setTimeout(() => opts.onSuccess?.({ subscribed: true }), 0);
          } else {
            setTimeout(() => opts.onFailure?.({ errorText: 'unmocked: ' + opts.method }), 0);
          }
          return { cancel(): void { /* no-op */ } };
        },
      },
    };
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
      { name: 'Test', url: 'http://host.example.com/playlist.m3u' },
    ]));
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: key,
      channelName: 'Channel One',
      title: 'Later Show',
      startMs: Date.now() + 3600_000,
      stopMs: Date.now() + 7200_000,
    }]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://epg.example.com/guide.xml'));
    localStorage.setItem('iptv_favorites', JSON.stringify(['one']));
    // A half-watched past programme, so the EPG offers to resume it.
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
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-item')).toHaveCount(2);
}

async function prepareXtream(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await seedXtream(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
}

interface Screen {
  name: string;
  /** Budget as a fraction of the viewport; see the calibration note below. */
  budget: number;
  go: (page: Page) => Promise<void>;
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
  ...(['general', 'sources', 'guide', 'appearance', 'playback', 'subtitles', 'data']
    .map((pane) => ({
      name: `settings-${pane}`,
      // The data pane prints a storage quota, and `navigator.storage` is
      // Chromium 55 — so webOS 4 estimates it another way. Environment, not
      // layout.
      budget: pane === 'data' ? 0.0005 : 0,
      go: async (p: Page) => {
        await enterTab(p, 'settings');
        // The stubbed service makes the panel render for real and refreshes
        // the upload list; both land after the view opens, so wait for them
        // before placing the column.
        await expect(p.locator('.setup-qr')).toBeVisible();
        await expect(p.locator('#upload-entries .empty-hint')).toBeVisible();
        // Clicking the nav item starts the app's scroll animation, which can
        // still be running when the frame is taken; that behaviour has its own
        // spec. Place the column where the animation would rest instead —
        // sampling the top of every pane would be steadier, but then nothing
        // below the fold is ever compared.
        await p.evaluate((name) => {
          const scroll = document.querySelector('.settings-scroll') as HTMLElement;
          const target = document.querySelector(`#settings-${name}`)!;
          // The scroller sets `scroll-behavior: smooth`, so even assigning
          // scrollTop animates. Go through `setProperty`: the simulation
          // deletes the CSSOM reflection but cannot take the property away
          // from the real engine.
          scroll.style.setProperty('scroll-behavior', 'auto');
          scroll.scrollTop += target.getBoundingClientRect().top
            - scroll.getBoundingClientRect().top;
        }, pane);
        await expect(p.locator(`.settings-nav-item.active[data-settings-target="${pane}"]`))
          .toBeVisible();
      },
    }))),
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
    // A past programme only offers to resume when a checkpoint exists for it;
    // prepareM3U seeds one. RIGHT enters the programme column on programme 0,
    // which is the past show, and ENTER activates it.
    name: 'catchup-resume',
    budget: 0,
    go: async (p) => {
      await p.keyboard.press('Escape');
      await p.keyboard.press('Escape');
      await enterTab(p, 'epg');
      await expect(p.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
      await p.keyboard.press('ArrowRight');
      await p.keyboard.press('Enter');
      await expect(p.locator('.catchup-resume-prompt')).toBeVisible();
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
    // Last two: both reload with the playlist state rewritten.
    name: 'loading',
    budget: 0,
    go: async (p) => {
      await p.route('**/playlist.m3u', (r) => new Promise(() => { void r; }));
      await p.reload();
      await expect(p.locator('#view-loading')).toBeVisible();
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
    name: 'movie-detail',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies .catalog-tile[data-item-id="10"]').first().click();
      await expect(p.locator('#view-movies .detail-plot')).toContainText('A plot.');
    },
  },
  {
    name: 'watchlist-toast',
    budget: 0,
    go: async (p) => {
      await p.locator('#view-movies [data-action="watchlist"]').click();
      await expect(p.locator('.toast.visible')).toBeVisible();
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
      await expect(p.locator('#view-series .episode-row')).toBeVisible();
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
    name: 'vod-menu-subtitles',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__subs_open__"]').click();
      await expect(p.locator('[data-menu-action="__subs_track__"][data-track-index="-3"]')).toBeVisible();
    },
  },
  {
    // Subtitle Sync only lists once a shiftable subtitle is on, so the pane has
    // to be reopened after picking the sidecar.
    name: 'vod-subtitle-offset',
    budget: 0.001,
    go: async (p) => {
      await p.locator('[data-menu-action="__subs_track__"][data-track-index="0"]').click();
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
      await p.locator('[data-menu-action="__subs_track__"][data-track-index="-3"]').click();
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
      // A toast from an earlier screen fades on a schedule the two pages do
      // not share.
      if (screen.name !== 'watchlist-toast') {
        await Promise.all([page, legacy.page].map((p) =>
          p.locator('.toast.visible').evaluateAll((toasts) => {
            toasts.forEach((toast) => toast.classList.remove('visible'));
          })));
      }
      // Let both settle on the same frame before sampling.
      await page.waitForTimeout(250);
      await legacy.page.waitForTimeout(250);

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
        await page.waitForTimeout(500);
        await legacy.page.waitForTimeout(500);
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
