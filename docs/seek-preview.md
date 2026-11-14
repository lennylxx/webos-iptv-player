# Seeking and seek-bar previews

On catch-up, live DVR, and VOD playback, Left and Right on the remote do not
seek at once. Each press moves a **pending target** on the seek bar, and the
player seeks once, after the presses settle. A bubble above the target shows
its time, the jump from the current position, and a preview frame when the
source offers one.

## Keys

| Input | Effect |
|---|---|
| Left / Right (OSD showing) | Move the target. Steps grow every half second one direction is held, whatever the remote's key repeat rate: 10 s, then 30 s, 1 min, 2 min, and 5 min, each capped at 5% of the timeline but never below 10 s. Reversing restarts at 10 s. On catch-up and VOD the target stops 2 s before the end, so a held key does not end playback; at the live edge Right does nothing. |
| No press for 0.8 s | Seek to the target. |
| OK | Seek to the target at once. |
| Back | Drop the target; playback continues where it was. |
| Pointer over the seek bar | Preview that spot without a jump; a click still seeks at once. |

The video keeps playing while a target is pending, so the left time label
always shows the real position. A pending target is dropped when playback
reloads or shrinks into the live preview, and a target applied after the OSD
was hidden does not show it again.

## Preview sources

webOS plays through the native video plane, so the app cannot capture frames
itself. Previews come from images the server already publishes. The player
tries these sources in order and keeps the first one that serves an image
(`src/services/seek-preview.ts`):

| Source | Applies to | Where the images come from |
|---|---|---|
| `seek_preview` M3U attribute | Catch-up, DVR | A per-channel URL template |
| Flussonic | Catch-up, DVR | `<dir>/<utc>-preview.jpg` beside a Flussonic playback URL |
| Nimble Streamer | Catch-up, DVR | `<dir>/dvr_thumbnail_<utc>.jpg` beside a `playlist_dvr…m3u8` URL |
| HLS image playlist | VOD, catch-up | `#EXT-X-IMAGE-STREAM-INF` in the master playlist, with `#EXT-X-TILES` sprite sheets |
| DASH thumbnail track | VOD, catch-up | An image `AdaptationSet` with a `thumbnail_tile` descriptor |
| WebVTT thumbnails | VOD, catch-up | A `seek_preview` URL ending in `.vtt` with no placeholders |

A source that fails its first image, or misses three frames in a row, gives
way to the next. A frame less than a minute old does not count against its
source, since the server may not have made it yet. Track-based sources (HLS,
DASH, WebVTT) are skipped on a live DVR window, whose media time does not map
to wall-clock time. Xtream movies and
episodes are plain files with no preview source, so they show the time
bubble only.

### The `seek_preview` attribute

The attribute follows OTT Navigator's format:

```
#EXTINF:-1 tvg-id="ch1" catchup="default" seek_preview="http://host/p/ch1/{utc}.jpg",Channel 1
http://host/live/ch1.m3u8
```

| Placeholder | Value |
|---|---|
| `{utc}`, `${start}`, `{utcend}`, `${end}` | The previewed moment, in Unix seconds |
| `{start_iso}`, `{end_iso}` | The previewed moment, ISO 8601 UTC |
| `${timestamp}`, `{current_utc}`, `{lutc}`, `{now_iso}` | Now |
| `${offset}` | Seconds from the previewed moment to now |
| `${start-year}`, `-mon`, `-day`, `-hour`, `-min`, `-sec` | Local-time parts of the previewed moment |
| `${token}`, `{key}` | The `token` query parameter of the stream URL |
| `{utc:-5m}`, `{{shift:start:-1h}}` | Shift one placeholder, or every start/end placeholder |

A template with a placeholder the app cannot fill, such as `${login}`, is
skipped and the next source is tried. Previewed moments are rounded down to 10 seconds so the server sees
a small, cacheable set of URLs. A frame loads once the target rests for
150 ms, one at a time, so a held key does not flood the server.
