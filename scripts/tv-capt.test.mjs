import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  buildFfmpegArgs,
  parseCaptureArgs,
  temporaryRootForNodeMajor,
} from './tv-capt.mjs';

const now = new Date(2026, 8, 10, 12, 34, 56);

describe('TV capture arguments', () => {
  it('parses screenshot defaults and a generated filename', () => {
    expect(parseCaptureArgs(['screenshot'], { now })).toMatchObject({
      help: false,
      mode: 'screenshot',
      method: 'BLENDED',
      width: 1920,
      height: 1080,
      output: expect.stringMatching(/tv-screenshot-20260910-123456\.png$/),
    });
  });

  it('parses screenshot method, dimensions, and JPEG output', () => {
    expect(parseCaptureArgs([
      'screenshot',
      'screen.jpg',
      '--method', 'display',
      '--width', '1280',
      '--height', '720',
    ])).toMatchObject({
      mode: 'screenshot',
      method: 'DISPLAY',
      width: 1280,
      height: 720,
      output: expect.stringMatching(/screen\.jpg$/),
    });
  });

  it('parses recording duration, fps, and video-only capture', () => {
    expect(parseCaptureArgs([
      'record',
      'screen.mp4',
      '--duration', '2.5',
      '--fps', '8',
      '--quality', '75',
      '--method', 'video-only',
    ])).toMatchObject({
      mode: 'record',
      duration: 2.5,
      fps: 8,
      quality: 75,
      method: 'VIDEO_ONLY',
      output: expect.stringMatching(/screen\.mp4$/),
    });
  });

  it('rejects invalid modes, values, extensions, and mode-only options', () => {
    expect(() => parseCaptureArgs(['shot'])).toThrow(/mode/i);
    expect(() => parseCaptureArgs(['record', '--fps', '11'])).toThrow(/fps/i);
    expect(() => parseCaptureArgs(['record', '--duration', '301'])).toThrow(/duration/i);
    expect(() => parseCaptureArgs(['record', '--quality', '101'])).toThrow(/quality/i);
    expect(() => parseCaptureArgs(['screenshot', '--fps', '5'])).toThrow(/only valid/i);
    expect(() => parseCaptureArgs(['screenshot', 'screen.mp4'])).toThrow(/screenshot output/i);
    expect(() => parseCaptureArgs(['record', 'screen.webm'])).toThrow(/recording output/i);
    expect(() => parseCaptureArgs(['record', '--unknown'])).toThrow(/unknown option/i);
  });
});

describe('TV recording encoder', () => {
  it('builds an H.264 MP4 command with even-dimension padding', () => {
    const args = buildFfmpegArgs({
      fps: 5,
      framesDirectory: '/tmp/frames',
      output: '/tmp/out.mp4',
    });
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    expect(args).toContain(join('/tmp/frames', 'frame-%06d.jpg'));
    expect(args.at(-1)).toBe('/tmp/out.mp4');
  });
});

describe('TV temporary directory', () => {
  it('uses the developer path for webOS 26 runtimes', () => {
    expect(temporaryRootForNodeMajor(12)).toBe('/tmp');
    expect(temporaryRootForNodeMajor(16)).toBe('/tmp');
    expect(temporaryRootForNodeMajor(20)).toBe('/media/developer/temp');
  });
});
