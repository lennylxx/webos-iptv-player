// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel } from '../types';
import type { RecentlyWatchedItem } from '../services/recently-watched';

const {
  data,
  customization,
  playlistMock,
  epgMock,
  storageMock,
  recentMock,
  toastMock,
  healthMock,
} = vi.hoisted(() => {
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
      complete: true,
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
    healthMock: {
      records: {} as Record<string, 'healthy' | 'suspect' | 'unavailable'>,
      getRecord: vi.fn((channel: Channel) => {
        const status = healthMock.records[channel.url];
        return status ? { status } : null;
      }),
    },
  };
});

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({ EpgService: epgMock }));
vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../services/recently-watched', () => ({ RecentlyWatchedService: recentMock }));
vi.mock('./toast', () => ({ showToast: toastMock.showToast }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));

import { ChannelList } from './channel-list';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';
import { ringsIn } from '../navigation/focus-ring';
import { morph } from '../utils/morph';
import { html } from '../utils/dom';
import { CONFIG } from '../config';
import { setLocale } from '../i18n';
import { channelKey } from '../utils/channel';
import { UNCATEGORIZED_GROUP } from '../types';
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
  healthMock.records = {};
  playlistMock.playlistTabs = [];
  playlistMock.complete = true;
  storageMock.toggleFavorite.mockClear();
  storageMock.setFavorites.mockClear();
  storageMock.setChannelCustomization.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  onSelect = vi.fn();
  list = new ChannelList(container, { onChannelSelect: onSelect });
  // The list's scope owns the keys, as on the Live view.
  Focus.setBase(() => list.focusScope);
});

afterEach(() => {
  Focus.setBase(() => null);
});

// The scope paints the ring on its next reconcile.
function ringed(el: Element | null | undefined): boolean {
  Focus.flush();
  return !!el?.classList.contains('focused');
}

function ringedEl(root: HTMLElement, selector: string): HTMLElement | null {
  Focus.flush();
  return root.querySelector<HTMLElement>(selector);
}

function channelItems(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.channel-main .channel-item'));
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
}

describe('ChannelList.render', () => {
  it('omits the live-preview toolbar when the setting is off', () => {
    list = new ChannelList(container, {
      onChannelSelect: onSelect,
      getPreviewHintState: () => 'off',
    });
    list.render();
    expect(container.querySelector('.preview-list-hints')).toBeNull();
  });

  it('keeps one stable live-preview hint set across list and control focus', () => {
    list = new ChannelList(container, {
      onChannelSelect: onSelect,
      getPreviewHintState: () => 'active',
    });
    list.render();
    expect(container.querySelector('.preview-list-hints')?.textContent).toContain('Open preview');
    expect(container.querySelector('.preview-list-hints')?.textContent).toContain('Preview controls');
    expect(container.querySelector('[data-preview-list-close] .key-back svg')).not.toBeNull();
    expect(container.querySelector('[data-preview-list-close]')?.textContent).toContain('Close');
    const hints = container.querySelector('.preview-list-hints')?.innerHTML;
    list.setPreviewFocused(true);
    expect(container.querySelector('.preview-list-hints')?.innerHTML).toBe(hints);
    list.setPreviewFocused(false);
    expect(container.querySelector('.preview-list-hints')?.innerHTML).toBe(hints);
  });

  it('shows the preview scrollbar while scrolling and hides it after a delay', () => {
    vi.useFakeTimers();
    document.body.classList.add('has-live-preview');
    try {
      list.render();
      const main = container.querySelector<HTMLElement>('.channel-main')!;
      const indicator = container.querySelector<HTMLElement>('.channel-scroll-indicator')!;
      const thumb = indicator.querySelector<HTMLElement>('.channel-scroll-thumb')!;
      Object.defineProperties(main, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1000 },
        scrollTop: { configurable: true, value: 200, writable: true },
      });
      Object.defineProperty(indicator, 'clientHeight', { configurable: true, value: 300 });

      main.dispatchEvent(new Event('scroll'));

      expect(indicator.classList.contains('visible')).toBe(true);
      expect(thumb.style.height).toBe('120px');
      expect(thumb.style.transform).toBe('translateY(60px)');
      vi.advanceTimersByTime(CONFIG.CHANNEL_SCROLLBAR_HIDE_MS);
      expect(indicator.classList.contains('visible')).toBe(false);
    } finally {
      document.body.classList.remove('has-live-preview');
      vi.useRealTimers();
    }
  });

  it('does not activate the custom scrollbar outside preview', () => {
    list.render();
    const main = container.querySelector<HTMLElement>('.channel-main')!;
    main.dispatchEvent(new Event('scroll'));
    expect(container.querySelector('.channel-scroll-indicator')?.classList.contains('visible'))
      .toBe(false);
  });

  // With no channels the entry point falls through to the first focusable,
  // taken in DOM order with no geometry to fall back on — so measurement is
  // the only thing keeping focus off an invisible control. Rects are stubbed
  // because jsdom has no layout.
  it('an empty list falls back to the first visible focusable', () => {
    const savedChannels = data.channels.slice();
    const savedByGroup = playlistMock.getByGroup;
    const savedCount = playlistMock.getGroupCount;
    playlistMock.getByGroup = () => [];
    playlistMock.getGroupCount = () => 0;
    data.channels.length = 0;

    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function stub(this: Element): DOMRect {
      const collapsed = this.classList.contains('channel-edit-btn');
      const size = collapsed ? 0 : 100;
      return { width: size, height: size, top: 0, left: 0, bottom: size, right: size } as DOMRect;
    };
    try {
      list.render();
    } finally {
      Element.prototype.getBoundingClientRect = original;
      playlistMock.getByGroup = savedByGroup;
      playlistMock.getGroupCount = savedCount;
      data.channels.push(...savedChannels);
    }

    expect(ringed(container.querySelector('.channel-edit-btn'))).toBe(false);
    expect(ringed(container.querySelector('.group-item'))).toBe(true);
  });

  it('initial focus is the first channel when channels exist', () => {
    list.render();
    expect(ringed(channelItems()[0])).toBe(true);
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

  it('renders persisted channel health status', () => {
    healthMock.records['http://host/a'] = 'suspect';
    list.render();

    const dot = channelItems()[0].querySelector('.channel-health-dot');
    expect(dot?.textContent).toBe('');
    expect(dot?.getAttribute('aria-label')).toBe('Suspect');
    expect(dot?.classList)
      .toContain('suspect');
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

  describe('with focus scrolled out of the rendered rows', () => {
    let original: Channel[];
    let main: HTMLElement;

    beforeEach(() => {
      original = data.raw.slice();
      data.raw.splice(0, data.raw.length);
      for (let i = 0; i < 300; i++) {
        data.raw.push({
          ...original[0],
          id: `ch${String(i)}`,
          name: `Channel ${String(i)}`,
          logo: `http://host/logo${String(i)}.png`,
          url: `http://host/${String(i)}`,
        });
      }
      playlistMock.applyCustomization();
      list.setPlaying(0);
      list.render();
      main = container.querySelector<HTMLElement>('.channel-main')!;
      expect(ringed(main.querySelector('[data-list-position="0"]'))).toBe(true);
    });

    function scrollTo(offset: number): void {
      main.scrollTop = offset;
      main.dispatchEvent(new Event('scroll'));
      list.render(false);
    }

    afterEach(() => {
      data.raw.splice(0, data.raw.length, ...original);
      playlistMock.applyCustomization();
    });

    it('a failed logo keeps a focused row scrolled just out of view where it is', () => {
      scrollTo(200);
      const row0 = main.querySelector('[data-list-position="0"]');
      expect(ringed(row0)).toBe(true);
      main.querySelector<HTMLImageElement>('img.channel-logo')!.dispatchEvent(new Event('error'));

      expect(main.scrollTop).toBe(200);
    });

    it('a failed logo keeps the scroll position and the detached focus', () => {
      scrollTo(3000);
      expect(main.querySelector('[data-list-position="0"]')).toBeNull();
      const logo = main.querySelector<HTMLImageElement>('img.channel-logo')!;
      logo.dispatchEvent(new Event('error'));

      expect(main.scrollTop).toBe(3000);
      expect(main.querySelector('[data-list-position="0"]')).toBeNull();
      expect(ringedEl(container, '.focused')).toBeNull();
    });

    it('a full render scrolls a partly hidden focused row back into view', () => {
      scrollTo(200);
      expect(ringed(main.querySelector('[data-list-position="0"]'))).toBe(true);
      list.render();

      expect(main.scrollTop).toBe(0);
    });

    it('a first render centers on the playing channel deep in the list', () => {
      const fresh = document.createElement('div');
      document.body.appendChild(fresh);
      const other = new ChannelList(fresh, { onChannelSelect: vi.fn() });
      other.setPlaying(250);
      other.render();

      expect(fresh.querySelector('.channel-main [data-channel-index="250"]')).not.toBeNull();
      expect(fresh.querySelector('.channel-main [data-channel-index="0"]')).toBeNull();
      fresh.remove();
    });

    it('does not center on a playing index whose channel sits earlier too', () => {
      data.raw[250] = data.raw[200];
      playlistMock.applyCustomization();
      const fresh = document.createElement('div');
      document.body.appendChild(fresh);
      const other = new ChannelList(fresh, { onChannelSelect: vi.fn() });
      other.setPlaying(250);
      other.render();

      expect(fresh.querySelector('.channel-main [data-list-position="200"]')).toBeNull();
      fresh.remove();
    });

    it('a render with a group focused does not jump to the playing channel', () => {
      hover(container.querySelector<HTMLElement>('.group-list [data-key^="g:"]')!);
      list.setPlaying(250);
      list.render();

      expect(main.querySelector('[data-list-position="250"]')).toBeNull();
    });

    it('a full render leaves the detached focus for the next key to resume', () => {
      scrollTo(3000);
      expect(main.querySelector('[data-list-position="0"]')).toBeNull();
      list.render();

      expect(main.scrollTop).toBe(3000);
      expect(main.querySelector('[data-list-position="0"]')).toBeNull();
      expect(ringedEl(container, '.focused')).toBeNull();
    });

    it('renders at where a smooth scroll is by the next frame, not where it fired', () => {
      const frames: FrameRequestCallback[] = [];
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      try {
        main.scrollTop = 1000;
        main.dispatchEvent(new Event('scroll'));
        // The smooth scroll moves on before the frame runs.
        main.scrollTop = 3000;
        frames.splice(0).forEach((cb) => { cb(0); });

        expect(main.scrollTop).toBe(3000);
      } finally {
        raf.mockRestore();
      }
    });
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

  it('localizes the ungrouped bucket while leaving provider group names alone', () => {
    const original = playlistMock.getGroupsForPlaylist;
    playlistMock.getGroupsForPlaylist = () => ['Uncategorized', UNCATEGORIZED_GROUP];
    playlistMock.groupsRevision++;
    try {
      setLocale('en');
      list.render();
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
        .filter(g => g.dataset.group?.indexOf('source:') === 0)
        .map(g => g.querySelector('.group-name')?.textContent);
      expect(labels).toEqual(['Uncategorized', 'Uncategorized']);

      setLocale('zh-CN');
      playlistMock.groupsRevision++;
      list.render();
      const zh = Array.from(container.querySelectorAll<HTMLElement>('.group-item'))
        .filter(g => g.dataset.group?.indexOf('source:') === 0)
        .map(g => g.querySelector('.group-name')?.textContent);
      expect(zh).toEqual(['Uncategorized', '未分类']);
    } finally {
      setLocale('en');
      playlistMock.getGroupsForPlaylist = original;
      playlistMock.groupsRevision++;
    }
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
    expect(alpha.querySelector('.favorite-glyph.set')).not.toBeNull();
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

  it('brings a restored Recently Watched row into view once', () => {
    Focus.setBase(() => list.focusScope);
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
    }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    Focus.flush();
    // The list sits 100px tall with its row scrolled just below it.
    const main = container.querySelector<HTMLElement>('.channel-main')!;
    let scrolled = 0;
    const rowTop = () => 150 - scrolled;
    const inView = () => rowTop() >= 0 && rowTop() + 50 <= 100;
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
      if (this === channelItems()[0] && !inView()) scrolled = 150 + 50 - 100;
    });
    expect(inView()).toBe(false);

    list.render();
    expect(inView()).toBe(false);
    main.style.overflowY = 'auto';
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 100 });
    main.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    channelItems()[0].getBoundingClientRect = () => new DOMRect(0, rowTop(), 400, 50);
    Focus.flush();
    expect(inView()).toBe(true);

    // Once it has been shown, the user may scroll it away again.
    scrolled = 0;
    Focus.reconcile();
    Focus.flush();
    expect(inView()).toBe(false);
  });

  it('keeps a restored Recently Watched row\'s reveal through a pass for another key', () => {
    Focus.setBase(() => list.focusScope);
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[0],
      channelIndex: 0,
      updatedAt: 1000,
    }];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    hover(channelItems()[0]);
    Focus.flush();
    const main = container.querySelector<HTMLElement>('.channel-main')!;
    let scrolled = 0;
    const rowTop = () => 150 - scrolled;
    const inView = () => rowTop() >= 0 && rowTop() + 50 <= 100;
    vi.mocked(Element.prototype.scrollIntoView).mockImplementation(function (this: Element) {
      if (this === channelItems()[0] && !inView()) scrolled = 150 + 50 - 100;
    });

    list.render();
    const rowKey = channelItems()[0].dataset.key!;
    main.style.overflowY = 'auto';
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(main, 'clientHeight', { configurable: true, value: 100 });
    main.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    channelItems()[0].getBoundingClientRect = () => new DOMRect(0, rowTop(), 400, 50);
    list.focusScope.focus('g:builtin:recently-watched', 'key');
    Focus.flush();
    expect(inView()).toBe(false);

    list.focusScope.focus(rowKey, 'key');
    Focus.flush();
    expect(inView()).toBe(true);
  });

  it('shows the Recently Watched empty state', () => {
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('Nothing watched yet');
  });

  it('says Recently Watched is still loading rather than empty during a load', () => {
    list.setLoading(true);
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expect(container.querySelector('.empty-state')?.textContent).toBe('Loading channels…');
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

  it('notifies the app before entering channel edit mode', () => {
    const onEnterManagement = vi.fn();
    list = new ChannelList(container, {
      onChannelSelect: onSelect,
      onEnterManagement,
    });
    list.render();
    list.enterEditMode('builtin:all');
    expect(onEnterManagement).toHaveBeenCalledOnce();
    expect(list.isEditing).toBe(true);
  });

  it('notifies the app before entering favorite management', () => {
    const onEnterManagement = vi.fn();
    data.favorites = [channelKey(data.channels[0])];
    list = new ChannelList(container, {
      onChannelSelect: onSelect,
      onEnterManagement,
    });
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
    list.handleAction('select');
    hover(container.querySelector<HTMLElement>('[data-favorite-manage]')!);
    list.handleAction('select');
    expect(onEnterManagement).toHaveBeenCalledOnce();
    expect(container.querySelector('.favorite-hints')).not.toBeNull();
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
    expect(onSelect).toHaveBeenCalledWith(
      1,
      undefined,
      { group: 'builtin:all', playlist: undefined },
      'expand-current',
    );
  });

  it('does not play or favorite a focused row a re-render removed', () => {
    data.favorites = [channelKey(data.channels[1])];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:favorites"]')!);
    list.handleAction('select');
    const row = channelItems()[0];
    expect(row.dataset.channelIndex).toBe('1');
    hover(row);
    expect(ringed(row)).toBe(true);

    data.favorites = [];
    list.render(false);
    Focus.flush();
    expect(row.isConnected).toBe(false);

    list.handleAction('select');
    list.handleAction('green');
    expect(onSelect).not.toHaveBeenCalled();
    expect(storageMock.toggleFavorite).not.toHaveBeenCalled();
  });

  it('reports virtual moves so Up does not hand focus to the tab bar', () => {
    expect(list.handleAction('down')).toBe(true);
    expect(ringedEl(container, '.channel-item.focused')?.dataset.channelIndex)
      .toBe('1');
    expect(list.handleAction('up')).toBe(true);
    list.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith(
      0,
      undefined,
      { group: 'builtin:all', playlist: undefined },
      'expand-current',
    );
  });

  it('follows the visual source, group, channel order', () => {
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    list.render();

    hover(container.querySelector<HTMLElement>('[data-group-position="0"]')!);
    expect(list.handleAction('up')).toBe(true);
    expect(ringed(container.querySelector('.playlist-tab.active')))
      .toBe(true);
    expect(list.handleAction('down')).toBe(true);
    const group = container.querySelector<HTMLElement>('.group-item.active')!;
    expect(ringed(group)).toBe(true);
    expect(list.handleAction('right')).toBe(true);
    expect(ringed(channelItems()[0])).toBe(true);
    expect(list.handleAction('left')).toBe(true);
    expect(ringed(container.querySelector('.group-item.active')))
      .toBe(true);
  });

  it('hands Up from the first channel to the tab bar instead of jumping diagonally', () => {
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    list.render();

    expect(list.handleAction('up')).toBe(false);
    expect(ringed(channelItems()[0])).toBe(true);
  });

  it('moves horizontally within the source list without jumping regions', () => {
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group-position="0"]')!);
    list.handleAction('up');

    expect(list.handleAction('right')).toBe(true);
    expect(ringed(container.querySelector('[data-playlist="a"]')))
      .toBe(true);
    expect(list.handleAction('right')).toBe(true);
    expect(ringed(container.querySelector('[data-playlist="b"]')))
      .toBe(true);
    expect(list.handleAction('right')).toBe(true);
    expect(ringed(container.querySelector('[data-playlist="b"]')))
      .toBe(true);
  });

  it('reveals the active group when source selection follows a deep group scroll', () => {
    const originalGroups = playlistMock.getGroupsForPlaylist;
    playlistMock.playlistTabs = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    playlistMock.getGroupsForPlaylist = () =>
      Array.from({ length: 50 }, (_, index) => `Group ${String(index)}`);
    playlistMock.groupsRevision++;
    try {
      list.render();
      const groupList = container.querySelector<HTMLElement>('.group-list')!;
      groupList.scrollTop = 2000;
      list.render(false);
      expect(container.querySelector('[data-group-position="0"]')).toBeNull();

      hover(container.querySelector<HTMLElement>('[data-playlist="a"]')!);
      list.handleAction('select');
      expect(list.handleAction('down')).toBe(true);
      expect(ringed(container.querySelector('[data-group-position="0"]')))
        .toBe(true);
    } finally {
      playlistMock.getGroupsForPlaylist = originalGroups;
      playlistMock.groupsRevision++;
    }
  });

  it('does not rerender when the next virtual item is already mounted', () => {
    const render = vi.spyOn(list, 'render');

    expect(list.handleAction('down')).toBe(true);
    expect(render).not.toHaveBeenCalled();

    hover(container.querySelector<HTMLElement>('[data-group-position="0"]')!);
    expect(list.handleAction('down')).toBe(true);
    expect(render).not.toHaveBeenCalled();
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
    expect(onSelect).toHaveBeenCalledWith(
      1,
      undefined,
      { group: 'builtin:recently-watched', playlist: undefined },
      'expand-current',
    );
  });

  it('places recent live health before the Live badge', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[1],
      channelIndex: 1,
      updatedAt: 1000,
    }];
    healthMock.records[data.channels[1].url] = 'suspect';
    list.render();
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');

    const row = channelItems()[0];
    const dot = row.querySelector('.channel-health-dot');
    const badge = row.querySelector('.recent-kind-badge');
    expect(dot?.nextElementSibling).toBe(badge);
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
    expect(onSelect).toHaveBeenCalledWith(0, info, { group: 'builtin:recently-watched', playlist: undefined });
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
    expect(onSelect).toHaveBeenCalledWith(
      1,
      undefined,
      { group: 'builtin:all', playlist: undefined },
      'expand-current',
    );
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

  describe('while a reload brings the channels back', () => {
    const activeGroup = () => container.querySelector<HTMLElement>('.group-item.active')?.dataset.group;
    const reloadWithoutBravo = (): Channel[] => {
      playlistMock.complete = false;
      const removed = data.channels.splice(1, 1);
      playlistMock.groupsRevision++;
      list.render();
      return removed;
    };
    const arrive = (removed: Channel[]): void => {
      data.channels.splice(1, 0, ...removed);
      playlistMock.groupsRevision++;
      list.render();
    };

    beforeEach(() => {
      hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
      list.handleAction('select');
    });

    it('returns to the selected group once it arrives', () => {
      const removed = reloadWithoutBravo();
      expect(activeGroup()).toBe('builtin:all');
      arrive(removed);
      expect(activeGroup()).toBe('source:Sports');
      expect(channelItems().map(item => item.textContent)).toEqual([expect.stringContaining('Bravo')]);
    });

    it('keeps a group picked meanwhile over the one it waited for', () => {
      const removed = reloadWithoutBravo();
      hover(container.querySelector<HTMLElement>('[data-group="source:News"]')!);
      list.handleAction('select');
      arrive(removed);
      expect(activeGroup()).toBe('source:News');
    });

    it('forgets the group once the load ends without it', () => {
      const removed = reloadWithoutBravo();
      playlistMock.complete = true;
      list.render();
      arrive(removed);
      expect(activeGroup()).toBe('builtin:all');
    });
  });

  it('clears the focused channel when the cursor leaves the view', () => {
    hover(channelItems()[1]);
    expect(ringed(channelItems()[1])).toBe(true);
    channelItems()[1].dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    expect(ringed(channelItems()[1])).toBe(false);
  });

  it('relights the focused channel when the pointer returns to it', () => {
    hover(channelItems()[1]);
    channelItems()[1].dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    expect(ringed(channelItems()[1])).toBe(false);
    hover(channelItems()[1]);
    expect(ringed(channelItems()[1])).toBe(true);
    expect(list.focusScope.concealed).toBe(false);

    // Down goes on from the row just lit, not a row never visibly lit.
    list.handleAction('down');
    expect(ringed(channelItems()[2])).toBe(true);
    expect(ringed(channelItems()[1])).toBe(false);
  });

  it('green toggles the focused channel as a favorite', () => {
    expect(container.querySelector('.channel-hints')).toBeNull();
    hover(channelItems()[0]);
    list.handleAction('green');
    expect(storageMock.toggleFavorite).toHaveBeenCalledWith(channelKey(data.channels[0]));
  });

  it('a number action plays that channel (1-based)', () => {
    list.handleAction('number', { number: 2 });
    expect(onSelect).toHaveBeenCalledWith(
      1,
      undefined,
      { group: 'builtin:all', playlist: undefined },
      'fullscreen',
    );
  });

  it('a number action focuses and marks the channel it tuned', () => {
    list.handleAction('number', { number: 2 });
    expect(ringed(channelItems()[1])).toBe(true);
    expect(channelItems()[1].classList.contains('playing')).toBe(true);
  });

  it('widens a filtered group so the tuned channel is reachable on return', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1); // Bravo only

    list.handleAction('number', { number: 1 }); // Alpha, outside the Sports group

    expect(onSelect).toHaveBeenCalledWith(
      0,
      undefined,
      { group: 'builtin:all', playlist: undefined },
      'fullscreen',
    );
    expect(channelItems()).toHaveLength(3);
    expect(ringed(channelItems()[0])).toBe(true);
    expect(channelItems()[0].classList.contains('playing')).toBe(true);
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

  // A U+25B6 glyph here stalled the first layout after leaving the player
  // on a fallback-font lookup.
  it('draws the playing marker as an SVG, not a font glyph', () => {
    recentMock.items = [{
      kind: 'live',
      channel: data.channels[2],
      channelIndex: 2,
      updatedAt: 1000,
    }];
    list.setPlaying(2);
    list.render();
    const expectSvgMarker = (row: HTMLElement) => {
      const marker = row.querySelector('.playing-indicator')!;
      expect(marker.querySelector('svg.playing-indicator-icon')).not.toBeNull();
      expect(marker.textContent).toBe('');
    };
    expectSvgMarker(channelItems()[2]);
    hover(container.querySelector<HTMLElement>('[data-group="builtin:recently-watched"]')!);
    list.handleAction('select');
    expectSvgMarker(channelItems()[0]);
  });

  it('highlightEntryPoint focuses the first channel without taking the caret', () => {
    list.highlightEntryPoint();
    expect(ringed(channelItems()[0])).toBe(true);
  });

  // However the channel was tuned — a number typed in the player, ch+/-, the
  // sidebar — coming back to the list has to land on what is playing.
  it('highlightEntryPoint focuses the playing channel, not the first one', () => {
    list.setPlaying(2); // tuned elsewhere: the list never rendered a selection
    list.highlightEntryPoint();
    expect(ringed(channelItems()[2])).toBe(true);
    expect(ringed(channelItems()[0])).toBe(false);
  });

  // The Guide retuning the channel already playing tunes nothing new, so
  // Back resumes the row the list was left on.
  it('highlightEntryPoint resumes the row left after the playing channel is retuned', () => {
    list.render();
    hover(channelItems()[2]);
    list.handleAction('select');
    list.setPlaying(2);
    hover(channelItems()[0]);

    list.setPlaying(2);
    list.highlightEntryPoint(true);

    expect(ringed(channelItems()[0])).toBe(true);
    expect(ringed(channelItems()[2])).toBe(false);
  });

  it('highlightEntryPoint widens a filtered group to reach the playing channel', () => {
    hover(container.querySelector<HTMLElement>('[data-group="source:Sports"]')!);
    list.handleAction('select');
    expect(channelItems()).toHaveLength(1); // Bravo only

    list.setPlaying(0); // Alpha: playing, but outside the Sports filter
    list.highlightEntryPoint();

    expect(channelItems()).toHaveLength(3);
    expect(ringed(channelItems()[0])).toBe(true);
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
    const l = new ChannelList(c, { onChannelSelect: vi.fn() });
    const initialCount = spy.mock.calls.filter(([type]) => type === 'nav:hover').length;
    l.render();
    l.render();
    l.render();
    const finalCount = spy.mock.calls.filter(([type]) => type === 'nav:hover').length;
    expect(initialCount).toBeGreaterThan(0);
    expect(finalCount).toBe(initialCount);
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
    expect(ringed(channelItems()[1])).toBe(true);
    list.render();
    // The morph keeps the ring the scope painted, with no pass in between.
    expect(channelItems()[1].classList.contains('focused')).toBe(true);
    expect(ringed(channelItems()[1])).toBe(true);
  });
});

describe('ChannelList focus scope off the keys', () => {
  it('hands a preview\'s return to the scope as a key request', () => {
    list.render();
    hover(channelItems()[1]);
    const focus = vi.spyOn(list.focusScope, 'focus');
    list.setPreviewFocused(false);
    expect(focus).toHaveBeenLastCalledWith(channelItems()[1].dataset.key, 'key');
  });

  it('keeps the key it owns lit through a re-render, without asking to reveal it', () => {
    list.render();
    hover(channelItems()[1]);
    Focus.flush();
    const focus = vi.spyOn(list.focusScope, 'focus');
    const track = vi.spyOn(list.focusScope, 'track');
    list.render(false);
    expect(focus).toHaveBeenCalledWith(channelItems()[1].dataset.key, 'pointer');
    expect(track).not.toHaveBeenCalled();
    expect(ringed(channelItems()[1])).toBe(true);
  });
  function pushTabBar(): FocusScope {
    const bar = document.createElement('div');
    morph(bar, html`<div data-focusable data-key="t1"></div>`);
    document.body.appendChild(bar);
    const scope = Focus.register({ id: 'tabbar', root: bar, tier: Tier.bar, defaultKey: () => 't1' });
    Focus.push(scope);
    return scope;
  }

  it('keeps a concealed ring concealed through a background re-render', () => {
    list.render();
    const bar = pushTabBar();
    try {
      list.focusScope.conceal();
      const focus = vi.spyOn(list.focusScope, 'focus');
      list.render(false);
      Focus.flush();
      expect(focus).not.toHaveBeenCalled();
      expect(list.focusScope.concealed).toBe(true);
      expect(ringsIn(container)).toHaveLength(0);
    } finally {
      bar.dispose();
    }
  });

  it('still hands a hover to the scope as a pointer request', () => {
    list.render();
    const bar = pushTabBar();
    try {
      list.focusScope.conceal();
      const focus = vi.spyOn(list.focusScope, 'focus');
      const row = channelItems()[2];
      hover(row);
      expect(focus).toHaveBeenCalledWith(row.dataset.key, 'pointer');
      expect(list.focusScope.focusKey).toBe(row.dataset.key);
      expect(list.focusScope.concealed).toBe(false);
    } finally {
      bar.dispose();
    }
  });
});
