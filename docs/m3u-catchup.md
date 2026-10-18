# M3U catch-up

How the app turns M3U catch-up tags into an archive URL for a past program.
It follows the modes and format specifiers of Kodi's
[pvr.iptvsimple](https://github.com/kodi-pvr/pvr.iptvsimple#catchup-format-specifiers),
which most providers target. Xtream accounts use the account's archive API instead
(see `src/services/xtream-archive.ts`).

| | |
|---|---|
| **Code** | `src/parsers/m3u-parser.ts` (tags), `src/utils/catchup-url.ts` (templates), `src/components/player.ts` (`resolveStreamUrl`, shift window) |

## Tags

An entry's own tags win over the `#EXTM3U` header's.

| Tag | Where | Meaning |
| --- | --- | --- |
| `catchup` / `catchup-type` | entry, header | Mode, see below. `fs` is `flussonic`. |
| `catchup-source` | entry, header | URL template, or a query to append (`append`). A header source applies to entries that use the header's mode. |
| `catchup-days` | entry, header | Archive days. |
| `timeshift` | entry | SIPTV archive days. Without a mode it implies `shift`. It is not an EPG shift; that is `tvg-shift`. |
| `tvg-rec` | entry | Same as `timeshift`, used when `timeshift` is absent. |
| `catchup-time` | header | Archive length in seconds, used when `catchup-days` is absent. |

A channel offers catch-up when it ends up with a template; a past program is
playable when it starts within the archive days.

## Modes

| Mode | Template |
| --- | --- |
| `default` | `catchup-source` as the full URL. |
| `append` | Stream URL + `catchup-source`, joined with `?` or `&`. |
| `shift` | Stream URL + `utc={utc}&lutc={lutc}` (SIPTV), unless `catchup-source` is set. |
| `flussonic` | Derived from the stream URL: `.../<name>.m3u8` becomes `.../<name>-{utc}-{duration}.m3u8`, `.../mpegts` becomes `.../archive-{utc}-{duration}.ts`. The query string is kept. |
| `xc` | Xtream timeshift URL inferred from an Xtream live URL. |

The `flussonic` template uses Flussonic's fixed-window archive playlist, which
spans exactly the program and ends with `#EXT-X-ENDLIST`, rather than Kodi's
sliding `timeshift_rel` stream: the player seeks inside a finite playlist.

## Format specifiers

Every occurrence is replaced.

| Specifier | Value |
| --- | --- |
| `{utc}`, `${start}` | Program start, Unix seconds |
| `{utcend}`, `${end}` | Program end, Unix seconds |
| `{lutc}`, `${now}`, `${timestamp}` | Request time, Unix seconds |
| `{duration}`, `${duration}` | Program length, seconds |
| `{duration:N}` | Program length divided by N seconds |
| `${offset}`, `{offset:N}` | Seconds since the program start, divided by N |
| `{Y}` `{m}` `{d}` `{H}` `{M}` `{S}` | Program start date parts, device local time |
| `{utc:YmdHMS}` (and the other timestamp names) | That timestamp formatted with those letters, device local time |
| `{channel-id}` | `tvg-id`, else the channel name, URL-encoded |

## Shift playback

A `shift` request returns a playlist that runs past the program: up to now, or a
server-side window. For `shift` channels the program length bounds the progress
bar, seeking and saved progress, and crossing the program end returns to the live
channel, as the end of any catch-up does. Other modes use the media duration,
since providers pad archive playlists on purpose.

Servers that answer `shift` with a sliding live playlist (no `#EXT-X-ENDLIST`)
play from the requested start but cannot be seeked; the player has no
URL-rebuilding seek for them.
