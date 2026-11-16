import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
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
// superseded, bus_error, unavailable) may clear on the next try.
const PERMANENT_REASONS = ['no_bus', 'bad_value', 'settings_denied', 'settings_failed', 'denied'];

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

export type TvAspectResult = 'applied' | 'failed' | 'superseded';

/**
 * Sets the TV's picture aspect ratio for this app through the bundled
 * service. The TV keeps it across launches and the user may change it in the
 * TV's own menu, so entering a channel leaves it alone unless the channel has
 * a remembered ratio, or the app changed it earlier this session and now
 * puts `original` back. A pick from the menu always writes; after a failure
 * a retry cannot fix, entering a channel stops writing until a pick succeeds.
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

  constructor(
    private readonly requestLuna: RequestLuna = lunaRequest,
    private readonly dirty: AspectDirtyFlag = memoryFlag(),
  ) {
    this.changed = dirty.get();
  }

  enter(mode: AspectRatio): void {
    if (this.blocked) {
      this.pendingEnter = mode;
      return;
    }
    if (mode === 'auto' ? !this.changed || this.target === 'auto' : mode === this.target) return;
    void this.write(mode);
  }

  pick(mode: AspectRatio): Promise<TvAspectResult> {
    this.pendingEnter = null;
    return this.write(mode);
  }

  private write(mode: AspectRatio): Promise<TvAspectResult> {
    this.target = mode;
    // Set before the write goes out: an app quit mid-write must still undo it.
    if (mode !== 'auto' && !this.changed) {
      this.changed = true;
      this.dirty.set(true);
    }
    const seq = ++this.seq;
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
      const fail = (reason: string): void => {
        if (!settle()) return;
        if (seq !== this.seq) {
          resolve('superseded');
          return;
        }
        this.target = null;
        if (PERMANENT_REASONS.indexOf(reason) !== -1) this.blocked = true;
        // A retry on every channel change must not flood the log.
        if (this.loggedReasons.indexOf(reason) === -1) {
          this.loggedReasons.push(reason);
          log.warn('Aspect ratio not applied', 'event=player.aspect_failed',
            `reason=${reason}`, `mode=${mode}`);
        }
        resolve('failed');
      };
      try {
        request = this.requestLuna(`luna://${CONFIG.SERVICE_ID}`, {
          method: 'setAspectRatio',
          parameters: { value: tvAspectValue(mode) },
          onSuccess: () => {
            if (!settle()) return;
            if (seq !== this.seq) {
              resolve('superseded');
              return;
            }
            this.blocked = false;
            if (mode === 'auto' && this.changed) {
              this.changed = false;
              this.dirty.set(false);
            }
            resolve('applied');
            const pending = this.pendingEnter;
            this.pendingEnter = null;
            if (pending) this.enter(pending);
          },
          onFailure: response => fail(failureReason(response)),
        });
      } catch {
        fail('unavailable');
      }
    });
  }
}
