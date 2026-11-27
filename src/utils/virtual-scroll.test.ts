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

  it('keeps a settling smooth scroll its own until it lands, without rewriting it', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');
    guard.syncOffset(element, 'vertical', 300, false, true);
    // Mid-scroll, past the two correction frames.
    vi.advanceTimersByTime(100);
    element.scrollTop = 120;
    expect(guard.readUserOffset(element, 'vertical')).toBeNull();
    expect(element.scrollTop).toBe(120);
    element.scrollTop = 300;
    expect(guard.readUserOffset(element, 'vertical')).toBeNull();
    element.scrollTop = 250;
    expect(guard.readUserOffset(element, 'vertical')).toBe(250);
  });

  it('reads an offset past a settling scroll\'s path as the user\'s', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');
    guard.syncOffset(element, 'vertical', 300, false, true);
    element.scrollTop = 500;
    expect(guard.readUserOffset(element, 'vertical')).toBe(500);
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

  it('keeps a scroll made after release, and reads it as the user offset', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');
    guard.syncOffset(element, 'vertical', 300);

    guard.release(element);
    element.scrollTop = 368;
    vi.advanceTimersByTime(20);

    expect(element.scrollTop).toBe(368);
    expect(guard.readUserOffset(element, 'vertical')).toBe(368);
  });

  it('cancels a pending correction when the desired offset is already applied', () => {
    const guard = new VirtualScrollGuard();
    const element = document.createElement('div');

    guard.syncOffset(element, 'vertical', 300);
    element.scrollTop = 0;
    guard.syncOffset(element, 'vertical', 0);
    vi.advanceTimersByTime(20);

    expect(element.scrollTop).toBe(0);
  });

  function smoothList(clientHeight: number): { element: HTMLElement; writes: string[] } {
    const element = document.createElement('div');
    document.body.appendChild(element);
    element.style.setProperty('scroll-behavior', 'smooth');
    Object.defineProperty(element, 'clientHeight', { value: clientHeight });
    const writes: string[] = [];
    let top = 0;
    Object.defineProperty(element, 'scrollTop', {
      get: () => top,
      set: (value: number) => {
        writes.push(element.style.getPropertyValue('scroll-behavior'));
        top = value;
      },
    });
    return { element, writes };
  }

  it('jumps past a viewport instantly despite smooth scrolling', () => {
    const debug = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const guard = new VirtualScrollGuard();
    const { element, writes } = smoothList(500);

    guard.syncOffset(element, 'vertical', 4000);
    vi.advanceTimersByTime(20);

    expect(writes).toEqual(['auto', 'auto']);
    expect(element.style.getPropertyValue('scroll-behavior')).toBe('smooth');
    expect(debug.mock.calls.flat().join(' ')).toContain('event=scroll.jump.instant');
    debug.mockRestore();
  });

  it('leaves a step within the viewport to the smooth scroll policy', () => {
    const guard = new VirtualScrollGuard();
    const { element, writes } = smoothList(500);

    guard.syncOffset(element, 'vertical', 300);

    expect(writes).toEqual(['smooth']);
  });
});
