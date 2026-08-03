// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlaylistEntry } from '../types';
import { TabBar, SEARCH_INPUT_MAX_WIDTH } from './tab-bar';

let onSwitch: ReturnType<typeof vi.fn>;
let onEnter: ReturnType<typeof vi.fn>;
let onSearchQuery: ReturnType<typeof vi.fn>;
let onSearchLeave: ReturnType<typeof vi.fn>;
let onSearchClose: ReturnType<typeof vi.fn>;
let onSelectAccount: ReturnType<typeof vi.fn>;
let bar: TabBar;

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  onSwitch = vi.fn();
  onEnter = vi.fn();
  onSearchQuery = vi.fn();
  onSearchLeave = vi.fn();
  onSearchClose = vi.fn();
  onSelectAccount = vi.fn();
  bar = new TabBar({ onSwitch, onEnter, onSearchQuery, onSearchLeave, onSearchClose, onSelectAccount });
  bar.setSections(true); // Xtream by default
  bar.setShown(true);
});

const items = () => Array.from(document.querySelectorAll('.tab-bar-item')).map((b) => b.textContent || b.getAttribute('aria-label'));
const focusedLabel = () => document.querySelector('.tab-bar-item.focused')?.textContent ?? null;

describe('TabBar', () => {
  it('renders the app title and the full section set for an Xtream account', () => {
    expect(bar.shown).toBe(true);
    expect(document.querySelector('.tab-bar-title')?.textContent).toBe('webOS IPTV Player');
    expect(items()).toEqual(['Live', 'Guide', 'Movies', 'Series', 'Settings', 'Search']);
    expect(focusedLabel()).toBe(null); // shown but not focused → no ring
    expect(document.body.classList.contains('tabbar-docked')).toBe(true);
  });

  it('renders only Live/Guide/Settings/Search for an M3U-only account', () => {
    bar.setSections(false);
    expect(items()).toEqual(['Live', 'Guide', 'Settings', 'Search']);
  });

  it('focus() puts the ring on the active tab', () => {
    bar.focus();
    expect(bar.focused).toBe(true);
    expect(focusedLabel()).toBe('Live');
  });

  it('blur() gives up focus so later input is no longer captured', () => {
    bar.focus();
    expect(bar.focused).toBe(true);
    bar.blur();
    expect(bar.focused).toBe(false);
    // A subsequent action is inert (handleAction returns early when not focused).
    bar.handleAction('select');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('right/left switch the active section live and call onSwitch, staying focused', () => {
    bar.focus();
    bar.handleAction('right');
    expect(focusedLabel()).toBe('Guide');
    expect(bar.focused).toBe(true);
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    bar.handleAction('right');
    expect(onSwitch).toHaveBeenLastCalledWith('movies');
    bar.handleAction('left');
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    expect(bar.focused).toBe(true);
  });

  it('right from Live on an M3U account skips to Guide then Settings (no Movies/Series)', () => {
    bar.setSections(false);
    bar.focus();
    bar.handleAction('right');
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    bar.handleAction('right');
    expect(onSwitch).toHaveBeenLastCalledWith('settings');
  });

  it('down/select enters the active section and drops focus', () => {
    bar.focus();
    bar.handleAction('right');   // → guide (live switch)
    bar.handleAction('select');
    expect(onEnter).toHaveBeenCalledWith('epg');
    expect(bar.focused).toBe(false);
    expect(focusedLabel()).toBe(null);
  });

  it('back drops focus into the content (enters the active section)', () => {
    bar.focus();
    bar.handleAction('back');
    expect(onEnter).toHaveBeenCalledWith('live');
    expect(bar.focused).toBe(false);
  });

  it('up is a no-op on the bar (topmost)', () => {
    bar.focus();
    bar.handleAction('up');
    expect(bar.focused).toBe(true);
    expect(focusedLabel()).toBe('Live');
    expect(onEnter).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('ignores key input while not focused', () => {
    bar.handleAction('right');
    bar.handleAction('select');
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('setShown(false) hides the bar, clears focus, and undocks', () => {
    bar.focus();
    bar.setShown(false);
    expect(bar.shown).toBe(false);
    expect(bar.focused).toBe(false);
    expect(document.body.classList.contains('tabbar-docked')).toBe(false);
    expect(document.querySelector('.tab-bar')?.classList.contains('tab-bar--hidden')).toBe(true);
  });

  it('clamps the active section to Live when switching to a set that lacks it', () => {
    bar.setActive('movies');
    bar.setSections(false); // M3U has no Movies
    bar.focus();
    expect(focusedLabel()).toBe('Live');
  });

  it('enters a tab on a pointer click by coordinate hit-test', () => {
    bar.init();
    const seriesBtn = document.querySelectorAll('.tab-bar-item')[3] as HTMLElement;
    seriesBtn.getBoundingClientRect = () =>
      ({ left: 200, top: 0, width: 100, height: 40, right: 300, bottom: 40, x: 200, y: 0, toJSON() {} }) as DOMRect;
    const origFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => seriesBtn;
    document.dispatchEvent(new MouseEvent('click', { clientX: 250, clientY: 20, bubbles: true }));
    document.elementFromPoint = origFromPoint;
    expect(onEnter).toHaveBeenCalledWith('series');
    expect(bar.focused).toBe(false);
  });
});

describe('TabBar inline search', () => {
  const input = () => document.querySelector<HTMLInputElement>('.tab-bar-search-input');
  const expanded = () => !!document.querySelector('.tab-bar-search.expanded');

  it('Select on the Search tab expands the inline box (without switching views yet)', () => {
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select');
    expect(expanded()).toBe(true);
    expect(onEnter).toHaveBeenCalledWith('search');
    expect(bar.focused).toBe(true);
  });

  it('typing in the box reports the query', () => {
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select');
    const box = input()!;
    box.value = 'abc';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onSearchQuery).toHaveBeenLastCalledWith('abc');
  });

  it('ArrowDown / Enter in the box hands off to the results and releases the bar', () => {
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select');
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onSearchLeave).toHaveBeenCalled();
    expect(bar.focused).toBe(false);
  });

  it('Escape collapses the box and notifies close', () => {
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select');
    const box = input()!;
    box.value = 'abc';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(expanded()).toBe(false);
    expect(onSearchClose).toHaveBeenCalled();
  });

  it('Back collapses the expanded box and notifies close, keeping the bar focused', () => {
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select');
    expect(expanded()).toBe(true);
    bar.handleAction('back');
    expect(expanded()).toBe(false);
    expect(onSearchClose).toHaveBeenCalled();
    expect(bar.focused).toBe(true);
  });

  it('a second click on the magnifier collapses the box (toggle)', () => {
    bar.init();
    const icon = document.querySelector('.tab-bar-search .search-icon') as HTMLElement;
    icon.getBoundingClientRect = () =>
      ({ left: 1700, top: 0, width: 44, height: 44, right: 1744, bottom: 44, x: 1700, y: 0, toJSON() {} }) as DOMRect;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => icon;
    document.dispatchEvent(new MouseEvent('click', { clientX: 1720, clientY: 20, bubbles: true }));
    expect(expanded()).toBe(true);
    document.dispatchEvent(new MouseEvent('click', { clientX: 1720, clientY: 20, bubbles: true }));
    expect(expanded()).toBe(false);
    document.elementFromPoint = orig;
  });

  it('caps the expanded box width so it does not span the whole bar (M3U-only leaves a big gap)', () => {
    bar.setSections(false); // M3U-only: only Live / Guide / Settings / Search, so the gap is largest
    bar.setActive('search');
    bar.focus();
    bar.handleAction('select'); // expands
    const box = document.querySelector<HTMLInputElement>('.tab-bar-search-input')!;
    const icon = document.querySelector<HTMLElement>('.tab-bar-search .search-icon')!;
    const settings = document.querySelector<HTMLElement>('.tab-bar-item[data-section="settings"]')!;
    const rect = (left: number, right: number): DOMRect =>
      ({ left, right, top: 0, bottom: 44, width: right - left, height: 44, x: left, y: 0, toJSON() {} }) as DOMRect;
    icon.getBoundingClientRect = () => rect(1760, 1804);
    settings.getBoundingClientRect = () => rect(120, 240); // far left → a ~1500px gap the old code would fill
    (bar as unknown as { setSearchWidth(i: HTMLInputElement): void }).setSearchWidth(box);
    expect(parseInt(box.style.width, 10)).toBe(SEARCH_INPUT_MAX_WIDTH);
  });
});

describe('TabBar account switcher', () => {
  const acct = (id: string, name: string): PlaylistEntry =>
    ({ id, name, url: 'http://host/a', source: 'xtream', xtream: { username: 'u', password: 'p' } });
  const A = [acct('a1', 'Alpha'), acct('a2', 'Bravo')];
  const avatar = () => document.querySelector<HTMLElement>('.account-avatar');

  it('shows the avatar to the right of search when ≥1 Xtream account exists', () => {
    bar.setAccounts(A, 'a1');
    expect(avatar()?.textContent).toBe('A');
  });

  it('renders no avatar when there are no Xtream accounts', () => {
    bar.setAccounts([], '');
    expect(avatar()).toBe(null);
  });

  it('Right from Search focuses the avatar without switching sections', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    onSwitch.mockClear();
    bar.handleAction('right'); // Search -> account
    expect(avatar()?.classList.contains('focused')).toBe(true);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('Right past the avatar wraps back to Live', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    bar.handleAction('right'); // -> account
    bar.handleAction('right'); // wrap -> live
    expect(onSwitch).toHaveBeenLastCalledWith('live');
  });

  it('Select on the avatar opens the menu; Select on a row fires onSelectAccount', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    bar.handleAction('right'); // -> account
    bar.handleAction('select'); // open menu
    expect(document.querySelector('.account-menu')).not.toBe(null);
    bar.handleAction('down');   // highlight Bravo
    bar.handleAction('select'); // choose
    expect(onSelectAccount).toHaveBeenCalledWith('a2');
    expect(document.querySelector('.account-menu')).toBe(null);
  });

  it('hiding the bar closes an open account menu', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    bar.handleAction('right');
    bar.handleAction('select');
    expect(document.querySelector('.account-menu')).not.toBe(null);
    bar.setShown(false);
    bar.setShown(true);
    expect(document.querySelector('.account-menu')).toBe(null);
  });
});
