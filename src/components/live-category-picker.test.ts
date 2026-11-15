// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialLiveCategorySelection,
  liveCategoryFilterFrom,
  LiveCategoryPicker,
  unseenLiveCategoryIds,
  type LiveCategoryPickerOptions,
} from './live-category-picker';
import { Focus } from '../navigation/focus-scope';

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock('./toast', () => ({ showToast: toastMock }));

const CATEGORIES = [
  { id: 'c1', name: 'Alpha', parentId: '0' },
  { id: 'c2', name: 'Bravo', parentId: '0' },
  { id: 'c3', name: 'Charlie', parentId: '0' },
];

describe('picker selection model', () => {
  const ids = ['c1', 'c2', 'c3'];

  it('starts from the stored filter', () => {
    expect([...initialLiveCategorySelection(ids, undefined)]).toEqual(ids);
    expect([...initialLiveCategorySelection(ids, { mode: 'include', ids: ['c2', 'c9'] })]).toEqual(['c2']);
    expect([...initialLiveCategorySelection(ids, { mode: 'exclude', ids: ['c2'] })]).toEqual(['c1', 'c3']);
  });

  it('stores checked ids with the toggle off and unchecked ids with it on', () => {
    const selected = new Set(['c1', 'c3']);
    expect(liveCategoryFilterFrom(ids, selected, false)).toEqual({ mode: 'include', ids: ['c1', 'c3'] });
    expect(liveCategoryFilterFrom(ids, selected, true)).toEqual({ mode: 'exclude', ids: ['c2'] });
    expect(liveCategoryFilterFrom(ids, new Set(ids), true)).toBeUndefined();
  });

  it('marks unknown categories new unless the user already selected them', () => {
    const snapshot = { knownIds: ['c1'], announcedIds: [], counts: {} };
    expect(unseenLiveCategoryIds(ids, { mode: 'include', ids: ['c1'] }, snapshot)).toEqual(['c2', 'c3']);
    expect(unseenLiveCategoryIds(ids, { mode: 'include', ids: ['c2'] }, snapshot)).toEqual(['c3']);
  });

  it('never marks categories new when new ones show automatically', () => {
    const snapshot = { knownIds: ['c1'], announcedIds: [], counts: {} };
    expect(unseenLiveCategoryIds(ids, undefined, snapshot)).toEqual([]);
    expect(unseenLiveCategoryIds(ids, { mode: 'exclude', ids: ['c1'] }, snapshot)).toEqual([]);
    expect(unseenLiveCategoryIds(ids, undefined, null)).toEqual([]);
  });
});

describe('LiveCategoryPicker', () => {
  let picker: LiveCategoryPicker;
  let options: LiveCategoryPickerOptions;

  const root = (): HTMLElement => document.querySelector<HTMLElement>('.live-category-picker')!;
  const row = (id: string, section = 'all'): HTMLElement =>
    root().querySelector<HTMLElement>(`[data-key="${section}:${id}"]`)!;

  async function open(overrides: Partial<LiveCategoryPickerOptions> = {}): Promise<void> {
    options = {
      accountId: 'a1',
      accountName: 'Acct <b>',
      filter: undefined,
      snapshot: null,
      loadCategories: vi.fn(async () => CATEGORIES),
      onDone: vi.fn(),
      onCancel: vi.fn(),
      ...overrides,
    };
    picker.open(options);
    await vi.waitFor(() => expect(root().querySelector('[data-category-id]')).not.toBeNull());
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    document.body.innerHTML = '';
    toastMock.mockClear();
    picker = new LiveCategoryPicker();
  });

  afterEach(() => picker.hide());

  it('lists categories with counts, escapes the account name, and checks all by default', async () => {
    await open({ snapshot: { knownIds: ['c1', 'c2', 'c3'], announcedIds: [], counts: { c1: 4 } } });
    expect(picker.visible).toBe(true);
    expect(root().querySelector('.live-category-account-name')!.textContent).toBe('Acct <b>');
    expect(root().querySelectorAll('.live-category-row.favorite-selected')).toHaveLength(3);
    expect(row('c1').querySelector('strong')!.textContent).toBe('4');
    expect(row('c2').querySelector('strong')).toBeNull();
    expect(root().querySelector('.source-toggle')!.getAttribute('data-enabled')).toBe('false');
  });

  it('puts unseen categories in a New section at the top', async () => {
    await open({
      filter: { mode: 'include', ids: ['c1'] },
      snapshot: { knownIds: ['c1', 'c2'], announcedIds: [], counts: {} },
    });
    const fresh = row('c3', 'new');
    expect(fresh.querySelector('.live-category-new')).not.toBeNull();
    expect(fresh.classList.contains('favorite-selected')).toBe(false);
    const keys = Array.from(root().querySelectorAll<HTMLElement>('[data-category-id]')).map(el => el.dataset.key);
    expect(keys[0]).toBe('new:c3');
    expect(keys).not.toContain('all:c3');
    expect(keys.filter(key => key?.endsWith(':c3'))).toHaveLength(1);
  });

  it('returns the original filter when nothing changed', async () => {
    await open();
    picker.handleAction('back');
    expect(options.onDone).toHaveBeenCalledWith(undefined, CATEGORIES);
    expect(picker.visible).toBe(false);
  });

  it('saves unchecked rows as an include filter with the toggle off', async () => {
    await open();
    row('c2').click();
    picker.handleAction('yellow');
    expect(options.onDone).toHaveBeenCalledWith({ mode: 'include', ids: ['c1', 'c3'] }, CATEGORIES);
  });

  it('saves an exclude filter when new categories show automatically', async () => {
    await open();
    root().querySelector<HTMLElement>('.source-toggle')!.click();
    row('c3').click();
    picker.handleAction('yellow');
    expect(options.onDone).toHaveBeenCalledWith({ mode: 'exclude', ids: ['c3'] }, CATEGORIES);
  });

  it('blocks saving with nothing selected and Select all recovers', async () => {
    await open();
    picker.handleAction('green');
    picker.handleAction('back');
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(options.onDone).not.toHaveBeenCalled();
    expect(picker.visible).toBe(true);
    picker.handleAction('red');
    picker.handleAction('back');
    expect(options.onDone).toHaveBeenCalledWith({ mode: 'include', ids: ['c1', 'c2', 'c3'] }, CATEGORIES);
  });

  it('focuses Try again when categories fail to load and retries', async () => {
    const loadCategories = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(CATEGORIES);
    picker.open({
      accountId: 'a1',
      accountName: 'Acct',
      filter: undefined,
      snapshot: null,
      loadCategories,
      onDone: vi.fn(),
      onCancel: vi.fn(),
    });
    await vi.waitFor(() => expect(root().querySelector('[data-live-categories-retry]')).not.toBeNull());
    expect(root().querySelector('.source-toggle')).toBeNull();
    expect(root().querySelector('[data-live-categories-retry]')!.classList.contains('focused')).toBe(true);
    root().querySelector<HTMLElement>('[data-live-categories-retry]')!.click();
    await vi.waitFor(() => expect(root().querySelector('[data-category-id]')).not.toBeNull());
    expect(loadCategories).toHaveBeenCalledTimes(2);
  });

  it('calls onCancel when closed from the error state', async () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();
    picker.open({ accountId: 'a1', accountName: 'Acct', filter: undefined, snapshot: null,
      loadCategories: async () => { throw new Error('offline'); }, onDone, onCancel });
    await vi.waitFor(() => expect(root().querySelector('[data-live-categories-retry]')).not.toBeNull());
    picker.handleAction('back');
    expect(onCancel).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(picker.visible).toBe(false);
  });

  it('hide() discards a pending load without rendering it later', async () => {
    let resolve: (value: typeof CATEGORIES) => void = () => {};
    const onDone = vi.fn();
    picker.open({ accountId: 'a1', accountName: 'Acct', filter: undefined, snapshot: null,
      loadCategories: () => new Promise(r => { resolve = r; }), onDone, onCancel: vi.fn() });
    picker.hide();
    resolve(CATEGORIES);
    await Promise.resolve();
    expect(root().querySelector('[data-category-id]')).toBeNull();
    expect(picker.visible).toBe(false);
  });

  describe('account switcher', () => {
    const ACCOUNTS = [
      { id: 'a1', name: 'Alpha', url: 'http://host/a', source: 'xtream' as const },
      { id: 'a2', name: 'Bravo', url: 'http://host/b', source: 'xtream' as const },
    ];
    const slot = () => root().querySelector<HTMLElement>('[data-live-category-avatar]')!;
    let pointerHit: Element | null = null;
    // jsdom has no layout, so the switcher's hit test is pointed explicitly.
    const clickAvatar = (): void => {
      pointerHit = slot().querySelector('.account-avatar');
      pointerHit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      pointerHit = null;
    };
    beforeEach(() => {
      document.elementFromPoint = vi.fn(() => pointerHit);
    });

    it('stays hidden without another account', async () => {
      await open({ accounts: [ACCOUNTS[0]], onSwitch: vi.fn() });
      expect(slot().classList.contains('hidden')).toBe(true);
      expect(slot().hasAttribute('data-focusable')).toBe(false);
      expect(slot().querySelector('.account-avatar')).toBeNull();
    });

    it('applies the current account before opening the chosen one', async () => {
      const onSwitch = vi.fn();
      await open({ accounts: ACCOUNTS, onSwitch });
      expect(slot().hasAttribute('data-focusable')).toBe(true);
      expect(slot().querySelector('.account-avatar')!.textContent).toBe('A');
      row('c2').click();
      clickAvatar();
      expect(root().querySelector('.account-menu')).not.toBeNull();
      picker.handleAction('down');
      picker.handleAction('select');
      expect(options.onDone).toHaveBeenCalledWith({ mode: 'include', ids: ['c1', 'c3'] }, CATEGORIES);
      expect(onSwitch).toHaveBeenCalledWith('a2');
      expect(picker.visible).toBe(false);
    });

    it('lets the keys leave the account menu once choosing an account closes the picker', async () => {
      let ownerAtDone: string | null | undefined;
      await open({ accounts: ACCOUNTS, onSwitch: vi.fn(), onDone: () => { ownerAtDone = Focus.owner()?.id ?? null; } });
      clickAvatar();
      expect(Focus.owner()?.id).toBe('prompt.live_categories.accounts');
      picker.handleAction('down');
      picker.handleAction('select');
      expect(picker.visible).toBe(false);
      expect(ownerAtDone).toBeNull();
    });

    it('keeps editing the current account while nothing is selected', async () => {
      const onSwitch = vi.fn();
      await open({ accounts: ACCOUNTS, onSwitch });
      picker.handleAction('green');
      clickAvatar();
      picker.handleAction('down');
      picker.handleAction('select');
      expect(toastMock).toHaveBeenCalledTimes(1);
      expect(onSwitch).not.toHaveBeenCalled();
      expect(picker.visible).toBe(true);
      expect(slot().querySelector('.account-avatar')!.textContent).toBe('A');
    });

    it('closes an open menu with Back instead of closing the picker', async () => {
      await open({ accounts: ACCOUNTS, onSwitch: vi.fn() });
      clickAvatar();
      picker.handleAction('back');
      expect(root().querySelector('.account-menu')).toBeNull();
      expect(picker.visible).toBe(true);
      expect(options.onDone).not.toHaveBeenCalled();
    });
  });

  describe('with a large catalog', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i + 1}`, name: `Group ${i + 1}`, parentId: '0' }));
    const focusedKey = () => {
      Focus.flush();
      return root().querySelector<HTMLElement>('.focused')?.dataset.key;
    };
    const list = () => root().querySelector<HTMLElement>('[data-live-category-list]')!;

    it('mounts only a window of rows and keeps the full scroll height', async () => {
      await open({ loadCategories: vi.fn(async () => many) });
      const rows = root().querySelectorAll('[data-category-id]').length;
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(40);
      const spacer = root().querySelector<HTMLElement>('.live-category-spacer')!;
      expect(parseFloat(spacer.style.height)).toBeGreaterThan(5000 * 60);
      expect(root().querySelector('.live-category-summary')!.textContent).toContain('5000');
    });

    it('steps the D-pad past the rendered window and back to the section header', async () => {
      await open({
        loadCategories: vi.fn(async () => many),
        filter: { mode: 'include', ids: ['c1'] },
        snapshot: { knownIds: many.slice(0, 4998).map(c => c.id), announcedIds: [], counts: {} },
      });
      expect(focusedKey()).toBe('new:c4999');
      picker.handleAction('down');
      picker.handleAction('down');
      expect(focusedKey()).toBe('all:c1');
      for (let i = 0; i < 100; i++) picker.handleAction('down');
      expect(focusedKey()).toBe('all:c101');
      expect(root().querySelector('[data-key="all:c1"]')).toBeNull();

      for (let i = 0; i < 100; i++) picker.handleAction('up');
      expect(focusedKey()).toBe('all:c1');
      expect(root().querySelector('[data-key="head:all"]')).not.toBeNull();
      picker.handleAction('up');
      expect(focusedKey()).toBe('new:c5000');
    });

    it('toggles an off-window row and Select all covers every category', async () => {
      await open({ loadCategories: vi.fn(async () => many), filter: { mode: 'include', ids: ['c1'] } });
      for (let i = 0; i < 300; i++) picker.handleAction('down');
      expect(focusedKey()).toBe('all:c301');
      picker.handleAction('select');
      expect(focusedKey()).toBe('all:c301');
      expect(row('c301').getAttribute('aria-pressed')).toBe('true');
      picker.handleAction('green');
      picker.handleAction('red');
      picker.handleAction('yellow');
      expect(options.onDone).toHaveBeenCalledWith({ mode: 'include', ids: many.map(c => c.id) }, many);
    });

    it('resumes from the remembered row after a wheel scroll unmounts it', async () => {
      await open({ loadCategories: vi.fn(async () => many) });
      expect(focusedKey()).toBe('all:c1');
      list().scrollTop = 64 * 2000;
      list().dispatchEvent(new Event('scroll'));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(root().querySelector('[data-key="all:c1"]')).toBeNull();
      expect(root().querySelector('[data-key="all:c2001"]')).not.toBeNull();

      picker.handleAction('down');
      expect(focusedKey()).toBe('all:c2');
    });
  });
});
