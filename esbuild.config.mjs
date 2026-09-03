import * as esbuild from 'esbuild';
import { cpSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import {
  LEGACY_JS_BANNER,
  scanBundle,
  formatViolations,
} from './scripts/compat-gate.mjs';
import {
  convertLegacyColorSyntax,
  generateFlexGapFallback,
  linkedStylesheets,
  scaleFontSizes,
} from './scripts/css-transforms.mjs';

const isPreview = process.argv.includes('--preview');
// Checked-in but regenerated on every build; never a source input.
const GENERATED_STYLESHEET = 'legacy-webos-base.css';
// Read version from package.json (single source of truth)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// Sync version to appinfo.json
const appinfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));
if (appinfo.version !== version) {
  appinfo.version = version;
  writeFileSync('appinfo.json', JSON.stringify(appinfo, null, 2) + '\n');
}

function transformStylesheets(outDir) {
  for (const file of readdirSync(outDir)) {
    if (!file.endsWith('.css')) continue;
    const path = `${outDir}/${file}`;
    const css = convertLegacyColorSyntax(readFileSync(path, 'utf8'));
    writeFileSync(path, scaleFontSizes(css));
  }
}

// Copy static assets to dist. The source HTML is the production/webOS version;
// preview builds swap only the platform library at build time.
mkdirSync('dist', { recursive: true });
const indexHtml = readFileSync('index.html', 'utf8');
const previewLibsMarker = '<!-- preview-libs -->';
const outputIndexHtml = indexHtml.replace(
  previewLibsMarker,
  isPreview ? '<script src="js/preview-libs.js"></script>' : '',
);
if (outputIndexHtml === indexHtml) {
  throw new Error('Build could not find the preview library marker in index.html.');
}
writeFileSync('dist/index.html', outputIndexHtml);
cpSync('appinfo.json', 'dist/appinfo.json');
rmSync('dist/resources', { recursive: true, force: true });
cpSync('resources', 'dist/resources', { recursive: true });
// Refresh the flex-`gap` fallback; see its header for the cascade rationale.
const sourceStylesheets = linkedStylesheets(indexHtml, readdirSync('css'), GENERATED_STYLESHEET)
  .map((file) => readFileSync(`css/${file}`, 'utf8'));
writeFileSync(`css/${GENERATED_STYLESHEET}`, generateFlexGapFallback(sourceStylesheets));
cpSync('css', 'dist/css', { recursive: true });
transformStylesheets('dist/css');
cpSync('assets/icon80.png', 'dist/icon.png');
cpSync('assets/icon130.png', 'dist/largeIcon.png');
cpSync('assets/group-icons', 'dist/assets/group-icons', { recursive: true });
cpSync('assets/icons', 'dist/assets/icons', { recursive: true });

// Main app bundle — excludes hls.js, mpegts.js and dashjs (only needed on desktop).
const serviceId = JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')).id;
const define = {
  '__APP_VERSION__': JSON.stringify(version),
  '__APP_ID__': JSON.stringify(appinfo.id),
  '__SERVICE_ID__': JSON.stringify(serviceId),
  '__ENABLE_PSEUDO_LOCALE__': JSON.stringify(isPreview),
};
// Target Chromium 53 — the engine on webOS 4. This down-levels newer
// syntax (`?.`, `??`, etc.) which would otherwise fail to parse on
// older TVs and leave the app stuck on the loading screen.
const TARGET = ['chrome53'];

// Shared config for the main app bundle (src/app.ts). The shipped build and
// compat-gate scan use the same tree-shaken graph.
const appBuild = {
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'dist/js/app.js',
  format: 'iife',
  target: TARGET,
  banner: { js: LEGACY_JS_BANNER },
  external: ['hls.js', 'mpegts.js', 'dashjs'],
  define,
};
const workerBuild = {
  entryPoints: ['src/workers/app-worker.ts'],
  bundle: true,
  outfile: 'dist/js/app-worker.js',
  format: 'iife',
  target: TARGET,
  banner: { js: LEGACY_JS_BANNER },
  define,
};
const shippedBuilds = [
  { name: 'app', config: appBuild },
  { name: 'worker', config: workerBuild },
];

// Shipped bundles (minified, both go into the IPK).
await Promise.all(shippedBuilds.map(({ config }) =>
  esbuild.build({ ...config, minify: true })));

// webOS 4 (Chromium 53) bundle compat gate. Down-leveling handles post-53
// *syntax*, but not *APIs* — and dependencies get bundled in without passing
// through the eslint source gate. Scan a NON-minified build of the same entry
// (same tree-shaken graph, readable identifiers) for banned APIs.
for (const { name, config } of shippedBuilds) {
  const scan = await esbuild.build({ ...config, minify: false, write: false });
  const violations = scanBundle(scan.outputFiles[0].text);
  if (violations.length > 0) {
    throw new Error(`${name} bundle:\n${formatViolations(violations)}`);
  }
}
console.log('Compat gate: app and worker bundles are Chromium-53 clean.');

// Desktop-only playback libraries. Production builds neither reference nor
// generate this bundle, so it cannot leak into the IPK.
if (isPreview) {
  await esbuild.build({
    entryPoints: ['src/preview-libs.ts'],
    bundle: true,
    outfile: 'dist/js/preview-libs.js',
    format: 'iife',
    target: TARGET,
    minify: true,
  });
} else {
  rmSync('dist/js/preview-libs.js', { force: true });
}

console.log('Build complete.');
