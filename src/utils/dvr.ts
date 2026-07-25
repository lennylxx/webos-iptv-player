// Live DVR (live timeshift) window math. Pure and DOM-free so the clamping and
// at-edge logic can be tested directly; the player feeds it `videoEl.seekable`,
// `videoEl.duration`, and `videoEl.currentTime` plus the CONFIG tolerances.

// The subset of TimeRanges we read (structural, to avoid a DOM type dependency).
export interface TimeRangesLike {
  length: number;
  start(index: number): number;
  end(index: number): number;
}

export interface DvrWindow {
  start: number;
  end: number;
  length: number;
}

export interface DvrState {
  start: number;
  end: number;
  length: number;
  position: number; // currentTime clamped into the window
  fraction: number; // 0..1 position within the window (for the cursor)
  behindLive: number; // seconds behind the live edge (>= 0)
  atLiveEdge: boolean;
}

// A live stream reports duration === Infinity; a finite duration is catch-up/VOD,
// which uses the duration-based seek path instead. Returns the rewindable window
// (the range at the live edge) only when it exceeds the stability floor.
export function dvrWindow(
  seekable: TimeRangesLike | null | undefined,
  duration: number,
  minWindow: number,
): DvrWindow | null {
  if (duration !== Infinity) return null;
  if (!seekable || seekable.length === 0) return null;
  const i = seekable.length - 1;
  const start = seekable.start(i);
  const end = seekable.end(i);
  const length = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      !Number.isFinite(length) || length <= minWindow) return null;
  return { start, end, length };
}

export function dvrState(win: DvrWindow, currentTime: number, liveEdge: number): DvrState {
  const position = Math.max(win.start, Math.min(win.end, currentTime));
  const fraction = win.length > 0 ? (position - win.start) / win.length : 0;
  const behindLive = win.end - position;
  return {
    start: win.start,
    end: win.end,
    length: win.length,
    position,
    fraction,
    behindLive,
    atLiveEdge: behindLive <= liveEdge,
  };
}
