import { test, expect, type Page, routePlaylist, routeLiveManifest, LIVE_MANIFEST } from './helpers';

// Catch-up resume markers + resume prompt. A fixed clock and a UTC device zone
// keep wall-clock == absolute time so the past/live/future split is unambiguous.
test.use({ timezoneId: 'UTC' });

// "Now" sits inside the middle program: Earlier (past, catch-up-able), Live, Later.
const NOW = new Date('2024-03-09T12:00:00Z');
const PAST_START = Date.parse('2024-03-09T10:00:00Z');
const PAST_END = Date.parse('2024-03-09T11:00:00Z');

// A single channel that advertises catch-up, so past programs are resumable.
const CH_URL = 'http://streams.example.com/ch1.m3u8';
const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="News" catchup="default" ' +
    'catchup-source="http://streams.example.com/catchup.m3u8?start={utc}&end={utcend}" catchup-days="7",Channel 1',
  CH_URL,
].join('\n');

const EPG = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch1"><display-name>Channel 1</display-name></channel>
<programme channel="ch1" start="20240309100000 +0000" stop="20240309110000 +0000"><title>Earlier Show</title></programme>
<programme channel="ch1" start="20240309110000 +0000" stop="20240309130000 +0000"><title>Live Show</title></programme>
<programme channel="ch1" start="20240309130000 +0000" stop="20240309140000 +0000"><title>Later Show</title></programme>
</tv>`;

interface Seed { startMs: number; endMs: number; position: number; duration: number; completed: boolean }

async function setup(page: Page, seed?: Seed): Promise<void> {
  await routePlaylist(page, M3U);
  await routeLiveManifest(page); // live stream for the channel
  await page.route('**/catchup.m3u8**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: LIVE_MANIFEST }));
  await page.route('**/epg.xml', (r) => r.fulfill({ status: 200, contentType: 'application/xml', body: EPG }));
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(({ url, s }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/epg.xml'));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    if (!s) return;
    // Mirror channelKey(): FNV-1a of the URL with query/fragment stripped.
    const stable = url.split('#')[0].split('?')[0];
    let h = 0x811c9dc5;
    for (let i = 0; i < stable.length; i++) { h ^= stable.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    // No padStart: init scripts run before the app installs its polyfills, and
    // the simulation project has already removed the post-Chromium-53 API.
    let key = (h >>> 0).toString(16);
    while (key.length < 8) key = `0${key}`;
    const rec = {
      [`${key}|${s.startMs}`]: {
        channelKey: key, progStart: s.startMs, progEnd: s.endMs,
        position: s.position, duration: s.duration, updatedAt: s.startMs,
        completed: s.completed, expiresAt: s.endMs + 7 * 86400 * 1000,
      },
    };
    localStorage.setItem('iptv_catchup_progress', JSON.stringify(rec));
  }, { url: CH_URL, s: seed ?? null });
}

async function openEpg(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
  await expect(page.locator('#view-epg')).toBeVisible();
  await page.locator('#epg-programmes .epg-programme-item').first().waitFor();
}

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate(
    (k) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true })),
    keyCode,
  );
}

// Focus the programmes column (RIGHT) and open the resume prompt (ENTER) on the
// earliest, already-ended program — data-prog-idx 0.
async function focusPastProgramme(page: Page): Promise<void> {
  await key(page, 39); // RIGHT → programmes column, focus prog 0
  await key(page, 13); // ENTER → activate
}

const partial: Seed = { startMs: PAST_START, endMs: PAST_END, position: 1800, duration: 3600, completed: false };
const watched: Seed = { startMs: PAST_START, endMs: PAST_END, position: 3600, duration: 3600, completed: true };

test.describe('EPG catch-up resume markers', () => {
  test('a partial entry shows a Resume badge and a half-filled progress bar', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);

    const item = page.locator('#epg-programmes [data-prog-idx="0"]');
    await expect(item).toContainText('Earlier Show');
    const badge = item.locator('.epg-catchup-badge');
    await expect(badge).toHaveText('Resume');
    await expect(badge).toHaveClass(/resume/);
    // 1800 / 3600 = 50%.
    await expect(item.locator('.epg-catchup-progress-fill')).toHaveAttribute('style', /width:\s*50%/);
  });

  test('a completed entry shows a Watched badge and no progress bar', async ({ page }) => {
    await setup(page, watched);
    await openEpg(page);

    const item = page.locator('#epg-programmes [data-prog-idx="0"]');
    const badge = item.locator('.epg-catchup-badge');
    await expect(badge).toHaveText('Watched');
    await expect(badge).toHaveClass(/watched/);
    await expect(item.locator('.epg-catchup-progress-fill')).toHaveCount(0);
  });

  test('no marker renders when there is no stored progress', async ({ page }) => {
    await setup(page); // no seed
    await openEpg(page);
    await expect(page.locator('.epg-catchup-badge')).toHaveCount(0);
  });
});

test.describe('EPG catch-up resume prompt', () => {
  test('selecting a partial program opens the prompt at the stored position', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);
    await focusPastProgramme(page);

    const prompt = page.locator('.catchup-resume-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt.locator('.catchup-resume-message')).toContainText('Earlier Show');
    await expect(prompt.locator('.catchup-resume-message')).toContainText('30:00'); // 1800s
    // Still in the EPG — no playback started yet.
    await expect(page.locator('#view-player')).toBeHidden();
  });

  test('Resume plays the program and dismisses the prompt', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);
    await focusPastProgramme(page);
    await expect(page.locator('.catchup-resume-prompt')).toBeVisible();

    await key(page, 13); // ENTER on Resume (default focus)
    await expect(page.locator('#view-player')).toBeVisible();
    await expect(page.locator('.catchup-resume-prompt')).toBeHidden();
  });

  test('Start Over clears the stored entry and plays from the beginning', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);
    await focusPastProgramme(page);
    await expect(page.locator('.catchup-resume-prompt')).toBeVisible();

    await key(page, 39); // RIGHT → Start Over
    await key(page, 13); // ENTER
    await expect(page.locator('#view-player')).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem('iptv_catchup_progress'));
    expect(Object.keys(stored ? JSON.parse(stored) : {})).toHaveLength(0);
  });

  test('Cancel keeps the EPG open and does not start playback', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);
    await focusPastProgramme(page);
    await expect(page.locator('.catchup-resume-prompt')).toBeVisible();

    await key(page, 39); // RIGHT → Start Over
    await key(page, 39); // RIGHT → Cancel
    await key(page, 13); // ENTER
    await expect(page.locator('.catchup-resume-prompt')).toBeHidden();
    await expect(page.locator('#view-epg')).toBeVisible();
    await expect(page.locator('#view-player')).toBeHidden();
  });

  // Magic-Remote/mouse parity: a real click on the program row opens the prompt,
  // and a click on Resume plays it — the click-driven activation path.
  test('a pointer click on the program opens the prompt, and clicking Resume plays it', async ({ page }) => {
    await setup(page, partial);
    await openEpg(page);

    await page.locator('#epg-programmes [data-prog-idx="0"]').click();
    await expect(page.locator('.catchup-resume-prompt')).toBeVisible();

    await page.locator('.catchup-resume-btn[data-action="resume"]').click();
    await expect(page.locator('#view-player')).toBeVisible();
    await expect(page.locator('.catchup-resume-prompt')).toBeHidden();
  });
});
