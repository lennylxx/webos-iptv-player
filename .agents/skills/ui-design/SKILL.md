---
name: ui-design
description: Visual and interaction design for this app's 10-foot TV UI — type and spacing on the 1920×1080 canvas, D-pad focus design, theme tokens, motion on TV hardware, UI copy, and a review checklist. Use when building a new view, overlay, or component, restyling existing UI, or reviewing a UI change.
---

# UI design

The app is watched from a sofa, driven by a five-way remote, and rendered
by a weak TV SoC running Chromium 53. Design for that, not for a desktop
browser. **The existing UI is the style guide** — before inventing a
pattern, find the nearest existing one (Live preview, catalog rails,
Settings, player OSD) and match it.

## Direction

- **Restrained and content-first.** Video, artwork, and channel logos carry
  the color; chrome stays quiet, flat, and recedes behind content in every
  theme, light or dark. One accent per screen state, used for focus and
  the primary action — not decoration.
- **Premium means calm:** generous spacing, few type sizes, aligned edges.
  Spend boldness in one place per screen (the hero artwork, the live
  preview) and keep everything around it disciplined.
- **Structure carries information.** Borders, dividers, numbering, and
  labels must encode something (grouping, sequence, state); otherwise cut
  them. Prefer removing an element to styling it.
- **Glanceable.** Every screen answers "where am I, what is focused, what
  does OK do" within a second, from 10 feet.
- Don't import web trends that fight TV use: hover-only affordances, dense
  tables, thin hairline type, scroll-linked effects, or constant motion.

## Process

1. **Plan.** Name the nearest existing pattern, sketch the layout as an
   ASCII wireframe on the 1920×1080 canvas, and list the tokens, type
   sizes, focus order, and states you'll use.
2. **Check the plan against the app.** Anything that doesn't come from an
   existing screen must justify itself; revise it, or say why it's new.
3. **Build** with `morph()` + `html` and the conventions below.
4. **Critique from screenshots.** Capture it at 1920×1080 in Midnight and
   Daylight (`npm run preview` or a Playwright screenshot), with focus on
   each kind of target. Then remove one thing that isn't earning its
   place.

## Canvas, type, and spacing

- The canvas is a fixed **1920×1080 CSS px** (`index.html` viewport,
  `appinfo.json`). Lay out in px against it; there is no responsive layout.
- **Gutters:** views use an **80px** side gutter (`tab-bar.css`,
  `catalog-view.css`). Keep text and focus targets well inside the edge;
  only full-bleed video and artwork may reach it.
- **Type:** body is 24px/1.4 in the system/`LG Smart UI` stack — don't add
  web fonts. Common steps are 18, 20, 22, 24, 26, 28, 32, with a hero size
  around 56. **Nothing readable below 18px**; reserve 12–16px for badges
  and keycaps. Prefer weight and color (`--text-secondary`,
  `--text-muted`) over adding sizes.
- **Write plain `font-size: NNpx`.** The build wraps every px font size in
  `calc(... * var(--font-scale))` (`scripts/css-transforms.mjs`) so the
  Settings text-size option works. Hand-write `var(--font-scale)` only for
  *boxes* that must grow with text (a row height or label width); check the
  layout at text size 150.
- **Spacing:** use the 4px-based steps already in use — 8, 12, 16, 20, 24,
  then 40/60/80 for section and view spacing. Don't introduce odd values.
- **Targets:** list rows and buttons are at least ~42px tall, and roomier
  where they hold two lines. Truncate long untrusted names with ellipsis;
  never let them reflow a row.
- Use the `--radius` token (8px) for controls and cards; pills (`999px`)
  only for badges.

## D-pad focus

Focus is the cursor. If the user can't see it instantly, the screen is
broken.

- **Mechanics.** Mark targets `data-focusable`; group a region with
  `data-nav-container` so `SpatialNav` (`src/navigation/spatial-nav.ts`)
  moves geometrically within it and crosses regions predictably. Add
  `data-nav-enter="last-focused"` when re-entering a region should return
  to where the user left it (rails, lists, menus).
- **Styling.** Focus is the **`.focused` class**, not `:focus` or
  `:focus-visible` (Chromium 53, and the remote never moves DOM focus).
  The base ring lives in `css/navigation.css`: `--focus-ring` border plus an
  `--accent-glow` shadow. Extend it per component; don't reinvent it.
- **One unmistakable state.** Focus must differ from rest by more than one
  cue: border color plus glow, or a background change. A subtle color
  shift alone fails at distance. Selected/current/playing states use a
  *different* cue (an indicator, weight, or accent text) so they never
  read as focus.
- **Don't let focus move layout.** Change border color, not border width;
  reserve the border at rest (`2px solid transparent`). Scale only with
  `transform` (buttons use `scale(1.03)`); never on video or dense rows.
- **Nothing clips the ring.** Leave padding inside scroll containers (see
  `.catalog-rail-track`'s padding plus negative margin) so glow and scale
  aren't cut by `overflow`.
- **Predictable order.** Lay targets out on clear rows and columns so
  geometric navigation matches reading order. Every view needs a sensible
  initial focus, and Back returns focus to where the user came from.
- **Pointer parity.** The Magic Remote hovers and clicks the same targets;
  a hovered target becomes `.focused` via `nav:hover`. Self-activating
  components mark their root `data-self-activate` (see `AGENTS.md`).
- Every action reachable by pointer must be reachable by D-pad, and the
  color keys (`--remote-key-*`) are hints, never the only path.

## Color and tokens

- **Only use tokens** from `css/main.css` `:root`: `--bg-primary` →
  `--bg-secondary` → `--bg-tertiary` → `--bg-card` for elevation,
  `--text-primary/secondary/muted`, `--accent`/`--accent-dim`,
  `--danger`/`--success`/`--warning`, `--border`, `--focus-ring`.
- Every theme in `css/themes.css` — including the light **Daylight** theme
  — must look right. Hard-coded `#fff`/`#000` are acceptable only over
  video or artwork scrims.
- For alpha, use `rgb(var(--accent-rgb) / 0.2)`; the build converts it for
  Chromium 53. A new `--*-rgb` token must be added to `:root` *and every
  theme*.
- Text over video or artwork needs a scrim (see
  `--catalog-hero-scrim-rgb`), not a text shadow alone. Aim for at least
  4.5:1 contrast for body text against its real background.
- Status colors carry meaning (live = danger red, health dots); don't
  reuse them decoratively.

## Motion and performance

- Respect the user's **animation mode** (`src/services/motion-service.ts`,
  `html[data-animation="essential|reduced|full"]`, default `reduced`) and
  `prefers-reduced-motion`. Smooth scrolling is opt-in under `full`; any
  non-essential transition must be cut in `essential`.
- Motion answers the user — focus feedback, a panel opening, a confirmed
  action — and shows what changed. No decorative entrance animations, and
  no looping motion except true status (spinner, live dot).
- Animate **only `transform` and `opacity`** on anything large or frequent.
  Border/shadow/background transitions are fine on small focus targets
  (`--transition`, 0.2s); never animate width, height, top/left, or
  `filter` on large areas. Keep durations around 120–260ms.
- Avoid `backdrop-filter` and big blurred shadows over playing video unless
  there is an `@supports not` fallback; they're costly on TV GPUs. Keep the
  number of glows on screen small.
- Long lists are virtualized and re-rendered via `morph()` with stable
  `data-key`s; design states (focused, selected, playing) as classes, so a
  re-render keeps the node and its transition.

## Words on screen

- Name things as a viewer understands them ("Channels", "Guide"), not as
  the system is built ("playlist entries", "XMLTV").
- A button says what happens ("Add reminder", not "OK"), and the action
  keeps that name through the flow — the confirmation says "Reminder
  added".
- Errors say what happened and what to do next, plainly, without
  apologizing. An empty screen offers the next action (add a playlist,
  pick a group).
- Sentence case, short labels — they're read from across a room. No
  appended arrows or decorative symbols; use an inline SVG icon instead.

## Chromium 53 limits

Load the **`legacy-engine`** skill before editing CSS layout. In short:
no flex `gap` on webOS 4–6 (the build generates margins), no Grid on
webOS 4 (fallbacks in `css/legacy-webos-overrides.css`), never mix a
modern selector with a legacy one in a rule, and put every fallback under a
top-level `@supports not (...)`. Icons are **inline SVG** with
`currentColor` — uncommon Unicode symbols render as blank boxes on the TV
font.

## Review checklist

Run this before calling a UI change done; fix or justify every miss.

- [ ] Matches the nearest existing pattern; no new tokens, sizes, or radii
      without reason; one focal point per screen.
- [ ] Readable at 10 feet: no readable text below 18px, holds at text
      size 80 and 150 without clipping or overlap.
- [ ] Focus is instantly visible, uses `.focused` and the shared ring,
      isn't clipped, and doesn't shift layout.
- [ ] Focus order follows the visual grid; initial focus and Back are
      sensible; containers use `data-nav-enter` where re-entry matters.
- [ ] Focused and selected/playing states are distinguishable.
- [ ] Works with D-pad alone and with the Magic Remote pointer.
- [ ] Looks right in every theme, including Daylight; text over imagery
      has a scrim.
- [ ] Motion honors `essential`/`reduced`/`full`; only cheap properties
      animate.
- [ ] Labels, errors, and empty states follow "Words on screen".
- [ ] Untrusted names go through `html`, truncate, and never break layout.
- [ ] `npm run lint` passes, and the change is checked in the
      `chromium-53-simulation` E2E project (and on a TV for anything
      visual that the simulation can't judge — see `webos-device`).
