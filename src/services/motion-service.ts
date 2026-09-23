export const ANIMATION_MODES = ['essential', 'reduced', 'full'] as const;
export type AnimationMode = typeof ANIMATION_MODES[number];

export const DEFAULT_ANIMATION_MODE: AnimationMode = 'reduced';

export function isAnimationMode(value: unknown): value is AnimationMode {
  return typeof value === 'string'
    && ANIMATION_MODES.includes(value as AnimationMode);
}

export function applyAnimationMode(mode: AnimationMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.animation = isAnimationMode(mode)
      ? mode
      : DEFAULT_ANIMATION_MODE;
  }
}
