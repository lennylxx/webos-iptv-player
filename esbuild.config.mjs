import * as esbuild from 'esbuild';
import { cpSync, readFileSync, writeFileSync, readdirSync, appendFileSync, rmSync, mkdirSync } from 'fs';
import postcss from 'postcss';
import { scanBundle, formatViolations } from './scripts/compat-gate.mjs';

const isWatch = process.argv.includes('--watch');
const isPreview = process.argv.includes('--preview');
// Read version from package.json (single source of truth)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;

// Sync version to appinfo.json
const appinfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));
if (appinfo.version !== version) {
  appinfo.version = version;
  writeFileSync('appinfo.json', JSON.stringify(appinfo, null, 2) + '\n');
}

// Build the flex-`gap` fallback appended to legacy-webos.css (see that file's
// header for the rationale). For each top-level flex container that sets `gap`,
// emit a `> * + *` margin on the main axis: column → margin-top, row → margin-left.
function generateGapFallback(srcDir) {
  const rules = [];
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith('.css')) continue;
    postcss.parse(readFileSync(`${srcDir}/${file}`, 'utf8')).walkRules((rule) => {
      if (rule.parent.type !== 'root') return; // skip @media/@supports-nested rules
      let gap;
      let column = false;
      rule.walkDecls((decl) => {
        if (decl.prop === 'flex-direction' && decl.value.trim().startsWith('column')) column = true;
        if (decl.prop === 'gap' || decl.prop === 'row-gap' || decl.prop === 'column-gap') gap = decl.value.trim();
      });
      if (!gap) return;
      const margin = column ? 'margin-top' : 'margin-left';
      // Expand grouped selectors so the child combinator binds to each one.
      const selector = rule.selector.split(',').map((s) => `${s.trim()} > * + *`).join(', ');
      rules.push(`  ${selector} { ${margin}: ${gap}; }`);
    });
  }
  return `\n/* AUTO-GENERATED from source \`gap\` declarations (esbuild.config.mjs) — do not edit. */\n@supports not (inset: 0) {\n${rules.join('\n')}\n}\n`;
}

// Copy static assets to dist. The source HTML is the production/webOS version;
// preview builds swap only the platform library at build time.
mkdirSync('dist', { recursive: true });
const indexHtml = readFileSync('index.html', 'utf8');
const outputIndexHtml = isPreview
  ? indexHtml.replace('src="webOSjs/webOS.js"', 'src="js/preview-libs.js"')
  : indexHtml;
if (isPreview && outputIndexHtml === indexHtml) {
  throw new Error('Preview build could not find the webOS platform script in index.html.');
}
writeFileSync('dist/index.html', outputIndexHtml);
cpSync('appinfo.json', 'dist/appinfo.json');
rmSync('dist/resources', { recursive: true, force: true });
cpSync('resources', 'dist/resources', { recursive: true });
cpSync('css', 'dist/css', { recursive: true });
// Append the generated flex-`gap` fallback to legacy-webos.css (loaded last).
appendFileSync('dist/css/legacy-webos.css', generateGapFallback('css'));
cpSync('webOSjs/webOS.js', 'dist/webOSjs/webOS.js');
cpSync('assets/icon80.png', 'dist/icon.png');
cpSync('assets/icon130.png', 'dist/largeIcon.png');
cpSync('assets/group-icons', 'dist/assets/group-icons', { recursive: true });

// Main app bundle — excludes hls.js and mpegts.js (only needed on desktop).
const serviceId = JSON.parse(readFileSync('bundled-service/src/services.json', 'utf8')).id;
const define = {
  '__APP_VERSION__': JSON.stringify(version),
  '__APP_ID__': JSON.stringify(appinfo.id),
  '__SERVICE_ID__': JSON.stringify(serviceId),
  '__ENABLE_PSEUDO_LOCALE__': JSON.stringify(isPreview),
};
// Target Chromium 68 — the engine on webOS 5. This down-levels ES2020+
// syntax (`?.`, `??`, etc.) which would otherwise fail to parse on
// webOS 5/6 and leave the app stuck on the loading screen.
const TARGET = ['chrome68'];

// Shared config for the main app bundle (src/app.ts). The shipped build, the
// compat-gate scan, and the dev watch rebuild all use this; they differ only in
// minify / sourcemap / write.
const appBuild = {
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'dist/js/app.js',
  format: 'iife',
  target: TARGET,
  external: ['hls.js', 'mpegts.js'],
  define,
};

if (isWatch) {
  // Dev watch: rebuild unminified with sourcemaps on every change. Owns the
  // app bundle in watch mode — no separate one-shot build.
  const ctx = await esbuild.context({ ...appBuild, minify: false, sourcemap: true });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  // Shipped app bundle → dist/js/app.js (minified, goes into the IPK).
  await esbuild.build({ ...appBuild, minify: true });

  // webOS 5 (Chromium 68) bundle compat gate. Down-leveling handles post-68
  // *syntax*, but not *APIs* — and dependencies get bundled in without passing
  // through the eslint source gate. Scan a NON-minified build of the same entry
  // (same tree-shaken graph, readable identifiers) for banned APIs.
  const scan = await esbuild.build({ ...appBuild, minify: false, write: false });
  const violations = scanBundle(scan.outputFiles[0].text);
  if (violations.length > 0) {
    throw new Error(formatViolations(violations));
  }
  console.log('Compat gate: bundle is Chromium-68 clean.');
}

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
