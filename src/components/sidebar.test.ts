// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Channel } from '../types';
import type { RecentlyWatchedItem } from '../services/recently-watched';
import { CONFIG } from '../config';

const { channels, favoriteIds, epgMock, recentMock, toastMock, healthMock, workerMock } = vi.hoisted(() => {
  function makeChannel(over: Partial<Channel>): Channel {
    return {
      id: '', name: '', logo: '', group: '', url: '', extras: null,
      playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
    };
  }
  return {
    channels: [
      makeChannel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['PL1'] }),
      makeChannel({ id: 'b', name: 'Bravo', group: 'News', playlistIds: ['PL1'] }),
      makeChannel({ id: 'c', name: 'Charlie', group: 'Sports', playlistIds: ['PL2'] }),
    ] as Channel[],
    // Favorites live in storage by channel key, not on the channel.
    favoriteIds: new Set(['b']),
    epgMock: {
      nowPlaying: null as { title: string } | null,
    },
    recentMock: {
      items: [] as RecentlyWatchedItem[],
      getItems: vi.fn(() => recentMock.items),
      catchupInfo: vi.fn(),
    },
    toastMock: vi.fn(),
    healthMock: {
      records: {} as Record<string, 'healthy' | 'suspect' | 'unavailable'>,
      getRecord: vi.fn((channel: Channel) => {
        const status = healthMock.records[channel.id];
        return status ? { status } : null;
      }),
    },
    workerMock: { failIndexes: false },
  };
});

vi.mock('../services/playlist-service', () => ({
  PlaylistService: {
    groupsRevision: 0,
    channels,
    playlistTabs: [{ id: 'PL1', name: 'PL1' }, { id: 'PL2', name: 'PL2' }],
    getByIndex: (i: number) => channels[i],
    indexOf: (channel: Channel) => channels.indexOf(channel),
    getGroupsForPlaylist: (playlist?: string) => {
      const source = playlist ? channels.filter(ch => ch.playlistIds.includes(playlist)) : channels;
      return Array.from(new Set(source.map(ch => ch.group)));
    },
    getByGroup: (group: string, playlist?: string) => {
      let source = playlist ? channels.filter(ch => ch.playlistIds.includes(playlist)) : channels;
      if (group === 'builtin:favorites') source = source.filter(ch => favoriteIds.has(ch.id));
      else if (group.startsWith('source:')) source = source.filter(ch => ch.group === group.slice(7));
      return source;
    },
    getGroupCount(group: string, playlist?: string) {
      return this.getByGroup(group, playlist).length;
    },
  },
}));

vi.mock('../services/epg-service', () => ({
  EpgService: {
    findChannelId: () => epgMock.nowPlaying ? 'epg' : null,
    getNowPlaying: () => epgMock.nowPlaying,
  },
}));

vi.mock('../services/recently-watched', () => ({ RecentlyWatchedService: recentMock }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));
vi.mock('./toast', () => ({ showToast: toastMock }));
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

import { Sidebar } from './sidebar';
import { groupIcon } from './group-icon';
import { setLocale } from '../i18n';
import { Focus, Tier } from '../navigation/focus-scope';
import { setInputMode } from '../navigation/input-mode';
import { PlaylistService } from '../services/playlist-service';
import { scopeId } from '../test/scope-id';

let container: HTMLElement;
let el: HTMLElement;
type SidebarArgs = ConstructorParameters<typeof Sidebar>;
let getCurrentIndex: Mock<SidebarArgs[1]>;
let getCurrentCatchupStart: Mock<NonNullable<SidebarArgs[3]>>;
let onSelect: Mock<SidebarArgs[2]>;
let sidebar: Sidebar;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout
  Element.prototype.scrollIntoView = vi.fn();

  container = document.createElement('div');
  el = document.createElement('div');
  el.id = 'player-sidebar';
  el.className = 'player-sidebar hidden';
  container.appendChild(el);
  document.body.appendChild(container);

  getCurrentIndex = vi.fn<SidebarArgs[1]>(() => 1);
  getCurrentCatchupStart = vi.fn<NonNullable<SidebarArgs[3]>>(() => null);
  onSelect = vi.fn<SidebarArgs[2]>();
  recentMock.items = [];
  recentMock.getItems.mockClear();
  recentMock.catchupInfo.mockReset();
  epgMock.nowPlaying = null;
  toastMock.mockClear();
  healthMock.records = {};
  workerMock.failIndexes = false;
  sidebar = new Sidebar(container, getCurrentIndex, onSelect, getCurrentCatchupStart);
  Focus.install();
});

afterEach(() => {
  Focus.uninstall();
  vi.useRealTimers();
  setInputMode('pointer');
  document.body.innerHTML = '';
});

function hover(target: Element): void {
  target.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
}

function ringed(): Element[] {
  Focus.flush();
  return Array.from(el.querySelectorAll('.focused'));
}

function items(): HTMLElement[] {
  Focus.flush();
  return Array.from(el.querySelectorAll<HTMLElement>('.sidebar-ch-item'));
}

function groupItems(): HTMLElement[] {
  Focus.flush();
  return Array.from(el.querySelectorAll<HTMLElement>('.sidebar-group-item'));
}

function finishOpening(): void {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  el.dispatchEvent(event);
}

function highlightSearch(): void {
  sidebar.handleAction('up');
  sidebar.handleAction('up');
  sidebar.handleAction('up');
}

describe('Sidebar', () => {
  describe('show / hide', () => {
    it('highlights the current channel on open', () => {
      sidebar.show();
      expect(sidebar.visible).toBe(true);
      expect(items()).toHaveLength(3);
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      expect(search.classList.contains('focused')).toBe(false);
      expect(items()[1].classList.contains('focused')).toBe(true);
      expect(document.activeElement).not.toBe(search);
      expect(el.classList.contains('hidden')).toBe(false);
      expect(el.classList.contains('visible')).toBe(true);
      expect(el.classList.contains('channels-only')).toBe(true);
    });

    it('shows channel health as a dot without consuming label space', () => {
      healthMock.records.b = 'suspect';

      sidebar.show();

      const dot = items()[1].querySelector('.channel-health-dot');
      expect(dot?.classList).toContain('suspect');
      expect(dot?.textContent).toBe('');
      expect(dot?.getAttribute('aria-label')).toBe('Suspect');
    });

    it('OK on the search box gives it the caret at the end', () => {
      const search = () => el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // OK on the search box
      search().value = 'char';
      search().dispatchEvent(new Event('input', { bubbles: true }));
      sidebar.hide();
      sidebar.show();
      expect(search().value).toBe('');
      highlightSearch();
      expect(document.activeElement).not.toBe(search());
      sidebar.handleAction('select');
      const s = search();
      expect(document.activeElement).toBe(s);
      expect(s.selectionStart).toBe(s.value.length);
      expect(items()).toHaveLength(3);
    });

    it('hide() removes the visible class and reports not visible', () => {
      sidebar.show();
      sidebar.hide();
      expect(sidebar.visible).toBe(false);
      expect(el.classList.contains('visible')).toBe(false);
    });

    it('adds the hidden class once the slide-out ends', () => {
      sidebar.show();
      sidebar.hide();
      expect(el.classList.contains('hidden')).toBe(false);
      el.dispatchEvent(new Event('transitionend'));
      expect(el.classList.contains('hidden')).toBe(true);
    });

    // Chromium 53 predates `once`: it ignores `once` in an options object
    // and keeps the listener attached after it fires.
    it('keeps no hide listener behind on an engine without `once`', () => {
      const attached = new Set<EventListenerOrEventListenerObject>();
      const add = el.addEventListener.bind(el);
      const remove = el.removeEventListener.bind(el);
      el.addEventListener = (type: string, fn: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions) => {
        if (type === 'transitionend') attached.add(fn);
        add(type, fn, typeof options === 'object' ? !!options.capture : options);
      };
      el.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions) => {
        if (type === 'transitionend') attached.delete(fn);
        remove(type, fn, options);
      };
      const before = attached.size;
      for (let i = 0; i < 3; i++) {
        sidebar.show();
        sidebar.hide();
        el.dispatchEvent(new Event('transitionend'));
      }
      sidebar.show();
      sidebar.hide();
      sidebar.show();
      expect(attached.size).toBe(before);
    });


    it('show() is idempotent', () => {
      sidebar.show();
      const first = items()[1];
      sidebar.show();
      expect(items()[1]).toBe(first);
    });

    it('rebuilds cached builtin group labels after a language change', () => {
      sidebar.show();
      sidebar.handleAction('left');
      expect(groupItems()[2].querySelector('.sidebar-group-name')?.textContent)
        .toBe('Recently Watched');
      sidebar.hide();

      setLocale('zh-CN');
      sidebar.show();
      sidebar.handleAction('left');

      expect(groupItems()[2].querySelector('.sidebar-group-name')?.textContent)
        .toBe('最近观看');
    });

    it('keeps logos blank until decoded and reveals one per frame', async () => {
      channels[0].logo = 'http://host/a.png';
      channels[1].logo = 'http://host/b.png';
      try {
        const target = sidebar as unknown as { preloadLogo(src: string): Promise<boolean> };
        vi.spyOn(target, 'preloadLogo').mockResolvedValue(true);

        sidebar.show();
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(0);
        expect(el.querySelectorAll('.ch-logo-wrap[data-logo-src]')).toHaveLength(2);

        finishOpening();
        await Promise.resolve();
        await Promise.resolve();
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(0);

        vi.advanceTimersByTime(20);
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(1);
        vi.advanceTimersByTime(20);
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(2);
      } finally {
        channels[0].logo = '';
        channels[1].logo = '';
      }
    });

    it('blanks decoded logos before reopening and restores one per frame', async () => {
      channels[0].logo = 'http://host/a.png';
      channels[1].logo = 'http://host/b.png';
      try {
        const target = sidebar as unknown as { preloadLogo(src: string): Promise<boolean> };
        const preload = vi.spyOn(target, 'preloadLogo').mockResolvedValue(true);

        sidebar.show();
        finishOpening();
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(40);
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(2);

        sidebar.hide();
        preload.mockClear();
        sidebar.show();
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(0);
        expect(el.querySelectorAll('.ch-logo-wrap[data-logo-src]')).toHaveLength(2);

        finishOpening();
        await Promise.resolve();
        await Promise.resolve();
        expect(preload).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(20);
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(1);
        vi.advanceTimersByTime(20);
        expect(el.querySelectorAll('.ch-logo[src]')).toHaveLength(2);
      } finally {
        channels[0].logo = '';
        channels[1].logo = '';
      }
    });

    it('removes a failed channel logo and does not restore it on later renders', async () => {
      channels[0].logo = 'http://host/broken.png';
      try {
        const target = sidebar as unknown as { preloadLogo(src: string): Promise<boolean> };
        vi.spyOn(target, 'preloadLogo').mockResolvedValue(false);
        sidebar.show();
        expect(items()[0].querySelector('.ch-logo-wrap[data-logo-src]')).not.toBeNull();

        finishOpening();
        await Promise.resolve();
        await Promise.resolve();
        expect(items()[0].querySelector('.ch-logo')).toBeNull();
        expect(items()[0].querySelector('.ch-logo-placeholder')).toBeNull();
        expect(items()[0].querySelector('.ch-logo-wrap')).not.toBeNull();

        sidebar.refresh();
        expect(items()[0].querySelector('.ch-logo')).toBeNull();
        expect(items()[0].querySelector('.ch-logo-wrap')).not.toBeNull();
      } finally {
        channels[0].logo = '';
      }
    });

    it('renders channel rows while hidden before starting the slide transition', () => {
      const target = sidebar as unknown as { render(): void };
      const render = target.render.bind(sidebar);
      let visibleDuringRender = false;
      let hiddenDuringRender = false;
      vi.spyOn(target, 'render').mockImplementation(() => {
        visibleDuringRender = el.classList.contains('visible');
        hiddenDuringRender = el.classList.contains('hidden');
        render();
      });

      sidebar.show();

      expect(visibleDuringRender).toBe(false);
      expect(hiddenDuringRender).toBe(true);
    });
  });

  describe('handleAction', () => {
    beforeEach(() => sidebar.show());

    it('starts on the current channel', () => {
      expect(items()[1].classList.contains('focused')).toBe(true);
    });

    it('down then up moves the focus highlight', () => {
      sidebar.handleAction('down'); // 1 -> 2
      expect(items()[2].classList.contains('focused')).toBe(true);
      sidebar.handleAction('up'); // 2 -> 1
      expect(items()[1].classList.contains('focused')).toBe(true);
    });

    it('does not resolve every channel index during navigation', () => {
      const indexOf = vi.spyOn(PlaylistService, 'indexOf');
      indexOf.mockClear();

      sidebar.handleAction('down');
      expect(indexOf).not.toHaveBeenCalled();

      sidebar.handleAction('select');
      expect(indexOf).toHaveBeenCalledTimes(1);
    });

    it('channel_up / channel_down behave like up / down', () => {
      sidebar.handleAction('channel_down'); // 1 -> 2
      expect(items()[2].classList.contains('focused')).toBe(true);
      sidebar.handleAction('channel_up'); // 2 -> 1
      expect(items()[1].classList.contains('focused')).toBe(true);
    });

    it('clamps at the bottom end', () => {
      sidebar.handleAction('down'); // 1 -> 2 (last)
      sidebar.handleAction('down'); // stays 2
      expect(items()[2].classList.contains('focused')).toBe(true);
    });

    it('up from the top channel highlights the search box (no caret)', () => {
      const tabs = PlaylistService.playlistTabs.slice();
      PlaylistService.playlistTabs.splice(1);
      try {
        sidebar.refresh();
        const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
        sidebar.handleAction('up'); // 1 -> 0
        sidebar.handleAction('up'); // from 0 -> search box
        expect(items().some(i => i.classList.contains('focused'))).toBe(false);
        expect(search.classList.contains('focused')).toBe(true);
        expect(document.activeElement).not.toBe(search);
      } finally {
        PlaylistService.playlistTabs.splice(0, PlaylistService.playlistTabs.length, ...tabs);
      }
    });

    it('moves through search, sources, and channels in visual order', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      sidebar.handleAction('up'); // 1 -> 0
      sidebar.handleAction('up'); // from 0 -> active source
      expect(items().some(i => i.classList.contains('focused'))).toBe(false);
      expect(el.querySelector('[data-sidebar-playlist=""]')?.classList.contains('focused'))
        .toBe(true);
      sidebar.handleAction('up'); // source -> search
      expect(search.classList.contains('focused')).toBe(true);
      expect(document.activeElement).not.toBe(search);
      sidebar.handleAction('down'); // search -> active source
      expect(el.querySelector('[data-sidebar-playlist=""]')?.classList.contains('focused'))
        .toBe(true);
      sidebar.handleAction('down'); // source -> first channel
      expect(items()[0].classList.contains('focused')).toBe(true);
    });

    it('uses left and right to focus and select a source', () => {
      sidebar.handleAction('up'); // 1 -> 0
      sidebar.handleAction('up'); // 0 -> All source
      sidebar.handleAction('right'); // All -> PL1
      expect(el.querySelector('[data-sidebar-playlist="PL1"]')?.classList.contains('focused'))
        .toBe(true);
      sidebar.handleAction('select');
      expect(el.querySelector('[data-sidebar-playlist="PL1"]')?.classList.contains('active'))
        .toBe(true);
      expect(items()).toHaveLength(2);
      expect(items()[1].classList.contains('focused')).toBe(true);
    });

    it('opens groups when moving left past the first source', () => {
      sidebar.handleAction('up'); // 1 -> 0
      sidebar.handleAction('up'); // 0 -> All source
      sidebar.handleAction('right'); // All -> PL1
      sidebar.handleAction('left'); // PL1 -> All

      expect(el.querySelector('[data-sidebar-playlist=""]')?.classList.contains('focused'))
        .toBe(true);

      sidebar.handleAction('left'); // All -> Groups

      expect(el.classList.contains('groups-expanded')).toBe(true);
      expect(groupItems()[0].classList.contains('focused')).toBe(true);
      expect(groupItems()[0].dataset.groupId).toBe('builtin:all');
    });

    it('resets expanded group focus to All after selecting a source', () => {
      sidebar.handleAction('left');
      for (let i = 0; i < 4; i++) sidebar.handleAction('down');
      sidebar.handleAction('select');
      sidebar.handleAction('up');
      sidebar.handleAction('right');
      sidebar.handleAction('select');
      sidebar.handleAction('left');

      expect(groupItems()[0].classList.contains('focused')).toBe(true);
      expect(groupItems()[0].dataset.groupId).toBe('builtin:all');
    });

    it('scrolls only channel names that overflow', () => {
      sidebar.show();
      const names = el.querySelectorAll<HTMLElement>('.ch-name');
      const texts = el.querySelectorAll<HTMLElement>('.ch-name-text');
      Object.defineProperty(names[0], 'offsetWidth', { value: 100, configurable: true });
      Object.defineProperty(texts[0], 'offsetWidth', { value: 160, configurable: true });
      Object.defineProperty(names[1], 'offsetWidth', { value: 100 });
      Object.defineProperty(texts[1], 'offsetWidth', { value: 100 });

      (sidebar as unknown as { measureMarquees: () => void }).measureMarquees();
      vi.advanceTimersByTime(20);

      expect(texts[0].classList.contains('scrolling')).toBe(true);
      expect(texts[0].style.getPropertyValue('--scroll-dist')).toBe('-60px');
      expect(texts[1].classList.contains('scrolling')).toBe(false);
      expect(texts[1].style.getPropertyValue('--scroll-dist')).toBe('');

      Object.defineProperty(texts[0], 'offsetWidth', { value: 100 });
      (sidebar as unknown as { measureMarquees: () => void }).measureMarquees();
      vi.advanceTimersByTime(20);

      expect(texts[0].classList.contains('scrolling')).toBe(false);
      expect(texts[0].style.getPropertyValue('--scroll-dist')).toBe('');
    });

    it('keeps the existing program-name marquee behavior', () => {
      epgMock.nowPlaying = { title: 'Program Alpha' };
      sidebar.refresh();
      const container = el.querySelector<HTMLElement>('.ch-now')!;
      const text = container.querySelector<HTMLElement>('.ch-now-text')!;
      Object.defineProperty(container, 'offsetWidth', { value: 100 });
      Object.defineProperty(text, 'offsetWidth', { value: 160 });

      (sidebar as unknown as { measureMarquees: () => void }).measureMarquees();
      vi.advanceTimersByTime(20);

      expect(text.classList.contains('scrolling')).toBe(true);
      expect(text.style.getPropertyValue('--scroll-dist')).toBe('-60px');
    });

    it('typing in the search box filters channels across playlists', async () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'char';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      const names = items().map(i => i.querySelector('.ch-name')?.textContent);
      expect(names).toEqual(['Charlie']);
    });

    it('Enter in the search box drops focus onto the first result', async () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'a';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(items().length).toBeGreaterThan(0));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(items()[0].classList.contains('focused')).toBe(true);
    });

    it('select fires onSelectChannel with the global index and hides', () => {
      sidebar.handleAction('down'); // 1 -> 2 (global 2)
      sidebar.handleAction('select');
      expect(onSelect).toHaveBeenCalledWith(2, undefined, { group: 'builtin:all', playlist: undefined });
      expect(sidebar.visible).toBe(false);
    });
  });

  describe('group panel', () => {
    beforeEach(() => sidebar.show());

    it('expands on Left and focuses the selected group', () => {
      sidebar.handleAction('left');

      expect(el.classList.contains('groups-expanded')).toBe(true);
      expect(groupItems()).toHaveLength(5);
      expect(groupItems()[0].classList.contains('active')).toBe(true);
      expect(groupItems()[0].classList.contains('focused')).toBe(true);
      expect(sidebar.pointerDismissX).toBe(740);
    });

    it('settles group icons with the playlist language', () => {
      const originalGroups = PlaylistService.getGroupsForPlaylist;
      PlaylistService.getGroupsForPlaylist = () => ['Telenovelas', 'Teletienda', 'Cine Gaming'];
      PlaylistService.groupsRevision++;
      try {
        sidebar.refresh();
        sidebar.handleAction('left');
        const item = groupItems().find(g => g.textContent?.indexOf('Cine Gaming') !== -1);
        const icon = item?.querySelector('.sidebar-group-icon')?.innerHTML;
        expect(icon).toBe(groupIcon('Cine Gaming', undefined, 'es'));
        expect(icon).not.toBe(groupIcon('Cine Gaming'));
      } finally {
        PlaylistService.getGroupsForPlaylist = originalGroups;
        PlaylistService.groupsRevision++;
      }
    });

    it('renders a bounded group window for 50,000 groups', () => {
      const originalGroups = PlaylistService.getGroupsForPlaylist;
      const originalCount = PlaylistService.getGroupCount;
      PlaylistService.getGroupsForPlaylist = () =>
        Array.from({ length: 50_000 }, (_, index) => `Group ${String(index)}`);
      PlaylistService.getGroupCount = () => 1;
      PlaylistService.groupsRevision++;
      try {
        sidebar.refresh();
        sidebar.handleAction('left');
        expect(groupItems().length).toBeLessThan(60);
        expect(el.querySelector<HTMLElement>('.sidebar-group-spacer')?.style.height)
          .toBe('3200192px');
      } finally {
        PlaylistService.getGroupsForPlaylist = originalGroups;
        PlaylistService.getGroupCount = originalCount;
        PlaylistService.groupsRevision++;
      }
    });

    it('resumes group focus in view after the focused group scrolled away', () => {
      const logs = vi.spyOn(console, 'log');
      const originalGroups = PlaylistService.getGroupsForPlaylist;
      const originalCount = PlaylistService.getGroupCount;
      PlaylistService.getGroupsForPlaylist = () =>
        Array.from({ length: 500 }, (_, index) => `Group ${String(index)}`);
      PlaylistService.getGroupCount = () => 1;
      PlaylistService.groupsRevision++;
      try {
        sidebar.refresh();
        sidebar.handleAction('left');
        const list = el.querySelector<HTMLElement>('.sidebar-group-list')!;
        Object.defineProperty(list, 'clientHeight', { value: 640, configurable: true });
        list.scrollTop = 6400;
        list.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(20);
        expect(list.scrollTop).toBe(6400);

        sidebar.handleAction('up');

        expect(list.scrollTop).toBe(6400);
        expect(el.querySelector<HTMLElement>('.sidebar-group-item.focused')?.dataset.groupPos)
          .toBe('100');
        const lines = logs.mock.calls.map(args => args.join(' '))
          .filter(line => line.includes('event=nav.focus.repaired reason=detached '));
        expect(lines).toEqual([expect.stringMatching(/scope=player.sidebar distance=100$/)]);
      } finally {
        PlaylistService.getGroupsForPlaylist = originalGroups;
        PlaylistService.getGroupCount = originalCount;
        PlaylistService.groupsRevision++;
      }
    });

    describe('with many groups', () => {
      let originalGroups: typeof PlaylistService.getGroupsForPlaylist;
      let originalCount: typeof PlaylistService.getGroupCount;

      beforeEach(() => {
        originalGroups = PlaylistService.getGroupsForPlaylist;
        originalCount = PlaylistService.getGroupCount;
        PlaylistService.getGroupsForPlaylist = () =>
          Array.from({ length: 500 }, (_, index) => `Group ${String(index)}`);
        PlaylistService.getGroupCount = () => 1;
        PlaylistService.groupsRevision++;
        sidebar.refresh();
        sidebar.handleAction('left');
      });

      afterEach(() => {
        PlaylistService.getGroupsForPlaylist = originalGroups;
        PlaylistService.getGroupCount = originalCount;
        PlaylistService.groupsRevision++;
      });

      function scrollGroups(scrollTop: number): HTMLElement {
        const list = el.querySelector<HTMLElement>('.sidebar-group-list')!;
        Object.defineProperty(list, 'clientHeight', { value: 640, configurable: true });
        list.scrollTop = scrollTop;
        list.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(20);
        return list;
      }

      it('a logo error render keeps the scrolled group list in place', () => {
        const list = scrollGroups(6400);
        const logo = document.createElement('img');
        logo.className = 'ch-logo';
        logo.setAttribute('src', 'http://host/a.png');
        el.querySelector('.sidebar-ch-item')!.appendChild(logo);
        logo.dispatchEvent(new Event('error'));

        expect(list.scrollTop).toBe(6400);
        expect(groupItems().some(item => item.dataset.groupPos === '100')).toBe(true);
      });

      it('a refresh keeps the scrolled group list in place', () => {
        const list = scrollGroups(6400);
        sidebar.refresh();

        expect(list.scrollTop).toBe(6400);
        expect(groupItems().some(item => item.dataset.groupPos === '100')).toBe(true);
      });

      it('opening groups scrolls a far-down current group into view', () => {
        scrollGroups(400 * 64);
        groupItems().find(item => item.dataset.groupPos === '403')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(el.querySelector('.sidebar-channel-title')?.textContent?.trim())
          .toBe('Group 400');
        sidebar.handleAction('right');
        expect(el.classList.contains('channels-only')).toBe(true);
        const list = scrollGroups(0);

        sidebar.handleAction('left');

        const focused = el.querySelector<HTMLElement>('.sidebar-group-item.focused');
        expect(focused?.dataset.groupPos).toBe('403');
        expect(focused?.classList.contains('active')).toBe(true);
        // Centered in the 640px viewport: 403 * 64 - (640 - 64) / 2.
        expect(list.scrollTop).toBe(403 * 64 - 288);
      });
    });

    it('uses the fitted group width for the pointer dismissal boundary', () => {
      sidebar.handleAction('left');
      el.querySelector<HTMLElement>('.sidebar-group-panel')!.getBoundingClientRect = () => ({
        x: 0, y: 0, top: 0, right: 360, bottom: 1080, left: 0,
        width: 360, height: 1080, toJSON: () => ({}),
      });

      expect(sidebar.pointerDismissX).toBe(820);
    });

    it('caches the width probe until the group source changes', () => {
      const target = sidebar as unknown as {
        groupWidthScore: (group: { label: string; count: number }) => number;
      };
      const score = vi.spyOn(target, 'groupWidthScore');

      PlaylistService.groupsRevision++;
      sidebar.refresh();
      const initialCalls = score.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      sidebar.handleAction('left');
      sidebar.handleAction('right');
      sidebar.handleAction('left');
      expect(score).toHaveBeenCalledTimes(initialCalls);

      PlaylistService.groupsRevision++;
      sidebar.refresh();
      expect(score.mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it('selects a group, filters channels, and returns focus to channels', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('select');

      expect(items().map(item => item.querySelector('.ch-name')?.textContent)).toEqual(['Charlie']);
      expect(el.querySelector('.sidebar-channel-title')?.textContent?.trim()).toBe('Sports');
      expect(items()[0].classList.contains('focused')).toBe(true);
      expect(el.classList.contains('groups-expanded')).toBe(true);
    });

    it('keeps channel marquees through a delayed scroll render', () => {
      recentMock.items = [{
        kind: 'live',
        channel: channels[0],
        channelIndex: 0,
        updatedAt: 1000,
      }];

      sidebar.handleAction('left');
      sidebar.handleAction('select'); // All
      sidebar.handleAction('left');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('select'); // Recently Watched

      const name = el.querySelector<HTMLElement>('.ch-name')!;
      const text = name.querySelector<HTMLElement>('.ch-name-text')!;
      Object.defineProperty(name, 'offsetWidth', { value: 100 });
      Object.defineProperty(text, 'offsetWidth', { value: 160 });
      const target = sidebar as unknown as { measureMarquees: () => void };
      const measure = vi.spyOn(target, 'measureMarquees');

      vi.advanceTimersByTime(20);
      expect(measure).not.toHaveBeenCalled();
      expect(text.classList.contains('scrolling')).toBe(false);

      finishOpening();
      vi.advanceTimersByTime(20);

      expect(measure).toHaveBeenCalledTimes(1);
      expect(text.classList.contains('scrolling')).toBe(true);
      expect(text.style.getPropertyValue('--scroll-dist')).toBe('-60px');

      measure.mockClear();
      el.querySelector<HTMLElement>('.sidebar-channel-list')!
        .dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);

      expect(text.classList.contains('scrolling')).toBe(true);
      expect(text.style.getPropertyValue('--scroll-dist')).toBe('-60px');
      expect(measure).not.toHaveBeenCalled();
    });

    it('Left from expanded channels returns focus to the active group', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('select'); // All, focus moves to channels
      sidebar.handleAction('left');

      expect(groupItems()[0].classList.contains('focused')).toBe(true);
      expect(items().some(item => item.classList.contains('focused'))).toBe(false);
    });

    it('Right and Back collapse groups before closing the channel panel', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('right');
      expect(sidebar.visible).toBe(true);
      expect(el.classList.contains('channels-only')).toBe(true);

      sidebar.handleAction('left');
      expect(sidebar.handleBack()).toBe(true);
      expect(sidebar.visible).toBe(true);
      expect(sidebar.handleBack()).toBe(false);
    });

    it('falls back to All on reopen when the current channel is outside the retained group', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('select'); // Sports
      sidebar.hide();
      sidebar.show(); // current channel is Bravo in News

      expect(items()).toHaveLength(3);
      expect(el.querySelector('.sidebar-channel-title')?.textContent?.trim()).toBe('All');
      expect(items()[1].classList.contains('focused')).toBe(true);
    });

    it('drops playlist scope on reopen when it excludes the current channel', () => {
      el.querySelector<HTMLElement>('[data-sidebar-playlist="PL1"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      sidebar.hide();
      getCurrentIndex.mockReturnValue(2);
      sidebar.show();

      expect(items()).toHaveLength(3);
      expect(el.querySelector('[data-sidebar-playlist=""]')?.classList.contains('active')).toBe(true);
      expect(items()[2].classList.contains('focused')).toBe(true);
    });

    it('updates Favorites count when reopened after membership changes', () => {
      sidebar.show();
      sidebar.handleAction('left');
      expect(groupItems()[1].querySelector('.sidebar-group-count')?.textContent).toBe('1');

      sidebar.hide();
      favoriteIds.add('a');
      sidebar.show();
      sidebar.handleAction('left');

      expect(groupItems()[1].querySelector('.sidebar-group-count')?.textContent).toBe('2');
      favoriteIds.delete('a');
    });

    it('updates Recently Watched count when reopened after history changes', () => {
      sidebar.show();
      sidebar.handleAction('left');
      expect(groupItems()[2].querySelector('.sidebar-group-count')?.textContent).toBe('0');

      sidebar.hide();
      recentMock.items = [{
        kind: 'live',
        channel: channels[2],
        channelIndex: 2,
        updatedAt: 1000,
      }];
      sidebar.show();
      sidebar.handleAction('left');

      expect(groupItems()[2].querySelector('.sidebar-group-count')?.textContent).toBe('1');
    });

    it('refreshes a visible Favorites group after its membership changes', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('down');
      sidebar.handleAction('select');
      expect(items().map(item => item.querySelector('.ch-name')?.textContent)).toEqual(['Bravo']);

      favoriteIds.delete('b');
      sidebar.refresh();
      expect(items()).toHaveLength(0);
      favoriteIds.add('b');
    });

    it('retains the selected group after tuning within it', () => {
      sidebar.handleAction('left');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('down');
      sidebar.handleAction('select'); // Sports
      items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      getCurrentIndex.mockReturnValue(2);
      sidebar.show();

      expect(items()).toHaveLength(1);
      expect(el.querySelector('.sidebar-channel-title')?.textContent?.trim()).toBe('Sports');
      expect(items()[0].classList.contains('focused')).toBe(true);
    });

    it('toggles groups from the channel title and selects a group by pointer', () => {
      const picker = el.querySelector<HTMLElement>('[data-open-groups]')!;
      expect(picker.querySelector('.sidebar-picker-arrow svg')).not.toBeNull();
      picker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.classList.contains('groups-expanded')).toBe(true);

      picker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.classList.contains('channels-only')).toBe(true);

      picker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      groupItems()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(items().map(item => item.querySelector('.ch-name')?.textContent))
        .toEqual(['Alpha', 'Bravo']);
    });

    it('shows Recently Watched and selects a recent live channel', () => {
      recentMock.items = [{
        kind: 'live',
        channel: channels[2],
        channelIndex: 2,
        updatedAt: 1000,
      }];
      sidebar.refresh();
      sidebar.handleAction('left');

      expect(groupItems()[2].querySelector('.sidebar-group-count')?.textContent).toBe('1');
      groupItems()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(items().map(item => item.querySelector('.ch-name')?.textContent)).toEqual(['Charlie']);

      items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).toHaveBeenCalledWith(2, undefined, {
        group: 'builtin:recently-watched',
        playlist: undefined,
      });
    });

    it('resumes a recent catch-up program', async () => {
      const recent: RecentlyWatchedItem = {
        kind: 'catchup',
        channel: channels[0],
        channelIndex: 0,
        updatedAt: 1000,
        progress: {
          channelKey: 'a',
          progStart: 1000,
          progEnd: 61000,
          position: 30,
          duration: 60,
          updatedAt: 1000,
          title: 'Program Alpha',
          completed: false,
        },
      };
      const catchup = {
        start: 1,
        end: 61,
        title: 'Program Alpha',
        description: '',
        icon: '',
        resumeSecs: 30,
      };
      recentMock.items = [recent];
      recentMock.catchupInfo.mockResolvedValue(catchup);
      sidebar.refresh();
      sidebar.handleAction('left');
      groupItems()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(items()[0].querySelector('.ch-name')?.textContent).toBe('Program Alpha');
      items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();

      expect(onSelect).toHaveBeenCalledWith(0, catchup, {
        group: 'builtin:recently-watched',
        playlist: undefined,
      });
      expect(sidebar.visible).toBe(false);
    });

    it('does not show live health on a recent Catch-up row', () => {
      recentMock.items = [{
        kind: 'catchup',
        channel: channels[0],
        channelIndex: 0,
        updatedAt: 1000,
        progress: {
          channelKey: 'a',
          progStart: 1000,
          progEnd: 61000,
          position: 30,
          duration: 60,
          updatedAt: 1000,
          title: 'Program Alpha',
          completed: false,
        },
      }];
      healthMock.records.a = 'healthy';
      sidebar.refresh();
      sidebar.handleAction('left');
      groupItems()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const row = items()[0];
      expect(row.querySelector('.sidebar-recent-kind')).not.toBeNull();
      expect(row.querySelector('.channel-health-dot')).toBeNull();
    });

    it('marks only the exact recent playback as playing', () => {
      getCurrentCatchupStart.mockReturnValue(2000);
      recentMock.items = [
        {
          kind: 'catchup',
          channel: channels[1],
          channelIndex: 1,
          updatedAt: 3000,
          progress: {
            channelKey: 'b',
            progStart: 1000,
            progEnd: 61000,
            position: 30,
            duration: 60,
            updatedAt: 3000,
            completed: false,
          },
        },
        {
          kind: 'catchup',
          channel: channels[1],
          channelIndex: 1,
          updatedAt: 3000,
          progress: {
            channelKey: 'b',
            progStart: 2000,
            progEnd: 62000,
            position: 30,
            duration: 60,
            updatedAt: 3000,
            completed: false,
          },
        },
        {
          kind: 'live',
          channel: channels[1],
          channelIndex: 1,
          updatedAt: 3000,
        },
      ];
      sidebar.refresh();
      sidebar.handleAction('left');
      groupItems()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(items().map(item => item.classList.contains('playing')))
        .toEqual([false, true, false]);
    });
  });

  // Regression guard: the global key handler routes the remote Back key through
  // even from inputs, so the search box must stop propagation on the keys it
  // owns. Otherwise Back would both exit the search box (here) and bubble up to
  // the global handler, closing the whole sidebar / acting on the player.
  describe('search box key propagation', () => {
    function pressInSearch(init: KeyboardEventInit): ReturnType<typeof vi.fn> {
      sidebar.show();
      const globalSpy = vi.fn();
      document.addEventListener('keydown', globalSpy);
      el.querySelector<HTMLInputElement>('.sidebar-search-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
      document.removeEventListener('keydown', globalSpy);
      return globalSpy;
    }

    it.each([
      ['Back', { keyCode: CONFIG.KEYS.BACK }],
      ['Escape', { key: 'Escape' }],
      ['Enter', { key: 'Enter' }],
      ['ArrowDown', { key: 'ArrowDown' }],
    ] as [string, KeyboardEventInit][])('stops %s from reaching the global handler', (_name, init) => {
      expect(pressInSearch(init)).not.toHaveBeenCalled();
    });

    it('lets an unhandled key (typing) reach the global handler', () => {
      expect(pressInSearch({ key: 'a' })).toHaveBeenCalledTimes(1);
    });

    it('leaves no reveal waiting when the caret leaves while another scope owns the keys', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select');
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      expect(document.activeElement).toBe(search);
      // The pointer notes a row while the box has the caret; then the keys
      // take over and a prompt opens above.
      hover(items()[1]);
      setInputMode('keys');
      const prompt = document.createElement('div');
      document.body.appendChild(prompt);
      const above = Focus.register({ id: scopeId('test.prompt'), root: prompt, tier: Tier.prompt });
      Focus.push(above);
      Focus.flush();
      const reveal = vi.spyOn(sidebar as unknown as { reveal(key: string): boolean }, 'reveal');

      search.blur();
      Focus.pop(above);
      Focus.flush();

      expect(sidebar.visible).toBe(true);
      expect(reveal).not.toHaveBeenCalled();
      expect(ringed()).toEqual([items()[1]]);
    });
  });

  describe('pointer interaction', () => {
    beforeEach(() => sidebar.show());

    it('starts the group dwell after the channel panel finishes opening', () => {
      sidebar.handlePointerMove(30, true);
      vi.advanceTimersByTime(1000);
      expect(el.classList.contains('groups-expanded')).toBe(false);

      finishOpening();
      vi.advanceTimersByTime(499);
      expect(el.classList.contains('groups-expanded')).toBe(false);

      vi.advanceTimersByTime(1);
      expect(el.classList.contains('groups-expanded')).toBe(true);
    });

    it('leaves the tab row edge to edge scrolling instead of opening groups', () => {
      sidebar.handlePointerMove(30, true, true);
      finishOpening();
      vi.advanceTimersByTime(1000);
      expect(el.classList.contains('groups-expanded')).toBe(false);

      sidebar.handlePointerMove(30, true);
      vi.advanceTimersByTime(500);
      expect(el.classList.contains('groups-expanded')).toBe(true);
    });

    it('cancels group expansion when the pointer leaves the edge', () => {
      sidebar.handlePointerMove(30, true);
      finishOpening();
      vi.advanceTimersByTime(200);
      sidebar.handlePointerMove(100, true);
      vi.advanceTimersByTime(500);

      expect(el.classList.contains('groups-expanded')).toBe(false);
    });

    it('collapses groups before closing after an outside dwell', () => {
      sidebar.handleAction('left');
      expect(sidebar.handlePointerMove(741, false)).toBe(true);
      expect(el.classList.contains('channels-only')).toBe(true);
      expect(sidebar.visible).toBe(true);

      vi.advanceTimersByTime(499);
      expect(sidebar.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sidebar.visible).toBe(false);
    });

    it('keeps the ring hidden and the list still while the pointer exit closes the groups', () => {
      sidebar.handleAction('left');
      hover(groupItems()[1]);
      groupItems()[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
      expect(ringed()).toEqual([]);
      const reveal = vi.mocked(Element.prototype.scrollIntoView);
      reveal.mockClear();
      sidebar.handlePointerMove(741, false);
      expect(el.classList.contains('channels-only')).toBe(true);
      expect(ringed()).toEqual([]);
      expect(reveal).not.toHaveBeenCalled();
    });

    it('keeps the ring hidden when the pointer exit closes the groups without a mouseout', () => {
      sidebar.handleAction('left');
      hover(groupItems()[1]);
      sidebar.handlePointerMove(741, false);
      expect(el.classList.contains('channels-only')).toBe(true);
      expect(ringed()).toEqual([]);
    });

    it('Back still closes the groups onto a lit channel', () => {
      sidebar.handleAction('left');
      groupItems()[1].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
      sidebar.handleBack();
      const lit = ringed();
      expect(lit).toHaveLength(1);
      expect(items()).toContain(lit[0]);
    });

    it('cancels the pending close when the pointer returns to channels', () => {
      sidebar.handleAction('left');
      sidebar.handlePointerMove(741, false);
      vi.advanceTimersByTime(250);
      expect(sidebar.handlePointerMove(300, false)).toBe(true);
      vi.advanceTimersByTime(500);

      expect(sidebar.visible).toBe(true);
      expect(el.classList.contains('channels-only')).toBe(true);
    });

    it('clicking a channel item selects it', () => {
      items()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).toHaveBeenCalledWith(2, undefined, { group: 'builtin:all', playlist: undefined });
    });

    it('clicking a playlist tab filters the list and resets focus', () => {
      const tab = el.querySelector<HTMLElement>('[data-sidebar-playlist="PL2"]')!;
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Only Charlie belongs to PL2, retaining its global index of 2
      expect(items()).toHaveLength(1);
      expect(items()[0].dataset.sidebarIndex).toBe('2');
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('hovering an item moves the focus highlight', () => {
      hover(items()[2]);
      expect(ringed()).toEqual([items()[2]]);
    });

    it('hovering up onto the search box highlights it and clears the channel', () => {
      hover(items()[1]);
      expect(ringed()).toEqual([items()[1]]);
      const search = el.querySelector<HTMLElement>('.sidebar-search-input')!;
      hover(search);
      expect(ringed()).toEqual([search]);
    });

    it('lights the search box under the pointer while it has the caret', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.focus();
      expect(ringed()).toEqual([]);
      hover(items()[2]);
      expect(ringed()).toEqual([]);
      hover(search);
      expect(ringed()).toEqual([search]);
      hover(items()[2]);
      expect(ringed()).toEqual([]);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(ringed()).toEqual([items()[0]]);
    });

    it('lights the search box clicked under a still pointer', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      hover(items()[2]);
      const matches = search.matches.bind(search);
      vi.spyOn(search, 'matches').mockImplementation(s => s === ':hover' || matches(s));
      search.focus();
      expect(ringed()).toEqual([search]);
      hover(items()[2]);
      expect(ringed()).toEqual([]);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(ringed()).toEqual([items()[0]]);
    });

    it('keeps the ring concealed when the keys focus the search box under the pointer', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      const matches = search.matches.bind(search);
      vi.spyOn(search, 'matches').mockImplementation(s => s === ':hover' || matches(s));
      setInputMode('keys');
      search.focus();
      expect(ringed()).toEqual([]);
    });

    it('lights the search box clicked under a still pointer while it already has the caret', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      const matches = search.matches.bind(search);
      vi.spyOn(search, 'matches').mockImplementation(s => s === ':hover' || matches(s));
      setInputMode('keys');
      search.focus();
      expect(ringed()).toEqual([]);
      search.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(ringed()).toEqual([search]);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(ringed()).toEqual([items()[0]]);
    });

    it.each([
      ['a group', () => groupItems()[1]],
      ['a source tab', () => el.querySelector<HTMLElement>('[data-sidebar-playlist="PL2"]')!],
    ])('Down from the search box lands on the first channel after hovering %s', (_, target) => {
      sidebar.handleAction('left');
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.focus();
      hover(target());
      expect(ringed()).toEqual([]);
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(ringed()).toEqual([items()[0]]);
    });

    it('marks every item it lights on hover as a hover target', () => {
      sidebar.handleAction('left');
      const lit = [
        el.querySelector('.sidebar-search-input')!,
        ...Array.from(el.querySelectorAll('.sidebar-tab, .sidebar-group-item, .sidebar-ch-item')),
      ];
      for (const item of lit) {
        expect(item.matches('[data-focusable], [data-hover-target]')).toBe(true);
      }
    });

    it('clears the highlight when the cursor leaves the sidebar', () => {
      hover(items()[2]);
      expect(ringed()).toEqual([items()[2]]);
      items()[2].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
      expect(ringed()).toEqual([]);
    });

    it('keeps the highlight while the cursor moves between its items', () => {
      hover(items()[2]);
      items()[2].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: items()[1] }));
      expect(ringed()).toEqual([items()[2]]);
    });

    it('re-shows the highlight when the cursor returns to the same row', () => {
      hover(items()[2]);
      items()[2].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
      hover(items()[2]);
      expect(ringed()).toEqual([items()[2]]);
    });

    it('re-shows the highlight on the next key after the cursor left', () => {
      hover(items()[2]);
      items()[2].dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: container }));
      sidebar.handleAction('up');
      expect(ringed()).toEqual([items()[1]]);
    });

    it('claims the wheel so it scrolls the list instead of stepping channels', () => {
      const logs = vi.spyOn(console, 'log');
      const wheel = () => new CustomEvent('nav:wheel', { bubbles: true, cancelable: true, detail: { step: false } });
      const first = wheel();
      items()[1].dispatchEvent(first);
      expect(first.defaultPrevented).toBe(true);
      expect(ringed()).toEqual([items()[1]]);
      items()[1].dispatchEvent(wheel());
      const lines = logs.mock.calls.map(args => args.join(' '))
        .filter(line => line.includes('event=sidebar.wheel.scroll '));
      expect(lines).toEqual([expect.stringContaining('pane=channels')]);
    });

    it('hovering a half-hidden source tab scrolls it into view', () => {
      const strip = el.querySelector<HTMLElement>('.sidebar-tabs')!;
      strip.style.overflowX = 'auto';
      vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40));
      Object.defineProperty(strip, 'clientWidth', { value: 100 });
      Object.defineProperty(strip, 'clientHeight', { value: 40 });
      const tab = el.querySelector<HTMLElement>('[data-sidebar-playlist="PL2"]')!;
      vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(new DOMRect(90, 0, 60, 40));
      const reveal = vi.fn();
      tab.scrollIntoView = reveal;
      hover(tab);
      expect(ringed()).toEqual([tab]);
      expect(reveal).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    });

    it('lights a half-hidden row under the pointer where it is', () => {
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      list.style.overflowY = 'auto';
      vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
      Object.defineProperty(list, 'clientWidth', { value: 100 });
      Object.defineProperty(list, 'clientHeight', { value: 100 });
      const row = items()[2];
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 100, 84));
      const reveal = vi.fn();
      row.scrollIntoView = reveal;
      hover(row);
      expect(ringed()).toEqual([row]);
      expect(reveal).not.toHaveBeenCalled();
    });

    it('re-hovering the same row after a key brings the ring back under the pointer', () => {
      hover(items()[2]);
      expect(ringed()).toEqual([items()[2]]);
      sidebar.handleAction('up');
      expect(ringed()).toEqual([items()[1]]);
      hover(items()[2]);
      expect(ringed()).toEqual([items()[2]]);
    });

    it('a key cancels the edge dwell', () => {
      sidebar.handlePointerMove(30, true);
      finishOpening();
      vi.advanceTimersByTime(200);
      setInputMode('keys');
      vi.advanceTimersByTime(500);
      expect(el.classList.contains('groups-expanded')).toBe(false);
    });

    it('a key cancels the edge dwell of a cursor that never left key mode', () => {
      setInputMode('keys');
      sidebar.handlePointerMove(30, true);
      finishOpening();
      vi.advanceTimersByTime(200);
      sidebar.handleAction('down');
      vi.advanceTimersByTime(500);
      expect(el.classList.contains('groups-expanded')).toBe(false);
    });

    it('a cursor resting at the edge in key mode still opens the groups', () => {
      setInputMode('keys');
      sidebar.handlePointerMove(30, true);
      finishOpening();
      vi.advanceTimersByTime(500);
      expect(el.classList.contains('groups-expanded')).toBe(true);
    });

    it('a key cancels the close that the pointer leaving started', () => {
      sidebar.handleAction('left');
      sidebar.handlePointerMove(741, false);
      setInputMode('keys');
      vi.advanceTimersByTime(500);
      expect(sidebar.visible).toBe(true);
    });

    it('does not stack listeners across re-renders (single select per click)', () => {
      sidebar.hide();
      sidebar.show(); // re-render #2
      sidebar.hide();
      sidebar.show(); // re-render #3
      items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });

  describe('virtual channel list', () => {
    let originalChannels: Channel[];

    beforeEach(() => {
      getCurrentIndex.mockReturnValue(0);
      originalChannels = channels.splice(0);
      for (let i = 0; i < 1200; i++) {
        channels.push({
          ...originalChannels[0],
          id: `ch${String(i)}`,
          name: `Channel ${String(i + 1)}`,
          playlistIds: ['PL1'],
        });
      }
    });

    afterEach(() => {
      channels.splice(0, channels.length, ...originalChannels);
    });

    it('renders only the visible rows with overscan', () => {
      sidebar.show();

      expect(items()).toHaveLength(34);
      expect(el.querySelector<HTMLElement>('.sidebar-channel-spacer')?.style.height).toBe('105600px');
    });

    it('keeps remote focus and selection on global channel positions', () => {
      sidebar.show();
      for (let i = 0; i < 30; i++) sidebar.handleAction('down');

      const focused = el.querySelector<HTMLElement>('.sidebar-ch-item.focused');
      expect(focused?.dataset.sidebarPos).toBe('30');
      expect(items().length).toBeLessThan(40);

      sidebar.handleAction('select');
      expect(onSelect).toHaveBeenCalledWith(30, undefined, { group: 'builtin:all', playlist: undefined });
    });

    it('hover after a not-yet-reported wheel scroll keeps the scroll position', () => {
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      Object.defineProperty(list, 'clientHeight', { value: 460, configurable: true });
      list.scrollTop = 2300;
      list.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);
      // The next native scroll lands before its scroll event fires.
      list.scrollTop = 2500;
      const row = items().find(item => item.dataset.sidebarPos === '32')!;
      hover(row);
      Focus.flush();

      expect(list.scrollTop).toBe(2500);
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('32');
    });

    it('resumes focus in view after the focused row scrolled away', () => {
      const logs = vi.spyOn(console, 'log');
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      Object.defineProperty(list, 'clientHeight', { value: 460, configurable: true });
      list.scrollTop = 2300;
      list.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);

      sidebar.handleAction('down');

      expect(list.scrollTop).toBe(2300);
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('27');
      const lines = logs.mock.calls.map(args => args.join(' '))
        .filter(line => line.includes('event=nav.focus.repaired reason=detached '));
      expect(lines).toEqual([expect.stringMatching(/scope=player.sidebar distance=27$/)]);

      sidebar.handleAction('down');
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('28');
    });

    it('OK on a scrolled-away row resumes focus instead of tuning it', () => {
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      Object.defineProperty(list, 'clientHeight', { value: 460, configurable: true });
      list.scrollTop = 2300;
      list.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);

      sidebar.handleAction('select');

      expect(onSelect).not.toHaveBeenCalled();
      expect(list.scrollTop).toBe(2300);
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('27');
    });

    it('Left then Right after a wheel scroll keeps the scrolled list in place', () => {
      const logs = vi.spyOn(console, 'log');
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      Object.defineProperty(list, 'clientHeight', { value: 460, configurable: true });
      list.scrollTop = 2300;
      list.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);

      sidebar.handleAction('left');
      expect(el.classList.contains('groups-expanded')).toBe(true);
      sidebar.handleAction('right');

      expect(el.classList.contains('channels-only')).toBe(true);
      expect(list.scrollTop).toBe(2300);
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('27');
      const lines = logs.mock.calls.map(args => args.join(' '))
        .filter(line => line.includes('event=nav.focus.repaired reason=detached '));
      expect(lines).toEqual([expect.stringMatching(/scope=player.sidebar distance=27$/)]);
    });

    it('opening scrolls a far-down current channel into view', () => {
      getCurrentIndex.mockReturnValue(900);
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      const focused = el.querySelector<HTMLElement>('.sidebar-ch-item.focused');
      expect(focused?.dataset.sidebarPos).toBe('900');
      // Centered in the 800px fallback viewport: 900 * 88 - (800 - 88) / 2.
      expect(list.scrollTop).toBe(78844);

      sidebar.hide();
      list.scrollTop = 0;
      getCurrentIndex.mockReturnValue(600);
      sidebar.show();
      expect(el.querySelector<HTMLElement>('.sidebar-ch-item.focused')?.dataset.sidebarPos)
        .toBe('600');
      expect(list.scrollTop).toBe(600 * 88 - 356);
    });

    it('updates the rendered window when the list scrolls', () => {
      sidebar.show();
      const list = el.querySelector<HTMLElement>('.sidebar-channel-list')!;
      Object.defineProperty(list, 'clientHeight', { value: 460, configurable: true });
      list.scrollTop = 2300;
      list.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);

      const positions = items().map(item => parseInt(item.dataset.sidebarPos!, 10));
      expect(positions).toContain(25);
      expect(positions).not.toContain(0);
      expect(positions.length).toBeLessThan(40);
    });
  });

  describe('auto-hide timer', () => {
    it('hides itself after the idle timeout', () => {
      sidebar.show();
      vi.advanceTimersByTime(5000);
      expect(sidebar.visible).toBe(false);
    });

    // Keyboard on → never auto-hide, wherever the mouse is.
    it('stays open while the keyboard is on (OK pressed)', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // OK → keyboard on
      expect(sidebar.keyboardOn).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(sidebar.visible).toBe(true);
    });

    // Also holds when the box is focused by a pointer click (not just OK):
    // the global click handler skips the sidebar, so focusin is what flips it on.
    it('stays open when the search box is focused by pointer (keyboard on)', () => {
      sidebar.show();
      el.querySelector<HTMLInputElement>('.sidebar-search-input')!.focus();
      expect(sidebar.keyboardOn).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(sidebar.visible).toBe(true);
    });

    // Cancel/Back → keyboard off → hide (pointer not over the sidebar).
    it('Cancel (Escape) on the search box turns the keyboard off and hides', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select');
      el.querySelector<HTMLInputElement>('.sidebar-search-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(sidebar.keyboardOn).toBe(false);
      expect(sidebar.visible).toBe(false);
    });

    it('Back on the search box turns the keyboard off and hides', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select');
      el.querySelector<HTMLInputElement>('.sidebar-search-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { keyCode: CONFIG.KEYS.BACK, bubbles: true }));
      expect(sidebar.visible).toBe(false);
    });

    // The real webOS fix: keyboard dismissed while the input keeps the caret.
    it('hides on keyboardStateChange:false even if the box keeps focus', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // focus → keyboard on
      expect(sidebar.keyboardOn).toBe(true);
      // webOS dismiss: keyboard off, but the input is NOT blurred (caret stays).
      document.dispatchEvent(new CustomEvent('keyboardStateChange', { detail: { visibility: false } }));
      expect(sidebar.keyboardOn).toBe(false);
      expect(sidebar.visible).toBe(false);
    });

    it('Down moves into the list (keyboard off) without hiding', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // keyboard on
      el.querySelector<HTMLInputElement>('.sidebar-search-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(sidebar.keyboardOn).toBe(false);
      expect(sidebar.visible).toBe(true);
      expect(items()[0].classList.contains('focused')).toBe(true);
    });
  });

  describe('search ranking', () => {
    it('a search result reports its global channel index, not the filtered position', async () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // focus the search box
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'charlie';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(items()).toHaveLength(1));
      expect(items().map(i => i.querySelector('.ch-name')?.textContent)).toEqual(['Charlie']);
      sidebar.handleAction('down');   // search -> active source
      sidebar.handleAction('down');   // source -> the single result
      sidebar.handleAction('select'); // pick it
      expect(onSelect).toHaveBeenCalledWith(2, undefined, { group: 'builtin:all', playlist: undefined }); // Charlie is global index 2, not filtered 0
    });

    it('logs the fallback for a failing worker once, not again while the retry is pending', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // Only the faked clock (and vi.waitFor's 50 ms polls) can end the delay.
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        const fallbackLogs = (): unknown[][] => error.mock.calls
          .filter(call => call.some(part => part === 'event=search.worker.fallback.used'));
        workerMock.failIndexes = true;
        sidebar.show();
        highlightSearch();
        sidebar.handleAction('select');
        const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
        const type = (value: string): void => {
          search.value = value;
          search.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const names = (): Array<string | null | undefined> =>
          items().map(i => i.querySelector('.ch-name')?.textContent);

        type('charlie');
        await vi.waitFor(() => expect(names()).toEqual(['Charlie']));
        expect(fallbackLogs()).toHaveLength(1);

        type('bravo');
        await vi.waitFor(() => expect(names()).toEqual(['Bravo']));
        vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS - 1000);
        type('alpha');
        await vi.waitFor(() => expect(names()).toEqual(['Alpha']));
        expect(fallbackLogs()).toHaveLength(1);

        // The delay passed: the worker is tried, and fails, again.
        vi.advanceTimersByTime(CONFIG.SEARCH.INDEX_RETRY_DELAY_MS);
        type('char');
        await vi.waitFor(() => expect(fallbackLogs()).toHaveLength(2));
      } finally {
        // Clears the real auto-hide timer that show() and typing started.
        sidebar.hide();
        vi.useRealTimers();
        error.mockRestore();
      }
    });
  });
});
