# HTTP header playback

Some IPTV servers only answer a request that carries the right HTTP
headers: a Referer, a User-Agent, a Cookie, or an Authorization. The
page's own players cannot send most of them, so the app plays such
*header channels* through the TV's media service (UMS, uMediaServer,
which the app drives through Luna `com.webos.media`) or through a
loopback proxy in the bundled service. This document covers how a
header channel is recognized, which path plays it, and how the paths
fall back to one another. The bundled service's
[manifest fetch](lan-service.md#manifest-fetch) and
[loopback proxy](lan-service.md#loopback-proxy) contracts are in
`docs/lan-service.md`.

## Header channels

### Where headers come from

The M3U parser (`src/parsers/m3u-parser.ts`) collects a channel's headers
from:

- `#EXTINF` attributes: `user-agent`, `http-user-agent`, `referrer`,
  `referer`, and `http-referrer`;
- `#EXTVLCOPT:http-referrer=`, `http-user-agent=`, `http-origin=`, and
  `http-cookie=`;
- `#KODIPROP:inputstream.adaptive.stream_headers=` and
  `manifest_headers=`, as `Name=value&Name2=value2`;
- `#EXTHTTP:{"Name": "value"}`;
- a Kodi-style URL suffix, `http://host/a.m3u8|Referer=http://host/&User-Agent=Agent%201`.
  The suffix counts only when it names a known header (Referer,
  User-Agent, Cookie, Authorization, or Origin), so a `|` inside an
  ordinary URL stays part of it.

When two sources set the same header, the URL suffix wins over
`#EXTHTTP`, which wins over `#EXTVLCOPT` and `#KODIPROP`, which win over
`#EXTINF`. Names must be RFC 7230 tokens and values free of CR, LF, and
NUL; hop-by-hop and framing headers (`Host`, `Connection`,
`Content-Length`, `Transfer-Encoding`, and the like) are dropped.

A playlist with one channel per form:

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="ch1" group-title="Header channels",Channel 1
#EXTVLCOPT:http-referrer=http://host/
#EXTVLCOPT:http-user-agent=Agent 1
http://host/ch1/index.m3u8
#EXTINF:-1 tvg-id="ch2" group-title="Header channels",Channel 2
#EXTHTTP:{"Cookie":"session=abc123","Referer":"http://host/"}
http://host/ch2/index.m3u8
#EXTINF:-1 tvg-id="ch3" group-title="Header channels",Channel 3
http://host/ch3/index.m3u8|Referer=http://host/&User-Agent=Agent%201
```

In Local proxy mode an `http://user:password@host/a.m3u8` URL is a
header channel too: the proxy sends its credentials as Basic auth,
which the page's `fetch()` refuses to send. In the other modes the
credentials alone change nothing; the URL's other headers decide how it
plays.

### Why `<video>` cannot send them

The `<video>` element, hls.js, and Shaka request every manifest and
segment through the browser, which sends its own User-Agent and Referer
and lets the page set neither, nor a Cookie for another site. A
User-Agent alone is often not checked, so such a channel still starts on
the element. Any other header (Referer, Cookie, Authorization, Origin,
or a custom one) needs a path that sends it.

UMS does not verify TLS certificates, so Cookie and Authorization never
go to an https URL, on any path. A https channel whose only extra
header is one of those plays as a channel without headers. One with a
Cookie or Authorization and a User-Agent plays only on `<video>`: it
does not count as User-Agent-only, so it gets no
[User-Agent-only retry](#user-agent-only-retry) through Media service.

## The HTTP headers setting

Settings → Advanced → **HTTP headers** decides how far a header channel
may go:

- **Off** plays every header channel on `<video>` without its headers.
  When such a channel fails and Media service would have sent its
  headers, the on-screen error says that HTTP headers are off instead of
  showing the generic error.
- **Media service** (the default) adds the TV's media service.
- **Local proxy** adds the bundled service's loopback proxy after Media
  service. It plays what Media service cannot, such as Widevine and
  ClearKey channels, at the cost of more CPU and memory.

The setting is read on each load, so a change applies from the next
tune. Changing it also clears the window-lookup latch described
[below](#window-lookup).

## Escalation chain

### Steps per mode

Each load plans a chain of steps (`src/components/player-pipeline.ts`)
from the setting and from what the channel needs:

| Setting | Needs Referer, Cookie, Authorization, or another header | User-Agent only |
|---|---|---|
| Off | `<video>` | `<video>` |
| Media service | Media service, then `<video>` as a last resort | `<video>`, Media service |
| Local proxy | Media service, proxy | `<video>`, Media service, proxy |

- `<video>` is never the first step for a channel that needs headers it
  cannot send. In Media service mode it stays as a last resort, which
  plays a channel whose server turns out not to check them. In Local
  proxy mode nothing follows the proxy: the channel fails instead of
  playing without its headers.
- An http URL with `user:password@` never starts on `<video>` in Local
  proxy mode. With no other header its steps are the proxy, then
  `<video>`; with only a User-Agent, Media service, the proxy, then
  `<video>`; with other headers, the same as any channel that needs
  them. Its `<video>` last resort runs only when the server did not
  answer the proxy with a 2xx.
- Media service is left out off webOS (the desktop preview), for TS and
  FLV streams, for a DRM it cannot decrypt (only PlayReady on DASH loads
  there; Widevine, ClearKey, and any DRM on HLS do not), once the
  [window lookup](#window-lookup) has failed for good, and for a stream
  it already failed this session (see [Failures](#failures)).

### Moving on

Only a stream that never started moves on: a startup error, the startup
watchdog (`STARTUP_TIMEOUT`, 15 s without a frame), a Media service
fallback, or a DRM Media service finds in the MPD. A frozen start waits
for the startup watchdog while a step is left, instead of the stall
watchdog reloading it.

- **Time cap:** no step starts once `HEADER_CHAIN_CAP_MS` (25 s) has
  passed since the load, so a dead channel does not spend every step.
- **No reconnect before a start:** in Media service and Local proxy
  modes, a live channel whose chain sends headers and none of whose
  steps started is never reloaded: when its last step fails, or the cap
  is reached, it fails without reconnect attempts. That includes a
  chain left with only the proxy, such as a route whose remembered
  winner is the proxy. Once any step has
  played, the channel reconnects like any other, except a Media service
  stream in Local proxy mode (see *After playing*).
- **Single step:** a chain whose only step is `<video>`, such as every
  channel in Off mode, takes the normal error path, so a network error on live TV reconnects
  first. A start that times out without a frame, a source the player
  cannot play, and a proxy that cannot open fail at once on any chain.
- **Early jump:** a Media service step that learns the stream is neither
  HLS nor DASH, or skips the stream once its type is known, hands it to
  the proxy when that is a step, so the element never gets it without
  its headers. Of the steps that can send headers, only Media service
  first probes the stream type without them; the `<video>` step probes
  without headers too, as it plays without them. A chain that starts on
  the proxy sends no headerless request.
- **After playing:** in Local proxy mode, a Media service stream that
  played and then reports a pipeline error moves straight to the proxy,
  with a fresh cap and no reconnect attempts. The proxy step counts as
  not started until it plays: it gets its own startup watchdog, and if
  it fails the channel fails without going back to Media service. The
  proxy becomes the route's winner once it plays. In Media service mode the same error
  takes the normal reconnect, which starts the chain again, since
  `<video>` would drop the headers. Such an error never counts against
  Media service as a failed start. A proxied stream that played and
  then fails reopens its [session](#sessions) once; if that reopen
  cannot start either, a live channel takes the normal reconnect
  attempts, as any live stream that loses its server does, instead of
  moving to the next channel at once.

### What the viewer sees

When a header channel fails for good, live TV shows the stream error
and moves to the next channel after 2 s. In Off mode, when Media
service would have sent the channel's headers, the error says that
HTTP headers are off; in the other modes it is the generic stream
error. A network error first shows Reconnecting: a `<video>`-only
chain, or a channel that already played, then reloads up to the Live
reconnect attempts setting. A header chain that never started
shows Reconnecting for about 2 s and then moves to the next channel
without a reload.

### Remembered winner

The step that first played a channel is remembered for the app session,
so the next tune starts there. The key is the stream route
(`streamRouteKey`): the URL's origin, its first path segment, and its
`output` or `output_format` query parameter. Channels on the same
server route share it, so one channel's winner also starts its
neighbors on that step. A channel that played on its first step
forgets it, and a `<video>` last resort is never remembered for a
channel that needs headers: the next tune tries the steps that can send
them first.

### User-Agent-only retry

A User-Agent-only channel that fails to start on `<video>`, where the
browser replaces its User-Agent, gets one Media service try per load
with the type the element path already probed. A DASH stream first
drops the element's source and DRM client. A stream on Shaka gets no
retry, and in Off mode there is none.

### One-time manifest URLs

Some servers hand out a manifest URL that works once. A later step then
cannot read what an earlier step already read. The app cannot replay
it, so that step fails as usual; the diagnostic log notes once per load
that the manifest may be single-use.

## Media service (Luna)

`src/components/luna-media-element.ts` plays the stream through
`luna://com.webos.media/load` and presents it as the player's `<video>`,
so the rest of the player needs no special cases. The load sends
Referer, User-Agent, and Cookie in `option.transmission.httpHeader` and
any other header in `extraHttpHeader`, with `mediaTransportType` `HLS`
or `MPEG-DASH`. For DASH on webOS 25, UMS sends them on the MPD
and every init and media segment, through redirects and live MPD
refreshes.

### Window lookup

UMS draws into a window, which the app borrows from a short bundled
placeholder clip (`resources/black.mp4`) played in the `<video>`. First
the app calls `getForegroundAppInfo` once to prove the method exists,
because on the webOS 4 emulator a placeholder played for nothing left
the native pipeline unable to play the next source; a failed call ends the step
without touching the element. Then it plays the placeholder and polls
`getForegroundAppInfo` for the window that shows the placeholder's
`mediaId`, for up to `LUNA_MEDIA_WINDOW_TIMEOUT_MS` (3 s). No match in
that time ends the step too.

When the bus answers that the method does not exist (`Unknown method`,
as the webOS 4 emulator does), the app turns Media service off for that
user agent across launches, in Media service and Local proxy modes, and
header channels go straight to the next step. Changing the HTTP headers
setting tries again. A missing service (at boot, or while uMediaServer
restarts), a timeout, or any other failure only counts toward the
per-session limit: after three no-window fallbacks in a row, with no
Media service start between them, Media service is off until the app
restarts.

### Manifests the page cannot read

The app reads a master playlist or MPD itself, without the channel's
headers, for audio-track names, subtitles, and DRM. When the server
refuses that read with an HTTP 4xx, or the URL carries
`user:password@`, the app asks the bundled service's `fetchManifest` to
read it with the channel's headers
([contract](lan-service.md#manifest-fetch)) and parses the answer as its
own, resolving relative URIs against the final URL. It waits 5 s plus
3 s for the service to start for an HLS master, which never holds
playback, and 2.5 s plus 0.5 s for an MPD, which holds the load until
it settles. A failed service read keeps the headerless outcome. A 5xx
or network error, a media playlist, a segment, and a stream on the
element never reach the service.

### DRM

PlayReady on DASH plays through Media service: the app loads a
PlayReady client first and passes its id beside the headers. License
requests never carry the channel's headers.

A DRM declared with `#KODIPROP` decides the path before the load. A DRM
only the MPD declares is found when the app reads the MPD: a Widevine or
ClearKey MPD then leaves Media service, for the proxy in Local proxy
mode or for Shaka without headers otherwise. An MPD the app cannot read
at all loads as configured, and if UMS rejects that load or reports a
stream error, Media service retries it once as PlayReady before the
stream counts as failed. A timeout or a missing window gets no such
retry. A
PlayReady channel whose MPD needs its headers should declare
`#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready`
to skip this guess.

### Subtitles

- WebVTT renditions are self-rendered on the Media service clock. A
  manifest the bundled service read starts them from that body, so the
  pick never reads the manifest from the page again. Subtitle playlists
  and segments are still read from the page without headers: an HLS
  subtitle playlist refused with an HTTP 4xx, or a first DASH WebVTT
  segment refused with HTTP 401 or 403, resets the pick to Off. Any
  other 4xx on a DASH segment, such as a 404 at a live edge the origin
  has not reached yet, retries on the next poll.
- A dynamic MPD that lists its WebVTT segments in a closed
  SegmentTimeline or a SegmentList gains new segments only when re-read,
  which the page cannot do when only the bundled service could read the
  MPD. In that case the menu leaves those renditions out, also after a
  fallback to the element; an MPD the page read itself keeps them. A duration-based SegmentTemplate, or a SegmentTimeline whose
  last `S` repeats until the next one (`r="-1"`) in an MPD with an
  `availabilityStartTime`, derives its segments from the clock and
  stays.
- Compositor subtitles (CEA-608/708, `stpp`, `wvtt`) stay in the menu
  and toggle with `setSubtitleEnable` on the Media service pipeline's
  own `mediaId`, never the placeholder's, once that pipeline loaded; a
  replaced pipeline gets a fresh call with its new id
  ([compositor details](hls-subtitles.md#5-cea-608708--pipeline-implemented-)).

### Audio tracks

The `<video>` holds only the silent placeholder, so its `audioTracks`
are unusable. The app owns the pipeline and switches with
`selectTrack {mediaId, type:"audio", index}` on its own `mediaId`,
bounded by the list UMS reports; on the `<video>` path that verb stays
forbidden ([why](audio-track-selection.md#why-not-comwebosmediaselecttrack-directly)).

- `sourceInfo.programInfo[0].audioTrackInfo[]` lists the renditions
  (language and `selected`, no name). The menu appears when it holds two
  or more tracks, once the load completed.
- A switch counts on `trackSelected`, or on the call's success when no
  event follows within `LUNA_MEDIA_AUDIO_EVENT_MS`. A refused call or a
  pipeline error meanwhile keeps the previous track checked; the pick is
  saved only once it succeeds.
- Names come from the master read (headerless, or through the bundled
  service), paired with UMS's list by language (in order among
  same-language renditions) only when every track pairs one-to-one, or
  by position when UMS lists no language at all and the counts match;
  otherwise the label is the language's endonym, then "Audio N" (also
  when two unnamed tracks share a language). A saved language matches
  across ISO 639 forms (a three-letter code matches its two-letter
  form); a regional code still
  matches exactly.
- The saved pick is re-applied once both UMS's list and the manifest (or
  its failure) are known. Names paired by position are display-only:
  they never re-apply a saved pick. A `sourceInfo` re-push with the same
  count and languages keeps a confirmed switch.
- Never call `selectTrack` with `type:"text"`: it kills the pipeline.

### Failures

A load UMS rejects keeps that stream off Media service for the session.
A stream error, a missing window, or a timeout may be transient: the
same load moves on, a later tune tries Media service again, and a
second such failure keeps the stream off for the session. A DASH
fallback to the element reuses the MPD already read, releases the
PlayReady client, and prepares a fresh one for the element.

## Local proxy

The bundled service runs an HTTP proxy on `127.0.0.1`, so the page's own
players (`<video>`, or Shaka for Widevine and ClearKey) fetch every
manifest and segment with the channel's headers
(`bundled-service/src/proxy/`, `src/services/proxy-service.ts`). The
exact routes, limits, and answers are in
[`docs/lan-service.md`](lan-service.md#loopback-proxy).

### Sessions

- **Open:** a step that needs the proxy opens a session for the stream's
  URL and headers and plays the proxy URL it gets back. The headers
  stay in the service's memory, never in a URL. While Media service
  tries a channel the proxy may take next, the app opens the session in
  parallel and closes it when Media service starts. The first open waits
  up to 8 s, since it may start the service, later ones 5 s; a session
  that opens after the app gave up is closed. A failed open moves to
  the next step, or fails the stream when none is left.
- **Keep alive:** the app touches the session every 45 s while the
  player holds it, so a paused or fully buffered stream outlives the
  service's 2-minute idle expiry. When a touch finds the session
  already expired while its stream is still current, the app reopens
  it at once rather than wait for the element to fail. A failing proxy
  step reads the last
  upstream status before it closes, which decides whether `<video>` may
  still try.
- **Close:** the app closes the session on the next load and when the
  player is destroyed, and detaches the old source first, so the old
  stream's error is never blamed on the new load. The service keeps at
  most eight sessions and closes the oldest idle one, then the oldest
  streaming one, when a ninth opens; the proxy itself stops 30 s after
  its last session ends.
- **Reopen:** a proxied stream that fails after it played, for example
  when its session expired, reopens a fresh session once; catch-up and
  finite streams resume at their position, or at the seek still in
  progress. A stream that never played takes the normal error path.
- **Suspend and resume:** hiding the app tears down a stream playing
  on the element, any Media service pipeline (it lives outside the
  page), and any proxied stream or load whose session is still
  opening, so no upstream fetch runs while the app is hidden. A proxied
  stream is torn down even when paused, since the TV may pause the
  element before the app learns it is hidden. Resume starts it again on
  a new session, a finite stream at its position, and pauses it again
  if the viewer had paused it. Any other paused stream on the element
  is left as it is. Xtream VOD plays direct and
  never uses the proxy.

### Manifest rewriting

The proxy rewrites every HLS playlist and MPD it serves so that each
URI in it points back through the same session; otherwise the player
would fetch the next manifest or segment straight from the server,
without the headers. Segments stream through unchanged, and license
URLs are left alone, so license requests keep their usual path. Which
tags and attributes are rewritten is in the
[contract](lan-service.md#loopback-proxy).

### Cookies

Each session keeps an in-memory RFC 6265 cookie jar. A `Set-Cookie`
from the server (Domain, Path, Expires, Max-Age, Secure, host-only) is
stored and sent on the session's later requests that domain- and
path-match, redirects included, after the channel's own Cookie, whose
names win. The player never sees the server's cookies, and its own
cookies never go upstream. Under the https rule, the jar neither
stores a cookie from https or one marked Secure, nor sends one to
https. It keeps at most 50. The cookies it refuses (from https, for a
foreign domain, malformed, or over the cap) are counted per reason and
reported once per session, in both the service log and the app's
diagnostic log, when the session closes, or from the last keep-alive
touch when the session expired or the close got no answer.

### Security

The proxy holds credentials and reaches any server, so only the app
may use it, and it must never become a way into the TV itself. It
listens on loopback only and refuses a request for any other host
name, which a DNS-rebinding page would send. A session's random token
never appears in app logs, which redact the upstream URL as they do a
direct stream URL, and the service logs no URL, header, or body. A
loopback upstream is refused, because a request back into the proxy
could deadlock it and the LAN service trusts loopback callers. Cookie,
Authorization, and URL credentials go only to the stream's own origin
and never over https. The exact checks are in the
[contract](lan-service.md#loopback-proxy).

### Desktop preview

Off the TV the service runs standalone with the proxy on a fixed port
(`IPTV_PROXY_PORT`, default 47390, `CONFIG.PLAYER.DEV_PROXY_PORT` in the
app):

```bash
IPTV_PROXY_ALLOW_LOOPBACK=1 npm run service:standalone   # build and run the service
npm run preview              # in another terminal; choose Local proxy
```

`IPTV_PROXY_ALLOW_LOOPBACK=1` lets the proxy reach a server on this
machine, such as the E2E server. The preview has no Media service, so a
header channel's chain is the proxy, plus `<video>` for a User-Agent-only
channel. When the service is not running, a channel that needs Referer,
Cookie, or Authorization fails without trying a headerless element; a
User-Agent-only channel starts on the element anyway.
`e2e/local-proxy.spec.ts` plays a Referer-gated HLS and a clear DASH
stream this way.

## Platform limits

- License requests never carry the channel's headers ([DRM](#drm)).
- Cookie and Authorization never go to an https URL
  ([why](#why-video-cannot-send-them)).
- Media service sends Authorization only on the first manifest request,
  not on segments or live playlist refreshes. A stream that needs it on
  every request plays only in Local proxy mode.
- TS, FLV, and any DRM on HLS skip Media service
  ([steps](#steps-per-mode)).
- webOS 4 may lack the window lookup Media service needs; the webOS 4
  emulator does. The app learns this from the first failed lookup and
  then skips Media service: in Local proxy mode header channels play
  through the proxy, otherwise on `<video>` without their headers
  ([window lookup](#window-lookup)).
- The desktop preview has no Media service ([preview](#desktop-preview)).
