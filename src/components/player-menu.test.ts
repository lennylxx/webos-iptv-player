// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel, AudioTrackOption, SubtitleTrackOption } from '../types';

const { channels } = vi.hoisted(() => {
  function makeChannel(over: Partial<Channel>): Channel {
    return {
      id: '', name: '', logo: '', group: '', url: '', extras: null,
      playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0, ...over,
    };
  }
  return { channels: [makeChannel({ id: 'a', name: 'Alpha' })] as Channel[] };
});

vi.mock('../services/playlist-service', () => ({
  PlaylistService: {
    channels,
    playlistTabs: [],
    getByIndex: (i: number) => channels[i],
  },
}));

import { PlayerMenu } from './player-menu';
import { Focus } from '../navigation/focus-scope';
import type { PlaybackRateState } from '../services/playback-rate';

// Number of colour actions before the "Audio Track" row in the main menu.
const MENU_ACTIONS = 4;

let container: HTMLElement;
let el: HTMLElement;
let getCurrentChannel: ReturnType<typeof vi.fn>;
let onAction: ReturnType<typeof vi.fn>;
let getAudioTracks: ReturnType<typeof vi.fn>;
let selectAudioTrack: ReturnType<typeof vi.fn>;
let audioTracks: AudioTrackOption[];
let getSubtitleTracks: ReturnType<typeof vi.fn>;
let selectSubtitleTrack: ReturnType<typeof vi.fn>;
let subtitleTracks: SubtitleTrackOption[];
let getSubtitleOffsetState: ReturnType<typeof vi.fn>;
let openSubtitleOffset: ReturnType<typeof vi.fn>;
let getPlaybackRateState: ReturnType<typeof vi.fn>;
let selectPlaybackRate: ReturnType<typeof vi.fn>;
let subtitleSearchAvailable: ReturnType<typeof vi.fn>;
let openSubtitleSearch: ReturnType<typeof vi.fn>;
let menu: PlayerMenu;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  el = document.createElement('div');
  el.id = 'player-menu';
  el.className = 'player-menu hidden';
  container.appendChild(el);
  document.body.appendChild(container);

  getCurrentChannel = vi.fn(() => channels[0] ?? null);
  onAction = vi.fn();
  audioTracks = [];
  getAudioTracks = vi.fn(() => audioTracks);
  selectAudioTrack = vi.fn();
  subtitleTracks = [];
  getSubtitleTracks = vi.fn(() => subtitleTracks);
  selectSubtitleTrack = vi.fn();
  getSubtitleOffsetState = vi.fn(() => ({ available: false, label: '0.00 s' }));
  openSubtitleOffset = vi.fn();
  getPlaybackRateState = vi.fn((): PlaybackRateState => ({ available: false, rate: 1 }));
  selectPlaybackRate = vi.fn().mockResolvedValue(true);
  subtitleSearchAvailable = vi.fn(() => false);
  openSubtitleSearch = vi.fn();
  menu = new PlayerMenu(
    container, getCurrentChannel, onAction,
    getAudioTracks, selectAudioTrack,
    getSubtitleTracks, selectSubtitleTrack,
    getSubtitleOffsetState, openSubtitleOffset,
    getPlaybackRateState, selectPlaybackRate,
    subtitleSearchAvailable, openSubtitleSearch,
  );
});

afterEach(() => {
  Focus.uninstall();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function items(): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('.menu-item'));
}

describe('PlayerMenu', () => {
  it('renders the action items and the playing channel name on show', () => {
    menu.show();
    expect(menu.visible).toBe(true);
    expect(items().map(i => i.dataset.menuAction)).toEqual(['red', 'green', 'yellow', 'blue']);
    expect(el.textContent).toContain('Alpha');
    expect(items()[0].classList.contains('focused')).toBe(true);
  });

  it('show() always resets focus to the first item', () => {
    menu.show();
    menu.handleAction('down');
    menu.hide();
    menu.show();
    expect(items()[0].classList.contains('focused')).toBe(true);
  });

  describe('handleAction', () => {
    beforeEach(() => menu.show());

    it('down then up moves the focus highlight', () => {
      menu.handleAction('down');
      expect(items()[1].classList.contains('focused')).toBe(true);
      menu.handleAction('up');
      expect(items()[0].classList.contains('focused')).toBe(true);
    });

    it('clamps at the ends', () => {
      menu.handleAction('up'); // already at 0
      expect(items()[0].classList.contains('focused')).toBe(true);
      for (let i = 0; i < 10; i++) menu.handleAction('down');
      expect(items()[3].classList.contains('focused')).toBe(true);
    });

    it('scrolls only the menu list to reveal the focused row', () => {
      const list = el.querySelector<HTMLElement>('.menu-items')!;
      const second = items()[1];
      const scrollIntoView = vi.fn();
      second.scrollIntoView = scrollIntoView;
      Object.defineProperty(list, 'scrollTop', {
        value: 0, writable: true, configurable: true,
      });
      list.getBoundingClientRect = () => ({
        top: 100, bottom: 300,
      }) as DOMRect;
      second.getBoundingClientRect = () => ({
        top: 280, bottom: 340,
      }) as DOMRect;

      menu.handleAction('down');

      expect(list.scrollTop).toBe(40);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('steps a held key instantly and an isolated one through the smooth policy', () => {
      const list = el.querySelector<HTMLElement>('.menu-items')!;
      list.style.setProperty('scroll-behavior', 'smooth');
      const writes: string[] = [];
      let top = 0;
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          writes.push(list.style.getPropertyValue('scroll-behavior'));
          top = value;
        },
      });
      list.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect;
      for (const item of items()) {
        item.getBoundingClientRect = () => ({ top: 280, bottom: 340 }) as DOMRect;
      }

      menu.handleAction('down');
      vi.advanceTimersByTime(80);
      menu.handleAction('down');
      vi.advanceTimersByTime(1000);
      menu.handleAction('down');

      expect(writes).toEqual(['smooth', 'auto', 'smooth']);
      expect(list.style.getPropertyValue('scroll-behavior')).toBe('smooth');
    });

    function recordListWrites(rowTop: () => number): string[] {
      const list = el.querySelector<HTMLElement>('.menu-items')!;
      list.style.setProperty('scroll-behavior', 'smooth');
      const writes: string[] = [];
      let top = 0;
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          writes.push(list.style.getPropertyValue('scroll-behavior'));
          top = value;
        },
      });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this.classList.contains('menu-items')) return { top: 100, bottom: 300 } as DOMRect;
        return { top: rowTop(), bottom: rowTop() + 60 } as DOMRect;
      });
      return writes;
    }

    it('opens a sub-menu on its active row without a glide', () => {
      menu.hide();
      subtitleTracks = Array.from({ length: 6 }, (_, i) => ({ index: i, label: `Track ${i + 1}`, active: i === 5 }));
      menu.show();
      const writes = recordListWrites(() => 280);
      vi.advanceTimersByTime(1000);

      items().find((i) => i.dataset.menuAction === '__subs_open__')!.click();

      expect(writes).toEqual(['auto']);
      vi.restoreAllMocks();
    });

    it('lets a row slide in instead of snapping it, and treats only another row as a held key', () => {
      let rowTop = 280;
      const writes = recordListWrites(() => rowTop);

      menu.handleAction('up'); // a key that moves nothing re-reveals the row
      rowTop = 270; // still sliding in
      vi.advanceTimersByTime(80);
      menu.handleAction('up');
      expect(writes).toEqual(['smooth']);

      rowTop = 280; // a reset left it no closer
      vi.advanceTimersByTime(20);
      menu.handleAction('up');
      expect(writes).toEqual(['smooth', 'smooth']);
      vi.restoreAllMocks();
    });

    it('select emits the focused action and hides the menu', () => {
      menu.handleAction('down'); // focus "green"
      menu.handleAction('select');
      expect(onAction).toHaveBeenCalledWith('green');
      expect(menu.visible).toBe(false);
    });
  });

  describe('pointer interaction', () => {
    beforeEach(() => menu.show());

    it('clicking an item emits its action and hides', () => {
      el.querySelector<HTMLElement>('[data-menu-action="blue"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onAction).toHaveBeenCalledWith('blue');
      expect(menu.visible).toBe(false);
    });

    it('hovering moves the focus highlight', () => {
      el.querySelector<HTMLElement>('[data-menu-action="yellow"]')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      expect(items()[2].classList.contains('focused')).toBe(true);
      expect(el.querySelectorAll('.focused')).toHaveLength(1);
      menu.handleAction('down');
      expect(items()[3].classList.contains('focused')).toBe(true);
    });

    it('leaves a raw mouseover, which a resting pointer fires in key mode, to the key handler', () => {
      el.querySelector<HTMLElement>('[data-menu-action="yellow"]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items()[0].classList.contains('focused')).toBe(true);
      expect(items()[2].classList.contains('focused')).toBe(false);
    });

    it('does not stack listeners across re-renders (single emit per click)', () => {
      menu.hide();
      menu.show();
      menu.hide();
      menu.show();
      el.querySelector<HTMLElement>('[data-menu-action="red"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('hide transition', () => {
    // Chromium 53 predates `once`: it ignores `once` in an options object
    // and keeps the listener attached after it fires.
    function ignoreListenerOptions(): { attached: () => number } {
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const add = el.addEventListener.bind(el);
      const remove = el.removeEventListener.bind(el);
      el.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions) => {
        if (type === 'transitionend' && fn) listeners.add(fn);
        add(type, fn, typeof options === 'object' ? !!options.capture : options);
      };
      el.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions) => {
        if (type === 'transitionend' && fn) listeners.delete(fn);
        remove(type, fn, options);
      };
      return { attached: () => listeners.size };
    }

    function transitionEnd(): void {
      el.dispatchEvent(new Event('transitionend'));
    }

    it('adds the hidden class once the fade-out ends', () => {
      menu.show();
      menu.hide();
      expect(el.classList.contains('hidden')).toBe(false);
      transitionEnd();
      expect(el.classList.contains('hidden')).toBe(true);
    });

    it('keeps no listener behind on an engine without `once`', () => {
      const engine = ignoreListenerOptions();
      for (let i = 0; i < 5; i++) {
        menu.show();
        menu.hide();
        transitionEnd();
      }
      expect(engine.attached()).toBe(0);
    });

    it('drops an unfinished fade-out when the menu reopens', () => {
      const engine = ignoreListenerOptions();
      menu.show();
      menu.hide();
      menu.show();
      // The fix under test; the class checks below held before it too.
      expect(engine.attached()).toBe(0);
      transitionEnd();
      expect(el.classList.contains('hidden')).toBe(false);
      expect(menu.visible).toBe(true);
    });

  });

  it('hides itself after the idle timeout', () => {
    menu.show();
    vi.advanceTimersByTime(5000);
    expect(menu.visible).toBe(false);
  });

  describe('audio track sub-menu', () => {
    const TRACKS: AudioTrackOption[] = [
      { index: 0, label: 'Track 1', active: true },
      { index: 1, label: 'Track 2', active: false },
      { index: 2, label: 'Track 3', active: false },
    ];

    it('omits the Audio Track row when fewer than two tracks', () => {
      audioTracks = [{ index: 0, label: 'Track 1', active: true }];
      menu.show();
      expect(el.querySelector('[data-menu-action="__audio_open__"]')).toBeNull();
    });

    it('shows the Audio Track row with the active track when multiple exist', () => {
      audioTracks = TRACKS;
      menu.show();
      const row = el.querySelector('[data-menu-action="__audio_open__"]');
      expect(row).not.toBeNull();
      expect(row!.querySelector('.menu-item-value')!.textContent).toBe('Track 1');
    });

    it('opens the picker listing all tracks plus a Back row, focusing the active one', () => {
      audioTracks = TRACKS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down'); // reach Audio Track row
      menu.handleAction('select');
      const rows = items();
      expect(rows).toHaveLength(4);
      expect(rows[0].dataset.menuAction).toBe('__menu_back__');
      expect(rows.slice(1).map(r => r.dataset.trackIndex)).toEqual(['0', '1', '2']);
      expect(rows[1].textContent).toContain('Track 1');
      expect(rows[1].querySelector('.menu-check')!.textContent).toBe('✓'); // active marked
      expect(rows[2].querySelector('.menu-check')!.textContent).toBe('');  // others blank
      // active track (Track 1) is focused: Back row is index 0, Track 1 is index 1
      expect(rows[1].classList.contains('focused')).toBe(true);
    });

    it('greys a track marked unavailable (a collapsed rendition), not the others', () => {
      audioTracks = [
        { index: 0, label: 'Track 1', active: true },
        { index: 1, label: 'Track 2', active: false, available: false },
        { index: 2, label: 'Track 3', active: false, available: false },
      ];
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');
      const rows = items();
      expect(rows[1].classList.contains('unavailable')).toBe(false); // Track 1 switchable
      expect(rows[2].classList.contains('unavailable')).toBe(true);  // Track 2 greyed
      expect(rows[3].classList.contains('unavailable')).toBe(true);  // Track 3 greyed
    });

    it('selecting a track switches to it and returns to the main menu', () => {
      audioTracks = TRACKS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker (Track 1 focused at idx 1)
      menu.handleAction('down');       // focus Track 3 (idx 3) ... step once → Track 2
      menu.handleAction('down');       // → Track 3
      menu.handleAction('select');     // pick it
      expect(selectAudioTrack).toHaveBeenCalledWith(2);
      // back on the main menu
      expect(el.querySelector('[data-menu-action="__audio_open__"]')).not.toBeNull();
      expect(menu.visible).toBe(true);
    });

    it('Back row returns to the main menu without closing', () => {
      audioTracks = TRACKS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker
      menu.handleAction('up');         // focus Back row (idx 0)
      menu.handleAction('select');
      expect(selectAudioTrack).not.toHaveBeenCalled();
      expect(el.querySelector('[data-menu-action="__audio_open__"]')).not.toBeNull();
      expect(menu.visible).toBe(true);
    });

    it('handleBack() leaves the picker but keeps the menu open; returns false on the main menu', () => {
      audioTracks = TRACKS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // in picker
      expect(menu.handleBack()).toBe(true);
      expect(menu.visible).toBe(true);
      expect(el.querySelector('[data-menu-action="__audio_open__"]')).not.toBeNull();
      // on the main menu it no longer consumes Back
      expect(menu.handleBack()).toBe(false);
    });
  });

  describe('subtitle sub-menu', () => {
    // audioTracks stays empty, so the Subtitles row sits right after the colours.
    const SUBS: SubtitleTrackOption[] = [
      { index: 0, label: 'Track 1', active: false },
      { index: 1, label: 'Track 2', active: true },
    ];

    it('omits the Subtitles row when the stream has no subtitle tracks', () => {
      subtitleTracks = [];
      menu.show();
      expect(el.querySelector('[data-menu-action="__subs_open__"]')).toBeNull();
    });

    it('shows the Subtitles row with the active label, falling back to Off', () => {
      subtitleTracks = SUBS;
      menu.show();
      expect(el.querySelector('[data-menu-action="__subs_open__"] .menu-item-value')!.textContent).toBe('Track 2');

      menu.hide();
      subtitleTracks = [{ index: 0, label: 'Track 1', active: false }];
      menu.show();
      expect(el.querySelector('[data-menu-action="__subs_open__"] .menu-item-value')!.textContent).toBe('Off');
    });

    it('opens the picker with Back, Off, then tracks, focusing the active one', () => {
      subtitleTracks = SUBS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down'); // reach Subtitles row
      menu.handleAction('select');
      const rows = items();
      expect(rows).toHaveLength(4);
      expect(rows[0].dataset.menuAction).toBe('__menu_back__');
      expect(rows[1].dataset.trackIndex).toBe('-1'); // Off
      expect(rows[1].textContent).toContain('Off');
      expect(rows.slice(2).map(r => r.dataset.trackIndex)).toEqual(['0', '1']);
      expect(rows[3].querySelector('.menu-check')!.textContent).toBe('✓'); // active (Track 2) marked
      expect(rows[1].querySelector('.menu-check')!.textContent).toBe('');  // Off not marked
      expect(rows[3].classList.contains('focused')).toBe(true);            // active track focused
    });

    it('marks Off as active and focuses it when no subtitle is showing', () => {
      subtitleTracks = [{ index: 0, label: 'Track 1', active: false }];
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');
      const rows = items();
      expect(rows[1].querySelector('.menu-check')!.textContent).toBe('✓'); // Off marked
      expect(rows[1].classList.contains('focused')).toBe(true);            // Off focused
    });

    it('selecting Off turns subtitles off (index -1) and returns to the main menu', () => {
      subtitleTracks = SUBS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker (Track 2 focused at idx 3)
      menu.handleAction('up');         // → Track 1 (idx 2)
      menu.handleAction('up');         // → Off (idx 1)
      menu.handleAction('select');
      expect(selectSubtitleTrack).toHaveBeenCalledWith(-1);
      expect(el.querySelector('[data-menu-action="__subs_open__"]')).not.toBeNull();
      expect(menu.visible).toBe(true);
    });

    it('selecting a track switches to it and returns to the main menu', () => {
      subtitleTracks = SUBS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker (Track 2 focused at idx 3)
      menu.handleAction('up');         // focus Track 1 (idx 2)
      menu.handleAction('select');
      expect(selectSubtitleTrack).toHaveBeenCalledWith(0);
      expect(menu.visible).toBe(true);
    });

    it('opens the Subtitles row for search alone, and Search online closes the menu', () => {
      subtitleSearchAvailable.mockReturnValue(true);
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker
      menu.handleAction('down');       // move past "Off" to "Search online…"
      expect(items()[2].dataset.menuAction).toBe('__subs_search__');
      menu.handleAction('select');
      expect(openSubtitleSearch).toHaveBeenCalledTimes(1);
      expect(selectSubtitleTrack).not.toHaveBeenCalled();
      expect(menu.visible).toBe(false);
    });

    it('shows a Subtitle Sync row in the subtitles submenu and opens the adjuster', () => {
      subtitleTracks = [{ index: 0, label: 'Track 1', active: true }];
      getSubtitleOffsetState.mockReturnValue({ available: true, label: '+0.25 s' });
      menu.show();
      items().find((i) => i.dataset.menuAction === '__subs_open__')!.click();
      const offsetRow = items().find((i) => i.dataset.menuAction === '__subs_offset__');
      expect(offsetRow).toBeTruthy();
      expect(offsetRow!.textContent).toContain('Subtitle Sync');
      expect(offsetRow!.textContent).toContain('+0.25 s');
      offsetRow!.click();
      expect(openSubtitleOffset).toHaveBeenCalled();
    });

    it('hides the Subtitle Sync row when offset is unavailable', () => {
      subtitleTracks = [{ index: 0, label: 'Track 1', active: true }];
      getSubtitleOffsetState.mockReturnValue({ available: false, label: '0.00 s' });
      menu.show();
      items().find((i) => i.dataset.menuAction === '__subs_open__')!.click();
      expect(items().find((i) => i.dataset.menuAction === '__subs_offset__')).toBeUndefined();
    });

    it('refresh() moves the check to Off after a reset and keeps focus', () => {
      subtitleTracks = SUBS;
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker (Track 2 focused at idx 3)
      menu.handleAction('up');         // focus Track 1 (idx 2)

      subtitleTracks = [
        { index: 0, label: 'Track 1', active: false },
        { index: 1, label: 'Track 2', active: false, available: false },
      ];
      menu.refresh();

      const rows = items();
      expect(rows[1].querySelector('.menu-check')!.textContent).toBe('✓'); // Off marked
      expect(rows[3].querySelector('.menu-check')!.textContent).toBe('');
      expect(rows[3].classList.contains('unavailable')).toBe(true);
      expect(rows[2].classList.contains('focused')).toBe(true);            // still on Track 1
    });

    it('greys a subtitle track marked unavailable, but never the Off row', () => {
      subtitleTracks = [{ index: 0, label: 'Track 1', active: false, available: false }];
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');
      const rows = items();
      expect(rows[1].classList.contains('unavailable')).toBe(false); // Off always selectable
      expect(rows[2].classList.contains('unavailable')).toBe(true);  // the track greyed
    });
  });

  describe('playback speed sub-menu', () => {
    beforeEach(() => {
      getPlaybackRateState.mockReturnValue({ available: true, rate: 1.5 });
    });

    it('shows the active speed for seekable playback', () => {
      menu.show();

      const row = el.querySelector('[data-menu-action="__speed_open__"]');
      expect(row).not.toBeNull();
      expect(row!.querySelector('.menu-item-value')!.textContent).toBe('1.5x');
    });

    it('opens the speed picker with the active rate focused', () => {
      menu.show();
      el.querySelector<HTMLElement>('[data-menu-action="__speed_open__"]')!.click();

      const rows = items();
      expect(rows.map(row => row.dataset.playbackRate)).toEqual([
        undefined, '0.5', '0.75', '1', '1.25', '1.5', '2',
      ]);
      expect(rows[5].classList.contains('focused')).toBe(true);
      expect(rows[5].querySelector('.menu-check')!.textContent).toBe('✓');
    });

    it('applies a selected rate and returns to the main menu', async () => {
      menu.show();
      el.querySelector<HTMLElement>('[data-menu-action="__speed_open__"]')!.click();
      el.querySelector<HTMLElement>('[data-playback-rate="2"]')!.click();
      await Promise.resolve();

      expect(selectPlaybackRate).toHaveBeenCalledWith(2);
      expect(el.querySelector('[data-menu-action="__speed_open__"]')).not.toBeNull();
      expect(menu.visible).toBe(true);
    });

    it('drops the speed row on refresh once the rate is found not to apply', () => {
      menu.show();
      getPlaybackRateState.mockReturnValue({ available: false, rate: 1 });
      menu.refresh();

      expect(el.querySelector('[data-menu-action="__speed_open__"]')).toBeNull();
    });

    it('moves focus off the speed row when refresh removes it', () => {
      menu.show();
      const speedIdx = items().findIndex(row => row.dataset.menuAction === '__speed_open__');
      for (let i = 0; i < speedIdx; i++) menu.handleAction('down');
      expect(items()[speedIdx].classList.contains('focused')).toBe(true);

      getPlaybackRateState.mockReturnValue({ available: false, rate: 1 });
      menu.refresh();

      const focused = items().filter(row => row.classList.contains('focused'));
      expect(focused).toEqual([items()[speedIdx - 1]]);
    });

    it('follows the pointer when refresh removes the focused speed row', () => {
      audioTracks = [
        { index: 0, label: 'Track 1', active: true },
        { index: 1, label: 'Track 2', active: false },
      ];
      menu.show();
      const speedIdx = items().findIndex(row => row.dataset.menuAction === '__speed_open__');
      for (let i = 0; i < speedIdx; i++) menu.handleAction('down');
      const audioRow = el.querySelector<HTMLElement>('[data-menu-action="__audio_open__"]')!;
      const query = el.querySelector.bind(el);
      vi.spyOn(el, 'querySelector').mockImplementation((selector: string) =>
        selector === '.menu-item:hover' ? audioRow : query(selector));

      getPlaybackRateState.mockReturnValue({ available: false, rate: 1 });
      menu.refresh();

      expect(items().filter(row => row.classList.contains('focused')))
        .toEqual([el.querySelector('[data-menu-action="__audio_open__"]')]);
    });

    it('re-renders an open speed picker when the rate falls back', () => {
      getPlaybackRateState.mockReturnValue({ available: true, rate: 2 });
      menu.show();
      el.querySelector<HTMLElement>('[data-menu-action="__speed_open__"]')!.click();

      getPlaybackRateState.mockReturnValue({ available: true, rate: 1 });
      menu.refresh();

      const checked = items().filter(row => row.querySelector('.menu-check')?.textContent === '✓');
      expect(checked.map(row => row.dataset.playbackRate)).toEqual(['1']);
    });

    it('leaves the speed picker on refresh once the rate is found not to apply', () => {
      menu.show();
      el.querySelector<HTMLElement>('[data-menu-action="__speed_open__"]')!.click();
      getPlaybackRateState.mockReturnValue({ available: false, rate: 1 });
      menu.refresh();

      expect(el.querySelector('[data-playback-rate]')).toBeNull();
      expect(menu.visible).toBe(true);
    });
  });

  describe('VOD mode (no channel)', () => {
    beforeEach(() => getCurrentChannel.mockReturnValue(null));

    it('keeps only the Info and Settings color rows, dropping Program Guide / Toggle Favorite', () => {
      audioTracks = [
        { index: 0, label: 'Track 1', active: true, available: true },
        { index: 1, label: 'Track 2', active: false, available: true },
      ];
      subtitleTracks = [{ index: 0, label: 'Track 1', active: false, available: true }];
      menu.show();
      const actions = items().map(i => i.dataset.menuAction);
      expect(actions).not.toContain('red');   // Program Guide — no EPG for VOD
      expect(actions).not.toContain('green');  // Toggle Favorite — channels only
      expect(actions).toContain('yellow');     // Title Info
      expect(actions).toContain('blue');       // Settings
      expect(el.textContent).toContain('Title Info');
      expect(el.textContent).not.toContain('Channel Info'); // relabeled for VOD
      expect(el.textContent).toContain('Settings');
      expect(el.textContent).toContain('Audio Track');
      expect(el.textContent).toContain('Subtitles');
      expect(el.textContent).not.toContain('Playing:'); // no channel name
    });

    it('still shows Info and Settings even without any tracks', () => {
      menu.show();
      expect(items().map(i => i.dataset.menuAction)).toEqual(['yellow', 'blue']);
    });

    it('selecting Info or Settings emits the color action to the host', () => {
      menu.show();
      menu.handleAction('select'); // Info (first row)
      expect(onAction).toHaveBeenCalledWith('yellow');
      menu.show();
      menu.handleAction('down');
      menu.handleAction('select'); // Settings (second row)
      expect(onAction).toHaveBeenCalledWith('blue');
    });
  });
});
