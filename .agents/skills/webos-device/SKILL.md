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
| `tv.sh logs` | Tail the app's DevTools console; `--service` tails the bundled service's log file over ssh. |
| `tv.sh eval '<js>'` | Probe live DOM or app state. |
| `tv.sh perf` | Performance counters and profiles. |
| `tv.sh diag` | Diagnostics report. |
| `tv.sh capt` | Screenshot or recording. |
| `tv.sh input` | Remote keys, pointer, wheel, and wake. |
| `tv.sh run '<cmd>'` | Run a shell command on the TV over ssh. |
| `tv.sh push <local> <remote>` / `pull <remote> <local>` | Copy files to or from the TV (`ares-push` is disabled in the `tv` profile). |
| `tv.sh shell` | Interactive shell (`ares-shell` is disabled in the `tv` profile). |
| `tv.sh reboot` | Reboot the TV through Luna. |

Pick a non-default device with `TV_DEVICE=<name>`; override the expect
timeout with `TV_TIMEOUT=<seconds>` (default 120; `0` lets a `run` command
go unbounded while sign-in still times out). `logs`, `eval`, `perf`,
`diag`, `capt`, and `input` print their full options with `-h` or
`--help`.

Notes:

- `ares-inspect` exposes a page-level CDP socket only. Playwright
  `connectOverCDP` fails; connect to the page WebSocket directly.
- App `console.*` output appears only in the DevTools that `ares-inspect`
  opens (or through `tv.sh logs`). `ares-monitor-log` is not in the current
  CLI.
- Logs come from `createLogger('Tag')`, so filter on the `[Tag]` prefix.
- `tv.sh input` writes Linux input events into the TV's own remote devices,
  so webOS shows and hides the cursor, scrolls natively, and sends keydown
  1536/1537 (cursor shown/hidden) exactly as with a real remote. Synthetic
  CDP or DOM events skip all of that.
- To reach a screen fast when the test isn't about remote input, use
  `tv.sh input tap <selector> | key=<data-key> | text=<text>`. It scrolls
  the element into view and clicks its center over CDP in one call, with
  no pointer travel. It records where the press and click landed and
  fails, naming the row it hit, if the target moved; add `--settle` when
  a list may still be scrolling (a busy preview slows its smooth scroll).
  Add `--wait '<js>'` to any action to poll a page expression until it is
  truthy and print it, or `--wait-log '<regex>'` to print the first
  console line the action caused, so one call both acts and confirms
  instead of a screenshot per step. `key --cdp --gap 0` sends a
  key burst the same way. Guard a key that must land in an open menu with
  `--if '<js>'`, which sends nothing unless the expression is truthy, so
  an auto-hidden menu can't turn `down` into a channel change. Chain
  steps over one connection with `tv.sh input do '<step>'...`; a step's
  `--if` and `--settle` go inside its quotes. Use the
  evdev default when you're testing remote, cursor, or scrolling
  behavior.
- Never inject `KEY_EXIT` (evdev 174): webOS closes the app.
- `tv.sh input key power` turns the TV off and `tv.sh input wake` turns
  it back on. Use them only when the user asks.
- `tv.sh input key home` opens webOS Home and sends the app to the
  background; use it to test suspend and resume.

## When the device is required

The desktop preview and the Chromium 53 simulation cannot reproduce
engine-level layout, V8 behavior, native media pipelines (audio and subtitle
track switching, DASH), Luna services, or Activity Manager callbacks. Verify
those on a TV before calling the change done.
