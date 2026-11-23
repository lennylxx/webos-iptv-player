// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Channel, VodPlayback } from '../types';
import type { AspectRatio } from '../services/aspect-ratio';
import type { LunaRequestOptions } from '../services/luna';

const { pipeline, tracks, osd, playlist, health, saved, dirty, requests } = vi.hoisted(() => ({
  pipeline: {
    load: vi.fn(), destroy: vi.fn(), setVideoElement: vi.fn(),
    currentLoadToken: vi.fn(() => 1), videoLabel: vi.fn(() => 'video'),
    isLunaActive: vi.fn(() => false), isLunaPending: vi.fn(() => false), isSourcePending: vi.fn(() => false), isProxyPending: vi.fn(() => false),
    canEscalate: vi.fn(() => false),
    isLunaStarting: vi.fn(() => false), lunaClock: vi.fn(() => null), setLunaDisplay: vi.fn(),
    lunaStreamUrl: vi.fn(() => ''), escalate: vi.fn(() => false),
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
  saved: {} as Record<string, string>,
  dirty: { value: false },
  requests: [] as { uri: string; options: LunaRequestOptions }[],
}));

vi.mock('./player-pipeline', () => ({ PlayerPipeline: vi.fn(function () { return pipeline; }) }));
vi.mock('./player-tracks', () => ({ PlayerTracks: vi.fn(function () { return tracks; }) }));
vi.mock('./player-osd', () => ({ PlayerOsd: vi.fn(function () { return osd; }) }));
vi.mock('../services/playlist-service', () => ({ PlaylistService: playlist }));
vi.mock('../services/channel-health', () => ({ ChannelHealthService: health }));
vi.mock('../services/epg-service', () => ({
  EpgService: { findChannelId: () => null, getNowPlaying: () => null },
}));
vi.mock('../services/storage-service', () => ({
  StorageService: {
    getLastChannel: vi.fn(() => null), setLastChannel: vi.fn(),
    setCatchupProgress: vi.fn(), setResume: vi.fn(), getResume: vi.fn(() => null),
    touchRecentlyWatchedLive: vi.fn(),
    getChannelCycleMode: vi.fn(() => 'global'),
    getLiveReconnectAttempts: vi.fn(() => 3),
    getHeaderPlayback: vi.fn(() => 'off'),
    getVideoQuality: vi.fn(() => 'auto'),
    getQualityOverride: vi.fn(() => null),
    setQualityOverride: vi.fn(),
    getAspectRatio: vi.fn((key: string) => saved[key] ?? 'auto'),
    setAspectRatio: vi.fn((key: string, mode: string) => { saved[key] = mode; }),
    getAspectDirty: vi.fn(() => dirty.value),
    setAspectDirty: vi.fn((value: boolean) => { dirty.value = value; }),
  },
}));
vi.mock('../services/luna', () => ({
  isLunaAvailable: () => true,
  lunaRequest: vi.fn((uri: string, options: LunaRequestOptions = {}) => {
    requests.push({ uri, options });
    return { cancel: () => {} };
  }),
}));
vi.mock('../services/media-probe', () => ({ probeMedia: vi.fn().mockResolvedValue(null) }));
vi.mock('./toast', () => ({ showToast: vi.fn() }));

import { Player } from './player';
import { PlayerPipeline, type PlayerPipelineOptions } from './player-pipeline';
import { StorageService } from '../services/storage-service';
import { showToast } from './toast';
import { channelKey } from '../utils/channel';

const channels: Channel[] = [1, 2].map((index) => ({
  id: `ch${index}`, name: `Channel ${index}`, logo: '', group: '',
  url: `http://host/ch${index}`, extras: null, playlistIds: [],
  catchup: '', catchupSource: '', catchupDays: 0,
}));
const movie: VodPlayback = {
  url: 'http://host/movie', title: 'Movie 1', poster: '', accountId: 'a1',
  itemId: 'm1', kind: 'vod', subtitles: [], resumeSecs: 0, onBack: () => {},
};
const episode = (itemId: string): VodPlayback => ({
  ...movie, url: `http://host/${itemId}`, title: itemId, itemId, kind: 'episode',
  watchlistOwner: { kind: 'series', itemId: 's1' },
});

let player: Player;
let layout: Mock<() => void>;

const aspectWrites = () => requests.filter(r => r.options.method === 'setAspectRatio');
const written = () => aspectWrites().map(r => (r.options.parameters as { value: string }).value);
const answer = (index: number, ok = true) => {
  const request = aspectWrites()[index].options;
  if (ok) request.onSuccess?.({ returnValue: true });
  else request.onFailure?.({ returnValue: false, errorCode: 'timeout' as unknown as number });
};
const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(saved)) delete saved[key];
  dirty.value = false;
  requests.length = 0;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Web0S; Linux/SmartTV)');
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<video id="video-player"></video><div id="player"></div>';
  playlist.channels = channels;
  playlist.getByIndex.mockImplementation((index: number) => playlist.channels[index]);
  playlist.indexOf.mockImplementation((channel: Channel) => playlist.channels.indexOf(channel));
  playlist.getByGroup.mockReturnValue(playlist.channels);
  player = new Player(document.querySelector<HTMLElement>('#player')!, vi.fn());
  player.init(document.querySelector('video')!);
  layout = vi.fn<() => void>();
  player.onAspectRatioChange(layout);
});

afterEach(() => {
  player.stop();
  vi.restoreAllMocks();
});

describe('Player aspect ratio on webOS', () => {
  it('leaves the TV setting alone on a channel with no remembered ratio', () => {
    player.play(0);
    expect(aspectWrites()).toHaveLength(0);
  });

  it('applies a remembered ratio without relayouting the outgoing pipeline', () => {
    saved[channelKey(channels[1])] = 'zoom';
    player.play(0);
    player.play(1);
    expect(written()).toEqual(['allDirZoom']);
    expect(player.getAspectRatio()).toBe('zoom');
    expect(layout).not.toHaveBeenCalled();
  });

  it('re-applies a menu pick that matches the value it last wrote', () => {
    saved[channelKey(channels[0])] = 'zoom';
    player.play(0);
    answer(0);
    player.setAspectRatio('zoom');
    expect(written()).toEqual(['allDirZoom', 'allDirZoom']);
  });

  it('shows a toast when a menu pick fails, but not for a tune-in write', async () => {
    saved[channelKey(channels[0])] = '4x3';
    player.play(0);
    answer(0, false);
    await settle();
    expect(showToast).not.toHaveBeenCalled();

    player.setAspectRatio('16x9');
    answer(1, false);
    await settle();
    expect(showToast).toHaveBeenCalledWith('This aspect ratio could not be applied.');
  });

  it('undoes a ratio left from an earlier launch on an Auto channel', () => {
    player.setAspectRatio('16x9');
    answer(0);
    expect(dirty.value).toBe(true);

    player.stop();
    player = new Player(document.querySelector<HTMLElement>('#player')!, vi.fn());
    player.init(document.querySelector('video')!);
    player.play(1);
    expect(written()).toEqual(['16x9', 'original']);
    answer(1);
    expect(dirty.value).toBe(false);
  });

  it('drops a failed pick\'s toast once playback moved to another channel', async () => {
    saved[channelKey(channels[1])] = 'zoom';
    player.play(0);
    player.setAspectRatio('zoom');
    player.play(1);
    expect(written()).toEqual(['allDirZoom']);
    answer(0, false);
    await settle();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('drops a failed pick\'s toast once the player closed', async () => {
    player.play(0);
    player.setAspectRatio('4x3');
    player.stop();
    answer(0, false);
    await settle();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('still shows a failed pick\'s toast in the live preview', async () => {
    player.play(0);
    player.setAspectRatio('4x3');
    player.enterLivePreview();
    answer(0, false);
    await settle();
    expect(showToast).toHaveBeenCalledWith('This aspect ratio could not be applied.');
  });

  it('does not re-read or re-apply the ratio on a stall reload', () => {
    saved[channelKey(channels[0])] = 'zoom';
    player.play(0);
    const reads = vi.mocked(StorageService.getAspectRatio).mock.calls.length;
    (player as unknown as { reloadCurrentStream(): void }).reloadCurrentStream();
    expect(vi.mocked(StorageService.getAspectRatio).mock.calls.length).toBe(reads);
    expect(written()).toEqual(['allDirZoom']);
  });

  it('restores a movie by its own key', () => {
    saved['vod:a1:vod:m1'] = '4x3';
    player.playVod(movie);
    expect(player.getAspectRatio()).toBe('4x3');
    expect(written()).toEqual(['4x3']);
  });

  it('shares one choice across the episodes of a series', () => {
    player.playVod(episode('e1'));
    player.setAspectRatio('zoom');
    expect(saved).toEqual({ 'vod:a1:series:s1': 'zoom' });

    player.playVod(movie);
    expect(player.getAspectRatio()).toBe('auto');
    player.playVod(episode('e2'));
    expect(player.getAspectRatio()).toBe('zoom');
  });

  describe('on the videooutput route', () => {
    let frames: Map<number, FrameRequestCallback>;
    let frameId: number;
    const nextFrame = () => {
      const run = [...frames.values()];
      frames.clear();
      for (const frame of run) frame(0);
    };
    const painted = () => { nextFrame(); nextFrame(); };
    const video = () => document.querySelector('video') as HTMLVideoElement & { mediaId?: string };
    const size = (width: number, height: number) => {
      Object.defineProperty(video(), 'videoWidth', { configurable: true, get: () => width });
      Object.defineProperty(video(), 'videoHeight', { configurable: true, get: () => height });
    };
    const ready = (mediaId: string) => {
      video().mediaId = mediaId;
      video().dispatchEvent(new Event('loadedmetadata'));
      painted();
    };
    const params = () => aspectWrites().map(r => r.options.parameters);
    const pending = (index: number) => aspectWrites()[index].options.onFailure?.(
      { returnValue: false, errorCode: 'video_pending' as unknown as number, backend: 'videooutput' } as never);
    const landed = (index: number) => aspectWrites()[index].options.onSuccess?.(
      { returnValue: true, backend: 'videooutput' } as never);
    const lunaDisplay = () => (vi.mocked(PlayerPipeline).mock.calls[0][0] as PlayerPipelineOptions).onLunaDisplay!;
    const slot = { left: 480.2, top: 50, width: 400, height: 225 } as DOMRect;
    const cropped = (mode: AspectRatio) => {
      saved[channelKey(channels[0])] = mode;
      size(1280, 720);
      player.play(0);
      pending(0);
      ready('m1');
      landed(1);
    };

    beforeEach(() => {
      frames = new Map();
      frameId = 0;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(frame => {
        frames.set(++frameId, frame);
        return frameId;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(960);
    });

    it('crops each new media once ready, never the outgoing one', () => {
      saved[channelKey(channels[0])] = 'zoom';
      saved[channelKey(channels[1])] = '4x3';
      player.play(0);
      pending(0);
      expect(lunaDisplay()()).toBe(false);
      video().mediaId = 'm1';
      video().dispatchEvent(new Event('loadedmetadata'));
      nextFrame();
      expect(lunaDisplay()()).toBe(false);
      nextFrame();
      expect(params()[1]).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
      landed(1);
      expect(lunaDisplay()()).toBe(true);

      player.play(1);
      expect(aspectWrites()).toHaveLength(2);
      ready('m2');
      expect(params()[2]).toEqual({ value: '4x3', mediaId: 'm2', display: 'full' });
    });

    it('writes a missed crop again once the media starts playing, even amid a resize', () => {
      saved[channelKey(channels[0])] = 'zoom';
      player.play(0);
      pending(0);
      ready('m1');
      pending(1);
      video().dispatchEvent(new Event('resize'));
      painted();
      expect(aspectWrites()).toHaveLength(2);
      video().dispatchEvent(new Event('playing'));
      video().dispatchEvent(new Event('resize'));
      painted();
      expect(params()[2]).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
    });

    it('crops a resized source once the page painted its new size', () => {
      cropped('zoom');
      size(960, 720);
      video().dispatchEvent(new Event('resize'));
      expect(lunaDisplay()()).toBe(true);
      player.setVideoDisplay(null);
      nextFrame();
      expect(aspectWrites()).toHaveLength(2);
      nextFrame();
      expect(params()[2]).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
    });

    it('places a cropped preview inside its slot once the page painted it', () => {
      cropped('16x9');
      player.setVideoDisplay(slot);
      expect(lunaDisplay()()).toBe(true);
      nextFrame();
      expect(aspectWrites()).toHaveLength(2);
      nextFrame();
      expect(params()[2]).toEqual({ value: '16x9', mediaId: 'm1',
        display: { x: 960, y: 100, width: 800, height: 450 } });
      player.setVideoDisplay(slot);
      painted();
      expect(aspectWrites()).toHaveLength(3);
    });

    it('writes a relayout and a resize together once, after the later of them', () => {
      cropped('16x9');
      player.setVideoDisplay(slot);
      nextFrame();
      size(960, 720);
      video().dispatchEvent(new Event('resize'));
      nextFrame();
      expect(aspectWrites()).toHaveLength(2);
      painted();
      expect(params().slice(2)).toEqual([{ value: '16x9', mediaId: 'm1',
        display: { x: 960, y: 100, width: 800, height: 450 } }]);
    });

    it('writes only the last of several relayouts in one frame', () => {
      cropped('16x9');
      player.setVideoDisplay(slot);
      player.setVideoDisplay(null);
      painted();
      expect(aspectWrites()).toHaveLength(2);
      player.setVideoDisplay(slot);
      nextFrame();
      player.setVideoDisplay(null);
      painted();
      expect(aspectWrites()).toHaveLength(2);
    });

    it('drops a change still waiting for its frame once a full-screen load starts', () => {
      saved[channelKey(channels[1])] = '16x9';
      cropped('16x9');
      player.setVideoDisplay(slot);
      size(960, 720);
      video().dispatchEvent(new Event('resize'));
      player.play(1);
      painted();
      expect(aspectWrites()).toHaveLength(2);
      ready('m2');
      expect(params().slice(2)).toEqual([{ value: '16x9', mediaId: 'm2', display: 'full' }]);
    });
  });
});
