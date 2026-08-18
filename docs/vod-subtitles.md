# VOD subtitles (Xtream movies & episodes)

How this app handles subtitles for **VOD** — Xtream movies and series episodes, played as
progressive `<video src>` (mp4/mkv) through the native pipeline. Two independent sources feed one
picker: subtitles muxed **in the container**, and **sidecar** files listed by the panel. Sidecars
render one of two ways by format: SRT/WebVTT as native `<track>`s, ASS/SSA through an `assjs`
overlay.

| | |
|---|---|
| **Code** | `src/components/player-tracks.ts`, `src/components/player-pipeline.ts`, `src/services/vod-subtitles.ts`, `src/services/ass-subtitles.ts`, `src/utils/srt.ts`, `src/services/xtream-client.ts`, `src/utils/subtitle-tracks.ts` |
| **Live/HLS counterpart** | [`hls-subtitles.md`](hls-subtitles.md) |
| **Audio counterpart** | [`audio-track-selection.md`](audio-track-selection.md) |

## TL;DR

- In-container and SRT/WebVTT sidecars surface as native `video.textTracks`, so one path drives
  them: `nativeSubtitleOptions` enumerates the `subtitles`/`captions` tracks for the picker, and
  a pick sets `textTracks[i].mode` (`'showing'` / `'disabled'`; `-1` = all off).
- ASS/SSA sidecars can't be a native `<track>`; they join the **same picker** as synthetic
  options at `ASS_SUBTITLE_BASE + i` and are drawn by `assjs` into an `#ass-overlay`.
- **Off by default** unless a saved pick applies. The choice is **remembered per item** under a
  `vod:<account>:<kind>:<itemId>` key — the same key the VOD audio memory uses.
- Blink draws the native-track cues (like the HLS self-render path), so `::cue` styling applies
  on-device; `assjs` draws ASS cues as HTML/CSS in the overlay.
- The player can also **search online** for a subtitle (SubDL, OpenSubtitles, and Assrt) — always
  offered for VOD once a provider is configured, not only when the bundled tracks come up empty;
  downloaded results reuse the in-memory-text paths for SRT/WebVTT/ASS and are cached to
  avoid re-fetching on replay.

## In-container subtitles

Progressive VOD exposes any subtitle streams muxed into the mp4/mkv as real
`video.textTracks`, so no self-render is needed. `subtitleOptions()` branches on `this.vod` to
`nativeSubtitleOptions(videoEl.textTracks)`; `applySubtitleChoice()` toggles the chosen
track's `mode`. The saved pick (or explicit *off*) is re-applied from `applyNativeSubtitleSelection`
once the tracks arrive (`loadedmetadata` / `addtrack`).

## Sidecar subtitles

Xtream `get_vod_info` / `get_series_info` may list external subtitle files under
`info.subtitles[]` (usually `.srt`, sometimes `.ass`/`.ssa`). `xtream-client`'s `parseSubtitles`
keeps only entries with an **absolute http(s) URL** — panels vary, and a filename we can't
resolve is useless (and unsafe to guess at). These ride the `VodPlayback` into the player, which
splits them by extension (`isAssSidecar`): SRT/WebVTT go to `VodSubtitles`, ASS/SSA to
`AssSubtitles`.

### SRT / WebVTT — native `<track>`s

On play, `VodSubtitles.attach` creates one empty `<track>` per SRT/WebVTT sidecar on the
`<video>`, so it lists in the picker via the same `nativeSubtitleOptions` path as in-container
tracks. The cues are fetched, converted and parsed the **first time the track is shown**
(`VodSubtitles.ensureLoaded`): a `WEBVTT` file is parsed directly, anything else is treated as
SRT and converted first (`srtToVtt` / `parseSubtitleFile` in `src/utils/srt.ts` — SRT differs only
in the `,mmm` fraction separator and the missing header; its numeric sequence lines are valid
WebVTT cue identifiers).

Because the `<track>`s are `<video>` children, the player's `innerHTML` reset between streams
(`loadStream` / `stop`) removes them and their tracks — nothing leaks from one item into the next.

### ASS / SSA — `assjs` overlay

ASS/SSA carry positioning, styling and karaoke a `<track>` can't express, so they're rendered by
[`assjs`](https://github.com/weizhenye/ass) (MIT) — a DOM/CSS ASS renderer. DOM/CSS was chosen
over libass/WASM so **the browser does font fallback** (the TV's system fonts, incl. CJK, with
**no bundled fonts**) and it stays small (tens of KB) and degrades feature-by-feature on old
browsers rather than breaking — so the core renders at the compatibility floor, while
newer TVs get the advanced tags. `assjs` is loaded with a **lazy dynamic `import('assjs')`** that
esbuild keeps in a deferred `__esm` wrapper, so a TV that never plays ASS never runs it; an import
or fetch failure logs a warning and leaves subtitles off (never a crash or blank screen).

`AssSubtitles` (`src/services/ass-subtitles.ts`) owns the `assjs` instance and an `#ass-overlay`
`<div>` positioned over the video plane (`pointer-events:none`, below the OSD/menu). Since ASS
sidecars aren't native tracks, `subtitleOptions()` appends a synthetic `SubtitleOption` per ASS
sidecar at index `ASS_SUBTITLE_BASE + i` (a high base, disjoint from real textTracks indices and
the `-1` Off / `-2` CC sentinels). `applySubtitleChoice` routes by range: an ASS index shows that
sidecar (`AssSubtitles.show(i)`) and disables every native track; a native index or Off calls
`AssSubtitles.hide()` — **one path draws at a time**. A `gen` counter guards a race where a newer
selection/stop lands mid-fetch; `stop` calls `AssSubtitles.destroy()` to tear down the instance
and drop the overlay.

Memory is unchanged: an ASS pick is remembered by name/lang under the same
`vod:<account>:<kind>:<itemId>` key, and `chooseSubtitleIndex` matches it across all options
(native and ASS), so it restores like any other pick.

**Fetch:** the sidecar is a plain cross-origin GET of the panel-provided URL. It works on-device
(as the HLS subtitle-segment fetch does); the desktop preview is subject to CORS.

## Online subtitle search (SubDL, OpenSubtitles & Assrt)

The player can also search **external subtitle databases** and apply a result in-memory. It's
offered for **any** VOD item once a provider is configured (not only when the bundled tracks are
empty), so a user can swap in an online subtitle when a bundled one is out of sync or in the wrong
language. Downloaded subtitles reuse the sidecar paths (SRT/WebVTT → native `<track>`, ASS/SSA →
`AssSubtitles` overlay), and the pick + its text are cached so replay never re-fetches.

| | |
|---|---|
| **Code** | `src/services/subtitle-search/` (types, subdl-provider, opensubtitles-provider, assrt-provider, subtitle-search-service), `src/components/subtitle-search-overlay.ts`, `src/utils/unzip.ts`, `src/utils/subtitle-decode.ts` |
| **Player integration** | `src/components/player-tracks.ts` (`openSubtitleSearch`, `applyOnlineSubtitle`, `restoreOnlineSubtitle`) |
| **Persistence** | Downloaded text in `src/services/idb-cache.ts`; picks in the `online-sub-picks` user store through `src/services/storage-service.ts` |
| **Settings** | `src/components/settings.ts` (Online Subtitles block) |

### Providers

`types.ts` defines `SubtitleProvider` (a common `search` + `download` interface); each provider is
a factory reading its config from `StorageService`.

- **SubDL** — `api.subdl.com`, `api_key` param, no login. Downloads are `.zip` archives extracted
  by `firstSubtitleFromZip` (`src/utils/unzip.ts`, a lazy `import('fflate')`).
- **OpenSubtitles** — `api.opensubtitles.com` (REST). Needs an `Api-Key` header **and**
  username/password: the provider logs in for a token, caches it, and does one silent re-login +
  retry on `401`. Its results include a **download count**.
- **Assrt** — `api.assrt.net`, a Chinese-subtitle community with a JSON API and no WAF. Ships a
  built-in shared token (`DEFAULT_ASSRT_TOKEN`), so `isConfigured()` is always true and Assrt is
  **on by default** (the "Search online…" entry therefore shows for every VOD); a personal token
  in Settings overrides it. Chinese subs are often GB18030, so it decodes raw bytes via
  `decodeSubtitleBytes` (UTF-8 strict, then GB18030).

The aggregator `subtitleSearchService` runs every configured provider in parallel, merges the
results, and ranks them: **preferred language first**, then download count, then provider order.
A provider that throws is logged and skipped, not fatal.

### Search keys

The player builds a `SubtitleQuery` from `VodPlayback.searchMeta` (populated by the catalog views
from `get_vod_info` / `get_series_info`): `imdbId`/`tmdbId`/`year` for movies, `season`/`episode`
for episodes, and `title` as the always-available fallback.

### Player UI

The subtitle picker gains a **"Search online…"** entry (index `-3`, `SEARCH_ONLINE_INDEX`), shown
only for VOD with a provider configured. It opens a `SubtitleSearchOverlay` that shows "Searching…"
then a D-pad list. Each row reads `<Provider> · <Language> · <ReleaseName> · HI` with the
**download count** right-aligned as a `DOWNLOAD_ICON` badge when the provider supplies one.
All provider text is untrusted, rendered through `html` (escaped). Selection is wired through
the overlay's `click` handler so desktop pointers and the Magic Remote use the same activation path.

A **persistent search box** sits above the list, prefilled with the detected title. Opening runs
the structured search automatically; pressing **Up** from the top result focuses the box, and
editing + **Enter** re-runs the search with `manualQuery` set (the player's `runSubtitleSearch`),
which overrides the structured keys — for items with no IMDb/TMDB id or a mislabeled title. The box
owns its own `keydown` (Enter submits, Down hands off to the results, Back returns to the list),
matching the Search section's box; because the box is always present, "No subtitles found" and
search errors render inline **without auto-closing**, so the user can retry (only the post-pick
"Download failed" message auto-dismisses).

### Applying & restoring

`applyOnlineSubtitle` downloads the subtitle (`{ text, format }`), caches the text in IndexedDB
(`setCachedSubtitle`, keyed `<providerId>:<id>`), and saves the pick metadata per item
in the `online-sub-picks` user store, keyed `<accountId>|<kind>|<itemId>`. The text is handed to the existing
renderers as an in-memory sidecar (a `text` field instead of a `url`): SRT/WebVTT via
`VodSubtitles.addOnline`, ASS/SSA via a synthetic `vodAssSidecars` entry.

On replay, `restoreOnlineSubtitle` reads the saved pick, tries the IndexedDB cache first (a
hit never calls the provider — important for OpenSubtitles' ~5 downloads/day free tier), and only
re-downloads on a cache miss.

### Settings

The **"Online Subtitles"** block has a **Preferred subtitle language** custom dropdown (D-pad
friendly, no native `<select>`) plus per-provider credential fields: SubDL API key, OpenSubtitles
API key + username/password, and an optional Assrt token (blank = shared token). The preferred
language bumps matching results to the top and is stored as a language code (e.g. `zh-CN`); the
OpenSubtitles password lives only in the TV's `localStorage`.

### Caveats

- **On-device only.** Provider API calls are cross-origin; only the webOS WebView (which ignores
  the CORS rules browsers enforce) can make them — `npm run preview` can't.
- **OpenSubtitles `User-Agent`.** Its API wants a `User-Agent` header that scripts can't set in a
  WebView, so verify OpenSubtitles downloads on a real TV; SubDL/Assrt are lower-risk.
- **No exotic Unicode symbols in UI text.** Provider labels and release names are escaped, but the
  TV's font won't render uncommon symbols — stick to letters, digits, punctuation.

## Subtitle offset (sync)

The same per-stream offset (positive = later, step 0.25 s, range ±60 s; remembered under
`vod:<account>:<kind>:<itemId>`) applies to VOD:

- **Sidecar SRT/WebVTT** cues are owned by `VodSubtitles`, so `setOffset(s)` bakes the
  offset into loaded cues and shifts existing ones.
- **ASS/SSA** uses `assjs`'s `ass.delay = s` (remembered so a later `show()` re-applies it).
- **In-container native tracks** are foreign (the demux owns the cues); they are shifted
  best-effort by `shiftForeignTrack` (idempotent, base-time cache) — if the platform
  rejects cue-time mutation the cues simply stay unshifted.
