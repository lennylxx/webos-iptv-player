---
name: ui-copy
description: Write UI copy and translate it into every locale — glossary first, industry-standard terms researched and approved by the user before any translation, idiomatic per-language phrasing, key reuse, plurals, and length checks. Use when adding or changing any user-visible string, naming a feature or setting, adding a locale, or reviewing translations in src/i18n.
---

# UI copy and translation

Strings live in `src/i18n/*.ts`: `en.ts` is the source and defines the
key types; every other locale (de, es, fr, it, pl, pt-BR, ru, tr, uk,
zh-CN) must cover it. The costliest past mistake was naming **one
concept several ways** — across screens, between the TV and the setup
page, and between languages — then fixing it file by file. Settle the
words first, translate second.

## Process

1. **List the concepts** the change touches (a setting, a state, an
   action, a content type), not the strings.
2. **Check what already exists.** Look the concept up in "Settled
   terms" below, then search `en.ts` and `zh-CN.ts`. A settled or
   established term wins; reuse its key when the meaning is identical.
3. **Research the industry term for each new concept.** Search how
   established TV and streaming UIs name it — LG/webOS, other platforms'
   TV apps, major IPTV players, broadcasters in that market — and pick
   the most common, most widely understood wording. Do this per language,
   not just in English; a literal translation of the English term is
   not research.
4. **Present a glossary for approval** before writing any string:

   | Concept | en | zh-CN | Other locales | Evidence | Avoid |
   |---|---|---|---|---|---|

   Show the candidates you rejected and why. **Wait for the user to
   approve it.** Don't translate against unapproved terms.
5. **Write the English source** from the approved terms, then the other
   locales — all of them in the same change, never "English now,
   translations later".
6. **Verify** (see "Checks") and report any locale whose wording you
   are unsure about instead of guessing silently.

When the user changes a term later, update "Settled terms" first, then
sweep every locale, both READMEs, and the setup page for the old term.

## Terms

- **One concept, one term**, in every screen, hint, toast, README, and
  the LAN setup page. A label in an overlay uses the same name as the
  setting that controls it.
- **One term, one concept.** Don't let a word drift onto a neighbor
  (a config *source* vs. a stream being *unavailable*; *connecting* vs.
  *reconnecting*).
- **Name a setting after its feature**, using the feature's established
  name, not an invented description.
- **Options in a set share one axis.** "Full / Reduced / Essential" are
  all amounts; "Reduced / Full / Performance" mixes axes.
- **Scope bare words.** "All playlists" beats "All" when "All" could
  mean anything.
- Brand and protocol names stay untranslated: webOS IPTV Player, M3U,
  Xtream, EPG/XMLTV, Magic Remote (use LG's official localized name where
  one exists).

## Keys

- **Reuse a key only when the meaning is identical**; split it when two
  places merely share an English word (`common.resume` "Resume" vs.
  `common.continue` "Continue"; `preview.connecting` vs.
  `player.reconnecting`).
- Before adding keys, look for near-duplicates you are about to create;
  when replacing a screen, reuse what still fits and delete keys that
  no longer have a caller.
- Only user-visible text is translated. Logs stay English.

## Writing English

- **American English** ("program", never "programme"; "color",
  "canceled").
- Short, one clause, sentence case, in the voice of the surrounding
  strings. A label names; a hint explains — move qualifiers and
  parentheticals into the hint.
- No emphasis or hedging words ("only then", "simply", "just") and no
  volatile detail (retry counts, version numbers) in copy or READMEs.
- Fix ambiguous English before translating; every locale inherits it.
  Check that shortening a label didn't change its meaning.

## Translating

- **Idiomatic, native, professional** — written as a native speaker
  writes a TV UI, never word-for-word. Match the conventions of locales
  already in the app.
- Use each market's established TV vocabulary (catch-up is "Replay" in
  fr/de/it, "АРХИВ" in ru; the guide is the local TV-guide word).
- **Plurals** use the locale's CLDR categories (one/few/many/other) in
  its own catalog; never reuse English's two forms for ru, uk, or pl.
- Keep every `{placeholder}` intact and grammatically placed; check
  agreement around it (es/fr/it/pt adjectives and verbs).
- One neutral variant per language (`es` uses *ustedes*; `pt-BR`, not
  `pt`).

### Simplified Chinese

- Professional written Chinese, not translated English.
- Full-width punctuation (`，`, `：`, `（EPG）`, `“…”`, `…`).
- A space between Chinese and Latin text (`API 令牌`, `EPG 时间校正`).
- No counter words (`个`, `条`) in counts; show plain numbers.

## Settled terms

Terms the user decided after back-and-forth review. Use them for their
concept and never reintroduce a rejected wording. When the user settles
a new term after review, add a row here.

| Concept | en | zh-CN |
|---|---|---|
| Configured M3U/Xtream input | Source | 播放源 |
| One M3U list | Playlist | 播放列表 |
| EPG view | Guide / Program Guide | 节目指南 |
| Catch-up | Catch-up | 回看 |
| Timeshift | Timeshift | 时移 |
| Watchlist | Watchlist | 稍后观看 |
| Current / next program | NOW / Up next | 当前 / 即将播放 |
| Resume playback | Resume | 继续播放 |
| EPG time offset | EPG time correction | EPG 时间校正 |
| Audio track | Audio track | 音轨 |
| Animation modes | Full / Reduced / Essential | 完整 / 均衡 / 基础 |

Rejected: 片单 (watchlist), 正在播放 for NOW, 节目单 (guide),
全局频道 / "Global" for all channels, "programme".

## Checks

- `npx vitest run src/i18n` — no empty strings, placeholders match,
  plurals resolve in every locale.
- Run the pseudo-locale and look at the screens at 1920×1080: the
  longest locale (usually ru, uk, de, pt-BR) must fit at text size 150.
  **Fix overflow with layout** (auto-width, wrapping) before shortening
  the words; shorten only when the shorter phrase is still the
  established term.
- Grep every locale for the old term after a rename.
- Ask yourself per locale: is this what that market's TV apps say?
  Flag any you can't vouch for.
- Keep `README.md` and `README.zh-CN.md` in sync with the same terms.
