import { test, expect, type Page, routePlaylist, seedPlaylist, PLAYLIST_URL, enterTab } from './helpers';

// All Settings coverage: navigation, playlist save/removal, Xtream, and uploads.

test.describe('Settings navigation', () => {
  test('the Settings tab on the channel list opens settings', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);

    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    await enterTab(page, 'settings');

    await expect(page.locator('#view-settings')).toBeVisible();
    // The configured playlist URL is populated in the settings form.
    await expect(page.locator('.playlist-url').first()).toHaveValue(PLAYLIST_URL);
  });

  test('an open dropdown closes on an outside click or Back before leaving Settings', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.locator('[data-settings-target="appearance"]').click();
    await expect(dropdown).not.toHaveClass(/open/);

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(dropdown).not.toHaveClass(/open/);
    await expect(page.locator('#view-settings')).toBeVisible();
  });

  test('keeps dropdown spacing aligned with adjacent settings', async ({ page }) => {
    await page.goto('/');

    const gaps = await page.evaluate(() => {
      const titleGap = (selector: string): number => {
        const control = document.querySelector<HTMLElement>(selector)!;
        const title = control.closest('.settings-item')!
          .querySelector<HTMLElement>('.settings-item-title')!;
        return control.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      };
      const rows = Array.from(document.querySelectorAll<HTMLElement>(
        '#settings-subtitles .settings-row',
      ));
      return {
        dropdownTitle: titleGap('#os-pref-lang'),
        toggleTitle: titleGap('#overlay-style'),
        dropdownToNextTitle: rows[0].querySelector('label')!.getBoundingClientRect().top
          - document.querySelector('#os-pref-lang')!.getBoundingClientRect().bottom,
        inputToNextTitle: rows[1].querySelector('label')!.getBoundingClientRect().top
          - document.querySelector('#subdl-key')!.getBoundingClientRect().bottom,
      };
    });

    expect(gaps.dropdownTitle).toBe(gaps.toggleTitle);
    expect(gaps.dropdownTitle).toBe(10);
    expect(gaps.dropdownToNextTitle).toBe(gaps.inputToNextTitle);
    expect(gaps.dropdownToNextTitle).toBe(12);
  });

  test('clicking Cancel in settings (opened via the tab bar) returns to the channel list, not the player', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    // Open settings via the tab bar, then dismiss with Cancel.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#cancel-settings').click();

    // Give the document-level deferred select (setTimeout 0) a chance to fire,
    // then assert we still land on the channel list rather than the player.
    // Before the fix, that second select fired on the channels view and played
    // the focused channel.
    await page.waitForTimeout(50);
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('#view-player')).toBeHidden();
    await expect(page.locator('#view-settings')).toBeHidden();
  });

  test('keeps Magic Remote hover separate from the weak scroll-position indicator', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const general = page.locator('[data-settings-target="general"]');
    const appearance = page.locator('[data-settings-target="appearance"]');
    const playback = page.locator('[data-settings-target="playback"]');
    const data = page.locator('[data-settings-target="data"]');

    await playback.hover();
    await expect(playback).toHaveClass(/focused/);
    await expect(general).toHaveClass(/active/);

    await appearance.click();
    await expect(appearance).toHaveClass(/active/);
    await page.locator('.settings-main').evaluate((main) => {
      (main as HTMLElement).style.scrollBehavior = 'auto';
      main.scrollTop = main.scrollHeight;
      main.dispatchEvent(new Event('scroll'));
    });

    await expect(data).toHaveClass(/active/);
    await playback.hover();
    await expect(playback).toHaveClass(/focused/);
    await expect(data).toHaveClass(/active/);
  });

  test('keeps the clicked weak indicator locked throughout smooth scrolling', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.evaluate(() => {
      const changes: string[] = [];
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges = changes;
      new MutationObserver(() => {
        const active = document.querySelector<HTMLElement>('.settings-nav-item.active')
          ?.dataset.settingsTarget;
        if (active && changes[changes.length - 1] !== active) changes.push(active);
      }).observe(document.querySelector('.settings-nav-list')!, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class'],
      });
    });

    const data = page.locator('[data-settings-target="data"]');
    await data.hover();
    await page.evaluate(() => {
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges.length = 0;
    });
    await data.click();
    await expect.poll(() => page.locator('.settings-main').evaluate((main) =>
      Math.abs(main.scrollHeight - main.clientHeight - main.scrollTop) <= 1)).toBe(true);

    const changes = await page.evaluate(() =>
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges);
    expect(changes).toEqual(['data']);
  });

  test('Right enters the selected sidebar category without changing its weak indicator', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const guide = page.locator('[data-settings-target="guide"]');
    await guide.dispatchEvent('nav:hover');
    await page.keyboard.press('ArrowRight');

    await expect(page.locator('#epg-url')).toHaveClass(/focused/);
    await expect(guide).toHaveClass(/active/);
  });

  test('Left returns from a category content boundary to its sidebar item', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const guide = page.locator('[data-settings-target="guide"]');
    await guide.dispatchEvent('nav:hover');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#epg-url')).toHaveClass(/focused/);

    await page.keyboard.press('ArrowLeft');
    await expect(guide).toHaveClass(/focused/);
  });

  test('keeps every localized sidebar label on one line', async ({ page }) => {
    const locales = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'uk', 'zh-CN'];
    await page.goto('/');

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      const result = await page.locator('.settings-sidebar').evaluate((sidebar) => {
        const bad = Array.from(sidebar.querySelectorAll<HTMLElement>(
          '.settings-nav-item, .settings-nav-help-row'))
          .filter((item) => {
            const label = item.lastElementChild;
            if (!label) return true;
            const range = document.createRange();
            range.selectNodeContents(label);
            return range.getClientRects().length !== 1 || item.scrollWidth > item.clientWidth;
          })
          .map((item) => item.textContent?.trim() ?? '');
        return { bad, width: Math.round(sidebar.getBoundingClientRect().width) };
      });

      expect(result.bad, locale).toEqual([]);
      expect(result.width, locale).toBeGreaterThanOrEqual(252);
      expect(result.width, locale).toBeLessThanOrEqual(328);
    }
  });

  test('lays out the 15 theme swatches across three full rows', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="appearance"]').click();

    const rowCounts = await page.locator('.theme-swatch').evaluateAll((swatches) => {
      const rows = new Map<number, number>();
      for (const swatch of swatches) {
        const top = Math.round(swatch.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? 0) + 1);
      }
      return Array.from(rows.values());
    });

    expect(rowCounts).toEqual([5, 5, 5]);
  });

  test('the text size picker scales only fonts and persists', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();

    const title = page.locator('.settings-title');
    const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const base = await fontSize();

    await page.locator('[data-settings-target="appearance"]').click();
    await page.locator('#text-size .dropdown-trigger').click();
    const option = page.locator('#text-size .dropdown-option[data-dropdown-value="130"]');
    await expect(option).toBeVisible();
    await option.click();
    // Live preview: the scale applies before saving.
    expect(await fontSize()).toBeCloseTo(base * 1.3, 1);

    await page.locator('#save-settings').click();
    await expect(page.locator('#view-channels')).toBeVisible();

    // Persisted across a relaunch and applied outside Settings, without
    // changing the dimensions of controls.
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    const row = page.locator('.channel-item').first();
    const metrics = () => row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        font: parseFloat(getComputedStyle(el.querySelector('.channel-name')!).fontSize),
        height: parseFloat(cs.height),
        padding: parseFloat(cs.paddingLeft),
        logo: parseFloat(getComputedStyle(el.querySelector('.channel-logo-wrap')!).width),
      };
    });
    const scaled = await metrics();
    // Same measurements at the default size, from a clean load.
    await page.evaluate(() => localStorage.removeItem('iptv_text_size'));
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    const unscaled = await metrics();
    expect(scaled.font).toBeCloseTo(unscaled.font * 1.3, 1);
    for (const key of ['height', 'padding', 'logo'] as const)
      expect(scaled[key], key).toBeCloseTo(unscaled[key], 1);
  });
});

test.describe('Settings playlists', () => {
  test('saving a playlist in settings reloads and shows its channels', async ({ page }) => {
    await routePlaylist(page);
    await page.goto('/');

    // First run with no playlist opens settings.
    await expect(page.locator('#view-settings')).toBeVisible();

    // Add a playlist row and fill in its URL.
    await page.locator('#add-playlist').click();
    await page.locator('.playlist-name').first().fill('Saved');
    await page.locator('.playlist-url').first().fill(PLAYLIST_URL);

    // Drive Save via the remote-style focus + Enter path (avoids the click's
    // deferred select firing on the channel view after the reload). Use an
    // explicit CustomEvent so SpatialNav's parent-bound listener receives a
    // bubbling nav:hover.
    await page.locator('.playlist-url').first().blur();
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel One' })).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel Two' })).toBeVisible();
  });

  test('removing the last playlist clears in-memory channels so back returns an empty list', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');

    // Channels render from the configured playlist.
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);

    // Open settings, remove the only playlist, and save.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('.remove-playlist').first().click();
    await expect(page.locator('#playlist-entries .settings-row')).toHaveCount(0);
    // Save via the keyboard path so the deferred-select skip-list does not
    // matter here (this test is about stale in-memory state, not click wiring).
    // Use page.evaluate for an explicit CustomEvent so SpatialNav's parent-
    // bound listener definitely receives the bubbling nav:hover.
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    // loadData re-opens settings because there are no playlists now. Wait for
    // the storage write + settings re-open before pressing Back, because the
    // test would otherwise race against the async loadData() call inside
    // onSettingsSaved.
    await page.waitForFunction(() => {
      const pls = JSON.parse(localStorage.getItem('iptv_playlists') || '[]') as unknown[];
      const settings = document.getElementById('view-settings');
      return pls.length === 0 && settings != null && !settings.classList.contains('hidden');
    });

    // Press Back to return to the channel list — it must NOT show the previous
    // playlist's channels (the bug: PlaylistService kept stale in-memory state).
    // Use dispatchEvent(KeyboardEvent) rather than page.keyboard.press('Escape')
    // — in this Playwright/Chromium combo press('Escape') gets consumed by
    // native key handling before any JS keydown listener fires (verified by
    // tracing: keyCode=13 Enter pressed via press() reaches KeyHandler, but
    // keyCode=27 Escape pressed via press() never does).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
    await expect(page.locator('.empty-state')).toContainText('No channels found');
  });

  // Regression: a global document click handler fired a deferred "select" after
  // the clicked Remove button detached (its `.settings-view` ancestor gone, so
  // the guard missed it), deleting a second row — clicking Remove on row N wiped
  // out N and N+1. waitForTimeout lets that deferred select fire.
  test.describe('playlist removal', () => {
    // Seed three playlists and stub their URLs so the app boots into the channel
    // list without real network.
    async function seedThree(page: Page): Promise<void> {
      const stream = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,\nhttp://streams.example.com/s.ts';
      await page.route('**/one.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/two.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/four.m3u', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl',
        body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a\n#EXTINF:-1,Bravo\nhttp://streams.example.com/b' }));
      await page.addInitScript(() => {
        localStorage.setItem('iptv_playlists', JSON.stringify([
          { name: 'Playlist 1', url: 'http://host.example.com/one.m3u8', source: 'url', id: 'id1' },
          { name: 'Playlist 2', url: 'http://host.example.com/two.m3u8', source: 'url', id: 'id2' },
          { name: 'Playlist 4', url: 'http://host.example.com/four.m3u', source: 'url', id: 'id3' },
        ]));
      });
    }

    async function openSettings(page: Page): Promise<void> {
      await page.goto('/');
      await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
      await enterTab(page, 'settings');
      await page.waitForSelector('.remove-playlist');
    }

    const names = (page: Page) =>
      page.$$eval('.playlist-name', els => (els as HTMLInputElement[]).map(e => e.value));

    test('Remove deletes only the clicked row', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').first().click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 2', 'Playlist 4']);
    });

    test('removing a middle row leaves the rest intact', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').nth(1).click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 1', 'Playlist 4']);
    });

    test('deleting down to the last row clears it (no spurious re-add)', async ({ page }) => {
      // Removing the last row left focus on "+ Add Playlist"; the deferred select
      // then "clicked" it and re-added an empty row, so the last one never went.
      await seedThree(page);
      await openSettings(page);
      for (let i = 0; i < 3; i++) {
        await page.locator('.remove-playlist').first().click();
        await page.waitForTimeout(150);
      }
      await expect(page.locator('.playlist-name')).toHaveCount(0);
      await expect(page.locator('#playlist-entries .empty-hint')).toBeVisible();
    });
  });
});

test.describe('Settings Xtream: add -> cancel -> re-enter', () => {
  // Boot into the channel list (so the settings gear is present) with one M3U
  // playlist and NO Xtream account — matching "no Xtream account at all".
  async function seedOneM3u(page: Page): Promise<void> {
    await page.route('**/one.m3u', r => r.fulfill({
      status: 200, contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a',
    }));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { name: 'Playlist 1', url: 'http://host.example.com/one.m3u', source: 'url', id: 'id1' },
      ]));
    });
  }

  async function openSettings(page: Page): Promise<void> {
    await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
    await enterTab(page, 'settings');
    await page.waitForSelector('#add-xtream');
  }

  test("re-entering Settings after Cancel must NOT show a leftover Xtream card", async ({ page }) => {
    await seedOneM3u(page);
    await page.goto('/');

    // 1) Open Settings — no Xtream account yet, no auto-added card.
    await openSettings(page);
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');

    // 2) Click "+ Add Xtream Account" — a blank card appears.
    await page.click('#add-xtream');
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(1);

    // 3) Cancel.
    await page.click('#cancel-settings');
    await expect(page.locator('#view-channels')).toBeVisible(); // back on channels

    // 4) Re-enter Settings.
    await openSettings(page);

    // 5) The card must be gone (this is the user's reported bug).
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');
  });
});

test.describe('Settings Xtream live output', () => {
  test('saving HLS reloads the account with output=m3u8', async ({ page }) => {
    await page.route('**/get.php*', (route) => {
      const output = new URL(route.request().url()).searchParams.get('output');
      const channel = output === 'm3u8' ? 'HLS Channel' : 'TS Channel';
      return route.fulfill({
        status: 200,
        contentType: 'application/x-mpegurl',
        body: `#EXTM3U\n#EXTINF:-1,${channel}\nhttp://streams.example.com/live`,
      });
    });
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: action === 'get_live_streams' ? '[]' : '{}',
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      }]));
    });

    await page.goto('/');
    await expect(page.locator('.channel-main .channel-item')).toContainText('TS Channel');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('#xtream-output-x1 .dropdown-trigger').click();
    await page.locator('#xtream-output-x1 [data-dropdown-value="m3u8"]').click();

    const hlsRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/get.php') && url.searchParams.get('output') === 'm3u8';
    });
    await page.locator('#save-settings').click();
    await hlsRequest;

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toContainText('HLS Channel');
    await expect.poll(() => page.evaluate(() => {
      const playlists = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
      return playlists[0]?.xtream?.liveOutput;
    })).toBe('m3u8');
  });
});

test.describe('Settings upload', () => {
  test('Settings shows an uploaded playlist when the upload service pushes a uploadEvents notification', async ({ page }) => {
    // End-to-end coverage for the push-driven upload refresh flow:
    //   service POST /uploads succeeds → service broadcasts Luna `uploadEvents`
    //   → app's subscription onSuccess fires → settings.refreshUploads() →
    //   UploadClient.reconcile() → fetch /uploads → storage write → morph().
    //
    // Playwright can't drive a real Luna bus, so we fake `window.webOS.service`
    // in an init script (captures the uploadEvents onSuccess so the test can
    // synthesize a push) and route the in-app HTTP fetches to a small
    // mutable fixture. Everything else — Settings render, UploadClient,
    // StorageService, morph, focus — runs as real production code.

    // Mutable fixture for /uploads responses. The route handler reads this
    // closure on every fetch, so test mutations are picked up by subsequent
    // reconcile calls.
    type UploadItem = { id: string; name: string; count: number; createdAt: number; url: string };
    let uploads: UploadItem[] = [];

    await page.route('http://127.0.0.1:9999/uploads', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(uploads),
      }),
    );
    await page.route('http://127.0.0.1:9999/info', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ip: '192.168.1.2', port: 9999, uploadUrl: 'http://192.168.1.2:9999/upload',
        }),
      }),
    );

    // Fake Luna shim — installed before the app bundle runs.
    await page.addInitScript(() => {
      type Cb = (resp: unknown) => void;
      type LunaOpts = { method?: string; subscribe?: boolean; onSuccess?: Cb; onFailure?: Cb };
      const win = window as unknown as {
        webOS?: unknown;
        __eventCallbacks__?: Cb[];
        __triggerUploadPush__?: (data?: unknown) => void;
      };
      win.__eventCallbacks__ = [];
      win.__triggerUploadPush__ = (data?: unknown) => {
        for (const cb of win.__eventCallbacks__!) cb(data ?? { event: 'uploads-changed' });
      };
      win.webOS = {
        service: {
          request: (_uri: string, opts: LunaOpts) => {
            if (opts.method === 'start') {
              // The real service returns the bound port; the in-app client
              // (UploadClient) uses this for all subsequent fetches.
              setTimeout(() => opts.onSuccess?.({ running: true, port: 9999 }), 0);
            } else if (opts.method === 'uploadEvents') {
              // Initial subscription ack (matches the real service's first
              // respond({subscribed:true}) inside the uploadEvents handler).
              setTimeout(() => opts.onSuccess?.({ subscribed: true }), 0);
              // Register the callback for test-driven pushes.
              if (opts.onSuccess) win.__eventCallbacks__!.push(opts.onSuccess);
            } else {
              // Unknown method — surface as a failure so future Luna additions
              // that we forget to mock here will fail the test loudly.
              setTimeout(() => opts.onFailure?.({ errorText: 'unmocked method: ' + opts.method }), 0);
            }
            return { cancel(): void { /* no-op */ } };
          },
        },
      };
    });

    await seedPlaylist(page);
    await page.goto('/');

    // Boots into channels from the seeded URL playlist.
    await expect(page.locator('#view-channels')).toBeVisible();

    // Open settings via the tab bar; the upload list starts empty.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect(page.locator('#upload-entries .empty-hint')).toHaveText('No uploaded playlists');

    // Simulate a phone POSTing a playlist to the service: mutate the routed
    // response, then fire the push the service would send on POST success.
    uploads = [{
      id: 'channel-one', name: 'Channel One', count: 2, createdAt: Date.now(),
      url: 'http://127.0.0.1:9999/uploads/channel-one.m3u',
    }];
    await page.evaluate(() => (window as unknown as { __triggerUploadPush__: () => void }).__triggerUploadPush__());

    // Settings re-morphs #upload-entries from the new /uploads response. No
    // navigation, no manual refresh. Label appends the channel count from the
    // UploadMeta (see uploadLabel() in settings.ts).
    const row = page.locator('#upload-entries .settings-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('label')).toHaveText('Channel One — 2 channels');
    await expect(page.locator('#upload-entries .empty-hint')).toHaveCount(0);

    // Storage was updated too: source: 'upload' entry is persisted.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Channel One', source: 'upload' }),
      ]),
    );

    // A second push that drops the upload also flows through (covers the
    // "delete on the upload page" case → service DELETE /uploads/:id fires
    // onChange too).
    uploads = [];
    await page.evaluate(() => (window as unknown as { __triggerUploadPush__: () => void }).__triggerUploadPush__());
    await expect(page.locator('#upload-entries .settings-row')).toHaveCount(0);
    await expect(page.locator('#upload-entries .empty-hint')).toBeVisible();
  });
});
