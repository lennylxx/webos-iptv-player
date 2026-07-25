import { describe, it, expect } from 'vitest';
import { dvrWindow, dvrState } from './dvr';

function ranges(...pairs: Array<[number, number]>) {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  };
}

describe('dvrWindow', () => {
  it('returns null for a finite duration (catch-up/VOD, not live)', () => {
    expect(dvrWindow(ranges([0, 120]), 120, 5)).toBeNull();
  });

  it('returns null for a NaN duration (metadata not ready yet)', () => {
    expect(dvrWindow(ranges([0, 60]), NaN, 5)).toBeNull();
  });

  it('returns null when seekable is empty', () => {
    expect(dvrWindow(ranges(), Infinity, 5)).toBeNull();
  });

  it('returns null when seekable is missing', () => {
    expect(dvrWindow(null, Infinity, 5)).toBeNull();
  });

  it('returns null when the window is at or below the minimum floor', () => {
    expect(dvrWindow(ranges([100, 103]), Infinity, 5)).toBeNull();
  });

  it('returns null for non-finite seekable bounds reported by a native pipeline', () => {
    expect(dvrWindow(ranges([0, Infinity]), Infinity, 5)).toBeNull();
    expect(dvrWindow(ranges([-Infinity, 60]), Infinity, 5)).toBeNull();
    expect(dvrWindow(ranges([NaN, 60]), Infinity, 5)).toBeNull();
  });

  it('returns the window for a live stream with a usable range', () => {
    expect(dvrWindow(ranges([10, 70]), Infinity, 5)).toEqual({ start: 10, end: 70, length: 60 });
  });

  it('uses the last range (the one at the live edge) when several exist', () => {
    expect(dvrWindow(ranges([0, 5], [100, 200]), Infinity, 5)).toEqual({ start: 100, end: 200, length: 100 });
  });
});

describe('dvrState', () => {
  const win = { start: 10, end: 70, length: 60 };

  it('computes fraction and behind-live for a mid-window position', () => {
    const s = dvrState(win, 40, 12);
    expect(s.position).toBe(40);
    expect(s.fraction).toBeCloseTo(0.5, 5);
    expect(s.behindLive).toBe(30);
    expect(s.atLiveEdge).toBe(false);
  });

  it('flags atLiveEdge when within the tolerance of the edge', () => {
    const s = dvrState(win, 62, 12); // 8s behind, <= 12
    expect(s.atLiveEdge).toBe(true);
    expect(s.behindLive).toBe(8);
  });

  it('clamps a position that rolled below the window start (paused too long)', () => {
    const s = dvrState(win, 4, 12);
    expect(s.position).toBe(10);
    expect(s.fraction).toBe(0);
    expect(s.behindLive).toBe(60);
    expect(s.atLiveEdge).toBe(false);
  });

  it('clamps a position beyond the end to the live edge', () => {
    const s = dvrState(win, 80, 12);
    expect(s.position).toBe(70);
    expect(s.fraction).toBe(1);
    expect(s.behindLive).toBe(0);
    expect(s.atLiveEdge).toBe(true);
  });
});
