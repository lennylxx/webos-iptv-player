import {
  test,
  expect,
  isChromium53,
  type Page,
  routePlaylist,
  seedPlaylist,
} from './helpers';

// EPG guide: the LIVE badge and the day/time-zone handling. Both need a fixed
// clock and a UTC device zone so wall-clock == absolute time.
test.use({ timezoneId: 'UTC' });

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
  await page.clock.setFixedTime(now);
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

    await page.evaluate(({ url, timestamp }) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('iptv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('epg-cache', 'readwrite');
        const store = tx.objectStore('epg-cache');
        const read = store.get(url);
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          if (!read.result) {
            reject(new Error('EPG cache entry was not stored'));
            return;
          }
          store.put({ ...read.result, timestamp });
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      };
    }), {
      url: epgUrl,
      timestamp: now.getTime() - 24 * 60 * 60 * 1000,
    });

    await page.reload();
    await expect.poll(() => epgRequests).toBe(2);
    await expect(nowPlaying).toHaveText('Cached Show');

    releaseRefresh();
    await expect(nowPlaying).toHaveText('Fresh Show');
  } finally {
    releaseRefresh();
  }
});

test.describe('EPG live badge', () => {
  // Fixed "now" placed inside the middle program so exactly one row is airing.
  // UTC device + +0000 EPG keeps wall-clock == absolute time, so the live/past/
  // future split is unambiguous regardless of timezone mode.
  const NOW = new Date('2024-03-09T12:00:00Z');

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
    await page.clock.setFixedTime(NOW);
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    });
  }

  test('the EPG marks the currently-airing program with a pulsing LIVE badge', async ({ page }) => {
    await setup(page);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    // Open the guide (Red / Programme Guide remote key).
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.locator('#epg-programmes .epg-programme-item').first().waitFor();

    // Exactly one program is live — the 11:00–13:00 show — and it carries the badge.
    const live = page.locator('#epg-programmes .epg-programme-item.state-live');
    await expect(live).toHaveCount(1);
    await expect(live).toContainText('Live Show');

    const badge = live.locator('.epg-now-badge');
    await expect(badge).toHaveCount(1);
    await expect(badge).toHaveText(/LIVE/);

    // The dot doesn't just exist — it carries the looping pulse animation...
    const dot = badge.locator('.epg-now-dot');
    await expect(dot).toHaveCount(1);
    await expect(dot).toHaveCSS('animation-name', 'epgDotPulse');
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
    await expect(page.locator('#epg-programmes .epg-now-badge')).toHaveCount(1);
    const earlier = page.locator('#epg-programmes .epg-programme-item', { hasText: 'Earlier Show' });
    await expect(earlier).toHaveClass(/state-past/);
    await expect(earlier.locator('.epg-now-badge')).toHaveCount(0);
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
    await expect(page.locator('#view-channels')).toBeVisible();
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
      return { idle, focused: read() };
    });

    expect(styles.focused.outline).not.toBe('none');
    expect(styles.focused.border).not.toBe(styles.idle.border);
  });

  test('with reduced motion the LIVE badge still shows, but the pulse is disabled', async ({ page }) => {
    // epg.css has `@media (prefers-reduced-motion: reduce) { .epg-now-dot { animation: none } }`.
    // Modern engines honor it (legacy webOS ignores it and keeps pulsing —
    // both acceptable). Verify the off-switch on an engine that honors it.
    test.skip(isChromium53(), 'legacy webOS ignores reduced motion and lacks getAnimations');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();
    await page.locator('#epg-programmes .epg-programme-item.state-live').first().waitFor();

    // Accessibility: the badge/dot still render (the LIVE indicator stays)...
    const dot = page.locator('#epg-programmes .epg-programme-item.state-live .epg-now-dot');
    await expect(dot).toHaveCount(1);
    // ...but the pulse is turned off entirely — no animation name, no running animation.
    await expect(dot).toHaveCSS('animation-name', 'none');
    expect(await dot.evaluate((el) => el.getAnimations().length)).toBe(0);
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
    await page.clock.setFixedTime(NOW);
    await page.addInitScript((mode) => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
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
    await expect(page.locator('#view-channels')).toBeVisible();
    await openEpg(page);

    // Today in the feed zone is Sun 03/10 — highlighted and selected.
    await expect(todayDay(page)).toHaveText(/Sun\s+03\/10/);
    await expect(selectedDay(page)).toHaveText(/Sun\s+03\/10/);
    // The 23:41 program belongs to 03/09, so 03/10 starts at 00:30 — not 23:41.
    await expect(page.locator('#epg-programmes .epg-prog-time').first()).toHaveText('00:30');
    // A program ending exactly at midnight must not create an empty 03/11 column.
    await expect(page.locator('#epg-dates .epg-date-item')).toHaveCount(2);
  });

  test('switching device → feed re-snaps the selected day to today', async ({ page }) => {
    await setup(page, 'device');
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    await openEpg(page);
    await expect(selectedDay(page)).toHaveText(/Sat\s+03\/09/); // device-local today

    // Back to channels, open settings, switch to Feed, save.
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, bubbles: true })));
    await expect(page.locator('#view-channels')).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 406, bubbles: true })));
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#tz-mode [data-value="feed"]').click();
    await page.locator('#save-settings').click();
    await expect(page.locator('#view-channels')).toBeVisible();

    await openEpg(page);
    // Selection must follow "today" into the new timezone, not stick on 03/09.
    await expect(selectedDay(page)).toHaveText(/Sun\s+03\/10/);
  });
});
