import { test, expect, routePlaylist, seedPlaylist, enterTab } from './helpers';

test('switching through every language refreshes cached Recently Watched labels', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');

  const recentLabel = page.locator(
    '[data-group="builtin:recently-watched"] .group-name',
  );
  await expect(recentLabel).toHaveText('Recently Watched');

  const locales = [
    ['de', 'Zuletzt angesehen'],
    ['es', 'Vistos recientemente'],
    ['fr', 'Vus récemment'],
    ['it', 'Visti di recente'],
    ['pt-BR', 'Assistidos recentemente'],
    ['ru', 'Недавно просмотренные'],
    ['uk', 'Нещодавно переглянуті'],
    ['zh-CN', '最近观看'],
    ['en', 'Recently Watched'],
  ];
  for (const [locale, label] of locales) {
    await enterTab(page, 'settings');
    await page.locator('#app-language .dropdown-trigger').click();
    await page.locator(`#app-language [data-dropdown-value="${locale}"]`).click();
    await page.locator('#save-settings').click();
    await expect(recentLabel).toHaveText(label);
  }
});
