import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { formatViolations, scanBundle } from '../scripts/compat-gate.mjs';

const outfile = 'test-output/benchmarks/parser-bundle.js';
await mkdir('test-output/benchmarks', { recursive: true });
await esbuild.build({
  entryPoints: ['benchmarks/parser-entry.ts'],
  bundle: true,
  outfile,
  format: 'iife',
  target: ['chrome68'],
  define: { __ENABLE_PSEUDO_LOCALE__: 'false' },
  minify: true,
});
const scan = await esbuild.build({
  entryPoints: ['benchmarks/parser-entry.ts'],
  bundle: true,
  format: 'iife',
  target: ['chrome68'],
  define: { __ENABLE_PSEUDO_LOCALE__: 'false' },
  minify: false,
  write: false,
});
const violations = scanBundle(scan.outputFiles[0].text);
if (violations.length > 0) throw new Error(formatViolations(violations));
console.log(`Built ${outfile}`);
