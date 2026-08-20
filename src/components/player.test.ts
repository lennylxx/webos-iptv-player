// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { healthMock, playlistMock } = vi.hoisted(() => ({
  healthMock: {
    recordPlaybackFailure: vi.fn().mockResolvedValue(undefined),
    recordPlaybackSuccess: vi.fn().mockResolvedValue(false),
  },
  playlistMock: { channels: [] as unknown[], getByIndex: vi.fn(), indexOf: vi.fn() },
}));

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null, getUpcoming: () => [] },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    setLastChannel: vi.fn(), setLastChannelKey: vi.fn(),
    getSubtitlePref: vi.fn(), setSubtitlePref: vi.fn(),
    getAudioPref: vi.fn(), setAudioPref: vi.fn(),
    setResume: vi.fn(), clearResume: vi.fn(),
    removeWatchlist: vi.fn(),
    getPickedOnlineSub: vi.fn(), setPickedOnlineSub: vi.fn(),
    setCatchupProgress: vi.fn(), getCatchupProgress: vi.fn(), clearCatchupProgress: vi.fn(),
    touchRecentlyWatchedLive: vi.fn(),
    getSubtitleOffset: vi.fn(() => 0), setSubtitleOffset: vi.fn(),
  },
}));
vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('../services/media-probe', () => ({ probeMedia: vi.fn() }));
vi.mock('../services/subtitle-search/subtitle-search-service', () => ({
  subtitleSearchService: { isAvailable: () => false },
}));

import { Player } from './player';
import {
  containerMime,
  diagnosticStreamUrl,
  extFromUrl,
  sniffStreamContentType,
  streamMime,
  streamRouteKey,
  streamUrlMime,
} from '../utils/url';
import { StorageService } from '../services/storage-service';
import { showToast } from './toast';
import { probeMedia } from '../services/media-probe';
import { CONFIG } from '../config';
import { channelKey, legacyChannelKey } from '../utils/channel';

const CHANNEL = {
  id: 'c1', name: 'Chan', logo: '', group: '', url: 'http://host/play/c1', extras: null,
  playlistIds: [], catchup: 'default', catchupSource: 'http://host/catchup/c1?start={utc}&end={utcend}', catchupDays: 7,
};
// Channel without catchupSource — catch-up progress must never be written.
const CHANNEL_NO_CATCHUP = {
  id: 'c2', name: 'NoCatchup', logo: '', group: '', url: 'http://host/play/c2', extras: null,
  playlistIds: [], catchupDays: 0,
};
const XTREAM_CHANNEL = {
  ...CHANNEL,
  catchup: 'xtream',
  catchupSource: 'http://host/timeshift/u1/p1/{duration}/{start}/42.ts',
  catchupFallbackSource: 'http://host/streaming/timeshift.php?username=u1&password=p1' +
    '&stream=42&start={start}&duration={duration}&extension=ts',
  catchupTimeZone: 'America/New_York',
};
// 120-second catch-up programme.
const CATCHUP = { start: 1_000_000, end: 1_000_120, title: 'Prog', description: '', icon: '' };

// A stand-in <video> with controllable duration/currentTime — jsdom's real one
// reports duration NaN and ignores currentTime without a media source.
function fakeVideo(duration: number): HTMLVideoElement {
  let currentTime = 0;
  let src = '';
  let paused = false;
  const listeners: Record<string, Array<() => void>> = {};
  return {
    duration,
    get currentTime() { return currentTime; },
    set currentTime(t: number) { currentTime = t; },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  } as unknown as HTMLVideoElement;
}

function fakeAsyncSeekVideo(duration: number) {
  let currentTime = 0;
  let requestedTime = 0;
  const requestedTimes: number[] = [];
  let paused = false;
  let src = '';
  const listeners: Record<string, Array<() => void>> = {};
  const video = {
    duration,
    get currentTime() { return currentTime; },
    set currentTime(t: number) { requestedTime = t; requestedTimes.push(t); },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  };
  return {
    video: video as unknown as HTMLVideoElement,
    requestedTime: () => requestedTime,
    requestedTimes,
    settleSeek: (time = requestedTime) => {
      currentTime = time;
      video.dispatchEvent(new Event('seeked'));
    },
  };
}

// A live <video> stand-in: duration Infinity and a single seekable range (the DVR
// window), with a mutable window so tests can simulate it rolling forward.
function fakeLiveVideo(start: number, end: number, currentTime = 0) {
  let ct = currentTime;
  let paused = false;
  let src = '';
  let w = { start, end };
  const listeners: Record<string, Array<() => void>> = {};
  const video = {
    duration: Infinity,
    get currentTime() { return ct; },
    set currentTime(t: number) { ct = t; },
    get paused() { return paused; },
    get src() { return src; },
    set src(v: string) { src = v; },
    seekable: { length: 1, start: () => w.start, end: () => w.end },
    classList: { add() {}, remove() {} },
    canPlayType: () => '',
    get currentSrc() { return src; },
    getAttribute: () => null,
    querySelector: () => null,
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  };
  return {
    video: video as unknown as HTMLVideoElement,
    setWindow: (s: number, e: number) => { w = { start: s, end: e }; },
  };
}

let container: HTMLElement;
let player: Player;
let video: HTMLVideoElement;
let allowAutoRevealOsd: boolean;
let onHealthChanged: ReturnType<typeof vi.fn>;

// The desktop path probes the stream's Content-Type before routing; stub it so
// tests stay offline and deterministic (HLS → hls.js fallback sets video.src).
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    headers: { get: () => 'application/vnd.apple.mpegurl' },
    body: { cancel: async () => {} },
  })));
  document.body.innerHTML = '';
  container = document.createElement('div');
  const osd = document.createElement('div');
  osd.id = 'player-osd';
  container.appendChild(osd);
  document.body.appendChild(container);
  playlistMock.getByIndex.mockReturnValue(CHANNEL);
  playlistMock.indexOf.mockReturnValue(0);
  healthMock.recordPlaybackFailure.mockClear();
  healthMock.recordPlaybackSuccess.mockReset();
  healthMock.recordPlaybackSuccess.mockResolvedValue(false);
  vi.mocked(probeMedia).mockResolvedValue(null);
  allowAutoRevealOsd = true;
  onHealthChanged = vi.fn();
  player = new Player(
    container,
    vi.fn(),
    undefined,
    () => allowAutoRevealOsd,
    onHealthChanged,
  );
  video = fakeVideo(120);
  player.init(video);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bar = () => container.querySelector('.osd-progress-bar') as HTMLElement;
const elapsed = () => container.querySelector('.osd-time-current')!.textContent;

describe('Player pointer OSD reveal', () => {
  it('does not reveal a hidden OSD while a player overlay is open', () => {
    player.hideOSD();
    allowAutoRevealOsd = false;

    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(true);
  });

  it('keeps an already visible OSD visible while a player overlay is open', () => {
    player.showOSD();
    allowAutoRevealOsd = false;

    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(container.querySelector('#player-osd')?.classList.contains('hidden')).toBe(false);
  });
});

describe('Player catch-up seeking', () => {
  beforeEach(() => player.play(0, CATCHUP)); // catch-up → OSD shown, seekable

  it('renders a seek bar showing the playback position and total', () => {
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(elapsed()).toBe('0:00');
    expect(container.querySelector('.osd-time-end')!.textContent).toBe('2:00');
    expect(player.canSeek()).toBe(true);
  });

  it('Right seeks forward by the step, Left back; the bar + label follow', () => {
    player.handleAction('right');
    expect(video.currentTime).toBe(30);
    expect(bar().style.width).toBe('25%');
    expect(elapsed()).toBe('0:30');

    player.handleAction('right');
    expect(video.currentTime).toBe(60);
    expect(bar().style.width).toBe('50%');

    player.handleAction('left');
    expect(video.currentTime).toBe(30);
  });

  it('accumulates repeated seeks while the native position is still stale', () => {
    const asyncVideo = fakeAsyncSeekVideo(120);
    video = asyncVideo.video;
    player.init(video);
    player.play(0, CATCHUP);

    player.handleAction('right');
    expect(asyncVideo.requestedTime()).toBe(30);
    expect(elapsed()).toBe('0:30');

    video.dispatchEvent(new Event('timeupdate'));
    expect(elapsed()).toBe('0:30');

    player.handleAction('right');
    expect(asyncVideo.requestedTime()).toBe(60);
    expect(bar().style.width).toBe('50%');
    expect(elapsed()).toBe('1:00');

    video.dispatchEvent(new Event('timeupdate'));
    expect(elapsed()).toBe('1:00');
    asyncVideo.settleSeek(30);
    expect(asyncVideo.requestedTimes).toEqual([30, 60, 60]);
    expect(elapsed()).toBe('1:00');

    asyncVideo.settleSeek(60);
    expect(elapsed()).toBe('1:00');
  });

  it('clamps seeks to [0, duration]', () => {
    player.handleAction('left'); // 0 - 30 → 0
    expect(video.currentTime).toBe(0);
    for (let i = 0; i < 5; i++) player.handleAction('right'); // 150 → clamp 120
    expect(video.currentTime).toBe(120);
  });

  const stubBar = () => {
    const seekbar = container.querySelector('[data-seekbar]') as HTMLElement;
    seekbar.getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 36 }) as DOMRect;
  };

  it('a pointer release over the bar seeks to that fraction of the duration', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 750, clientY: 18 }));
    expect(video.currentTime).toBe(90); // 0.75 * 120
  });

  it('OK while the cursor is over the bar seeks to the pointer position', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    player.handleAction('select');
    expect(video.currentTime).toBe(30); // 0.25 * 120
  });

  it('OK away from the bar pauses playback instead of seeking', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 500 })); // off the bar
    player.handleAction('select');
    expect(video.currentTime).toBe(0); // not seeked
    expect(video.paused).toBe(true); // paused instead
  });

  it('a d-pad press clears the cursor so OK pauses instead of seeking', () => {
    stubBar();
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    player.handleAction('right'); // d-pad seek clears the tracked cursor
    expect(video.currentTime).toBe(30);
    player.handleAction('select');
    expect(video.paused).toBe(true); // paused (cursor cleared), not seeked to the stale pointer
  });

  it('is no longer seekable once the OSD hides', () => {
    player.hideOSD();
    expect(player.canSeek()).toBe(false);
  });
});

describe('Player catch-up pause/play', () => {
  beforeEach(() => player.play(0, CATCHUP)); // catch-up → OSD shown, finite duration

  it('renders a play/pause control', () => {
    expect(container.querySelector('[data-playpause]')).not.toBeNull();
  });

  it('OK (OSD up, cursor off the bar) pauses then resumes playback', () => {
    expect(video.paused).toBe(false);
    player.handleAction('select'); // OSD up + catch-up → pause
    expect(video.paused).toBe(true);
    player.handleAction('select'); // resume
    expect(video.paused).toBe(false);
  });

  it('the pause/play remote keys toggle playback', () => {
    player.handleAction('pause');
    expect(video.paused).toBe(true);
    player.handleAction('play');
    expect(video.paused).toBe(false);
  });

  // The control is driven from click by coordinates — mirror the live DVR
  // play/pause test.
  it('a pointer click on the play/pause control pauses playback', () => {
    const btn = container.querySelector('[data-playpause]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 10, right: 42, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 26, clientY: 16 }));
    expect(video.paused).toBe(true);
  });

  it('resyncAV seeks backward by RESYNC_SEEK_BACK to force a pipeline re-lock', () => {
    player.handleAction('right'); // → 30
    player.handleAction('right'); // → 60
    player.resyncAV();
    expect(video.currentTime).toBe(60 - CONFIG.PLAYER.RESYNC_SEEK_BACK);
  });

  it('resyncAV clamps the seek target at 0', () => {
    video.currentTime = 0.3;
    player.resyncAV();
    expect(video.currentTime).toBe(0);
  });

  it('resyncAV debounces while a resync is already in flight', () => {
    player.handleAction('right'); // → 30
    player.handleAction('right'); // → 60
    player.resyncAV();            // → 59.5, now resyncing
    expect(video.currentTime).toBe(60 - CONFIG.PLAYER.RESYNC_SEEK_BACK);
    video.currentTime = 100;      // pretend playback advanced
    player.resyncAV();            // no-op while resyncing
    expect(video.currentTime).toBe(100);
  });

  it('shows a Resyncing… message and clears it once playback resumes', () => {
    const osd = container.querySelector('#player-osd')!;
    player.resyncAV();
    expect(osd.textContent).toContain('Resyncing');
    video.dispatchEvent(new Event('playing'));
    expect(osd.textContent).not.toContain('Resyncing');
  });

  it('a pointer click on the resync control seeks backward', () => {
    player.handleAction('right'); // → 30
    player.handleAction('right'); // → 60
    const btn = container.querySelector('[data-resync]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 900, right: 932, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 916, clientY: 16 }));
    expect(video.currentTime).toBe(60 - CONFIG.PLAYER.RESYNC_SEEK_BACK);
  });
});

describe('Player catch-up completion', () => {
  it('resolves an Xtream timeshift URL in the provider timezone', async () => {
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    player.play(0, {
      ...CATCHUP,
      start,
      end: start + 3661,
    });
    await flush();
    expect(video.src)
      .toContain('/timeshift/u1/p1/62/2026-07-21:15-30/42.ts');
  });

  it('retries a failed Xtream catch-up through the legacy PHP endpoint', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const realVideo = document.createElement('video');
    container.appendChild(realVideo);
    player.init(realVideo);
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;

    player.play(0, { ...CATCHUP, start, end: start + 3600 });
    await flush();
    expect(realVideo.src).toContain('/timeshift/');

    realVideo.dispatchEvent(new Event('error'));
    await flush();
    const fallbackVideo = container.querySelector('video')!;
    expect(fallbackVideo.src).toContain(
      '/streaming/timeshift.php?username=u1&password=p1&stream=42' +
      '&start=2026-07-21:15-30&duration=60&extension=ts',
    );

    fallbackVideo.dispatchEvent(new Event('error'));
    expect(container.querySelector('video')).toBe(fallbackVideo);
  });

  it('resumes the channel live stream when the catch-up programme ends', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    container.appendChild(v);
    const onPlaybackChanged = vi.fn();
    player = new Player(container, vi.fn(), onPlaybackChanged);
    player.init(v);

    player.play(0, CATCHUP);
    await flush();
    expect(container.querySelector('video')!.src).toContain('/catchup/');
    expect(player.canSeek()).toBe(true);

    container.querySelector('video')!.dispatchEvent(new Event('ended'));
    await flush();

    expect(container.querySelector('video')!.src).toContain('/play/'); // live URL on the fresh element
    expect(player.canSeek()).toBe(false); // live, not seekable
    expect(onPlaybackChanged).toHaveBeenLastCalledWith(0, null);
  });
});

describe('Player live playback', () => {
  it('has no seek bar and is not seekable', () => {
    player.play(0); // live, no catch-up
    expect(player.canSeek()).toBe(false);
    expect(container.querySelector('[data-seekbar]')).toBeNull();
  });

  it('clears the visible index when the playing channel is hidden', () => {
    const onPlaybackChanged = vi.fn();
    player = new Player(container, vi.fn(), onPlaybackChanged);
    player.init(video);
    player.play(0);
    playlistMock.indexOf.mockReturnValue(-1);

    player.syncCurrentIndex();

    expect(player.getCurrentIndex()).toBe(-1);
    expect(player.getCurrentChannel()).toBe(CHANNEL);
    expect(onPlaybackChanged).toHaveBeenLastCalledWith(-1, null);
  });

  it('ignores the outgoing stream\'s state until the new source is attached', async () => {
    playlistMock.channels = [{}, {}];
    // Left over from the channel that just failed; the next load has not
    // reached the element yet (webOS probes the content type first).
    Object.assign(video, { readyState: 0, networkState: 3 });
    player.play(0);
    await flush();
    playlistMock.getByIndex.mockClear();
    healthMock.recordPlaybackFailure.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);

    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
  });

  it('leaves a live stream that never starts to the stall watchdog', async () => {
    playlistMock.channels = [{}, {}];
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('loadstart'));
    playlistMock.getByIndex.mockClear();
    healthMock.recordPlaybackFailure.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
  });

  it('coalesces repeated playback errors into one channel advance', async () => {
    playlistMock.channels = [{}, {}];
    player.play(0);
    playlistMock.getByIndex.mockClear();

    for (let i = 0; i < 20; i++) video.dispatchEvent(new Event('error'));
    await flush();
    vi.advanceTimersByTime(2000);

    expect(playlistMock.getByIndex).toHaveBeenCalledTimes(1);
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledOnce();
    expect(healthMock.recordPlaybackFailure)
      .toHaveBeenCalledWith(CHANNEL, 'playback_error');
    expect(onHealthChanged).toHaveBeenCalledOnce();
  });

  it('starts the OSD hide timer when startup playback begins', async () => {
    video.pause();
    player.showOSD();
    vi.advanceTimersByTime(CONFIG.PLAYER.OSD_TIMEOUT);
    expect((container.querySelector('#player-osd') as HTMLElement).style.display).not.toBe('none');

    await video.play();
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.PLAYER.OSD_TIMEOUT);

    expect((container.querySelector('#player-osd') as HTMLElement).style.display).toBe('none');
  });

  it('refreshes health UI only when passive success updates a tracked channel', async () => {
    healthMock.recordPlaybackSuccess.mockResolvedValueOnce(false);
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    await flush();
    expect(onHealthChanged).not.toHaveBeenCalled();

    healthMock.recordPlaybackSuccess.mockResolvedValueOnce(true);
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    await flush();
    expect(onHealthChanged).toHaveBeenCalledOnce();
  });
});

describe('Player Recently Watched recording', () => {
  const touchLive = () => vi.mocked(StorageService.touchRecentlyWatchedLive);

  beforeEach(() => {
    touchLive().mockClear();
  });

  it('records live playback after five continuous seconds', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS - 1);
    expect(touchLive()).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(touchLive()).toHaveBeenCalledWith(channelKey(CHANNEL));
  });

  it('does not record Catch-up playback as live', () => {
    player.play(0, CATCHUP);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('cancels a pending live record when playback buffers', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);
    video.dispatchEvent(new Event('waiting'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('keeps the pending live record through a spurious stalled event', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);
    video.dispatchEvent(new Event('stalled'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS - 2000);

    expect(touchLive()).toHaveBeenCalledWith(channelKey(CHANNEL));
  });

  it('cancels the abandoned playback generation', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(2000);

    player.play(1);
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).not.toHaveBeenCalled();
  });

  it('deduplicates repeated playing events in one playback generation', () => {
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.RECENTLY_WATCHED.LIVE_CONFIRM_MS);
    expect(touchLive()).toHaveBeenCalledTimes(1);
  });
});

describe('Player native subtitle retry', () => {
  it('re-applies only the native subtitle compositor once playback starts', () => {
    const apply = vi.fn();
    const internals = player as unknown as {
      tracks: { reapplyNativeSubtitleCompositor: () => void };
    };
    internals.tracks.reapplyNativeSubtitleCompositor = apply;

    video.dispatchEvent(new Event('playing'));

    expect(apply).toHaveBeenCalledOnce();
  });
});

describe('Player live DVR', () => {
  let live: HTMLVideoElement;
  let setWindow: (s: number, e: number) => void;
  const PAD = CONFIG.PLAYER.DVR_GO_LIVE_PAD;
  const OLDEST_PAD = CONFIG.PLAYER.DVR_OLDEST_PAD;

  beforeEach(() => {
    ({ video: live, setWindow } = fakeLiveVideo(0, 60, 60)); // 60s window, at the live edge
    player.init(live);
    player.play(0); // live, no catch-up → OSD shown
  });

  it('is seekable within the window and shows a seek bar', () => {
    expect(player.canSeek()).toBe(true);
    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
  });

  it('resyncAV is a no-op on live (no finite decode to re-lock)', () => {
    expect(live.currentTime).toBe(60);
    player.resyncAV();
    expect(live.currentTime).toBe(60);
    expect(container.querySelector('[data-resync]')).toBeNull();
  });

  it('Left rewinds by the step, moving the bar', () => {
    player.handleAction('left'); // 60 - 30 = 30
    expect(live.currentTime).toBe(30);
    expect((container.querySelector('.osd-progress-bar') as HTMLElement).style.width).toBe('50%');
  });

  it('Right near the live edge snaps to the edge (end - pad)', () => {
    player.handleAction('right'); // 60 + 30 → clamp 60 → snap 60 - PAD
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('rewind jumps to the oldest point, fast_forward to live', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);
    player.handleAction('fast_forward');
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('pause/play and OK toggle playback', () => {
    player.handleAction('pause');
    expect(live.paused).toBe(true);
    player.handleAction('play');
    expect(live.paused).toBe(false);
    player.handleAction('select'); // OSD up + live DVR → pause
    expect(live.paused).toBe(true);
  });

  it('clamps to the window start when resuming after it rolled past the paused point', () => {
    player.handleAction('rewind');
    player.handleAction('pause');
    setWindow(20, 80); // window rolled forward while paused
    player.handleAction('play');
    expect(live.currentTime).toBe(20 + OLDEST_PAD);
  });

  it('re-enters the sliding window when a manifest refresh overtakes playback', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);

    setWindow(10, 70);
    live.dispatchEvent(new Event('progress'));

    expect(live.currentTime).toBe(10 + OLDEST_PAD);
  });

  // The OSD controls are driven from click by coordinates, like the seek bar.
  it('a pointer click on the pause control pauses playback', () => {
    const btn = container.querySelector('[data-playpause]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 10, right: 42, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 26, clientY: 16 }));
    expect(live.paused).toBe(true);
  });

  it('a pointer release on the Go-to-Live control seeks to the live edge', () => {
    player.handleAction('rewind');
    expect(live.currentTime).toBe(OLDEST_PAD);
    const btn = container.querySelector('[data-golive]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 500, right: 560, width: 60, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 530, clientY: 16 }));
    expect(live.currentTime).toBe(60 - PAD);
  });

  it('reveals the DVR bar once the window becomes available, without reopening the OSD', () => {
    // Tune in to a live stream whose seekable window is not usable yet.
    const { video: v2, setWindow } = fakeLiveVideo(0, 3, 0); // 3s < DVR_MIN_WINDOW
    player.init(v2);
    player.play(0); // OSD shown, but no DVR window yet
    expect(container.querySelector('[data-seekbar]')).toBeNull();

    // The pipeline fills the retained window; the next timeupdate must switch the
    // OSD to the DVR layout on its own (no close/reopen).
    setWindow(0, 60);
    v2.dispatchEvent(new Event('timeupdate'));

    expect(container.querySelector('[data-seekbar]')).not.toBeNull();
    expect(container.querySelector('[data-playpause]')).not.toBeNull();
  });
});

describe('Player OSD image handling', () => {
  // renderOSD re-runs on pointer move (to keep the OSD fresh); it must reuse the
  // programme <img> instead of recreating it, and drop one that failed to load so
  // a broken image can't thrash the layout.
  it('reuses the programme icon element across re-renders instead of recreating it', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/a.jpg' });
    const img1 = container.querySelector('.osd-programme-icon');
    expect(img1).not.toBeNull();
    player.showOSD(); // a re-render (e.g. pointer moved into the OSD area)
    expect(container.querySelector('.osd-programme-icon')).toBe(img1); // same node → no reload
  });

  it('drops a programme icon that failed to load and does not re-request it', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/broken.jpg' });
    const img = container.querySelector('.osd-programme-icon') as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull(); // dropped on error
    player.showOSD(); // re-render must not bring it back
    expect(container.querySelector('.osd-programme-icon')).toBeNull();
  });

  it('retries a previously-failed icon on the next channel/programme (failure is per-visit)', () => {
    player.play(0, { ...CATCHUP, icon: 'http://host/x.jpg' });
    (container.querySelector('.osd-programme-icon') as HTMLImageElement).dispatchEvent(new Event('error'));
    expect(container.querySelector('.osd-programme-icon')).toBeNull();

    player.play(1, { ...CATCHUP, icon: 'http://host/x.jpg' }); // switch channel, same icon URL
    expect(container.querySelector('.osd-programme-icon')).not.toBeNull(); // fresh attempt
  });
});

describe('Player stall reconnect OSD', () => {
  it('clears the Reconnecting… message after the reloaded stream recovers', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);

    player.play(0); // live
    await flush();

    // A real stall reloads only after the OSD has auto-hidden (osdVisible false)
    // — the case the message used to get stuck in.
    vi.advanceTimersByTime(CONFIG.PLAYER.OSD_TIMEOUT + 100);

    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    await flush();
    const osd = container.querySelector('#player-osd')!;
    expect(osd.textContent).toContain('Reconnecting');

    // Recovery (loadedmetadata) must repaint over the message, not leave it stuck.
    container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    expect(osd.textContent).not.toContain('Reconnecting');
  });
});

describe('Player VOD mode', () => {
  const req = (over = {}) => ({
    url: 'http://host:8080/movie/u/p/10.mp4', title: 'Movie One', poster: '',
    accountId: 'x1', itemId: '10', kind: 'vod' as const, resumeSecs: 0, subtitles: [], onBack: vi.fn(), ...over,
  });

  let player: Player;
  let container: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = ''; // drop the outer beforeEach's #player-osd (a duplicate id breaks scoped querySelector)
    container = document.createElement('div');
    container.innerHTML = '<div id="player-osd"></div>';
    document.body.appendChild(container);
    player = new Player(container, () => {});
  });
  afterEach(() => { container.remove(); });

  it('seeks to the resume position once metadata is known', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req({ resumeSecs: 900 }));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(900);
    expect(player.isVod()).toBe(true);
  });

  it('is seekable while the OSD is up (finite duration)', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    expect(player.canSeek()).toBe(true); // playVod shows the OSD
  });

  it('resyncAV seeks backward by RESYNC_SEEK_BACK on VOD', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    video.currentTime = 900;
    player.resyncAV();
    expect(video.currentTime).toBe(900 - CONFIG.PLAYER.RESYNC_SEEK_BACK);
  });

  it('renders the VOD OSD through the Live markup (title + stream info, no .osd-vod)', () => {
    const video = fakeVideo(3600);
    (video as unknown as { videoHeight: number }).videoHeight = 1080;
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));
    const osd = container.querySelector('#player-osd')!;
    expect(osd.querySelector('.osd-vod')).toBeNull();
    expect(osd.querySelector('.osd-channel-name')?.textContent).toContain('Movie One');
    expect(osd.querySelector('.osd-stream-info')?.textContent).toContain('1080p');
    expect(osd.querySelector('.osd-progress[data-seekbar]')).not.toBeNull();
  });

  it('merges probed codec/fps/HDR into the VOD OSD when the probe resolves', async () => {
    vi.mocked(probeMedia).mockResolvedValue({ videoCodec: 'hvc1', audioCodec: 'ec-3', width: 3840, height: 2160, fps: 24, hdr: 'PQ' });
    const video = fakeVideo(3600);
    (video as unknown as { videoHeight: number }).videoHeight = 2160;
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));
    await flush(); // let the probe promise resolve and re-render the OSD
    const info = container.querySelector('.osd-stream-info')?.textContent ?? '';
    expect(probeMedia).toHaveBeenCalledWith('http://host:8080/movie/u/p/10.mp4', 'x1|media_probe|vod|10');
    expect(info).toContain('4K');
    expect(info).toContain('HEVC');
    expect(info).toContain('24fps');
    expect(info).toContain('HDR');
  });

  it('saves the resume point and calls onBack on Back', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadedmetadata'));
    video.currentTime = 1200;
    player.handleAction('back');
    expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({ itemId: '10', position: 1200, duration: 3600, ext: 'mp4' }));
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false); // stop() cleared VOD state
  });

  it('stores the remaining episode queue with the resume point', () => {
    const video = fakeVideo(1800);
    player.init(video);
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode' as const, subtitles: [],
    };
    player.playVod(req({
      itemId: 'e1',
      kind: 'episode',
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
    video.currentTime = 300;
    player.handleAction('back');
    expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e1',
      episodeQueue: [next],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
  });

  it('clears resume and Watchlist state when a movie ends', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.clearResume).toHaveBeenCalledWith('x1', 'vod', '10');
    expect(StorageService.removeWatchlist).toHaveBeenCalledWith('x1', 'vod', '10');
    expect(r.onBack).toHaveBeenCalled();
  });

  it('counts down and starts the next movie from a Watchlist queue', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/movie/u/p/11.mp4', title: 'Movie Two',
      poster: '', accountId: 'x1', itemId: '11', kind: 'vod' as const, subtitles: [],
    };
    player.playVod(req({ watchlistQueue: [next] }));
    vi.mocked(probeMedia).mockClear();

    video.dispatchEvent(new Event('ended'));
    expect(container.textContent).toContain('Starts in 10 seconds');
    expect(container.textContent).toContain('Movie Two');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeMedia).toHaveBeenCalledWith(next.url, 'x1|media_probe|vod|11');
  });

  it('counts down and automatically starts the next episode', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode' as const, subtitles: [],
    };
    player.playVod(req({ itemId: 'e1', kind: 'episode', episodeQueue: [next] }));
    vi.mocked(probeMedia).mockClear();

    video.dispatchEvent(new Event('ended'));
    expect(container.textContent).toContain('Starts in 10 seconds');
    expect(container.textContent).toContain('Series One — S1E2');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeMedia).toHaveBeenCalledWith(next.url, 'x1|media_probe|episode|e2');
    expect(player.isVod()).toBe(true);
  });

  it('removes a series from Watchlist only after its final episode', () => {
    const video = fakeVideo(1800);
    player.init(video);
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(req({
      itemId: 'e2',
      kind: 'episode',
      episodeQueue: [],
      watchlistOwner: { kind: 'series', itemId: 's1' },
    }));
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.removeWatchlist).toHaveBeenCalledWith('x1', 'series', 's1');
  });

  it('keeps a series in Watchlist when another episode remains', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(req({
      itemId: 'e1',
      kind: 'episode',
      watchlistOwner: { kind: 'series', itemId: 's1' },
      episodeQueue: [{
        url: 'http://host/series/e2.mp4', title: 'Series One — S1E2',
        poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
        watchlistOwner: { kind: 'series', itemId: 's1' },
      }],
    }));
    video.dispatchEvent(new Event('ended'));
    expect(StorageService.removeWatchlist).not.toHaveBeenCalled();
  });

  it('cancels the next-episode countdown with Back', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const r = req({
      itemId: 'e1',
      kind: 'episode',
      episodeQueue: [{
        url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
        poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode', subtitles: [],
      }],
    });
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    player.handleAction('back');

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(r.onBack).toHaveBeenCalledTimes(1);
  });

  it('ignores channel up/down in VOD mode', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    expect(() => { player.handleAction('channel_up'); player.handleAction('up'); }).not.toThrow();
    expect(player.isVod()).toBe(true);
  });

  it('routes a playback error to onBack, not a channel change', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const r = req();
    player.playVod(r);
    playlistMock.channels = [{}, {}]; // non-empty so a stray channelUp would fire
    playlistMock.getByIndex.mockClear();
    vi.mocked(showToast).mockClear();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(3000); // let any (unwanted) channelUp timer run
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled(); // no channel playback
    expect(showToast).toHaveBeenCalled();
  });

  it('surfaces a source the element refused, which fires no error event', () => {
    const video = fakeVideo(3600);
    // NETWORK_NO_SOURCE: every <source> was skipped, so no 'error' ever arrives.
    Object.assign(video, { readyState: 0, networkState: 3 });
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_POLL_MS);

    // A rejected source never becomes currentSrc, so the URL comes from the request.
    expect(logged.mock.calls[0].join(' ')).toContain('url=http://host:8080/movie/***/***/10.mp4');
    logged.mockRestore();
    expect(showToast).toHaveBeenCalledWith('Unable to play this video.');
    expect(r.onBack).toHaveBeenCalled();
    expect(player.isVod()).toBe(false);
  });

  it('surfaces a VOD stream that never produces a frame', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 }); // NETWORK_LOADING forever
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);

    expect(showToast).toHaveBeenCalledWith('Unable to play this video.');
    expect(r.onBack).toHaveBeenCalled();
  });

  it('stops watching once the stream starts', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();
    Object.assign(video, { readyState: 4 });

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('does not fail a VOD that was still loading when the app was hidden', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();

    player.suspend();
    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(r.onBack).not.toHaveBeenCalled();
  });

  it('does not re-arm the startup watchdog for a VOD that already played', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    const r = req();
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    video.dispatchEvent(new Event('loadeddata')); // first frame decoded
    player.suspend();
    // Back from hidden mid-seek: readyState drops below HAVE_CURRENT_DATA
    // without the stream having failed to start.
    Object.assign(video, { readyState: 1 });
    vi.mocked(showToast).mockClear();

    player.resume();
    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT * 2);

    expect(showToast).not.toHaveBeenCalled();
    expect(r.onBack).not.toHaveBeenCalled();
  });

  it('does not clobber the resume point when Back is pressed before metadata loads', () => {
    const video = fakeVideo(NaN); // duration NaN — metadata not loaded yet
    player.init(video);
    const r = req();
    player.playVod(r);
    vi.mocked(StorageService.setResume).mockClear();
    player.handleAction('back');
    expect(StorageService.setResume).not.toHaveBeenCalled();
    expect(r.onBack).toHaveBeenCalled();
  });
});

describe('containerMime', () => {
  it('maps known progressive extensions to their container MIME', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.mkv')).toBe('video/x-matroska');
    expect(containerMime('http://host/movie/u/p/10.avi')).toBe('video/x-msvideo');
  });

  it('ignores query strings and fragments when reading the extension', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4?token=x')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.mkv#frag')).toBe('video/x-matroska');
  });

  it('claims no type for unknown or extension-less URLs', () => {
    expect(containerMime('http://host/movie/u/p/10.xyz')).toBe('');
    expect(containerMime('http://host/movie/u/p/10')).toBe('');
  });
});

describe('extFromUrl', () => {
  it('reads the lowercased extension, ignoring query and fragment', () => {
    expect(extFromUrl('http://host/movie/u/p/10.MP4')).toBe('mp4');
    expect(extFromUrl('http://host/series/u/p/e1.mkv?token=x')).toBe('mkv');
    expect(extFromUrl('http://host/series/u/p/e1.avi#frag')).toBe('avi');
    expect(extFromUrl('http://host/movie/u/p/10')).toBe('');
  });
});

describe('sniffStreamContentType', () => {
  it('recognizes an MPEG-TS body served as application/octet-stream', () => {
    const prefix = new Uint8Array(900);
    prefix[300] = 0x47;
    prefix[488] = 0x47;
    prefix[676] = 0x47;
    expect(sniffStreamContentType('application/octet-stream', prefix)).toBe('video/mp2t');
  });

  it('recognizes an HLS body served as application/octet-stream', () => {
    const prefix = new TextEncoder().encode('#EXTM3U\n#EXT-X-VERSION:3');
    expect(sniffStreamContentType('application/octet-stream', prefix))
      .toBe('application/vnd.apple.mpegurl');
  });

  it('leaves unknown binary and specific response types unchanged', () => {
    expect(sniffStreamContentType('application/octet-stream', new Uint8Array([1, 2, 3])))
      .toBe('application/octet-stream');
    expect(sniffStreamContentType('video/mp2t; charset=binary', new Uint8Array()))
      .toBe('video/mp2t');
  });
});

describe('stream routing', () => {
  it('classifies stream URLs by extension path or query parameter', () => {
    expect(streamUrlMime('http://host/live/ch1.TS?token=x')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/live?id=ch1&extension=ts#fragment')).toBe('video/mp2t');
    expect(streamUrlMime('http://host/live/ch1.FLV#fragment')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/live?extension=FLV&token=x')).toBe('video/x-flv');
    expect(streamUrlMime('http://host/live/ch1.m3u8?token=x'))
      .toBe('application/vnd.apple.mpegurl');
    expect(streamUrlMime('http://host/live?extension=flv2')).toBe('');
  });

  it('groups extension-less channels by origin and route prefix', () => {
    expect(streamRouteKey('http://host/play/ch1')).toBe('http://host/play');
    expect(streamRouteKey('http://host/play/ch2?token=x')).toBe('http://host/play');
    expect(streamRouteKey('http://host/catchup/ch1')).toBe('http://host/catchup');
    expect(streamRouteKey('not a url')).toBe('');
  });

  it('separates routes by the requested live output format', () => {
    // The same route serves a different container per requested format, so a
    // probe of one must not classify the other.
    expect(streamRouteKey('http://host/live/ch1?output_format=m3u8'))
      .toBe('http://host/live?output=m3u8');
    expect(streamRouteKey('http://host/live/ch1?output_format=ts'))
      .toBe('http://host/live?output=ts');
    expect(streamRouteKey('http://host/live/ch1?output=m3u8'))
      .toBe('http://host/live?output=m3u8');
    expect(streamRouteKey('http://host/live/ch1?output_format=ts&token=x'))
      .toBe('http://host/live?output=ts');
  });

  it('redacts stream credentials while retaining diagnostic routing data', () => {
    expect(diagnosticStreamUrl(
      'http://user:pass@host/timeshift/u1/p1/60/start/42.ts?token=x&start=10&end=20',
    )).toBe(
      'http://***:***@host/timeshift/***/***/60/start/42.ts?token=***&start=10&end=20',
    );
    expect(diagnosticStreamUrl(
      'http://host/catchup/ch1.m3u8?start=10&end=20&auth=secret',
    )).toBe('http://host/catchup/ch1.m3u8?start=10&end=20&auth=***');
  });

  it('maps detected content types to native MIME values', () => {
    expect(streamMime('video/mp2t')).toBe('video/mp2t');
    expect(streamMime('video/x-flv')).toBe('video/x-flv');
    expect(streamMime('video/mp4; charset=binary')).toBe('video/mp4');
    expect(streamMime('application/vnd.apple.mpegurl')).toBe('application/vnd.apple.mpegurl');
    expect(streamMime('application/octet-stream')).toBe('');
    expect(streamMime('')).toBe('');
  });
});

describe('Player catch-up save/restore lifecycle', () => {
  // Outer beforeEach provides: player (with fakeVideo(120) via player.init(video)), video
  const setCatchupProgress = () => vi.mocked(StorageService.setCatchupProgress);

  beforeEach(() => {
    setCatchupProgress().mockClear();
  });

  it('applies resumeSecs from CatchupInfo on loadedmetadata', () => {
    player.play(0, { ...CATCHUP, resumeSecs: 45 });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(45);
  });

  it('restores and persists progress for Xtream catch-up', async () => {
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    player.play(0, {
      ...CATCHUP,
      start,
      end: start + 3600,
      resumeSecs: 45,
    });
    await flush();

    expect(video.src).toContain('/timeshift/u1/p1/60/2026-07-21:15-30/42.ts');
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(45);

    video.currentTime = 70;
    setCatchupProgress().mockClear();
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: channelKey(XTREAM_CHANNEL),
        progStart: start * 1000,
        progEnd: (start + 3600) * 1000,
        position: 70,
      }),
      XTREAM_CHANNEL.catchupDays,
    );
  });

  it('clamps resumeSecs to duration-1 if it would overshoot', () => {
    player.play(0, { ...CATCHUP, resumeSecs: 999 });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(119); // Math.min(999, 120-1)
  });

  it('does not seek when resumeSecs is absent', () => {
    player.play(0, CATCHUP);
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(0);
  });

  it('saves on pause with channelKey, progStart epoch ms, and position', () => {
    player.play(0, CATCHUP);
    video.currentTime = 60;
    setCatchupProgress().mockClear();
    player.handleAction('pause');
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKey: channelKey(CHANNEL),
        progStart: CATCHUP.start * 1000,
        progEnd: CATCHUP.end * 1000,
        title: CATCHUP.title,
        description: CATCHUP.description,
        icon: CATCHUP.icon,
        position: 60,
      }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on seeked', () => {
    player.play(0, CATCHUP);
    video.currentTime = 50;
    setCatchupProgress().mockClear();
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 50 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on stop (back action)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 70;
    setCatchupProgress().mockClear();
    player.handleAction('back');
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 70 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on channel switch (channelUp)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 80;
    setCatchupProgress().mockClear();
    player.channelUp();
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 80 }),
      CHANNEL.catchupDays,
    );
  });

  it('saves on switching to VOD (playVod)', () => {
    player.play(0, CATCHUP);
    video.currentTime = 90;
    setCatchupProgress().mockClear();
    player.playVod({
      url: 'http://host/movie.mp4', title: 'Movie', poster: '',
      accountId: 'x1', itemId: '1', kind: 'vod', resumeSecs: 0,
      subtitles: [], onBack: vi.fn(),
    });
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 90 }),
      CHANNEL.catchupDays,
    );
  });

  it('throttles periodic saves to CHECKPOINT_INTERVAL via timeupdate', () => {
    player.play(0, CATCHUP);
    setCatchupProgress().mockClear();

    // First timeupdate — no time elapsed, no save.
    video.currentTime = 15;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Advance past CHECKPOINT_INTERVAL.
    vi.advanceTimersByTime(CONFIG.CATCHUP.CHECKPOINT_INTERVAL + 100);
    video.currentTime = 45;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).toHaveBeenCalledTimes(1);
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 45 }),
      CHANNEL.catchupDays,
    );

    // Another timeupdate immediately after — still within interval, no second save.
    setCatchupProgress().mockClear();
    video.currentTime = 46;
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('does not save on timeupdate for live playback (no catch-up)', () => {
    player.play(0); // live, no catchup
    setCatchupProgress().mockClear();
    vi.advanceTimersByTime(CONFIG.CATCHUP.CHECKPOINT_INTERVAL + 100);
    video.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('marks completed=true when the ended event fires on a catch-up stream', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 118;
    setCatchupProgress().mockClear();
    v.dispatchEvent(new Event('ended'));
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true }),
      CHANNEL.catchupDays,
    );
  });

  it('saves with current position before suspend and queues that position for resume', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    // suspend() only saves when the element was playing; a real DOM element is always paused
    // without an actual src, so override paused to simulate the playing state.
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 55;
    setCatchupProgress().mockClear();

    player.suspend();
    // Progress saved with the pre-suspend position before the element was destroyed.
    expect(setCatchupProgress()).toHaveBeenCalledWith(
      expect.objectContaining({ position: 55 }),
      CHANNEL.catchupDays,
    );

    // After resume(), play() must queue 55 as the resume position.
    player.resume();
    const p = player as unknown as { pendingResumeSecs: number };
    expect(p.pendingResumeSecs).toBe(55);
  });

  it('preserves a pending resume seek when suspended before loadedmetadata applies it', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    // Resume from 45s, but the resume seek only runs on loadedmetadata — which we
    // never dispatch here, so currentTime stays 0 (the race window).
    player.play(0, { ...CATCHUP, resumeSecs: 45 });
    expect(v.currentTime).toBe(0);

    player.suspend();
    player.resume();
    // The requested 45s must survive — not collapse to 0 from the un-advanced element.
    const p = player as unknown as { pendingResumeSecs: number };
    expect(p.pendingResumeSecs).toBe(45);
  });

  it('does not write zero-position progress after suspend recreates the element', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    Object.defineProperty(v, 'duration', { value: 120, configurable: true });
    Object.defineProperty(v, 'paused', { get: () => false, configurable: true });
    container.appendChild(v);
    player.init(v);

    player.play(0, CATCHUP);
    v.currentTime = 55;
    player.suspend();
    setCatchupProgress().mockClear(); // ignore the suspend save

    // resume() calls play() with a fresh element (currentTime=0); that must not overwrite.
    player.resume();
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // The fresh element's first timeupdate should also be silent (checkpoint timer reset).
    const freshEl = (player as unknown as { videoEl: HTMLVideoElement }).videoEl;
    freshEl.dispatchEvent(new Event('timeupdate'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });

  it('does not save catch-up progress when channel has no catchupSource', () => {
    playlistMock.getByIndex.mockReturnValue(CHANNEL_NO_CATCHUP);
    player.play(0, CATCHUP);
    video.currentTime = 60;
    setCatchupProgress().mockClear();
    player.handleAction('pause');
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Also no write on seeked
    video.dispatchEvent(new Event('seeked'));
    expect(setCatchupProgress()).not.toHaveBeenCalled();

    // Also no write on back
    player.handleAction('back');
    expect(setCatchupProgress()).not.toHaveBeenCalled();
  });
});

describe('Player subtitle-offset overlay', () => {
  it('opens, routes actions, and closes without throwing', () => {
    document.body.innerHTML = '<div id="pc"></div><div id="subtitle-offset" class="hidden"></div>';
    const p = new Player(document.getElementById('pc') as HTMLElement, vi.fn());
    p.init(fakeVideo(0));
    (p as unknown as { currentChannel: unknown }).currentChannel = { ...CHANNEL };
    p.openSubtitleOffset();
    expect(p.subtitleOffsetOpen()).toBe(true);
    p.handleSubtitleOffsetAction('right');
    p.handleSubtitleOffsetAction('back');
    expect(p.subtitleOffsetOpen()).toBe(false);
  });
});

describe('Player channel number entry', () => {
  beforeEach(() => {
    playlistMock.channels = [CHANNEL, CHANNEL_NO_CATCHUP, XTREAM_CHANNEL];
  });
  afterEach(() => {
    playlistMock.channels = [];
  });

  it('jumps to the 1-based channel number the digits spelled out', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});

    player.handleAction('number', { number: 2 });

    expect(play).toHaveBeenCalledWith(1);
  });

  it('ignores a number outside the channel list instead of switching', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});

    player.handleAction('number', { number: 0 });
    player.handleAction('number', { number: 4 });

    expect(play).not.toHaveBeenCalled();
  });

  it('ignores channel numbers during VOD playback', () => {
    const play = vi.spyOn(player, 'play').mockImplementation(() => {});
    (player as unknown as { vod: unknown }).vod = { title: 'Movie' };

    player.handleAction('number', { number: 2 });

    expect(play).not.toHaveBeenCalled();
  });
});
