// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, VodPlayback } from '../types';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { StorageService } from '../services/storage-service';
import type { PlayerPipeline } from './player-pipeline';
import { ASS_SUBTITLE_BASE, PlayerTracks } from './player-tracks';

const { subtitleSearchServiceMock } = vi.hoisted(() => {
  let available = false;
  return {
    subtitleSearchServiceMock: {
      isAvailable: () => available,
      preferredLanguage: () => '',
      search: vi.fn(),
      download: vi.fn(async () => ({
        text: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n',
        format: 'srt' as const,
      })),
      setAvailable: (value: boolean) => { available = value; },
    },
  };
});

vi.mock('../services/storage-service', () => ({
  StorageService: {
    getAudioPref: vi.fn(() => null),
    setAudioPref: vi.fn(),
    getSubtitlePref: vi.fn(() => null),
    setSubtitlePref: vi.fn(),
    getSubtitleOffset: vi.fn(() => 0),
    setSubtitleOffset: vi.fn(),
    getPickedOnlineSub: vi.fn(() => null),
    setPickedOnlineSub: vi.fn(),
    getOnlineSubtitleConfig: vi.fn(() => ({
      preferredLanguage: '',
      subdl: { apiKey: '' },
      assrt: { apiKey: '' },
      opensubtitles: {
        apiKey: '',
        username: '',
        password: '',
        token: '',
        tokenTs: 0,
      },
    })),
  },
}));

vi.mock('./toast', () => ({ showToast: vi.fn() }));
vi.mock('../services/subtitle-search/subtitle-search-service', () => ({
  subtitleSearchService: subtitleSearchServiceMock,
}));
vi.mock('../services/idb-cache', () => ({
  getCachedSubtitle: vi.fn(),
  setCachedSubtitle: vi.fn(),
}));

import { getCachedSubtitle } from '../services/idb-cache';

const CHANNEL: Channel = {
  id: 'ch1',
  name: 'Alpha',
  logo: '',
  group: 'Group 1',
  url: 'http://host/a',
  extras: null,
  playlistIds: [],
  catchup: '',
  catchupSource: '',
  catchupDays: 0,
};

function pipeline(overrides: Partial<PlayerPipeline> = {}): PlayerPipeline {
  return {
    isHlsActive: () => false,
    hlsAudioOptions: () => [],
    setHlsAudioTrack: () => false,
    hlsSubtitleOptions: () => [],
    setHlsSubtitleTrack: () => false,
    ...overrides,
  } as PlayerPipeline;
}

function audioTrack(enabled: boolean, label: string, language: string) {
  return { enabled, label, language };
}

function textTrack(mode: TextTrackMode, label: string, language = '') {
  return { kind: 'subtitles', label, language, mode };
}

function vodRequest(overrides: Partial<VodPlayback> = {}): VodPlayback {
  return {
    accountId: 'x1',
    itemId: '10',
    kind: 'vod',
    title: 'Video 1',
    poster: '',
    url: 'http://host/v',
    resumeSecs: 0,
    subtitles: [],
    onBack: vi.fn(),
    ...overrides,
  };
}

function trackInternals(instance: PlayerTracks): Record<string, unknown> {
  return instance as unknown as Record<string, unknown>;
}

describe('PlayerTracks', () => {
  let video: HTMLVideoElement;
  let channel: Channel | null;
  let vod: VodPlayback | null;
  let tracks: PlayerTracks;

  beforeEach(() => {
    vi.clearAllMocks();
    subtitleSearchServiceMock.setAvailable(false);
    vi.mocked(StorageService.getAudioPref).mockReturnValue(null);
    vi.mocked(StorageService.getSubtitlePref).mockReturnValue(null);
    vi.mocked(StorageService.getSubtitleOffset).mockReturnValue(0);
    vi.mocked(StorageService.getPickedOnlineSub).mockReturnValue(null);
    channel = CHANNEL;
    vod = null;
    video = {
      audioTracks: undefined,
      textTracks: [] as unknown as TextTrackList,
    } as unknown as HTMLVideoElement;
    tracks = new PlayerTracks(pipeline(), {
      getVideoElement: () => video,
      getChannel: () => channel,
      getVod: () => vod,
    });
  });

  // Native path with a collapsed manifest: 3 declared renditions but the TV
  // exposes only 2 tracks (two share a language). The manifest non-conformantly
  // tags two renditions DEFAULT=YES; the picker must still check exactly one row
  // — the track actually enabled — not every manifest default.
  it('checks only the playing track, not every manifest DEFAULT', () => {
    video = {
      audioTracks: {
        length: 2,
        0: audioTrack(true, '', 'l1'),
        1: audioTrack(false, '', 'l2'),
      },
    } as unknown as HTMLVideoElement;
    (tracks as unknown as { manifestAudio: unknown[] }).manifestAudio = [
      { name: 'Track 1', lang: 'l1', isDefault: true },
      { name: 'Track 2', lang: 'l2', isDefault: true },
      { name: 'Track 3', lang: 'l1', isDefault: false },
    ];

    const options = tracks.getAudioTracks();
    expect(options.map((item) => item.active)).toEqual([true, false, false]);
    expect(options[2].available).toBe(false); // collapsed alternate grayed out
  });

  it('switches a native audio track and persists the live preference keys', () => {
    const audio = [
      audioTrack(true, 'Track 1', 'l1'),
      audioTrack(false, 'Track 2', 'l2'),
    ];
    video = { audioTracks: audio } as unknown as HTMLVideoElement;

    tracks.selectAudioTrack(1);

    expect(audio.map(item => item.enabled)).toEqual([false, true]);
    expect(StorageService.setAudioPref).toHaveBeenCalledWith(
      channelKey(CHANNEL),
      { name: 'Track 2', lang: 'l2' },
    );
    tracks.applyNativeAudioSelection();
    expect(StorageService.getAudioPref).toHaveBeenCalledWith(
      channelKey(CHANNEL),
      legacyChannelKey(CHANNEL),
    );
  });

  it('self-renders a forced live subtitle from the manifest', () => {
    const subs = {
      start: vi.fn(),
      stop: vi.fn(),
      setOffset: vi.fn(),
      owns: vi.fn(() => false),
    };
    (tracks as unknown as { subs: unknown }).subs = subs;

    tracks.applyManifest({
      audio: [],
      subtitles: [
        { name: 'Track 1', lang: 'l1', isDefault: true, isForced: false },
        { name: 'Track 2', lang: 'l2', isDefault: false, isForced: true },
      ],
      closedCaptions: [],
      variants: [],
      masterUrl: 'http://host/master.m3u8',
    });

    expect(subs.start).toHaveBeenCalledWith(
      video,
      'http://host/master.m3u8',
      { name: 'Track 2', lang: 'l2' },
    );
    expect(tracks.getSubtitleTracks().map(item => item.active))
      .toEqual([false, true]);
  });

  it('switches between native and ASS VOD subtitles', () => {
    subtitleSearchServiceMock.setAvailable(true);
    const native = textTrack('showing', 'Track 1');
    video = { textTracks: [native] } as unknown as HTMLVideoElement;
    vod = {
      accountId: 'x1',
      itemId: '10',
      kind: 'vod',
      title: 'Video 1',
      poster: '',
      url: 'http://host/v',
      resumeSecs: 0,
      subtitles: [],
      onBack: vi.fn(),
    };
    const assSubs = { show: vi.fn(), hide: vi.fn(), setOffset: vi.fn() };
    const internals = tracks as unknown as {
      vodAssSidecars: unknown[];
      assSubs: typeof assSubs;
    };
    internals.vodAssSidecars = [
      { id: 's1', name: 'Track 2', lang: 'l2', url: 'http://host/a.ass' },
    ];
    internals.assSubs = assSubs;

    expect(tracks.getSubtitleTracks().map(item => item.index))
      .toEqual([0, ASS_SUBTITLE_BASE, -3]);
    tracks.selectSubtitleTrack(ASS_SUBTITLE_BASE);
    expect(native.mode).toBe('disabled');
    expect(assSubs.show).toHaveBeenCalledWith(0);

    tracks.selectSubtitleTrack(0);
    expect(native.mode).toBe('showing');
    expect(assSubs.hide).toHaveBeenCalled();
  });

  describe('subtitle self-render (webOS native path)', () => {
    // In-manifest WebVTT is self-rendered on the native path. Inject a fake
    // controller so we can assert what gets rendered without real fetches, and
    // drive the native branch with a controlled non-HLS PlayerPipeline.
    let subs: {
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      active: boolean;
      setOffset: ReturnType<typeof vi.fn>;
      owns: ReturnType<typeof vi.fn>;
    };

    const rendition = (
      name: string,
      lang: string,
      over: { isDefault?: boolean; isForced?: boolean } = {},
    ) => ({
      name,
      lang,
      isDefault: !!over.isDefault,
      isForced: !!over.isForced,
    });

    const setup = (manifestSubtitles: unknown[], selfRenderIndex = -1) => {
      subs = {
        start: vi.fn(),
        stop: vi.fn(),
        active: false,
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      video = { textTracks: { length: 0 } } as unknown as HTMLVideoElement;
      channel = CHANNEL;
      vod = null;
      const internals = trackInternals(tracks);
      internals.subs = subs;
      internals.manifestSubtitles = manifestSubtitles;
      internals.masterUrl = 'http://host/master.m3u8';
      internals.selfRenderIndex = selfRenderIndex;
    };
    const applySelfRender = () => (
      tracks as unknown as { applySelfRenderSelection(): void }
    ).applySelfRenderSelection();

    it('does not self-render a DEFAULT-only rendition on tune-in (off unless forced)', () => {
      setup([rendition('Track 1', 'l1', { isDefault: true })]);
      applySelfRender();
      expect(subs.start).not.toHaveBeenCalled();
    });

    it('auto-self-renders a FORCED rendition on tune-in', () => {
      setup([
        rendition('Track 1', 'l1', { isDefault: true }),
        rendition('Track 2', 'l2', { isForced: true }),
      ]);
      applySelfRender();
      expect(subs.start).toHaveBeenCalledWith(
        video,
        'http://host/master.m3u8',
        { name: 'Track 2', lang: 'l2' },
      );
    });

    it('re-applies a saved subtitle pick on tune-in', () => {
      setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: false,
        name: 'Track 2',
        lang: 'l2',
      });
      applySelfRender();
      expect(subs.start).toHaveBeenCalledWith(
        video,
        expect.any(String),
        { name: 'Track 2', lang: 'l2' },
      );
    });

    it('stays off when the saved pref is an explicit off (survives re-tune)', () => {
      setup([rendition('Track 1', 'l1', { isDefault: true })]);
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: true,
        name: '',
        lang: '',
      });
      applySelfRender();
      expect(subs.start).not.toHaveBeenCalled();
    });

    it('selecting a subtitle self-renders it and remembers the pick', () => {
      setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
      tracks.selectSubtitleTrack(1);
      expect(subs.start).toHaveBeenCalledWith(
        video,
        'http://host/master.m3u8',
        { name: 'Track 2', lang: 'l2' },
      );
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        channelKey(CHANNEL),
        { off: false, name: 'Track 2', lang: 'l2' },
      );
    });

    it('selecting Off stops self-render and remembers off', () => {
      setup([rendition('Track 1', 'l1')], 0);
      tracks.selectSubtitleTrack(-1);
      expect(subs.stop).toHaveBeenCalled();
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        channelKey(CHANNEL),
        { off: true, name: '', lang: '' },
      );
    });

    it('lists the manifest renditions with the self-rendered one active and all selectable', () => {
      setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')], 1);
      const options = tracks.getSubtitleTracks();
      expect(options.map((item) => item.label)).toEqual(['Track 1', 'Track 2']);
      expect(options.map((item) => item.active)).toEqual([false, true]);
      expect(options.every((item) => item.available)).toBe(true);
    });
  });

  describe('VOD audio/subtitle track selection (native, in-container)', () => {
    // Plain arrays satisfy the length + indexed reads/writes PlayerTracks does on
    // audioTracks / textTracks, so they stand in for the native track lists.
    const nativeAudioTrack = (
      enabled: boolean,
      over: { label?: string; language?: string } = {},
    ) => ({
      label: over.label ?? '',
      language: over.language ?? '',
      enabled,
    });
    const nativeTextTrack = (
      mode: TextTrackMode,
      over: { kind?: string; label?: string; language?: string } = {},
    ) => ({
      kind: over.kind ?? 'subtitles',
      label: over.label ?? '',
      language: over.language ?? '',
      mode,
    });

    const setup = (opts: { audio?: unknown[]; text?: unknown[] } = {}) => {
      vod = {
        accountId: 'x1',
        itemId: '10',
        kind: 'vod',
        title: 'Video 1',
        poster: '',
        url: 'http://host/movie.mkv',
        resumeSecs: 0,
        subtitles: [],
        onBack: vi.fn(),
      };
      channel = null;
      video = {
        audioTracks: opts.audio,
        textTracks: opts.text,
      } as unknown as HTMLVideoElement;
    };

    it('lists subtitle tracks from the native textTracks with the showing one active', () => {
      setup({ text: [
        nativeTextTrack('disabled', { label: 'Track 1', language: 'l1' }),
        nativeTextTrack('showing', { label: 'Track 2', language: 'l2' }),
      ] });
      const options = tracks.getSubtitleTracks();
      expect(options.map((item) => item.label)).toEqual(['Track 1', 'Track 2']);
      expect(options.map((item) => item.active)).toEqual([false, true]);
      expect(options.every((item) => item.available)).toBe(true);
    });

    it('selecting a subtitle shows that textTrack, disables the others, and remembers it', () => {
      const text = [
        nativeTextTrack('disabled', { label: 'Track 1' }),
        nativeTextTrack('disabled', { label: 'Track 2' }),
      ];
      setup({ text });
      tracks.selectSubtitleTrack(1);
      expect(text.map((item) => item.mode)).toEqual(['disabled', 'showing']);
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        'vod:x1:vod:10',
        { off: false, name: 'Track 2', lang: '' },
      );
    });

    it('selecting Off disables every native textTrack and remembers off', () => {
      const text = [
        nativeTextTrack('showing', { label: 'Track 1' }),
        nativeTextTrack('disabled', { label: 'Track 2' }),
      ];
      setup({ text });
      tracks.selectSubtitleTrack(-1);
      expect(text.map((item) => item.mode)).toEqual(['disabled', 'disabled']);
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        'vod:x1:vod:10',
        { off: true, name: '', lang: '' },
      );
    });

    it('lazily loads a sidecar track when it is shown', () => {
      const text = [nativeTextTrack('disabled', { label: 'Track 1' })];
      setup({ text });
      const vodSubs = {
        attach: vi.fn(),
        ensureLoaded: vi.fn(),
        clear: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      trackInternals(tracks).vodSubs = vodSubs;
      tracks.selectSubtitleTrack(0);
      expect(text[0].mode).toBe('showing');
      expect(vodSubs.ensureLoaded).toHaveBeenCalledWith(text[0]);
    });

    it('does not load anything when subtitles are turned off', () => {
      const text = [nativeTextTrack('showing', { label: 'Track 1' })];
      setup({ text });
      const vodSubs = {
        attach: vi.fn(),
        ensureLoaded: vi.fn(),
        clear: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      trackInternals(tracks).vodSubs = vodSubs;
      tracks.selectSubtitleTrack(-1);
      expect(vodSubs.ensureLoaded).not.toHaveBeenCalled();
    });

    it('re-applies a saved subtitle pick when tracks arrive', () => {
      const text = [
        nativeTextTrack('disabled', { label: 'Track 1', language: 'l1' }),
        nativeTextTrack('disabled', { label: 'Track 2', language: 'l2' }),
      ];
      setup({ text });
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: false,
        name: 'Track 2',
        lang: 'l2',
      });
      tracks.applyNativeSubtitleSelection();
      expect(text.map((item) => item.mode)).toEqual(['disabled', 'showing']);
    });

    it('leaves subtitles off by default when there is no saved pick', () => {
      const text = [
        nativeTextTrack('showing', { label: 'Track 1' }), // pipeline auto-enabled one
      ];
      setup({ text });
      tracks.applyNativeSubtitleSelection();
      expect(text.map((item) => item.mode)).toEqual(['disabled']);
    });

    it('remembers the audio pick under the VOD key and switches the native track', () => {
      const audio = [
        nativeAudioTrack(true, { label: 'Track 1', language: 'l1' }),
        nativeAudioTrack(false, { label: 'Track 2', language: 'l2' }),
      ];
      setup({ audio });
      tracks.selectAudioTrack(1);
      expect(audio.map((item) => item.enabled)).toEqual([false, true]);
      expect(StorageService.setAudioPref).toHaveBeenCalledWith(
        'vod:x1:vod:10',
        { name: 'Track 2', lang: 'l2' },
      );
    });

    it('re-applies the saved audio pick when tracks arrive', () => {
      const audio = [
        nativeAudioTrack(true, { label: 'Track 1', language: 'l1' }),
        nativeAudioTrack(false, { label: 'Track 2', language: 'l2' }),
      ];
      setup({ audio });
      vi.mocked(StorageService.getAudioPref).mockReturnValue({
        name: 'Track 2',
        lang: 'l2',
      });
      tracks.applyNativeAudioSelection();
      expect(audio.map((item) => item.enabled)).toEqual([false, true]);
    });

    it('reads live preferences with current and legacy channel keys', () => {
      const audio = [
        nativeAudioTrack(true, { label: 'Track 1', language: 'l1' }),
        nativeAudioTrack(false, { label: 'Track 2', language: 'l2' }),
      ];
      setup({ audio });
      const live = { ...CHANNEL, url: 'http://host/play?stid=1&key=A' };
      vod = null;
      channel = live;

      tracks.applyNativeAudioSelection();

      expect(StorageService.getAudioPref)
        .toHaveBeenCalledWith(channelKey(live), legacyChannelKey(live));
    });

    it('reports the offset row available and clamps/persists/shifts on setSubtitleOffset', () => {
      const cue = { startTime: 5, endTime: 7 };
      const text = [
        nativeTextTrack('showing', { label: 'Track 1' }),
      ] as Array<Record<string, unknown>>;
      text[0].cues = [cue];
      setup({ text });
      expect(tracks.subtitleOffsetState()).toEqual({
        available: true,
        label: '0.00 s',
      });
      tracks.setSubtitleOffset(0.3); // clamps to 0.25
      expect(StorageService.setSubtitleOffset)
        .toHaveBeenCalledWith('vod:x1:vod:10', 0.25);
      expect(cue).toEqual({ startTime: 5.25, endTime: 7.25 });
      expect(tracks.subtitleOffsetState().label).toBe('+0.25 s');
    });

    it('reports the offset row unavailable when no subtitle is showing', () => {
      setup({ text: [nativeTextTrack('disabled', { label: 'Track 1' })] });
      expect(tracks.subtitleOffsetState().available).toBe(false);
    });
  });

  describe('VOD ASS sidecar subtitles', () => {
    // ASS/SSA sidecars can't render as native <track>s, so they join the one
    // picker as synthetic options at ASS_SUBTITLE_BASE + i and route to a fake
    // assjs overlay controller. Native textTracks (in-container / SRT/WebVTT) are
    // plain arrays as in the in-container suite above.
    const nativeTextTrack = (
      mode: TextTrackMode,
      over: { kind?: string; label?: string; language?: string } = {},
    ) => ({
      kind: over.kind ?? 'subtitles',
      label: over.label ?? '',
      language: over.language ?? '',
      mode,
    });
    const assSidecar = (
      over: { id?: string; name?: string; lang?: string; url?: string } = {},
    ) => ({
      id: over.id ?? '1',
      name: over.name ?? 'ASS 1',
      lang: over.lang ?? 'l1',
      url: over.url ?? 'http://host/a.ass',
    });

    let assSubs: {
      attach: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      hide: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      setOffset: ReturnType<typeof vi.fn>;
    };
    const setup = (opts: { text?: unknown[]; ass?: unknown[] } = {}) => {
      assSubs = {
        attach: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        destroy: vi.fn(),
        setOffset: vi.fn(),
      };
      vod = {
        accountId: 'x1',
        itemId: '10',
        kind: 'vod',
        title: 'Video 1',
        poster: '',
        url: 'http://host/movie.mkv',
        resumeSecs: 0,
        subtitles: [],
        onBack: vi.fn(),
      };
      channel = null;
      video = {
        textTracks: opts.text ?? [],
      } as unknown as HTMLVideoElement;
      const internals = trackInternals(tracks);
      internals.vodAssSidecars = opts.ass ?? [];
      internals.assSubs = assSubs;
      internals.activeAssIndex = -1;
    };

    it('lists ASS sidecars in the picker after the native tracks', () => {
      setup({
        text: [nativeTextTrack('disabled', { label: 'Track 1' })],
        ass: [assSidecar({ name: 'ASS 1' })],
      });
      const options = tracks.getSubtitleTracks();
      expect(options.map((item) => item.label)).toEqual(['Track 1', 'ASS 1']);
      expect(options.map((item) => item.index)).toEqual([0, ASS_SUBTITLE_BASE]);
      expect(options.every((item) => item.available)).toBe(true);
    });

    it('selecting an ASS sidecar shows it, disables native tracks, and remembers the pick', () => {
      const text = [nativeTextTrack('showing', { label: 'Track 1' })];
      const ass = [assSidecar({ name: 'ASS 1', lang: 'l1' })];
      setup({ text, ass });
      tracks.selectSubtitleTrack(ASS_SUBTITLE_BASE);
      expect(assSubs.show).toHaveBeenCalledWith(0);
      expect(text[0].mode).toBe('disabled');
      expect(assSubs.hide).not.toHaveBeenCalled();
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        'vod:x1:vod:10',
        { off: false, name: 'ASS 1', lang: 'l1' },
      );
    });

    it('marks the shown ASS sidecar active in the picker', () => {
      setup({ text: [], ass: [assSidecar({ name: 'ASS 1' })] });
      tracks.selectSubtitleTrack(ASS_SUBTITLE_BASE);
      const option = tracks.getSubtitleTracks()
        .find((item) => item.index === ASS_SUBTITLE_BASE);
      expect(option?.active).toBe(true);
    });

    it('selecting a native track hides the ASS overlay', () => {
      const text = [nativeTextTrack('disabled', { label: 'Track 1' })];
      setup({ text, ass: [assSidecar()] });
      tracks.selectSubtitleTrack(0);
      expect(assSubs.hide).toHaveBeenCalled();
      expect(assSubs.show).not.toHaveBeenCalled();
      expect(text[0].mode).toBe('showing');
    });

    it('selecting Off hides the ASS overlay', () => {
      setup({ text: [], ass: [assSidecar()] });
      tracks.selectSubtitleTrack(-1);
      expect(assSubs.hide).toHaveBeenCalled();
    });

    it('re-applies a saved ASS pick when tracks arrive', () => {
      const ass = [assSidecar({ name: 'ASS 1', lang: 'l1' })];
      setup({ text: [], ass });
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: false,
        name: 'ASS 1',
        lang: 'l1',
      });
      tracks.applyNativeSubtitleSelection();
      expect(assSubs.show).toHaveBeenCalledWith(0);
    });

    it('exposes an ASS sidecar as a selectable picker option at base + 0', () => {
      setup({
        ass: [{
          id: 'ass1',
          name: 'Track 1',
          lang: 'l1',
          url: 'http://host/a.ass',
          text: '',
        }],
      });
      expect(tracks.getSubtitleTracks()
        .some((item) => item.index === ASS_SUBTITLE_BASE)).toBe(true);
    });

    it('closeSubtitleSearch dismisses an open overlay (called on every view change)', async () => {
      subtitleSearchServiceMock.setAvailable(true);
      const host = document.createElement('div');
      host.id = 'subtitle-search';
      document.body.appendChild(host);
      vod = {
        accountId: 'a',
        kind: 'movie',
        itemId: 'm1',
        title: 'Video 1',
        url: 'http://host/m',
        poster: '',
        resumeSecs: 0,
        onBack: vi.fn(),
        extras: {},
        searchMeta: {},
        subtitles: [],
      };
      subtitleSearchServiceMock.search.mockResolvedValueOnce([{
        providerId: 'subdl',
        id: '1',
        language: 'l1',
        releaseName: 'Track 1',
        fileName: 'a.srt',
        format: 'srt',
        hearingImpaired: false,
        downloads: 0,
      }]);

      await (
        tracks as unknown as {
          runSubtitleSearch(query: string | null): Promise<void>;
        }
      ).runSubtitleSearch(null);
      const overlay = trackInternals(tracks).subsOverlay as { visible: boolean };
      expect(overlay.visible).toBe(true);
      tracks.closeSubtitleSearch();
      expect(overlay.visible).toBe(false);
      expect(host.classList.contains('hidden')).toBe(true);
      host.remove();
    });

    it('runs a manual query that overrides the structured search keys', async () => {
      subtitleSearchServiceMock.setAvailable(true);
      const host = document.createElement('div');
      host.id = 'subtitle-search';
      document.body.appendChild(host);
      subtitleSearchServiceMock.search.mockResolvedValueOnce([]);
      vod = {
        accountId: 'a',
        kind: 'movie',
        itemId: 'm1',
        title: 'Video 1',
        url: 'http://host/m',
        poster: '',
        resumeSecs: 0,
        onBack: vi.fn(),
        extras: {},
        searchMeta: { imdbId: '123', year: 2020 },
        subtitles: [],
      };

      await (
        tracks as unknown as {
          runSubtitleSearch(query: string | null): Promise<void>;
        }
      ).runSubtitleSearch('Manual Query');
      expect(subtitleSearchServiceMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ manualQuery: 'Manual Query' }),
      );
      host.remove();
    });

    it('applies an online SRT result as a shown text track', async () => {
      subtitleSearchServiceMock.setAvailable(true);
      vod = {
        accountId: 'a',
        kind: 'movie',
        itemId: 'm1',
        title: 'Video 1',
        url: 'http://host/m',
        poster: '',
        resumeSecs: 0,
        onBack: vi.fn(),
        extras: {},
        searchMeta: {},
        subtitles: [],
      };
      const textTracks: unknown[] = [];
      video = { textTracks } as unknown as HTMLVideoElement;
      const vodSubs = {
        addOnline: vi.fn((_: unknown, sub: { name: string; lang: string }) => {
          const track = {
            mode: 'showing' as TextTrackMode,
            kind: 'subtitles',
            label: sub.name,
            language: sub.lang,
          };
          textTracks.push(track);
          return track;
        }),
        ensureLoaded: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      trackInternals(tracks).vodSubs = vodSubs;

      await (
        tracks as unknown as {
          applyOnlineSubtitle(result: unknown): Promise<void>;
        }
      ).applyOnlineSubtitle({
        providerId: 'subdl',
        id: '1',
        language: 'l1',
        releaseName: 'Track 1',
        fileName: 'a.srt',
        format: 'srt',
        hearingImpaired: false,
        downloads: 0,
      });
      expect(tracks.getSubtitleTracks().some((item) => item.active)).toBe(true);
      // The full happy path ran (not the catch): the pick was persisted.
      expect(StorageService.setPickedOnlineSub).toHaveBeenCalled();
    });

    it('does not apply or persist an online result when the VOD changed mid-download', async () => {
      subtitleSearchServiceMock.setAvailable(true);
      const firstVod = vodRequest({
        accountId: 'a',
        kind: 'movie',
        itemId: 'm1',
        title: 'Video 1',
        url: 'http://host/m1',
      });
      vod = firstVod;
      video = { textTracks: [] } as unknown as HTMLVideoElement;
      const addOnline = vi.fn();
      trackInternals(tracks).vodSubs = {
        addOnline,
        ensureLoaded: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      let resolveDownload: (value: { text: string; format: 'srt' }) => void =
        () => {};
      subtitleSearchServiceMock.download.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveDownload = resolve as typeof resolveDownload;
        }));
      const done = (
        tracks as unknown as {
          applyOnlineSubtitle(result: unknown): Promise<void>;
        }
      ).applyOnlineSubtitle({
        providerId: 'subdl',
        id: '1',
        language: 'l1',
        releaseName: 'Track 1',
        fileName: 'a.srt',
        format: 'srt',
        hearingImpaired: false,
        downloads: 0,
      });
      vod = { ...firstVod, itemId: 'm2', title: 'Video 2' };
      // user switched items before the download resolved
      resolveDownload({ text: 'WEBVTT\n\nx', format: 'srt' });
      await done;
      expect(addOnline).not.toHaveBeenCalled();
      expect(StorageService.setPickedOnlineSub).not.toHaveBeenCalled();
    });

    it('restores a remembered online subtitle from the idb cache without downloading', async () => {
      const activeVod = vodRequest({
        title: 'Video 1',
        url: 'http://host/vod.mp4',
      });
      vod = activeVod;
      const textTracks: unknown[] = [];
      video = { textTracks } as unknown as HTMLVideoElement;
      const addOnline = vi.fn((_: unknown, sub: { name: string; lang: string }) => {
        const track = {
          mode: 'disabled' as TextTrackMode,
          kind: 'subtitles',
          label: sub.name,
          language: sub.lang,
        };
        textTracks.push(track);
        return track;
      });
      trackInternals(tracks).vodSubs = {
        addOnline,
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
      };
      // Seed the pick + cache-hit for exactly this restore; `Once` + reset
      // keeps these mocks from leaking into later VOD tests. Clear `download`'s
      // history because a prior test in this file exercised it.
      subtitleSearchServiceMock.download.mockClear();
      vi.mocked(StorageService.getPickedOnlineSub).mockReturnValueOnce({
        providerId: 'subdl',
        id: '9',
        name: 'Track 1',
        lang: 'l1',
        format: 'srt',
      });
      vi.mocked(getCachedSubtitle).mockResolvedValueOnce(
        'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhi\n',
      );

      await (
        tracks as unknown as {
          restoreOnlineSubtitle(active: VodPlayback): Promise<void>;
        }
      ).restoreOnlineSubtitle(activeVod);
      expect(getCachedSubtitle).toHaveBeenCalledWith('subdl:9');
      expect(subtitleSearchServiceMock.download).not.toHaveBeenCalled();
      expect(addOnline).toHaveBeenCalled();
    });
  });

  describe('VOD attachment lifecycle', () => {
    it('attaches the sidecar subtitle tracks', () => {
      const vodSubs = { attach: vi.fn() };
      trackInternals(tracks).vodSubs = vodSubs;
      const subtitles = [{
        id: '1',
        name: 'Track 1',
        lang: 'l1',
        url: 'http://host/a.srt',
      }];
      const request = vodRequest({ subtitles });
      vod = request;

      tracks.attachVod(request);

      expect(vodSubs.attach).toHaveBeenCalledWith(video, subtitles);
    });

    it('splits sidecars: SRT/WebVTT to vodSubs, ASS to assSubs', () => {
      const vodSubs = { attach: vi.fn() };
      const assSubs = { attach: vi.fn() };
      const internals = trackInternals(tracks);
      internals.vodSubs = vodSubs;
      internals.assSubs = assSubs;
      const srt = {
        id: '1',
        name: 'Track 1',
        lang: 'l1',
        url: 'http://host/a.srt',
      };
      const ass = {
        id: '2',
        name: 'Track 2',
        lang: 'l2',
        url: 'http://host/b.ass',
      };
      const request = vodRequest({ subtitles: [srt, ass] });
      vod = request;

      tracks.attachVod(request);

      expect(vodSubs.attach).toHaveBeenCalledWith(video, [srt]);
      expect(assSubs.attach).toHaveBeenCalledWith(
        video,
        expect.anything(),
        [ass],
      );
    });

    it('tears down the ASS overlay on stop', () => {
      const assSubs = { destroy: vi.fn() };
      trackInternals(tracks).assSubs = assSubs;

      tracks.stop();

      expect(assSubs.destroy).toHaveBeenCalled();
    });
  });

  it('owns track-engine reset, suspend, and stop lifecycle', () => {
    const subs = { stop: vi.fn() };
    const vodSubs = { clear: vi.fn() };
    const assSubs = { destroy: vi.fn() };
    const internals = tracks as unknown as {
      subs: typeof subs;
      vodSubs: typeof vodSubs;
      assSubs: typeof assSubs;
      vodAssSidecars: unknown[];
      activeAssIndex: number;
    };
    internals.subs = subs;
    internals.vodSubs = vodSubs;
    internals.assSubs = assSubs;
    internals.vodAssSidecars = [{}];
    internals.activeAssIndex = 0;

    tracks.resetForLoad();
    tracks.suspend();
    tracks.stop();

    expect(subs.stop).toHaveBeenCalledTimes(3);
    expect(vodSubs.clear).toHaveBeenCalledOnce();
    expect(assSubs.destroy).toHaveBeenCalledOnce();
    expect(internals.vodAssSidecars).toEqual([]);
    expect(internals.activeAssIndex).toBe(-1);
  });
});
