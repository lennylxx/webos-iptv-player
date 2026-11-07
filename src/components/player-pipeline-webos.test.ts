// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerPipelineOptions } from './player-pipeline';
import { CONFIG } from '../config';

const cacheMocks = vi.hoisted(() => ({
  getCachedStreamMime: vi.fn(),
  setCachedStreamMime: vi.fn(),
}));

vi.mock('../services/idb-cache', () => cacheMocks);

const manifestService = vi.hoisted(() => ({
  fetchManifestViaService: vi.fn(),
}));

vi.mock('../services/manifest-service', () => manifestService);

const proxyService = vi.hoisted(() => ({
  openStreamProxy: vi.fn(),
  closeStreamProxy: vi.fn(),
  touchStreamProxy: vi.fn(),
}));

vi.mock('../services/proxy-service', () => proxyService);

const luna = vi.hoisted(() => ({
  sessions: [] as Array<{
    uri: string;
    headers: Record<string, string>;
    onFallback: (reason: string, code: number, stage?: string) => void;
    playReadyClientId?: string;
    onStarted?: () => void;
    onPlaybackError?: (code: number) => boolean;
    onAudioTracks?: () => void;
    start: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setDisplay: ReturnType<typeof vi.fn>;
    selectAudio: ReturnType<typeof vi.fn>;
    isLoaded: ReturnType<typeof vi.fn>;
    element: { mediaId: string };
  }>,
}));

vi.mock('./luna-media-element', () => ({
  LunaMediaElement: class {
    readonly start = vi.fn();
    readonly destroy = vi.fn();
    readonly setDisplay = vi.fn();
    readonly clockTime = vi.fn(() => 42);
    readonly audioTracks = vi.fn(() => [{ index: 0, language: 'l1', selected: true }]);
    readonly selectAudio = vi.fn(() => Promise.resolve(true));
    readonly isLoaded = vi.fn(() => false);
    mediaId = '';
    constructor(_video: HTMLVideoElement, options: {
      uri: string;
      headers: Record<string, string>;
      onFallback: (reason: string, code: number) => void;
      onStarted?: () => void;
    }) {
      luna.sessions.push({ ...options, start: this.start, destroy: this.destroy,
        setDisplay: this.setDisplay, selectAudio: this.selectAudio, isLoaded: this.isLoaded,
        element: this });
    }
  },
}));

function callbacks(): PlayerPipelineOptions {
  return {
    playbackLabel: token => `load=${String(token)}`,
    mediaState: () => '',
    isCatchup: () => false,
    headerPlayback: () => 'luna',
    onError: vi.fn(),
    onAudioTracksUpdated: vi.fn(),
    onSubtitleTracksUpdated: vi.fn(),
    onPlaybackPathChange: vi.fn(),
    onManifest: vi.fn(),
  };
}

function videoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  vi.spyOn(video, 'play').mockResolvedValue();
  vi.spyOn(video, 'load').mockImplementation(() => {});
  return video;
}

describe('PlayerPipeline webOS stream MIME cache', () => {
  beforeEach(() => {
    vi.resetModules();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
  });

  it.each(['mkv', 'avi', 'mov', 'webm'])(
    'omits the source type for direct .%s playback',
    async extension => {
      const { PlayerPipeline } = await import('./player-pipeline');
      const pipeline = new PlayerPipeline(callbacks());
      const video = videoElement();
      pipeline.setVideoElement(video);

      pipeline.load(`http://host/movie/ch1.${extension}`, null, { direct: true });

      const source = video.querySelector('source');
      expect(source?.src).toBe(`http://host/movie/ch1.${extension}`);
      expect(source?.hasAttribute('type')).toBe(false);
      expect(video.play).toHaveBeenCalledOnce();
    },
  );

  it('plays an ambiguous route from the IndexedDB MIME cache without probing', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('video/mp2t');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.getCachedStreamMime).toHaveBeenCalledWith('http://host/live');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(video.querySelector('source')?.src).toBe('http://host/live/ch1');
  });

  it('stores a successful probe in the IndexedDB MIME cache', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { headers: { 'content-type': 'video/mp2t' } }),
    ));
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'video/mp2t');
  });

  it('ignores a cache result after a newer load supersedes it', async () => {
    let resolveCache: ((mime: string | null) => void) | undefined;
    cacheMocks.getCachedStreamMime.mockReturnValue(
      new Promise(resolve => { resolveCache = resolve; }),
    );
    const { PlayerPipeline } = await import('./player-pipeline');
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/live/ch1', null);
    pipeline.load('http://host/live/ch2.ts', null);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());

    resolveCache?.('application/vnd.apple.mpegurl');
    await Promise.resolve();
    await Promise.resolve();

    expect(video.querySelector('source')?.src).toBe('http://host/live/ch2.ts');
    expect(video.play).toHaveBeenCalledOnce();
  });
});

describe('PlayerPipeline webOS DASH', () => {
  beforeEach(() => {
    vi.resetModules();
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'webOS',
    });
  });

  async function pipelineFor(video: HTMLVideoElement) {
    const { PlayerPipeline } = await import('./player-pipeline');
    const opts = callbacks();
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(video);
    return Object.assign(pipeline, { opts });
  }

  const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <Period>
    <AdaptationSet contentType="audio" lang="l1" label="Track 1">
      <Representation id="a1" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="l2" label="Track 2">
      <Representation id="a2" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1" label="Track 1">
      <Representation id="s1"/>
    </AdaptationSet>
  </Period>
</MPD>`;

  it('parses a fetched MPD into audio and subtitle labels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(MPD)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    const manifest = vi.mocked(pipeline.opts.onManifest).mock.calls[0][0];
    expect(manifest.audio.map(a => a.name)).toEqual(['Track 1', 'Track 2']);
    expect(manifest.subtitles.map(s => s.lang)).toEqual(['l1']);
    expect(manifest.masterUrl).toBe('http://host/a.mpd');
  });

  it.each([
    ['whitespace', ` \n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    ['comment', `<!-- lead -->\n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    ['doctype', `<!DOCTYPE MPD>\n${MPD.replace('<?xml version="1.0"?>\n', '')}`],
    [
      'namespace prefix',
      MPD
        .replace('<MPD xmlns=', '<dash:MPD xmlns:dash=')
        .replace('</MPD>', '</dash:MPD>'),
    ],
  ])('accepts an MPD with a legal %s opening', async (_name, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].audio).toHaveLength(2);
  });

  it('accepts an MPD larger than the HLS manifest byte budget', async () => {
    const padded = MPD + `<!--${'x'.repeat(400 * 1024)}-->`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(padded)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].audio).toHaveLength(2);
  });

  it('takes the error path immediately for a DRM-protected MPD', async () => {
    const drm = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection schemeIdUri="urn:uuid:00000000-0000-0000-0000-000000000000"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(drm)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledOnce());
    expect(pipeline.opts.onManifest).toHaveBeenCalledOnce();
  });

  it('does not reject an MPD with only the generic MP4 protection descriptor', async () => {
    const generic = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(generic)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
  });

  it('ignores a DRM verdict from a superseded load', async () => {
    const drm = MPD.replace('</MPD>',
      '<ContentProtection schemeIdUri="urn:uuid:0"/></MPD>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(drm)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', null);
    pipeline.load('http://host/b.m3u8', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
  });

  it('prepares PlayReady before attaching the native DASH source', async () => {
    const playReady = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection ' +
      'schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>' +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(playReady)));
    const request = vi.fn();
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private method = '';

      call(uri: string): void {
        this.method = uri.slice(uri.lastIndexOf('/') + 1);
        request(uri, { method: this.method });
        if (this.method === 'load') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            clientId: 'client-1',
          }));
        } else if (this.method === 'sendDrmMessage') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            resultCode: 0,
            msgId: 'msg-1',
          }));
        } else if (this.method === 'unload') {
          this.onservicecallback?.('{"returnValue":true}');
        }
      }

      cancel(): void {
        this.onservicecallback = null;
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', {
      configurable: true,
      value: FakePalmServiceBridge,
    });
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/a.mpd', {
      'inputstream.adaptive.license_type': 'com.microsoft.playready',
      'inputstream.adaptive.license_key': 'http://host/license|x-token=v|R{SSM}|',
    });

    expect(pipeline.drmLabel()).toBe('');
    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(pipeline.drmLabel()).toBe('PlayReady');
    expect(request.mock.calls.map(call => call[1].method)).toEqual([
      'load',
      'getRightsError',
      'sendDrmMessage',
    ]);
    expect(parseMediaOption(video.querySelector('source')?.type ?? '')).toEqual({
      mediaTransportType: 'MPEG-DASH',
      option: {
        drm: {
          type: 'playready',
          clientId: 'client-1',
        },
      },
    });

    pipeline.destroy();
    expect(pipeline.drmLabel()).toBe('');
  });

  it.each([
    { label: 'Widevine', keySystem: 'com.widevine.alpha', scheme: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' },
    { label: 'ClearKey', keySystem: 'org.w3.clearkey', scheme: 'e2719d58-a985-b3c9-781a-b030af78d30e' },
    { label: 'ClearKey', keySystem: 'org.w3.clearkey', scheme: '9a04f079-9840-4286-ab92-e65be0885f95' },
  ])('routes $label through Shaka when the MPD declares $scheme', async testCase => {
    const widevine = MPD.replace('<Period>',
      '<Period><AdaptationSet contentType="video" mimeType="video/mp4">' +
      '<ContentProtection ' +
      `schemeIdUri="urn:uuid:${testCase.scheme}"/>` +
      '<Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>' +
      '</AdaptationSet>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(widevine)));
    const requestFilters: Array<
      (type: number, request: { headers: Record<string, string> }) => void
    > = [];
    const configure = vi.fn(() => true);
    const load = vi.fn().mockResolvedValue(undefined);
    class Player {
      static isBrowserSupported(): boolean {
        return true;
      }

      addEventListener(): void {}
      attach(): Promise<void> {
        return Promise.resolve();
      }
      configure = configure;
      destroy(): Promise<void> {
        return Promise.resolve();
      }
      getAudioTracks(): [] {
        return [];
      }
      getNetworkingEngine(): {
        registerRequestFilter: (
          filter: (type: number, request: { headers: Record<string, string> }) => void,
        ) => void;
      } {
        return {
          registerRequestFilter: filter => requestFilters.push(filter),
        };
      }
      getTextTracks(): [] {
        return [];
      }
      getVariantTracks(): [] {
        return [];
      }
      load = load;
      selectAudioTrack(): void {}
      selectTextTrack(): void {}
    }
    vi.stubGlobal('__shaka', {
      Player,
      net: { NetworkingEngine: { RequestType: { LICENSE: 2 } } },
      polyfill: { installAll: vi.fn() },
      util: { Error: { Severity: { CRITICAL: 2 } } },
    });
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.mpd', {
      'inputstream.adaptive.license_type': testCase.keySystem,
      'inputstream.adaptive.license_key':
        'http://host/license|authorization=Bearer%20token',
    });

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('http://host/a.mpd'));
    const request = { headers: {} as Record<string, string> };
    requestFilters[0]?.(2, request);
    expect(configure).toHaveBeenCalledWith({
      streaming: { bufferingGoal: 30 },
      drm: {
        preferredKeySystems: [testCase.keySystem],
        servers: { [testCase.keySystem]: 'http://host/license' },
      },
    });
    expect(request.headers).toEqual({ authorization: 'Bearer token' });
    expect(video.querySelector('source')).toBeNull();
    expect(pipeline.isMseActive()).toBe(true);
    expect(pipeline.drmLabel()).toBe(testCase.label);
  });

  it('plays an .mpd URL natively with the MPEG-DASH media option', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(MPD));
    vi.stubGlobal('fetch', fetchMock);
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/a.mpd', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    const source = video.querySelector('source');
    expect(source?.src).toBe('http://host/a.mpd');
    expect(parseMediaOption(source?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    expect(source?.type).not.toContain('application/dash+xml');
    expect(cacheMocks.getCachedStreamMime).not.toHaveBeenCalled();
  });

  it('plays a cached DASH route without probing', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('application/dash+xml');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(MPD)));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.getCachedStreamMime).toHaveBeenCalledWith('http://host/live');
    // A cached classification skips probing and storage; routing still fetches
    // the MPD for track labels.
    expect(cacheMocks.setCachedStreamMime).not.toHaveBeenCalled();
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
  });

  it('caches and plays a DASH route discovered by the content-type probe', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { headers: { 'content-type': 'application/dash+xml' } }),
    ));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
  });

  it('plays an extension-less MPD detected by sniffing the body', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<?xml version="1.0"?><MPD type="dynamic"></MPD>',
        { headers: { 'content-type': 'application/octet-stream' } }),
    ));
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const { parseMediaOption } = await import('../utils/webos-media-option');

    pipeline.load('http://host/live/ch1', null);

    await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
    expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
      .toEqual({ mediaTransportType: 'MPEG-DASH' });
    // A sniffed classification is cached like any other, keyed by route.
    expect(cacheMocks.setCachedStreamMime)
      .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
  });

  it.each(['application/xml', 'text/xml'])(
    'plays an extension-less MPD served as %s',
    async contentType => {
      cacheMocks.getCachedStreamMime.mockResolvedValue(null);
      cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('<?xml version="1.0"?><MPD type="dynamic"></MPD>', {
          headers: { 'content-type': contentType },
        })));
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      const { parseMediaOption } = await import('../utils/webos-media-option');

      pipeline.load('http://host/live/1', null);

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(parseMediaOption(video.querySelector('source')?.type ?? ''))
        .toEqual({ mediaTransportType: 'MPEG-DASH' });
      expect(cacheMocks.setCachedStreamMime)
        .toHaveBeenCalledWith('http://host/live', 'application/dash+xml');
    },
  );

  it('omits the type attribute when the bare source spelling is selected', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { CONFIG } = await import('../config');
    const previous = CONFIG.PLAYER.DASH_SOURCE;
    CONFIG.PLAYER.DASH_SOURCE = 'bare';
    try {
      const video = videoElement();
      const pipeline = await pipelineFor(video);

      pipeline.load('http://host/a.mpd', null);

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(video.querySelector('source')?.getAttribute('type')).toBeNull();
    } finally {
      CONFIG.PLAYER.DASH_SOURCE = previous;
    }
  });
});

describe('PlayerPipeline webOS Luna routing', () => {
  const WEBOS_25 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager';
  const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",URI="a1.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",URI="a2.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="l1",URI="s1.m3u8"',
    '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC 1",INSTREAM-ID="CC1"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a",SUBTITLES="s",CLOSED-CAPTIONS="cc"',
    'v.m3u8',
  ].join('\n');
  const REFERER = { Referer: 'http://host/' };

  let logs: string[];

  beforeEach(() => {
    vi.resetModules();
    luna.sessions.length = 0;
    cacheMocks.getCachedStreamMime.mockReset();
    cacheMocks.setCachedStreamMime.mockReset();
    localStorage.clear();
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: WEBOS_25 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(MASTER)));
    manifestService.fetchManifestViaService.mockReset();
    manifestService.fetchManifestViaService.mockResolvedValue({ ok: false, reason: 'unavailable' });
    logs = [];
    const record = (...args: unknown[]) => { logs.push(args.join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function pipelineFor(video: HTMLVideoElement) {
    const { PlayerPipeline } = await import('./player-pipeline');
    const opts = callbacks();
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(video);
    return Object.assign(pipeline, { opts });
  }

  it('plays an HLS channel with headers through Luna', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

    expect(luna.sessions).toHaveLength(1);
    expect(luna.sessions[0]).toMatchObject({ uri: 'http://host/a.m3u8', headers: REFERER });
    expect(luna.sessions[0].start).toHaveBeenCalledOnce();
    expect(pipeline.isLunaActive()).toBe(true);
    expect(video.querySelector('source')).toBeNull();
    expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=url headers=referer');
    expect(logs.join('\n')).not.toContain('http://host/');
  });

  it('reads only subtitle, caption and audio renditions from the master while Luna plays', async () => {
    let respond: (response: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

    expect(luna.sessions[0].start).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    respond(new Response(MASTER));
    await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
    expect(pipeline.opts.onManifest).toHaveBeenCalledWith({
      audio: [expect.objectContaining({ name: 'Track 1' }), expect.objectContaining({ name: 'Track 2' })],
      subtitles: [expect.objectContaining({ name: 'l1' })],
      closedCaptions: [expect.objectContaining({ instreamId: 'CC1' })],
      variants: [],
      masterUrl: 'http://host/a.m3u8',
    });
    expect(pipeline.isLunaActive()).toBe(true);
    expect(video.querySelector('source')).toBeNull();
  });

  describe('manifest through the bundled service', () => {
    const refused = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const serviceLogs = () => logs.filter(line => line.includes('event=playback.luna.manifest.service'));

    it('reads a refused master through the service with the channel headers', async () => {
      refused();
      manifestService.fetchManifestViaService.mockResolvedValue(
        { ok: true, status: 200, url: 'http://host/b/a.m3u8', text: MASTER });
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(manifestService.fetchManifestViaService).toHaveBeenCalledExactlyOnceWith(
        'http://host/a.m3u8', { ...REFERER, 'User-Agent': WEBOS_25 },
        expect.objectContaining({ maxBytes: 256 * 1024, timeoutMs: 5000, graceMs: 3000 }));
      // Relative URIs resolve against the URL the service ended on, and
      // subtitles start from this text: the page would be refused again.
      expect(pipeline.opts.onManifest).toHaveBeenCalledWith(expect.objectContaining({
        audio: [expect.objectContaining({ name: 'Track 1' }), expect.objectContaining({ name: 'Track 2' })],
        subtitles: [expect.objectContaining({ name: 'l1' })],
        masterUrl: 'http://host/b/a.m3u8',
        masterText: MASTER,
      }));
      expect(serviceLogs()).toEqual([
        expect.stringMatching(/event=playback\.luna\.manifest\.service load=1 outcome=ok page=http_403 elapsed=\d+ms/),
      ]);
      expect(logs.join('\n')).not.toContain('event=subtitles.luna.unavailable');
      expect(logs.join('\n')).not.toContain('http://host/');
    });

    it('keeps the channel User-Agent, whatever its case, and sends an encoded URL', async () => {
      refused();
      const headers = { ...REFERER, 'user-agent': 'Agent 1' };
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/\u00e9/a.m3u8', null, { headers });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(manifestService.fetchManifestViaService).toHaveBeenCalledExactlyOnceWith(
        'http://host/%C3%A9/a.m3u8', headers, expect.anything());
    });

    it('stays quiet when the channel changes while the service reads', async () => {
      refused();
      let answer: (result: unknown) => void = () => {};
      manifestService.fetchManifestViaService.mockReturnValueOnce(
        new Promise(resolve => { answer = resolve; }));
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      await vi.waitFor(() => expect(manifestService.fetchManifestViaService).toHaveBeenCalledOnce());
      const signal = (manifestService.fetchManifestViaService.mock.calls[0][2] as { signal: AbortSignal }).signal;

      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      pipeline.load('http://host/b.m3u8', null, { headers: REFERER });
      expect(signal.aborted).toBe(true);
      answer({ ok: true, status: 200, url: 'http://host/a.m3u8', text: MASTER });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(pipeline.opts.onManifest).not.toHaveBeenCalled();
      expect(serviceLogs()).toEqual([]);
      expect(logs.join('\n')).not.toContain('event=subtitles.luna.unavailable');
    });

    it.each([
      ['fails', { ok: false, reason: 'http_403' }, 'http_403'],
      ['returns something other than a playlist', { ok: true, status: 200, url: 'http://host/a.m3u8', text: '<html>' }, 'parse'],
    ])('keeps the empty manifest when the service %s', async (_name, result, reason) => {
      refused();
      manifestService.fetchManifestViaService.mockResolvedValue(result);
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(pipeline.opts.onManifest).toHaveBeenCalledWith(
        { audio: [], subtitles: [], closedCaptions: [], variants: [], masterUrl: '' });
      expect(serviceLogs()).toEqual([expect.stringContaining(
        `event=playback.luna.manifest.service load=1 outcome=failed reason=${reason} page=http_403`)]);
      expect(logs.filter(line => line.includes('event=subtitles.luna.unavailable')))
        .toEqual([expect.stringContaining('stage=manifest reason=http_403')]);
      expect(pipeline.isLunaActive()).toBe(true);
    });

    it.each([
      ['a server error', () => Promise.resolve(new Response('', { status: 503 }))],
      ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('does not ask the service after %s', async (_name, response) => {
      vi.stubGlobal('fetch', vi.fn(response));
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(manifestService.fetchManifestViaService).not.toHaveBeenCalled();
      expect(serviceLogs()).toEqual([]);
    });

    it('reads a master with URL credentials through the service, which the page cannot fetch', async () => {
      const pageFetch = vi.fn(() => Promise.reject(new TypeError('Request cannot be constructed')));
      vi.stubGlobal('fetch', pageFetch);
      manifestService.fetchManifestViaService.mockResolvedValue(
        { ok: true, status: 200, url: 'http://host/a.m3u8', text: MASTER });
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://u1:p1@host/a.m3u8', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(pageFetch).not.toHaveBeenCalled();
      expect(manifestService.fetchManifestViaService).toHaveBeenCalledExactlyOnceWith(
        'http://u1:p1@host/a.m3u8', expect.anything(), expect.anything());
      expect(pipeline.opts.onManifest).toHaveBeenCalledWith(expect.objectContaining({ masterText: MASTER }));
      expect(serviceLogs()).toEqual([
        expect.stringMatching(/outcome=ok page=credentials elapsed=\d+ms/),
      ]);
      expect(logs.join('\n')).not.toContain('p1');
    });

    it('does not ask the service for a stream on the video element', async () => {
      refused();
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.m3u8', null);

      await vi.waitFor(() => expect(logs.join('\n')).toContain('event=playback.manifest.failed'));
      expect(pipeline.isLunaActive()).toBe(false);
      expect(manifestService.fetchManifestViaService).not.toHaveBeenCalled();
    });
  });

  it("exposes only the loaded Luna pipeline's mediaId, never a stale one", async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const video = videoElement();
    (video as HTMLVideoElement & { mediaId?: string }).mediaId = 'placeholder1';
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    const first = luna.sessions[0];
    first.element.mediaId = 'luna1';
    expect(pipeline.lunaMediaId()).toBe('');
    first.isLoaded.mockReturnValue(true);
    expect(pipeline.lunaMediaId()).toBe('luna1');

    pipeline.load('http://host/b.m3u8', null, { headers: REFERER });
    expect(first.destroy).toHaveBeenCalled();
    expect(pipeline.lunaMediaId()).toBe('');
    luna.sessions[1].element.mediaId = 'luna2';
    luna.sessions[1].isLoaded.mockReturnValue(true);
    expect(pipeline.lunaMediaId()).toBe('luna2');

    luna.sessions[1].onFallback('error', 1);
    expect(pipeline.lunaMediaId()).toBe('');
  });

  it.each([
    ['an HTTP refusal', () => Promise.resolve(new Response('', { status: 403 })), 'http_403'],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
  ])('silently drops Luna subtitles after %s', async (_name, response, reason) => {
    vi.stubGlobal('fetch', vi.fn(response));
    const pipeline = await pipelineFor(videoElement());

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

    await vi.waitFor(() => expect(logs.join('\n')).toContain('event=subtitles.luna.unavailable'));
    expect(logs.filter(line => line.includes('event=subtitles.luna.unavailable')))
      .toEqual([expect.stringContaining(`load=1 stage=manifest reason=${reason}`)]);
    expect(logs.join('\n')).not.toContain('event=playback.manifest.failed');
    expect(logs.join('\n')).not.toContain('http://host/');
    // Settled empty, so Luna audio labels stop waiting for names.
    expect(pipeline.opts.onManifest).toHaveBeenCalledExactlyOnceWith(
      { audio: [], subtitles: [], closedCaptions: [], variants: [], masterUrl: '' });
    expect(pipeline.opts.onError).not.toHaveBeenCalled();
    expect(pipeline.isLunaActive()).toBe(true);
  });

  it("routes Luna's audio list and switches only while that Luna plays", async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pipeline = await pipelineFor(videoElement());
    expect(pipeline.lunaAudioTracks()).toEqual([]);
    await expect(pipeline.selectLunaAudio(1)).resolves.toBe(false);

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    const session = luna.sessions[0];
    session.onAudioTracks?.();

    expect(pipeline.opts.onAudioTracksUpdated).toHaveBeenCalledOnce();
    expect(pipeline.lunaAudioTracks()).toEqual([{ index: 0, language: 'l1', selected: true }]);
    await expect(pipeline.selectLunaAudio(1)).resolves.toBe(true);
    expect(session.selectAudio).toHaveBeenCalledWith(1);
    session.onFallback('error', 1);
    session.onAudioTracks?.();
    expect(pipeline.opts.onAudioTracksUpdated).toHaveBeenCalledOnce();
  });

  it("exposes Luna's playback clock only while Luna plays", async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    expect(pipeline.lunaClock()).toBeNull();

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    const clock = pipeline.lunaClock();

    expect(clock?.()).toBe(42);
    luna.sessions[0].onFallback('error', 1);
    expect(pipeline.lunaClock()).toBeNull();
    expect(clock?.()).toBe(video.currentTime);
  });

  it('routes a cached HLS route through Luna', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('application/vnd.apple.mpegurl');
    const pipeline = await pipelineFor(videoElement());

    pipeline.load('http://host/live/ch1', null, { headers: REFERER });

    await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
    expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=cache');
  });

  it.each([
    ['a User-Agent alone', { headers: { 'User-Agent': 'ua1' } }, null],
    ['no headers', {}, null],
    ['a DRM channel', { headers: REFERER },
      { drm: 'com.widevine.alpha', license: 'http://host/l' }],
  ])('keeps the video element for %s', async (_name, opts, drm) => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    const extras = drm
      ? { 'inputstream.adaptive.license_type': drm.drm, 'inputstream.adaptive.license_key': drm.license }
      : null;

    pipeline.load('http://host/a.m3u8', extras, opts);

    expect(luna.sessions).toHaveLength(0);
    expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');
    expect(logs.filter(line => line.includes('event=playback.luna.skipped')))
      .toEqual(drm ? [expect.stringContaining('load=1 reason=drm headers=referer')] : []);
  });

  it.each([['load_failed', 12]])(
    'falls back to the video element on %s and remembers it',
    async (reason, code) => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      const fetches = vi.mocked(fetch).mock.calls.length;
      vi.mocked(pipeline.opts.onPlaybackPathChange).mockImplementation(() => {
        expect(vi.mocked(fetch).mock.calls).toHaveLength(fetches);
      });
      luna.sessions[0].onFallback(reason, code, 'load');

      expect(pipeline.opts.onPlaybackPathChange).toHaveBeenCalledOnce();
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(fetches);
      expect(pipeline.isLunaActive()).toBe(false);
      expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');
      expect(logs.join('\n')).toContain(
        `event=playback.luna.fallback load=1 reason=${reason} code=${String(code)} stage=load`);
      expect(logs.join('\n')).toContain(
        'event=playback.path.native load=1 reason=luna_fallback format=hls');
      // The video element path reads the manifest for its tracks.
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].audio).toHaveLength(2);

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);
      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=2 reason=failed_before');
    },
  );

  it('notes a header channel that is not HLS once per load', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue('video/mp2t');
    const pipeline = await pipelineFor(videoElement());

    pipeline.load('http://host/a.ts', null, { headers: REFERER });
    pipeline.load('http://host/live/ch1', null, { headers: REFERER });
    await vi.waitFor(() => expect(logs.filter(line => line.includes('event=playback.luna.skipped')))
      .toHaveLength(2));

    expect(logs.filter(line => line.includes('event=playback.luna.skipped'))).toEqual([
      expect.stringContaining('load=1 reason=non_hls headers=referer'),
      expect.stringContaining('load=2 reason=non_hls headers=referer'),
    ]);
    expect(luna.sessions).toHaveLength(0);
  });

  it.each([['no_window', 0], ['timeout', 0], ['error', 1003]])(
    'retries Luna once after a transient %s fallback',
    async (reason, code) => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onFallback(reason, code);
      expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');
      expect(logs.join('\n')).toContain(
        `event=playback.luna.fallback load=1 reason=${reason} code=${String(code)}`);

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
      luna.sessions[1].onFallback(reason, code);

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
    },
  );

  it('keeps a recovery reload on the element after a Luna timeout', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    luna.sessions[0].onFallback('timeout', 0);

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER, reload: true });
    expect(luna.sessions).toHaveLength(1);
    expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');
    expect(logs.join('\n')).toContain('event=playback.luna.skipped load=2 reason=fell_back');

    // A new play tries Luna again, its second miss latching it off.
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    expect(luna.sessions).toHaveLength(2);
  });

  it('routes a header channel probed as HLS through Luna', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('',
      { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })));
    const pipeline = await pipelineFor(videoElement());

    pipeline.load('http://host/live/ch1', null, { headers: REFERER });

    await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
    expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=probe');
    expect(logs.join('\n')).not.toContain('event=playback.path.native');
  });

  it('logs the native path for a header channel probed as non-HLS', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    cacheMocks.setCachedStreamMime.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('',
      { headers: { 'content-type': 'video/mp2t' } })));
    const pipeline = await pipelineFor(videoElement());

    pipeline.load('http://host/live/ch1', null, { headers: REFERER });

    await vi.waitFor(() => expect(logs.join('\n')).toContain('event=playback.path.native load=1 reason=probe'));
    expect(luna.sessions).toHaveLength(0);
    expect(logs.filter(line => line.includes('event=playback.path.native')).join('\n'))
      .not.toContain('host');
  });

  it('tries Luna for a header channel whose probe is refused and falls back untyped', async () => {
    cacheMocks.getCachedStreamMime.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const video = videoElement();
    const pipeline = await pipelineFor(video);

    pipeline.load('http://host/live/ch1', null, { headers: REFERER });

    await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
    expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=guess');
    expect(logs.join('\n')).not.toContain('event=playback.path.native');
    // Luna plays it as HLS, so its master is read for audio names too.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    luna.sessions[0].onFallback('error', 5);
    const source = video.querySelector('source');
    expect(source?.src).toBe('http://host/live/ch1');
    expect(source?.getAttribute('type')).toBeNull();
  });

  it('keeps retrying Luna after a stream error once the channel has played', async () => {
    const pipeline = await pipelineFor(videoElement());
    for (let i = 0; i < 3; i++) {
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      const session = luna.sessions[luna.sessions.length - 1];
      session.onStarted?.();
      session.onFallback('error', 1003);
    }
    expect(luna.sessions).toHaveLength(3);
  });

  it('turns Luna off for the session after windows fail on several channels', async () => {
    const pipeline = await pipelineFor(videoElement());
    for (const url of ['http://host/a.m3u8', 'http://host/b.m3u8', 'http://host/c.m3u8']) {
      pipeline.load(url, null, { headers: REFERER });
      luna.sessions[luna.sessions.length - 1].onFallback('no_window', 0);
    }
    pipeline.load('http://host/d.m3u8', null, { headers: REFERER });
    expect(luna.sessions).toHaveLength(3);
    expect(logs.filter(line => line.includes('event=playback.luna.disabled'))).toEqual(
      [expect.stringContaining('load=3 reason=no_window count=3')]);
    expect(logs.join('\n')).toContain('event=playback.luna.skipped load=4 reason=latched_off headers=referer');
  });

  it('plays a header channel on the element when HTTP headers are off', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    pipeline.opts.headerPlayback = () => 'off';

    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

    expect(luna.sessions).toHaveLength(0);
    await vi.waitFor(() => expect(video.play).toHaveBeenCalled());
    expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=setting headers=referer');
    expect(pipeline.headersTurnedOff()).toBe(true);

    pipeline.opts.headerPlayback = () => 'luna';
    pipeline.load('http://host/b.m3u8', null, { headers: REFERER });
    expect(pipeline.headersTurnedOff()).toBe(false);
  });

  it('does not blame the off setting when Media service would skip Luna too', async () => {
    const pipeline = await pipelineFor(videoElement());
    pipeline.opts.headerPlayback = () => 'off';

    pipeline.load('https://host/a.m3u8', null, { headers: { Cookie: 'c=1' } });

    expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=setting headers=cookie');
    expect(pipeline.headersTurnedOff()).toBe(false);
  });

  it('withholds credentials from an https stream on the Luna path', async () => {
    const pipeline = await pipelineFor(videoElement());
    pipeline.load('https://host/a.m3u8', null, {
      headers: { Referer: 'http://host/', Cookie: 'c=1' },
    });
    expect(luna.sessions[0].headers).toEqual({ Referer: 'http://host/' });
    expect(logs.join('\n')).toContain(
      'event=playback.luna.tls.stripped load=1 headers=cookie path=luna');
    expect(logs.join('\n')).not.toContain('c=1');
  });

  it('keeps an https stream with only credentials on the video element', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    pipeline.load('https://host/a.m3u8', null, { headers: { Cookie: 'c=1' } });
    expect(luna.sessions).toHaveLength(0);
    expect(video.querySelector('source')?.src).toBe('https://host/a.m3u8');
    expect(logs.join('\n')).toContain(
      'event=playback.luna.tls.stripped load=1 headers=cookie path=native');
  });

  it('never uses Luna in a desktop browser', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const pipeline = await pipelineFor(videoElement());
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    await Promise.resolve();
    expect(luna.sessions).toHaveLength(0);
  });

  it('uses Luna on an older webOS engine too', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true, value: WEBOS_25.replace('Chrome/120', 'Chrome/53'),
    });
    const pipeline = await pipelineFor(videoElement());
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    expect(luna.sessions).toHaveLength(1);
  });

  describe('Local proxy', () => {
    const TOKEN = 'a'.repeat(32);
    const PROXIED = `http://127.0.0.1:1/p/${TOKEN}/http/host/a.m3u8`;
    const PROXIED_TS = `http://127.0.0.1:1/p/${TOKEN}/http/host/a.ts`;
    let opened: Array<(result: unknown) => void>;

    beforeEach(() => {
      opened = [];
      proxyService.openStreamProxy.mockReset();
      proxyService.closeStreamProxy.mockReset();
      proxyService.touchStreamProxy.mockReset();
      proxyService.touchStreamProxy.mockResolvedValue(null);
      proxyService.openStreamProxy.mockImplementation(() => new Promise(resolve => opened.push(resolve)));
    });

    async function proxyPipeline(video = videoElement()) {
      const pipeline = await pipelineFor(video);
      pipeline.opts.headerPlayback = () => 'proxy';
      return pipeline;
    }

    it('sends no header-less probe for a channel only the proxy can play', async () => {
      const probe = vi.fn().mockResolvedValue(new Response('', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }));
      vi.stubGlobal('fetch', probe);
      cacheMocks.getCachedStreamMime.mockResolvedValue(null);
      localStorage.setItem('iptv_luna_window_unsupported', JSON.stringify(navigator.userAgent));
      const latched = await proxyPipeline();
      latched.load('http://host/live/ch1', null, { headers: REFERER });
      await vi.waitFor(() => expect(proxyService.openStreamProxy).toHaveBeenCalledOnce());
      expect(probe).not.toHaveBeenCalled();

      // Media service needs the type, so a channel it will play is probed.
      localStorage.removeItem('iptv_luna_window_unsupported');
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/live/ch2', null, { headers: REFERER });
      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(probe).toHaveBeenCalledWith('http://host/live/ch2', expect.anything());
    });

    it.each([false, true])('gives a stream Media service skips once typed to the proxy, never to the bare element (cached=%s)', async cached => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      })));
      cacheMocks.getCachedStreamMime.mockResolvedValue(cached ? 'application/vnd.apple.mpegurl' : null);
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://host/live/ch1', {
        'inputstream.adaptive.license_type': 'com.microsoft.playready',
      }, { headers: REFERER });
      await vi.waitFor(() => expect(logs.join('\n'))
        .toMatch(/event=playback\.chain\.escalated load=1 from=luna to=proxy cause=luna_skipped/));
      opened[0]({ ok: true, url: PROXIED, token: TOKEN });

      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe(PROXIED));
      expect(video.play).toHaveBeenCalledOnce();
      expect(luna.sessions).toHaveLength(0);
    });

    it('tries Media service first, opening the proxy alongside it', async () => {
      const pipeline = await proxyPipeline();

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      expect(luna.sessions).toHaveLength(1);
      expect(proxyService.openStreamProxy).toHaveBeenCalledWith('http://host/a.m3u8',
        { ...REFERER, 'User-Agent': WEBOS_25 });
      opened[0]({ ok: true, url: PROXIED, token: TOKEN });
      luna.sessions[0].onStarted?.();

      await vi.waitFor(() => expect(proxyService.closeStreamProxy).toHaveBeenCalledWith(TOKEN));
      expect(pipeline.isProxied()).toBe(false);
    });

    it('moves a channel Media service cannot play to the proxy, and starts it there next time', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      opened[0]({ ok: true, url: PROXIED, token: TOKEN });

      luna.sessions[0].onFallback('error', 1003);

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(video.querySelector('source')?.src).toBe(PROXIED);
      expect(proxyService.openStreamProxy).toHaveBeenCalledOnce();
      expect(pipeline.isProxied()).toBe(true);
      const text = logs.join('\n');
      expect(text).toMatch(/event=playback\.chain\.escalated load=1 from=luna to=proxy cause=luna_error elapsedMs=\d+/);
      expect(text).toContain('Luna playback fell back to the local proxy event=playback.luna.fallback load=1 reason=error');
      expect(text).not.toContain('fell back to the video element');
      expect(text).toMatch(/event=playback\.proxy\.opened load=1 format=hls elapsedMs=\d+/);
      expect(text).toContain('event=playback.path.native load=1 via=proxy reason=url');
      expect(text).not.toContain('http://host/');
      expect(text).not.toContain(TOKEN);

      pipeline.notePlaying();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);
      expect(proxyService.openStreamProxy).toHaveBeenCalledTimes(2);
    });

    it('starts a Referer channel on Luna again after its headerless fallback played', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onFallback('error', 1003);
      expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');
      pipeline.notePlaying();

      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
    });

    it('escalates a Referer channel remembered on the element to Luna when the element fails', async () => {
      const { streamRouteKey } = await import('../utils/url');
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      (pipeline as unknown as { chainWinners: Map<string, string> }).chainWinners
        .set(streamRouteKey('http://host/a.m3u8'), 'video');
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(0);

      expect(pipeline.escalate()).toBe(true);
      expect(luna.sessions).toHaveLength(1);
      expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=url headers=referer');
    });

    it('keeps Media service when the setting stops there', async () => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });

      luna.sessions[0].onFallback('error', 1003);

      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('event=playback.path.native load=1 reason=luna_fallback');
    });

    it('stops escalating once the chain has run too long', async () => {
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1000);
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      now.mockReturnValue(1001 + CONFIG.PLAYER.HEADER_CHAIN_CAP_MS);

      luna.sessions[0].onFallback('timeout', 0);

      expect(logs.join('\n')).toContain('event=playback.chain.capped load=1 step=luna next=proxy');
      expect(logs.join('\n')).not.toContain('event=playback.chain.escalated');
      expect(pipeline.opts.onError).toHaveBeenCalledOnce();
    });

    it('plays a Widevine MPD with headers on Shaka through the proxy', async () => {
      const mpd = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>'
        + '<AdaptationSet contentType="video" mimeType="video/mp4">'
        + '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>'
        + '<Representation id="v1" codecs="avc1.640028"/></AdaptationSet></Period></MPD>';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd)));
      const pipeline = await proxyPipeline();
      const proxiedMpd = `http://127.0.0.1:1/p/${TOKEN}/http/host/a.mpd`;

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      opened[0]({ ok: true, url: proxiedMpd, token: TOKEN });

      await vi.waitFor(() => expect(pipeline.isMseActive()).toBe(true));
      expect(fetch).toHaveBeenCalledWith(proxiedMpd, expect.anything());
      expect(luna.sessions).toHaveLength(0);
      expect(logs.join('\n')).toContain('event=playback.chain.escalated load=1 from=luna to=proxy cause=drm_mse');
      expect(logs.join('\n')).toMatch(/event=playback\.proxy\.opened load=1 format=dash/);
    });

    it('opens the proxy first for a stream Media service cannot play, and never plays it without its Referer', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://host/a.ts', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(0);
      opened[0]({ ok: false, reason: 'timeout' });

      await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledOnce());
      expect(logs.join('\n')).toContain('event=playback.proxy.failed load=1 reason=timeout fallback=none');
      expect(video.querySelector('source')).toBeNull();
      expect(pipeline.escalate()).toBe(false);
    });

    it('names no next step when the proxy was the last one', async () => {
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/a.m3u8', null, { headers: { 'User-Agent': 'ua1' } });
      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(pipeline.escalate()).toBe(true);
      expect(luna.sessions).toHaveLength(1);

      luna.sessions[0].onFallback('error', 1003);
      opened[0]({ ok: false, reason: 'unavailable' });

      await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledOnce());
      expect(logs.join('\n')).toContain('event=playback.proxy.failed load=1 reason=unavailable fallback=none');
    });

    it('stops the old source before the new session opens', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);
      pipeline.load('http://host/b.m3u8', null);
      expect(video.querySelector('source')).not.toBeNull();

      pipeline.load('http://host/a.ts', null, { headers: REFERER });

      expect(opened).toHaveLength(1);
      expect(video.querySelector('source')).toBeNull();
      expect(video.load).toHaveBeenCalled();
    });

    it('drops a proxied source before its session closes', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);
      pipeline.load('http://host/a.ts', null, { headers: REFERER });
      opened[0]({ ok: true, url: PROXIED_TS, token: TOKEN });
      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe(PROXIED_TS));
      const attached: Array<string | undefined> = [];
      proxyService.closeStreamProxy.mockImplementation(() => {
        attached.push(video.querySelector('source')?.src);
      });

      pipeline.load('http://host/b.m3u8', null);

      expect(attached).toEqual([undefined]);
    });

    it('closes a session that opens after a newer load, and the current one on reload and destroy', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://host/a.ts', null, { headers: REFERER });
      pipeline.load('http://host/b.ts', null, { headers: REFERER });
      opened[0]({ ok: true, url: PROXIED_TS, token: 'stale' });
      await vi.waitFor(() => expect(proxyService.closeStreamProxy).toHaveBeenCalledWith('stale'));
      expect(video.querySelector('source')).toBeNull();

      opened[1]({ ok: true, url: PROXIED_TS.replace('a.ts', 'b.ts'), token: TOKEN });
      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(proxyService.closeStreamProxy).toHaveBeenCalledTimes(1);

      pipeline.load('http://host/b.ts', null, { headers: REFERER, reload: true });
      expect(proxyService.closeStreamProxy).toHaveBeenLastCalledWith(TOKEN);
      opened[2]({ ok: true, url: PROXIED_TS, token: 'next' });
      await vi.waitFor(() => expect(video.play).toHaveBeenCalledTimes(2));
      pipeline.destroy();
      expect(proxyService.closeStreamProxy).toHaveBeenLastCalledWith('next');
      expect(proxyService.closeStreamProxy).toHaveBeenCalledTimes(3);
    });

    it('keeps its session alive while the player holds it', async () => {
      vi.useFakeTimers();
      try {
        const video = videoElement();
        const pipeline = await proxyPipeline(video);
        pipeline.load('http://host/a.ts', null, { headers: REFERER });
        opened[0]({ ok: true, url: PROXIED_TS, token: TOKEN });
        await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());

        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL * 2);
        expect(proxyService.touchStreamProxy).toHaveBeenCalledTimes(2);
        expect(proxyService.touchStreamProxy).toHaveBeenCalledWith(TOKEN);

        const expired = vi.fn();
        pipeline.opts.onProxyExpired = expired;
        proxyService.touchStreamProxy.mockResolvedValue({ alive: false, lastStatus: 0, manifestStatus: 0, cookies: {} });
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL);
        expect(logs.join('\n')).toContain('event=playback.proxy.expired load=1');
        expect(expired).toHaveBeenCalledOnce();

        pipeline.destroy();
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL * 2);
        expect(proxyService.touchStreamProxy).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs the cookies a session did not keep once, when it ends', async () => {
      vi.useFakeTimers();
      try {
        const video = videoElement();
        const pipeline = await proxyPipeline(video);
        pipeline.load('http://host/a.ts', null, { headers: REFERER });
        opened[0]({ ok: true, url: PROXIED_TS, token: TOKEN });
        await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
        proxyService.touchStreamProxy.mockResolvedValue(
          { alive: true, lastStatus: 200, manifestStatus: 0, cookies: { domain: 1 } });
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL * 2);
        expect(logs.join('\n')).not.toContain('event=playback.proxy.cookie');
        proxyService.closeStreamProxy.mockResolvedValue({ domain: 2, https: 1 });

        pipeline.load('http://host/b.m3u8', null);
        await vi.waitFor(() => expect(logs.join('\n')).toContain('event=playback.proxy.cookie'));

        const events = logs.filter(line => line.includes('event=playback.proxy.cookie'));
        expect(events).toHaveLength(2);
        expect(events[0]).toContain('event=playback.proxy.cookie load=1 reason=domain count=2');
        expect(events[1]).toContain('event=playback.proxy.cookie load=1 reason=https count=1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('logs the last cookies a touch reported when the session expired or its close got no answer', async () => {
      vi.useFakeTimers();
      try {
        const video = videoElement();
        const pipeline = await proxyPipeline(video);
        pipeline.load('http://host/a.ts', null, { headers: REFERER });
        opened[0]({ ok: true, url: PROXIED_TS, token: TOKEN });
        await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
        proxyService.touchStreamProxy.mockResolvedValue(
          { alive: true, lastStatus: 200, manifestStatus: 0, cookies: { cap: 3 } });
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL);
        proxyService.touchStreamProxy.mockResolvedValue(
          { alive: false, lastStatus: 0, manifestStatus: 0, cookies: {} });
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL);
        expect(logs.join('\n')).toContain('event=playback.proxy.cookie load=1 reason=cap count=3');

        pipeline.load('http://host/a.ts', null, { headers: REFERER, reload: true });
        opened[1]({ ok: true, url: PROXIED_TS, token: 'b'.repeat(32) });
        await vi.waitFor(() => expect(video.play).toHaveBeenCalledTimes(2));
        proxyService.touchStreamProxy.mockResolvedValue(
          { alive: true, lastStatus: 200, manifestStatus: 0, cookies: { malformed: 1 } });
        await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_TOUCH_INTERVAL);
        proxyService.closeStreamProxy.mockResolvedValue(null);
        pipeline.destroy();
        await vi.waitFor(() => expect(logs.join('\n')).toContain('reason=malformed count=1'));
        expect(logs.filter(line => line.includes('event=playback.proxy.cookie'))).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a manifest an earlier step read and the proxy was refused, and stops there', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      opened[0]({ ok: true, url: PROXIED, token: TOKEN });
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalled());
      luna.sessions[0].onFallback('error', 1003);
      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe(PROXIED));
      let status: (value: unknown) => void = () => {};
      proxyService.touchStreamProxy.mockReturnValue(new Promise(resolve => { status = resolve; }));

      expect(pipeline.escalate()).toBe(false);

      expect(proxyService.touchStreamProxy).toHaveBeenCalledWith(TOKEN);
      expect(video.querySelector('source')?.src).toBe(PROXIED);
      status({ alive: true, lastStatus: 403, manifestStatus: 403, cookies: {} });
      await vi.waitFor(() => expect(logs.join('\n')).toContain('event=playback.chain.manifest_once'));
      const text = logs.join('\n');
      expect(text).toContain('event=playback.proxy.upstream load=1 last=403 manifest=403');
      expect(text).toContain('event=playback.chain.manifest_once load=1 step=proxy status=403 earlier=luna');
      expect(text).not.toContain('to=video');
    });

    it('proxies an http URL with user:password, and keeps the channel URL as the route key', async () => {
      cacheMocks.getCachedStreamMime.mockResolvedValue('application/vnd.apple.mpegurl');
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://u1:p1@host/live/ch1', null);
      expect(proxyService.openStreamProxy).toHaveBeenCalledOnce();
      opened[0]({ ok: true, url: `http://127.0.0.1:1/p/${TOKEN}/http/host/live/ch1`, token: TOKEN });

      await vi.waitFor(() => expect(video.play).toHaveBeenCalledOnce());
      expect(cacheMocks.getCachedStreamMime).toHaveBeenCalledWith('http://host/live');
      expect(logs.join('\n')).toContain('event=playback.proxy.opened load=1 format=unknown');
    });

    it('plays a User-Agent-only channel on the element, then Media service, then the proxy', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://host/a.m3u8', null, { headers: { 'User-Agent': 'ua1' } });
      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(video.querySelector('source')?.src).toBe('http://host/a.m3u8');

      expect(pipeline.escalate()).toBe(true);
      expect(luna.sessions).toHaveLength(1);
      expect(proxyService.openStreamProxy).toHaveBeenCalledOnce();
      opened[0]({ ok: true, url: PROXIED, token: TOKEN });
      luna.sessions[0].onFallback('error', 1003);

      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe(PROXIED));
      expect(pipeline.opts.onError).not.toHaveBeenCalled();
    });

    it('leaves https credential-only channels off the proxy', async () => {
      const pipeline = await proxyPipeline();

      pipeline.load('https://host/a.m3u8', null, { headers: { Cookie: 'c=1' } });
      pipeline.load('https://u1:p1@host/a.m3u8', null);

      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(pipeline.escalate()).toBe(false);
    });

    it('has a step to escalate to only while one is left and the cap has not passed', async () => {
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1000);
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(pipeline.canEscalate()).toBe(true);

      now.mockReturnValue(1001 + CONFIG.PLAYER.HEADER_CHAIN_CAP_MS);
      expect(pipeline.canEscalate()).toBe(false);

      now.mockReturnValue(2000);
      pipeline.load('http://host/a.ts', null, { headers: REFERER });
      expect(pipeline.canEscalate()).toBe(false);
    });

    it('counts a proxy step as pending until its session opens', async () => {
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(pipeline.isProxyPending()).toBe(false);

      luna.sessions[0].onFallback('error', 1003);
      expect(pipeline.isProxyPending()).toBe(true);

      opened[0]({ ok: true, url: PROXIED, token: TOKEN });
      await vi.waitFor(() => expect(pipeline.isProxied()).toBe(true));
      expect(pipeline.isProxyPending()).toBe(false);

      // A stream Luna cannot take starts at the proxy.
      pipeline.load('http://host/b.ts', null, { headers: REFERER });
      expect(pipeline.isProxyPending()).toBe(true);
    });

    it('moves a Luna stream that played, then failed, to the proxy', async () => {
      const video = videoElement();
      const pipeline = await proxyPipeline(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onStarted?.();
      await vi.waitFor(() => expect(proxyService.openStreamProxy).toHaveBeenCalledOnce());

      const restarted = vi.fn();
      pipeline.opts.onStepRestarted = restarted;
      expect(luna.sessions[0].onPlaybackError?.(1003)).toBe(true);
      expect(luna.sessions[0].destroy).toHaveBeenCalled();
      expect(restarted).toHaveBeenCalledOnce();
      expect(pipeline.opts.onPlaybackPathChange).toHaveBeenCalled();
      opened[1]({ ok: true, url: PROXIED, token: TOKEN });

      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe(PROXIED));
      expect(pipeline.opts.onError).not.toHaveBeenCalled();
      const text = logs.join('\n');
      expect(text).toMatch(/event=playback\.chain\.escalated load=1 from=luna to=proxy cause=luna_played_error/);
      expect(text).not.toContain('event=playback.luna.fallback');

      // The proxy, not Luna, wins the route once it plays.
      pipeline.notePlaying();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);
    });

    it('leaves a played Luna stream that failed in Media service mode to the reconnect', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onStarted?.();

      expect(luna.sessions[0].onPlaybackError?.(1003)).toBe(false);
      expect(luna.sessions[0].destroy).not.toHaveBeenCalled();
      expect(video.querySelector('source')).toBeNull();
      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(logs.join('\n')).not.toContain('event=playback.chain.escalated');
    });

    it('starts a User-Agent-only channel Luna cannot take on the element, whatever its MIME', async () => {
      localStorage.setItem('iptv_luna_window_unsupported', JSON.stringify(navigator.userAgent));
      cacheMocks.getCachedStreamMime.mockResolvedValue('video/mp2t');
      const video = videoElement();
      const pipeline = await proxyPipeline(video);

      pipeline.load('http://host/live/ch1', null, { headers: { 'User-Agent': 'ua1' } });

      await vi.waitFor(() => expect(video.querySelector('source')?.src).toBe('http://host/live/ch1'));
      expect(proxyService.openStreamProxy).not.toHaveBeenCalled();
      expect(logs.join('\n')).not.toContain('event=playback.chain.escalated');
    });

    it('names a Luna step this load already tried, not a remembered one, when it skips Luna', async () => {
      const pipeline = await proxyPipeline();
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      const internals = pipeline as unknown as {
        chain: { step: string; tried: string[] };
        lunaSkipToken: number;
        lunaHeaders(url: string, headers: Record<string, string>, extras: null, token: number): unknown;
      };
      internals.chain.step = 'video';
      internals.chain.tried = ['luna', 'proxy', 'video'];
      internals.lunaSkipToken = -1;

      expect(internals.lunaHeaders('http://host/a.m3u8', REFERER, null, pipeline.currentLoadToken())).toBeNull();

      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=tried headers=referer');
    });
  });

  describe('Luna without a window lookup', () => {
    beforeEach(() => {
      proxyService.openStreamProxy.mockReset();
      proxyService.openStreamProxy.mockReturnValue(new Promise(() => {}));
    });

    it('marks a load that can escalate as a header chain, but not one the setting keeps on the element', async () => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.opts.headerPlayback = () => 'proxy';
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(pipeline.isHeaderChain()).toBe(true);

      pipeline.opts.headerPlayback = () => 'off';
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(pipeline.isHeaderChain()).toBe(false);

      pipeline.load('http://host/a.m3u8', null, {});
      expect(pipeline.isHeaderChain()).toBe(false);
    });

    it('marks a load left with only the proxy step as a header chain', async () => {
      localStorage.setItem('iptv_luna_window_unsupported', JSON.stringify(navigator.userAgent));
      const pipeline = await pipelineFor(videoElement());
      pipeline.opts.headerPlayback = () => 'proxy';
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(pipeline.isProxyPending()).toBe(true);
      expect(pipeline.canEscalate()).toBe(false);
      expect(pipeline.isHeaderChain()).toBe(true);
    });

    it('latches a firmware that answered it has no window lookup, and skips Luna on the next launch', async () => {
      const first = await pipelineFor(videoElement());
      first.opts.headerPlayback = () => 'proxy';
      first.load('http://host/a.m3u8', null, { headers: REFERER });

      luna.sessions[0].onFallback('no_window', -1, 'app_info', true);

      expect(logs.filter(line => line.includes('event=playback.luna.window_unsupported')))
        .toEqual([expect.stringContaining('event=playback.luna.window_unsupported load=1 stage=app_info code=-1')]);
      expect(logs.join('\n')).toContain('event=playback.chain.escalated load=1 from=luna to=proxy');

      vi.resetModules();
      const proxied = await pipelineFor(videoElement());
      proxied.opts.headerPlayback = () => 'proxy';
      proxied.load('http://host/b.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);
      expect(proxyService.openStreamProxy).toHaveBeenCalledTimes(2);
      expect(logs.filter(line => line.includes('reason=no_window_latched')))
        .toEqual([expect.stringContaining('event=playback.luna.skipped load=1 reason=no_window_latched headers=referer')]);

      vi.resetModules();
      const video = videoElement();
      const next = await pipelineFor(video);
      next.load('http://host/c.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);
      expect(video.querySelector('source')?.src).toBe('http://host/c.m3u8');
      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=no_window_latched');
      expect(logs.filter(line => line.includes('event=playback.luna.window_unsupported'))).toHaveLength(1);
    });

    it('tries Luna again under another user agent', async () => {
      const first = await pipelineFor(videoElement());
      first.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onFallback('no_window', -1, 'app_info', true);

      vi.resetModules();
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: WEBOS_25.replace('120', '121') });
      const next = await pipelineFor(videoElement());
      next.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
    });

    it('tries Luna again once the header playback setting changes', async () => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onFallback('no_window', -1, 'app_info', true);
      pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(1);

      const { StorageService } = await import('../services/storage-service');
      StorageService.setHeaderPlayback('proxy');
      StorageService.setHeaderPlayback('luna');
      pipeline.load('http://host/b.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
    });

    it('keeps a transient window miss to this launch', async () => {
      const first = await pipelineFor(videoElement());
      first.load('http://host/a.m3u8', null, { headers: REFERER });
      luna.sessions[0].onFallback('no_window', -1, 'app_info');

      vi.resetModules();
      const next = await pipelineFor(videoElement());
      next.load('http://host/a.m3u8', null, { headers: REFERER });
      expect(luna.sessions).toHaveLength(2);
      expect(logs.join('\n')).not.toContain('event=playback.luna.window_unsupported');
    });
  });

  describe('User-Agent-only retry', () => {
    const UA = { 'User-Agent': 'ua1' };

    it('retries a failed User-Agent-only load once through Luna', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      expect(luna.sessions).toHaveLength(0);
      const fetches = vi.mocked(fetch).mock.calls.length;
      vi.mocked(pipeline.opts.onPlaybackPathChange).mockImplementation(() => {
        expect(vi.mocked(fetch).mock.calls).toHaveLength(fetches);
      });

      expect(pipeline.escalate()).toBe(true);

      expect(pipeline.opts.onPlaybackPathChange).toHaveBeenCalledOnce();
      expect(luna.sessions).toHaveLength(1);
      expect(luna.sessions[0]).toMatchObject({ uri: 'http://host/a.m3u8', headers: UA });
      expect(logs.join('\n')).toContain('event=playback.luna.fallback load=1 reason=ua_only');
      expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=ua_only');
      expect(pipeline.escalate()).toBe(false);
      expect(luna.sessions).toHaveLength(1);
    });

    it('blames the off setting when it blocks the User-Agent retry', async () => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.opts.headerPlayback = () => 'off';
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      expect(pipeline.headersTurnedOff()).toBe(false);

      expect(pipeline.escalate()).toBe(false);

      expect(luna.sessions).toHaveLength(0);
      expect(pipeline.headersTurnedOff()).toBe(true);
    });

    it('surfaces the error when the Luna retry fails too', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      pipeline.escalate();
      video.innerHTML = '';

      luna.sessions[0].onFallback('error', 1003);

      expect(pipeline.opts.onError).toHaveBeenCalledOnce();
      expect(video.querySelector('source')).toBeNull();
      expect(pipeline.escalate()).toBe(false);
    });

    it('does not log the failed element play() the Luna placeholder aborts', async () => {
      const video = videoElement();
      let reject: (error: Error) => void = () => {};
      vi.mocked(video.play).mockReturnValueOnce(new Promise((_resolve, rejectPlay) => {
        reject = rejectPlay;
      }));
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      pipeline.escalate();

      // The placeholder's load() interrupts the element's pending play().
      reject(new DOMException('interrupted by a new load request', 'AbortError'));
      await Promise.resolve();
      await Promise.resolve();

      expect(logs.join('\n')).not.toContain('event=playback.play.rejected');
    });

    it('still logs a rejected play() of the current element source', async () => {
      const video = videoElement();
      vi.mocked(video.play).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      await Promise.resolve();
      await Promise.resolve();

      expect(logs.join('\n')).toContain('event=playback.play.rejected load=1 path=native');
    });

    it.each([
      ['no headers', {}, null],
      ['a DRM channel', UA, { 'inputstream.adaptive.license_type': 'com.widevine.alpha',
        'inputstream.adaptive.license_key': 'http://host/l' }],
    ])('does not retry %s', async (_name, headers, extras) => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.m3u8', extras, { headers });
      expect(pipeline.escalate()).toBe(false);
      expect(luna.sessions).toHaveLength(0);
    });

    it('does not retry a stream Luna already failed this session', async () => {
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      pipeline.escalate();
      luna.sessions[0].onFallback('load_failed', 12);

      pipeline.load('http://host/a.m3u8', null, { headers: UA });
      expect(pipeline.escalate()).toBe(false);
      expect(luna.sessions).toHaveLength(1);
    });
  });

  it('ignores a fallback from a superseded session', async () => {
    const video = videoElement();
    const pipeline = await pipelineFor(video);
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    const first = luna.sessions[0];
    pipeline.load('http://host/b.m3u8', null, { headers: REFERER });

    expect(first.destroy).toHaveBeenCalled();
    first.onFallback('timeout', 0);

    expect(logs.join('\n')).not.toContain('event=playback.luna.fallback');
    expect(pipeline.isLunaActive()).toBe(true);
    expect(video.querySelector('source')).toBeNull();
  });

  it('moves the picture with the presentation and ends it on destroy', async () => {
    const pipeline = await pipelineFor(videoElement());
    const rect = { x: 0, y: 0, width: 640, height: 360 };
    pipeline.setLunaDisplay(rect);
    pipeline.load('http://host/a.m3u8', null, { headers: REFERER });
    expect(luna.sessions[0].setDisplay).toHaveBeenLastCalledWith(rect);

    pipeline.setLunaDisplay('full');
    expect(luna.sessions[0].setDisplay).toHaveBeenLastCalledWith('full');

    pipeline.destroy();
    expect(luna.sessions[0].destroy).toHaveBeenCalledOnce();
    expect(pipeline.isLunaActive()).toBe(false);
  });

  describe('DASH', () => {
    const PLAYREADY_SCHEME = '9a04f079-9840-4286-ab92-e65be0885f95';
    const WIDEVINE_SCHEME = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
    const mpd = (scheme = '') => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      ${scheme ? `<ContentProtection schemeIdUri="urn:uuid:${scheme}"/>` : ''}
      <Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="l1" label="Track 1">
      <Representation id="a1" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1" label="Track 1">
      <Representation id="s1"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" lang="l2" label="Track 2">
      <Representation id="s2" codecs="stpp"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    const PLAYREADY_EXTRAS = {
      'inputstream.adaptive.license_type': 'com.microsoft.playready',
      'inputstream.adaptive.license_key': 'http://host/license',
    };
    let drmCalls: string[];
    // How the DRM service answers load: a client, an error, or later.
    let drmLoad: 'ok' | 'fail' | 'hold';
    let heldDrmLoads: Array<() => void>;

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd())));
      drmCalls = [];
      drmLoad = 'ok';
      heldDrmLoads = [];
      const calls = drmCalls;
      const held = heldDrmLoads;
      class FakePalmServiceBridge {
        onservicecallback: ((message: string) => void) | null = null;

        call(uri: string): void {
          const method = uri.slice(uri.lastIndexOf('/') + 1);
          calls.push(method);
          const reply = method === 'load'
            ? drmLoad === 'fail' ? { returnValue: false } : { returnValue: true, clientId: 'client-1' }
            : method === 'sendDrmMessage' ? { returnValue: true, resultCode: 0, msgId: 'msg-1' }
              : { returnValue: true };
          const send = () => this.onservicecallback?.(JSON.stringify(reply));
          if (method === 'load' && drmLoad === 'hold') held.push(send);
          else send();
        }

        cancel(): void {
          this.onservicecallback = null;
        }
      }
      Object.defineProperty(window, 'PalmServiceBridge', {
        configurable: true,
        value: FakePalmServiceBridge,
      });
    });

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).PalmServiceBridge;
    });

    it('plays a clear MPD with headers through Luna after reading it header-less', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      expect(luna.sessions).toHaveLength(0);
      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0]).toMatchObject({
        uri: 'http://host/a.mpd', headers: REFERER, transport: 'MPEG-DASH', playReadyClientId: undefined,
      });
      expect(video.querySelector('source')).toBeNull();
      expect(logs.join('\n')).toContain(
        'event=playback.path.luna load=1 reason=url headers=referer format=dash drm=none');
      // The compositor rendition stays too: it toggles Luna's own pipeline.
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      const manifest = vi.mocked(pipeline.opts.onManifest).mock.calls[0][0];
      expect(manifest.subtitles).toEqual([
        expect.objectContaining({ lang: 'l1' }),
        expect.objectContaining({ lang: 'l2', dash: { kind: 'native' } }),
      ]);
      expect(manifest.audio).toHaveLength(1);
      expect(logs.join('\n')).not.toContain('event=subtitles.luna.unavailable');
      expect(fetch).toHaveBeenCalledOnce();
      expect(logs.join('\n')).not.toContain('http://host/');
    });

    it('routes a cached DASH route through Luna', async () => {
      cacheMocks.getCachedStreamMime.mockResolvedValue('application/dash+xml');
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/live/ch1', null, { headers: REFERER });

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0]).toMatchObject({ transport: 'MPEG-DASH' });
      expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=cache');
    });

    it('loads Luna as configured when the MPD is refused', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0]).toMatchObject({ transport: 'MPEG-DASH' });
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalled());
      expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].subtitles).toEqual([]);
    });

    it('reads a refused MPD through the service before the Luna load', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      manifestService.fetchManifestViaService.mockResolvedValue(
        { ok: true, status: 200, url: 'http://host/b/a.mpd', text: mpd() });
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      // A shorter budget: the Luna load waits on this read.
      expect(manifestService.fetchManifestViaService).toHaveBeenCalledExactlyOnceWith(
        'http://host/a.mpd', { ...REFERER, 'User-Agent': WEBOS_25 },
        expect.objectContaining({ maxBytes: 1024 * 1024, timeoutMs: 2500, graceMs: 500 }));
      // Read, so its DRM is known.
      expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=url headers=referer format=dash drm=none');
      expect(logs.join('\n')).not.toContain('mpd=unreadable');
      expect(logs.join('\n')).toContain('event=playback.luna.manifest.service load=1 outcome=ok page=http_403');
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      expect(vi.mocked(pipeline.opts.onManifest).mock.calls[0][0].subtitles).toHaveLength(2);
    });

    it('drops WebVTT a service-read live MPD lists in a SegmentTimeline, which never refreshes', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      const timeline = mpd().replace('<Representation id="s1"/>', `<SegmentTemplate media="s-$Time$.vtt">
        <SegmentTimeline><S t="0" d="4" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="s1"/>`);
      manifestService.fetchManifestViaService.mockResolvedValue(
        { ok: true, status: 200, url: 'http://host/b/a.mpd', text: timeline });
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());
      const manifest = vi.mocked(pipeline.opts.onManifest).mock.calls[0][0];
      // The native rendition rides the compositor and needs no MPD re-read.
      expect(manifest.subtitles).toEqual([expect.objectContaining({ lang: 'l2', dash: { kind: 'native' } })]);
      expect(manifest.masterText).toBe(timeline);
      expect(logs.filter(line => line.includes('event=subtitles.luna.unavailable'))).toEqual([
        expect.stringContaining('load=1 stage=manifest reason=dynamic_mpd'),
      ]);
    });

    it('keeps the service-read MPD text and live filter when Luna falls back to the element', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      const timeline = mpd().replace('<Representation id="s1"/>', `<SegmentTemplate media="s-$Time$.vtt">
        <SegmentTimeline><S t="0" d="4" r="2"/></SegmentTimeline></SegmentTemplate><Representation id="s1"/>`);
      manifestService.fetchManifestViaService.mockResolvedValue(
        { ok: true, status: 200, url: 'http://host/b/a.mpd', text: timeline });
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());

      luna.sessions[0].onFallback('error', 1003);

      expect(pipeline.opts.onManifest).toHaveBeenCalledTimes(2);
      const manifest = vi.mocked(pipeline.opts.onManifest).mock.calls[1][0];
      expect(manifest.subtitles).toEqual([expect.objectContaining({ lang: 'l2', dash: { kind: 'native' } })]);
      expect(manifest.masterUrl).toBe('http://host/b/a.mpd');
      expect(manifest.masterText).toBe(timeline);
      // Only the Luna read reports; the element plays the fallback.
      expect(logs.filter(line => line.includes('reason=dynamic_mpd'))).toHaveLength(1);
    });

    it('neither loads Luna nor reports when the channel changes while the service reads the MPD', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      let answer: (result: unknown) => void = () => {};
      manifestService.fetchManifestViaService.mockReturnValueOnce(
        new Promise(resolve => { answer = resolve; }));
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      await vi.waitFor(() => expect(manifestService.fetchManifestViaService).toHaveBeenCalledOnce());

      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      pipeline.load('http://host/b.m3u8', null);
      answer({ ok: true, status: 200, url: 'http://host/a.mpd', text: mpd() });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(luna.sessions).toHaveLength(0);
      expect(pipeline.opts.onManifest).not.toHaveBeenCalled();
      expect(logs.join('\n')).not.toContain('event=playback.luna.manifest.service');
      expect(logs.join('\n')).not.toContain('event=playback.path.luna');
    });

    it.each([
      ['configured', PLAYREADY_EXTRAS, ''],
      ['detected', null, PLAYREADY_SCHEME],
    ])('prepares %s PlayReady before the Luna load', async (_name, extras, scheme) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(scheme))));
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', extras, { headers: REFERER });

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(drmCalls).toContain('load');
      expect(luna.sessions[0]).toMatchObject({ transport: 'MPEG-DASH', playReadyClientId: 'client-1' });
      expect(pipeline.drmLabel()).toBe('PlayReady');
      expect(logs.join('\n')).toContain('event=playback.dash.drm.ready load=1');
      expect(logs.join('\n')).toContain('format=dash drm=playready');
      expect(logs.join('\n')).not.toContain('http://host/license');
    });

    it('releases the Luna PlayReady client and prepares a fresh one for the element', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', PLAYREADY_EXTRAS, { headers: REFERER });
      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      drmCalls.length = 0;

      luna.sessions[0].onFallback('error', 1003);

      expect(drmCalls[0]).toBe('unload');
      expect(pipeline.drmLabel()).toBe('');
      await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
      expect(drmCalls).toContain('load');
      expect(drmCalls.filter(call => call === 'unload')).toHaveLength(1);
      const { parseMediaOption } = await import('../utils/webos-media-option');
      expect(parseMediaOption(video.querySelector('source')?.type ?? '')).toMatchObject({
        mediaTransportType: 'MPEG-DASH',
        option: { drm: { type: 'playready', clientId: 'client-1' } },
      });
      expect(pipeline.drmLabel()).toBe('PlayReady');
      expect(luna.sessions).toHaveLength(1);
    });

    it('keeps a configured Widevine MPD on Shaka', async () => {
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', {
        'inputstream.adaptive.license_type': 'com.widevine.alpha',
        'inputstream.adaptive.license_key': 'http://host/license',
      }, { headers: REFERER });

      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=drm_mse headers=referer');
      expect(luna.sessions).toHaveLength(0);
    });

    it('keeps an MPD that declares Widevine on Shaka', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(WIDEVINE_SCHEME))));
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(logs.join('\n')).toContain(
        'event=playback.path.native load=1 reason=drm_mse format=dash'));
      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=1 reason=drm_mse headers=referer');
      expect(luna.sessions).toHaveLength(0);
      expect(pipeline.isMseActive()).toBe(true);
    });

    it('keeps an MPD with an unknown DRM scheme off Luna', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd('00000000-0000-0000-0000-000000000001'))));
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onError).toHaveBeenCalledWith('unsupported'));
      expect(logs.join('\n')).toContain(
        'event=playback.luna.skipped load=1 reason=drm_unsupported headers=referer');
      expect(luna.sessions).toHaveLength(0);
    });

    it('withholds credentials from an https MPD on the Luna path', async () => {
      const pipeline = await pipelineFor(videoElement());

      pipeline.load('https://host/a.mpd', null, { headers: { Referer: 'http://host/', Cookie: 'c=1' } });

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0].headers).toEqual({ Referer: 'http://host/' });
      expect(logs.join('\n')).toContain('event=playback.luna.tls.stripped load=1 headers=cookie path=luna');
    });

    it('retries a failed User-Agent-only MPD once through Luna DASH', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', null, { headers: { 'User-Agent': 'ua1' } });
      await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
      expect(luna.sessions).toHaveLength(0);

      expect(pipeline.escalate()).toBe(true);

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0]).toMatchObject({ transport: 'MPEG-DASH', headers: { 'User-Agent': 'ua1' } });
      expect(logs.join('\n')).toContain('event=playback.path.luna load=1 reason=ua_only');
      luna.sessions[0].onFallback('error', 1003);
      expect(pipeline.opts.onError).toHaveBeenCalledOnce();
    });

    it('drops the failed element source and its PlayReady client before the User-Agent-only retry', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', PLAYREADY_EXTRAS, { headers: { 'User-Agent': 'ua1' } });
      await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
      expect(pipeline.drmLabel()).toBe('PlayReady');
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      drmCalls.length = 0;

      expect(pipeline.escalate()).toBe(true);

      expect(video.querySelector('source')).toBeNull();
      expect(drmCalls).toEqual(['unload']);
      expect(pipeline.drmLabel()).toBe('');
    });

    it('does not log the failed element play() the User-Agent-only MPD retry aborts', async () => {
      const video = videoElement();
      let reject: (error: Error) => void = () => {};
      vi.mocked(video.play).mockReturnValueOnce(new Promise((_resolve, rejectPlay) => {
        reject = rejectPlay;
      }));
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', null, { headers: { 'User-Agent': 'ua1' } });
      await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      pipeline.escalate();

      // The retry's load() interrupts the element's pending play() while the MPD read waits.
      reject(new DOMException('interrupted by a new load request', 'AbortError'));
      await Promise.resolve();
      await Promise.resolve();

      expect(logs.join('\n')).not.toContain('event=playback.play.rejected');
    });

    it('does not retry a User-Agent-only MPD on Shaka through Luna', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(WIDEVINE_SCHEME))));
      const pipeline = await pipelineFor(videoElement());
      pipeline.load('http://host/a.mpd', null, { headers: { 'User-Agent': 'ua1' } });
      await vi.waitFor(() => expect(pipeline.isMseActive()).toBe(true));

      expect(pipeline.escalate()).toBe(false);

      expect(luna.sessions).toHaveLength(0);
      expect(logs.join('\n')).not.toContain('reason=ua_only');
    });

    it('retries an MPD unreadable without headers once as PlayReady', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
      expect(luna.sessions[0].playReadyClientId).toBeUndefined();
      expect(logs.join('\n')).toContain(
        'event=playback.path.luna load=1 reason=url headers=referer format=dash drm=unknown mpd=unreadable');

      luna.sessions[0].onFallback('load_failed', 12, 'load');

      await vi.waitFor(() => expect(luna.sessions).toHaveLength(2));
      expect(luna.sessions[1]).toMatchObject({ transport: 'MPEG-DASH', playReadyClientId: 'client-1' });
      expect(logs.join('\n')).toContain(
        'event=playback.luna.drm.retry load=1 reason=load_failed code=12 stage=load drm=playready');
      expect(logs.join('\n')).toContain(
        'event=playback.path.luna load=1 reason=url headers=referer format=dash drm=playready');
      // Re-arms the startup watchdog over the restored element.
      expect(pipeline.opts.onPlaybackPathChange).toHaveBeenCalledOnce();
      expect(video.querySelector('source')).toBeNull();

      luna.sessions[1].onFallback('load_failed', 12, 'load');

      expect(logs.filter(line => line.includes('event=playback.luna.drm.retry'))).toHaveLength(1);
      await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
      expect(luna.sessions).toHaveLength(2);
      expect(fetch).toHaveBeenCalledOnce();
      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      expect(logs.join('\n')).toContain('event=playback.luna.skipped load=2 reason=failed_before');
    });

    describe('guessed PlayReady retry', () => {
      async function unreadable() {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
        const video = videoElement();
        const pipeline = await pipelineFor(video);
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
        return { video, pipeline };
      }

      it('falls back to the element when the guessed client cannot load', async () => {
        const { video, pipeline } = await unreadable();
        drmLoad = 'fail';

        luna.sessions[0].onFallback('load_failed', 12, 'load');

        await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
        expect(pipeline.opts.onError).not.toHaveBeenCalled();
        expect(pipeline.opts.onPlaybackPathChange).toHaveBeenCalledTimes(2);
        expect(logs.join('\n')).toContain(
          'event=playback.luna.fallback load=1 reason=load_failed code=12 stage=load');
        expect(luna.sessions).toHaveLength(1);
      });

      it('loads PlayReady up front when a reload supersedes the retry', async () => {
        const { video, pipeline } = await unreadable();
        drmLoad = 'hold';

        luna.sessions[0].onFallback('load_failed', 12, 'load');
        await vi.waitFor(() => expect(heldDrmLoads).toHaveLength(1));
        drmLoad = 'ok';
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });
        // The superseded load unloads its client before the reload's load,
        // which the service answers with the same clientId.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(drmCalls.filter(method => method === 'load')).toHaveLength(1);
        heldDrmLoads[0]();

        await vi.waitFor(() => expect(luna.sessions).toHaveLength(2));
        expect(drmCalls.filter(method => method === 'load' || method === 'unload'))
          .toEqual(['load', 'unload', 'load']);
        expect(luna.sessions[1].playReadyClientId).toBe('client-1');
        expect(logs.join('\n')).not.toContain('reason=failed_before');

        luna.sessions[1].onFallback('load_failed', 12, 'load');
        await vi.waitFor(() => expect(video.querySelector('source')).not.toBeNull());
        expect(logs.filter(line => line.includes('event=playback.luna.drm.retry'))).toHaveLength(1);
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });
        expect(logs.join('\n')).toContain('event=playback.luna.skipped load=3 reason=failed_before');
        expect(luna.sessions).toHaveLength(2);
      });

      it('keeps a clear load_failed when the retry fails transiently', async () => {
        const { pipeline } = await unreadable();
        luna.sessions[0].onFallback('load_failed', 12, 'load');
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(2));

        luna.sessions[1].onFallback('error', 1003, 'playback');
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });

        expect(logs.join('\n')).toContain('event=playback.luna.skipped load=2 reason=failed_before');
      });

      it('loads a URL whose guess played as PlayReady up front next time', async () => {
        const { pipeline } = await unreadable();
        luna.sessions[0].onFallback('load_failed', 12, 'load');
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(2));
        luna.sessions[1].onStarted?.();

        pipeline.load('http://host/a.mpd', null, { headers: REFERER });

        await vi.waitFor(() => expect(luna.sessions).toHaveLength(3));
        expect(luna.sessions[2].playReadyClientId).toBe('client-1');
        expect(pipeline.drmLabel()).toBe('PlayReady');

        luna.sessions[2].onFallback('error', 1003, 'playback');
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(4));
        expect(luna.sessions[3].playReadyClientId).toBeUndefined();
      });

      it('does not claim PlayReady when the clear load only failed transiently', async () => {
        const { pipeline } = await unreadable();

        luna.sessions[0].onFallback('error', 1003, 'playback');

        await vi.waitFor(() => expect(luna.sessions).toHaveLength(2));
        expect(luna.sessions[1].playReadyClientId).toBe('client-1');
        expect(pipeline.drmLabel()).toBe('');
      });

      it('stays pending while the guessed client prepares, so suspend unloads it', async () => {
        const { pipeline } = await unreadable();
        drmLoad = 'hold';

        luna.sessions[0].onFallback('error', 1003, 'playback');
        await vi.waitFor(() => expect(heldDrmLoads).toHaveLength(1));

        expect(pipeline.isLunaActive()).toBe(false);
        expect(pipeline.isLunaPending()).toBe(true);
        pipeline.destroy();
        expect(pipeline.isLunaPending()).toBe(false);
        heldDrmLoads[0]();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(luna.sessions).toHaveLength(1);
      });

      it('stays pending while the MPD is read, so suspend unloads it', async () => {
        let release: (response: Response) => void = () => {};
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
        const pipeline = await pipelineFor(videoElement());

        pipeline.load('http://host/a.mpd', null, { headers: REFERER });

        expect(pipeline.isLunaActive()).toBe(false);
        expect(pipeline.isLunaPending()).toBe(true);
        pipeline.destroy();
        expect(pipeline.isLunaPending()).toBe(false);
        release(new Response(mpd('')));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(luna.sessions).toHaveLength(0);

        vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(''))));
        pipeline.load('http://host/a.mpd', null, { headers: REFERER });
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
        expect(pipeline.isLunaPending()).toBe(false);
      });

      it('stays pending while a detected PlayReady client prepares', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(PLAYREADY_SCHEME))));
        drmLoad = 'hold';
        const pipeline = await pipelineFor(videoElement());

        pipeline.load('http://host/a.mpd', null, { headers: REFERER });

        await vi.waitFor(() => expect(heldDrmLoads).toHaveLength(1));
        expect(pipeline.isLunaPending()).toBe(true);
        heldDrmLoads[0]();
        await vi.waitFor(() => expect(luna.sessions).toHaveLength(1));
        expect(pipeline.isLunaPending()).toBe(false);
      });
    });

    it('reuses the MPD read when Luna DASH falls back to the element', async () => {
      const video = videoElement();
      const pipeline = await pipelineFor(video);
      pipeline.load('http://host/a.mpd', null, { headers: REFERER });
      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledOnce());

      luna.sessions[0].onFallback('error', 1003);

      expect(video.querySelector('source')).not.toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
      expect(pipeline.opts.onManifest).toHaveBeenCalledTimes(2);
      expect(vi.mocked(pipeline.opts.onManifest).mock.calls[1][0].subtitles).toHaveLength(2);
    });

    it('holds the MPD once when the manifest handler throws', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(mpd(PLAYREADY_SCHEME))));
      const pipeline = await pipelineFor(videoElement());
      vi.mocked(pipeline.opts.onManifest).mockImplementationOnce(() => { throw new Error('boom'); });

      pipeline.load('http://host/a.mpd', null, { headers: REFERER });

      await vi.waitFor(() => expect(pipeline.opts.onManifest).toHaveBeenCalledTimes(2));
      expect(luna.sessions).toHaveLength(1);
      expect(luna.sessions[0].destroy).not.toHaveBeenCalled();
      expect(drmCalls.filter(call => call === 'load')).toHaveLength(1);
    });
  });
});
