import {
  test,
  expect,
  enterTab,
  isChromium53,
  type Page,
  routeLiveManifest,
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
    await expect(page.locator('#view-channels')).toBeVisible();

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
  await page.clock.setFixedTime(new Date('2024-03-10T06:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
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
  await page.clock.setFixedTime(new Date('2024-03-10T06:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
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
    const at = (slot: number) => {
      const d = new Date(Date.UTC(2024, 2, 9) + slot * 30 * 60 * 1000);
      return `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
    };
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
    await page.clock.setFixedTime(new Date('2024-03-09T12:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
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
    await expect(page.locator('#view-channels')).toBeVisible();
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
    await page.clock.setFixedTime(new Date('2024-03-09T12:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
      localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    });
    await page.goto('/');
    await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);
    await page.keyboard.press('1');
    await page.keyboard.press('5');
    await page.keyboard.press('0');
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 150');
    await page.keyboard.press('Escape');
    await expect(page.locator('#view-channels')).toBeVisible();

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
