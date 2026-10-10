---
name: commit
description: Stage and commit changes in this repo — full test suites first, an exact message approved by the user, no trailers, 72-column lines. Use whenever the user asks to commit.
---

# Commit

Only commit or push when the user asks. Commit **directly to `main`** — no
feature branch, no PR.

## 1. Run both full suites

Against the final changes, run:

```bash
npm test
npm run test:e2e
```

Targeted runs while iterating never replace these. Do not commit unless both
pass after the last code change. If either fails, fix it (or report it) and
rerun.

## 2. Stage

Stage only what belongs to the change; leave unrelated local edits alone.
**Never run `git add` and `git commit` in the same command** — staging and
committing are separate, user-visible steps.

## 3. Write the message

- **Every line is at most 72 characters** — subject, body, and bullets.
  Measure it; 72 is a hard limit, not an approximation.
- Length is proportional: a small or mechanical change gets one tight
  subject line. A real feature gets an imperative subject, a blank line,
  then a body covering the key behaviors and the *why*, with bullets for
  supporting changes.
- **No trailers of any kind**: no `Co-Authored-By`, no `Copilot-Session`,
  no tool or agent attribution, even if the runtime adds one by default.
  The body ends with its last content line.

## 4. Get approval, then commit

Show the exact message as a heredoc and wait for explicit approval:

```bash
git commit -F - <<'EOF'
Subject

Body
EOF
```

Do not run `git commit` until the user approves that exact message. If they
edit it, show the revised version again.

## Media for README or GitHub

Upload with `gh image --repo lennylxx/webos-iptv-player -- <files>`; it
prints ready-to-use Markdown attachment URLs.
