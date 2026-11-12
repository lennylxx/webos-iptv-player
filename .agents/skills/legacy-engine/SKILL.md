---
name: legacy-engine
description: Keep the app working on webOS 4's Chromium 53 — the compat gates, polyfills, the two legacy stylesheets, and the chromium-53-simulation E2E project. Use when adding browser APIs or polyfills, editing CSS layout, touching css/legacy-*.css, or writing or debugging E2E tests.
---

# Legacy engine (webOS 4 / Chromium 53)

esbuild builds with `target: ['chrome53']`. Modern *syntax* is down-leveled;
modern *APIs* are not, and they fail silently on a TV — often as a blank
screen. **Don't change the target without reason.**

## The two static gates

- **Source lint** (`npm run lint`): `eslint-plugin-compat` plus a method
  denylist in `eslint.config.mjs`, derived from the shared `DENYLIST` in
  `scripts/compat-gate.mjs` and keyed to the `chrome 53` browserslist. It
  flags `.flat()`, `.at()`, `replaceAll`, `structuredClone`, and so on.
  Its `call-option` entries also flag option-object properties that
  Chromium 53 silently ignores or misreads on an existing call:
  `addEventListener(…, { once })` (`once` is ignored; the listener stays —
  use `onceTransitionEnd` or remove it by hand) and
  `focus({ preventScroll })` (ignored; use `focusWithoutScroll`, both in
  `src/utils/dom.ts`).
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
  `scripts/css-transforms.mjs` on every build: `> * + *` margins for flex
  `gap` (missing on webOS 4/5/6) under `html.q-no-flex-gap`, and scroll-end
  spacers under `html.q-scroll-end-padding`. Never hand-edit it; commit the
  regenerated file. It is linked **first**, but the quirk class makes each
  rule more specific than a plain component rule, so a component rule that
  must still win (a `margin-left: auto` push, a `::after` opt-out) is
  restated under the same class in `legacy-webos-overrides.css`.
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

## Engine quirks — measured, not proxied

Some legacy behavior is not a feature, so `@supports` cannot test it:
`@supports (gap: …)` is true for grid gap alone, and Chromium before 91
leaves a row flex scroller's end padding out of its scroll width.
`src/engine-quirks.ts`, imported right after `polyfills` in `src/app.ts`
(not in the worker), measures each with a hidden probe at boot and sets a
`q-*` class on `<html>` only where the quirk exists. Measure behavior;
never parse the user agent. The simulation measures both: `q-no-flex-gap`
for real, and `q-scroll-end-padding` because its init script under-reports
`scrollWidth` on the `data-quirk-probe` scroller. On `chromium`, a test that
needs the spacers adds `q-scroll-end-padding` itself. Neither quirk names a
grid: a single-row grid's generated margins sit under
`@supports not (display: grid)`, since Chromium 66–83 has grid gap without
flex gap. `scripts/css-transforms.test.mjs` rejects any `html.q-*` class
missing from `QUIRK_CLASSES`. The classes land when `app.js` runs, before
it shows any view, so no static markup may rely on a generated margin.
`e2e/legacy-layout-parity.spec.ts` unscopes
every quirk rule in place and fails on any element whose margins move, which
is how an out-specified component rule surfaces.

## Fallbacks must stay inert on a modern TV

A leaked fallback double-applies on top of the real feature (an unguarded
`:focus` ring once stacked a second glow inside a `:focus-within` one). So
every rule in both legacy stylesheets sits under a top-level
`@supports not (...)` or is scoped to an `html.q-*` quirk class, and every
polyfill is feature-detected. Three checks pin this:

- `e2e/legacy-fallbacks.spec.ts`: on `chromium`, each legacy `@supports`
  condition is false, no `q-*` class is set, and each polyfilled API is
  still `[native code]`; on `chromium-53-simulation`, the same APIs are
  ours and both `q-*` classes are set.
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
- **Events.** Deleting `PointerEvent` does not stop the engine firing
  `pointermove`, so DOM events newer than Chromium 53 (`pointer*`,
  `transitionstart`, `auxclick`, …, derived from BCD's `*_event` entries)
  are swallowed by a capture listener on `window` registered before any
  other script; only trusted ones, so a test may still dispatch its own.
  Their `on<event>` handler properties are deleted too, so
  `'onpointermove' in window` detects nothing. Pointer input reaches
  components through KeyHandler's `nav:*` events, which ride on mouse
  events; lint rejects listeners for Pointer Events (`pointer*`,
  `*pointercapture`) everywhere in `src/` (`pointerlockchange` is allowed).
- **Not modeled: call options.** Deleting an API cannot make an engine
  ignore a dictionary member it predates, so `{ once }` and
  `{ preventScroll }` behave natively here. Cover such fallbacks with a
  unit test that models the old engine (a stub that drops the option), as
  `player-menu.test.ts` and `channel-list-editor.test.ts` do.

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
