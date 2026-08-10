# webOS IPTV Player

An IPTV player for LG webOS TVs. Supports M3U playlists, Xtream Codes accounts, XMLTV program guides, and catch-up/timeshift playback.

![icon](assets/icon.svg)

## Screenshots

| Channel list | Recently watched |
| --- | --- |
| ![Channel list](https://github.com/user-attachments/assets/99dfb28e-0f47-461c-92d6-70c9fb285b7b) | ![Recently watched](https://github.com/user-attachments/assets/d28e6147-03c8-402e-b697-70ac524dc1d9) |

| Program guide | Catch-up resume |
| --- | --- |
| ![Program guide](https://github.com/user-attachments/assets/b5a3c75b-bfc4-4413-aa41-ed981c657130) | ![Catch-up resume](https://github.com/user-attachments/assets/a55843ab-723a-4ef1-9add-491d694fd215) |

| Channel info | Playback overlays |
| --- | --- |
| ![Channel info](https://github.com/user-attachments/assets/87744996-4e94-45fe-b3ba-103ff7b2ddb9) | ![Playback overlays](https://github.com/user-attachments/assets/b1734ae5-637e-4759-ae88-227d832294e4) |

| Subtitles | Subtitle search |
| --- | --- |
| ![Subtitles](https://github.com/user-attachments/assets/5d1fab57-1087-414b-9a20-f900589eac4a) | ![Subtitle search](https://github.com/user-attachments/assets/4ef9c97e-131b-4e4f-bf9a-c753d66f2956) |

| Movies | Movie detail |
| --- | --- |
| ![Movies](https://github.com/user-attachments/assets/a6b09baf-0342-4e02-9d7e-5cf7677d1ecf) | ![Movie detail](https://github.com/user-attachments/assets/820d768b-0ed2-42fa-b2bc-5caee70d4a1c) |

| Series detail | Search |
| --- | --- |
| ![Series detail](https://github.com/user-attachments/assets/05810327-7066-4202-94d0-7cb08e87168e) | ![Search](https://github.com/user-attachments/assets/008383a1-64c5-49f9-8cc6-877a0ebbae08) |

| Settings | Theme picker |
| --- | --- |
| ![Settings](https://github.com/user-attachments/assets/a50a7179-07c7-4d92-821f-d16aa544f7f9) | ![Theme picker](https://github.com/user-attachments/assets/48eb438f-3b61-4508-80fe-0775ab729027) |

## Features

**Playlists & accounts**

- **M3U playlists** — load multiple M3U/M3U8 lists, auto-deduplicated
- **Xtream Codes accounts** — add one or more accounts; the playlist and EPG are derived from your credentials, and you switch between them from the top-bar avatar
- **LAN setup** — configure sources or upload `.m3u` files from a phone on the same network by scanning a QR code ([LAN service](docs/lan-service.md))

**Live TV & on-demand**

- **Program guide (EPG)** — three-pane guide with an auto-derived date range, cached for instant reopen
- **Reminders** — flag an upcoming program and get notified at air time, even with the app closed, to tune straight in
- **Recently Watched** — return to recent live channels or resume partially watched catch-up programs
- **Movies & Series** — browse an Xtream account's VOD catalogs, with Continue Watching and account-scoped Watchlist rails
- **Automatic VOD queues** — continue through series episodes or remaining Watchlist movies, removing completed titles from the Watchlist
- **Catch-up & Live DVR** — replay past programs, and pause / rewind / return to the live edge on live streams

**Playback**

- **Native HDR & Dolby passthrough** — the stream goes straight to the TV's decoder, so HDR10, HLG, Dolby Vision®, and Dolby Atmos® pass through untouched — **[Why native instead of hls.js? See the on-device comparison](docs/native-vs-hls.js.md)**
- **Audio & subtitle tracks** — pick from the player menu, remembered per channel or VOD item; subtitles cover in-manifest WebVTT (live), in-container / sidecar SRT/WebVTT/ASS (VOD), and online search (SubDL, OpenSubtitles, and Assrt) — with a manual title box to refine the query — when no bundled subtitle fits; adjust the subtitle offset live when captions are out of sync
- **On-screen display** — program title, progress, and a live stream-info readout (resolution, HDR, frame rate, codec, audio channels)
- **Resync A/V** (🔄) — one tap on the playback bar re-locks audio and video that drift apart during a long catch-up or on-demand stream

**Navigation**

- **Search** — across channels, EPG programs, movies, and series, with direct live, catch-up, and reminder actions
- **Channel sidebar** — switch channels over the video with current-program info, organized by group
- **Channel customization** — reorder, hide, rename, regroup, and manage favorites
- **Auto-play and genre group icons** for faster browsing
- **Full remote & Magic Remote** — spatial D-pad navigation and pointer control across every view
- **Color themes** — choose from light and dark app-wide themes with live previews, plus Dark or Frosted player overlays; selections persist across launches
- **Adjustable text size** — scale text from 80%–150% without resizing controls
- **Multilingual interface** — available in English, Deutsch, Español, Français, Italiano, Português (Brasil), Русский, Українська, and 简体中文; follows the TV language by default or can be selected explicitly in Settings

**Development**

- **Desktop preview** — browser-based playback via HLS.js and mpegts.js

## Supported webOS versions

The app runs on **webOS 5.0 (2020) and newer**. Its baseline is the Chromium 68
engine on webOS 5; every later release ships a newer Chromium, so the app is
forward-compatible. Features only newer engines support natively (flex `gap`,
`backdrop-filter`, …) get feature-detected fallbacks on the older ones.

| webOS version | Released | Chromium engine | Supported |
| --- | --- | --- | --- |
| webOS 5.0 | 2020 | 68 | ✅ (minimum) |
| webOS 6.0 | 2021 | 79 | ✅ |
| webOS 22 | 2022 | 87 | ✅ |
| webOS 23 | 2023 | 94 | ✅ |
| webOS 24 | 2024 | 108 | ✅ |
| webOS 25 | 2025 | 120 | ✅ |
| webOS 26 | 2026 | 132 | ✅ |

webOS 4.x and older (Chromium 53 and earlier) lack JavaScript and CSS features
the app relies on, and are not supported.

## Prerequisites

Command-line installation and local builds require
[Node.js](https://nodejs.org/) (v18+) and the
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

### Preview in Browser

```bash
npm run preview
```

Opens at http://localhost:3000. Video playback uses HLS.js/mpegts.js on desktop since browsers lack native TS/HLS support.

## Settings

Open with the **Blue** key or the **Settings** tab in the top bar. Sections:

- **Language** — follow the TV's system language when supported, or choose a language explicitly.
- **Xtream Account** — add, edit, or remove Xtream Codes accounts (portal URL + username + password). The playlist and EPG are derived from your credentials on Save.
- **Playlists** — add, edit, or remove M3U URLs. Re-applied on Save.
- **Upload Playlist** — QR code + LAN URL on the left, list of currently uploaded playlists on the right. Scan the QR from a phone/laptop on the same network to upload `.m3u` files; they appear in this list within milliseconds via Luna push.
- **Channels** — reorder, hide, rename, or regroup entries; show hidden channels or reset customizations.
- **Program Guide** — set the XMLTV URL (also auto-detected from `x-tvg-url` in M3U) and show times in the TV's **Device** time zone or the guide **Feed** time zone.
- **Appearance** — preview an app-wide color theme, choose Dark or Frosted player overlays, and adjust text from 80% to 150%.
- **Playback** — toggle auto-play (resume last watched channel on launch).
- **Online Subtitles** — choose a preferred subtitle language and configure SubDL, OpenSubtitles, and Assrt credentials for online search.
- **Data Management** — refresh data, clear caches or viewing lists, or reset the app.
- **Save & Apply** reloads channels from the new sources. **Cancel** discards edits.

## Remote Control Mapping

| Key | Player | Channel List | EPG |
|-----|--------|-------------|-----|
| Up/Down | Channel +/- | Navigate | Navigate within pane |
| Left | Open sidebar, then groups; seek −30s when available | — | Back to channels; previous day |
| Right | Open menu; seek +30s when available | — | To programs; next day |
| OK/Enter | Toggle OSD; pause/resume; activate overlay | Select channel | Play channel / program (catch-up if past) |
| Back | Back out of sidebar/menu; stop & return | Exit app (press twice) | Close guide |
| Red | Open EPG | Open EPG | — |
| Blue | Open settings | Open settings | Close guide |
| Yellow | Show OSD | Edit channel list | — |
| Green | Toggle favorite (in sidebar/menu) | Toggle favorite (on focused channel) | Jump to today |
| Play/Pause | Pause/resume (live DVR) | — | — |
| Rewind/Fast-Forward | To oldest / Go to live (live DVR) | — | — |
| Ch +/- | Channel +/- | Page up/down | Jump 10 channels |
| 0-9 | Direct channel entry | Direct channel entry | — |

## Docs

Implementation deep-dives for contributors — the webOS-specific behavior behind
some of the features above:

- [`docs/native-vs-hls.js.md`](docs/native-vs-hls.js.md) — why on-device playback uses the native `<video>` pipeline (HDR & Dolby passthrough) instead of hls.js
- [`docs/audio-track-selection.md`](docs/audio-track-selection.md) — how audio-track switching works on the native webOS player
- [`docs/hls-subtitles.md`](docs/hls-subtitles.md) — how live HLS subtitles are handled on webOS (in-manifest types and their render paths)
- [`docs/vod-subtitles.md`](docs/vod-subtitles.md) — how VOD (Xtream movies & episodes) subtitles work: in-container tracks plus sidecar SRT/WebVTT/ASS, and online subtitle search (SubDL, OpenSubtitles, Assrt)
- [`docs/storage-and-data.md`](docs/storage-and-data.md) — what the app stores, where it lives, and how user data is separated from disposable caches
- [`docs/lan-service.md`](docs/lan-service.md) — phone setup and M3U uploads over the bundled LAN service
