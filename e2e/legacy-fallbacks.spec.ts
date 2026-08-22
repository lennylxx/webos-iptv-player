import {
  enterTab, test, expect, isChromium53, neuterVideo, routeLiveManifest, routePlaylist,
  seedPlaylist, type Page, SAMPLE_M3U,
} from './helpers';
import { POLYFILLED_APIS } from '../scripts/polyfilled-apis.mjs';

// The webOS 4 fallbacks are only correct if they are *inert* on a modern TV
// (webOS 6/22/23/24/25). A leaked fallback is not a no-op: it double-applies —
// an unguarded `:focus` ring once stacked a second glow inside the modern
// `:focus-within` ring. The legacy suite proves the fallbacks work on the old
// engine; this one proves they stay out of the way on the new one.

async function nativeApis(page: import('@playwright/test').Page, paths: string[]) {
  return page.evaluate((names) => {
    const result: Record<string, string> = {};
    for (const name of names) {
      const value = name.split('.').reduce<unknown>(
        (owner, key) => (owner as Record<string, unknown> | undefined)?.[key],
        window as unknown,
      );
      if (typeof value !== 'function') result[name] = 'missing';
      else result[name] = /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(value))
        ? 'native'
        : 'polyfill';
    }
    return result;
  }, paths);
}

test('a modern engine keeps every polyfilled API native', async ({ page }) => {
  test.skip(isChromium53(), 'the simulation deliberately removes these');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const apis = await nativeApis(page, POLYFILLED_APIS);
  for (const name of POLYFILLED_APIS) expect(apis[name], name).toBe('native');
});

test('the simulated engine really falls back to the polyfills', async ({ page }) => {
  test.skip(!isChromium53(), 'only the simulation removes the natives');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const apis = await nativeApis(page, POLYFILLED_APIS);
  // Not merely present — present *and* ours, which is what a webOS 4 TV gets.
  for (const name of POLYFILLED_APIS) expect(apis[name], name).toBe('polyfill');

  // Discovery, the other direction: scan the built-in surface for anything
  // non-native and require it to be a listed entry. This is what keeps
  // POLYFILLED_APIS honest — a polyfill added anywhere, including the esbuild
  // banner that src/polyfills.ts never mentions, shows up here.
  const discovered = await page.evaluate(() => {
    const owners: [string, object][] = [
      ['Object', Object], ['Array.prototype', Array.prototype],
      ['String.prototype', String.prototype], ['Number.prototype', Number.prototype],
      ['Element.prototype', Element.prototype], ['Node.prototype', Node.prototype],
      ['Document.prototype', Document.prototype],
      ['DocumentFragment.prototype', DocumentFragment.prototype],
      ['Intl', Intl], ['Promise', Promise], ['Promise.prototype', Promise.prototype],
      ['JSON', JSON], ['Math', Math], ['Reflect', Reflect],
      ['window', window],
    ];
    const isNative = (fn: unknown) => /\{\s*\[native code\]\s*\}/
      .test(Function.prototype.toString.call(fn));
    const found: string[] = [];
    for (const [name, owner] of owners) {
      for (const key of Object.getOwnPropertyNames(owner)) {
        // The preview harness parks its own globals on window.
        if (key.indexOf('__') === 0) continue;
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        if (!isNative(descriptor.value)) found.push(`${name}.${key}`);
      }
    }
    return found;
  });

  expect(discovered.slice().sort()).toEqual(POLYFILLED_APIS.slice().sort());
});

test('a modern engine activates none of the legacy CSS fallbacks', async ({ page }) => {
  test.skip(isChromium53(), 'the simulation rewrites these blocks away');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const guards = await page.evaluate(() => {
    const legacy = [...document.styleSheets]
      .filter((sheet) => /legacy-webos-/.test(sheet.href || ''));
    const conditions: { condition: string; active: boolean }[] = [];
    let unguarded = 0;
    for (const sheet of legacy) {
      for (const rule of [...(sheet.cssRules || [])]) {
        if (rule instanceof CSSSupportsRule) {
          conditions.push({ condition: rule.conditionText, active: CSS.supports(rule.conditionText) });
        } else if (!(rule instanceof CSSMediaRule) && rule.constructor.name !== 'CSSComment') {
          unguarded++;
        }
      }
    }
    return { sheets: legacy.length, conditions, unguarded };
  });

  // Both legacy stylesheets must be loaded, or the test would pass vacuously.
  expect(guards.sheets).toBe(2);
  expect(guards.conditions.length).toBeGreaterThan(0);
  expect(guards.unguarded, 'legacy rules outside an @supports guard').toBe(0);
  for (const guard of guards.conditions) expect(guard.active, guard.condition).toBe(false);
});

// addInitScript reaches page realms only, so the worker is degraded by a
// prelude the preview server prepends to its bundle instead. Worker code is
// the M3U/XMLTV parser and the search index — the least forgiving input in the
// app — so a gap here would be silent false confidence.
test('the simulation reaches the worker realm too', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const worker = await page.waitForEvent('worker');
  const surface = await worker.evaluate(() => ({
    // Post-53 and deliberately not polyfilled: shows the prelude ran.
    flat: typeof (Array.prototype as unknown as { flat?: unknown }).flat,
    // Post-53 and polyfilled: shows src/polyfills.ts loads inside the worker.
    flatMap: typeof (Array.prototype as unknown as { flatMap?: unknown }).flatMap,
  }));

  expect(surface.flat).toBe(isChromium53() ? 'undefined' : 'function');
  expect(surface.flatMap).toBe('function');
});

// `space-between` and friends spread the children themselves, so no gap is
// holding them apart.
function findLooseText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const spread = ['space-between', 'space-around', 'space-evenly'];
    const offenders: string[] = [];
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if (!/flex|grid/.test(style.display)) return;
      if (!(parseFloat(style.columnGap) || parseFloat(style.rowGap))) return;
      if (spread.includes(style.justifyContent)) return;
      if (!el.children.length) return;
      const text = Array.from(el.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!text) return;
      const id = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(' ').join('.')}` : ''}`;
      offenders.push(`${id} :: "${text.textContent?.trim().slice(0, 40)}"`);
    });
    return offenders;
  });
}

// The flex-gap fallback is `> * + *`, so a loose text node beside an element
// child is separated by nothing on webOS 4. Only the real engine can measure
// it — the simulation strips `gap`.
test('no flex-gap container separates an element from loose text', async ({ page }) => {
  test.skip(isChromium53(), 'gap is stripped there, so nothing is measurable');

  const M3U = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1" group-title="News",Channel 1',
    'http://streams.example.com/ch1.m3u8',
  ].join('\n');
  // Relative to now so the aired / airing / upcoming variants all render — the
  // LIVE badge and the replay glyph are gap containers of their own.
  const at = (hours: number) => new Date(Date.now() + hours * 3600_000)
    .toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="${at(-3)}" stop="${at(-2)}"><title>Earlier Show</title></programme>
<programme channel="ch1" start="${at(-1)}" stop="${at(1)}"><title>Current Show</title></programme>
<programme channel="ch1" start="${at(2)}" stop="${at(3)}"><title>Later Show</title></programme>
</tv>`;

  await routePlaylist(page, M3U);
  await routeLiveManifest(page);
  await neuterVideo(page);
  await page.route('**/epg.xml', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
    // A populated Reminder Manager: its rows never render while it is empty.
    // The key is fnv1a of the stream URL, as in src/utils/channel.ts.
    let h = 0x811c9dc5;
    const url = 'http://streams.example.com/ch1.m3u8';
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: (h >>> 0).toString(16).padStart(8, '0'), channelName: 'Channel 1',
      title: 'Later Show', startMs: Date.now() + 7200_000, stopMs: Date.now() + 10800_000,
    }]));
    // Favourites management only offers its hint bar on a non-empty group.
    localStorage.setItem('iptv_favorites',
      JSON.stringify([(h >>> 0).toString(16).padStart(8, '0')]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const offenders = new Set<string>();
  const collect = async () => {
    for (const offender of await findLooseText(page)) offenders.add(offender);
  };
  await collect();

  for (const section of ['epg', 'settings', 'search', 'live'] as const) {
    await enterTab(page, section);
    await page.waitForTimeout(300);
    await collect();
  }

  // The Reminder Manager, then the channel editor: both are full-screen views
  // the section walk never reaches.
  await enterTab(page, 'epg');
  await page.locator('.epg-reminder-entry').click();
  await expect(page.locator('#view-reminders')).toBeVisible();
  await expect(page.locator('.reminder-manager-row')).toHaveCount(1);
  await collect();
  await page.keyboard.press('Escape');

  await enterTab(page, 'live');
  await page.locator('[data-edit-channels]').click();
  await expect(page.locator('.channel-view.editing .edit-hints')).toBeVisible();
  await collect();
  await page.keyboard.press('Escape');

  // Favourites management is a second editor mode with a hint bar of its own,
  // and it renders only while the Favourites group is active and non-empty.
  await page.locator('[data-group="builtin:favorites"]').click();
  await page.locator('[data-favorite-manage]').click();
  await expect(page.locator('.edit-hints.favorite-hints')).toBeVisible();
  await collect();
  await page.keyboard.press('Escape');
  await page.locator('[data-group="builtin:all"]').click();

  // The playback overlays sit outside every section: OSD, right-hand menu and
  // the channel sidebar.
  await page.locator('.channel-item').first().click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd')).toBeVisible();
  await collect();

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#player-menu')).toBeVisible();
  await collect();

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar')).toBeVisible();
  await collect();

  expect(Array.from(offenders), 'wrap the text in an element so `> * + *` reaches it').toEqual([]);
});

// The Xtream catalog is a section of its own, unreachable without an account:
// Movies and Series both shipped icon-plus-loose-text detail buttons.
test('no flex-gap container separates an element from loose text in the catalog', async ({ page }) => {
  test.skip(isChromium53(), 'gap is stripped there, so nothing is measurable');

  await page.route('**/get.php*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: SAMPLE_M3U }));
  await page.route('**/xmltv.php*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: 10, name: 'Movie One', stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    if (url.includes('get_vod_info')) return json({ info: { plot: 'A plot.', duration_secs: 3600 } });
    if (url.includes('get_series_categories')) return json([{ category_id: '2', category_name: 'Cat B' }]);
    if (url.includes('get_series_info')) {
      return json({
        info: { name: 'Series One', plot: 'A series plot.' },
        episodes: { 1: [{ id: '11', title: 'Episode 1', season: 1, episode_num: 1,
          container_extension: 'mp4', info: { duration_secs: 600, plot: 'An episode.' } }] },
      });
    }
    if (url.includes('get_series')) {
      return json([{ series_id: 20, name: 'Series One', cover: '', category_id: '2' }]);
    }
    return json({});
  });
  await neuterVideo(page);
  await page.route('**/movie/**', (r) => r.fulfill({
    status: 200, contentType: 'video/mp4', body: '',
  }));
  // The provider is a live third-party API. Stub it in the page rather than
  // through routing, which the app's own fetch path does not go through.
  await page.addInitScript(() => {
    const real = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      // Assrt reports itself configured unconditionally, so answer it too:
      // otherwise the merged search waits out its timeout on every run.
      if (url.indexOf('api.assrt.net') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ sub: { subs: [] } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.indexOf('api.opensubtitles.com') === -1) return real.call(window, input, init);
      const body = { token: 't', data: [
        { attributes: { language: 'l1', release: 'Release One', download_count: 12345,
          files: [{ file_id: 1, file_name: 'one.srt' }] } },
        { attributes: { language: 'l2', release: 'Release Two', download_count: 678,
          files: [{ file_id: 2, file_name: 'two.srt' }] } },
      ] };
      return Promise.resolve(new Response(JSON.stringify(body),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([
      { id: 'x1', name: 'X Account', url: 'http://host.example.com:8080',
        source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ]));
    localStorage.setItem('iptv_online_subtitles', JSON.stringify({
      preferredLanguage: 'l1',
      opensubtitles: { apiKey: 'key', username: 'user', password: 'pass', token: '', tokenTs: 0 },
      subdl: { apiKey: '' },
      assrt: { apiKey: '' },
    }));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const offenders = new Set<string>();
  const collect = async () => {
    for (const offender of await findLooseText(page)) offenders.add(offender);
  };

  await enterTab(page, 'movies');
  await expect(page.locator('.catalog-tile[data-item-id="10"]')).toBeVisible();
  await collect();
  await page.locator('.catalog-tile[data-item-id="10"]').click();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await collect();
  await page.keyboard.press('Escape');

  await enterTab(page, 'series');
  await expect(page.locator('.catalog-tile[data-item-id="20"]')).toBeVisible();
  await collect();
  await page.locator('.catalog-tile[data-item-id="20"]').click();
  await expect(page.locator('#view-series .episode-row')).toBeVisible();
  await collect();

  // The online-subtitle overlay is deeper still: a VOD player, a configured
  // provider, and a result carrying a download count — the only `.subs-count`.
  await enterTab(page, 'movies');
  await page.locator('.catalog-tile[data-item-id="10"]').click();
  await expect(page.locator('#view-movies .detail-plot')).toContainText('A plot.');
  await page.locator('#view-movies .detail-btn').first().click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('#player-osd')).toBeVisible();

  await page.mouse.move(1900, 540);
  await expect(page.locator('#player-menu')).toBeVisible();
  await page.locator('[data-menu-action="__subs_open__"]').click();
  const search = page.locator('[data-menu-action="__subs_track__"][data-track-index="-3"]');
  await expect(search).toBeVisible();
  await collect();
  await search.click();
  await expect(page.locator('#subtitle-search .subs-count').first()).toBeVisible();
  await collect();

  expect(Array.from(offenders), 'wrap the text in an element so `> * + *` reaches it').toEqual([]);
});
