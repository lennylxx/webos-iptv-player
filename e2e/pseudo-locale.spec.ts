import {
  test,
  expect,
  enterTab,
  routePlaylist,
  seedPlaylist,
  SEARCH_M3U,
  type Page,
} from './helpers';

async function textOverflow(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => {
      const el = element as HTMLElement;
      const style = getComputedStyle(el);
      return el.getClientRects().length > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
    })
    .filter((element) => {
      const el = element as HTMLElement;
      return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    })
    .map((element) => {
      const el = element as HTMLElement;
      return `${el.className || el.tagName}: ${el.textContent?.trim() ?? ''}`;
    }));
}

test('expands localized channel navigation without clipping', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');

  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(page.locator('.tab-bar-item[data-section="live"]')).toContainText('[!!');
  expect(await textOverflow(page, [
    '.tab-bar-item',
    '.channel-count',
  ].join(','))).toEqual([]);
  await expect(page.locator('.group-name').first()).toHaveCSS('text-overflow', 'ellipsis');
});

test('keeps pseudo-localized Settings controls within their boxes', async ({ page }) => {
  await routePlaylist(page, SEARCH_M3U);
  await seedPlaylist(page);
  await page.goto('/?pseudo=1');
  await enterTab(page, 'settings');
  await expect(page.locator('#view-settings')).toBeVisible();

  expect(await textOverflow(page, [
    '#view-settings h2',
    '#view-settings h3',
    '#view-settings label',
    '#view-settings .btn',
    '#view-settings .toggle-option',
    '#view-settings .dropdown-trigger',
  ].join(','))).toEqual([]);

  await page.locator('#app-language [data-dropdown-trigger]').click();
  await expect(page.locator('#app-language [data-dropdown-value="en"]')).toBeVisible();
  await expect(page.locator('#app-language [data-dropdown-value="en-XA"]')).toHaveCount(0);
});
