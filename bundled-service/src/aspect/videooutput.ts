/**
 * The videooutput fallback's geometry: one setDisplayWindow request per
 * aspect value, for the app's own media, in the app's 1920x1080 space.
 */

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VideoDisplay = 'full' | DisplayRect;

export interface AppVideo {
  context: string;
  width: number;
  height: number;
}

const CANVAS: DisplayRect = { x: 0, y: 0, width: 1920, height: 1080 };
// Zoom enlarges the Auto picture by a third and crops what leaves the box.
const ZOOM = 4 / 3;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

function dimension(value: unknown): value is number {
  return finite(value) && value >= 2 && value <= 16384;
}

// A preview rect is rounded and clipped to the canvas; null when nothing
// of it is left.
export function videoDisplay(value: unknown): VideoDisplay | null {
  if (value === undefined || value === 'full') return 'full';
  const rect = record(value);
  if (!rect || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) return null;
  const x = Math.max(CANVAS.x, Math.round(rect.x));
  const y = Math.max(CANVAS.y, Math.round(rect.y));
  const width = Math.min(CANVAS.width, Math.round(rect.x + rect.width)) - x;
  const height = Math.min(CANVAS.height, Math.round(rect.y + rect.height)) - y;
  return width >= 2 && height >= 2 ? { x: x, y: y, width: width, height: height } : null;
}

// The connected video videooutput reports for exactly this app and media.
export function findAppVideo(value: unknown, appId: string, mediaId: string): AppVideo | null {
  if (!Array.isArray(value)) return null;
  for (let i = 0; i < value.length; i++) {
    const video = record(value[i]);
    if (video && video.appId === appId && video.context === mediaId && video.connected === true
        && dimension(video.width) && dimension(video.height)) {
      return { context: mediaId, width: video.width, height: video.height };
    }
  }
  return null;
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function centered(box: DisplayRect, width: number, height: number): DisplayRect {
  const w = Math.min(box.width, Math.round(width));
  const h = Math.min(box.height, Math.round(height));
  return {
    x: box.x + Math.floor((box.width - w) / 2), y: box.y + Math.floor((box.height - h) / 2),
    width: w, height: h,
  };
}

function fills(rect: DisplayRect, box: DisplayRect): boolean {
  return rect.x === box.x && rect.y === box.y && rect.width === box.width && rect.height === box.height;
}

export function videoWindow(video: AppVideo, value: string, display: VideoDisplay): Record<string, unknown> {
  const full = display === 'full';
  const box = full ? CANVAS : display as DisplayRect;
  const parameters: Record<string, unknown> = { context: video.context, fullScreen: full };
  // Auto leaves both inputs out, which drops an earlier crop.
  if (value === 'original') {
    if (!full) parameters.displayOutput = box;
    return parameters;
  }
  const original = { x: 0, y: 0, width: video.width, height: video.height };
  let crop = original;
  let output: DisplayRect;
  if (value === 'allDirZoom') {
    const scale = Math.min(box.width / video.width, box.height / video.height) * ZOOM;
    const width = even(Math.min(video.width, box.width / scale));
    const height = even(Math.min(video.height, box.height / scale));
    crop = {
      x: Math.floor((video.width - width) / 4) * 2, y: Math.floor((video.height - height) / 4) * 2,
      width: width, height: height,
    };
    output = centered(box, width * scale, height * scale);
  } else {
    const ratio = value === '4x3' ? 4 / 3 : 16 / 9;
    output = box.width / box.height > ratio
      ? centered(box, box.height * ratio, box.height)
      : centered(box, box.width, box.width / ratio);
  }
  // The TV-tested shapes: a full-screen crop without an output, and an
  // output box with fullScreen off.
  if (value === 'allDirZoom' && full && fills(output, box)) parameters.fullScreen = true;
  else {
    parameters.fullScreen = false;
    parameters.displayOutput = output;
  }
  // videooutput rejects either input rectangle without the other.
  parameters.originalInput = original;
  parameters.sourceInput = crop;
  return parameters;
}
