# Add optional webOS 4.x (Chromium 53) compatibility

## Summary

This PR lets the app run on **webOS 4.x TVs (Chromium 53)** — one generation below
the current baseline of webOS 5 (Chromium 68). All changes are **additive and
self-gating**: on webOS 5+ nothing changes (polyfills no-op when the API exists,
CSS fallbacks only apply when Grid is unsupported, the build target default is
unchanged). There is **zero behavior change on currently supported platforms**.

Motivation: webOS 4.x (2018 LG TVs) is still widely used and rooted via Homebrew
Channel, but the app currently fails to boot there. The failures are a handful of
post-Chromium-53 features. Each is addressed below.

## What breaks on Chromium 53, and the fix

1. **`\p{...}` Unicode property escapes in regex** (Chrome 64+) throw a
   `SyntaxError` at parse time, which crashes the entire bundle before the app
   renders. Two files used them (`group-icon.ts`, `channel-search.ts`). Replaced
   with explicit Unicode ranges that behave the same after `normalize('NFD')` —
   the same approach `channel-search.ts` already used elsewhere
   (`[\u0300-\u036f]`). Unconditional change; equivalent on all engines.

2. **Missing runtime APIs.** Added `src/polyfills-legacy.ts`, a companion to the
   existing `polyfills.ts`, covering the 53→68 gap: `globalThis` (71),
   `Array/String.prototype.at` (92), `Promise.prototype.finally` (63),
   `Promise.allSettled` (76), `Object.entries/values` (54), `padStart/padEnd`
   (57), `Array.prototype.flat` (69), `Intl.PluralRules` (63),
   `AbortController/AbortSignal` (66), `String.prototype.replaceAll` (85). Every
   install is guarded exactly like the existing polyfills, so it is a **no-op on
   webOS 5+**. Imported first in `src/app.ts`.

3. **CSS Grid** is unsupported on Chromium 53, so `display: grid` collapses to
   block: the settings nav stacks above the content (instead of beside it) and
   theme swatches stack in one column. Added a flex fallback in
   `css/legacy-webos.css` gated on `@supports not (display: grid)`, so webOS 5+
   (which has Grid) is untouched.

4. **Build target.** `esbuild.config.mjs` hardcoded `['chrome68']`, which emits
   syntax (`?.`, `??`) that Chromium 53 can't parse. Made the target overridable
   via an env var **without changing the default**:
   `WEBOS_TARGET=chrome53,es2015 npm run build`. Shipped builds are unaffected.

## Testing

Built with `WEBOS_TARGET=chrome53,es2015` and installed on an LG webOS 4.10 TV
(Chromium 53, rooted via Homebrew Channel). The app boots, loads M3U playlists,
renders the channel list and settings correctly (nav beside content), and plays
streams. On a webOS 6 TV the build is byte-for-byte the same as before when built
without the env var, and behaves identically when built with the default target.

## Notes / scope

- Kept intentionally minimal and non-invasive: no default behavior changes, no new
  dependencies, no changes to existing features.
- Did **not** include a CORS proxy fallback (some playlist hosts lack CORS headers
  on old WebViews) since that depends on third-party services and is a policy
  choice better left to the maintainer. Happy to open a separate discussion if of
  interest.

## Files

- `M src/components/group-icon.ts` — `\p{}` → explicit ranges
- `M src/utils/channel-search.ts` — `\p{}` → explicit ranges
- `A src/polyfills-legacy.ts` — Chromium 53 polyfills (self-gating)
- `M src/app.ts` — import `polyfills-legacy` first
- `M esbuild.config.mjs` — `WEBOS_TARGET` env override (default unchanged)
- `M css/legacy-webos.css` — Grid fallback under `@supports not (display: grid)`
