// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { playlistMock, subtitleSearchServiceMock } = vi.hoisted(() => {
  let mockIsAvailable = false;
  return {
    playlistMock: { channels: [] as unknown[], getByIndex: vi.fn() },
    subtitleSearchServiceMock: {
      isAvailable: () => mockIsAvailable,
      preferredLanguage: () => '',
      search: vi.fn(),
      download: vi.fn(async () => ({ text: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n', format: 'srt' as const })),
      __setMockAvailable: (v: boolean) => { mockIsAvailable = v; },
    },
  };
});

vi.mock('../services/playlist-service', () => ({ PlaylistService: playlistMock }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null, getUpcoming: () => [] },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    setLastChannel: vi.fn(), getSubtitlePref: vi.fn(), setSubtitlePref: vi.fn(),
    getAudioPref: vi.fn(), setAudioPref: vi.fn(),
    getStreamMime: vi.fn(() => null), setStreamMime: vi.fn(),
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
  subtitleSearchService: subtitleSearchServiceMock,
}));
vi.mock('../services/idb-cache', () => ({
  getCachedSubtitle: vi.fn(),
  setCachedSubtitle: vi.fn(),
}));

import { Player, ASS_SUBTITLE_BASE } from './player';
import {
  containerMime,
  extFromUrl,
  sniffStreamContentType,
  streamMime,
  streamRouteKey,
} from '../utils/url';
import { StorageService } from '../services/storage-service';
import { showToast } from './toast';
import { probeMedia } from '../services/media-probe';
import { getCachedSubtitle, setCachedSubtitle } from '../services/idb-cache';
import { CONFIG } from '../config';
import { channelKey } from '../utils/channel';

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
    play: () => { paused = false; return Promise.resolve(); },
    pause() { paused = true; },
    load() {}, removeAttribute() {}, appendChild() {}, set innerHTML(_: string) {},
    addEventListener(type: string, fn: () => void) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(e: Event) { (listeners[e.type] || []).forEach((fn) => fn()); return true; },
  } as unknown as HTMLVideoElement;
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
  vi.mocked(probeMedia).mockResolvedValue(null);
  player = new Player(container, vi.fn());
  video = fakeVideo(120);
  player.init(video);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const bar = () => container.querySelector('.osd-progress-bar') as HTMLElement;
const elapsed = () => container.querySelector('.osd-time-current')!.textContent;

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

  it('aborts the previous manifest probe when a new one starts', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) => {
      signals.push(opts.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    const internals = player as unknown as {
      loadManifestTracks(url: string, seq: number): Promise<void>;
    };

    const first = internals.loadManifestTracks('http://host/a', 0);
    await Promise.resolve();
    const second = internals.loadManifestTracks('http://host/b', 0);
    await Promise.resolve();

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    player.stop();
    await Promise.all([first, second]);
  });

  it('coalesces repeated playback errors into one channel advance', () => {
    playlistMock.channels = [{}, {}];
    player.play(0);
    playlistMock.getByIndex.mockClear();

    for (let i = 0; i < 20; i++) video.dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(2000);

    expect(playlistMock.getByIndex).toHaveBeenCalledTimes(1);
    expect(playlistMock.getByIndex).toHaveBeenCalledWith(1);
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

describe('Player live DVR', () => {
  let live: HTMLVideoElement;
  let setWindow: (s: number, e: number) => void;
  const PAD = CONFIG.PLAYER.DVR_GO_LIVE_PAD;

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
    expect(live.currentTime).toBe(0);
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
    player.handleAction('rewind'); // to 0
    player.handleAction('pause');
    setWindow(20, 80); // window rolled forward while paused
    player.handleAction('play');
    expect(live.currentTime).toBe(20);
  });

  // The OSD controls are driven from click by coordinates, like the seek bar.
  it('a pointer click on the pause control pauses playback', () => {
    const btn = container.querySelector('[data-playpause]') as HTMLElement;
    btn.getBoundingClientRect = () => ({ left: 10, right: 42, width: 32, top: 0, bottom: 32 }) as DOMRect;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 26, clientY: 16 }));
    expect(live.paused).toBe(true);
  });

  it('a pointer release on the Go-to-Live control seeks to the live edge', () => {
    player.handleAction('rewind'); // move to the oldest point (0)
    expect(live.currentTime).toBe(0);
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

describe('Player audio track picker', () => {
  // Native path with a collapsed manifest: 3 declared renditions but the TV
  // exposes only 2 tracks (two share a language). The manifest non-conformantly
  // tags two renditions DEFAULT=YES; the picker must still check exactly one row
  // — the track actually enabled — not every manifest default.
  it('checks only the playing track, not every manifest DEFAULT', () => {
    (player as unknown as { hls: unknown }).hls = null;
    (player as unknown as { videoEl: unknown }).videoEl = {
      audioTracks: {
        length: 2,
        0: { label: '', language: 'l1', enabled: true },
        1: { label: '', language: 'l2', enabled: false },
      },
    };
    (player as unknown as { manifestAudio: unknown }).manifestAudio = [
      { name: 'Track 1', lang: 'l1', isDefault: true },
      { name: 'Track 2', lang: 'l2', isDefault: true },
      { name: 'Track 3', lang: 'l1', isDefault: false },
    ];

    const tracks = player.getAudioTracks();
    expect(tracks.map((t) => t.active)).toEqual([true, false, false]);
    expect(tracks[2].available).toBe(false); // collapsed alternate grayed out
  });
});

describe('Player subtitle self-render (webOS native path)', () => {
  // In-manifest WebVTT is self-rendered on the native path. Inject a fake
  // controller so we can assert what gets rendered without real fetches, and
  // drive the native branch by clearing `hls`.
  let subs: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; active: boolean };

  const rendition = (name: string, lang: string, over: { isDefault?: boolean; isForced?: boolean } = {}) =>
    ({ name, lang, isDefault: !!over.isDefault, isForced: !!over.isForced });

  const setup = (manifestSubtitles: unknown[], selfRenderIndex = -1) => {
    subs = { start: vi.fn(), stop: vi.fn(), active: false, setOffset: vi.fn(), owns: vi.fn(() => false) };
    const p = player as unknown as Record<string, unknown>;
    p.hls = null;
    p.videoEl = { textTracks: { length: 0 } };
    p.subs = subs;
    p.manifestSubtitles = manifestSubtitles;
    p.masterUrl = 'http://host/master.m3u8';
    p.selfRenderIndex = selfRenderIndex;
    p.currentChannel = CHANNEL;
  };
  const applySelfRender = () =>
    (player as unknown as { applySelfRenderSelection(): void }).applySelfRenderSelection();

  beforeEach(() => vi.mocked(StorageService.getSubtitlePref).mockReset());

  it('does not self-render a DEFAULT-only rendition on tune-in (off unless forced)', () => {
    setup([rendition('Track 1', 'l1', { isDefault: true })]);
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue(null);
    applySelfRender();
    expect(subs.start).not.toHaveBeenCalled();
  });

  it('auto-self-renders a FORCED rendition on tune-in', () => {
    setup([rendition('Track 1', 'l1', { isDefault: true }), rendition('Track 2', 'l2', { isForced: true })]);
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue(null);
    applySelfRender();
    expect(subs.start).toHaveBeenCalledWith(expect.anything(), 'http://host/master.m3u8', { name: 'Track 2', lang: 'l2' });
  });

  it('re-applies a saved subtitle pick on tune-in', () => {
    setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue({ off: false, name: 'Track 2', lang: 'l2' });
    applySelfRender();
    expect(subs.start).toHaveBeenCalledWith(expect.anything(), expect.any(String), { name: 'Track 2', lang: 'l2' });
  });

  it('stays off when the saved pref is an explicit off (survives re-tune)', () => {
    setup([rendition('Track 1', 'l1', { isDefault: true })]);
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue({ off: true, name: '', lang: '' });
    applySelfRender();
    expect(subs.start).not.toHaveBeenCalled();
  });

  it('selecting a subtitle self-renders it and remembers the pick', () => {
    setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
    player.selectSubtitleTrack(1);
    expect(subs.start).toHaveBeenCalledWith(expect.anything(), 'http://host/master.m3u8', { name: 'Track 2', lang: 'l2' });
    expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(expect.any(String), { off: false, name: 'Track 2', lang: 'l2' });
  });

  it('selecting Off stops self-render and remembers off', () => {
    setup([rendition('Track 1', 'l1')], 0);
    player.selectSubtitleTrack(-1);
    expect(subs.stop).toHaveBeenCalled();
    expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(expect.any(String), { off: true, name: '', lang: '' });
  });

  it('lists the manifest renditions with the self-rendered one active and all selectable', () => {
    setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')], 1);
    const tracks = player.getSubtitleTracks();
    expect(tracks.map((t) => t.label)).toEqual(['Track 1', 'Track 2']);
    expect(tracks.map((t) => t.active)).toEqual([false, true]);
    expect(tracks.every((t) => t.available)).toBe(true);
  });
});

describe('Player VOD audio/subtitle track selection (native, in-container)', () => {
  // Plain arrays satisfy the length + indexed reads/writes the player does on
  // audioTracks / textTracks, so they stand in for the native track lists.
  const audioTrack = (enabled: boolean, over: { label?: string; language?: string } = {}) =>
    ({ label: over.label ?? '', language: over.language ?? '', enabled });
  const textTrack = (mode: TextTrackMode, over: { kind?: string; label?: string; language?: string } = {}) =>
    ({ kind: over.kind ?? 'subtitles', label: over.label ?? '', language: over.language ?? '', mode });

  const setup = (opts: { audio?: unknown[]; text?: unknown[] } = {}) => {
    const p = player as unknown as Record<string, unknown>;
    p.hls = null;
    p.vod = {
      url: 'http://host/movie.mkv', title: 'Movie One', poster: '',
      accountId: 'x1', itemId: '10', kind: 'vod', resumeSecs: 0, onBack: vi.fn(),
    };
    p.videoEl = { audioTracks: opts.audio, textTracks: opts.text };
    p.currentChannel = null;
  };
  const applyAudio = () => (player as unknown as { applyNativeAudioSelection(): void }).applyNativeAudioSelection();
  const applySubs = () => (player as unknown as { applyNativeSubtitleSelection(): void }).applyNativeSubtitleSelection();

  beforeEach(() => {
    vi.mocked(StorageService.getSubtitlePref).mockReset();
    vi.mocked(StorageService.setSubtitlePref).mockReset();
    vi.mocked(StorageService.getAudioPref).mockReset();
    vi.mocked(StorageService.setAudioPref).mockReset();
    vi.mocked(StorageService.getSubtitleOffset).mockReset().mockReturnValue(0);
    vi.mocked(StorageService.setSubtitleOffset).mockReset();
  });

  it('lists subtitle tracks from the native textTracks with the showing one active', () => {
    setup({ text: [
      textTrack('disabled', { label: 'Track 1', language: 'l1' }),
      textTrack('showing', { label: 'Track 2', language: 'l2' }),
    ] });
    const tracks = player.getSubtitleTracks();
    expect(tracks.map((t) => t.label)).toEqual(['Track 1', 'Track 2']);
    expect(tracks.map((t) => t.active)).toEqual([false, true]);
    expect(tracks.every((t) => t.available)).toBe(true);
  });

  it('selecting a subtitle shows that textTrack, disables the others, and remembers it', () => {
    const text = [textTrack('disabled', { label: 'Track 1' }), textTrack('disabled', { label: 'Track 2' })];
    setup({ text });
    player.selectSubtitleTrack(1);
    expect(text.map((t) => t.mode)).toEqual(['disabled', 'showing']);
    expect(StorageService.setSubtitlePref).toHaveBeenCalledWith('vod:x1:vod:10', { off: false, name: 'Track 2', lang: '' });
  });

  it('selecting Off disables every native textTrack and remembers off', () => {
    const text = [textTrack('showing', { label: 'Track 1' }), textTrack('disabled', { label: 'Track 2' })];
    setup({ text });
    player.selectSubtitleTrack(-1);
    expect(text.map((t) => t.mode)).toEqual(['disabled', 'disabled']);
    expect(StorageService.setSubtitlePref).toHaveBeenCalledWith('vod:x1:vod:10', { off: true, name: '', lang: '' });
  });

  it('lazily loads a sidecar track when it is shown', () => {
    const text = [textTrack('disabled', { label: 'Track 1' })];
    setup({ text });
    const vodSubs = { attach: vi.fn(), ensureLoaded: vi.fn(), clear: vi.fn(), setOffset: vi.fn(), owns: vi.fn(() => false) };
    (player as unknown as { vodSubs: unknown }).vodSubs = vodSubs;
    player.selectSubtitleTrack(0);
    expect(text[0].mode).toBe('showing');
    expect(vodSubs.ensureLoaded).toHaveBeenCalledWith(text[0]);
  });

  it('does not load anything when subtitles are turned off', () => {
    const text = [textTrack('showing', { label: 'Track 1' })];
    setup({ text });
    const vodSubs = { attach: vi.fn(), ensureLoaded: vi.fn(), clear: vi.fn(), setOffset: vi.fn(), owns: vi.fn(() => false) };
    (player as unknown as { vodSubs: unknown }).vodSubs = vodSubs;
    player.selectSubtitleTrack(-1);
    expect(vodSubs.ensureLoaded).not.toHaveBeenCalled();
  });

  it('re-applies a saved subtitle pick when tracks arrive', () => {
    const text = [
      textTrack('disabled', { label: 'Track 1', language: 'l1' }),
      textTrack('disabled', { label: 'Track 2', language: 'l2' }),
    ];
    setup({ text });
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue({ off: false, name: 'Track 2', lang: 'l2' });
    applySubs();
    expect(text.map((t) => t.mode)).toEqual(['disabled', 'showing']);
  });

  it('leaves subtitles off by default when there is no saved pick', () => {
    const text = [textTrack('showing', { label: 'Track 1' })]; // pipeline auto-enabled one
    setup({ text });
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue(null);
    applySubs();
    expect(text.map((t) => t.mode)).toEqual(['disabled']);
  });

  it('remembers the audio pick under the VOD key and switches the native track', () => {
    const audio = [
      audioTrack(true, { label: 'Track 1', language: 'l1' }),
      audioTrack(false, { label: 'Track 2', language: 'l2' }),
    ];
    setup({ audio });
    player.selectAudioTrack(1);
    expect(audio.map((t) => t.enabled)).toEqual([false, true]);
    expect(StorageService.setAudioPref).toHaveBeenCalledWith('vod:x1:vod:10', { name: 'Track 2', lang: 'l2' });
  });

  it('re-applies the saved audio pick when tracks arrive', () => {
    const audio = [
      audioTrack(true, { label: 'Track 1', language: 'l1' }),
      audioTrack(false, { label: 'Track 2', language: 'l2' }),
    ];
    setup({ audio });
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: 'Track 2', lang: 'l2' });
    applyAudio();
    expect(audio.map((t) => t.enabled)).toEqual([false, true]);
  });

  it('reports the offset row available and clamps/persists/shifts on setSubtitleOffset', () => {
    const cue = { startTime: 5, endTime: 7 };
    const text = [textTrack('showing', { label: 'Track 1' })] as Array<Record<string, unknown>>;
    text[0].cues = [cue];
    setup({ text });
    expect(player.subtitleOffsetState()).toEqual({ available: true, label: '0.00 s' });
    player.setSubtitleOffset(0.3); // clamps to 0.25
    expect(StorageService.setSubtitleOffset).toHaveBeenCalledWith('vod:x1:vod:10', 0.25);
    expect(cue).toEqual({ startTime: 5.25, endTime: 7.25 });
    expect(player.subtitleOffsetState().label).toBe('+0.25 s');
  });

  it('reports the offset row unavailable when no subtitle is showing', () => {
    setup({ text: [textTrack('disabled', { label: 'Track 1' })] });
    expect(player.subtitleOffsetState().available).toBe(false);
  });
});

describe('Player VOD ASS sidecar subtitles', () => {
  // ASS/SSA sidecars can't render as native <track>s, so they join the one
  // picker as synthetic options at ASS_SUBTITLE_BASE + i and route to a fake
  // assjs overlay controller. Native textTracks (in-container / SRT/WebVTT) are
  // plain arrays as in the in-container suite above.
  const textTrack = (mode: TextTrackMode, over: { kind?: string; label?: string; language?: string } = {}) =>
    ({ kind: over.kind ?? 'subtitles', label: over.label ?? '', language: over.language ?? '', mode });
  const assSidecar = (over: { id?: string; name?: string; lang?: string; url?: string } = {}) =>
    ({ id: over.id ?? '1', name: over.name ?? 'ASS 1', lang: over.lang ?? 'l1', url: over.url ?? 'http://host/a.ass' });

  let assSubs: { attach: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; setOffset: ReturnType<typeof vi.fn> };
  const setup = (opts: { text?: unknown[]; ass?: unknown[] } = {}) => {
    assSubs = { attach: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn(), setOffset: vi.fn() };
    const p = player as unknown as Record<string, unknown>;
    p.hls = null;
    p.vod = {
      url: 'http://host/movie.mkv', title: 'Movie One', poster: '',
      accountId: 'x1', itemId: '10', kind: 'vod', resumeSecs: 0, onBack: vi.fn(),
    };
    p.videoEl = { textTracks: opts.text ?? [] };
    p.vodAssSidecars = opts.ass ?? [];
    p.assSubs = assSubs;
    p.activeAssIndex = -1;
    p.currentChannel = null;
  };
  const applySubs = () => (player as unknown as { applyNativeSubtitleSelection(): void }).applyNativeSubtitleSelection();

  beforeEach(() => {
    vi.mocked(StorageService.getSubtitlePref).mockReset();
    vi.mocked(StorageService.setSubtitlePref).mockReset();
  });

  it('lists ASS sidecars in the picker after the native tracks', () => {
    setup({ text: [textTrack('disabled', { label: 'Native 1' })], ass: [assSidecar({ name: 'ASS 1' })] });
    const tracks = player.getSubtitleTracks();
    expect(tracks.map((t) => t.label)).toEqual(['Native 1', 'ASS 1']);
    expect(tracks.map((t) => t.index)).toEqual([0, ASS_SUBTITLE_BASE]);
    expect(tracks.every((t) => t.available)).toBe(true);
  });

  it('selecting an ASS sidecar shows it, disables native tracks, and remembers the pick', () => {
    const text = [textTrack('showing', { label: 'Native 1' })];
    const ass = [assSidecar({ name: 'ASS 1', lang: 'l1' })];
    setup({ text, ass });
    player.selectSubtitleTrack(ASS_SUBTITLE_BASE);
    expect(assSubs.show).toHaveBeenCalledWith(0);
    expect(text[0].mode).toBe('disabled');
    expect(assSubs.hide).not.toHaveBeenCalled();
    expect(StorageService.setSubtitlePref).toHaveBeenCalledWith('vod:x1:vod:10', { off: false, name: 'ASS 1', lang: 'l1' });
  });

  it('marks the shown ASS sidecar active in the picker', () => {
    setup({ text: [], ass: [assSidecar({ name: 'ASS 1' })] });
    player.selectSubtitleTrack(ASS_SUBTITLE_BASE);
    const opt = player.getSubtitleTracks().find((t) => t.index === ASS_SUBTITLE_BASE);
    expect(opt?.active).toBe(true);
  });

  it('selecting a native track hides the ASS overlay', () => {
    const text = [textTrack('disabled', { label: 'Native 1' })];
    setup({ text, ass: [assSidecar()] });
    player.selectSubtitleTrack(0);
    expect(assSubs.hide).toHaveBeenCalled();
    expect(assSubs.show).not.toHaveBeenCalled();
    expect(text[0].mode).toBe('showing');
  });

  it('selecting Off hides the ASS overlay', () => {
    setup({ text: [], ass: [assSidecar()] });
    player.selectSubtitleTrack(-1);
    expect(assSubs.hide).toHaveBeenCalled();
  });

  it('re-applies a saved ASS pick when tracks arrive', () => {
    const ass = [assSidecar({ name: 'ASS 1', lang: 'l1' })];
    setup({ text: [], ass });
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue({ off: false, name: 'ASS 1', lang: 'l1' });
    applySubs();
    expect(assSubs.show).toHaveBeenCalledWith(0);
  });

  it('exposes an ASS sidecar as a selectable picker option at base + 0', () => {
    const p = player as unknown as Record<string, unknown>;
    p.vod = {
      accountId: 'a', kind: 'movie', itemId: 'm1', title: 'T', url: 'http://host/m',
      poster: '', resumeSecs: 0, onBack: vi.fn(), extras: {}, searchMeta: {},
      subtitles: [{ id: 'ass1', name: 'A', lang: 'l1', url: 'http://host/a.ass' }],
    };
    p.vodAssSidecars = [{ id: 'ass1', name: 'A', lang: 'l1', url: 'http://host/a.ass', text: '' }];
    const tracks = player.getSubtitleTracks();
    expect(tracks.some((t) => t.index === ASS_SUBTITLE_BASE)).toBe(true);
  });

  it('closeSubtitleSearch dismisses an open overlay (called on every view change)', async () => {
    subtitleSearchServiceMock.__setMockAvailable(true);
    const host = document.createElement('div');
    host.id = 'subtitle-search';
    container.appendChild(host);
    subtitleSearchServiceMock.search.mockResolvedValueOnce([
      { providerId: 'subdl', id: '1', language: 'l1', releaseName: 'A', fileName: 'a.srt', format: 'srt', hearingImpaired: false, downloads: 0 },
    ]);
    try {
      const p = player as unknown as Record<string, unknown>;
      p.vod = {
        accountId: 'a', kind: 'movie', itemId: 'm1', title: 'Charade', url: 'http://host/m',
        poster: '', resumeSecs: 0, onBack: vi.fn(), extras: {}, searchMeta: {}, subtitles: [],
      };
      await (player as unknown as { runSubtitleSearch: (q: string | null) => Promise<void> }).runSubtitleSearch(null);
      const overlay = (player as unknown as { subsOverlay: { visible: boolean } }).subsOverlay;
      expect(overlay.visible).toBe(true);
      player.closeSubtitleSearch();
      expect(overlay.visible).toBe(false);
      expect(host.classList.contains('hidden')).toBe(true);
    } finally {
      subtitleSearchServiceMock.__setMockAvailable(false);
      host.remove();
    }
  });

  it('runs a manual query that overrides the structured search keys', async () => {
    subtitleSearchServiceMock.__setMockAvailable(true);
    const host = document.createElement('div');
    host.id = 'subtitle-search';
    document.body.appendChild(host);
    subtitleSearchServiceMock.search.mockClear();
    subtitleSearchServiceMock.search.mockResolvedValueOnce([]);
    try {
      const p = player as unknown as Record<string, unknown>;
      p.vod = {
        accountId: 'a', kind: 'movie', itemId: 'm1', title: 'Auto Title', url: 'http://host/m',
        poster: '', resumeSecs: 0, onBack: vi.fn(), extras: {},
        searchMeta: { imdbId: '123', year: 2020 }, subtitles: [],
      };
      await (player as unknown as { runSubtitleSearch: (q: string | null) => Promise<void> }).runSubtitleSearch('My Manual Query');
      expect(subtitleSearchServiceMock.search).toHaveBeenCalledWith(expect.objectContaining({ manualQuery: 'My Manual Query' }));
    } finally {
      subtitleSearchServiceMock.__setMockAvailable(false);
      host.remove();
    }
  });

  it('applies an online SRT result as a shown text track', async () => {
    subtitleSearchServiceMock.__setMockAvailable(true);
    subtitleSearchServiceMock.__setMockAvailable(true);
    try {
      const p = player as unknown as Record<string, unknown>;
      p.vod = {
        accountId: 'a', kind: 'movie', itemId: 'm1', title: 'T', url: 'http://host/m',
        poster: '', resumeSecs: 0, onBack: vi.fn(), extras: {}, searchMeta: {},
        subtitles: [],
      };
      const videoEl = { textTracks: [] as unknown[] };
      p.videoEl = videoEl;
      const vodSubs = {
        addOnline: vi.fn((_, sub) => {
          const track = { mode: 'showing' as TextTrackMode, kind: 'subtitles', label: sub.name, language: sub.lang };
          videoEl.textTracks.push(track);
          return track;
        }),
        ensureLoaded: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      p.vodSubs = vodSubs;
      await (player as unknown as { applyOnlineSubtitle: (r: unknown) => Promise<void> }).applyOnlineSubtitle({
        providerId: 'subdl', id: '1', language: 'l1', releaseName: 'A', fileName: 'a.srt',
        format: 'srt', hearingImpaired: false, downloads: 0,
      });
      const tracks = player.getSubtitleTracks();
      expect(tracks.some((t) => t.active)).toBe(true);
      // The full happy path ran (not the catch): the pick was persisted.
      expect(vi.mocked(StorageService.setPickedOnlineSub)).toHaveBeenCalled();
    } finally {
      subtitleSearchServiceMock.__setMockAvailable(false);
    }
  });

  it('does not apply or persist an online result when the VOD changed mid-download', async () => {
    subtitleSearchServiceMock.__setMockAvailable(true);
    try {
      const p = player as unknown as Record<string, unknown>;
      const v1 = { accountId: 'a', kind: 'movie' as const, itemId: 'm1', title: 'One', url: 'http://host/m1',
        poster: '', resumeSecs: 0, onBack: vi.fn(), subtitles: [] };
      p.vod = v1;
      p.videoEl = { textTracks: [] as unknown[] };
      const addOnline = vi.fn();
      p.vodSubs = { addOnline, ensureLoaded: vi.fn(), setOffset: vi.fn(), owns: vi.fn(() => false) };
      let resolveDl: (v: { text: string; format: 'srt' }) => void = () => {};
      subtitleSearchServiceMock.download.mockImplementationOnce(() => new Promise((res) => { resolveDl = res as typeof resolveDl; }));
      vi.mocked(StorageService.setPickedOnlineSub).mockClear();
      const done = (player as unknown as { applyOnlineSubtitle: (r: unknown) => Promise<void> }).applyOnlineSubtitle({
        providerId: 'subdl', id: '1', language: 'l1', releaseName: 'A', fileName: 'a.srt',
        format: 'srt', hearingImpaired: false, downloads: 0,
      });
      p.vod = { ...v1, itemId: 'm2', title: 'Two' }; // user switched items before the download resolved
      resolveDl({ text: 'WEBVTT\n\nx', format: 'srt' });
      await done;
      expect(addOnline).not.toHaveBeenCalled();
      expect(vi.mocked(StorageService.setPickedOnlineSub)).not.toHaveBeenCalled();
    } finally {
      subtitleSearchServiceMock.__setMockAvailable(false);
    }
  });

  it('restores a remembered online subtitle from the idb cache without downloading', async () => {
    const p = player as unknown as Record<string, unknown>;
    const vod = { accountId: 'x1', kind: 'vod' as const, itemId: '10', title: 'Movie', url: 'http://host/vod.mp4',
      poster: '', resumeSecs: 0, onBack: vi.fn(), subtitles: [] };
    p.vod = vod;
    const videoEl = { textTracks: [] as unknown[] };
    p.videoEl = videoEl;
    const addOnline = vi.fn((_: unknown, sub: { name: string; lang: string }) => {
      const track = { mode: 'disabled' as TextTrackMode, kind: 'subtitles', label: sub.name, language: sub.lang };
      videoEl.textTracks.push(track);
      return track;
    });
    p.vodSubs = { addOnline, setOffset: vi.fn(), owns: vi.fn(() => false) };
    // Seed the pick + cache-hit for exactly this restore; `Once` + finally-reset
    // keeps these mocks from leaking into later VOD tests. Clear `download`'s
    // history because a prior test in this file exercised it (no global clearMocks).
    subtitleSearchServiceMock.download.mockClear();
    vi.mocked(StorageService.getPickedOnlineSub).mockReturnValueOnce({ providerId: 'subdl', id: '9', name: 'Alpha', lang: 'l1', format: 'srt' });
    vi.mocked(getCachedSubtitle).mockResolvedValueOnce('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n');
    try {
      await (player as unknown as { restoreOnlineSubtitle: (v: unknown) => Promise<void> }).restoreOnlineSubtitle(vod);
      expect(vi.mocked(getCachedSubtitle)).toHaveBeenCalledWith('subdl:9');
      expect(subtitleSearchServiceMock.download).not.toHaveBeenCalled();
      expect(addOnline).toHaveBeenCalled();
    } finally {
      vi.mocked(StorageService.getPickedOnlineSub).mockReset();
      vi.mocked(getCachedSubtitle).mockReset();
    }
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

  it('attaches the sidecar subtitle tracks on playVod', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const vodSubs = { attach: vi.fn(), ensureLoaded: vi.fn(), clear: vi.fn() };
    (player as unknown as { vodSubs: unknown }).vodSubs = vodSubs;
    const subs = [{ id: '1', name: 'Track 1', lang: 'l1', url: 'http://host/a.srt' }];
    player.playVod(req({ subtitles: subs }));
    expect(vodSubs.attach).toHaveBeenCalledWith(video, subs);
  });

  it('splits sidecars on playVod: SRT/WebVTT to vodSubs, ASS to assSubs', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const vodSubs = { attach: vi.fn(), ensureLoaded: vi.fn(), clear: vi.fn() };
    const assSubs = { attach: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
    (player as unknown as { vodSubs: unknown }).vodSubs = vodSubs;
    (player as unknown as { assSubs: unknown }).assSubs = assSubs;
    const srt = { id: '1', name: 'SRT', lang: 'l1', url: 'http://host/a.srt' };
    const ass = { id: '2', name: 'ASS', lang: 'l2', url: 'http://host/b.ass' };
    player.playVod(req({ subtitles: [srt, ass] }));
    expect(vodSubs.attach).toHaveBeenCalledWith(video, [srt]);
    expect(assSubs.attach).toHaveBeenCalledWith(video, expect.anything(), [ass]);
  });

  it('tears down the ASS overlay on stop', () => {
    const video = fakeVideo(3600);
    player.init(video);
    const assSubs = { attach: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
    (player as unknown as { assSubs: unknown }).assSubs = assSubs;
    player.playVod(req());
    player.stop();
    expect(assSubs.destroy).toHaveBeenCalled();
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

  it('defaults to video/mp4 for unknown or extension-less URLs', () => {
    expect(containerMime('http://host/movie/u/p/10.xyz')).toBe('video/mp4');
    expect(containerMime('http://host/movie/u/p/10')).toBe('video/mp4');
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
  it('groups extension-less channels by origin and route prefix', () => {
    expect(streamRouteKey('http://host/play/ch1')).toBe('http://host/play');
    expect(streamRouteKey('http://host/play/ch2?token=x')).toBe('http://host/play');
    expect(streamRouteKey('http://host/catchup/ch1')).toBe('http://host/catchup');
    expect(streamRouteKey('not a url')).toBe('');
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
