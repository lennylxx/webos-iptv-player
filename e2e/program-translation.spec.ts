import {
  enterTab,
  expect,
  liveLoaded,
  neuterVideo,
  routePlaylist,
  test,
  type Page,
} from './helpers';

// Program info translation: Green turns it on in the Guide and the player's
// info, and the program the focus rests on comes back labeled.
test.use({ timezoneId: 'UTC' });

const RED = 403;
const GREEN = 404;
const YELLOW = 405;
const BLUE = 406;

function key(page: Page, keyCode: number): Promise<void> {
  return page.evaluate((k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: k, bubbles: true }));
  }, keyCode);
}

function at(slot: number): string {
  const d = new Date(Date.UTC(2024, 2, 9) + slot * 60 * 60 * 1000);
  return `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
}

// Program N airs from N:00 to N+1:00 on ch1; the AI server answers with "Programm N".
// ch2 has no guide, so its row says No information.
async function setup(page: Page, options: { ai?: boolean; layout?: 'schedule' | 'timeline' } = {}): Promise<string[]> {
  const programmes = Array.from({ length: 24 }, (_, i) =>
    `<programme channel="ch1" start="${at(i)}" stop="${at(i + 1)}"><title>Program ${i}</title><desc>Episode ${i}.</desc></programme>`);
  await routePlaylist(page, ['#EXTM3U', '#EXTINF:-1 tvg-id="ch1",Channel 1', 'http://host/a.m3u8',
    '#EXTINF:-1 tvg-id="ch2",Channel 2', 'http://host/b.m3u8'].join('\n'));
  await page.route('**/epg.xml', route => route.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/>${programmes.join('')}</tv>` }));
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(m => m.role === 'user')?.content || '';
    sent.push(user);
    const n = /Program (\d+)/.exec(user)?.[1] ?? '';
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: `Programm ${n}`, description: `Folge ${n}.`,
      }) } }] }) });
  });
  await page.clock.setFixedTime(new Date('2024-03-09T12:10:00Z'));
  await page.addInitScript(({ ai, layout }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    localStorage.setItem('iptv_guide_layout', JSON.stringify(layout));
    if (ai) {
      localStorage.setItem('iptv_llm', JSON.stringify({
        enabled: true,
        baseUrl: 'http://ai.test/v1',
        model: 'm1',
        capabilities: {
          signature: 'http://ai.test/v1|m1', structured: 'json_schema',
          thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1,
        },
      }));
    }
  }, { ai: options.ai !== false, layout: options.layout ?? 'schedule' });
  return sent;
}

async function openSchedule(page: Page): Promise<void> {
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);
  // Up to the tab bar, over to the Guide, and down onto its channel.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-epg .epg-channel-item.selected')).toHaveClass(/\bfocused\b/);
  await expect(page.locator('#epg-programmes .epg-programme-item.current')).toBeVisible();
  // Back to now: onto the program airing now.
  await key(page, RED);
  await expect(page.locator('#epg-programmes .epg-programme-item.focused')).toContainText('Program 12');
}

test('Green translates the focused Guide program and shows the original again', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  const hint = page.locator('#view-epg .epg-hints [data-epg-translate]');
  await expect(hint).toHaveText('Translate');
  const row = page.locator('#epg-programmes .epg-programme-item.focused');

  await key(page, GREEN);
  await expect(hint).toHaveText('Show original');
  await expect(row.locator('.epg-prog-title')).toContainText('Programm 12');
  await expect(row.locator('.epg-prog-desc')).toHaveText('AI translation · Folge 12.');
  await expect(row.locator('.epg-prog-desc .program-translation-label .ai-icon svg')).toHaveCount(1);
  expect(sent).toEqual(['Title: Program 12\nDescription: Episode 12.']);

  // The next program translates once the focus rests on it; the last one keeps its translation.
  await page.keyboard.press('ArrowDown');
  const next = page.locator('#epg-programmes .epg-programme-item.focused');
  await expect(next.locator('.epg-prog-desc')).toHaveText('AI translation · Folge 13.');
  await expect(page.locator('#epg-programmes .epg-programme-item', { hasText: 'Programm 12' })).toHaveCount(1);

  await key(page, GREEN);
  await expect(hint).toHaveText('Translate');
  await expect(next.locator('.epg-prog-desc')).toHaveText('Episode 13.');
  await expect(page.locator('#epg-programmes .program-translation-label')).toHaveCount(0);
  await expect(page.locator('#view-epg .focused')).toHaveCount(1);
});

test('Green does nothing where the Guide\'s ring rests on no program', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  const hint = page.locator('#view-epg .epg-hints [data-epg-translate]');
  await expect(hint).toHaveText('Translate');

  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#view-epg .epg-channel-item.selected')).toHaveClass(/\bfocused\b/);
  await expect(hint).toHaveCount(0);
  await key(page, GREEN);

  await page.locator('.epg-group-button').click();
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await key(page, GREEN);
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await key(page, 461);

  await key(page, RED);
  await expect(hint).toHaveText('Translate');
  await page.waitForTimeout(600);
  expect(sent).toEqual([]);
});

test('leaving the Guide before the focus rests sends nothing', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  await key(page, GREEN);
  await expect(page.locator('#epg-programmes .epg-programme-item.focused .program-translation-label')).toHaveText(/AI translation/);
  await page.keyboard.press('ArrowDown');
  await key(page, BLUE);
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.waitForTimeout(800);
  expect(sent).toEqual(['Title: Program 12\nDescription: Episode 12.']);
});

test('the open group menu shows no Green key, as Green does nothing there', async ({ page }) => {
  await setup(page);
  await openSchedule(page);
  await key(page, GREEN);
  const hint = page.locator('#view-epg .epg-hints [data-epg-translate]');
  await expect(hint).toHaveText('Show original');
  await page.locator('.epg-group-button').click();
  await expect(page.locator('.epg-group-menu')).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test('the Guide offers no translation without AI features', async ({ page }) => {
  const sent = await setup(page, { ai: false });
  await openSchedule(page);
  await expect(page.locator('#view-epg [data-epg-translate]')).toHaveCount(0);
  await key(page, GREEN);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#epg-programmes .epg-programme-item.focused .epg-prog-desc')).toHaveText('Episode 13.');
  expect(sent).toEqual([]);
});

test('the timeline details translate by a click on their Green hint', async ({ page }) => {
  await setup(page, { layout: 'timeline' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await page.keyboard.press('ArrowDown');
  const detail = page.locator('.epg-tl-detail');
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Program 12');

  await detail.locator('[data-epg-translate]').click();
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Programm 12');
  await expect(detail.locator('.epg-tl-desc')).toHaveText('AI translation · Folge 12.');
  await expect(detail.locator('[data-epg-translate]')).toHaveText('Show original');
});

test('Green leaves timeline translation on while the toolbar has the keys', async ({ page }) => {
  await setup(page, { layout: 'timeline' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await page.keyboard.press('ArrowDown');
  const detail = page.locator('.epg-tl-detail');
  await key(page, GREEN);
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Programm 12');

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.epg-group-button')).toHaveClass(/focused/);
  await expect(detail.locator('[data-epg-translate]')).toHaveCount(0);
  await key(page, GREEN);
  await page.keyboard.press('ArrowDown');
  await expect(detail.locator('[data-epg-translate]')).toHaveText('Show original');
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Programm 12');
});

test('the timeline sends nothing for a program the ring left for a row without information', async ({ page }) => {
  const sent = await setup(page, { layout: 'timeline' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await page.keyboard.press('ArrowDown');
  const detail = page.locator('.epg-tl-detail');
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Program 12');
  await key(page, GREEN);
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Programm 12');

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(detail.locator('.epg-tl-no-info')).toBeVisible();
  // Green still turns translation off from here, so its key shows.
  await expect(detail.locator('[data-epg-translate]')).toHaveText('Show original');
  await page.waitForTimeout(800);
  expect(sent).toEqual(['Title: Program 12\nDescription: Episode 12.']);
});

test('Green translates the program in the player info', async ({ page }) => {
  await neuterVideo(page);
  const sent = await setup(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-programme-title')).toHaveText('Program 12');
  await expect(page.locator('[data-osd-translate]')).toHaveText('Translate');

  // The hint sits at the row's end, the legacy engine's flex-gap fallback included.
  const ends = await page.locator('.osd-programme-time').evaluate((row) => ({
    row: row.getBoundingClientRect().right,
    hint: row.querySelector('.osd-translate')!.getBoundingClientRect().right,
  }));
  expect(Math.abs(ends.row - ends.hint)).toBeLessThan(1);

  await key(page, GREEN);
  await expect(page.locator('.osd-programme-title')).toHaveText('Programm 12');
  await expect(page.locator('.osd-description')).toHaveText('AI translation · Folge 12.');
  await expect(page.locator('.osd-description .program-translation-label .ai-icon svg')).toHaveCount(1);
  expect(sent).toEqual(['Title: Program 12\nDescription: Episode 12.']);

  // Translation stays on for the session: the info shows it again.
  await key(page, YELLOW);
  await expect(page.locator('[data-osd-translate]')).toHaveText('Show original');
  await key(page, GREEN);
  await expect(page.locator('.osd-programme-title')).toHaveText('Program 12');
});
