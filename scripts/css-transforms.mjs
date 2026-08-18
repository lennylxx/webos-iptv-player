// Build-time CSS transforms consumed by esbuild.config.mjs.
//
// - Flex gap: generate sibling margins for webOS versions without flex gap.
// - Font scale: wrap pixel font sizes in the app-wide --font-scale variable.
// - Legacy colors: convert modern rgb(var(...) / alpha) syntax for Chrome 53.
import postcss from 'postcss';

const RGB_PROP_RE = /^--[\w-]+-rgb$/;
const RGB_VAR_ALIAS_RE = /^var\((--[\w-]+)\)$/;
const MODERN_RGB_USAGE_RE = /rgb\(\s*var\((--[\w-]+)\)\s*\/\s*([^()]+)\)/g;

const GRID_DISPLAY_RE = /\bgrid\b/;

const selectorParts = (selector) => selector.split(',').map((part) => part.trim());

// The rightmost compound of a descendant selector, so an override like
// `#playlist-entries .settings-row` can inherit `.settings-row`'s flex context.
const lastCompound = (part) => part.split(/[\s>+~]+/).filter(Boolean).pop() || part;

// A gap-carrying rule often does not declare `display` itself: it either refines
// a base rule with the same selector, narrows one (`#id .base`), or rides a
// companion class on the same element (`.setup-box-info.device-setup-card`).
// Collect what each selector declares anywhere so those rules still resolve.
function collectFlexContext(stylesheets) {
  const context = new Map();
  const record = (key, prop, value) => {
    const entry = context.get(key) || {};
    entry[prop] = value;
    context.set(key, entry);
  };

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      rule.walkDecls((decl) => {
        if (decl.prop !== 'display' && decl.prop !== 'flex-direction') return;
        for (const part of selectorParts(rule.selector)) record(part, decl.prop, decl.value.trim());
      });
    });
  }

  return context;
}

// Emit in index.html's link order, not whatever readdir returns, so the
// generated cascade resolves an equal-specificity pair the same way the source
// cascade does. A stylesheet that is never linked would silently lose its
// fallback, so demand that the two sets match.
export function linkedStylesheets(indexHtml, cssDirFiles, generated) {
  const linked = [];
  const pattern = /<link[^>]+href="css\/([\w-]+\.css)"/g;
  for (let match = pattern.exec(indexHtml); match; match = pattern.exec(indexHtml)) {
    if (match[1] !== generated) linked.push(match[1]);
  }
  const sources = cssDirFiles.filter((file) => file.endsWith('.css') && file !== generated);
  const unlinked = sources.filter((file) => linked.indexOf(file) === -1);
  if (unlinked.length) throw new Error(`css/ files not linked in index.html: ${unlinked.join(', ')}`);
  return linked;
}

export function generateFlexGapFallback(stylesheets) {
  const rules = [];
  const context = collectFlexContext(stylesheets);

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      let display = '';
      let direction = '';
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

      if (!gap && !rowGap && !columnGap) return;

      const parts = selectorParts(rule.selector);
      const inherited = (prop) => {
        for (const part of parts) {
          const value = context.get(part)?.[prop] || context.get(lastCompound(part))?.[prop];
          if (value) return value;
        }
        return '';
      };

      // Grid gap has its own fallback (`@supports not (display: grid)`), and a
      // sibling margin there would stack on top of it. Everything else is a flex
      // container: emit unless the resolved display says otherwise.
      if (GRID_DISPLAY_RE.test(display || inherited('display'))) return;

      const resolvedDirection = direction || inherited('flex-direction') || 'row';
      const column = resolvedDirection.startsWith('column');
      const gapValues = postcss.list.space(gap);
      const shorthandRowGap = gapValues[0] || '';
      const shorthandColumnGap = gapValues[1] || shorthandRowGap;
      const spacing = column
        ? rowGap || shorthandRowGap
        : columnGap || shorthandColumnGap;
      if (!spacing) return;
      const margin = column ? 'margin-top' : 'margin-left';
      // A rule that flips direction without redeclaring `display` overrides a base
      // flex container, whose fallback margin sits on the other axis. That margin
      // is not ours to inherit, so zero it — real gap never spans both axes.
      const reset = direction && !display ? ` ${column ? 'margin-left' : 'margin-top'}: 0;` : '';
      const selector = parts.map((part) => `${part} > * + *`).join(', ');
      rules.push(`  ${selector} { ${margin}: ${spacing};${reset} }`);
    });
  }

  return `/*
 * AUTO-GENERATED by scripts/css-transforms.mjs on every build — do not edit.
 * Checked in so its rules show up in review diffs.
 *
 * Margin fallbacks for flex \`gap\`, which webOS 4/5/6 (Chromium 53/68/79) lack.
 * Linked FIRST, before any component CSS: this is the base layer, so a
 * component rule of equal specificity — notably \`margin: auto\` — still wins.
 * Hand-written rules that must beat component CSS live in the companion
 * legacy-webos-overrides.css, which is linked last.
 */
@supports not (inset: 0) {
${rules.join('\n')}
}
`;
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
