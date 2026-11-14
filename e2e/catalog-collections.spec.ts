import { test, expect, enterTab, readUserDataStore, type Page } from './helpers';
import { seedXtream } from './fixtures/xtream';
import { THEMES } from '../src/config/themes';
import type { ResumeEntry, WatchlistEntry } from '../src/types';

async function seedCollections(page: Page, count = 30): Promise<void> {
  await seedXtream(page);
  await page.route('http://host/poster/**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="330"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#304b62"/><stop offset="1" stop-color="#10202e"/></linearGradient></defs><path fill="url(#a)" d="M0 0h220v330H0z"/><circle cx="155" cy="95" r="55" fill="#c8a267"/><path d="m0 280 100-150 120 170v30H0" fill="#122334"/></svg>',
  }));
  await page.addInitScript(n => {
    if (localStorage.getItem('collection_fixture')) return;
    localStorage.setItem('collection_fixture', '1');
    const watchlist: Record<string, WatchlistEntry> = {};
    const resume: Record<string, ResumeEntry> = {};
    for (const accountId of ['x1', 'x2']) {
      for (const kind of ['vod', 'series'] as const) {
        for (let i = 0; i < (accountId === 'x1' ? n : 1); i++) {
          const itemId = `${kind}${i}`;
          watchlist[`${accountId}|${kind}|${itemId}`] = {
            accountId, kind, itemId, name: `Title ${i}`, poster: `http://host/poster/${i}`,
            rating: '', categoryId: kind === 'vod' ? '1' : '2', containerExtension: 'mp4', addedAt: n - i,
          };
        }
      }
      for (const kind of ['vod', 'episode'] as const) {
        for (let i = 0; i < (accountId === 'x1' ? Math.min(n, 50) : 1); i++) {
          const itemId = `${kind}${i}`;
          resume[`${accountId}|${kind}|${itemId}`] = {
            accountId, kind, itemId, name: `Title ${i}`, poster: `http://host/poster/${i}`, ext: 'mp4',
            categoryId: kind === 'vod' ? '1' : '2', position: 100, duration: 600, updatedAt: n - i,
          };
        }
      }
    }
    localStorage.setItem('iptv_watchlist', JSON.stringify(watchlist));
    localStorage.setItem('iptv_resume', JSON.stringify(resume));
  }, count);
}

const layer = (page: Page, section = 'movies') =>
  page.locator(`#view-${section} .catalog-layer-grid`);

for (const section of ['movies', 'series'] as const) {
  for (const collection of ['continue', 'watchlist'] as const) {
    test(`${section} ${collection}: counted preview, independent removal, and remote navigation`, async ({ page }) => {
      await seedCollections(page);
      await page.goto('/');
      await enterTab(page, section);
      const rail = page.locator(`#view-${section} [data-rail-key="${collection}"]`);
      await expect(rail.locator('.catalog-tile:not(.catalog-see-all)')).toHaveCount(20);
      await expect(rail.locator('.catalog-see-all-count')).toContainText('30');
      await rail.locator('[data-collection-see-all]').click();
      const grid = layer(page, section);
      await expect(grid.locator('.catalog-grid-title')).toContainText('30');
      if (section === 'series' && collection === 'continue') {
        await expect(grid.locator('.catalog-grid-count')).toHaveText('30 series');
      }
      await expect(grid.locator('.catalog-sort')).toHaveCount(0);
      await grid.locator('[data-collection-action="manage"]').click();
      await expect(grid.locator('.catalog-tile[data-focusable]')).toHaveCount(0);
      const removes = grid.locator('[data-collection-action="remove"]');
      await removes.first().hover();
      await expect(removes.first()).toHaveClass(/focused/);
      await grid.locator('.catalog-poster').first().click({ position: { x: 50, y: 180 } });
      await expect(grid.locator('.catalog-grid-count')).toContainText('30');
      await expect(removes).toHaveCount(30);
      await removes.first().click();
      await expect(grid.locator('.catalog-grid-count')).toContainText('29');
      await removes.first().hover();
      await page.keyboard.press('ArrowRight');
      await expect(removes.nth(1)).toHaveClass(/focused/);
      await page.keyboard.press('Enter');
      await expect(grid.locator('.catalog-grid-count')).toContainText('28');
      await expect(removes.nth(1)).toHaveClass(/focused/);
      await page.keyboard.press('Escape');
      await expect(removes).toHaveCount(0);
      await expect(grid.locator('[data-collection-action="manage"]')).toHaveClass(/focused/);
      await page.keyboard.press('Escape');
      await expect(rail.locator('[data-collection-manage]')).toBeVisible();
      const store = collection === 'continue' ? 'playback-progress' : 'watchlist';
      const kind = section === 'movies' ? 'vod' : collection === 'continue' ? 'episode' : 'series';
      await expect.poll(async () => (await readUserDataStore<ResumeEntry | WatchlistEntry>(page, store))
        .filter(row => row.value.accountId === 'x1' && row.value.kind === kind).length).toBe(28);
      await page.reload();
      await enterTab(page, section);
      await expect(rail.locator('.catalog-see-all-count')).toContainText('28');
    });
  }
}

test('clears only the visible account and kind, preserves the other collection, and cancels safely', async ({ page }) => {
  await seedCollections(page);
  await page.goto('/');
  await enterTab(page, 'movies');
  await page.locator('#view-movies [data-collection-manage="watchlist"]').click();
  const grid = layer(page);
  await grid.locator('[data-collection-action="clear"]').click();
  const prompt = page.locator('.confirmation-prompt:not(.hidden)');
  await expect(prompt).toContainText('X Account');
  await expect(prompt).toContainText('(Movies)');
  await expect(prompt.locator('[data-confirm-action="cancel"]')).toHaveClass(/focused/);
  await expect(grid.locator('.focused')).toHaveCount(0);
  await page.mouse.move(200, 300);
  await expect(grid.locator('.focused')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(grid.locator('.catalog-grid-count')).toContainText('30');
  await expect(grid.locator('[data-collection-action="clear"]')).toHaveClass(/focused/);
  await grid.locator('[data-collection-action="clear"]').click();
  await prompt.locator('[data-confirm-action="confirm"]').click();
  await expect(page.locator('#view-movies [data-rail-key="watchlist"]')).toHaveCount(0);
  await expect.poll(async () => {
    const rows = await readUserDataStore<WatchlistEntry>(page, 'watchlist');
    return rows.filter(row => row.value.accountId === 'x1' && row.value.kind === 'vod').length;
  }).toBe(0);
  const rows = await readUserDataStore<WatchlistEntry>(page, 'watchlist');
  expect(rows.filter(row => row.value.accountId === 'x1' && row.value.kind === 'series')).toHaveLength(30);
  expect(rows.filter(row => row.value.accountId === 'x2')).toHaveLength(2);
  expect(await readUserDataStore(page, 'playback-progress')).toHaveLength(62);
  await expect(page.locator('#view-movies [data-rail-key="continue"] .catalog-tile')).toHaveCount(21);
});

for (const section of ['movies', 'series'] as const) {
  test(`${section}: returns to the same collection title after playback changes its order`, async ({ page }) => {
    await seedCollections(page);
    await page.goto('/');
    await enterTab(page, section);
    await page.locator(`#view-${section} [data-rail-key="continue"] [data-collection-see-all]`).click();
    const grid = layer(page, section);
    const tile = grid.locator('.catalog-tile').nth(1);
    const key = await tile.getAttribute('data-key');
    await tile.click();
    if (section === 'movies') await page.locator('#view-movies [data-action="resume"]').click();
    await expect(page.locator('#view-player')).toBeVisible();
    await page.locator('#video-player').evaluate(video => {
      Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
      Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 200 });
    });
    await page.keyboard.press('Escape');
    if (section === 'movies') await page.keyboard.press('Escape');
    await expect(grid.locator('.catalog-tile').first()).toHaveAttribute('data-key', key!);
    await expect(grid.locator('.catalog-tile.focused')).toHaveAttribute('data-key', key!);
  });
}

test('returns to a neighboring browse episode after completing direct playback', async ({ page }) => {
  await seedCollections(page, 4);
  await page.goto('/');
  await enterTab(page, 'series');
  const rail = page.locator('#view-series [data-rail-key="continue"]');
  await rail.locator('[data-resume-episode="episode2"]').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate(video => {
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 599 });
  });
  await page.keyboard.press('Escape');
  await expect(rail.locator('[data-resume-episode="episode2"]')).toHaveCount(0);
  await expect(rail.locator('.focused')).toHaveAttribute('data-key', 'r:episode3');
});

for (const collection of ['continue', 'watchlist'] as const) {
  test(`leaves an emptied ${collection} grid after removing its final movie from detail`, async ({ page }) => {
    await seedCollections(page, 1);
    await page.goto('/');
    await enterTab(page, 'movies');
    await page.locator(`#view-movies [data-collection-manage="${collection}"]`).click();
    await page.keyboard.press('Escape');
    const grid = layer(page);
    await grid.locator('.catalog-tile').click();
    const action = page.locator(`#view-movies [data-action="${collection === 'continue' ? 'remove-resume' : 'watchlist'}"]`);
    await action.click();
    if (collection === 'continue') await expect(action).toHaveCount(0);
    else await expect(action).toContainText('Add to Watchlist');
    await page.keyboard.press('Escape');
    await expect(grid).toBeEmpty();
    await expect(page.locator(`#view-movies [data-rail-key="${collection}"]`)).toHaveCount(0);
    await expect(page.locator('#view-movies .catalog-layer-browse .focused')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#view-movies .catalog-layer-browse .focused')).toHaveCount(1);
  });
}

test('leaves an emptied collection after completing its final episode', async ({ page }) => {
  await seedCollections(page, 1);
  await page.goto('/');
  await enterTab(page, 'series');
  await page.locator('#view-series [data-collection-manage="continue"]').click();
  await page.keyboard.press('Escape');
  const grid = layer(page, 'series');
  await grid.locator('.catalog-tile').click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.locator('#video-player').evaluate(video => {
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 600 });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 599 });
  });
  await page.keyboard.press('Escape');
  await expect(grid).toBeEmpty();
  await expect(page.locator('#view-series [data-rail-key="continue"]')).toHaveCount(0);
  await expect(page.locator('#view-series .catalog-layer-browse .focused')).toHaveCount(1);
});

test('refreshes concealed collection counts when the unlock session expires without moving Settings focus', async ({ page }) => {
  await seedCollections(page, 1);
  await page.goto('/');
  await enterTab(page, 'settings');
  await page.locator('#manage-parental-controls').click();
  const prompt = page.locator('.parental-pin-prompt');
  await prompt.locator('.parental-pin-input').fill('1234');
  await expect(prompt.locator('h2')).toContainText('Confirm');
  await prompt.locator('.parental-pin-input').fill('1234');
  const manager = page.locator('#view-parental-controls');
  await expect(manager).toBeVisible();
  await manager.locator('#parental-kind [data-value="vod"]').click();
  const category = manager.locator('[data-parental-group]').filter({ hasText: 'Cat A' });
  await category.click();
  await expect(category).toContainText('Locked');
  await manager.locator('[data-parental-tab="options"]').click();
  await manager.locator('#parental-conceal [data-value="hide-locked"]').click();
  await expect(manager.locator('#parental-duration .active')).toHaveAttribute('data-value', '5-minutes');
  await page.clock.install();
  await manager.locator('[data-parental-back]').click();
  await expect(page.locator('#view-settings')).toBeVisible();
  const resumeHint = page.locator('#continue-watching-count-hint');
  const watchlistHint = page.locator('#watchlist-count-hint');
  await expect(resumeHint).toContainText('(2)');
  await expect(watchlistHint).toContainText('(2)');
  const clear = page.locator('#clear-continue-watching');
  await clear.hover();
  await expect(clear).toHaveClass(/focused/);
  const button = await clear.elementHandle();

  await page.clock.fastForward(5 * 60 * 1000 + 1);
  await expect(page.locator('[data-lock-now]')).toHaveCount(0);
  await expect(resumeHint).not.toContainText(/\(\d+\)/);
  await expect(watchlistHint).not.toContainText(/\(\d+\)/);
  await expect(clear).toHaveClass(/focused/);
  expect(await button!.evaluate(element => element === document.querySelector('#clear-continue-watching'))).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-settings .focused')).toHaveCount(1);
});

test('keeps one ring through virtualized deletion, tab-bar handoff, and management exit', async ({ page }) => {
  await seedCollections(page, 200);
  await page.goto('/');
  await enterTab(page, 'movies');
  await page.locator('#view-movies [data-collection-manage="watchlist"]').click();
  const grid = layer(page);
  await grid.locator('[data-collection-action="remove"]').first().hover();
  for (let i = 0; i < 32; i++) await page.keyboard.press('ArrowDown');
  await expect(grid.locator('.catalog-remove-mark.focused')).toHaveAttribute('data-key', 'w:vod196');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(grid.locator('.catalog-remove-mark.focused')).toHaveAttribute('data-key', 'w:vod199');
  expect(await grid.locator('.catalog-remove-mark').count()).toBeLessThan(50);
  await page.keyboard.press('Enter');
  await expect(grid.locator('.catalog-remove-mark.focused')).toHaveAttribute('data-key', 'w:vod198');
  await page.keyboard.press('Escape');
  await expect(grid.locator('[data-collection-action="manage"]')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.tab-bar-item.focused')).toHaveCount(1);
  await expect(grid.locator('.focused')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('[data-collection-action="manage"]')).toHaveClass(/focused/);
});

test('leaves a managed collection where each spaced wheel step stops it', async ({ page }) => {
  await seedCollections(page, 35);
  await page.goto('/');
  await enterTab(page, 'series');
  await page.locator('#view-series [data-collection-manage="continue"]').click();
  const grid = layer(page, 'series');
  const view = grid.locator('.catalog-grid.catalog-managing');
  await expect(view).toBeVisible();
  await page.mouse.move(700, 600);
  // Only the wheel may move the grid while the pointer rests.
  await view.evaluate(el => {
    const writes: string[] = [];
    (window as unknown as { gridWrites: string[] }).gridWrites = writes;
    const top = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return top.get!.call(el) as number; },
      set(value: number) { writes.push(`scrollTop=${String(value)}`); top.set!.call(el, value); },
    });
    const reveal = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
      writes.push('scrollIntoView');
      return reveal.apply(this, args as []);
    };
  });
  const scrollTop = () => view.evaluate(el => el.scrollTop);
  const max = await view.evaluate(el => el.scrollHeight - el.clientHeight);
  let expected = 0;
  const steps = [80, 80, 80, 80, -80, 80, -80, -80];
  for (let i = 0; i < steps.length || expected < max; i++) {
    const step = steps[i] ?? 80;
    expected = Math.max(0, Math.min(max, expected + step));
    await page.mouse.wheel(0, step);
    await expect.poll(scrollTop).toBe(expected);
    // Longer than any settle delay, so a late correction would show.
    await page.waitForTimeout(250);
    expect(await scrollTop()).toBe(expected);
  }
  expect(expected).toBe(max);
  expect(await page.evaluate(() => (window as unknown as { gridWrites: string[] }).gridWrites)).toEqual([]);
  expect(await grid.locator('.focused').count()).toBeLessThanOrEqual(1);
});

test('rejects a full Watchlist without replacing saved titles and shows an actionable message', async ({ page }) => {
  await seedCollections(page, 200);
  await page.goto('/');
  await enterTab(page, 'movies');
  await page.locator('#view-movies [data-rail-key="cat:1"] .catalog-tile').first().click();
  await page.locator('#view-movies [data-action="watchlist"]').click();
  await expect(page.locator('.toast').filter({ hasText: 'Watchlist is full' })).toBeVisible();
  await expect(page.locator('#view-movies [data-action="watchlist"]')).toContainText('Add to Watchlist');
  const rows = await readUserDataStore<WatchlistEntry>(page, 'watchlist');
  expect(rows.filter(row => row.value.accountId === 'x1' && row.value.kind === 'vod')).toHaveLength(200);
  expect(rows.some(row => row.value.itemId === 'vod199')).toBe(true);
  expect(rows.some(row => row.value.itemId === '10')).toBe(false);
});

test('offers management for a single title and returns to browse after its removal', async ({ page }) => {
  await seedCollections(page, 1);
  await page.goto('/');
  await enterTab(page, 'series');
  const rail = page.locator('#view-series [data-rail-key="continue"]');
  await expect(rail.locator('.catalog-see-all')).toHaveCount(0);
  await rail.locator('[data-collection-manage]').click();
  await layer(page, 'series').locator('[data-collection-action="remove"]').click();
  await expect(rail).toHaveCount(0);
  await expect(page.locator('#view-series .catalog-layer-browse')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-series .catalog-layer-browse .focused')).toHaveCount(1);
});

test('keeps the independent red-and-white remove icon aligned in every theme and text size', async ({ page }, testInfo) => {
  await seedCollections(page);
  await page.goto('/?pseudo=1');
  await enterTab(page, 'movies');
  await page.locator('#view-movies [data-collection-manage="continue"]').click();
  const grid = layer(page);
  await expect(page.locator('.toast.visible')).toHaveCount(0);
  for (const theme of THEMES) {
    for (const size of ['80', '100', '150']) {
      await page.evaluate(({ theme, size }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.textSize = size;
      }, { theme: theme.id, size });
      const remove = grid.locator('[data-collection-action="remove"]').first();
      await remove.hover();
      const style = await remove.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const clear = document.querySelector<HTMLElement>('.catalog-layer-grid:not(.catalog-layer-hidden) [data-collection-action="clear"]')!;
        const label = clear.querySelector('span:last-child')!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const posters = button.closest('.catalog-grid')!.querySelectorAll('.catalog-grid-cell');
        const posterRight = posters[6].getBoundingClientRect().right;
        return {
          width: rect.width, height: rect.height,
          fill: getComputedStyle(button.querySelector('circle')!).fill,
          stroke: getComputedStyle(button.querySelector('path')!).stroke,
          danger: getComputedStyle(clear.querySelector('.catalog-action-icon')!).color,
          background: getComputedStyle(button).backgroundColor,
          shadow: getComputedStyle(button).boxShadow,
          alignment: range.getBoundingClientRect().right - posterRight,
          clipping: clear.scrollWidth - clear.clientWidth,
        };
      });
      expect(style.width).toBe(44);
      expect(style.height).toBe(44);
      expect(style.fill).toBe(style.danger);
      expect(style.stroke).toBe('rgb(255, 255, 255)');
      expect(style.background).toBe('rgba(0, 0, 0, 0)');
      expect(style.shadow).toBe('none');
      expect(Math.abs(style.alignment)).toBeLessThanOrEqual(1);
      expect(style.clipping).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`${theme.id}-${size}-collection-management.png`) });
      await page.mouse.move(1900, 500);
      await expect(remove).not.toHaveClass(/focused/);
    }
  }
});
