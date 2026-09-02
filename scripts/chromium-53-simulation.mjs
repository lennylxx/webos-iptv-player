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

// Chromium 53 predates these; the parser treats each as a syntax error.
const POST_53_SELECTOR = /:focus-within\b|::placeholder\b|:(?:is|where|has)\(/; // Chrome 60 / 57 / 88 / 88 / 105
// Two of the post-53 features stylelint.config.js accepts are deliberately
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
    if (POST_53_SELECTOR.test(rule.selector)) rule.remove();
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
