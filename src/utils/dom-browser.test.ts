// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

type Focus = (this: HTMLElement, options?: FocusOptions) => void;

let list: HTMLElement;
let option: HTMLElement;
let logs: MockInstance<typeof console.log>;

// Stands in for an engine's focus(): it scrolls the list to the target unless
// it both reads and honors `preventScroll`.
function engineFocus(readsPreventScroll: boolean): ReturnType<typeof vi.fn> {
  const native = HTMLElement.prototype.focus;
  const focus = vi.fn(function (this: HTMLElement, options?: FocusOptions) {
    native.call(this);
    if (readsPreventScroll && options?.preventScroll) return;
    if (this === option) list.scrollTop = 700;
  });
  HTMLElement.prototype.focus = focus as unknown as Focus;
  return focus;
}

async function load(): Promise<typeof import('./dom')> {
  vi.resetModules();
  return import('./dom');
}

const originalFocus = HTMLElement.prototype.focus;

beforeEach(() => {
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  list = document.createElement('div');
  option = document.createElement('button');
  list.appendChild(option);
  document.body.appendChild(list);
  list.scrollTop = 40;
});

afterEach(() => {
  HTMLElement.prototype.focus = originalFocus;
  logs.mockRestore();
  document.body.innerHTML = '';
});

describe('focusWithoutScroll', () => {
  it('restores scroll offsets on an engine that ignores preventScroll', async () => {
    engineFocus(false);
    const { focusWithoutScroll } = await load();

    focusWithoutScroll(option);

    expect(document.activeElement).toBe(option);
    expect(list.scrollTop).toBe(40);
  });

  it('uses the native option where the engine reads it', async () => {
    const focus = engineFocus(true);
    const { focusWithoutScroll } = await load();

    focusWithoutScroll(option);

    expect(document.activeElement).toBe(option);
    expect(list.scrollTop).toBe(40);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('detects support once and logs it for tv.sh diag', async () => {
    engineFocus(false);
    const { focusWithoutScroll } = await load();

    focusWithoutScroll(option);
    focusWithoutScroll(option);

    expect(logs.mock.calls.map((args) => args.join(' '))).toEqual([
      '[Dom] Focus option detected event=compat.focus.preventScroll supported=0',
    ]);
  });
});

describe('onceTransitionEnd', () => {
  it('runs the callback on the first transitionend only and detaches', async () => {
    const { onceTransitionEnd } = await load();
    const remove = vi.spyOn(list, 'removeEventListener');
    const callback = vi.fn();

    onceTransitionEnd(list, callback);
    list.dispatchEvent(new Event('transitionend'));
    list.dispatchEvent(new Event('transitionend'));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('transitionend', expect.any(Function));
  });

  it('stops waiting when canceled', async () => {
    const { onceTransitionEnd } = await load();
    const callback = vi.fn();

    const cancel = onceTransitionEnd(list, callback);
    cancel();
    list.dispatchEvent(new Event('transitionend'));

    expect(callback).not.toHaveBeenCalled();
  });
});
