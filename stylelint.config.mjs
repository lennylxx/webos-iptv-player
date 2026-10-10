// webOS 4 ships Chromium 53. This gate fails the build when CSS uses a feature
// that engine lacks. The target is read from the "browserslist" field in
// package.json (Chromium 53), shared with the JS gate (eslint-plugin-compat).
//
// `ignore` lists caniuse feature names we knowingly accept — either because we
// provide a build-time fallback (e.g. the generated flex-gap margins), or because
// they degrade gracefully on Chromium 53.
import stylelint from 'stylelint';
import { isPost53Selector, splitSelectorList } from './scripts/chromium-53-simulation.mjs';

// Chromium 53 drops a whole rule when its selector list holds a selector it
// cannot parse, taking the otherwise-valid selectors down with it — so
// `.x.focused, .x:focus-within { }` loses both on webOS 4. Modern-only
// selectors must sit in a rule of their own.
const mixedSelectorRule = 'iptv/no-mixed-legacy-selector';
const mixedSelectorMessages = stylelint.utils.ruleMessages(mixedSelectorRule, {
  rejected: (selector) =>
    `"${selector}" needs Chromium > 53 and drops this whole rule on webOS 4; move it to its own rule`,
});

const noMixedLegacySelector = (primary) => (root, result) => {
  if (!stylelint.utils.validateOptions(result, mixedSelectorRule, { actual: primary })) return;
  root.walkRules((rule) => {
    const selectors = splitSelectorList(rule.selector);
    const modern = selectors.filter(isPost53Selector);
    if (modern.length === 0 || modern.length === selectors.length) return;
    for (const selector of modern) {
      stylelint.utils.report({
        result,
        ruleName: mixedSelectorRule,
        node: rule,
        word: selector,
        message: mixedSelectorMessages.rejected(selector),
      });
    }
  });
};
noMixedLegacySelector.ruleName = mixedSelectorRule;
noMixedLegacySelector.messages = mixedSelectorMessages;

export const noMixedLegacySelectorPlugin = stylelint.createPlugin(mixedSelectorRule, noMixedLegacySelector);

export default {
  plugins: ['stylelint-no-unsupported-browser-features', noMixedLegacySelectorPlugin],
  rules: {
    'iptv/no-mixed-legacy-selector': true,
    'plugin/no-unsupported-browser-features': [
      true,
      {
        severity: 'error',
        ignore: [
          // Flex gap gets a margin-based fallback generated at build time and
          // written to legacy-webos-base.css (see esbuild.config.mjs).
          'flexbox-gap',
          // legacy-webos-overrides.css supplies flex equivalents for every grid layout.
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
