import { CONFIG } from '../config';

/** Seconds one press moves the scrub target after one direction has been held
 *  for `heldMs`. Steps grow with time, not press count, so a remote's key
 *  repeat rate does not set the speed; a step never exceeds a fixed share of
 *  the seekable span, so a short program keeps fine control. */
export function scrubStep(heldMs: number, span: number): number {
  const steps = CONFIG.PLAYER.SEEK_STEPS;
  const tier = Math.floor(Math.max(0, heldMs) / CONFIG.PLAYER.SEEK_STEP_HOLD);
  const step = steps[Math.min(tier, steps.length - 1)];
  const cap = Math.max(steps[0], span * CONFIG.PLAYER.SEEK_MAX_STEP_FRACTION);
  return Math.min(step, cap);
}
