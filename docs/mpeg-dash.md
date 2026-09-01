# MPEG-DASH support

The player supports MPEG-DASH channels on webOS and in the desktop preview.
webOS uses its native media pipeline; the preview uses dashjs through MSE.

## Runtime paths

| Platform | Playback path | Track control |
|---|---|---|
| webOS | Native `MPEG-DASH` transport | HTML5 audio tracks, self-rendered raw WebVTT, and the native subtitle compositor |
| Desktop preview | dashjs | The `MseEngine` adapter |

## Detection

`PlayerPipeline` recognizes DASH from:

- a `.mpd` URL;
- an `extension=mpd` or `output=mpd` query parameter;
- a DASH Content-Type; or
- an MPD XML prefix after an optional UTF-8 BOM and XML declaration.

The internal classification MIME is `application/dash+xml`. This value is also
used by the stream-route cache, but it is not used as the native `<source>`
type.

MPDs are fetched separately for track labels and stream metadata. This fetch is
bounded by `MPD_MAX_BYTES` and `MANIFEST_TIMEOUT`; failure reduces the available
metadata but does not block native playback.

## Native webOS source

The default native source explicitly selects the webOS DASH transport:

```text
type="video/mp4;mediaOption=<encoded JSON>"
```

The decoded JSON is:

```json
{"mediaTransportType":"MPEG-DASH"}
```

The explicit transport selection works for both `.mpd` and extensionless URLs.
A plain `application/dash+xml` source does not deterministically select the
native transport. `CONFIG.PLAYER.DASH_SOURCE` also provides a `bare` mode that
omits the type and delegates selection to URI typefinding for provider
compatibility.

Native DASH source selection logs:

```text
event=playback.path.native.dash hint=mediaOption|none
```

The existing `loadedmetadata`, `playing`, startup-watchdog, stall-watchdog and
video-error logs describe the remaining native lifecycle.

## MPD metadata

`parseMpd()` reads the first Period and supplies the existing player models:

- audio labels, languages, default roles and channel configuration;
- subtitle labels, languages and forced roles;
- CEA-608/708 accessibility descriptors;
- video resolution, codec, frame rate and HDR transfer characteristics;
- Dolby JOC signaling for Atmos;
- static or dynamic presentation type; and
- `ContentProtection`.

The OSD matches parsed variants against the dimensions reported by the playing
video element. This avoids assuming that every Representation declared by the
MPD remains available to the native player.

## Subtitles

| Subtitle form | MPD signal | webOS rendering | App styling and offset |
|---|---|---|---|
| Raw WebVTT | `text/vtt` or `application/x-subtitle-vtt` | `DashSubtitles` and `WebVttCueTrack` | Yes |
| TTML/IMSC in fMP4 | `application/mp4`, codec `stpp` | Native compositor | No |
| WebVTT in fMP4 | `application/mp4`, codec `wvtt` | Native compositor | No |
| CEA-608/708 | DASH accessibility descriptor | Native compositor | No |

Raw `text/vtt` renditions do not appear as native `TextTrack` entries on the
tested TV. `DashSubtitles` fetches and parses them, then sends their cues to the
same `WebVttCueTrack` renderer used by HLS.

Supported addressing and timing include:

- inherited `BaseURL`;
- `SegmentTemplate` with representation, bandwidth, number and time variables;
- fixed-duration and `SegmentTimeline` templates;
- bounded negative timeline repeats;
- `SegmentList`;
- HTTP byte ranges;
- Period start and `presentationTimeOffset`; and
- dynamic MPD refresh and long static presentations.

The shared cue renderer owns TextTrack reuse, cue settings, subtitle offset,
pruning and cleanup. HLS and DASH retain their own fetching and clock mapping.

Native `stpp`, `wvtt` and CEA tracks may not appear as Blink `TextTrack`
objects. Picker activation uses
`com.webos.media/setSubtitleEnable` after the native media ID is available.
Selection is applied again on `playing` because the media ID can appear after
`loadedmetadata`.

App `::cue` styling and subtitle offsets apply only to self-rendered raw WebVTT.
Native compositor positioning and styling are controlled by the media stream
and platform.

## Live playback and DVR

Dynamic MPDs use the native seekable window. DVR seeks stay inside both moving
boundaries:

- Go-to-Live seeks slightly behind `seekable.end`, where media is ready.
- Rewind stays inside `seekable.start` so the next MPD refresh does not move the
  retained window past the current position.
- `timeupdate`, `progress` and `durationchange` re-clamp playback when a sliding
  window advances.

The pads are configured by `DVR_GO_LIVE_PAD` and `DVR_OLDEST_PAD`.

## Native PlayReady DRM

The webOS native path supports PlayReady-protected DASH. Before attaching the
source, the player:

1. loads a `playready` client through `com.webos.service.drm`;
2. subscribes to rights errors;
3. sends post-acquisition license-server and optional custom-data messages; and
4. attaches the DASH source with the DRM `clientId` in `mediaOption`.

Playlist entries may use Kodi 22's DRM JSON:

```text
#KODIPROP:inputstream.adaptive.drm={"com.microsoft.playready":{"license":{"server_url":"http://host/license"},"optional_key_req_params":{"custom_data":"token"}}}
```

Kodi 21's simple form is also supported:

```text
#KODIPROP:inputstream.adaptive.drm_legacy=com.microsoft.playready|http://host/license
```

The deprecated properties remain accepted for older playlists:

```text
#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready
#KODIPROP:inputstream.adaptive.license_key=http://host/license|x-token=v|R{SSM}|
#KODIPROP:drm_custom_data=token
```

The native client consumes the license URL and PlayReady custom data. Arbitrary
license-request headers, request/response recipes, server certificates and
custom PSSH data are recognized but cannot be applied through the webOS DRM
service; the player logs
`event=playback.dash.drm.options.unsupported` and continues with the supported
settings. Kodi's deprecated `license_data` property means initialization/PSSH
data and is not treated as PlayReady custom data. If no license URL is
configured, the client uses the URL in the content's PlayReady header.

The DRM client and rights-error subscription are released on channel changes,
player teardown and app suspension. Widevine and unknown protection schemes
trigger `event=playback.dash.drm.unsupported` and normal channel fallback.
The generic `mp4protection` descriptor alone does not mark a stream as DRM.
Once the native DRM client is ready, the player OSD shows a `PlayReady` stream
information pill.

Native playback errors use the existing video-element error path. Desktop
dashjs errors use a bounded retry budget before invoking the same channel
fallback.

Channel-health probing accepts MPD XML and rejects other XML responses. It does
not probe template-derived media segments.

## Validation

Automated coverage includes:

- URL, Content-Type and content-sniff classification;
- MPD metadata and subtitle addressing;
- native source construction for URL, cached and sniffed routes;
- raw WebVTT rendering and native subtitle routing;
- DVR sliding-window boundaries;
- the dashjs adapter in Chromium and Chromium-53 simulation; and
- the real dashjs dependency in modern Chromium.

Native decode, extensionless detection, multiple audio AdaptationSets, raw
WebVTT, `stpp`, `wvtt`, dynamic MPDs and DVR were tested on webOS TV 10.3.1.

## Known limitations

- Native DRM support is PlayReady-only; Widevine requires a future EME path.
- Metadata and subtitle discovery use the first Period.
- Multi-Period subtitle continuation, xlink, encrypted WebVTT, BaseURL failover
  and UTCTiming correction are not implemented.
- Native `wvtt` positioning and styling have not been verified.
