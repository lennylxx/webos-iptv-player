---
name: webos-device
description: Install, run, and debug the app on a real LG webOS TV — packaging, cold restart, console logs, and live page evaluation over CDP. Use when deploying to a TV or investigating behavior that only reproduces on the device.
---

# webOS device

## Build and install

```bash
./build.sh                     # package the IPK (needs ares-package from @webos-tools/cli)
./build.sh --install [device]  # build + ares-install + cold-restart on a TV
```

**Install needs a cold restart.** webOS keeps the old instance suspended
through an in-place upgrade, and a plain relaunch resumes the stale
in-memory copy. `build.sh --install` closes the app, then cold-starts it to
load the new bundle. If you install another way, close and relaunch it.

## Debug

`scripts/tv.sh` wraps the device access that the `tv` CLI profile blocks:

| Command | Use |
| --- | --- |
| `tv.sh logs [--app <id>]` | Tail the app's DevTools console headlessly over CDP. |
| `tv.sh eval [--app <id>] '<js>'` | Evaluate JS in the app page (also `--file <path.js>`, or `-` for stdin) to probe live DOM or app state. |
| `tv.sh perf [--app <id>]` | CDP perf counters, recordings, GC, and heap snapshots. |
| `tv.sh diag [--app <id>]` | Cold-start redacted diagnostics report. |
| `tv.sh capt` | Screenshot or record the TV display. |
| `tv.sh run '<cmd>'` | Run a shell command on the TV over ssh. |
| `tv.sh push <local> <remote>` / `pull <remote> <local>` | Copy files to or from the TV (`ares-push` is disabled in the `tv` profile). |
| `tv.sh shell` | Interactive shell (`ares-shell` is disabled in the `tv` profile). |
| `tv.sh reboot` | Reboot the TV through Luna. |

Pick a non-default device with `TV_DEVICE=<name>`; override the expect
timeout with `TV_TIMEOUT=<seconds>` (default 120). `perf`, `diag`, and
`capt` print their full options with `--help`.

Notes:

- `ares-inspect` exposes a page-level CDP socket only. Playwright
  `connectOverCDP` fails; connect to the page WebSocket directly.
- App `console.*` output appears only in the DevTools that `ares-inspect`
  opens (or through `tv.sh logs`). `ares-monitor-log` is not in the current
  CLI.
- Logs come from `createLogger('Tag')`, so filter on the `[Tag]` prefix.

## When the device is required

The desktop preview and the Chromium 53 simulation cannot reproduce
engine-level layout, V8 behavior, native media pipelines (audio and subtitle
track switching, DASH), Luna services, or Activity Manager callbacks. Verify
those on a TV before calling the change done.
