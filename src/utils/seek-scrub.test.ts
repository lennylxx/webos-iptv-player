import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { scrubStep } from './seek-scrub';

const HOLD = CONFIG.PLAYER.SEEK_STEP_HOLD;

describe('scrubStep', () => {
  it('grows with how long one direction is held on a long timeline', () => {
    const steps = [0, HOLD - 1, HOLD, 2 * HOLD, 3 * HOLD, 4 * HOLD, 40 * HOLD].map(ms => scrubStep(ms, 4 * 3600));
    expect(steps).toEqual([10, 10, 30, 60, 120, 300, 300]);
  });

  it('caps a step at a share of a short timeline, but never below the first step', () => {
    expect(scrubStep(10 * HOLD, 3600)).toBe(180);
    expect(scrubStep(10 * HOLD, 120)).toBe(10);
    expect(scrubStep(0, 20)).toBe(10);
  });
});
