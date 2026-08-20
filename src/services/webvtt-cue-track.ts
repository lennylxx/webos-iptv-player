import { applyCueSettings, type VttCueSettings } from '../utils/webvtt';

/**
 * Protocol-agnostic sink for self-rendered WebVTT. HLS and DASH keep ownership
 * of fetching and clock mapping; this class keeps their application-created
 * TextTracks consistent.
 */
export class WebVttCueTrack {
  private track: TextTrack | null = null;
  private video: HTMLVideoElement | null = null;
  private offset = 0;

  get current(): TextTrack | null {
    return this.track;
  }

  attach(video: HTMLVideoElement, label: string, lang: string): TextTrack {
    // Reuse one track per video element because TextTracks cannot be removed.
    if (!this.track || this.video !== video) {
      this.track = video.addTextTrack('subtitles', label, lang || 'und');
      this.video = video;
    }
    this.track.mode = 'showing';
    return this.track;
  }

  disable(): void {
    this.clear();
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
  }

  /** True only for the application-created track owned by this renderer. */
  owns(track: TextTrack): boolean {
    return this.track === track;
  }

  prune(cutoff: number): void {
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].endTime < cutoff) this.track.removeCue(cues[i]);
    }
  }

  clear(): void {
    const cues = this.track?.cues;
    if (!cues || !this.track) return;
    for (let i = cues.length - 1; i >= 0; i--) this.track.removeCue(cues[i]);
  }
}
