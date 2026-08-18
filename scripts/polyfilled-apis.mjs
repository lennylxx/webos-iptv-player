import { postTargetApis } from './chromium-53-simulation.mjs';

// Every polyfill the app installs at runtime, as the path it resolves to.
// Mostly src/polyfills.ts, plus the esbuild banner (see scripts/compat-gate.mjs),
// whose install the source file never mentions. The paths cannot be derived
// statically — installs assign through `scope.x`, cast expressions and a loop
// over constructors — so the list is authored, and
// e2e/legacy-fallbacks.spec.ts pins it against what actually lands on the
// page under the simulated engine.
export const POLYFILLED_APIS = [
  'Object.entries',
  'Object.getOwnPropertyDescriptors',
  'Object.values',
  'Object.fromEntries',
  'String.prototype.padStart',
  'Array.prototype.flatMap',
  'Element.prototype.append',
  'Document.prototype.append',
  'DocumentFragment.prototype.append',
  'Element.prototype.scrollIntoView',
  'Node.prototype.getRootNode',
  'window.ResizeObserver',
  'window.AbortController',
  // The AbortController install also wraps fetch, to honour the stand-in signal.
  'window.fetch',
  'Intl.PluralRules',
];

// A few installs are not gated on their own availability. fetch is wrapped only
// because AbortController had to be replaced, and scrollIntoView is replaced
// for its options object, which the engine only honours where it also supports
// CSS scroll-behavior.
const INSTALLED_WITH = {
  'window.fetch': 'window.AbortController',
  'Element.prototype.scrollIntoView': 'css:scroll-behavior',
};

let cachedRemoved;

function isRemoved(path) {
  path = INSTALLED_WITH[path] ?? path;
  cachedRemoved ??= postTargetApis();
  if (path.indexOf('css:') === 0) {
    const camel = path.slice(4).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return cachedRemoved.cssProperties.includes(camel);
  }
  const parts = path.split('.').filter((part) => part !== 'window' && part !== 'prototype');
  if (parts.length === 1) return cachedRemoved.globals.includes(parts[0]);
  const [owner, member] = parts;
  return cachedRemoved.members.some(([o, m]) => o === owner && m === member);
}

// Entries the simulation cannot exercise — an API Chromium 53 already shipped
// (scrollIntoView — only its options object is newer) or one KEEP_GLOBALS
// exempts. Must stay empty: such a polyfill is only half-guarded, since the
// discovery scan in e2e/legacy-fallbacks.spec.ts can never notice its install
// go missing.
export function simulationCoverageGap() {
  return POLYFILLED_APIS.filter((path) => !isRemoved(path));
}
