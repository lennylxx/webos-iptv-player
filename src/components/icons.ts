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
export const CHEVRON_LEFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>';
export const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-5 4 5 4"/><path d="M5 12h9a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4h-4"/></svg>';
export const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg>';
export const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6V4.5A2.5 2.5 0 0 1 11.5 2h1A2.5 2.5 0 0 1 15 4.5V6"/><rect x="3" y="6" width="18" height="4" rx="2"/><path d="M5 10v8.5A3.5 3.5 0 0 0 8.5 22h7a3.5 3.5 0 0 0 3.5-3.5V10M9 13v5M12 13v5M15 13v5"/></svg>';

// Settings sidebar categories. Stroke/fill styling is supplied by settings.css.
export const GLOBE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>';
export const SOURCES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/></svg>';
export const GUIDE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 9h18M8 3v4M16 3v4M7 13h3M14 13h3M7 17h3"/></svg>';
export const APPEARANCE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>';
export const PLAYBACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
export const CAPTIONS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 14h6M14 14h5M5 17h4M12 17h7"/></svg>';
export const DATABASE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
export const NAV_VERTICAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>';
export const NAV_HORIZONTAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>';

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
