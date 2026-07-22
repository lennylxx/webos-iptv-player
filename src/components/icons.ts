// Shared inline SVG icons — the single source of truth for the app's icon
// markup. On webOS the WebView can't reach the last-resort font that some
// Unicode glyphs fall through to, so UI icons are inline SVGs drawn with
// `currentColor`. These are trusted raw markup strings — wrap them with `raw()`
// (or interpolate into an `html` template / assign to `innerHTML`) at the call
// site.

export const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
export const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// Magnifier (tab bar search).
export const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';

// Closed-caption card (player menu subtitles row).
export const SUBTITLE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2 7v2h6v-2H6zm8 0v2h4v-2h-4zM6 8v2h4V8H6zm6 0v2h6V8h-6z"/></svg>';

// Replay arrow marking an aired (catch-up) programme in the EPG.
export const REPLAY_ICON = '<svg class="epg-replay-glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';

// Sync (two circular arrows) — the player OSD "Resync A/V" button.
export const RESYNC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';

// Reminder bell — dim on a future programme ("OK sets a reminder"), accent once
// set; the state class drives the fill in CSS.
const BELL_PATH = 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z';
export function bellIcon(active: boolean): string {
  return `<svg class="epg-bell-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path fill="currentColor" d="${BELL_PATH}"/></svg>`;
}

// Download count badge on an online-subtitle search result row.
export const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

// Check mark for the current row in the account switcher (no exotic Unicode).
export const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

const WATCHLIST_PATH = 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z';
export function watchlistIcon(active: boolean): string {
  return `<svg class="watchlist-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="${WATCHLIST_PATH}"/></svg>`;
}
