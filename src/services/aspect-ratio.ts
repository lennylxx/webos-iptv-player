import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import type { LunaDisplay } from './luna-media';
import {
  lunaRequest,
  type LunaRequestHandle,
  type LunaRequestOptions,
  type LunaResponse,
} from './luna';

const log = createLogger('AspectRatio');

export const ASPECT_RATIOS = ['auto', '16x9', '4x3', 'zoom'] as const;
export type AspectRatio = typeof ASPECT_RATIOS[number];

// The TV's per-app arcPerApp values: Auto follows the stream, Zoom is the
// TV's 4-way (all-direction) zoom, which scales uniformly and crops.
const TV_VALUES: Record<AspectRatio, string> = {
  auto: 'original',
  '16x9': '16x9',
  '4x3': '4x3',
  zoom: 'allDirZoom',
};

const REASON = /^[a-z0-9_]{1,32}$/;
// Failures a retry cannot fix this session; any other reason (timeout,
// superseded, bus_error, video_failed, unavailable) may clear on the next try.
const PERMANENT_REASONS = ['no_bus', 'bad_value', 'settings_failed', 'denied'];

type RequestLuna = (uri: string, options?: LunaRequestOptions) => LunaRequestHandle;

// Whether the app left a non-`original` ratio on the TV, kept across launches
// because the TV keeps the ratio too.
export interface AspectDirtyFlag {
  get(): boolean;
  set(dirty: boolean): void;
}

function memoryFlag(): AspectDirtyFlag {
  let dirty = false;
  return { get: () => dirty, set: (value) => { dirty = value; } };
}

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).indexOf(value) !== -1;
}

export function tvAspectValue(mode: AspectRatio): string {
  return TV_VALUES[mode];
}

function failureReason(response: LunaResponse): string {
  const code: unknown = response.errorCode;
  // A string code is the service's own; a numeric one is the Luna bus's.
  return typeof code === 'string' && REASON.test(code) ? code : 'unavailable';
}

export type TvAspectResult = 'applied' | 'failed' | 'superseded' | 'deferred';

// The current media, once it is ready for the videooutput fallback.
export interface AspectPlayback {
  mediaId: string;
  width: number;
  height: number;
  display: LunaDisplay;
}

interface AspectReply extends LunaResponse {
  backend?: unknown;
}

/**
 * Sets the TV's picture aspect ratio for this app through the bundled
 * service. The TV keeps it across launches and the user may change it in the
 * TV's own menu, so entering a channel leaves it alone unless the channel has
 * a remembered ratio, or the app changed it earlier this session and now
 * puts `original` back. A pick from the menu always writes; after a failure
 * a retry cannot fix, entering a channel stops writing until a pick succeeds.
 *
 * Where the TV refuses its setting, the service answers from videooutput,
 * which crops and places one media at a time: then every new media, size,
 * and picture box is written again, and the app owns the window of a media
 * it changed until Auto restores it.
 */
export class TvAspectRatio {
  // The mode last requested that has not failed: applied or on its way.
  private target: AspectRatio | null = null;
  // A non-Auto ratio was requested and `original` has not been restored since.
  private changed: boolean;
  private seq = 0;
  private blocked = false;
  // The latest tune-in skipped while blocked, run once a pick unblocks.
  private pendingEnter: AspectRatio | null = null;
  private readonly loggedReasons: string[] = [];
  private videoOutput = false;
  // The mode the current playback wants, for the videooutput route.
  private mode: AspectRatio = 'auto';
  // The media whose window the app changed and so must keep placing.
  private ownedMedia = '';
  // The last videooutput write sent, so a repeat of it is not resent, and
  // whether it missed, so the media becoming ready sends it again.
  private sentKey = '';
  private sentMissed = false;
  // Bumped on each load, so a videooutput reply for the last media is stale.
  private load = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  constructor(
    private readonly requestLuna: RequestLuna = lunaRequest,
    private readonly dirty: AspectDirtyFlag = memoryFlag(),
    private readonly getPlayback: () => AspectPlayback | null = () => null,
  ) {
    this.changed = dirty.get();
  }

  enter(mode: AspectRatio): void {
    this.mode = mode;
    if (this.videoOutput) {
      this.reapply();
      return;
    }
    if (this.blocked) {
      this.pendingEnter = mode;
      return;
    }
    if (mode === 'auto' ? !this.changed || this.target === 'auto' : mode === this.target) return;
    void this.write(mode);
  }

  pick(mode: AspectRatio): Promise<TvAspectResult> {
    this.mode = mode;
    this.pendingEnter = null;
    this.retries = 0;
    return this.write(mode);
  }

  /**
   * Writes the current mode again on the videooutput route when the media,
   * its size, or its box changed. True while the app owns the media's
   * window, so the regular placement must leave it alone. `ready` marks the
   * media becoming ready or playing, which also resends a write that missed
   * with a fresh set of retries.
   */
  reapply(ready = false): boolean {
    if (!this.videoOutput) return false;
    const playback = this.getPlayback();
    if (!playback || (this.mode === 'auto' && this.ownedMedia !== playback.mediaId)) return false;
    const key = playbackKey(this.mode, playback);
    if (key !== this.sentKey) {
      void this.write(this.mode);
    } else if (ready && this.sentMissed) {
      this.retries = 0;
      void this.write(this.mode);
    }
    return true;
  }

  /** A new load: the videooutput window starts over. */
  reset(): void {
    this.load++;
    this.sentKey = '';
    this.sentMissed = false;
    this.retries = 0;
    this.clearRetry();
  }

  private missed(playback: AspectPlayback | null): void {
    if (playback) this.sentMissed = true;
    this.retryLater();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  // A videooutput write that did not land keeps its key, so routine
  // relayouts do not resend it; only this bounded timer does.
  private retryLater(): void {
    if (this.retryTimer !== null || this.retries >= CONFIG.PLAYER.ASPECT_RATIO_RETRIES) return;
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.sentKey = '';
      this.reapply();
    }, CONFIG.PLAYER.ASPECT_RATIO_RETRY_MS);
  }

  private write(mode: AspectRatio): Promise<TvAspectResult> {
    this.target = mode;
    const playback = this.getPlayback();
    if (playback) {
      this.clearRetry();
      this.sentKey = playbackKey(mode, playback);
      this.sentMissed = false;
      if (mode !== 'auto') this.ownedMedia = playback.mediaId;
    }
    // Set before the write goes out: an app quit mid-write must still undo it.
    const marked = mode !== 'auto' && !this.changed && !this.videoOutput;
    if (marked) {
      this.changed = true;
      this.dirty.set(true);
    }
    const seq = ++this.seq;
    const load = this.load;
    // A later write took over, or a videooutput reply is for the last media.
    const stale = (): boolean =>
      seq !== this.seq || (playback !== null && this.videoOutput && load !== this.load);
    return new Promise<TvAspectResult>(resolve => {
      let settled = false;
      let request: LunaRequestHandle | null = null;
      // A hung or absent service never answers; give up so a later write runs.
      const timer = setTimeout(() => {
        if (settled) return;
        if (request) request.cancel();
        fail('timeout');
      }, CONFIG.PLAYER.ASPECT_RATIO_TIMEOUT);
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      // This reply was the first to name videooutput.
      let learned = false;
      // videooutput answered, so the TV setting was never written.
      const viaVideoOutput = (response: AspectReply): boolean => {
        if (response.backend !== 'videooutput') return false;
        learned = !this.videoOutput;
        this.videoOutput = true;
        if (marked && this.changed) {
          this.changed = false;
          this.dirty.set(false);
        }
        return true;
      };
      const fail = (reason: string): void => {
        if (!settle()) return;
        if (stale()) {
          resolve('superseded');
          if (learned) this.reapply();
          return;
        }
        this.target = null;
        if (!this.videoOutput && PERMANENT_REASONS.indexOf(reason) !== -1) this.blocked = true;
        if (this.videoOutput) this.missed(playback);
        // A retry on every channel change must not flood the log.
        if (this.loggedReasons.indexOf(reason) === -1) {
          this.loggedReasons.push(reason);
          log.warn('Aspect ratio not applied', 'event=player.aspect_failed',
            `reason=${reason}`, `mode=${mode}`);
        }
        resolve('failed');
      };
      const parameters: Record<string, unknown> = { value: tvAspectValue(mode) };
      if (playback) {
        parameters.mediaId = playback.mediaId;
        parameters.display = playback.display;
      }
      try {
        request = this.requestLuna(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'setAspectRatio',
          parameters,
          onSuccess: (response: AspectReply) => {
            if (!settle()) return;
            const video = viaVideoOutput(response);
            if (stale()) {
              resolve('superseded');
              // The route is new to the app: the current media still needs it.
              if (learned) this.reapply();
              return;
            }
            this.blocked = false;
            if (!video && mode === 'auto' && this.changed) {
              this.changed = false;
              this.dirty.set(false);
            }
            if (video && mode === 'auto' && playback && this.ownedMedia === playback.mediaId) this.ownedMedia = '';
            resolve('applied');
            const pending = this.pendingEnter;
            this.pendingEnter = null;
            if (pending) this.enter(pending);
            // The media may have changed while the route was unknown.
            else if (learned) this.reapply();
          },
          onFailure: (response: AspectReply) => {
            const reason = failureReason(response);
            if (reason !== 'video_pending') {
              if (!settled) viaVideoOutput(response);
              fail(reason);
              return;
            }
            if (!settle()) return;
            viaVideoOutput(response);
            if (stale()) {
              resolve('superseded');
              // The route is new to the app: the current media still needs it.
              if (learned) this.reapply();
              return;
            }
            this.blocked = false;
            resolve('deferred');
            this.pendingEnter = null;
            // A write sent before the route was known: send the media now.
            if (!playback) {
              this.reapply();
              return;
            }
            const sent = this.sentKey;
            // The media may have changed while the route was unknown.
            if (learned) this.reapply();
            if (this.sentKey === sent) this.missed(playback);
          },
        });
      } catch {
        fail('unavailable');
      }
    });
  }
}

function playbackKey(mode: AspectRatio, playback: AspectPlayback): string {
  return JSON.stringify([mode, playback.mediaId, playback.width, playback.height, playback.display]);
}
