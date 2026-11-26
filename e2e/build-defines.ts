import { readFileSync } from 'node:fs';

// src/config.ts reads the constants esbuild defines at build time
// (esbuild.config.mjs); Playwright has no define step, so E2E sets them
// before helpers.ts loads CONFIG, as vitest.config.ts does for unit tests.
const g = globalThis as Record<string, unknown>;
g.__APP_ID__ = (JSON.parse(readFileSync('appinfo.json', 'utf8')) as { id: string }).id;
g.__APP_VERSION__ = '0.0.0-test';
g.__SERVICE_ID__ = (JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')) as { id: string }).id;
