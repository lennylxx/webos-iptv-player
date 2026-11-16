// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerPresentation } from './player-presentation';
import type { AspectRatio } from '../services/aspect-ratio';

const preview = { left: 880, top: 160, width: 960, height: 540 };

function rect(value: typeof preview): DOMRect {
  return {
    ...value, x: value.left, y: value.top,
    right: value.left + value.width, bottom: value.top + value.height,
    toJSON: () => value,
  };
}

let video: HTMLVideoElement | null;
let slot: HTMLElement | null;
let slotRectangle: typeof preview;
let presentation: PlayerPresentation;

function expectGeometry(value: typeof preview): void {
  expect(video?.style.left).toBe(`${value.left}px`);
  expect(video?.style.top).toBe(`${value.top}px`);
  expect(video?.style.width).toBe(`${value.width}px`);
  expect(video?.style.height).toBe(`${value.height}px`);
}

function expectBaseline(element = video): void {
  for (const property of [
    'left', 'top', 'width', 'height', 'transition', 'zIndex', 'borderRadius',
  ] as const) {
    expect(element?.style[property]).toBe('');
  }
}

beforeEach(() => {
  document.body.innerHTML = '<video class="active"></video><div></div>';
  video = document.querySelector('video');
  slot = document.querySelector('div');
  slot!.style.borderRadius = '8px';
  slotRectangle = preview;
  vi.spyOn(slot!, 'getBoundingClientRect').mockImplementation(() => rect(slotRectangle));
  presentation = new PlayerPresentation(() => video, () => slot);
});

afterEach(() => {
  presentation.showFullscreen();
  vi.restoreAllMocks();
});

describe('PlayerPresentation', () => {
  it('reports where the picture goes for an out-of-page pipeline', () => {
    const onLayout = vi.fn();
    const tracked = new PlayerPresentation(() => video, () => slot, onLayout);

    tracked.showPreview();
    expect(onLayout).toHaveBeenLastCalledWith(preview);
    slotRectangle = { ...preview, top: 200 };
    tracked.refresh();
    expect(onLayout).toHaveBeenLastCalledWith({ ...preview, top: 200 });
    tracked.showFullscreen();
    expect(onLayout).toHaveBeenLastCalledWith(null);
  });

  it('keeps the picture at the last preview while the slot has no geometry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onLayout = vi.fn();
    const tracked = new PlayerPresentation(() => video, () => slot, onLayout);
    tracked.showPreview();
    tracked.showFullscreen();
    slotRectangle = { ...preview, width: 0 };

    tracked.showPreview();

    expect(warn).toHaveBeenCalled();
    expect(onLayout).toHaveBeenLastCalledWith(preview);
    expectGeometry(preview);
    expect(video?.style.borderRadius).toBe('8px');
  });

  it('switches both directions immediately without touching media state', () => {
    const original = video!;
    const parent = original.parentNode;
    const load = vi.spyOn(original, 'load');
    const pause = vi.spyOn(original, 'pause');
    const play = vi.spyOn(original, 'play');
    const src = vi.spyOn(original, 'src', 'set');
    original.muted = true;
    original.volume = 0.4;
    original.currentTime = 37;
    original.style.objectFit = 'contain';
    original.style.display = 'block';

    presentation.showPreview();
    expectGeometry(preview);
    expect(original.style.borderRadius).toBe('8px');
    expect(original.style.transition).toBe('none');

    presentation.showFullscreen();
    expectBaseline();
    expect(video).toBe(original);
    expect(original.parentNode).toBe(parent);
    expect(load).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(src).not.toHaveBeenCalled();
    expect(original.muted).toBe(true);
    expect(original.volume).toBe(0.4);
    expect(original.currentTime).toBe(37);
    expect(original.style.objectFit).toBe('contain');
    expect(original.style.display).toBe('block');
    expect(original.className).toBe('active');
  });

  it('reapplies an updated destination', () => {
    presentation.showPreview();
    slotRectangle = { left: 800, top: 120, width: 640, height: 360 };
    presentation.showPreview();
    expectGeometry(slotRectangle);
  });

  it('refreshes replacement video nodes and clears the old node', () => {
    presentation.showPreview();
    const original = video!;
    video = document.createElement('video');
    video.muted = true;
    presentation.refresh();
    expectBaseline(original);
    expectGeometry(preview);
    expect(video.style.borderRadius).toBe('8px');
    expect(video.muted).toBe(true);
  });

  it('retains the requested destination while the video is absent', () => {
    video = null;
    presentation.showPreview();
    video = document.createElement('video');
    presentation.refresh();
    expectGeometry(preview);
  });

  it('refreshes the latest destination during lifecycle changes', () => {
    presentation.showPreview();
    slotRectangle = { left: 800, top: 120, width: 640, height: 360 };
    presentation.refresh();
    expectGeometry(slotRectangle);
    presentation.showFullscreen();
    presentation.refresh();
    expectBaseline();
  });

  it.each([
    { ...preview, width: 0 },
    { ...preview, height: -1 },
    { ...preview, left: NaN },
    { ...preview, width: Infinity },
  ])('logs invalid slot geometry and allows an explicit retry', (invalid) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    slotRectangle = invalid;
    presentation.showPreview();
    expect(warn).toHaveBeenCalled();
    expect(video?.style.transition).toBe('none');
    slotRectangle = preview;
    presentation.refresh();
    expectGeometry(preview);
  });

  it('logs a missing slot instead of moving the video', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    slot = null;
    presentation.showPreview();
    expect(warn).toHaveBeenCalled();
    expect(video?.style.transition).toBe('none');
    expect(video?.style.width).toBe('');
  });

  it('restores fullscreen styles without touching unrelated state', () => {
    video!.style.opacity = '0.8';
    presentation.showPreview();
    presentation.showFullscreen();
    expectBaseline();
    expect(video!.style.opacity).toBe('0.8');
    expect(video!.className).toBe('active');
    presentation.refresh();
    expectBaseline();
  });
});

describe('PlayerPresentation aspect ratio emulation', () => {
  let mode: AspectRatio;
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

  beforeEach(() => {
    mode = 'auto';
    presentation = new PlayerPresentation(() => video, () => slot, () => {}, () => mode, true);
  });

  it('stretches into a centered 4:3 or 16:9 box full screen', () => {
    mode = '4x3';
    presentation.showFullscreen();
    expect(video?.style.objectFit).toBe('fill');
    expectGeometry(box(240, 0, 1440, 1080));

    mode = '16x9';
    presentation.refresh();
    expectGeometry(box(0, 0, 1920, 1080));
  });

  it('fills and crops for Zoom, and Auto restores the stylesheet fit', () => {
    mode = 'zoom';
    presentation.showFullscreen();
    expect(video?.style.objectFit).toBe('cover');
    expectBaseline();

    mode = 'auto';
    presentation.refresh();
    expect(video?.style.objectFit).toBe('');
    expectBaseline();
  });

  it('boxes inside the preview slot but reports the slot to the pipeline', () => {
    const onLayout = vi.fn();
    presentation = new PlayerPresentation(() => video, () => slot, onLayout, () => mode, true);
    mode = '4x3';
    presentation.showPreview();
    expectGeometry(box(880 + 120, 160, 720, 540));
    expect(onLayout).toHaveBeenLastCalledWith(preview);
  });

  it('clears the emulated fit from a replaced video node', () => {
    mode = 'zoom';
    presentation.showFullscreen();
    const original = video!;
    video = document.createElement('video');
    presentation.refresh();
    expect(original.style.objectFit).toBe('');
    expect(video.style.objectFit).toBe('cover');
  });

  it('leaves the video alone where the TV scales the picture', () => {
    presentation = new PlayerPresentation(() => video, () => slot, () => {}, () => mode, false);
    mode = '4x3';
    presentation.showFullscreen();
    expect(video?.style.objectFit).toBe('');
    expectBaseline();
  });
});
