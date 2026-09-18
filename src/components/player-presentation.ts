import { createLogger } from '../utils/logger';

const log = createLogger('PlayerPresentation');
const geometryProperties = ['left', 'top', 'width', 'height'] as const;

interface Rectangle {
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

function clearStyles(video: HTMLVideoElement): void {
  video.style.transition = '';
  video.style.zIndex = '';
  video.style.borderRadius = '';
  for (const property of geometryProperties) video.style[property] = '';
}

export class PlayerPresentation {
  private previewMode = false;
  private video: HTMLVideoElement | null = null;

  constructor(
    private readonly getVideo: () => HTMLVideoElement | null,
    private readonly getSlot: () => HTMLElement | null,
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
    if (this.video) clearStyles(this.video);
    this.video = current;
  }

  private applyLayout(): void {
    this.syncVideoElement();
    const video = this.video;
    if (!video) return;
    if (!this.previewMode) {
      clearStyles(video);
      return;
    }
    const slot = this.getSlot();
    const rect = slot?.getBoundingClientRect();
    if (!slot || !rect || !validRectangle(rect)) {
      log.warn('Cannot present live preview: slot is missing or has invalid geometry', rect);
      video.style.transition = 'none';
      video.style.zIndex = '';
      return;
    }
    // Animated resizing saturated the TV CPU and caused dropped frames.
    video.style.transition = 'none';
    writeRectangle(video, rect);
    video.style.borderRadius = getComputedStyle(slot).borderRadius || '0px';
    video.style.zIndex = '';
  }
}
