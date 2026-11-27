// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusRing, isHovered, ringsIn, setRing } from './focus-ring';
import { setInputMode } from './input-mode';
import { morph } from '../utils/morph';
import { html } from '../utils/dom';

let lower: HTMLElement;
let upper: HTMLElement;
let owner: HTMLElement | null;
let modal = false;

function item(parent: HTMLElement, key: string, cls = 'item'): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  el.setAttribute('data-focusable', '');
  el.setAttribute('data-key', key);
  parent.appendChild(el);
  return el;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '';
  lower = document.createElement('div');
  upper = document.createElement('div');
  document.body.append(lower, upper);
  owner = lower;
  modal = false;
  FocusRing.install(() => ({ root: owner, modal }));
});

afterEach(() => {
  FocusRing.uninstall();
  document.documentElement.classList.remove('keyboard-nav');
});

describe('FocusRing', () => {
  it('reads the owner id only to mark it', () => {
    const id = vi.fn(() => 'view.a');
    FocusRing.install(() => ({ root: owner, modal, id }));
    expect(lower.getAttribute('data-focus-scope')).toBe('view.a');
    id.mockClear();
    FocusRing.defer('test');
    expect(id).toHaveBeenCalledTimes(1);
    id.mockClear();
    FocusRing.reveal('key', 'up');
    expect(id).toHaveBeenCalledTimes(1);
  });

  it('marks the hover target it exempts, and clears the mark when the pointer leaves', () => {
    const row = item(lower, 'r1');
    FocusRing.hover(row);
    expect(row.hasAttribute('data-ring-hover')).toBe(true);
    FocusRing.unhover(row);
    expect(row.hasAttribute('data-ring-hover')).toBe(false);
    FocusRing.hover(row);
    morph(lower, html`<div class="item" data-focusable data-key="r1"></div>`);
    expect(lower.firstElementChild).toBe(row);
    expect(row.hasAttribute('data-ring-hover')).toBe(true);
    FocusRing.uninstall();
    expect(row.hasAttribute('data-ring-hover')).toBe(false);
  });

  it('marks only the current owner root, and whether it is modal', () => {
    FocusRing.sync();
    expect(lower.getAttribute('data-ring-owner')).toBe('');
    owner = upper;
    modal = true;
    FocusRing.sync();
    expect(lower.hasAttribute('data-ring-owner')).toBe(false);
    expect(upper.getAttribute('data-ring-owner')).toBe('modal');
    FocusRing.uninstall();
    expect(upper.hasAttribute('data-ring-owner')).toBe(false);
  });

  it('parks the ring of a surface that lost the keys and restores it when they return', () => {
    const row = item(lower, 'r1');
    setRing(row, true);
    const tile = item(upper, 't1');
    setRing(tile, true);
    owner = upper;
    FocusRing.sync();

    expect(row.className).toBe('item focused-parked');
    expect(tile.classList.contains('focused')).toBe(true);

    owner = lower;
    setRing(tile, false);
    FocusRing.sync();
    expect(row.className).toBe('item focused');
  });

  it('re-parks a ring a template re-render draws under another owner', () => {
    lower.innerHTML = '';
    const render = (focused: boolean) => morph(lower, html`
      <div class="item ${focused ? 'focused' : ''}" data-key="r1"></div>`);
    render(true);
    owner = upper;
    FocusRing.sync();
    render(true);
    FocusRing.sync();
    const row = lower.querySelector('[data-key="r1"]')!;
    expect(row.classList.contains('focused')).toBe(false);

    owner = lower;
    FocusRing.sync();
    expect(row.classList.contains('focused')).toBe(true);
  });

  it('does not bring back a parked ring its component moved away from meanwhile', () => {
    const a = item(lower, 'a');
    const b = item(lower, 'b');
    setRing(a, true);
    owner = upper;
    FocusRing.sync();

    ringsIn(lower, '.item').forEach((el) => setRing(el, false));
    setRing(b, true);
    owner = lower;
    FocusRing.sync();

    expect(ringsIn(lower)).toEqual([b]);
    expect(a.className).toBe('item');
  });

  it('drops a parked ring when a template re-render removes its focus', () => {
    const render = (key: string) => morph(lower, html`
      <div class="item ${key === 'a' ? 'focused' : ''}" data-key="a"></div>
      <div class="item ${key === 'b' ? 'focused' : ''}" data-key="b"></div>`);
    render('a');
    owner = upper;
    FocusRing.sync();
    render('b');
    owner = lower;
    FocusRing.sync();

    expect(ringsIn(lower).map((el) => el.getAttribute('data-key'))).toEqual(['b']);
  });

  it('lights what the pointer hovers outside the owner until a key is pressed', () => {
    const tile = item(upper, 't1');
    FocusRing.hover(tile);
    setRing(tile, true);
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(true);

    document.documentElement.classList.add('keyboard-nav');
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(false);
  });

  it('parks a hovered ring outside the owner as soon as the remote takes over', () => {
    const tile = item(upper, 't1');
    setInputMode('pointer');
    FocusRing.hover(tile);
    setRing(tile, true);
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(true);

    setInputMode('keys');
    expect(tile.classList.contains('focused')).toBe(false);
  });

  it('lights a parked ring as soon as the pointer hovers it', () => {
    const tile = item(upper, 't1');
    setRing(tile, true);
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(false);
    FocusRing.hover(tile);
    expect(tile.classList.contains('focused')).toBe(true);
  });

  it('parks a hovered ring outside the owner once the pointer leaves it', () => {
    const tile = item(upper, 't1');
    FocusRing.hover(tile);
    setRing(tile, true);
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(true);
    FocusRing.unhover(tile);
    expect(tile.classList.contains('focused')).toBe(false);
  });

  it('keeps the hover dark behind a modal prompt', () => {
    const row = item(lower, 'r1');
    FocusRing.hover(row);
    setRing(row, true);
    owner = upper;
    modal = true;
    FocusRing.sync();
    expect(row.classList.contains('focused')).toBe(false);
  });

  it('lights a ring the hovered element hands to its child', () => {
    const slot = item(upper, 'slot');
    const avatar = item(slot, 'avatar');
    FocusRing.hover(slot);
    setRing(slot, true);
    setRing(avatar, true);
    FocusRing.sync();
    expect(avatar.classList.contains('focused')).toBe(true);
  });

  it('tells whether the pointer rests on an element or the focusable holding it', () => {
    const slot = item(upper, 'slot');
    const avatar = item(slot, 'avatar');
    const other = item(upper, 'other');
    expect(isHovered(avatar)).toBe(false);
    FocusRing.hover(slot);
    expect(isHovered(slot)).toBe(true);
    expect(isHovered(avatar)).toBe(true);
    expect(isHovered(other)).toBe(false);
    FocusRing.unhover(slot);
    expect(isHovered(avatar)).toBe(false);
  });

  it('leaves every ring alone without an owner', () => {
    const tile = item(upper, 't1');
    setRing(tile, true);
    owner = null;
    FocusRing.sync();
    expect(tile.classList.contains('focused')).toBe(true);
  });
});

describe('FocusRing deferral', () => {
  const logLines = (run: () => void): string[] => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run();
    const lines = spy.mock.calls.map((args) => args.join(' '));
    spy.mockRestore();
    return lines;
  };
  let row: HTMLElement;
  beforeEach(() => {
    row = item(lower, 'r1');
    setRing(row, true);
  });

  it('parks the owner\'s own ring and marks the owner as waiting', () => {
    const lines = logLines(() => FocusRing.defer('channels'));
    expect(row.className).toBe('item focused-parked');
    expect(lower.getAttribute('data-ring-owner')).toBe('deferred');
    expect(FocusRing.deferred).toBe(true);
    expect(lines.find((l) => l.includes('event=nav.focus.deferred'))).toContain('view=channels');

    // A ring the view's scope paints later, such as a catalog that finished loading.
    const tile = item(lower, 't1');
    setRing(tile, true);
    FocusRing.sync();
    expect(tile.className).toBe('item focused-parked');
  });

  it('shows the ring on a key, and consumes only a key that asks to', () => {
    FocusRing.defer('channels');
    let consumed = false;
    const lines = logLines(() => { consumed = FocusRing.reveal('key', 'down', true); });
    expect(consumed).toBe(true);
    expect(row.className).toBe('item focused');
    expect(lower.getAttribute('data-ring-owner')).toBe('');
    expect(FocusRing.deferred).toBe(false);
    expect(lines.find((l) => l.includes('event=nav.focus.shown')))
      .toContain('via=key action=down consumed=yes');

    FocusRing.defer('channels');
    expect(FocusRing.reveal('key', 'back')).toBe(false);
    expect(row.className).toBe('item focused');
  });

  it('consumes only the keys that act on the focused item', () => {
    for (const action of ['up', 'select', 'channel_down', 'green'] as const) {
      FocusRing.defer('channels');
      expect(FocusRing.revealForKey(action)).toBe(true);
    }
    for (const action of ['back', 'number', 'play'] as const) {
      FocusRing.defer('channels');
      expect(FocusRing.revealForKey(action)).toBe(false);
      expect(FocusRing.deferred).toBe(false);
    }
  });

  it('lets the key act when the focused element is gone', () => {
    FocusRing.defer('channels');
    row.remove();
    const lines = logLines(() => { expect(FocusRing.reveal('key', 'down', true)).toBe(false); });
    expect(lines.find((l) => l.includes('event=nav.focus.shown'))).toContain('consumed=no');
  });

  it('does nothing once nothing is deferred', () => {
    const lines = logLines(() => { expect(FocusRing.reveal('key', 'down', true)).toBe(false); });
    expect(lines.some((l) => l.includes('event=nav.focus.shown'))).toBe(false);
  });

  it('ends on the wheel without consuming it', () => {
    FocusRing.defer('channels');
    const wheel = vi.fn();
    document.addEventListener('wheel', wheel);
    const lines = logLines(() => { document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true })); });
    document.removeEventListener('wheel', wheel);
    expect(row.className).toBe('item focused');
    expect(wheel).toHaveBeenCalledTimes(1);
    expect(lines.find((l) => l.includes('event=nav.focus.shown'))).toContain('via=wheel');
  });

  it('ends on a hover over the owner, but not over another surface', () => {
    FocusRing.defer('channels');
    const tab = item(upper, 'tab');
    FocusRing.hover(tab);
    expect(FocusRing.deferred).toBe(true);

    const other = item(lower, 'r2');
    const lines = logLines(() => { FocusRing.hover(other); });
    expect(FocusRing.deferred).toBe(false);
    expect(row.className).toBe('item focused');
    expect(lines.find((l) => l.includes('event=nav.focus.shown'))).toContain('via=hover');
  });

  it('ends when the keys move to another owner, and stays ended when they return', () => {
    FocusRing.defer('channels');
    owner = upper;
    FocusRing.sync();
    owner = lower;
    FocusRing.sync();
    expect(FocusRing.deferred).toBe(false);
    expect(row.className).toBe('item focused');
  });

  it('ends on a press inside the owner, before the view handles it', () => {
    FocusRing.defer('channels');
    item(upper, 'tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(FocusRing.deferred).toBe(true);

    let seen = '';
    const other = item(lower, 'r2');
    other.addEventListener('mousedown', () => { seen = row.className; });
    const lines = logLines(() => { other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(seen).toBe('item focused');
    expect(lines.find((l) => l.includes('event=nav.focus.shown'))).toContain('via=pointer');
  });

  it('logs nothing shown for a key that moved the keys elsewhere', () => {
    FocusRing.defer('channels');
    // The key's handler switched the owner; the observer has not synced yet.
    owner = upper;
    const lines = logLines(() => { expect(FocusRing.reveal('key', 'back')).toBe(false); });
    expect(FocusRing.deferred).toBe(false);
    expect(lines.some((l) => l.includes('event=nav.focus.shown'))).toBe(false);
    owner = lower;
    FocusRing.sync();
    expect(row.className).toBe('item focused');
  });

  it('never hides a modal prompt\'s ring', () => {
    modal = true;
    FocusRing.defer('channels');
    expect(FocusRing.deferred).toBe(false);
    expect(row.className).toBe('item focused');
  });
});
