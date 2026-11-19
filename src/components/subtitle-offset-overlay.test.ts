// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SubtitleOffsetOverlay } from './subtitle-offset-overlay';
import { Focus } from '../navigation/focus-scope';

afterEach(() => {
  Focus.uninstall();
  document.body.innerHTML = '';
});

function make() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onChange = vi.fn();
  const overlay = new SubtitleOffsetOverlay(el, onChange, vi.fn());
  return { el, onChange, overlay };
}

describe('SubtitleOffsetOverlay', () => {
  it('opens showing the seeded value', () => {
    const { el, overlay } = make();
    overlay.open(0.5);
    expect(overlay.visible).toBe(true);
    expect(el.querySelector('.subs-offset-value')?.textContent).toBe('+0.50 s');
  });

  it('nudges right/left by the step and fires onChange', () => {
    const { el, onChange, overlay } = make();
    overlay.open(0);
    overlay.handleAction('right');
    expect(onChange).toHaveBeenLastCalledWith(0.25);
    overlay.handleAction('left');
    overlay.handleAction('left');
    expect(onChange).toHaveBeenLastCalledWith(-0.25);
    expect(el.querySelector('.subs-offset-value')?.textContent).toBe('-0.25 s');
  });

  it('does not fire onChange past the clamp edge', () => {
    const { onChange, overlay } = make();
    overlay.open(60);
    overlay.handleAction('right');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resets to zero on select and on a Reset click', () => {
    const { el, onChange, overlay } = make();
    overlay.open(2);
    overlay.handleAction('select');
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(el.querySelector('.subs-offset-value')?.textContent).toBe('0.00 s');
    overlay.open(2);
    (el.querySelector('[data-offset-reset]') as HTMLElement).click();
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('rings its Reset control while open', () => {
    const { el, overlay } = make();
    overlay.open(1);
    Focus.flush();
    expect(Array.from(el.querySelectorAll('.focused'))).toEqual([el.querySelector('[data-offset-reset]')]);
  });

  it('closes on back', () => {
    const { overlay } = make();
    overlay.open(1);
    overlay.handleAction('back');
    expect(overlay.visible).toBe(false);
  });
});
