// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebVttCueTrack } from './webvtt-cue-track';

class FakeVTTCue {
  line?: number;
  align?: string;
  constructor(
    public startTime: number,
    public endTime: number,
    public text: string,
  ) {}
}

function fakeTrack() {
  const cues: FakeVTTCue[] = [];
  return {
    mode: 'disabled' as TextTrackMode,
    cues,
    addCue: (cue: FakeVTTCue) => cues.push(cue),
    removeCue: (cue: FakeVTTCue) => {
      const index = cues.indexOf(cue);
      if (index >= 0) cues.splice(index, 1);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebVttCueTrack', () => {
  it('reuses its TextTrack and applies cue settings', () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    const native = fakeTrack();
    const addTextTrack = vi.fn(() => native);
    const video = { addTextTrack } as unknown as HTMLVideoElement;
    const renderer = new WebVttCueTrack();

    renderer.attach(video, 'Subtitles', 'l1');
    renderer.attach(video, 'Subtitles', 'l1');
    expect(renderer.add(10, 12, 'Alpha', { line: 80, align: 'center' })).toBe(true);

    expect(addTextTrack).toHaveBeenCalledOnce();
    expect(native.mode).toBe('showing');
    expect(native.cues[0]).toMatchObject({
      startTime: 10,
      endTime: 12,
      text: 'Alpha',
      line: 80,
      align: 'center',
    });
  });

  it('applies an absolute offset to existing and future cues', () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    const native = fakeTrack();
    const video = { addTextTrack: () => native } as unknown as HTMLVideoElement;
    const renderer = new WebVttCueTrack();
    renderer.attach(video, 'Subtitles', 'l1');
    renderer.add(10, 12, 'Alpha');
    renderer.add(20, 22, 'Bravo');

    renderer.setOffset(2);
    expect(native.cues.map(cue => [cue.startTime, cue.endTime]))
      .toEqual([[12, 14], [22, 24]]);
    renderer.setOffset(3);
    expect(native.cues.map(cue => [cue.startTime, cue.endTime]))
      .toEqual([[13, 15], [23, 25]]);
    renderer.add(30, 32, 'Charlie');
    expect(native.cues.map(cue => [cue.startTime, cue.endTime]))
      .toEqual([[13, 15], [23, 25], [33, 35]]);
    renderer.setOffset(0);

    expect(native.cues.map(cue => [cue.startTime, cue.endTime]))
      .toEqual([[10, 12], [20, 22], [30, 32]]);
  });

  it('stores an offset before attach and applies it to future cues', () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    const native = fakeTrack();
    const video = { addTextTrack: () => native } as unknown as HTMLVideoElement;
    const renderer = new WebVttCueTrack();

    renderer.setOffset(1.5);
    renderer.attach(video, 'Subtitles', 'l1');
    renderer.add(10, 12, 'Alpha');

    expect(native.cues.map(cue => [cue.startTime, cue.endTime]))
      .toEqual([[11.5, 13.5]]);
  });

  it('prunes old cues, clears on disable and reports ownership', () => {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    const native = fakeTrack();
    const video = { addTextTrack: () => native } as unknown as HTMLVideoElement;
    const renderer = new WebVttCueTrack();
    renderer.attach(video, 'Subtitles', 'l1');
    renderer.add(1, 2, 'Alpha');
    renderer.add(10, 12, 'Bravo');

    renderer.prune(5);
    expect(native.cues.map(cue => cue.text)).toEqual(['Bravo']);
    expect(renderer.owns(native as unknown as TextTrack)).toBe(true);

    renderer.disable();
    expect(native.mode).toBe('disabled');
    expect(native.cues).toEqual([]);
  });
});

describe('WebVttCueTrack with an external clock', () => {
  function clocked() {
    vi.stubGlobal('VTTCue', FakeVTTCue);
    const timeline = fakeTrack();
    const display = fakeTrack();
    const tracks = [timeline, display];
    const video = document.createElement('video');
    const addTextTrack = vi.fn(() => tracks.shift()!);
    Object.defineProperty(video, 'addTextTrack', { value: addTextTrack });
    let now = 0;
    const renderer = new WebVttCueTrack();
    renderer.attach(video, 'Subtitles', 'l1', () => now);
    return { renderer, timeline, display, video, setNow: (t: number) => { now = t; } };
  }

  it('shows the cues active on the clock across the whole element timeline', () => {
    const { renderer, timeline, display, video, setNow } = clocked();
    renderer.add(100, 102, 'Alpha', { line: 80, align: 'start' });
    renderer.add(103, 104, 'Bravo');

    expect(timeline.mode).toBe('hidden');
    expect(display.mode).toBe('showing');
    expect(display.cues).toHaveLength(0);

    setNow(101);
    video.dispatchEvent(new Event('timeupdate'));
    expect(display.cues).toEqual([
      expect.objectContaining({ startTime: 0, text: 'Alpha', line: 80, align: 'start' }),
    ]);
    expect(display.cues[0].endTime).toBeGreaterThan(1000);

    setNow(103.5);
    video.dispatchEvent(new Event('timeupdate'));
    expect(display.cues.map(cue => cue.text)).toEqual(['Bravo']);
    expect(renderer.owns(display as unknown as TextTrack)).toBe(true);
  });

  it('shows nothing while the clock has no position', () => {
    const { renderer, display, video, setNow } = clocked();
    renderer.add(0, 5, 'Alpha');
    setNow(1);
    video.dispatchEvent(new Event('timeupdate'));
    expect(display.cues).toHaveLength(1);

    setNow(NaN);
    video.dispatchEvent(new Event('timeupdate'));
    expect(display.cues).toHaveLength(0);
  });

  it('follows the clock between element time updates', () => {
    vi.useFakeTimers();
    try {
      const { renderer, display, setNow } = clocked();
      renderer.add(10, 11, 'Alpha');

      setNow(10.5);
      vi.advanceTimersByTime(250);
      expect(display.cues.map(cue => cue.text)).toEqual(['Alpha']);

      renderer.disable();
      expect(display.cues).toHaveLength(0);
      expect(display.mode).toBe('disabled');
      setNow(10.6);
      vi.advanceTimersByTime(1000);
      expect(display.cues).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns to the element clock when attached without one', () => {
    const { renderer, timeline, display, video } = clocked();
    renderer.attach(video, 'Subtitles', 'l1');

    expect(timeline.mode).toBe('showing');
    expect(display.mode).toBe('disabled');
  });
});
