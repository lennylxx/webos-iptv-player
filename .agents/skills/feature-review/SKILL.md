---
name: feature-review
description: Review a finished feature with a fresh-context subagent, rank the findings, let the user pick fixes, and offer one more round. Use automatically once a feature is implemented and its tests pass, or when the user asks for a review.
---

# Feature review

Run this without being asked as soon as a feature is implemented and its
tests pass.

## 1. Delegate the review

Run the review in a separate reviewer subagent with a fresh context, so it
judges the code rather than the conversation:

- Copilot CLI: the `rubber-duck` agent.
- Claude Code: a Task subagent or `/code-review`.
- Codex CLI: `/review`.

Give it everything it needs, since it shares none of your context:

- the feature's goal and the user-visible behavior it should have;
- the spec or design doc, if one exists (often under `docs/`);
- the changed files (`git status`, `git diff`), including new tests;
- the project constraints that matter here: webOS 4 / Chromium 53, remote
  and Magic Remote input, `morph()` rendering, XSS-safe `html` templates.

Ask for bugs, logic errors, missed states, and UX problems, not style nits.

## 2. Rank and present

Order the findings by priority:

1. bugs and correctness;
2. UX: confusing behavior, focus or remote-control traps, unclear copy;
3. polish.

Give each one a concrete suggested fix. Drop findings you verified are
wrong, and say so briefly.

## 3. Let the user choose

Present the findings as a multi-select (`ask_user` in Copilot CLI, or the
equivalent prompt), defaulting to the bugs. Fix only what the user picks.

Every bug fixed here gets a regression test that fails without the fix and
passes with it.

## 4. Offer one more round

After the chosen fixes pass their tests, ask once whether to review again.
Start another round only if the user says yes.
