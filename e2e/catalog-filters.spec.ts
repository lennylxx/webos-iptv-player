import { test, expect, enterTab, liveLoaded, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';

// One category with enough titles for See all, in three genres.
const GENRES = ['g1', 'g2, g3', 'g3'];
const STREAMS = Array.from({ length: 24 }, (_, i) => ({
  stream_id: 100 + i, name: `${i % 2 ? 'Alpha' : 'Bravo'} ${String(i)}`, stream_icon: '',
  container_extension: 'mp4', category_id: '1', genre: GENRES[i % 3],
}));

async function seedCatalog(page: Page): Promise<void> {
  await seedXtream(page);
  await page.route('**/player_api.php*', (route) => {
    const url = route.request().url();
    if (url.includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STREAMS) });
    }
    if (url.includes('get_vod_info')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ info: { plot: 'A plot.' } }) });
    }
    return route.fallback();
  });
}

async function openCategory(page: Page): Promise<void> {
  await page.goto('/');
  await liveLoaded(page);
  await enterTab(page, 'movies');
  const seeAll = page.locator('#view-movies .catalog-see-all[data-category-id="1"]');
  await seeAll.evaluate((el) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-movies .catalog-grid-title')).toHaveText('Cat A');
}

const names = (page: Page) => page.locator('#view-movies .catalog-grid .catalog-tile-name');

test('a category narrows by genre and by a search typed with the remote', async ({ page }) => {
  await seedCatalog(page);
  await openCategory(page);
  await expect(names(page)).toHaveCount(24);

  const genre = page.locator('#movies-grid-genre');
  await genre.locator('.dropdown-trigger').click();
  await genre.locator('.dropdown-option').filter({ hasText: /^g3$/ }).click();
  await expect(names(page)).toHaveCount(16);

  const input = page.locator('#view-movies .catalog-filter-input');
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.type('alpha');
  await page.keyboard.press('ArrowDown');
  await expect(input).not.toBeFocused();
  await expect(names(page)).toHaveCount(8);
  await expect(page.locator('#view-movies [data-grid-index="0"] .catalog-tile')).toHaveClass(/focused/);
  for (const name of await names(page).allTextContents()) expect(name).toMatch(/^Alpha /);
});

test('a hidden title leaves its category until it is unhidden from Hidden', async ({ page }) => {
  await seedCatalog(page);
  await openCategory(page);
  const first = page.locator('#view-movies .catalog-grid .catalog-tile[data-item-id="100"]');
  await first.click();
  const hide = page.locator('#view-movies .movies-detail [data-action="hide"]');
  await hide.click();
  await expect(hide).toContainText('Unhide');
  const watched = page.locator('#view-movies .movies-detail [data-action="watched"]');
  await watched.click();
  await expect(watched).toContainText('Mark as not watched');
  await page.keyboard.press('Escape');
  await expect(names(page)).toHaveCount(23);
  await expect(first).toHaveCount(0);

  const show = page.locator('#movies-grid-show');
  await show.locator('.dropdown-trigger').click();
  await show.locator('.dropdown-option').filter({ hasText: 'Hidden' }).click();
  await expect(names(page)).toHaveText(['Bravo 0']);
  await expect(first.locator('.catalog-watched-badge')).toBeVisible();

  await first.click();
  await hide.click();
  await expect(hide).toContainText('Hide');
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-grid .catalog-hint')).toHaveText('No titles match these filters.');
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies [data-rail-key="cat:1"] .catalog-tile[data-item-id="100"]')).toHaveCount(1);
});

test('a long genre menu scrolls on its own and stays open', async ({ page }) => {
  await seedXtream(page);
  const streams = Array.from({ length: 60 }, (_, i) => ({
    stream_id: 300 + i, name: `Title ${String(i)}`, stream_icon: '', container_extension: 'mp4',
    category_id: '1', genre: `Genre ${String(i % 30).padStart(2, '0')}`,
  }));
  await page.route('**/player_api.php*', (route) => {
    if (route.request().url().includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(streams) });
    }
    return route.fallback();
  });
  await openCategory(page);
  const genre = page.locator('#movies-grid-genre');
  await genre.locator('.dropdown-trigger').click();
  await expect(genre).toHaveClass(/open/);
  for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
  await expect(genre).toHaveClass(/open/);
  const option = genre.locator('.dropdown-option.focused');
  await expect(option).toHaveText('Genre 24');
  await expect(option).toBeInViewport();
});

test('Down from the search box lands on the first title after the grid scrolled away', async ({ page }) => {
  await seedXtream(page);
  const streams = Array.from({ length: 200 }, (_, i) => ({
    stream_id: 500 + i, name: `Title ${String(i)}`, stream_icon: '', container_extension: 'mp4', category_id: '1',
  }));
  await page.route('**/player_api.php*', (route) => {
    if (route.request().url().includes('get_vod_streams')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(streams) });
    }
    return route.fallback();
  });
  await openCategory(page);
  const input = page.locator('#view-movies .catalog-filter-input');
  await input.click();
  await page.locator('#view-movies .catalog-grid').evaluate((el) => {
    el.scrollTop = 6000;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('#view-movies [data-grid-index="0"]')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-movies [data-grid-index="0"] .catalog-tile')).toHaveClass(/focused/);
});
