import { defineConfig, devices } from '@playwright/test';

// The preview server (scripts/serve.mjs) listens on port 3000.
const baseURL = 'http://localhost:3000';

// End-to-end tests drive the real app in headless Chromium (close to the
// legacy webOS Chromium engine). The preview harness builds the app and serves
// dist/ on baseURL.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { outputFolder: 'test-output/report', open: 'never' }]],
  // Per-test artifacts (traces, screenshots) — kept under the shared test-output/ folder.
  outputDir: 'test-output/results',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
  webServer: {
    command: 'npm run preview',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
