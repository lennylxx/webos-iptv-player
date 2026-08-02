// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualScrollGuard } from './virtual-scroll';

describe('VirtualScrollGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores scroll events caused by a programmatic offset', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');

    guard.syncOffset(element, 'vertical', 400);

    expect(element.scrollTop).toBe(400);
    expect(guard.readUserOffset(element, 'vertical')).toBeNull();
  });

  it('accepts user offsets after the programmatic correction frames', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');
    guard.syncOffset(element, 'horizontal', 600);

    vi.advanceTimersByTime(40);
    element.scrollLeft = 900;

    expect(guard.readUserOffset(element, 'horizontal')).toBe(900);
  });

  it('restores the requested offset on the next frame', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');
    guard.syncOffset(element, 'vertical', 300);
    element.scrollTop = 360;

    vi.advanceTimersByTime(20);

    expect(element.scrollTop).toBe(300);
  });
});
