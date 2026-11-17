// Build-time CSS transforms consumed by esbuild.config.mjs.
//
// - Flex gap: generate sibling margins for webOS versions without flex gap.
// - Scroll end padding: give horizontal flex scrollers a real end spacer for
//   engines that leave the end padding out of the scroll width.
// - Font scale: wrap pixel font sizes in the app-wide --font-scale variable.
// - Legacy colors: convert modern rgb(var(...) / alpha) syntax for Chrome 53.
import postcss from 'postcss';

// Classes src/engine-quirks.ts measures and sets on <html>.
export const SCROLL_END_QUIRK = 'html.q-scroll-end-padding';
export const NO_FLEX_GAP_QUIRK = 'html.q-no-flex-gap';

const RGB_PROP_RE = /^--[\w-]+-rgb$/;
const RGB_VAR_ALIAS_RE = /^var\((--[\w-]+)\)$/;
const MODERN_RGB_USAGE_RE = /rgb\(\s*var\((--[\w-]+)\)\s*\/\s*([^()]+)\)/g;

const GRID_DISPLAY_RE = /\bgrid\b/;

// A grid whose columns are an explicit heterogeneous track list holds one row
// and no more: every child lands in a declared track. `repeat()` sizes a track
// list to content that outruns it, so those wrap and stay out.
function isSingleRowGrid(templateColumns) {
  return postcss.list.space(templateColumns).length > 1;
}

// Grid containers the hand-written `@supports not (display: grid)` fallbacks
// already space themselves — with their own margins, or by wrapping — so a
// generated sibling margin would stack on top or land on a wrapped row. A
// fallback that only swaps `display` leaves the spacing to be regenerated.
function collectGridOverrides(stylesheets) {
  const claimed = new Set();
  for (const css of stylesheets) {
    postcss.parse(css).walkAtRules('supports', (atRule) => {
      if (!GRID_DISPLAY_RE.test(atRule.params)) return;
      atRule.walkRules((rule) => {
        let spaces = false;
        rule.walkDecls((decl) => {
          // `auto` margins center a container; they do not space its children.
          if (/^margin(-|$)/.test(decl.prop) && !/\bauto\b/.test(decl.value)) spaces = true;
          if (decl.prop === 'flex-wrap' && decl.value.trim() !== 'nowrap') spaces = true;
        });
        if (!spaces) return;
        for (const part of selectorParts(rule.selector)) {
          for (const compound of part.split(/[\s>+~]+/).filter(Boolean)) claimed.add(compound);
        }
      });
    });
  }
  return claimed;
}

const classesOf = (compound) => compound.match(/\.[\w-]+/g) || [];

const selectorParts = (selector) => selector.split(',').map((part) => part.trim());

// The rightmost compound of a descendant selector, so an override like
// `#playlist-entries .settings-row` can inherit `.settings-row`'s flex context.
const lastCompound = (part) => part.split(/[\s>+~]+/).filter(Boolean).pop() || part;

// A gap-carrying rule often does not declare `display` itself: it either refines
// a base rule with the same selector, narrows one (`#id .base`), or rides a
// companion class on the same element (`.setup-box-info.device-setup-card`).
// Collect what each selector declares anywhere so those rules still resolve.
const FLEX_CONTEXT_PROP_RE = /^(display|flex-direction|flex-wrap|margin|margin-right|margin-bottom)$/;

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
        if (!FLEX_CONTEXT_PROP_RE.test(decl.prop)) return;
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

const SCROLLING_RE = /^(auto|scroll)$/;
const ZERO_LENGTH_RE = /^0(px|r?em|%)?$/;
const nonZero = (value) => (value && !ZERO_LENGTH_RE.test(value) ? value : '');
const SPACER_PROP_RE = /^(display|flex-direction|flex-wrap|justify-content|overflow(-x)?|padding(-right|-inline-end)?|gap|column-gap)$/;

function boxSide(shorthand, index) {
  const values = postcss.list.space(shorthand || '');
  if (!values.length) return '';
  if (index === 2) return values[2] || values[0];
  return values[index] || values[0];
}

// `a - b - c` as px when every term is px, else a calc() the engine resolves.
function subtract(first, ...rest) {
  const terms = [first, ...rest];
  if (terms.every((term) => /^-?\d*\.?\d+px$/.test(term))) {
    const value = terms.slice(1).reduce((sum, term) => sum - parseFloat(term), parseFloat(first));
    return `${String(Math.round(value * 100) / 100)}px`;
  }
  return `calc(${terms.join(' - ')})`;
}

// Chromium before 91 leaves a row flex scroller's padding-right out of its
// scroll width, so the last item scrolls flush to the edge. (Its block-end
// padding does count: a column scroller needs nothing, as the webOS 4 emulator
// shows.) A 1px ::after placed `padding` past the last item rebuilds that room
// from content on every engine; engines that do count the padding only scroll
// that much further. It is 1px on both axes because a zero-area box adds no
// scrollable overflow there. A trailing margin of -padding nets the spacer to
// zero outer size, so a container that does not overflow keeps its size.
// Without flex gap no gap precedes the spacer, so its offset grows by the gap.
// Wrapping or justified containers would lay the spacer out as a real item,
// so they are left alone. Every rule is scoped to the measured quirk, so an
// engine that counts the padding never scrolls past it.
export function generateScrollEndSpacers(stylesheets) {
  const declared = new Map();
  const pseudoAfter = new Set();
  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      for (const part of selectorParts(rule.selector)) {
        if (/::?after\b/.test(part)) pseudoAfter.add(part.replace(/::?after\b.*$/, '').trim());
        const entry = declared.get(part) || {};
        rule.walkDecls((decl) => { entry[decl.prop] = decl.value.trim(); });
        declared.set(part, entry);
      }
    });
  }

  const spacerFor = (d) => {
    if (!/^inline-flex$|^flex$/.test(d.display || '')) return null;
    if ((d['flex-direction'] || 'row') !== 'row') return null;
    const overflow = postcss.list.space(d.overflow || '');
    if (!SCROLLING_RE.test(d['overflow-x'] || overflow[0] || '')) return null;
    if (!/^(|nowrap)$/.test(d['flex-wrap'] || '')) return null;
    if (!/^(|normal|start|flex-start)$/.test(d['justify-content'] || '')) return null;
    const padding = d['padding-right'] || d['padding-inline-end'] || boxSide(d.padding, 1);
    if (!padding || ZERO_LENGTH_RE.test(padding)) return null;
    const gapValues = postcss.list.space(d.gap || '');
    const rawGap = d['column-gap'] || gapValues[1] || gapValues[0];
    const gap = rawGap && !ZERO_LENGTH_RE.test(rawGap) ? rawGap : '';
    return {
      modern: "content: ''; flex: 0 0 1px; width: 1px; height: 1px; "
        + `margin-left: ${gap ? subtract(padding, gap, '1px') : subtract(padding, '1px')}; `
        + `margin-right: ${subtract('0px', padding)};`,
      legacy: gap ? `margin-left: ${subtract(padding, '1px')};` : '',
    };
  };

  const modern = [];
  const legacy = [];
  const emit = (selector, spacer) => {
    if (pseudoAfter.has(selector)) {
      throw new Error(`${selector} scrolls with end padding but already styles ::after; `
        + 'give it a scroll-end spacer by hand');
    }
    modern.push(`${SCROLL_END_QUIRK} ${selector}::after { ${spacer ? spacer.modern : 'content: none;'} }`);
    // Only the flex-gap class, so the offset keeps the spacer rule's own
    // specificity; without `content` from the spacer rule it renders nothing.
    if (spacer && spacer.legacy) legacy.push(`${NO_FLEX_GAP_QUIRK} ${selector}::after { ${spacer.legacy} }`);
  };
  const scrollers = [];
  for (const [selector, d] of declared) {
    const spacer = spacerFor(d);
    if (!spacer) continue;
    emit(selector, spacer);
    scrollers.push(selector);
  }
  // A compound selector that restyles a scroller (`.tabs.compact`) inherits its
  // spacer, so recompute it there, or drop it when that variant has no padding.
  for (const base of scrollers) {
    if (/[\s>+~]/.test(base)) continue;
    const baseClasses = classesOf(base);
    for (const [selector, d] of declared) {
      if (selector === base || selector.indexOf(':') !== -1) continue;
      const own = classesOf(lastCompound(selector));
      if (!baseClasses.every((cls) => own.indexOf(cls) !== -1)) continue;
      if (!Object.keys(d).some((prop) => SPACER_PROP_RE.test(prop))) continue;
      emit(selector, spacerFor(Object.assign({}, declared.get(base), d)));
    }
  }
  return { modern, legacy };
}

// A wrapping row's take-back margin is its declared bottom margin less the
// gap, read from its own rule; it outranks any other rule's bottom margin for
// that row, so a narrowed selector, a variant, or a media query that sets one
// would silently lose. Refuse those rather than emit a wrong margin.
function assertTakeBackHolds(stylesheets, wrapRows) {
  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      let margin = false;
      rule.walkDecls((decl) => { if (/^margin(-bottom)?$/.test(decl.prop)) margin = true; });
      if (!margin) return;
      const nested = rule.parent.type !== 'root';
      for (const part of selectorParts(rule.selector)) {
        const classes = classesOf(lastCompound(part));
        for (const row of wrapRows) {
          const rowClasses = classesOf(lastCompound(row));
          if (!rowClasses.length || !rowClasses.every((cls) => classes.indexOf(cls) !== -1)) continue;
          if (part === row && !nested) continue;
          if (wrapRows.indexOf(part) !== -1 && !nested) continue;
          throw new Error(`${part}: sets a bottom margin on the wrapping gap row ${row}, `
            + 'whose legacy take-back margin would override it');
        }
      }
    });
  }
}

export function generateFlexGapFallback(stylesheets) {
  const rules = [];
  const wrapRows = [];
  const context = collectFlexContext(stylesheets);
  const gridOverrides = collectGridOverrides(stylesheets);

  for (const css of stylesheets) {
    postcss.parse(css).walkRules((rule) => {
      if (rule.parent.type !== 'root') return;
      let display = '';
      let direction = '';
      let gap = '';
      let rowGap = '';
      let columnGap = '';
      let templateColumns = '';
      const own = {};

      rule.walkDecls((decl) => {
        const value = decl.value.trim();
        if (FLEX_CONTEXT_PROP_RE.test(decl.prop)) own[decl.prop] = value;
        if (decl.prop === 'display') display = value;
        if (decl.prop === 'flex-direction') direction = value;
        if (decl.prop === 'gap') gap = value;
        if (decl.prop === 'row-gap') rowGap = value;
        if (decl.prop === 'column-gap') columnGap = value;
        if (decl.prop === 'grid-template-columns') templateColumns = value;
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

      // A grid usually degrades to some inline/float layout the override sheet
      // writes by hand, and a sibling margin would stack on top of that. One
      // grid does not: an explicit heterogeneous track list no override claims
      // can only ever be one row, so the same `> * + *` margin-left a flex row
      // gets is provably right there — but only without grid itself: Chromium
      // 66-83 lacks flex gap yet has grid gap, and would space it twice.
      const resolvedDisplay = display || inherited('display');
      const isGrid = GRID_DISPLAY_RE.test(resolvedDisplay);
      if (isGrid && (!isSingleRowGrid(templateColumns)
          || parts.some((part) => gridOverrides.has(lastCompound(part))))) return;

      const resolvedDirection = direction || inherited('flex-direction') || 'row';
      const column = !isGrid && resolvedDirection.startsWith('column');
      const gapValues = postcss.list.space(gap);
      const shorthandRowGap = gapValues[0] || '';
      const shorthandColumnGap = gapValues[1] || shorthandRowGap;
      const spacing = column
        ? rowGap || shorthandRowGap
        : columnGap || shorthandColumnGap;

      // A row that wraps: `> * + *` would indent each later line and leave no
      // space between lines. Each child carries the gap on its right and
      // bottom instead (bottom, since a top margin on the row would collapse
      // with its neighbor's), and the row takes the last line's back with a
      // negative bottom margin. The last right margin stays: taking it back
      // would push the row's box past its parent, overflowing a scroller, so
      // a line can break up to one gap earlier than with gap.
      // A variant class (`.tags.wide`) wraps if its base class does.
      const looseInherited = (prop) => inherited(prop) || parts.reduce((found, part) => found
        || classesOf(lastCompound(part)).reduce((value, cls) => value || context.get(cls)?.[prop] || '', ''), '');
      const wrap = own['flex-wrap'] || looseInherited('flex-wrap');
      const wraps = !isGrid && !column && /^wrap/.test(wrap);
      // A variant that stops a wrapping base row from wrapping would keep the
      // base's child margins under its own; nothing here resets those.
      const baseWrap = parts.some((part) => classesOf(lastCompound(part)).length > 1
        && classesOf(lastCompound(part)).some((cls) => /^wrap/.test(context.get(cls)?.['flex-wrap'] || '')));
      if (!wraps && baseWrap) {
        throw new Error(`${rule.selector}: a variant of a wrapping gap row must keep wrapping in a row`);
      }
      if (wraps) {
        const rowSpacing = nonZero(rowGap || shorthandRowGap);
        const columnSpacing = nonZero(spacing);
        const declared = (prop, side) => {
          const value = own[prop] || boxSide(own.margin, side)
            || looseInherited(prop) || boxSide(looseInherited('margin'), side) || '0px';
          return value === '0' ? '0px' : value;
        };
        // Both axes always, so a zero one resets what a base row's fallback gave.
        const bottom = declared('margin-bottom', 2);
        const back = `margin-bottom: ${rowSpacing ? subtract(bottom, rowSpacing) : bottom};`;
        const child = `margin-bottom: ${rowSpacing || '0'}; margin-right: ${columnSpacing || '0'};`;
        const rows = parts.map((part) => `${NO_FLEX_GAP_QUIRK} ${part}`).join(', ');
        const children = parts.map((part) => `${NO_FLEX_GAP_QUIRK} ${part} > *`).join(', ');
        rules.push(`${rows} { ${back} }`, `${children} { ${child} }`);
        wrapRows.push(...parts);
        return;
      }
      if (!spacing) return;
      const margin = column ? 'margin-top' : 'margin-left';
      // A rule that flips direction without redeclaring `display` overrides a base
      // flex container, whose fallback margin sits on the other axis. That margin
      // is not ours to inherit, so zero it — real gap never spans both axes.
      const reset = !isGrid && direction && !display ? ` ${column ? 'margin-left' : 'margin-top'}: 0;` : '';
      const selector = parts.map((part) => `${NO_FLEX_GAP_QUIRK} ${part} > * + *`).join(', ');
      const declaration = `${selector} { ${margin}: ${spacing};${reset} }`;
      rules.push(isGrid ? `@supports not (display: grid) {\n  ${declaration}\n}` : declaration);
    });
  }

  assertTakeBackHolds(stylesheets, wrapRows);

  const spacers = generateScrollEndSpacers(stylesheets);
  rules.push(...spacers.legacy);

  return `/*
 * AUTO-GENERATED by scripts/css-transforms.mjs on every build — do not edit.
 * Checked in so its rules show up in review diffs.
 *
 * Every rule is scoped to an engine quirk src/engine-quirks.ts measures at
 * boot, so none of it reaches an engine without the quirk:
 *
 * - ${SCROLL_END_QUIRK}: scroll-end spacers for horizontal flex
 *   scrollers, whose padding-right Chromium before 91 leaves out of the
 *   scroll width.
 * - ${NO_FLEX_GAP_QUIRK}: margin fallbacks for flex \`gap\`, which
 *   Chromium before 84 (webOS 4/5/6) lacks. A single-row grid's margins
 *   also sit under \`@supports not (display: grid)\`: grid gap needs none.
 *
 * Linked FIRST, before any component CSS: this is the base layer. The quirk
 * class adds (0,1,1) specificity, so a component rule that must beat a
 * generated margin — notably \`margin: auto\` — is restated under the same
 * class in legacy-webos-overrides.css, which is linked last.
 */
${spacers.modern.map((rule) => `${rule}\n`).join('')}${rules.map((rule) => `${rule}\n`).join('')}`;
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
