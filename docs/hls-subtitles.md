# webOS HLS Subtitles

Reference for how this app handles HLS subtitles on LG webOS — the **three in-manifest subtitle
types**, how each maps to a render path, and the device-verified behavior behind each.

| | |
|---|---|
| **Platform** | webOS TV **10.3.1**, Chromium/Blink **120** |
| **Code** | `src/components/player-tracks.ts`, `src/services/hls-subtitles.ts`, `src/utils/webvtt.ts`, `src/utils/subtitle-tracks.ts`, `css/player.css` |
| **Specs** | RFC 8216 (HLS), draft-pantos-hls-rfc8216bis (X-TIMESTAMP-MAP, fMP4/IMSC), W3C WebVTT |

---

## 0. Overview

- On-device the app plays HLS via **native `<video src>`**; hls.js is used only in the desktop preview.
- HLS can carry **three in-manifest subtitle types** — **WebVTT renditions**, **CEA-608/708**, and
  **TTML/IMSC** (§1). They take **two render paths** on webOS: WebVTT is **self-rendered** by the app
  and drawn by Blink; 608/708 and TTML/IMSC ride the **native caption compositor**, driven over Luna.
- Subtitles are **off by default** (unless a rendition is `FORCED=YES`); the choice — including an
  explicit *off* — is **remembered per channel** (§2). Real names come from the master `EXT-X-MEDIA`.
- **Status:** WebVTT self-render (§3) and CEA-608/708 (§5) are **implemented and ✅ verified on device**;
  TTML/IMSC is **✅ verified to draw** but its player wiring is **deferred** (§6).

Device-verified highlights, each detailed below:

- `getStartDate()` (wall-clock of `currentTime=0`) is **NaN for HLS** here ✅, so self-render
  **reconstructs** the timing anchor from `PROGRAM-DATE-TIME` (§3).
- `::cue` styling applies **on the TV**, not just the preview ✅ — Blink draws our self-rendered cues, so
  the `<c.class>` speaker colors render on-device (§3).
- `selectTrack {type:"text"}` **decode-freezes the video** ✅ — never call it; the only working caption
  verb is `setSubtitleEnable` (on/off), which drives the pipeline types (§4).

---

## 1. The three in-manifest subtitle types

The type determines the render path. WebVTT is a **separate `.vtt` playlist** the demux parses but the
compositor never sees — so the app self-renders it. 608/708 and TTML/IMSC are **real demuxed pipeline
tracks** the native compositor draws.

| Type | Manifest | Render path on webOS | Status |
|---|---|---|---|
| **WebVTT renditions** | `EXT-X-MEDIA:TYPE=SUBTITLES` (separate `.vtt` playlists) | Parsed in the demux but **never routed to the compositor** and **not** exposed as a `TextTrack` → the app **self-renders** into a `TextTrack` it owns, drawn by Blink (§3) | **Implemented ✅** |
| **CEA-608/708** | `EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS` (no URI; rides in the video ES) | Demuxed as a real pipeline track → **drawn by the native compositor**, toggled via Luna `setSubtitleEnable` (§4–5) | **Implemented ✅** |
| **TTML / IMSC** | fMP4 `stpp` segments (`CODECS="stpp.TTML.im1t"`) | Demuxed as a real pipeline track → **drawn by the native compositor** via `setSubtitleEnable` (§4, §6) | **Verified ✅, wiring deferred** |

External sidecar SRT/WebVTT/ASS/etc. are also supported via the native `option.subtitle.uri` load path
but aren't part of HLS.

### Render paths

| Path | Subtitle engine | Used by |
|---|---|---|
| **Native `<video src>`** | self-rendered WebVTT → **Blink** (`VTTCueBox`, `::cue`-styled); in-band CEA-608/708 & TTML → native compositor | **on-device** |
| **MSE (hls.js)** | Blink 120 text-track + `::cue` (IMSC via imsc.js) | desktop preview only |

Native video plays on a punch-through "video-hole" plane, so subtitles are **not burned in** — they're a
web overlay the engine draws from `video.textTracks`, gated by `track.mode` (`'showing'` renders a track,
`'disabled'` turns it off). LG's Blink maps this onto the pipeline's subtitle `selectTrack`, the same way
`audioTracks[i].enabled` maps for audio — the on-device-verified audio path this mirrors is in
[`audio-track-selection.md`](audio-track-selection.md).

**Why WebVTT is self-rendered:** the native demux parses in-manifest WebVTT but **never surfaces it as a
switchable `TextTrack`**, and `setSubtitleEnable` draws nothing for it (✅ §4). So `HlsSubtitles` fetches
the subtitle media playlist itself, parses each segment, and injects `VTTCue`s into a `TextTrack` it owns
(§3) — started per the §2 selection (off unless `FORCED` or a saved pick), not automatically. Self-rendering
runs the **same on-device and in the preview** and gives `::cue` styling — it's necessary here, not a choice.

> **VOD subtitles** (Xtream movies/episodes — in-container native tracks and sidecar SRT/WebVTT files)
> are a separate path, covered in [`vod-subtitles.md`](vod-subtitles.md).

---

## 2. Selecting a subtitle (picker + per-channel memory)

Cross-cutting across types; helpers in `src/utils/subtitle-tracks.ts`; mirrors the audio-track feature.

- **Off unless forced** — `chooseSubtitleIndex(options, pref)`:

  | Saved pref | Result |
  |---|---|
  | none | the `FORCED=YES` track if any, else **off** |
  | explicit *off* | **off** (even if a forced track exists) |
  | a track (by name → language) | that track; else fall back to forced / off |

  `DEFAULT=YES` does **not** auto-enable subtitles; only `FORCED=YES` turns them on without a user choice.
  (Per spec `DEFAULT` marks the rendition to prefer *once subtitles are on*, but the app doesn't auto-prefer
  it — a subtitle is only ever enabled by a `FORCED` rendition or an explicit per-track pick, so `isDefault`
  is parsed but unused in subtitle selection.)
- **Switch:** on webOS the WebVTT path **self-renders** the chosen rendition — a pick starts
  `HlsSubtitles` on it (matched by name → language), *off* calls `stop`; the preview uses
  `hls.subtitleTrack = i` (`-1` = off) with `hls.subtitleDisplay`. Pipeline captions (608) toggle via Luna
  `setSubtitleEnable` (§4–5). On tune-in the remembered pick — or the `FORCED` track, else off — is
  re-applied through `chooseSubtitleIndex` (`applySelfRenderSelection`).
- **Per-channel memory:** a `SubtitlePref` `{ off, name, lang, cc? }` keyed by `channelKey`, re-applied on
  tune-in. It records one choice: an explicit *off* (`off: true`) — which lets "I turned subtitles off
  here" survive a re-tune; a WebVTT rendition (`off: false` + `name`/`lang`); or the closed-caption toggle
  (`off: false`, `cc: true`, §5). `cc` is optional — set only by the CC pick, and cleared by picking a
  WebVTT track or *off*.
- **Real names:** the picker's options come straight from the parsed master renditions
  (`parseSubtitleRenditions` → `manifestSubtitleOptions`) — native text tracks surface with empty
  `label`/`language` and don't carry the `FORCED`/`DEFAULT` flags, so the manifest is the source on-device.
- **Labels:** `subtitleLabel` shows the rendition `NAME`; with none, the language rendered as its
  **endonym** (its own-language name — `languageName` via `iso-639-1` + `iso-639-2` to fold 3-letter
  codes to 2), then a positional `Subtitle N`.

---

## 3. WebVTT renditions — self-rendered (`HlsSubtitles`)

The one type the app renders itself. `HlsSubtitles` fetches the subtitle media playlist, parses each
segment, and injects `VTTCue`s into a `TextTrack` it owns. **Implemented ✅.**

### Render & styling — Blink draws it, on the TV too

- Our self-rendered cues are drawn by **Blink** (`VTTCueBox`) **both on-device and in the preview**, so
  **`::cue` styling applies on the TV.** `#video-player::cue` (in `css/player.css`): white text on
  `rgba(0,0,0,0.8)` plus the `<c.class>` speaker colors — ✅ the colors were confirmed on the TV. (The
  TV's GStreamer caption compositor draws only *pipeline* subs — 608/708, TTML — never our injected
  `VTTCue`s.)
- **Blink decodes entities, parses cue tags, and `::cue`-styles them on-device.** ✅ A `VTTCue` with text
  `a&amp;b <c.red>RED</c> &lt;x&gt;` draws as `a&b RED <x>` on the TV — entities decoded; the `<c.red>`
  span's `getCueAsHTML().textContent` is the plain text, but the span **renders colored by
  `::cue(.red)`**. So **don't pre-decode**; pass raw cue text through.
- The TV's caption settings in `com.webos.settingsservice` category `caption` govern the *pipeline*
  compositor; whether they also override `::cue` font/size for our Blink-drawn cues isn't pinned, but the
  `::cue` color clearly wins.

To re-verify the renderer on another device, paste into the `ares-inspect` console while playing:
```js
const v = document.querySelector('video'), t = v.textTracks[0];
const cue = new VTTCue(v.currentTime + 1, v.currentTime + 7, 'TEST a&amp;b <c.red>RED</c> &lt;x&gt;');
t.addCue(cue);
const box = document.createElement('div'); box.appendChild(cue.getCueAsHTML());
console.log('blink:', box.textContent);   // "TEST a&b RED <x>" — compare to what the TV draws
```

### Sync model (wall-clock → media time)

Sync is the hard part, because there's no native anchor.

**Anchor.** `getStartDate()` is **`Invalid Date` / NaN for HLS** here ✅ — the native HLS demux never
surfaces `EXT-X-PROGRAM-DATE-TIME` as a media-timeline offset, so the wall-clock-of-`currentTime=0`
anchor is empty (same with MSE in desktop Chrome — **(standard)**). So `maybeCalibrate` **reconstructs**
it. Anchoring at the live edge — `seekable.end` ↔ the newest segment's `PROGRAM-DATE-TIME` — runs cues
seconds early, because the pipeline holds `seekable.end` behind the playlist's true live edge by a
buffering hold-back (≈2–6s, varying). So we anchor at the **start** of the timeline, which carries no
hold-back —
the **video feed's oldest PDT ↔ `seekable.start`** — giving `startDate = oldestPDT − seekable.start·1000`
(slope 1, constant: both slide together at 1×). `seekable.start` and the oldest segment are quantized to
~segment boundaries, so each sample is noisy by ±~half-a-segment; `startDate` is fixed per session, so we
**average** several samples (a low percentile, `lowPercentile`) until it settles, then anchor cues at
media 0. If the video feed carries no PDT, sync falls back to the live edge, accepting the hold-back skew.
A small **per-channel residual** can remain — a genuine publish-time offset between the subtitle and video
feeds, not estimator error.

- Cue media time = `anchor.media + (cueWall − anchor.wall)/1000` (slope 1; live plays at 1×, **no fudge
  offset**).
- Each cue's wall clock comes from **its own segment's PDT** (per-segment, so a sliding window doesn't
  matter): `segmentPDT + (cueStart − local)`, where `local` is the `X-TIMESTAMP-MAP LOCAL` anchor —
  or, for **media-clock streams** that number cues along the whole timeline (`LOCAL:0`, cue at e.g.
  `03:21:40`), the segment's own first-cue time.
- **Boundary-split captions:** when one caption straddles a segment boundary, broadcasters re-emit it as
  two (sometimes three) abutting **same-text** cues (`15.720→16.000` then `16.000→16.920`). Two passes
  handle this: dedup keys on **start+end** (not a rounded second) so a true re-add is dropped while both
  halves of a split survive; then `mergeSameTextCues` coalesces an adjacent same-text run (gaps ≤
  `MERGE_GAP_S`) into one continuous cue. Without the merge the abutting cues overlapped and the line
  flickered; without the precise key a coarse one dropped the second, often-longer half and the caption
  flashed too briefly to read. ✅
- **Sparse PDT:** a server need only tag `PROGRAM-DATE-TIME` once (or per discontinuity), so
  `parseMediaPlaylist` carries it forward by summing `EXTINF`, resetting at `EXT-X-DISCONTINUITY`
  (else later segments are dropped for lack of a tag → subtitles vanish after one segment).

### Parser hardening (`webvtt.ts`)

- **Block-aware** — classifies each block (separated by blank lines) before looking for a cue, so a
  `-->` inside a `NOTE`/`STYLE`/`REGION` block can't become a phantom caption. Handles the optional
  cue-identifier line.
- **Strict timestamps** — `^(?:(\d+):)?([0-5]\d):([0-5]\d)\.(\d{3})$`; comma-decimals, scientific/hex
  notation and out-of-range fields parse to NaN (cue dropped) rather than silently mistimed.
- **Whitespace-tolerant attribute parsing** in the rendition parsers (`[:,]\s*KEY="…"`) so a packager's
  `, NAME="…"` spacing doesn't drop the value (and the rendition).

### Cue positioning & unsupported renditions

- **Cue positioning** — the cue-setting list after the `-->` (`line`/`position`/`size`/`align`/`vertical`,
  incl. the `lineAlign`/`positionAlign` sub-settings) is parsed (`parseCueSettings`) and applied to each
  `VTTCue` (`applyCueSettings`), so cues honor their authored placement — Blink's `VTTCueBox` reads these
  native props (not `::cue`). Applied under its own `try` so an unsupported setter never drops the text.
- **fMP4/IMSC (`EXT-X-MAP`) and encrypted (`EXT-X-KEY`) renditions** can't be text-parsed — detected in
  `parseMediaPlaylist`, logged, and self-rendering stops (instead of silently producing zero cues). For
  fMP4 `stpp`/IMSC this is where the deferred pipeline path would take over (§6).

### Known limitations (with their log/visual fingerprint)

| Area | Limitation | Fingerprint |
|---|---|---|
| **Forced-subtitle language** | With multiple `FORCED=YES` renditions the *first* is auto-shown, not the one matching the current audio language (the spec's rule). | Rare; a foreign-dialogue caption in the wrong language on a multi-forced stream. |
| **Discontinuity** | One slope-1 wall↔media line; cues after an ad-splice `EXT-X-DISCONTINUITY` can misalign (carry-forward *stops* there, but a new-domain relative anchor may skew). | A chunk (often an ad break) is offset, rest correct. |
| **Per-channel feed residual** | The reconstructed `startDate` aligns the two timelines, but a genuine publish-time offset between the subtitle and video feeds leaves a small constant skew on some channels — playlist-only sync can't remove it. | Captions consistently a second or two early/late on one channel. |
| **No-PDT fallback skew** | When the *video* feed carries no `PROGRAM-DATE-TIME`, `startDate` can't be reconstructed; sync falls back to the live edge (`seekable.end ↔ newest subtitle PDT`), which the buffering hold-back biases. | Captions a few seconds early; `[HlsSubs]` logs `using live-edge anchor`. |
| **X-TIMESTAMP-MAP MPEGTS** | Only `LOCAL` is read; PDT-anchoring covers the common case but a `LOCAL:0` + MPEGTS-offset packager with an unrelated PDT origin would desync. | Constant offset on one packager. |
| **GROUP-ID** | Renditions are collected across all groups; the variant's `SUBTITLES="grp"` association is ignored. One-group masters (the norm) are fine. | Wrong name/rendition on a multi-group master. |
| **EXT-X-BYTERANGE / EXT-X-DEFINE** | Byte-range segments are fetched whole; `{$var}` URIs aren't substituted. Rare for live WebVTT. | Wrong/duplicate cues, or a 404 → no captions. |
| **REGION / cue `region:`** | REGION blocks are skipped, so a cue's `region:` setting has no `VTTRegion` to bind and is ignored — the other cue settings (line/position/size/align/vertical) *are* applied. Roll-up captions fall back to static placement. | Rare; a region cue shows at its line/position instead of scrolling within a region. |

### Diagnosing a "no subtitles" channel (from `[HlsSubs]` logs in `ares-inspect`)

- `subtitles on: …` then nothing, with `cannot self-render this rendition — fmp4`/`encrypted` → an
  unsupported rendition (expected; see limitations).
- `no PROGRAM-DATE-TIME in the playlist — cannot anchor cue timing` → the *subtitle* playlist is
  PDT-less (VOD-style); not supported.
- `video playlist has no PROGRAM-DATE-TIME — using live-edge anchor …` → the *video* feed lacks PDT, so
  `startDate` can't be reconstructed; cues fall back to the live edge and may run a few seconds early.
- `subtitles refresh failed` (debug) → a segment fetch threw (404 — a redirect, `EXT-X-DEFINE`, or
  transient network).

---

## 4. Native control surface — `luna://com.webos.media`

This is how the **pipeline** caption types (CEA-608/708, TTML/IMSC) are driven. We **don't** use it for
self-rendered WebVTT — it can't render those, and one of its verbs actively **breaks playback** (all
verified on device with a clean control).

- `setSubtitleEnable {mediaId, enable}` is the **only working caption verb.** It **draws/hides 608** on
  screen, both directions (confirmed visually, repeatedly); `mediaId` is read straight off
  `video.mediaId`. For a **WebVTT** rendition it's **harmless but draws nothing** — the video keeps
  playing, no captions appear (our cues live in separate `.vtt` renditions the demux parses but never
  routes into the compositor). ✅
- **`selectTrack {type:"text"}` decode-freezes the whole video — never call it.** ✅ It returns `true`
  but freezes playback with `MEDIA_ERR_DECODE` (`video.error.code === 3`) within ~1 s — verified on
  **both** 608 and WebVTT streams, reproducibly, user-confirmed on screen. `type:"subtitle"` returns
  `false`. It returns `true` for any index, so it can't even be used to count tracks. (Control: the same
  stream plays 60 s+ smoothly with **no** subtitle calls.) So **caption-channel selection (CC1/CC2,
  languages) is NOT possible via Luna here** — only enable/disable via `setSubtitleEnable`.
- **`com.webos.settingsservice` is `Access denied`**, so the TV's caption font/size/color are out of
  reach. *Why (verified on device):* `getSystemSettings` is in the `settings.read` / `settings` ACG
  groups, but a **dev-mode app is granted only `["ares.webos.cli", "public"]`**
  (`/usr/share/luna-service2/devmode_certificate.json`). Declaring `requiredPermissions:["settings.read"]`
  and reinstalling does **not** help — `settings.read` isn't in `devmodeGroups`. It's handed out only by
  per-app-id entries in `client-permissions.d/` to **LG first-party apps**; **publishing to the LG
  Content Store does NOT unlock it** (a store third-party still gets only `public`). So caption settings
  are unreadable/unsettable by us, full stop.

### Verbs tested on device (`mediaId` = `video.mediaId`)

| Verb (params) | Result |
|---|---|
| `setSubtitleEnable {enable}` | ✅ **The only working verb.** Draws/hides **608** on screen, both directions. For WebVTT: harmless but draws nothing. |
| `selectTrack {type:"text", index}` | ❌ Returns `true` but **decode-freezes the video** (`MEDIA_ERR_DECODE`) on **both** 608 and WebVTT — never call. `type:"subtitle"` → `false`. Returns `true` for any index, so it can't count tracks. |
| `setSubtitleColor {color}`, `setSubtitleCharacterColor {charColor}`, `setSubtitleFontSize {fontSize}`, `setSubtitleCharacterFont {charFont}`, `setSubtitleBackgroundColor {bgColor}` | Reachable; return `true` with the **right param name** (wrong name → `Method … was not handled`), but **no-op on 608** — applied red/large/green-bg + held across cues with a 2 s re-apply keeper, zero visual change. Likely affect only external `option.subtitle.uri` subs, not in-pipeline 608. |
| `selectTrackByPreference` | **Denied** (`Denied method call`). |
| `setSubtitleLanguage`, `getActiveAppInfo` | **Unknown method** on this firmware. |
| `option.subtitle.{languageCode, show, uri, subtitleRedirect}` | Load-time external-sidecar path — not tested; the app doesn't use it. |

`com.webos.media` is reachable from the app's web bridge (its verbs are in the literal `public` ACG
group), but the only effective caption control is `setSubtitleEnable` (on/off) — track-selection and
styling aren't usable, so pipeline captions render only in the TV's default style.

---

## 5. CEA-608/708 — pipeline (implemented ✅)

608/708 rides the **video ES**, is demuxed as a **real pipeline track**, and is drawn by the native
compositor. `parseClosedCaptions` + a single "Closed Captions" picker entry are wired on the webOS native
path (`src/utils/subtitle-tracks.ts`, `src/components/player-tracks.ts`).

- **Not surfaced as a `TextTrack`.** ✅ `textTracks` stays empty 20 s+, no `addtrack`, no vendor caption
  property. So the picker is **blind** to 608 — it must be detected from the manifest's
  `EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,INSTREAM-ID="CC1"` declaration, the only a-priori signal.
- **In-band captions can't be auto-detected either.** ✅ (probed) On a stream that definitely carries 608
  (a public test stream that declares CC1), `com.webos.media`'s media-info shows
  `sourceInfo.programInfo[].numSubtitleTracks` = **0** (it counts only separate subtitle *PIDs* — 608 has
  none, it rides the video ES) and `videoInfo.userData` = **`"(null)"`**. There is no on-demand getter
  (`getSourceInfo`/`getMediaInfo`/… all return *Unknown method*); `sourceInfo` is pushed once at load.
  After `setSubtitleEnable:true` a `userDefinedEvent` with `subtitleSpec:"ttml"` fires — but that's the
  **compositor's internal render format** (LG normalizes 608/IMSC → TTML for drawing), *not* a presence
  signal. So the picker gates its CC toggle on the manifest declaration.
- **Toggle:** a single on/off entry, gated on the manifest declaration, toggled with
  `setSubtitleEnable {mediaId, enable}` and remembered per channel (as `cc: true`, §2). **No channel list**
  (CC1/CC2, languages) — `selectTrack` decode-freezes the video (§4), so whichever CC channel the stream
  defaults to is what shows.
- **Off by default.** ✅ Verified even with the TV's global "Closed Captions" accessibility setting
  turned ON: nothing draws until `setSubtitleEnable:true`. That global setting drives the TV's
  **tuner/broadcast** path, **not** the app's `com.webos.media` pipeline. (The app needn't force
  `enable:false` on load; it's already off.) The flip side: a retail-TV global "Closed Captions: off"
  can *suppress* drawing even when `setSubtitleEnable` succeeds — the app can't toggle it, so a stubborn
  stream may need the user to enable captions in TV settings.
- **Styling** is owned by the native compositor + the TV's accessibility settings, which the app can't
  read (`settingsservice` = Access denied, §4). The default 608 face is a monospaced HanYang font
  (`HYDefault`) — Courier-like — so `::cue` does **not** style pipeline captions.

---

## 6. TTML/IMSC — pipeline (verified ✅, wiring deferred)

TTML/IMSC arrives as fMP4 `stpp` segments (`CODECS="stpp.TTML.im1t"`), is demuxed as a **real pipeline
track**, and is drawn by the native compositor via `setSubtitleEnable` — the same on/off surface as 608.

- **Verified on device.** ✅ No public HLS+IMSC1 source exists (every IMSC test vector is DASH `.mpd`),
  so it was verified with a **hand-built `stpp` fMP4 rendition** (built from a TTML doc → `init.mp4` +
  `.m4s` + HLS manifests, video from a public TS test stream). Like 608, it is **not surfaced as a
  `TextTrack`** ✅ (`textTracks` stays empty 20 s+), and `setSubtitleEnable` draws it on screen.
- **Detection would differ from 608.** An IMSC rendition is declared `TYPE=SUBTITLES` (like WebVTT,
  **not** `TYPE=CLOSED-CAPTIONS`), so `parseClosedCaptions` never sees it. Today it falls onto the WebVTT
  self-render path, where `HlsSubtitles` detects the fMP4/`stpp` segments as `unsupported` (§3) and shows
  nothing. Proper support needs IMSC-vs-WebVTT detection (variant `CODECS="stpp…"`, or a `.m4s`-vs-`.vtt`
  segment sniff) that routes the option to `setSubtitleEnable` instead of self-render — still on/off only
  (default rendition; `selectTrack` freezes, §4).
- **Deferred.** No public HLS+IMSC source exists and it's ~absent from live IPTV, so it's untestable in
  CI and low-value.

## Subtitle offset (sync)

A per-stream timing offset lets the user nudge subtitles when they run early/late.
Positive = later, negative = earlier; step 0.25 s, range ±60 s, remembered per channel
under the same `channelPrefKey()` as the subtitle pick (`subtitle_offsets` map).

- **Self-rendered WebVTT** owns its cues, so `HlsSubtitles.setOffset(s)` bakes the offset
  into new cues and delta-shifts existing ones — the merge/prune/dedup logic stays
  self-consistent because every cue lives in the same shifted space.
- The UI is a `SubtitleOffsetOverlay` opened from the player's Subtitles menu ("Subtitle
  Sync" row), routed input modally by `App`.
- In-band **CEA-608/708** and **TTML/IMSC** are drawn by the native compositor with no cue
  access, so the offset control is hidden while they are the active caption.

---

*Conventions: **✅ confirmed on device** marks facts verified on real hardware; **(standard)** marks
behavior that holds in any Blink/MSE browser.*
