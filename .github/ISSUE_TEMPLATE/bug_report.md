---
name: Bug report
about: Report a playback or app problem
title: "[Bug] "
labels: ""
assignees: ""
---

<!--
Title: symptom + where it happens, e.g.
"[Bug] Black screen on HLS channel after 10s".
One problem per issue. Describe what you observed, not what you think
the cause is. Keep it short and specific.
-->

- [ ] I searched existing issues and I am on the latest release.
- [ ] I checked the README and `docs/`.
- [ ] I attached a `tv-diag.json` report (see **Diagnostics** below).

## Environment

- App version:
- TV model:
- webOS version:
- Playlist type: M3U / Xtream

## Expected result

What you thought the app would do.

## Actual result

What it did instead. Quote on-screen errors verbatim; a screenshot helps (hide private information).

- Frequency: always / sometimes (how many tries)
- Affects: one channel / one group / all channels / VOD only
- Last working version:

## Steps to reproduce (from a cold start)

1.
2.
3.

## Diagnostics (required)

Reproduce the bug while this runs, then attach `tv-diag.json`. Issues without it are likely to be closed as not actionable.

```bash
scripts/tv.sh diag --attach --duration 15 --output tv-diag.json
```

The report is redacted by default; review it before uploading and do **not** use `--full`.

## What you tried

What you already tried, and — if you are asking for different behavior — what you are ultimately trying to accomplish.

## The failing entry (optional)

Only if it is relevant — remove credentials, tokens and private content first.

For a wrong group, name, EPG match or catchup: the single `#EXTINF` line.

```
#EXTINF:-1 tvg-id="ch1" group-title="Group A",Channel 1
http://host/a.m3u8
```

For playback problems the stream URL rarely helps us (it needs your credentials), but its manifest does, paste the output of below command:

```bash
curl -s "<stream url>" | head -40
```

## After it is resolved

Please post one line saying what fixed it — including if you worked it out yourself — and close the issue.

The next person hits this bug through search, and silence leaves them nothing.
