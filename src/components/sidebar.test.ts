// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel } from '../types';
import type { RecentlyWatchedItem } from '../services/recently-watched';
import { CONFIG } from '../config';

const { channels, epgMock, recentMock, toastMock } = vi.hoisted(() => {
  function makeChannel(over: Partial<Channel>): Channel {
    return {
      id: '', name: '', logo: '', group: '', url: '', extras: null,
      playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
    };
  }
  return {
    channels: [
      makeChannel({ id: 'a', name: 'Alpha', group: 'News', playlistIds: ['PL1'] }),
      makeChannel({ id: 'b', name: 'Bravo', group: 'News', playlistIds: ['PL1'], favorite: true }),
      makeChannel({ id: 'c', name: 'Charlie', group: 'Sports', playlistIds: ['PL2'] }),
    ] as Channel[],
    epgMock: {
      nowPlaying: null as { title: string } | null,
    },
    recentMock: {
      items: [] as RecentlyWatchedItem[],
      getItems: vi.fn(() => recentMock.items),
      catchupInfo: vi.fn(),
    },
    toastMock: vi.fn(),
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
      if (group === 'builtin:favorites') source = source.filter(ch => ch.favorite);
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
vi.mock('./toast', () => ({ showToast: toastMock }));

import { Sidebar } from './sidebar';
import { setLocale } from '../i18n';
import { PlaylistService } from '../services/playlist-service';

let container: HTMLElement;
let el: HTMLElement;
let getCurrentIndex: ReturnType<typeof vi.fn>;
let getCurrentCatchupStart: ReturnType<typeof vi.fn>;
let onSelect: ReturnType<typeof vi.fn>;
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

  getCurrentIndex = vi.fn(() => 1);
  getCurrentCatchupStart = vi.fn(() => null);
  onSelect = vi.fn();
  recentMock.items = [];
  recentMock.getItems.mockClear();
  recentMock.catchupInfo.mockReset();
  epgMock.nowPlaying = null;
  toastMock.mockClear();
  sidebar = new Sidebar(container, getCurrentIndex, onSelect, getCurrentCatchupStart);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function items(): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.sidebar-ch-item'));
}

function groupItems(): HTMLElement[] {
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
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      sidebar.handleAction('up'); // 1 -> 0
      sidebar.handleAction('up'); // from 0 -> search box
      expect(items().some(i => i.classList.contains('focused'))).toBe(false);
      expect(search.classList.contains('focused')).toBe(true);
      expect(document.activeElement).not.toBe(search);
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

    it('typing in the search box filters channels across playlists', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'char';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const names = items().map(i => i.querySelector('.ch-name')?.textContent);
      expect(names).toEqual(['Charlie']);
    });

    it('Enter in the search box drops focus onto the first result', () => {
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'a';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(items()[0].classList.contains('focused')).toBe(true);
    });

    it('select fires onSelectChannel with the global index and hides', () => {
      sidebar.handleAction('down'); // 1 -> 2 (global 2)
      sidebar.handleAction('select');
      expect(onSelect).toHaveBeenCalledWith(2);
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
      channels[0].favorite = true;
      sidebar.show();
      sidebar.handleAction('left');

      expect(groupItems()[1].querySelector('.sidebar-group-count')?.textContent).toBe('2');
      channels[0].favorite = false;
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

      channels[1].favorite = false;
      sidebar.refresh();
      expect(items()).toHaveLength(0);
      channels[1].favorite = true;
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
      expect(onSelect).toHaveBeenCalledWith(2);
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

      expect(onSelect).toHaveBeenCalledWith(0, catchup);
      expect(sidebar.visible).toBe(false);
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
      expect(onSelect).toHaveBeenCalledWith(2);
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
      items()[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items()[2].classList.contains('focused')).toBe(true);
    });

    it('hovering up onto the search box highlights it and clears the channel', () => {
      items()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items()[1].classList.contains('focused')).toBe(true);
      const search = el.querySelector<HTMLElement>('.sidebar-search-input')!;
      search.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items().some(i => i.classList.contains('focused'))).toBe(false);
      expect(search.classList.contains('focused')).toBe(true);
    });

    it('clears the highlight when the cursor leaves the sidebar', () => {
      items()[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items()[2].classList.contains('focused')).toBe(true);
      el.dispatchEvent(new MouseEvent('mouseleave'));
      expect(el.querySelectorAll('.focused')).toHaveLength(0);
    });

    it('re-shows the highlight when the cursor returns to the same row', () => {
      items()[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseleave'));
      items()[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // same row
      expect(items()[2].classList.contains('focused')).toBe(true);
    });

    it('hover only re-highlights when the position changes', () => {
      const spy = vi.spyOn(sidebar as unknown as { updateFocus: () => void }, 'updateFocus');
      const row = items()[2];
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(spy).toHaveBeenCalledTimes(1);
      // Sweeping across a child of the same row must not re-run updateFocus.
      row.querySelector('.ch-name')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(spy).toHaveBeenCalledTimes(1);
      // A different row does.
      items()[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('wheel down / up moves the focus highlight', () => {
      const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      el.dispatchEvent(wheel);
      expect(items()[2].classList.contains('focused')).toBe(true);
      expect(wheel.defaultPrevented).toBe(false);
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
      expect(items()[2].classList.contains('focused')).toBe(true);
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      expect(items()[1].classList.contains('focused')).toBe(true);
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
      expect(onSelect).toHaveBeenCalledWith(30);
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
    it('a search result reports its global channel index, not the filtered position', () => {
      sidebar.show();
      highlightSearch();
      sidebar.handleAction('select'); // focus the search box
      const search = el.querySelector<HTMLInputElement>('.sidebar-search-input')!;
      search.value = 'charlie';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(items().map(i => i.querySelector('.ch-name')?.textContent)).toEqual(['Charlie']);
      sidebar.handleAction('down');   // enter the list at the single result
      sidebar.handleAction('select'); // pick it
      expect(onSelect).toHaveBeenCalledWith(2); // Charlie is global index 2, not filtered 0
    });
  });
});
