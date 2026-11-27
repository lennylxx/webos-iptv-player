import { test, expect, liveLoaded, enterTab, type Page } from './helpers';
import { type Locator } from '@playwright/test';
import { seedXtream } from './fixtures/xtream';

// Headless Chromium hides scrollbars by default; a TV shows them.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

type Scroller = [Locator, 'x' | 'y'];

// Each scroller must overflow along its own axis, or there is no bar to hide.
async function expectNoScrollbars(scrollers: Scroller[]): Promise<void> {
  for (const [scroller, axis] of scrollers) {
    await expect(scroller).toBeVisible();
    expect(await scroller.evaluate((el: HTMLElement, a) => ({
      horizontal: el.offsetHeight - el.clientHeight,
      vertical: el.offsetWidth - el.clientWidth,
      overflows: a === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight,
    }), axis)).toEqual({ horizontal: 0, vertical: 0, overflows: true });
  }
}

const expectNoRailScrollbars = (page: Page) => expectNoScrollbars([
  [page.locator('#view-movies .catalog-rails'), 'y'],
  [page.locator('#view-movies [data-rail-key^="cat:"] .catalog-rail-track').first(), 'x'],
]);

test.beforeEach(async ({ page }) => {
  await seedXtream(page, { catalog: 'large' });
  await page.goto('/');
  await liveLoaded(page);
});

test('catalog rails show no scrollbars', async ({ page }) => {
  await enterTab(page, 'movies');
  await expectNoRailScrollbars(page);
});

// Chrome 121+ drops ::-webkit-scrollbar rules wherever scrollbar-color applies.
test('catalog rails stay bar-free under an inherited scrollbar-color', async ({ page }) => {
  await page.evaluate(() => { document.documentElement.style.setProperty('scrollbar-color', 'gray transparent'); });
  await enterTab(page, 'movies');
  await expectNoRailScrollbars(page);
});

test('search result rails show no scrollbars', async ({ page }) => {
  await enterTab(page, 'search');
  await page.locator('.tab-bar-search-input').fill('movie');
  await expectNoScrollbars([[page.locator('#view-search [data-search-virtual="movies"]'), 'x']]);
});
