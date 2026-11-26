import { fakeAiConfig, expect, liveLoaded, neuterVideo, routePlaylist, test, type Page, pinClock, xmltvTime } from './helpers';

// Program info translation in Live: the legend's hint turns it on, and the
// visible rows, the preview's program, and its Up next go in one request.
const CHANNELS = 30;

function at(slot: number): string {
  return xmltvTime(Date.UTC(2024, 2, 9) + slot * 30 * 60 * 1000);
}

// Program N on chC airs in the Nth half hour; ch2's current program has no title.
async function setup(page: Page): Promise<string[]> {
  const ids = Array.from({ length: CHANNELS }, (_, i) => i + 1);
  const programmes: string[] = [];
  for (const c of ids) {
    for (let i = 20; i < 32; i++) {
      const title = c === 2 && i === 24 ? '' : `Ch${c} Program ${i}`;
      programmes.push(`<programme channel="ch${c}" start="${at(i)}" stop="${at(i + 1)}"><title>${title}</title><desc>Episode ${c}-${i}.</desc></programme>`);
    }
  }
  await routePlaylist(page, ['#EXTM3U', ...ids.flatMap(c => [`#EXTINF:-1 tvg-id="ch${c}",Channel ${c}`, `http://host/${c}.m3u8`])].join('\n'));
  await page.route('**/epg.xml', route => route.fulfill({ status: 200, contentType: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><tv>${ids.map(c => `<channel id="ch${c}"/>`).join('')}${programmes.join('')}</tv>` }));
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(m => m.role === 'user')?.content || '';
    sent.push(user);
    const reply = user.split('\n').map(line => line.replace('Program', 'Programm').replace('Episode', 'Folge')).join('\n');
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: reply } }] }) });
  });
  await pinClock(page, new Date('2024-03-09T12:10:00Z'));
  await page.addInitScript((config) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1', name: 'P', url: 'http://host/playlist.m3u' }]));
    localStorage.setItem('iptv_manual_epg_sources', JSON.stringify([{ url: 'http://host/epg.xml', playlistIds: [] }]));
    localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
    localStorage.setItem('iptv_live_preview', JSON.stringify(true));
    localStorage.setItem('iptv_llm', config);
  }, fakeAiConfig());
  return sent;
}

async function openPreview(page: Page): Promise<void> {
  await page.goto('/');
  await liveLoaded(page);
  await expect(page.locator('#view-channels .channel-item').first()).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#live-preview .live-preview-title')).toHaveText('Ch1 Program 24');
}

const hint = (page: Page) => page.locator('#view-channels [data-live-translate]');
const rowTitle = (page: Page, channel: number) =>
  page.locator(`#view-channels .channel-main .channel-item[data-channel-index="${channel - 1}"] .channel-now`);

test('the legend hint translates the visible rows, the preview, and Up next in one request', async ({ page }) => {
  await neuterVideo(page);
  const sent = await setup(page);
  await openPreview(page);
  await expect(hint(page)).toHaveText('Translate program info with AI');
  await expect(hint(page)).not.toHaveAttribute('data-focusable');
  const legend = () => page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('#view-channels .preview-list-hints')!;
    const items = Array.from(bar.querySelectorAll<HTMLElement>('.preview-list-context > *'));
    const button = bar.querySelector<HTMLElement>('[data-live-translate]')!;
    const label = button.querySelector<HTMLElement>('span:last-child')!;
    // Layout without the hover's scale, which every button has and which moves nothing around it.
    button.style.transition = button.style.transform = 'none';
    const box = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const layout = { text: bar.innerText, bar: box(bar), label: box(label), items: items.map(box) };
    button.style.transition = button.style.transform = '';
    return layout;
  });
  const look = () => hint(page).evaluate(el => {
    const style = getComputedStyle(el);
    return [style.color, style.backgroundColor, style.borderTopColor, style.boxShadow];
  });
  // The Guide's clickable hint as its hover paints it.
  const guideHover = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'color: var(--text-primary); background-color: var(--bg-tertiary); '
      + 'border: 2px solid var(--focus-ring); box-shadow: 0 0 0 3px var(--focus-glow), 0 0 20px var(--focus-glow)';
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const look = [style.color, style.backgroundColor, style.borderTopColor, style.boxShadow];
    probe.remove();
    return look;
  });
  const before = await legend();
  expect(await look()).not.toEqual(guideHover);
  // The first move only seeds the pointer's position; the second is a pointer's.
  await page.mouse.move(500, 300);
  await hint(page).hover();
  await expect(page.locator('html')).not.toHaveClass(/\bkeyboard-nav\b/);
  await expect.poll(look, 'hover lights the hint as the Guide lights its own').toEqual(guideHover);
  expect(await legend(), 'hover moves nothing in the legend').toEqual(before);
  expect(sent).toHaveLength(0);

  await hint(page).click();
  await expect(rowTitle(page, 1)).toHaveText('Ch1 Programm 24');
  await expect(rowTitle(page, 3)).toHaveText('Ch3 Programm 24');
  await expect(page.locator('#live-preview .live-preview-title')).toHaveText('Ch1 Programm 24');
  await expect(page.locator('#live-preview .live-preview-program').first()).toContainText('Ch1 Programm 25');
  await expect(rowTitle(page, 1).locator('.ai-icon.is-title-mark')).toHaveCount(1);
  await expect(page.locator('#live-preview .live-preview-title .ai-icon.is-title-mark')).toHaveCount(1);
  // The preview's title mark grows with its title; a row's and Up next's stay small.
  const marks = await page.evaluate(() => {
    const size = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector)!;
      return [parseFloat(getComputedStyle(el).width), parseFloat(getComputedStyle(el).height)];
    };
    const title = document.querySelector<HTMLElement>('#live-preview .live-preview-title')!;
    return {
      titleFont: parseFloat(getComputedStyle(title).fontSize),
      title: size('#live-preview .live-preview-title .ai-icon'),
      row: size('#view-channels .channel-now .ai-icon'),
      upNext: size('#live-preview .live-preview-program .ai-icon'),
    };
  });
  expect(marks.title).toEqual([marks.titleFont, marks.titleFont]);
  expect(marks.titleFont).toBe(32);
  expect(marks.row).toEqual([16, 16]);
  expect(marks.upNext).toEqual([16, 16]);
  await expect(hint(page)).toHaveText('Show original');
  expect(sent).toHaveLength(1);
  // Only what shows: the rows below the fold, and a program without a title, stay out.
  expect(sent[0]).toContain('Ch1 Program 25');
  expect(sent[0]).not.toContain(`Ch${CHANNELS} Program`);
  expect(sent[0]).not.toContain('Episode 2-24');
  await expect(rowTitle(page, 2).locator('.ai-icon')).toHaveCount(0);

  // Translations already made show at once, with no new request.
  await hint(page).click();
  await expect(rowTitle(page, 1)).toHaveText('Ch1 Program 24');
  await expect(rowTitle(page, 1).locator('.ai-icon')).toHaveCount(0);
  await hint(page).click();
  await expect(rowTitle(page, 1)).toHaveText('Ch1 Programm 24', { timeout: 300 });
  await expect(page.locator('#live-preview .live-preview-title')).toHaveText('Ch1 Programm 24', { timeout: 300 });
  await page.waitForTimeout(800);
  expect(sent).toHaveLength(1);
});

test('after a relaunch the stored translations come back without a request', async ({ page }) => {
  await neuterVideo(page);
  const sent = await setup(page);
  await openPreview(page);
  await hint(page).click();
  await expect(page.locator('#live-preview .live-preview-title')).toHaveText('Ch1 Programm 24');
  await page.waitForTimeout(800);
  expect(sent).toHaveLength(1);

  await openPreview(page);
  await expect(hint(page), 'translation is off at every launch').toHaveText('Translate program info with AI');
  await hint(page).click();
  await expect(rowTitle(page, 1)).toHaveText('Ch1 Programm 24');
  await expect(page.locator('#live-preview .live-preview-program').first()).toContainText('Ch1 Programm 25');
  await page.waitForTimeout(800);
  expect(sent).toHaveLength(1);
});
