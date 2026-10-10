# bundled-service — AGENTS.md

Scoped to `bundled-service/`; the root `AGENTS.md` still applies.

A sandbox-separate Node (CommonJS) webOS service,
`com.lennylxx.iptv.service`. It hosts LAN phone setup and M3U uploads and,
in Developer Mode, interactive program-reminder alerts. `src/index.ts` wires
`lan/`, `setup/`, and `reminder/`.

**Read `docs/lan-service.md` before changing it.**

## Runtime: Node.js 0.12.2

It must run on webOS 4's Node.js 0.12.2:

- compile to ES5/CommonJS;
- route newer Node APIs through `compat.ts`;
- the final JavaScript build is gated, like the app bundle.

## Contract with the app

- **Luna:** `start` / `stop` / `heartbeat` / `serviceEvents` for LAN
  changes; `getDevMode` / `fireReminderAlert` for reminders.
- **HTTP:** phone setup pages and uploads.
- Changes are pushed through `serviceEvents`; nothing polls.
- The lifecycle follows the app's `visibilitychange`.

Keep both sides aligned with `src/services/setup-client.ts` and
`src/services/upload-client.ts` in the app, and update their colocated tests
with any messaging change.

## Reminder alerts

`com.webos.notification/createAlert` (with buttons) is denied to every
identity the app or service can present; the block is identity-based in the
notification daemon, not an `appinfo.json`/ACG gap. Passive `createToast`
works. Only `/usr/bin/luna-send-pub` (Luna role `type:"devmode"`) may raise
`createAlert`, and only while Developer Mode is on, so the service execs it
through `child_process` for the dev-mode alert; retail falls back to a toast
plus an in-app prompt.

Reminders are scheduled through the Activity Manager
(`com.webos.service.activitymanager` `create` with a `callback` and
`schedule.start`, `local: true`), which fires at air time **even with the
app closed**. The dev callback targets the service's `fireReminderAlert`;
the retail callback targets `createToast`.

## Verify

```bash
npm run service:smoke          # build + gate + real Node.js 0.12.2 smoke
npm run service:smoke:matrix   # webOS 4-26 representative runtimes
```

`service:smoke` downloads the official Node.js 0.12.2 archive, verifies its
published SHA-256, caches it under the user cache directory, then parses and
exercises the compiled service with that exact runtime. CI runs the matrix
across Node.js 0.12.2, 8.12.0, 12.21.0, 16.19.1, and 20.12.2 (webOS 4
through 26). On Apple Silicon, Node 16/20 run as arm64 and older releases as
x64 through Rosetta.
