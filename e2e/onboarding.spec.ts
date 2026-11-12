import { test, expect, routePlaylist, seedPlaylist, liveLoaded } from './helpers';

// App bootstrap / first run.

test('opens settings on first run when no playlist is configured', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('playlist');
});

test('loads and renders channels from a configured playlist', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);

  await page.goto('/');

  await liveLoaded(page);
  await expect(page.getByText('Channel One')).toBeVisible();
  await expect(page.getByText('Channel Two')).toBeVisible();
});
