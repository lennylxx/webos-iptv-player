// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, VodPlayback } from '../types';
import type { PlayerPipelineOptions } from './player-pipeline';
import type { QualityOverride, QualityTier, VideoQuality } from '../utils/video-quality';

const { pipeline, tracks, osd, playlist, health, store } = vi.hoisted(() => ({
  pipeline: {
    load: vi.fn(), destroy: vi.fn(), setVideoElement: vi.fn(),
    currentLoadToken: vi.fn(() => 1), videoLabel: vi.fn(() => 'video'),
    isLunaActive: vi.fn(() => false), isLunaPending: vi.fn(() => false), isSourcePending: vi.fn(() => false), isProxyPending: vi.fn(() => false),
    canEscalate: vi.fn(() => false),
    isLunaStarting: vi.fn(() => false), lunaClock: vi.fn(() => null), setLunaDisplay: vi.fn(),
    lunaStreamUrl: vi.fn(() => ''), escalate: vi.fn(() => false),
    notePlaying: vi.fn(), isProxied: vi.fn(() => false),
    engineQualityTiers: vi.fn((): QualityTier[] | null => null),
  },
  tracks: {
    resetForLoad: vi.fn(), suspend: vi.fn(), stop: vi.fn(), attachVod: vi.fn(), applyManifest: vi.fn(),
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
  store: { setting: 'auto' as VideoQuality, picks: {} as Record<string, QualityOverride> },
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
    getVideoQuality: vi.fn(() => store.setting),
    getQualityOverride: vi.fn((key: string) => store.picks[key] ?? null),
    setQualityOverride: vi.fn((key: string, pick: QualityOverride | null) => {
      if (pick) store.picks[key] = pick; else delete store.picks[key];
    }),
    getAspectRatio: vi.fn(() => 'auto'), setAspectRatio: vi.fn(),
    getAspectDirty: vi.fn(() => false), setAspectDirty: vi.fn(),
  },
}));
vi.mock('../services/luna', () => ({
  isLunaAvailable: () => false,
  lunaRequest: vi.fn(() => ({ cancel: () => {} })),
}));
vi.mock('../services/media-probe', () => ({ probeMedia: vi.fn().mockResolvedValue(null) }));
vi.mock('./toast', () => ({ showToast: vi.fn() }));

import { Player } from './player';
import { PlayerPipeline } from './player-pipeline';
import { channelKey } from '../utils/channel';

const channels: Channel[] = [1, 2].map((index) => ({
  id: `ch${index}`, name: `Channel ${index}`, logo: '', group: '',
  url: `http://host/ch${index}.m3u8`, extras: null, playlistIds: [],
  catchup: '', catchupSource: '', catchupDays: 0,
}));
const movie: VodPlayback = {
  url: 'http://host/movie.m3u8', title: 'Movie 1', poster: '', accountId: 'a1',
  itemId: 'm1', kind: 'vod', subtitles: [], resumeSecs: 0, onBack: () => {},
};
const tier = (height: number, bandwidth: number): QualityTier => ({
  width: height * 16 / 9, height, bandwidth, averageBandwidth: 0,
});
const TIERS = [tier(480, 1500000), tier(720, 3000000), tier(1080, 6000000)];

let player: Player;
let onPlaybackStateChanged: ReturnType<typeof vi.fn<() => void>>;
const options = (): PlayerPipelineOptions => vi.mocked(PlayerPipeline).mock.calls[0][0];
const deliver = (tiers: QualityTier[]): void => options().onManifest({
  audio: [], subtitles: [], closedCaptions: [], variants: [], qualityTiers: tiers, masterUrl: '',
});

beforeEach(() => {
  vi.clearAllMocks();
  store.setting = 'auto';
  store.picks = {};
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
  onPlaybackStateChanged = vi.fn<() => void>();
  player = new Player(document.querySelector<HTMLElement>('#player')!, vi.fn(),
    undefined, undefined, undefined, onPlaybackStateChanged);
  player.init(document.querySelector('video')!);
});

afterEach(() => {
  player.stop();
  vi.restoreAllMocks();
});

describe('Player Video quality', () => {
  it('starts each load with the setting, or the playing stream\'s own pick', () => {
    store.setting = 'max1080';
    store.picks[channelKey(channels[1])] = { height: 720, bandwidth: 3000000 };
    player.play(0);
    expect(options().qualityRule()).toEqual({ kind: 'max', height: 1080 });
    player.play(1);
    expect(options().qualityRule()).toEqual({ kind: 'tier', height: 720, bandwidth: 3000000 });
  });

  it('offers the menu once the stream names two or more variants', () => {
    player.play(0);
    expect(player.getQualityMenu()).toBeNull();
    deliver(TIERS.slice(0, 1));
    expect(player.getQualityMenu()).toBeNull();
    store.picks[channelKey(channels[0])] = { height: 720, bandwidth: 3000000 };
    deliver(TIERS);
    expect(player.getQualityMenu()).toEqual({
      setting: 'auto', override: { height: 720, bandwidth: 3000000 }, tiers: TIERS, pinned: 1,
    });
  });

  it('keeps the Lowest setting on the Default row rather than pinning its variant', () => {
    store.setting = 'lowest';
    player.play(0);
    deliver(TIERS);
    expect(player.getQualityMenu()).toMatchObject({ setting: 'lowest', override: null, pinned: -1 });
  });

  it('unloads a source still waiting on its master when the app is hidden', () => {
    player.play(0);
    pipeline.isSourcePending.mockReturnValue(true);
    pipeline.destroy.mockClear();

    player.suspend();

    expect(pipeline.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the menu row through the reload a pick starts', () => {
    player.play(0);
    deliver(TIERS);
    player.setQualityOverride({ height: 720, bandwidth: 3000000 });
    expect(pipeline.load).toHaveBeenCalledTimes(2);
    expect(player.getQualityMenu()?.tiers).toEqual(TIERS);
  });

  it('does not reload when a pick leaves the same rule', () => {
    player.play(0);
    player.setQualityOverride('auto');
    expect(pipeline.load).toHaveBeenCalledTimes(1);
    player.setQualityOverride(null);
    expect(pipeline.load).toHaveBeenCalledTimes(1);
    expect(store.picks[channelKey(channels[0])]).toBeUndefined();
  });

  it('tells the menu when the desktop library names its variants', () => {
    player.play(0);
    onPlaybackStateChanged.mockClear();
    options().onEngineQualityTiers?.();
    expect(onPlaybackStateChanged).toHaveBeenCalledOnce();
  });

  it('tells the menu when the stream\'s variants arrive', () => {
    player.play(0);
    onPlaybackStateChanged.mockClear();
    deliver(TIERS);
    expect(onPlaybackStateChanged).toHaveBeenCalled();
    onPlaybackStateChanged.mockClear();
    deliver(TIERS);
    expect(onPlaybackStateChanged).not.toHaveBeenCalled();
  });

  it('prefers the desktop library\'s own variants', () => {
    player.play(0);
    pipeline.engineQualityTiers.mockReturnValue(TIERS);
    expect(player.getQualityMenu()?.tiers).toBe(TIERS);
  });

  it('reloads the channel in place for a new pick, and not for the same one', () => {
    player.play(0);
    expect(pipeline.load).toHaveBeenCalledTimes(1);

    player.setQualityOverride({ height: 720, bandwidth: 3000000 });
    expect(store.picks[channelKey(channels[0])]).toEqual({ height: 720, bandwidth: 3000000 });
    expect(pipeline.load).toHaveBeenCalledTimes(2);
    expect(pipeline.load).toHaveBeenLastCalledWith(channels[0].url, null,
      expect.objectContaining({ reload: true }));
    expect(osd.updateMessage).not.toHaveBeenCalled();

    player.setQualityOverride({ height: 720, bandwidth: 3000000 });
    expect(pipeline.load).toHaveBeenCalledTimes(2);

    player.setQualityOverride(null);
    expect(store.picks[channelKey(channels[0])]).toBeUndefined();
    expect(pipeline.load).toHaveBeenCalledTimes(3);
  });

  it('reloads a title at its position with its subtitles', () => {
    player.playVod(movie);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 120 });
    expect(tracks.attachVod).toHaveBeenCalledTimes(1);

    player.setQualityOverride({ height: 720, bandwidth: 3000000 });

    expect(store.picks['vod:a1:vod:m1']).toEqual({ height: 720, bandwidth: 3000000 });
    expect(pipeline.load).toHaveBeenLastCalledWith(movie.url, null, { direct: true });
    expect(tracks.attachVod).toHaveBeenCalledTimes(2);
    expect(tracks.attachVod).toHaveBeenLastCalledWith(movie);
  });
});
