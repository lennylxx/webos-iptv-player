// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, VodPlayback } from '../types';

const { pipeline, tracks, osd, playlist, health } = vi.hoisted(() => ({
  pipeline: {
    load: vi.fn(), destroy: vi.fn(), setVideoElement: vi.fn(),
    currentLoadToken: vi.fn(() => 1), videoLabel: vi.fn(() => 'video'),
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
    setLastChannel: vi.fn(), setLastChannelKey: vi.fn(),
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
import { channelKey } from '../utils/channel';

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
    expect(pipeline.load).toHaveBeenCalledWith(replacement.url, replacement.extras, undefined);
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
