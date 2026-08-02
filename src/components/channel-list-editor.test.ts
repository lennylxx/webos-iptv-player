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
      getGroupCount: (_group: string, _playlist?: string): number => channels.length,
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
playlistMock.getGroupCount = (group: string, playlist?: string): number =>
  playlistMock.getByGroup(group, playlist).length;

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

describe('ChannelList edit mode', () => {
  function names(): string[] {
    return channelItems().map(el => el.querySelector('.channel-name')?.textContent?.trim() ?? '');
  }

  function enterEdit(): void {
    list.render();
    list.handleAction('yellow');
  }

  it('yellow enters edit mode and yellow again leaves it', () => {
    enterEdit();
    expect(list.isEditing).toBe(true);
    expect(container.querySelector('.edit-hints')).not.toBeNull();
    expect(container.querySelector('.channel-edit-btn')).toBeNull();
    expect(container.querySelector('.channel-edit-btn-spacer')).not.toBeNull();
    list.handleAction('yellow');
    expect(list.isEditing).toBe(false);
    expect(container.querySelector('.favorite-hints')).toBeNull();
    expect(container.querySelector('.channel-hints')).toBeNull();
  });

  describe('ChannelList favorite management', () => {
    function openFavorites(): void {
      data.favorites = data.channels.map(channelKey);
      list.render();
      hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
      list.handleAction('select');
    }

    function manageFavorites(): void {
      openFavorites();
      hover(container.querySelector<HTMLElement>('[data-favorite-manage]')!);
      list.handleAction('select');
    }

    it('plays a favorite outside management mode', () => {
      openFavorites();
      expect(list.isEditing).toBe(false);
      expect(container.querySelector('.favorite-checkbox')).toBeNull();
      expect(container.querySelector('[data-favorite-manage]')).not.toBeNull();
      expect(container.querySelector('[data-favorite-manage] .key-ok')).toBeNull();
      expect(channelItems().every(item =>
        !item.querySelector('.channel-name')?.textContent?.startsWith('★'))).toBe(true);
      hover(channelItems()[0]);
      list.handleAction('select');
      expect(onSelect).toHaveBeenCalledWith(0);
    });

    it('uses a multi-select mode when editing favorites', () => {
      manageFavorites();
      expect(list.isEditing).toBe(true);
      expect(container.querySelector('.favorite-hints')?.textContent).toContain('Select all');
      expect(container.querySelectorAll('.favorite-checkbox')).toHaveLength(3);
      expect(container.querySelector('.favorite-hints .key-green')).toBeNull();
      expect(container.querySelector('.favorite-hints .key-red')).not.toBeNull();

      hover(channelItems()[0]);
      list.handleAction('select');
      hover(channelItems()[1]);
      list.handleAction('select');
      expect(container.querySelectorAll('.favorite-selected')).toHaveLength(2);
      expect(container.querySelector('.favorite-hints')?.textContent)
        .toContain('Remove selected (2)');

      list.handleAction('red');
      expect(storageMock.setFavorites).toHaveBeenCalledWith([channelKey(data.channels[2])]);
      expect(channelItems()).toHaveLength(1);
    });

    it('blue selects all favorites and toggles back to none', () => {
      manageFavorites();
      list.handleAction('blue');
      expect(container.querySelectorAll('.favorite-selected')).toHaveLength(3);
      expect(container.querySelector('.favorite-hints')?.textContent)
        .toContain('Deselect all');
      list.handleAction('blue');
      expect(container.querySelectorAll('.favorite-selected')).toHaveLength(0);
      expect(container.querySelector('.favorite-hints')?.textContent).toContain('Select all');
    });

    it('keeps the management footer after removing every favorite', () => {
      manageFavorites();
      list.handleAction('blue');
      list.handleAction('red');
      expect(channelItems()).toHaveLength(0);
      expect(container.querySelector('.empty-state')).not.toBeNull();
      expect(container.querySelector('.favorite-hints')).not.toBeNull();
      expect(container.querySelector('[data-favorite-action="yellow"]')).not.toBeNull();
      expect(container.querySelector('.channel-view')?.classList.contains('has-channel-hints'))
        .toBe(true);
    });

    it('navigates favorites with the channel up and down keys', () => {
      manageFavorites();
      const items = channelItems();
      items.forEach((item, index) => {
        const top = index * 100;
        item.getBoundingClientRect = () => ({
          x: 400, y: top, top, bottom: top + 84,
          left: 400, right: 1000, width: 600, height: 84,
          toJSON: () => ({}),
        });
      });
      hover(items[1]);
      list.handleAction('channel_up');
      expect(items[0].classList.contains('focused')).toBe(true);
      list.handleAction('channel_down');
      expect(items[1].classList.contains('focused')).toBe(true);
    });

    it('requires a selection before removing favorites', () => {
      manageFavorites();
      list.handleAction('red');
      expect(storageMock.setFavorites).not.toHaveBeenCalled();
      expect(toastMock.showToast).toHaveBeenCalledWith(
        'Select at least one favorite first.',
      );
    });

    it('keeps the selection when favorites cannot be saved', () => {
      manageFavorites();
      hover(channelItems()[0]);
      list.handleAction('select');
      storageMock.setFavorites.mockReturnValueOnce(false);
      list.handleAction('red');
      expect(container.querySelectorAll('.favorite-selected')).toHaveLength(1);
      expect(channelItems()).toHaveLength(3);
    });

    it('removes only the selected query-identified favorite', () => {
      const originalUrls = data.raw.map(channel => channel.url);
      try {
        data.raw[0].url = 'http://host/a?id=1';
        data.raw[1].url = 'http://host/a?id=2';
        data.favorites = [channelKey(data.raw[0]), channelKey(data.raw[1])];
        list.render();
        hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
        list.handleAction('select');
        hover(container.querySelector<HTMLElement>('[data-favorite-manage]')!);
        list.handleAction('select');
        hover(channelItems()[0]);
        list.handleAction('select');
        list.handleAction('red');
        expect(data.favorites).toEqual([channelKey(data.raw[1])]);
      } finally {
        data.raw.forEach((channel, index) => { channel.url = originalUrls[index]; });
      }
    });

    it('keeps the pencil for channel editing', () => {
      openFavorites();
      const pencil = container.querySelector<HTMLElement>('.channel-edit-btn');
      expect(pencil).not.toBeNull();
      hover(pencil!);
      list.handleAction('select');
      expect(container.querySelector('.favorite-hints')).toBeNull();
      expect(container.querySelector('.edit-hints')).not.toBeNull();
    });

    it('keeps the yellow-key channel editor shortcut in Favorites', () => {
      openFavorites();
      list.handleAction('yellow');
      expect(list.isEditing).toBe(true);
      expect(container.querySelector('.favorite-hints')).toBeNull();
      expect(container.querySelector('[data-edit-action="green"]')).not.toBeNull();
    });
  });

  it('back leaves edit mode and is not consumed outside it', () => {
    list.render();
    expect(list.handleBack()).toBe(false);
    enterEdit();
    expect(list.handleBack()).toBe(true);
    expect(list.isEditing).toBe(false);
  });

  it('back completes edit mode even while an item is selected', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    expect(container.querySelector('.grabbed')).not.toBeNull();
    expect(list.handleBack()).toBe(true);
    expect(list.isEditing).toBe(false);
  });

  it('shows Back as another way to complete editing', () => {
    enterEdit();
    const back = container.querySelector('.edit-key.key-back');
    expect(back?.querySelector('svg')).not.toBeNull();
    expect(back?.textContent).toBe('');
    expect(back?.parentElement?.textContent).toContain('Done');
    expect(back?.parentElement?.querySelector('.key-yellow')).not.toBeNull();
    expect(back?.parentElement?.querySelector('.edit-key-separator')?.textContent).toBe('/');
  });

  it('green stays the favorite toggle outside edit mode', () => {
    list.render();
    hover(channelItems()[0]);
    list.handleAction('green');
    expect(storageMock.toggleFavorite).toHaveBeenCalledTimes(1);
    expect(ChannelCustomizationService.customized).toBe(false);
  });

  it('select grabs a channel and up/down reorders and persists it', () => {
    enterEdit();
    hover(channelItems()[2]);
    list.handleAction('select');
    expect(channelItems()[2].classList.contains('grabbed')).toBe(true);

    expect(list.handleAction('up')).toBe(true);
    list.handleAction('up');
    expect(names()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(storageMock.setChannelCustomization).toHaveBeenCalled();

    // Focus follows the grabbed row so a second move continues from there.
    expect(channelItems()[0].classList.contains('grabbed')).toBe(true);
    list.handleAction('select');
    expect(container.querySelector('.grabbed')).toBeNull();
  });

  it('drags a channel with the Magic Remote mouse sequence', () => {
    enterEdit();
    const originalElementFromPoint = document.elementFromPoint;
    let hit = channelItems()[2];
    document.elementFromPoint = () => hit;
    channelItems()[2].dispatchEvent(new MouseEvent('mousedown', {
      button: 0, clientX: 100, clientY: 250, bubbles: true,
    }));

    hit = channelItems()[0];
    hit.getBoundingClientRect = () => ({
      top: 0, bottom: 84, left: 0, right: 600, width: 600, height: 84, x: 0, y: 0,
      toJSON: () => ({}),
    });
    container.dispatchEvent(new MouseEvent('mousemove', {
      clientX: 100, clientY: 10, bubbles: true,
    }));
    container.dispatchEvent(new MouseEvent('mouseup', {
      button: 0, clientX: 100, clientY: 10, bubbles: true,
    }));
    container.dispatchEvent(new MouseEvent('click', {
      button: 0, clientX: 100, clientY: 10, bubbles: true,
    }));
    document.elementFromPoint = originalElementFromPoint;

    expect(names()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(container.querySelector('.grabbed')).toBeNull();
    expect(storageMock.setChannelCustomization).toHaveBeenCalled();
  });

  it('does not move a grabbed channel past the ends of the list', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('up');
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('up/down navigates instead of reordering while nothing is grabbed', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('down');
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(storageMock.setChannelCustomization).not.toHaveBeenCalled();
  });

  it('green hides the selected channel, which stays visible but marked while editing', () => {
    enterEdit();
    hover(channelItems()[1]);
    list.handleAction('select');
    list.handleAction('green');
    expect(channelItems()).toHaveLength(3);
    expect(channelItems()[1].classList.contains('hidden-entry')).toBe(true);
    expect(ChannelCustomizationService.isHidden(channelKey(data.raw[1]))).toBe(true);

    list.handleAction('yellow');
    expect(names()).toEqual(['Alpha', 'Charlie']);
  });

  it('shows a toast instead of hiding the hovered channel when none is selected', () => {
    enterEdit();
    hover(channelItems()[1]);
    list.handleAction('green');
    expect(ChannelCustomizationService.isHidden(channelKey(data.raw[1]))).toBe(false);
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Select a channel or group first.');
  });

  it('does not rename or regroup a hovered channel when none is selected', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('blue');
    expect(container.querySelector('.edit-text-input')).toBeNull();
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Select a channel or group first.');

    list.handleAction('red');
    expect(container.querySelector('.group-picker')).toBeNull();
    expect(toastMock.showToast).toHaveBeenLastCalledWith('Select a channel or group first.');
  });

  it('opens rename from the clickable edit toolbar', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    const rename = container.querySelector<HTMLElement>('[data-edit-action="blue"]')!;
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => rename;
    container.dispatchEvent(new MouseEvent('click', {
      clientX: 100, clientY: 100, bubbles: true,
    }));
    document.elementFromPoint = originalElementFromPoint;
    expect(container.querySelector('.edit-text-input')).not.toBeNull();
  });

  it('blue renames the focused channel and an empty value restores the source name', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('blue');
    const input = container.querySelector<HTMLInputElement>('.edit-text-input');
    expect(input).not.toBeNull();
    input!.value = 'Alpha Two';
    list.handleAction('select');
    expect(names()[0]).toBe('Alpha Two');
    expect(data.raw[0].sourceName).toBe('Alpha');

    hover(channelItems()[0]);
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = '';
    list.handleAction('select');
    expect(names()[0]).toBe('Alpha');
    expect(data.raw[0].sourceName).toBeUndefined();
  });

  it('does not commit a rename when the Magic Remote clicks inside the input', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('blue');
    const input = container.querySelector<HTMLInputElement>('.edit-text-input')!;
    input.value = 'Alpha Two';

    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(container.querySelector('.edit-text-input')).toBe(input);
    expect(data.raw[0].sourceName).toBeUndefined();
  });

  it('commits a rename when Enter originates from the focused input', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('blue');
    const input = container.querySelector<HTMLInputElement>('.edit-text-input')!;
    input.value = 'Alpha Two';

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 13,
      bubbles: true,
    }));

    expect(container.querySelector('.edit-text-input')).toBeNull();
    expect(names()[0]).toBe('Alpha Two');
  });

  it('back cancels an open rename without changing the name', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Nope';
    expect(list.handleBack()).toBe(true);
    expect(names()[0]).toBe('Alpha');
    expect(list.isEditing).toBe(true);
  });

  it('red moves the focused channel into an existing group', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('red');
    const options = Array.from(container.querySelectorAll<HTMLElement>('.group-picker-option'));
    const sports = options.find(el => el.dataset.groupChoice === 'Sports');
    expect(sports).toBeDefined();
    hover(sports!);
    list.handleAction('select');
    expect(data.raw[0].group).toBe('Sports');
    expect(data.raw[0].sourceGroup).toBe('News');
  });

  it('red can create a new group for the focused channel', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('red');
    const newOption = Array.from(container.querySelectorAll<HTMLElement>('.group-picker-option'))
      .find(el => el.dataset.groupChoice === 'new');
    hover(newOption!);
    list.handleAction('select');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Custom';
    list.handleAction('select');
    expect(data.raw[0].group).toBe('Custom');
    expect(ChannelCustomizationService.customGroups).toEqual(['Custom']);
    expect(container.querySelector('.group-picker')).toBeNull();
  });

  it('keeps new-group input open when its name already exists', () => {
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('red');
    const newOption = Array.from(container.querySelectorAll<HTMLElement>('.group-picker-option'))
      .find(el => el.dataset.groupChoice === 'new');
    hover(newOption!);
    list.handleAction('select');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'sports';

    list.handleAction('select');

    expect(container.querySelector('.edit-text-input')).not.toBeNull();
    expect(data.raw[0].group).toBe('News');
    expect(toastMock.showToast).toHaveBeenLastCalledWith(
      'A group with that name already exists.',
    );
  });

  it('the source-group option clears a group override', () => {
    ChannelCustomizationService.setGroup(channelKey(data.raw[0]), 'Custom');
    playlistMock.applyCustomization();
    enterEdit();
    hover(channelItems()[0]);
    list.handleAction('select');
    list.handleAction('red');
    const source = Array.from(container.querySelectorAll<HTMLElement>('.group-picker-option'))
      .find(el => el.dataset.groupChoice === 'source');
    hover(source!);
    list.handleAction('select');
    expect(data.raw[0].group).toBe('News');
    expect(data.raw[0].sourceGroup).toBeUndefined();
  });

  it('reorders a grabbed source group', () => {
    enterEdit();
    const sports = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:Sports');
    hover(sports!);
    list.handleAction('select');
    list.handleAction('up');
    const groups = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .map(el => el.dataset.group);
    expect(groups.slice(-2)).toEqual(['source:Sports', 'source:News']);
  });

  it('preserves other playlists groups when reordering within one playlist', () => {
    data.raw[0].playlistIds = ['a'];
    data.raw[1].playlistIds = ['b'];
    data.raw[2].playlistIds = ['a'];
    data.raw[2].group = 'Movies';
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    list.render();
    const playlistA = container.querySelector<HTMLElement>('[data-playlist="a"]')!;
    hover(playlistA);
    list.handleAction('select');
    enterEdit();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');

    list.handleAction('down');

    expect(playlistMock.getGroupsForPlaylist()).toEqual(['Sports', 'Movies', 'News']);
  });

  it('renames a source group without changing its channels', () => {
    enterEdit();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Headlines';
    list.handleAction('select');
    expect(data.raw[0].group).toBe('Headlines');
    expect(data.raw[0].sourceGroup).toBe('News');
    expect(ChannelCustomizationService.groupLabel('News')).toBe('Headlines');
  });

  it('keeps the stable key when renaming an empty custom group again', () => {
    ChannelCustomizationService.addCustomGroup('Custom');
    ChannelCustomizationService.renameGroup('Custom', 'Renamed');
    playlistMock.applyCustomization();
    list.render();
    enterEdit();
    const renamed = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:Renamed');
    hover(renamed!);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Again';

    list.handleAction('select');

    expect(ChannelCustomizationService.groupLabel('Custom')).toBe('Again');
    expect(ChannelCustomizationService.groupLabel('Renamed')).toBe('Renamed');
  });

  it('keeps group rename open when the name belongs to another group', () => {
    enterEdit();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Sports';

    list.handleAction('select');

    expect(container.querySelector('.edit-text-input')).not.toBeNull();
    expect(data.raw[0].group).toBe('News');
    expect(toastMock.showToast).toHaveBeenLastCalledWith(
      'A group with that name already exists.',
    );
  });

  it('rejects a group name used only by another playlist', () => {
    data.raw[0].playlistIds = ['a'];
    data.raw[1].playlistIds = ['b'];
    data.raw[2].playlistIds = ['a'];
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    list.render();
    const playlistA = container.querySelector<HTMLElement>('[data-playlist="a"]')!;
    hover(playlistA);
    list.handleAction('select');
    enterEdit();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Sports';

    list.handleAction('select');

    expect(container.querySelector('.edit-text-input')).not.toBeNull();
    expect(data.raw[0].group).toBe('News');
  });

  it('falls back to All when the active group is renamed', () => {
    list.render();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');
    enterEdit();
    const selectedNews = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(selectedNews!);
    list.handleAction('select');
    list.handleAction('blue');
    container.querySelector<HTMLInputElement>('.edit-text-input')!.value = 'Headlines';

    list.handleAction('select');

    expect(container.querySelector<HTMLElement>('.group-item.active')?.dataset.group)
      .toBe('builtin:all');
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('green hides a source group', () => {
    enterEdit();
    const news = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
      .find(el => el.dataset.group === 'source:News');
    hover(news!);
    list.handleAction('select');
    list.handleAction('green');
    expect(ChannelCustomizationService.isGroupHidden('News')).toBe(true);
    list.handleAction('yellow');
    expect(names()).toEqual(['Bravo']);
  });
});
