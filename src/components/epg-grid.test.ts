// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi, type Mock } from 'vitest';
import type { CatchupProgressEntry, GuideLayout } from '../types';

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
      getProgrammes: (id: string) => state.programmes[id] ?? null,
      getProgrammeStartRange() {
        const starts = Object.values(state.programmes).flatMap(list => list.length
          ? [list[0].start.getTime(), list[list.length - 1].start.getTime()]
          : []);
        return starts.length ? { min: Math.min(...starts), max: Math.max(...starts) } : null;
      },
      findChannelId: vi.fn((ch: any) => (state.programmes[ch.name] ? ch.name : null)),
      getSourceUrl: vi.fn(() => 'http://host/epg.xml'),
      guideRevision: 0,
      mappingRevision: 0,
      getProgrammesIntersectingRange(id: string, from: number, to: number) {
        return (state.programmes[id] ?? [])
          .filter(programme => programme.stop.getTime() > from && programme.start.getTime() < to);
      },
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
  reminderMock: {
    has: vi.fn(() => false),
    list: vi.fn((): Array<{ channelKey: string; startMs: number }> => []),
    add: vi.fn(),
    remove: vi.fn(),
    revision: 0,
    listeners: [] as Array<() => void>,
    onChange(listener: () => void) {
      this.listeners.push(listener);
      return () => { this.listeners = this.listeners.filter(item => item !== listener); };
    },
  },
  toastMock: vi.fn(),
}));
vi.mock('../services/reminder-service', () => ({ ReminderService: reminderMock }));
vi.mock('./toast', () => ({ showToast: toastMock }));

const { storageMock } = vi.hoisted(() => ({
  storageMock: {
    getCatchupProgressList: vi.fn((): CatchupProgressEntry[] => []),
    clearCatchupProgress: vi.fn(),
    getGuideLayout: vi.fn((): GuideLayout => 'schedule'),
    getCustomThemes: vi.fn(() => []),
    getTheme: vi.fn(() => 'midnight'),
    getThemeCss: vi.fn(() => ''),
    setThemeCss: vi.fn(),
  },
}));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
const { workerMock } = vi.hoisted(() => ({ workerMock: { failIndexes: false } }));
vi.mock('../workers/app-worker-client', async () => {
  const { ScopedSearchIndex } = await import('../workers/scoped-search-index');
  const index = new ScopedSearchIndex();
  return {
    retainAppWorker: () => () => undefined,
    runAppWorkerTask: (task: string, payload: never) => {
      if (task === 'list-search.index') {
        if (workerMock.failIndexes) return Promise.reject(new Error('App worker failed'));
        return Promise.resolve(index.indexList(payload));
      }
      if (task === 'list-search.query') return Promise.resolve(index.queryList(payload));
      if (task === 'list-search.release') return Promise.resolve(index.releaseList(payload));
      return Promise.reject(new Error(`Unexpected worker task: ${task}`));
    },
  };
});

import { EpgGrid } from './epg-grid';
import { TimelineView } from './epg-timeline-view';
import { installCustomThemes } from '../services/theme-service';
import { setLocale } from '../i18n';
import { Focus } from '../navigation/focus-scope';
import { setInputMode } from '../navigation/input-mode';
import { CONFIG } from '../config';
import { channelKey } from '../utils/channel';
import { ParentalControlService } from '../services/parental-control';
import { installEdgeScroll } from '../navigation/edge-scroll';

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
type EpgGridArgs = ConstructorParameters<typeof EpgGrid>;
let onSelect: Mock<EpgGridArgs[1]>;
let onManageReminders: Mock<NonNullable<EpgGridArgs[3]>>;
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
  reminderMock.listeners.length = 0;
  workerMock.failIndexes = false;
  archiveMock.getCached.mockReturnValue(null);
  archiveMock.load.mockResolvedValue(null);
  archiveMock.isAvailable.mockImplementation((channel: { catchupSource?: string }) => !!channel.catchupSource);
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  onSelect = vi.fn<EpgGridArgs[1]>();
  onManageReminders = vi.fn<NonNullable<EpgGridArgs[3]>>();
  grid = new EpgGrid(container, onSelect, undefined, onManageReminders);
  Focus.setBase(() => grid.focusScope);
});

afterEach(() => {
  vi.useRealTimers();
  Focus.uninstall();
});

const channelItems = () => Array.from(container.querySelectorAll('.epg-channel-item'));
const dateItems = () => Array.from(container.querySelectorAll('.epg-date-item'));

describe('entry channel focus', () => {
  it('focuses the channel that was playing before the guide opened', () => {
    grid.focusChannel(1);
    grid.render();
    Focus.flush();

    expect(container.querySelector('.epg-channel-item.focused')
      ?.getAttribute('data-channel-idx')).toBe('1');
  });

  it('falls back to the first visible channel when the playing channel is missing', () => {
    grid.focusChannel(99);
    grid.render();
    Focus.flush();

    expect(container.querySelector('.epg-channel-item.focused')
      ?.getAttribute('data-channel-idx')).toBe('0');
  });

  it('keeps copies that differ only by a token apart', () => {
    state.channels = [
      { name: 'Chan A', group: 'News', url: 'http://host/a?token=t1', playlistIds: ['p1'] },
      { name: 'Chan A', group: 'News', url: 'http://host/a?token=t2', playlistIds: ['p1'] },
    ];
    grid.focusChannel(1);
    grid.render();
    Focus.flush();

    const keys = channelItems().map(item => item.getAttribute('data-key'));
    expect(new Set(keys).size).toBe(2);
    expect(container.querySelector('.epg-channel-item.focused')
      ?.getAttribute('data-channel-idx')).toBe('1');
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

  it('does not force focused-item layout on a render', () => {
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    grid.render();
    Focus.flush();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('flags the currently airing program with a NOW badge', () => {
    const now = container.querySelector('.epg-programme-item.current');
    expect(now!.querySelector('.live-badge')).not.toBeNull();
    expect(now!.querySelector('.epg-prog-title')!.textContent).toContain('Noon Show');
  });

  it('leaves long descriptions whole for the CSS line clamp', () => {
    const description = 'word '.repeat(60).trim();
    const [first, ...rest] = state.programmes['Chan A'];
    state.programmes['Chan A'] = [{ ...first, description }, ...rest];
    grid.render();

    expect(progItems()[0].querySelector('.epg-prog-desc')!.textContent).toBe(description);
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

  it('leaves a list the user scrolled where it is on a background refresh', () => {
    state.channels = Array.from({ length: 200 }, (_, index) => ({
      name: `Channel ${String(index)}`,
      group: 'Group A',
      url: `http://host/${String(index)}`,
      playlistIds: [],
    }));
    grid.focusChannel(0);
    grid.render(true);
    const list = container.querySelector<HTMLElement>('.epg-channel-list')!;
    list.scrollTop = 2000;

    grid.render();

    expect(list.scrollTop).toBe(2000);
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
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
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
    expect(catchup?.start).toBeLessThan(catchup?.end ?? 0);
  });

  it('passes the program catch-up id and its availability check through', () => {
    state.channels = [{ name: 'Chan A', url: 'http://host/a', catchup: 'vod', catchupSource: 'http://host/v/{catchup-id}' }];
    const [first, ...rest] = state.programmes['Chan A'];
    state.programmes['Chan A'] = [{ ...first, catchupId: 'p1' }, ...rest];
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    clickData('data-prog-idx', 0);
    expect(onSelect.mock.calls[0][1]).toMatchObject({ title: 'Morning', catchupId: 'p1' });
    expect(archiveMock.isAvailable).toHaveBeenCalledWith(
      state.channels[0], state.programmes['Chan A'][0].start.getTime(), expect.any(Number), 'p1');
  });

  it('opens a vod channel live for a past program without a catch-up id', async () => {
    state.channels = [{ name: 'Chan A', url: 'http://host/a', catchup: 'vod', catchupSource: '' }];
    archiveMock.isAvailable.mockImplementation(
      (_channel: unknown, _start?: number, _now?: number, catchupId?: string) => !!catchupId);
    const start = state.programmes['Chan A'][0].start.getTime();
    storageMock.getCatchupProgressList.mockReturnValue([{
      channelKey: 'k', progStart: start, progEnd: start + 3_600_000, position: 600,
      duration: 3600, updatedAt: 1, completed: false,
    }]);
    grid.render();
    expect(container.querySelector('[data-prog-idx="0"] .epg-catchup-badge')).toBeNull();
    expect(container.querySelector('[data-prog-idx="0"] .epg-catchup-progress')).toBeNull();

    clickData('data-prog-idx', 0);
    await vi.runAllTimersAsync();
    expect(toastMock).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(0, undefined, expect.anything());
  });

  it('opens the channel live for a past program outside its archive days', async () => {
    state.channels = [{ name: 'Chan A', url: 'http://host/a', catchupSource: 'http://host/catchup/{start}', catchupDays: 1 }];
    // The archive days leave this program out.
    archiveMock.isAvailable.mockReturnValue(false);
    storageMock.getCatchupProgressList.mockReturnValue([]);
    grid.render();
    expect(container.querySelector('[data-prog-idx="0"] .epg-replay-glyph')).toBeNull();

    clickData('data-prog-idx', 0);
    await vi.runAllTimersAsync();
    expect(toastMock).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(0, undefined, expect.anything());
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
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
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

  it('shows a channel run through by the D-pad once the selection rests', () => {
    state.programmes['Chan B'] = [prog(12, 0, 13, 0, 'B Show')];
    grid.render();

    grid.handleAction('down');
    expect(channelItems()[1].classList.contains('selected')).toBe(true);
    expect(channelItems()[0].classList.contains('selected')).toBe(false);
    expect(progItems()[0].textContent).toContain('Morning');

    vi.advanceTimersByTime(150);
    expect(progItems()).toHaveLength(1);
    expect(progItems()[0].textContent).toContain('B Show');
  });

  it('renders no pane for a channel left by Back before it rested', () => {
    container.classList.add('view');
    const render = vi.spyOn(grid, 'render');
    grid.handleAction('down');
    grid.deactivateFilters();
    vi.advanceTimersByTime(150);

    expect(render).not.toHaveBeenCalled();
  });

  it('renders no hidden Guide when a channel rests, and shows that channel next', () => {
    state.programmes['Chan B'] = [prog(12, 0, 13, 0, 'B Show')];
    container.classList.add('view');
    grid.render();
    const render = vi.spyOn(grid, 'render');
    grid.handleAction('down');
    container.classList.add('hidden');
    vi.advanceTimersByTime(150);
    expect(render).not.toHaveBeenCalled();

    container.classList.remove('hidden');
    grid.render();
    expect(progItems()[0].textContent).toContain('B Show');
  });

  it('tunes a channel OK pressed before it rested without rendering its pane', () => {
    container.classList.add('view');
    onSelect.mockImplementation(() => container.classList.add('hidden'));
    const render = vi.spyOn(grid, 'render');
    grid.handleAction('down');
    grid.handleAction('select');

    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
    expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(render).not.toHaveBeenCalled();
  });

  it('shows the channel a PIN prompt keeps the Guide on after a quick move and OK', () => {
    state.programmes['Chan B'] = [prog(12, 0, 13, 0, 'B Show')];
    container.classList.add('view');
    grid.render();
    grid.handleAction('down');
    grid.handleAction('select');

    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
    expect(progItems()).toHaveLength(1);
    expect(progItems()[0].textContent).toContain('B Show');
  });

  it('enters the programmes of the channel just moved to', () => {
    state.programmes['Chan B'] = [prog(12, 0, 13, 0, 'B Show')];
    grid.render();

    grid.handleAction('down');
    grid.handleAction('right');
    Focus.flush();

    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('B Show');
  });

  it('says in the legend what OK does where the ring rests', () => {
    const hint = () => container.querySelector('.epg-hints .key-ok')?.parentElement?.textContent?.trim() ?? '';
    grid.render();
    expect(hint()).toContain('Watch now');
    expect(container.querySelector('.epg-hints')?.textContent).toContain('Back to now');

    grid.handleAction('right'); // Morning, aired, no catch-up: OK tunes in live
    expect(hint()).toContain('Watch live');
    grid.handleAction('down');
    grid.handleAction('down'); // Afternoon, upcoming
    expect(hint()).toContain('Set reminder');
  });

  it('follows the ring onto a hovered program, and keeps it after a render', () => {
    const hint = () => container.querySelector('.epg-hints .key-ok')?.parentElement?.textContent?.trim() ?? '';
    grid.handleAction('right');
    grid.handleAction('down');
    grid.handleAction('down'); // Afternoon, upcoming
    expect(hint()).toContain('Set reminder');

    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })); // Noon Show, airing
    expect(hint()).toContain('Watch now');
    grid.render();
    expect(hint()).toContain('Watch now');

    grid.handleAction('select');
    expect(reminderMock.add).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('offers no OK in the legend while the search box has the caret, and OK once a click drops it', () => {
    grid.handleAction('yellow');
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(container.querySelector('.epg-hints .key-ok')).toBeNull();

    container.querySelector<HTMLInputElement>('.epg-search-input')!.blur();
    expect(container.querySelector('[data-prog-idx="1"]')!.classList.contains('focused')).toBe(true);
    expect(container.querySelector('.epg-hints .key-ok')?.parentElement?.textContent).toContain('Watch now');
  });

  it('offers no OK in the legend for an aired program an Xtream archive lacks', async () => {
    state.channels[0] = {
      ...state.channels[0],
      catchupSource: 'http://host/catchup/{start}',
      catchupAccountId: 'x1',
      catchupStreamId: '101',
    };
    archiveMock.getCached.mockReturnValue(new Set());
    archiveMock.load.mockResolvedValue(new Set());
    archiveMock.isAvailable.mockReturnValue(false);
    grid.render();
    grid.handleAction('right'); // Morning, aired

    expect(container.querySelector('.epg-hints .key-ok')).toBeNull();
    expect(container.querySelector('.epg-hints')?.textContent).toContain('Back to now');
    grid.handleAction('select');
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith("This program isn't available for catch-up.");
  });

  it('offers catch-up in the legend for an aired program the archive holds', () => {
    state.channels[0] = { ...state.channels[0], catchupSource: 'http://host/c' };
    grid.render();
    grid.handleAction('right');
    expect(container.querySelector('.epg-hints')?.textContent).toContain('Play catch-up');
  });

  it('red goes back to today and the program airing now', () => {
    clickData('data-day-index', 1);
    expect(dateItems()[1].classList.contains('selected')).toBe(true);
    grid.handleAction('red');
    Focus.flush();
    expect(dateItems()[0].classList.contains('selected')).toBe(true);
    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('Noon Show');
  });

  it('red rings the date bar when the channel has no programs today', () => {
    state.programmes['Chan B'] = [{
      start: new Date(Y, M, D - 1, 9, 0),
      stop: new Date(Y, M, D - 1, 10, 0),
      title: 'Yesterday AM',
      description: '',
      category: '',
      icon: '',
    }];
    grid.focusChannel(1);
    grid.render();
    clickData('data-day-index', 0);
    grid.handleAction('down');
    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('Yesterday AM');

    grid.handleAction('red');
    Focus.flush();
    expect(dateItems()[1].classList.contains('selected')).toBe(true);
    expect(dateItems()[1].classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('goes back to now from a click on the Red hint, which never takes the keys', () => {
    clickData('data-day-index', 1);
    const hint = () => container.querySelector<HTMLElement>('.epg-hints [data-epg-now]')!;
    const before = hint();
    expect(before.textContent).toContain('Back to now');
    expect(before.hasAttribute('data-focusable')).toBe(false);
    expect(before.hasAttribute('data-self-activate')).toBe(true);

    before.focus(); // as a mouse click leaves it
    before.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    Focus.flush();
    expect(document.activeElement).not.toBe(before);
    expect(dateItems()[0].classList.contains('selected')).toBe(true);
    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('Noon Show');
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(hint()).toBe(before);
  });

  it('leaves another day where it is on green', () => {
    clickData('data-day-index', 1);
    grid.handleAction('green');
    expect(dateItems()[1].classList.contains('selected')).toBe(true);
  });

  it('red leaves the search box for the program airing now', () => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    expect(document.activeElement).toBe(input);

    grid.handleAction('red');
    Focus.flush();
    expect(document.activeElement).not.toBe(input);
    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('Noon Show');
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('red closes the group menu and goes back to now', () => {
    Focus.install();
    grid.handleAction('left');
    expect(container.querySelector('.epg-group-menu')).not.toBeNull();

    grid.handleAction('red');
    Focus.flush();
    expect(container.querySelector('.epg-group-menu')).toBeNull();
    expect(container.querySelector('.epg-programme-item.focused')?.textContent).toContain('Noon Show');
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
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
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: 'p2' });
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

  it('logs the fallback for a failing worker once, not again while the retry is pending', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Only the faked clock (and vi.waitFor's 50 ms polls) can end the delay.
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const fallbackLogs = (): unknown[][] => error.mock.calls
        .filter(call => call.some(part => part === 'event=search.worker.fallback.used'));
      workerMock.failIndexes = true;
      const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
      const type = (value: string): void => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const names = (): Array<string | null | undefined> =>
        channelItems().map(item => item.querySelector('.epg-ch-name')?.textContent);

      type('Chan B');
      await vi.waitFor(() => expect(names()).toEqual(['Chan B']));
      expect(fallbackLogs()).toHaveLength(1);

      type('Chan A');
      await vi.waitFor(() => expect(names()).toEqual(['Chan A']));
      vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS - 1000);
      type('Chan B');
      await vi.waitFor(() => expect(names()).toEqual(['Chan B']));
      expect(fallbackLogs()).toHaveLength(1);

      // The delay passed: the worker is tried, and fails, again.
      vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS);
      type('Chan A');
      await vi.waitFor(() => expect(fallbackLogs()).toHaveLength(2));
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
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

  it('takes the keys and the only ring into the open group menu', () => {
    grid.handleAction('left');
    grid.handleAction('down');

    expect(Focus.owner()?.id).toBe('guide.groups');
    const option = container.querySelector('[data-group-index="1"]')!;
    expect(option.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);

    grid.handleAction('back');
    expect(Focus.owner()?.id).toBe('guide.grid');
    expect(container.querySelector('.epg-group-button')!.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('pops the group menu scope when the reminders bell is clicked', () => {
    grid.handleAction('left');
    expect(Focus.owner()?.id).toBe('guide.groups');
    const pop = vi.spyOn(Focus, 'pop');

    container.querySelector<HTMLElement>('[data-epg-reminders]')!.click();

    // Its `when` already hides the shut menu; the stack must drop it as well.
    expect(pop.mock.calls.map(([scope]) => scope.id)).toContain('guide.groups');
    pop.mockRestore();
  });

  it('keeps the hover behind the open group menu from moving the Guide', () => {
    Focus.install();
    grid.handleAction('left');
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-group-index="2"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    expect(container.querySelector('[data-group-index="2"]')!.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);

    grid.handleAction('back');
    expect(container.querySelector('.epg-group-button')!.classList.contains('focused')).toBe(true);
    expect(container.querySelector('[data-prog-idx="1"]')!.classList.contains('focused')).toBe(false);
  });

  it('keeps the only ring on the search box while it has the caret', () => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    Focus.flush();

    expect(container.querySelector('.epg-search-wrap')!.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);

    input.blur();
    Focus.flush();
    expect(container.querySelector('[data-prog-idx="1"]')!.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('keeps Channel Up and Down from moving a programme hovered while typing', () => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    grid.handleAction('channel_down');
    grid.handleAction('channel_up');
    grid.handleAction('channel_down');

    input.blur();
    Focus.flush();
    expect(container.querySelector('[data-prog-idx="1"]')!.classList.contains('focused')).toBe(true);
  });

  it.each([
    ['Back', { key: 'Escape' }],
    ['OK', { key: 'Enter' }],
  ])('reveals no programme hovered while typing when %s leaves the search box', (_name, init) => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    const reveal = vi.spyOn(grid as unknown as { revealGridKey: (key: string) => boolean | null },
      'revealGridKey');

    setInputMode('keys');
    input.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    Focus.flush();
    setInputMode('pointer');

    expect(document.activeElement).not.toBe(input);
    expect(reveal.mock.calls.filter(([key]) => key.startsWith('prog:'))).toEqual([]);
  });

  it('reveals no programme hovered while typing when the Back button leaves the search box', () => {
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    const reveal = vi.spyOn(grid as unknown as { revealGridKey: (key: string) => boolean | null },
      'revealGridKey');

    setInputMode('keys');
    grid.handleAction('back');
    Focus.flush();
    setInputMode('pointer');

    expect(document.activeElement).not.toBe(input);
    expect(reveal.mock.calls.filter(([key]) => key.startsWith('prog:'))).toEqual([]);
  });

  it('drops the search caret when a prompt takes the keys', () => {
    const prompt = document.createElement('div');
    document.body.appendChild(prompt);
    const scope = Focus.register({ id: 'test.prompt', root: prompt, restrict: 'self-only' });
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    expect(document.activeElement).toBe(input);

    Focus.push(scope);
    Focus.owner();

    expect(document.activeElement).not.toBe(input);
  });

  it('leaves no reveal pending once Up hands the keys to the tab bar', () => {
    Focus.uninstall();
    const tabBar = document.createElement('div');
    document.body.appendChild(tabBar);
    const tabScope = Focus.register({ id: 'test.tabbar', root: tabBar });
    grid = new EpgGrid(container, onSelect, () => Focus.push(tabScope), onManageReminders);
    Focus.setBase(() => grid.focusScope);
    grid.render();
    Focus.flush();
    const reveal = vi.spyOn(grid as unknown as { revealGridKey: (key: string) => boolean | null },
      'revealGridKey');

    grid.handleAction('up');
    grid.handleAction('up');
    expect(Focus.owner()?.id).toBe('test.tabbar');
    reveal.mockClear();
    Focus.pop(tabScope);
    Focus.owner();
    Focus.flush();

    expect(reveal).not.toHaveBeenCalled();
  });

  it('hands the keys back to the grid when the filters deactivate', () => {
    grid.handleAction('left');
    grid.deactivateFilters();
    expect(Focus.owner()?.id).toBe('guide.grid');
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
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
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
    Focus.uninstall();
    const g = new EpgGrid(c, vi.fn());
    g.render();
    g.handleAction('down');
    g.handleAction('right');
    g.handleAction('down');
    const clicks = spy.mock.calls.filter(([t]) => t === 'click').length;
    const hovers = spy.mock.calls.filter(([t]) => t === 'nav:hover').length;
    expect(clicks).toBe(1);
    expect(hovers).toBe(1);
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

  it('shows the replay icon only on aired programs that can be replayed', () => {
    grid.render();
    expect(container.querySelector('[data-prog-idx="0"] .epg-replay-glyph')).not.toBeNull();
    expect(container.querySelector('[data-prog-idx="2"] .epg-replay-glyph')).toBeNull();

    state.channels = [{ name: 'Chan A', url: 'http://host/a' }];
    grid.render();
    expect(container.querySelector('[data-prog-idx="0"]')!.classList.contains('state-past')).toBe(true);
    expect(container.querySelector('.epg-replay-glyph')).toBeNull();
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
    expect(catchup).toMatchObject({ resumeSecs: 300 });
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
    expect(catchup).toBeDefined();
    expect(catchup?.resumeSecs).toBeUndefined();
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
    grid.handleAction('select'); // opens prompt for Morning
    grid.handleAction('down');
    expect(document.querySelector('.catchup-resume-prompt:not(.hidden)')).not.toBeNull();
    grid.handleAction('back');
    expect(document.querySelector('.catchup-resume-prompt:not(.hidden)')).toBeNull();
    // Had Down moved to Noon Show, OK would play it instead of reopening Morning's prompt.
    grid.handleAction('select');
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('.catchup-resume-prompt:not(.hidden)')).not.toBeNull();
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
    expect(catchup).toBeDefined();
    expect(catchup?.resumeSecs).toBeUndefined();
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
    expect(catchup).toBeDefined();
    expect(catchup?.resumeSecs).toBeUndefined();
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

  describe('EpgGrid archive check of an aired program', () => {
    let loaded!: (value: Set<number> | null) => void;
    beforeEach(() => {
      state.channels = [{
        name: 'Chan A',
        url: 'http://host/a',
        catchupSource: 'http://host/catchup/{start}',
        catchupAccountId: 'x1',
        catchupStreamId: '101',
      }];
      archiveMock.getCached.mockReturnValue(undefined);
      archiveMock.load.mockReturnValue(new Promise(resolve => {
        loaded = (value) => {
          archiveMock.getCached.mockReturnValue(value);
          resolve(value);
        };
      }));
      container.classList.add('view');
      grid.render();
      grid.handleAction('right');
      grid.handleAction('select'); // Morning, aired; its archive is still loading
    });

    it('plays nothing when the focus moved to another program during the check', async () => {
      grid.handleAction('down'); // Noon Show
      loaded(null);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('shows no resume prompt once the Guide was left during the check', async () => {
      const startMs = new Date(Y, M, D, 10, 0).getTime();
      storageMock.getCatchupProgressList.mockReturnValue([
        { channelKey: 'ck1', progStart: startMs, progEnd: startMs + 3600000, position: 300, duration: 3600, updatedAt: 0, completed: false },
      ]);
      container.classList.add('hidden');
      loaded(null);
      await vi.advanceTimersByTimeAsync(0);

      expect(document.querySelector('.catchup-resume-prompt:not(.hidden)')).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('plays the checked program when the focus stayed', async () => {
      loaded(null);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSelect).toHaveBeenCalledWith(0, expect.objectContaining({ title: 'Morning' }), expect.anything());
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
    Focus.uninstall();
    new EpgGrid(c, vi.fn());
    const clicks = spy.mock.calls.filter(([t]) => t === 'click').length;
    expect(clicks).toBe(1);
    spy.mockRestore();
  });

  it('hover still updates focus without full render', () => {
    const item1 = container.querySelector<HTMLElement>('[data-prog-idx="1"]')!;
    const render = vi.spyOn(grid, 'render');
    item1.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    expect(item1.classList.contains('focused')).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });

  it('hovering a programme takes the ring off the channel, which stays selected', () => {
    Focus.flush();
    const channel = container.querySelector<HTMLElement>('[data-channel-idx="0"]')!;
    expect(channel.classList.contains('focused')).toBe(true);

    container.querySelector<HTMLElement>('[data-prog-idx="1"]')!
      .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));

    expect(channel.classList.contains('selected')).toBe(true);
    expect(channel.classList.contains('focused')).toBe(false);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
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

describe('EpgGrid timeline layout', () => {
  const elementRect = Element.prototype.getBoundingClientRect;
  const rect = (width: number, height: number): DOMRect => ({
    x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}),
  });
  const detail = () => container.querySelector('.epg-tl-detail')?.textContent?.replace(/\s+/g, ' ') ?? '';
  // The focused row's channel: the details name the programme, not the channel.
  const focusedChannel = () => {
    const g = grid as unknown as { timelineRows(): { channel: { name: string } }[]; timeline: { row: number } };
    return g.timelineRows()[g.timeline.row]?.channel.name ?? '';
  };

  beforeEach(() => {
    storageMock.getGuideLayout.mockReturnValue('timeline');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('epg-tl-surface') ? rect(1920, 744) : elementRect.call(this);
    });
    grid.render(true);
    Focus.flush();
  });

  it('shows the guide in one surface and opens on the program airing now', () => {
    expect(container.querySelector('.epg-tl-surface .tl-row')).not.toBeNull();
    expect(container.querySelector('.epg-channel-list')).toBeNull();
    expect(detail()).toContain('Noon Show');
    expect(container.querySelector('.epg-tl-focus')?.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('moves between programs and channels with the D-pad', () => {
    grid.handleAction('right');
    expect(detail()).toContain('Afternoon');

    grid.handleAction('down');
    expect(focusedChannel()).toBe('Chan B');
    expect(detail()).toContain('No information');
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('hands the keys to the group filter above the first channel', () => {
    grid.handleAction('up');
    Focus.flush();

    expect(container.querySelector('.epg-group-button.focused')).not.toBeNull();
    expect(container.querySelector('.epg-tl-focus.focused')).toBeNull();
  });

  it('plays the channel for the program airing now', () => {
    grid.handleAction('select');

    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('red leaves the search box for the program airing now', () => {
    grid.handleAction('right');
    grid.handleAction('yellow');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    expect(document.activeElement).toBe(input);

    grid.handleAction('red');
    Focus.flush();
    expect(document.activeElement).not.toBe(input);
    expect(detail()).toContain('Noon Show');
    expect(container.querySelector('.epg-tl-focus')?.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('red closes the group menu and goes back to now', () => {
    Focus.install();
    grid.handleAction('right');
    grid.handleAction('up');
    grid.handleAction('select');
    expect(container.querySelector('.epg-group-menu')).not.toBeNull();

    grid.handleAction('red');
    Focus.flush();
    expect(container.querySelector('.epg-group-menu')).toBeNull();
    expect(detail()).toContain('Noon Show');
    expect(container.querySelector('.epg-tl-focus')?.classList.contains('focused')).toBe(true);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('offers no OK in the details for an aired program an Xtream archive lacks', async () => {
    state.channels = [{
      ...state.channels[0],
      catchupSource: 'http://host/catchup/{start}',
      catchupAccountId: 'x1',
      catchupStreamId: '101',
    }, state.channels[1]];
    archiveMock.getCached.mockReturnValue(new Set());
    archiveMock.load.mockResolvedValue(new Set());
    archiveMock.isAvailable.mockReturnValue(false);
    grid.render();
    grid.handleAction('left'); // Morning, aired
    expect(detail()).toContain('Morning');
    expect(container.querySelector('.epg-tl-detail .epg-tl-hint')).toBeNull();
    grid.handleAction('select');
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith("This program isn't available for catch-up.");
  });

  it('offers a way back to now once the page left it', () => {
    expect(container.querySelector('.epg-now-pill')).toBeNull();

    grid.handleAction('right');
    grid.handleAction('right');
    expect(detail()).toContain('Tomorrow AM');
    const pill = container.querySelector<HTMLElement>('.epg-now-pill.is-earlier');
    expect(pill?.textContent).toContain('Back to now');

    pill!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    Focus.flush();
    expect(detail()).toContain('Noon Show');
    expect(container.querySelector('.epg-now-pill')).toBeNull();
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('tells what OK does to the focused program, and only while the timeline has the keys', () => {
    grid.handleAction('right');
    const hint = () => container.querySelector('.epg-tl-detail .epg-tl-hint')?.textContent ?? '';
    expect(container.querySelector('.epg-tl-detail .epg-bell-glyph.unset')).not.toBeNull();
    expect(hint()).toContain('Set reminder');

    reminderMock.list.mockReturnValue([{ channelKey: channelKey(state.channels[0]), startMs: new Date(Y, M, D, 13, 0).getTime() }]);
    reminderMock.revision++;
    grid.render();
    expect(container.querySelector('.epg-tl-detail .epg-bell-glyph.set')).not.toBeNull();
    expect(hint()).toContain('Remove reminder');

    grid.handleAction('left');
    expect(container.querySelector('.epg-tl-detail .epg-bell-glyph')).toBeNull();
    expect(hint()).toContain('Watch now');

    grid.handleAction('down'); // Chan B has no programs; OK still tunes it in
    expect(hint()).toContain('Watch live');
    grid.handleAction('up');

    grid.handleAction('right');
    grid.handleAction('up');
    expect(container.querySelector('.epg-tl-detail .epg-tl-hint')).toBeNull();
  });

  it('tells that OK replays an aired program with catch-up', () => {
    state.channels = [{ ...state.channels[0], catchupSource: 'http://host/c' }];
    grid.render();
    grid.handleAction('left');
    expect(detail()).toContain('Morning');
    expect(container.querySelector('.epg-tl-detail .epg-tl-hint')?.textContent).toContain('Play catch-up');
  });

  it('gives the rows the room a program without a description leaves', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('epg-tl-detail')) return 0;
      return this.querySelector('.epg-tl-desc') ? 168 : 104;
    });
    const timeline = (grid as unknown as { timeline: { visibleRows(): number } }).timeline;
    grid.render();
    expect(timeline.visibleRows()).toBe(7);

    grid.handleAction('down'); // Chan B has no programs, so no description
    expect(focusedChannel()).toBe('Chan B');
    expect(timeline.visibleRows()).toBe(8);

    grid.handleAction('up');
    expect(timeline.visibleRows()).toBe(7);
  });

  it('sets a reminder for an upcoming program picked by pointer', () => {
    // 13:00 sits a third of the way along the 12:00-15:00 page; row one is below the ruler.
    container.querySelector('.epg-tl-surface')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1100, clientY: 90 }));

    expect(detail()).toContain('Afternoon');
    expect(reminderMock.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Afternoon' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  const surface = () => container.querySelector<HTMLElement>('.epg-tl-surface')!;
  const fire = (type: string, detail: object) =>
    surface().dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail }));
  const spyDraw = () => {
    const draw = vi.spyOn(TimelineView.prototype, 'draw').mockReturnValue(false);
    grid.render();
    draw.mockClear();
    return draw;
  };

  it('plays a channel with no guide live on OK', () => {
    grid.handleAction('down');
    grid.handleAction('select');

    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('tunes the channel clicked in the channel column, not its focused program', () => {
    grid.handleAction('right');
    expect(detail()).toContain('Afternoon');

    surface().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 90 }));

    expect(reminderMock.add).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(0, undefined, { group: 'builtin:all', playlist: undefined });
  });

  const searchInput = () => container.querySelector<HTMLInputElement>('.epg-search-input')!;
  const typeQuery = async (value: string) => {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(searchInput().dataset.searchPending).toBe('false'));
    Focus.flush();
  };
  const leaveSearch = (key: string) => {
    searchInput().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    Focus.flush();
  };
  const rowCount = () => (grid as unknown as { timelineRows: () => unknown[] }).timelineRows().length;
  const ringOn = (selector: string) => {
    expect(container.querySelector(`${selector}.focused`)).not.toBeNull();
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  };

  it('opens on the playing channel among the searched ones, else on the first match', async () => {
    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();
    await typeQuery('Chan');
    storageMock.getGuideLayout.mockReturnValue('timeline');
    grid.focusChannel(1);
    grid.render(true);
    expect(focusedChannel()).toBe('Chan B');

    await typeQuery('Chan A');
    grid.focusChannel(1);
    grid.render(true);
    expect(focusedChannel()).toBe('Chan A');
    expect(rowCount()).toBe(1);
  });

  it('puts the search box after the group filter in the toolbar', () => {
    const filters = container.querySelector('.epg-tl-toolbar .epg-tl-filters')!;
    expect(Array.from(filters.children).map(el => el.className))
      .toEqual(['epg-group-control', 'epg-search-wrap']);
    expect(filters.querySelector('.epg-search-input')?.getAttribute('data-key')).toBe('epg-search');
  });

  it('filters the timeline rows by channel name while the caret stays in the box', async () => {
    grid.handleAction('yellow');
    await typeQuery('Chan B');

    expect(rowCount()).toBe(1);
    expect(focusedChannel()).toBe('Chan B');
    expect(document.activeElement).toBe(searchInput());
    ringOn('.epg-search-wrap');
  });

  it.each(['Enter', 'ArrowDown'])('leaves the search box with %s on the first match airing now', async (key) => {
    grid.handleAction('down');
    grid.handleAction('yellow');
    await typeQuery('Chan');
    expect(focusedChannel()).toBe('Chan B');

    leaveSearch(key);

    expect(document.activeElement).not.toBe(searchInput());
    expect(detail()).toContain('Noon Show');
    ringOn('.epg-tl-focus');
  });

  it('repaints once per keystroke and once per result, hit-testing the new rows', async () => {
    const draw = spyDraw();
    grid.handleAction('yellow');
    await typeQuery('Chan B');
    vi.advanceTimersToNextFrame();
    expect(draw).toHaveBeenCalledTimes(2);

    surface().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1100, clientY: 90 }));
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('opens the search box with Yellow from the timeline', () => {
    grid.handleAction('yellow');
    Focus.flush();

    expect(document.activeElement).toBe(searchInput());
    ringOn('.epg-search-wrap');
  });

  it('keeps the caret and shows the empty state when nothing matches', async () => {
    grid.handleAction('yellow');
    searchInput().value = 'zz';
    searchInput().dispatchEvent(new Event('input', { bubbles: true }));
    Focus.flush();
    expect(document.activeElement).toBe(searchInput());
    ringOn('.epg-search-wrap');

    await typeQuery('zzz');

    expect(container.querySelector('.epg-tl-empty')?.textContent).toBe('No channels found');
    expect(document.activeElement).toBe(searchInput());
    ringOn('.epg-search-wrap');
  });

  it('restores every row on clearing the query, keeping the selected channel', async () => {
    grid.handleAction('down');
    grid.handleAction('yellow');
    await typeQuery('Chan B');
    await typeQuery('');

    expect(rowCount()).toBe(2);
    expect(focusedChannel()).toBe('Chan B');
    leaveSearch('Escape');
    ringOn('.epg-search-wrap');
  });

  it('walks the toolbar: the tabs above the filters, then search and the reminders beside them', () => {
    state.playlistTabs = [{ id: 'p1', name: 'Playlist 1' }, { id: 'p2', name: 'Playlist 2' }];
    grid.handleAction('up');
    Focus.flush();
    ringOn('.epg-group-button');

    grid.handleAction('up');
    Focus.flush();
    ringOn('.playlist-tab');
    grid.handleAction('right');
    grid.handleAction('right');
    grid.handleAction('right');
    Focus.flush();
    ringOn('.playlist-tab[data-playlist="p2"]');
    grid.handleAction('down');
    Focus.flush();
    ringOn('.epg-group-button');

    grid.handleAction('right');
    Focus.flush();
    ringOn('.epg-search-wrap');
    grid.handleAction('right');
    Focus.flush();
    ringOn('.epg-reminder-entry');
    grid.handleAction('left');
    grid.handleAction('select');
    Focus.flush();
    expect(document.activeElement).toBe(searchInput());
    ringOn('.epg-search-wrap');
  });

  it('counts the channels over the channel column, following the group filter', () => {
    const count = () => container.querySelector('.epg-tl-count')?.textContent?.trim();
    expect(count()).toBe('2 channels');

    grid.handleAction('up');
    grid.handleAction('select');
    Array.from(container.querySelectorAll<HTMLElement>('[data-epg-group]'))
      .find(option => option.textContent?.includes('Sports'))!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(count()).toBe('1 channel');
  });

  it('hands the keys to the group filter when no channel is left', () => {
    state.channels = [];
    grid.render();
    Focus.flush();

    expect(container.querySelector('.epg-group-button.focused')).not.toBeNull();
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
    grid.handleAction('down');
    Focus.flush();
    expect(container.querySelector('.epg-group-button.focused')).not.toBeNull();
  });

  const catchupRows = (count: number) => {
    state.channels = Array.from({ length: count }, (_, i) => ({
      name: i ? `ch${String(i + 1)}` : 'Chan A',
      url: `http://host/${String(i + 1)}`,
      catchupSource: 'http://host/catchup/{start}',
      catchupAccountId: 'acc1',
      catchupStreamId: `s${String(i + 1)}`,
    }));
    archiveMock.getCached.mockReturnValue(undefined);
    const loads: Array<(value: Set<number> | null) => void> = [];
    archiveMock.load.mockImplementation(() => new Promise(resolve => { loads.push(resolve); }));
    return loads;
  };

  it('asks for the archive of the row the focus rests on, not every row passed', () => {
    catchupRows(4);
    grid.render();
    vi.advanceTimersByTime(150);
    archiveMock.load.mockClear();

    for (let i = 0; i < 3; i++) {
      grid.handleAction('down');
      vi.advanceTimersByTime(50);
    }
    expect(archiveMock.load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);

    expect(archiveMock.load).toHaveBeenCalledOnce();
    expect(archiveMock.load).toHaveBeenCalledWith(state.channels[3]);
  });

  it('repaints replay marks once an archive loads, though the focus moved on', async () => {
    const loads = catchupRows(2);
    const draw = spyDraw();
    vi.advanceTimersByTime(150);
    grid.handleAction('down');
    vi.advanceTimersByTime(150);
    expect(loads).toHaveLength(2);
    vi.advanceTimersToNextFrame();
    draw.mockClear();

    loads[0](new Set());
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();

    expect(draw).toHaveBeenCalledOnce();
  });

  it('moves the now line of a Guide shown again without a render', () => {
    const draw = spyDraw();
    container.classList.add('view', 'hidden');
    vi.advanceTimersByTime(61000);
    vi.advanceTimersToNextFrame();
    expect(draw).not.toHaveBeenCalled();

    container.classList.remove('hidden');
    vi.advanceTimersByTime(60000);
    vi.advanceTimersToNextFrame();

    expect(draw).toHaveBeenCalled();
  });

  it('steps one row for a wheel over the details, leaving the group menu to scroll', () => {
    state.channels = [0, 1, 2, 3, 4, 5].map(i => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    grid.render();
    vi.advanceTimersByTime(1000);
    const wheel = (el: Element) => el.dispatchEvent(new CustomEvent('nav:wheel', {
      bubbles: true, cancelable: true, detail: { step: true, deltaY: 100 },
    }));

    expect(wheel(container.querySelector('.epg-tl-detail')!)).toBe(false);
    expect(focusedChannel()).toBe('ch2');

    grid.handleAction('up');
    grid.handleAction('up');
    grid.handleAction('select');
    expect(wheel(container.querySelector('.epg-group-options')!)).toBe(true);
  });

  it('reads the reminder list once for a whole page of bells', () => {
    state.channels = Array.from({ length: 8 }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    state.programmes = Object.fromEntries(state.channels.map(channel => [channel.name,
      Array.from({ length: 12 }, (_, i) => prog(12 + Math.floor(i / 4), (i % 4) * 15, 12 + Math.floor((i + 1) / 4), ((i + 1) % 4) * 15, `P${String(i)}`))]));
    reminderMock.list.mockReturnValue([{ channelKey: channelKey(state.channels[0] as never), startMs: new Date(Y, M, D, 12, 15).getTime() }]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: (_target, name) => (name === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    }) as CanvasRenderingContext2D);
    reminderMock.revision++;
    grid.render();
    grid.handleAction('right');

    expect(detail()).toContain('P1');
    expect(container.querySelector('.epg-tl-detail .epg-bell-glyph.set')).not.toBeNull();
    expect(reminderMock.list).toHaveBeenCalledOnce();
    expect(reminderMock.has).not.toHaveBeenCalled();
  });

  it('lets go of the timeline once the schedule layout replaces it', () => {
    const held = grid as unknown as {
      timelineDrawnHost: unknown; timelineFrame: unknown; timelineTick: unknown; requestTimelineFrame(): void;
    };
    const detach = vi.spyOn(TimelineView.prototype, 'detach');
    held.requestTimelineFrame();
    expect(held.timelineDrawnHost).not.toBeNull();
    expect(held.timelineFrame).not.toBeNull();

    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();

    expect(held.timelineDrawnHost).toBeNull();
    expect(detach).toHaveBeenCalled();
    expect(held.timelineFrame).toBeNull();
    expect(held.timelineTick).toBeNull();
  });

  it('draws again and keeps the minute moving once the timeline comes back', () => {
    const draw = spyDraw();
    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();
    expect(draw).not.toHaveBeenCalled();

    storageMock.getGuideLayout.mockReturnValue('timeline');
    grid.render();
    expect(draw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it('red from the toolbar brings the ring down to the program airing now', () => {
    grid.handleAction('right');
    grid.handleAction('up');
    Focus.flush();
    expect(container.querySelector('.epg-group-button.focused')).not.toBeNull();

    grid.handleAction('red');
    Focus.flush();

    expect(detail()).toContain('Noon Show');
    expect(container.querySelector('.epg-tl-focus.focused')).not.toBeNull();
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('repaints when a reminder changes elsewhere', () => {
    const draw = spyDraw();
    reminderMock.has.mockReturnValue(true);
    reminderMock.revision++;
    for (const listener of reminderMock.listeners) listener();
    vi.advanceTimersToNextFrame();

    expect(draw).toHaveBeenCalledOnce();
  });

  it('keeps the timeline while the group menu moves, drawing it again only at a new size', () => {
    const draw = spyDraw();
    const style = vi.spyOn(TimelineView.prototype, 'setStyle');
    grid.handleAction('up');
    grid.handleAction('select');
    grid.handleAction('down');
    expect(draw).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();

    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    grid.handleAction('down');
    expect(draw).toHaveBeenCalledOnce();
  });

  it('reads the timeline font again when a custom theme changes under the same id', () => {
    const style = vi.spyOn(TimelineView.prototype, 'setStyle');
    grid.render();
    style.mockClear();
    grid.render();
    expect(style).not.toHaveBeenCalled();
    installCustomThemes();
    grid.render();
    expect(style).toHaveBeenCalledOnce();
  });

  it('keeps the row the wheel moved to while the pointer only jitters', () => {
    vi.advanceTimersByTime(1000);
    Focus.pointer(1100, 90);
    fire('nav:wheel', { deltaY: 100 });
    expect(focusedChannel()).toBe('Chan B');

    fire('nav:pointermove', { clientX: 1104, clientY: 94 });
    expect(focusedChannel()).toBe('Chan B');

    fire('nav:pointermove', { clientX: 1150, clientY: 90 });
    expect(focusedChannel()).toBe('Chan A');
  });

  it('drops the OK hint while the search box has the caret, and shows it once the caret leaves', () => {
    const hint = () => container.querySelector('.epg-tl-detail .epg-tl-hint')?.textContent ?? '';
    expect(hint()).toContain('Watch now');
    const input = container.querySelector<HTMLInputElement>('.epg-search-input')!;
    input.focus();
    expect(hint()).toBe('');

    fire('nav:pointermove', { clientX: 1100, clientY: 90 });
    expect(detail()).toContain('Afternoon');
    expect(hint()).toBe('');

    input.blur();
    expect(hint()).toContain('Set reminder');
  });

  it('red leaves the search box after the pointer moved the timeline under its caret', () => {
    grid.handleAction('yellow');
    const input = searchInput();
    expect(document.activeElement).toBe(input);
    fire('nav:pointermove', { clientX: 1100, clientY: 90 });
    expect(detail()).toContain('Afternoon');

    grid.handleAction('red');
    Focus.flush();

    expect(document.activeElement).not.toBe(input);
    expect(detail()).toContain('Noon Show');
    ringOn('.epg-tl-focus');
  });

  it('drops the way back to now once the clock walks into the page', () => {
    (grid as unknown as { timeline: { edgeStep(axis: 'x', direction: number): boolean } }).timeline.edgeStep('x', 1);
    grid.render();
    expect(container.querySelector('.epg-tl-now-slot .epg-now-pill.is-earlier')).not.toBeNull();

    // Past 12:30, the start of the 12:30-15:30 page.
    vi.advanceTimersByTime(31 * 60000);

    expect(container.querySelector('.epg-now-pill')).toBeNull();
  });

  it('shows the channels of another group in rows it already drew', () => {
    const draw = TimelineView.prototype.draw;
    if (vi.isMockFunction(draw)) draw.mockRestore();
    // A layout switch lets go of the host an earlier stand-in drew into.
    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();
    storageMock.getGuideLayout.mockReturnValue('timeline');
    grid.render();
    const names = () => Array.from(container.querySelectorAll<HTMLElement>('.tl-row'))
      .filter(row => row.style.visibility !== 'hidden')
      .map(row => `${row.querySelector('.tl-num')?.textContent ?? ''} ${row.querySelector('.tl-name')?.textContent ?? ''}`);
    expect(names()).toEqual(['1 Chan A', '2 Chan B']);

    grid.handleAction('up');
    grid.handleAction('select');
    const sports = Array.from(container.querySelectorAll<HTMLElement>('[data-epg-group]'))
      .find(option => option.textContent?.includes('Sports'))!;
    sports.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(names()).toEqual(['2 Chan B']);
  });

  it('acts on the ringed row when the wheel that moved it is pressed', () => {
    vi.advanceTimersByTime(1000);
    Focus.pointer(1100, 90);
    fire('nav:wheel', { deltaY: 100 });
    expect(focusedChannel()).toBe('Chan B');

    surface().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1103, clientY: 93 }));

    expect(reminderMock.add).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(1, undefined, { group: 'builtin:all', playlist: undefined });
  });

  it('acts on the row under the pointer once it really moved after the wheel', () => {
    vi.advanceTimersByTime(1000);
    Focus.pointer(1100, 90);
    fire('nav:wheel', { deltaY: 100 });

    surface().dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1100, clientY: 130 }));

    expect(detail()).toContain('Afternoon');
    expect(onSelect).not.toHaveBeenCalled();
  });

  // A stand-in Element.animate with full animation; each call's animation
  // reports the currentTime the test sets on it.
  const stubAnimate = () => {
    const runs: { cancel: Mock<() => void>; currentTime: number | null }[] = [];
    const animate = vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => Animation>(() => {
      const run = { cancel: vi.fn<() => void>(), currentTime: null as number | null };
      runs.push(run);
      return run as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    document.documentElement.setAttribute('data-animation', 'full');
    return {
      animate,
      runs,
      restore: () => {
        document.documentElement.removeAttribute('data-animation');
        delete (HTMLElement.prototype as { animate?: unknown }).animate;
      },
    };
  };
  const translateOf = (transform: unknown) =>
    (/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(String(transform)) ?? []).slice(1).map(Number);
  const ring = () => container.querySelector<HTMLElement>('.epg-tl-focus')!;

  it('moves the ring once per key, after the details settle the rows', () => {
    state.channels = Array.from({ length: 8 }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    state.programmes = { ch7: [prog(11, 30, 12, 30, 'Seventh')] };
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    const detailHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('epg-tl-detail')) return 0;
      return this.querySelector('.epg-tl-desc') ? 250 : 104;
    });
    const { animate, restore } = stubAnimate();
    try {
      grid.render();
      for (let i = 0; i < 5; i++) grid.handleAction('down');
      const timeline = (grid as unknown as { timeline: { scrollGoal: number } }).timeline;
      expect(timeline.scrollGoal).toBe(0);
      const from = translateOf(ring().style.transform);
      animate.mockClear();

      grid.handleAction('down'); // ch7's description grows the details over its row
      expect(timeline.scrollGoal).toBeGreaterThan(0);
      expect(animate).toHaveBeenCalledOnce();
      const [frames] = animate.mock.calls[0];
      expect(translateOf(frames[0].transform)).toEqual(from);
      expect(translateOf(frames[1].transform)).toEqual(translateOf(ring().style.transform));
    } finally {
      restore();
      height.mockRestore();
      detailHeight.mockRestore();
    }
  });

  it('does not fly the ring in from where it was when the Guide opens again', () => {
    const { animate, restore } = stubAnimate();
    try {
      grid.handleAction('right');
      expect(animate).toHaveBeenCalledOnce();

      grid.focusChannel(0);
      grid.render(true);

      expect(detail()).toContain('Noon Show');
      expect(animate).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it('changes a ring size more than twice over at once, sliding only its place', () => {
    const { animate, restore } = stubAnimate();
    try {
      grid.handleAction('down'); // Chan B has no programs: its ring spans the page
      const [frames] = animate.mock.calls[0];
      expect(String(frames[0].transform)).not.toContain('scale');
      expect(translateOf(frames[1].transform)).toEqual(translateOf(ring().style.transform));
    } finally {
      restore();
    }
  });

  it('starts a quick repeat from where the ring shows, part way through its slide', () => {
    const { animate, runs, restore } = stubAnimate();
    try {
      const noon = translateOf(ring().style.transform)[0];
      grid.handleAction('right');
      const afternoon = translateOf(ring().style.transform)[0];
      runs[0].currentTime = 80;
      grid.handleAction('left');

      expect(animate).toHaveBeenCalledTimes(2);
      const x = translateOf(animate.mock.calls[1][0][0].transform)[0];
      expect(x).toBeGreaterThan(noon);
      expect(x).toBeLessThan(afternoon);
      expect(runs[0].cancel).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('shows the parental lock of a locked channel in its row, not again in the details', () => {
    const enabled = vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    const lockState = vi.spyOn(ParentalControlService, 'lockState').mockReturnValue('locked');
    onTestFinished(() => { enabled.mockRestore(); lockState.mockRestore(); });
    const draw = TimelineView.prototype.draw;
    if (vi.isMockFunction(draw)) draw.mockRestore();
    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();
    storageMock.getGuideLayout.mockReturnValue('timeline');
    grid.render();

    expect(container.querySelector('.tl-row .tl-name .lock-badge.is-locked')).not.toBeNull();
    expect(container.querySelector('.epg-tl-detail .lock-badge')).toBeNull();
  });

  it('slides and resizes the ring together with full animation', () => {
    const animate = vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => Animation>()
      .mockReturnValue({ cancel: vi.fn() } as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    document.documentElement.setAttribute('data-animation', 'full');
    try {
      const ring = container.querySelector<HTMLElement>('.epg-tl-focus')!;
      const before = ring.style.width;
      grid.handleAction('right');

      expect(ring.style.width).not.toBe(before);
      expect(animate).toHaveBeenCalledOnce();
      const [frames] = animate.mock.calls[0];
      expect(String(frames[0].transform)).toMatch(new RegExp(`scale\\(${parseFloat(before) / parseFloat(ring.style.width)}, 1\\)`));
      expect(frames[1].transform).toBe(ring.style.transform.replace(/\s+/g, ' '));
    } finally {
      document.documentElement.removeAttribute('data-animation');
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  // Edge scrolling over the timeline, as key-handler installs it, with the
  // pointer resting where `rest` puts it.
  const edgeScrolling = () => {
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => window.setTimeout(() => fn(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => surface() });
    setInputMode('pointer');
    const dispose = installEdgeScroll(() => {});
    onTestFinished(() => {
      dispose();
      vi.unstubAllGlobals();
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    });
    let screen = 0;
    return (x: number, y: number) => {
      screen++;
      Focus.pointer(x, y);
      surface().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, screenX: screen, screenY: screen }));
    };
  };
  const timelineOf = () => (grid as unknown as {
    timeline: { windowStartMs: number; scrollGoal: number; row: number };
  }).timeline;

  it('pages forward while the pointer rests at the right edge of the cells, until it moves away', () => {
    const rest = edgeScrolling();
    rest(1000, 120);
    const start = timelineOf().windowStartMs;
    rest(1890, 120);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 100);

    const paged = timelineOf().windowStartMs;
    expect(paged).toBeGreaterThan(start);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
    rest(1000, 120);
    vi.advanceTimersByTime(1000);
    expect(timelineOf().windowStartMs).toBe(paged);
  });

  it('scrolls the rows while the pointer rests at their foot, the ring following it', () => {
    state.channels = Array.from({ length: 20 }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    grid.render();
    const rest = edgeScrolling();
    rest(1000, 400);
    rest(1000, 730);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 600);

    const timeline = timelineOf();
    expect(timeline.scrollGoal).toBeGreaterThanOrEqual(160);
    expect(focusedChannel()).toBe(`ch${String(timeline.row + 1)}`);
    expect(timeline.row).toBeGreaterThan(Math.floor((730 - 52) / 80));
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('scrolls tall rows under the pointer for the wheel, keeping the focus there through a jitter', () => {
    state.channels = Array.from({ length: 20 }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    grid.render();
    setInputMode('pointer');
    vi.advanceTimersByTime(1000);
    const timeline = timelineOf();
    // Row five sits under y=400, below the 52px ruler.
    for (let i = 0; i < 3; i++) {
      fire('nav:wheel', { deltaY: 100, clientX: 1000, clientY: 400 });
      vi.advanceTimersByTime(200);
    }
    expect(timeline.scrollGoal).toBe(240);
    expect(focusedChannel()).toBe('ch8');

    fire('nav:pointermove', { clientX: 1020, clientY: 410 });
    expect(focusedChannel()).toBe('ch8');
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  const hourly = (count: number, withDescription = (_i: number) => true) => {
    state.channels = Array.from({ length: count }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    state.programmes = Object.fromEntries(state.channels.map((channel, i) => [channel.name,
      [10, 11, 12, 13, 14, 15].map(h => ({ ...prog(h, 0, h + 1, 0, `P${String(h)}`), description: withDescription(i) ? 'd' : '' }))]));
    grid.render();
  };
  // The focused row's place in the rows' view, from the ring.
  const ringTop = () => parseFloat(/translate\([^,]+, ([-\d.]+)px\)/.exec(ring().style.transform)?.[1] ?? 'NaN');

  it('keeps the focus on a shown row while the rows edge-scroll under a gap between cells', () => {
    hourly(30);
    const rest = edgeScrolling();
    // 13:00 is where the cells of every row leave a gap.
    const gap = Math.round(480 + 1440 / 3);
    rest(gap, 400);
    rest(gap, 730);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 1500);

    expect(timelineOf().scrollGoal).toBeGreaterThan(0);
    expect(ringTop()).toBeGreaterThanOrEqual(52);
    expect(ringTop() + 72).toBeLessThanOrEqual(744);
    expect(container.querySelectorAll('.focused')).toHaveLength(1);
  });

  it('holds the details height while the rows edge-scroll, and lets it fit again after', () => {
    hourly(30, i => i % 2 === 0);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('epg-tl-detail')) return 0;
      if (this.style.height) return parseFloat(this.style.height);
      return this.querySelector('.epg-tl-desc') ? 168 : 104;
    });
    onTestFinished(() => height.mockRestore());
    grid.render();
    const rest = edgeScrolling();
    // ch1's description makes the details 168 tall: the rows end at 576.
    rest(1000, 300);
    rest(1000, 560);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 2000);

    const detailEl = container.querySelector<HTMLElement>('.epg-tl-detail')!;
    expect(detailEl.style.height).toBe('168px');
    expect(timelineOf().scrollGoal).toBeGreaterThanOrEqual(3 * 80);
    rest(1000, 300);
    vi.advanceTimersByTime(100);
    expect(detailEl.style.height).toBe('');
  });

  it('shows a lock as soon as the parental state changes', () => {
    const enabled = vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    const lockState = vi.spyOn(ParentalControlService, 'lockState').mockReturnValue(null);
    onTestFinished(() => { enabled.mockRestore(); lockState.mockRestore(); });
    const draw = TimelineView.prototype.draw;
    if (vi.isMockFunction(draw)) draw.mockRestore();
    storageMock.getGuideLayout.mockReturnValue('schedule');
    grid.render();
    storageMock.getGuideLayout.mockReturnValue('timeline');
    grid.render();
    expect(container.querySelector('.tl-row .lock-badge')).toBeNull();

    lockState.mockReturnValue('locked');
    (ParentalControlService as unknown as { listeners: Set<(changed: boolean) => void> }).listeners
      .forEach(listener => listener(false));
    vi.advanceTimersToNextFrame();

    expect(container.querySelector('.tl-row .tl-name .lock-badge.is-locked')).not.toBeNull();
  });

  it('pages into the past from the left edge only once paged away from the present', () => {
    const rest = edgeScrolling();
    const present = timelineOf().windowStartMs;
    rest(1000, 120);
    rest(500, 120);
    vi.advanceTimersByTime(2000);
    expect(timelineOf().windowStartMs).toBe(present);

    rest(1000, 120);
    rest(1890, 120);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 50);
    expect(timelineOf().windowStartMs).toBeGreaterThan(present);
    rest(1000, 120);
    rest(500, 120);
    vi.advanceTimersByTime(2000);
    expect(timelineOf().windowStartMs).toBe(present);
  });

  it('pages forward with the pointer pushed against the right edge of the screen', () => {
    const rest = edgeScrolling();
    const start = timelineOf().windowStartMs;
    rest(1000, 120);
    rest(1915, 120);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 100);
    expect(timelineOf().windowStartMs).toBeGreaterThan(start);
  });

  it('steps rows at about two a second at first and never more than eight', () => {
    state.channels = Array.from({ length: 200 }, (_, i) => ({ name: `ch${String(i + 1)}`, url: `http://host/${String(i + 1)}` }));
    grid.render();
    const rest = edgeScrolling();
    const rows = () => timelineOf().scrollGoal / 80;
    rest(1000, 400);
    rest(1000, 730);
    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_DWELL_MS + 1000);
    expect(rows()).toBeGreaterThanOrEqual(2);
    expect(rows()).toBeLessThanOrEqual(4);

    vi.advanceTimersByTime(CONFIG.NAVIGATION.EDGE_SCROLL_RAMP_MS);
    const ramped = rows();
    vi.advanceTimersByTime(1000);
    expect(rows() - ramped).toBeGreaterThanOrEqual(7);
    expect(rows() - ramped).toBeLessThanOrEqual(9);
  });

  it('follows the clock to the next present page, its left edge staying shut under a resting pointer', () => {
    const rest = edgeScrolling();
    rest(1000, 120);
    rest(500, 120);
    vi.advanceTimersByTime(2000);
    expect(timelineOf().windowStartMs).toBe(new Date(Y, M, D, 12, 0).getTime());

    vi.advanceTimersByTime(31 * 60000);

    expect(timelineOf().windowStartMs).toBe(new Date(Y, M, D, 12, 30).getTime());
    // Noon Show ended at 12:30; the focus moves on to what comes next.
    expect(detail()).toContain('Afternoon');
  });

  it('leaves the archive lookup alone on a key that moves nothing', () => {
    grid.handleAction('left'); // Morning, the first program
    vi.advanceTimersByTime(1000);
    const schedule = vi.spyOn(EpgGrid.prototype as unknown as { scheduleArchiveLoad: () => void }, 'scheduleArchiveLoad');
    onTestFinished(() => schedule.mockRestore());

    grid.handleAction('left');

    expect(detail()).toContain('Morning');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('never edge-scrolls from the ruler', () => {
    const rest = edgeScrolling();
    const start = timelineOf().windowStartMs;
    rest(1830, 20);
    vi.advanceTimersByTime(2000);
    expect(timelineOf().windowStartMs).toBe(start);
  });

  it('splits the details: the time over the channel column, the programme over the cells', () => {
    const when = () => container.querySelector('.epg-tl-detail .epg-tl-when')?.textContent?.replace(/\s+/g, ' ').trim();
    const what = () => container.querySelector('.epg-tl-detail .epg-tl-what')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(when()).toBe('11:30 – 12:30 Sat 06/15 · 1h 0m');
    expect(what()).toContain('Noon Show');
    expect(what()).toContain('Noon Show description');
    expect(detail()).not.toContain('Chan A');

    grid.handleAction('down'); // Chan B has no programs
    expect(when()).toBe('');
    expect(what()).toContain('No information');
    expect(detail()).not.toContain('Chan B');
  });

  it('sizes the number column again for a new row list only', () => {
    const zeros: string[] = [];
    const measure = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: (_target, name) => (name === 'measureText'
        ? (text: string) => { if (/^0+$/.test(text)) zeros.push(text); return { width: 10 * text.length }; }
        : () => undefined),
      set: () => true,
    }) as CanvasRenderingContext2D);
    onTestFinished(() => { measure.mockRestore(); });
    state.channels = Array.from({ length: 30 }, (_, i) => ({
      name: `ch${String(i + 1)}`, group: i < 5 ? 'News' : 'Sports', url: `http://host/${String(i + 1)}`,
    }));
    grid.render();
    const source = (timelineOf() as unknown as { source: { row(index: number): unknown } }).source;
    const row = vi.spyOn(source, 'row');
    zeros.length = 0;

    vi.advanceTimersByTime(60000);
    reminderMock.revision++;
    grid.render();
    epgMock.guideRevision++;
    grid.render();
    expect(zeros).toEqual([]);
    expect(row.mock.calls.every(([index]) => index < 12)).toBe(true);

    container.querySelector<HTMLElement>('[data-epg-group-toggle]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector<HTMLElement>('[data-epg-group="source:News"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(zeros).toEqual(['0']);
  });

  it('starts the details where a widened number column moves the names', () => {
    const measure = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, {
      get: (_target, name) => (name === 'measureText' ? () => ({ width: 100 }) : () => undefined),
      set: () => true,
    }) as CanvasRenderingContext2D);
    onTestFinished(() => { measure.mockRestore(); });
    state.channels = state.channels.slice();
    grid.render();

    expect(container.style.getPropertyValue('--tl-name-left')).toBe('136px');
    expect(container.querySelector<HTMLElement>('.epg-tl-when')!.style.paddingLeft).toBe('');
  });

  it('offers to watch live from an aired programme without catch-up or a row without programs', () => {
    const hint = () => container.querySelector('.epg-tl-detail .epg-tl-hint')?.textContent?.trim() ?? '';
    expect(hint()).toContain('Watch now'); // Noon Show, airing
    grid.handleAction('left'); // Morning, aired
    expect(hint()).toContain('Watch live');
    grid.handleAction('down'); // Chan B has no programs
    expect(hint()).toContain('Watch live');
  });

  it('marks a replayable aired programme by its time', () => {
    state.channels = [{ ...state.channels[0], catchupSource: 'http://host/c' }];
    grid.render();
    grid.handleAction('left'); // Morning, aired
    expect(container.querySelector('.epg-tl-detail .epg-tl-when .epg-replay-glyph')).not.toBeNull();
  });

  it('claims the wheel over the timeline only, leaving the toolbar its own', () => {
    vi.advanceTimersByTime(1000);
    const wheel = (el: Element) => el.dispatchEvent(new CustomEvent('nav:wheel', {
      bubbles: true, cancelable: true, detail: { step: true, deltaY: 100 },
    }));
    for (const selector of ['.epg-search-wrap', '.epg-group-button', '.epg-legend']) {
      expect(wheel(container.querySelector(selector)!), selector).toBe(true);
    }
    expect(focusedChannel()).toBe('Chan A');
    expect(wheel(surface())).toBe(false);
    expect(focusedChannel()).toBe('Chan B');
  });

  it('leaves the wheel to a modal prompt', () => {
    const prompt = document.createElement('div');
    document.body.appendChild(prompt);
    const modal = Focus.register({ id: 'test.prompt', root: prompt, restrict: 'self-only' });
    Focus.push(modal);
    vi.advanceTimersByTime(1000);
    fire('nav:wheel', { deltaY: 100 });
    Focus.pop(modal);

    expect(focusedChannel()).toBe('Chan A');
  });
});
