import {
  liveLoaded,
  test,
  expect,
  enterTab,
  isChromium53,
  type Page,
  routeLiveManifest,
  routePlaylist,
  seedPlaylist,
  expectSelectionVisibleInEveryTheme,
  pinClock,
  NOW,
  xmltvTime,
  startClock,
} from './helpers';

// EPG guide: the LIVE badge and the day/time-zone handling, on a pinned clock.

// The guide shows before its cache write lands, so this waits for the entry.
async function ageCachedGuide(page: Page, url: string, timestamp: number): Promise<void> {
  await expect.poll(() => page.evaluate(({ url, timestamp }) => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('iptv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('epg-cache', 'readwrite');
      const store = tx.objectStore('epg-cache');
      const read = store.get(url);
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        if (read.result) store.put({ ...read.result, timestamp });
      };
      tx.oncomplete = () => {
        db.close();
        resolve(!!read.result);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    };
  }), { url, timestamp }), { message: 'EPG cache entry was not stored' }).toBe(true);
}

// The next launch's cached-guide read waits for `releaseGuideRead(page)`.
async function holdGuideRead(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { releaseGuide: () => void };
    const released = new Promise<void>((resolve) => { w.releaseGuide = resolve; });
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, query);
      if (this.name !== 'epg-cache') return request;
      Object.defineProperty(request, 'onsuccess', {
        set(listener: (event: Event) => void) {
          IDBRequest.prototype.addEventListener.call(request, 'success', (event: Event) => {
            void released.then(() => listener.call(request, event));
          });
        },
      });
      return request;
    };
  });
}

async function releaseGuideRead(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { releaseGuide: () => void }).releaseGuide());
}

test('stale cached EPG stays visible while a refresh is in flight', async ({ page }) => {
  const now = new Date('2024-03-09T12:00:00Z');
  const epgUrl = 'http://epg.example.com/guide.xml';
  const epg = (title: string) => `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="20240309110000 +0000" stop="20240309130000 +0000"><title>${title}</title></programme>
</tv>`;
  let epgRequests = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });

  await routePlaylist(page);
  await seedPlaylist(page);
  await pinClock(page, now);
  await page.route('**/guide.xml', async (route) => {
    epgRequests++;
    if (epgRequests > 1) await refreshGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: epg(epgRequests === 1 ? 'Cached Show' : 'Fresh Show'),
    });
  });

  try {
    await page.goto('/');
    const nowPlaying = page.locator('.channel-main .channel-item').first().locator('.channel-now');
    await expect(nowPlaying).toHaveText('Cached Show');

    await ageCachedGuide(page, epgUrl, now.getTime() - 24 * 60 * 60 * 1000);

    await page.reload();
    await expect.poll(() => epgRequests).toBe(2);
    await expect(nowPlaying).toHaveText('Cached Show');

    releaseRefresh();
    await expect(nowPlaying).toHaveText('Fresh Show');
  } finally {
    releaseRefresh();
  }
});

test('the channel list opens before the cached guide is read', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await pinClock(page);
  await page.route('**/guide.xml', route => route.fulfill({
    status: 200,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Cached Show</title></programme>
</tv>`,
  }));
  await page.goto('/');
  const firstRow = page.locator('.channel-main .channel-item').first();
  await expect(firstRow.locator('.channel-now')).toHaveText('Cached Show');

  // The next launch's guide read never completes.
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      if (this.name === 'epg-cache') return {} as IDBRequest;
      return get.call(this, query);
    };
  });
  await page.reload();
  await liveLoaded(page);
  await expect(firstRow).toBeVisible();
});

test('the auto-played channel shows its programme once the cached guide is read', async ({ page }) => {
  await routePlaylist(page);
  await routeLiveManifest(page);
  await seedPlaylist(page);
  await pinClock(page);
  await page.route('**/guide.xml', route => route.fulfill({
    status: 200,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Cached Show</title></programme>
</tv>`,
  }));
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item').first().locator('.channel-now'))
    .toHaveText('Cached Show');
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel One');
  await page.evaluate(() => localStorage.setItem('iptv_auto_play', 'true'));

  await holdGuideRead(page);
  await page.reload();
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel One');
  await expect(page.locator('.osd-programme-title')).toHaveCount(0);

  await releaseGuideRead(page);
  await expect(page.locator('.osd-programme-title')).toHaveText('Cached Show');
});

test('a Guide opened while the cached guide is read shows it once read', async ({ page }) => {
  const now = new Date('2024-03-09T12:00:00Z');
  let guideRequests = 0;
  await routePlaylist(page);
  await seedPlaylist(page);
  await pinClock(page, now);
  await page.route('**/guide.xml', async (route) => {
    // Only the first launch downloads; the refresh of the aged copy hangs.
    if (++guideRequests > 1) return;
    await route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<programme channel="one" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Cached Show</title></programme>
</tv>`,
    });
  });
  await page.goto('/');
  await expect(page.locator('.channel-main .channel-item').first().locator('.channel-now'))
    .toHaveText('Cached Show');
  await ageCachedGuide(page, 'http://epg.example.com/guide.xml', now.getTime() - 24 * 60 * 60 * 1000);

  await holdGuideRead(page);
  await page.reload();
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  await releaseGuideRead(page);
  await expect(page.locator('#epg-programmes .epg-programme-item', { hasText: 'Cached Show' }))
    .toBeVisible();
});

test.describe('EPG live badge', () => {
  // Fixed "now" placed inside the middle program so exactly one row is airing.
  // UTC device + +0000 EPG keeps wall-clock == absolute time, so the live/past/
  // future split is unambiguous regardless of timezone mode.

  const M3U = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1" group-title="News",Channel 1',
    'http://streams.example.com/ch1.m3u8',
  ].join('\n');

  // Three programs on 03/09: one already ended, one airing at NOW (12:00Z), one
  // yet to start. Only the middle one is "live" and must show the pulsing badge.
  const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="20240309100000 +0000" stop="20240309110000 +0000"><title>Earlier Show</title></programme>
<programme channel="ch1" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
<programme channel="ch1" start="20240309130000 +0000" stop="20240309140000 +0000"><title>Later Show</title></programme>
</tv>`;

  async function setup(page: Page): Promise<void> {
    await routePlaylist(page, M3U);
    await page.route('**/epg.xml', r => r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
    await pinClock(page);
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    });
  }

  test('the EPG marks the currently-airing program with a pulsing LIVE badge', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await liveLoaded(page);

    // Open the guide (Red / Programme Guide remote key).
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.locator('#epg-programmes .epg-programme-item').first().waitFor();

    // Exactly one program is live — the 11:00–13:00 show — and it carries the badge.
    const live = page.locator('#epg-programmes .epg-programme-item.state-live');
    await expect(live).toHaveCount(1);
    await expect(live).toContainText('Live Show');

    const badge = live.locator('.live-badge');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveText(/LIVE/);

    // The dot doesn't just exist — it carries the looping pulse animation...
    const dot = badge.locator('.live-badge-dot');
    await expect(dot).toHaveCount(1);
    await expect(dot).toHaveCSS('animation-name', 'liveBadgeDotPulse');
    await expect(dot).toHaveCSS('animation-iteration-count', 'infinite');

    // ...and it's a real animation, not a no-op: a computed style (or empty/paused
    // keyframes) can't tell "looping" from "frozen". The test's fixed clock freezes
    // the timeline so we can't sample motion, but the Web Animations API proves it
    // is RUNNING and its keyframes genuinely VARY the opacity — i.e. it really pulses.
    // (getAnimations() landed in Chrome 84, so this check is modern-engine only —
    // the CSS assertions above still run on the legacy engine.)
    if (!isChromium53()) {
      const anim = await dot.evaluate((el) => {
        const a = el.getAnimations()[0];
        const opacities = (a.effect as KeyframeEffect).getKeyframes().map((k) => k.opacity);
        return { playState: a.playState, distinctOpacities: new Set(opacities).size };
      });
      expect(anim.playState).toBe('running');     // active, not paused/idle/finished
      expect(anim.distinctOpacities).toBeGreaterThan(1); // opacity changes across the cycle → it pulses
    }

    // Only the airing row gets a badge; the ended row is "past" and unbadged.
    await expect(page.locator('#epg-programmes .live-badge')).toHaveCount(1);
    const earlier = page.locator('#epg-programmes .epg-programme-item', { hasText: 'Earlier Show' });
    await expect(earlier).toHaveClass(/state-past/);
    await expect(earlier.locator('.live-badge')).toHaveCount(0);
  });

  // The search box's focus styling is reached two ways: a `.focused` class the
  // D-pad path adds, and `:focus-within` for pointer focus. Chromium 53 does
  // not know `:focus-within`, and an engine drops a whole rule whose selector
  // list contains one it cannot parse — so sharing a rule would silently kill
  // the `.focused` styling too. The class is applied directly here because the
  // contract under test is the CSS, not the navigation that sets it.
  test('the EPG search box keeps its focus styling without :focus-within', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await liveLoaded(page);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();

    const wrap = page.locator('.epg-search-wrap');
    await expect(wrap).toHaveCount(1);
    const styles = await wrap.evaluate((element) => {
      const read = (): { outline: string; border: string } => {
        const computed = getComputedStyle(element);
        return { outline: computed.outlineStyle, border: computed.borderTopColor };
      };
      const idle = read();
      element.classList.add('focused');
      const focused = read();
      // A probe, not a real ring: leave one ring on screen for the audit.
      element.classList.remove('focused');
      return { idle, focused };
    });

    expect(styles.focused.outline).not.toBe('none');
    expect(styles.focused.border).not.toBe(styles.idle.border);
  });

  test('the LIVE badge keeps pulsing when the OS prefers reduced motion', async ({ page }) => {
    // webOS never reports the OS preference; only the animation mode gates motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page);
    await page.goto('/');
    await liveLoaded(page);

    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.locator('#epg-programmes .epg-programme-item.state-live').first().waitFor();

    const dot = page.locator('#epg-programmes .epg-programme-item.state-live .live-badge-dot');
    await expect(dot).toHaveCount(1);
    await expect(dot).toHaveCSS('animation-name', 'liveBadgeDotPulse');
  });
});

test.describe('EPG time zone', () => {
  // Synthetic scenario: device at UTC, feed at +0100, "now" just before UTC
  // midnight — so the feed's wall clock has already rolled to the next civil day.
  // (Arbitrary fixed date; values chosen only to exercise the day-boundary math.)
  const NOW = new Date('2024-03-09T23:30:00Z'); // device-local Sat 03/09, feed Sun 03/10

  const M3U = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1" group-title="News",Channel 1',
    'http://streams.example.com/ch1.m3u8',
  ].join('\n');

  // "Late night" starts on 03/09 and spills past feed midnight; the 03/10 schedule
  // must not start with it. "Evening" ends exactly at feed midnight — which must
  // NOT spawn an empty 03/11 column.
  const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="20240309234100 +0100" stop="20240310003000 +0100"><title>Late night</title></programme>
<programme channel="ch1" start="20240310003000 +0100" stop="20240310120000 +0100"><title>Morning</title></programme>
<programme channel="ch1" start="20240310120000 +0100" stop="20240311000000 +0100"><title>Evening</title></programme>
</tv>`;

  async function setup(page: Page, tzMode: 'device' | 'feed'): Promise<void> {
    await routePlaylist(page, M3U);
    await page.route('**/epg.xml', r => r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
    await pinClock(page, NOW);
    await page.addInitScript((mode) => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
      localStorage.setItem('iptv_tz_mode', JSON.stringify(mode));
    }, tzMode);
  }

  async function openEpg(page: Page): Promise<void> {
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.locator('#epg-dates .epg-date-item').first().waitFor();
  }

  const selectedDay = (page: Page) => page.locator('#epg-dates .epg-date-item.selected');
  const todayDay = (page: Page) => page.locator('#epg-dates .epg-date-item.today');

  test('feed mode: today is the feed day, selected, and its schedule starts after midnight', async ({ page }) => {
    await setup(page, 'feed');
    await page.goto('/');
    await liveLoaded(page);
    await openEpg(page);

    // Today in the feed zone is Sun 03/10 — highlighted and selected.
    await expect(todayDay(page)).toHaveText(/Sun\s+03\/10/);
    await expect(selectedDay(page)).toHaveText(/Sun\s+03\/10/);
    // The 23:41 program belongs to 03/09, so 03/10 starts at 00:30 — not 23:41.
    await expect(page.locator('#epg-programmes .epg-prog-time').first()).toHaveText('00:30');
    // A program ending exactly at midnight must not create an empty 03/11 column.
    await expect(page.locator('#epg-dates .epg-date-item')).toHaveCount(2);
  });

  test('keeps the selected day distinct from the other days in every theme', async ({ page }) => {
    await setup(page, 'feed');
    await page.goto('/');
    await liveLoaded(page);
    await openEpg(page);
    await expect(page.locator('#epg-dates .epg-date-item')).toHaveCount(2);
    await expectSelectionVisibleInEveryTheme(page,
      selectedDay(page), page.locator('#epg-dates .epg-date-item:not(.selected)'));
  });

  test('switching device → feed re-snaps the selected day to today', async ({ page }) => {
    await setup(page, 'device');
    await page.goto('/');
    await liveLoaded(page);

    await openEpg(page);
    await expect(selectedDay(page)).toHaveText(/Sat\s+03\/09/); // device-local today

    // Back to channels, open settings, switch to Feed, save.
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
    await liveLoaded(page);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#tz-mode [data-value="feed"]').click();
    await page.locator('#save-settings').click();
    await liveLoaded(page);

    await openEpg(page);
    // Selection must follow "today" into the new timezone, not stick on 03/09.
    await expect(selectedDay(page)).toHaveText(/Sun\s+03\/10/);
  });
});

test('Down from the tab bar resumes the Guide on the day and channel Up left', async ({ page }) => {
  const day = (d: number, h: number) => `202403${String(d).padStart(2, '0')}${String(h).padStart(2, '0')}0000 +0000`;
  const programmes = ['ch1', 'ch2'].flatMap((ch) => [9, 10, 11].flatMap((d) => [
    `<programme channel="${ch}" start="${day(d, 0)}" stop="${day(d, 12)}"><title>Alpha</title></programme>`,
    `<programme channel="${ch}" start="${day(d, 12)}" stop="${day(d + 1, 0)}"><title>Bravo</title></programme>`,
  ]));
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1",Channel 1',
    'http://streams.example.com/ch1.m3u8',
    '#EXTINF:-1 tvg-id="ch2",Channel 2',
    'http://streams.example.com/ch2.m3u8',
  ].join('\n'));
  await page.route('**/epg.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/><channel id="ch2"/>${programmes.join('')}</tv>` }));
  await pinClock(page, new Date('2024-03-10T06:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const channel = page.locator('#view-epg .epg-channel-item.selected');
  await expect(channel).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(channel).toHaveAttribute('data-channel-idx', '1');
  await expect(page.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  const date = page.locator('#epg-dates .epg-date-item.focused');
  await expect(date).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(date).toHaveClass(/\bselected\b/);
  await expect(date).not.toHaveClass(/\btoday\b/);
  const label = await date.textContent();

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item[data-section="epg"].focused')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(date).toHaveText(label ?? '');
  await expect(channel).toHaveAttribute('data-channel-idx', '1');
});

test('Right on a channel with no programmes keeps the ring on the channel', async ({ page }) => {
  const day = (d: number, h: number) => `202403${String(d).padStart(2, '0')}${String(h).padStart(2, '0')}0000 +0000`;
  const programmes = [9, 10, 11].flatMap((d) => [
    `<programme channel="ch1" start="${day(d, 0)}" stop="${day(d, 12)}"><title>Alpha</title></programme>`,
    `<programme channel="ch1" start="${day(d, 12)}" stop="${day(d + 1, 0)}"><title>Bravo</title></programme>`,
  ]);
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1",Channel 1',
    'http://streams.example.com/ch1.m3u8',
    '#EXTINF:-1 tvg-id="ch2",Channel 2',
    'http://streams.example.com/ch2.m3u8',
  ].join('\n'));
  await page.route('**/epg.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/>${programmes.join('')}</tv>` }));
  await pinClock(page, new Date('2024-03-10T06:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
  });
  await page.goto('/');
  await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const channel = page.locator('#view-epg .epg-channel-item.selected');
  await expect(channel).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('ArrowDown');
  await expect(channel).toHaveAttribute('data-channel-idx', '1');
  await expect(page.locator('#epg-programmes .epg-no-data')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(channel).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-epg .focused')).toHaveCount(1);

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-epg .epg-channel-item[data-channel-idx="0"]')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#view-epg .focused')).toHaveCount(1);
});

test.describe('Guide pointer and keys', () => {
  // A day of half-hour programmes on two channels, so the programme column
  // runs past the bottom of the screen.
  async function openGuide(page: Page, describe?: (i: number) => string): Promise<void> {
    const at = (slot: number) => xmltvTime(Date.UTC(2024, 2, 9) + slot * 30 * 60 * 1000);
    const programmes = ['ch1', 'ch2'].flatMap((ch) => Array.from({ length: 48 }, (_, i) =>
      `<programme channel="${ch}" start="${at(i)}" stop="${at(i + 1)}"><title>Show ${i}</title>${
        describe ? `<desc>${describe(i)}</desc>` : ''}</programme>`));
    await routePlaylist(page, [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ch1",Channel 1',
      'http://host/ch1.m3u8',
      '#EXTINF:-1 tvg-id="ch2",Channel 2',
      'http://host/ch2.m3u8',
    ].join('\n'));
    await page.route('**/epg.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/><channel id="ch2"/>${programmes.join('')}</tv>` }));
    await pinClock(page);
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    });
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#view-epg .epg-channel-item.selected')).toHaveClass(/\bfocused\b/);
  }

  // Programme rows are measured two frames after they render, which can shift
  // them; wait until the column holds rows and stops moving.
  async function programmesSettled(page: Page): Promise<void> {
    await expect.poll(() => page.locator('#epg-programmes .epg-programme-item').count()).toBeGreaterThan(0);
    let last = '';
    await expect.poll(async () => {
      const now = await page.evaluate(() => new Promise<string>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const list = document.querySelector('#epg-programmes')!;
          const rows = Array.from(list.querySelectorAll('.epg-programme-item'));
          done(`${String(list.scrollTop)}:${rows.map((el) => el.getBoundingClientRect().top).join(',')}`);
        }));
      }));
      const still = now === last;
      last = now;
      return still;
    }).toBe(true);
  }

  test('a long programme description clamps to two lines', async ({ page }) => {
    const description = 'word '.repeat(120).trim();
    await openGuide(page, () => description);
    await programmesSettled(page);

    const box = await page.locator('#epg-programmes .epg-prog-desc').first().evaluate((el) => ({
      text: el.textContent,
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    expect(box.text).toBe(description);
    expect(Math.abs(box.clientHeight - 2 * box.lineHeight)).toBeLessThanOrEqual(1);
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  });

  test('hovering a programme moves the ring off the channel, which stays selected', async ({ page }) => {
    await openGuide(page);
    const channel = page.locator('#view-epg .epg-channel-item.selected');
    const programme = page.locator('#epg-programmes .epg-programme-item').nth(1);
    const box = (await programme.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });

    await expect(programme).toHaveClass(/\bfocused\b/);
    await expect(channel).toHaveClass(/\bselected\b/);
    await expect(channel).not.toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg .focused')).toHaveCount(1);
  });

  test('the Red hint goes back to now by pointer and never takes a ring', async ({ page }) => {
    await openGuide(page);
    await programmesSettled(page);
    await page.keyboard.press('ArrowRight');
    const first = page.locator('#epg-programmes .epg-programme-item[data-prog-idx="0"]');
    await expect(first).toHaveClass(/\bfocused\b/);
    const hint = page.locator('#view-epg .epg-hints [data-epg-now]');
    const idle = await hint.evaluate((el) => getComputedStyle(el).backgroundColor);
    await hint.hover();

    await expect.poll(() => hint.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(idle);
    await expect(first).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg .focused')).toHaveCount(1);

    await hint.click();
    expect(await hint.evaluate((el) => el === document.activeElement)).toBe(false);
    expect(await hint.evaluate((el) => {
      (el as HTMLElement).focus();
      const width = getComputedStyle(el).outlineWidth;
      (el as HTMLElement).blur();
      return width;
    })).toBe('0px');
    const airing = page.locator('#epg-programmes .epg-programme-item[data-prog-idx="24"]');
    await expect(airing).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg')).toBeVisible();
    await expect(page.locator('#view-player')).toBeHidden();
    await expect(page.locator('#view-epg .focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#epg-programmes .epg-programme-item[data-prog-idx="25"]')).toHaveClass(/\bfocused\b/);
  });

  test('the Red hint drops its hover ring once the D-pad takes over', async ({ page }) => {
    await openGuide(page);
    await programmesSettled(page);
    await page.keyboard.press('ArrowRight');
    const hint = page.locator('#view-epg .epg-hints [data-epg-now]');
    const ring = () => hint.evaluate((el) => {
      const style = getComputedStyle(el);
      return `${style.borderTopColor}|${style.boxShadow}`;
    });
    const idle = await ring();
    // The first move only seeds the pointer; the next ones hand it over.
    const box = (await hint.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y - 40);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect.poll(ring).not.toBe(idle);

    await page.keyboard.press('ArrowDown');
    await expect.poll(ring).toBe(idle);
    await expect(page.locator('#view-epg .focused')).toHaveCount(1);
  });

  test('a click that drops the search caret shows what OK does on the hovered programme', async ({ page }) => {
    await openGuide(page);
    await programmesSettled(page);
    const okHint = page.locator('#view-epg .epg-hints .key-ok');
    await page.locator('#view-epg .epg-search-input').click();
    const aired = page.locator('#epg-programmes .epg-programme-item').nth(1);
    await aired.hover();
    await expect(okHint).toHaveCount(0);

    const hints = (await page.locator('#view-epg .epg-hints').boundingBox())!;
    await page.mouse.click(hints.x + hints.width - 20, hints.y + hints.height / 2);
    await expect(page.locator('#view-epg .epg-search-input')).not.toBeFocused();
    await expect(aired).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg .epg-hints')).toContainText('Watch live');
  });

  test('a key that leaves a clipped programme focused brings it into view', async ({ page }) => {
    await openGuide(page);
    await programmesSettled(page);
    const list = page.locator('#epg-programmes');
    const listBox = (await list.boundingBox())!;
    const items = page.locator('#epg-programmes .epg-programme-item');
    let progIdx = '';
    await expect.poll(async () => {
      progIdx = await items.evaluateAll((items, bottom) => items.find((el) => {
        const r = el.getBoundingClientRect();
        return r.top < bottom - 8 && r.bottom > bottom;
      })?.getAttribute('data-prog-idx') ?? '', listBox.y + listBox.height);
      return progIdx;
    }).not.toBe('');
    const programme = page.locator(`#epg-programmes .epg-programme-item[data-prog-idx="${progIdx}"]`);
    const box = (await programme.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 2 });
    await expect(programme).toHaveClass(/\bfocused\b/);

    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => {
      const r = (await programme.boundingBox())!;
      return r.y + r.height <= listBox.y + listBox.height + 1;
    }).toBe(true);
    await expect(programme).toHaveClass(/\bfocused\b/);
  });

  for (const [name, press] of [
    ['Down', (page: Page) => page.keyboard.press('ArrowDown')],
    ['OK', (page: Page) => page.keyboard.press('Enter')],
    ['Back', (page: Page) => page.evaluate(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })))],
  ] as const) {
    test(`${name} from the tab bar resumes a clipped programme, brought into view`, async ({ page }) => {
      await openGuide(page);
      await expect(page.locator('#epg-programmes .epg-programme-item').first()).toBeVisible();
      await page.keyboard.press('ArrowRight');
      const programme = page.locator('#epg-programmes .epg-programme-item.focused');
      await expect(programme).toHaveCount(1);
      const progIdx = await programme.getAttribute('data-prog-idx');
      await programmesSettled(page);

      // Scroll the focused programme half above the top of the column.
      // The column may hold its offset for a frame after a key, so retry.
      const list = page.locator('#epg-programmes');
      const listBox = (await list.boundingBox())!;
      await expect.poll(async () => {
        await list.evaluate((el) => {
          const row = el.querySelector<HTMLElement>('.epg-programme-item.focused')!.getBoundingClientRect();
          el.scrollTop += row.top - el.getBoundingClientRect().top + row.height / 2;
        });
        const r = (await programme.boundingBox())!;
        return r.y < listBox.y - 1;
      }).toBe(true);

      // The search box closed with Back leaves the keys on the bar over the Guide.
      await page.locator('.tab-bar-item[data-section="search"]').click();
      await expect(page.locator('.tab-bar-search-input')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.tab-bar-item[data-section="epg"].focused')).toHaveCount(1);
      await expect(page.locator('#view-epg')).toBeVisible();

      await press(page);
      const focused = page.locator(`#epg-programmes .epg-programme-item[data-prog-idx="${String(progIdx)}"]`);
      await expect(focused).toHaveClass(/\bfocused\b/);
      await expect(page.locator('.tab-bar-item.focused')).toHaveCount(0);
      await expect.poll(async () => {
        const r = (await focused.boundingBox())!;
        return r.y >= listBox.y - 1 && r.y + r.height <= listBox.y + listBox.height + 1;
      }).toBe(true);
    });
  }

  test('Down on the last programme brings it into view when clipped', async ({ page }) => {
    await openGuide(page);
    const list = page.locator('#epg-programmes');
    const last = page.locator('#epg-programmes .epg-programme-item', { hasText: 'Show 47' });
    await expect.poll(async () => {
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      return last.isVisible();
    }).toBe(true);
    const box = (await last.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 2 });
    await expect(last).toHaveClass(/\bfocused\b/);
    await list.evaluate((el, h) => { el.scrollTop -= h / 2; }, box.height);
    const listBox = (await list.boundingBox())!;
    expect((await last.boundingBox())!.y + box.height).toBeGreaterThan(listBox.y + listBox.height + 1);

    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => {
      const r = (await last.boundingBox())!;
      return r.y + r.height <= listBox.y + listBox.height + 1;
    }).toBe(true);
    await expect(last).toHaveClass(/\bfocused\b/);
  });

  test('a page jump keeps the programme in view once its neighbors are measured', async ({ page }) => {
    // Odd rows run to two lines, even rows to one, so no row matches its estimate.
    await openGuide(page, (i) => (i % 2 ? 'Words of a longer synopsis. '.repeat(12) : 'Short.'));
    const list = page.locator('#epg-programmes');
    const last = page.locator('#epg-programmes .epg-programme-item', { hasText: 'Show 47' });
    await expect.poll(async () => {
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      return last.isVisible();
    }).toBe(true);
    const lastBox = (await last.boundingBox())!;
    await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 2 });
    await expect(last).toHaveClass(/\bfocused\b/);
    const focused = page.locator('#epg-programmes .epg-programme-item.focused');
    for (let jump = 0; jump < 3; jump++) {
      await page.keyboard.press('PageUp');
      await expect(focused).toHaveCount(1);
      await programmesSettled(page);
      await expect.poll(async () => {
        const [listBox, box] = await Promise.all([list.boundingBox(), focused.boundingBox()]);
        return !!listBox && !!box && box.y >= listBox.y - 1 && box.y + box.height <= listBox.y + listBox.height + 1;
      }).toBe(true);
    }
  });

  test('the group filter lights under the pointer', async ({ page }) => {
    await openGuide(page);
    const filter = page.locator('#view-epg .epg-filter-control').first();
    const idle = await filter.evaluate((el) => getComputedStyle(el).backgroundColor);
    await filter.hover();
    await expect.poll(() => filter.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(idle);
  });

  test('opening the Guide again lands on the channel with the group menu shut', async ({ page }) => {
    await openGuide(page);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#view-epg .epg-group-option.focused')).toHaveCount(1);

    await page.locator('.tab-bar-item[data-section="live"]').click();
    await liveLoaded(page);
    await page.locator('.tab-bar-item[data-section="epg"]').click();
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.keyboard.press('ArrowDown');

    await expect(page.locator('#view-epg .epg-group-menu')).toHaveCount(0);
    await expect(page.locator('#view-epg .epg-channel-item.selected')).toHaveClass(/\bfocused\b/);
    await expect(page.locator('#view-epg .focused')).toHaveCount(1);
  });

  for (const via of ['pointer', 'Red key'] as const) test(`opening the Guide by ${via} shows the far channel that was playing`, async ({ page }) => {
    const lines = ['#EXTM3U'];
    for (let i = 1; i <= 200; i++) {
      lines.push(`#EXTINF:-1 tvg-id="ch${String(i)}",Channel ${String(i)}`, `http://host/ch${String(i)}.m3u8`);
    }
    await routePlaylist(page, lines.join('\n'));
    await routeLiveManifest(page);
    // The guide data lands only after the Guide has opened.
    let releaseEpg!: () => void;
    const epgGate = new Promise<void>((resolve) => { releaseEpg = resolve; });
    await page.route('**/epg.xml', async (r) => {
      await epgGate;
      await r.fulfill({ status: 200, contentType: 'application/xml',
        body: '<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch150"/>'
          + '<programme channel="ch150" start="20240309110000 +0000" stop="20240309130000 +0000">'
          + '<title>Show</title></programme></tv>' });
    });
    await pinClock(page);
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    });
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);
    await page.keyboard.press('1');
    await page.keyboard.press('5');
    await page.keyboard.press('0');
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 150');
    await page.keyboard.press('Escape');
    await liveLoaded(page);

    if (via === 'pointer') {
      await enterTab(page, 'epg');
    } else {
      await page.evaluate(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    }
    const list = page.locator('#view-epg .epg-channel-list');
    const row = page.locator('#epg-channels [data-channel-idx="149"]');
    const inView = async () => {
      const r = await row.boundingBox();
      const l = await list.boundingBox();
      return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
    };
    await expect(row).toHaveClass(/\bselected\b/);
    await expect(row).toHaveClass(/\bfocused\b/);
    await expect.poll(inView).toBe(true);

    releaseEpg();
    await expect(page.locator('#epg-programmes .epg-programme-item')).toHaveCount(1);
    await expect.poll(inView).toBe(true);
  });
});

async function openTimelineGuide(page: Page): Promise<void> {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
  await pinClock(page, new Date('2024-03-09T12:10:00Z'));
  await page.route('**/guide.xml', route => route.fulfill({
    status: 200,
    contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="one"><display-name>Channel One</display-name></channel>
<channel id="two"><display-name>Channel Two</display-name></channel>
<programme channel="one" start="20240309110000 +0000" stop="20240309123000 +0000"><title>Show One</title></programme>
<programme channel="one" start="20240309123000 +0000" stop="20240309133000 +0000"><title>Show Two</title></programme>
<programme channel="one" start="20240309133000 +0000" stop="20240309150000 +0000"><title>Show Three</title></programme>
<programme channel="one" start="20240309150000 +0000" stop="20240309160000 +0000"><title>Show Five</title></programme>
<programme channel="two" start="20240309090000 +0000" stop="20240309120000 +0000"><title>Show Early</title></programme>
<programme channel="two" start="20240309120000 +0000" stop="20240309140000 +0000"><title>Show Four</title></programme>
</tv>`,
  }));
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('.epg-tl-surface')).toBeVisible();
}

test('the timeline guide follows the remote, the pointer, and the wheel', async ({ page }) => {
  await openTimelineGuide(page);
  await expect(page.locator('.epg-tl-count')).toHaveText(/\b2 channels\b/);
  const surface = page.locator('.epg-tl-surface');
  const detail = page.locator('.epg-tl-detail');
  await expect(detail).toContainText('Show One');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.epg-tl-focus')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowRight');
  await expect(detail).toContainText('Show Two');
  await page.keyboard.press('ArrowDown');
  await expect(detail).toContainText('Show Four');
  await expect(page.locator('.focused')).toHaveCount(1);

  // The 12:00-15:00 page spans the timeline's 1440px from x=480; row one sits under a 52px ruler.
  const box = (await surface.boundingBox())!;
  const xAt = (minutes: number) => box.x + 480 + (minutes / 180) * 1440;
  await page.mouse.move(xAt(120), box.y + 52 + 40);
  await expect(detail).toContainText('Show Three');
  await expect(page.locator('.focused')).toHaveCount(1);

  await page.mouse.wheel(0, 120);
  await expect(detail).toContainText('Show Four');

  // A press of the wheel would act on the ring; a real move takes the pointer's row back.
  await page.mouse.move(xAt(130), box.y + 52 + 40);
  await expect(detail).toContainText('Show Three');
  await page.mouse.click(xAt(130), box.y + 52 + 40);
  await expect(page.locator('.toast')).toContainText('Reminder set');
});

test('the timeline guide searches channels and goes down to the first match', async ({ page }) => {
  await openTimelineGuide(page);
  const detail = page.locator('.epg-tl-detail');
  await expect(detail).toContainText('Show One');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const input = page.locator('.epg-tl-toolbar .epg-search-input');
  await expect(page.locator('.epg-tl-toolbar .epg-search-wrap')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await page.keyboard.type('Two');
  await expect(input).toHaveAttribute('data-search-pending', 'false');
  await expect(page.locator('.focused')).toHaveCount(1);

  await page.keyboard.press('ArrowDown');
  await expect(input).not.toBeFocused();
  await expect(detail).toContainText('Show Four');
  await expect(page.locator('.tl-name.is-focused:visible')).toHaveText('Channel Two');
  await expect(page.locator('.epg-tl-focus')).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

// The pill sits at the cells' edge toward now, every ruler time under it is
// hidden, and every other one shows.
async function expectNowPillAtEdge(page: Page, side: 'earlier' | 'later'): Promise<void> {
  const pill = page.locator(`.epg-now-pill.is-${side}`);
  await expect(pill).toBeVisible();
  const box = (await pill.boundingBox())!;
  const surface = (await page.locator('.epg-tl-surface').boundingBox())!;
  if (side === 'earlier') expect(Math.abs(box.x - (surface.x + 484))).toBeLessThanOrEqual(1);
  else expect(Math.abs(box.x + box.width - (surface.x + 1920 - 4))).toBeLessThanOrEqual(1);
  expect(await pill.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await pill.hover();
  await expect.poll(() => pill.evaluate(el => getComputedStyle(el).transform)).toContain('1.03');
  const hovered = (await pill.boundingBox())!;
  expect(Math.abs(hovered.y + hovered.height / 2 - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    let hidden = 0;
    for (const label of await page.locator('.tl-ruler-label').all()) {
      const r = (await label.boundingBox())!;
      const under = r.x < box.x + box.width && r.x + r.width > box.x;
      if (under === await label.isVisible()) return `"${await label.textContent()}" under=${String(under)}`;
      if (under) hidden++;
    }
    return hidden > 0 ? 'ok' : 'nothing hidden';
  }).toBe('ok');
}

test('the timeline guide puts Back to now on the ruler edge toward now, hiding only the times under it', async ({ page }) => {
  await openTimelineGuide(page);
  const detail = page.locator('.epg-tl-detail');
  const labels = page.locator('.tl-ruler-label');
  await page.keyboard.press('ArrowDown');
  for (const title of ['Show Two', 'Show Three', 'Show Five']) {
    await page.keyboard.press('ArrowRight');
    await expect(detail).toContainText(title);
  }
  await expectNowPillAtEdge(page, 'earlier');

  await page.locator('.epg-now-pill').click();
  await expect(detail).toContainText('Show One');
  await expect(page.locator('.epg-now-pill')).toHaveCount(0);
  for (const label of await labels.all()) await expect(label).toBeVisible();
  await expect(page.locator('.epg-tl-focus')).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);

  await page.keyboard.press('ArrowDown');
  await expect(detail).toContainText('Show Four');
  await page.keyboard.press('ArrowLeft');
  await expect(detail).toContainText('Show Early');
  await expectNowPillAtEdge(page, 'later');

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('.epg-now-pill')).toHaveCount(0);
  for (const label of await labels.all()) await expect(label).toBeVisible();
});

test('the timeline guide fits the whole Back to now in a long language at the largest text size', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_locale', JSON.stringify('ru'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await openTimelineGuide(page);
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expectNowPillAtEdge(page, 'earlier');
});

test('the timeline details split under the channel column and the cells', async ({ page }) => {
  await openTimelineGuide(page);
  const surface = (await page.locator('.epg-tl-surface').boundingBox())!;
  const viewport = page.viewportSize()!;
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const detail = await box('.epg-tl-detail');
  const when = await box('.epg-tl-detail .epg-tl-when');
  const column = await box('.tl-column');

  expect(Math.abs(detail.x - surface.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(detail.x + detail.width - viewport.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(when.width - 480)).toBeLessThanOrEqual(1);
  expect(Math.abs(column.y + column.height - viewport.height)).toBeLessThanOrEqual(1);
  await expect(page.locator('.epg-tl-detail .epg-tl-when')).toContainText('11:00 – 12:30');
  await expect(page.locator('.epg-tl-detail')).not.toContainText('Channel One');
  // The time starts where the channel names do, the programme where a cell's title does.
  const range = await box('.epg-tl-detail .epg-tl-range');
  const name = await box('.tl-name.is-focused:visible');
  expect(Math.abs(range.x - name.x)).toBeLessThanOrEqual(1);
  const title = await box('.epg-tl-detail .epg-tl-what .epg-tl-title');
  expect(Math.abs(title.x - (surface.x + 494))).toBeLessThanOrEqual(1);
  const hint = await box('.epg-tl-detail .epg-tl-hint');
  expect(Math.abs(hint.x + hint.width - (viewport.width - 14))).toBeLessThanOrEqual(1);
});

test('the open group menu shows over the timeline ruler corner', async ({ page }) => {
  await openTimelineGuide(page);
  const count = (await page.locator('.epg-tl-count').boundingBox())!;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.epg-group-button')).toHaveClass(/focused/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.epg-group-menu')).toBeVisible();

  // The count ignores the pointer; let hit-testing see it to compare paint order.
  await page.locator('.epg-tl-count').evaluate((el: HTMLElement) => { el.style.pointerEvents = 'auto'; });
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.epg-group-menu'),
    { x: count.x + count.width / 2, y: count.y + count.height / 2 })).toBe(true);
});

test('the timeline details align with the channel names a long number moves on', async ({ page }) => {
  const channels = Array.from({ length: 1000 }, (_, i) => `#EXTINF:-1,ch${String(i + 1)}\nhttp://host/${String(i)}.m3u8`);
  await routePlaylist(page, `#EXTM3U\n${channels.join('\n')}`);
  await seedPlaylist(page);
  await page.addInitScript(() => {
    localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline'));
    localStorage.setItem('iptv_text_size', JSON.stringify('150'));
  });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('.tl-name.is-focused:visible')).toHaveText('ch1');

  const starts = () => page.evaluate(() => {
    const when = document.querySelector<HTMLElement>('.epg-tl-when')!;
    const name = Array.from(document.querySelectorAll<HTMLElement>('.tl-name.is-focused'))
      .find(el => el.offsetParent && getComputedStyle(el.parentElement!).visibility !== 'hidden')!;
    return {
      when: when.getBoundingClientRect().left + parseFloat(getComputedStyle(when).paddingLeft),
      name: name.getBoundingClientRect().left,
    };
  });
  // Four digits at 150% outgrow the 44px number column.
  const open = await starts();
  expect(open.name).toBeGreaterThan(78 + 4);
  expect(open.when).toBe(open.name);

  // Three-digit results narrow the column again, the details with it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ch9');
  await expect(page.locator('.epg-tl-count')).toHaveText(/\b111 channels\b/);
  const found = await starts();
  expect(found.name).toBeLessThan(open.name);
  expect(found.when).toBe(found.name);
});

test('the timeline guide shows no details strip without a channel', async ({ page }) => {
  await openTimelineGuide(page);
  await expect(page.locator('.epg-tl-detail')).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.type('zzz');
  await expect(page.locator('.epg-tl-empty')).toBeVisible();
  await expect(page.locator('.epg-tl-detail')).toBeHidden();
});

// `count` URL playlists of one channel each, opening the Guide in `layout`.
async function openGuideWithPlaylists(page: Page, count: number, layout: 'timeline' | 'schedule', textSize = '100') {
  await page.route('**/p*.m3u', (route) => {
    const index = /p(\d+)\.m3u/.exec(route.request().url())?.[1] ?? '0';
    return route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: `#EXTM3U\n#EXTINF:-1,Channel ${index}\nhttp://streams.example.com/${index}.m3u8`,
    });
  });
  await page.addInitScript(({ count, layout, textSize }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify(Array.from({ length: count }, (_, i) =>
      ({ id: `p${String(i)}`, name: `A rather long playlist name ${String(i)}`, url: `http://host/p${String(i)}.m3u` }))));
    // A test may switch the layout and reload.
    if (!localStorage.getItem('iptv_guide_layout')) localStorage.setItem('iptv_guide_layout', JSON.stringify(layout));
    localStorage.setItem('iptv_text_size', JSON.stringify(textSize));
  }, { count, layout, textSize });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
}

test('the timeline puts the playlist tabs above its filters, where the schedule layout has them', async ({ page }) => {
  const boxes = async () => {
    const box = async (selector: string) => (await page.locator(`#view-epg ${selector}`).boundingBox())!;
    return { tabs: await box('.epg-playlist-tabs'), group: await box('.epg-group-button'), search: await box('.epg-search-wrap') };
  };
  await openGuideWithPlaylists(page, 2, 'schedule');
  await expect(page.locator('#view-epg .epg-channel-item').first()).toBeVisible();
  const schedule = await boxes();
  await page.evaluate(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
  await page.reload();
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await expect(page.locator('.epg-tl-surface')).toBeVisible();
  const timeline = await boxes();

  expect(timeline.tabs.y + timeline.tabs.height).toBeLessThanOrEqual(timeline.group.y);
  for (const key of ['tabs', 'group', 'search'] as const) {
    for (const side of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(timeline[key][side] - schedule[key][side]), `${key} ${side}`).toBeLessThanOrEqual(1);
    }
  }

  // Up from the group filter reaches the tabs, Down comes back.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.epg-group-button')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#view-epg .playlist-tab.active')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.epg-group-button')).toHaveClass(/focused/);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the timeline toolbar scrolls many playlist tabs at the largest text size', async ({ page }) => {
  await openGuideWithPlaylists(page, 10, 'timeline', '150');
  const tabs = page.locator('.epg-tl-toolbar .epg-playlist-tabs');
  await expect(tabs.locator('.playlist-tab')).toHaveCount(11);

  const viewport = page.viewportSize()!;
  for (const selector of ['.epg-group-button', '.epg-search-wrap', '.epg-reminder-entry']) {
    const box = (await page.locator(`.epg-tl-toolbar ${selector}`).boundingBox())!;
    expect(box.x + box.width, `${selector} stays on screen`).toBeLessThanOrEqual(viewport.width);
  }
  expect(await tabs.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);

  // The keys reach the last tab, which scrolls into the strip.
  // The first key only shows the ring that the pointer's tab click hid.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.epg-group-button')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  const last = tabs.locator('.playlist-tab').last();
  await expect(last).toHaveClass(/focused/);
  await expect.poll(async () => {
    const strip = (await tabs.boundingBox())!;
    const box = (await last.boundingBox())!;
    return box.x >= strip.x - 1 && box.x + box.width <= strip.x + strip.width + 1;
  }).toBe(true);
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('the timeline pages and scrolls while the pointer rests at its edges, and stops when it leaves', async ({ page }) => {
  const channels = Array.from({ length: 20 }, (_, i) =>
    `#EXTINF:-1 tvg-id="c${String(i + 1)}",Channel ${String(i + 1)}\nhttp://streams.example.com/${String(i + 1)}.m3u8`);
  await routePlaylist(page, ['#EXTM3U url-tvg="http://epg.example.com/guide.xml"', ...channels].join('\n'));
  // Hourly programs from six hours back to a day ahead, so there are pages to turn.
  const hour = NOW.getTime();
  const programmes = Array.from({ length: 20 }, (_, c) => Array.from({ length: 30 }, (_, h) =>
    `<programme channel="c${String(c + 1)}" start="${xmltvTime(hour + (h - 6) * 3600_000)}" stop="${xmltvTime(hour + (h - 5) * 3600_000)}"><title>Show ${String(h)}</title></programme>`).join('')).join('');
  await page.route('**/guide.xml', route => route.fulfill({
    status: 200, contentType: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><tv>${programmes}</tv>`,
  }));
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_guide_layout', JSON.stringify('timeline')));
  await startClock(page);
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  const surface = page.locator('.epg-tl-surface');
  await expect(page.locator('.tl-row').first()).toBeVisible();
  const box = (await surface.boundingBox())!;
  const firstTime = page.locator('.tl-ruler-label').first();
  const layer = page.locator('.tl-layer');
  const transform = () => layer.evaluate(el => el.style.transform);
  // Reads until two reads 400 ms apart agree, then checks nothing moves on.
  const expectStill = async (read: () => Promise<string | null>) => {
    let last: string | null = null;
    await expect.poll(async () => {
      const now = await read();
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [400], timeout: 5000 }).toBe(true);
    await page.waitForTimeout(800);
    expect(await read()).toBe(last);
  };

  const start = await firstTime.textContent();
  await page.mouse.move(box.x + 1000, box.y + 120, { steps: 4 });
  await page.mouse.move(box.x + 1890, box.y + 120, { steps: 4 });
  await expect.poll(() => firstTime.textContent(), { timeout: 5000 }).not.toBe(start);
  await page.mouse.move(box.x + 1000, box.y + 120, { steps: 4 });
  await expectStill(() => firstTime.textContent());

  const top = await transform();
  const rowsBottom = (await page.locator('.epg-tl-detail').boundingBox())!.y;
  await page.mouse.move(box.x + 1000, rowsBottom - 10, { steps: 4 });
  await expect.poll(transform, { timeout: 5000 }).not.toBe(top);
  await page.mouse.move(box.x + 1000, box.y + 300, { steps: 4 });
  await expectStill(transform);
  await expect(page.locator('.focused')).toHaveCount(1);
});
