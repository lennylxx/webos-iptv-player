// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Channel } from '../types';
import type { RecentlyWatchedItem } from '../services/recently-watched';

const { data, customization, playlistMock, epgMock, storageMock, recentMock, toastMock } = vi.hoisted(() => {
  const mk = (o: Partial<Channel>): Channel => ({
    id: '', name: '', logo: '', group: '', url: '', extras: null,
    playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...o,
  });
  const channels: Channel[] = [
    mk({ id: 'a', name: 'Alpha', group: 'News', url: 'http://host/a' }),
    mk({ id: 'b', name: 'Bravo', group: 'Sports', url: 'http://host/b' }),
    mk({ id: 'c', name: 'Charlie', group: 'News', url: 'http://host/c' }),
  ];
  const raw = channels.slice();
  const data = { channels, raw, favorites: [] as string[], includeHidden: false };
  const customization = { record: null as unknown };

  return {
    data,
    customization,
    playlistMock: {
      channels,
      groupsRevision: 0,
      playlistTabs: [] as { id: string; name: string }[],
      getGroupsForPlaylist: () => ['News', 'Sports'],
      getGroupKeyForDisplay: (display: string) => display,
      getByGroup: (_group: string, _playlist?: string): Channel[] => channels,
      getGroupCount: (_group: string, _playlist?: string) => channels.length,
      indexOf: (ch: Channel) => channels.indexOf(ch),
      indexOfKey: (_key: string) => -1,
      getByIndex: (i: number) => channels[i] ?? null,
      applyCustomization: vi.fn(),
      setIncludeHidden: vi.fn(),
    },
    epgMock: { findChannelId: () => null, getNowPlaying: () => null },
    storageMock: {
      getFavorites: () => data.favorites,
      setFavorites: vi.fn((favorites: string[]) => {
        data.favorites = favorites;
        return true;
      }),
      toggleFavorite: vi.fn((key: string) => {
        const index = data.favorites.indexOf(key);
        if (index >= 0) data.favorites.splice(index, 1);
        else data.favorites.push(key);
        return index < 0;
      }),
      getShowHiddenChannels: () => false,
      getChannelCustomization: () => customization.record,
      setChannelCustomization: vi.fn((d: unknown) => { customization.record = d; }),
      clearChannelCustomization: vi.fn(() => { customization.record = null; }),
    },
    recentMock: {
      items: [] as RecentlyWatchedItem[],
      getItems: vi.fn(() => recentMock.items),
      catchupInfo: vi.fn(),
    },
    toastMock: { showToast: vi.fn() },
  };
});

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({ EpgService: epgMock }));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../services/recently-watched', () => ({ RecentlyWatchedService: recentMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));

import { ChannelList } from './channel-list';
import { setLocale } from '../i18n';
import { channelKey } from '../utils/channel';
import { ChannelCustomizationService, groupKeyOf } from '../services/channel-customization';

playlistMock.indexOfKey = (key: string) => data.channels
  .findIndex(ch => channelKey(ch) === key);
playlistMock.getGroupKeyForDisplay = (display: string): string => {
  for (const key of ChannelCustomizationService.customGroups) {
    if (ChannelCustomizationService.groupLabel(key) === display) return key;
  }
  for (const channel of data.channels) {
    if (channel.group === display) return groupKeyOf(channel);
  }
  return display;
};
playlistMock.getByGroup = (group: string, playlist?: string): Channel[] => {
  const channels = playlist
    ? data.channels.filter(channel => channel.playlistIds.includes(playlist))
    : data.channels;
  if (group === 'builtin:all' || group === 'builtin:recently-watched') return channels;
  if (group === 'builtin:favorites') {
    return channels.filter(channel => data.favorites.includes(channelKey(channel)));
  }
  return channels.filter(channel => channel.group === group.slice('source:'.length));
};

// Mirror PlaylistService: re-derive the visible list from the customization record.
playlistMock.applyCustomization = vi.fn(() => {
  const next = ChannelCustomizationService.applyTo(data.raw, data.includeHidden);
  data.channels.splice(0, data.channels.length, ...next);
  playlistMock.groupsRevision++;
});
playlistMock.setIncludeHidden = vi.fn((on: boolean) => {
  if (data.includeHidden === on) return;
  data.includeHidden = on;
  playlistMock.applyCustomization();
});
playlistMock.getGroupsForPlaylist = (playlist?: string) => {
  const keys: string[] = [];
  const channels = playlist
    ? data.channels.filter(ch => ch.playlistIds.includes(playlist))
    : data.channels;
  for (const ch of channels) {
    const key = groupKeyOf(ch);
    if (key && keys.indexOf(key) < 0) keys.push(key);
  }
  if (!playlist) {
    for (const key of ChannelCustomizationService.customGroups) {
      if (keys.indexOf(key) < 0) keys.push(key);
    }
  }
  return ChannelCustomizationService.sortGroupKeys(keys)
    .map(key => ChannelCustomizationService.groupLabel(key));
};

let container: HTMLElement;
let onSelect: ReturnType<typeof vi.fn>;
let list: ChannelList;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  data.favorites = [];
  data.includeHidden = false;
  data.raw.forEach(ch => { ch.playlistIds = []; });
  data.raw[2].group = 'News';
  delete data.raw[2].sourceGroup;
  delete data.raw[2].groupKey;
  customization.record = null;
  ChannelCustomizationService.reload();
  playlistMock.applyCustomization();
  recentMock.items = [];
  recentMock.getItems.mockClear();
  recentMock.catchupInfo.mockReset();
  toastMock.showToast.mockClear();
  playlistMock.playlistTabs = [];
  storageMock.toggleFavorite.mockClear();
  storageMock.setFavorites.mockClear();
  storageMock.setChannelCustomization.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  onSelect = vi.fn();
  list = new ChannelList(container, onSelect);
});

function channelItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.channel-main .channel-item'));
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
}

describe('ChannelList.render', () => {
  it('initial focus is the first channel when channels exist', () => {
    list.render();
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
  });

  it('renders no title heading or settings gear (the tab bar owns those)', () => {
    list.render();
    expect(container.querySelector('.sidebar-title')).toBeNull();
    expect(container.querySelector('.settings-btn')).toBeNull();
  });

  it('renders the channel count and all channels for the default group', () => {
    list.render();
    expect(container.querySelector('.channel-count')?.textContent).toBe('3 channels');
    expect(channelItems()).toHaveLength(3);
    expect(container.textContent).toContain('Alpha');
  });

  it('renders normal channel and group content without editor inputs', () => {
    list.render();

    expect(channelItems()[0].querySelector('.channel-name')?.textContent).toBe('Alpha');
    expect(container.querySelector('[data-group="source:News"] .group-name')?.textContent)
      .toBe('News');
    expect(container.querySelector('.edit-text-input')).toBeNull();
  });

  it('opens channel editing from the pencil button', () => {
    list.render();
    const edit = container.querySelector<HTMLElement>('.channel-edit-btn');
    expect(edit?.querySelector('img')?.getAttribute('src')).toBe('assets/icons/pencil.svg');
    hover(edit!);
    list.handleAction('select');
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('.channel-edit-btn')).toBeNull();
  });

  it('uses the singular channel count for a one-channel playlist', () => {
    const removed = playlistMock.channels.splice(1);
    try {
      list.render();
      expect(container.querySelector('.channel-count')?.textContent).toBe('1 channel');
    } finally {
      playlistMock.channels.push(...removed);
    }
  });

  it('renders no inline search magnifier (the tab bar owns search)', () => {
    list.render();
    expect(container.querySelector('.channel-search')).toBeNull();
    expect(container.querySelector('.search-icon')).toBeNull();
  });

  it('renders a bounded window for 50,000 channels', () => {
    const original = data.raw.slice();
    data.raw.splice(0, data.raw.length);
    for (let i = 0; i < 50_000; i++) {
      data.raw.push({
        ...original[0],
        id: `ch${String(i)}`,
        name: `Channel ${String(i)}`,
        url: `http://host/${String(i)}`,
      });
    }
    try {
      playlistMock.applyCustomization();
      list.render();

      expect(channelItems().length).toBeLessThan(50);
      expect(container.querySelector<HTMLElement>('.channel-list-spacer')?.style.height)
        .toBe('4400000px');
    } finally {
      data.raw.splice(0, data.raw.length, ...original);
      playlistMock.applyCustomization();
    }
  });

  it('renders the group list including All, Favorites, and Recently Watched', () => {
    list.render();
    const groups = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .map(g => g.dataset.group);
    expect(groups).toEqual([
      'builtin:all',
      'builtin:favorites',
      'builtin:recently-watched',
      'source:News',
      'source:Sports',
    ]);
  });

  it('rebuilds cached builtin group labels after a language change', () => {
    list.render();
    expect(container.querySelector('[data-group="builtin:recently-watched"] .group-name')?.textContent)
      .toBe('Recently Watched');

    setLocale('zh-CN');
    list.render();

    expect(container.querySelector('[data-group="builtin:recently-watched"] .group-name')?.textContent)
      .toBe('最近观看');
  });

  it('renders a bounded group window for 50,000 groups', () => {
    const original = playlistMock.getGroupsForPlaylist;
    playlistMock.getGroupsForPlaylist = () =>
      Array.from({ length: 50_000 }, (_, index) => `Group ${String(index)}`);
    playlistMock.groupsRevision++;
    try {
      list.render();
      expect(container.querySelectorAll('.group-item').length).toBeLessThan(60);
      expect(container.querySelector<HTMLElement>('.group-list-spacer')?.style.height)
        .toBe('3400204px');
    } finally {
      playlistMock.getGroupsForPlaylist = original;
      playlistMock.groupsRevision++;
    }
  });

  it('marks favorites with a star', () => {
    data.favorites = [channelKey(data.channels[0])];
    list.render();
    const alpha = channelItems()[0].querySelector('.channel-name')!;
    expect(alpha.textContent).toContain('★');
  });

  it('shows an empty state when a group has no channels', () => {
    data.favorites = [];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('No channels found');
  });

  it('renders distinct live and Catch-up rows in Recently Watched', () => {
    const live = {
      kind: 'live' as const,
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 2000,
    };
    const catchup = {
      kind: 'catchup' as const,
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[1]),
        progStart: 1000,
        progEnd: 3_601_000,
        title: 'Program Alpha',
        description: '',
        icon: '',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    };
    recentMock.items = [live, catchup];

    list.render();
    const spacer = container.querySelector('.channel-list-spacer');
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    expect(channelItems()).toHaveLength(2);
    expect(channelItems()[0]).not.toBe(spacer);
    expect(channelItems()[0].querySelector('.recent-kind-badge')?.textContent).toBe('LIVE');
    expect(channelItems()[1].querySelector('.recent-kind-badge')?.textContent).toBe('CATCH-UP');
    expect(channelItems()[1].textContent).toContain('Program Alpha');
    expect(channelItems()[1].textContent).toContain('Resume at 10:00');
    expect(container.querySelector('.channel-list-scroll')?.classList.contains('recent-list'))
      .toBe(true);
    expect(container.querySelector('.channel-list-spacer')).toBeNull();
  });

  it('resets a deep channel scroll before showing Recently Watched', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
    }];
    list.render();
    const main = container.querySelector<HTMLElement>('.channel-main')!;
    main.scrollTop = 20_000;

    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    expect(main.scrollTop).toBe(0);
    expect(channelItems()).toHaveLength(1);
  });

  it('shows the Recently Watched empty state', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('Nothing watched yet');
  });

  it('disables channel editing in Recently Watched', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expect(container.querySelector('.channel-edit-btn')).toBeNull();
    expect(container.querySelector('.channel-edit-btn-spacer')).not.toBeNull();
    list.handleAction('yellow');
    expect(list.isEditing).toBe(false);
    expect(container.querySelector('.edit-hints')).toBeNull();
  });

  it('opens Settings-driven channel editing in All', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    list.enterEditMode('builtin:all');
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('[data-group="builtin:all"]')?.classList.contains('active'))
      .toBe(true);
    expect(channelItems()).toHaveLength(3);
  });

  it('escapes a malicious channel name instead of rendering live HTML (XSS)', () => {
    playlistMock.channels[0].name = '<img src=x onerror="window.__xss=1">';
    try {
      list.render();
      expect(container.querySelector('.channel-main img')).toBeNull();
      expect(container.querySelector('.channel-name')?.textContent)
        .toContain('<img src=x onerror=');
    } finally {
      playlistMock.channels[0].name = 'Alpha';
    }
  });

  it('removes a failed channel logo and does not restore it on later renders', () => {
    playlistMock.channels[0].logo = 'http://host/broken.png';
    try {
      list.render();
      const logo = container.querySelector<HTMLImageElement>('.channel-logo');
      expect(logo).not.toBeNull();

      logo!.dispatchEvent(new Event('error'));
      const failedRow = channelItems()[0];
      expect(failedRow.querySelector('.channel-logo')).toBeNull();
      expect(failedRow.querySelector('.channel-logo-placeholder')).toBeNull();

      list.render();
      expect(channelItems()[0].querySelector('.channel-logo')).toBeNull();
    } finally {
      playlistMock.channels[0].logo = '';
    }
  });
});

describe('ChannelList interaction', () => {
  beforeEach(() => list.render());

  it('selecting a focused channel plays it', () => {
    hover(channelItems()[1]);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('reports virtual moves so Up does not hand focus to the tab bar', () => {
    expect(list.handleAction('down')).toBe(true);
    expect(container.querySelector<HTMLElement>('.channel-item.focused')?.dataset.channelIndex)
      .toBe('1');
    expect(list.handleAction('up')).toBe(true);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('selecting a recent live row starts live playback', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
    }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('selecting a recent Catch-up row resumes directly', async () => {
    const catchup = {
      kind: 'catchup' as const,
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[0]),
        progStart: 1_000_000,
        progEnd: 4_600_000,
        title: 'Program Alpha',
        description: '',
        icon: '',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    };
    recentMock.items = [catchup];
    const info = {
      start: 1000,
      end: 4600,
      title: 'Program Alpha',
      description: '',
      icon: '',
      resumeSecs: 600,
    };
    recentMock.catchupInfo.mockResolvedValue(info);
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith(0, info);
  });

  it('removes an unavailable recent Catch-up row and shows a toast', async () => {
    recentMock.items = [{
      kind: 'catchup',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
      progress: {
        channelKey: channelKey(data.channels[0]),
        progStart: 1_000_000,
        progEnd: 4_600_000,
        title: 'Program Alpha',
        position: 600,
        duration: 3600,
        updatedAt: 1000,
        completed: false,
      },
    }];
    recentMock.catchupInfo.mockResolvedValue(null);
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    list.handleAction('select');
    await Promise.resolve();
    expect(onSelect).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith('This catch-up program is no longer available.');
  });

  it('plays a channel on a pointer click', () => {
    const target = channelItems()[1];
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => target;
    container.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 50, bubbles: true }));
    document.elementFromPoint = orig;
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('switches group on a pointer click over a group item', () => {
    const group = container.querySelector<HTMLElement>('[data-group="source:Sports"]')!;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => group;
    container.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
    document.elementFromPoint = orig;
    expect(channelItems()).toHaveLength(1);
    expect(container.textContent).toContain('Bravo');
  });

  it('selecting a group filters the channel list', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1);
    expect(container.textContent).toContain('Bravo');
    expect(container.textContent).not.toContain('Alpha');
  });

  it('clears the focused channel when the cursor leaves the view', () => {
    hover(channelItems()[1]);
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    container.dispatchEvent(new MouseEvent('mouseleave'));
    expect(channelItems()[1].classList.contains('focused')).toBe(false);
  });

  it('green toggles the focused channel as a favorite', () => {
    expect(container.querySelector('.channel-hints')).toBeNull();
    hover(channelItems()[0]);
    list.handleAction('green');
    expect(storageMock.toggleFavorite).toHaveBeenCalledWith(channelKey(data.channels[0]));
  });

  it('a number action plays that channel (1-based)', () => {
    list.handleAction('number', { number: 2 });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('ignores an out-of-range number', () => {
    list.handleAction('number', { number: 99 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('setPlaying marks the playing channel on the next render', () => {
    list.setPlaying(2);
    list.render();
    expect(channelItems()[2].classList.contains('playing')).toBe(true);
  });

  it('highlightEntryPoint focuses the first channel without taking the caret', () => {
    list.highlightEntryPoint();
    expect(channelItems()[0].classList.contains('focused')).toBe(true);
  });
});

describe('ChannelList listener lifecycle', () => {
  it('falls back to the All tab when the selected playlist was removed', () => {
    playlistMock.playlistTabs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-playlist="b"]')!);
    list.handleAction('select');
    expect(container.querySelector('.playlist-tab.active')?.getAttribute('data-playlist')).toBe('b');

    playlistMock.playlistTabs = [{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }]; // 'b' deleted
    list.render();
    expect(container.querySelector('.playlist-tab.active')?.getAttribute('data-playlist')).toBe('');
  });

  it('binds the nav:hover listener once, not per render', () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    const spy = vi.spyOn(c, 'addEventListener');
    const l = new ChannelList(c, vi.fn());
    l.render();
    l.render();
    l.render();
    const navHover = spy.mock.calls.filter(([type]) => type === 'nav:hover');
    expect(navHover).toHaveLength(1);
  });
});

describe('ChannelList morph lifecycle', () => {
  it('preserves channel-item node identity across re-renders', () => {
    list.render();
    const before = channelItems();
    list.setPlaying(1);
    list.render();
    const after = channelItems();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('restores the SpatialNav focus class on the same node after a re-render', () => {
    list.render();
    hover(channelItems()[1]);
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    list.render();
    // Same DOM node, .focused re-applied via prevFocusedKey lookup.
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
  });
});
