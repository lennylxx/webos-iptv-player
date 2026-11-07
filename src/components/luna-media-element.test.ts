// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';

const media = vi.hoisted(() => ({
  foregroundAppInfo: vi.fn(),
  loadMedia: vi.fn(),
  subscribeMedia: vi.fn(),
  mediaCommand: vi.fn(),
  setDisplayWindow: vi.fn(),
  setMediaVolume: vi.fn(),
  seekMedia: vi.fn(),
  selectAudioTrack: vi.fn(),
}));

vi.mock('../services/luna-media', async importOriginal => ({
  ...await importOriginal<typeof import('../services/luna-media')>(),
  ...media,
}));

const { LunaMediaElement } = await import('./luna-media-element');
const { LunaMediaError } = await import('../services/luna-media');
const { StallWatchdog } = await import('../utils/stall-watchdog');

const APP = __APP_ID__;
let video: HTMLVideoElement;
let onEvent: (event: Record<string, unknown>) => void;
let onSubscribeFailure: (code: number) => void;
let cancel: ReturnType<typeof vi.fn>;

function placeholderMediaId(value: string | undefined): void {
  Object.defineProperty(video, 'mediaId', { configurable: true, writable: true, value });
}

function windowInfo(mediaId: string, windowId = '_Window_Id_7'): unknown {
  return { returnValue: true, foregroundAppInfo: [{ appId: APP, mediaId, windowId }] };
}

function start(onFallback = vi.fn()): {
  element: InstanceType<typeof LunaMediaElement>;
  onFallback: ReturnType<typeof vi.fn>;
} {
  const element = new LunaMediaElement(video, {
    uri: 'http://host/a.m3u8',
    headers: { Referer: 'http://host/' },
    label: 'session=1 load=1',
    onFallback,
  });
  element.start();
  return { element, onFallback };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function recordEvents(): string[] {
  const seen: string[] = [];
  for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play',
    'playing', 'pause', 'timeupdate', 'durationchange', 'error', 'waiting', 'resize']) {
    video.addEventListener(type, () => seen.push(type));
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  video = document.createElement('video');
  document.body.appendChild(video);
  placeholderMediaId('ph1');
  cancel = vi.fn();
  media.foregroundAppInfo.mockResolvedValue(windowInfo('ph1'));
  media.loadMedia.mockResolvedValue('lm1');
  media.subscribeMedia.mockImplementation((_id, event, failure) => {
    onEvent = event;
    onSubscribeFailure = failure;
    return { cancel };
  });
  media.mediaCommand.mockResolvedValue({ returnValue: true });
  media.setDisplayWindow.mockResolvedValue({ returnValue: true });
  media.setMediaVolume.mockResolvedValue({ returnValue: true });
  media.seekMedia.mockResolvedValue({ returnValue: true });
  media.selectAudioTrack.mockResolvedValue({ returnValue: true });
});

afterEach(() => {
  video.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of Object.values(media)) fn.mockReset();
});

function warnings(event: string): unknown[][] {
  return vi.mocked(console.warn).mock.calls.filter(call => call.includes(event));
}

describe('LunaMediaElement', () => {
  it('borrows the placeholder window and loads with the channel headers', async () => {
    const { element } = start();
    element.setDisplay({ x: 1, y: 2, width: 640, height: 360 });
    await flush();

    expect(video.getAttribute('src')).toBe(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER);
    expect(video.loop).toBe(true);
    expect(video.classList.contains('luna-media')).toBe(true);
    const params = media.loadMedia.mock.calls[0][0] as {
      payload: { option: { windowId: string; appId: string; transmission: unknown } };
    };
    expect(params.payload.option).toMatchObject({
      appId: APP,
      windowId: '_Window_Id_7',
      transmission: { httpHeader: { referer: 'http://host/' } },
    });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(media.subscribeMedia.mock.calls[0][0]).toBe('lm1');
    expect((video as HTMLVideoElement & { mediaId?: string }).mediaId).toBe('lm1');
  });

  it('loads DASH with its PlayReady client', async () => {
    const element = new LunaMediaElement(video, {
      uri: 'http://host/a.mpd',
      headers: { Referer: 'http://host/' },
      transport: 'MPEG-DASH',
      playReadyClientId: 'client-1',
      label: 'session=1 load=1',
      onFallback: vi.fn(),
    });
    element.start();
    await flush();

    expect(media.loadMedia.mock.calls[0][0]).toMatchObject({
      uri: 'http://host/a.mpd',
      payload: {
        mediaTransportType: 'MPEG-DASH',
        option: {
          transmission: { httpHeader: { referer: 'http://host/' } },
          drm: { type: 'playready', clientId: 'client-1' },
        },
      },
    });
    element.destroy();
  });

  it('positions the picture only after loadCompleted, with the latest rect', async () => {
    const { element } = start();
    element.setDisplay({ x: 1, y: 2, width: 640, height: 360 });
    await flush();
    element.setDisplay('full');
    expect(media.setDisplayWindow).not.toHaveBeenCalled();

    onEvent({ loadCompleted: true });
    expect(media.setDisplayWindow).toHaveBeenCalledOnce();
    expect(media.setDisplayWindow).toHaveBeenCalledWith('lm1', 'full');

    element.setDisplay({ x: 1, y: 2, width: 640, height: 360 });
    expect(media.setDisplayWindow).toHaveBeenLastCalledWith('lm1',
      { x: 1, y: 2, width: 640, height: 360 });
  });

  it('skips repeating an unchanged display rect, but retries after a failure', async () => {
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true });
    element.setDisplay({ x: 1, y: 2, width: 640, height: 360 });
    element.setDisplay({ x: 1, y: 2, width: 640, height: 360 });
    expect(media.setDisplayWindow).toHaveBeenCalledTimes(2);

    media.setDisplayWindow.mockRejectedValueOnce(new Error('busy'));
    element.setDisplay('full');
    await flush();
    element.setDisplay('full');
    expect(media.setDisplayWindow).toHaveBeenCalledTimes(4);
  });

  it('logs a display window that keeps failing once per load', async () => {
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true });
    media.setDisplayWindow.mockRejectedValue(new LunaMediaError('busy', 4));
    for (const width of [640, 641, 642]) {
      element.setDisplay({ x: 1, y: 2, width, height: 360 });
      await flush();
    }
    expect(media.setDisplayWindow).toHaveBeenCalledTimes(4);
    expect(warnings('event=playback.luna.display.failed')).toEqual([
      expect.arrayContaining(['session=1 load=1', 'code=4']),
    ]);
  });

  it('ignores a stale window entry until the placeholder has its own', async () => {
    media.foregroundAppInfo
      .mockResolvedValueOnce({ returnValue: true })
      .mockResolvedValueOnce(windowInfo('old'))
      .mockResolvedValue(windowInfo('ph1', '_Window_Id_8'));
    start();
    await flush();
    expect(media.loadMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_WINDOW_POLL_MS);
    expect(media.loadMedia).toHaveBeenCalledOnce();
    expect(JSON.stringify(media.loadMedia.mock.calls[0][0])).toContain('_Window_Id_8');
  });

  it('maps UMS events to media events and ignores errorCode 0', async () => {
    const seen = recordEvents();
    start();
    await flush();
    onEvent({ error: { errorCode: 0, errorText: 'No Error' } });
    expect(seen).not.toContain('error');
    expect(video.readyState).toBe(0);

    onEvent({ loadCompleted: true, mediaId: 'lm1' });
    onEvent({ sourceInfo: { numPrograms: 1 } });
    expect(video.readyState).toBe(1);
    expect(video.duration).toBe(Infinity);
    expect(media.mediaCommand).toHaveBeenCalledWith('play', 'lm1');

    onEvent({ playing: true });
    onEvent({ currentTime: { currentTime: 2500 } });
    onEvent({ videoInfo: { width: 1280, height: 720 } });
    expect(video.paused).toBe(false);
    expect(video.readyState).toBe(4);
    expect(video.currentTime).toBe(2.5);
    expect(video.videoWidth).toBe(1280);

    onEvent({ paused: true });
    onEvent({ bufferingStart: true });
    expect(video.paused).toBe(true);
    expect(seen).toEqual(['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata',
      'canplay', 'play', 'playing', 'timeupdate', 'resize', 'pause', 'waiting']);
  });

  it('runs its playback clock on between position reports', async () => {
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true, mediaId: 'lm1' });
    onEvent({ sourceInfo: { numPrograms: 1 } });
    onEvent({ playing: true });
    onEvent({ currentTime: { currentTime: 2500 } });

    await vi.advanceTimersByTimeAsync(500);
    expect(element.clockTime()).toBeCloseTo(3);
    expect(video.currentTime).toBe(2.5);
    await vi.advanceTimersByTimeAsync(2500);
    expect(element.clockTime()).toBeCloseTo(2.5 + CONFIG.PLAYER.LUNA_MEDIA_CLOCK_STEP_MS / 1000);

    onEvent({ paused: true });
    expect(element.clockTime()).toBe(2.5);
  });

  it('has no playback clock until UMS reports a position', async () => {
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true, mediaId: 'lm1' });
    onEvent({ playing: true });

    expect(element.clockTime()).toBeNaN();
    onEvent({ currentTime: { currentTime: 7000 } });
    expect(element.clockTime()).toBe(7);
  });

  it('treats moving time as loaded when loadCompleted never arrives', async () => {
    const { onFallback } = start();
    await flush();
    onEvent({ currentTime: { currentTime: 1000 } });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_METADATA_WAIT_MS);
    onEvent({ currentTime: { currentTime: 3000 } });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    expect(onFallback).not.toHaveBeenCalled();
    expect(video.paused).toBe(false);
  });

  it('reports a playback error after load as a network MediaError', async () => {
    const seen = recordEvents();
    const { onFallback } = start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ error: { errorCode: 1003 } });
    expect(onFallback).not.toHaveBeenCalled();
    expect(seen).toContain('error');
    expect(video.error?.code).toBe(2);
    expect(console.warn).toHaveBeenCalledWith('[Player]', 'Luna playback error',
      'event=playback.luna.error', 'session=1 load=1', 'code=1003', 'source=event');
  });

  it('suppresses the placeholder clip events', async () => {
    const seen = recordEvents();
    start();
    await flush();
    video.dispatchEvent(new Event('playing'));
    video.dispatchEvent(new Event('timeupdate'));
    expect(seen).toEqual(['loadstart']);
  });

  it('falls back without a window', async () => {
    media.foregroundAppInfo.mockResolvedValue({ returnValue: true, foregroundAppInfo: [] });
    const { onFallback } = start();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_WINDOW_TIMEOUT_MS
      + CONFIG.PLAYER.LUNA_MEDIA_WINDOW_POLL_MS);
    expect(onFallback).toHaveBeenCalledWith('no_window', 0, 'no_match');
    expect(media.loadMedia).not.toHaveBeenCalled();
  });

  it('falls back with the code of a failed load', async () => {
    media.loadMedia.mockRejectedValue(new LunaMediaError('load failed', 12));
    const { onFallback } = start();
    await flush();
    expect(onFallback).toHaveBeenCalledWith('load_failed', 12, 'load');
  });

  it('falls back on an error before loadCompleted', async () => {
    const { onFallback } = start();
    await flush();
    onEvent({ error: { errorCode: 1003 } });
    expect(onFallback).toHaveBeenCalledWith('error', 1003, 'event');
    expect(cancel).toHaveBeenCalled();
    expect(media.mediaCommand).toHaveBeenCalledWith('unload', 'lm1');
  });

  it('falls back when the subscription fails before load', async () => {
    const { onFallback } = start();
    await flush();
    onSubscribeFailure(-1);
    expect(onFallback).toHaveBeenCalledWith('error', -1, 'subscription');
  });

  it('falls back when the stream never starts', async () => {
    const { onFallback } = start();
    await flush();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    expect(onFallback).toHaveBeenCalledWith('timeout', 0, 'completed');
    expect(media.mediaCommand).toHaveBeenCalledWith('unload', 'lm1');
  });

  it('unloads a pipeline whose load finished after it was superseded', async () => {
    let resolveLoad: (mediaId: string) => void = () => {};
    media.loadMedia.mockReturnValue(new Promise<string>(resolve => { resolveLoad = resolve; }));
    const { element, onFallback } = start();
    await flush();
    element.destroy();
    resolveLoad('lm2');
    await flush();
    expect(media.mediaCommand).toHaveBeenCalledWith('unload', 'lm2');
    expect(media.subscribeMedia).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('restores the element and keeps the player mute on destroy', async () => {
    video.muted = false;
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true });
    video.muted = true;
    expect(media.setMediaVolume).toHaveBeenLastCalledWith('lm1', 0);
    element.destroy();
    expect(cancel).toHaveBeenCalled();
    expect(media.mediaCommand).toHaveBeenCalledWith('unload', 'lm1');
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.loop).toBe(false);
    expect(video.classList.contains('luna-media')).toBe(false);
    // The fallback <video> must stay muted as the player believes it is.
    expect(video.muted).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(video, 'paused')).toBe(false);
    expect((video as HTMLVideoElement & { mediaId?: string }).mediaId).toBe('ph1');
  });

  it('forwards play, pause, and seek to the pipeline', async () => {
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ playing: true });
    video.pause();
    expect(media.mediaCommand).toHaveBeenCalledWith('pause', 'lm1');
    video.currentTime = 30;
    expect(media.seekMedia).toHaveBeenCalledWith('lm1', 30000);
    expect(video.seeking).toBe(true);
    onEvent({ seekDone: true });
    expect(video.seeking).toBe(false);
  });

  it('falls back on the overall deadline when a Luna call never answers', async () => {
    media.foregroundAppInfo.mockReturnValue(new Promise(() => {}));
    const { onFallback } = start();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS - 1);
    expect(onFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFallback).toHaveBeenCalledWith('timeout', 0, 'window');
  });

  it('falls back on the deadline when load never answers', async () => {
    media.loadMedia.mockReturnValue(new Promise(() => {}));
    const { onFallback } = start();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    expect(onFallback).toHaveBeenCalledWith('timeout', 0, 'load');
  });

  it('holds loadedmetadata until sourceInfo so a catch-up resume can seek', async () => {
    const seen = recordEvents();
    start();
    await flush();
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) video.currentTime = 1200;
    });
    onEvent({ loadCompleted: true });
    expect(seen).not.toContain('loadedmetadata');
    expect(media.mediaCommand).not.toHaveBeenCalledWith('play', 'lm1');
    onEvent({ sourceInfo: { programInfo: [{ duration: 3600000 }] } });
    expect(seen).toContain('loadedmetadata');
    expect(video.duration).toBe(3600);
    expect(media.seekMedia).toHaveBeenCalledWith('lm1', 1200000);
    expect(media.mediaCommand).toHaveBeenCalledWith('play', 'lm1');
  });

  it('sends loadedmetadata after a short wait when sourceInfo never comes', async () => {
    const seen = recordEvents();
    start();
    await flush();
    onEvent({ loadCompleted: true });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_METADATA_WAIT_MS);
    expect(seen).toContain('loadedmetadata');
    expect(video.duration).toBe(Infinity);
    expect(media.mediaCommand).toHaveBeenCalledWith('play', 'lm1');
  });

  it('plays anyway when loadCompleted never arrives after subscribe', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { onFallback } = start();
    await flush();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_FORCE_PLAY_MS - 1);
    expect(media.mediaCommand).not.toHaveBeenCalledWith('play', 'lm1');
    await vi.advanceTimersByTimeAsync(1);
    expect(media.mediaCommand).toHaveBeenCalledWith('play', 'lm1');
    const logged = vi.mocked(console.log).mock.calls.flat().filter(arg => arg === 'event=playback.luna.play.forced');
    expect(logged).toHaveLength(1);
    onEvent({ currentTime: { currentTime: 500 } });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_METADATA_WAIT_MS);
    onEvent({ currentTime: { currentTime: 2500 } });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('keeps hiding placeholder events after restore until a real source loads', async () => {
    const seen = recordEvents();
    const { element } = start();
    await flush();
    element.destroy();
    video.dispatchEvent(new Event('error'));
    video.dispatchEvent(new Event('waiting'));
    expect(seen).toEqual(['loadstart']);

    video.src = 'http://host/a.m3u8';
    video.dispatchEvent(new Event('loadstart'));
    video.dispatchEvent(new Event('error'));
    expect(seen).toEqual(['loadstart', 'loadstart', 'error']);
  });

  it('stops hiding events a short while after restore', async () => {
    const seen = recordEvents();
    const { element } = start();
    await flush();
    element.destroy();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_PLACEHOLDER_QUIET_MS);
    video.dispatchEvent(new Event('error'));
    expect(seen).toEqual(['loadstart', 'error']);
  });

  it('ends a seek on advancing time when seekDone never arrives', async () => {
    const seen: string[] = [];
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: { duration: 600000 } });
    onEvent({ playing: true });
    onEvent({ currentTime: { currentTime: 200000 } });
    video.addEventListener('seeked', () => seen.push('seeked'));
    video.currentTime = 50;
    onEvent({ currentTime: { currentTime: 200500 } });
    expect(video.seeking).toBe(true);
    expect(video.currentTime).toBe(50);
    onEvent({ currentTime: { currentTime: 50500 } });
    expect(video.seeking).toBe(false);
    expect(video.currentTime).toBe(50.5);
    expect(seen).toEqual(['seeked']);
  });

  it('ends a seek after a timeout when nothing confirms it', async () => {
    const seen: string[] = [];
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: { duration: 600000 } });
    video.addEventListener('seeked', () => seen.push('seeked'));
    video.currentTime = 30;
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_SEEK_TIMEOUT_MS);
    expect(video.seeking).toBe(false);
    expect(seen).toEqual(['seeked']);
  });

  it('logs a refused seek once per load and still ends it', async () => {
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: { duration: 600000 } });
    media.seekMedia.mockRejectedValue(new LunaMediaError('seek failed', 9));
    video.currentTime = 30;
    await flush();
    expect(video.seeking).toBe(false);
    video.currentTime = 60;
    await flush();
    expect(warnings('event=playback.luna.seek.failed')).toEqual([
      expect.arrayContaining(['reason=refused', 'code=9']),
    ]);
  });

  it('logs a seek that nothing confirms as a timeout', async () => {
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: { duration: 600000 } });
    video.currentTime = 30;
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_SEEK_TIMEOUT_MS);
    expect(warnings('event=playback.luna.seek.failed')).toEqual([
      expect.arrayContaining(['reason=timeout', 'code=0']),
    ]);

    video.currentTime = 60;
    onEvent({ seekDone: true });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_SEEK_TIMEOUT_MS);
    expect(warnings('event=playback.luna.seek.failed')).toHaveLength(1);
  });

  it('falls back at once when the Luna service is unavailable', async () => {
    const actual = await vi.importActual<typeof import('../services/luna-media')>(
      '../services/luna-media');
    media.foregroundAppInfo.mockImplementation(actual.foregroundAppInfo);
    placeholderMediaId(undefined);
    const { onFallback } = start();
    await flush();
    expect(onFallback).toHaveBeenCalledWith('no_window', expect.any(Number), 'app_info');
    expect(media.loadMedia).not.toHaveBeenCalled();
  });

  it('never plays the placeholder when the TV answers that it has no window lookup', async () => {
    Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: function Bridge() {} });
    try {
      media.foregroundAppInfo.mockRejectedValue(new LunaMediaError('getForegroundAppInfo failed', -1, false,
        'Unknown method "getForegroundAppInfo" for category "/"'));
      const { onFallback } = start();
      await flush();

      expect(onFallback).toHaveBeenCalledWith('no_window', -1, 'app_info', true);
      expect(video.hasAttribute('src')).toBe(false);
      expect(video.classList.contains('luna-media')).toBe(false);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'PalmServiceBridge');
    }
  });

  it('keeps any other window lookup error a transient miss', async () => {
    Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: function Bridge() {} });
    try {
      media.foregroundAppInfo.mockRejectedValue(new LunaMediaError('getForegroundAppInfo failed', -1, false,
        'Internal error'));
      const { onFallback } = start();
      await flush();

      expect(onFallback).toHaveBeenCalledWith('no_window', -1, 'app_info');
      expect(video.hasAttribute('src')).toBe(false);
    } finally {
      Reflect.deleteProperty(window, 'PalmServiceBridge');
    }
  });

  it('keeps a window lookup that timed out a transient miss', async () => {
    Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: function Bridge() {} });
    try {
      media.foregroundAppInfo.mockRejectedValue(new LunaMediaError('getForegroundAppInfo timed out', -1, true));
      const { onFallback } = start();
      await flush();

      expect(onFallback).toHaveBeenCalledWith('no_window', -1, 'app_info');
      expect(video.hasAttribute('src')).toBe(false);
    } finally {
      Reflect.deleteProperty(window, 'PalmServiceBridge');
    }
  });

  function watch(): { onReload: ReturnType<typeof vi.fn> } {
    const onReload = vi.fn();
    new StallWatchdog({
      probe: () => ({
        currentTime: video.currentTime, readyState: video.readyState,
        networkState: video.networkState, paused: video.paused, seeking: video.seeking,
      }),
      onReload, onEscalate: vi.fn(),
      pollMs: CONFIG.PLAYER.STALL_POLL_MS, freezeTicks: CONFIG.PLAYER.STALL_FREEZE_TICKS,
      maxReloads: 3,
    }).start();
    return { onReload };
  }

  const STALL_MS = CONFIG.PLAYER.STALL_POLL_MS * (CONFIG.PLAYER.STALL_FREEZE_TICKS + 1);

  it('lets the stall watchdog see a Luna stream that buffers forever', async () => {
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    onEvent({ playing: true });
    onEvent({ bufferingStart: true });
    expect(video.readyState).toBe(2);
    const { onReload } = watch();
    await vi.advanceTimersByTimeAsync(STALL_MS);
    expect(onReload).toHaveBeenCalled();
    onEvent({ bufferingEnd: true });
    expect(video.readyState).toBe(4);
  });

  it('lets the stall watchdog see a Luna stream whose time stops without events', async () => {
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    onEvent({ playing: true });
    onEvent({ currentTime: { currentTime: 1000 } });
    const { onReload } = watch();
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_FROZEN_MS + STALL_MS);
    expect(onReload).toHaveBeenCalled();
  });

  it('falls back when a loaded stream never starts playing', async () => {
    const { onFallback } = start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_DEADLINE_MS);
    expect(onFallback).toHaveBeenCalledWith('timeout', 0, 'playing');
  });

  it('falls back when UMS refuses to play a loaded stream', async () => {
    media.mediaCommand.mockImplementation((method: string) => method === 'play'
      ? Promise.reject(new LunaMediaError('play failed', 7))
      : Promise.resolve({ returnValue: true }));
    const onStarted = vi.fn();
    const onFallback = vi.fn();
    new LunaMediaElement(video, {
      uri: 'http://host/a.m3u8', headers: { Referer: 'http://host/' }, label: 'session=1 load=1', onFallback, onStarted,
    }).start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    await flush();
    expect(onFallback).toHaveBeenCalledWith('error', 7, 'play');
    expect(onStarted).not.toHaveBeenCalled();
  });

  describe('diagnostics', () => {
    const lines = (spy: unknown) => (spy as ReturnType<typeof vi.fn>).mock.calls
      .map((args: unknown[]) => args.join(' '));

    it('logs the start timeline once when the stream first plays', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      start();
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      onEvent({ loadCompleted: true });
      onEvent({ sourceInfo: {} });
      await vi.advanceTimersByTimeAsync(200);
      onEvent({ playing: true });
      onEvent({ currentTime: { currentTime: 1000 } });
      onEvent({ playing: true });

      expect(lines(console.log).filter(line => line.includes('event=playback.luna.started'))).toEqual([
        expect.stringContaining('event=playback.luna.started session=1 load=1 '
          + 'windowMs=0 loadMs=0 completedMs=300 startMs=500 forced=0'),
      ]);
    });

    it('logs where the picture went once per full or rect switch', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { element } = start();
      element.setDisplay({ x: 10, y: 20, width: 640, height: 360 });
      await flush();
      onEvent({ loadCompleted: true });
      await flush();
      element.setDisplay({ x: 12, y: 20, width: 640, height: 360 });
      await flush();
      element.setDisplay('full');
      await flush();

      expect(lines(console.log).filter(line => line.includes('event=playback.luna.display '))).toEqual([
        expect.stringContaining('event=playback.luna.display session=1 load=1 mode=rect rect=10,20,640x360'),
        expect.stringContaining('event=playback.luna.display session=1 load=1 mode=full'),
      ]);
    });

    it('notes a load that starts while an earlier unload is in flight', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      let unloaded: (value: unknown) => void = () => {};
      media.mediaCommand.mockReturnValue(new Promise(resolve => { unloaded = resolve; }));
      const { element } = start();
      await flush();
      element.destroy();
      start();
      await flush();

      expect(lines(console.log).filter(line => line.includes('event=playback.luna.unload.pending'))).toEqual([
        expect.stringContaining('event=playback.luna.unload.pending session=1 load=1 count=1'),
      ]);
      unloaded({ returnValue: true });
      await flush();
    });
  });

  it('reports the first play once', async () => {
    const onStarted = vi.fn();
    new LunaMediaElement(video, {
      uri: 'http://host/a.m3u8', headers: { Referer: 'http://host/' }, label: 'session=1 load=1', onFallback: vi.fn(), onStarted,
    }).start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ playing: true });
    onEvent({ currentTime: { currentTime: 1000 } });
    onEvent({ playing: true });
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('hands a pipeline error after the start to the caller, not before it', async () => {
    const seen = recordEvents();
    const onFallback = vi.fn();
    const onPlaybackError = vi.fn(() => true);
    new LunaMediaElement(video, {
      uri: 'http://host/a.m3u8', headers: { Referer: 'http://host/' }, label: 'session=1 load=1',
      onFallback, onPlaybackError,
    }).start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ error: { errorCode: 1003 } });
    expect(onPlaybackError).not.toHaveBeenCalled();
    expect(seen).toContain('error');

    seen.length = 0;
    onEvent({ playing: true });
    onEvent({ error: { errorCode: 1004 } });
    expect(onPlaybackError).toHaveBeenCalledWith(1004);
    expect(seen).not.toContain('error');
    expect(onFallback).not.toHaveBeenCalled();

    onPlaybackError.mockReturnValue(false);
    onEvent({ error: { errorCode: 1005 } });
    expect(seen).toContain('error');
  });

  it('mutes a muted preview before the forced play', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    video.muted = true;
    start();
    await flush();
    expect(media.setMediaVolume).toHaveBeenCalledWith('lm1', 0);
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_FORCE_PLAY_MS);
    const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];
    const play = media.mediaCommand.mock.calls.findIndex(([method]) => method === 'play');
    expect(order(media.setMediaVolume))
      .toBeLessThan(media.mediaCommand.mock.invocationCallOrder[play]);
  });

  it('shows pause and play at once and reverts a refused pause', async () => {
    const seen = recordEvents();
    start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    onEvent({ playing: true });
    seen.length = 0;
    video.pause();
    expect(video.paused).toBe(true);
    expect(seen).toEqual(['pause']);
    onEvent({ currentTime: { currentTime: 2000 } });
    expect(video.paused).toBe(true);
    void video.play();
    expect(video.paused).toBe(false);
    expect(seen).toEqual(['pause', 'timeupdate', 'play']);
    onEvent({ playing: true });
    expect(seen.filter(type => type === 'play')).toHaveLength(1);

    media.mediaCommand.mockRejectedValueOnce(new LunaMediaError('pause failed', 3));
    video.pause();
    await flush();
    expect(video.paused).toBe(false);
  });
});

describe('LunaMediaElement audio', () => {
  const SOURCE_INFO = {
    sourceInfo: {
      programInfo: [{
        audioTrackInfo: [
          { language: 'l1', selected: true, codec: 'c1', channels: 2 },
          { language: 'und', selected: false },
        ],
      }],
    },
  };
  let onAudioTracks: ReturnType<typeof vi.fn>;
  let warn: string[];

  async function loaded(): Promise<InstanceType<typeof LunaMediaElement>> {
    onAudioTracks = vi.fn();
    const element = new LunaMediaElement(video, {
      uri: 'http://host/a.m3u8',
      headers: { Referer: 'http://host/' },
      label: 'session=1 load=1',
      onFallback: vi.fn(),
      onAudioTracks,
    });
    element.start();
    await flush();
    return element;
  }

  beforeEach(() => {
    warn = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => { warn.push(args.join(' ')); });
  });

  it('lists the UMS audio renditions once loaded, whenever sourceInfo comes', async () => {
    const element = await loaded();
    onEvent(SOURCE_INFO);
    expect(element.audioTracks()).toEqual([]);
    expect(onAudioTracks).not.toHaveBeenCalled();

    onEvent({ loadCompleted: true });

    expect(onAudioTracks).toHaveBeenCalledOnce();
    expect(element.audioTracks()).toEqual([
      { index: 0, language: 'l1', selected: true },
      { index: 1, language: '', selected: false },
    ]);
    onEvent(SOURCE_INFO);
    expect(onAudioTracks).toHaveBeenCalledOnce();
  });

  it('switches audio on trackSelected', async () => {
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);

    const result = element.selectAudio(1);
    expect(media.selectAudioTrack).toHaveBeenCalledWith('lm1', 1);
    onEvent({ trackSelected: { type: 'audio', index: 1 } });

    await expect(result).resolves.toBe(true);
    expect(element.audioTracks().map(track => track.selected)).toEqual([false, true]);
    expect(onAudioTracks).toHaveBeenCalledTimes(2);
  });

  it('counts a successful call that no trackSelected follows, after a short wait', async () => {
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);
    let settled: boolean | null = null;

    void element.selectAudio(1).then(ok => { settled = ok; });
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_AUDIO_EVENT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(element.audioTracks()[1].selected).toBe(true);
  });

  it('keeps the previous rendition when selectTrack is refused', async () => {
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);
    media.selectAudioTrack.mockRejectedValueOnce(new LunaMediaError('selectTrack failed', 7));

    await expect(element.selectAudio(1)).resolves.toBe(false);

    expect(element.audioTracks()[0].selected).toBe(true);
    expect(warn.join('\n')).toContain(
      'event=audio.luna.switch.failed session=1 load=1 reason=call code=7 from=0 to=1');
  });

  it('keeps the previous rendition when the pipeline errors during the switch', async () => {
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);

    const result = element.selectAudio(1);
    await flush();
    onEvent({ error: { errorCode: 9 } });

    await expect(result).resolves.toBe(false);
    expect(element.audioTracks()[0].selected).toBe(true);
    expect(warn.join('\n')).toContain('event=audio.luna.switch.failed session=1 load=1 reason=error code=9 from=0 to=1');
  });

  it('settles a switch quietly when torn down, and ignores later events', async () => {
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);

    const result = element.selectAudio(1);
    element.destroy();
    onEvent({ trackSelected: { type: 'audio', index: 1 } });

    await expect(result).resolves.toBe(false);
    expect(warn.join('\n')).not.toContain('event=audio.luna.switch.failed');
    await expect(element.selectAudio(1)).resolves.toBe(false);
  });

  it('keeps a confirmed switch when sourceInfo re-pushes the old selection', async () => {
    const info: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { info.push(args.join(' ')); });
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);
    const result = element.selectAudio(1);
    onEvent({ trackSelected: { type: 'audio', index: 1 } });
    await expect(result).resolves.toBe(true);

    onEvent(SOURCE_INFO);
    onEvent(SOURCE_INFO);

    expect(element.audioTracks().map(track => track.selected)).toEqual([false, true]);
    expect(info.filter(line => line.includes('event=audio.luna.tracks.changed'))).toEqual([
      expect.stringContaining('event=audio.luna.tracks.changed session=1 load=1 change=selected '
        + 'count=2>2 langs=l1,und selected=1>0 kept=true'),
    ]);
  });

  it('replaces the list when sourceInfo re-pushes different languages', async () => {
    const info: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { info.push(args.join(' ')); });
    const element = await loaded();
    onEvent({ loadCompleted: true });
    onEvent(SOURCE_INFO);
    const result = element.selectAudio(1);
    onEvent({ trackSelected: { type: 'audio', index: 1 } });
    await result;

    onEvent({ sourceInfo: { programInfo: [{ audioTrackInfo: [
      { language: 'l1', selected: true },
      { language: 'l2', selected: false },
      { language: 'l3', selected: false },
    ] }] } });

    expect(element.audioTracks().map(track => track.language)).toEqual(['l1', 'l2', 'l3']);
    expect(element.audioTracks()[0].selected).toBe(true);
    expect(info.join('\n')).toContain(
      'event=audio.luna.tracks.changed session=1 load=1 change=count count=2>3 langs=l1,l2,l3 selected=1>0 kept=false');
  });
});

describe('LunaMediaElement call failures', () => {
  it('logs each refused Luna call once with the playback label and code only', async () => {
    const warn: string[] = [];
    vi.mocked(console.warn).mockImplementation((...args: unknown[]) => { warn.push(args.join(' ')); });
    media.setDisplayWindow.mockRejectedValue(new LunaMediaError('setDisplayWindow failed', 53));
    media.setMediaVolume.mockRejectedValue(new LunaMediaError('setVolume failed', 4));
    media.mediaCommand.mockImplementation((method: string) => Promise.reject(
      new LunaMediaError(`${method} failed`, method === 'unload' ? 6 : 5)));
    const { element } = start();
    await flush();
    onEvent({ loadCompleted: true });
    onEvent({ sourceInfo: {} });
    onEvent({ playing: true });
    video.pause();
    await flush();
    element.destroy();
    await flush();

    const text = warn.join('\n');
    for (const line of [
      'event=playback.luna.display.failed session=1 load=1 code=53',
      'event=playback.luna.volume.failed session=1 load=1 code=4',
      'event=playback.luna.play.failed session=1 load=1 code=5',
      'event=playback.luna.pause.failed session=1 load=1 code=5',
      'event=playback.luna.unload.failed session=1 load=1 code=6',
    ]) expect(text).toContain(line);
    expect(text).not.toContain('http://host/');
  });
});
