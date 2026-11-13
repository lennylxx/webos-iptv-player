// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, VodPlayback } from '../types';

const { pipeline, tracks, osd, playlist, health } = vi.hoisted(() => ({
  pipeline: {
    load: vi.fn(), destroy: vi.fn(), setVideoElement: vi.fn(),
    currentLoadToken: vi.fn(() => 1), videoLabel: vi.fn(() => 'video'),
    isLunaActive: vi.fn(() => false), isLunaPending: vi.fn(() => false), isProxyPending: vi.fn(() => false),
    canEscalate: vi.fn(() => false),
    isLunaStarting: vi.fn(() => false), lunaClock: vi.fn(() => null), setLunaDisplay: vi.fn(), lunaStreamUrl: vi.fn(() => ''), escalate: vi.fn(() => false),
    notePlaying: vi.fn(), isProxied: vi.fn(() => false),
  },
  tracks: {
    resetForLoad: vi.fn(), suspend: vi.fn(), stop: vi.fn(), attachVod: vi.fn(),
    applyNativeAudioSelection: vi.fn(), applyNativeSubtitleSelection: vi.fn(),
    reapplyNativeSubtitleCompositor: vi.fn(),
  },
  osd: {
    show: vi.fn(), hide: vi.fn(), clearFailedIcons: vi.fn(),
    isVisible: vi.fn(() => false), render: vi.fn(), resetTimer: vi.fn(),
    updateMessage: vi.fn(), refreshProgress: vi.fn(),
  },
  playlist: {
    getByIndex: vi.fn(), indexOf: vi.fn(), resolveChannelKey: vi.fn(),
    getByGroup: vi.fn(), channels: [] as Channel[],
  },
  health: {
    recordPlaybackFailure: vi.fn().mockResolvedValue(undefined),
    recordPlaybackSuccess: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('./player-pipeline', () => ({
  PlayerPipeline: vi.fn(function () { return pipeline; }),
}));
vi.mock('./player-tracks', () => ({
  PlayerTracks: vi.fn(function () { return tracks; }),
}));
vi.mock('./player-osd', () => ({
  PlayerOsd: vi.fn(function () { return osd; }),
}));
vi.mock('../services/playlist-service', () => ({ PlaylistService: playlist }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: health }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    getLastChannel: vi.fn(() => null), setLastChannel: vi.fn(),
    setCatchupProgress: vi.fn(), setResume: vi.fn(),
    touchRecentlyWatchedLive: vi.fn(),
    getChannelCycleMode: vi.fn(() => 'global'),
    getLiveReconnectAttempts: vi.fn(() => 3),
  },
}));
vi.mock('../services/media-probe', () => ({
  probeMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock('./toast', () => ({ showToast: vi.fn() }));

import { Player } from './player';
import { CONFIG } from '../config';
import { StorageService } from '../services/storage-service';
import {
  channelExactStreamIdentity,
  channelExactStreamKey,
  channelKey,
  channelStreamKey,
} from '../utils/channel';
import { ParentalControlService, liveParentalRequest } from '../services/parental-control';

const channels: Channel[] = [1, 2].map((index) => ({
  id: `ch${index}`, name: `Channel ${index}`, logo: '', group: '',
  url: `http://host/ch${index}`, extras: null, playlistIds: [],
  catchup: 'default', catchupSource: 'http://host/archive?start={utc}&end={utcend}',
  catchupDays: 7,
}));
const catchup = { start: 1_000_000, end: 1_000_120, title: 'Program 1', description: '', icon: '' };
const vod: VodPlayback = {
  url: 'http://host/movie', title: 'Movie 1', poster: '', accountId: 'a1',
  itemId: 'm1', kind: 'movie', subtitles: [], resumeSecs: 0, onBack: () => {},
};

let player: Player;
let video: HTMLVideoElement;
let container: HTMLElement;
let onStateChanged: ReturnType<typeof vi.fn>;
let canResume: ReturnType<typeof vi.fn>;
let listenerRegistrations: ReturnType<typeof vi.spyOn<typeof document, 'addEventListener'>>;

function currentVideo(): HTMLVideoElement {
  return player.getVideoElement()!;
}

function emit(type: string, element = currentVideo()): void {
  element.dispatchEvent(new Event(type));
}

function playing(element = currentVideo()): void {
  vi.spyOn(element, 'paused', 'get').mockReturnValue(false);
  emit('playing', element);
}

function changeAudioBeforeEvent(): void {
  // jsdom fires volumechange synchronously; hold it to exercise a pending notification.
  const defer = (event: Event) => event.stopImmediatePropagation();
  video.addEventListener('volumechange', defer, true);
  video.muted = true;
  video.volume = 0.2;
  video.removeEventListener('volumechange', defer, true);
}

function setDvr(start: number, end: number, position: number, duration = Infinity): void {
  const element = currentVideo();
  vi.spyOn(element, 'duration', 'get').mockReturnValue(duration);
  vi.spyOn(element, 'seekable', 'get').mockReturnValue({
    length: 1, start: () => start, end: () => end,
  });
  element.currentTime = position;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<video id="video-player"></video><div id="player"></div>';
  video = document.querySelector('video')!;
  container = document.querySelector('#player')!;
  playlist.channels = channels;
  playlist.getByIndex.mockImplementation((index: number) => playlist.channels[index]);
  playlist.indexOf.mockImplementation((channel: Channel) => playlist.channels.indexOf(channel));
  playlist.resolveChannelKey.mockImplementation((key: string) => {
    const channel = playlist.channels.find(item => channelKey(item) === key);
    if (!channel) return null;
    return { channel, channelIndex: playlist.channels.indexOf(channel) };
  });
  playlist.getByGroup.mockReturnValue(playlist.channels);
  vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('global');
  onStateChanged = vi.fn();
  canResume = vi.fn(() => true);
  player = new Player(container, vi.fn(), vi.fn(), () => true, vi.fn(), onStateChanged, canResume);
  listenerRegistrations = vi.spyOn(document, 'addEventListener');
  player.init(video);
});

afterEach(() => {
  player.stop();
  for (const [type, listener, options] of listenerRegistrations.mock.calls) {
    document.removeEventListener(type, listener, options);
  }
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Player live preview', () => {
  it('exposes a snapshot only for an active live session, independent of presentation', () => {
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    expect(player.isInLivePreview()).toBe(false);
    expect(player.getVideoElement()).toBe(video);
    player.play(0);
    expect(player.getLivePlaybackSnapshot()).toEqual({
      channel: channels[0], muted: false, status: 'loading',
    });
    player.enterLivePreview();
    expect(player.getLivePlaybackSnapshot()?.channel).toBe(channels[0]);
    player.play(0, catchup);
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    player.play(1);
    expect(player.getLivePlaybackSnapshot()?.channel).toBe(channels[1]);
    player.playVod(vod);
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    expect(player.isInLivePreview()).toBe(false);
    player.play(0);
    player.stop();
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    expect(player.isInLivePreview()).toBe(false);
  });

  it('tunes and changes channels in preview without revealing the OSD or player overlay', () => {
    player.enterLivePreview();
    player.play(0);
    player.showOSD();
    player.play(1);
    expect(player.isInLivePreview()).toBe(true);
    expect(osd.show).not.toHaveBeenCalled();
    expect(container.classList.contains('hidden')).toBe(true);
    expect(container.style.display).toBe('none');
    expect(video.classList.contains('active')).toBe(true);
    expect(pipeline.load).toHaveBeenCalledTimes(2);
    expect(player.getLivePlaybackSnapshot()?.channel).toBe(channels[1]);
  });

  it('rebinds a reordered replacement channel without reloading playback', () => {
    const scope = { group: 'source:g1' as const, playlist: 'p1' };
    player.enterLivePreview();
    player.play(0, undefined, scope);
    const replacement = { ...channels[0] };
    const other = { ...channels[1] };
    playlist.channels = [other, replacement];
    playlist.getByGroup.mockReturnValue([replacement, other]);
    pipeline.load.mockClear();
    onStateChanged.mockClear();

    player.syncCurrentIndex();

    expect(player.getCurrentChannel()).toBe(replacement);
    expect(player.getCurrentIndex()).toBe(1);
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(onStateChanged).toHaveBeenCalledOnce();
    vi.mocked(StorageService.getChannelCycleMode).mockReturnValue('active');
    player.channelUp();
    expect(player.getCurrentChannel()).toBe(other);
    expect(player.getCurrentIndex()).toBe(0);
  });

  it('moves the saved last channel\'s index with its reordered channel', () => {
    player.enterLivePreview();
    player.play(0);
    const calls = vi.mocked(StorageService.setLastChannel).mock.calls;
    const saved = calls[calls.length - 1][0];
    vi.mocked(StorageService.getLastChannel).mockReturnValue(saved);
    playlist.channels = [channels[1], channels[0]];
    vi.mocked(StorageService.setLastChannel).mockClear();

    player.syncCurrentIndex();

    expect(player.getCurrentIndex()).toBe(1);
    expect(StorageService.setLastChannel).toHaveBeenCalledWith({ ...saved, index: 1 });
    vi.mocked(StorageService.getLastChannel).mockReturnValue(null);
  });

  it('retunes a replacement channel when its signed URL was refreshed', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.enterLivePreview();
    player.play(0);
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(player.getCurrentChannel()).toBe(replacement);
    expect(player.getCurrentIndex()).toBe(0);
    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, replacement.extras, { headers: {} });
  });

  it('retunes a replacement channel whose stream options changed', () => {
    const oldChannel = { ...channels[0], extras: { 'http-referrer': 'http://host/a' } };
    playlist.channels = [oldChannel];
    player.enterLivePreview();
    player.play(0);
    const replacement = { ...oldChannel, extras: { 'http-referrer': 'http://host/b' } };
    playlist.channels = [replacement];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(player.getCurrentChannel()).toBe(replacement);
    expect(pipeline.load).toHaveBeenCalledOnce();
  });

  it('hands the channel headers to the pipeline', () => {
    playlist.channels = [{ ...channels[0], httpHeaders: { Referer: 'http://host/' } }];
    pipeline.load.mockClear();
    player.play(0);
    expect(pipeline.load).toHaveBeenCalledWith(channels[0].url, null,
      { headers: { Referer: 'http://host/' } });
  });

  it('retunes a refreshed URL without asking for the PIN again', () => {
    const authorize = vi.fn((_channel: Channel, action: () => void) => { action(); return true; });
    player.stop();
    player = new Player(
      container, vi.fn(), vi.fn(), () => true, vi.fn(), onStateChanged, canResume, authorize,
    );
    player.init(document.querySelector('video')!);
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    playlist.channels = [{ ...oldChannel, url: `${channels[0].url}?token=new` }];
    authorize.mockClear();
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(authorize).not.toHaveBeenCalled();
    expect(pipeline.load).toHaveBeenCalledOnce();
  });

  it('asks for the PIN on resume only in full screen, not in the list preview', () => {
    const authorize = vi.fn((_channel: Channel, action: () => void) => { action(); return true; });
    player.stop();
    player = new Player(
      container, vi.fn(), vi.fn(), () => true, vi.fn(), onStateChanged, canResume, authorize,
    );
    player.init(document.querySelector('video')!);
    player.play(0);
    playing();
    player.suspend();
    player.resume();
    expect(authorize).toHaveBeenLastCalledWith(channels[0], expect.any(Function), false, true);

    player.enterLivePreview();
    playing();
    player.suspend();
    player.resume();
    expect(authorize).toHaveBeenLastCalledWith(channels[0], expect.any(Function), true, false);
  });

  it('unloads a paused Luna stream on suspend and restarts it on resume', () => {
    player.play(0);
    pipeline.isLunaActive.mockReturnValue(true);
    pipeline.load.mockClear();
    try {
      player.suspend();
      expect(pipeline.destroy).toHaveBeenCalled();
      player.resume();
      expect(pipeline.load).toHaveBeenCalledOnce();
    } finally {
      pipeline.isLunaActive.mockReturnValue(false);
    }
  });

  it('unloads a Luna stream still preparing its DRM on suspend and restarts it on resume', () => {
    player.play(0);
    pipeline.isLunaPending.mockReturnValue(true);
    pipeline.load.mockClear();
    try {
      player.suspend();
      expect(pipeline.destroy).toHaveBeenCalled();
      player.resume();
      expect(pipeline.load).toHaveBeenCalledOnce();
    } finally {
      pipeline.isLunaPending.mockReturnValue(false);
    }
  });

  it('unloads a stream whose proxy session is still opening on suspend and restarts it on resume', () => {
    player.play(0);
    pipeline.isProxyPending.mockReturnValue(true);
    pipeline.load.mockClear();
    try {
      player.suspend();
      expect(pipeline.destroy).toHaveBeenCalled();
      player.resume();
      expect(pipeline.load).toHaveBeenCalledOnce();
    } finally {
      pipeline.isProxyPending.mockReturnValue(false);
    }
  });

  it('places a Luna picture in the 1920x1080 app space', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(960);
    player.setVideoDisplay({ left: 440, top: 80, width: 480, height: 270 });
    expect(pipeline.setLunaDisplay)
      .toHaveBeenLastCalledWith({ x: 880, y: 160, width: 960, height: 540 });
    player.setVideoDisplay(null);
    expect(pipeline.setLunaDisplay).toHaveBeenLastCalledWith('full');
  });

  it('hands a live preview header channel to the pipeline in the preview rect', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    playlist.channels = [{ ...channels[0], httpHeaders: { Referer: 'http://host/' } }];
    player.enterLivePreview();
    player.setVideoDisplay({ left: 440, top: 80, width: 480, height: 270 });
    pipeline.load.mockClear();
    player.play(0);
    expect(pipeline.load).toHaveBeenCalledWith(channels[0].url, null,
      { headers: { Referer: 'http://host/' } });
    expect(pipeline.setLunaDisplay)
      .toHaveBeenLastCalledWith({ x: 440, y: 80, width: 480, height: 270 });
  });

  it('starts a full-screen load at full screen, never resizing the outgoing pipeline', () => {
    player.enterLivePreview();
    player.setVideoDisplay({ left: 440, top: 80, width: 480, height: 270 });
    player.play(0);
    expect(pipeline.setLunaDisplay).not.toHaveBeenLastCalledWith('full');

    player.exitLivePreview();
    pipeline.setLunaDisplay.mockClear();
    player.play(1);
    expect(pipeline.setLunaDisplay).toHaveBeenCalledWith('full');
    expect(pipeline.setLunaDisplay.mock.invocationCallOrder[0])
      .toBeGreaterThan(pipeline.load.mock.invocationCallOrder.at(-1)!);
  });

  it('restores live audio when expanding without touching playback state', () => {
    player.play(0);
    player.enterLivePreview();
    video.currentTime = 45;
    video.volume = 0.35;
    player.togglePreviewMute();
    const src = vi.spyOn(video, 'src', 'set');
    vi.clearAllMocks();
    const parent = video.parentNode;
    expect(video.muted).toBe(true);
    player.enterLivePreview();
    expect(video.muted).toBe(true);
    player.exitLivePreview();
    expect(video.muted).toBe(false);
    player.exitLivePreview();
    player.enterLivePreview();
    expect(video.muted).toBe(false);
    player.exitLivePreview();
    expect(player.isInLivePreview()).toBe(false);
    expect(player.getVideoElement()).toBe(video);
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(pipeline.destroy).not.toHaveBeenCalled();
    expect(video.load).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(src).not.toHaveBeenCalled();
    expect(video.parentNode).toBe(parent);
    expect(video.currentTime).toBe(45);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.35);
  });

  it('keeps preview mute across channel changes and clears it after stop', () => {
    player.play(0);
    player.enterLivePreview();
    video.volume = 0.3;
    emit('volumechange');
    player.togglePreviewMute();
    expect(onStateChanged).toHaveBeenCalled();
    player.play(1);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.3);
    expect(player.getLivePlaybackSnapshot()?.muted).toBe(true);
    player.stop();
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    expect(video.muted).toBe(false);
    player.togglePreviewMute();
    expect(video.muted).toBe(false);
    player.enterLivePreview();
    player.play(0);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.3);
    player.togglePreviewMute();
    player.play(1);
    expect(video.muted).toBe(true);
    player.exitLivePreview();
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.3);
  });

  it('captures the current live audio state on stop before a volumechange event arrives', () => {
    player.play(0);
    changeAudioBeforeEvent();
    player.stop();
    player.play(1);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.2);
  });

  it('preserves current audio on live tune before a volumechange event arrives', () => {
    player.play(0);
    changeAudioBeforeEvent();
    player.play(1);
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.2);
  });

  it('preserves audio and intended preview presentation across video recreation and resume', () => {
    player.play(0);
    player.enterLivePreview();
    video.volume = 0.25;
    emit('volumechange');
    player.togglePreviewMute();
    playing();
    player.suspend();
    const fresh = currentVideo();
    expect(fresh).not.toBe(video);
    expect(fresh.parentNode).toBe(document.body);
    expect(fresh.id).toBe('video-player');
    expect(fresh.muted).toBe(true);
    expect(fresh.volume).toBe(0.25);
    expect(player.isInLivePreview()).toBe(true);
    expect(pipeline.setVideoElement).toHaveBeenLastCalledWith(fresh);
    expect(onStateChanged).toHaveBeenCalled();
    osd.show.mockClear();
    player.resume();
    expect(pipeline.load).toHaveBeenCalledTimes(2);
    expect(fresh.muted).toBe(true);
    expect(fresh.volume).toBe(0.25);
    expect(player.getLivePlaybackSnapshot()?.status).toBe('loading');
    expect(osd.show).not.toHaveBeenCalled();
  });

  it('does not inherit VOD volume changes into the next live session', () => {
    player.play(0);
    player.enterLivePreview();
    video.volume = 0.4;
    player.togglePreviewMute();
    player.playVod(vod);
    expect(video.muted).toBe(false);
    video.volume = 0.9;
    emit('volumechange');
    player.stop();
    player.play(1);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.4);
  });

  it('reports loading, playing, buffering, paused and reconnecting from actual events', () => {
    player.play(0);
    expect(player.getLivePlaybackSnapshot()?.status).toBe('loading');
    for (const [event, status] of [
      ['playing', 'playing'], ['waiting', 'buffering'], ['pause', 'paused'], ['error', 'buffering'],
    ]) {
      onStateChanged.mockClear();
      emit(event);
      expect(player.getLivePlaybackSnapshot()?.status).toBe(status);
      expect(onStateChanged).toHaveBeenCalled();
    }
    player.play(1);
    expect(player.getLivePlaybackSnapshot()?.status).toBe('loading');
    expect(player.getLivePlaybackSnapshot()?.channel).toBe(channels[1]);
    emit('playing');
    expect(player.getLivePlaybackSnapshot()?.status).toBe('playing');
  });

  it.each(['playing', 'waiting', 'pause', 'volumechange', 'loadedmetadata', 'error'])(
    'ignores stale %s events from a replaced video element',
    (event) => {
      player.play(0);
      player.togglePreviewMute();
      playing();
      player.suspend();
      player.resume();
      emit('playing');
      const snapshot = player.getLivePlaybackSnapshot();
      onStateChanged.mockClear();
      health.recordPlaybackFailure.mockClear();
      video.muted = false;
      emit(event, video);
      expect(player.getLivePlaybackSnapshot()).toEqual(snapshot);
      expect(onStateChanged).not.toHaveBeenCalled();
      expect(health.recordPlaybackFailure).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid suspended-session resume without loading the stream again', () => {
    player.play(0);
    player.enterLivePreview();
    playing();
    player.suspend();
    pipeline.load.mockClear();
    canResume.mockReturnValue(false);
    player.resume();
    expect(canResume).toHaveBeenCalled();
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    expect(player.isInLivePreview()).toBe(false);
    expect(currentVideo().classList.contains('active')).toBe(false);
    canResume.mockReturnValue(true);
    player.resume();
    expect(pipeline.load).not.toHaveBeenCalled();
  });

  it('does not resurrect stopped playback when resume arrives after suspension', () => {
    player.play(0);
    playing();
    player.suspend();
    player.stop();
    pipeline.load.mockClear();
    player.resume();
    player.resume();
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(player.getLivePlaybackSnapshot()).toBeNull();
    emit('playing');
    emit('waiting');
    expect(player.getLivePlaybackSnapshot()).toBeNull();
  });

  it('returns to the live edge when entering preview without revealing the OSD', () => {
    player.play(0);
    setDvr(100, 200, 130);
    osd.show.mockClear();
    osd.resetTimer.mockClear();
    player.enterLivePreview();
    expect(video.currentTime).toBe(200 - CONFIG.PLAYER.DVR_GO_LIVE_PAD);
    expect(osd.show).not.toHaveBeenCalled();
    expect(osd.resetTimer).not.toHaveBeenCalled();
    expect(player.getLivePlaybackSnapshot()).toEqual({
      channel: channels[0], muted: false, status: 'loading',
    });
  });
});

describe('Player Luna resume', () => {
  const resumeEvents = () => vi.mocked(console.log).mock.calls
    .map(args => args.join(' ')).filter(text => text.includes('event=playback.luna.resume '));

  function withAuthorizer(authorize: (channel: Channel, action: () => void) => boolean): void {
    player.stop();
    player = new Player(
      container, vi.fn(), vi.fn(), () => true, vi.fn(), onStateChanged, canResume, authorize,
    );
    player.init(document.querySelector('video')!);
  }

  function suspendPausedLuna(): void {
    player.play(0);
    pipeline.isLunaActive.mockReturnValue(true);
    (player as unknown as { userPaused: boolean }).userPaused = true;
    vi.spyOn(currentVideo(), 'paused', 'get').mockReturnValue(true);
    player.suspend();
    pipeline.isLunaActive.mockReturnValue(false);
  }

  // The re-pause settles only when the test says UMS answered.
  function holdPause(): () => void {
    let land = () => {};
    const landed = new Promise<void>((resolve) => { land = resolve; });
    vi.spyOn(currentVideo(), 'pause').mockReturnValue(landed as unknown as undefined);
    return land;
  }

  it('keeps a paused Luna restore through a PIN asked on resume', () => {
    let deferred: (() => void) | null = null;
    let allowed = true;
    withAuthorizer((_channel, action) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    suspendPausedLuna();
    allowed = false;

    player.resume();
    expect(deferred).not.toBeNull();
    (deferred as unknown as () => void)();
    playing();

    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('stays silent until a paused Luna restore has paused again', async () => {
    suspendPausedLuna();
    player.resume();
    expect(currentVideo().muted).toBe(true);
    expect(player.getLivePlaybackSnapshot()?.muted).toBe(false);

    const land = holdPause();
    pipeline.isLunaActive.mockReturnValue(true);
    playing();
    await Promise.resolve();
    expect(currentVideo().muted).toBe(true);

    land();
    await vi.waitFor(() => expect(currentVideo().muted).toBe(false));
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1 path=luna')]);
  });

  it('keeps the user\'s mute after a paused Luna restore', async () => {
    player.play(0);
    currentVideo().muted = true;
    pipeline.isLunaActive.mockReturnValue(true);
    (player as unknown as { userPaused: boolean }).userPaused = true;
    vi.spyOn(currentVideo(), 'paused', 'get').mockReturnValue(true);
    player.suspend();
    pipeline.isLunaActive.mockReturnValue(false);

    player.resume();
    playing();
    await Promise.resolve();

    expect(currentVideo().muted).toBe(true);
    player.stop();
    player.play(0);
    expect(currentVideo().muted).toBe(true);
  });

  it('restores a Luna resume after the playlist rebinds the channel while hidden', () => {
    suspendPausedLuna();
    const replacement = { ...channels[0] };
    playlist.channels = [replacement, channels[1]];
    player.syncCurrentIndex();
    expect(player.getCurrentChannel()).toBe(replacement);

    player.resume();
    playing();

    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1 path=native')]);
  });
  it('waits for the return to retune a hidden Luna session whose token rotated', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    vi.spyOn(currentVideo(), 'duration', 'get').mockReturnValue(60);
    pipeline.lunaClock.mockReturnValueOnce((() => 11) as unknown as null);
    suspendPausedLuna();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(pipeline.load).not.toHaveBeenCalled();
    expect(player.getCurrentChannel()).toBe(replacement);
    player.resume();
    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, null, { headers: {} });
    expect((player as unknown as { pendingResumeSecs: number }).pendingResumeSecs).toBe(11);
    playing();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('asks a hidden session for the PIN of a locked stand-in only on return', () => {
    let deferred: (() => void) | null = null;
    let allowed = true;
    const authorize = vi.fn((_channel: Channel, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    withAuthorizer(authorize);
    const current: Channel = {
      ...channels[0], group: 'g1', playlistIds: ['p1'], httpHeaders: { Referer: 'http://host/a' },
    };
    const locked: Channel = { ...channels[0], group: 'g2', playlistIds: ['p1'] };
    playlist.channels = [current];
    suspendPausedLuna();
    allowed = false;
    authorize.mockClear();
    vi.spyOn(ParentalControlService, 'decision')
      .mockReturnValue({ allowed: false, concealed: false, reason: 'parent' });
    playlist.channels = [locked];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(authorize).not.toHaveBeenCalled();
    expect(pipeline.load).not.toHaveBeenCalled();
    player.resume();
    expect(authorize).toHaveBeenCalledWith(locked, expect.any(Function), false, true);
    expect(pipeline.load).not.toHaveBeenCalled();
    (deferred as unknown as () => void)();
    expect(pipeline.load).toHaveBeenCalledOnce();
    playing();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('retunes a session hidden while paused only once visible again', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    player.suspend();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(pipeline.load).not.toHaveBeenCalled();
    player.resume();
    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(player.getCurrentChannel()).toBe(replacement);
  });

  it('asks for the PIN and keeps the pause when a paused hidden session retunes', () => {
    let deferred: (() => void) | null = null;
    let allowed = true;
    const authorize = vi.fn((_channel: Channel, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    withAuthorizer(authorize);
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    (player as unknown as { userPaused: boolean }).userPaused = true;
    vi.spyOn(currentVideo(), 'paused', 'get').mockReturnValue(true);
    player.suspend();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    player.syncCurrentIndex();
    allowed = false;
    authorize.mockClear();
    pipeline.load.mockClear();

    player.resume();

    expect(authorize).toHaveBeenCalledWith(replacement, expect.any(Function), false, true);
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.map(args => args.join(' '))
      .filter(text => text.includes('event=parental.playback.relocked')))
      .toEqual([expect.stringContaining('reason=resume')]);
    (deferred as unknown as () => void)();
    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, null, { headers: {} });
    const pause = vi.spyOn(currentVideo(), 'pause');
    playing();
    expect(pause).toHaveBeenCalled();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('keeps the pause when an unlocked paused hidden session retunes', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    (player as unknown as { userPaused: boolean }).userPaused = true;
    vi.spyOn(currentVideo(), 'paused', 'get').mockReturnValue(true);
    player.suspend();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    player.syncCurrentIndex();
    pipeline.load.mockClear();

    player.resume();

    expect(pipeline.load).toHaveBeenCalledOnce();
    const pause = vi.spyOn(currentVideo(), 'pause');
    playing();
    expect(pause).toHaveBeenCalled();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('keeps a pending paused restore when hidden again before it lands', () => {
    player.play(0);
    vi.spyOn(currentVideo(), 'duration', 'get').mockReturnValue(60);
    pipeline.lunaClock.mockReturnValueOnce((() => 11) as unknown as null);
    suspendPausedLuna();
    player.resume();
    pipeline.isLunaActive.mockReturnValue(true);
    vi.spyOn(currentVideo(), 'duration', 'get').mockReturnValue(60);
    pipeline.lunaClock.mockReturnValueOnce((() => 0) as unknown as null);
    vi.spyOn(currentVideo(), 'paused', 'get').mockReturnValue(false);

    player.suspend();
    pipeline.isLunaActive.mockReturnValue(false);
    player.resume();

    expect((player as unknown as { pendingResumeSecs: number }).pendingResumeSecs).toBe(11);
    playing();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  function finiteAt(position: number, paused: boolean): void {
    const element = currentVideo();
    vi.spyOn(element, 'duration', 'get').mockReturnValue(60);
    vi.spyOn(element, 'paused', 'get').mockReturnValue(paused);
    element.currentTime = position;
    (player as unknown as { userPaused: boolean }).userPaused = paused;
  }

  it('keeps the pause and position when a refresh lands after resume', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    suspendPausedLuna();
    player.resume();
    playing();
    finiteAt(20, true);
    pipeline.load.mockClear();
    player.syncCurrentIndex();
    expect(pipeline.load).not.toHaveBeenCalled();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    vi.mocked(console.log).mockClear();

    player.syncCurrentIndex();

    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, null, { headers: {} });
    expect((player as unknown as { pendingResumeSecs: number }).pendingResumeSecs).toBe(20);
    expect(currentVideo().muted).toBe(true);
    const pause = vi.spyOn(currentVideo(), 'pause');
    playing();
    expect(pause).toHaveBeenCalled();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });

  it('keeps a playing finite stream playing at its position when its token rotates', () => {
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    player.play(0);
    playing();
    finiteAt(20, false);
    playlist.channels = [{ ...oldChannel, url: `${channels[0].url}?token=new` }];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(pipeline.load).toHaveBeenCalledOnce();
    expect((player as unknown as { pendingResumeSecs: number }).pendingResumeSecs).toBe(20);
    expect(currentVideo().muted).toBe(false);
    const pause = vi.spyOn(currentVideo(), 'pause');
    playing();
    expect(pause).not.toHaveBeenCalled();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=0')]);
  });

  it('plays the refreshed copy when a token rotates while resume waits for the PIN', () => {
    let deferred: (() => void) | null = null;
    let allowed = true;
    withAuthorizer((_channel, action) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    const oldChannel = { ...channels[0], url: `${channels[0].url}?token=old` };
    playlist.channels = [oldChannel];
    suspendPausedLuna();
    allowed = false;
    player.resume();
    const replacement = { ...oldChannel, url: `${channels[0].url}?token=new` };
    playlist.channels = [replacement];
    player.syncCurrentIndex();
    pipeline.load.mockClear();

    (deferred as unknown as () => void)();

    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, null, { headers: {} });
    expect(player.getCurrentChannel()).toBe(replacement);
    playing();
    expect(resumeEvents()).toEqual([expect.stringContaining('paused=1')]);
  });
});

describe('Player channel rebind', () => {
  it('saves the last channel stream so autoplay can pick it among shared keys', () => {
    const channel: Channel = { ...channels[0], httpHeaders: { Referer: 'http://host/a' } };
    playlist.channels = [channel];

    player.play(0);

    expect(StorageService.setLastChannel).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, stream: channelStreamKey(channel) }));
  });

  it('keeps the playing copy among copies that differ only by a token', () => {
    const copyA = { ...channels[0], url: `${channels[0].url}?token=A` };
    const copyB = { ...channels[0], url: `${channels[0].url}?token=B` };
    playlist.channels = [copyA, copyB];
    playlist.resolveChannelKey.mockImplementation((key: string, _stream?: string,
      _prefer?: (channel: Channel) => boolean, exact?: string) => {
      const shared = playlist.channels.filter(item => channelKey(item) === key);
      const channel = shared.find(item => channelExactStreamIdentity(item) === exact) ?? shared[0];
      return channel ? { channel, channelIndex: playlist.channels.indexOf(channel) } : null;
    });
    player.play(1);
    expect(StorageService.setLastChannel).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, exact: channelExactStreamKey(copyB) }));
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(pipeline.load).not.toHaveBeenCalled();
    expect(player.getCurrentChannel()).toBe(copyB);
    expect(player.getCurrentIndex()).toBe(1);
  });

  it('asks for the PIN when a rebind falls back to a locked channel sharing the key', () => {
    let deferred: (() => void) | null = null;
    let allowed = true;
    const authorize = vi.fn((_channel: Channel, action: () => void) => {
      if (allowed) { action(); return true; }
      deferred = action;
      return false;
    });
    const onBack = vi.fn();
    player.stop();
    player = new Player(
      container, onBack, vi.fn(), () => true, vi.fn(), onStateChanged, canResume, authorize,
    );
    player.init(document.querySelector('video')!);
    const current: Channel = {
      ...channels[0], group: 'g1', playlistIds: ['p1'], httpHeaders: { Referer: 'http://host/a' },
    };
    const locked: Channel = { ...channels[0], group: 'g2', playlistIds: ['p1'] };
    playlist.channels = [current];
    player.play(0);
    allowed = false;
    authorize.mockClear();
    const lockedParents = JSON.stringify(liveParentalRequest(locked).parents);
    vi.spyOn(ParentalControlService, 'decision').mockImplementation(request =>
      JSON.stringify(request.parents) === lockedParents
        ? { allowed: false, concealed: false, reason: 'parent' }
        : { allowed: true });
    playlist.channels = [locked];
    pipeline.load.mockClear();

    player.syncCurrentIndex();

    expect(authorize).toHaveBeenCalledWith(locked, expect.any(Function), false, true);
    expect(pipeline.load).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledOnce();
    (deferred as unknown as () => void)();
    expect(pipeline.load).toHaveBeenCalledOnce();
    expect(player.getCurrentChannel()).toBe(locked);
  });
});
