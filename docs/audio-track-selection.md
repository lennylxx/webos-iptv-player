# Selecting the audio track on the native webOS player

How this app switches between multiple audio tracks (multi-language / accessibility
renditions) when playing through the **native `<video>` element** on webOS — the path used
on-device (`src/components/player.ts`, the `isWebOS` branch; helpers in
`src/utils/audio-tracks.ts`). Everything below was **verified on-device** (firmware
`33.31.61`, Chromium 120, UA `Web0S; Linux/SmartTV`, an LG OLED C5), not just inferred from
binaries.

## TL;DR

- **Switch with the HTML5 API:** `video.audioTracks[i].enabled = true` (enabling one disables
  the rest). LG's Chromium maps this onto the media pipeline's `selectTrack` internally — and
  crucially, **bounded to the tracks the pipeline actually demuxed**, so it can't break playback.
- **Do NOT call `com.webos.media/selectTrack` yourself.** The `<video>` element *does* expose a
  `mediaId` and that Luna call *is* reachable — but it accepts out-of-range indices and then
  fires a decode error that **kills the stream**. The HTML5 API is the safe front door.
- **webOS exposes one `AudioTrack` per _distinct_ `LANGUAGE`**, with empty `label`/`language`.
  So (a) same-language alternates are hidden, and (b) real names must be parsed from the master
  `.m3u8`.

```ts
// Safe switch — valid only for the tracks webOS actually exposed (see the rule below).
function selectAudioTrack(video: HTMLVideoElement, index: number) {
  const list = video.audioTracks;
  if (!list || index < 0 || index >= list.length) return;
  for (let i = 0; i < list.length; i++) list[i].enabled = (i === index);
}
```

## How many tracks you actually get — the LANGUAGE-collapse rule

webOS surfaces **one HTML5 `AudioTrack` per distinct `LANGUAGE`** in the master playlist.
Renditions that share a language code collapse to one — the pipeline loads only the `DEFAULT`
among them. Verified on-device:

| Master playlist | distinct `LANGUAGE` | native `audioTracks.length` |
|---|---|---|
| 3 renditions, all the **same** language | 1 | **1** |
| 2 renditions, **2** distinct languages | 2 | **2** |
| 3 renditions, **3** distinct languages | 3 | **3** |

A stream that tags all its renditions with the **same** language collapses them to one — those
same-language alternates are **not reachable** via the native path at all; only hls.js (which
loads each rendition's separate audio playlist) could switch them.

The exposed tracks arrive — sometimes asynchronously, via `addtrack` — with **empty `label`,
`language`, and `kind`** for the alternates; only the default usually carries a language:

```
AUDIOTRACKS: 3 tracks -> [0] "" lang=l1 enabled=true [1] "" lang= enabled=false [2] "" lang=l2 enabled=false
AUDIOTRACKS: 1 tracks -> [0] "" lang=l1 enabled=true        # all-same-language stream, collapsed to 1
```

React to `addtrack` (and re-check on `loadedmetadata`) since the list can fill in after metadata.

## Switching: `audioTracks[i].enabled` (the supported path)

Setting `.enabled` triggers, inside LG's engine:

```
video.audioTracks[i].enabled = true                          // app JS
  → RendererImpl::OnEnabledAudioTracksChanged                 (libcbe.so)
  → uMediaServer::uMediaClient::selectTrack("audio", i)       (libcbe.so)
  → StarfishMediaAPIs::SelectTrack({ type:"audio", index:i }) (starfish-media-pipeline)
  → com.webos.media pipeline selectTrack
```

Because the index space is the **HTML5 list** (only the demuxed tracks), you can't ask for a
track the pipeline never loaded — which is exactly what makes it safe.

**Expect a switch lag.** The pipeline keeps playing already-buffered audio of the old track
until the playhead drains it, so the new track isn't audible for a few seconds (longer on big
VOD buffers; ~seconds at a live edge). The app shows a *"Switching audio track to …"* toast as
feedback.

## Why not `com.webos.media/selectTrack` directly

You might assume a `<video>` web app can't reach the pipeline directly. It can — but you still
shouldn't, for a different reason:

- The `<video>` element exposes a **`mediaId`** (e.g. `mediaId=_0NsNkKxKetdf8a`) and an
  `onpipelinestarted` hook.
- `luna://com.webos.media/selectTrack {mediaId, type:"audio", index}` **is reachable and returns
  `{returnValue:true, errorText:"No Error"}`**.
- **But it is unsafe.** It accepts indices the pipeline never demuxed and then throws a **decode
  error** (`MediaError.code === 3`), breaking the stream; follow-up calls return
  `returnValue:false`. On a stream that collapses to 1 native track, `selectTrack` to index 1
  returned "No Error" and immediately killed playback.
- Admin methods are **ACL-denied** to the app: `getActivePipelines` / `getPipelineState` →
  `Denied method call ... for category "/"`; `subscribe` is not handled at the root category.

So `selectTrack` adds nothing over `.enabled` except the ability to crash the decoder. Use
`.enabled`.

## Real track names — parse the master playlist

Because native `audioTracks` carry empty `label`/`language` for the alternates, the picker would
otherwise read "Audio 2". Fix: fetch the master `.m3u8`, read each `EXT-X-MEDIA:TYPE=AUDIO`
`NAME`/`LANGUAGE`, and overlay them onto the native tracks **by index, only when the counts
match** (so a collapsed list isn't mislabelled):

- `parseAudioRenditions()` and `mergeManifestNames()` in `src/utils/audio-tracks.ts` (pure,
  unit-tested).
- `Player.loadManifestAudio()` fetches/parses on tune-in (webOS HLS only) and re-applies the
  saved pick once the names are known. Degrades to generic labels on a fetch/parse failure.

## Per-channel memory

The chosen track is remembered per channel (keyed by `channelKey`) as `{ name, language }` and
re-applied on the next tune-in — matched by name, then language, else the stream default. The
manifest names are what make this reliable; the empty-metadata native tracks alone can't be keyed.

## Desktop preview (hls.js)

The desktop preview drives playback with **hls.js**, which exposes every rendition with real
names — switch with `hls.audioTrack = i` (and read `hls.audioTracks`). The native-path manifest
overlay is webOS-only. `mpegts.js` exposes only the first audio track (no switching). See the
`this.hls` branches in `player.ts`.

## Evidence (firmware `33.31.61`, Chromium 120, chassis `o22n3` / `papikonda`)

The platform selects the manifest `DEFAULT` rendition; no layer auto-prefers audio description
for an app's HLS stream:

| Layer | Behavior (from binary strings) |
|---|---|
| `adaptiveng` HLS demuxer | Parses `EXT-X-MEDIA` incl. `DEFAULT`/`AUTOSELECT`; `gst_adaptive_demux_period_select_default_tracks`, `Selecting default audio track %s`, `Sort by SELECT flag` |
| `umediaserver` `selectTrackByPreference` | Keys on **`languageCode`** only — not audio description |
| `audiod` + "Audio Description" setting | A DVB broadcast **receiver-mix** (`audioDescriptionVolume.xml`, region-gated `EU_AU_HK_CN`) — not HLS rendition selection |
| `com.webos.app.tvhotkey` Multi-Audio menu | Broadcast only: `setAudioLanguage({category:"channel"})`; never `selectTrack` on app media |
| `WebMediaPlayerUMS` (Chromium adapter) | Reflects the platform-selected track; tracks a sticky `userSelectedAudioTrack`; `Only one enabled audio track is supported` |

- `usr/lib/libcbe.so` — `AudioTrackList`, `audioTracks`, `OnEnabledAudioTracksChanged`,
  `OnSelectedAudioTrackChanged`, and `uMediaServer::uMediaClient::selectTrack(std::string&, int)`.
- `usr/sbin/starfish-media-pipeline` — `StarfishMediaAPIs::SelectTrack`, `selectTrack`,
  `selectTrackByPreference`, `numAudioTracks`, `audioTrackInfo`, `sourceInfo` / `programInfo`.

LG open source:
- [`webosose/chromium68` — `umediaclient_impl.cc`](https://github.com/webosose/chromium68/blob/master/src/media/blink/neva/webos/umediaclient_impl.cc)
  — audio tracks built from `sourceInfo.programInfo[0].numAudioTracks` → `add_audio_track_cb_`
  (HTML5 `AudioTrackList`); `SelectTrack(type, id)`. *(In OSE the body is `NOTIMPLEMENTED()`;
  implemented in the commercial TV firmware above.)*
- [`webosose/umediaserver`](https://github.com/webosose/umediaserver) and the
  [`com.webos.media` LS2 API](https://www.webosose.org/docs/reference/ls2-api/com-webos-media/).

---

*Verified on-device against the extracted LG firmware (`33.31.61`, chassis `o22n3` / `papikonda`)
and live testing on an LG OLED C5 (2025).*
