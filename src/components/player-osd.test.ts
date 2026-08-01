// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import type { Channel, Programme } from '../types';
import type { DvrState } from '../utils/dvr';
import { PlayerOsd, type PlayerOsdOptions, type PlayerOsdSnapshot } from './player-osd';

const CHANNEL: Channel = {
  id: 'ch1',
  name: 'Alpha',
  logo: 'http://host/logo',
  group: 'Group 1',
  url: 'http://host/a',
  extras: null,
  playlistIds: [],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
};

const PROGRAMME: Programme = {
  start: new Date('2026-01-01T10:00:00Z'),
  stop: new Date('2026-01-01T11:00:00Z'),
  title: 'Programme 1',
  description: 'Description 1',
  category: 'Category 1',
  icon: 'http://host/icon',
};

function playback(duration: number, position = 0, paused = false) {
  return { duration, position, paused };
}

function snapshot(overrides: Partial<PlayerOsdSnapshot> = {}): PlayerOsdSnapshot {
  return {
    playback: null,
    channel: CHANNEL,
    channelNumber: 1,
    catchup: null,
    vodTitle: null,
    upNextSeconds: 0,
    dvr: null,
    nowPlaying: null,
    upcoming: null,
    streamInfo: null,
    ...overrides,
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  } as DOMRect;
}

describe('PlayerOsd', () => {
  let container: HTMLElement;
  let state: PlayerOsdSnapshot;
  let callbacks: PlayerOsdOptions;
  let osd: PlayerOsd;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.innerHTML = '<div id="player-osd"></div>';
    document.body.appendChild(container);
    state = snapshot();
    callbacks = {
      getSnapshot: () => state,
      canAutoReveal: () => true,
      canSeek: () => true,
      onSeekFraction: vi.fn(),
      onPauseToggle: vi.fn(),
      onGoLive: vi.fn(),
      onResync: vi.fn(),
      onPlayNext: vi.fn(),
      onCancelNext: vi.fn(),
    };
    osd = new PlayerOsd(container, callbacks);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows, hides, auto-reveals, and stays visible while paused', () => {
    state = snapshot({ playback: playback(120), vodTitle: 'Video 1' });

    osd.show();
    expect(osd.isVisible()).toBe(true);
    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(CONFIG.PLAYER.OSD_TIMEOUT);
    expect(osd.isVisible()).toBe(false);

    container.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 12,
      clientY: 34,
    }));
    expect(osd.isVisible()).toBe(true);
    expect(osd.pointerPosition()).toEqual({ x: 12, y: 34 });

    state = { ...state, playback: playback(120, 0, true) };
    osd.resetTimer();
    vi.advanceTimersByTime(CONFIG.PLAYER.OSD_TIMEOUT);
    expect(osd.isVisible()).toBe(true);

    osd.clearPointer();
    osd.hide();
    expect(osd.pointerPosition()).toEqual({ x: null, y: null });
    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(true);
  });

  it('renders representative Live, catch-up, VOD, and up-next layouts', () => {
    state = snapshot({
      playback: playback(120, 30),
      nowPlaying: PROGRAMME,
      upcoming: { ...PROGRAMME, title: 'Programme 2' },
      streamInfo: {
        resolution: { tier: 'hd', label: 'Info 1' },
        hdr: 'HDR',
        fps: '30',
        videoCodec: 'Codec 1',
        audioCodec: 'Codec 2',
        audio: 'Track 1',
        subtitle: 'Track 2',
      },
    });
    osd.show();
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Programme 1');
    expect(container.textContent).toContain('Programme 2');
    expect(container.textContent).toContain('Info 1');
    expect(container.textContent).toContain('HDR');
    expect(container.textContent).toContain('30fps');
    expect(container.textContent).toContain('Codec 1');

    state = snapshot({
      playback: playback(120, 30),
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 3',
        description: 'Description 3',
        icon: '',
      },
    });
    osd.render();
    expect(container.textContent).toContain('Programme 3');
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(container.querySelector('[data-resync]')).not.toBeNull();

    state = snapshot({ playback: playback(120, 30), channel: null, vodTitle: 'Video 1' });
    osd.render();
    expect(container.querySelector('.osd-channel-name')?.textContent).toContain('Video 1');
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('25%');

    state = { ...state, vodTitle: 'Video 2', upNextSeconds: 5 };
    osd.render();
    expect(container.textContent).toContain('Video 2');
    expect(container.querySelector('[data-next-play]')).not.toBeNull();
    expect(container.querySelector('[data-next-cancel]')).not.toBeNull();
  });

  it('refreshes progress and switches an open Live OSD to the DVR layout', () => {
    state = snapshot({ playback: playback(Infinity, 30), nowPlaying: PROGRAMME });
    osd.show();
    expect(container.querySelector('[data-golive]')).toBeNull();

    const dvr: DvrState = {
      start: 0,
      end: 60,
      length: 60,
      position: 30,
      fraction: 0.5,
      behindLive: 30,
      atLiveEdge: false,
    };
    state = { ...state, dvr };
    osd.refreshProgress();
    expect(container.querySelector('[data-golive]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('50%');

    state = { ...state, dvr: { ...dvr, fraction: 0.75, behindLive: 15 } };
    osd.refreshProgress();
    expect(container.querySelector<HTMLElement>('.osd-progress-bar')?.style.width).toBe('75%');
    expect(container.querySelector('.osd-dvr-behind')?.textContent).toBe('-0:15');
  });

  it('routes pointer seeks and control clicks through callbacks', () => {
    state = snapshot({
      playback: playback(120, 30),
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 1',
        description: '',
        icon: '',
      },
    });
    osd.show();

    const seekbar = container.querySelector('[data-seekbar]') as HTMLElement;
    seekbar.getBoundingClientRect = () => rect(100, 50, 400, 20);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 400,
      clientY: 60,
    }));
    expect(callbacks.onSeekFraction).toHaveBeenCalledWith(0.75);

    const pause = container.querySelector('[data-playpause]') as HTMLElement;
    pause.getBoundingClientRect = () => rect(10, 10, 30, 30);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    }));
    expect(callbacks.onPauseToggle).toHaveBeenCalledOnce();

    const resync = container.querySelector('[data-resync]') as HTMLElement;
    resync.getBoundingClientRect = () => rect(600, 10, 30, 30);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 610,
      clientY: 20,
    }));
    expect(callbacks.onResync).toHaveBeenCalledOnce();

    state = snapshot({
      playback: playback(120, 30),
      channel: null,
      vodTitle: 'Video 2',
      upNextSeconds: 5,
    });
    osd.render();
    const playNext = container.querySelector('[data-next-play]') as HTMLElement;
    playNext.getBoundingClientRect = () => rect(50, 100, 80, 30);
    container.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 60,
      clientY: 110,
    }));
    expect(callbacks.onPlayNext).toHaveBeenCalledOnce();
  });

  it('reuses keyed programme icons and removes failed URLs until cleared', () => {
    state = snapshot({
      catchup: {
        start: 1_000_000,
        end: 1_000_120,
        title: 'Programme 1',
        description: '',
        icon: 'http://host/icon',
      },
    });
    osd.show();
    const first = container.querySelector('.osd-programme-icon');
    expect(first).not.toBeNull();

    osd.render();
    expect(container.querySelector('.osd-programme-icon')).toBe(first);

    first?.dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull();
    osd.render();
    expect(container.querySelector('.osd-programme-icon')).toBeNull();

    osd.clearFailedIcons();
    osd.render();
    expect(container.querySelector('.osd-programme-icon')).not.toBeNull();
  });
});
