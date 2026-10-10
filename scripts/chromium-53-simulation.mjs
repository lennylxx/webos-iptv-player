// Simulates webOS 4's Chromium 53 on a modern engine for the
// `chromium-53-simulation` Playwright project, on both axes:
//
// - JS: derives the API set Chromium 53 lacks, so the harness can delete it
//   from the page before the app loads.
// - CSS: rewrites a stylesheet the way that engine would parse it.
//
// Unguarded use then fails the way it would on a real TV, and guarded use
// exercises the fallback path — neither of which the static compat gate in
// compat-gate.mjs can check, since it only reads code, never runs it.
import bcd from '@mdn/browser-compat-data' with { type: 'json' };
import postcss from 'postcss';
import { readFile } from 'fs/promises';
import { extname } from 'path';

const TARGET_CHROME = 53;

// Globals the harness itself needs, or that the shipped bundle never reaches:
// removing them would fail the preview, not the app. An exempt name that
// already existed in Chromium 53 still has its post-53 members stripped; one
// that is itself newer is kept whole, since gutting its members would model an
// engine that has no such interface at all — which is what the exemption
// deliberately opts out of.
const KEEP_GLOBALS = new Set([
  // hls.js and mpegts.js are desktop-preview only — they are not in the webOS
  // bundle, so their post-53 API use cannot break a TV.
  'MediaSource',
  'SourceBuffer',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'TextDecoder',
  'TextEncoder',
  // Playwright drives the page through these.
  'globalThis',
  'Promise',
  // Playwright's `evaluate` serializer references the BigInt typed arrays by
  // name; removing them breaks the harness, not the app. The static gate
  // already denylists `BigInt` itself.
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
]);

const parseVersion = (version) => {
  if (typeof version !== 'string') return null;
  const parsed = parseFloat(version.replace(/^≤/, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

// A BCD support array is a list of *ranges*, not a history of one range: an
// entry may re-add a feature whose behaviour changed (`Element.scrollLeft` is
// listed as added in 86 first, then 1–85 for the old RTL semantics). So ask
// whether any range covers the target version rather than reading support[0].
const isPostTarget = (compat) => {
  const support = compat?.support?.chrome;
  if (!support) return false;
  const ranges = Array.isArray(support) ? support : [support];
  let knownLater = false;
  for (const range of ranges) {
    // A prefixed or alternatively named API does not make the canonical name
    // available. Chromium 53 may expose `webkitRequestFullscreen`, for
    // example, while still lacking `requestFullscreen`.
    if (range.flags || range.prefix || range.alternative_name) continue;
    // `true` means supported since an unknown version — assume it predates the
    // target rather than delete an API the TV may well have.
    if (range.version_added === true) return false;
    const added = parseVersion(range.version_added);
    if (added === null) continue;
    const removed = parseVersion(range.version_removed) ?? Infinity;
    if (added <= TARGET_CHROME && TARGET_CHROME < removed) return false;
    if (added > TARGET_CHROME) knownLater = true;
  }
  return knownLater;
};

/**
 * @returns {{ globals: string[], members: [string, string][], cssProperties: string[] }}
 * globals to delete from `window`, `[builtin, member]` pairs to delete from
 * either the builtin's prototype or the builtin itself (resolved in the page),
 * and camelCased CSSOM reflections to shadow.
 */
export function postTargetApis() {
  const globals = [];
  const members = [];

  for (const [name, node] of Object.entries(bcd.javascript.builtins)) {
    if (isPostTarget(node.__compat)) {
      if (!KEEP_GLOBALS.has(name)) globals.push(name);
      continue;
    }
    for (const [member, sub] of Object.entries(node)) {
      // `@@`-prefixed entries are well-known symbols, which cannot be addressed
      // by name; skip them rather than emit an undeletable property.
      if (member === '__compat' || member.startsWith('@@')) continue;
      if (isPostTarget(sub?.__compat)) members.push([name, member]);
    }
  }

  for (const [name, node] of Object.entries(bcd.api)) {
    if (isPostTarget(node.__compat)) {
      if (!KEEP_GLOBALS.has(name)) globals.push(name);
      continue;
    }
    // Interface members matter more than the interfaces themselves: the DOM
    // surface an old engine is missing is mostly new methods on old objects.
    for (const [member, sub] of Object.entries(node)) {
      if (member === '__compat' || member.includes('_')) continue;
      if (isPostTarget(sub?.__compat)) members.push([name, member]);
    }
  }

  // CSS lives outside the api tree, but its CSSOM reflections are part of the
  // JS surface an app feature-detects — `style.scrollBehavior` is how
  // src/polyfills.ts decides whether scrollIntoView options are supported.
  const cssProperties = [];
  for (const [property, node] of Object.entries(bcd.css.properties)) {
    if (property.startsWith('-') || !isPostTarget(node.__compat)) continue;
    cssProperties.push(property.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  }

  return { globals, members, cssProperties };
}

/**
 * Page-side removal. Kept as a standalone function so Playwright can pass it
 * straight to `addInitScript` with the derived lists as its argument.
 */
export function removeApis({ globals, members, cssProperties }) {
  const drop = (owner, key) => {
    try {
      if (owner && Object.prototype.hasOwnProperty.call(owner, key)) delete owner[key];
    } catch {
      // Non-configurable — the engine keeps it; nothing else to try.
    }
  };

  for (const name of globals) drop(globalThis, name);

  // CSS reflections are named-property interceptors, not own properties, so
  // `delete` cannot reach them; shadow them with an undefined accessor instead.
  if (typeof CSSStyleDeclaration !== 'undefined') {
    for (const property of cssProperties || []) {
      try {
        Object.defineProperty(CSSStyleDeclaration.prototype, property, {
          configurable: true,
          get: () => undefined,
          set: () => {},
        });
      } catch {
        // Some engines seal the reflection; nothing else to try.
      }
    }
  }

  for (const [builtin, member] of members) {
    const owner = globalThis[builtin];
    if (!owner) continue;
    // An instance method lives on the prototype, a static on the builtin.
    drop(owner.prototype, member);
    drop(owner, member);
  }
}

// The CSS axis: approximate how Chromium 53 parses a stylesheet, so the e2e
// suite exercises the legacy layout path. Three effects are simulated:
//
// - `@supports` blocks are resolved against that engine's feature set and
//   replaced in place by their contents or dropped, so legacy fallbacks
//   activate without changing their cascade position and the modern branch
//   they pair with goes away. Every guard resolving this way is only true
//   below Chromium 57 (Grid) — that is, webOS 4. webOS 5/6 activate a subset,
//   so testing the oldest target covers them.
// - `gap` is dropped everywhere, since Chromium 53 has neither flex nor grid
//   gap — the hoisted fallbacks and generated margins must carry the spacing.
// - Whatever Chromium 53 cannot parse is discarded the way that engine
//   discards it: a declaration on its own, but a rule whose selector list holds
//   an unknown pseudo-class *entirely* — taking its otherwise-valid selectors
//   down with it. That asymmetry is easy to miss by reading, and it is why a
//   modern-only selector must never share a rule with a legacy one.
//
// This stays a CSS simulation, not an engine emulation — it cannot reproduce
// layout or JS behavior that differs at equal feature support — so the emulator
// sweep remains the check for engine-level differences.

// Selectors Chromium 53 cannot parse, derived from BCD's `css.selectors` so the
// list never needs hand-maintenance. Classification fails closed:
// `unclassifiedSelectorFeatures()` names any feature the target lacks that is
// neither detected below nor excluded with a reason, and a test keeps it empty.

// Unlike an API, a selector Chromium has never shipped (`false`) is just as
// unparsable as one added later.
const selectorUnavailable = (compat) => {
  const support = compat?.support?.chrome;
  if (!support) return false;
  for (const range of Array.isArray(support) ? support : [support]) {
    if (range.flags || range.prefix || range.alternative_name) continue;
    if (range.version_added === true || range.version_added === null) return false;
    const added = parseVersion(range.version_added);
    const removed = parseVersion(range.version_removed) ?? Infinity;
    if (added !== null && added <= TARGET_CHROME && TARGET_CHROME < removed) return false;
  }
  return true;
};

// BCD entries whose description carries no `<code>` syntax.
const SELECTOR_SYNTAX = {
  'interest-source': ':interest-source',
  'interest-target': ':interest-target',
  'target-after': ':target-after',
  'target-before': ':target-before',
};
const EXCLUDED_SELECTORS = {
  nesting: '`&` belongs to nested rules, which Chromium 53 cannot parse at all',
};

// New grammar inside a selector Chromium 53 otherwise supports. Each detector
// receives one selector from a list.
const argsOf = (selector, name) => {
  const args = [];
  const lower = selector.toLowerCase();
  const open = `:${name}(`;
  for (let at = lower.indexOf(open); at !== -1; at = lower.indexOf(open, at + 1)) {
    if (lower[at - 1] === ':') continue;
    const start = at + open.length;
    let depth = 1;
    let quote = '';
    let i = start;
    for (; i < selector.length && depth > 0; i++) {
      const ch = selector[i];
      if (ch === '\\') i++;
      else if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    args.push(selector.slice(start, i - 1));
  }
  return args;
};
const STRINGS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const attributesOf = (selector) => selector.replace(STRINGS, '""').match(/\[[^\]]*\]/g) ?? [];

const GRAMMAR_SUBFEATURES = {
  'not.selector_list': (s) => argsOf(s, 'not').some((a) => splitSelectorList(a).length > 1),
  'nth-child.of_syntax': (s) => argsOf(s, 'nth-child').some((a) => /\sof\s/i.test(a)),
  'nth-last-child.of_syntax': (s) => argsOf(s, 'nth-last-child').some((a) => /\sof\s/i.test(a)),
  'lang.argument_list': (s) => argsOf(s, 'lang').some((a) => splitSelectorList(a).length > 1),
  'lang.wildcards': (s) => argsOf(s, 'lang').some((a) => a.includes('*')),
  'attribute.case_sensitive_modifier': (s) => attributesOf(s).some((a) => /\ss\s*\]$/i.test(a)),
};
// Changes to matching or styling, not grammar: the rule still parses.
const BEHAVIOR = 'matching or styling behaviour; the rule still parses';
const NON_GRAMMAR_SUBFEATURES = {
  'after.nested_marker': '`::marker` is itself post-53 and already detected',
  'before.nested_marker': '`::marker` is itself post-53 and already detected',
  'active.top-layer_ancestor_matching_boundary': BEHAVIOR,
  'hover.top-layer_ancestor_matching_boundary': BEHAVIOR,
  'backdrop.fullscreen': BEHAVIOR,
  'backdrop.inherit_from_originating_element': BEHAVIOR,
  'backdrop.popover': BEHAVIOR,
  'empty.matches_whitespace': BEHAVIOR,
  'first-child.no_parent_required': BEHAVIOR,
  'last-child.no_parent_required': BEHAVIOR,
  'nth-child.no_parent_required': BEHAVIOR,
  'nth-last-child.no_parent_required': BEHAVIOR,
  'only-child.no_parent_required': BEHAVIOR,
  'first-letter.dutch_ij_digraph': BEHAVIOR,
  'first-letter.svg_text_element': BEHAVIOR,
  'first-line.svg_text_element': BEHAVIOR,
  'selection.text-decoration': BEHAVIOR,
};

const selectorFeatures = () => {
  const tops = [];
  const subs = [];
  for (const [key, feature] of Object.entries(bcd.css.selectors)) {
    if (selectorUnavailable(feature.__compat)) {
      tops.push([key, feature.__compat]);
      continue;
    }
    for (const [subKey, sub] of Object.entries(feature)) {
      if (subKey !== '__compat' && selectorUnavailable(sub.__compat)) subs.push(`${key}.${subKey}`);
    }
  }
  return { tops, subs };
};

export const postTargetSelectors = () => {
  const selectors = [];
  for (const [key, compat] of selectorFeatures().tops) {
    const match = /<code>(::?-?[a-z][\w-]*)(\(\))?<\/code>/i.exec(compat.description ?? '');
    const syntax = match ? match[1] + (match[2] ?? '') : SELECTOR_SYNTAX[key];
    if (syntax) selectors.push(syntax.toLowerCase());
  }
  return selectors.sort();
};

export const unclassifiedSelectorFeatures = () => {
  const { tops, subs } = selectorFeatures();
  return [
    ...tops
      .filter(([, compat]) => !/<code>::?-?[a-z]/i.test(compat.description ?? ''))
      .map(([key]) => key)
      .filter((key) => !SELECTOR_SYNTAX[key] && !EXCLUDED_SELECTORS[key]),
    ...subs.filter(
      (key) => !GRAMMAR_SUBFEATURES[key] && !NON_GRAMMAR_SUBFEATURES[key],
    ),
  ];
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const POST_53_PSEUDO = new RegExp(
  postTargetSelectors()
    .map((s) => (s.endsWith('()') ? escapeRegExp(s.slice(0, -1)) : `${escapeRegExp(s)}(?![\\w-])`))
    .join('|'),
  'i',
);
const grammarDetectors = Object.values(GRAMMAR_SUBFEATURES);

// Whether Chromium 53 fails to parse this single selector (one entry of a
// selector list).
export const isPost53Selector = (selector) =>
  POST_53_PSEUDO.test(selector) || grammarDetectors.some((detect) => detect(selector));

// Splits a selector list on its top-level commas, honouring parentheses,
// brackets, strings, and escapes.
export function splitSelectorList(selector) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '\\') i++;
    else if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}
// Two of the post-53 features stylelint.config.mjs accepts are deliberately
// left in place, because removing them models the engine *less* faithfully:
// - `overflow-anchor: none` — Chromium 53 has no scroll anchoring to turn off,
//   so dropping the declaration would enable, on the modern engine only, a
//   behavior the TV never has.
// - `scroll-behavior: smooth` — dropping it is faithful (53 scrolls
//   instantly), but instant scroll under a stationary pointer makes Chromium
//   re-dispatch `mouseover`, and the hover-to-focus path in
//   src/navigation/key-handler.ts then pulls focus to whatever is under the
//   cursor. That is a real hazard, but a desktop-pointer one; leaving smooth
//   scrolling on keeps it out of the simulation's D-pad coverage.
const POST_53_PROP = /^(?:grid(?:-|$)|backdrop-filter$|inset$)/; // Chrome 57 / 76 / 87
const POST_53_VALUE = { display: /\bgrid\b/, position: /\bsticky\b/ }; // Chrome 57 / 56

// `@supports` itself parses on 53, so a condition naming a feature it lacks is
// simply false — the block goes, rather than being hoisted like its `not` twin.
const supportsDeclaration = (text) => {
  const match = /^\(\s*([\w-]+)\s*:\s*(.+?)\s*\)$/.exec(text.trim());
  if (!match) return true;
  const [, prop, value] = match;
  return !(POST_53_PROP.test(prop) || POST_53_VALUE[prop]?.test(value));
};

const supportsCondition = (params) => {
  const trimmed = params.trim();
  if (/^not\s*\(/i.test(trimmed)) return !supportsCondition(trimmed.replace(/^not\s*/i, ''));
  return trimmed.split(/\s+or\s+/i).some(
    (clause) => clause.split(/\s+and\s+/i).every(supportsDeclaration),
  );
};

export function simulateLegacyEngine(css) {
  const root = postcss.parse(css);

  root.walkAtRules('supports', (atRule) => {
    if (supportsCondition(atRule.params)) atRule.replaceWith(atRule.nodes || []);
    else atRule.remove();
  });

  root.walkDecls(/^(gap|row-gap|column-gap)$/, (decl) => decl.remove());

  root.walkRules((rule) => {
    if (splitSelectorList(rule.selector).some(isPost53Selector)) rule.remove();
  });

  root.walkDecls((decl) => {
    const value = POST_53_VALUE[decl.prop];
    if (POST_53_PROP.test(decl.prop) || (value && value.test(decl.value))) decl.remove();
  });

  return root.toString();
}

// How the preview server serves an asset to the simulation project, which asks
// for it with this header: stylesheets come back rewritten, and the worker
// bundle comes back with the API removal prepended.
export const LEGACY_HEADER = 'x-legacy-engine';

// Playwright's addInitScript reaches page realms only, so a worker would keep
// the modern API surface. Prepending the same removal to the served bundle is
// the one hook that runs before the worker's own code.
const WORKER_PATH = '/js/app-worker.js';
let workerPrelude;
const legacyWorkerPrelude = () => {
  workerPrelude ??= `(${removeApis.toString()})(${JSON.stringify(postTargetApis())});\n`;
  return workerPrelude;
};

export async function readLegacyAsset(file, pathname) {
  if (extname(file) === '.css') return simulateLegacyEngine(await readFile(file, 'utf8'));
  if (pathname === WORKER_PATH) return legacyWorkerPrelude() + (await readFile(file, 'utf8'));
  return readFile(file);
}
