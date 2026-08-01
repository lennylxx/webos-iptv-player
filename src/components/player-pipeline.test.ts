// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import type { PlayerPipelineOptions } from './player-pipeline';
import { PlayerPipeline } from './player-pipeline';

type HlsListener = (event: string, data?: {
  fatal?: boolean;
  type?: string;
  details?: string;
}) => void;

class FakeLoader {}

class FakeHls {
  static readonly Events = {
    AUDIO_TRACKS_UPDATED: 'audio',
    SUBTITLE_TRACKS_UPDATED: 'subtitle',
    MANIFEST_PARSED: 'manifest',
    FRAG_BUFFERED: 'fragment',
    ERROR: 'error',
  };
  static readonly ErrorTypes = {
    NETWORK_ERROR: 'network',
    MEDIA_ERROR: 'media',
  };
  static readonly DefaultConfig = { loader: FakeLoader };
  static readonly instances: FakeHls[] = [];
  static isSupported = vi.fn(() => true);

  readonly listeners = new Map<string, HlsListener>();
  readonly destroy = vi.fn();
  readonly loadSource = vi.fn();
  readonly attachMedia = vi.fn();
  readonly startLoad = vi.fn();
  readonly recoverMediaError = vi.fn();
  audioTracks = [
    { name: 'Track 1', lang: 'l1', default: true, channels: '2' },
    { name: 'Track 2', lang: 'l2', channels: '6' },
  ];
  subtitleTracks = [
    { name: 'Track 1', lang: 'l1', default: true },
    { name: 'Track 2', lang: 'l2', forced: true },
  ];
  audioTrack = 1;
  subtitleTrack = 0;
  subtitleDisplay = true;
  loadLevelObj = {
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    videoRange: 'PQ',
    frameRate: 30,
  };

  constructor(readonly config: Record<string, unknown>) {
    FakeHls.instances.push(this);
  }

  on(event: string, listener: HlsListener): void {
    this.listeners.set(event, listener);
  }

  emit(event: string, data?: Parameters<HlsListener>[1]): void {
    this.listeners.get(event)?.(event, data);
  }
}

class FakeMpegtsPlayer {
  readonly attachMediaElement = vi.fn();
  readonly load = vi.fn();
  readonly play = vi.fn();
  readonly on = vi.fn();
  readonly destroy = vi.fn();
}

const fakeMpegts = {
  Events: { ERROR: 'error' },
  isSupported: vi.fn(() => true),
  createPlayer: vi.fn(() => new FakeMpegtsPlayer()),
};

function callbacks(overrides: Partial<PlayerPipelineOptions> = {}): PlayerPipelineOptions {
  return {
    playbackLabel: token => `load=${String(token)}`,
    mediaState: () => '',
    isCatchup: () => false,
    onError: vi.fn(),
    onAudioTracksUpdated: vi.fn(),
    onSubtitleTracksUpdated: vi.fn(),
    onManifest: vi.fn(),
    ...overrides,
  };
}

function videoElement(): HTMLVideoElement {
  const video = document.createElement('video');
  vi.spyOn(video, 'play').mockResolvedValue();
  return video;
}

function contentTypeResponse(contentType: string): Response {
  return new Response('', { headers: { 'content-type': contentType } });
}

function installPreviewGlobals(): void {
  vi.stubGlobal('__Hls', FakeHls);
  vi.stubGlobal('__mpegts', fakeMpegts);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  FakeHls.instances.length = 0;
  FakeHls.isSupported.mockClear();
  fakeMpegts.isSupported.mockClear();
  fakeMpegts.createPlayer.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PlayerPipeline desktop routing', () => {
  it('routes detected direct video to the media element', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(contentTypeResponse('video/mp4')));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a', null);
    await settle();

    expect(video.src).toBe('http://host/a');
    expect(video.play).toHaveBeenCalledOnce();
    expect(pipeline.isHlsActive()).toBe(false);
  });

  it('routes detected HLS through hls.js', async () => {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      contentTypeResponse('application/vnd.apple.mpegurl'),
    ));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a', { 'http-user-agent': 'Agent 1' });
    await settle();

    const hls = FakeHls.instances[0];
    expect(hls.loadSource).toHaveBeenCalledWith('http://host/a');
    expect(hls.attachMedia).toHaveBeenCalledWith(video);
    expect(hls.config).toMatchObject({
      maxBufferLength: CONFIG.PLAYER.BUFFER_LENGTH,
      enableWorker: false,
    });
    expect(hls.config.xhrSetup).toBeTypeOf('function');
    expect(pipeline.isHlsActive()).toBe(true);
  });

  it.each([
    ['video/mp2t', 'mpegts'],
    ['video/x-flv', 'flv'],
  ])('routes detected %s through mpegts.js as %s', async (contentType, type) => {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(contentTypeResponse(contentType)));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a', null);
    await settle();

    expect(fakeMpegts.createPlayer).toHaveBeenCalledWith({
      type,
      isLive: true,
      url: 'http://host/a',
    });
    const player = fakeMpegts.createPlayer.mock.results[0].value;
    expect(player.attachMediaElement).toHaveBeenCalledWith(video);
    expect(player.load).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledOnce();
  });

  it('ignores a stale content-type result after a newer load', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(contentTypeResponse('video/mp4')));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a', null);
    pipeline.load('http://host/b', null);
    await settle();
    expect(video.src).toBe('http://host/b');

    resolveFirst?.(contentTypeResponse('video/mp4'));
    await settle();
    expect(video.src).toBe('http://host/b');
    expect(video.play).toHaveBeenCalledOnce();
  });
});

describe('PlayerPipeline loader lifecycle', () => {
  it('ignores a content-type result that arrives after destroy', async () => {
    let resolveProbe: ((response: Response) => void) | undefined;
    const probe = new Promise<Response>(resolve => { resolveProbe = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(probe));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a', null);
    pipeline.destroy();
    resolveProbe?.(contentTypeResponse('video/mp4'));
    await settle();

    expect(video.getAttribute('src')).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
  });

  it('destroy tears down active HLS and mpegts resources', async () => {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(contentTypeResponse('application/vnd.apple.mpegurl'))
      .mockResolvedValueOnce(contentTypeResponse('video/mp2t')));
    const hlsPipeline = new PlayerPipeline(callbacks());
    hlsPipeline.setVideoElement(videoElement());
    hlsPipeline.load('http://host/a', null);
    await settle();
    const hls = FakeHls.instances[0];

    const tsPipeline = new PlayerPipeline(callbacks());
    tsPipeline.setVideoElement(videoElement());
    tsPipeline.load('http://host/b', null);
    await settle();
    const player = fakeMpegts.createPlayer.mock.results[0].value;

    hlsPipeline.destroy();
    tsPipeline.destroy();

    expect(hls.destroy).toHaveBeenCalledOnce();
    expect(player.destroy).toHaveBeenCalledOnce();
    expect(hlsPipeline.isHlsActive()).toBe(false);
  });

  it('destroy aborts manifest work', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: RequestInit) => {
      signal = opts.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    const pipeline = new PlayerPipeline(callbacks());
    const internals = pipeline as unknown as {
      loadManifest(url: string, seq: number, loadToken: number): Promise<void>;
    };

    const pending = internals.loadManifest('http://host/a', 0, 1);
    await settle();
    pipeline.destroy();

    expect(signal?.aborted).toBe(true);
    await pending;
  });
});

describe('PlayerPipeline HLS integration', () => {
  it('forwards track updates and performs bounded fatal recovery', async () => {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(contentTypeResponse(
      'application/vnd.apple.mpegurl',
    )));
    const opts = callbacks();
    const pipeline = new PlayerPipeline(opts);
    pipeline.setVideoElement(videoElement());
    pipeline.load('http://host/a', null);
    await settle();
    const hls = FakeHls.instances[0];

    hls.emit(FakeHls.Events.AUDIO_TRACKS_UPDATED);
    hls.emit(FakeHls.Events.SUBTITLE_TRACKS_UPDATED);
    hls.emit(FakeHls.Events.ERROR, {
      fatal: true,
      type: FakeHls.ErrorTypes.NETWORK_ERROR,
      details: 'network',
    });
    hls.emit(FakeHls.Events.ERROR, {
      fatal: true,
      type: FakeHls.ErrorTypes.MEDIA_ERROR,
      details: 'media',
    });
    expect(opts.onAudioTracksUpdated).toHaveBeenCalledOnce();
    expect(opts.onSubtitleTracksUpdated).toHaveBeenCalledOnce();
    expect(hls.startLoad).toHaveBeenCalledOnce();
    expect(hls.recoverMediaError).toHaveBeenCalledOnce();

    hls.emit(FakeHls.Events.FRAG_BUFFERED);
    for (let i = 0; i < CONFIG.PLAYER.HLS_MAX_RECOVERIES; i++) {
      hls.emit(FakeHls.Events.ERROR, {
        fatal: true,
        type: FakeHls.ErrorTypes.NETWORK_ERROR,
        details: 'network',
      });
    }
    expect(hls.startLoad).toHaveBeenCalledTimes(1 + CONFIG.PLAYER.HLS_MAX_RECOVERIES);
    expect(opts.onError).not.toHaveBeenCalled();

    hls.emit(FakeHls.Events.ERROR, {
      fatal: true,
      type: FakeHls.ErrorTypes.NETWORK_ERROR,
      details: 'network',
    });
    expect(opts.onError).toHaveBeenCalledOnce();
  });

  it('exposes HLS track controls and a stream-info snapshot', async () => {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(contentTypeResponse(
      'application/vnd.apple.mpegurl',
    )));
    const pipeline = new PlayerPipeline(callbacks());
    pipeline.setVideoElement(videoElement());
    pipeline.load('http://host/a', null);
    await settle();
    const hls = FakeHls.instances[0];

    expect(pipeline.hlsAudioOptions()).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, active: true },
    ]);
    expect(pipeline.setHlsAudioTrack(0)).toBe(true);
    expect(hls.audioTrack).toBe(0);
    expect(pipeline.setHlsAudioTrack(9)).toBe(false);
    expect(pipeline.setHlsSubtitleTrack(-1)).toBe(true);
    expect(hls.subtitleDisplay).toBe(false);
    expect(pipeline.setHlsSubtitleTrack(1)).toBe(true);
    expect(hls.subtitleTrack).toBe(1);
    expect(pipeline.streamInfo()).toEqual({
      videoCodec: 'avc1.640028',
      audioCodec: 'mp4a.40.2',
      videoRange: 'PQ',
      frameRate: 30,
      audioChannels: '2',
    });
  });
});

describe('PlayerPipeline manifest loading', () => {
  it('delivers parsed audio, subtitle, CC, and variant declarations', async () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="l2"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 3",LANGUAGE="l3",FORCED=YES,URI="s.m3u8"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="c",NAME="Track 4",LANGUAGE="l4",INSTREAM-ID="CC1",DEFAULT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,FRAME-RATE=30,CODECS="avc1.42c00d,mp4a.40.2",AUDIO="a",SUBTITLES="s",CLOSED-CAPTIONS="c"',
      'v.m3u8',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(manifest)));
    const onManifest = vi.fn();
    const pipeline = new PlayerPipeline(callbacks({ onManifest }));
    const internals = pipeline as unknown as {
      loadManifest(url: string, seq: number, loadToken: number): Promise<void>;
    };

    await internals.loadManifest('http://host/a', 0, 1);

    expect(onManifest).toHaveBeenCalledWith({
      audio: [
        { name: 'Track 1', lang: 'l1', isDefault: true },
        { name: 'Track 2', lang: 'l2', isDefault: false },
      ],
      subtitles: [
        { name: 'Track 3', lang: 'l3', isDefault: false, isForced: true },
      ],
      closedCaptions: [
        { name: 'Track 4', lang: 'l4', instreamId: 'CC1', isDefault: true },
      ],
      variants: [{
        width: 1280,
        height: 720,
        videoCodec: 'avc1.42c00d',
        audioCodec: 'mp4a.40.2',
        atmos: false,
        videoRange: '',
        frameRate: 30,
      }],
      masterUrl: 'http://host/a',
    });
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
    const pipeline = new PlayerPipeline(callbacks());
    const internals = pipeline as unknown as {
      loadManifest(url: string, seq: number, loadToken: number): Promise<void>;
    };

    const first = internals.loadManifest('http://host/a', 0, 1);
    await settle();
    const second = internals.loadManifest('http://host/b', 0, 2);
    await settle();

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    pipeline.destroy();
    await Promise.all([first, second]);
  });
});
