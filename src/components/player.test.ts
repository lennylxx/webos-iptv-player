// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { healthMock, playlistMock } = vi.hoisted(() => ({
  healthMock: {
    recordPlaybackFailure: vi.fn().mockResolvedValue(undefined),
    recordPlaybackSuccess: vi.fn().mockResolvedValue(false),
  },
  playlistMock: {
    channels: [] as unknown[],
    getByIndex: vi.fn(),
    indexOf: vi.fn(),
    resolveChannelKey: vi.fn(),
    getByGroup: vi.fn(),
  },
}));

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: healthMock }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null, getUpcoming: () => [] },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    getLastChannel: vi.fn(() => null), setLastChannel: vi.fn(),
    getSubtitlePref: vi.fn(), setSubtitlePref: vi.fn(),
    getAudioPref: vi.fn(), setAudioPref: vi.fn(),
    setResume: vi.fn(), clearResume: vi.fn(), getResumeList: vi.fn(() => []), getResume: vi.fn(() => null),
    removeWatchlist: vi.fn(),
    getPickedOnlineSub: vi.fn(), setPickedOnlineSub: vi.fn(),
    setCatchupProgress: vi.fn(), getCatchupProgress: vi.fn(), clearCatchupProgress: vi.fn(),
    touchRecentlyWatchedLive: vi.fn(),
    getSubtitleOffset: vi.fn(() => 0), setSubtitleOffset: vi.fn(),
    getChannelCycleMode: vi.fn(() => 'global'),
    getLiveReconnectAttempts: vi.fn(() => 3),
    getHeaderPlayback: vi.fn(() => 'off'),
    getPlayerOsdTimeoutMs: vi.fn(() => 5000),
    getPlaylists: vi.fn(() => [{
      id: 'x',
      name: 'Account',
      url: 'http://host',
      source: 'xtream',
      xtream: { username: 'u1', password: 'p1', liveOutput: 'auto' },
    }]),
  },
}));
vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('../services/media-probe', () => ({ probeMedia: vi.fn() }));
vi.mock('../services/subtitle-search/subtitle-search-service', () => ({
  subtitleSearchService: { isAvailable: () => false },
}));

import { Player } from './player';
import { Focus } from '../navigation/focus-scope';
import { setCursorHidden, setInputMode } from '../navigation/input-mode';
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
import { KeyHandler } from '../navigation/key-handler';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { ParentalControlService } from '../services/parental-control';
import { VodSubtitles } from '../services/vod-subtitles';
import { HlsSubtitles } from '../services/hls-subtitles';
import { DashSubtitles } from '../services/dash-subtitles';

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
  catchupSources: [
    {
      kind: 'path-ts' as const,
      url: 'http://host/timeshift/u1/p1/{duration}/{start}/42.ts',
    },
    {
      kind: 'path-bare' as const,
      url: 'http://host/timeshift/u1/p1/{duration}/{start}/42',
    },
    {
      kind: 'legacy-ts' as const,
      url: 'http://host/streaming/timeshift.php?username=u1&password=p1'
        + '&stream=42&start={start}&duration={duration}&extension=ts',
    },
  ],
  catchupTimeZone: 'America/New_York',
};
const DERIVED_XTREAM_CHANNEL = {
  ...CHANNEL,
  url: 'https://stream-host/token/42',
  catchup: 'xtream',
  catchupSource: 'http://host/timeshift/u1/p1/{duration}/{start}/42.m3u8',
  catchupAccountId: 'x',
  catchupStreamId: '42',
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

// An AudioTrackList/TextTrackList stand-in whose add() fires `addtrack`.
function trackList<T>(items: T[]) {
  const listeners: Array<(e: { track: T }) => void> = [];
  const list = Object.assign(items.slice(), {
    addEventListener(_type: string, fn: (e: { track: T }) => void) { listeners.push(fn); },
    add(track: T) { list.push(track); listeners.forEach(fn => fn({ track })); },
  });
  return list;
}

const vodTrackEvents = (log: { mock: { calls: unknown[][] } }) => log.mock.calls
  .map(args => args.join(' ')).filter(text => text.includes('event=vod.tracks'));

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
  playlistMock.resolveChannelKey.mockReturnValue({ channel: CHANNEL, channelIndex: 0 });
  playlistMock.getByGroup.mockReturnValue([]);
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
  Focus.uninstall();
  setInputMode('pointer');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bar = () => container.querySelector('.osd-progress-bar') as HTMLElement;
// The remote's keys drive the player, as KeyHandler records a key press that
// follows another key.
const remoteKeys = () => { setInputMode('keys'); setInputMode('keys'); };
const elapsed = () => container.querySelector('.osd-time-current')!.textContent;

describe('Player authorization gates', () => {
  it('defers live playback until the authorizer runs the action', () => {
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_channel, action: () => void) => {
      deferred = action;
      return false;
    });
    player = new Player(
      container,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authorize,
    );
    player.init(video);

    player.play(0);

    expect(authorize).toHaveBeenCalledWith(CHANNEL, expect.any(Function), false);
    expect(player.getCurrentChannel()).toBeNull();
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    expect(player.getCurrentChannel()).toBe(CHANNEL);
  });

  it('asks again before resuming a live channel after the app was hidden', () => {
    let allowed = true;
    let deferred: (() => void) | null = null;
    const onBack = vi.fn();
    const authorize = vi.fn((_channel, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, onBack, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const el = document.createElement('video');
    Object.defineProperty(el, 'paused', { get: () => false, configurable: true });
    container.appendChild(el);
    player.init(el);
    player.play(0);
    player.suspend();
    allowed = false;

    player.resume();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(container.classList.contains('hidden')).toBe(true);
    (deferred as unknown as () => void)();
    expect(container.classList.contains('hidden')).toBe(false);
  });
});

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

  it('Back drops a stale cursor, so OK resumes rather than seeking to it', () => {
    stubBar();
    player.handleAction('pause');
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 18 }));
    remoteKeys();
    expect(player.hideOsdForBack()).toBe(true);
    player.handleAction('select'); // shows the OSD
    expect(player.canSeek()).toBe(true);
    player.handleAction('select');
    expect(video.paused).toBe(false); // resumed
    expect(video.currentTime).toBe(0); // not seeked to the stale cursor
  });

  it('is no longer seekable once the OSD hides', () => {
    player.hideOSD();
    expect(player.canSeek()).toBe(false);
  });
});

describe('Player catch-up pause/play', () => {
  beforeEach(() => player.play(0, CATCHUP)); // catch-up → OSD shown, finite duration

  it('does not offer playback speed for native HLS catch-up', () => {
    expect(player.getPlaybackRateState()).toEqual({ available: false, rate: 1 });
  });

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

  it('lets Back hide the OSD only while paused', () => {
    remoteKeys();
    expect(player.hideOsdForBack()).toBe(false); // playing: Back stops
    player.handleAction('select'); // pauses
    expect(video.paused).toBe(true);
    expect(player.hideOsdForBack()).toBe(true);
    expect(video.paused).toBe(true);
    expect(player.canSeek()).toBe(false); // Right opens the menu
    vi.advanceTimersByTime(60_000);
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(true);
  });

  it('lets Back stop once the pipeline resumed a user pause, even if it paused again', () => {
    remoteKeys();
    player.handleAction('pause');
    video.play();
    video.dispatchEvent(new Event('play'));
    video.pause();
    video.dispatchEvent(new Event('pause'));
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.hideOsdForBack()).toBe(false);
  });

  it('keeps a user re-pause when the resume\'s `play` event arrives after it', () => {
    remoteKeys();
    player.handleAction('pause');
    player.handleAction('play');
    player.handleAction('pause');
    video.dispatchEvent(new Event('play'));
    expect(player.hideOsdForBack()).toBe(true);
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

  it('keeps a status message up when a guide refresh lands', () => {
    const osd = container.querySelector('#player-osd')!;
    player.resyncAV();
    player.refreshOsd();
    expect(osd.textContent).toContain('Resyncing');
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
  it('derives Xtream catch-up candidates only when playback needs them', () => {
    const internals = player as unknown as {
      xtreamCatchupSources: (channel: typeof DERIVED_XTREAM_CHANNEL) =>
        Array<{ kind: string; url: string }>;
    };

    const sources = internals.xtreamCatchupSources(DERIVED_XTREAM_CHANNEL);

    expect(sources.map(source => source.kind)).toEqual([
      'path-hls',
      'path-bare',
      'path-ts',
      'legacy-hls',
      'legacy-bare',
      'legacy-ts',
    ]);
    expect(sources[0].url)
      .toBe('http://host/timeshift/u1/p1/{duration}/{start}/42.m3u8');
    expect(DERIVED_XTREAM_CHANNEL).not.toHaveProperty('catchupSources');
  });

  it('resolves an Xtream timeshift URL in the provider timezone', async () => {
    playlistMock.getByIndex.mockReturnValue(DERIVED_XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    player.play(0, {
      ...CATCHUP,
      start,
      end: start + 3661,
    });
    await flush();
    expect(video.src)
      .toContain('/timeshift/u1/p1/62/2026-07-21:15-30/42.m3u8');
  });

  it('tries each Xtream catch-up candidate once in order', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const realVideo = document.createElement('video');
    container.appendChild(realVideo);
    player.init(realVideo);
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);
    const start = Date.UTC(2026, 6, 21, 19, 30) / 1000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    player.play(0, { ...CATCHUP, start, end: start + 3600 });
    await flush();
    expect(realVideo.src).toContain('/timeshift/');

    realVideo.dispatchEvent(new Event('error'));
    await flush();
    const bareVideo = container.querySelector('video')!;
    expect(bareVideo.src).toContain(
      '/timeshift/u1/p1/60/2026-07-21:15-30/42',
    );
    expect(bareVideo.src).not.toContain('42.ts');

    bareVideo.dispatchEvent(new Event('error'));
    await flush();
    const legacyVideo = container.querySelector('video')!;
    expect(legacyVideo.src).toContain(
      '/streaming/timeshift.php?username=u1&password=p1&stream=42' +
      '&start=2026-07-21:15-30&duration=60&extension=ts',
    );

    legacyVideo.dispatchEvent(new Event('error'));
    expect(container.querySelector('video')).toBe(legacyVideo);
    expect(warn.mock.calls.map(args => args.join(' '))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'event=xtream.catchup.variant.attempted variant=path-bare attempt=2 total=3',
        ),
        expect.stringContaining(
          'event=xtream.catchup.variant.attempted variant=legacy-ts attempt=3 total=3',
        ),
        expect.stringContaining(
          'event=xtream.catchup.variant.failed variant=legacy-ts attempt=3 total=3',
        ),
      ]),
    );
    warn.mockRestore();
  });

  it('does not switch catch-up variants after playback starts', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const realVideo = document.createElement('video');
    container.appendChild(realVideo);
    player.init(realVideo);
    playlistMock.getByIndex.mockReturnValue(XTREAM_CHANNEL);

    player.play(0, CATCHUP);
    await flush();
    realVideo.dispatchEvent(new Event('playing'));
    realVideo.dispatchEvent(new Event('error'));

    expect(container.querySelector('video')).toBe(realVideo);
    expect(container.querySelector('video')!.src).toContain('/42.ts');
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
  it('lets Back stop playing live with the OSD up', () => {
    player.play(0);
    remoteKeys();
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.hideOsdForBack()).toBe(false);
  });

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
    playlistMock.resolveChannelKey.mockReturnValue(null);

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

  it('detects a stalled initial load even while autoplay has not unpaused the video', async () => {
    Object.defineProperties(video, {
      paused: { get: () => true, configurable: true },
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    const watchdog = (player as unknown as { stallWatchdog: { start(): void } }).stallWatchdog;
    watchdog.start();

    vi.advanceTimersByTime(
      CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS + 1),
    );
    expect(reload).toHaveBeenCalledOnce();
  });

  it('leaves a stall during a Luna start to the Luna deadline', async () => {
    Object.defineProperties(video, {
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    const pipeline = (player as unknown as { pipeline: { isLunaStarting(): boolean } }).pipeline;
    const starting = vi.spyOn(pipeline, 'isLunaStarting').mockReturnValue(true);
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const watchdog = (player as unknown as { stallWatchdog: { start(): void } }).stallWatchdog;
    watchdog.start();
    const freeze = CONFIG.PLAYER.STALL_POLL_MS * CONFIG.PLAYER.STALL_FREEZE_TICKS;

    vi.advanceTimersByTime(freeze * 2);
    expect(reload).not.toHaveBeenCalled();
    const held = info.mock.calls.map(args => args.join(' '))
      .filter(text => text.includes('event=playback.luna.stall.held'));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain('reloads=0/3');

    // Fallen back to the element: its stall reloads with the full budget.
    starting.mockReturnValue(false);
    vi.advanceTimersByTime(freeze);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('gives the element a whole freeze window after a Luna fallback', async () => {
    Object.defineProperties(video, {
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    const internals = player as unknown as {
      pipeline: { isLunaStarting(): boolean; callbacks: { onPlaybackPathChange(): void } };
      stallWatchdog: { start(): void };
    };
    const starting = vi.spyOn(internals.pipeline, 'isLunaStarting').mockReturnValue(true);
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    internals.stallWatchdog.start();
    // The first tick takes the baseline; the rest count frozen.
    vi.advanceTimersByTime(CONFIG.PLAYER.STALL_POLL_MS * CONFIG.PLAYER.STALL_FREEZE_TICKS);

    // The Luna deadline fires just before the tick that completes the freeze.
    starting.mockReturnValue(false);
    internals.pipeline.callbacks.onPlaybackPathChange();
    vi.advanceTimersByTime(CONFIG.PLAYER.STALL_POLL_MS);
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS - 1));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps a recovery reload after a Luna fallback on the element', async () => {
    player.play(0);
    await flush();
    const pipeline = (player as unknown as {
      pipeline: { load(url: string, extras: unknown, opts?: { reload?: boolean }): void };
    }).pipeline;
    const load = vi.spyOn(pipeline, 'load');
    vi.spyOn(player as unknown as { recreateVideoEl(): void }, 'recreateVideoEl')
      .mockImplementation(() => {});
    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    expect(load.mock.calls[0][2]).toEqual(expect.objectContaining({ reload: true }));
  });

  it('does not retry a live stream the user pauses after playback starts', async () => {
    Object.defineProperties(video, {
      paused: { get: () => true, configurable: true },
      readyState: { value: 0, configurable: true },
      networkState: { value: 2, configurable: true },
    });
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('playing'));
    const reload = vi.spyOn(player as unknown as { reloadCurrentStream(): void }, 'reloadCurrentStream')
      .mockImplementation(() => {});
    const watchdog = (player as unknown as { stallWatchdog: { start(): void } }).stallWatchdog;
    watchdog.start();

    vi.advanceTimersByTime(
      CONFIG.PLAYER.STALL_POLL_MS * CONFIG.PLAYER.STALL_FREEZE_TICKS * 2,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('logs the Luna stream URL, not the placeholder, on a Luna playback error', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    Object.defineProperty(video, 'currentSrc', {
      configurable: true, get: () => `http://app/${CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER}`,
    });
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    player.init(video);
    const pipeline = (player as unknown as { pipeline: { lunaStreamUrl(): string } }).pipeline;
    vi.spyOn(pipeline, 'lunaStreamUrl').mockReturnValue('http://host/live/u/p/1.m3u8');
    player.play(0);

    video.dispatchEvent(new Event('error'));

    const line = error.mock.calls.map(args => args.join(' '))
      .find(text => text.includes('event=playback.video.error'));
    expect(line).toContain(diagnosticStreamUrl('http://host/live/u/p/1.m3u8'));
    expect(line).not.toContain(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER);
  });

  it('logs the channel URL, not the placeholder, on an error after a Luna fallback', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    // The restored element keeps the placeholder as currentSrc until its next
    // resource selection.
    Object.defineProperty(video, 'currentSrc', {
      configurable: true, get: () => `file:///app/${CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER}`,
    });
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    player.init(video);
    player.play(0);

    video.dispatchEvent(new Event('error'));

    const line = error.mock.calls.map(args => args.join(' '))
      .find(text => text.includes('event=playback.video.error'));
    expect(line).toContain(diagnosticStreamUrl(CHANNEL.url));
    expect(line).not.toContain(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER);
  });

  it('hands a channel that never started to the next header step instead of reconnecting', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    player.init(video);
    const pipeline = (player as unknown as { pipeline: { escalate(): boolean } }).pipeline;
    const retry = vi.spyOn(pipeline, 'escalate').mockReturnValue(true);
    player.play(0);

    video.dispatchEvent(new Event('error'));

    expect(retry).toHaveBeenCalledOnce();
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .not.toContain('event=playback.video.error');

    retry.mockClear();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('error'));
    expect(retry).not.toHaveBeenCalled();
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=playback.video.error');
  });

  it('reopens a proxied stream that had played once, then takes the normal error path', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const internals = player as unknown as {
      pipeline: { isProxied(): boolean };
      reloadCurrentStream(): void;
    };
    vi.spyOn(internals.pipeline, 'isProxied').mockReturnValue(true);
    const reload = vi.spyOn(internals, 'reloadCurrentStream').mockImplementation(() => {});
    player.play(0);
    video.dispatchEvent(new Event('playing'));

    video.dispatchEvent(new Event('error'));

    expect(reload).toHaveBeenCalledOnce();
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=playback.proxy.reopen');
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .not.toContain('event=playback.video.error');

    video.dispatchEvent(new Event('error'));
    expect(reload).toHaveBeenCalledOnce();
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=playback.video.error');
  });

  it('does not reopen a proxy session for a stream that never started', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const internals = player as unknown as {
      pipeline: { isProxied(): boolean };
      reloadCurrentStream(): void;
      onStartupFailure(failure: 'unsupported', probe: { readyState: number; networkState: number }, ms: number): void;
    };
    vi.spyOn(internals.pipeline, 'isProxied').mockReturnValue(true);
    const reload = vi.spyOn(internals, 'reloadCurrentStream').mockImplementation(() => {});
    player.play(0);

    internals.onStartupFailure('unsupported', { readyState: 0, networkState: 2 }, 10000);

    expect(reload).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
      .not.toContain('event=playback.proxy.reopen');
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toContain('event=playback.video.error');
  });

  it('treats the proxy step a played Luna stream moved to as unstarted', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const internals = player as unknown as {
      pipeline: {
        isProxied(): boolean; isHeaderChain(): boolean;
        callbacks: { onStepRestarted(): void };
      };
      reloadCurrentStream(): void;
      startupWatchdog: { start(): void };
    };
    vi.spyOn(internals.pipeline, 'isProxied').mockReturnValue(true);
    vi.spyOn(internals.pipeline, 'isHeaderChain').mockReturnValue(true);
    const reload = vi.spyOn(internals, 'reloadCurrentStream').mockImplementation(() => {});
    const watchdog = vi.spyOn(internals.startupWatchdog, 'start');
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    watchdog.mockClear();

    internals.pipeline.callbacks.onStepRestarted();
    expect(watchdog).toHaveBeenCalled();
    playlistMock.getByIndex.mockClear();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);

    expect(reload).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
      .not.toContain('event=playback.proxy.reopen');
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toMatch(/event=playback\.recovery\.exhausted .*chain=unstarted/);
  });

  it('reconnects a live channel that played when its reload finds the source gone', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const internals = player as unknown as {
      reloadCurrentStream(): void;
      onStartupFailure(failure: 'unsupported', probe: { readyState: number; networkState: number }, ms: number): void;
    };
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    internals.reloadCurrentStream();
    playlistMock.getByIndex.mockClear();

    internals.onStartupFailure('unsupported', { readyState: 0, networkState: 3 }, 500);
    vi.advanceTimersByTime(2000);

    expect(playlistMock.getByIndex).not.toHaveBeenCalledWith(1);
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
      .toMatch(/event=playback\.recovery\.reload .*cause=error .*reloads=1\//);
  });

  it('gives up on a header channel no step started instead of rerunning its chain', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const pipeline = (player as unknown as { pipeline: { isHeaderChain(): boolean } }).pipeline;
    vi.spyOn(pipeline, 'isHeaderChain').mockReturnValue(true);
    player.play(0);
    playlistMock.getByIndex.mockClear();

    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);

    expect(container.querySelector('video')).toBe(video);
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toMatch(/event=playback\.recovery\.exhausted .*cause=error .*chain=unstarted/);
  });

  it('fails a channel only the proxy could play at once when the proxy is unavailable', async () => {
    playlistMock.channels = [{}, {}];
    playlistMock.getByIndex.mockReturnValue({ ...CHANNEL, httpHeaders: { Referer: 'http://host/' } });
    vi.mocked(StorageService.getHeaderPlayback).mockReturnValue('proxy');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      player.play(0);
      await vi.waitFor(() => expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
        .toContain('event=playback.chain.stopped'));
      playlistMock.getByIndex.mockClear();
      vi.advanceTimersByTime(10000);

      expect(warn.mock.calls.map(args => args.join(' ')).join('\n'))
        .not.toContain('event=playback.recovery.reload');
      expect(error.mock.calls.map(args => args.join(' ')).join('\n')
        .match(/event=playback\.video\.error/g)).toHaveLength(1);
      expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    } finally {
      vi.mocked(StorageService.getHeaderPlayback).mockReturnValue('off');
    }
  });

  it('leaves a header step that hangs to the startup watchdog, which escalates it', async () => {
    playlistMock.channels = [{}, {}];
    Object.assign(video, { readyState: 0, networkState: 2 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internals = player as unknown as {
      pipeline: { isHeaderChain(): boolean; canEscalate(): boolean; escalate(): boolean };
      stallWatchdog: { start(): void };
    };
    vi.spyOn(internals.pipeline, 'isHeaderChain').mockReturnValue(true);
    vi.spyOn(internals.pipeline, 'canEscalate').mockReturnValue(true);
    const escalate = vi.spyOn(internals.pipeline, 'escalate').mockReturnValue(true);
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('loadstart'));
    internals.stallWatchdog.start();
    playlistMock.getByIndex.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS + 1));
    expect(escalate).not.toHaveBeenCalled();
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);
    expect(escalate).toHaveBeenCalled();
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
  });

  it('gives up on a hanging header chain with no step left, without rerunning it', async () => {
    playlistMock.channels = [{}, {}];
    Object.assign(video, { readyState: 0, networkState: 2 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internals = player as unknown as {
      pipeline: { isHeaderChain(): boolean; canEscalate(): boolean };
      stallWatchdog: { start(): void };
      reloadCurrentStream(): void;
    };
    vi.spyOn(internals.pipeline, 'isHeaderChain').mockReturnValue(true);
    vi.spyOn(internals.pipeline, 'canEscalate').mockReturnValue(false);
    const reload = vi.spyOn(internals, 'reloadCurrentStream');
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('loadstart'));
    internals.stallWatchdog.start();
    playlistMock.getByIndex.mockClear();

    vi.advanceTimersByTime(CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS + 1));

    expect(reload).not.toHaveBeenCalled();
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .toMatch(/event=playback\.recovery\.exhausted .*cause=stall .*chain=unstarted/);
  });

  it('still reconnects a header channel that played before it stalled', () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    const pipeline = (player as unknown as { pipeline: { isHeaderChain(): boolean } }).pipeline;
    vi.spyOn(pipeline, 'isHeaderChain').mockReturnValue(true);
    player.play(0);
    video.dispatchEvent(new Event('playing'));
    playlistMock.getByIndex.mockClear();

    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    const second = container.querySelector('video')!;
    expect(second).not.toBe(video);

    second.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(container.querySelector('video')).not.toBe(second);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();
  });

  it('coalesces errors and reconnects the same channel before advancing', async () => {
    playlistMock.channels = [{}, {}];
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    video = document.createElement('video');
    container.appendChild(video);
    player.init(video);
    player.play(0);
    playlistMock.getByIndex.mockClear();

    for (let i = 0; i < 20; i++) video.dispatchEvent(new Event('error'));
    await flush();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(container.querySelector('video')).toBe(video);
    vi.advanceTimersByTime(1);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();

    const first = container.querySelector('video')!;
    first.dispatchEvent(new Event('error'));
    first.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    const second = container.querySelector('video')!;
    expect(second).not.toBe(first);
    first.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(container.querySelector('video')).toBe(second);
    second.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    const third = container.querySelector('video')!;
    expect(third).not.toBe(second);
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();

    third.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);

    expect(playlistMock.getByIndex).toHaveBeenCalledTimes(1);
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledOnce();
    expect(healthMock.recordPlaybackFailure)
      .toHaveBeenCalledWith(CHANNEL, 'playback_error');
    await flush();
    expect(onHealthChanged).toHaveBeenCalledOnce();
  });

  it('cancels a pending reconnect if the original live stream resumes', async () => {
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(1000);
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(3000);
    expect(container.querySelector('video')).toBeNull();
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
    expect(container.querySelector('#player-osd')?.textContent).not.toContain('Reconnecting');
  });

  it('honors a disabled retry limit and skips reconnect for unsupported sources', async () => {
    playlistMock.channels = [{}, {}];
    vi.mocked(StorageService.getLiveReconnectAttempts).mockReturnValueOnce(0);
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledWith(CHANNEL, 'playback_error');
    expect(container.querySelector('video')).toBeNull();

    player.play(0);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: '' } });
    healthMock.recordPlaybackFailure.mockClear();
    video.dispatchEvent(new Event('error'));
    expect(healthMock.recordPlaybackFailure).toHaveBeenCalledOnce();
  });

  it('says HTTP headers are off when a channel that needed them fails', async () => {
    playlistMock.channels = [{}, {}];
    player.play(0);
    await flush();
    const pipeline = (player as unknown as { pipeline: { headersTurnedOff(): boolean } }).pipeline;
    vi.spyOn(pipeline, 'headersTurnedOff').mockReturnValue(true);
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4, message: '' } });

    video.dispatchEvent(new Event('error'));

    expect(container.querySelector('#player-osd')?.textContent)
      .toContain('Playback error — HTTP headers are off. Trying the next channel…');
  });

  it('cancels a pending reconnect when the user changes channel or stops', async () => {
    playlistMock.channels = [{}, {}];
    player.play(0);
    await flush();
    video.dispatchEvent(new Event('error'));
    player.play(1);
    playlistMock.getByIndex.mockClear();
    vi.advanceTimersByTime(3000);
    expect(playlistMock.getByIndex).not.toHaveBeenCalled();

    video.dispatchEvent(new Event('error'));
    player.stop();
    vi.advanceTimersByTime(3000);
    expect(healthMock.recordPlaybackFailure).not.toHaveBeenCalled();
  });

  it('starts the OSD hide timer when startup playback begins', async () => {
    video.pause();
    player.showOSD();
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);
    expect((container.querySelector('#player-osd') as HTMLElement).style.display).not.toBe('none');

    await video.play();
    video.dispatchEvent(new Event('playing'));
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS);

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

describe('Player Luna suspend and resume', () => {
  type LunaPipeline = { isLunaActive(): boolean; lunaClock(): (() => number) | null };

  function startOnLuna(duration: number, at: number) {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    let paused = false;
    Object.defineProperties(v, {
      duration: { value: duration, configurable: true },
      paused: { get: () => paused, configurable: true },
      pause: { value: () => { paused = true; }, configurable: true },
    });
    container.appendChild(v);
    player.init(v);
    player.play(0);
    const pipeline = (player as unknown as { pipeline: LunaPipeline }).pipeline;
    const active = vi.spyOn(pipeline, 'isLunaActive').mockReturnValue(true);
    vi.spyOn(pipeline, 'lunaClock').mockReturnValue(() => at);
    return { unload: () => active.mockReturnValue(false) };
  }

  // The element the resumed load plays on, with a working clock.
  function reloaded(duration: number) {
    const fresh = player.getVideoElement()!;
    let time = 0;
    const pause = vi.fn();
    Object.defineProperties(fresh, {
      duration: { value: duration, configurable: true },
      currentTime: { get: () => time, set: (t: number) => { time = t; }, configurable: true },
      pause: { value: pause, configurable: true },
    });
    return { fresh, pause, time: () => time };
  }

  const events = (spy: { mock: { calls: unknown[][] } }, name: string) => spy.mock.calls
    .map(args => args.join(' ')).filter(text => text.includes(`event=${name} `));

  it('reloads a paused finite stream at its position and pauses it again', () => {
    const luna = startOnLuna(60, 11.1);
    (player as unknown as { pauseToggle(): void }).pauseToggle();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.suspend();
    luna.unload();
    player.resume();
    const { fresh, pause, time } = reloaded(60);
    fresh.dispatchEvent(new Event('loadedmetadata'));
    expect(time()).toBe(11.1);
    expect(pause).not.toHaveBeenCalled();
    fresh.dispatchEvent(new Event('playing'));

    expect(pause).toHaveBeenCalledOnce();
    expect((player as unknown as { userPaused: boolean }).userPaused).toBe(true);
    expect(events(info, 'playback.luna.suspend')).toEqual([
      expect.stringContaining('kind=finite atS=10 paused=1'),
    ]);
    expect(events(info, 'playback.luna.resume')).toEqual([
      expect.stringContaining('atS=10 paused=1'),
    ]);
    fresh.dispatchEvent(new Event('playing'));
    expect(pause).toHaveBeenCalledOnce();
  });

  function startProxied(duration: number, at: number) {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    let paused = false;
    Object.defineProperties(v, {
      duration: { value: duration, configurable: true },
      currentTime: { get: () => at, set: () => {}, configurable: true },
      paused: { get: () => paused, configurable: true },
    });
    container.appendChild(v);
    player.init(v);
    const pipeline = (player as unknown as { pipeline: { isProxied(): boolean } }).pipeline;
    vi.spyOn(pipeline, 'isProxied').mockReturnValue(true);
    player.play(0);
    v.dispatchEvent(new Event('playing'));
    return Object.assign(v, { systemPause: () => { paused = true; } });
  }

  type ProxyCallbacks = { pipeline: { callbacks: { onProxyExpired(): void } }; pendingSeekTarget: number | null };

  it('releases a proxied stream the TV paused before hiding the app, and resumes it where it was', () => {
    const v = startProxied(60, 11.1);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    v.systemPause();

    player.suspend();
    expect(player.getVideoElement()).not.toBe(v);
    player.resume();
    const { fresh, pause, time } = reloaded(60);
    fresh.dispatchEvent(new Event('loadedmetadata'));
    fresh.dispatchEvent(new Event('playing'));

    expect(time()).toBe(11.1);
    expect(pause).not.toHaveBeenCalled();
    expect(events(info, 'playback.luna.suspend')).toEqual([
      expect.stringContaining('kind=finite atS=10 paused=0'),
    ]);
  });

  it('reopens a session the service expired under a played stream, at its pending seek', () => {
    const v = startProxied(60, 11.1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const internals = player as unknown as ProxyCallbacks;
    internals.pendingSeekTarget = 30;

    internals.pipeline.callbacks.onProxyExpired();
    const { fresh, time } = reloaded(60);
    fresh.dispatchEvent(new Event('loadedmetadata'));

    expect(fresh).not.toBe(v);
    expect(time()).toBe(30);
  });

  it('reopens an expired proxy session for a finite stream where it was', () => {
    const v = startProxied(60, 11.1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    v.dispatchEvent(new Event('error'));
    const { fresh, time } = reloaded(60);
    fresh.dispatchEvent(new Event('loadedmetadata'));

    expect(fresh).not.toBe(v);
    expect(time()).toBe(11.1);
  });

  it('resumes a proxied finite stream hidden while it played where it was', () => {
    startProxied(60, 11.1);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    player.suspend();
    player.resume();
    const { fresh, time } = reloaded(60);
    fresh.dispatchEvent(new Event('loadedmetadata'));

    expect(time()).toBe(11.1);
  });

  it('reloads a playing live stream at its edge and keeps it playing', () => {
    const luna = startOnLuna(Infinity, 30);
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.suspend();
    luna.unload();
    player.resume();
    const { fresh, pause, time } = reloaded(Infinity);
    fresh.dispatchEvent(new Event('loadedmetadata'));
    fresh.dispatchEvent(new Event('playing'));

    expect(time()).toBe(0);
    expect(pause).not.toHaveBeenCalled();
    expect(events(info, 'playback.luna.suspend')).toEqual([
      expect.stringContaining('kind=live atS=0 paused=0'),
    ]);
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

describe('Player native playback-rate retry', () => {
  it('re-applies the selected speed as the native pipeline becomes playable', () => {
    const reapply = vi.fn();
    const internals = player as unknown as {
      playbackRate: { reapply: () => void };
    };
    internals.playbackRate.reapply = reapply;

    video.dispatchEvent(new Event('canplay'));
    video.dispatchEvent(new Event('playing'));

    expect(reapply).toHaveBeenCalledTimes(2);
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

  it('keeps a paused OSD current after Back hid it and OK showed it again', () => {
    remoteKeys();
    player.handleAction('pause');
    expect(player.hideOsdForBack()).toBe(true);
    vi.advanceTimersByTime(1000);
    player.handleAction('select'); // hidden OSD: OK shows it, still paused
    expect(live.paused).toBe(true);
    setWindow(0, 120); // the live edge moves on while paused
    vi.advanceTimersByTime(1000);
    expect((container.querySelector('.osd-progress-bar') as HTMLElement).style.width).toBe('50%');
  });

  it('holds the paused point until resume, then clamps into the rolled window', () => {
    player.handleAction('rewind');
    player.handleAction('pause');
    const pausedAt = live.currentTime;
    setWindow(20, 80); // window rolled forward while paused
    live.dispatchEvent(new Event('progress'));
    expect(live.currentTime).toBe(pausedAt);

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
    vi.advanceTimersByTime(CONFIG.PLAYER.DEFAULT_PLAYER_OSD_TIMEOUT_MS + 100);

    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    await flush();
    const osd = container.querySelector('#player-osd')!;
    expect(osd.textContent).toContain('Reconnecting');

    // Recovery (loadedmetadata) must repaint over the message, not leave it stuck.
    container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    expect(osd.textContent).not.toContain('Reconnecting');
  });

  it('lets Back stop at once over a Reconnecting… message and while the reload starts', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);
    player.play(0); // live
    await flush();
    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    await flush();
    remoteKeys();
    expect(v.paused).toBe(true); // the mocked play() never starts it
    expect(player.hideOsdForBack()).toBe(false);
    container.querySelector('video')!.dispatchEvent(new Event('loadedmetadata'));
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.hideOsdForBack()).toBe(false); // recovered metadata, not yet playing
  });

  it('lets Back stop a stream still starting with the OSD up', async () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const v = document.createElement('video');
    container.appendChild(v);
    player.init(v);
    player.play(0); // live
    await flush();
    remoteKeys();
    expect(v.paused).toBe(true); // the mocked play() never starts it
    expect(container.querySelector('#player-osd')!.classList.contains('hidden')).toBe(false);
    expect(player.hideOsdForBack()).toBe(false);
    player.playVod({
      url: 'http://host/a.mp4', title: 'Movie One', poster: '', accountId: 'x1', itemId: '10',
      kind: 'vod', resumeSecs: 0, subtitles: [], onBack: vi.fn(),
    });
    await flush();
    expect(container.querySelector('video')!.paused).toBe(true);
    expect(player.hideOsdForBack()).toBe(false);
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
  afterEach(() => { container.remove(); vi.restoreAllMocks(); });

  it('defers VOD playback until the authorizer runs the action', () => {
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      deferred = action;
      return false;
    });
    player = new Player(
      container,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authorize,
    );
    player.init(fakeVideo(3600));

    player.playVod(req());

    expect(player.isVod()).toBe(false);
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('asks again before resuming a VOD after the app was hidden', () => {
    let allowed = true;
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const v = fakeVideo(3600);
    player.init(v);
    const r = req();
    player.playVod(r);
    v.currentTime = 42;
    player.suspend();
    allowed = false;

    player.resume();

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: '10', resumeSecs: 42 }), expect.any(Function));
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('keeps an allowed VOD playing when the app returns', () => {
    const authorize = vi.fn((_item, action: () => void) => { action(); return true; });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    player.init(fakeVideo(3600));
    const r = req();
    player.playVod(r);

    player.resume();

    expect(r.onBack).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('seeks to the resume position once metadata is known', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req({ resumeSecs: 900 }));
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(900);
    expect(player.isVod()).toBe(true);
  });

  it('logs the native track counts once metadata is known', () => {
    const counted = fakeVideo(3600);
    const audio = (enabled: boolean) => ({ enabled, label: '', language: '', id: '', kind: 'main' });
    const sidecar = { kind: 'subtitles', label: '', language: '', mode: 'hidden' };
    Object.defineProperty(counted, 'audioTracks', { value: [audio(true), audio(false)] });
    Object.defineProperty(counted, 'textTracks', {
      value: [{ kind: 'subtitles', label: '', language: '', mode: 'disabled' }, sidecar],
    });
    vi.spyOn(VodSubtitles.prototype, 'owns').mockImplementation((track) => track === sidecar as unknown);
    const bare = fakeVideo(3600);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(counted);
    player.playVod(req());
    counted.dispatchEvent(new Event('loadedmetadata'));
    player.init(bare);
    player.playVod(req());
    bare.dispatchEvent(new Event('loadedmetadata'));

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=2 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=none text=0 mse=0'),
    ]);
  });

  it('flags MSE playback in the track counts', () => {
    const video = fakeVideo(3600);
    vi.spyOn((player as unknown as { pipeline: { isMseActive(): boolean } }).pipeline, 'isMseActive')
      .mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadedmetadata'));

    expect(vodTrackEvents(log)).toEqual([expect.stringContaining('mse=1')]);
  });

  it('logs the first native track added after metadata once per load', () => {
    const video = fakeVideo(3600);
    const audio = () => ({ enabled: false, label: '', language: '', id: '', kind: 'main' });
    const text = () => ({ kind: 'subtitles', label: '', language: '', mode: 'disabled' });
    const audioTracks = trackList([audio()]);
    const textTracks = trackList<unknown>([]);
    Object.defineProperty(video, 'audioTracks', { value: audioTracks });
    Object.defineProperty(video, 'textTracks', { value: textTracks });
    const sidecar = text();
    vi.spyOn(VodSubtitles.prototype, 'owns').mockImplementation((track) => track === sidecar as unknown);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    audioTracks.add(audio()); // before metadata: covered by the loadedmetadata event
    video.dispatchEvent(new Event('loadedmetadata'));
    textTracks.add(sidecar); // the app's own sidecar track is not a late arrival
    textTracks.add(text());
    audioTracks.add(audio());
    video.dispatchEvent(new Event('loadstart'));
    video.dispatchEvent(new Event('loadedmetadata'));
    video.dispatchEvent(new Event('loadstart')); // a new load disarms the last one's late event
    textTracks.add(text());
    video.dispatchEvent(new Event('loadedmetadata'));
    audioTracks.add(audio());

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=2 text=0 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=2 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=3 text=1 mse=0'),
      expect.stringContaining('event=vod.tracks audio=3 text=2 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=4 text=2 mse=0'),
    ]);
  });

  it('leaves the HLS and DASH renderer tracks out of the track counts', () => {
    const video = fakeVideo(3600);
    const text = () => ({ kind: 'subtitles', label: '', language: '', mode: 'disabled' });
    const textTracks = trackList<unknown>([]);
    Object.defineProperty(video, 'audioTracks', { value: trackList([]) });
    Object.defineProperty(video, 'textTracks', { value: textTracks });
    const hlsTrack = text();
    const dashTrack = text();
    vi.spyOn(HlsSubtitles.prototype, 'owns').mockImplementation((track) => track === hlsTrack as unknown);
    vi.spyOn(DashSubtitles.prototype, 'owns').mockImplementation((track) => track === dashTrack as unknown);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    player.init(video);
    player.playVod(req());
    textTracks.add(hlsTrack);
    video.dispatchEvent(new Event('loadedmetadata'));
    textTracks.add(dashTrack); // a FORCED or saved subtitle the app renders itself
    textTracks.add(text());

    expect(vodTrackEvents(log)).toEqual([
      expect.stringContaining('event=vod.tracks audio=0 text=0 mse=0'),
      expect.stringContaining('event=vod.tracks phase=late audio=0 text=1 mse=0'),
    ]);
  });

  it('lets Right open the menu only over bare video', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    const internals = player as unknown as {
      osd: { hide(): void };
      tracks: { subsOverlay: { visible: boolean } | null };
    };
    expect(player.vodRightOpensMenu()).toBe(false); // the OSD shows
    internals.osd.hide();
    expect(player.vodRightOpensMenu()).toBe(true);
    internals.tracks.subsOverlay = { visible: true };
    expect(player.vodRightOpensMenu()).toBe(false);
  });

  it('lets Right open the menu over the OSD until the duration is usable', () => {
    const video = fakeVideo(NaN);
    player.init(video);
    player.playVod(req()); // the OSD shows before loadedmetadata
    expect(player.vodRightOpensMenu()).toBe(true);
    (video as { duration: number }).duration = Infinity;
    expect(player.vodRightOpensMenu()).toBe(true);
    (video as { duration: number }).duration = 3600;
    expect(player.vodRightOpensMenu()).toBe(false);
  });

  it('is seekable while the OSD is up (finite duration)', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    expect(player.canSeek()).toBe(true); // playVod shows the OSD
  });

  it('lets Back hide the OSD unless the subtitle search or up-next owns it', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    remoteKeys();
    expect(player.hideOsdForBack()).toBe(false); // playing: Back stops
    player.handleAction('select'); // pause
    expect(player.vodRightOpensMenu()).toBe(false);
    const internals = player as unknown as {
      tracks: { subsOverlay: { visible: boolean } | null };
      upNextTimer: ReturnType<typeof setInterval> | null;
    };
    internals.tracks.subsOverlay = { visible: true };
    expect(player.hideOsdForBack()).toBe(false);
    internals.tracks.subsOverlay = null;
    internals.upNextTimer = 1 as unknown as ReturnType<typeof setInterval>;
    expect(player.hideOsdForBack()).toBe(false);
    internals.upNextTimer = null;
    expect(player.hideOsdForBack()).toBe(true);
    expect(video.paused).toBe(true);
    expect(player.vodRightOpensMenu()).toBe(true);
  });

  // A cursor on screen re-reveals the OSD, so hiding it would trap Back.
  it('lets Back stop a paused VOD when the pointer drove it last, unless webOS hid the cursor', () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    player.handleAction('select'); // pause
    setInputMode('pointer');
    setInputMode('keys'); // Back is the first key after the pointer
    expect(player.hideOsdForBack()).toBe(false);
    setInputMode('pointer');
    setCursorHidden(true);
    setInputMode('keys');
    expect(player.hideOsdForBack()).toBe(true);
  });

  it('offers and applies playback speed for VOD in the desktop preview', async () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());

    expect(player.getPlaybackRateState()).toEqual({ available: true, rate: 1 });
    await expect(player.setPlaybackRate(1.5)).resolves.toBe(true);
    expect(video.playbackRate).toBe(1.5);
    expect(player.getPlaybackRateState()).toEqual({ available: true, rate: 1.5 });
  });

  it('refreshes the player menu when the audio tracks change', () => {
    const onStateChanged = vi.fn();
    player = new Player(container, vi.fn(), undefined, undefined, undefined, onStateChanged);
    player.init(fakeVideo(3600));
    player.playVod(req());
    onStateChanged.mockClear();
    const pipeline = (player as unknown as {
      pipeline: { callbacks: { onAudioTracksUpdated(): void } };
    }).pipeline;

    pipeline.callbacks.onAudioTracksUpdated();

    expect(onStateChanged).toHaveBeenCalled();
  });

  it('does not offer playback speed while the Luna pipeline plays', () => {
    player.init(fakeVideo(3600));
    player.playVod(req());
    const pipeline = (player as unknown as { pipeline: { isLunaActive(): boolean } }).pipeline;
    vi.spyOn(pipeline, 'isLunaActive').mockReturnValue(true);
    expect(player.getPlaybackRateState().available).toBe(false);
  });

  it('logs why a playback speed change failed', async () => {
    const video = fakeVideo(3600);
    Object.defineProperty(video, 'playbackRate', { get: () => 1, set: () => {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    player.init(video);
    player.playVod(req());

    await expect(player.setPlaybackRate(2)).resolves.toBe(false);

    const line = warn.mock.calls
      .map(args => args.join(' '))
      .find(text => text.includes('event=playback.rate.failed'));
    expect(line).toMatch(/session=\d+ load=\d+ engine=html rate=2 stage=html attempt=0/);
    expect(line).toContain('errorText="playbackRate=1"');
    warn.mockRestore();
  });

  it('does not offer playback speed for HLS or DASH VOD', () => {
    player.init(fakeVideo(3600));
    player.playVod(req({ url: 'http://host:8080/movie/u/p/10.m3u8' }));
    expect(player.getPlaybackRateState().available).toBe(false);

    player.playVod(req({ url: 'http://host:8080/movie/u/p/10.mpd?t=1' }));
    expect(player.getPlaybackRateState().available).toBe(false);

    player.playVod(req({ url: 'http://host:8080/movie/u/p/10?output=m3u8' }));
    expect(player.getPlaybackRateState().available).toBe(false);

    player.playVod(req({ url: 'http://host:8080/movie/u/p/10?output_format=mpd' }));
    expect(player.getPlaybackRateState().available).toBe(false);
  });

  it('resets playback speed when starting another VOD item', async () => {
    const video = fakeVideo(3600);
    player.init(video);
    player.playVod(req());
    await player.setPlaybackRate(2);

    player.playVod(req({ itemId: '11', title: 'Movie Two' }));

    expect(video.playbackRate).toBe(1);
    expect(player.getPlaybackRateState()).toEqual({ available: true, rate: 1 });
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
    expect(StorageService.setResume).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: '10', position: 1200, duration: 3600, ext: 'mp4' }), { keepStart: false });
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
    }), { keepStart: false });
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

  it('keeps Right from opening the menu during the up-next countdown', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    player.playVod(req({ watchlistQueue: [{
      url: 'http://host:8080/movie/u/p/11.mp4', title: 'Movie Two',
      poster: '', accountId: 'x1', itemId: '11', kind: 'vod' as const, subtitles: [],
    }] }));

    video.dispatchEvent(new Event('ended'));
    expect(container.textContent).toContain('Starts in 10 seconds');
    (player as unknown as { osd: { hide(): void } }).osd.hide();
    expect(player.vodRightOpensMenu()).toBe(false);
    player.stop();
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

  it('leaves the player while a locked next item waits for the PIN', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    let locked = false;
    let deferred: (() => void) | null = null;
    const authorize = vi.fn((_item, action: () => void) => {
      if (!locked) { action(); return true; }
      deferred = action;
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const next = {
      url: 'http://host:8080/movie/u/p/11.mp4', title: 'Movie Two',
      poster: '', accountId: 'x1', itemId: '11', kind: 'vod' as const, subtitles: [],
    };
    const r = req({ watchlistQueue: [next] });
    player.playVod(r);
    video.dispatchEvent(new Event('ended'));
    vi.mocked(r.onBack).mockClear();
    locked = true;

    player.handleAction('select');

    expect(r.onBack).toHaveBeenCalledTimes(1);
    expect(player.isVod()).toBe(false);
    (deferred as unknown as () => void)();
    expect(player.isVod()).toBe(true);
  });

  it('continues to the next episode of an unlocked series without the PIN', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    let locked = false;
    const authorize = vi.fn((_item, action: () => void) => {
      if (!locked) { action(); return true; }
      return false;
    });
    player = new Player(
      container, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, authorize,
    );
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const series = { kind: 'episode' as const, categoryId: 'c1', parentalItemId: 's1' };
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', subtitles: [], ...series,
    };
    player.playVod(req({ itemId: 'e1', episodeQueue: [next], ...series }));
    video.dispatchEvent(new Event('ended'));
    locked = true;
    authorize.mockClear();

    player.handleAction('select');

    expect(authorize).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
  });

  it('offers playback speed only once the queued item starts playing', async () => {
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

    video.dispatchEvent(new Event('ended'));
    expect(player.getPlaybackRateState().available).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(player.getPlaybackRateState().available).toBe(true);
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

  it('moves a series\' place to its next episode when one ends', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const owner = { kind: 'series' as const, itemId: 's1' };
    const next = {
      url: 'http://host:8080/series/u/p/e3.mkv', title: 'Series One — S1E3',
      poster: '', accountId: 'x1', itemId: 'e3', kind: 'episode' as const, subtitles: [],
      searchMeta: { season: 1, episode: 3 }, watchlistOwner: owner,
    };
    const later = { ...next, itemId: 'e4', title: 'Series One — S1E4' };
    vi.mocked(StorageService.getResumeList).mockReturnValueOnce([
      { accountId: 'x1', kind: 'episode', itemId: 'e1', name: '', poster: '', ext: 'mp4',
        position: 600, duration: 1800, updatedAt: 1, watchlistOwner: owner },
      { accountId: 'x1', kind: 'episode', itemId: 'e9', name: '', poster: '', ext: 'mp4',
        position: 600, duration: 1800, updatedAt: 1, watchlistOwner: { kind: 'series', itemId: 's2' } },
    ]);
    vi.mocked(StorageService.clearResume).mockClear();
    vi.mocked(StorageService.setResume).mockClear();
    player.playVod(req({ itemId: 'e2', kind: 'episode', episodeQueue: [next, later], watchlistOwner: owner }));
    video.dispatchEvent(new Event('ended'));

    expect(vi.mocked(StorageService.clearResume).mock.calls).toEqual([
      ['x1', 'episode', 'e1'], ['x1', 'episode', 'e2'],
    ]);
    expect(StorageService.setResume).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'e3', position: 0, ext: 'mkv', season: 1, episode: 3,
      episodeQueue: [later], watchlistOwner: owner,
    }), { keepStart: true });
    // Leaving during the countdown keeps that place rather than clearing it.
    vi.mocked(StorageService.setResume).mockClear();
    player.handleAction('back');
    expect(StorageService.setResume).not.toHaveBeenCalled();
  });

  it('keeps later episodes\' progress when an earlier one ends', () => {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
    container.appendChild(video);
    player.init(video);
    const owner = { kind: 'series' as const, itemId: 's1' };
    const point = (itemId: string, episode: number, position: number) => ({
      accountId: 'x1', kind: 'episode' as const, itemId, name: '', poster: '', ext: 'mp4',
      position, duration: 1800, updatedAt: 1, watchlistOwner: owner, season: 1, episode,
    });
    const next = {
      url: 'http://host:8080/series/u/p/e5.mp4', title: 'Series One — S1E5',
      poster: '', accountId: 'x1', itemId: 'e5', kind: 'episode' as const, subtitles: [],
      searchMeta: { season: 1, episode: 5 }, watchlistOwner: owner,
    };
    vi.mocked(StorageService.getResumeList).mockReturnValueOnce([
      point('e3', 3, 300), point('e5', 5, 1200), point('e6', 6, 600),
    ]);
    vi.mocked(StorageService.clearResume).mockClear();
    vi.mocked(StorageService.setResume).mockClear();
    player.playVod(req({
      itemId: 'e4', kind: 'episode', episodeQueue: [next], watchlistOwner: owner,
      searchMeta: { season: 1, episode: 4 },
    }));
    video.dispatchEvent(new Event('ended'));

    expect(vi.mocked(StorageService.clearResume).mock.calls).toEqual([
      ['x1', 'episode', 'e3'], ['x1', 'episode', 'e4'],
    ]);
    expect(StorageService.setResume).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'e5', position: 1200, duration: 1800 }), { keepStart: true });
  });

  it('moves a series\' place on when Back leaves an episode in its credits', () => {
    const video = fakeVideo(1800);
    player.init(video);
    const owner = { kind: 'series' as const, itemId: 's1' };
    const next = {
      url: 'http://host:8080/series/u/p/e2.mp4', title: 'Series One — S1E2',
      poster: '', accountId: 'x1', itemId: 'e2', kind: 'episode' as const, subtitles: [],
      watchlistOwner: owner,
    };
    vi.mocked(StorageService.clearResume).mockClear();
    vi.mocked(StorageService.setResume).mockClear();
    player.playVod(req({ itemId: 'e1', kind: 'episode', episodeQueue: [next], watchlistOwner: owner }));
    video.dispatchEvent(new Event('loadedmetadata'));
    video.currentTime = 1780;
    player.handleAction('back');
    expect(StorageService.clearResume).toHaveBeenCalledWith('x1', 'episode', 'e1');
    expect(StorageService.setResume).toHaveBeenCalledTimes(1);
    expect(StorageService.setResume).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'e2', position: 0 }), { keepStart: true });
  });

  it('finishes a series when Back leaves its final episode in the credits', () => {
    const video = fakeVideo(1800);
    player.init(video);
    const owner = { kind: 'series' as const, itemId: 's1' };
    vi.mocked(StorageService.getResumeList).mockReturnValueOnce([
      { accountId: 'x1', kind: 'episode', itemId: 'e9', name: '', poster: '', ext: 'mp4',
        position: 600, duration: 1800, updatedAt: 1, watchlistOwner: owner },
    ]);
    vi.mocked(StorageService.clearResume).mockClear();
    vi.mocked(StorageService.removeWatchlist).mockClear();
    player.playVod(req({ itemId: 'e9', kind: 'episode', episodeQueue: [], watchlistOwner: owner }));
    video.dispatchEvent(new Event('loadedmetadata'));
    video.currentTime = 1790;
    player.handleAction('back');
    expect(vi.mocked(StorageService.clearResume).mock.calls).toEqual([['x1', 'episode', 'e9']]);
    expect(StorageService.removeWatchlist).toHaveBeenCalledWith('x1', 'series', 's1');
  });

  it('keeps a resumed episode\'s place when it is left near its start', () => {
    const video = fakeVideo(1800);
    player.init(video);
    player.playVod(req({ itemId: 'e1', kind: 'episode', holdsSeriesPlace: true }));
    video.currentTime = 5;
    player.handleAction('back');
    expect(StorageService.setResume).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: 'e1', position: 5 }), { keepStart: true });
  });

  describe('episode skips', () => {
    const owner = { kind: 'series' as const, itemId: 's1' };
    const ep = (n: number) => ({
      url: `http://host:8080/series/u/p/e${n}.mp4`, title: `Series One — S1E${n}`, poster: '',
      accountId: 'x1', itemId: `e${n}`, kind: 'episode' as const, subtitles: [],
      categoryId: 'c1', parentalItemId: 's1', watchlistOwner: owner,
    });
    const playing = () => (player as unknown as { vod: {
      itemId: string; resumeSecs: number; holdsSeriesPlace?: boolean;
      episodeQueue?: { itemId: string }[]; previousEpisodes?: { itemId: string }[];
    } | null }).vod;
    const ids = (items?: { itemId: string }[]) => (items ?? []).map((item) => item.itemId);

    beforeEach(() => {
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      HTMLMediaElement.prototype.pause = vi.fn();
      HTMLMediaElement.prototype.load = vi.fn();
      const video = document.createElement('video');
      Object.defineProperty(video, 'duration', { value: 1800, configurable: true });
      container.appendChild(video);
      player.init(video);
      vi.mocked(StorageService.setResume).mockClear();
    });

    it('steps CH+ and CH- through the series, keeping each episode\'s point', () => {
      player.playVod(req({ ...ep(2), resumeSecs: 0, previousEpisodes: [ep(1)], episodeQueue: [ep(3), ep(4)] }));
      vi.mocked(StorageService.getResume).mockImplementation((_a, _k, id) => id === 'e3'
        ? { accountId: 'x1', kind: 'episode', itemId: 'e3', name: '', poster: '', ext: 'mp4',
            position: 300, duration: 1800, updatedAt: 1 }
        : null);
      document.querySelector<HTMLVideoElement>('video')!.currentTime = 600;

      player.handleAction('channel_up');
      expect(StorageService.setResume).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'e2', position: 600 }), { keepStart: false });
      expect(playing()).toMatchObject({ itemId: 'e3', resumeSecs: 300, holdsSeriesPlace: true });
      expect(ids(playing()?.previousEpisodes)).toEqual(['e1', 'e2']);
      expect(ids(playing()?.episodeQueue)).toEqual(['e4']);

      player.handleAction('channel_down');
      expect(playing()).toMatchObject({ itemId: 'e2', resumeSecs: 0 });
      expect(ids(playing()?.previousEpisodes)).toEqual(['e1']);
      expect(ids(playing()?.episodeQueue)).toEqual(['e3', 'e4']);
      vi.mocked(StorageService.getResume).mockReturnValue(null);
    });

    it('opens one stream for a run of presses, once they settle', async () => {
      vi.useFakeTimers();
      try {
        player.playVod(req({ ...ep(1), resumeSecs: 0, episodeQueue: [ep(2), ep(3), ep(4)] }));
        vi.mocked(probeMedia).mockClear();
        player.handleAction('channel_up');
        player.handleAction('channel_up');
        expect(playing()?.itemId).toBe('e3');
        expect(container.querySelector('.osd-channel-name')?.textContent).toContain('S1E3');
        expect(probeMedia).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.EPISODE_SKIP_SETTLE_MS);
        expect(vi.mocked(probeMedia).mock.calls.map((call) => call[1])).toEqual(['x1|media_probe|episode|e3']);
        expect(ids(playing()?.previousEpisodes)).toEqual(['e1', 'e2']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores the wheel', () => {
      player.playVod(req({ ...ep(2), resumeSecs: 0, previousEpisodes: [ep(1)], episodeQueue: [ep(3)] }));
      const wheel = vi.spyOn(KeyHandler, 'isWheelAction').mockReturnValue(true);
      player.handleAction('channel_up');
      expect(playing()?.itemId).toBe('e2');
      expect(StorageService.setResume).not.toHaveBeenCalled();
      wheel.mockRestore();
      player.handleAction('channel_up');
      expect(playing()?.itemId).toBe('e3');
    });

    it('leaves an episode still starting without its startup timeout closing the player', async () => {
      const r = req({ ...ep(1), resumeSecs: 0, episodeQueue: [ep(2)] });
      player.playVod(r);
      document.querySelector<HTMLVideoElement>('video')!.dispatchEvent(new Event('loadstart'));
      vi.mocked(showToast).mockClear();
      vi.mocked(probeMedia).mockClear();
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.STARTUP_TIMEOUT - 100);
      player.handleAction('channel_up');
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.EPISODE_SKIP_SETTLE_MS);
      expect(showToast).not.toHaveBeenCalled();
      expect(r.onBack).not.toHaveBeenCalled();
      expect(playing()?.itemId).toBe('e2');
      expect(vi.mocked(probeMedia).mock.calls.map((call) => call[1])).toEqual(['x1|media_probe|episode|e2']);
    });

    it('drops the episode left\'s stream info, subtitles and menu while a skip is pending', async () => {
      vi.mocked(probeMedia).mockResolvedValue({ videoCodec: 'hvc1', audioCodec: 'ec-3', width: 3840, height: 2160, fps: 24 });
      player.playVod(req({ ...ep(1), resumeSecs: 0, episodeQueue: [ep(2)] }));
      await flush();
      const info = () => container.querySelector('.osd-stream-info')?.textContent ?? '';
      expect(info()).toContain('HEVC');
      const tracks = (player as unknown as { tracks: { stop(): void } }).tracks;
      const stopTracks = vi.spyOn(tracks, 'stop');
      player.handleAction('channel_up');
      expect(info()).not.toContain('HEVC');
      expect(stopTracks).toHaveBeenCalled();
      expect(player.vodRightOpensMenu()).toBe(false);
    });

    it('starts a skip pending when the app hides only once it is back', async () => {
      player.playVod(req({ ...ep(1), resumeSecs: 0, episodeQueue: [ep(2)] }));
      vi.mocked(probeMedia).mockClear();
      player.handleAction('channel_up');
      player.suspend();
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.EPISODE_SKIP_SETTLE_MS);
      expect(probeMedia).not.toHaveBeenCalled();
      player.resume();
      expect(playing()?.itemId).toBe('e2');
      expect(vi.mocked(probeMedia).mock.calls.map((call) => call[1])).toEqual(['x1|media_probe|episode|e2']);
    });

    it('steps back from the credits without finishing the series', () => {
      vi.mocked(StorageService.removeWatchlist).mockClear();
      player.playVod(req({ ...ep(3), resumeSecs: 0, previousEpisodes: [ep(1), ep(2)], episodeQueue: [] }));
      document.querySelector<HTMLVideoElement>('video')!.currentTime = 1790;
      player.handleAction('channel_down');
      expect(playing()?.itemId).toBe('e2');
      expect(StorageService.removeWatchlist).not.toHaveBeenCalled();
      expect(StorageService.setResume).toHaveBeenCalledTimes(1);
      expect(StorageService.setResume).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'e3', position: 1790 }), { keepStart: false });
    });

    it('stays put at the series\' ends, on a movie, and during the up-next countdown', () => {
      player.playVod(req({ ...ep(1), resumeSecs: 0, episodeQueue: [] }));
      player.handleAction('channel_down');
      player.handleAction('channel_up');
      expect(playing()?.itemId).toBe('e1');

      player.playVod(req({ previousEpisodes: [ep(1)], episodeQueue: [ep(2)] }));
      player.handleAction('channel_up');
      expect(playing()?.itemId).toBe('10');

      player.playVod(req({ ...ep(1), resumeSecs: 0, episodeQueue: [ep(2), ep(3)] }));
      document.querySelector<HTMLVideoElement>('video')!.dispatchEvent(new Event('ended'));
      expect(playing()?.itemId).toBe('e2');
      expect(ids(playing()?.previousEpisodes)).toEqual(['e1']);
      player.handleAction('channel_up');
      expect(playing()?.itemId).toBe('e2');
      expect(container.textContent).toContain('Starts in 10 seconds');
    });
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
    const r = req({ url: 'http://host:8080/movie/u/p/10.mkv' });
    player.playVod(r);
    video.dispatchEvent(new Event('loadstart'));
    vi.mocked(showToast).mockClear();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_POLL_MS);

    // A rejected source never becomes currentSrc, so the URL comes from the request.
    const detail = logged.mock.calls[0].join(' ');
    expect(detail).toContain('extension=mkv');
    expect(detail).toContain('url=http://host:8080/movie/***/***/10.mkv');
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

  it('logs the Luna stream URL, not the placeholder, when a Luna start fails', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    Object.defineProperty(video, 'currentSrc', {
      configurable: true, get: () => `http://app/${CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER}`,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    player.init(video);
    const pipeline = (player as unknown as { pipeline: { lunaStreamUrl(): string } }).pipeline;
    vi.spyOn(pipeline, 'lunaStreamUrl').mockReturnValue('http://host/live/u/p/1.m3u8');
    player.playVod(req());
    video.dispatchEvent(new Event('loadstart'));

    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_TIMEOUT);

    const line = error.mock.calls.map(args => args.join(' '))
      .find(text => text.includes('event=playback.startup.failed'));
    expect(line).toContain(diagnosticStreamUrl('http://host/live/u/p/1.m3u8'));
    expect(line).not.toContain(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER);
  });

  it('does not read the element\'s reload after a Luna fallback as a refused source', () => {
    const video = fakeVideo(3600);
    Object.assign(video, { readyState: 0, networkState: 2 });
    player.init(video);
    player.playVod(req());
    video.dispatchEvent(new Event('loadstart'));
    vi.advanceTimersByTime(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS - 200);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(showToast).mockClear();

    // The fallback reloads the element, which reads NETWORK_NO_SOURCE until
    // resource selection runs in a later task.
    const pipeline = player as unknown as {
      pipeline: { callbacks: { onPlaybackPathChange(): void } };
    };
    pipeline.pipeline.callbacks.onPlaybackPathChange();
    Object.assign(video, { networkState: 3 });
    setTimeout(() => {
      Object.assign(video, { networkState: 2 });
      video.dispatchEvent(new Event('loadstart'));
    }, 300);
    vi.advanceTimersByTime(CONFIG.PLAYER.STARTUP_POLL_MS * 2);

    expect(error.mock.calls.map(args => args.join(' ')).join('\n'))
      .not.toContain('event=playback.startup.failed');
    expect(showToast).not.toHaveBeenCalled();
    expect(player.isVod()).toBe(true);
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
  it('maps reliably recognized progressive extensions to their MIME', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.m4v')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.ts')).toBe('video/mp2t');
  });

  it('ignores query strings and fragments when reading the extension', () => {
    expect(containerMime('http://host/movie/u/p/10.mp4?token=x')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10.mkv#frag')).toBe('');
  });

  it('claims no type for containers without reliable webOS MIME recognition', () => {
    expect(containerMime('http://host/movie/u/p/10.mkv')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.avi')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.mov')).toBe('');
    expect(containerMime('http://host/movie/u/p/10.webm')).toBe('');
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

  it('redacts the whole local proxy token and treats the upstream URL as a direct one', () => {
    const token = 'ab'.repeat(16);
    expect(diagnosticStreamUrl(
      `http://127.0.0.1:8080/p/${token}/http/host/live/u1/p1/1.ts?token=x&start=10`,
    )).toBe('http://127.0.0.1:8080/p/***/http/host/live/***/***/1.ts?token=***&start=10');
    expect(diagnosticStreamUrl(`http://127.0.0.1:8080/p/${token}/https/host:8443/a.m3u8`))
      .toBe('http://127.0.0.1:8080/p/***/https/host:8443/a.m3u8');
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
    const offset = document.getElementById('subtitle-offset')!;
    expect(offset.classList.contains('hidden')).toBe(false);
    // The overlay owns its keys while open, ahead of the player view.
    expect(Focus.owner()?.id).toBe('player.subtitle_offset');
    expect(Focus.owner()?.handle('right')).toBe(true);
    expect(Focus.owner()?.handle('back')).toBe(true);
    expect(offset.classList.contains('hidden')).toBe(true);
    expect(Focus.owner()).toBeNull();
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

    expect(play).toHaveBeenCalledWith(1, undefined, null);
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

describe('Player channel_up/channel_down view scope', () => {
  // Global order deliberately interleaves a non-favorite (OTHER) between two
  // favorites — exactly the real-world layout that made channel_up from
  // Favorites land on a non-favorite channel before this fix.
  const FAV_A = { id: 'fa', name: 'FavA', logo: '', group: '', url: 'http://host/fa', extras: null, playlistIds: [], catchupDays: 0 };
  const OTHER = { id: 'ox', name: 'Other', logo: '', group: '', url: 'http://host/ox', extras: null, playlistIds: [], catchupDays: 0 };
  const FAV_B = { id: 'fb', name: 'FavB', logo: '', group: '', url: 'http://host/fb', extras: null, playlistIds: [], catchupDays: 0 };
  const FAV_C = { id: 'fc', name: 'FavC', logo: '', group: '', url: 'http://host/fc', extras: null, playlistIds: [], catchupDays: 0 };
  const GLOBAL = [FAV_A, OTHER, FAV_B, FAV_C];
  let favorites: (typeof FAV_A)[];

  beforeEach(() => {
    favorites = [FAV_A, FAV_B, FAV_C];
    playlistMock.channels = GLOBAL;
    playlistMock.getByIndex.mockImplementation((i: number) => GLOBAL[i] ?? null);
    playlistMock.indexOf.mockImplementation((ch: unknown) => GLOBAL.indexOf(ch as never));
    playlistMock.getByGroup.mockImplementation(() => favorites);
    // These tests exercise scoped stepping, which only applies when the
    // user opted into it — settings.channelCycleMode: 'active'.
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('active');
  });
  afterEach(() => {
    playlistMock.channels = [];
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
  });

  it('steps within the launch scope, skipping channels outside it', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_B); // not OTHER, which sits between them globally
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('passes over parental-locked channels in both directions', () => {
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
    const decision = vi.spyOn(ParentalControlService, 'decision').mockImplementation(request =>
      request.target.kind === 'live-channel' && request.target.channelKey === channelKey(OTHER as never)
        ? { allowed: false, concealed: false, reason: 'item' }
        : { allowed: true });
    const enabled = vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    try {
      player.play(0); // FAV_A
      player.channelUp();
      expect(player.getCurrentChannel()).toBe(FAV_B);
      player.channelDown();
      expect(player.getCurrentChannel()).toBe(FAV_A);
    } finally {
      decision.mockRestore();
      enabled.mockRestore();
    }
  });

  it('wraps at the end of the scope instead of spilling into the full list', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp(); // -> FAV_B
    player.channelUp(); // -> FAV_C
    player.channelUp(); // wraps
    expect(player.getCurrentChannel()).toBe(FAV_A);
  });

  it('wraps backward the same way with channelDown', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelDown();
    expect(player.getCurrentChannel()).toBe(FAV_C); // wraps to the scope's last entry
  });

  it('picks up a live change to the scope on the very next press', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = [FAV_A, FAV_C]; // FAV_B unfavorited mid-playback
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('falls back to the global list when the playing channel drops out of scope', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, global index 0
    favorites = [FAV_B, FAV_C]; // FAV_A itself unfavorited while it's still playing
    player.channelUp();
    // FAV_A is gone from the scope — resume plain global stepping from its
    // global index (0) instead of a remembered slot in the stale scope.
    expect(player.getCurrentChannel()).toBe(OTHER);
  });

  it('falls back to the global list when the scope becomes empty', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = []; // the whole group emptied out mid-playback
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // global neighbor of FAV_A
  });

  it('stays on global stepping for a scope it already fell back out of', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    favorites = [FAV_B, FAV_C]; // FAV_A drops out
    player.channelUp(); // falls back to global -> OTHER, and clears the scope
    player.channelUp(); // now plain global stepping from OTHER
    expect(player.getCurrentChannel()).toBe(FAV_B);
  });

  it('keeps a scope across internal channelUp/channelDown replays', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.channelUp(); // -> FAV_B, via the internal 2-arg play() call
    player.channelUp(); // still scoped -> FAV_C, not the global next (FAV_C anyway, but via scope math)
    expect(player.getCurrentChannel()).toBe(FAV_C);
  });

  it('has no scope when launched without one — channel_up cycles the full list', () => {
    player.play(0); // no scope passed at all
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // the full-list neighbor, not a favorite
  });

  it('a global number jump mid-scope clears the scope for the next channel_up', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A
    player.handleAction('number', { number: 2 }); // jump to global index 1 = OTHER
    expect(player.getCurrentChannel()).toBe(OTHER);
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(FAV_B); // global neighbor of OTHER, not scoped
  });

  it('keeps the OSD channel number global even while scoped to Favorites', () => {
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, global index 0
    player.channelUp(); // -> FAV_B, global index 2
    expect(player.getCurrentIndex()).toBe(2);
  });

  it('ignores an active launch scope when settings.channelCycleMode is global (the default)', () => {
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
    player.play(0, undefined, { group: 'builtin:favorites' }); // FAV_A, scope tracked either way
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(OTHER); // full-list neighbor, not FAV_B
  });
});
