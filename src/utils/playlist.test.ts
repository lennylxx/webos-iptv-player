import { describe, expect, it } from 'vitest';
import { playlistLoadFraction } from './playlist';

const SCALE = 1000;

describe('playlistLoadFraction', () => {
  it('measures a source of known size against its total', () => {
    expect(playlistLoadFraction(
      { sourceNumber: 1, sourceCount: 1, inputBytes: 250, totalBytes: 1000 }, SCALE,
    )).toBe(0.25);
  });

  it('eases a source of unknown or overrun size without reaching the end', () => {
    const unknown = (inputBytes: number, totalBytes?: number) => playlistLoadFraction(
      { sourceNumber: 1, sourceCount: 1, inputBytes, ...(totalBytes ? { totalBytes } : {}) }, SCALE,
    );
    expect(unknown(1000)).toBeCloseTo(1 - Math.exp(-1));
    expect(unknown(1000)).toBeGreaterThan(unknown(500));
    expect(unknown(1e9)).toBe(0.95);
    expect(unknown(1500, 1000)).toBe(unknown(1500));
  });

  it('splits the bar evenly across sources', () => {
    expect(playlistLoadFraction(
      { sourceNumber: 2, sourceCount: 4, inputBytes: 500, totalBytes: 1000 }, SCALE,
    )).toBe(0.375);
  });
});
