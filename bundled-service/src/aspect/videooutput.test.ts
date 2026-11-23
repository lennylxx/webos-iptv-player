import { describe, expect, it } from 'vitest';
import { videoDisplay, videoWindow, type AppVideo } from './videooutput';

const hd: AppVideo = { context: 'm1', width: 1920, height: 1080 };
const preview = { x: 960, y: 100, width: 800, height: 450 };

describe('videoWindow', () => {
  it('restores Auto by leaving both inputs out', () => {
    expect(videoWindow(hd, 'original', 'full')).toEqual({ context: 'm1', fullScreen: true });
    expect(videoWindow(hd, 'original', preview))
      .toEqual({ context: 'm1', fullScreen: false, displayOutput: preview });
  });

  it('crops Zoom from the middle in the TV-tested full-screen shape', () => {
    expect(videoWindow(hd, 'allDirZoom', 'full')).toEqual({
      context: 'm1', fullScreen: true,
      originalInput: { x: 0, y: 0, width: 1920, height: 1080 },
      sourceInput: { x: 240, y: 134, width: 1440, height: 810 },
    });
  });

  it('zooms a narrow source uniformly instead of stretching it', () => {
    expect(videoWindow({ context: 'm1', width: 608, height: 1080 }, 'allDirZoom', 'full')).toMatchObject({
      fullScreen: false,
      displayOutput: { x: 554, y: 0, width: 811, height: 1080 },
      sourceInput: { x: 0, y: 134, width: 608, height: 810 },
    });
  });

  it('boxes a forced shape inside the picture\'s box', () => {
    expect(videoWindow(hd, '4x3', 'full')).toEqual({
      context: 'm1', fullScreen: false, displayOutput: { x: 240, y: 0, width: 1440, height: 1080 },
      originalInput: { x: 0, y: 0, width: 1920, height: 1080 },
      sourceInput: { x: 0, y: 0, width: 1920, height: 1080 },
    });
    expect(videoWindow(hd, '16x9', { x: 0, y: 0, width: 800, height: 600 }))
      .toMatchObject({ displayOutput: { x: 0, y: 75, width: 800, height: 450 } });
    expect(videoWindow(hd, 'allDirZoom', preview)).toMatchObject({
      fullScreen: false, displayOutput: preview, sourceInput: { x: 240, y: 134, width: 1440, height: 810 },
    });
  });
});

describe('videoDisplay', () => {
  it('rounds a preview box and clips it to the app canvas', () => {
    expect(videoDisplay(undefined)).toBe('full');
    expect(videoDisplay({ x: -10.4, y: 1000.6, width: 200, height: 200 }))
      .toEqual({ x: 0, y: 1001, width: 190, height: 79 });
    expect(videoDisplay({ x: 0, y: 0, width: 1, height: 100 })).toBeNull();
    expect(videoDisplay({ x: 0, y: 0, width: '100', height: 100 })).toBeNull();
  });
});
