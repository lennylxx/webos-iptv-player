// Build-time CSS transforms consumed by esbuild.config.mjs.
//
// - Flex gap: generate sibling margins for webOS versions without flex gap.
// - Font scale: wrap pixel font sizes in the app-wide --font-scale variable.
// - Legacy colors: convert modern rgb(var(...) / alpha) syntax for Chrome 53.
import postcss from 'postcss';

const RGB_PROP_RE = /^--[\w-]+-rgb$/;
const RGB_VAR_ALIAS_RE = /^var\((--[\w-]+)\)$/;
const MODERN_RGB_USAGE_RE = /rgb\(\s*var\((--[\w-]+)\)\s*\/\s*([^()]+)\)/g;

export function generateFlexGapFallback(stylesheets) {
  const rules = [];

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      let display = '';
      let direction = 'row';
      let gap = '';
      let rowGap = '';
      let columnGap = '';

      rule.walkDecls((decl) => {
        const value = decl.value.trim();
        if (decl.prop === 'display') display = value;
        if (decl.prop === 'flex-direction') direction = value;
        if (decl.prop === 'gap') gap = value;
        if (decl.prop === 'row-gap') rowGap = value;
        if (decl.prop === 'column-gap') columnGap = value;
      });

      if (display !== 'flex' && display !== 'inline-flex') return;
      const column = direction.startsWith('column');
      const gapValues = postcss.list.space(gap);
      const shorthandRowGap = gapValues[0] || '';
      const shorthandColumnGap = gapValues[1] || shorthandRowGap;
      const spacing = column
        ? rowGap || shorthandRowGap
        : columnGap || shorthandColumnGap;
      if (!spacing) return;
      const margin = column ? 'margin-top' : 'margin-left';
      const selector = rule.selector
        .split(',')
        .map((part) => `${part.trim()} > * + *`)
        .join(', ');
      rules.push(`  ${selector} { ${margin}: ${spacing}; }`);
    });
  }

  return `\n/* AUTO-GENERATED from source flex gap declarations (scripts/css-transforms.mjs) — do not edit. */\n@supports not (inset: 0) {\n${rules.join('\n')}\n}\n`;
}

export function scaleFontSizes(css) {
  const root = postcss.parse(css);
  root.walkDecls('font-size', (decl) => {
    if (decl.parent.type === 'rule' && decl.parent.selector.includes('::cue')) return;
    decl.value = decl.value.replace(
      /(-?\d*\.?\d+)px\b/g,
      (px) => `calc(${px} * var(--font-scale))`,
    );
  });
  return root.toString();
}

function legacyValueFor(value) {
  const alias = RGB_VAR_ALIAS_RE.exec(value.trim());
  if (alias) return `var(${alias[1]}-legacy)`;
  return value.trim().split(/\s+/).join(', ');
}

export function convertLegacyColorSyntax(css) {
  const root = postcss.parse(css);

  // Legacy rgba() needs comma-separated RGB values. A companion property in
  // the same rule preserves each theme's cascade and aliases.
  root.walkDecls(RGB_PROP_RE, (decl) => {
    const legacyProp = `${decl.prop}-legacy`;
    const hasCompanion = decl.parent.nodes.some((node) => node.prop === legacyProp);
    if (hasCompanion) return;
    decl.cloneAfter({ prop: legacyProp, value: legacyValueFor(decl.value) });
  });

  root.walkDecls((decl) => {
    if (!decl.value.includes('rgb(var(')) return;
    decl.value = decl.value.replace(
      MODERN_RGB_USAGE_RE,
      (_match, name, alpha) => `rgba(var(${name}-legacy), ${alpha.trim()})`,
    );
  });

  return root.toString();
}
