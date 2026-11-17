# M3U Catch-up Formats

A channel plays past programs when its M3U entry, or the `#EXTM3U` header,
declares catch-up. `src/utils/catchup-url.ts` builds the archive URL;
Xtream accounts and `catchup="xc"` entries use the Xtream timeshift URL from
`src/utils/xtream-url.ts` instead.

## Attributes

| Attribute | Meaning |
| --- | --- |
| `catchup`, `catchup-type` | How the archive URL is built (see below). |
| `catchup-source` | The URL template, or the suffix for `append`. |
| `catchup-days`, `timeshift`, `tvg-rec` | Days of archive; `0` means none. |
| `catchup-time` | The archive window in seconds. |
| `catchup-correction` | Hours added to every time in the URL, e.g. `-2.5`. |
| `catchup-enable` | `1` gives the channel an archive; `0` none, even when the header declares one. |

The archive length comes from `catchup-days` and `catchup-time`, the larger
of the two when both are set. Without either, `timeshift` gives it, and
without that `tvg-rec`; either is ignored when `catchup-days` or
`catchup-time` is present.

A channel with archive days, or `catchup-enable="1"`, but no type and no
source uses `shift`. The `timeshift` attribute is archive days, not an EPG
shift (`tvg-shift` is). On an Xtream live URL of the form
`/live/<user>/<pass>/<id>` (with or without `.ts` or `.m3u8`), or in an
Xtream account's playlist, such a channel uses the Xtream archive instead,
and the account's catalog decides whether the stream has one. An explicit
type or source always wins; `catchup="xc"` also accepts the bare
`/<user>/<pass>/<id>` form.

The header's `catchup`, `catchup-type`, `catchup-source`, `catchup-days`,
`catchup-time`, `timeshift`, `tvg-rec`, and `catchup-correction` are
defaults:

- When no channel has a catch-up attribute of its own (`catchup`,
  `catchup-type`, `catchup-source`, `catchup-days`, `catchup-time`, `tvg-rec`,
  `timeshift`, or `catchup-enable="1"`), every channel gets the header's
  archive.
- Once any channel has one, only channels with their own attribute get an
  archive; they still take the header's type and source when they name none.
  A channel a playlist filter drops still counts. Channels that already
  arrived lose the header's archive as soon as it is found, and each list
  shows that on its next render.
- On an Xtream account, the account's own archive for a stream replaces the
  header's, as it does an archive implied only by archive days.
- A non-HTTP stream (UDP, RTP, RTSP) never gets a rule-built archive URL
  (`shift` … `fs`) from the header or from archive days alone.

## Types

Examples use the live URL `http://host/ch1/index.m3u8`.

| Type | Archive URL | Ends with the program |
| --- | --- | --- |
| `default` | `catchup-source` with its variables filled. Without a source, as `shift`. | see below |
| `append` | The live URL plus `catchup-source`. A leading `?` or `&` is adjusted to the live URL's query. | see below |
| `shift` | Adds `utc={utc}&lutc={lutc}` to the query. | no |
| `archive` | Adds `archive={utc}&archive_end={utcend}` to the query. | no |
| `timeshift` | Adds `timeshift={utc}&timenow={lutc}` to the query. | no |
| `flussonic` | `flussonic-dash` for a `.mpd` URL, `flussonic-ts` for `.ts` or `mpegts`, `flussonic-hls` for `.m3u8`. | yes |
| `flussonic-hls` | The playlist name with the window: `index.m3u8` → `index-{utc}-{duration}.m3u8`, `mono.m3u8` → `mono-{utc}-{duration}.m3u8`. | yes |
| `flussonic-dash` | The last path part → `archive-{utc}-{duration}.mpd`. | yes |
| `flussonic-ts`, `fs` | The last path part → `archive-{utc}-{duration}.ts`. | yes |
| `vod` | `catchup-source` with its variables filled, or, without a source, the program's `catchup-id` itself as the URL. | yes |
| `xc` | Xtream timeshift URL derived from `/live/<user>/<pass>/<id>`; an explicit `catchup-source` is used as written, with Xtream's `{start}` (`YYYY-MM-DD:HH-MM`) and `{duration}` (minutes). | yes |

The Flussonic forms are its fixed-window archive URLs: the HLS playlist
`<name>-<from>-<duration>.m3u8`
([DVR playback](https://flussonic.com/doc/fms/dvr/playback/),
[HLS](https://flussonic.com/doc/fms/protocols/hls/)) and the MPEG-TS file
`archive-<from>-<duration>.ts` ([DVR API](https://flussonic.com/doc/fms/dvr/api/)).
The TS file is used for `fs` too, where the OTT Navigator FAQ names the
open-ended `timeshift_abs-<from>.ts`, so every Flussonic archive ends with
the program. A Flussonic type needs a live URL (or plain `catchup-source`)
whose last path part is a Flussonic playback file: `*.m3u8`, `*.mpd`, `*.ts`,
or `mpegts`. Flussonic's docs place those files under the stream's directory
and document no bare stream URL, so a URL such as `http://host/live/ch1` has
no derived archive. The other types follow the OTT Navigator catch-up FAQ and
the Kodi IPTV Simple README.

- A `catchup-source` without `/` is ignored except by `append` and `vod`.
- With the rule-based types (`shift` … `fs`), a source that contains a
  variable is used as a full template; a plain source replaces the live URL
  the rule rewrites.
- A source with no type, or with an unrecognized type, is a template, as for
  `default`. An unrecognized type logs `event=catchup.type.unknown`.
- The query and fragment of the live URL are kept by every rule.
- When the URL uses `{catchup-id}` (`vod` without a source, or any template
  containing it), only past programs whose XMLTV entry carries a
  `catchup-id` offer catch-up; the others show as plain past programs. If
  such a URL is still asked for without an id, the player plays live with a
  "catch-up unavailable" notice and logs `event=catchup.url.unavailable`.

### Program catch-up ids

The guide reads the `catchup-id` attribute of each XMLTV `<programme>`, the
program's id on the provider's archive server:

```
<programme channel="ch2" start="20260102030405 +0000" stop="20260102040405 +0000" catchup-id="p1">
  <title>Alpha</title>
</programme>
```

The id travels with the program into the guide, Search, the player, and a
saved catch-up position, so resuming from Recently Watched rebuilds the same
URL. A position saved before ids were kept takes the id of the guide's
program at the same start, for channels whose URL needs one.

The guide keeps ids only for the channels whose URL uses `{catchup-id}`, so
a guide with ids costs nothing extra when no such channel exists. Adding such
a channel later makes the guide count as not covering it, and the feed is
parsed again.

Guides and playlists cached by an earlier version are discarded on upgrade
and downloaded and parsed again once, so the first launch after an upgrade
starts without a cache. Until the guide has ids, a saved position without one
stays in Recently Watched but is not listed.

### Open-ended archives

A template (`default`, `append`, `vod`, or any type with a source that has
variables) ends with the program when it names the end or the length: a
start variable (`{utc}`, `${start}`, `{start_iso}`, `{Y}`…, `${start-…}`,
`${offset}`) without any of `{utcend}`, `${end}`, `{end_iso}`, `${end-…}`,
`{duration…}`, `${durmin}`, or `{{shift:end:…}}` asks for everything from the
start on, which runs into live.

An archive URL that does not end with the program (the "no" rows above, and
such templates)
plays on into live and has no duration. The player keeps the program's
timeline itself: resuming, seeking, and a stall reload rebuild the URL with
the start moved to the target position, the elapsed time is the offset plus
the stream's own time, and reaching the program's end returns to live as a
finished program does.

## Variables

Names are case-insensitive except the single-letter date parts. Each may be
written `{name}` or `${name}`. Unrecognized variables stay in the URL.

| Variable | Value |
| --- | --- |
| `{utc}`, `${start}` | Program start, Unix seconds. |
| `{utcend}`, `${end}` | Program end, Unix seconds. |
| `{lutc}`, `${now}`, `${timestamp}`, `{current_utc}` | Now, Unix seconds. |
| `{start_iso}`, `{end_iso}`, `{now_iso}` | The same in UTC ISO form, `2026-01-02T03:04:05Z`. |
| `{duration}`, `${duration}` | Program length, seconds. `{duration:60}` divides it (minutes); a zero or non-integer divider counts as 1. |
| `${durmin}` | Program length, minutes. |
| `${offset}` | Seconds from the program start to now. `{offset:60}` divides it, as for `{duration:X}`. |
| `{Y}` `{m}` `{d}` `{H}` `{M}` `{S}` | Start year, month, day, hour, minute, second in the TV's local time. |
| `${start-year}` `${start-mon}` `${start-day}` `${start-hour}` `${start-min}` `${start-sec}` | The same parts of the start; `${end-…}` for the end. |
| `{catchup-id}` | The program's XMLTV `catchup-id`, inserted as written. A result that is not an absolute URL (an id such as `p1` without a template) is not played. |
| `{channel-id}` | The channel's `tvg-id`, or its name when it has none, URL-encoded. |

A time variable takes one argument after a colon:

- a shift: `{utc:-5m}`, `${start:+1h}`, `{utcend:90}`, `{utc:1d}` (`m`, `h`,
  `d`, or plain seconds);
- or a date format in local time: `{utc:YmdHM}`, `${end:Ymd-H-M}`, where
  `Y m d H M S` become the date parts and other characters stay.

`{{shift:start:-5m}}` or `{{shift:end:+10m}}` anywhere in the URL moves that
time for every variable, durations included, and is removed; only the first
one counts.

A live stream URL may carry the current-time variables (`{lutc}`, `${now}`,
`${timestamp}`, `{current_utc}`, `{now_iso}`, with arguments); they are
filled each time the channel starts.

## Examples

```
#EXTM3U
#EXTINF:-1 tvg-id="ch1" timeshift="3",Alpha
http://host/ch1/index.m3u8
#EXTINF:-1 catchup="default" catchup-source="http://host/ch2/{utc}-{duration}.m3u8",Bravo
http://host/ch2/index.m3u8
#EXTINF:-1 catchup="append" catchup-source="&cutv={Y}-{m}-{d}T{H}:{M}:{S}",Charlie
http://host/ch3.ts
#EXTINF:-1 catchup="flussonic",Delta
http://host/ch4/index.m3u8?token=t1
```

For a program starting at Unix time `1767323045`, an hour long, Alpha plays
`http://host/ch1/index.m3u8?utc=1767323045&lutc=<now>` and Delta plays
`http://host/ch4/index-1767323045-3600.m3u8?token=t1`.

## Not supported

- Upcoming or live programs through `vod`: only aired programs play as
  catch-up.
- `${token}`, `{key}`, `${login}`, `${password}`: the app has no per-provider
  token or login settings for M3U playlists.
- A per-provider override of the catch-up type and days.
