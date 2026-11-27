// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Focus, Tier, type FocusScope, type ScopeSpec } from './focus-scope';
import { FocusRing, hasRing, ringsIn, setRing } from './focus-ring';
import { setInputMode } from './input-mode';
import { morph } from '../utils/morph';
import { hide, html, inShownView, show } from '../utils/dom';
import { scopeId } from '../test/scope-id';

let view: HTMLElement;
let prompt: HTMLElement;
let logs: string[];

function list(parent: HTMLElement, keys: string[]): void {
  morph(parent, html`${keys.map((k) => html`<div class="row" data-focusable data-key="${k}"></div>`)}`);
}

const row = (parent: HTMLElement, key: string) => parent.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const shown = () => Array.from(document.querySelectorAll('.focused')).map((el) => el.getAttribute('data-key'));
const repairs = () => logs.filter((l) => l.includes('event=nav.focus.repaired'));

function logical(id: string, root: HTMLElement, extra: Partial<ScopeSpec> = {}): FocusScope {
  return Focus.register({ id: scopeId(id), root, defaultKey: () => root.querySelector('[data-key]')?.getAttribute('data-key') ?? null, ...extra });
}

function installRing(): void {
  FocusRing.install(() => {
    const owner = Focus.owner();
    return { root: owner?.root() ?? null, modal: !!owner?.modal, id: () => owner?.surface };
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '';
  view = document.createElement('div');
  prompt = document.createElement('div');
  document.body.append(view, prompt);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
});

afterEach(() => {
  Focus.uninstall();
  FocusRing.uninstall();
  setInputMode('pointer');
  vi.restoreAllMocks();
});

describe('Focus owner stack', () => {
  it('counts a pushed scope only while its condition holds, above the base', () => {
    const base = Focus.register({ id: scopeId('view.a'), root: view });
    let tabBar = false;
    let menu = false;
    const bar = Focus.register({ id: 'tabbar', mode: () => 'tabs', root: view, tier: Tier.bar, when: () => tabBar });
    const dropdown = Focus.register({
      id: scopeId('menu'), root: view, restrict: 'self-only', tier: Tier.overlay, when: () => menu,
    });
    Focus.push(bar);
    Focus.push(dropdown);
    Focus.setBase(() => base);
    expect(Focus.owner()).toBe(base);

    menu = true;
    expect(Focus.owner()).toBe(dropdown);
    tabBar = true;
    expect(Focus.owner()).toBe(bar);

    const confirm = Focus.register({ id: scopeId('prompt.confirm'), root: prompt, restrict: 'self-only' });
    Focus.push(confirm);
    expect(Focus.owner()).toBe(confirm);
    expect(confirm.modal).toBe(true);
    expect(bar.modal).toBe(false);
    Focus.pop(confirm);
    Focus.pop(confirm);
    expect(Focus.owner()).toBe(bar);
  });

  it('keeps a higher tier on top of a later push, such as the PIN over a timed prompt', () => {
    const pin = Focus.register({ id: scopeId('prompt.pin'), root: prompt, restrict: 'self-only', tier: Tier.critical });
    const reminder = Focus.register({ id: 'prompt.reminder', root: prompt, restrict: 'self-only' });
    const menu = Focus.register({ id: scopeId('menu'), root: view });
    Focus.push(pin);
    Focus.push(reminder);
    Focus.push(menu);
    expect(Focus.owner()).toBe(pin);
    Focus.pop(pin);
    expect(Focus.owner()).toBe(reminder);
  });

  it('ranks pushed scopes by tier before push order', () => {
    const history = Focus.register({ id: 'search.history', root: view, restrict: 'self-only', tier: Tier.overlay });
    const bar = Focus.register({ id: 'tabbar', mode: () => 'tabs', root: view, tier: Tier.bar });
    Focus.push(bar);
    Focus.push(history);
    expect(Focus.owner()).toBe(bar);
    const confirm = Focus.register({ id: scopeId('prompt.confirm'), root: prompt, restrict: 'self-only' });
    Focus.push(confirm);
    expect(Focus.owner()).toBe(confirm);
    const overlay = Focus.register({ id: scopeId('test.menu'), root: prompt });
    Focus.push(overlay);
    expect(Focus.owner()).toBe(confirm);
  });

  it('keeps an overlay above a panel pushed after it, such as the menu over the subtitle search', () => {
    const menu = Focus.register({ id: scopeId('test.menu'), root: view });
    const search = Focus.register({ id: 'player.subtitle_search', root: prompt, tier: Tier.panel });
    Focus.push(menu);
    Focus.push(search);
    expect(Focus.owner()).toBe(menu);
    Focus.pop(menu);
    expect(Focus.owner()).toBe(search);
  });

  it('tells a scope once when it stops owning the keys', () => {
    const onRelease = vi.fn();
    const search = Focus.register({ id: 'player.subtitle_search', root: view, tier: Tier.panel, onRelease });
    const menu = Focus.register({ id: scopeId('test.menu'), root: prompt });
    Focus.push(search);
    expect(Focus.owner()).toBe(search);
    expect(onRelease).not.toHaveBeenCalled();
    Focus.push(menu);
    expect(Focus.owner()).toBe(menu);
    expect(Focus.owner()).toBe(menu);
    expect(onRelease).toHaveBeenCalledTimes(1);
    Focus.pop(menu);
    expect(Focus.owner()).toBe(search);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('tells a scope once when it comes to own the keys, after the old owner lets go', () => {
    const calls: string[] = [];
    const search = Focus.register({
      id: 'player.subtitle_search', root: view, tier: Tier.panel,
      onRelease: () => calls.push('search released'),
      onAcquire: () => calls.push('search acquired'),
    });
    const menu = Focus.register({
      id: scopeId('test.menu'), root: prompt,
      onRelease: () => calls.push('menu released'),
      onAcquire: () => calls.push('menu acquired'),
    });
    Focus.push(search);
    expect(Focus.owner()).toBe(search);
    expect(calls).toEqual(['search acquired']);
    Focus.push(menu);
    expect(Focus.owner()).toBe(menu);
    expect(Focus.owner()).toBe(menu);
    expect(calls).toEqual(['search acquired', 'search released', 'menu acquired']);
    Focus.pop(menu);
    expect(Focus.owner()).toBe(search);
    expect(calls).toEqual(['search acquired', 'search released', 'menu acquired',
      'menu released', 'search acquired']);
  });

  it('tells the scope that owns the keys after an onRelease that changes the stack', () => {
    const calls: string[] = [];
    const sheet = Focus.register({
      id: scopeId('player.sheet'), root: prompt,
      onAcquire: () => calls.push('sheet acquired'),
    });
    const search = Focus.register({
      id: 'player.subtitle_search', root: view, tier: Tier.panel,
      onRelease: () => { calls.push('search released'); Focus.push(sheet); },
      onAcquire: () => calls.push('search acquired'),
    });
    const menu = Focus.register({
      id: scopeId('test.menu'), root: prompt, tier: Tier.panel,
      onAcquire: () => calls.push('menu acquired'),
    });
    Focus.push(search);
    expect(Focus.owner()).toBe(search);
    Focus.push(menu);
    expect(Focus.owner()).toBe(sheet);
    expect(Focus.owner()).toBe(sheet);
    expect(calls).toEqual(['search acquired', 'search released', 'sheet acquired']);
  });

  describe('a pushed scope opening under a resting pointer', () => {
    let hit: Element | null;
    let left: number;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      hit = null;
      left = 0;
      prompt.getBoundingClientRect = () => new DOMRect(left, 0, 100, 100);
      Focus.setHoverAt((_x, _y, within) => {
        if (hit && within.contains(hit)) hit.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      Focus.setHoverAt(null);
    });

    function panel(extra: Partial<ScopeSpec> = { hoverOnSettle: true }): FocusScope {
      list(prompt, ['a', 'b', 'c']);
      const scope = logical('panel', prompt, extra);
      prompt.addEventListener('nav:hover', (e) => {
        scope.focus((e.target as HTMLElement).getAttribute('data-key'), 'pointer');
      });
      return scope;
    }

    it('lights the row under the pointer once it settles, over its default', () => {
      const scope = panel();
      Focus.pointer(5, 5);
      hit = row(prompt, 'b');
      Focus.push(scope);
      Focus.flush();
      expect(Focus.owner()).toBe(scope);
      expect(shown()).toEqual(['a']);
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['b']);
    });

    it('waits for a panel still off to the side to slide out under the pointer', () => {
      const scope = panel();
      Focus.pointer(5, 5);
      hit = row(prompt, 'b');
      left = 200;
      Focus.push(scope);
      Focus.flush();
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['a']);
      left = 0;
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['b']);
    });

    it('leaves the default alone under the D-pad, or with the pointer outside it', () => {
      const scope = panel();
      Focus.pointer(5, 5);
      hit = row(prompt, 'b');
      setInputMode('keys');
      Focus.push(scope);
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['a']);

      Focus.pop(scope);
      setInputMode('pointer');
      list(view, ['x']);
      hit = row(view, 'x');
      Focus.push(scope);
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['a']);
    });

    it('keeps a prompt on its default under a resting pointer', () => {
      const scope = panel({ restrict: 'self-only' });
      Focus.pointer(5, 5);
      hit = row(prompt, 'b');
      Focus.push(scope);
      Focus.flush();
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['a']);
    });

    it('keeps the default once the pointer is gone', () => {
      const scope = panel();
      Focus.pointer(5, 5);
      Focus.pointerGone();
      hit = row(prompt, 'b');
      Focus.push(scope);
      Focus.flush();
      vi.advanceTimersByTime(100);
      Focus.flush();
      expect(shown()).toEqual(['a']);
    });

    it('lights the row a slide of the owner left under the resting pointer', () => {
      const scope = panel({});
      Focus.push(scope);
      Focus.flush();
      Focus.pointer(5, 5);
      hit = row(prompt, 'b');
      Focus.hoverPointerIn(scope);
      Focus.flush();
      expect(shown()).toEqual(['b']);
    });

    it('hovers nothing after a slide under the D-pad, below another owner, or with no pointer', () => {
      const scope = panel({});
      Focus.push(scope);
      Focus.flush();
      const hover = vi.fn();
      Focus.setHoverAt(hover);
      Focus.pointer(5, 5);

      setInputMode('keys');
      Focus.hoverPointerIn(scope);
      setInputMode('pointer');
      list(view, ['x']);
      const top = logical('top', view);
      Focus.push(top);
      Focus.hoverPointerIn(scope);
      Focus.pop(top);
      Focus.pointerGone();
      Focus.hoverPointerIn(scope);
      expect(hover).not.toHaveBeenCalled();

      Focus.pointer(5, 5);
      Focus.hoverPointerIn(scope);
      expect(hover).toHaveBeenCalledWith(5, 5, prompt);
    });
  });

  it('skips a pushed scope while its view is not shown, and restores it after', () => {
    let shownView = 'player';
    const base = Focus.register({ id: scopeId('view.a'), root: view });
    Focus.setBase(() => base);
    const menu = Focus.register({ id: scopeId('test.menu'), root: prompt, when: () => shownView === 'player' });
    Focus.push(menu);
    expect(Focus.owner()).toBe(menu);
    shownView = 'channels';
    expect(Focus.owner()).toBe(base);
    shownView = 'player';
    expect(Focus.owner()).toBe(menu);
  });

  it('settles the owner after a view switch alone, with no input or morph', async () => {
    const channels = document.createElement('div');
    const player = document.createElement('div');
    channels.className = 'view';
    player.className = 'view hidden';
    document.body.append(channels, player);
    list(channels, ['c1']);
    list(player, ['m1']);
    let current = 'channels';
    const released = vi.fn();
    const acquired = vi.fn();
    const list1 = logical('test.list', channels, { onRelease: released });
    const playerView = Focus.register({ id: 'view.player', root: player });
    const menu = logical('test.menu', player, { when: () => inShownView(player), onAcquire: acquired });
    Focus.setBase(() => (current === 'channels' ? list1 : playerView));
    Focus.push(menu);
    installRing();
    await Promise.resolve();
    expect(shown()).toEqual(['c1']);

    // App.showView: the stack changes, then the views flip.
    current = 'player';
    hide(channels);
    show(player);
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toHaveBeenCalledTimes(1);
    expect(acquired).toHaveBeenCalledTimes(1);
    expect(player.getAttribute('data-focus-scope')).toBe('test.menu');
    expect(shown()).toEqual(['m1']);
  });

  it('returns to the scope below when the top one pops', () => {
    const a = Focus.register({ id: scopeId('a'), root: view });
    const b = Focus.register({ id: scopeId('b'), root: prompt });
    Focus.push(a);
    Focus.push(b);
    Focus.push(a);
    expect(Focus.owner()).toBe(a);
    Focus.pop(a);
    expect(Focus.owner()).toBe(b);
    b.dispose();
    expect(Focus.owner()).toBeNull();
  });

  it('takes the ring off a popped scope and keeps it registered for the next push', () => {
    list(prompt, ['p1', 'p2']);
    const p = logical('prompt.a', prompt, { restrict: 'self-only' });
    Focus.push(p);
    p.focus('p2', 'key');
    Focus.flush();
    expect(shown()).toEqual(['p2']);

    Focus.pop(p);
    expect(shown()).toEqual([]);
    expect(() => Focus.register({ id: scopeId('prompt.a'), root: prompt })).toThrow(/already registered/);

    Focus.push(p);
    Focus.flush();
    expect(Focus.owner()).toBe(p);
    expect(shown()).toEqual(['p2']);
  });

  it('routes keys to the owner only when it has a handler', () => {
    const onAction = vi.fn();
    const withHandler = Focus.register({ id: scopeId('prompt.pin'), root: prompt, onAction });
    const without = Focus.register({ id: scopeId('view.a'), root: view });
    expect(withHandler.handle('select')).toBe(true);
    expect(onAction).toHaveBeenCalledWith('select', undefined);
    expect(without.handle('select')).toBe(false);
  });

  it('hands a key off the edge to the scope named for that side', () => {
    list(prompt, ['t1', 't2']);
    let barShown = true;
    const bar = logical('bar', prompt, { tier: Tier.bar, when: () => barShown, enterTo: 'default' });
    const a = Focus.register({ id: scopeId('view.a'), root: view, leaveFor: { up: 'bar', down: null } });
    bar.focus('t2', 'key');

    expect(a.leave('up')).toBe(true);
    expect(bar.focusKey).toBe('t1');
    // A blocked side keeps the key without moving it; an unnamed one is free.
    expect(a.leave('down')).toBe(true);
    expect(a.leave('left')).toBe(false);
    barShown = false;
    expect(a.leave('up')).toBe(false);
  });

  it('lets the scope left for take the keys its own way', () => {
    const onEnter = vi.fn();
    Focus.register({ id: scopeId('bar'), root: prompt, onEnter });
    const a = Focus.register({ id: scopeId('view.a'), root: view, leaveFor: { up: 'bar', left: 'missing' } });
    expect(a.leave('up')).toBe(true);
    expect(onEnter).toHaveBeenCalledWith('key');
    expect(a.leave('left')).toBe(false);
  });

  it('names the scope that would own the keys without a given one, even one above it', () => {
    const base = Focus.register({ id: scopeId('view.a'), root: view });
    const bar = Focus.register({ id: scopeId('bar'), root: prompt, tier: Tier.bar });
    const menu = Focus.register({ id: scopeId('menu'), root: prompt, restrict: 'self-only' });
    Focus.setBase(() => base);
    Focus.push(bar);
    expect(Focus.ownerWithout(bar)).toBe(base);
    Focus.push(menu);
    expect(Focus.ownerWithout(menu)).toBe(bar);
    expect(Focus.ownerWithout(bar)).toBe(menu);
    expect(Focus.ownerWithout(menu, bar)).toBe(base);
    expect(Focus.owner()).toBe(menu);
    expect(Focus.base()).toBe(base);
  });

  it('rejects a second scope with the same id', () => {
    Focus.register({ id: scopeId('a'), root: view });
    expect(() => Focus.register({ id: scopeId('a'), root: prompt })).toThrow(/already registered/);
  });

  it('marks the owner root with its scope id for FocusRing', () => {
    const a = Focus.register({ id: scopeId('view.a'), root: view });
    const p = Focus.register({ id: scopeId('prompt.confirm'), root: prompt, restrict: 'self-only' });
    Focus.setBase(() => a);
    installRing();
    expect(view.getAttribute('data-focus-scope')).toBe('view.a');
    Focus.push(p);
    FocusRing.sync();
    expect(view.hasAttribute('data-focus-scope')).toBe(false);
    expect(prompt.getAttribute('data-focus-scope')).toBe('prompt.confirm');
    expect(prompt.getAttribute('data-ring-owner')).toBe('modal');
  });

  it('marks a scope with modes by the mode it shows', () => {
    let mode: 'schedule' | 'timeline' = 'schedule';
    const grid = Focus.register({ id: 'guide.grid', root: view, mode: () => mode });
    Focus.setBase(() => grid);
    installRing();
    expect(view.getAttribute('data-focus-scope')).toBe('guide.grid:schedule');
    mode = 'timeline';
    FocusRing.sync();
    expect(view.getAttribute('data-focus-scope')).toBe('guide.grid:timeline');
  });

  it('refuses a scope with modes that does not report one', () => {
    expect(() => Focus.register({ id: 'guide.grid', root: view })).toThrow(/must report its mode/);
  });
});

describe('Focus reconcile', () => {
  it('leaves a non-logical owner\'s rings to its component', async () => {
    list(view, ['r1', 'r2']);
    setRing(row(view, 'r1'), true);
    setRing(row(view, 'r2'), true);
    const a = Focus.register({ id: scopeId('view.a'), root: view });
    Focus.setBase(() => a);
    Focus.reconcile();
    await Promise.resolve();
    expect(shown()).toEqual(['r1', 'r2']);
    expect(view.hasAttribute('data-focus-unresolved')).toBe(false);
    expect(repairs()).toEqual([]);
  });

  it('paints the ring on the focus key, once per microtask however often asked', async () => {
    list(view, ['r1', 'r2']);
    const resolve = vi.fn((key: string) => row(view, key));
    const a = logical('test.list', view, { resolve });
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    Focus.reconcile();
    Focus.reconcile();
    expect(shown()).toEqual([]);
    await Promise.resolve();
    expect(shown()).toEqual(['r2']);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('moves the ring with the key without reporting a repair', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r1', 'key');
    Focus.flush();
    a.focus('r2', 'key');
    Focus.flush();
    expect(shown()).toEqual(['r2']);
    expect(repairs()).toEqual([]);
  });

  it('keeps the ring on the key across a re-render that replaces the node', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    Focus.flush();
    view.innerHTML = '';
    list(view, ['r0', 'r1', 'r2']);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
    expect(repairs()).toEqual([]);
  });

  it('falls back to the entry point when the key no longer resolves', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    Focus.flush();
    list(view, ['r1']);
    Focus.flush();
    expect(a.focusKey).toBe('r1');
    expect(shown()).toEqual(['r1']);
    expect(repairs()).toEqual([expect.stringContaining('reason=unresolved scope=test.list')]);
  });

  it('marks the owner root when not even the entry point resolves', () => {
    const a = logical('test.list', view, { defaultKey: () => 'gone' });
    Focus.setBase(() => a);
    a.focus('missing', 'key');
    Focus.flush();
    expect(view.hasAttribute('data-focus-unresolved')).toBe(true);
    list(view, ['gone']);
    Focus.flush();
    expect(view.hasAttribute('data-focus-unresolved')).toBe(false);
    expect(shown()).toEqual(['gone']);
  });

  it('refuses a key that resolves outside the owner root', () => {
    list(view, ['r1']);
    list(prompt, ['p1']);
    const a = logical('test.list', view, { resolve: (key) => document.querySelector(`[data-key="${key}"]`) });
    Focus.setBase(() => a);
    a.focus('p1', 'key');
    Focus.flush();
    expect(shown()).toEqual(['r1']);
    expect(repairs()).toEqual([expect.stringContaining('reason=outside_owner scope=test.list')]);
  });

  it('clears a ring another writer left in the owner and reports it', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r1', 'key');
    Focus.flush();
    setRing(row(view, 'r2'), true);
    Focus.reconcile();
    Focus.flush();
    expect(shown()).toEqual(['r1']);
    expect(repairs()).toEqual([expect.stringContaining('reason=two_rings scope=test.list')]);
  });

  it('applies the enter rule for how focus arrives', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.grid', view, { enterTo: (via) => (via === 'key' ? 'default' : 'last') });
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    a.enter('back');
    expect(a.focusKey).toBe('r2');
    a.enter('key');
    expect(a.focusKey).toBe('r1');
  });

  it('leaves the ring parked while a pointer entry defers it', () => {
    list(view, ['r1']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    installRing();
    FocusRing.defer('channels');
    a.focus('r1', 'key');
    Focus.flush();
    expect(shown()).toEqual([]);
    expect(hasRing(row(view, 'r1'))).toBe(true);
    expect(FocusRing.reveal('key', 'down', true)).toBe(true);
    expect(shown()).toEqual(['r1']);
  });

  it('paints when a pushed scope\'s condition hands it the keys at the next ring sync', async () => {
    list(view, ['r1']);
    list(prompt, ['p1']);
    const a = Focus.register({ id: scopeId('view.a'), root: view });
    let open = false;
    const sidebar = logical('player.sidebar', prompt, { when: () => open });
    Focus.push(sidebar);
    Focus.setBase(() => a);
    installRing();
    await Promise.resolve();
    open = true;
    FocusRing.sync();
    await Promise.resolve();
    expect(shown()).toEqual(['p1']);
  });

  it('finds a key that needs escaping, such as a quote or a line break', () => {
    const key = 'a"b\\c\nd';
    const el = document.createElement('div');
    el.setAttribute('data-key', key);
    view.appendChild(el);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus(key, 'key');
    Focus.flush();
    expect(el.classList.contains('focused')).toBe(true);
    expect(repairs()).toEqual([]);
  });

  it('escapes keys with CSS.escape where the engine has it', () => {
    list(view, ['r1']);
    const escape = vi.fn((s: string) => s);
    vi.stubGlobal('CSS', { escape });
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r1', 'key');
    Focus.flush();
    vi.unstubAllGlobals();
    expect(escape).toHaveBeenCalledWith('r1');
  });

  it('re-gates rings at once, so a modal above parks the view\'s ring', () => {
    list(view, ['r1']);
    list(prompt, ['p1']);
    const a = logical('test.list', view);
    const p = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.setBase(() => a);
    installRing();
    a.focus('r1', 'key');
    Focus.flush();
    Focus.push(p);
    Focus.flush();
    expect(shown()).toEqual(['p1']);
    expect(ringsIn(view)).toHaveLength(1);
    Focus.pop(p);
    Focus.flush();
    FocusRing.sync();
    expect(shown()).toEqual(['r1']);
  });

  it('restores a ring the view re-rendered under a modal once the keys return', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['p1']);
    const a = logical('test.list', view);
    const p = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.setBase(() => a);
    installRing();
    a.focus('r2', 'key');
    Focus.flush();
    Focus.push(p);
    Focus.flush();
    list(view, ['r1', 'r2']);
    Focus.flush();
    expect(shown()).toEqual(['p1']);
    Focus.pop(p);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
  });

  it('reconciles after a morph into the owner root', async () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    Focus.flush();
    view.innerHTML = '';
    morph(view, html`<div data-key="r2"></div>`);
    await Promise.resolve();
    expect(shown()).toEqual(['r2']);
  });

  // A style recalc between the patch and the pass would see the row ringless
  // and restart its ring transitions twice per re-render, as a virtual list
  // re-rendering on every scroll step does.
  it('keeps the ring the owner painted through a re-render, with no class write', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    installRing();
    setInputMode('keys');
    a.focus('r2', 'key');
    Focus.flush();
    const writes: (string | null)[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.target === row(view, 'r2')) writes.push(r.oldValue);
    });
    observer.observe(view, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    list(view, ['r0', 'r1', 'r2']);
    expect(shown()).toEqual(['r2']);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
    expect(observer.takeRecords().filter((r) => r.target === row(view, 'r2'))).toEqual([]);
    expect(writes).toEqual([]);

    // The pass after the patch still moves a ring the re-render kept.
    a.focus('r1', 'key');
    list(view, ['r1', 'r2']);
    Focus.flush();
    expect(shown()).toEqual(['r1']);
    expect(repairs()).toEqual([]);
    observer.disconnect();
  });

  it('drops a ring a re-render kept once another scope takes the keys first', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['p1']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    installRing();
    setInputMode('keys');
    a.focus('r2', 'key');
    Focus.flush();

    list(view, ['r0', 'r1', 'r2']);
    expect(hasRing(row(view, 'r2'))).toBe(true);
    const p = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.push(p);
    Focus.flush();
    expect(shown()).toEqual(['p1']);
    // Not merely parked: the template dropped it, so the pass does too.
    expect(hasRing(row(view, 'r2'))).toBe(false);
    expect(ringsIn(document.body)).toHaveLength(1);
  });

  it('drops a ring a re-render kept even after a nested morph in its patch threw', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['p1']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    installRing();
    setInputMode('keys');
    a.focus('r2', 'key');
    Focus.flush();

    // Inserting r3 runs code that catches a failing morph, after r2's ring was kept.
    const broken = document.createElement('div');
    vi.spyOn(broken, 'insertBefore').mockImplementation(() => { throw new Error('patch failed'); });
    const insert = view.insertBefore.bind(view);
    vi.spyOn(view, 'insertBefore').mockImplementation(<T extends Node>(node: T, child: Node | null): T => {
      try { morph(broken, html`<i></i>`); } catch { /* reported elsewhere */ }
      return insert(node, child);
    });
    list(view, ['r1', 'r2', 'r3']);
    vi.mocked(view.insertBefore).mockRestore();
    expect(hasRing(row(view, 'r2'))).toBe(true);
    const p = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.push(p);
    Focus.flush();
    expect(hasRing(row(view, 'r2'))).toBe(false);
    expect(ringsIn(document.body)).toHaveLength(1);
  });

  it('settles the owner on show() alone', () => {
    list(view, ['r1']);
    list(prompt, ['p1']);
    const base = logical('view.a', view);
    const overlay = logical('overlay', prompt, { when: () => !prompt.classList.contains('hidden') });
    prompt.classList.add('hidden');
    Focus.push(overlay);
    Focus.setBase(() => base);
    installRing();
    Focus.flush();
    expect(shown()).toEqual(['r1']);
    show(prompt);
    Focus.flush();
    expect(shown()).toEqual(['p1']);
  });

  it('settles the owner on hide() alone', () => {
    list(view, ['r1']);
    list(prompt, ['p1']);
    const base = logical('view.a', view);
    const overlay = logical('overlay', prompt, { when: () => !prompt.classList.contains('hidden') });
    Focus.push(overlay);
    Focus.setBase(() => base);
    installRing();
    Focus.flush();
    expect(shown()).toEqual(['p1']);
    hide(prompt);
    Focus.flush();
    expect(shown()).toEqual(['r1']);
  });

  it('keeps the template authoritative for a ring no scope painted', () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    a.focus('r2', 'key');
    Focus.flush();
    morph(prompt, html`<div class="focused" data-key="t1"></div>`);
    morph(prompt, html`<div data-key="t1"></div>`);
    expect(hasRing(row(prompt, 't1'))).toBe(false);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
  });

  it('skips the pass for a morph beside the owner, but still gates a ring it draws', () => {
    list(view, ['r1', 'r2']);
    const resolve = vi.fn((key: string) => row(view, key));
    const a = logical('test.list', view, { resolve });
    Focus.setBase(() => a);
    installRing();
    setInputMode('keys');
    a.focus('r2', 'key');
    Focus.flush();
    resolve.mockClear();

    morph(prompt, html`<div data-key="t1">1</div>`);
    Focus.flush();
    expect(resolve).not.toHaveBeenCalled();

    morph(prompt, html`<div class="focused" data-key="t1">2</div>`);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
    expect(hasRing(row(prompt, 't1'))).toBe(true);

    morph(view, html`<div class="row" data-key="r1"></div><div class="row" data-key="r2"></div>`);
    Focus.flush();
    expect(shown()).toEqual(['r2']);
  });

  it('skips the pass for a background morph that keeps only a parked ring of a scope off the keys', () => {
    list(view, ['r1', 'r2']);
    morph(prompt, html`<div data-key="slot" data-morph-preserve><div class="row" data-key="p1"></div></div>`);
    const resolve = vi.fn((key: string) => row(view, key));
    const a = logical('test.list', view, { resolve });
    const b = logical('view.b', prompt, { defaultKey: () => 'p1' });
    let base: FocusScope = b;
    Focus.setBase(() => base);
    installRing();
    setInputMode('keys');
    b.focus('p1', 'key');
    Focus.flush();
    expect(shown()).toEqual(['p1']);
    base = a;
    a.focus('r2', 'key');
    Focus.flush();
    expect(shown()).toEqual(['r2']);
    expect(hasRing(row(prompt, 'p1'))).toBe(true);
    Focus.flush();
    resolve.mockClear();

    morph(prompt, html`<div data-key="slot" data-morph-preserve></div><div data-key="t1">1</div>`);
    Focus.flush();
    expect(resolve).not.toHaveBeenCalled();
    expect(shown()).toEqual(['r2']);
    expect(hasRing(row(prompt, 'p1'))).toBe(true);
  });

  it('reconciles after a pointer hover once installed', async () => {
    list(view, ['r1', 'r2']);
    const a = logical('test.list', view);
    Focus.setBase(() => a);
    Focus.install();
    view.addEventListener('nav:hover', (e) => {
      a.focus((e.target as HTMLElement).getAttribute('data-key'), 'pointer');
    });
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    await Promise.resolve();
    expect(shown()).toEqual(['r2']);
  });

  it('lights the pointer\'s pick off the keys only while the pointer rests on it', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['m1']);
    const a = logical('test.settings', view);
    const bar = logical('tabbar', prompt, { tier: Tier.bar, mode: () => 'tabs' });
    Focus.push(bar);
    Focus.setBase(() => a);
    Focus.install();
    installRing();
    setInputMode('pointer');
    bar.focus('m1', 'key');
    Focus.flush();
    view.addEventListener('nav:hover', (e) => {
      a.focus((e.target as HTMLElement).getAttribute('data-key'), 'pointer');
    });
    view.addEventListener('nav:unhover', () => a.conceal());

    a.focus('r1', 'pointer');
    expect(shown()).toEqual(['m1']);

    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(shown()).toEqual(['r2', 'm1']);
    expect(Focus.owner()).toBe(bar);

    row(view, 'r2').dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    row(view, 'r1').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(shown()).toEqual(['r1', 'm1']);
    expect(ringsIn(view)).toHaveLength(1);

    row(view, 'r1').dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    expect(shown()).toEqual(['m1']);
    expect(ringsIn(view)).toHaveLength(0);
  });

  it('keeps the pointer\'s pick off the keys lit through a re-render of its view', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['m1']);
    const a = logical('test.settings', view);
    const bar = logical('tabbar', prompt, { tier: Tier.bar, mode: () => 'tabs' });
    Focus.push(bar);
    Focus.setBase(() => a);
    Focus.install();
    installRing();
    setInputMode('pointer');
    bar.focus('m1', 'key');
    Focus.flush();
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    a.focus('r2', 'pointer');
    expect(shown()).toEqual(['r2', 'm1']);

    morph(view, html`<div class="row" data-focusable data-key="r1"></div>
      <div class="row" data-focusable data-key="r2"></div>`);
    Focus.flush();
    expect(shown()).toEqual(['r2', 'm1']);
    expect(Focus.owner()).toBe(bar);
  });

  it('stops relighting the pointer\'s pick off the keys once the keys take over', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['m1']);
    const a = logical('test.settings', view);
    const bar = logical('tabbar', prompt, { tier: Tier.bar, mode: () => 'tabs' });
    Focus.push(bar);
    Focus.setBase(() => a);
    Focus.install();
    installRing();
    setInputMode('pointer');
    bar.focus('m1', 'key');
    Focus.flush();
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    a.focus('r2', 'pointer');
    expect(shown()).toEqual(['r2', 'm1']);

    setInputMode('keys');
    Focus.reconcile();
    Focus.flush();
    expect(shown()).toEqual(['m1']);
    const watch = new MutationObserver(() => {});
    watch.observe(view, { subtree: true, attributes: true, attributeFilter: ['class'] });
    for (let i = 0; i < 3; i++) {
      Focus.reconcile();
      Focus.flush();
    }
    // A ring re-added and parked again in the same pass still leaves its records.
    const records = watch.takeRecords();
    watch.disconnect();
    expect(records).toHaveLength(0);
    expect(ringsIn(view)).toHaveLength(0);
  });

  it('keeps hover behind a pushed modal from the surfaces below', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['ok', 'cancel']);
    const a = logical('test.list', view);
    const modal = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.setBase(() => a);
    Focus.install();
    const hovered: string[] = [];
    const record = (e: Event) => hovered.push((e.target as HTMLElement).getAttribute('data-key')!);
    document.addEventListener('nav:hover', record);
    Focus.push(modal);
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    row(prompt, 'cancel').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(hovered).toEqual(['cancel']);

    Focus.pop(modal);
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(hovered).toEqual(['cancel', 'r2']);
    document.removeEventListener('nav:hover', record);
  });

  it('marks no hover behind a pushed modal for the ring', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['ok', 'cancel']);
    const a = logical('test.list', view);
    const modal = logical('prompt.confirm', prompt, { restrict: 'self-only' });
    Focus.setBase(() => a);
    Focus.install();
    installRing();
    Focus.push(modal);
    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(document.querySelectorAll('[data-ring-hover]')).toHaveLength(0);

    row(prompt, 'cancel').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(row(prompt, 'cancel').hasAttribute('data-ring-hover')).toBe(true);
  });

  describe('keeping the ring in view', () => {
    let scroller: HTMLElement;
    let clip = true;
    beforeEach(() => {
      clip = true;
      scroller = document.createElement('div');
      scroller.style.overflowY = 'auto';
      view.appendChild(scroller);
      list(scroller, ['r1', 'r2']);
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
      Object.defineProperty(scroller, 'clientWidth', { value: 100 });
      Object.defineProperty(scroller, 'clientHeight', { value: 100 });
      for (const el of Array.from(scroller.children)) {
        vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, clip ? 90 : 10, 100, 40));
      }
      Element.prototype.scrollIntoView = vi.fn(() => { clip = false; });
    });

    it('reveals a clipped ring in key mode through the polyfilled call', () => {
      setInputMode('keys');
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      // A move onto a clipped key is routine; only a clip of unchanged focus is reported.
      expect(repairs()).toEqual([]);
    });

    it('jumps a held key instead of restarting a smooth reveal', () => {
      setInputMode('keys');
      const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      for (const [key, at] of [['r1', 50_000], ['r2', 50_080], ['r1', 51_000]] as const) {
        clip = true;
        now.mockReturnValue(at);
        a.focus(key, 'key');
        Focus.flush();
      }
      const calls = vi.mocked(Element.prototype.scrollIntoView).mock.calls;
      expect(calls.map(([arg]) => (arg as ScrollIntoViewOptions).behavior)).toEqual(['auto', 'instant', 'auto']);
      now.mockRestore();
    });

    it('lets a smooth reveal finish instead of restarting it, or reporting a clip', () => {
      setInputMode('keys');
      Element.prototype.scrollIntoView = vi.fn();
      let slide = 0;
      for (const el of Array.from(scroller.children)) {
        vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 90 - slide, 100, 40));
      }
      const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      // A key that moves nothing, while the row still slides in on a slow TV.
      slide = 10;
      now.mockReturnValue(50_600);
      a.focus('r2', 'key');
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
      expect(repairs()).toEqual([]);
      // Long after, a row still clipped is a real clip.
      now.mockReturnValue(51_000);
      a.focus('r2', 'key');
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(2);
      expect(repairs()).toEqual([expect.stringContaining('reason=clipped scope=test.list')]);
      now.mockRestore();
    });

    it('reveals again a row that a reveal left no closer, such as a pane reset under it', () => {
      setInputMode('keys');
      Element.prototype.scrollIntoView = vi.fn();
      const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      now.mockReturnValue(50_200);
      a.focus('r2', 'key');
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(2);
      now.mockRestore();
    });

    it('times a held key per surface, so another surface\'s reveal stays smooth', () => {
      setInputMode('keys');
      const now = vi.spyOn(Date, 'now').mockReturnValue(50_000);
      const a = logical('test.list', view);
      const b = logical('live.sidebar', view);
      Focus.setBase(() => a);
      a.focus('r1', 'key');
      Focus.flush();
      clip = true;
      now.mockReturnValue(50_080);
      Focus.push(b);
      b.focus('r2', 'key');
      Focus.flush();
      const calls = vi.mocked(Element.prototype.scrollIntoView).mock.calls;
      expect(calls.map(([arg]) => (arg as ScrollIntoViewOptions).behavior)).toEqual(['auto', 'auto']);
      Focus.pop(b);
      now.mockRestore();
    });

    it('reports a clip of unchanged focus, such as a key that moved nothing', () => {
      setInputMode('keys');
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      clip = false;
      a.focus('r2', 'key');
      Focus.flush();
      clip = true;
      a.focus('r2', 'key');
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
      expect(repairs()).toEqual([expect.stringContaining('reason=clipped scope=test.list')]);
    });

    it('uses the scope\'s own reveal when it has one', () => {
      setInputMode('keys');
      const reveal = vi.fn(() => true);
      const a = logical('test.list', view, { reveal });
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      expect(reveal).toHaveBeenCalledWith('r2');
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
    });

    it('lets the pointer light a clipped item where it is, and a later key reveal it', () => {
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      // A hover: KeyHandler switches to the pointer, then the item takes focus.
      setInputMode('pointer');
      a.focus('r2', 'pointer');
      Focus.input();
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
      // A key that moves nothing still brings the ring into view.
      setInputMode('keys');
      Focus.input();
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('does not chase a smooth scroll from re-renders, nor log each frame', () => {
      setInputMode('keys');
      Element.prototype.scrollIntoView = vi.fn();
      const resolve = vi.fn((key: string) => row(scroller, key));
      const a = logical('test.list', view, { resolve });
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      resolve.mockClear();
      // Still clipped while the scroll animates; each frame may re-render.
      for (let i = 0; i < 3; i++) {
        Focus.afterMorph(scroller);
        Focus.flush();
      }
      // Each re-render inside the owner's root runs a pass, which reveals nothing.
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
      expect(repairs()).toEqual([]);
    });

    it('falls back to the geometric reveal when the scope\'s own declines', () => {
      const reveal = vi.fn(() => false);
      const a = logical('test.list', view, { reveal });
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      expect(reveal).toHaveBeenCalledWith('r2');
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('skips the geometric reveal, and reports no clip, when the scope keeps its key in view', () => {
      setInputMode('keys');
      const reveal = vi.fn((): boolean | null => null);
      const a = logical('test.list', view, { reveal });
      Focus.setBase(() => a);
      a.focus('r2', 'key');
      Focus.flush();
      a.focus('r2', 'key');
      Focus.flush();
      expect(reveal).toHaveBeenCalledTimes(2);
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
      expect(row(scroller, 'r2').classList.contains('focused')).toBe(true);
      expect(repairs()).toEqual([]);
    });

    it('reveals a key the pointer rests on only where the scope asks for it', () => {
      const a = logical('test.list', view, { revealOnHover: (key) => key === 'r2' });
      Focus.setBase(() => a);
      Focus.install();
      for (const key of ['r1', 'r2']) {
        a.focus(key, 'pointer');
        row(scroller, key).dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
        Focus.flush();
      }
      const revealed = () => vi.mocked(Element.prototype.scrollIntoView).mock.contexts
        .map((el) => (el as Element).getAttribute('data-key'));
      expect(revealed()).toEqual(['r2']);
      // A wheel or a click over it is no reason to scroll.
      clip = true;
      document.dispatchEvent(new CustomEvent('nav:wheel', { cancelable: true }));
      Focus.flush();
      expect(revealed()).toEqual(['r2']);
    });

    it('lets a wheel reveal in key mode only when no surface claimed it', () => {
      const a = logical('test.list', view);
      Focus.setBase(() => a);
      Focus.install();
      setInputMode('pointer');
      a.focus('r2', 'pointer');
      Focus.flush();
      setInputMode('keys');
      const claim = (e: Event) => e.preventDefault();
      scroller.addEventListener('nav:wheel', claim);
      row(scroller, 'r2').dispatchEvent(new CustomEvent('nav:wheel', { bubbles: true, cancelable: true }));
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
      scroller.removeEventListener('nav:wheel', claim);
      row(scroller, 'r2').dispatchEvent(new CustomEvent('nav:wheel', { bubbles: true, cancelable: true }));
      Focus.flush();
      expect(row(scroller, 'r2').scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('does not reveal a hovered item just because the hover arrived in key mode', () => {
      const reveal = vi.fn(() => false);
      const a = logical('test.list', view, { reveal });
      Focus.setBase(() => a);
      Focus.install();
      setInputMode('keys');
      a.focus('r2', 'pointer');
      row(scroller, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      Focus.flush();
      expect(reveal).not.toHaveBeenCalled();
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
      // A key in the same pass still reveals.
      Focus.input('hover');
      Focus.input();
      Focus.flush();
      expect(reveal).toHaveBeenCalledWith('r2');
    });

    it('resumes scrolled-away focus where it is and reports it', () => {
      setInputMode('keys');
      const a = logical('test.list', view, { reveal: () => false });
      Focus.setBase(() => a);
      a.resume('r2', 3, 'list=channel', 'target=nearest');
      Focus.flush();
      expect(shown()).toEqual(['r2']);
      expect(row(scroller, 'r2').scrollIntoView).not.toHaveBeenCalled();
      expect(repairs()).toEqual([
        expect.stringContaining(
          'reason=detached scope=test.list distance=3 list=channel target=nearest'),
      ]);
    });
  });
});

describe('Focus kept by a component', () => {
  let rows: string[];
  let current: string;
  let scope: FocusScope;

  function render(): void {
    list(view, rows);
    scope.track(current);
  }

  beforeEach(() => {
    rows = ['r1', 'r2'];
    current = 'r1';
    scope = logical('player.sidebar', view, {
      defaultKey: () => current,
      has: (key) => key === current,
      concealOnLeave: true,
    });
    Focus.push(scope);
    Focus.install();
    render();
    Focus.flush();
  });

  it('waits for an unrendered key the model still has, without repairing it', () => {
    current = 'r9';
    render();
    Focus.flush();
    expect(shown()).toEqual([]);
    expect(scope.focusKey).toBe('r9');
    expect(view.hasAttribute('data-focus-unresolved')).toBe(false);
    expect(repairs()).toEqual([]);
  });

  it('paints an unrendered key once its reveal renders it', () => {
    Focus.uninstall();
    scope = logical('player.sidebar', view, {
      defaultKey: () => current,
      has: (key) => key === current,
      reveal: (key) => {
        rows = ['r8', 'r9'];
        list(view, rows);
        return key === 'r9';
      },
    });
    Focus.push(scope);
    current = 'r9';
    scope.focus('r9', 'key');
    Focus.flush();
    expect(shown()).toEqual(['r9']);
    expect(repairs()).toEqual([]);
  });

  it('conceals the ring once the pointer leaves the root, and keeps it hidden across renders', () => {
    expect(shown()).toEqual(['r1']);
    row(view, 'r1').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: prompt }));
    Focus.flush();
    expect(shown()).toEqual([]);
    current = 'r2';
    render();
    Focus.flush();
    expect(shown()).toEqual([]);
    expect(scope.focusKey).toBe('r2');
    scope.focus('r2', 'pointer');
    Focus.flush();
    expect(shown()).toEqual(['r2']);
  });

  it('keeps the ring while the pointer moves within the root or the keys drive', () => {
    row(view, 'r1').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: row(view, 'r2') }));
    Focus.flush();
    expect(shown()).toEqual(['r1']);
    setInputMode('keys');
    row(view, 'r1').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: prompt }));
    Focus.flush();
    expect(shown()).toEqual(['r1']);
  });
});

describe('Focus requested by the pointer outside the owner', () => {
  it('lights what the pointer rests on, and only that, until the scope owns the keys', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['p1']);
    const below = logical('view.catalog', view);
    let barActive = true;
    const bar = logical('bar', prompt, { tier: Tier.bar, when: () => barActive });
    Focus.push(bar);
    Focus.setBase(() => below);
    installRing();
    Focus.install();
    Focus.flush();
    expect(shown()).toEqual(['p1']);

    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    below.focus('r2', 'pointer');
    expect(shown()).toEqual(['r2', 'p1']);
    row(view, 'r1').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    below.focus('r1', 'pointer');
    expect(shown()).toEqual(['r1', 'p1']);
    below.track('r2');
    expect(shown()).toEqual(['r1', 'p1']);

    barActive = false;
    Focus.flush();
    expect(shown()).toEqual(['r2']);
  });

  it('leaves a pointer request for an item the pointer is not on until the keys come', () => {
    list(view, ['r1', 'r2']);
    list(prompt, ['p1']);
    const reveal = vi.fn(() => true);
    const below = logical('view.catalog', view, { reveal });
    let barActive = true;
    const bar = logical('bar', prompt, { tier: Tier.bar, when: () => barActive });
    Focus.push(bar);
    Focus.setBase(() => below);
    installRing();
    Focus.install();
    Focus.flush();
    below.focus('r1', 'resume');

    below.focus('r2', 'pointer');
    expect(shown()).toEqual(['p1']);
    expect(below.focusKey).toBe('r2');

    barActive = false;
    Focus.flush();
    expect(reveal).toHaveBeenCalledWith('r2');
    expect(shown()).toEqual(['r2']);
  });

  it('keeps the ring of an owner nested in its root when it lights a hovered item', () => {
    list(view, ['r1', 'r2']);
    const panel = document.createElement('div');
    view.appendChild(panel);
    list(panel, ['p1']);
    const below = logical('view.catalog', view);
    const inner = logical('panel', panel);
    Focus.push(inner);
    Focus.setBase(() => below);
    installRing();
    Focus.install();
    Focus.flush();
    expect(shown()).toEqual(['p1']);

    row(view, 'r2').dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    below.focus('r2', 'pointer');
    expect(shown()).toEqual(['r2', 'p1']);
  });

  it('relights the pointer\'s pick when a re-render of its scope replaces it', () => {
    const wrap = document.createElement('div');
    view.appendChild(wrap);
    list(wrap, ['r1', 'r2']);
    list(prompt, ['p1']);
    const below = logical('view.catalog', view);
    const bar = logical('bar', prompt, { tier: Tier.bar });
    Focus.push(bar);
    Focus.setBase(() => below);
    installRing();
    Focus.install();
    wrap.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    below.focus('r2', 'pointer');
    Focus.flush();
    expect(shown()).toEqual(['r2', 'p1']);

    // A new node for r2, with no ring drawn and the owner's untouched.
    morph(wrap, html`<div class="row" data-focusable data-key="r1"></div><span class="row" data-focusable data-key="r2"></span>`);
    expect(shown()).toEqual(['p1']);
    Focus.flush();
    expect(shown()).toEqual(['r2', 'p1']);
  });
});
