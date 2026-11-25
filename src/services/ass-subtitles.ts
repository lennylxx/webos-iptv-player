import type { SidecarSubtitle } from '../types';
import { fetchText } from '../utils/fetch-helper';
import { createLogger } from '../utils/logger';

const log = createLogger('AssSubs');

const OVERLAY_ID = 'ass-overlay';

// A sidecar we render with assjs rather than a native <track>: the .ass/.ssa
// files, matched by URL extension (query string / hash tolerated, case-insensitive).
export function isAssSidecar(url: string): boolean {
  const ext = (url.split('?')[0].split('#')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  return ext === 'ass' || ext === 'ssa';
}

// The subset of the assjs instance we drive.
interface AssInstance {
  destroy(): unknown;
  hide(): unknown;
  show(): unknown;
  delay?: number;
}

type AssConstructor = new (content: string, video: HTMLVideoElement, options: { container: HTMLElement }) => unknown;

/**
 * Renders `.ass` / `.ssa` sidecar subtitles for VOD with `assjs` — a DOM/CSS ASS
 * renderer, so the browser does font fallback (no bundled fonts) and it degrades
 * gracefully at the compatibility floor. assjs is loaded with a lazy dynamic
 * `import('assjs')`, so a TV that never plays ASS never loads it. One track draws
 * at a time, into an `#ass-overlay` positioned over the video plane.
 */
export class AssSubtitles {
  private video: HTMLVideoElement | null = null;
  private container: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private sidecars: SidecarSubtitle[] = [];
  private ass: AssInstance | null = null;
  private gen = 0; // bumped on attach/show/hide/destroy; in-flight shows bail when it changes
  private shown = -1;
  private loads = new Map<number, Promise<string>>();
  private Ass: AssConstructor | null = null;
  private delay = 0; // per-stream subtitle timing offset (seconds; + = later)

  // Record the video, the DOM host for the overlay, and the ASS sidecars. No
  // assjs instance is created yet — that waits for the first `show`.
  attach(video: HTMLVideoElement, container: HTMLElement, sidecars: SidecarSubtitle[]): void {
    this.gen++;
    this.destroyInstance();
    this.video = video;
    this.container = container;
    this.sidecars = sidecars;
    this.loads.clear();
    if (sidecars.length) log.info('recorded', sidecars.length, 'ASS sidecar(s)');
  }

  // Show the i-th recorded ASS sidecar: lazily load assjs, fetch the body, and
  // render it into the overlay. Any prior instance is torn down first (one track
  // at a time).
  async show(index: number): Promise<void> {
    this.destroyInstance();
    const sidecar = this.sidecars[index];
    const video = this.video;
    if (!sidecar || !video) return;
    const gen = ++this.gen;
    try {
      const [{ default: ASS }, content] = await Promise.all([import('assjs'), this.contentOf(index)]);
      if (gen !== this.gen) return; // a newer selection/stop landed mid-fetch
      this.Ass = ASS as unknown as AssConstructor;
      if (!this.render(content)) return;
      this.shown = index;
      log.info('showing ASS sidecar', sidecar.name || sidecar.lang || sidecar.url);
    } catch (e) {
      log.warn('ASS load failed:', e);
    }
  }

  isShowing(index: number): boolean {
    return this.shown === index && !!this.ass;
  }

  /** The text of the i-th sidecar, fetched once. */
  contentOf(index: number): Promise<string> {
    const sidecar = this.sidecars[index];
    if (!sidecar) return Promise.reject(new Error('No such ASS sidecar'));
    if (sidecar.text != null) return Promise.resolve(sidecar.text);
    let load = this.loads.get(index);
    if (!load) {
      load = fetchText(sidecar.url);
      load.catch(() => this.loads.delete(index));
      this.loads.set(index, load);
    }
    return load;
  }

  /** Replaces the i-th sidecar's text, redrawing it at once if it is shown. */
  setText(index: number, text: string): void {
    const sidecar = this.sidecars[index];
    if (!sidecar) return;
    sidecar.text = text;
    if (this.shown !== index || !this.ass) return;
    const started = Date.now();
    this.destroyInstance();
    if (this.render(text)) this.shown = index;
    log.debug('ASS redrawn in', Date.now() - started, 'ms');
  }

  private render(content: string): boolean {
    const overlay = this.ensureOverlay();
    const video = this.video;
    if (!overlay || !video || !this.Ass) return false;
    // assjs starts drawing frames only on a later play/playing event, so an
    // instance made mid-playback would freeze; keep its handler to start it.
    let start: EventListener | null = null;
    const own = Object.prototype.hasOwnProperty.call(video, 'addEventListener');
    const add = video.addEventListener;
    video.addEventListener = function (this: HTMLVideoElement, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === 'playing' && typeof listener === 'function') start = listener;
      return add.call(this, type, listener, options);
    } as typeof video.addEventListener;
    try {
      this.ass = new this.Ass(content, video, { container: overlay }) as AssInstance;
    } finally {
      if (own) video.addEventListener = add;
      else delete (video as Partial<HTMLVideoElement>).addEventListener;
    }
    if (this.delay) { try { this.ass.delay = this.delay; } catch { /* older assjs */ } }
    const playing = start as EventListener | null;
    if (playing && !video.paused) playing.call(video, new Event('playing'));
    return true;
  }

  // Stop drawing (destroys the instance) while keeping the overlay for reuse.
  /** Shift ASS cues by `seconds` via assjs's `delay`. Remembered so a later `show`
   *  re-applies it. Positive = subtitles appear later. */
  setOffset(seconds: number): void {
    this.delay = seconds;
    if (this.ass) { try { this.ass.delay = seconds; } catch { /* older assjs */ } }
  }

  hide(): void {
    this.gen++; // cancel any in-flight show
    this.destroyInstance();
  }

  // Full teardown: destroy the instance, drop the overlay and forget state.
  destroy(): void {
    this.gen++;
    this.destroyInstance();
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    this.video = null;
    this.container = null;
    this.sidecars = [];
    this.loads.clear();
  }

  private destroyInstance(): void {
    this.shown = -1;
    if (!this.ass) return;
    try { this.ass.destroy(); } catch (e) { log.warn('ASS destroy failed:', e); }
    this.ass = null;
  }

  private ensureOverlay(): HTMLElement | null {
    if (this.overlay) return this.overlay;
    if (!this.container) return null;
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    this.container.appendChild(el);
    this.overlay = el;
    return el;
  }
}
