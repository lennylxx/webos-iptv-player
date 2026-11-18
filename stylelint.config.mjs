// webOS 4 ships Chromium 53. This gate fails the build when CSS uses a feature
// that engine lacks. The target is read from the "browserslist" field in
// package.json (Chromium 53), shared with the JS gate (eslint-plugin-compat).
//
// `ignore` lists caniuse feature names we knowingly accept — either because we
// provide a build-time fallback (e.g. the generated flex-gap margins), or because
// they degrade gracefully on Chromium 53.
import stylelint from 'stylelint';
import { isPost53Selector, splitSelectorList } from './scripts/chromium-53-simulation.mjs';
import { isLoweredModernRgb } from './scripts/css-transforms.mjs';

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

// Chromium 53 parses only the comma form of rgb()/hsl(): `rgb(0 0 0 / 0.5)`
// is dropped as invalid on webOS 4. The build lowers the var form
// `rgb(var(--x-rgb) / a)` (scripts/css-transforms.mjs), but not literal values.
const spaceColorRule = 'iptv/no-space-separated-color';
const spaceColorMessages = stylelint.utils.ruleMessages(spaceColorRule, {
  rejected: (color, example) => `"${color}" needs Chromium > 53; write it comma-separated (${example})`,
});
const COMMA_EXAMPLES = { rgb: 'rgba(0, 0, 0, 0.5)', hsl: 'hsla(0, 0%, 0%, 0.5)' };
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
const IDENT_CHAR_RE = /[\w-]/;
// The build's comma-form companion of a --*-rgb property (css-transforms.mjs).
const LEGACY_VAR_RE = /^var\(--[\w-]+-legacy\)$/;

function skipString(value, i) {
  const quote = value[i];
  for (i += 1; i < value.length && value[i] !== quote; i += 1) if (value[i] === '\\') i += 1;
  return i;
}

// Index of the ')' closing the '(' at `open`, or -1 when unbalanced.
function matchParen(value, open) {
  let depth = 0;
  for (let i = open; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"' || ch === "'") i = skipString(value, i);
    else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function* colorCalls(value) {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      i = skipString(value, i);
      continue;
    }
    if (!/[a-z]/i.test(ch) || (i > 0 && IDENT_CHAR_RE.test(value[i - 1]))) continue;
    let end = i;
    while (end < value.length && IDENT_CHAR_RE.test(value[end])) end += 1;
    const name = value.slice(i, end).toLowerCase();
    i = end - 1;
    if (value[end] !== '(') continue;
    const close = matchParen(value, end);
    if (close < 0) return;
    if (name === 'url') i = close;
    else if (COLOR_FUNCTIONS.has(name)) {
      yield { call: value.slice(end - name.length, close + 1), name, args: value.slice(end + 1, close) };
    }
  }
}

function hasTopLevelComma(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '"' || ch === "'") i = skipString(args, i);
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

function isLegacyColorCall({ call, args }) {
  const trimmed = args.trim();
  return !trimmed || hasTopLevelComma(trimmed) || LEGACY_VAR_RE.test(trimmed) || isLoweredModernRgb(call);
}

const noSpaceSeparatedColor = (primary) => (root, result) => {
  if (!stylelint.utils.validateOptions(result, spaceColorRule, { actual: primary })) return;
  root.walkDecls((decl) => {
    for (const color of colorCalls(decl.value)) {
      if (isLegacyColorCall(color)) continue;
      stylelint.utils.report({
        result,
        ruleName: spaceColorRule,
        node: decl,
        word: color.call,
        message: spaceColorMessages.rejected(color.call, COMMA_EXAMPLES[color.name.slice(0, 3)]),
      });
    }
  });
};
noSpaceSeparatedColor.ruleName = spaceColorRule;
noSpaceSeparatedColor.messages = spaceColorMessages;

export const noSpaceSeparatedColorPlugin = stylelint.createPlugin(spaceColorRule, noSpaceSeparatedColor);

export default {
  plugins: ['stylelint-no-unsupported-browser-features', noMixedLegacySelectorPlugin, noSpaceSeparatedColorPlugin],
  rules: {
    'iptv/no-mixed-legacy-selector': true,
    'iptv/no-space-separated-color': true,
    'plugin/no-unsupported-browser-features': [
      true,
      {
        severity: 'error',
        ignore: [
          // Flex gap gets a margin-based fallback generated at build time,
          // keyed to html.q-no-flex-gap, and written to legacy-webos-base.css
          // (see esbuild.config.mjs).
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
          // Degrades gracefully: every backdrop-filter has a >=75% opaque background
          // fallback, so panels lose only the frosted blur, not legibility.
          'css-backdrop-filter',
        ],
      },
    ],
  },
};
