import { enterTab, expect, liveLoaded, test, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// Movie and series info translation: Translate on a detail page turns on the
// session's translation, and the title and description come back labeled.

async function setup(page: Page): Promise<string[]> {
  await seedXtream(page);
  const sent: string[] = [];
  await page.route('http://ai.test/v1/chat/completions', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(route.request().postData() || '{}') as { messages: Array<{ role: string; content: string }> };
    const user = body.messages.find(m => m.role === 'user')?.content || '';
    sent.push(user);
    const title = /^Title: (.*)$/m.exec(user)?.[1] ?? '';
    const description = /^Description: (.*)$/m.exec(user)?.[1] ?? '';
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: `${title} (de)`, description: description ? `${description} (de)` : '',
      }) } }] }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('iptv_llm', JSON.stringify({
      enabled: true,
      baseUrl: 'http://ai.test/v1',
      model: 'm1',
      capabilities: {
        signature: 'http://ai.test/v1|m1', structured: 'json_schema',
        thinkingOff: false, effortOff: false, reasoningParams: false, checkedAt: 1,
      },
    }));
  });
  return sent;
}

async function openDetail(page: Page, section: 'movies' | 'series', itemId: string): Promise<void> {
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, section);
  await page.locator(`#view-${section} .catalog-tile[data-item-id="${itemId}"]`).first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator(`#view-${section} .detail-plot`)).toBeVisible();
}

// The keys a viewer presses: Right along the actions onto Translate, then OK.
async function pressTranslate(page: Page, section: 'movies' | 'series'): Promise<void> {
  const button = page.locator(`#view-${section} [data-key="translate"]`);
  for (let i = 0; i < 6 && !(await button.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(button).toHaveClass(/\bfocused\b/);
  await page.keyboard.press('Enter');
}

test('Translate on a movie translates its title and plot, and shows the original again', async ({ page }) => {
  const sent = await setup(page);
  await openDetail(page, 'movies', '10');
  const view = page.locator('#view-movies');
  const button = view.locator('[data-key="translate"]');
  await expect(button).toHaveAttribute('aria-label', 'Translate with AI');
  // Its icon takes the round action's color, like the others in the row.
  const iconMatchesCircle = () => button.locator('.detail-icon-circle').evaluate((circle) => {
    const svg = circle.querySelector('svg')!;
    return getComputedStyle(svg).fill === getComputedStyle(circle).color;
  });
  expect(await iconMatchesCircle()).toBe(true);

  await pressTranslate(page, 'movies');
  await expect(button).toHaveAttribute('aria-label', 'Show original');
  await expect(button).toHaveClass(/\bon\b/);
  expect(await iconMatchesCircle()).toBe(true);
  await expect(view.locator('.detail-title')).toHaveText('Movie One (de)');
  await expect(view.locator('.detail-plot')).toHaveText('AI translation · A plot. (de)');
  await expect(view.locator('.detail-plot .program-translation-label .ai-icon svg')).toHaveCount(1);
  expect(sent).toEqual(['Title: Movie One\nDescription: A plot.']);
  await expect(view.locator('.focused')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-label', 'Translate with AI');
  await expect(view.locator('.detail-title')).toHaveText('Movie One');
  await expect(view.locator('.detail-plot')).toHaveText('A plot.');
  expect(sent).toHaveLength(1);
});

test('a series translates its own info, then the episode the focus rests on', async ({ page }) => {
  const sent = await setup(page);
  await openDetail(page, 'series', '20');
  const view = page.locator('#view-series');
  await pressTranslate(page, 'series');
  await expect(view.locator('.detail-plot')).toHaveText('AI translation · A series plot. (de)');
  expect(sent).toEqual(['Title: Series One\nDescription: A series plot.']);

  // Down past the seasons onto the episode.
  const row = view.locator('.episode-row[data-episode-id="11"]');
  for (let i = 0; i < 4 && !(await row.evaluate((el) => el.classList.contains('focused'))); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(row).toHaveClass(/\bfocused\b/);
  await expect(row.locator('.episode-name')).toHaveText('Episode 1 (de)');
  await expect(row.locator('.episode-plot')).toHaveText('AI translation · An episode. (de)');
  expect(sent).toEqual(['Title: Series One\nDescription: A series plot.', 'Title: Episode 1\nDescription: An episode.']);
  await expect(view.locator('.detail-plot')).toHaveText('AI translation · A series plot. (de)');
});

test('a detail page offers no Translate while AI features are off', async ({ page }) => {
  await seedXtream(page);
  await openDetail(page, 'movies', '10');
  await expect(page.locator('#view-movies .detail-icon-btn').first()).toBeVisible();
  await expect(page.locator('#view-movies [data-key="translate"]')).toHaveCount(0);
});

test('a long title without a plot keeps its translation label in full at text size 150', async ({ page }) => {
  await setup(page);
  const name = 'Movie One With A Title Long Enough To Fill Both Of The Lines The Heading Shows At The Largest Text Size';
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('get_vod_categories')) return json([{ category_id: '1', category_name: 'Cat A' }]);
    if (url.includes('get_vod_streams')) {
      return json([{ stream_id: 10, name, stream_icon: '', container_extension: 'mp4', category_id: '1' }]);
    }
    if (url.includes('get_vod_info')) return json({ info: { duration_secs: 3600 } });
    return route.fallback();
  });
  await page.addInitScript(() => localStorage.setItem('iptv_text_size', JSON.stringify('150')));
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  await page.locator('#view-movies .catalog-tile[data-item-id="10"]').first()
    .evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  const view = page.locator('#view-movies');
  await expect(view.locator('[data-key="translate"]')).toBeVisible();
  await pressTranslate(page, 'movies');
  const label = view.locator('.program-translation-label.is-title');
  await expect(label).toHaveText('AI translation');
  // The title is clamped to two lines; no clamp or scroller cuts the label.
  const box = await label.evaluate((el) => {
    const own = el.getBoundingClientRect();
    let clipped = false;
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflow === 'visible') continue;
      const r = up.getBoundingClientRect();
      if (own.top < r.top - 1 || own.bottom > r.bottom + 1 || own.right > r.right + 1) clipped = true;
    }
    return { clipped, height: own.height };
  });
  expect(box.clipped).toBe(false);
  expect(box.height).toBeGreaterThan(20);
  await expect(view.locator('.detail-title')).toHaveText(`${name} (de)`);
});
