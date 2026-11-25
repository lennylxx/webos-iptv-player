# VOD subtitles (Xtream movies & episodes)

How this app handles subtitles for **VOD** — Xtream movies and series episodes, played as
progressive `<video src>` (mp4/mkv) through the native pipeline. Two independent sources feed one
picker: subtitles muxed **in the container**, and **sidecar** files listed by the panel. Sidecars
render one of two ways by format: SRT/WebVTT through a reusable application-created `TextTrack`,
ASS/SSA through an `assjs` overlay.

| | |
|---|---|
| **Code** | `src/components/player-tracks.ts`, `src/components/player-pipeline.ts`, `src/services/vod-subtitles.ts`, `src/services/subtitle-translation.ts`, `src/services/ass-translation.ts`, `src/services/ass-subtitles.ts`, `src/utils/srt.ts`, `src/services/xtream-client.ts`, `src/utils/subtitle-tracks.ts` |
| **Live/HLS counterpart** | [`hls-subtitles.md`](hls-subtitles.md) |
| **Audio counterpart** | [`audio-track-selection.md`](audio-track-selection.md) |

## TL;DR

- In-container subtitles surface as native `video.textTracks`. SRT/WebVTT sidecars are synthetic
  picker entries rendered through one reusable track created by `video.addTextTrack()`.
- ASS/SSA sidecars can't be a native `<track>`; they join the **same picker** as synthetic
  options at `ASS_SUBTITLE_BASE + i` and are drawn by `assjs` into an `#ass-overlay`.
- **Off by default** unless a saved pick applies. The choice is **remembered per item** under a
  `vod:<account>:<kind>:<itemId>` key — the same key the VOD audio memory uses.
- Blink draws native and application-track cues, so `::cue` styling applies on-device; `assjs`
  draws ASS cues as HTML/CSS in the overlay.
- The player can also **search online** for a subtitle (SubDL, OpenSubtitles, and Assrt) — always
  offered for VOD once a provider is configured, not only when the bundled tracks come up empty;
  downloaded results reuse the in-memory-text paths for SRT/WebVTT/ASS and are cached to
  avoid re-fetching on replay.
- With AI features on, a shown SRT/WebVTT or ASS/SSA sidecar (bundled or downloaded) can be
  **translated** into the preferred subtitle language; only cue text is sent, timings and ASS
  styling stay on the TV.

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

### SRT / WebVTT — reusable application `TextTrack`

`VodSubtitles.attach` records the SRT/WebVTT sidecars as synthetic picker entries. The first
selection fetches and parses the file, then feeds its cues to one track created with
`video.addTextTrack()`. This matters on older webOS releases: they accept programmatic cues on an
empty DOM `<track>` element but may not paint them, while an application-created track does.

The renderer track is reused because `addTextTrack()` tracks cannot be removed from a persistent
video element. Switching sidecars clears and repopulates its cues; the internal renderer track is
filtered out of the picker so each sidecar appears exactly once under its real name. While the
video is paused, Chromium keeps drawing a removed or rewritten cue until the track's mode changes,
so after a switch, and after a translated batch rewrites a cue on screen, the track goes
`hidden` and back to `showing` in one task (`WebVttCueTrack.redraw`), with no blank frame. Parsed cues
stay cached for the current VOD item. A `WEBVTT` file is parsed directly; anything else is treated
as SRT and converted first (`srtToVtt` / `parseSubtitleFile` in `src/utils/srt.ts`).

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
and drop the overlay. `assjs` starts drawing frames only on a `play`/`playing` event, so an instance made
while the video already plays (a pick or a redraw mid-playback) is started at once.

Memory is unchanged: an ASS pick is remembered by name/lang under the same
`vod:<account>:<kind>:<itemId>` key, and `chooseSubtitleIndex` matches it across all options
(native and ASS), so it restores like any other pick.

**Fetch:** the sidecar is a plain cross-origin GET of the panel-provided URL. It works on-device
(as the HLS subtitle-segment fetch does); the desktop preview is subject to CORS.

## Online subtitle search (SubDL, OpenSubtitles & Assrt)

The player can also search **external subtitle databases** and apply a result in-memory. It's
offered for **any** VOD item once a provider is configured (not only when the bundled tracks are
empty), so a user can swap in an online subtitle when a bundled one is out of sync or in the wrong
language. Downloaded subtitles reuse the sidecar paths (SRT/WebVTT → reusable application
`TextTrack`, ASS/SSA → `AssSubtitles` overlay), and the pick + its text are cached so replay never
re-fetches.

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
from `get_vod_info` / `get_series_info`): `imdbId`/`tmdbId`/`year` for movies; `season`/`episode`
plus the **series'** `imdbId`/`tmdbId` for episodes (OpenSubtitles takes them as `parent_imdb_id`
/ `parent_tmdb_id`, SubDL with the season and episode); and `title` as the always-available
fallback, which Assrt always uses.

`title` is the work's own name, tidied by rules (`cleanSearchTitle` in
`subtitle-search/title-cleanup.ts`): an episode uses its series name, not the player's
`Series — S1E2 — Episode` label. Language/country tags at either end (`|EN|`, `[FR]`, `(DE)`, and
a bare `EN - `, `UK: `, or trailing `| FR` in capitals) are removed only for known codes, so `QXZ: …` or `[QRZ]`
stay. Release tags (`4K`, `1080p`, `HEVC`, `MULTI`, …) are removed only after the title or inside
brackets, and word-like ones (`HD`, `Dual`, `Multi`) only in capitals, so `HD Alpha` stays. A
bracketed year, or the last dotted one, is kept as `year`; the end is cleaned until nothing more
goes, so `Title [EN] (2019) HD` becomes `Title`. A leading capital `IT:` reads as a tag. The search box starts with this title. An episode
resumed from Continue Watching keeps its series' ids, which the resume entry stores.

**AI search title.** When the automatic search finds nothing and AI features are on, the raw
catalog name (only that, with the item type) goes to the AI model (`suggestSearchTitle`, JSON
schema: `title`, `year`, `season`, `episode`, `original_title`). The search runs again by title
alone (ids already found nothing) with the cleaned title (even when it matches the rule-based one,
if the first search went by id), then, if still empty, with the
original or English title the model gave — the one step that relies on the model's own knowledge,
so it only runs second and the user still picks from the release names. The search box shows the
title searched. Replies are cached per name; a typed search never calls the model, and a typed
search or closing the overlay supersedes (and cancels) one under way.
`event=subtitle.search.ai_title outcome=<found_title|found_original|none|unchanged|empty|failed>
results=<n>` (plus `reason` on failure) records each attempt, without the name.

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

## AI subtitle translation

With **Use AI features** on (see the AI features settings), the Subtitles menu adds
**"Translate to {language}"** under the subtitle list while the shown subtitle is an SRT/WebVTT
or ASS/SSA sidecar, bundled or downloaded, whose language differs from the target. The target is the
**Preferred subtitle language**, else the UI language; Traditional and Simplified Chinese count as
different languages. In-container tracks and live subtitles are not translated. The row
stays hidden while AI features are off.

- Picking it adds a picker entry next to its source (a `VodSubtitles.addTranslation` entry that
  starts as a copy of the source cues) and shows it. The menu tags it **"{name} · AI · EN"** with
  the target's code (`targetCode`: ISO 639-1 in caps, 简中/繁中 for Chinese in every UI language), the name giving
  way to the tag; the toast and the OSD name it in full, **"{name} · AI translation ({language})"**.
  Untranslated lines keep the original text; translated batches replace cue text in place
  (`setCueTexts` updates the live `VTTCue.text`), so the offset and sync adjuster still apply.
  While it runs, the entry shows its progress.
- **"Translate to another language…"** opens a **Translation language** list while the shown
  subtitle is a sidecar or its translation: the default target first, then the Settings
  languages, the UI language, and targets already used, less the source's own language. Picking
  one translates into it for this playback only; the Settings language stays, and the title
  remembers the pick like any subtitle choice. Each language keeps its own entry, and the
  one-press row hides only while the default target's translation is shown.
- `SubtitleTranslation` splits the cues into fixed batches (at most 40 lines, a quarter of the
  **Context size** setting) and sends each as numbered plain text, one `[n] text` line per cue
  with `<br>` for a line break, through `LlmService.runText` — never times, titles, or URLs. The
  reply is parsed the same way (full-width `【n】`/`［n］` markers too), so a missing or garbled line
  keeps only that line in the original language. The reply limit is at least 2048 tokens or three
  times the batch, capped by the room the context size leaves. Blank cues are not sent.
- Two workers each take the unfinished batch nearest the **current** playback position (then the
  ones before it), so a seek is translated next; batches within a minute of it go out at
  foreground priority.
- Fixed batches make every usable answer a cache hit on replay (the `llm-cache` store). A reply
  with fewer than half its lines is not cached and leaves the batch for a later run; when the
  first two replies are unusable the run stops with "Subtitle translation failed".
- Rate limits (429), server errors (5xx), timeouts, and network errors retry a batch up to twice,
  after the server's `Retry-After` or 10 s, then 20 s. Any other failure, or the daily limit,
  stops the run with a toast, keeping what was translated.
- Switching to another subtitle stops the run: queued batches are dropped, but batches already
  sent finish and are cached (`finishStarted`), so stopping never wastes a paid request. A stop
  ends quietly even if such a batch fails afterwards, and the first failure ends the run at once
  (toast, Translate row back), cutting short any retry wait; a resumed run waits for the batches
  still out. An identical request already out (e.g. after a quality change rebuilds the job) is
  shared instead of sent again. A
  stopped, unfinished translation brings back **"Translate to {language}"**, which resumes it.
- The pick is remembered with the other subtitle choices as the **source** subtitle plus
  `translateTo`, and restored over its source on replay while AI features are on (otherwise the
  source shows).
- **ASS/SSA** (`src/services/ass-translation.ts`) translates only the visible text of `Dialogue`
  events. Everything before the Text field (timings, style, margins), the Script Info and Styles
  sections, and `Comment` lines stay byte for byte. Override blocks before and after the text stay
  in place; a block inside it travels as a marker: `<i>`/`</i>` (and `b`, `u`, `s`) for a block that
  only toggles that and has its other half in the line, `<x1/>`, `<x2/>`, … for any other block,
  a lone toggle, or a drawing. A toggle right at the
  text's edge whose other half sits inside the line (`{\i1}Title{\i0} said …`) travels as a
  marker too. Only an ASS batch with markers gets one more system-prompt sentence asking to keep
  them; SRT prompts never change, and an ASS batch without markers is the same request as for SRT
  and shares its cache. A reply whose markers don't add up, or whose closing marker comes before
  its opening one, keeps its text without the line-internal styling and without any edge toggle
  turning a style on whose other half was inside, so no style is left switched on (an edge block that also sets
  other tags, like `{\pos(1,2)\i1}`, keeps them and loses only that toggle; a `\r` inside turns
  every toggle off, and `\b` is bold at 1 or a weight from 700); an edge toggle turning a
  style off stays, and so does a whole-line toggle; an edge toggle facing away from the text (`{\i0}` before it, `{\i1}` after it) is never sent. A line
  with more than four line-internal blocks
  (typesetting) is sent as plain text the same way, keeping only its drawings as markers.
  `\N` (and `\n` under `\q2`) is a line break, other `\n` and `\h` a space,
  and `{`, `}`, and `\` are removed from replies so they can't form tags. Karaoke lines (`\k`),
  drawings (`\p1` until `\p0`), and lines with no visible text are not sent; signs are. One
  text repeated across layers or events (border and fill layers, tracked signs) is sent once and
  translated alike; units go in time order, a repeated one at its earliest showing. The
  translation is a synthetic ASS entry that `assjs` draws from the rebuilt file, which leaves out
  the sections `assjs` doesn't read (`[Fonts]`, `[Graphics]`, …). A shown source is parsed only
  while a translation could be offered (AI features on, VOD, no MSE), once, and kept while it or
  one of its translations shows. Since a redraw rebuilds the whole instance,
  translated batches redraw within a second only when one of their events shows between 5 s
  before and 60 s after the playback position, else at most every 60 s, and at once on a seek or
  when the run ends (a rebuild of a 10k-event file takes 150–250 ms in the Chromium 53
  simulation). A file with no Dialogue text to translate shows no Translate row, and a saved
  translation of it shows the source instead, with no translation entry in the menu.
- Diagnostics (no subtitle text): `subtitle.translate.start` (target, lines, batches, remaining,
  resume; for ASS also `format=ass` and the `skipped` events), `subtitle.translate.retry` (reason, status, attempt, wait), and once per run that
  wasn't stopped either `subtitle.translate.done` or `subtitle.translate.incomplete` (reason `lines_kept`,
  `unusable_reply`, or the failure; failed batches; done/kept/cached/requested/total lines and
  batches; for ASS `tags_dropped`, the lines that lost their line-internal styling); `subtitle.translate.restore` (`restored` or `ai_off`, then `nothing_to_translate` when a restored ASS source has no text to translate) once per opening of an item, a reload such
  as a quality change included.
  Request failures also log `llm.request.failed`.

**Context size.** **Test connection** reads the model's context window where the server reports
one: `max_model_len` (vLLM), `context_length` (OpenRouter, Together), `context_window` (Groq),
`max_context_length` (Mistral), or `loaded_context_length` (LM Studio, read before its maximum) on `/models`, else
llama.cpp's per-slot `n_ctx` from `/props`. Many hosted services report none. The setting snaps to
the largest preset that fits (the smallest, 2048, when none does): it is always lowered to fit, but
raised only from the default or from a size an earlier test set (saved as `detectedContextTokens`),
so a smaller size the user picked stays. `llm.context.detected` logs the source and size.
The default is 16000 for every server. Saved sizes clamp to 2048–128000, the presets' range. Subtitle batches stay at 40 lines at any size.

## Subtitle offset (sync)

The same per-stream offset (positive = later, step 0.25 s, range ±60 s; remembered under
`vod:<account>:<kind>:<itemId>`) applies to VOD:

- **Sidecar SRT/WebVTT** cues are owned by `VodSubtitles`, so `setOffset(s)` bakes the
  offset into the reusable renderer's loaded cues and shifts existing ones.
- **ASS/SSA** uses `assjs`'s `ass.delay = s` (remembered so a later `show()` re-applies it).
- **In-container native tracks** are foreign (the demux owns the cues); they are shifted
  best-effort by `shiftForeignTrack` (idempotent, base-time cache) — if the platform
  rejects cue-time mutation the cues simply stay unshifted.
