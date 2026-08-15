// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { state, playlistMock, epgMock, archiveMock } = vi.hoisted(() => {
  const state = {
    channels: [] as any[],
    playlistTabs: [] as any[],
    programmes: {} as Record<string, any[]>,
  };
  return {
    state,
    playlistMock: {
      groupsRevision: 0,
      get channels() { return state.channels; },
      get playlistTabs() { return state.playlistTabs; },
      getGroupsForPlaylist(playlist?: string) {
        return Array.from(new Set(state.channels
          .filter(ch => !playlist || ch.playlistIds?.includes(playlist))
          .map(ch => ch.group)
          .filter(Boolean)));
      },
      getByGroup(group: string, playlist?: string) {
        return state.channels.filter(ch =>
          (!playlist || ch.playlistIds?.includes(playlist))
          && (group === 'builtin:all'
            || (group === 'builtin:favorites' ? ch.favorite : ch.group === group.slice(7))));
      },
      getGroupCount(group: string, playlist?: string) {
        return this.getByGroup(group, playlist).length;
      },
      indexOf(channel: unknown) {
        return state.channels.indexOf(channel);
      },
    },
    epgMock: {
      get programmes() { return state.programmes; },
      findChannelId: vi.fn((ch: any) => (state.programmes[ch.name] ? ch.name : null)),
      getSourceUrl: vi.fn(() => 'http://host/epg.xml'),
      getProgrammesStartingInRange(id: string, from: number, to: number) {
        return (state.programmes[id] ?? [])
          .filter(programme => programme.start.getTime() >= from && programme.start.getTime() < to);
      },
    },
    archiveMock: {
      getCached: vi.fn(() => null as Set<number> | null | undefined),
      load: vi.fn(async () => null as Set<number> | null),
      isAvailable: vi.fn((channel: { catchupSource?: string }) => !!channel.catchupSource),
    },
  };
});

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({ EpgService: epgMock }));
vi.mock('../services/xtream-archive', () => ({ XtreamArchiveService: archiveMock }));

const { reminderMock, toastMock } = vi.hoisted(() => ({
  reminderMock: { has: vi.fn(() => false), add: vi.fn(), remove: vi.fn() },
  toastMock: vi.fn(),
}));
vi.mock('../services/reminder-service', () => ({ ReminderService: reminderMock }));
vi.mock('./toast', () => ({ showToast: toastMock }));

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    getCatchupProgressList: vi.fn(() => []),
    clearCatchupProgress: vi.fn(),
  },
}));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../workers/app-worker-client', async () => {
  const { ScopedSearchIndex } = await import('../workers/scoped-search-index');
  const index = new ScopedSearchIndex();
  return {
    retainAppWorker: () => () => undefined,
    runAppWorkerTask: (task: string, payload: never) => {
      if (task === 'list-search.index') return Promise.resolve(index.indexList(payload));
      if (task === 'list-search.query') return Promise.resolve(index.queryList(payload));
      if (task === 'list-search.release') return Promise.resolve(index.releaseList(payload));
      return Promise.reject(new Error(`Unexpected worker task: ${task}`));
    },
  };
});

import { EpgGrid } from './epg-grid';
import { setLocale } from '../i18n';

const Y = 2024, M = 5, D = 15; // Sat Jun 15 2024, 12:00 local = "now"

function prog(h1: number, m1: number, h2: number, m2: number, title: string) {
  return {
    start: new Date(Y, M, D, h1, m1),
    stop: new Date(Y, M, D, h2, m2),
    title,
    description: `${title} description`,
    category: '',
    icon: '',
  };
}

let container: HTMLElement;
let onSelect: ReturnType<typeof vi.fn>;
let onManageReminders: ReturnType<typeof vi.fn>;
let grid: EpgGrid;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Y, M, D, 12, 0, 0));
  Element.prototype.scrollIntoView = vi.fn();
  state.channels = [
    { name: 'Chan A', group: 'News', url: 'http://host/a', playlistIds: ['p1'] },
    { name: 'Chan B', group: 'Sports', url: 'http://host/b', playlistIds: ['p2'] },
  ];
  state.playlistTabs = [];
  state.programmes = {
    'Chan A': [
      prog(10, 0, 11, 0, 'Morning'),
      prog(11, 30, 12, 30, 'Noon Show'),
      prog(13, 0, 14, 0, 'Afternoon'),
      {
        start: new Date(Y, M, D + 1, 9, 0),
        stop: new Date(Y, M, D + 1, 10, 0),
        title: 'Tomorrow AM',
        description: '',
        category: '',
        icon: '',
      },
    ],
  };
  vi.clearAllMocks();
  archiveMock.getCached.mockReturnValue(null);
  archiveMock.load.mockResolvedValue(null);
  archiveMock.isAvailable.mockImplementation((channel: { catchupSource?: string }) => !!channel.catchupSource);
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  onSelect = vi.fn();
  onManageReminders = vi.fn();
  grid = new EpgGrid(container, onSelect, undefined, onManageReminders);
});

afterEach(() => {
  vi.useRealTimers();
});

const channelItems = () => Array.from(container.querySelectorAll('.epg-channel-item'));
const dateItems = () => Array.from(container.querySelectorAll('.epg-date-item'));

describe('entry channel focus', () => {
  it('focuses the channel that was playing before the guide opened', () => {
    grid.focusChannel(1);
    grid.render();

    expect(container.querySelector('.epg-channel-item.focused')
      ?.getAttribute('data-channel-idx')).toBe('1');
  });

  it('falls back to the first visible channel when the playing channel is missing', () => {
    grid.focusChannel(99);
    grid.render();

    expect(container.querySelector('.epg-channel-item.focused')
      ?.getAttribute('data-channel-idx')).toBe('0');
  });
});
const progItems = () => Array.from(container.querySelectorAll('.epg-programme-item'));

function clickData(attr: string, value: number): void {
  container.querySelector<HTMLElement>(`[${attr}="${value}"]`)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('EpgGrid.render', () => {
  beforeEach(() => grid.render());

  it('lists every channel', () => {
    expect(channelItems().map(el => el.querySelector('.epg-ch-name')!.textContent)).toEqual(['Chan A', 'Chan B']);
  });

  it('builds one date column per day spanned by program data', () => {
    expect(dateItems()).toHaveLength(2); // today + tomorrow
  });

  it('selects today by default and marks it', () => {
    const today = dateItems()[0];
    expect(today.classList.contains('today')).toBe(true);
    expect(today.classList.contains('selected')).toBe(true);
  });

  it("shows the selected channel's programs for today", () => {
    expect(progItems()).toHaveLength(3);
    expect(container.querySelector('.epg-header')).toBeNull();
    expect(container.querySelector('.epg-page-info')!.textContent).toContain('Chan A');
    expect(container.querySelector('.epg-page-info')!.textContent).toContain('3 programs');
    expect(container.querySelector('.epg-date-bar .epg-legend')).not.toBeNull();
    expect(container.querySelector('.epg-reminder-entry')).not.toBeNull();
  });

  it('does not force focused-item layout on the initial render', () => {
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    grid.render();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('flags the currently airing program with a NOW badge', () => {
    const now = container.querySelector('.epg-programme-item.current');
    expect(now!.querySelector('.epg-now-badge')).not.toBeNull();
    expect(now!.querySelector('.epg-prog-title')!.textContent).toContain('Noon Show');
  });

  it('rebuilds row sizes when refreshed programme data changes descriptions', () => {
    expect(container.querySelector<HTMLElement>(
      '#epg-programmes .epg-virtual-spacer',
    )?.style.height).toBe('324px');

    state.programmes['Chan A'] = state.programmes['Chan A'].map(programme => ({
      ...programme,
      description: '',
    }));
    grid.render();

    expect(container.querySelector<HTMLElement>(
      '#epg-programmes .epg-virtual-spacer',
    )?.style.height).toBe('240px');
  });

  it('replaces the seeded row estimates with measured row heights after paint', () => {
    expect(container.querySelector<HTMLElement>(
      '#epg-programmes .epg-virtual-spacer',
    )?.style.height).toBe('324px');

    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getRect(this: Element) {
      return this.classList.contains('epg-programme-item')
        ? { height: 85 } as DOMRect
        : original.call(this);
    };
    try {
      grid.render();
      expect(container.querySelector<HTMLElement>(
        '#epg-programmes .epg-virtual-spacer',
      )?.style.height).toBe('324px');
      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();
      expect(container.querySelector<HTMLElement>(
        '#epg-programmes .epg-virtual-spacer',
      )?.style.height).toBe('255px');
      expect(progItems().map(el => (el as HTMLElement).style.top))
        .toEqual(['0px', '85px', '170px']);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('renders bounded windows for 50,000 channels and programs', () => {
    state.channels = Array.from({ length: 50_000 }, (_, index) => ({
      name: `Channel ${String(index)}`,
      group: 'Group A',
      url: `http://host/${String(index)}`,
      playlistIds: [],
    }));
    state.programmes = {
      'Channel 0': Array.from({ length: 50_000 }, (_, index) => ({
        ...prog(0, 0, 0, 1, `Program ${String(index)}`),
        start: new Date(Y, M, D, 0, 0, 0, index),
        stop: new Date(Y, M, D, 0, 1, 0, index),
      })),
    };

    grid.render();

    expect(channelItems().length).toBeLessThan(50);
    expect(progItems().length).toBeLessThan(40);
    expect(container.querySelector<HTMLElement>(
      '#epg-channels .epg-virtual-spacer',
    )?.style.height).toBe('3600000px');
    expect(container.querySelector<HTMLElement>(
      '#epg-programmes .epg-virtual-spacer',
    )?.style.height).toBe('5400000px');
  });

  it('renders a bounded group menu for 50,000 groups', () => {
    const originalGroups = playlistMock.getGroupsForPlaylist;
    const originalCount = playlistMock.getGroupCount;
    playlistMock.getGroupsForPlaylist = () =>
      Array.from({ length: 50_000 }, (_, index) => `Group ${String(index)}`);
    playlistMock.getGroupCount = () => 1;
    playlistMock.groupsRevision++;
    try {
      grid.render();
      grid.handleAction('left');
      expect(container.querySelectorAll('.epg-group-option').length).toBeLessThan(60);
      expect(container.querySelector<HTMLElement>('.epg-group-options-spacer')?.style.height)
        .toBe('2200088px');
    } finally {
      playlistMock.getGroupsForPlaylist = originalGroups;
      playlistMock.getGroupCount = originalCount;
      playlistMock.groupsRevision++;
    }
  });
});

describe('EpgGrid mouse interaction', () => {
  beforeEach(() => grid.render());

  it('selecting a different channel re-renders its (empty) guide', () => {
    clickData('data-channel-idx', 1);
    expect(channelItems()[1].classList.contains('selected')).toBe(true);
    expect(container.querySelector('.epg-no-data')!.textContent).toBe('No program information available.');
  });

  it('clicking the already-selected focused channel plays it', () => {
    clickData('data-channel-idx', 0); // focusCol is 'channels' and idx already selected
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('changing the day shows that day programs', () => {
    clickData('data-day-index', 1);
    expect(progItems()).toHaveLength(1);
    expect(progItems()[0].querySelector('.epg-prog-title')!.textContent).toContain('Tomorrow AM');
  });

  it('opens reminder management from the legend by pointer', () => {
    container.querySelector<HTMLElement>('.epg-reminder-entry')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onManageReminders).toHaveBeenCalledOnce();
  });

  it('clicking a past program plays it with catch-up info when channel has catchupSource', () => {
    state.channels = [
      { name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}' },
      { name: 'Chan B', url: 'http://host/b' },
    ];
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    clickData('data-prog-idx', 0); // Morning 10:00-11:00, before noon
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [idx, catchup] = onSelect.mock.calls[0];
    expect(idx).toBe(0);
    expect(catchup).toMatchObject({ title: 'Morning' });
    expect(catchup.start).toBeLessThan(catchup.end);
  });

  it('clicking a future program sets a reminder instead of tuning', () => {
    clickData('data-prog-idx', 2); // Afternoon 13:00-14:00, future vs noon
    expect(reminderMock.add).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('EpgGrid.handleAction', () => {
  beforeEach(() => grid.render());

  it('select on the channels column plays the channel', () => {
    grid.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('right moves focus to the programs column', () => {
    grid.handleAction('right');
    expect(container.querySelector('.epg-programmes-pane')!.classList.contains('pane-focused')).toBe(true);
  });

  it('reaches reminder management after the last date with the D-pad', () => {
    grid.handleAction('right'); // channels -> programmes
    grid.handleAction('up'); // programmes -> dates
    grid.handleAction('right'); // tomorrow
    grid.handleAction('right'); // legend
    expect(container.querySelector('.epg-reminder-entry.focused')).not.toBeNull();

    grid.handleAction('select');
    expect(onManageReminders).toHaveBeenCalledOnce();
  });

  it('moves programme focus inside the rendered window without a full render', () => {
    grid.handleAction('right');
    const render = vi.spyOn(grid, 'render');

    grid.handleAction('down');

    expect(render).not.toHaveBeenCalled();
    expect(container.querySelector('[data-prog-idx="1"]')?.classList.contains('focused')).toBe(true);
    expect(container.querySelector('[data-prog-idx="0"]')?.classList.contains('focused')).toBe(false);
  });

  it('falls back to rendering when programme focus leaves the virtual window', () => {
    state.programmes['Chan A'] = Array.from({ length: 30 }, (_, index) => ({
      start: new Date(Y, M, D, 0, index * 20),
      stop: new Date(Y, M, D, 0, index * 20 + 20),
      title: `Program ${String(index)}`,
      description: `Description ${String(index)}`,
      category: '',
      icon: '',
    }));
    grid.render();
    grid.handleAction('right');
    const render = vi.spyOn(grid, 'render');

    grid.handleAction('channel_down');
    expect(render).not.toHaveBeenCalled();
    grid.handleAction('channel_down');

    expect(render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-prog-idx="20"]')?.classList.contains('focused')).toBe(true);
  });

  it('down moves the channel selection', () => {
    grid.handleAction('down');
    expect(channelItems()[1].classList.contains('selected')).toBe(true);
  });

  it('green jumps the date selection back to today', () => {
    clickData('data-day-index', 1);
    expect(dateItems()[1].classList.contains('selected')).toBe(true);
    grid.handleAction('green');
    expect(dateItems()[0].classList.contains('selected')).toBe(true);
  });
});

describe('EpgGrid playlist tabs', () => {
  beforeEach(() => {
    state.playlistTabs = [
      { id: 'p1', name: 'Playlist 1' },
      { id: 'p2', name: 'Xtream 1' },
    ];
    grid.render();
  });

  it('renders All and each configured source', () => {
    const labels = Array.from(container.querySelectorAll('.epg-playlist-tabs .playlist-tab'))
      .map(item => item.textContent);
    expect(labels).toEqual(['All', 'Playlist 1', 'Xtream 1']);
  });

  it('filters channels by source while preserving global playback indices', () => {
    container.querySelector<HTMLElement>('[data-playlist="p2"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(channelItems().map(item => item.querySelector('.epg-ch-name')!.textContent))
      .toEqual(['Chan B']);
    expect(container.querySelector('[data-channel-idx="1"]')).not.toBeNull();

    grid.handleAction('down');
    grid.handleAction('down');
    grid.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('supports remote navigation and activation of source tabs', () => {
    grid.handleAction('up');
    grid.handleAction('up');
    grid.handleAction('right');
    grid.handleAction('right');
    grid.handleAction('select');

    expect(container.querySelector<HTMLElement>('[data-playlist="p2"]')!
      .classList.contains('active')).toBe(true);
    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan B');
  });
});

describe('EpgGrid group and channel filters', () => {
  beforeEach(() => grid.render());

  it('opens a source-aware group menu and filters with global channel indices', () => {
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const labels = Array.from(container.querySelectorAll('.epg-group-option-label'))
      .map(item => item.textContent);
    expect(labels).toEqual(['All', 'Favorites', 'News', 'Sports']);

    container.querySelector<HTMLElement>('[data-epg-group="source:Sports"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan B');
    expect(container.querySelector('[data-channel-idx="1"]')).not.toBeNull();
  });

  it('filters favorites while preserving global channel indices', () => {
    state.channels[1].favorite = true;
    grid.render();
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group="builtin:favorites"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan B');
    expect(container.querySelector('[data-channel-idx="1"]')).not.toBeNull();
  });

  it('scopes favorites to the selected playlist', () => {
    state.channels[0].favorite = true;
    state.channels[1].favorite = true;
    state.playlistTabs = [
      { id: 'p1', name: 'Playlist 1' },
      { id: 'p2', name: 'Xtream 1' },
    ];
    grid.render();
    container.querySelector<HTMLElement>('[data-playlist="p1"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group="builtin:favorites"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan A');
  });

  it('composes playlist and group filters', () => {
    state.playlistTabs = [
      { id: 'p1', name: 'Playlist 1' },
      { id: 'p2', name: 'Xtream 1' },
    ];
    grid.render();
    container.querySelector<HTMLElement>('[data-playlist="p1"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const labels = Array.from(container.querySelectorAll('.epg-group-option-label'))
      .map(item => item.textContent);
    expect(labels).toEqual(['All', 'Favorites', 'News']);
  });

  it('searches channel names and preserves global indices', async () => {
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    input.value = 'Chan B';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await vi.waitFor(() => expect(channelItems()).toHaveLength(1));
    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan B');
    expect(container.querySelector('[data-channel-idx="1"]')).not.toBeNull();
  });

  it('applies search inside the selected group and shows an empty state', () => {
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group="source:News"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    input.value = 'Chan B';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(channelItems()).toHaveLength(0);
    expect(container.querySelector('.epg-no-channels')!.textContent).toBe('No channels found');
  });

  it('opens groups with Left and selects a group with the remote', () => {
    grid.handleAction('left');
    expect(grid.isFilterOpen).toBe(true);

    grid.handleAction('down');
    grid.handleAction('down');
    grid.handleAction('down');
    grid.handleAction('select');

    expect(grid.isFilterOpen).toBe(false);
    expect(channelItems()).toHaveLength(1);
    expect(channelItems()[0].querySelector('.epg-ch-name')!.textContent).toBe('Chan B');
  });

  it('rebuilds cached group labels after a language change', () => {
    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('.epg-group-option-label')?.textContent).toBe('All');

    setLocale('zh-CN');
    grid.render();

    expect(container.querySelector('.epg-group-option-label')?.textContent).toBe('全部');
  });

  it('focuses search with Yellow and exits to results with ArrowDown', async () => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    expect(document.activeElement).toBe(input);
    expect(grid.isFilterOpen).toBe(true);

    input.value = 'Chan B';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(channelItems()).toHaveLength(1));
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
    }));

    expect(document.activeElement).not.toBe(input);
    grid.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('deactivates an open filter before leaving the EPG view', () => {
    grid.handleAction('yellow');
    expect(grid.isFilterOpen).toBe(true);

    grid.deactivateFilters();

    expect(grid.isFilterOpen).toBe(false);
    expect(document.activeElement).not.toBe(
      container.querySelector<HTMLInputElement>('.epg-search-input'),
    );
  });
});

describe('EpgGrid morph lifecycle', () => {
  it('preserves channel-item node identity across re-renders that only change focus', () => {
    grid.render();
    const beforeA = container.querySelector<HTMLElement>('[data-channel-idx="0"]')!;
    const beforeB = container.querySelector<HTMLElement>('[data-channel-idx="1"]')!;
    grid.handleAction('down');
    expect(container.querySelector('[data-channel-idx="0"]')).toBe(beforeA);
    expect(container.querySelector('[data-channel-idx="1"]')).toBe(beforeB);
    // The new selection is reflected via class only.
    expect(beforeB.classList.contains('selected')).toBe(true);
  });

  it('binds pane click handlers once (no accumulation across re-renders)', () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const spy = vi.spyOn(c, 'addEventListener');
    const g = new EpgGrid(c, vi.fn());
    g.render();
    g.handleAction('down');
    g.handleAction('right');
    g.handleAction('down');
    const clicks = spy.mock.calls.filter(([t]) => t === 'click').length;
    const mouseovers = spy.mock.calls.filter(([t]) => t === 'mouseover').length;
    expect(clicks).toBe(1);
    expect(mouseovers).toBe(1);
  });
});

describe('EpgGrid reminders', () => {
  beforeEach(() => { reminderMock.has.mockReturnValue(false); grid.render(); });

  it('OK on a future program adds a reminder and does not tune', () => {
    grid.handleAction('right');            // focusCol → programmes (Morning, past)
    grid.handleAction('down'); grid.handleAction('down'); // → "Afternoon" (13:00, future)
    grid.handleAction('select');
    expect(reminderMock.add).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('OK on a future program that already has a reminder removes it', () => {
    reminderMock.has.mockReturnValue(true);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('down'); grid.handleAction('down');
    grid.handleAction('select');
    expect(reminderMock.remove).toHaveBeenCalledTimes(1);
  });

  it('renders a dim (unset) bell on every future program as an affordance', () => {
    reminderMock.has.mockReturnValue(false);
    grid.render();
    expect(container.querySelector('#epg-programmes .epg-bell-glyph.unset')).not.toBeNull();
    expect(container.querySelector('#epg-programmes .epg-bell-glyph.set')).toBeNull();
  });

  it('renders an accent (set) bell on a reminded future program', () => {
    reminderMock.has.mockReturnValue(true);
    grid.render();
    expect(container.querySelector('#epg-programmes .epg-bell-glyph.set')).not.toBeNull();
  });

  it('OK on a live program still tunes (no reminder)', () => {
    grid.handleAction('right');
    grid.handleAction('down'); // "Noon Show" (11:30-12:30, live at 12:00)
    grid.handleAction('select');
    expect(onSelect).toHaveBeenCalled();
    expect(reminderMock.add).not.toHaveBeenCalled();
  });
});

// --- Catch-up resume/history integration tests ---

describe('EpgGrid catch-up resume markers', () => {
  const catchupChannel = () => {
    state.channels = [
      { name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}' },
    ];
  };

  beforeEach(() => {
    catchupChannel();
    storageMock.getCatchupProgressList.mockReturnValue([]);
    storageMock.clearCatchupProgress.mockClear();
  });

  it('renders a Resume badge and progress bar for a partial entry', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 1800, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    const item = container.querySelector('[data-prog-idx="0"]');
    expect(item!.querySelector('.epg-catchup-badge')!.textContent).toContain('Resume');
    const bar = item!.querySelector<HTMLElement>('.epg-catchup-progress-fill');
    expect(bar).not.toBeNull();
    // 1800/3600 = 50%
    expect(bar!.style.width).toBe('50%');
  });

  it('renders a Watched badge for a completed entry', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 3600, duration: 3600, updatedAt: 0, completed: true },
    ]);
    grid.render();
    const item = container.querySelector('[data-prog-idx="0"]');
    expect(item!.querySelector('.epg-catchup-badge')!.textContent).toContain('Watched');
    expect(item!.querySelector('.epg-catchup-progress-fill')).toBeNull();
  });

  it('does not render a marker for a channel without catchupSource', () => {
    state.channels = [{ name: 'Chan A', url: 'http://host/a' }]; // no catchupSource
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 1800, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    expect(container.querySelector('.epg-catchup-badge')).toBeNull();
  });

  it('does not render a marker for a future programme', () => {
    const startMs = new Date(Y, M, D, 13, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 1800, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    const item = container.querySelector('[data-prog-idx="2"]'); // Afternoon (future)
    expect(item!.querySelector('.epg-catchup-badge')).toBeNull();
  });

  it('does not render a marker when no progress entry matches', () => {
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    expect(container.querySelector('.epg-catchup-badge')).toBeNull();
  });

  it('calls getCatchupProgressList once per render, not once per programme', () => {
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    expect(storageMock.getCatchupProgressList).toHaveBeenCalledTimes(1);
  });

  it('clamps progress fill between 0 and 100%', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 9999, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    const bar = container.querySelector<HTMLElement>('.epg-catchup-progress-fill');
    expect(bar!.style.width).toBe('100%');
  });

  it('shows Resume badge but not progress bar for a partial entry with duration=0', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 15, duration: 0, updatedAt: 0, completed: false },
    ]);
    grid.render();
    const item = container.querySelector('[data-prog-idx="0"]');
    expect(item!.querySelector('.epg-catchup-badge')!.textContent).toContain('Resume');
    const bar = item!.querySelector('.epg-catchup-progress-fill');
    expect(bar).toBeNull();
  });
});

describe('EpgGrid catch-up selection behavior', () => {
  const catchupChannel = () => {
    state.channels = [
      { name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}' },
    ];
  };

  beforeEach(() => {
    catchupChannel();
    storageMock.getCatchupProgressList.mockReturnValue([]);
    storageMock.clearCatchupProgress.mockClear();
  });

  it('selecting a partial entry opens the resume prompt and does not call onChannelSelect', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right'); // focus programmes
    grid.handleAction('select'); // Morning (past, partial)
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.catchup-resume-prompt')).not.toBeNull();
  });

  it('Resume passes resumeSecs to onChannelSelect', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select');
    // Simulate choosing Resume
    grid.handleAction('select'); // Resume is default focus
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [idx, catchup] = onSelect.mock.calls[0];
    expect(idx).toBe(0);
    expect(catchup.resumeSecs).toBe(300);
  });

  it('Start Over clears the entry and starts from zero', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select');
    // Navigate to Start Over (right from Resume)
    grid.handleAction('right');
    grid.handleAction('select');
    expect(storageMock.clearCatchupProgress).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [, catchup] = onSelect.mock.calls[0];
    expect(catchup.resumeSecs).toBeUndefined();
  });

  it('Cancel leaves EPG unchanged and does not call onChannelSelect', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select');
    // Navigate to Cancel
    grid.handleAction('right');
    grid.handleAction('right');
    grid.handleAction('select');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('while prompt is visible, actions route to it and EPG focus does not move', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select'); // opens prompt
    // Now pressing down should NOT move EPG programme focus
    grid.handleAction('down');
    // Prompt is still visible and EPG focus hasn't moved
    expect(document.querySelector('.catchup-resume-prompt.hidden')).toBeNull();
  });

  it('selecting a completed entry plays from zero without prompt', () => {
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 3600, duration: 3600, updatedAt: 0, completed: true },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select');
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [, catchup] = onSelect.mock.calls[0];
    expect(catchup.resumeSecs).toBeUndefined();
    // No prompt opened
    expect(document.querySelector('.catchup-resume-prompt:not(.hidden)')).toBeNull();
  });

  it('selecting an untouched past entry plays normally without prompt', () => {
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select'); // Morning, past, no progress
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [, catchup] = onSelect.mock.calls[0];
    expect(catchup.resumeSecs).toBeUndefined();
  });

  it('programme title remains XSS-safe in the resume prompt', () => {
    state.programmes['Chan A'] = [
      prog(10, 0, 11, 0, '<img src=x onerror=alert(1)>'),
      prog(11, 30, 12, 30, 'Noon Show'),
      prog(13, 0, 14, 0, 'Afternoon'),
    ];
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
    grid.handleAction('right');
    grid.handleAction('select');
    expect(document.querySelector('.catchup-resume-message img')).toBeNull();
  });
});

describe('EpgGrid non-catchup channel selection', () => {
  beforeEach(() => {
    // Channel without catchupSource
    state.channels = [{ name: 'Chan A', url: 'http://host/a' }];
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
  });

  describe('EpgGrid Xtream archive availability', () => {
    it('does not play a program whose has_archive flag is false', async () => {
      state.channels = [{
        name: 'Chan A',
        url: 'http://host/a',
        catchupSource: 'http://host/catchup/{start}',
        catchupAccountId: 'x1',
        catchupStreamId: '101',
      }];
      archiveMock.getCached.mockReturnValue(new Set());
      archiveMock.load.mockResolvedValue(new Set());
      archiveMock.isAvailable.mockReturnValue(false);
      grid.render();
      grid.handleAction('right');
      grid.handleAction('select');
      await Promise.resolve();

      expect(onSelect).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledWith("This program isn't available for catch-up.");
    });
  });

  it('selecting a past programme on a non-catchup channel passes no CatchupInfo', () => {
    grid.handleAction('right'); // focus programmes
    grid.handleAction('select'); // Morning (past)
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [idx, catchup] = onSelect.mock.calls[0];
    expect(idx).toBe(0);
    expect(catchup).toBeUndefined();
  });
});

describe('EpgGrid prompt visibility query', () => {
  beforeEach(() => {
    state.channels = [
      { name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}' },
    ];
    const startMs = new Date(Y, M, D, 10, 0).getTime();
    storageMock.getCatchupProgressList.mockReturnValue([
      { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
    ]);
    grid.render();
  });

  it('isPromptVisible returns false when prompt is not open', () => {
    expect(grid.isPromptVisible).toBe(false);
  });

  it('isPromptVisible returns true when catch-up prompt is open', () => {
    grid.handleAction('right');
    grid.handleAction('select'); // opens prompt
    expect(grid.isPromptVisible).toBe(true);
  });

  it('isPromptVisible returns false after prompt is dismissed', () => {
    grid.handleAction('right');
    grid.handleAction('select'); // opens prompt
    grid.handleAction('back'); // cancel prompt
    expect(grid.isPromptVisible).toBe(false);
  });

  it('back action while prompt is visible cancels prompt, does not leave EPG', () => {
    grid.handleAction('right');
    grid.handleAction('select'); // opens prompt
    grid.handleAction('back');
    expect(grid.isPromptVisible).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('dismissPrompt hides the prompt if it is open', () => {
    grid.handleAction('right');
    grid.handleAction('select'); // opens prompt
    expect(grid.isPromptVisible).toBe(true);
    grid.dismissPrompt();
    expect(grid.isPromptVisible).toBe(false);
  });
});

describe('EpgGrid click pointer activation', () => {
  beforeEach(() => {
    state.channels = [
      { name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}' },
    ];
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
  });

  it('click on a programme activates it', () => {
    const item = container.querySelector<HTMLElement>('[data-prog-idx="0"]')!;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('click outside any item does nothing', () => {
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('binds click once (no accumulation)', () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const spy = vi.spyOn(c, 'addEventListener');
    new EpgGrid(c, vi.fn());
    const clicks = spy.mock.calls.filter(([t]) => t === 'click').length;
    expect(clicks).toBe(1);
    spy.mockRestore();
  });

  it('mouseover still updates focus without full render', () => {
    const item1 = container.querySelector<HTMLElement>('[data-prog-idx="1"]')!;
    item1.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(item1.classList.contains('focused')).toBe(true);
  });

  it('measures variable programme rows only after the first paint', () => {
    const row = container.querySelector<HTMLElement>('[data-prog-idx="0"]')!;
    const measure = vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 96,
      top: 0,
      right: 100,
      bottom: 96,
      left: 0,
      toJSON: () => ({}),
    });

    grid.render();
    expect(measure).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(measure).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(measure).toHaveBeenCalledOnce();
  });
});
