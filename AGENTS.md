# AGENTS.md

IPTV player for LG webOS TVs. Vanilla TypeScript (no UI framework), bundled
with esbuild and packaged as a webOS `.ipk`. A separate bundled webOS JS
service (`bundled-service/`) provides LAN M3U uploads over Luna + HTTP. App
id `com.lennylxx.iptv`; targets webOS 4+ (Chromium 53).

## Skills

Procedural workflows live in `.agents/skills/` (open Agent Skills format;
`.claude/skills` is a symlink to it). Load the matching skill before acting:

| Skill | Use when |
| --- | --- |
| `feature-review` | A feature is implemented and its tests pass — run it unasked. |
| `commit` | The user asks to commit. |
| `ui-design` | Building or restyling a view, overlay, or component, or reviewing a UI change. |
| `ui-copy` | Adding or changing any user-visible string, naming a feature, or translating. |
| `legacy-engine` | Adding browser APIs/polyfills, editing CSS layout or `css/legacy-*.css`, writing or debugging E2E tests. |
| `webos-device` | Installing on a TV, or debugging what only reproduces on device. |

## Key rules

- Modern *APIs* silently break webOS 4. `npm run lint` and the build gate
  must pass; never change the esbuild `chrome53` target without reason.
- Render with `morph()` + the `html` template — never `innerHTML =`.
  Interpolate untrusted M3U/XMLTV text only through `html`.
- Every bug fix ships with a regression test that fails without the fix.
- Tests and docs use synthetic identifiers only.
- Never hand-edit the version in `appinfo.json` (it syncs from
  `package.json`), and never hand-edit the generated
  `css/legacy-webos-base.css`.
- CSS: never put a modern selector (e.g. `:focus-within`) in the same rule
  as a legacy one — Chromium 53 drops the whole rule (stylelint
  `iptv/no-mixed-legacy-selector` enforces it). Every legacy fallback
  sits under a top-level `@supports not (...)`; every polyfill is
  feature-detected.
- Chromium 53 treats a `scrollIntoView` options object as `true`;
  `src/polyfills.ts` fixes it, so never bypass or reimplement that call.
- `bundled-service/` runs on Node.js 0.12.2: ES5/CommonJS, newer Node APIs
  via `compat.ts`, and `npm run service:smoke` after any change. Read
  `bundled-service/AGENTS.md` before changing the service or its Luna/HTTP
  contract (`setup-client.ts`, `upload-client.ts`, reminder delivery).
- After installing on a TV, cold-restart the app (`build.sh --install`);
  a plain relaunch keeps running the old bundle.
- Commit only when asked, and only through the `commit` skill.

## Commands

```bash
npm install                    # setup
npm run typecheck              # tsc --noEmit (strict)
npm run lint                   # stylelint + eslint Chromium 53 compat gate
npm run build                  # typecheck + esbuild bundle into dist/
npm run preview                # build + serve dist/ at http://localhost:3000
npm test                       # vitest run (unit/integration)
npm run test:watch             # vitest watch
npm run test:e2e               # Playwright, 2 projects (see legacy-engine)
npm run test:all               # lint + unit + e2e
npm run screenshots            # regenerate README screenshots
npm run service:smoke          # bundled service on real Node.js 0.12.2
npm run service:smoke:matrix   # webOS 4-26 Node runtime matrix
./build.sh [--install [device]]  # package the IPK (see webos-device)
```

Run a single test by file or name:

```bash
npx vitest run src/parsers/m3u-parser.test.ts
npx vitest run -t "parses catchup-source"
```

There is no Prettier/autoformatter, but ESLint + stylelint (`npm run lint`)
and `tsc` strictness are real gates.

## CI

`.github/workflows/build.yml` runs typecheck (app, `service`, **and**
`benchmarks`), `npm run lint` and the compat gate, `vitest run`, the esbuild
bundle, `service:smoke:matrix`, and packages the IPK. Pushes/PRs to `main`
build; tagged `v*` pushes publish a GitHub release with the `.ipk`.

## Versioning

`package.json` `version` is the **single source of truth**.
`esbuild.config.mjs` syncs it into `appinfo.json` and the `__APP_VERSION__`
build constant; `scripts/sync-version.mjs` runs on `npm version`.

## Architecture

- **Entry `src/app.ts`** — the `App` class instantiates the top-level
  components, owns a `viewStack`, and routes remote-control input.
  `KeyHandler` (`src/navigation/key-handler.ts`) maps key codes
  (`CONFIG.KEYS`) to a small `Action` union (`up`/`down`/`select`/`red`/… in
  `src/types.ts`); `App.handleKey` dispatches to the active view's
  `handleAction`.
- **Views** are plain `<div>`s in `index.html` (`channels`, `player`, `epg`,
  `settings`, `loading`, plus the Xtream `movies`/`series` catalogs and
  `search`) toggled with `show`/`hide` from `src/utils/dom.ts`.
- **Sections & Xtream catalog** — a persistent `TabBar`
  (`src/components/tab-bar.ts`) docks the **Live / Guide / Movies / Series /
  Settings / Search** sections and hosts the multi-account avatar switcher
  (`account-switcher.ts`); `App` owns section switching. Movies/Series
  (`movies.ts`, `series.ts`) share the browse/grid/detail machinery in
  `CatalogView` (`catalog-view.ts`) over the per-account `xtream-catalog`
  cache, with a **Continue Watching** resume rail. `search.ts` ranks
  channels, programs, movies, and series in one view. Movies/Series require
  an Xtream account; M3U-only setups see Live/Guide/Settings/Search.
- **Components** (`src/components/`) own a DOM subtree and re-render through
  `morph()` (`src/utils/morph.ts`), a keyed in-place reconciler fed by the
  `html` tagged template. Reused nodes keep listeners, focus, and scroll, so
  list items carry a stable `data-key`. Build a `Safe` with `` html`…` `` and
  pass it to `morph`; bind listeners once (delegated), not per render.
  `Player` delegates media loading and desktop hls.js/mpegts.js/Shaka access
  to `PlayerPipeline` (`player-pipeline.ts`) and audio/subtitle state to
  `PlayerTracks` (`player-tracks.ts`). A desktop MSE library owns its own
  tracks behind the `MseEngine` adapters in `src/components/mse/`
  (`isMseActive()`); on webOS everything plays natively, DASH included — see
  `docs/mpeg-dash.md`.
- **Services** (`src/services/`) expose facades such as `PlaylistService`,
  `EpgService`, `StorageService`, `SetupClient`, `UploadClient`, and
  `ReminderService`. `StorageService` keeps boot-critical configuration under
  `iptv_` localStorage keys and fronts durable user records from
  `idb-user-data`; `idb-cache` owns disposable IndexedDB data and
  `idb-database` owns the shared schema/transactions. A localStorage quota
  error evicts parsed-playlist and stream-MIME caches before retrying.
  `ReminderService` stores reminders, schedules an Activity Manager callback
  per reminder, and resolves a launch param back to a channel. Xtream access
  goes through `createXtreamClient` and the IndexedDB-backed `xtream-catalog`
  cache; `media-probe`, `hls-subtitles`, `vod-subtitles`, and
  `ass-subtitles` back the stream-info readout and subtitle rendering.
- **Navigation** (`src/navigation/`) — `SpatialNav` does geometric D-pad
  focus among `[data-focusable]` elements (grouped by
  `[data-nav-container]`); `KeyHandler` also wires pointer/Magic Remote and
  desktop mouse/wheel input.
- **Parsers** (`src/parsers/`) — `parseM3U` / `parseXMLTV` are pure
  functions; keep them tolerant of messy real-world feeds.
- **Config** (`src/config.ts`) — `CONFIG` holds key codes, refresh
  intervals, and player/EPG/storage constants. Prefer it over magic numbers.
- **Bundled service** (`bundled-service/`) — Node.js 0.12.2 CommonJS service
  `com.lennylxx.iptv.service` for LAN setup/uploads and dev-mode reminder
  alerts. See `bundled-service/AGENTS.md`.

## Conventions

- **Build-time constants** `__APP_VERSION__`, `__APP_ID__`, `__SERVICE_ID__`
  are injected via esbuild `define`. Keep all three in lockstep across
  `esbuild.config.mjs`, `vitest.config.ts`, and `src/globals.d.ts`.
- **XSS safety.** Channel names, program titles, group titles, and logo URLs
  come from untrusted M3U/XMLTV. Always interpolate them through `html`
  (auto-escapes); wrap only genuinely trusted markup in `raw(...)`. E2E tests
  guard this.
- **TS strictness.** `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns` are on — unused symbols fail `typecheck`/CI.
- **Tests** are colocated as `*.test.ts`. Vitest defaults to `node`;
  DOM tests opt in with `// @vitest-environment jsdom` as the **first line**.
- **Synthetic identifiers only — in tests _and_ `docs/`.** No real channel
  names, brands, domains, URLs, audio-track names, or locale-specific
  language codes, in fixtures, log samples, or doc examples. Use
  `http://host/a`, `ch1`/`ch2`, `Track 1/2/3`, `l1`/`l2` (existing
  Alpha/Bravo/Charlie are fine).
- **Logging** uses `createLogger('Tag')` (`src/utils/logger.ts`), giving
  `[Tag]`-prefixed output. Prefer it over bare `console`.
- **Comments** are sparse — a one-line `//` only for a non-obvious *why*. No
  JSDoc that restates a name. Match the surrounding file's density.

## webOS platform gotchas

- **No exotic Unicode *symbols* in UI text.** The TV's `LG Smart UI` font
  covers whole scripts (Latin/Cyrillic/Greek/Korean, with `LG_Display` for the
  rest), but uncommon *symbols* (e.g. `↺`) render as a blank box. Use an
  **inline SVG** (`fill: currentColor`), as the EPG replay indicator does.
- **Audio tracks switch via `audioTracks[i].enabled`.** The list holds one
  entry **per distinct `LANGUAGE`** with empty `label`/`language`, so names
  come from parsing the master `EXT-X-MEDIA`. **Don't** call
  `com.webos.media/selectTrack` directly: it decode-errors on a track the
  pipeline didn't demux. See `docs/audio-track-selection.md`
  (`src/utils/audio-tracks.ts`).
- **Subtitles switch via `textTracks[i].mode`** on webOS and
  `hls.subtitleTrack` in the preview. They're **off by default** (unless
  `FORCED=YES`); the choice, including *off*, is remembered per channel.
  On-device the app self-renders in-manifest WebVTT into a Blink `TextTrack`,
  so `::cue` styling applies; CEA-608/708 and TTML/IMSC ride the native
  compositor via Luna `setSubtitleEnable`. See `docs/hls-subtitles.md`; VOD
  subtitles (native, SRT/WebVTT, ASS/SSA) are in `docs/vod-subtitles.md`.
- **Magic Remote OK fires a normal `click`** — the full trusted pointer/mouse
  sequence, with `click.target` the topmost element, even over the native
  video plane ([LG guide](https://webostv.developer.lge.com/develop/guides/magic-remote)).
  Drive pointer activation from a `click` listener local to the component,
  not `mouseup`. Components that self-activate mark their root
  `data-self-activate` so the global click handler in `key-handler.ts`
  doesn't double-fire `select`.

## Workflow

- Prefer small, surgical changes that fit the existing architecture over a
  new state container, UI framework, or ad hoc pattern.
- When changing UI behavior, preserve the remote-control and desktop-preview
  experience; keep key handling, focus navigation, and view transitions
  consistent with the `App`/`KeyHandler`/component flow.
- When changing parsers, services, or bundled-service messaging, add or
  update the colocated tests for the touched module.
- **Every bug fix ships with a regression test** — whether the bug came from
  a review, the user, or anywhere else. Add the narrowest test that covers
  it (unit where possible, E2E for UI or focus behavior), and confirm it
  fails without the fix and passes with it.
- **Done** means `npm run typecheck`, `npm run lint`, and the relevant tests
  pass. Then run the `feature-review` skill for any finished feature.
- **Git:** commit directly to `main`, only when asked, via the `commit`
  skill — full suites first, user-approved message, lines ≤ 72, no trailers.
