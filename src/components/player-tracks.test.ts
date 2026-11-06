// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, VodPlayback } from '../types';
import { channelKey, legacyChannelKey } from '../utils/channel';
import { StorageService } from '../services/storage-service';
import type { PlayerPipeline } from './player-pipeline';
import {
  ASS_SUBTITLE_BASE,
  PlayerTracks,
  VOD_SUBTITLE_BASE,
} from './player-tracks';

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

import { Focus } from '../navigation/focus-scope';
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
    isMseActive: () => false,
    mseAudioOptions: () => [],
    setMseAudioTrack: () => false,
    mseSubtitleOptions: () => [],
    setMseSubtitleTrack: () => false,
    lunaClock: () => null,
    isLunaActive: () => false,
    lunaAudioTracks: () => [],
    selectLunaAudio: () => Promise.resolve(false),
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

afterEach(() => {
  Focus.uninstall();
});

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
      playbackLabel: () => 'session=1 load=7',
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
      { masterText: undefined },
    );
    expect(tracks.getSubtitleTracks().map(item => item.active))
      .toEqual([false, true]);
  });

  describe('subtitles from a manifest only the bundled service could read', () => {
    const MASTER = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 1",LANGUAGE="l1",URI="s.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"',
      'v.m3u8',
    ].join('\n');
    const MPD = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
      <Period><AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <BaseURL>sub.vtt</BaseURL><Representation id="s1"/>
      </AdaptationSet></Period></MPD>`;
    let fetched: string[];

    beforeEach(() => {
      fetched = [];
      // The page is refused everything but the subtitle files themselves.
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        fetched.push(url);
        if (url.endsWith('/b/s.m3u8')) {
          return { ok: true, status: 200, url, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' };
        }
        if (url.endsWith('/b/sub.vtt')) return { ok: true, status: 200, url, text: async () => 'WEBVTT\n' };
        return { ok: false, status: 403, url, text: async () => '' };
      }));
      vi.stubGlobal('VTTCue', class {});
      video = {
        currentTime: 0,
        seekable: { length: 0 },
        textTracks: { length: 0 },
        addTextTrack: () => ({ mode: 'disabled', cues: [], addCue: () => {}, removeCue: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as HTMLVideoElement;
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => () => 42, isLunaActive: () => true });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      tracks.resetForLoad();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('starts an HLS pick from the service text without reading the master again', async () => {
      tracks.applyManifest({
        audio: [],
        subtitles: [{ name: 'Track 1', lang: 'l1', isDefault: false, isForced: false }],
        closedCaptions: [],
        variants: [],
        masterUrl: 'http://host/b/a.m3u8',
        masterText: MASTER,
      });

      tracks.selectSubtitleTrack(0);

      await vi.waitFor(() => expect(fetched).toContain('http://host/b/s.m3u8'));
      expect(fetched).not.toContain('http://host/b/a.m3u8');
      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: true, available: true })]);
    });

    it('starts a DASH pick from the service text without reading the MPD again', async () => {
      tracks.applyManifest({
        audio: [],
        subtitles: [{
          name: 'Track 1', lang: 'l1', isDefault: false, isForced: false,
          dash: { kind: 'webvtt', url: 'http://host/b/sub.vtt' },
        }],
        closedCaptions: [],
        variants: [],
        masterUrl: 'http://host/b/a.mpd',
        masterText: MPD,
      });

      tracks.selectSubtitleTrack(0);

      await vi.waitFor(() => expect(fetched).toContain('http://host/b/sub.vtt'));
      expect(fetched).not.toContain('http://host/b/a.mpd');
    });

    it.each([
      ['Luna', () => () => 42],
      ['the video element', () => null],
    ])('resets a DASH pick on %s to Off when the page is refused its first segment', async (_name, lunaClock) => {
      const lines: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
      trackInternals(tracks).pipeline = pipeline({ lunaClock, isLunaActive: () => lunaClock() !== null });
      const onChanged = vi.fn();
      (trackInternals(tracks).options as { onChanged?: () => void }).onChanged = onChanged;
      tracks.applyManifest({
        audio: [],
        subtitles: [{
          name: 'Track 1', lang: 'l1', isDefault: false, isForced: false,
          dash: { kind: 'webvtt', url: 'http://host/c/sub.vtt' },
        }],
        closedCaptions: [],
        variants: [],
        masterUrl: 'http://host/c/a.mpd',
        masterText: MPD.replace('sub.vtt', 'http://host/c/sub.vtt'),
      });

      tracks.selectSubtitleTrack(0);

      await vi.waitFor(() => expect(tracks.getSubtitleTracks())
        .toEqual([expect.objectContaining({ active: false, available: false })]));
      expect(onChanged).toHaveBeenCalledTimes(1);
      const lunaEvents = lines.filter(line => /event=subtitles\.luna\.(unavailable|reset)/.test(line));
      // The element plays a Luna fallback; it reports nothing as Luna.
      expect(lunaEvents).toEqual(lunaClock() ? [
        expect.stringContaining('event=subtitles.luna.unavailable session=1 load=7 stage=render reason=segment_http_403'),
        expect.stringContaining('event=subtitles.luna.reset session=1 load=7 index=0 reason=segment_http_403'),
      ] : []);
      expect(StorageService.setSubtitlePref).toHaveBeenLastCalledWith(
        channelKey(CHANNEL), { off: false, name: 'Track 1', lang: 'l1' });
      // Stopped: the 2 s refresh never asks again.
      const count = fetched.length;
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(fetched).toHaveLength(count);
    });

    it('keeps polling a DASH pick whose first segment is not found yet', async () => {
      const lines: string[] = [];
      vi.mocked(console.log).mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
      tracks.applyManifest({
        audio: [],
        subtitles: [{
          name: 'Track 1', lang: 'l1', isDefault: false, isForced: false,
          dash: { kind: 'webvtt', url: 'http://host/d/sub.vtt' },
        }],
        closedCaptions: [],
        variants: [],
        masterUrl: 'http://host/d/a.mpd',
        masterText: MPD.replace('sub.vtt', 'http://host/d/sub.vtt'),
      });
      vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
        fetched.push(String(url));
        return { ok: false, status: 404, url, text: async () => '' } as unknown as Response;
      });

      tracks.selectSubtitleTrack(0);

      await vi.waitFor(() => expect(fetched).toContain('http://host/d/sub.vtt'));
      await vi.waitFor(() => expect(fetched.filter(url => url === 'http://host/d/sub.vtt')).toHaveLength(2),
        { timeout: 3000 });
      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: true, available: true })]);
      expect(lines.join('\n')).not.toContain('event=subtitles.luna.reset');
    });
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
      .toEqual([0, ASS_SUBTITLE_BASE]);
    expect(tracks.subtitleSearchAvailable()).toBe(true);
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
    let dashSubs: typeof subs;

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
      dashSubs = {
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
      internals.dashSubs = dashSubs;
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
        { masterText: undefined },
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
        { masterText: undefined },
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
        { masterText: undefined },
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
      expect(dashSubs.stop).toHaveBeenCalled();
      expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
        channelKey(CHANNEL),
        { off: true, name: '', lang: '' },
      );
    });

    it('routes DASH WebVTT to the DASH self-renderer', () => {
      setup([{
        ...rendition('Track 1', 'l1'),
        dash: { kind: 'webvtt', url: 'http://host/sub.vtt' },
      }]);
      trackInternals(tracks).masterUrl = 'http://host/stream.mpd';

      tracks.selectSubtitleTrack(0);

      expect(subs.start).not.toHaveBeenCalled();
      expect(dashSubs.start).toHaveBeenCalledWith(
        video,
        'http://host/stream.mpd',
        { name: 'Track 1', lang: 'l1' },
        undefined,
        undefined,
        undefined,
      );
    });

    it("self-renders DASH WebVTT on Luna's clock and stops it with the path", () => {
      setup([{
        ...rendition('Track 1', 'l1'),
        dash: { kind: 'webvtt', url: 'http://host/sub.vtt' },
      }]);
      trackInternals(tracks).masterUrl = 'http://host/stream.mpd';
      const clock = () => 42;
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => clock });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      tracks.selectSubtitleTrack(0);

      expect(dashSubs.start).toHaveBeenCalledWith(
        video, 'http://host/stream.mpd', { name: 'Track 1', lang: 'l1' }, clock, undefined, expect.any(Function));
      expect(log.mock.calls.map(args => args.join(' '))).toContainEqual(expect.stringContaining(
        'event=subtitles.luna.start session=1 load=7 index=0 count=1 pick=user format=dash'));
      (dashSubs as { active: boolean }).active = true;
      vi.mocked(dashSubs.stop).mockClear();
      tracks.stopSelfRender();
      expect(dashSubs.stop).toHaveBeenCalled();
      log.mockRestore();
    });

    it.each(['stpp', 'wvtt'])(
      'routes DASH %s to the native compositor without self-rendering',
      () => {
      setup([{
        ...rendition('Track 1', 'l1'),
        dash: { kind: 'native' },
      }]);
      const nativeToggle = vi.fn();
      trackInternals(tracks).setNativeCC = nativeToggle;

      tracks.selectSubtitleTrack(0);

      expect(subs.start).not.toHaveBeenCalled();
      expect(dashSubs.start).not.toHaveBeenCalled();
      expect(nativeToggle).toHaveBeenCalledWith(true);
      expect(tracks.getSubtitleTracks()[0].active).toBe(true);
      },
    );

    it('exposes only the first native DASH rendition, which the compositor draws', () => {
      setup([
        {
          ...rendition('Track 1', 'l1'),
          dash: { kind: 'native' },
        },
        {
          ...rendition('Track 2', 'l2', { isDefault: true }),
          dash: { kind: 'native' },
        },
        {
          ...rendition('Track 3', 'l3'),
          dash: { kind: 'webvtt', url: 'http://host/sub.vtt' },
        },
      ]);

      expect(tracks.getSubtitleTracks().map(item => item.label))
        .toEqual(['Track 1', 'Track 3']);
    });

    it('does not restore a hidden native DASH rendition', () => {
      setup([
        {
          ...rendition('Track 1', 'l1', { isDefault: true }),
          dash: { kind: 'native' },
        },
        {
          ...rendition('Track 2', 'l2'),
          dash: { kind: 'native' },
        },
      ]);
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: false,
        name: 'Track 2',
        lang: 'l2',
      });
      const nativeToggle = vi.fn();
      trackInternals(tracks).setNativeCC = nativeToggle;

      applySelfRender();

      expect(nativeToggle).toHaveBeenCalledWith(false);
      expect(trackInternals(tracks).selfRenderIndex).toBe(-1);
    });

    it('does not reselect VOD subtitles when reapplying the native compositor', () => {
      setup([]);
      vod = {
        accountId: 'acc1',
        kind: 'movie',
        itemId: 'item1',
        title: 'Alpha',
        url: 'http://host/a',
        resumeSecs: 0,
        durationSecs: 0,
        subtitles: [],
      };
      const apply = vi.spyOn(
        tracks as unknown as { applyNativeSubtitleSelection(): void },
        'applyNativeSubtitleSelection',
      );

      tracks.reapplyNativeSubtitleCompositor();

      expect(apply).not.toHaveBeenCalled();
    });

    it('retries the native compositor after a Luna failure', () => {
      const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get')
        .mockReturnValue('webOS');
      const requests: Array<{
        respond(response: unknown): void;
      }> = [];
      class FakePalmServiceBridge {
        onservicecallback: ((message: string) => void) | null = null;

        call(): void {
          requests.push({
            respond: (response) => {
              this.onservicecallback?.(JSON.stringify(response));
            },
          });
        }

        cancel(): void {
          this.onservicecallback = null;
        }
      }
      vi.stubGlobal('PalmServiceBridge', FakePalmServiceBridge);
      setup([{
        ...rendition('Track 1', 'l1'),
        dash: { kind: 'native' },
      }]);
      (video as HTMLVideoElement & { mediaId?: string }).mediaId = 'media1';

      tracks.selectSubtitleTrack(0);
      expect(trackInternals(tracks).ccEnabled).toBe(false);
      requests[0].respond({ returnValue: false, errorCode: 1 });
      tracks.reapplyNativeSubtitleCompositor();
      expect(requests).toHaveLength(2);
      requests[1].respond({ returnValue: true });
      expect(trackInternals(tracks).ccEnabled).toBe(true);

      userAgent.mockRestore();
      vi.unstubAllGlobals();
    });

    describe('compositor subtitles on Luna playback', () => {
      let requests: Array<{ uri: string; params: Record<string, unknown>; respond(response: unknown): void }>;
      let lunaMediaId: string;
      let userAgent: { mockRestore(): void };

      beforeEach(() => {
        userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('webOS');
        requests = [];
        class FakePalmServiceBridge {
          onservicecallback: ((message: string) => void) | null = null;

          call(uri: string, payload: string): void {
            requests.push({
              uri,
              params: JSON.parse(payload) as Record<string, unknown>,
              respond: (response) => this.onservicecallback?.(JSON.stringify(response)),
            });
          }

          cancel(): void {
            this.onservicecallback = null;
          }
        }
        vi.stubGlobal('PalmServiceBridge', FakePalmServiceBridge);
        lunaMediaId = '';
      });

      afterEach(() => {
        userAgent.mockRestore();
        vi.unstubAllGlobals();
      });

      const lunaSetup = (manifestSubtitles: unknown[], closedCaptions: unknown[] = []) => {
        setup(manifestSubtitles);
        (video as HTMLVideoElement & { mediaId?: string }).mediaId = 'placeholder1';
        trackInternals(tracks).manifestClosedCaptions = closedCaptions;
        trackInternals(tracks).pipeline = pipeline({
          isLunaActive: () => true,
          lunaClock: () => () => 42,
          lunaMediaId: () => lunaMediaId,
        });
      };

      it("toggles captions on Luna's own pipeline, not the placeholder's", () => {
        lunaSetup([], [{ name: 'CC 1', lang: '', instreamId: 'CC1', isDefault: false }]);

        expect(tracks.getSubtitleTracks()).toEqual([
          expect.objectContaining({ index: -2, label: 'CC 1 [CC]', active: false, available: true }),
        ]);
        // Not loaded yet: nothing goes to the placeholder meanwhile.
        tracks.selectSubtitleTrack(-2);
        expect(requests).toHaveLength(0);
        expect(StorageService.setSubtitlePref).toHaveBeenCalledWith(
          channelKey(CHANNEL), { off: false, cc: true, name: '', lang: '' });
        vi.mocked(StorageService.getSubtitlePref)
          .mockReturnValue({ off: false, cc: true, name: '', lang: '' });

        lunaMediaId = 'luna1';
        tracks.reapplyNativeSubtitleCompositor();
        expect(requests).toEqual([expect.objectContaining({
          uri: 'luna://com.webos.media/setSubtitleEnable',
          params: { mediaId: 'luna1', enable: true },
        })]);
        requests[0].respond({ returnValue: true });
        expect(tracks.getSubtitleTracks()[0].active).toBe(true);

        tracks.selectSubtitleTrack(-1);
        expect(requests[1].params).toEqual({ mediaId: 'luna1', enable: false });
        expect(requests.map(request => request.uri))
          .not.toContain('luna://com.webos.media/selectTrack');
      });

      it('shows a CC pick as on while setSubtitleEnable is pending', () => {
        lunaSetup([], [{ name: 'CC 1', lang: '', instreamId: 'CC1', isDefault: false }]);
        lunaMediaId = 'luna1';

        tracks.selectSubtitleTrack(-2);
        expect(tracks.getSubtitleTracks()[0].active).toBe(true);

        requests[0].respond({ returnValue: false, errorCode: 7 });
        expect(tracks.getSubtitleTracks()[0].active).toBe(false);
      });

      it('lists and enables CEA-708-only captions on Luna', () => {
        lunaSetup([], [{ name: 'Track 1', lang: 'l1', instreamId: 'SERVICE1', isDefault: false }]);
        lunaMediaId = 'luna1';

        expect(tracks.getSubtitleTracks()).toEqual([
          expect.objectContaining({ index: -2, available: true }),
        ]);
        tracks.selectSubtitleTrack(-2);

        expect(requests).toEqual([expect.objectContaining({
          uri: 'luna://com.webos.media/setSubtitleEnable',
          params: { mediaId: 'luna1', enable: true },
        })]);
      });

      it('lists a DASH compositor rendition on Luna and enables it there', () => {
        lunaSetup([
          { ...rendition('Track 1', 'l1'), dash: { kind: 'native' } },
          { ...rendition('Track 2', 'l2'), dash: { kind: 'webvtt', url: 'http://host/sub.vtt' } },
        ]);
        lunaMediaId = 'luna1';

        expect(tracks.getSubtitleTracks().map(item => item.label)).toEqual(['Track 1', 'Track 2']);
        tracks.selectSubtitleTrack(0);

        expect(dashSubs.start).not.toHaveBeenCalled();
        expect(requests).toEqual([expect.objectContaining({
          params: { mediaId: 'luna1', enable: true },
        })]);
      });

      it('re-enables on a replaced Luna pipeline and ignores the stale answer', () => {
        lunaSetup([{ ...rendition('Track 1', 'l1'), dash: { kind: 'native' } }]);
        lunaMediaId = 'luna1';
        tracks.selectSubtitleTrack(0);
        expect(requests[0].params).toEqual({ mediaId: 'luna1', enable: true });

        lunaMediaId = 'luna2';
        tracks.reapplyNativeSubtitleCompositor();
        requests[0].respond({ returnValue: true });
        expect(requests).toHaveLength(2);
        expect(requests[1].params).toEqual({ mediaId: 'luna2', enable: true });
        expect(trackInternals(tracks).ccEnabled).toBe(false);
        requests[1].respond({ returnValue: true });
        expect(trackInternals(tracks).ccEnabled).toBe(true);

        // Already on for luna2: no repeat call.
        tracks.reapplyNativeSubtitleCompositor();
        expect(requests).toHaveLength(2);
        expect(requests.map(request => request.params.mediaId)).not.toContain('placeholder1');
      });

      it('reports a refused Luna compositor toggle', () => {
        lunaSetup([{ ...rendition('Track 1', 'l1'), dash: { kind: 'native' } }]);
        lunaMediaId = 'luna1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        tracks.selectSubtitleTrack(0);
        requests[0].respond({ returnValue: false, errorCode: 7 });

        expect(warn.mock.calls.map(args => args.join(' '))).toContainEqual(expect.stringContaining(
          'event=subtitles.luna.compositor.failed session=1 load=7 enable=true code=7'));
        warn.mockRestore();
      });

      it('stops re-asking a pipeline that refused, and resets the menu', () => {
        lunaSetup([{ ...rendition('Track 1', 'l1'), dash: { kind: 'native' } }]);
        lunaMediaId = 'luna1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const onChanged = vi.fn();
        (trackInternals(tracks).options as { onChanged?: () => void }).onChanged = onChanged;

        tracks.selectSubtitleTrack(0);
        expect(onChanged).not.toHaveBeenCalled();
        requests[0].respond({ returnValue: false, errorCode: 7 });
        // An open menu re-reads the pick.
        expect(onChanged).toHaveBeenCalledTimes(1);
        tracks.reapplyNativeSubtitleCompositor();
        tracks.reapplyNativeSubtitleCompositor();

        expect(requests).toHaveLength(1);
        expect(warn.mock.calls.filter(args => args.join(' ')
          .includes('event=subtitles.luna.compositor.failed'))).toHaveLength(1);
        expect(tracks.getSubtitleTracks()).toEqual([
          expect.objectContaining({ index: 0, active: false, available: false }),
        ]);
        warn.mockRestore();
      });

      it('ignores a refusal from the Luna pipeline after falling back to native', () => {
        lunaSetup([{ ...rendition('Track 1', 'l1'), dash: { kind: 'native' } }]);
        lunaMediaId = 'luna1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tracks.selectSubtitleTrack(0);

        tracks.stopSelfRender();
        trackInternals(tracks).pipeline = pipeline({ isLunaActive: () => false });
        (video as HTMLVideoElement & { mediaId?: string }).mediaId = '';
        tracks.selectSubtitleTrack(0);
        requests[0].respond({ returnValue: false, errorCode: 7 });

        expect(tracks.getSubtitleTracks()).toEqual([
          expect.objectContaining({ index: 0, active: true, available: true }),
        ]);
        warn.mockRestore();
      });

      it('keeps a refused pipeline unasked after a click on a grayed row', () => {
        lunaSetup([rendition('Track 1', 'l1')],
          [{ name: 'Track 2', lang: 'l2', instreamId: 'CC1', isDefault: false }]);
        vi.mocked(StorageService.getSubtitlePref)
          .mockReturnValue({ off: false, cc: true, name: '', lang: '' });
        lunaMediaId = 'luna1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        tracks.reapplyNativeSubtitleCompositor();
        requests[0].respond({ returnValue: false, errorCode: 7 });
        (trackInternals(tracks).unavailableSubs as Set<number>).add(0);
        tracks.selectSubtitleTrack(0);
        tracks.reapplyNativeSubtitleCompositor();

        expect(requests).toHaveLength(1);
        warn.mockRestore();
      });

      it('retries a refused caption toggle only on a user pick or a new pipeline', () => {
        lunaSetup([], [{ name: 'Track 1', lang: 'l1', instreamId: 'CC1', isDefault: false }]);
        vi.mocked(StorageService.getSubtitlePref)
          .mockReturnValue({ off: false, cc: true, name: '', lang: '' });
        lunaMediaId = 'luna1';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        tracks.reapplyNativeSubtitleCompositor();
        requests[0].respond({ returnValue: false, errorCode: 7 });
        tracks.reapplyNativeSubtitleCompositor();
        expect(requests).toHaveLength(1);
        expect(tracks.getSubtitleTracks()[0].active).toBe(false);

        tracks.selectSubtitleTrack(-2);
        expect(requests).toHaveLength(2);
        requests[1].respond({ returnValue: false, errorCode: 7 });

        lunaMediaId = 'luna2';
        tracks.reapplyNativeSubtitleCompositor();
        expect(requests).toHaveLength(3);
        expect(requests[2].params).toEqual({ mediaId: 'luna2', enable: true });
        warn.mockRestore();
      });
    });

    it("self-renders on Luna's clock and reports one unavailable event per load", () => {
      setup([rendition('Track 1', 'l1')]);
      const clock = () => 42;
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => clock });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      tracks.selectSubtitleTrack(0);
      expect(subs.start).toHaveBeenCalledWith(
        video,
        'http://host/master.m3u8',
        { name: 'Track 1', lang: 'l1' },
        expect.objectContaining({ clock, onUnavailable: expect.any(Function) }),
      );
      const { onUnavailable } = subs.start.mock.calls[0][3] as { onUnavailable(reason: string): void };
      onUnavailable('network');
      onUnavailable('segment_http_404');
      const events = () => log.mock.calls.map(args => args.join(' '))
        .filter(line => line.includes('event=subtitles.luna.unavailable'));
      expect(events()).toEqual([
        expect.stringContaining('event=subtitles.luna.unavailable session=1 load=7 stage=render reason=network'),
      ]);
      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: true, available: true })]);

      // A permanent reason still lands after a transient one, once.
      onUnavailable('no_pdt');
      onUnavailable('http_404');
      expect(events()).toEqual([
        expect.stringContaining('reason=network'),
        expect.stringContaining('event=subtitles.luna.unavailable session=1 load=7 stage=render reason=no_pdt'),
      ]);
      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: false, available: false })]);

      tracks.resetForLoad();
      onUnavailable('network');
      expect(events()).toHaveLength(3);
      log.mockRestore();
    });

    it.each(['http_403', 'no_pdt', 'fmp4', 'encrypted', 'no_rendition'])(
      'moves the checkmark to Off when Luna can never render it (%s)',
      reason => {
        setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
        trackInternals(tracks).pipeline = pipeline({ lunaClock: () => () => 42 });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const savePref = vi.spyOn(StorageService, 'setSubtitlePref');
        tracks.selectSubtitleTrack(0);
        savePref.mockClear();

        const { onUnavailable } = subs.start.mock.calls[0][3] as { onUnavailable(reason: string): void };
        onUnavailable(reason);

        const options = tracks.getSubtitleTracks();
        expect(options.map(item => item.active)).toEqual([false, false]);
        expect(options.map(item => item.available)).toEqual([false, true]);
        expect(savePref).not.toHaveBeenCalled();
        expect(log.mock.calls.map(args => args.join(' ')).join('\n')).toContain(
          `event=subtitles.luna.reset session=1 load=7 index=0 reason=${reason}`);
        savePref.mockRestore();
        log.mockRestore();
      },
    );

    it('keeps a Luna rendition checked after a transient failure', () => {
      setup([rendition('Track 1', 'l1')]);
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => () => 42 });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      tracks.selectSubtitleTrack(0);

      const { onUnavailable } = subs.start.mock.calls[0][3] as { onUnavailable(reason: string): void };
      onUnavailable('network');
      onUnavailable('segment_http_404');

      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: true, available: true })]);
      vi.restoreAllMocks();
    });

    it('stops self-rendering when playback switches path mid-load', () => {
      setup([rendition('Track 1', 'l1')], 0);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      tracks.stopSelfRender();

      expect(subs.stop).toHaveBeenCalled();
      expect(tracks.getSubtitleTracks()).toEqual([expect.objectContaining({ active: false })]);
      expect(log.mock.calls.map(args => args.join(' ')).join('\n')).toContain(
        'event=subtitles.self_render.stopped session=1 load=7 reason=path_change');
      log.mockRestore();
    });

    it('logs the Luna self-render start with the pick source', () => {
      setup([rendition('Track 1', 'l1'), rendition('Track 2', 'l2')]);
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => () => 42 });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      tracks.selectSubtitleTrack(1);

      expect(log.mock.calls.map(args => args.join(' ')).join('\n')).toContain(
        'event=subtitles.luna.start session=1 load=7 index=1 count=2 pick=user format=hls');
      log.mockRestore();
    });

    it('logs Luna subtitle anchoring and a silent clock once each', () => {
      setup([rendition('Track 1', 'l1')]);
      trackInternals(tracks).pipeline = pipeline({ lunaClock: () => () => 42 });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      tracks.selectSubtitleTrack(0);
      const { onAnchor, onClockWait } = subs.start.mock.calls[0][3] as {
        onAnchor(src: string, holdBackS: number): void;
        onClockWait(waitedMs: number): void;
      };

      onAnchor('clock-edge', 4);
      onClockWait(10000);

      expect(log.mock.calls.map(args => args.join(' ')).join('\n')).toContain(
        'event=subtitles.luna.anchor session=1 load=7 src=clock-edge holdBackS=4');
      expect(warn.mock.calls.map(args => args.join(' ')).join('\n')).toContain(
        'event=subtitles.luna.clock.waiting session=1 load=7 waitedMs=10000');
      log.mockRestore();
      warn.mockRestore();
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

    it('routes a sidecar pick to the reusable VOD renderer', () => {
      setup();
      const vodSubs = {
        attach: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        clear: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
        activeIndex: -1,
      };
      const internals = trackInternals(tracks);
      internals.vodSubs = vodSubs;
      internals.vodTextSidecars = [{
        id: '1',
        name: 'Track 1',
        lang: 'l1',
        url: 'http://host/a.srt',
      }];

      tracks.selectSubtitleTrack(VOD_SUBTITLE_BASE);

      expect(vodSubs.show).toHaveBeenCalledWith(0);
      expect(vodSubs.hide).not.toHaveBeenCalled();
    });

    it('hides the live self-renderer tracks from the VOD picker', () => {
      const timeline = nativeTextTrack('hidden', { label: 'Subtitles' });
      const display = nativeTextTrack('showing', { label: 'Subtitles' });
      setup({ text: [nativeTextTrack('disabled', { label: 'Track 1' }), timeline, display] });
      trackInternals(tracks).subs = {
        owns: vi.fn((track: unknown) => track === timeline || track === display),
        stop: vi.fn(),
      };

      expect(tracks.getSubtitleTracks().map(item => item.label)).toEqual(['Track 1']);
    });

    it('lists a sidecar once and hides its renderer track from the picker', () => {
      const renderer = nativeTextTrack('showing', { label: 'Renderer' });
      setup({ text: [renderer] });
      const internals = trackInternals(tracks);
      internals.vodTextSidecars = [{
        id: '1',
        name: 'Track 1',
        lang: 'l1',
        url: 'http://host/a.srt',
      }];
      internals.vodSubs = {
        activeIndex: 0,
        owns: vi.fn((track: TextTrack) => track === renderer),
      };

      expect(tracks.getSubtitleTracks()).toEqual([{
        index: VOD_SUBTITLE_BASE,
        label: 'Track 1',
        active: true,
        available: true,
      }]);
    });

    it('uses the generic subtitle label for an unnamed sidecar', () => {
      setup();
      const internals = trackInternals(tracks);
      internals.vodTextSidecars = [{
        id: '1',
        name: '',
        lang: '',
        url: 'http://host/a.srt',
      }];
      internals.vodSubs = {
        activeIndex: -1,
        owns: vi.fn(() => false),
      };

      expect(tracks.getSubtitleTracks()[0].label).toBe('Subtitles');
    });

    it('uses the language as the label when a sidecar has no name', () => {
      setup();
      const internals = trackInternals(tracks);
      internals.vodTextSidecars = [{
        id: '1',
        name: '',
        lang: 'l1',
        url: 'http://host/a.srt',
      }];
      internals.vodSubs = {
        activeIndex: -1,
        owns: vi.fn(() => false),
      };

      expect(tracks.getSubtitleTracks()[0].label).toBe('l1');
    });

    it('hides the sidecar renderer before selecting a native track', () => {
      const text = [nativeTextTrack('disabled', { label: 'Track 1' })];
      setup({ text });
      const vodSubs = {
        activeIndex: 0,
        hide: vi.fn(),
        owns: vi.fn(() => false),
        setOffset: vi.fn(),
      };
      trackInternals(tracks).vodSubs = vodSubs;

      tracks.selectSubtitleTrack(0);

      expect(vodSubs.hide).toHaveBeenCalled();
      expect(text[0].mode).toBe('showing');
    });

    it('ignores addtrack reapplication while a sidecar is active', () => {
      const text = [nativeTextTrack('disabled', { label: 'Renderer' })];
      setup({ text });
      const vodSubs = {
        activeIndex: 0,
        hide: vi.fn(),
        owns: vi.fn(() => true),
        setOffset: vi.fn(),
      };
      trackInternals(tracks).vodSubs = vodSubs;
      vi.mocked(StorageService.getSubtitlePref).mockReturnValue({
        off: false,
        name: 'Track 1',
        lang: 'l1',
      });

      tracks.applyNativeSubtitleSelection();

      expect(vodSubs.hide).not.toHaveBeenCalled();
      expect(text[0].mode).toBe('disabled');
    });

    it('hides the sidecar renderer when subtitles are turned off', () => {
      const text = [nativeTextTrack('showing', { label: 'Track 1' })];
      setup({ text });
      const vodSubs = {
        attach: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        clear: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
        activeIndex: -1,
      };
      trackInternals(tracks).vodSubs = vodSubs;
      tracks.selectSubtitleTrack(-1);
      expect(vodSubs.hide).toHaveBeenCalled();
      expect(vodSubs.show).not.toHaveBeenCalled();
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
        addOnline: vi.fn(() => 0),
        show: vi.fn(),
        hide: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
        activeIndex: 0,
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
        show: vi.fn(),
        hide: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
        activeIndex: -1,
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
      video = { textTracks: [] } as unknown as HTMLVideoElement;
      const addOnline = vi.fn(() => 0);
      trackInternals(tracks).vodSubs = {
        addOnline,
        show: vi.fn(),
        hide: vi.fn(),
        setOffset: vi.fn(),
        owns: vi.fn(() => false),
        activeIndex: -1,
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

  it('clears VOD subtitle state on a new load and stop', () => {
    const subs = { stop: vi.fn() };
    const vodSubs = { clear: vi.fn() };
    const assSubs = { destroy: vi.fn() };
    const internals = tracks as unknown as {
      subs: typeof subs;
      vodSubs: typeof vodSubs;
      assSubs: typeof assSubs;
      vodTextSidecars: unknown[];
      vodAssSidecars: unknown[];
      activeAssIndex: number;
    };
    internals.subs = subs;
    internals.vodSubs = vodSubs;
    internals.assSubs = assSubs;
    internals.vodTextSidecars = [{}];
    internals.vodAssSidecars = [{}];
    internals.activeAssIndex = 0;

    tracks.resetForLoad();
    tracks.suspend();
    tracks.stop();

    expect(subs.stop).toHaveBeenCalledTimes(3);
    expect(vodSubs.clear).toHaveBeenCalledTimes(2);
    expect(assSubs.destroy).toHaveBeenCalledTimes(2);
    expect(internals.vodTextSidecars).toEqual([]);
    expect(internals.vodAssSidecars).toEqual([]);
    expect(internals.activeAssIndex).toBe(-1);
  });
});

describe('PlayerTracks Luna audio', () => {
  let video: HTMLVideoElement;
  let luna: Array<{ index: number; language: string; selected: boolean }>;
  let selectLunaAudio: ReturnType<typeof vi.fn>;
  let tracks: PlayerTracks;
  let log: ReturnType<typeof vi.spyOn>;

  const manifest = (audio: Array<{ name: string; lang: string }>) => ({
    audio: audio.map(item => ({ ...item, isDefault: false })),
    subtitles: [],
    closedCaptions: [],
    variants: [],
    masterUrl: '',
  });
  const logged = (): string => log.mock.calls.map(args => args.join(' ')).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StorageService.getAudioPref).mockReturnValue(null);
    luna = [
      { index: 0, language: 'l1', selected: true },
      { index: 1, language: 'l2', selected: false },
    ];
    selectLunaAudio = vi.fn(() => Promise.resolve(true));
    video = { audioTracks: undefined, textTracks: [] } as unknown as HTMLVideoElement;
    tracks = new PlayerTracks(pipeline({
      isLunaActive: () => true,
      lunaAudioTracks: () => luna,
      selectLunaAudio,
    }), {
      getVideoElement: () => video,
      getChannel: () => CHANNEL,
      getVod: () => null,
      playbackLabel: () => 'session=1 load=7',
    });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('names UMS audio from the manifest, pairing same-language renditions in order', () => {
    luna = [
      { index: 0, language: 'l1', selected: false },
      { index: 1, language: 'l2', selected: true },
      { index: 2, language: 'l1', selected: false },
    ];
    tracks.applyManifest(manifest([
      { name: 'Track 1', lang: 'l1' },
      { name: 'Track 2', lang: 'l1' },
      { name: 'Track 3', lang: 'l2' },
    ]));

    expect(tracks.getAudioTracks()).toEqual([
      { index: 0, label: 'Track 1', active: false, available: true },
      { index: 1, label: 'Track 3', active: true, available: true },
      { index: 2, label: 'Track 2', active: false, available: true },
    ]);
    expect(logged()).toContain(
      'event=audio.luna.tracks session=1 load=7 count=3 manifest=3 naming=manifest pick=none index=1');
  });

  it('names UMS audio by position when UMS lists no languages, but does not switch to a saved pick', () => {
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: 'Track 2', lang: '' });
    luna = [
      { index: 0, language: '', selected: true },
      { index: 1, language: '', selected: false },
    ];
    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }, { name: 'Track 2', lang: 'l2' }]));

    expect(tracks.getAudioTracks().map(item => item.label)).toEqual(['Track 1', 'Track 2']);
    expect(selectLunaAudio).not.toHaveBeenCalled();
    expect(logged()).toContain(
      'event=audio.luna.tracks session=1 load=7 count=2 manifest=2 naming=order pick=unpaired index=0');
  });

  it('labels UMS audio by language or position when the manifest does not pair', () => {
    luna = [
      { index: 0, language: 'l1', selected: true },
      { index: 1, language: '', selected: false },
    ];
    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }]));

    expect(tracks.getAudioTracks().map(item => item.label)).toEqual(['l1', 'Audio 2']);
    expect(logged()).toContain('event=audio.luna.tracks session=1 load=7 count=2 manifest=1 naming=count_mismatch');
  });

  it('numbers unnamed UMS tracks that share a language instead of repeating it', () => {
    luna = [
      { index: 0, language: 'l1', selected: true },
      { index: 1, language: 'l1', selected: false },
      { index: 2, language: 'l2', selected: false },
    ];
    tracks.applyManifest(manifest([]));

    expect(tracks.getAudioTracks().map(item => item.label)).toEqual(['Audio 1', 'Audio 2', 'l2']);
  });

  it('shows no audio menu when UMS lists one track, whatever the manifest declares', () => {
    luna = [{ index: 0, language: 'l1', selected: true }];
    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }, { name: 'Track 2', lang: 'l2' }]));

    expect(tracks.getAudioTracks()).toHaveLength(1);
    expect(logged()).not.toContain('event=audio.luna.tracks');
  });

  it('reapplies the saved pick once UMS lists the audio and the manifest settles', () => {
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: 'Track 2', lang: 'l2' });

    tracks.applyLunaAudioSelection();
    expect(selectLunaAudio).not.toHaveBeenCalled();
    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }, { name: 'Track 2', lang: 'l2' }]));
    tracks.applyLunaAudioSelection();

    expect(selectLunaAudio).toHaveBeenCalledExactlyOnceWith(1);
    expect(StorageService.getAudioPref).toHaveBeenCalledWith(channelKey(CHANNEL), legacyChannelKey(CHANNEL));
    expect(StorageService.setAudioPref).not.toHaveBeenCalled();
    expect(logged()).toContain('event=audio.luna.tracks session=1 load=7 count=2 manifest=2 naming=manifest pick=saved index=1');
  });

  it('matches a saved language when the manifest failed', () => {
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: 'Track 2', lang: 'l2' });

    tracks.applyManifest(manifest([]));

    expect(selectLunaAudio).toHaveBeenCalledExactlyOnceWith(1);
    expect(logged()).toContain('naming=no_manifest pick=saved index=1');
  });

  it('keeps the stream default when the saved pick is not offered', () => {
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: 'Track 9', lang: 'l9' });

    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }, { name: 'Track 2', lang: 'l2' }]));

    expect(selectLunaAudio).not.toHaveBeenCalled();
    expect(logged()).toContain('pick=missed index=0');
  });

  it('switches Luna audio and remembers it only once UMS confirms', async () => {
    tracks.applyManifest(manifest([{ name: 'Track 1', lang: 'l1' }, { name: 'Track 2', lang: 'l2' }]));
    selectLunaAudio.mockResolvedValueOnce(false);

    tracks.selectAudioTrack(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(StorageService.setAudioPref).not.toHaveBeenCalled();
    // The menu reads UMS's selection, which a refused switch left alone.
    expect(tracks.getAudioTracks().map(item => item.active)).toEqual([true, false]);

    tracks.selectAudioTrack(1);
    await vi.waitFor(() => expect(StorageService.setAudioPref).toHaveBeenCalledWith(
      channelKey(CHANNEL), { name: 'Track 2', lang: 'l2' }));
    expect(selectLunaAudio).toHaveBeenCalledTimes(2);
  });

  it("leaves the placeholder's own audio tracks alone", () => {
    const audio = [audioTrack(true, '', ''), audioTrack(false, '', '')];
    video = { audioTracks: audio, textTracks: [] } as unknown as HTMLVideoElement;
    vi.mocked(StorageService.getAudioPref).mockReturnValue({ name: '', lang: 'l2' });

    tracks.applyNativeAudioSelection();

    expect(audio.map(item => item.enabled)).toEqual([true, false]);
  });
});
