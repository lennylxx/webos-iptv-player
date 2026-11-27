// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Action, PlaylistEntry } from '../types';
import { TabBar, SEARCH_INPUT_MAX_WIDTH } from './tab-bar';
import { Focus, Tier } from '../navigation/focus-scope';
import { scopeId } from '../test/scope-id';

type Handlers = ConstructorParameters<typeof TabBar>[0];

let onSwitch: Mock<Handlers['onSwitch']>;
let onEnter: Mock<Handlers['onEnter']>;
let onSearchQuery: Mock<Handlers['onSearchQuery']>;
let onSearchLeave: Mock<Handlers['onSearchLeave']>;
let onSearchClose: Mock<Handlers['onSearchClose']>;
let onSelectAccount: Mock<Handlers['onSelectAccount']>;
let onAccountMenuOpen: Mock<Handlers['onAccountMenuOpen']>;
let onAccountMenuClose: Mock<Handlers['onAccountMenuClose']>;
let onLockNow: Mock<Handlers['onLockNow']>;
let bar: TabBar;

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  onSwitch = vi.fn<Handlers['onSwitch']>();
  onEnter = vi.fn<Handlers['onEnter']>();
  onSearchQuery = vi.fn<Handlers['onSearchQuery']>();
  onSearchLeave = vi.fn<Handlers['onSearchLeave']>(() => true);
  onSearchClose = vi.fn<Handlers['onSearchClose']>();
  onSelectAccount = vi.fn<Handlers['onSelectAccount']>();
  onAccountMenuOpen = vi.fn<Handlers['onAccountMenuOpen']>();
  onAccountMenuClose = vi.fn<Handlers['onAccountMenuClose']>();
  onLockNow = vi.fn<Handlers['onLockNow']>();
  bar = new TabBar({
    onSwitch, onEnter, onSearchQuery, onSearchLeave, onSearchClose, onSelectAccount, onAccountMenuOpen, onAccountMenuClose,
    onLockNow,
  });
  bar.setSections(true); // Xtream by default
  bar.setShown(true);
});

// Close any menu a test left open, so the document listeners each bar's
// switcher leaves behind stay inert in later tests.
afterEach(() => { bar.setShown(false); Focus.uninstall(); });

// Keys reach whichever scope owns them, as App routes them.
const press = (action: Action) => Focus.owner()?.handle(action) ?? false;
const items = () => Array.from(document.querySelectorAll('.tab-bar-item')).map((b) => b.textContent || b.getAttribute('aria-label'));
const focusedLabel = () => {
  Focus.flush();
  return document.querySelector('.tab-bar-item.focused')?.textContent ?? null;
};

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
    press('select');
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('right/left switch the active section live and call onSwitch, staying focused', () => {
    bar.focus();
    press('right');
    expect(focusedLabel()).toBe('Guide');
    expect(bar.focused).toBe(true);
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    press('right');
    expect(onSwitch).toHaveBeenLastCalledWith('movies');
    press('left');
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    expect(bar.focused).toBe(true);
  });

  it('right from Live on an M3U account skips to Guide then Settings (no Movies/Series)', () => {
    bar.setSections(false);
    bar.focus();
    press('right');
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
    press('right');
    expect(onSwitch).toHaveBeenLastCalledWith('settings');
  });

  it('down/select enters the active section and drops focus', () => {
    bar.focus();
    press('right');   // → guide (live switch)
    press('select');
    expect(onEnter).toHaveBeenCalledWith('epg', 'key');
    expect(bar.focused).toBe(false);
    expect(focusedLabel()).toBe(null);
  });

  it('back drops focus back into the content it came from', () => {
    bar.focus();
    press('back');
    expect(onEnter).toHaveBeenCalledWith('live', 'key');
    expect(bar.focused).toBe(false);
  });

  it('Down enters the shown section by key, whether or not the bar switched away and back', () => {
    bar.focus();
    press('down');
    expect(onEnter).toHaveBeenLastCalledWith('live', 'key');

    bar.focus();
    press('right');
    press('left');
    press('down');
    expect(onEnter).toHaveBeenLastCalledWith('live', 'key');
  });

  it('up is a no-op on the bar (topmost)', () => {
    bar.focus();
    press('up');
    expect(bar.focused).toBe(true);
    expect(focusedLabel()).toBe('Live');
    expect(onEnter).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('ignores key input while not focused', () => {
    press('right');
    press('select');
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
    expect(onEnter).toHaveBeenCalledWith('series', 'pointer');
    expect(bar.focused).toBe(false);
  });

  it('takes the keys when a content scope leaves upward, and only while shown', () => {
    const view = document.createElement('div');
    document.body.appendChild(view);
    const content = Focus.register({ id: scopeId('view.test'), root: view, leaveFor: { up: 'tabbar' } });
    Focus.setBase(() => content);
    bar.setActive('settings');

    expect(content.leave('up')).toBe(true);
    expect(bar.focused).toBe(true);
    expect(Focus.owner()?.id).toBe('tabbar');
    expect(focusedLabel()).toBe('Settings');

    press('back');
    expect(Focus.owner()).toBe(content);
    bar.setShown(false);
    expect(content.leave('up')).toBe(false);
    expect(bar.focused).toBe(false);
  });

  describe('pointer hover on content', () => {
    const hover = (el: Element) => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    let row: HTMLElement;
    let contentHover: Mock<(e: Event) => void>;
    beforeEach(() => {
      bar.init();
      const view = document.createElement('div');
      row = document.createElement('div');
      row.setAttribute('data-focusable', '');
      view.appendChild(row);
      document.body.appendChild(view);
      contentHover = vi.fn<(e: Event) => void>();
      view.addEventListener('nav:hover', contentHover);
      const content = Focus.register({ id: scopeId('view.test'), root: view });
      Focus.setBase(() => content);
    });

    it('releases the bar so the next key acts in the content', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      bar.focus();
      hover(row);
      const lines = spy.mock.calls.map((args) => args.join(' '));
      spy.mockRestore();
      expect(bar.focused).toBe(false);
      expect(focusedLabel()).toBe(null);
      expect(lines.find((l) => l.includes('event=tab_bar.blur'))).toContain('reason=hover');
      press('right');
      expect(onSwitch).not.toHaveBeenCalled();
    });

    it('releases the bar when a rail below starts edge scrolling from a gutter', () => {
      bar.focus();
      row.parentElement!.dispatchEvent(new CustomEvent('nav:edge-scroll', { bubbles: true }));
      expect(bar.focused).toBe(false);
      expect(contentHover).not.toHaveBeenCalled();
      press('right');
      expect(onSwitch).not.toHaveBeenCalled();
    });

    it('keeps the keys while the pointer moves on the bar', () => {
      bar.focus();
      hover(document.querySelector('.tab-bar-item')!);
      expect(bar.focused).toBe(true);
    });

    it('keeps the keys while the pointer moves on a prompt above the bar', () => {
      const prompt = document.createElement('div');
      const button = document.createElement('button');
      prompt.appendChild(button);
      document.body.appendChild(prompt);
      const scope = Focus.register({ id: scopeId('prompt.test'), root: prompt, restrict: 'self-only', tier: Tier.prompt });
      bar.focus();
      Focus.push(scope);
      hover(button);
      expect(bar.focused).toBe(true);
      expect(Focus.owner()).toBe(scope);
      Focus.pop(scope);
      expect(Focus.owner()?.id).toBe('tabbar');
    });

    it('hands the keys to a menu under the bar when the pointer moves on the view', () => {
      const menu = document.createElement('div');
      menu.appendChild(document.createElement('div'));
      document.body.appendChild(menu);
      const scope = Focus.register({ id: scopeId('menu.test'), root: menu, restrict: 'self-only', tier: Tier.overlay });
      Focus.push(scope);
      bar.focus();
      expect(Focus.owner()?.id).toBe('tabbar');
      hover(row);
      expect(bar.focused).toBe(false);
      expect(Focus.owner()).toBe(scope);
      // The hover outside the self-only scope must not reach the content.
      expect(contentHover).not.toHaveBeenCalled();
      press('right');
      expect(onSwitch).not.toHaveBeenCalled();
    });

    it('hands the keys to a scope under the bar when the pointer moves on it', () => {
      const menu = document.createElement('div');
      const item = document.createElement('div');
      menu.appendChild(item);
      document.body.appendChild(menu);
      const scope = Focus.register({ id: scopeId('menu.test'), root: menu, restrict: 'self-only', tier: Tier.overlay });
      Focus.push(scope);
      bar.focus();
      expect(Focus.owner()?.id).toBe('tabbar');
      hover(item);
      expect(bar.focused).toBe(false);
      expect(Focus.owner()).toBe(scope);
      press('right');
      expect(onSwitch).not.toHaveBeenCalled();

      bar.focus();
      hover(row);
      expect(bar.focused).toBe(false);
      expect(Focus.owner()).toBe(scope);
      expect(contentHover).not.toHaveBeenCalled();
    });

    it('keeps the keys in the open search box', () => {
      bar.setActive('search');
      bar.focus();
      press('select');
      hover(row);
      expect(bar.focused).toBe(true);
      expect(bar.searchOpen).toBe(true);
    });

    it('keeps the keys in the open account menu', () => {
      bar.setAccounts([{ id: 'a1', name: 'Alpha', url: 'http://host/a', source: 'xtream',
        xtream: { username: 'u', password: 'p' } }], 'a1');
      bar.setActive('search');
      bar.focus();
      press('right');
      press('select');
      expect(bar.accountMenuOpen).toBe(true);
      hover(row);
      expect(bar.focused).toBe(true);
      expect(bar.accountMenuOpen).toBe(true);
    });
  });

  it('hands the keys back to the bar when the open account menu loses its accounts', () => {
    bar.setAccounts([
      { id: 'a1', name: 'Alpha', url: 'http://host/a', source: 'xtream', xtream: { username: 'u', password: 'p' } },
      { id: 'a2', name: 'Bravo', url: 'http://host/a', source: 'xtream', xtream: { username: 'u', password: 'p' } },
    ], 'a1');
    bar.focus();
    press('left');
    press('select');
    expect(bar.accountMenuOpen).toBe(true);
    expect(Focus.owner()?.id).toBe('tabbar.accounts');
    bar.setAccounts([], '');
    expect(bar.accountMenuOpen).toBe(false);
    expect(Focus.owner()?.id).toBe('tabbar');
    expect(onAccountMenuClose).toHaveBeenCalledWith('host', undefined);
    press('right');
    expect(onSwitch).toHaveBeenLastCalledWith('epg');
  });
});

describe('TabBar inline search', () => {
  const input = () => document.querySelector<HTMLInputElement>('.tab-bar-search-input');
  const expanded = () => !!document.querySelector('.tab-bar-search.expanded');

  it('Down after closing the box resumes the view it was opened over', () => {
    onSearchClose.mockImplementation(() => bar.setActive('movies'));
    bar.setActive('search');
    bar.focus();
    press('select');
    press('back');
    expect(bar.focused).toBe(true);
    press('down');
    expect(onEnter).toHaveBeenLastCalledWith('movies', 'key');
  });

  it('Select on the Search tab expands the inline box (without switching views yet)', () => {
    bar.setActive('search');
    bar.focus();
    expect(Focus.owner()?.surface).toBe('tabbar:tabs');
    press('select');
    expect(expanded()).toBe(true);
    expect(onEnter).toHaveBeenCalledWith('search', 'key');
    expect(bar.focused).toBe(true);
    expect(Focus.owner()?.surface).toBe('tabbar:search');
  });

  it('typing in the box reports the query', () => {
    bar.setActive('search');
    bar.focus();
    press('select');
    const box = input()!;
    box.value = 'abc';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onSearchQuery).toHaveBeenLastCalledWith('abc');
  });

  it('ArrowDown / Enter in the box hands off to the results and releases the bar', () => {
    bar.setActive('search');
    bar.focus();
    press('select');
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onSearchLeave).toHaveBeenCalled();
    expect(bar.focused).toBe(false);
  });

  it('keeps the box focused when nothing below can take the handoff', () => {
    onSearchLeave.mockReturnValue(false);
    bar.setActive('search');
    bar.focus();
    press('select');
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSearchLeave).toHaveBeenCalled();
    expect(bar.focused).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it('takes D-pad keys back into the box after its input lost DOM focus', () => {
    bar.setActive('search');
    bar.focus();
    press('select');
    input()!.blur();
    press('left');
    expect(document.activeElement).toBe(input());
    input()!.blur();
    press('down');
    expect(onSearchLeave).toHaveBeenCalled();
    expect(bar.focused).toBe(false);
  });

  it('Escape collapses the box and notifies close', () => {
    bar.setActive('search');
    bar.focus();
    press('select');
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
    press('select');
    expect(expanded()).toBe(true);
    press('back');
    expect(expanded()).toBe(false);
    expect(onSearchClose).toHaveBeenCalled();
    expect(bar.focused).toBe(true);
  });

  it('closeSearch() collapses the box from outside and notifies close', () => {
    bar.setActive('search');
    bar.focus();
    press('select');
    bar.closeSearch();
    expect(expanded()).toBe(false);
    expect(onSearchClose).toHaveBeenCalledTimes(1);
    bar.closeSearch();
    expect(onSearchClose).toHaveBeenCalledTimes(1);
  });

  describe('afterSearchExpanded()', () => {
    const transitionEnd = (propertyName: string) =>
      input()!.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName }));

    beforeEach(() => {
      vi.useFakeTimers();
      bar.setActive('search');
      bar.focus();
      press('select');
    });
    afterEach(() => vi.useRealTimers());

    it('waits for the width slide to finish, once', () => {
      const done = vi.fn();
      bar.afterSearchExpanded(done);
      transitionEnd('opacity');
      expect(done).not.toHaveBeenCalled();
      transitionEnd('width');
      expect(done).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('falls back to a timer when no transition ends', () => {
      const done = vi.fn();
      bar.afterSearchExpanded(done);
      vi.advanceTimersByTime(319);
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('skips a box that closed, or one superseded by a later expand', () => {
      const first = vi.fn();
      bar.afterSearchExpanded(first);
      const second = vi.fn();
      bar.afterSearchExpanded(second);
      vi.runAllTimers();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);

      const closed = vi.fn();
      bar.afterSearchExpanded(closed);
      bar.closeSearch();
      vi.runAllTimers();
      expect(closed).not.toHaveBeenCalled();
    });

    it('logs how each slide settled for tv.sh diag', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      bar.afterSearchExpanded(vi.fn());
      transitionEnd('width');
      bar.afterSearchExpanded(vi.fn());
      bar.closeSearch();
      vi.runAllTimers();
      const lines = spy.mock.calls.map((args) => args.join(' '));
      spy.mockRestore();
      expect(lines.find((l) => l.includes('event=search.box.expand.settled') && l.includes('source=transitionend')))
        .toContain('reason=run');
      expect(lines.find((l) => l.includes('event=search.box.collapsed'))).toContain('reason=dismiss');
      expect(lines.find((l) => l.includes('event=search.box.expand.settled') && l.includes('source=timeout')))
        .toContain('reason=stale');
    });
  });

  it('a second click on the magnifier collapses the box (toggle)', () => {
    bar.init();
    const icon = document.querySelector('.tab-bar-search .search-icon') as HTMLElement;
    icon.getBoundingClientRect = () =>
      ({ left: 900, top: 0, width: 44, height: 44, right: 944, bottom: 44, x: 900, y: 0, toJSON() {} }) as DOMRect;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => icon;
    document.dispatchEvent(new MouseEvent('click', { clientX: 920, clientY: 20, bubbles: true }));
    expect(expanded()).toBe(true);
    document.dispatchEvent(new MouseEvent('click', { clientX: 920, clientY: 20, bubbles: true }));
    expect(expanded()).toBe(false);
    document.elementFromPoint = orig;
  });

  it('caps the expanded box width so it does not span the whole bar (M3U-only leaves a big gap)', () => {
    bar.setSections(false); // M3U-only: only Live / Guide / Settings / Search, so the gap is largest
    bar.setActive('search');
    bar.focus();
    press('select'); // expands
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
  const avatar = () => { Focus.flush(); return document.querySelector<HTMLElement>('.account-avatar'); };

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
    press('right'); // Search -> account
    expect(avatar()?.classList.contains('focused')).toBe(true);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('Right back off the avatar onto the shown section neither switches nor forgets it', () => {
    bar.setAccounts(A, 'a1');
    bar.focus();
    onSwitch.mockClear();
    press('left'); // Live -> account
    expect(avatar()?.classList.contains('focused')).toBe(true);
    press('right'); // back onto Live
    expect(focusedLabel()).toBe('Live');
    expect(onSwitch).not.toHaveBeenCalled();
    press('down');
    expect(onEnter).toHaveBeenLastCalledWith('live', 'key');
  });

  it('Right past the avatar wraps back to Live', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    press('right'); // -> account
    press('right'); // wrap -> live
    expect(onSwitch).toHaveBeenLastCalledWith('live');
  });

  it('Select on the avatar opens the menu; Select on a row fires onSelectAccount', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    press('right'); // -> account
    press('select'); // open menu
    expect(document.querySelector('.account-menu')).not.toBe(null);
    press('down');   // highlight Bravo
    press('select'); // choose
    expect(onSelectAccount).toHaveBeenCalledWith('a2');
    expect(document.querySelector('.account-menu')).toBe(null);
  });

  describe('opened by pointer', () => {
    const realElementFromPoint = document.elementFromPoint;
    afterEach(() => { document.elementFromPoint = realElementFromPoint; });

    const clickOn = (el: HTMLElement) => {
      document.elementFromPoint = vi.fn(() => el);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    const logLines = (fn: () => void): string[] => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fn();
      const lines = spy.mock.calls.map((args) => args.join(' '));
      spy.mockRestore();
      return lines;
    };

    it('a pointer click on the avatar takes input focus so D-pad drives the menu', () => {
      bar.setAccounts(A, 'a1');
      const lines = logLines(() => clickOn(avatar()!));
      expect(bar.accountMenuOpen).toBe(true);
      expect(bar.focused).toBe(true);
      // The open menu holds the ring; the avatar gets it back on close.
      expect(avatar()?.classList.contains('focused')).toBe(false);
      expect(document.querySelectorAll('.account-menu-item.focused')).toHaveLength(1);
      expect(lines.filter((l) => l.includes('event=account.menu.opened')).pop()).toContain('mode=pointer');
      press('down');   // highlight Bravo
      press('select'); // choose
      expect(onSelectAccount).toHaveBeenCalledWith('a2');
      expect(avatar()?.classList.contains('focused')).toBe(true);
    });

    it('Back after a pointer-opened menu resumes the shown section', () => {
      bar.setAccounts(A, 'a1');
      bar.setActive('settings');
      clickOn(avatar()!);
      press('back'); // closes the menu; the bar stays on the avatar
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(true);
      press('back');
      expect(onEnter).toHaveBeenLastCalledWith('settings', 'key');
    });

    it('logs mode=pointer even when the D-pad already rests on the avatar', () => {
      bar.setAccounts(A, 'a1');
      bar.setActive('search');
      bar.focus();
      press('right'); // -> account
      const lines = logLines(() => clickOn(avatar()!));
      expect(lines.filter((l) => l.includes('event=account.menu.opened')).pop()).toContain('mode=pointer');
    });

    it('a click on the content closes the menu and releases the bar, so its select is not swallowed', () => {
      bar.setAccounts(A, 'a1');
      clickOn(avatar()!);
      const poster = document.createElement('div');
      poster.setAttribute('data-focusable', '');
      document.body.appendChild(poster);
      const lines = logLines(() => clickOn(poster));
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(false);
      expect(onAccountMenuClose).toHaveBeenCalledWith('outside', poster);
      expect(lines.filter((l) => l.includes('event=account.menu.closed')).pop()).toContain('reason=outside');
      // The global click handler's deferred select must not reopen the menu.
      press('select');
      expect(bar.accountMenuOpen).toBe(false);
    });

    it('a click on a spot that fires no select closes the menu but keeps the bar focused', () => {
      bar.setAccounts(A, 'a1');
      clickOn(avatar()!);
      const blank = document.createElement('div');
      document.body.appendChild(blank);
      const lines = logLines(() => clickOn(blank));
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(true);
      expect(onAccountMenuClose).toHaveBeenCalledWith('blank', blank);
      expect(lines.filter((l) => l.includes('event=account.menu.closed')).pop()).toContain('reason=blank');
    });

    it('a click on a self-activating view\'s item releases the bar too', () => {
      bar.setAccounts(A, 'a1');
      clickOn(avatar()!);
      const list = document.createElement('div');
      list.setAttribute('data-self-activate', '');
      const row = document.createElement('div');
      row.setAttribute('data-focusable', '');
      list.appendChild(row);
      document.body.appendChild(list);
      clickOn(row);
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(false);
      expect(onAccountMenuClose).toHaveBeenCalledWith('outside', row);
    });

    it('a click elsewhere on the bar closes the menu but keeps the bar focused', () => {
      bar.setAccounts(A, 'a1');
      clickOn(avatar()!);
      const title = document.querySelector<HTMLElement>('.tab-bar-title')!;
      const lines = logLines(() => clickOn(title));
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(true);
      expect(onAccountMenuClose).toHaveBeenCalledWith('bar', title);
      expect(lines.filter((l) => l.includes('event=account.menu.closed')).pop()).toContain('reason=bar');
    });

    it('a magnifier click that collapses search keeps the bar focused', () => {
      // Like App: the bar's click listener registers before the switcher's.
      bar.setShown(false);
      Focus.uninstall();
      document.body.innerHTML = '';
      bar = new TabBar({
        onSwitch, onEnter, onSearchQuery, onSearchLeave, onSearchClose, onSelectAccount, onAccountMenuOpen,
        onAccountMenuClose, onLockNow,
      });
      bar.init();
      bar.setSections(true);
      bar.setShown(true);
      bar.setAccounts(A, 'a1');
      bar.setActive('search');
      bar.focus();
      press('select'); // expand search
      clickOn(avatar()!);
      clickOn(document.querySelector<HTMLElement>('.tab-bar-item[data-section="search"]')!);
      expect(bar.searchOpen).toBe(false);
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(true);
    });

    it('a second click on the avatar closes the menu but keeps the bar focused', () => {
      bar.setAccounts(A, 'a1');
      clickOn(avatar()!);
      const lines = logLines(() => clickOn(avatar()!));
      expect(bar.accountMenuOpen).toBe(false);
      expect(bar.focused).toBe(true);
      expect(lines.filter((l) => l.includes('event=account.menu.closed')).pop()).toContain('reason=toggle');
    });
  });

  it('logs a D-pad open of the account menu as mode=key', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    press('right');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    press('select');
    const lines = spy.mock.calls.map((args) => args.join(' '));
    spy.mockRestore();
    expect(lines.filter((l) => l.includes('event=account.menu.opened')).pop()).toContain('mode=key');
  });

  it('hiding the bar drops search before its account menu closes', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    press('select');
    const avatar = document.querySelector<HTMLElement>('.account-avatar')!;
    document.elementFromPoint = vi.fn(() => avatar);
    avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bar.accountMenuOpen).toBe(true);
    let openAtClose: boolean | null = null;
    onAccountMenuClose.mockImplementation(() => { openAtClose = bar.searchOpen; });
    bar.setShown(false);
    expect(onAccountMenuClose).toHaveBeenCalledTimes(1);
    expect(openAtClose).toBe(false);
  });

  it('hiding the bar closes an open account menu', () => {
    bar.setAccounts(A, 'a1');
    bar.setActive('search');
    bar.focus();
    press('right');
    press('select');
    expect(document.querySelector('.account-menu')).not.toBe(null);
    bar.setShown(false);
    bar.setShown(true);
    expect(document.querySelector('.account-menu')).toBe(null);
  });
});

describe('TabBar parental lock', () => {
  const lock = () => { Focus.flush(); return document.querySelector<HTMLElement>('[data-lock-now]'); };

  it('shows Lock now only during an unlock session, between Search and the avatar', () => {
    expect(lock()).toBe(null);
    bar.setAccounts([{ id: 'a1', name: 'Alpha', url: 'http://host/a', source: 'xtream',
      xtream: { username: 'u', password: 'p' } }], 'a1');
    bar.setParentalSession(true);
    expect(lock()?.textContent).toBe('Lock now');

    bar.setActive('search');
    bar.focus();
    onSwitch.mockClear();
    press('right');
    expect(lock()?.classList.contains('focused')).toBe(true);
    expect(onSwitch).not.toHaveBeenCalled();
    press('select');
    expect(onLockNow).toHaveBeenCalledTimes(1);

    press('right');
    Focus.flush();
    expect(document.querySelector('.account-avatar')?.classList.contains('focused')).toBe(true);

    bar.setParentalSession(false);
    expect(lock()).toBe(null);
  });
});
