// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../config';
import type { Action, NumberEvent } from '../types';

// KeyHandler attaches its listeners to `document` and keeps module-level singleton
// state. init() must run only once (re-running would stack duplicate listeners),
// so we init in beforeAll and just swap the active handler per test.
let KeyHandler: typeof import('./key-handler').KeyHandler;
let handler: ReturnType<typeof vi.fn>;

const K = CONFIG.KEYS;

function press(keyCode: number, target: EventTarget = document): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode, bubbles: true, cancelable: true } as KeyboardEventInit),
  );
}

function wheel(deltaY: number, target: EventTarget = document.body): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
}

describe('KeyHandler', () => {
  beforeAll(async () => {
    ({ KeyHandler } = await import('./key-handler'));
    KeyHandler.init();
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
    handler = vi.fn();
    KeyHandler.setHandler(handler as (a: Action, e?: NumberEvent) => void);
    KeyHandler.setChannelCount(() => 0); // module state persists: back to "unknown"
    // Same reason: a half-typed number left buffered by the previous test would
    // prepend its digits to this one. Any non-digit key abandons it.
    press(K.BACK);
    handler.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('remote key mapping', () => {
    it.each([
      [K.UP, 'up'],
      [K.DOWN, 'down'],
      [K.LEFT, 'left'],
      [K.RIGHT, 'right'],
      [K.ENTER, 'select'],
      [K.BACK, 'back'],
      [K.ESC, 'back'], // Escape on desktop
      [K.RED, 'red'],
      [K.GREEN, 'green'],
      [K.YELLOW, 'yellow'],
      [K.BLUE, 'blue'],
      [K.CH_UP, 'channel_up'],
      [K.CH_DOWN, 'channel_down'],
      [K.PLAY, 'play'],
      [K.PAUSE, 'pause'],
      [K.STOP, 'stop'],
    ])('maps keyCode %i to action "%s"', (keyCode, action) => {
      press(keyCode);
      expect(handler).toHaveBeenCalledWith(action);
    });

    it('ignores unmapped keys', () => {
      press(999);
      expect(handler).not.toHaveBeenCalled();
    });

    // Text-editing keys stay with a focused input: digits are typed into the
    // query, arrows move the caret, and the channel-list's own listener handles
    // Enter/ArrowDown/Escape to leave the search box.
    it.each([
      [K.UP], [K.DOWN], [K.LEFT], [K.RIGHT], [K.ENTER], [K.ESC], [K.NUM_0 + 5],
    ])('keeps text-editing key %i with a focused input (no app action)', (keyCode) => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      press(keyCode, input);
      expect(handler).not.toHaveBeenCalled();
    });

    // Dedicated remote-control buttons must still reach the app even while the
    // search box has focus — otherwise Back can't exit, Red/Blue can't open
    // EPG/Settings, etc.
    it.each([
      [K.BACK, 'back'],
      [K.RED, 'red'],
      [K.GREEN, 'green'],
      [K.YELLOW, 'yellow'],
      [K.BLUE, 'blue'],
      [K.CH_UP, 'channel_up'],
      [K.CH_DOWN, 'channel_down'],
      [K.PLAY, 'play'],
      [K.PAUSE, 'pause'],
      [K.STOP, 'stop'],
    ])('routes remote-control key %i to the app as "%s" from a focused input', (keyCode, action) => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      press(keyCode, input);
      expect(handler).toHaveBeenCalledWith(action);
    });

    it('routes Back to the app from a focused textarea', () => {
      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      press(K.BACK, ta);
      expect(handler).toHaveBeenCalledWith('back');
    });
  });

  describe('channel number entry', () => {
    it('echoes each digit as it is typed, before the flush', () => {
      press(K.NUM_0 + 2);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 2, digits: '2' });
      press(K.NUM_0 + 1);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 21, digits: '21' });
      press(K.NUM_0 + 5);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 215, digits: '215' });

      // Still one tune, after the timeout.
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(handler).toHaveBeenCalledWith('number', { number: 215 });
    });

    it('buffers consecutive digits and fires a single number action', () => {
      const tunes = () => handler.mock.calls.filter(([action]) => action === 'number');
      press(K.NUM_0 + 4);
      press(K.NUM_0 + 2);
      expect(tunes()).toHaveLength(0); // waits for the timeout (only echoes so far)
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(tunes()).toHaveLength(1);
      expect(handler).toHaveBeenCalledWith('number', { number: 42 });
    });

    it('resets the timeout while digits keep coming', () => {
      press(K.NUM_0 + 1);
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT - 1);
      press(K.NUM_0 + 7);
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT - 1);
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledWith('number', { number: 17 });
    });

    it('ignores digits past the width of the channel count', () => {
      KeyHandler.setChannelCount(() => 350);
      press(K.NUM_0 + 2);
      press(K.NUM_0 + 1);
      press(K.NUM_0 + 5);
      // The fourth digit cannot reach a channel, so it never joins the buffer.
      press(K.NUM_0 + 9);
      expect(handler).not.toHaveBeenCalledWith('number_input', { number: 2159, digits: '2159' });

      // And the wait still belongs to the number that was typed.
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(handler).toHaveBeenCalledWith('number', { number: 215 });
    });

    it('starts a fresh number after the capped one tunes', () => {
      KeyHandler.setChannelCount(() => 99);
      press(K.NUM_0 + 4);
      press(K.NUM_0 + 2);
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(handler).toHaveBeenCalledWith('number', { number: 42 });
      press(K.NUM_0 + 7);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 7, digits: '7' });
    });

    it('falls back to a fixed cap until the channel count is known', () => {
      for (const d of [1, 2, 3, 4]) press(K.NUM_0 + d);
      press(K.NUM_0 + 5);
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(handler).toHaveBeenCalledWith('number', { number: 1234 });
    });

    it('abandons a half-typed number when another key is pressed', () => {
      press(K.NUM_0 + 2);
      press(K.NUM_0 + 1);
      press(K.UP);
      expect(handler).toHaveBeenCalledWith('number_cancel');
      expect(handler).toHaveBeenCalledWith('up');

      // The abandoned digits must not merge into what comes next.
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      press(K.NUM_0 + 5);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 5, digits: '5' });
    });

    it('does not announce a cancel when no number is being typed', () => {
      press(K.UP);
      expect(handler).not.toHaveBeenCalledWith('number_cancel');
    });
  });

  // `scripts/tv.sh diag` reads these console lines back into its input timeline,
  // so parse the real output with the real extractor: a "dead button" report is
  // only answerable if the press, the mapping, and the buffer flush are visible.
  describe('diagnostic logging', () => {
    it('emits key events that the tv-diag input timeline can parse', async () => {
      const { extractInputTimeline } = await import('../../scripts/tv-diag.mjs');
      const lines: Array<{ observedAt: string; level: string; text: string }> = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push({
          observedAt: '2026-01-01T00:00:00.000Z',
          level: 'log',
          text: args.map(String).join(' '),
        });
      });

      press(K.NUM_0 + 4);
      vi.advanceTimersByTime(CONFIG.PLAYER.CHANNEL_NUMBER_TIMEOUT);
      press(K.RED);
      press(4242); // a code this remote map has no entry for
      const input = document.createElement('input');
      document.body.appendChild(input);
      press(K.NUM_0 + 1, input);
      spy.mockRestore();

      expect(extractInputTimeline(lines)).toEqual([
        expect.objectContaining({
          event: 'key.down', code: K.NUM_0 + 4, action: 'number', target: 'app',
        }),
        expect.objectContaining({ event: 'key.number', number: 4 }),
        expect.objectContaining({ event: 'key.down', code: K.RED, action: 'red', target: 'app' }),
        expect.objectContaining({ event: 'key.down', code: 4242, action: 'unmapped' }),
        // Never the code: it would spell out what is being typed.
        expect.objectContaining({ event: 'key.down', code: null, target: 'text_input' }),
        expect.objectContaining({ event: 'key.ignored', reason: 'text_input', code: null }),
      ]);
    });

    it('logs a press a focused component swallows before it can bubble', () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });

      // Search boxes, the list editor and the EPG grid all stop propagation.
      const swallower = document.createElement('div');
      document.body.appendChild(swallower);
      swallower.addEventListener('keydown', (e) => { e.stopPropagation(); });
      press(K.RED, swallower);
      spy.mockRestore();

      expect(lines).toContainEqual(
        expect.stringContaining(`event=key.down code=${String(K.RED)} action=red`));
      expect(handler).not.toHaveBeenCalledWith('red', expect.anything());
    });

    it('keeps a remote button\'s code while a text field has focus', () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });

      const input = document.createElement('input');
      document.body.appendChild(input);
      press(K.BACK, input);
      spy.mockRestore();

      expect(lines).toContainEqual(
        expect.stringContaining(`event=key.down code=${String(K.BACK)}`));
    });
  });

  describe('Magic Remote pointer (mouse)', () => {
    it('dispatches nav:hover when the pointer moves over a focusable element', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);

      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
    });

    it('dispatches nav:hover once while moving within one focusable (skips its children)', () => {
      const row = document.createElement('div');
      row.setAttribute('data-focusable', '');
      const child1 = document.createElement('span');
      const child2 = document.createElement('span');
      row.append(child1, child2);
      document.body.appendChild(row);
      const onHover = vi.fn();
      row.addEventListener('nav:hover', onHover);

      child1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      child2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
    });

    it('dispatches nav:hover again when the pointer moves to a different focusable', () => {
      const a = document.createElement('div'); a.setAttribute('data-focusable', '');
      const b = document.createElement('div'); b.setAttribute('data-focusable', '');
      document.body.append(a, b);
      const onA = vi.fn(); const onB = vi.fn();
      a.addEventListener('nav:hover', onA);
      b.addEventListener('nav:hover', onB);

      a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).toHaveBeenCalledTimes(1);
    });

    it('dispatches nav:unhover when the pointer leaves a focusable element', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      const outside = document.createElement('div');
      document.body.append(el, outside);
      const onUnhover = vi.fn();
      el.addEventListener('nav:unhover', onUnhover);

      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      outside.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onUnhover).toHaveBeenCalledTimes(1);
    });

    it('keeps hover while the pointer moves between children of one focusable', () => {
      const row = document.createElement('div');
      row.setAttribute('data-focusable', '');
      const child1 = document.createElement('span');
      const child2 = document.createElement('span');
      row.append(child1, child2);
      document.body.appendChild(row);
      const onUnhover = vi.fn();
      row.addEventListener('nav:unhover', onUnhover);

      child1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      child2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onUnhover).not.toHaveBeenCalled();
    });

    it('does not dispatch nav:hover over non-focusable elements', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);

      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).not.toHaveBeenCalled();
    });

    it('focuses then selects when a focusable element is clicked', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);

      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled(); // select is deferred

      vi.advanceTimersByTime(0);
      expect(handler).toHaveBeenCalledWith('select');
    });

    it('ignores clicks inside a data-self-activate subtree (it handles its own)', () => {
      const sidebar = document.createElement('div');
      sidebar.setAttribute('data-self-activate', '');
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      sidebar.appendChild(el);
      document.body.appendChild(sidebar);

      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      vi.advanceTimersByTime(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not fire a deferred select when the click already removed its target', () => {
      // The clicked control deletes itself mid-click (see key-handler.ts); the
      // detached-target guard, not the skip marker, prevents the spurious select.
      const view = document.createElement('div');
      const btn = document.createElement('button');
      btn.setAttribute('data-focusable', '');
      btn.addEventListener('click', () => btn.remove());
      view.appendChild(btn);
      document.body.appendChild(view);

      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      vi.advanceTimersByTime(0);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Magic Remote scroll wheel', () => {
    it('scrolling down changes channel down, up changes channel up', () => {
      wheel(120);
      expect(handler).toHaveBeenLastCalledWith('channel_down');
      wheel(-120);
      expect(handler).toHaveBeenLastCalledWith('channel_up');
    });

    it('swallows the first scroll after a 5s idle period (cursor re-activation)', () => {
      wheel(120); // warmed up by default → acts
      expect(handler).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000); // idle → next scroll only re-activates
      wheel(120);
      expect(handler).toHaveBeenCalledTimes(1); // swallowed

      wheel(120); // now warmed again → acts
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('lets a scrollable ancestor scroll natively instead of changing channel', () => {
      const scroller = document.createElement('div');
      scroller.style.overflowY = 'scroll';
      Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
      const child = document.createElement('div');
      scroller.appendChild(child);
      document.body.appendChild(scroller);

      wheel(120, child);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
