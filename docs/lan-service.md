# LAN Setup Service

A bundled webOS JS service that lets a phone or computer on the same LAN
configure Playlist URLs, Xtream accounts, and ordered EPG sources, or upload an
`.m3u` playlist to the TV. Each manual EPG source can apply globally or to
selected playlists. The TV-side app consumes these changes through Luna.

The service targets webOS TV 4.x's Node.js 0.12.2 runtime. TypeScript emits
ES5/CommonJS, and `scripts/service-compat-gate.mjs` scans the final JavaScript
for newer syntax and APIs. `bundled-service/src/compat.ts` prefers native APIs
on newer TVs and supplies focused fallbacks for Node 0.12.

## Architecture

```
┌──────────────────┐  Luna  ┌─────────────────────────────┐  HTTP  ┌──────────────────┐
│ App (browser)    │◀──────▶│  Bundled service            │◀──────▶│  Phone / laptop  │
│  src/app.ts      │        │  com.lennylxx.iptv.service  │  LAN   │  setup page      │
│  LAN clients     │        │  lan/ + setup/ + upload/    │        │  (/setup)        │
└──────────────────┘        └─────────────────────────────┘        └──────────────────┘
            ▲                             │
            └─────── serviceEvents ───────┘    push notification on every change
```

- **Luna bus** — in-process IPC between the app and the service.
- **HTTP** — `0.0.0.0:<ephemeral>` for phones, `127.0.0.1:<same>` for the app's reconcile fetches.
- **Loopback proxy** — a separate `127.0.0.1:<ephemeral>` server for
  Local proxy header playback; see [Loopback proxy](#loopback-proxy).

## APIs

The service exposes the Luna methods and HTTP routes below.

Luna (called by the app's LAN/reminder/manifest clients and by Activity Manager):

| Method | Subscribe? | Purpose |
|---|---|---|
| `start` | no | Bind the HTTP server; returns the bound port. Idempotent. |
| `stop` | no | Close the HTTP server and release the keepAlive activity. |
| `heartbeat` | no | Liveness probe; returns `{running, port}`. |
| `serviceEvents` | **yes** | Push channel for `uploads-changed` and `setup-changed` events. |
| `getDevMode` | no | Report whether Developer Mode is available for interactive reminder alerts. |
| `fireReminderAlert` | no | Raise the Developer Mode reminder alert requested by Activity Manager. |
| `fetchManifest` | no | GET a stream's master playlist or MPD with the channel's HTTP headers; app-only. |
| `openProxy` | no | Open a loopback proxy session that sends a stream's HTTP headers; app-only. |
| `touchProxy` | no | Keep a loopback proxy session alive and report its last upstream status; app-only. |
| `closeProxy` | no | End a loopback proxy session; app-only. |

HTTP (called by phones, and by the app for reconcile):

| Route | Method | Purpose |
|---|---|---|
| `/info` | GET | Loopback-only metadata, including setup URLs and the pairing code. |
| `/` or `/setup` | GET | Public setup page; asks for the TV pairing code. |
| `/setup?token=…` | GET | QR entry that opens the same page already authorized. |
| `/pair` | POST | Rate-limited exchange of the four-digit code for the setup token. |
| `/setup-state` | PUT | Loopback-only sanitized source state, including enabled flags, published by the TV. |
| `/setup-state?token=…` | GET | Sanitized source and online-subtitle state for the setup page. |
| `/setup-actions?token=…` | POST | Validate and queue a source or online-subtitle change. |
| `/setup-actions` | GET | Loopback-only list consumed by the TV app. |
| `/setup-actions/:id` | DELETE | Loopback-only acknowledgement from the TV app. |
| `/setup-actions/:id?token=…` | GET | Phone-facing application status. |
| `/uploads` | GET | List all stored uploads with serve-back URLs. |
| `/uploads?name=foo.m3u&token=…` | POST | Save a playlist; fires `serviceEvents`. |
| `/uploads/:id[.m3u]` | GET | Serve a stored playlist. |
| `/uploads/:id?token=…` | DELETE | Remove an upload; loopback callers do not need the token. |

## Manifest fetch

`fetchManifest` reads a header channel's master playlist or MPD with the
channel's HTTP headers for the app's Media service path, which calls it
once per load (`src/services/manifest-service.ts`, `bundled-service/src/fetch/`);
when and how long the app waits is in
[HTTP header playback](http-header-playback.md#manifests-the-page-cannot-read).
The app sends the URL percent-encoded (`new URL(url).href`), because
Node.js 0.12's `url.parse` passes a non-ASCII path through as raw bytes.

Request:

```json
{"url": "http://host/a.m3u8", "headers": {"Referer": "http://host/", "User-Agent": "Agent 1"}, "maxBytes": 262144, "timeoutMs": 5000}
```

- **Caller:** only the app is answered, identified by the LS2 application
  id, then the sender service name, then webos-service's `message.sender`;
  a lookup that throws counts as empty.
  An application id or `message.sender` must be `com.lennylxx.iptv`,
  alone or with WAM's `" <pid>"` suffix; only a sender service name may
  also be `com.lennylxx.iptv-<digits>`, since another app's id can end
  in `-<digits>`. Any other caller gets `denied` without a request being
  made, and the service logs the denial with the caller's id, every digit
  replaced by `N`, and which lookup supplied it.
- **URL:** `http:` and `https:` only.
- **Headers:** the same set the app passes to `com.webos.media/load`: every
  header the playlist parser kept, minus hop-by-hop, framing, and routing
  headers (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`,
  `Proxy-*`, and the like) and `Accept-Encoding`. Names must be RFC 7230
  tokens and values free of CR, LF, and NUL; at most 32 headers. Cookie and
  Authorization never go over https, as on the Luna path, and never follow
  a redirect to another origin.
- **User-Agent:** Node.js sends none of its own, and many origins refuse a
  request without one, so the app adds the TV's `navigator.userAgent`
  when the channel declares no User-Agent (matched case-insensitively).
- **URL credentials:** a `user:password@` in the URL is sent as Basic
  auth under the Cookie rule: over http only, on the first request and
  same-origin redirects. An Authorization header the channel declares
  takes precedence. The `url` in the answer never carries them.
- **Redirects:** 301, 302, 303, 307, and 308, at most 5, http and https
  only.
- **Limits:** `timeoutMs` (default 5000, at most 10000) covers the whole
  redirect chain; `maxBytes` (at most 1 MiB) caps the decoded body.
- **Encoding:** gzip and deflate bodies are decoded; a leading UTF-8 BOM
  is dropped.

Success returns `{returnValue: true, status, url, text}`, where `url` is the
final URL after redirects; the app resolves relative URIs against it.
Failure returns `{returnValue: false, errorCode, errorText}`, plus `status`
when a response arrived. `errorCode` is one of `bad_url`, `denied`,
`timeout`, `too_large`, `too_many_redirects`, `network`, `decode`, or
`http_NNN`. The service logs only the outcome and the status or error code,
never the URL, headers, or body.

## Loopback proxy

The proxy plays a header channel in Local proxy mode by sending its
headers on every manifest and segment the page's own players request
(`bundled-service/src/proxy/`, `src/services/proxy-service.ts`). When the
app uses it, how sessions are kept and reopened, and its security model
are in [HTTP header playback](http-header-playback.md#local-proxy); this
section is the service contract.

Request (`openProxy`):

```json
{"url": "http://host/a.m3u8", "headers": {"Referer": "http://host/", "User-Agent": "Agent 1"}}
```

Success returns `{returnValue: true, url, token}`; failure returns
`{returnValue: false, errorCode, errorText}` with `errorCode` `bad_url`,
`denied`, `blocked` (a loopback upstream), or `unavailable` (the server
could not bind). `touchProxy {token}` marks the session used and returns
`{returnValue: true, alive, lastStatus, manifestStatus, cookies}`, the
last upstream status of any request and of a manifest (0 before the
first) and the cookies the session's jar refused, counted by `https`,
`domain`, `malformed`, and `cap`
([cookie rules](http-header-playback.md#cookies)). `closeProxy
{token}` returns `{returnValue: true, closed, cookies}`. Callers are
checked as for `fetchManifest`.

- **Server:** `127.0.0.1` only, on an ephemeral port, started on the
  first `openProxy` and closed 30 s after its last session ends. The
  service holds a `proxyKeepAlive` activity from the first session until
  that close. The socket timeout is off.
- **Sessions:** a 128-bit random hex token names one stream's URL and
  headers. A session ends on `closeProxy`, after 2 minutes without a
  request or touch, or when a ninth opens: at most 8 are kept, and the
  oldest idle one goes first, then the oldest streaming one.
- **URL:** `http://127.0.0.1:<port>/p/<token>/<http|https>/<host[:port]><path>?<query>`.
  The upstream path stays intact, so a relative URI resolves under the
  proxy even where the rewriter left it alone. Userinfo and fragments
  are dropped.
- **Upstreams:** a loopback upstream (`127.0.0.0/8`, `::1`, `0.0.0.0`,
  and their mapped forms) fails `openProxy` with `blocked`; a request
  or redirect that reaches one, by name or resolved address, gets 403.
  LAN addresses stay allowed.
- **Requests:** GET, HEAD, and OPTIONS only (OPTIONS answers the CORS
  preflight and allows `Range`); every response carries
  `Access-Control-Allow-Origin: *` and exposes `Content-Length`,
  `Content-Range`, and `Accept-Ranges`. A `Host` other than
  `127.0.0.1:<port>` or `localhost:<port>` gets 403; an unknown or
  expired token gets 404.
- **Headers:** the channel's headers go upstream, sanitized as for
  `fetchManifest`; when the channel sets no User-Agent, the app supplies
  the TV's, as for `fetchManifest`. Cookie, Authorization, and URL credentials go only to
  the session's own origin and never over https; another origin gets
  the rest. Of the client's headers only `Range`, `If-Range`, and
  `Accept` (when the channel sets none) pass; its cookies never do.
  Hop-by-hop headers are dropped both ways, and upstream `Set-Cookie`
  never reaches the client. Cookies the session's jar stored are added
  to matching requests ([cookie rules](http-header-playback.md#cookies)).
- **Redirects:** followed in the service, at most 5, under the
  `fetchManifest` rules.
- **Manifests:** a 200 GET whose type or body is an HLS playlist
  (`#EXTM3U`) or an MPD (`<MPD`) is read whole (at most 4 MiB; gzip and
  deflate decoded) and rewritten against its final URL; a body whose
  first 1 KiB is only whitespace streams through. HLS: URI lines
  and every `URI="…"` attribute (`EXT-X-MEDIA`, `EXT-X-MAP`, `EXT-X-KEY`,
  `EXT-X-I-FRAME-STREAM-INF`, `EXT-X-SESSION-KEY`, …); `data:`, `skd:`, and
  other non-http URIs stay. DASH: `BaseURL`, `Location`, and
  `PatchLocation`; absolute or root-relative `SegmentTemplate@media` and
  `@initialization`, `SegmentURL@media`, and `Initialization@sourceURL`,
  with `$…$` identifiers kept. A `../` above the upstream root stops at
  the root (RFC 3986), never climbing into the proxy's own path. After a redirect an MPD without a top-level
  `BaseURL` gains one, so relative segments resolve against the final URL.
  License URLs (`dashif:laurl`, `ms:laurl`, `clearkey:Laurl`) are left
  alone; license requests keep their usual path.
- **Segments:** streamed with backpressure, passing status,
  `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges`.
  At most 6 upstream requests run per origin, the rest queue. No
  response headers within 10 s gives 504, a body that stalls upstream
  for 30 s ends (time spent waiting on a paused client does not count),
  and a network error gives 502. A client that disconnects aborts
  the upstream request.
- **Logging:** never URLs, headers, or bodies. One line per session when
  it ends, with why it ended and its request, byte, status-class, abort,
  and rewrite counts; a bind failure is a warning.

### Running it on a desktop

Off the TV (no `webos-service`) the service starts the proxy at once on
`IPTV_PROXY_PORT` (default 47390) and adds three loopback control routes:
`POST /open` with the `openProxy` JSON body, answering
`{returnValue, url, token}` (400 on failure), and `POST /touch` and
`POST /close` with `{token}`. They take the same `Host` check, accept an
`Origin` only from `localhost` or `127.0.0.1`, and are never served on
webOS. `IPTV_PROXY_ALLOW_LOOPBACK=1` lets the proxy reach an upstream on
this machine (other than itself), as the E2E server is. How to run the
desktop preview against it is in
[HTTP header playback](http-header-playback.md#desktop-preview).

## Event-driven updates

When a phone uploads, deletes, or submits a source change, the TV updates
within milliseconds. There is **no background polling**.

A successful POST or DELETE on the HTTP side calls an `onChange` hook,
which iterates the active `serviceEvents` subscriber list and calls
`msg.respond({event})` on each one. Upload events refresh `/uploads`.
Setup events make `SetupClient` consume the pending actions, update the
existing `StorageService` models, publish a sanitized `/setup-state` snapshot,
acknowledge each action, and reload data. EPG edits use one
`manual-epg-sources` action containing the complete ordered list, so priority
and playlist scope change atomically. The phone waits for that
acknowledgement before showing “Saved on TV”. Source-removal actions use the
same queue, so deleting a Playlist or Xtream account remains idempotent.
Source-enable actions also use this queue for URL, Xtream, and uploaded
playlists; missing `enabled` fields remain backward-compatible and mean enabled.

The TV also publishes state after service startup and local Settings changes.
The setup page refreshes the snapshot periodically. Xtream snapshots contain
the account id, display name, server URL, and username, but never the password.
Online-subtitle snapshots contain only the preferred language and configured
flags for each provider, plus the OpenSubtitles username. API keys, passwords,
and login tokens never leave the TV. The phone shows configured secrets as a
fixed `********` mask that does not reveal their length. An unchanged mask
preserves the value, one delete clears the field, and replacement text updates
only that field.

Rejected uploads (HTTP 400) and missing-id deletes (HTTP 404) do **not**
fire the event.

Uploaded files remain server-authoritative. Setup actions remain in a shared
in-memory queue until the TV acknowledges them. If the app misses a push,
bundled-service initialization consumes the queue after reconnecting.

## Setup authorization

Every HTTP bind generates a random 12-character token. `/info` is available
only over loopback, so only the TV app can obtain the tokenized setup URL for
the QR code. It also returns a random four-digit code for computers that open
the short root URL manually. The public page exchanges that code for the full
token; five failures from one client lock pairing for one minute.

The token is required to submit source changes, query their status, upload M3U
files, read the sanitized setup state, or remotely delete uploads. Publishing
state and reading or acknowledging queued actions is loopback-only, which
prevents another LAN client from injecting state or reading Xtream
credentials. Upload identifiers are validated before file access so requests
cannot escape the upload directory. A new foreground bind creates a new token,
pairing code, and URL, invalidating the old values.

## Foreground / background lifecycle

The service is tied to the app's visibility. When the app is backgrounded
(`visibilitychange → hidden`) the app calls Luna `stop`, which closes the
HTTP listener and releases the `keepAlive` activity — neither the LAN
port nor the service process lingers while other webOS apps are in use.

When the app is foregrounded (`visibilitychange → visible`) it calls
Luna `start` again, which re-binds the HTTP server on a new ephemeral
port and resubscribes to `serviceEvents`. `Settings.refreshSetupInfo()` and
`Settings.refreshUploads()` run so the QR code and upload list reflect the
new port and current state.

The service process itself stays alive across stop/start cycles — only
the HTTP server is torn down. Luna respawns the process on cold start
(first call to `start` after a TV reboot or app uninstall).

## Why this shape?

- **Why a separate process?** webOS sandboxes the app and won't let it
  open a server socket on a non-loopback interface. The bundled service
  runs alongside but independently.
- **Why an OS-assigned port?** A fixed port (e.g. 8890) collides
  unpredictably with whatever else is running on the TV. The OS-assigned
  port is reported back through Luna's `start` response, so the app and
  the phone always agree.
- **Why Luna push and not polling?** Polling wakes the device ~20×/min
  per active Settings view to detect a change that happens maybe twice
  per session, and adds 1–3s lag. Push is built into the platform — one
  `subscribe: true` request from the app, `msg.respond()` from the
  service.
- **Why stop/start on background?** Holding an open LAN port and a
  keepAlive activity while the app is invisible is wasteful and a small
  attack surface. Closing it on hidden costs only a fresh `listen(0)`
  when the app returns.
- **Why M3U only — why not EPG upload too?** The upload plumbing is
  content-agnostic and could carry an XMLTV file just as easily, but it
  would be the wrong model for EPG:
  - **EPG is time-sensitive; an upload is a frozen snapshot.** The app
    refreshes EPG periodically and keeps only a ±7-day program window
    (`src/services/epg-service.ts`, `src/parsers/xmltv-parser.ts`). An
    uploaded XMLTV file is stale within a day or two and effectively
    empty within a week — so the user would have to re-upload every
    couple of days, forever. A playlist, by contrast, is static: upload
    once and it stays valid. Upload fits M3U precisely because M3U
    doesn't expire.
  - **EPG almost always travels as a URL.** It's embedded in the M3U
    header (`x-tvg-url` / `url-tvg`, auto-detected) or fetched from a
    public aggregator. The "I have a file but no hosted URL" gap that
    justifies M3U upload barely exists for EPG.
  - **The local-source case is already covered — and stays fresh.** The
    manual EPG source list in **Settings → EPG**, plus the
    localhost→playlist-host rewrite in `src/services/playlist-service.ts`
    (for users running a local proxy like xTeVe/Threadfin that serves
    M3U and XMLTV from the same box), let the TV *pull* fresh EPG by URL.
    Pull stays current automatically; a push upload does not. For EPG,
    pull strictly dominates.

  If genuine demand for fully offline, file-based EPG ever shows up, the
  better shape is a per-playlist EPG URL the TV can re-pull, not a
  one-shot upload that throws away the freshness guarantee.
