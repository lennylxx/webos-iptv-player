import {
  enterTab,
  expect,
  fakeAiConfig,
  liveLoaded,
  neuterVideo,
  routePlaylist,
  test,
  type Page,
  pinClock,
  xmltvTime,
} from './helpers';

// Program info translation: Green turns it on in the Guide and the player's
// info, and every program a surface shows comes back translated, in one
// request per surface once it settles.
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
  return xmltvTime(Date.UTC(2024, 2, 9) + slot * 60 * 60 * 1000);
}

// Program N airs from N:00 to N+1:00 on ch1; the AI server answers each
// numbered line with "Programm N" and "Folge N.", the latter longer with
// `longer`. ch2 has no guide, so its row says No information.
async function setup(page: Page, options: { ai?: boolean; layout?: 'schedule' | 'timeline'; longer?: boolean } = {}): Promise<string[]> {
  const programmes = Array.from({ length: 24 }, (_, i) =>
    `<programme channel="ch1" start="${at(i)}" stop="${at(i + 1)}"><title>Program ${i}</title><desc>Episode ${i}.</desc></programme>`);
  await routePlaylist(page, ['#EXTM3U', '#EXTINF:-1 tvg-id="ch1",Channel 1', 'http://host/a.m3u8',
    '#EXTINF:-1 tvg-id="ch2",Channel 2', 'http://host/b.m3u8'].join('\n'));
  await page.route('**/epg.xml', route => route.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="ch1"/>${programmes.join('')}</tv>` }));
  const sent: string[] = [];
  const more = options.longer ? ' Eine lange Folge mit vielen Worten, die über mehr als eine Zeile läuft und weiter geht.'.repeat(2) : '';
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(m => m.role === 'user')?.content || '';
    sent.push(user);
    const content = user.replace(/Program (\d+)/g, 'Programm $1').replace(/Episode (\d+)\./g, `Folge $1.${more}`);
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await pinClock(page, new Date('2024-03-09T12:10:00Z'));
  await page.addInitScript(({ ai, layout }) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    localStorage.setItem('iptv_guide_layout', JSON.stringify(layout));
    if (ai) {
      localStorage.setItem('iptv_llm', ai);
    }
  }, { ai: options.ai !== false ? fakeAiConfig() : '', layout: options.layout ?? 'schedule' });
  return sent;
}

// The program numbers a request's title lines carry, in order.
function sentPrograms(user: string): number[] {
  return user.split('\n').filter(line => /^\[T\d+\]/.test(line)).map(line => Number(/Program (\d+)/.exec(line)?.[1]));
}

// The schedule rows any part of which shows in the list, top to bottom.
function shownScheduleRows(page: Page): Promise<Array<{ title: string; top: number; bottom: number }>> {
  return page.locator('.epg-programmes-pane').evaluate((pane) => {
    const box = pane.getBoundingClientRect();
    return Array.from(pane.querySelectorAll<HTMLElement>('.epg-programme-item'))
      .map(row => ({ row, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)
      .map(({ row, rect }) => ({ title: row.querySelector('.epg-prog-title')!.textContent!.trim(), top: rect.top, bottom: rect.bottom }));
  });
}

// The titles the timeline's shown cells write.
function shownCellTitles(page: Page): Promise<string[]> {
  return page.locator('.tl-viewport').evaluate(viewport => Array.from(viewport.querySelectorAll<HTMLElement>('.tl-row .tl-cell'))
    .filter(cell => (cell.parentElement as HTMLElement).style.visibility !== 'hidden')
    .filter(cell => cell.style.display !== 'none' && !cell.classList.contains('is-empty'))
    .map(cell => cell.querySelector('.tl-title')!.textContent!.trim())
    .filter(title => title));
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
  // The rows have their measured heights, so the rows on screen stay put.
  await expect.poll(async () => {
    const rows = await shownScheduleRows(page);
    return rows.every((one, i) => i === 0 || Math.abs(rows[i - 1].bottom - one.top) < 1);
  }).toBe(true);
}

test('Green translates every program the schedule shows in one request and shows the original again', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  const hint = page.locator('#view-epg .epg-hints [data-epg-translate]');
  await expect(hint).toHaveText('Translate program info with AI');
  const row = page.locator('#epg-programmes .epg-programme-item.focused');

  await key(page, GREEN);
  await expect(hint).toHaveText('Show original');
  await expect(row.locator('.epg-prog-title')).toContainText('Programm 12');
  await expect(row.locator('.epg-prog-desc')).toHaveText('AI translation · Folge 12.');
  await expect(row.locator('.epg-prog-desc .program-translation-label .ai-icon svg')).toHaveCount(1);
  const shown = await shownScheduleRows(page);
  expect(shown.length).toBeGreaterThan(2);
  for (const one of shown) expect(one.title).toMatch(/Programm \d+/);
  expect(sent).toHaveLength(1);
  expect(sentPrograms(sent[0])).toEqual(shown.map(one => Number(/(\d+)/.exec(one.title)![1])));
  expect(sent[0]).toContain('[T1] Program ');
  expect(sent[0]).toContain('[D1] Episode ');

  // The ring moves among rows already translated: nothing more goes out.
  await page.keyboard.press('ArrowDown');
  const next = page.locator('#epg-programmes .epg-programme-item.focused');
  await expect(next.locator('.epg-prog-desc')).toHaveText('AI translation · Folge 13.');
  await page.waitForTimeout(600);
  expect(sent).toHaveLength(1);

  await key(page, GREEN);
  await expect(hint).toHaveText('Translate program info with AI');
  await expect(next.locator('.epg-prog-desc')).toHaveText('Episode 13.');
  await expect(page.locator('#epg-programmes .program-translation-label')).toHaveCount(0);
  await expect(page.locator('#view-epg .focused')).toHaveCount(1);
});

test('translated schedule rows keep their own room when a translation runs longer', async ({ page }) => {
  await setup(page, { longer: true });
  await openSchedule(page);
  const before = await shownScheduleRows(page);
  await key(page, GREEN);
  await expect(page.locator('#epg-programmes .epg-programme-item.focused .epg-prog-desc')).toContainText('Eine lange Folge');
  await expect.poll(async () => {
    const rows = await shownScheduleRows(page);
    return rows.length > 1 && rows.every((one, i) => i === 0 || rows[i - 1].bottom <= one.top + 0.5);
  }).toBe(true);
  const after = await shownScheduleRows(page);
  // The longer text takes another line, so each row grew.
  expect(after[1].bottom - after[1].top).toBeGreaterThan(before[1].bottom - before[1].top);
});

test('Green does nothing where the Guide\'s ring rests on no program', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  const hint = page.locator('#view-epg .epg-hints [data-epg-translate]');
  await expect(hint).toHaveText('Translate program info with AI');

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
  await expect(hint).toHaveText('Translate program info with AI');
  await page.waitForTimeout(600);
  expect(sent).toEqual([]);
});

test('leaving the Guide before the schedule settles sends nothing', async ({ page }) => {
  const sent = await setup(page);
  await openSchedule(page);
  await key(page, GREEN);
  await expect(page.locator('#view-epg .epg-hints [data-epg-translate]')).toHaveText('Show original');
  await key(page, BLUE);
  await expect(page.locator('#view-settings')).toBeVisible();
  await page.waitForTimeout(800);
  expect(sent).toEqual([]);
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

test('the timeline translates the cells it shows in one request, unmarked, and its details say so', async ({ page }) => {
  const sent = await setup(page, { layout: 'timeline' });
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'epg');
  await page.keyboard.press('ArrowDown');
  const detail = page.locator('.epg-tl-detail');
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Program 12');
  const before = await shownCellTitles(page);
  expect(before.length).toBeGreaterThan(1);

  await expect(detail.locator('[data-epg-translate]')).toHaveText('Translate program info with AI');
  await detail.locator('[data-epg-translate]').click();
  await expect(detail.locator('.epg-tl-title-text')).toHaveText('Programm 12');
  await expect(detail.locator('.epg-tl-desc')).toHaveText('AI translation · Folge 12.');
  await expect(detail.locator('.epg-tl-desc .program-translation-label .ai-icon svg')).toHaveCount(1);
  await expect(detail.locator('[data-epg-translate]')).toHaveText('Show original');
  await expect.poll(() => shownCellTitles(page)).toEqual(before.map(title => title.replace('Program', 'Programm')));
  await expect(page.locator('.tl-viewport .ai-icon')).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sentPrograms(sent[0]).sort((a, b) => a - b)).toEqual(before.map(title => Number(/(\d+)/.exec(title)![1])).sort((a, b) => a - b));

  // The ring crosses translated cells and a row without information: nothing more goes out.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(detail.locator('.epg-tl-no-info')).toBeVisible();
  // Green still turns translation off from here, so its key shows.
  await expect(detail.locator('[data-epg-translate]')).toHaveText('Show original');
  await page.waitForTimeout(800);
  expect(sent).toHaveLength(1);

  await key(page, GREEN);
  await expect.poll(() => shownCellTitles(page)).toEqual(before);
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

test('Green translates the program in the player info', async ({ page }) => {
  await neuterVideo(page);
  const sent = await setup(page);
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-programme-title-text')).toHaveText('Program 12');
  // The hint sits on the title row, after the title.
  await expect(page.locator('.osd-programme-title [data-osd-translate]')).toHaveText('Translate program info with AI');

  await key(page, GREEN);
  await expect(page.locator('.osd-programme-title-text')).toHaveText('Programm 12');
  await expect(page.locator('.osd-description')).toHaveText('AI translation · Folge 12.');
  await expect(page.locator('.osd-description .program-translation-label .ai-icon svg')).toHaveCount(1);
  expect(sent).toEqual(['[T1] Program 12\n[D1] Episode 12.']);

  // Translation stays on for the session: the info shows it again.
  await key(page, YELLOW);
  await expect(page.locator('[data-osd-translate]')).toHaveText('Show original');
  await key(page, GREEN);
  await expect(page.locator('.osd-programme-title-text')).toHaveText('Program 12');
});

test('a translation kept from an earlier session sends nothing, alone or in a list', async ({ page }) => {
  await neuterVideo(page);
  const sent = await setup(page);
  await openSchedule(page);
  await key(page, GREEN);
  await expect(page.locator('#epg-programmes .epg-programme-item.focused .epg-prog-title')).toContainText('Programm 12');
  await expect.poll(async () => (await shownScheduleRows(page)).every(one => /Programm/.test(one.title))).toBe(true);
  expect(sent).toHaveLength(1);
  const programsOf = (rows: Array<{ title: string }>) => rows.map(one => Number(/(\d+)/.exec(one.title)![1]));
  const firstShown = programsOf(await shownScheduleRows(page));
  expect(sentPrograms(sent[0])).toEqual(firstShown);

  // The next launch starts with translation off; the player's info asks for one program the list sent.
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-programme-title-text')).toHaveText('Program 12');
  await key(page, GREEN);
  await expect(page.locator('.osd-programme-title-text')).toHaveText('Programm 12');
  await page.waitForTimeout(600);
  expect(sent).toHaveLength(1);

  // The list may come to rest a row higher than in the first launch; only a
  // program the first launch did not show is sent, and in one request.
  await openSchedule(page);
  await key(page, GREEN);
  await expect.poll(async () => (await shownScheduleRows(page)).every(one => /Programm/.test(one.title))).toBe(true);
  await page.waitForTimeout(600);
  const unseen = programsOf(await shownScheduleRows(page)).filter(n => !firstShown.includes(n));
  expect(sent.slice(1).map(sentPrograms)).toEqual(unseen.length ? [unseen] : []);
});
