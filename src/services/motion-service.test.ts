// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAnimationMode,
} from './motion-service';

describe('motion-service', () => {
  beforeEach(() => {
    applyAnimationMode('reduced');
  });

  it('applies the selected mode to the document', () => {
    applyAnimationMode('essential');
    expect(document.documentElement.dataset.animation).toBe('essential');
  });

  it('falls back to Reduced for an invalid runtime value', () => {
    applyAnimationMode('invalid' as 'reduced');
    expect(document.documentElement.dataset.animation).toBe('reduced');
  });
});
