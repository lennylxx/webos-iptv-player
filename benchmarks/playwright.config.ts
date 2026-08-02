import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:3000';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  outputDir: '../test-output/benchmark-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 1920, height: 1080 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'npm run preview',
    cwd: '..',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
