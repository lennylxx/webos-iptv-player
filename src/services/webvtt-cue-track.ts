import { applyCueSettings, type VttCueSettings } from '../utils/webvtt';

const CUE_SYNC_MS = 250;
const SHOWN_CUE_END_S = 1e6;
const CUE_LAYOUT = [
  'vertical', 'snapToLines', 'line', 'lineAlign', 'position', 'positionAlign', 'size', 'align',
] as const;

/**
 * Protocol-agnostic sink for self-rendered WebVTT. HLS and DASH keep ownership
 * of fetching and clock mapping; this class keeps their application-created
 * TextTracks consistent.
 */
export class WebVttCueTrack {
  private track: TextTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private offset = 0;
  private clock: (() => number) | null = null;
  private display: TextTrack | null = null;
  private shown = new Map<TextTrackCue, VTTCue>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncVideo: HTMLVideoElement | null = null;
  private readonly onTick = (): void => this.sync();

  get current(): TextTrack | null {
    return this.track;
  }

  /**
   * With a `clock`, cues are timed on that clock instead of the element's own
   * media time, and a second track shows the cues active on it.
   */
  attach(video: HTMLVideoElement, label: string, lang: string, clock?: () => number): TextTrack {
    this.stopSync();
    // Reuse one track per video element because TextTracks cannot be removed.
    if (!this.track || this.video !== video) {
      this.track = video.addTextTrack('subtitles', label, lang || 'und');
      this.display = null;
      this.video = video;
    }
    this.clock = clock ?? null;
    if (!this.clock) {
      this.hideDisplay();
      this.track.mode = 'showing';
      return this.track;
    }
    // Blink activates cues by the element's own media time, which is not the
    // clock, so the clock's timeline stays hidden and its active cues show on
    // a track spanning the element's whole timeline.
    this.track.mode = 'hidden';
    if (!this.display) this.display = video.addTextTrack('subtitles', label, lang || 'und');
    this.display.mode = 'showing';
    video.addEventListener('timeupdate', this.onTick);
    this.syncVideo = video;
    this.syncTimer = setInterval(this.onTick, CUE_SYNC_MS);
    this.sync();
    return this.track;
  }

  disable(): void {
    this.stopSync();
    this.clear();
    this.hideDisplay();
    if (this.track) this.track.mode = 'disabled';
  }

  add(
    start: number,
    end: number,
    text: string,
    settings?: VttCueSettings,
  ): boolean {
    if (!this.track || end <= start) return false;
    // Bake the current offset into new cues; setOffset shifts existing cues by
    // only its delta, so repeated absolute updates cannot accumulate drift.
    const cue = new VTTCue(start + this.offset, end + this.offset, text);
    if (settings) {
      try {
        applyCueSettings(cue, settings);
      } catch { /* positioning unsupported */ }
    }
    try {
      this.track.addCue(cue);
      return true;
    } catch {
      return false;
    }
  }

  /** Shift self-rendered subtitles relative to media time; positive means later. */
  setOffset(seconds: number): void {
    const delta = seconds - this.offset;
    this.offset = seconds;
    if (!delta || !this.track?.cues) return;
    for (let i = 0; i < this.track.cues.length; i++) {
      const cue = this.track.cues[i] as VTTCue;
      cue.startTime += delta;
      cue.endTime += delta;
    }
    this.sync();
  }

  /** True only for the application-created track owned by this renderer. */
  owns(track: TextTrack): boolean {
    return this.track === track || this.display === track;
  }

  prune(cutoff: number): void {
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].endTime < cutoff) this.track.removeCue(cues[i]);
    }
    this.sync();
  }

  clear(): void {
    this.clearDisplay();
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    for (let i = cues.length - 1; i >= 0; i--) this.track.removeCue(cues[i]);
  }

  // Adding or removing a cue makes Blink re-run cue display, even while the
  // element itself is paused.
  private sync(): void {
    const track = this.track;
    const display = this.display;
    if (!this.clock || !track || !display) return;
    const now = this.clock();
    const active = new Set<TextTrackCue>();
    // A NaN clock (no position yet) matches no cue, so nothing shows.
    const cues = track.cues;
    for (let i = 0; cues && i < cues.length; i++) {
      if (cues[i].startTime <= now && now < cues[i].endTime) active.add(cues[i]);
    }
    this.shown.forEach((shown, cue) => {
      if (active.has(cue)) return;
      this.shown.delete(cue);
      try { display.removeCue(shown); } catch { /* already gone */ }
    });
    active.forEach(cue => {
      if (this.shown.has(cue)) return;
      const shown = shownCue(cue as VTTCue);
      try {
        display.addCue(shown);
        this.shown.set(cue, shown);
      } catch { /* not shown */ }
    });
  }

  private stopSync(): void {
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.syncVideo?.removeEventListener('timeupdate', this.onTick);
    this.syncVideo = null;
  }

  private clearDisplay(): void {
    const display = this.display;
    if (display) this.shown.forEach(shown => {
      try { display.removeCue(shown); } catch { /* already gone */ }
    });
    this.shown.clear();
  }

  private hideDisplay(): void {
    this.clearDisplay();
    if (this.display) this.display.mode = 'disabled';
  }
}

function shownCue(cue: VTTCue): VTTCue {
  const shown = new VTTCue(0, SHOWN_CUE_END_S, cue.text);
  const from = cue as unknown as Record<string, unknown>;
  const to = shown as unknown as Record<string, unknown>;
  for (const key of CUE_LAYOUT) {
    if (!(key in from)) continue;
    try { to[key] = from[key]; } catch { /* unsupported setting */ }
  }
  return shown;
}
