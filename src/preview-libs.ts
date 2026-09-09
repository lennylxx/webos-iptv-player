// The desktop preview exposes its MSE engines through globals.
// This file is NOT loaded on webOS
import Hls from 'hls.js';
import mpegts from 'mpegts.js';

(window as unknown as Record<string, unknown>).__Hls = Hls;
(window as unknown as Record<string, unknown>).__mpegts = mpegts;
