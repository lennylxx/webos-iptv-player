---
name: ui-design
description: Visual and interaction design for this app's 10-foot TV UI — type and spacing on the 1920×1080 canvas, D-pad focus design, theme and overlay tokens, consistency, motion on TV hardware, UI copy, screenshot verification, and a review checklist. Use when building a new view, overlay, or component, restyling existing UI, or reviewing a UI change.
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
- **Simple first; don't design like a programmer.** Show what a viewer
  needs right now — what's on, how long is left, what's next, what OK
  does. Leave detail to the Guide and technical state to logs. A small
  panel must not grow into a control panel.
- **Premium means calm:** generous spacing, few type sizes, aligned edges.
  Spend boldness in one place per screen (the hero artwork, the live
  preview) and keep everything around it disciplined.
- **Structure carries information.** Borders, dividers, numbering, and
  labels must encode something (grouping, sequence, state); otherwise cut
  them. Prefer removing an element to styling it.
- **No duplicate affordances.** If the legend says what a key does, drop
  the tooltip; Back closes a panel, so it needs no close button; use an
  icon alone when it is unambiguous (move up/down).
- **Redesign surgically.** Respect the current layout and change only the
  part that is wrong; don't rebuild a screen to fix one region.
- **Glanceable.** Every screen answers "where am I, what is focused, what
  does OK do" within a second, from 10 feet.
- Don't import web trends that fight TV use: hover-only affordances, dense
  tables, thin hairline type, or scroll-linked effects.

## Process

1. **Plan.** Name the nearest existing pattern, sketch the layout as an
   ASCII wireframe on the 1920×1080 canvas, and list the tokens, type
   sizes, focus order, and states you'll use. For a substantial redesign,
   show a mockup screenshot in the app's own visual language and iterate
   before wiring it up.
2. **Check the plan against the app.** Compare explicitly: tokens, radii,
   control classes, focus treatment, overlay tokens. Anything that doesn't
   come from an existing screen must justify itself; revise it, or say why
   it's new.
3. **Build** with `morph()` + `html` and the conventions below.
4. **Verify from screenshots yourself** before reporting done (see
   "Screenshots and verification"), then remove one thing that isn't
   earning its place.

## Consistency

- **One meaning, one look.** A toggle, segmented control, selected chip,
  number badge, list highlight, or bottom bar must reuse the existing
  component's classes — never a look-alike. Examples: on/off and small
  choices use the Settings segmented `.toggle-group`/`.toggle-option`;
  an enable switch uses `.source-toggle`; a selected chip uses the
  primary-button state (`--accent-dim` fill, `--accent` border, white
  text).
- **Element ids are unique app-wide.** A reused id (for example a Settings
  control sharing a panel's id) silently pulls in the other component's
  CSS.
- **Accent-filled controls use white text in every theme**, light ones
  included.
- **Heights match within a row.** A button beside an input matches the
  input's height; Settings action buttons are 54px; every bottom legend
  bar (`.edit-hints` and its kin) is 64px so lists don't jump when the
  bar changes.
- **Icons and labels share one midline.** Use a shared control-row height
  and measure the boxes; if the numbers match and it still looks off, say
  so rather than guess.
- **Sibling overlays copy the reference overlay's controls** (a Reset row
  in one overlay is styled like the matching row in its sibling).
- **Disabled states look the same everywhere** (same opacity and color for
  a disabled arrow in Settings and in LAN setup).

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
  `--text-muted`) over adding sizes, and keep weights moderate — 700 reads
  heavy on the TV font; check computed fonts on the device.
- **Write plain `font-size: NNpx`.** The build wraps every px font size in
  `calc(... * var(--font-scale))` (`scripts/css-transforms.mjs`) so the
  Settings text-size option works. Hand-write `var(--font-scale)` only for
  *boxes* that must grow with text (a row height or label width); check the
  layout at text size 150.
- **Spacing:** use the 4px-based steps already in use — 8, 12, 16, 20, 24,
  then 40/60/80 for section and view spacing. Keep related columns tight
  (size a time column to its content) and give separate control groups
  breathing room.
- **Targets:** list rows and buttons are at least ~42px tall, and roomier
  where they hold two lines. Truncate long untrusted names with ellipsis;
  never let them reflow a row.
- **Every language fits.** Labels are translated into many languages, some
  ~40% longer than English. Size buttons and segmented controls so the
  longest translation fits at text size 150, or let them wrap by design —
  never clip or overflow.
- **Shapes:** `--radius` (8px) for controls, cards, and embedded video (the
  same radius as its focus ring); circles for numeric order badges and the
  account avatar; pills (`999px`) for status badges.

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
  `--accent-glow` shadow. Extend it per component; don't reinvent it, and
  match the focus color and shape used elsewhere.
- **One ring, on the visual target.** A card frames its poster, not poster
  plus caption, with no gap between ring and image; override the global
  ring so two rings never stack. Underline-style targets (tabs) suppress
  the global box, and text inputs get no extra accent ring.
- **Quieter row focus when the row holds its own controls**: a faint tint
  plus a 3px left accent bar instead of a full border.
- **One unmistakable state.** Focus must differ from rest by more than one
  cue: border color plus glow, or a background change. A subtle color
  shift alone fails at distance.
- **Selection is separate from focus.** The current item (active group,
  playing channel) keeps its own highlight after focus or the pointer
  leaves, uses a *different* cue (indicator, weight, accent text), and
  never reads as focus. Color-key actions target the selection, and no
  displayed state (such as a "mixed" badge) may depend on focus.
- **Don't let focus move layout.** Change border color, not border width;
  reserve the border at rest (`2px solid transparent`). Scale only with
  `transform` (buttons use `scale(1.03)`); never on video or dense rows.
- **Nothing clips the ring.** Every scroll container with focusable rows
  needs a gutter (see `.catalog-rail-track`'s padding plus negative
  margin) so glow and scale aren't cut by `overflow`.
- **Predictable order.** Lay targets out on clear rows and columns so
  geometric navigation matches reading order. Every view needs a sensible
  initial focus, and Back returns focus to where the user came from.
- Every action reachable by pointer must be reachable by D-pad, and the
  color keys (`--remote-key-*`) are hints, never the only path.

## Magic Remote pointer

- A hovered target becomes `.focused` immediately via `nav:hover`, and
  pointer leave clears the highlight — don't wait for another target.
- **Hover previews revert at once on leave**, to the currently *selected*
  value, not the saved one (theme swatches).
- Hover never changes the legend bar, and D-pad-only hints (such as
  "‹ Channel list") never appear on hover.
- After a reorder or re-render under the cursor, ignore hover until the
  pointer actually moves, so the moved item doesn't flash.
- Self-activating components mark their root `data-self-activate` (see
  `AGENTS.md`).

## Color and tokens

- **Only use tokens** from `css/main.css` `:root`: `--bg-primary` →
  `--bg-secondary` → `--bg-tertiary` → `--bg-card` for elevation,
  `--text-primary/secondary/muted`, `--accent`/`--accent-dim`,
  `--danger`/`--success`/`--warning`, `--border`, `--focus-ring`,
  `--scrollbar-thumb`.
- Every theme in `css/themes.css` must look right — there are three light
  ones (Daylight, Pastel Latte, Paper Light) besides the dark ones.
- **Scrims and gradients come from the theme** (`--catalog-hero-scrim-rgb`
  is light on light themes); never a fixed dark gradient. Text over video
  or artwork needs a scrim, not a text shadow alone. Aim for at least
  4.5:1 contrast for body text against its real background.
- **Hard-coded `#fff`/`#000` only** for bare controls drawn directly on
  video and for solid status badges — never inside a themed or overlay
  panel.
- For alpha, use `rgb(var(--accent-rgb) / 0.2)`; the build converts it for
  Chromium 53. A new `--*-rgb` token must be added to `:root` *and every
  theme*.
- Status colors carry meaning (live = danger red, health dots); don't
  reuse them decoratively.

## Overlays and glass styles

Player overlays (OSD, sidebar, menu, subtitle panels, number entry, live
preview message) follow the user's **Player overlay** style, Dark or
Frosted, not the theme (`css/player.css`).

- Text, icons, dividers, and chips inside an overlay take color only from
  the overlay-scoped tokens — `--text-*`, `--overlay-divider`,
  `--overlay-chip` — which `[data-overlay="frosted"]` redefines. Never
  hard-code white inside a panel: it vanishes on Frosted.
- **A new overlay root joins both selector lists** in `css/player.css`
  (the dark base and the `[data-overlay="frosted"]` block).
- Controls drawn directly on video, outside any panel, use fixed white
  icons with a shadow and no panel background; their focus is light glass
  (`rgba(255, 255, 255, .16)`) plus the shared ring, not a dark block.
- Overlays share one language: translucent panel, `var(--radius)`, the
  accent ring.

## Motion and performance

Everyone likes animation; old TVs just can't afford all of it. The
**animation mode** (`src/services/motion-service.ts`,
`html[data-animation="essential|reduced|full"]`, default `reduced`) is a
performance setting, not a no-animation preference.

- Gate only animations with a measured cost: smooth scrolling (opt-in
  under `full`), layout-driven transitions (width, padding, `max-height`,
  scrollbar position). Cheap status loops — live pulse, playing pulse,
  marquee, spinner — stay in every mode, and also honor
  `prefers-reduced-motion`.
- Motion answers the user — focus feedback, a panel opening, a confirmed
  action — and shows what changed. No decorative entrance animations.
- **Close mirrors open**: same transition and path in reverse, from every
  view (reset inline state when the view changes).
- Animate **only `transform` and `opacity`** on anything large or frequent.
  Border/shadow/background transitions are fine on small focus targets
  (`--transition`, 0.2s). Keep durations around 120–260ms.
- If a transition drops frames on the TV, delete it and leave a one-line
  comment saying why.
- `backdrop-filter` belongs only to overlay glass and needs an
  `@supports not` fallback; keep big blurred shadows and glows few.
- Long lists are virtualized and re-rendered via `morph()` with stable
  `data-key`s; design states (focused, selected, playing) as classes, so a
  re-render keeps the node and its transition.

## Words on screen

Load the **`ui-copy`** skill for any new or changed string: it owns the
glossary-first process, terminology, and translation rules.

- Name things as a viewer understands them ("Channels", "Guide"), not as
  the system is built ("playlist entries", "XMLTV").
- A button says what happens ("Add reminder", not "OK"), and the action
  keeps that name through the flow — the confirmation says "Reminder
  added".
- **Reuse existing strings and terms.** Prefer an existing i18n key
  (`common.loading`, …) over a new one; keep one term per concept in
  every language, phrased idiomatically, and name Settings labels after
  the established feature name.
- Errors say what happened and what to do next, plainly, without
  apologizing. An empty screen offers the next action (add a playlist,
  pick a group).
- Sentence case, short labels — they're read from across a room. No
  appended arrows or decorative symbols; use an inline SVG icon instead.
- Design-process names ("Style A", "Option 2") never ship in code, class
  names, or scripts.

## Chromium 53 limits

Load the **`legacy-engine`** skill before editing CSS layout. In short:
no flex `gap` on webOS 4–6 (the build generates margins), no Grid on
webOS 4 (fallbacks in `css/legacy-webos-overrides.css`), never mix a
modern selector with a legacy one in a rule, and put every fallback under a
top-level `@supports not (...)`. Icons are **inline SVG** with
`currentColor` — uncommon Unicode symbols render as blank boxes on the TV
font.

## Screenshots and verification

- **Look at your own work** before calling it done: capture 1920×1080
  screenshots and check them, with focus on each kind of target and the
  hover state.
- **Real production code only.** Drive the app (preview server, a
  Playwright script, or `scripts/generate-screenshots.mjs`); never
  hand-build mock DOM to screenshot.
- **Cover the matrix that the change touches:** Midnight plus every light
  theme while iterating, every theme before done; Dark and Frosted for any
  overlay; each submenu and panel state; M3U-only and Xtream setups; dense,
  realistic data (a long multi-day guide, long names). Prefix files with
  the theme name.
- When a color or size is the point of the change, **assert the computed
  value** (`getComputedStyle`) instead of eyeballing it, and answer
  alignment or "is it the same" questions with measured numbers.
- After regenerating README screenshots, diff them against the published
  ones and list what changed; an unexplained difference is a regression.
- Check legacy parity with the `chromium-53-simulation` project
  (`e2e/legacy-layout-parity.spec.ts`, `e2e/pixel-parity.ts`). Fonts,
  animation smoothness, and CPU need the TV (see `webos-device`).
- Don't commit review screenshots or throwaway screenshot scripts unless
  asked; delete them when the review is over.

## Review checklist

Run this before calling a UI change done; fix or justify every miss.

- [ ] Matches the nearest existing pattern and reuses its classes; no new
      tokens, sizes, or radii without reason; one focal point per screen.
- [ ] Nothing redundant: no duplicate hints, close buttons, or labels the
      legend or an icon already covers.
- [ ] Readable at 10 feet: no readable text below 18px; holds at text
      size 80 and 150 and in the longest translation without clipping.
- [ ] Heights and midlines align within each row; bottom bars are 64px.
- [ ] Focus is instantly visible, uses `.focused` and the shared ring,
      frames only the visual target, isn't clipped, and doesn't shift
      layout.
- [ ] Focus order follows the visual grid; initial focus and Back are
      sensible; containers use `data-nav-enter` where re-entry matters.
- [ ] Selection is distinct from focus and doesn't depend on it.
- [ ] Works with D-pad alone and with the Magic Remote pointer; hover
      clears on leave and never changes the legend.
- [ ] Right in every theme, including the light ones; accent fills carry
      white text; scrims follow the theme.
- [ ] Overlays use overlay tokens and look right in Dark and Frosted.
- [ ] Motion gates only costly animations by mode; close mirrors open.
- [ ] Labels, errors, and empty states follow "Words on screen".
- [ ] Untrusted names go through `html`, truncate, and never break layout.
- [ ] Screenshots reviewed across the relevant matrix; `npm run lint`
      passes; legacy parity checked in `chromium-53-simulation`.
