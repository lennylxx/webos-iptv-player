// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import type { Action, NumberEvent } from '../types';
import { Focus, type FocusScope } from './focus-scope';

// KeyHandler attaches its listeners to `document` and keeps module-level singleton
// state. init() must run only once (re-running would stack duplicate listeners),
// so we init in beforeAll and just swap the active handler per test.
let KeyHandler: typeof import('./key-handler').KeyHandler;
let InputMode: typeof import('./input-mode').InputMode;
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
    ({ InputMode } = await import('./input-mode'));
    KeyHandler.init();
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
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

  // Must run before any other test moves the pointer: module state persists.
  describe('keyboard-nav root class', () => {
    const root = document.documentElement;
    const move = (screenX: number, screenY: number): void => {
      document.dispatchEvent(new MouseEvent('mousemove', { screenX, screenY, bubbles: true }));
    };

    it('ignores a mouseover before the pointer ever moved, and still seeds on the next mousemove', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);
      press(K.DOWN);
      el.dispatchEvent(new MouseEvent('mouseover', { screenX: 100, screenY: 100, bubbles: true }));
      expect(onHover).not.toHaveBeenCalled();
      expect(root.classList.contains('keyboard-nav')).toBe(true);
    });

    it('keeps keyboard-nav through the first synthetic mousemove after startup', () => {
      press(K.DOWN);
      expect(root.classList.contains('keyboard-nav')).toBe(true);
      const onMove = vi.fn();
      document.addEventListener('nav:pointermove', onMove);
      try {
        move(100, 100);
      } finally {
        document.removeEventListener('nav:pointermove', onMove);
      }
      expect(root.classList.contains('keyboard-nav')).toBe(true);
      // The seed may be a render under a cursor resting at a screen edge.
      expect(onMove).not.toHaveBeenCalled();
    });

    it('keeps keyboard-nav when a mousemove repeats the resting position', () => {
      press(K.DOWN);
      move(100, 100);
      expect(root.classList.contains('keyboard-nav')).toBe(true);
    });

    it('drops keyboard-nav once the pointer actually moves', () => {
      press(K.DOWN);
      move(104, 100);
      expect(root.classList.contains('keyboard-nav')).toBe(false);
    });

    // A Back right after the pointer doesn't hide the player OSD, which the
    // cursor would re-reveal; once webOS hid the cursor, nothing re-reveals it.
    it('counts a key as after the pointer only while the cursor shows', () => {
      const seen: boolean[] = [];
      KeyHandler.setHandler(() => { seen.push(InputMode.keyAfterPointer); });
      press(K.DOWN);
      move(108, 100);
      press(K.BACK);
      move(112, 100);
      press(K.CURSOR_HIDE);
      press(K.BACK);
      move(116, 100);
      press(K.CURSOR_HIDE);
      press(K.CURSOR_SHOW);
      press(K.BACK);
      expect(seen).toEqual([false, true, false, true]);
    });

    it('counts a key as after the pointer once the pointer moves after the cursor hid', () => {
      const seen: boolean[] = [];
      KeyHandler.setHandler(() => { seen.push(InputMode.keyAfterPointer); });
      move(120, 100);
      press(K.CURSOR_HIDE);
      move(124, 100);
      press(K.BACK);
      expect(seen).toEqual([true]);
    });

    it('stops counting a key as after the pointer once cursorStateChange hides the cursor', () => {
      const seen: boolean[] = [];
      KeyHandler.setHandler(() => { seen.push(InputMode.keyAfterPointer); });
      const cursor = (visibility: boolean) => document.dispatchEvent(
        new CustomEvent('cursorStateChange', { detail: { visibility } }));
      move(126, 100);
      move(128, 100);
      cursor(false);
      press(K.BACK);
      move(132, 100);
      cursor(false);
      cursor(true);
      press(K.BACK);
      expect(seen).toEqual([false, true]);
    });
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
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(handler).toHaveBeenCalledWith('number', { number: 215 });
    });

    it('buffers consecutive digits and fires a single number action', () => {
      const tunes = () => handler.mock.calls.filter(([action]) => action === 'number');
      press(K.NUM_0 + 4);
      press(K.NUM_0 + 2);
      expect(tunes()).toHaveLength(0); // waits for the timeout (only echoes so far)
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(tunes()).toHaveLength(1);
      expect(handler).toHaveBeenCalledWith('number', { number: 42 });
    });

    it('resets the timeout while digits keep coming', () => {
      press(K.NUM_0 + 1);
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS - 1);
      press(K.NUM_0 + 7);
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS - 1);
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledWith('number', { number: 17 });
    });

    it('uses the configured number entry timeout', () => {
      StorageService.setNumberEntryOsdTimeoutMs(1800);
      press(K.NUM_0 + 4);
      vi.advanceTimersByTime(1799);
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledWith('number', { number: 4 });
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
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(handler).toHaveBeenCalledWith('number', { number: 215 });
    });

    it('starts a fresh number after the capped one tunes', () => {
      KeyHandler.setChannelCount(() => 99);
      press(K.NUM_0 + 4);
      press(K.NUM_0 + 2);
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(handler).toHaveBeenCalledWith('number', { number: 42 });
      press(K.NUM_0 + 7);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 7, digits: '7' });
    });

    it('falls back to a fixed cap until the channel count is known', () => {
      for (const d of [1, 2, 3, 4]) press(K.NUM_0 + d);
      press(K.NUM_0 + 5);
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(handler).toHaveBeenCalledWith('number', { number: 1234 });
    });

    it('abandons a half-typed number when another key is pressed', () => {
      press(K.NUM_0 + 2);
      press(K.NUM_0 + 1);
      press(K.UP);
      expect(handler).toHaveBeenCalledWith('number_cancel');
      expect(handler).toHaveBeenCalledWith('up');

      // The abandoned digits must not merge into what comes next.
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      expect(handler).not.toHaveBeenCalledWith('number', expect.anything());
      press(K.NUM_0 + 5);
      expect(handler).toHaveBeenCalledWith('number_input', { number: 5, digits: '5' });
    });

    it('does not announce a cancel when no number is being typed', () => {
      press(K.UP);
      expect(handler).not.toHaveBeenCalledWith('number_cancel');
    });
  });

  // `scripts/tv.sh diag` prints these console lines verbatim: a "dead button"
  // report is only answerable if the press, the mapping, and the buffer flush
  // are visible.
  describe('diagnostic logging', () => {
    it('emits key events for tv.sh diag', () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });

      press(K.NUM_0 + 4);
      vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_NUMBER_ENTRY_OSD_TIMEOUT_MS);
      press(K.RED);
      press(4242); // a code this remote map has no entry for
      const input = document.createElement('input');
      document.body.appendChild(input);
      press(K.NUM_0 + 1, input);
      spy.mockRestore();

      const events = lines.filter((line) => line.includes('event=key.'));
      expect(events).toEqual([
        expect.stringMatching(new RegExp(
          `event=key\\.down code=${String(K.NUM_0 + 4)} action=number target=app\\b`)),
        expect.stringMatching(/event=key\.number number=4\b/),
        expect.stringMatching(new RegExp(
          `event=key\\.down code=${String(K.RED)} action=red target=app\\b`)),
        expect.stringMatching(/event=key\.down code=4242 action=unmapped\b/),
        expect.stringMatching(/event=key\.down code=hidden .*target=text_input/),
        expect.stringMatching(/event=key\.ignored reason=text_input/),
      ]);
      // Never the code while typing: it would spell out what is being typed.
      expect(events.slice(4).join('\n')).not.toMatch(/\bcode=\d/);
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
    it('ignores hover from content moving under a resting pointer after a key press', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);
      const over = (screenX: number, screenY: number): void => {
        el.dispatchEvent(new MouseEvent('mouseover', { screenX, screenY, bubbles: true }));
      };
      document.dispatchEvent(new MouseEvent('mousemove', { screenX: 300, screenY: 300, bubbles: true }));
      press(K.DOWN);

      over(300, 300);
      expect(onHover).not.toHaveBeenCalled();
      over(320, 300);
      expect(onHover).toHaveBeenCalledTimes(1);
    });

    describe('after the D-pad takes over', () => {
      let screenX = 1000;
      const focusable = (): HTMLElement => {
        const el = document.createElement('div');
        el.setAttribute('data-focusable', '');
        document.body.appendChild(el);
        return el;
      };
      const pointer = (type: string, target: EventTarget, x: number): void => {
        target.dispatchEvent(new MouseEvent(type, { screenX: x, screenY: 500, bubbles: true }));
      };
      // Each test starts with the pointer resting somewhere new, after a real move.
      const restPointerOver = (target: EventTarget): number => {
        screenX += 50;
        pointer('mousemove', target, screenX - 10);
        pointer('mouseover', target, screenX);
        pointer('mousemove', target, screenX);
        return screenX;
      };

      const scroller = (): HTMLElement => {
        const el = document.createElement('div');
        el.style.overflowY = 'auto';
        Object.defineProperty(el, 'scrollHeight', { value: 1000 });
        Object.defineProperty(el, 'clientHeight', { value: 100 });
        document.body.appendChild(el);
        return el;
      };

      it('leaves key mode on the mouseout and mouseover of a real move, before its mousemove', () => {
        const from = focusable();
        const to = focusable();
        const x = restPointerOver(from);
        press(K.DOWN);
        const seen: string[] = [];
        const mode = () => (document.documentElement.classList.contains('keyboard-nav') ? 'keys' : 'pointer');
        const onOut = () => seen.push(`out:${mode()}`);
        document.addEventListener('mouseout', onOut);
        to.addEventListener('nav:hover', () => seen.push(`hover:${mode()}`));
        pointer('mouseout', from, x + 20);
        press(K.DOWN);
        pointer('mouseover', to, x + 20);
        document.removeEventListener('mouseout', onOut);
        expect(seen).toEqual(['out:pointer', 'hover:pointer']);
      });

      it('still ignores the mouseout and mouseover of content moving under a resting pointer', () => {
        const from = focusable();
        const to = focusable();
        const x = restPointerOver(from);
        press(K.DOWN);
        const onHover = vi.fn();
        to.addEventListener('nav:hover', onHover);
        pointer('mouseout', from, x);
        pointer('mouseover', to, x);
        expect(onHover).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains('keyboard-nav')).toBe(true);
      });

      it('follows wheel-scrolled content under the pointer again', () => {
        const list = scroller();
        const row = focusable();
        list.appendChild(row);
        const onHover = vi.fn();
        row.addEventListener('nav:hover', onHover);
        const x = restPointerOver(document.body);
        press(K.DOWN);
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        });
        pointer('mouseover', row, x);
        expect(onHover).not.toHaveBeenCalled();

        wheel(120, row);
        pointer('mouseover', row, x);
        spy.mockRestore();
        expect(onHover).toHaveBeenCalledTimes(1);
        expect(document.documentElement.classList.contains('keyboard-nav')).toBe(false);
        expect(lines).toContainEqual(expect.stringMatching(/event=nav\.hover\.resumed via=wheel suppressed=1\b/));
      });

      it('hovers the row a wheel scroll brings under a resting pointer', () => {
        vi.useFakeTimers();
        const list = scroller();
        const first = focusable();
        const next = focusable();
        list.append(first, next);
        const onFirst = vi.fn();
        const onNext = vi.fn();
        first.addEventListener('nav:hover', onFirst);
        next.addEventListener('nav:hover', onNext);
        restPointerOver(first);
        onFirst.mockClear();
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
        });
        const hitTest = vi.fn(() => next);
        Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true });
        try {
          wheel(120, first);
          // No mouseover follows: the content just moves under the pointer.
          list.dispatchEvent(new Event('scroll'));
          vi.advanceTimersByTime(200);
        } finally {
          spy.mockRestore();
          Reflect.deleteProperty(document, 'elementFromPoint');
          vi.useRealTimers();
        }
        expect(onNext).toHaveBeenCalledTimes(1);
        expect(lines).toContainEqual(expect.stringContaining('event=nav.hover.synced via=wheel'));
      });

      it('lets views with their own mouseover follow a wheel scroll', () => {
        vi.useFakeTimers();
        const list = scroller();
        const cell = document.createElement('div');
        list.appendChild(cell);
        const onOver = vi.fn();
        list.addEventListener('mouseover', onOver);
        restPointerOver(cell);
        onOver.mockClear();
        Object.defineProperty(document, 'elementFromPoint', { value: () => cell, configurable: true });
        try {
          wheel(120, cell);
          list.dispatchEvent(new Event('scroll'));
          vi.advanceTimersByTime(200);
        } finally {
          Reflect.deleteProperty(document, 'elementFromPoint');
          vi.useRealTimers();
        }
        expect(onOver).toHaveBeenCalledTimes(1);
      });

      it('hands control back to the pointer when the wheel turns over an icon', () => {
        const list = scroller();
        const row = focusable();
        list.appendChild(row);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        row.appendChild(icon);
        restPointerOver(row);
        press(K.DOWN);
        wheel(120, icon);
        expect(document.documentElement.classList.contains('keyboard-nav')).toBe(false);
      });

      it('leaves hover alone when the app scrolls the list', () => {
        vi.useFakeTimers();
        const list = scroller();
        const row = focusable();
        list.appendChild(row);
        const hitTest = vi.fn(() => row);
        Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true });
        try {
          vi.advanceTimersByTime(2000);
          document.documentElement.classList.remove('keyboard-nav');
          list.dispatchEvent(new Event('scroll'));
          vi.advanceTimersByTime(200);
        } finally {
          Reflect.deleteProperty(document, 'elementFromPoint');
          vi.useRealTimers();
        }
        expect(hitTest).not.toHaveBeenCalled();
      });

      it('keeps the D-pad in charge when the wheel only steps channels', () => {
        const row = focusable();
        const onHover = vi.fn();
        row.addEventListener('nav:hover', onHover);
        restPointerOver(row);
        onHover.mockClear();
        press(K.DOWN);
        wheel(120, row);
        expect(onHover).not.toHaveBeenCalled();
        expect(document.documentElement.classList.contains('keyboard-nav')).toBe(true);
      });

      it('hides suppressed hovers from components with their own mouseover', () => {
        const panel = document.createElement('div');
        const row = document.createElement('div');
        panel.appendChild(row);
        document.body.appendChild(panel);
        const onOver = vi.fn();
        panel.addEventListener('mouseover', onOver);
        const x = restPointerOver(document.body);
        press(K.DOWN);
        pointer('mouseover', row, x);
        expect(onOver).not.toHaveBeenCalled();
        pointer('mouseover', row, x + 20);
        expect(onOver).toHaveBeenCalledTimes(1);
      });

      it('does not treat the webOS cursor appearing or hiding as a key press', () => {
        const row = focusable();
        const onHover = vi.fn();
        row.addEventListener('nav:hover', onHover);
        const x = restPointerOver(document.body);
        press(K.CURSOR_SHOW);
        pointer('mouseover', row, x);
        press(K.CURSOR_HIDE);
        expect(onHover).toHaveBeenCalledTimes(1);
        expect(document.documentElement.classList.contains('keyboard-nav')).toBe(false);
      });

      it('unhovers the element the pointer leaves once it moves again', () => {
        const a = focusable();
        const b = focusable();
        const onUnhoverA = vi.fn();
        a.addEventListener('nav:unhover', onUnhoverA);
        const x = restPointerOver(a);
        press(K.DOWN);
        pointer('mouseover', b, x + 30);
        pointer('mousemove', b, x + 30);
        expect(onUnhoverA).toHaveBeenCalledTimes(1);
      });

      it('re-hovers the same element when the pointer moves within it', () => {
        const a = focusable();
        const onHover = vi.fn();
        a.addEventListener('nav:hover', onHover);
        const x = restPointerOver(a);
        onHover.mockClear();
        press(K.DOWN);
        pointer('mousemove', a, x + 5);
        expect(onHover).toHaveBeenCalledTimes(1);
        pointer('mousemove', a, x + 10);
        expect(onHover).toHaveBeenCalledTimes(1);
      });

      it('re-hovers the same element when the pointer moves onto another of its children', () => {
        const row = focusable();
        const child = document.createElement('span');
        row.appendChild(child);
        const onHover = vi.fn();
        row.addEventListener('nav:hover', onHover);
        const x = restPointerOver(row);
        onHover.mockClear();
        press(K.UP);
        pointer('mouseover', child, x + 5);
        pointer('mousemove', child, x + 5);
        expect(onHover).toHaveBeenCalledTimes(1);
      });

      it('re-hovers the same element when the pointer moves after a wheel step', () => {
        const a = focusable();
        const onHover = vi.fn();
        a.addEventListener('nav:hover', onHover);
        const x = restPointerOver(a);
        onHover.mockClear();
        wheel(-120, a);
        expect(handler).toHaveBeenLastCalledWith('channel_up');
        pointer('mousemove', a, x + 5);
        expect(onHover).toHaveBeenCalledTimes(1);
        pointer('mousemove', a, x + 10);
        expect(onHover).toHaveBeenCalledTimes(1);
      });

      it('lets a surface claim the wheel so it scrolls instead of stepping channels', () => {
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        const claim = vi.fn((e: Event) => e.preventDefault());
        panel.addEventListener('nav:wheel', claim);
        restPointerOver(panel);
        const e = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
        panel.dispatchEvent(e);
        wheel(120, panel);
        expect(claim).toHaveBeenCalledTimes(2);
        expect(handler).not.toHaveBeenCalled();
        // The surface scrolls natively.
        expect(e.defaultPrevented).toBe(false);
      });
    });

    describe('nav:pointermove', () => {
      let screenX = 5000;
      let seen: { target: EventTarget | null; clientX: number; clientY: number }[];
      const onMove = (e: Event): void => {
        seen.push({ target: e.target, ...(e as CustomEvent<{ clientX: number; clientY: number }>).detail });
      };
      const move = (target: EventTarget, x: number): void => {
        target.dispatchEvent(new MouseEvent('mousemove', {
          clientX: x, clientY: 300, screenX: x, screenY: 300, bubbles: true,
        }));
      };
      const attached = (): HTMLElement => document.body.appendChild(document.createElement('div'));
      beforeEach(() => {
        seen = [];
        document.addEventListener('nav:pointermove', onMove);
      });
      afterEach(() => document.removeEventListener('nav:pointermove', onMove));

      it('carries the coordinates of a real move and of a resting repeat in pointer mode', () => {
        const el = attached();
        screenX += 50;
        move(el, screenX - 10);
        move(el, screenX);
        move(el, screenX);
        expect(seen.slice(-2)).toEqual([
          { target: el, clientX: screenX, clientY: 300 },
          { target: el, clientX: screenX, clientY: 300 },
        ]);
      });

      it('skips a resting repeat in key mode, which is content moving under the cursor', () => {
        const el = attached();
        screenX += 50;
        move(el, screenX);
        press(K.DOWN);
        seen = [];
        move(el, screenX);
        expect(seen).toEqual([]);
        move(el, screenX + 10);
        expect(seen).toHaveLength(1);
      });

      it('reaches listeners after the pointer state is updated', () => {
        const el = attached();
        screenX += 50;
        move(el, screenX);
        press(K.DOWN);
        const states: unknown[] = [];
        const probe = (): void => {
          states.push([InputMode.current, Focus.pointerPosition()]);
        };
        document.addEventListener('nav:pointermove', probe);
        try {
          move(el, screenX + 10);
        } finally {
          document.removeEventListener('nav:pointermove', probe);
        }
        expect(states).toEqual([['pointer', { x: screenX + 10, y: 300 }]]);
      });

      it('still reaches document when a hover re-renders the target away', () => {
        const el = attached();
        el.setAttribute('data-focusable', '');
        el.addEventListener('nav:hover', () => el.remove());
        screenX += 50;
        move(document.body, screenX - 10);
        move(el, screenX);
        expect(el.isConnected).toBe(false);
        expect(seen.slice(-1)).toEqual([{ target: document, clientX: screenX, clientY: 300 }]);
      });
    });

    it('dispatches nav:hover when the pointer moves over a focusable element', () => {
      const el = document.createElement('div');
      el.setAttribute('data-focusable', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);

      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
    });

    it('announces a view\'s own hover target, but leaves its click to the view', () => {
      const el = document.createElement('div');
      el.setAttribute('data-hover-target', '');
      document.body.appendChild(el);
      const onHover = vi.fn();
      el.addEventListener('nav:hover', onHover);

      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      vi.runAllTimers();
      expect(handler).not.toHaveBeenCalled();
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

    it('marks only the action a wheel step dispatches as a wheel action', () => {
      const seen: boolean[] = [];
      handler.mockImplementation(() => { seen.push(KeyHandler.isWheelAction()); });
      wheel(120);
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: K.CH_DOWN, bubbles: true }));
      expect(seen).toEqual([true, false]);
      expect(KeyHandler.isWheelAction()).toBe(false);
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

  describe('hover after edge scrolling', () => {
    let track: HTMLElement;
    let first: HTMLElement;
    let next: HTMLElement;
    let hit: HTMLElement;
    let onNext: ReturnType<typeof vi.fn>;
    let root: HTMLElement;
    let screen = 10000;

    beforeEach(() => {
      root = document.createElement('div');
      track = document.createElement('div');
      track.setAttribute('data-edge-scroll', '');
      first = document.createElement('button');
      next = document.createElement('button');
      first.setAttribute('data-focusable', '');
      next.setAttribute('data-focusable', '');
      track.append(first, next);
      root.appendChild(track);
      document.body.appendChild(root);
      hit = first;
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
      Object.defineProperties(track, {
        clientWidth: { value: 500 }, clientHeight: { value: 200 }, scrollWidth: { value: 2000 },
      });
      track.getBoundingClientRect = () => new DOMRect(0, 100, 500, 200);
      const scope = Focus.register({ id: 'edge-hover', root });
      Focus.setBase(() => scope);
      onNext = vi.fn();
      next.addEventListener('nav:hover', onNext);
      for (const clientX of [200, 490]) {
        screen++;
        first.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX, clientY: 150, screenX: screen, screenY: screen,
        }));
      }
      vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 100);
      expect(track.scrollLeft).toBeGreaterThan(0);
      hit = next;
      track.dispatchEvent(new Event('scroll'));
    });

    afterEach(() => {
      press(K.CURSOR_HIDE);
      Focus.uninstall();
      Reflect.deleteProperty(document, 'elementFromPoint');
    });

    it('hovers the item that settles under a resting pointer', () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      track.scrollLeft = 1500;
      vi.advanceTimersByTime(100);
      spy.mockRestore();
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(lines).toContainEqual(expect.stringContaining('event=nav.hover.synced via=edge'));
    });

    it('does not reveal new tiles sliding under a stationary pointer mid-scroll', () => {
      next.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: 490, clientY: 150, screenX: screen, screenY: screen,
      }));
      vi.advanceTimersByTime(100);
      expect(onNext).not.toHaveBeenCalled();
      expect(track.scrollLeft).toBeGreaterThan(0);
    });

    it('still hovers a real pointer move during edge scrolling', () => {
      next.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: 485, clientY: 150, screenX: screen + 1, screenY: screen,
      }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it.each(['key', 'cursor-hide key', 'hidden cursor event'])('hands off the visible pick before %s', cause => {
      const modes: boolean[] = [];
      next.addEventListener('nav:hover', () => modes.push(document.documentElement.classList.contains('keyboard-nav')));
      if (cause === 'key') press(K.RIGHT);
      else if (cause === 'cursor-hide key') press(K.CURSOR_HIDE);
      else document.dispatchEvent(new CustomEvent('cursorStateChange', { detail: { visibility: false } }));
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(modes).toEqual([false]);
      if (cause !== 'key') {
        press(K.RIGHT);
        expect(onNext).toHaveBeenCalledTimes(1);
      }
    });

    it('hands off the nearest visible pick when the pointer rests in a gap', () => {
      hit = track;
      first.getBoundingClientRect = () => new DOMRect(-200, 100, 80, 180);
      next.getBoundingClientRect = () => new DOMRect(400, 100, 80, 180);
      press(K.RIGHT);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it.each(['moving', 'stopped'])('hands off the nearest visible pick from the outer gutter while %s', state => {
      root.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
      first.getBoundingClientRect = () => new DOMRect(-200, 100, 80, 180);
      next.getBoundingClientRect = () => new DOMRect(400, 100, 80, 180);
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true, value: (px: number) => px < 500 ? next : root,
      });
      screen++;
      root.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 590, clientY: 150, screenX: screen, screenY: screen,
      }));
      if (state === 'stopped') track.scrollLeft = 1500;
      vi.advanceTimersByTime(100);
      press(K.RIGHT);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('forgets a stopped gutter scroll once the pointer moves elsewhere', () => {
      const other = document.createElement('button');
      other.setAttribute('data-focusable', '');
      root.appendChild(other);
      root.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
      first.getBoundingClientRect = () => new DOMRect(-200, 100, 80, 180);
      next.getBoundingClientRect = () => new DOMRect(400, 100, 80, 180);
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true, value: (px: number, py: number) => py > 300 ? other : px < 500 ? next : root,
      });
      const moveTo = (target: Element, clientX: number, clientY: number): void => {
        screen++;
        target.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX, clientY, screenX: screen, screenY: screen,
        }));
      };
      moveTo(root, 590, 150);
      track.scrollLeft = 1500;
      vi.advanceTimersByTime(100);
      moveTo(other, 200, 350);
      other.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: 200, clientY: 350, screenX: screen, screenY: screen,
      }));
      moveTo(root, 590, 150);
      press(K.DOWN);
      expect(onNext).not.toHaveBeenCalled();
      other.remove();
    });

    it('keeps the visible handoff available just after reaching the end', () => {
      track.scrollLeft = 1500;
      vi.advanceTimersByTime(20);
      press(K.CURSOR_HIDE);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it.each(['key', 'click', 'owner', 'hidden cursor'])('does not replay a stale hover after %s', cause => {
      if (cause === 'key') press(K.RIGHT);
      else if (cause === 'click') track.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      else if (cause === 'owner') Focus.push(Focus.register({ id: 'edge-menu', root: next }));
      else Focus.pointerGone();
      vi.advanceTimersByTime(80);
      expect(onNext).toHaveBeenCalledTimes(cause === 'key' ? 1 : 0);
    });
  });

  describe('a panel settling under the resting pointer', () => {
    let hit: Element | null;
    let root: HTMLElement;
    let scope: FocusScope;
    let screen = 0;
    const row = (key: string) => root.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    const moveTo = (x: number, y: number): void => {
      screen += 7;
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: x, clientY: y, screenX: screen, screenY: screen, bubbles: true,
      }));
    };
    const settle = (): void => {
      Focus.flush();
      vi.advanceTimersByTime(100);
      Focus.flush();
    };

    beforeEach(() => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
      hit = null;
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
      root = document.createElement('div');
      root.innerHTML = '<div data-focusable data-key="a"></div><div data-focusable data-key="b"></div>';
      root.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
      document.body.appendChild(root);
      scope = Focus.register({ id: 'panel', root, hoverOnSettle: true, defaultKey: () => 'a' });
      root.addEventListener('nav:hover', (e) => {
        scope.focus((e.target as HTMLElement).getAttribute('data-key'), 'pointer');
      });
      moveTo(5, 5);
      moveTo(6, 6);
    });

    afterEach(() => {
      Focus.uninstall();
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    });

    it('hovers the row it settles under as the one KeyHandler tracks', () => {
      const before = document.createElement('div');
      before.setAttribute('data-focusable', '');
      document.body.appendChild(before);
      before.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const onUnhoverBefore = vi.fn();
      before.addEventListener('nav:unhover', onUnhoverBefore);
      const onHover = vi.fn();
      const onUnhover = vi.fn();
      row('b').addEventListener('nav:hover', onHover);
      row('b').addEventListener('nav:unhover', onUnhover);

      hit = row('b');
      Focus.push(scope);
      settle();
      expect(row('b').classList.contains('focused')).toBe(true);
      expect(onHover).toHaveBeenCalledTimes(1);
      expect(onUnhoverBefore).toHaveBeenCalledTimes(1);

      // Chromium's own late mouseover on the same row is no second hover.
      row('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onHover).toHaveBeenCalledTimes(1);
      // Leaving the panel unhovers the settled row.
      document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(onUnhover).toHaveBeenCalledTimes(1);
      expect(onUnhoverBefore).toHaveBeenCalledTimes(1);
    });

    it('hovers afresh a row hovered before it opened, after settling with the pointer on no row', () => {
      // A row of the panel slid under the pointer before the panel owned the keys.
      row('b').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      Focus.push(scope);
      scope.focus('a', 'key');
      hit = root;
      settle();
      expect(row('a').classList.contains('focused')).toBe(true);

      // Chromium still counts the pointer on that row, so moving onto it
      // fires no mouseover.
      screen += 7;
      row('b').dispatchEvent(new MouseEvent('mousemove', {
        clientX: 50, clientY: 50, screenX: screen, screenY: screen, bubbles: true,
      }));
      Focus.flush();
      expect(row('b').classList.contains('focused')).toBe(true);
      expect(row('a').classList.contains('focused')).toBe(false);
    });

    it('hovers afresh the row the pointer last moved onto, after settling onto another', () => {
      row('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      hit = row('b');
      Focus.push(scope);
      settle();
      expect(row('b').classList.contains('focused')).toBe(true);

      // Chromium still counts the pointer on the row it last moved onto, so
      // moving back onto it fires no mouseover.
      screen += 7;
      row('a').dispatchEvent(new MouseEvent('mousemove', {
        clientX: 50, clientY: 50, screenX: screen, screenY: screen, bubbles: true,
      }));
      Focus.flush();
      expect(row('a').classList.contains('focused')).toBe(true);
      expect(row('b').classList.contains('focused')).toBe(false);
    });

    it.each([
      ['the cursor-hide key', () => press(K.CURSOR_HIDE)],
      ['a hidden cursor state', () => document.dispatchEvent(
        new CustomEvent('cursorStateChange', { detail: { visibility: false } }))],
      ['the pointer leaving the window', () => document.documentElement.dispatchEvent(
        new MouseEvent('mouseleave'))],
    ])('keeps its default after %s', (_name, gone) => {
      gone();
      hit = row('b');
      Focus.push(scope);
      settle();
      expect(row('a').classList.contains('focused')).toBe(true);
      expect(row('b').classList.contains('focused')).toBe(false);
    });
  });
});
