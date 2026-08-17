// webOS 4 (Chromium 53) bundle compat gate — single module holding the
// denylist of post-53 APIs, the allowlist of accepted exceptions, and the
// scanner. Consumed by:
//   - esbuild.config.mjs → scans a NON-minified build of the app bundle and
//                          throws on any un-allowlisted post-53 API (catches
//                          APIs introduced by bundled dependencies).
//   - eslint.config.mjs  → derives its `no-restricted-syntax` selectors from
//                          the `method` entries of DENYLIST (source gate).
import ts from 'typescript';

export const LEGACY_JS_BANNER = `
if (!Object.getOwnPropertyDescriptors) {
  Object.getOwnPropertyDescriptors = function (object) {
    var descriptors = {};
    Object.getOwnPropertyNames(object).forEach(function (key) {
      descriptors[key] = Object.getOwnPropertyDescriptor(object, key);
    });
    Object.getOwnPropertySymbols(object).forEach(function (key) {
      descriptors[key] = Object.getOwnPropertyDescriptor(object, key);
    });
    return descriptors;
  };
}
`;

//
// DENYLIST fields:
//   name       API identifier (method / static / global name)
//   kind       'method' → an instance method call `x.name(...)`
//              'static' → a static method on a built-in, `Object.name(...)`
//                         (needs an `object` field); bundle scan only
//              'global' → a global function call, bare `name(...)` or namespaced
//                         `self`/`window`/`globalThis`.name(...); bundle scan only
//              'constructor' → a global constructor call, `new name(...)`;
//                              bundle scan only (eslint compat covers source)
//              'worker-option' → a module Worker/SharedWorker constructor option;
//                                bundle scan plus a dedicated eslint rule
//              'postmessage-option' → object-form `postMessage` transfer options
//              'listener-option' → AbortSignal-backed event-listener options
//   object     for static or nested constructor APIs: the owning built-in
//              (e.g. 'Promise' or 'Intl')
//   minChrome  first Chrome version shipping the API (for messages)
//   message    remediation hint (shared by both gates)
//   scanBundle optional, default true. Set false to keep a generic name
//              (e.g. `at`) out of the AST bundle scan while still enforcing it
//              in source via eslint's AST (the receiver's type is unknowable
//              in bundled JS, so a generic name can match an unrelated object).
//
// eslint derives its `no-restricted-syntax` from the 'method' entries only;
// 'static'/'global' entries are the bundle scanner's job because eslint's
// `compat/compat` already flags those in first-party source.
export const DENYLIST = [
  // --- unsupported constructor options ---
  { name: 'module worker', kind: 'worker-option', minChrome: 80, message: 'Module workers are Chrome 80+ — bundle the worker as a classic script.' },
  { name: 'postMessage transfer options', kind: 'postmessage-option', minChrome: 79, message: 'Object-form postMessage transfer options are Chrome 79+ — pass the transfer list array as the second argument.' },
  { name: 'abortable event listener', kind: 'listener-option', minChrome: 88, message: 'addEventListener({ signal }) is Chrome 88+ — remove the listener explicitly.' },
  // --- unsupported constructors ---
  { name: 'AbortController', kind: 'constructor', minChrome: 66, message: 'AbortController is Chrome 66+ — use the guarded project polyfill.' },
  { name: 'PluralRules', kind: 'constructor', object: 'Intl', minChrome: 63, message: 'Intl.PluralRules is Chrome 63+ — use the guarded project polyfill.' },
  { name: 'ResizeObserver', kind: 'constructor', minChrome: 64, message: 'ResizeObserver is Chrome 64+ — use the guarded project polyfill.' },
  { name: 'SharedArrayBuffer', kind: 'constructor', minChrome: 68, message: 'SharedArrayBuffer is Chrome 68+ — avoid shared-memory code in shipped bundles.' },
  { name: 'OffscreenCanvas', kind: 'constructor', minChrome: 69, message: 'OffscreenCanvas is Chrome 69+ — render with HTMLCanvasElement on the main thread.' },
  { name: 'TextEncoderStream', kind: 'constructor', minChrome: 71, message: 'TextEncoderStream is Chrome 71+ — encode chunks with TextEncoder.' },
  { name: 'TextDecoderStream', kind: 'constructor', minChrome: 71, message: 'TextDecoderStream is Chrome 71+ — decode chunks with TextDecoder.' },
  { name: 'CompressionStream', kind: 'constructor', minChrome: 80, message: 'CompressionStream is Chrome 80+ — use the bundled fflate library.' },
  { name: 'DecompressionStream', kind: 'constructor', minChrome: 80, message: 'DecompressionStream is Chrome 80+ — use the bundled fflate library.' },
  { name: 'WeakRef', kind: 'constructor', minChrome: 84, message: 'WeakRef is Chrome 84+ — retain explicit ownership and cleanup.' },
  { name: 'FinalizationRegistry', kind: 'constructor', minChrome: 84, message: 'FinalizationRegistry is Chrome 84+ — perform deterministic cleanup.' },
  { name: 'AggregateError', kind: 'constructor', minChrome: 85, message: 'AggregateError is Chrome 85+ — use Error with explicit failure details.' },
  // --- instance methods (also drive eslint no-restricted-syntax) ---
  { name: 'padStart', kind: 'method', minChrome: 57, message: 'String.prototype.padStart is Chrome 57+ — use the guarded project polyfill.' },
  { name: 'padEnd', kind: 'method', minChrome: 57, message: 'String.prototype.padEnd is Chrome 57+ — append and slice padding explicitly.' },
  { name: 'finally', kind: 'method', minChrome: 63, message: 'Promise.prototype.finally is Chrome 63+ — use .then(onSettled, onSettled).' },
  { name: 'trimStart', kind: 'method', minChrome: 66, message: 'String.prototype.trimStart is Chrome 66+ — remove leading whitespace with a regex.' },
  { name: 'trimEnd', kind: 'method', minChrome: 66, message: 'String.prototype.trimEnd is Chrome 66+ — remove trailing whitespace with a regex.' },
  { name: 'flat', kind: 'method', minChrome: 69, message: 'Array.prototype.flat is Chrome 69+ — flatten with reduce/concat.' },
  { name: 'flatMap', kind: 'method', minChrome: 69, message: 'Array.prototype.flatMap is Chrome 69+ — use the guarded project polyfill.' },
  { name: 'at', kind: 'method', minChrome: 92, scanBundle: false, message: 'Array/String.prototype.at is Chrome 92+ — use indexed access.' },
  { name: 'replaceAll', kind: 'method', minChrome: 85, message: 'String.prototype.replaceAll is Chrome 85+ — use .replace(/x/g, …).' },
  { name: 'replaceChildren', kind: 'method', minChrome: 86, message: 'Element.replaceChildren is Chrome 86+ — clear then append children explicitly.' },
  { name: 'findLast', kind: 'method', minChrome: 97, message: 'Array.prototype.findLast is Chrome 97+ — reverse-iterate or use a loop.' },
  { name: 'findLastIndex', kind: 'method', minChrome: 97, message: 'Array.prototype.findLastIndex is Chrome 97+ — reverse-iterate with an index.' },
  { name: 'toSorted', kind: 'method', minChrome: 110, message: 'Array.prototype.toSorted is Chrome 110+ — use [...arr].sort().' },
  { name: 'toReversed', kind: 'method', minChrome: 110, message: 'Array.prototype.toReversed is Chrome 110+ — use [...arr].reverse().' },
  { name: 'toSpliced', kind: 'method', minChrome: 110, message: 'Array.prototype.toSpliced is Chrome 110+ — copy then splice the array.' },
  { name: 'isWellFormed', kind: 'method', minChrome: 111, message: 'String.prototype.isWellFormed is Chrome 111+ — validate surrogate pairs explicitly.' },
  { name: 'toWellFormed', kind: 'method', minChrome: 111, message: 'String.prototype.toWellFormed is Chrome 111+ — sanitize surrogate pairs explicitly.' },
  // --- globals (bundle scan only; eslint covers these via compat/compat) ---
  { name: 'BigInt', kind: 'global', minChrome: 67, message: 'BigInt is Chrome 67+ — use Number or string-based integer handling.' },
  { name: 'structuredClone', kind: 'global', minChrome: 98, message: 'structuredClone is Chrome 98+ — write a typed copy for the required data.' },
  { name: 'queueMicrotask', kind: 'global', minChrome: 71, message: 'queueMicrotask is Chrome 71+ — use Promise.resolve().then().' },
  // --- static built-in methods (bundle scan only; eslint covers via compat/compat) ---
  { name: 'values', kind: 'static', object: 'Object', minChrome: 54, message: 'Object.values is Chrome 54+ — use the guarded project polyfill.' },
  { name: 'entries', kind: 'static', object: 'Object', minChrome: 54, message: 'Object.entries is Chrome 54+ — use the guarded project polyfill.' },
  { name: 'getOwnPropertyDescriptors', kind: 'static', object: 'Object', minChrome: 54, message: 'Object.getOwnPropertyDescriptors is Chrome 54+ — keep the pre-bundle helper polyfill.' },
  { name: 'fromEntries', kind: 'static', object: 'Object', minChrome: 73, message: 'Object.fromEntries is Chrome 73+ — use the guarded project polyfill.' },
  { name: 'hasOwn', kind: 'static', object: 'Object', minChrome: 93, message: 'Object.hasOwn is Chrome 93+ — use Object.prototype.hasOwnProperty.call.' },
  { name: 'allSettled', kind: 'static', object: 'Promise', minChrome: 76, message: 'Promise.allSettled is Chrome 76+ — catch each input before Promise.all.' },
  { name: 'any', kind: 'static', object: 'Promise', minChrome: 85, message: 'Promise.any is Chrome 85+ — use an explicit first-success helper.' },
];

// Post-53 tokens the bundle scan tolerates. Each entry documents WHY the token
// is safe to ship:
//   guarded       the code feature-detects and falls back at runtime
//   polyfilled    src/polyfills.ts installs the API before it is used
//   accepted-risk knowingly shipped without a fix (documents the risk)
// Note: the AST scanner only flags call sites and already ignores `typeof x`
// feature-detection guards, so 'guarded' usages rarely need an entry here
// (e.g. fflate's guarded queueMicrotask is not flagged and needs no allowlist).
export const ALLOWLIST = [
  { name: 'AbortController', reason: 'polyfilled', note: 'src/polyfills.ts installs an AbortController and logical fetch cancellation on Chromium 53.' },
  { name: 'PluralRules', reason: 'polyfilled', note: 'src/polyfills.ts installs cardinal rules for the app locales on Chromium 53.' },
  { name: 'ResizeObserver', reason: 'polyfilled', note: 'src/polyfills.ts observes window and video metadata changes for assjs on Chromium 53.' },
  { name: 'padStart', reason: 'polyfilled', note: 'src/polyfills.ts installs a guarded String.prototype.padStart.' },
  { name: 'values', reason: 'polyfilled', note: 'src/polyfills.ts installs a guarded Object.values.' },
  { name: 'entries', reason: 'polyfilled', note: 'src/polyfills.ts installs a guarded Object.entries.' },
  { name: 'getOwnPropertyDescriptors', reason: 'polyfilled', note: 'The esbuild banner installs this before generated helper aliases are captured.' },
  { name: 'flatMap', reason: 'polyfilled', note: 'src/polyfills.ts installs a guarded Array.prototype.flatMap for assjs.' },
  { name: 'fromEntries', reason: 'polyfilled', note: 'src/polyfills.ts installs a guarded Object.fromEntries for assjs.' },
];

// Scan bundled JS for post-53 APIs using a real AST (TypeScript's parser, a
// dependency we already have). Parsing — rather than text-matching — means
// occurrences inside string/template literals, comments, and regex literals
// are ignored, and a `typeof x` feature-detection guard is not mistaken for a
// use. Detection is call-site based, which is the actual legacy webOS throw risk:
//   method  → `recv.name(...)`   (any receiver; also computed `recv["name"](…)`)
//   static  → `Object.name(...)` (bare-identifier owner must match `object`)
//   global  → `name(...)` bare, or `self|window|globalThis .name(...)`
//   constructor → `new name(...)`, bare or on a standard global namespace
// Dedicated checks also cover unsupported literal option-object shapes.
// It cannot know a receiver's TYPE (bundled deps are untyped JS), so a generic
// method name can still match an unrelated object; keep such names out with
// `scanBundle: false` (they stay enforced in first-party source by eslint).
//
// Returns [] when clean, else one entry per distinct violating token (in
// DENYLIST order). Pass a NON-minified bundle for readable, faithful results.
const NAMESPACES = new Set(['self', 'window', 'globalThis']);

// The property name a call targets: `x.name` or the static string `x["name"]`.
function calledPropName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

// The owner identifier text of a member access, when it is a bare identifier.
function ownerIdentText(node) {
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

function globalExpressionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const owner = ownerIdentText(node);
  return owner !== undefined && NAMESPACES.has(owner) ? calledPropName(node) : undefined;
}

function objectProperty(node, wanted) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : undefined;
    if (name === wanted) return property;
  }
  return undefined;
}

function hasLiteralObjectProperty(node, name, value) {
  const property = objectProperty(node, name);
  return !!property
    && ts.isStringLiteralLike(property.initializer)
    && property.initializer.text === value;
}

export function scanBundle(code, { denylist = DENYLIST, allowlist = ALLOWLIST } = {}) {
  const allowed = new Set(allowlist.map((a) => a.name));
  const active = denylist.filter((e) => e.scanBundle !== false && !allowed.has(e.name));
  const methods = new Map(); // name -> entry
  const statics = new Map(); // `${object}.${name}` -> entry
  const globals = new Map(); // name -> entry
  const constructors = new Map(); // global constructor name -> entry
  let moduleWorker;
  let postMessageOptions;
  let listenerOptions;
  for (const e of active) {
    if (e.kind === 'method') methods.set(e.name, e);
    else if (e.kind === 'static') statics.set(`${e.object}.${e.name}`, e);
    else if (e.kind === 'global') globals.set(e.name, e);
    else if (e.kind === 'constructor') constructors.set(e.object ? `${e.object}.${e.name}` : e.name, e);
    else if (e.kind === 'worker-option') moduleWorker = e;
    else if (e.kind === 'postmessage-option') postMessageOptions = e;
    else if (e.kind === 'listener-option') listenerOptions = e;
  }

  const counts = new Map();
  const bump = (entry) => counts.set(entry, (counts.get(entry) || 0) + 1);
  const sf = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

  const walk = (node) => {
    if (ts.isNewExpression(node)) {
      const name = globalExpressionName(node.expression);
      let constructor = name === undefined ? undefined : constructors.get(name);
      if (!constructor
          && (ts.isPropertyAccessExpression(node.expression)
            || ts.isElementAccessExpression(node.expression))) {
        const owner = ownerIdentText(node.expression);
        const property = calledPropName(node.expression);
        if (owner !== undefined && property !== undefined) {
          constructor = constructors.get(`${owner}.${property}`);
        }
      }
      if (constructor) bump(constructor);
      if (moduleWorker
          && (name === 'Worker' || name === 'SharedWorker')
          && hasLiteralObjectProperty(node.arguments?.[1], 'type', 'module')) {
        bump(moduleWorker);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calledName = ts.isIdentifier(callee) ? callee.text : calledPropName(callee);
      if (postMessageOptions
          && calledName === 'postMessage'
          && objectProperty(node.arguments[1], 'transfer')) {
        bump(postMessageOptions);
      }
      if (listenerOptions
          && calledName === 'addEventListener'
          && objectProperty(node.arguments[2], 'signal')) {
        bump(listenerOptions);
      }
      if (ts.isIdentifier(callee)) {
        const g = globals.get(callee.text);
        if (g) bump(g);
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const name = calledPropName(callee);
        if (name !== undefined) {
          const owner = ownerIdentText(callee);
          if (owner !== undefined) {
            const s = statics.get(`${owner}.${name}`);
            if (s) bump(s);
            if (NAMESPACES.has(owner) && globals.has(name)) bump(globals.get(name));
          }
          const m = methods.get(name);
          if (m) bump(m);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  const violations = [];
  for (const entry of denylist) {
    const count = counts.get(entry);
    if (count) {
      violations.push({
        name: entry.name,
        kind: entry.kind,
        minChrome: entry.minChrome,
        count,
        message: entry.message,
      });
    }
  }
  return violations;
}

// Render violations as a human-readable build-error message.
export function formatViolations(violations) {
  const n = violations.length;
  const lines = [
    '',
    `\u2717 webOS 4 (Chromium 53) compat gate failed \u2014 ${n} post-53 API${n === 1 ? '' : 's'} in the app bundle:`,
    '',
  ];
  for (const v of violations) {
    lines.push(`  \u2022 ${v.name}  (Chrome ${v.minChrome}+)  \u00d7${v.count}`);
    lines.push(`    ${v.message}`);
    lines.push('    Fix one of:');
    lines.push("      - add a guarded polyfill in src/polyfills.ts, then allowlist as 'polyfilled'");
    lines.push('      - avoid the API');
    lines.push("      - allowlist as 'accepted-risk' in the ALLOWLIST in scripts/compat-gate.mjs (documents the risk)");
    lines.push('');
  }
  return lines.join('\n');
}
