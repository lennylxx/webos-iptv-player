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
  menu = new PlayerMenu(
    container, getCurrentChannel, onAction,
    getAudioTracks, selectAudioTrack,
    getSubtitleTracks, selectSubtitleTrack,
    getSubtitleOffsetState, openSubtitleOffset,
  );
});

afterEach(() => {
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
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(items()[2].classList.contains('focused')).toBe(true);
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

    it('routes the Search online row through selectSubtitleTrack(-3)', () => {
      subtitleTracks = [{ index: -3, label: 'Search online…', active: false, available: true }];
      menu.show();
      for (let i = 0; i < MENU_ACTIONS; i++) menu.handleAction('down');
      menu.handleAction('select');     // open picker
      menu.handleAction('down');       // move past "Off" to "Search online…"
      menu.handleAction('select');
      expect(selectSubtitleTrack).toHaveBeenCalledWith(-3);
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
