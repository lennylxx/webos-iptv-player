<div align="center">
  <img src="assets/icon.svg" alt="webOS IPTV Player icon">
  <h1>webOS IPTV Player</h1>
  <p>An IPTV player for LG webOS TVs. Supports M3U playlists, Xtream Codes accounts, XMLTV program guides, and catch-up/timeshift playback.</p>
  <p>English | <a href="README.zh-CN.md">简体中文</a></p>
  <p>
  <a href="#supported-webos-versions"><img src="https://img.shields.io/badge/webOS-4%2B-e6007e?logo=webos&logoColor=white" alt="webOS 4+"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases/latest"><img src="https://img.shields.io/github/v/release/lennylxx/webos-iptv-player" alt="Latest release"></a>
  <a href="https://github.com/lennylxx/webos-iptv-player/releases"><img src="https://img.shields.io/github/downloads/lennylxx/webos-iptv-player/total" alt="GitHub downloads"></a>
  <a href="https://lennylxx.github.io/webos-iptv-player/"><img src="https://img.shields.io/badge/Website-222?logo=github" alt="Project website"></a>
  </p>
</div>

## Screenshots

| Channel list | Recently watched |
| --- | --- |
| ![Channel list](https://github.com/user-attachments/assets/ec5dab43-3b1e-4b90-a20f-71514b8a605b) | ![Recently watched](https://github.com/user-attachments/assets/529c23e4-5fe4-4fbf-bae8-f62ce6008e33) |

| Program guide | Catch-up resume |
| --- | --- |
| ![Program guide](https://github.com/user-attachments/assets/9928c342-c2fa-46b8-92f1-b5e815f24f19) | ![Catch-up resume](https://github.com/user-attachments/assets/9a49fa89-b3ae-4b27-bcd6-b93de2c3e1e1) |

| Channel info | Playback overlays |
| --- | --- |
| ![Channel info](https://github.com/user-attachments/assets/e0dd4fbf-b6b4-46f6-a8e8-7235c66d9512) | ![Playback overlays](https://github.com/user-attachments/assets/1a2a3fe7-55ca-4a7c-ac05-a38c4f578e41) |

| Subtitles | Subtitle search |
| --- | --- |
| ![Subtitles](https://github.com/user-attachments/assets/5d1fab57-1087-414b-9a20-f900589eac4a) | ![Subtitle search](https://github.com/user-attachments/assets/4ef9c97e-131b-4e4f-bf9a-c753d66f2956) |

| Movies | Movie detail |
| --- | --- |
| ![Movies](https://github.com/user-attachments/assets/a6b09baf-0342-4e02-9d7e-5cf7677d1ecf) | ![Movie detail](https://github.com/user-attachments/assets/1380b0b2-680f-49bb-a470-336c9e14a54a) |

| Series detail | Search |
| --- | --- |
| ![Series detail](https://github.com/user-attachments/assets/e7bf3b55-3464-4c7a-966d-34ee432795e3) | ![Search](https://github.com/user-attachments/assets/8677ff38-b32d-44af-991b-ce40a7157e61) |

| Settings | Theme picker |
| --- | --- |
| ![Settings](https://github.com/user-attachments/assets/0813b5a4-41ce-4a13-b398-8e7bb213de64) | ![Theme picker](https://github.com/user-attachments/assets/90ecc674-1421-42a5-8c10-248697cce305) |

| Reminder manager | LAN setup |
| --- | --- |
| ![Reminder manager](https://github.com/user-attachments/assets/f48116a3-9553-4d22-b0b1-ebd09a477a5b) | ![LAN setup](https://github.com/user-attachments/assets/fda1f741-bf92-45fd-b7c5-e2ed555cdc92) |

## Features

**Playlists & accounts**

- **M3U playlists** — load multiple M3U/M3U8 lists, auto-deduplicated, and temporarily disable a source without deleting its setup
- **Xtream Codes accounts** — add or temporarily disable accounts, or switch between accounts from the top-bar avatar; playlists and EPG data are derived from their credentials
- **LAN setup** — configure sources and online subtitle settings or upload `.m3u` files from a phone on the same network by scanning a QR code ([LAN service](docs/lan-service.md))

**Live TV & on-demand**

- **Program guide (EPG)** — three-pane guide with an auto-derived date range, per-source time correction, and caching for instant reopen
- **Channel health** — check live streams and mark them as healthy, suspect, or unavailable
- **Reminders** — flag an upcoming program and get notified at air time, even with the app closed, to tune straight in
- **Recently Watched** — return to recent live channels or resume partially watched catch-up programs
- **Movies & Series** — browse an Xtream account's VOD catalogs, with Continue Watching and account-scoped Watchlist rails
- **Automatic VOD queues** — continue through series episodes or remaining Watchlist movies, removing completed titles from the Watchlist
- **Catch-up & Live DVR** — replay past programs, and pause / rewind / return to the live edge on live streams

**Playback**

- **Native HDR & Dolby passthrough** — the stream goes straight to the TV's decoder, so HDR10, HLG, Dolby Vision®, and Dolby Atmos® pass through untouched — **[Why native instead of hls.js? See the on-device comparison](docs/native-vs-hls.js.md)**
- **MPEG-DASH playback** — play `.mpd` channels through the native webOS pipeline or dash.js in the desktop preview, with MPD track metadata, live DVR, self-rendered raw WebVTT, and native IMSC/`stpp` and `wvtt` subtitles ([details](docs/mpeg-dash.md))
- **Audio & subtitle tracks** — pick from the player menu, remembered per channel or VOD item; subtitles cover in-manifest WebVTT and CEA-608/708 (live), in-container / sidecar SRT/WebVTT/ASS (VOD), and online search (SubDL, OpenSubtitles, and Assrt) with a manual title box; online search remains available when bundled tracks exist, and subtitle timing can be adjusted live
- **On-screen display** — program title, progress, and a live stream-info readout (resolution, HDR, frame rate, codec, audio channels)
- **Resync A/V** (🔄) — one tap on the playback bar re-locks audio and video that drift apart during a long catch-up or on-demand stream

**Navigation**

- **Search** — across channels, EPG programs, movies, and series, with direct live, catch-up, and reminder actions
- **Channel sidebar** — switch channels over the video with current-program info, organized by group
- **Channel customization** — reorder, hide, rename, regroup, manage favorites, and correct per-channel EPG matching or timing
- **Auto-play and genre group icons** for faster browsing
- **Full remote & Magic Remote** — spatial D-pad navigation and pointer control across every view
- **Color themes** — choose from light and dark app-wide themes with live previews, plus Dark or Frosted player overlays; selections persist across launches
- **Adjustable text size** — scale text from 80%–150% without resizing controls
- **Multilingual interface** — available in English, Deutsch, Español, Français, Italiano, Português (Brasil), Русский, Українська, and 简体中文; follows the TV language by default or can be selected explicitly in Settings

**Development**

- **Desktop preview** — browser-based playback via HLS.js, mpegts.js, and dash.js

## Supported webOS versions

The app runs on **webOS 4.0 (2018) and newer**. Its baseline is the Chromium 53
engine on webOS 4; every later release ships a newer Chromium, so the app is
forward-compatible. Features only newer engines support natively (flex `gap`,
`backdrop-filter`, …) get feature-detected fallbacks on the older ones.

| webOS version | Released | Chromium engine | Bundled service Node.js | Supported |
| --- | --- | --- | --- | --- |
| webOS 4.x | 2018–2019 | 53 | 0.12.2 | ✅ (minimum) |
| webOS 5.0 | 2020 | 68 | 8.12.0 | ✅ |
| webOS 6.0 | 2021 | 79 | 8.12.0 | ✅ |
| webOS 22 | 2022 | 87 | 12.21.0 | ✅ |
| webOS 23 | 2023 | 94 | 12.22.2 | ✅ |
| webOS 24 | 2024 | 108 | 16.19.1 | ✅ |
| webOS 25 | 2025 | 120 | 16.20.2 | ✅ |
| webOS 26 | 2026 | 132 | 20.12.2 | ✅ |

webOS 3.x and older (Chromium 38 and earlier) are not supported.

## Prerequisites

Command-line installation and local builds require
[Node.js](https://nodejs.org/) (v22+) and the
[webOS CLI tools](https://webostv.developer.lge.com/develop/tools/cli-installation):

```bash
npm install -g @webos-tools/cli
```

Adding the repository directly in Homebrew Channel does not require these tools.

## Install on your TV

### Homebrew Channel

Install the community
[webOS Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel),
then open **Settings → Add repository** and enter:

```text
https://raw.githubusercontent.com/lennylxx/webos-iptv-player/main/homebrew-repository.json
```

To prefill the repository URL from a computer configured with `ares-cli`, run:

```bash
ares-launch --device tv org.webosbrew.hbchannel -p '{"launchMode":"addRepository","url":"https://raw.githubusercontent.com/lennylxx/webos-iptv-player/main/homebrew-repository.json"}'
```

Confirm **Add repository** on the TV. Homebrew Channel can then install the app
and detect updates from later GitHub releases.

### Developer Mode

1. **Download the app.** On your computer, open the
   [Releases page](https://github.com/lennylxx/webos-iptv-player/releases/latest)
   and download the latest `.ipk` file.

2. **Turn on Developer Mode on the TV.**
   - Create a free account at the [LG webOS Developer site](https://webostv.developer.lge.com/).
   - On the TV, open the **LG Content Store**, search for **Developer Mode**, then
     install and open it.
   - Sign in with your LG developer account and switch **Dev Mode Status** to **ON**.
     The TV restarts. Note the **IP address** and **passphrase** the app shows.

3. **Register your TV.** Add it as a device named `tv` (replace the IP with your TV's):

   ```bash
   ares-setup-device --add tv -i "username=prisoner" -i "host=127.0.0.1" -i "port=9922"
   ```

   Then fetch the device key, entering the **passphrase** from the Developer Mode app when prompted:

   ```bash
   ares-novacom --device tv --getkey
   ```

4. **Install the app.**

   ```bash
   ares-install --device tv ./com.lennylxx.iptv_<version>_all.ipk
   ```

## Development

### Setup

```bash
npm install
```

### Build

```bash
./build.sh
```

### Build & Install to TV

```bash
./build.sh --install [device-name]
```

If no device name is given, the default device from `ares-setup-device` is used.

### Debug on a TV

`scripts/tv.sh` reads the connection details for the default
`ares-setup-device` device, so keys and passphrases do not need to be copied
into commands.

```bash
scripts/tv.sh logs --app com.lennylxx.iptv       # Stream the app's DevTools console
scripts/tv.sh eval 'document.visibilityState'    # Evaluate JavaScript in the app page
scripts/tv.sh perf --duration 30                 # Sample CPU, heap, DOM, and layout
scripts/tv.sh diag                               # Capture a redacted diagnostics report
scripts/tv.sh run 'uname -a'                     # Run a TV command over SSH
scripts/tv.sh push ./file.txt /tmp/file.txt      # Copy a local file to the TV
scripts/tv.sh shell                              # Open an interactive SSH session
TV_DEVICE=tv2 scripts/tv.sh logs                 # Select a non-default configured TV
```

Run `scripts/tv.sh perf --help` or `scripts/tv.sh diag --help` for capture and
output options.

### Preview in Browser

```bash
npm run preview
```

Opens at http://localhost:3000. Video playback uses HLS.js, mpegts.js, and dash.js on desktop.

## Settings

Open with the **Blue** key or the **Settings** tab in the top bar. Sections:

- **Language** — follow the TV's system language when supported, or choose a language explicitly.
- **Device Setup** — scan the QR code to configure the app from a phone, or open the shown URL on a computer and enter the pairing code.
- **Xtream Accounts** — add, edit, remove, or temporarily disable accounts; check credentials, connection usage, and expiry; and choose TS, HLS, or Auto for live streams. The playlist and EPG are derived from the account credentials on Save.
- **Playlists** — add, edit, remove, or temporarily disable M3U URLs. Re-applied on Save.
- **Upload Playlist** — QR code + LAN URL on the left, list of currently uploaded playlists on the right. Scan the QR from a phone/laptop on the same network to upload `.m3u` files; they appear in this list within milliseconds via Luna push.
- **Channels** — check live-stream health; reorder, hide, rename, regroup, manually map entries to XMLTV channels, or correct one channel's EPG time; show hidden channels or reset customizations.
- **XMLTV URL** — set the program guide URL, also auto-detected from `x-tvg-url` in M3U playlists.
- **EPG time zone** — show guide times in the TV's **Device** time zone or the guide **Feed** time zone.
- **EPG time correction** — adjust each source independently in 15-minute steps.
- **Program reminders** — open the date-grouped Reminder Manager to review or remove upcoming reminders.
- **Appearance** — preview an app-wide color theme, choose Dark or Frosted player overlays, and adjust text from 80% to 150%.
- **Playback** — toggle auto-play (resume last watched channel on launch).
- **Online Subtitles** — choose a preferred subtitle language and configure SubDL, OpenSubtitles, and Assrt credentials for online search.
- **Data Management** — refresh data, clear caches or viewing lists, or reset the app.
- **Save Changes** applies preferences and reloads playlist and guide data when their sources change. **Cancel** discards edits.

## Remote Control Mapping

| Key | Player | Channel List | EPG |
|-----|--------|-------------|-----|
| Up/Down | Channel +/- | Navigate | Navigate within pane |
| Left | Open sidebar, then groups; seek −30s when available | Move toward groups | Previous pane or day |
| Right | Open menu; seek +30s when available | Move toward channels | Next pane, day, or Reminder Manager |
| OK/Enter | Toggle OSD; pause/resume; activate overlay | Select channel | Play channel/program or open Reminder Manager |
| Back | Back out of sidebar/menu; stop & return | Exit app (press twice) | Close guide |
| Red | Open EPG | Open EPG | — |
| Blue | Open settings | Open settings | Open settings |
| Yellow | Show OSD | Edit channel list | Search guide |
| Green | Toggle favorite (in sidebar/menu) | Toggle favorite (on focused channel) | Jump to today |
| Play/Pause | Pause/resume playback | — | — |
| Rewind/Fast-Forward | To oldest / Go to live (live DVR) | — | — |
| Ch +/- | Channel +/- | Previous/next channel | Jump 10 channels/programs |
| 0-9 | Direct channel entry | Direct channel entry | — |

Movies, Series, Search, Settings, and Reminder Manager use standard D-pad
navigation; **Back** returns to the previous view.

## Docs

Implementation deep-dives for contributors — the webOS-specific behavior behind
some of the features above:

- [`docs/native-vs-hls.js.md`](docs/native-vs-hls.js.md) — why on-device playback uses the native `<video>` pipeline (HDR & Dolby passthrough) instead of hls.js
- [`docs/audio-track-selection.md`](docs/audio-track-selection.md) — how audio-track switching works on the native webOS player
- [`docs/hls-subtitles.md`](docs/hls-subtitles.md) — how live HLS subtitles are handled on webOS (in-manifest types and their render paths)
- [`docs/mpeg-dash.md`](docs/mpeg-dash.md) — how DASH detection, native playback, subtitles, and live DVR work
- [`docs/vod-subtitles.md`](docs/vod-subtitles.md) — how VOD (Xtream movies & episodes) subtitles work: in-container tracks plus sidecar SRT/WebVTT/ASS, and online subtitle search (SubDL, OpenSubtitles, Assrt)
- [`docs/storage-and-data.md`](docs/storage-and-data.md) — what the app stores, where it lives, and how user data is separated from disposable caches
- [`docs/lan-service.md`](docs/lan-service.md) — phone setup and M3U uploads over the bundled LAN service
