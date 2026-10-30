export const CONFIG = {
  APP_ID: __APP_ID__ as string,
  APP_NAME: 'webOS IPTV Player',
  VERSION: __APP_VERSION__ as string,

  STORAGE_PREFIX: 'iptv_',

  // Versioned channel customization record (order, display, grouping, and EPG overrides).
  // Bump when its shape changes so an older payload is ignored, not misapplied.
  CHANNEL_CUSTOMIZATION_VERSION: 1,
  PARENTAL_CONTROL_VERSION: 1,
  PARENTAL_PIN_LENGTH: 4,
  PARENTAL_ITEMS_DELAY_MS: 250,
  PARENTAL_PIN_MAX_FAILURES: 5,
  PARENTAL_PIN_RETRY_DELAY_MS: 30 * 1000,
  PARENTAL_PIN_MAX_RETRY_DELAY_MS: 15 * 60 * 1000,

  // Bundled webOS JS service (see bundled-service/src/lan) for phone setup and uploads.
  SERVICE_ID: __SERVICE_ID__,
  SERVICE_HOST: '127.0.0.1',

  DEFAULT_PLAYLIST_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
  WORKER_IDLE_TERMINATION_MS: 1000,
  PLAYLIST_CACHE_WRITE_DELAY_MS: 1200,
  DEFAULT_EPG_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
  REMINDER_SCAN_INTERVAL: 30 * 1000,
  CHANNEL_SCROLLBAR_HIDE_MS: 900,
  NAVIGATION: {
    // Treat fast successive focus changes as held-key navigation. The repeat
    // interval measured on LG remotes is around 80 ms; leave room for load.
    FOCUS_REPEAT_WINDOW_MS: 180,
    // Longer than a native smooth reveal takes to bring its row in on a TV.
    REVEAL_SETTLE_MS: 800,
    EDGE_SCROLL_DWELL_MS: 400,
    EDGE_SCROLL_ZONE_PX: 64,
    // Edge scroll starts slow for precise stops and eases up to the top
    // speed over the ramp while the pointer stays on the same edge.
    EDGE_SCROLL_MIN_SPEED_PX_PER_SECOND: 600,
    EDGE_SCROLL_MAX_SPEED_PX_PER_SECOND: 2400,
    EDGE_SCROLL_RAMP_MS: 2500,
    // A track that reached its end under a resting pointer may still grow,
    // such as search results loading more: watch it this long to resume.
    EDGE_SCROLL_PARK_MS: 3000,
    EDGE_SCROLL_PARK_POLL_MS: 150,
  },
  PLAYER: {
    LIVE_PREVIEW_UPCOMING_COUNT: 4,
    LIVE_PREVIEW_REFRESH_MS: 1000,
    DEFAULT_PLAYER_OSD_TIMEOUT_MS: 5000,
    BUFFER_LENGTH: 30,
    MANIFEST_TIMEOUT: 5000,
    MANIFEST_MAX_BYTES: 256 * 1024,
    // Long live SegmentTimelines need a larger budget so the parser receives
    // complete MPD XML.
    MPD_MAX_BYTES: 1024 * 1024,
    // mediaOption selects the native MPEG-DASH transport deterministically;
    // bare delegates selection to URI typefinding for provider compatibility.
    DASH_SOURCE: 'mediaOption' as 'mediaOption' | 'bare',
    STREAM_MIME_CACHE_TTL: 7 * 24 * 60 * 60 * 1000,
    // Long enough to type a second or third digit, short enough that a
    // full-width number does not feel stalled once it can no longer grow.
    DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS: 1200,
    CHANNEL_NUMBER_MAX_DIGITS: 4,  // fallback cap until the channel count is known
    SEEK_STEP: 30,              // seconds per Left/Right press while seeking catch-up or live DVR
    HLS_MAX_RECOVERIES: 3,      // bounded hls.js fatal-error retries before giving up → next channel
    STALL_POLL_MS: 2000,        // native stall watchdog: currentTime poll interval
    STALL_FREEZE_TICKS: 5,      // ~10s frozen before the first in-place reload
    DEFAULT_LIVE_RECONNECT_ATTEMPTS: 3, // reconnect attempts before switching channels
    STARTUP_POLL_MS: 500,       // startup watchdog: readyState/networkState poll interval
    STARTUP_TIMEOUT: 15000,     // ms a stream may load without a frame before it counts as failed
    DVR_MIN_WINDOW: 10,         // live DVR: a seekable window must exceed this (s) to offer timeshift
    DVR_LIVE_EDGE: 10,          // within this many seconds of the window end counts as "at live"
    DVR_GO_LIVE_PAD: 3,         // Go-to-Live seeks to seekable.end minus this (s), avoiding a stall at the edge
    DVR_OLDEST_PAD: 3,          // Rewind stays inside the sliding window so its next refresh cannot strand playback
    RESYNC_SEEK_BACK: 0.5,      // manual A/V resync: seconds to seek back to force a native-pipeline flush
    RESYNC_TIMEOUT: 8000,       // ms safety cap to clear the "Resyncing…" message if `playing` never fires
    PLAYBACK_RATE_MEDIA_POLL_MS: 250, // wait cadence for the native pipeline's video.mediaId
    PLAYBACK_RATE_MEDIA_TIMEOUT: 5000, // max wait for video.mediaId before rejecting a rate change
    PLAYBACK_RATE_LUNA_TIMEOUT: 3000, // max wait for com.webos.media/setPlayRate
    PLAYBACK_RATE_REASSERT_MS: 250, // native pipeline may ignore the first accepted rate command
    PLAYBACK_RATE_REASSERT_COUNT: 2, // initial command plus two reassertions proved stable on-device
    PLAYBACK_RATE_VERIFY_MS: 3000, // playback sampled after a native rate change to confirm it took effect
    SUBTITLE_OFFSET_STEP: 0.25, // seconds per Left/Right press in the subtitle-sync adjuster
    SUBTITLE_OFFSET_MAX: 60,    // max |offset| the adjuster allows (seconds)
    SUBTITLE_SEARCH_TIMEOUT: 8000, // ms one online provider may take before the merged search gives up on it
    UP_NEXT_COUNTDOWN: 10,      // seconds before the queued episode/movie starts automatically
  },

  EPG: {
    VISIBLE_HOURS: 6,
    PIXELS_PER_MINUTE: (1920 - 200) / (6 * 60),
    TIME_SLOT_MINUTES: 30,
    OFFSET_STEP_MINUTES: 15,
    OFFSET_MAX_MINUTES: 12 * 60,
    // Retention ceiling for one XMLTV parse. A five-figure channel count
    // otherwise retains hundreds of MB, which a 1 GB TV cannot survive.
    MAX_RETAINED_PROGRAMMES: 120_000,
    // Visibility and mapping edits arrive one per keypress; coalesce them.
    CHANNEL_CHANGE_RELOAD_DELAY: 2000,
  },

  // Xtream Movies/Series catalog + resume tuning.
  XTREAM: {
    DEFAULT_CATALOG_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
    // After an unfiltered movie or series list fails, Search waits this long
    // before requesting it again, so a refusing panel is not asked on every open.
    WHOLE_CATALOG_RETRY_MS: 60 * 60 * 1000,
    // Unfiltered lists are parsed as they stream in, so memory follows the
    // kept fields, not the download; this only bounds a runaway response.
    WHOLE_CATALOG_MAX_BYTES: 256 * 1024 * 1024,
    WHOLE_CATALOG_TIMEOUT_MS: 3 * 60 * 1000,
    // The search catalog downloads this long after startup, once the channel
    // list and any resumed stream have settled, so Search finds it ready.
    SEARCH_CATALOG_PRELOAD_DELAY_MS: 10 * 1000,
    ACCOUNT_MAX_BYTES: 1024 * 1024,      // account/server metadata response budget
    CATEGORY_MAX_BYTES: 2 * 1024 * 1024, // category-list response budget
    CATALOG_MAX_BYTES: 32 * 1024 * 1024, // full or per-category stream-list budget
    DETAIL_MAX_BYTES: 8 * 1024 * 1024,   // VOD/series detail and episode response budget
    BACKGROUND_REFRESH_CONCURRENCY: 2,   // stale catalog lists re-fetched at once; the rest queue
    RAIL_CATEGORIES: 6,                  // categories preloaded as rails in the browse view
    RAIL_ITEMS: 20,                      // posters shown per rail before the "all categories" drill-in
    RESUME_MIN_SECS: 15,                 // below this, treat as "start over" (don't store a resume point)
    RESUME_FINISH_PAD: 30,               // within this of the end = finished (clear the resume point)
    RESUME_MAX_ITEMS: 50,                // Continue Watching entries per account and kind
    ARCHIVE_TTL_MS: 10 * 60 * 1000,      // per-channel get_simple_data_table freshness
    WATCHLIST_MAX_ITEMS: 200,            // per account and content type
  },

  // Catch-up (time-shift) resume and history store tuning.
  CATCHUP: {
    RESUME_MIN_SECS: 15,                // below this, treat as "start over" (don't store a resume point)
    FINISH_PAD: 30,                     // within this of the end = finished; caller sets completed: true
    FALLBACK_RETENTION_DAYS: 7,         // retention when the channel's catchupDays is 0 or absent
    CHECKPOINT_INTERVAL: 30 * 1000,     // how often the player should call setCatchupProgress
  },

  RECENTLY_WATCHED: {
    LIVE_CONFIRM_MS: 5 * 1000,
    MAX_LIVE_ENTRIES: 30,
    MAX_VISIBLE_ITEMS: 50,
  },

  SEARCH: {
    // Budget for the worker's IndexedDB reads before the page posts the index instead.
    CACHE_READ_TIMEOUT_MS: 1200,
    // Documents per index message when the page posts a source itself, one per frame.
    INDEX_CHUNK_SIZE: 2000,
    // Largest share of the free cache room one stored index may take.
    INDEX_BUDGET_SHARE: 0.1,
    INDEX_WRITE_TIMEOUT_MS: 5000,
    // After a search index attempt or a rebuild of a lost index fails, its
    // queries search on the main thread for this long before the worker is
    // tried again.
    INDEX_RETRY_DELAY_MS: 5000,
    // Background index builds are not latency-bound, so their reads may run longer.
    PREWARM_READ_TIMEOUT_MS: 10_000,
    // Latest the background index build waits for an idle period.
    PREWARM_IDLE_TIMEOUT_MS: 5000,
    INITIAL_RESULTS: 200,       // first ranked results published per group
    EXPANSION_FACTOR: 5,        // grow retained results near a virtual window boundary
    RESULT_CAP: 50_000,         // final per-group cap after progressive expansion
    HISTORY_MAX_ENTRIES: 10,    // recent searches kept
  },

  CHANNEL_HEALTH: {
    CONCURRENCY: 4,
    TIMEOUT_MS: 8000,
    MAX_PROBE_BYTES: 128 * 1024,
    MAX_MANIFEST_DEPTH: 2,
    FAILURES_UNTIL_UNAVAILABLE: 2,
  },

  // Max characters shown for a reminder's programme title and channel name
  // before an ellipsis, so long names don't overflow the toast/alert/in-app prompt.
  REMINDER: {
    TITLE_MAX: 40,
    CHANNEL_MAX: 24,
  },

  KEYS: {
    UP: 38,
    DOWN: 40,
    LEFT: 37,
    RIGHT: 39,
    ENTER: 13,
    BACK: 461,
    ESC: 27, // Escape key for desktop, maps to Back
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406,
    CH_UP: 33,
    CH_DOWN: 34,
    PLAY: 415,
    PAUSE: 19,
    STOP: 413,
    REWIND: 412,
    FORWARD: 417,
    NUM_0: 48,
    NUM_9: 57,
    // webOS sends these as keydown when the Magic Remote cursor shows or hides.
    CURSOR_SHOW: 1536,
    CURSOR_HIDE: 1537,
  },
} as const;
