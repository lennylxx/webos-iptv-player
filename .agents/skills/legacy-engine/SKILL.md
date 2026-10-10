---
name: legacy-engine
description: Keep the app working on webOS 4's Chromium 53 — the compat gates, polyfills, the two legacy stylesheets, and the chromium-53-simulation E2E project. Use when adding browser APIs or polyfills, editing CSS layout, touching css/legacy-*.css, or writing or debugging E2E tests.
---

# Legacy engine (webOS 4 / Chromium 53)

esbuild builds with `target: ['chrome53']`. Modern *syntax* is down-levelled;
modern *APIs* are not, and they fail silently on a TV — often as a blank
loading screen. **Don't change the target without reason.**

## The two static gates

- **Source lint** (`npm run lint`): `eslint-plugin-compat` plus a method
  denylist in `eslint.config.mjs`, derived from the shared `DENYLIST` in
  `scripts/compat-gate.mjs` and keyed to the `chrome 53` browserslist. It
  flags `.flat()`, `.at()`, `replaceAll`, `structuredClone`, and so on.
- **Bundle scan** (build time): `esbuild.config.mjs` AST-scans a
  non-minified app bundle (`scanBundle`, using the TypeScript compiler API,
  so string/comment hits and `typeof` guards are ignored). It catches
  post-53 APIs pulled in by **dependencies**, which the lint never sees, and
  fails the build.

`scripts/compat-gate.mjs` holds both the `DENYLIST` and the `ALLOWLIST` of
accepted exceptions (`polyfilled`, `guarded`, `accepted-risk`).

## Polyfills

Installs live in `src/polyfills.ts`, imported first by both `src/app.ts` and
`src/workers/app-worker.ts`. Examples: `Array.prototype.flatMap`,
`Object.fromEntries`, `ParentNode.append`, and `Node.getRootNode`, all used
unguarded by the bundled `assjs`. Every install must be feature-detected.

**`scrollIntoView` options.** Chromium 53 has `scrollIntoView` but treats an
options object like the legacy `true`, aligning hovered items to the top;
pointer hover can then loop scroll and focus to the end of a list. The
polyfill detects `scrollBehavior` and, on webOS 4, handles options objects
with a manual nearest/start fallback while leaving no-argument and boolean
calls native.

## Legacy stylesheets — load order is the contract

- `css/legacy-webos-base.css` is **auto-generated** by
  `scripts/css-transforms.mjs` on every build: webOS 4/5/6 lack flex `gap`,
  so it emits `> * + *` margins. Never hand-edit it; commit the regenerated
  file. It is linked **first**, so a component rule of equal specificity (a
  `margin: auto` in particular) still wins.
- `css/legacy-webos-overrides.css` is hand-written and linked **last**,
  because its Grid and backdrop-filter fallbacks must beat component CSS.

Put a new legacy rule in the file matching its intent; don't add selector
specificity to force the cascade. Component stylesheets between the two are
order-independent: break a cross-file tie with a compound selector
(`.playlist-tabs.epg-playlist-tabs`), not with link order.

**Never let a modern selector share a rule with a legacy one.** Chromium 53
drops an unsupported *declaration* alone, but drops the *whole rule* when
its selector list holds a selector it cannot parse:
`.x.focused, .x:focus-within { }` loses both. The stylelint rule
`iptv/no-mixed-legacy-selector` (`stylelint.config.mjs`) enforces this
with the simulation's `isPost53Selector`. Selector names come from
`@mdn/browser-compat-data` (`css.selectors`); new grammar inside a
supported selector (`:not(a, b)`, `of` in `:nth-child`, …) is mapped in
`GRAMMAR_SUBFEATURES` / `NON_GRAMMAR_SUBFEATURES`. After a BCD bump, the
`unclassifiedSelectorFeatures()` test fails until each new subfeature
is classified there.

## Fallbacks must stay inert on a modern TV

A leaked fallback double-applies on top of the real feature (an unguarded
`:focus` ring once stacked a second glow inside a `:focus-within` one). So
every rule in both legacy stylesheets sits under a top-level
`@supports not (...)`, and every polyfill is feature-detected. Three checks
pin this:

- `e2e/legacy-fallbacks.spec.ts`: on `chromium`, each legacy `@supports`
  condition is false and each polyfilled API is still `[native code]`; on
  `chromium-53-simulation`, the same APIs are ours.
- `scripts/css-transforms.test.mjs`: catches an unguarded rule without a
  browser.
- `scripts/polyfilled-apis.mjs`: the polyfill list, pinned by discovery. The
  simulation scans built-ins for non-native functions and requires each to be
  listed, so a polyfill added anywhere fails the suite (that is how the
  esbuild banner's `Object.getOwnPropertyDescriptors` surfaced). Every entry
  must be reachable by the removal set — `simulationCoverageGap()` must stay
  empty. Declare an install gated on something else through
  `INSTALLED_WITH`: `fetch` is wrapped only because `AbortController` was
  replaced, and `scrollIntoView` is gated on CSS `scroll-behavior`.

## The chromium-53-simulation E2E project

Playwright's engine passes every `@supports` guard and has every API, so a
broken fallback can ship green (one did). `npm run test:e2e` therefore runs
the whole suite twice: `chromium`, and `chromium-53-simulation`, which
degrades both axes from `scripts/chromium-53-simulation.mjs`:

- **Cascade.** The project sends an `x-legacy-engine` header, and the
  preview server rewrites each stylesheet: `@supports not (...)` blocks
  hoisted in place, `gap` stripped, unparsable syntax discarded. Hoisting
  every guard models Chromium 53, the only target below the Grid cutoff;
  webOS 5/6 need a subset, so the oldest target covers them.
- **APIs.** Every API newer than Chromium 53 (from
  `@mdn/browser-compat-data`) is deleted before the app loads, CSSOM
  reflections included, since `style.someProperty` is how code
  feature-detects CSS. This covers APIs the denylist never named, calls
  reached only at runtime, and whether the polyfills take effect.
  `addInitScript` reaches page realms only, so the worker (the M3U/XMLTV
  parser and search index) gets the same removal from a prelude that
  `scripts/serve.mjs` prepends to its bundle. `KEEP_GLOBALS` exempts only
  what the harness or desktop preview needs: exempting `AbortController` for
  hls.js once silently cost the app's own polyfill its coverage.

## Writing E2E tests

- Assert legacy layout with geometry (`getBoundingClientRect`), which holds
  in both projects.
- Guard a test that *introspects* through a newer API — rather than
  exercising app behavior — with `isChromium53()` from `e2e/helpers.ts`.
- Playwright reuses a running preview server. After source changes, rebuild
  with `node esbuild.config.mjs --preview` before rerunning against it.
- The simulation removes what the source declares but cannot reproduce
  layout or V8 differences at equal feature support; engine-level checks
  still need a real device (see the `webos-device` skill).
