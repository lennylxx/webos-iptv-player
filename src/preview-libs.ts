// The desktop preview exposes its MSE engines through globals.
// This file is NOT loaded on webOS
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

(window as unknown as Record<string, unknown>).__Hls = Hls;
(window as unknown as Record<string, unknown>).__mpegts = mpegts;

// Isolate the desktop-only DASH engine so its initialization cannot affect the
// independently supported HLS and MPEG-TS preview engines.
void import('dashjs')
  .then(dashjs => {
    (window as unknown as Record<string, unknown>).__dashjs = dashjs;
  })
  .catch(() => {
    // Direct playback preserves preview behavior after DASH MSE initialization fails.
  });
