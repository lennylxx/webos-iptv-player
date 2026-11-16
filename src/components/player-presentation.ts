import type { AspectRatio } from '../services/aspect-ratio';
import { createLogger } from '../utils/logger';
import { isWebOS } from '../utils/platform';

const log = createLogger('PlayerPresentation');
const geometryProperties = ['left', 'top', 'width', 'height'] as const;
// #video-player's full-screen box (css/main.css).
const FULL_SCREEN: Rectangle = { left: 0, top: 0, width: 1920, height: 1080 };
const BOX_RATIOS: Partial<Record<AspectRatio, number>> = { '16x9': 16 / 9, '4x3': 4 / 3 };

export interface Rectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

function validRectangle(rect: Rectangle): boolean {
  return isFinite(rect.left) && isFinite(rect.top)
    && isFinite(rect.width) && isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function writeRectangle(video: HTMLVideoElement, rect: Rectangle): void {
  for (const property of geometryProperties) video.style[property] = `${rect[property]}px`;
}

// The centered box of the given width:height ratio that fits in rect.
export function aspectBox(rect: Rectangle, ratio: number): Rectangle {
  if (rect.width / rect.height > ratio) {
    const width = rect.height * ratio;
    return { ...rect, left: rect.left + (rect.width - width) / 2, width };
  }
  const height = rect.width / ratio;
  return { ...rect, top: rect.top + (rect.height - height) / 2, height };
}

function clearStyles(video: HTMLVideoElement): void {
  video.style.transition = '';
  video.style.zIndex = '';
  video.style.borderRadius = '';
  for (const property of geometryProperties) video.style[property] = '';
}

export class PlayerPresentation {
  private previewMode = false;
  private video: HTMLVideoElement | null = null;
  private lastPreview: { rect: Rectangle; radius: string } | null = null;
  // Whether emulate() set the video's object-fit, so Auto knows to undo it.
  private fitStyled = false;

  constructor(
    private readonly getVideo: () => HTMLVideoElement | null,
    private readonly getSlot: () => HTMLElement | null,
    // A pipeline outside the page (Luna) has to be told where the picture goes.
    private readonly onLayout: (rect: Rectangle | null) => void = () => {},
    private readonly getAspect: () => AspectRatio = () => 'auto',
    // The TV scales its video plane itself and ignores CSS there.
    private readonly emulateAspect = !isWebOS(),
  ) {}

  showPreview(): void {
    this.previewMode = true;
    this.applyLayout();
  }

  showFullscreen(): void {
    this.previewMode = false;
    this.applyLayout();
  }

  refresh(): void {
    this.applyLayout();
  }

  private syncVideoElement(): void {
    const current = this.getVideo();
    if (current === this.video) return;
    if (this.video) {
      clearStyles(this.video);
      if (this.fitStyled) this.video.style.objectFit = '';
    }
    this.fitStyled = false;
    this.video = current;
  }

  private applyLayout(): void {
    this.syncVideoElement();
    const video = this.video;
    if (!video) return;
    if (!this.previewMode) {
      clearStyles(video);
      this.emulate(video, FULL_SCREEN);
      this.onLayout(null);
      return;
    }
    const slot = this.getSlot();
    const rect = slot?.getBoundingClientRect();
    if (!slot || !rect || !validRectangle(rect)) {
      log.warn('Cannot present live preview: slot is missing or has invalid geometry', rect);
      video.style.transition = 'none';
      video.style.zIndex = '';
      // A Luna picture would otherwise stay full screen behind the list.
      if (this.lastPreview) this.place(video, this.lastPreview.rect, this.lastPreview.radius);
      else this.emulate(video, null);
      return;
    }
    // Animated resizing saturated the TV CPU and caused dropped frames.
    video.style.transition = 'none';
    video.style.zIndex = '';
    const preview = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    this.lastPreview = { rect: preview, radius: getComputedStyle(slot).borderRadius || '0px' };
    this.place(video, preview, this.lastPreview.radius);
  }

  private place(video: HTMLVideoElement, rect: Rectangle, radius: string): void {
    writeRectangle(video, rect);
    video.style.borderRadius = radius;
    this.emulate(video, rect);
    this.onLayout(rect);
  }

  // Auto keeps the stylesheet's contain; 16:9 and 4:3 stretch the picture
  // into a centered box of that shape; Zoom fills and crops.
  private emulate(video: HTMLVideoElement, rect: Rectangle | null): void {
    if (!this.emulateAspect) return;
    const mode = this.getAspect();
    if (mode === 'auto') {
      if (this.fitStyled) video.style.objectFit = '';
      this.fitStyled = false;
      return;
    }
    const ratio = BOX_RATIOS[mode];
    video.style.objectFit = ratio ? 'fill' : 'cover';
    this.fitStyled = true;
    if (ratio && rect) writeRectangle(video, aspectBox(rect, ratio));
  }
}
