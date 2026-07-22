export const CONFIG = {
  APP_ID: __APP_ID__ as string,
  APP_NAME: 'webOS IPTV Player',
  VERSION: __APP_VERSION__ as string,

  STORAGE_PREFIX: 'iptv_',

  // Bundled webOS JS service (see bundled-service/src/upload) for LAN playlist uploads.
  SERVICE_ID: __SERVICE_ID__,
  SERVICE_HOST: '127.0.0.1',

  PLAYLIST_REFRESH_INTERVAL: 6 * 60 * 60 * 1000,
  EPG_REFRESH_INTERVAL: 6 * 60 * 60 * 1000,
  REMINDER_SCAN_INTERVAL: 30 * 1000,
  PLAYER: {
    OSD_TIMEOUT: 5000,
    BUFFER_LENGTH: 30,
    MANIFEST_TIMEOUT: 5000,
    MANIFEST_MAX_BYTES: 256 * 1024,
    CHANNEL_NUMBER_TIMEOUT: 2000,
    SEEK_STEP: 30,              // seconds per Left/Right press while seeking catch-up or live DVR
    HLS_MAX_RECOVERIES: 3,      // bounded hls.js fatal-error retries before giving up → next channel
    STALL_POLL_MS: 2000,        // native stall watchdog: currentTime poll interval
    STALL_FREEZE_TICKS: 5,      // ~10s frozen before the first in-place reload
    STALL_MAX_RELOADS: 2,       // in-place reloads before escalating to the next channel
    DVR_MIN_WINDOW: 10,         // live DVR: a seekable window must exceed this (s) to offer timeshift
    DVR_LIVE_EDGE: 10,          // within this many seconds of the window end counts as "at live"
    DVR_GO_LIVE_PAD: 3,         // Go-to-Live seeks to seekable.end minus this (s), avoiding a stall at the edge
    RESYNC_SEEK_BACK: 0.5,      // manual A/V resync: seconds to seek back to force a native-pipeline flush
    RESYNC_TIMEOUT: 8000,       // ms safety cap to clear the "Resyncing…" message if `playing` never fires
    SUBTITLE_OFFSET_STEP: 0.25, // seconds per Left/Right press in the subtitle-sync adjuster
    SUBTITLE_OFFSET_MAX: 60,    // max |offset| the adjuster allows (seconds)
    NEXT_EPISODE_COUNTDOWN: 10, // seconds before an available next episode starts automatically
  },

  EPG: {
    VISIBLE_HOURS: 6,
    PIXELS_PER_MINUTE: (1920 - 200) / (6 * 60),
    TIME_SLOT_MINUTES: 30,
  },

  // Xtream Movies/Series catalog + resume tuning.
  XTREAM: {
    CATALOG_TTL_MS: 6 * 60 * 60 * 1000, // catalog cache freshness before a re-fetch
    RAIL_CATEGORIES: 6,                 // categories preloaded as rails in the browse view
    RAIL_ITEMS: 20,                     // posters shown per rail before the "all categories" drill-in
    RESUME_MIN_SECS: 15,                // below this, treat as "start over" (don't store a resume point)
    RESUME_FINISH_PAD: 30,              // within this of the end = finished (clear the resume point)
    SEARCH_RESULT_CAP: 30,              // max results rendered per Search group
    ARCHIVE_TTL_MS: 10 * 60 * 1000,     // per-channel get_simple_data_table freshness
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
  },
} as const;
