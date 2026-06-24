// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Channel, AudioTrackOption } from '../types';

const { channels } = vi.hoisted(() => {
  function makeChannel(over: Partial<Channel>): Channel {
    return {
      id: '', name: '', logo: '', group: '', url: '', extras: null,
      playlist: '', catchup: '', catchupSource: '', catchupDays: 0, ...over,
    };
  }
  return { channels: [makeChannel({ id: 'a', name: 'Alpha' })] as Channel[] };
});

vi.mock('../services/playlist-service', () => ({
  PlaylistService: {
    channels,
    playlistNames: [],
    getByIndex: (i: number) => channels[i],
  },
}));

import { PlayerMenu } from './player-menu';

// Number of colour actions before the "Audio Track" row in the main menu.
const MENU_ACTIONS = 4;

let container: HTMLElement;
let el: HTMLElement;
let getCurrentIndex: ReturnType<typeof vi.fn>;
let onAction: ReturnType<typeof vi.fn>;
let getAudioTracks: ReturnType<typeof vi.fn>;
let selectAudioTrack: ReturnType<typeof vi.fn>;
let audioTracks: AudioTrackOption[];
let menu: PlayerMenu;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  el = document.createElement('div');
  el.id = 'player-menu';
  el.className = 'player-menu hidden';
  container.appendChild(el);
  document.body.appendChild(container);

  getCurrentIndex = vi.fn(() => 0);
  onAction = vi.fn();
  audioTracks = [];
  getAudioTracks = vi.fn(() => audioTracks);
  selectAudioTrack = vi.fn();
  menu = new PlayerMenu(container, getCurrentIndex, onAction, getAudioTracks, selectAudioTrack);
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
      expect(rows[0].dataset.menuAction).toBe('__audio_back__');
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
});
