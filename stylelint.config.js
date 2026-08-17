// webOS 4 ships Chromium 53. This gate fails the build when CSS uses a feature
// that engine lacks. The target is read from the "browserslist" field in
// package.json (Chromium 53), shared with the JS gate (eslint-plugin-compat).
//
// `ignore` lists caniuse feature names we knowingly accept — either because we
// provide a build-time fallback (e.g. the generated flex-gap margins), or because
// they degrade gracefully on Chromium 53.
module.exports = {
  plugins: ['stylelint-no-unsupported-browser-features'],
  rules: {
    'plugin/no-unsupported-browser-features': [
      true,
      {
        severity: 'error',
        ignore: [
          // Flex gap gets a margin-based fallback generated at build time and
          // appended to legacy-webos.css (see esbuild.config.mjs).
          'flexbox-gap',
          // legacy-webos.css supplies flex equivalents for every grid layout.
          'css-grid',
          // Only hidden/auto/scroll/visible + text-overflow:ellipsis are used —
          // all fully supported on 53. doiuse flags newer values we do not use.
          'css-overflow',
          // Sticky headings degrade to normal document flow on Chromium 53.
          'css-sticky',
          // These affect scrolling polish or input styling, not layout or control.
          'css-overflow-anchor',
          'css-placeholder',
          'css-scroll-behavior',
          // Focused classes cover remote navigation; the legacy stylesheet adds
          // a direct input-focus fallback for the remaining pointer-only field.
          'css-focus-within',
          // Chromium 53 ignores the query, so animations simply always run.
          'prefers-reduced-motion',
          // Degrades gracefully: every backdrop-filter has a >=75% opaque background
          // fallback, so panels lose only the frosted blur, not legibility.
          'css-backdrop-filter',
        ],
      },
    ],
  },
};
