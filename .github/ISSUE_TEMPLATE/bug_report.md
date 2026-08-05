---
name: Bug report
about: Report a playback or app problem
title: "[Bug] "
labels: ""
assignees: ""
---

## Problem

Describe what happened and what you expected.

Add a screenshot if it helps explain the problem. Hide private information
before uploading it.

## Steps to reproduce

1.
2.
3.

## Environment

- App version:
- TV model:
- webOS version:
- Playlist type: M3U / Xtream

## Diagnostics

Attach a redacted report if possible:

```bash
scripts/tv.sh diag --attach --duration 15 --output tv-diag.json
```

Review the report before uploading it. Do not use `--full`.

If you are comfortable sharing, attach a minimal playlist that reproduces the
problem. Remove credentials, tokens, and private content first.
