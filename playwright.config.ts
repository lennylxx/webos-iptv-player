import { createHash } from 'crypto';
import { defineConfig, devices } from '@playwright/test';
import type { E2EOptions } from './e2e/helpers';
import { LEGACY_HEADER } from './scripts/chromium-53-simulation.mjs';

// A port of this worktree's own, so E2E runs in parallel worktrees never
// meet on one server.
const worktreePort = 3100
  + parseInt(createHash('sha1').update(__dirname).digest('hex').slice(0, 8), 16) % 900;

const list = (value: string | undefined): string[] | null =>
  value ? value.split(',').map((item) => item.trim()) : null;

// Every environment variable the E2E run reads, here and nowhere else; specs
// import what they need from this file.
export const E2E_ENV = {
  ci: !!process.env.CI,
  // The E2E server's port: E2E_PORT=<port>, or one derived from the
  // worktree's path.
  port: Number(process.env.E2E_PORT) || worktreePort,
  // E2E_CPU_THROTTLE=4 runs pages at a quarter speed, to find tests that only
  // pass on a fast machine.
  cpuThrottle: Number(process.env.E2E_CPU_THROTTLE) || 1,
  // RING_AUDIT=<file> also records screens without a focus ring (helpers.ts).
  ringAuditFile: process.env.RING_AUDIT,
  // NAV_REPORT=1 prints each navigation sweep's findings.
  navReport: !!process.env.NAV_REPORT,
  // FOCUS_FUZZ=1 adds the focus fuzz walk (`npm run test:fuzz`); the rest
  // steer it, see the top of focus-fuzz.spec.ts.
  fuzz: !!process.env.FOCUS_FUZZ,
  fuzzReplay: process.env.FOCUS_FUZZ_REPLAY,
  fuzzSteps: Number(process.env.FOCUS_FUZZ_STEPS) || 0,
  fuzzSeeds: list(process.env.FOCUS_FUZZ_SEED)?.map(Number) ?? null,
  fuzzSurfaces: list(process.env.FOCUS_FUZZ_SURFACE),
  fuzzContinue: process.env.FOCUS_FUZZ_CONTINUE === '1',
};

const baseURL = `http://localhost:${E2E_ENV.port}`;

// End-to-end tests drive the real app in headless Chromium (close to the
// legacy webOS Chromium engine). The preview harness builds the app and serves
// dist/ on baseURL.
export default defineConfig<E2EOptions>({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: E2E_ENV.ci,
  retries: E2E_ENV.ci ? 2 : 0,
  reporter: E2E_ENV.ci ? 'list' : [['list'], ['html', { outputFolder: 'test-output/report', open: 'never' }]],
  // Per-test artifacts (traces, screenshots) — kept under the shared test-output/ folder.
  outputDir: 'test-output/results',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // The time zone CI runs in, so a test sees the same day on every machine.
    timezoneId: 'UTC',
    cpuThrottle: E2E_ENV.cpuThrottle,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
    // The same suite against a simulated webOS 4 engine, degraded on two axes, both from scripts/chromium-53-simulation.mjs:
    // - CSS: the preview server rewrites each stylesheet through simulateLegacyEngine() — legacy fallbacks on, post-53 syntax dropped.
    // - JS: removeApis() deletes every API newer than Chromium 53 before the app loads.
    {
      name: 'chromium-53-simulation',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        extraHTTPHeaders: { [LEGACY_HEADER]: '1' },
      },
    },
  ],
  // A fresh build every run: a server already on the port, such as one an
  // aborted run left, fails the run rather than serving an old build.
  webServer: {
    command: 'node esbuild.config.mjs --preview && node scripts/serve.mjs',
    // serve.mjs reads its port as `npm run preview` gives it.
    env: { PREVIEW_PORT: String(E2E_ENV.port) },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
