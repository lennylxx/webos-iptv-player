// Shared inline SVG icons — the single source of truth for the app's icon
// markup. On webOS the WebView can't reach the last-resort font that some
// Unicode glyphs fall through to, so UI icons are inline SVGs drawn with
// `currentColor`. These are trusted raw markup strings — wrap them with `raw()`
// (or interpolate into an `html` template / assign to `innerHTML`) at the call
// site.

export const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
export const PREVIOUS_EPISODE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>';
export const NEXT_EPISODE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
export const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

// Play triangle for a channel group without a matching icon. A U+25B6 glyph
// here forced a fallback-font lookup that stalled the channel list's first
// paint.
export const TRIANGLE_ICON = '<svg class="group-fallback-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l14-8z"/></svg>';
// Marks the playing channel. A U+25B6 glyph here stalled the first layout
// after leaving the player on the same fallback-font lookup.
export const PLAYING_ICON = '<svg class="playing-indicator-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l14-8z"/></svg>';

// Magnifier (tab bar search).
export const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';
export const CHEVRON_LEFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>';
export const SEE_ALL_ICON = '<svg class="catalog-see-all-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
export const CHEVRON_RIGHT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
export const LOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
export const UNLOCK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.75-1.4"/></svg>';
export const CHEVRON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
export const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
export const SORT_ASCENDING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 19V5m-3 3 3-3 3 3M13 6h3m-3 6h5m-5 6h8"/></svg>';
export const SORT_DESCENDING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5v14m-3-3 3 3 3-3M13 6h8m-8 6h5m-5 6h3"/></svg>';
export const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 8-5 4 5 4"/><path d="M5 12h9a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4h-4"/></svg>';
export const CLOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
export const REMOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg>';
export const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg>';
export const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.5 2h5a1 1 0 0 1 1 1v1H20a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4.5V3a1 1 0 0 1 1-1zM5 8.5h14l-.9 11.1A2.5 2.5 0 0 1 15.6 22H8.4a2.5 2.5 0 0 1-2.5-2.4L5 8.5zm4.1 3v7h1.8v-7H9.1zm4 0v7h1.8v-7h-1.8z"/></svg>';
export const VOLUME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>';
export const VOLUME_MUTED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/></svg>';
export const FULLSCREEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg>';

const FAVORITE_PATH = 'm12 2.8 2.84 5.75 6.35.92-4.6 4.48 1.09 6.32L12 17.28l-5.68 2.99 1.09-6.32-4.6-4.48 6.35-.92L12 2.8z';
export function favoriteIcon(active: boolean): string {
  return `<svg class="favorite-glyph ${active ? 'set' : 'unset'}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="${FAVORITE_PATH}"/></svg>`;
}

// Settings sidebar categories. Stroke/fill styling is supplied by settings.css.
export const GLOBE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M4.2 8.5c2.2 1.1 4.9 1.7 7.8 1.7s5.6-.6 7.8-1.7M4.2 15.5c2.2-1.1 4.9-1.7 7.8-1.7s5.6.6 7.8 1.7M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/></svg>';
export const SOURCES_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01"/></svg>';
export const GUIDE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 9h18M8 3v4M16 3v4M7 13h3M14 13h3M7 17h3"/></svg>';
export const APPEARANCE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>';
export const PLAYBACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
export const CAPTIONS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 14h6M14 14h5M5 17h4M12 17h7"/></svg>';
export const DATABASE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>';
export const ADVANCED_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
export const NAV_VERTICAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>';
export const NAV_HORIZONTAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>';

// Speed gauge (player menu playback-speed row).
export const SPEED_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="m20.38 8.57-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>';
// Beamed eighth notes (player menu audio-track row).
export const AUDIO_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M21 2v13a3.2 3.2 0 1 1-1.8-2.88V6.4l-8.4 1.9V17.5a3.2 3.2 0 1 1-1.8-2.88V4.6z"/></svg>';
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
