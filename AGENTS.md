# AGENTS.md

IPTV player for LG webOS TVs. Vanilla TypeScript (no UI framework), bundled with
esbuild and packaged as a webOS `.ipk`. A separate bundled webOS JS service
(`bundled-service/`) provides LAN M3U uploads over Luna + HTTP. App id
`com.lennylxx.iptv`; targets webOS 4+.

## Commands

```bash
npm install                    # setup
npm run typecheck              # tsc --noEmit (TS strict mode — see TS strictness)
npm run service:smoke          # build + gate + real Node.js 0.12.2 service smoke
npm run service:smoke:matrix   # representative webOS 4-26 Node runtime matrix
npm run lint                   # stylelint + eslint webOS 4 / Chromium 53 browser-compat gate
npm run build                  # typecheck + esbuild bundle into dist/
npm run preview                # build + serve dist/ at http://localhost:3000 (desktop video via hls.js/mpegts.js)
npm test                       # vitest run (unit/integration)
npm run test:watch             # vitest watch
npm run test:e2e               # Playwright against the preview server (2 projects)
npm run test:all               # lint + unit + e2e
npm run screenshots            # regenerate README screenshots
./build.sh                     # package the IPK (needs ares-package from @webos-tools/cli)
./build.sh --install [device]  # build + ares-install + cold-restart on a TV
```

Run a single test by file or name:

```bash
npx vitest run src/parsers/m3u-parser.test.ts
npx vitest run -t "parses catchup-source"
```

There is **no Prettier/autoformatter**, but ESLint + stylelint are a real static
gate (`npm run lint`) alongside `tsc` strictness — see the webOS 4 compat gate under
Conventions. Run `npm run typecheck`, `npm run lint`, and the relevant tests before
considering a change done.

Before **every commit**, run both full suites against the final staged changes:

```bash
npm test
npm run test:e2e
```

Targeted UT/E2E runs are sufficient while iterating, but never replace these
pre-commit full-suite runs. Do not commit unless both pass after the final code
change.

## CI

`.github/workflows/build.yml` runs typecheck (app, `service`, **and** `benchmarks`),
`npm run lint` and the compatibility gate, `vitest run`, the esbuild bundle, and
packages the IPK. Pushes/PRs to `main` build; tagged `v*` pushes publish a GitHub
release with the `.ipk`.

After bundled-service changes, run `npm run service:smoke`. It downloads the
official Node.js 0.12.2 archive, verifies its published SHA-256, caches it under
the user cache directory, then parses and exercises the compiled service with
that exact runtime. CI runs `npm run service:smoke:matrix` across Node.js 0.12.2,
8.12.0, 12.21.0, 16.19.1, and 20.12.2, representing webOS 4 through 26. On
Apple Silicon, Node 16/20 use arm64 while older releases use x64 through Rosetta.

## Versioning

`package.json` `version` is the **single source of truth**. `esbuild.config.mjs`
syncs it into `appinfo.json` and the `__APP_VERSION__` build constant;
`scripts/sync-version.mjs` runs on `npm version`. **Never hand-edit the version in
`appinfo.json`.**

## Architecture

- **Entry `src/app.ts`** — the `App` class instantiates the top-level components, owns a
  `viewStack`, and routes remote-control input. `KeyHandler`
  (`src/navigation/key-handler.ts`) maps key codes (`CONFIG.KEYS`) to a small
  `Action` union (`up`/`down`/`select`/`red`/… in `src/types.ts`); `App.handleKey`
  dispatches to the active view's `handleAction`.
- **Views** are plain `<div>`s in `index.html` (`channels`, `player`, `epg`,
  `settings`, `loading`, plus the Xtream `movies`/`series` catalogs and `search`)
  toggled with `show`/`hide` from `src/utils/dom.ts`.
- **Sections & Xtream catalog** — a persistent `TabBar` (`src/components/tab-bar.ts`)
  docks the **Live / Guide / Movies / Series / Settings / Search** sections above the views and
  hosts the multi-account avatar switcher (`account-switcher.ts`); `App` owns section
  switching and a `viewStack`. Movies/Series (`movies.ts`, `series.ts`) share the
  browse/grid/detail machinery in `CatalogView` (`catalog-view.ts`) over the per-account
  `xtream-catalog` cache, with a **Continue Watching** resume rail. `search.ts` ranks
  channels, programs, movies, and series in one view; Movies/Series require an Xtream
  account, while Search remains available for channels and programs. M3U-only setups
  see Live/Guide/Settings/Search.
- **Components** (`src/components/`) own a DOM subtree and re-render through
  `morph()` (`src/utils/morph.ts`), a keyed in-place DOM reconciler fed by the
  `html` tagged template. Reused nodes keep their listeners, focus, and scroll — so
  list items carry a stable `data-key`. **Do not rebuild subtrees with
  `innerHTML =`**; build a `Safe` with `` html`…` `` and pass it to `morph`. Bind
  listeners once (delegated), not per render. `Player` delegates media loading and
  desktop hls.js/mpegts.js/dash.js access to `PlayerPipeline` (`player-pipeline.ts`) and
  audio/subtitle state to `PlayerTracks` (`player-tracks.ts`). A desktop MSE library
  owns its own tracks behind the `MseEngine` adapters in `src/components/mse/`
  (`isMseActive()`); on webOS everything plays natively, DASH included — see
  `docs/mpeg-dash.md`.
- **Services** (`src/services/`) expose application-facing facades such as
  `PlaylistService`, `EpgService`, `StorageService`, `SetupClient`, `UploadClient`,
  and `ReminderService`. `StorageService` keeps boot-critical configuration under
  `iptv_` localStorage keys and fronts durable user records from `idb-user-data`;
  `idb-cache` owns disposable IndexedDB data and `idb-database` owns the shared
  schema/transactions. A localStorage quota error evicts parsed-playlist and
  stream-MIME caches before retrying. `ReminderService` stores reminders, schedules an
  Activity Manager callback per reminder (dev-mode alert vs. retail toast), and
  resolves a launch param back to a channel. Xtream access goes through the
  `xtream-client` factory (`createXtreamClient`) and the IndexedDB-backed `xtream-catalog`
  cache; `media-probe`, `hls-subtitles`, `vod-subtitles`, and `ass-subtitles` back the
  player's live stream-info readout and subtitle rendering (see the subtitle docs).
- **Navigation** (`src/navigation/`) — `SpatialNav` does geometric D-pad focus
  among `[data-focusable]` elements (grouped by `[data-nav-container]`);
  `KeyHandler` also wires pointer/Magic-Remote and desktop mouse/wheel input.
- **Parsers** (`src/parsers/`) — `parseM3U` / `parseXMLTV` are pure functions; keep
  them tolerant of messy real-world feeds.
- **Config** (`src/config.ts`) — `CONFIG` holds key codes, refresh intervals,
  player/EPG/storage constants. Prefer constants here over magic numbers.
- **Bundled service** (`bundled-service/`) — a sandbox-separate Node (CommonJS) webOS
  service (`com.lennylxx.iptv.service`) hosting LAN phone setup/M3U uploads and,
  in Developer Mode, interactive program-reminder **alerts**. The app talks to
  it over the Luna bus
  (`start`/`stop`/`heartbeat`/`serviceEvents` for LAN changes; `getDevMode`/
  `fireReminderAlert` for reminders) and over HTTP; changes push
  `serviceEvents` without polling. Its lifecycle is tied to app
  `visibilitychange`. `index.ts` wires `lan/`, `setup/`, and `reminder/`.
  It targets webOS 4's Node.js 0.12.2: compile to ES5/CommonJS, route newer
  Node APIs through `compat.ts`, and gate the final JavaScript build.
  **Read `docs/lan-service.md` before changing it**, and keep the Luna/HTTP
  contract aligned with `setup-client.ts` and `upload-client.ts`.

## Conventions

- **webOS 4 target.** esbuild builds with `target: ['chrome53']` (webOS 4's
  Chromium). Modern syntax (`?.`, `??`, …) is fine — esbuild down-levels it — but
  modern *APIs* aren't polyfilled and silently fail on a real TV. `npm run lint` is
  the guard: `eslint-plugin-compat` plus a method denylist in `eslint.config.mjs`
  (derived from the shared `DENYLIST` in `scripts/compat-gate.mjs`, keyed to the
  `chrome 53` `browserslist`) flags post-53 APIs — `.flat()`, `.at()`, `replaceAll`,
  `structuredClone`, … — that would otherwise hang the app on a blank loading
  screen. A second, **build-time** gate in `esbuild.config.mjs` AST-scans a
  non-minified build of the app bundle (`scanBundle` in `scripts/compat-gate.mjs`,
  parsing with the TypeScript compiler API — so string/comment hits and `typeof`
  guards are ignored) to catch post-53 APIs pulled in by **dependencies**, which
  the source lint never sees; these fail the build too. That one file holds the
  `DENYLIST` and the `ALLOWLIST` of accepted (`polyfilled`/`guarded`/`accepted-risk`)
  exceptions. Polyfilled fixes are installed in `src/polyfills.ts` (imported first
  in both `src/app.ts` and the `src/workers/app-worker.ts` entry) — e.g.
  `Array.prototype.flatMap`, `Object.fromEntries`, `ParentNode.append` and
  `Node.getRootNode`, all used unguarded by the bundled `assjs`. **Don't change the target without reason.**
- **Two legacy stylesheets, and load order is the contract.** webOS 4/5/6 lack
  flex `gap`, so every build regenerates `> * + *` margins from
  `scripts/css-transforms.mjs` into the checked-in `css/legacy-webos-base.css`
  (auto-generated — never hand-edit; commit the regenerated file). It is linked
  **first**, so a component rule of equal specificity — a `margin: auto` in
  particular — still wins. `css/legacy-webos-overrides.css` is hand-written and
  linked **last**, because its Grid and backdrop-filter fallbacks must beat
  component CSS. Put a new legacy rule in the file matching its intent; don't
  reach for extra selector specificity to force the cascade. The component
  stylesheets between them are order-independent: settle a cross-file tie with a
  compound selector (`.playlist-tabs.epg-playlist-tabs`), not with link order.
- **Simulate webOS 4 — modern Chromium can't see its failures.** Playwright's
  engine satisfies every `@supports` guard and has every API, so a broken
  fallback ships green (one did). `npm run test:e2e` therefore runs the whole
  suite twice: the `chromium` project as usual, and `chromium-53-simulation`,
  which degrades both axes of webOS 4's engine from
  `scripts/chromium-53-simulation.mjs`.
  - *Cascade* — the project sends an `x-legacy-engine` header and the preview
    server rewrites each stylesheet: `@supports not (...)` blocks hoisted in
    place, `gap` stripped everywhere, unparsable syntax discarded. Hoisting
    every guard at once models Chromium 53, the only target below the Grid
    cutoff; webOS 5/6 need a subset, so the oldest target covers them.
    **Never let a modern selector share a rule with a legacy one**: the engine
    drops an unsupported *declaration* alone, but a *whole rule* whose selector
    list holds an unknown pseudo-class — `.x.focused, .x:focus-within { }`
    loses both on webOS 4.
  - *APIs* — every API newer than Chromium 53 (derived from
    `@mdn/browser-compat-data`) is deleted before the app loads, CSSOM
    reflections included, since `style.someProperty` is how code
    feature-detects CSS. This covers what the static gate cannot: APIs the
    denylist never named, calls reached only at runtime, and whether the
    `src/polyfills.ts` installs take effect. `addInitScript` reaches page
    realms only, so the worker — the M3U/XMLTV parser and the search index,
    the least forgiving code in the app — gets the same removal from a prelude
    `scripts/serve.mjs` prepends to its bundle. `KEEP_GLOBALS` exempts what the
    harness or the desktop-only preview needs and nothing more: exempting
    `AbortController` for hls.js silently cost the app's own polyfill its
    coverage.

  Writing a test: assert legacy layout with geometry (`getBoundingClientRect`),
  which holds in both projects, and guard one that *introspects* through a
  newer API — rather than exercises app behavior — with `isChromium53()` from
  `e2e/helpers.ts`. It is a simulation, not an emulation: it removes what the
  source declares, but cannot reproduce layout or V8 behavior that differs at
  equal feature support, so engine-level checks still need a real device.
- **The fallbacks must also stay inert on a modern TV.** A leaked fallback is
  not a no-op — it double-applies on top of the real feature, the way an
  unguarded `:focus` ring once stacked a second glow inside a `:focus-within`
  one. So every rule in both legacy stylesheets sits under a top-level
  `@supports not (...)`, and every `src/polyfills.ts` install is
  feature-detected. Three checks pin that:
  - `e2e/legacy-fallbacks.spec.ts` — `chromium` asserts each legacy `@supports`
    condition evaluates false and each polyfilled API is still `[native code]`;
    `chromium-53-simulation` asserts the same APIs are ours.
  - `scripts/css-transforms.test.mjs` — catches an unguarded rule without a
    browser.
  - `scripts/polyfilled-apis.mjs` — the polyfill list, pinned by discovery
    rather than by documentation: the simulation scans the built-in surface for
    non-native functions and requires each to be a listed entry, so a polyfill
    added anywhere fails the suite (that is how the esbuild banner's
    `Object.getOwnPropertyDescriptors` turned up). Every entry must also be
    reachable by the removal set — `simulationCoverageGap()` has to stay empty,
    or discovery could never notice an install go missing. Declare an install
    gated on something else through `INSTALLED_WITH`: `fetch` is wrapped only
    because `AbortController` was replaced, and `scrollIntoView` is gated on
    CSS `scroll-behavior`.
- **`scrollIntoView` options need a fallback.** Chromium 53 exposes
  `scrollIntoView` but predates its options object and treats that object like
  the legacy `true` argument, aligning hovered items to the top. Pointer hover
  can then create a scroll/focus feedback loop that races to the end of a list.
  `src/polyfills.ts` detects `scrollBehavior` support and wraps the native
  method on webOS 4: options objects use a manual nearest/start fallback, while
  no-argument and boolean calls retain native behavior.
- **Build-time constants** `__APP_VERSION__`, `__APP_ID__`, `__SERVICE_ID__` are
  injected via esbuild `define`. Keep all three in lockstep across
  `esbuild.config.mjs` (build), `vitest.config.ts` (tests), and the `declare const`
  in `src/globals.d.ts`.
- **XSS safety.** Channel names, program titles, group titles, and logo URLs come
  from untrusted M3U/XMLTV. Always interpolate them through the `html` tagged
  template (auto HTML-escapes); only wrap genuinely trusted markup in `raw(...)`.
  There are e2e tests guarding this — don't regress it.
- **TS strictness.** `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns` are on — unused symbols fail `typecheck`/CI.
- **Tests** are colocated as `*.test.ts` next to source. Vitest defaults to the
  `node` environment; DOM-dependent tests opt in with `// @vitest-environment jsdom`
  as the **first line** of the file.
- **Synthetic identifiers only — in tests _and_ `docs/`.** No real channel names,
  brands, domains, URLs, audio-track names, or locale-specific language codes — not in
  fixtures, not in log samples, not in doc examples. Use `http://host/a`, `ch1`/`ch2`,
  `Track 1/2/3`, `l1`/`l2` (existing Alpha/Bravo/Charlie are fine).
- **Logging** uses `createLogger('Tag')` (`src/utils/logger.ts`); output is
  `[Tag]`-prefixed for filtering in `ares-inspect`. Prefer it over bare `console`.
- **Comments** are sparse — a one-line `//` only for non-obvious *why*. No JSDoc
  that just restates a name. Match the surrounding file's density.

## webOS platform gotchas

- **No exotic Unicode *symbols* in UI text.** The TV's `LG Smart UI` font renders
  whole scripts fine (Latin/Cyrillic/Greek/Korean, with a `LG_Display` fallback for
  the rest), but uncommon *symbols* (e.g. the replay arrow `↺`) fall through to a
  deep last-resort font the WebView won't reach and render as a blank box. Use an
  **inline SVG** (`fill: currentColor`) instead — that's why the EPG replay
  indicator is SVG.
- **Audio tracks switch via HTML5 `audioTracks[i].enabled`** on webOS (LG's Chromium maps
  it to the pipeline's `selectTrack`). The list holds one entry **per distinct `LANGUAGE`** —
  same-language renditions collapse, and entries carry empty `label`/`language`, so real names
  come from parsing the master `EXT-X-MEDIA`. **Don't** call `com.webos.media/selectTrack`
  directly: it's reachable but decode-errors on a track the pipeline didn't demux. Full
  writeup in `docs/audio-track-selection.md` (helpers in `src/utils/audio-tracks.ts`).
- **Subtitles switch via HTML5 `textTracks[i].mode`** (`'showing'`/`'disabled'`) on webOS and
  `hls.subtitleTrack` in the desktop preview. Unlike audio they're **off by default** (unless a
  rendition is `FORCED=YES`); the choice — including an explicit *off* — is remembered per
  channel, and real names come from parsing the master `EXT-X-MEDIA:TYPE=SUBTITLES`. On-device
  the app **self-renders** in-manifest WebVTT (the demux never exposes it as a selectable
  `TextTrack`) into a `TextTrack` drawn by Blink, so `::cue` styling — speaker colors and cue
  positioning — applies on the TV too, not just the preview; pipeline caption types
  (CEA-608/708, TTML/IMSC) instead ride the native compositor via Luna `setSubtitleEnable`. Full
  writeup in `docs/hls-subtitles.md` (helpers in `src/utils/subtitle-tracks.ts`,
  `src/utils/webvtt.ts`, `src/services/hls-subtitles.ts`). VOD (Xtream movies/episodes)
  subtitles — in-container native tracks and sidecar SRT/WebVTT plus ASS/SSA — are a separate
  path in `docs/vod-subtitles.md` (`src/services/vod-subtitles.ts`,
  `src/services/ass-subtitles.ts`, `src/utils/srt.ts`).
- **Magic Remote OK fires a normal `click`.** Pressing OK with the Magic Remote
  pointer over an element fires the full `pointerdown`/`mousedown`/`pointerup`/
  `mouseup`/**`click`** sequence, all trusted, with `click.target` = the topmost
  element under the cursor — exactly like a desktop mouse, matching LG's official
  [Magic Remote guide](https://webostv.developer.lge.com/develop/guides/magic-remote).
  This holds even for controls layered over the native video plane (the player OSD
  seek bar / play-pause / Go-to-Live). **So drive pointer activation from a `click`
  listener** (local to the component's subtree), not `mouseup`. Components that
  self-activate mark their root with **`data-self-activate`** so the global click
  handler in `src/navigation/key-handler.ts` skips that subtree and doesn't
  double-fire `select` (see `SpatialNav` + the `[data-focusable]` flow). Coordinate
  hit-testing (vs. `e.target`) is still fine and is used where the target can be
  ambiguous, but it is no longer *required*.
- **Debugging:** `ares-inspect` gives a page-level CDP socket only (Playwright
  `connectOverCDP` fails — connect to the page WebSocket directly). App `console.*`
  is visible only via the DevTools `ares-inspect` opens; `ares-monitor-log` is not in
  the current CLI. `scripts/tv.sh` wraps device access the `tv` CLI profile blocks:
  `tv.sh logs [--app <id>]` tails the app's DevTools console headlessly over CDP (no
  GUI copy-paste), `tv.sh eval '<js>'` evaluates an expression in the app page over CDP
  (probe live DOM/app state from the terminal), and `tv.sh run '<cmd>'` / `push` /
  `shell` cover ssh/scp since `ares-shell`/`ares-push` are disabled in the `tv` profile.
- **`createAlert` is denied to third-party apps; `createToast` isn't.** On webOS the
  interactive `com.webos.notification/createAlert` (buttons) refuses every identity the
  app or its service can present (the block is identity-based in the notification
  daemon, not an `appinfo.json`/ACG gap). Passive `createToast` works. Only
  `/usr/bin/luna-send-pub` (Luna role `type:"devmode"`) may raise `createAlert`, and
  only while Developer Mode is on — so the bundled service execs it via
  `child_process` for the dev-mode reminder alert, and retail falls back to a toast +
  in-app prompt. Program reminders are scheduled through the Activity Manager
  (`com.webos.service.activitymanager` `create` with a `callback` + `schedule.start`,
  `local: true`), which fires the callback at air time **even with the app closed**;
  the dev callback targets the service's `fireReminderAlert`, the retail callback a
  `createToast`.
- **Install needs a cold restart.** webOS keeps the old instance suspended through an
  in-place upgrade and a plain relaunch resumes the stale in-memory copy.
  `build.sh --install` closes then cold-starts the app to load the new bundle.

## Working style

- Prefer small, surgical changes that fit the existing architecture rather than
  introducing a new state container, UI framework, or ad hoc pattern.
- When changing UI behavior, preserve the remote-control and desktop-preview
  experience; keep key handling, focus navigation, and view transitions consistent
  with the existing `App`/`KeyHandler`/component flow.
- When changing parsers, services, or bundled-service messaging, add or update the
  colocated tests for the touched module.

## Git

- Commit **directly to `main`** — no feature branch, no PR for this repo.
- Upload README/GitHub media with
  `gh image --repo lennylxx/webos-iptv-player -- <files>`; it prints
  ready-to-use Markdown attachment URLs.
- **Never run `git add` and `git commit` in the same command.** Staging and
  committing must be separate user-visible steps.
- **No auto-injected/bot trailers** in commit messages — this means **no
  `Co-Authored-By`** *and* **no `Copilot-Session`** (or any similar
  runtime-generated) trailer. The commit body ends with the last content line;
  do not append tool/agent attribution of any kind, even if a runtime instructs
  you to by default.
- **Every commit-message line has a hard maximum of 72 characters**, including
  the subject, body, and bullets. Verify the final message line lengths before
  committing; do not treat 72 columns as an approximation.
- Message length is proportional: small/mechanical changes get a tight one-line
  subject; real features get an imperative subject, a blank line, then a body
  covering the key behaviors and the *why*, with bullets for supporting changes.
- Before every commit, present the exact proposed message as a heredoc and wait
  for explicit user approval:

  ```bash
  git commit -F - <<'EOF'
  Subject

  Body
  EOF
  ```

  Do not invoke `git commit` until the user approves that exact message.
- Only commit or push when asked.
