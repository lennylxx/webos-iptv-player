import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { isLunaAvailable, lunaRequest, type LunaResponse } from './luna';

const log = createLogger('Trailer');

export const YOUTUBE_APP_ID = 'youtube.leanback.v4';
const APP_MANAGER = 'luna://com.webos.applicationManager';

type Status = 'unknown' | 'probing' | 'installed' | 'missing';

let status: Status = 'unknown';
const waiting = new Set<() => void>();
let watchingVisibility = false;

// Callbacks re-render, so they wait for the task to end: a check that fails
// at once settles inside the render that asked.
function settle(next: Status): void {
  status = next;
  const callbacks = Array.from(waiting);
  waiting.clear();
  if (callbacks.length) setTimeout(() => callbacks.forEach(callback => callback()), 0);
}

// Only an explicit "not installed" hides the trailer: a check that fails or
// never answers shows it, and a launch that finds no app hides it then.
function probe(): void {
  status = 'probing';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = lunaRequest<LunaResponse & { exist?: boolean }>(APP_MANAGER, {
    method: 'getAppLoadStatus',
    parameters: { appId: YOUTUBE_APP_ID },
    onSuccess: (response) => {
      const exist = response.exist !== false;
      if (!exist) log.info('YouTube app not found', 'event=trailer.youtube', 'exist=false');
      settle(exist ? 'installed' : 'missing');
    },
    onFailure: (response) => {
      log.warn('YouTube app check failed', 'event=trailer.youtube',
        `error=${String(response.errorCode ?? 'unknown')}`);
      settle('installed');
    },
    onComplete: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  });
  if (status !== 'probing') return;
  timer = setTimeout(() => {
    timer = null;
    if (status !== 'probing') return;
    request.cancel();
    log.warn('YouTube app check timed out', 'event=trailer.youtube', 'error=timeout');
    settle('installed');
  }, CONFIG.XTREAM.YOUTUBE_CHECK_TIMEOUT_MS);
}

// Whether a trailer can open now. Off webOS a browser tab plays it. On the TV
// the first call asks the app manager and reports `false` until it answers,
// then calls `onSettled`. A missing app is asked about again once the app is
// shown again, so a YouTube installed meanwhile is found.
export function youtubeReady(onSettled: () => void): boolean {
  if (!isLunaAvailable()) return true;
  if (!watchingVisibility && typeof document !== 'undefined') {
    watchingVisibility = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && status === 'missing') status = 'unknown';
    });
  }
  if (status === 'installed') return true;
  if (status === 'missing') return false;
  waiting.add(onSettled);
  if (status === 'unknown') probe();
  // A check that failed at once has settled already.
  return (status as Status) === 'installed';
}

export function openYoutubeTrailer(videoId: string, onFailure: () => void): void {
  if (!isLunaAvailable()) {
    window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
    return;
  }
  lunaRequest(APP_MANAGER, {
    method: 'launch',
    parameters: {
      id: YOUTUBE_APP_ID,
      params: { contentTarget: `https://www.youtube.com/tv?v=${videoId}` },
    },
    onFailure: (response) => {
      log.warn('YouTube launch failed', 'event=trailer.launch',
        `error=${String(response.errorCode ?? 'unknown')}`);
      if (response.errorCode === -101) status = 'missing';
      onFailure();
    },
  });
}

export function resetYoutubeStatusForTests(): void {
  status = 'unknown';
  waiting.clear();
}
