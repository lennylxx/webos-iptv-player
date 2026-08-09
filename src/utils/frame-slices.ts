export interface FrameSliceOptions {
  budgetMs?: number;
  shouldContinue?: () => boolean;
}

const DEFAULT_FRAME_BUDGET_MS = 6;

/**
 * Run synchronous work in bounded animation-frame slices. `step` returns true
 * when the work is complete; false means another unit remains.
 */
export function runInFrameSlices(
  step: () => boolean,
  options: FrameSliceOptions = {},
): Promise<boolean> {
  const budgetMs = options.budgetMs ?? DEFAULT_FRAME_BUDGET_MS;
  const shouldContinue = options.shouldContinue ?? (() => true);

  return new Promise((resolve) => {
    const run = (): void => {
      if (!shouldContinue()) {
        resolve(false);
        return;
      }

      const startedAt = performance.now();
      do {
        if (step()) {
          resolve(true);
          return;
        }
        if (!shouldContinue()) {
          resolve(false);
          return;
        }
      } while (performance.now() - startedAt < budgetMs);

      requestAnimationFrame(run);
    };

    requestAnimationFrame(run);
  });
}
