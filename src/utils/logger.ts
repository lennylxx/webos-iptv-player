/**
 * Tagged logger with timing helpers.
 *
 * All logs are prefixed with `[tag]` so they can be filtered in ares-inspect
 * (Chromium DevTools), and timing helpers make stage durations visible.
 *
 * Default level is 'debug' so everything is visible in ares-inspect without
 * any setup. Logging cost is negligible (<0.01% CPU even on webOS 5).
 * To quiet things down: Logger.setLevel('warn') or
 *   localStorage.setItem('iptv_log_level', 'warn'); location.reload();
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<Level, number> = {
  debug: 10, info: 20, warn: 30, error: 40, silent: 100,
};

let currentLevel: Level = 'debug';
try {
  const stored = localStorage.getItem('iptv_log_level');
  if (stored && stored in LEVEL_RANK) currentLevel = stored as Level;
} catch { /* localStorage may be unavailable */ }

function should(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

export interface TaggedLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Start a timer; call the returned function to log elapsed ms. */
  time(label: string): () => void;
}

export function createLogger(tag: string): TaggedLogger {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => { if (should('debug')) console.log(prefix, ...args); },
    info:  (...args) => { if (should('info'))  console.log(prefix, ...args); },
    warn:  (...args) => { if (should('warn'))  console.warn(prefix, ...args); },
    error: (...args) => { if (should('error')) console.error(prefix, ...args); },
    time(label: string) {
      const start = Date.now();
      return () => {
        if (should('info')) console.log(prefix, `${label}: ${Date.now() - start}ms`);
      };
    },
  };
}

/** No-op shortcut for callers in hot paths to skip arg construction. */
export function isDebugEnabled(): boolean { return should('debug'); }

export const Logger = {
  setLevel(level: Level): void {
    currentLevel = level;
    try { localStorage.setItem('iptv_log_level', level); } catch { /* ignore */ }
    console.log(`[Logger] level set to '${level}'`);
  },
  getLevel(): Level { return currentLevel; },
};

/**
 * Install global handlers so any uncaught error or unhandled promise
 * rejection lands in ares-inspect with full context. Without these,
 * a parse-time SyntaxError (like the one that hung the app on webOS 5
 * before #1 was fixed) leaves no trace beyond a blank screen.
 */
export function installGlobalErrorHandlers(): void {
  const log = createLogger('GlobalError');
  window.addEventListener('error', (e: ErrorEvent) => {
    log.error('Uncaught error:', {
      message: e.message,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && (e.error as Error).stack,
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    log.error('Unhandled promise rejection:', e.reason);
  });
}

/** Log a one-line snapshot of the runtime environment for diagnostic context. */
export function logEnvironment(version: string): void {
  const log = createLogger('Env');
  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrom(?:e|ium)\/(\d+)/);
  const webosMatch = ua.match(/Web0?S\/?([\d.]+)?/i);
  log.info('App', version, '|',
    'Chromium', chromeMatch ? chromeMatch[1] : '?', '|',
    'webOS', webosMatch && webosMatch[1] ? webosMatch[1] : (webosMatch ? 'detected' : 'no'), '|',
    'Viewport', `${window.innerWidth}x${window.innerHeight}`, '|',
    'UA', ua);
}
