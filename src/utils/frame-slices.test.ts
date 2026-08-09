// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInFrameSlices } from './frame-slices';

describe('runInFrameSlices', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('yields between bounded slices until work completes', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 2;
      return now;
    });
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    let steps = 0;

    const completed = await runInFrameSlices(() => ++steps === 5, { budgetMs: 4 });

    expect(completed).toBe(true);
    expect(steps).toBe(5);
    expect(frame).toHaveBeenCalledTimes(3);
  });

  it('stops before running more work after cancellation', async () => {
    let active = true;
    let steps = 0;

    const completed = await runInFrameSlices(() => {
      steps++;
      active = false;
      return false;
    }, { shouldContinue: () => active });

    expect(completed).toBe(false);
    expect(steps).toBe(1);
  });
});
