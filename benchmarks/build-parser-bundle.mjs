import * as esbuild from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import {
  LEGACY_JS_BANNER,
  formatViolations,
  scanBundle,
} from '../scripts/compat-gate.mjs';

const outfile = 'test-output/benchmarks/parser-bundle.js';
const appinfo = JSON.parse(await readFile('appinfo.json', 'utf8'));
const service = JSON.parse(await readFile('bundled-service/src/services.json', 'utf8'));
const define = {
  __APP_ID__: JSON.stringify(appinfo.id),
  __APP_VERSION__: JSON.stringify('0.0.0-benchmark'),
  __SERVICE_ID__: JSON.stringify(service.id),
  __ENABLE_PSEUDO_LOCALE__: 'false',
};
await mkdir('test-output/benchmarks', { recursive: true });
await esbuild.build({
  entryPoints: ['benchmarks/parser-entry.ts'],
  bundle: true,
  outfile,
  format: 'iife',
  target: ['chrome53'],
  banner: { js: LEGACY_JS_BANNER },
  define,
  minify: true,
});
const scan = await esbuild.build({
  entryPoints: ['benchmarks/parser-entry.ts'],
  bundle: true,
  format: 'iife',
  target: ['chrome53'],
  banner: { js: LEGACY_JS_BANNER },
  define,
  minify: false,
  write: false,
});
const violations = scanBundle(scan.outputFiles[0].text);
if (violations.length > 0) throw new Error(formatViolations(violations));
console.log(`Built ${outfile}`);
