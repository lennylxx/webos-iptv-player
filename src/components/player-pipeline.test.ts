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

class FakeShakaPlayer {
  static readonly instances: FakeShakaPlayer[] = [];
  static pendingAttach: Promise<void> | null = null;

  readonly attach = vi.fn(() => FakeShakaPlayer.pendingAttach ?? Promise.resolve());
  readonly configure = vi.fn(() => true);
  readonly destroy = vi.fn().mockResolvedValue(undefined);
  readonly load = vi.fn().mockResolvedValue(undefined);
  readonly requestFilters: Array<
    (type: number, request: { headers: Record<string, string> }) => void
  > = [];
  readonly selectAudioTrack = vi.fn((track: typeof this.audioTracks[number]) => {
    for (const candidate of this.audioTracks) candidate.active = candidate === track;
    this.emit('variantchanged');
  });
  readonly selectTextTrack = vi.fn((track?: typeof this.textTracks[number] | null) => {
    for (const candidate of this.textTracks) candidate.active = candidate === track;
    this.emit('textchanged');
  });
  readonly listeners = new Map<string, (event: Event) => void>();
  audioTracks = [
    {
      active: false, channelsCount: 2, codecs: 'mp4a.40.2',
      label: 'Track 1', language: 'l1', primary: true,
    },
    {
      active: true, channelsCount: 6, codecs: 'ec-3',
      label: null, language: 'l2', primary: false,
    },
  ];
  textTracks = [
    {
      active: true, forced: false, label: 'Track 1',
      language: 'l1', primary: true,
    },
    {
      active: false, forced: true, label: null,
      language: 'l2', primary: false,
    },
  ];
  variantTracks = [
    {
      active: true,
      audioCodec: 'ec-3',
      channelsCount: 6,
      frameRate: 24,
      hdr: 'PQ',
      videoCodec: 'hvc1.2.4.L120.90',
    },
  ];

  constructor() {
    FakeShakaPlayer.instances.push(this);
  }

  addEventListener(event: string, listener: (event: Event) => void): void {
    this.listeners.set(event, listener);
  }

  emit(event: string, detail?: unknown): void {
    this.listeners.get(event)?.(new CustomEvent(event, { detail }));
  }

  getAudioTracks(): typeof this.audioTracks {
    return this.audioTracks;
  }

  getTextTracks(): typeof this.textTracks {
    return this.textTracks;
  }

  getVariantTracks(): typeof this.variantTracks {
    return this.variantTracks;
  }

  getNetworkingEngine(): {
    registerRequestFilter: (
      filter: (type: number, request: { headers: Record<string, string> }) => void,
    ) => void;
  } {
    return {
      registerRequestFilter: filter => {
        this.requestFilters.push(filter);
      },
    };
  }

}

const fakeShaka = {
  Player: FakeShakaPlayer,
  net: { NetworkingEngine: { RequestType: { LICENSE: 2 } } },
  util: { Error: { Severity: { CRITICAL: 2, RECOVERABLE: 1 } } },
};

function lastShakaPlayer(): FakeShakaPlayer | undefined {
  return FakeShakaPlayer.instances[FakeShakaPlayer.instances.length - 1];
}

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
  vi.stubGlobal('__shaka', fakeShaka);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  FakeShakaPlayer.instances.length = 0;
  FakeShakaPlayer.pendingAttach = null;
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
    expect(pipeline.isMseActive()).toBe(false);
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
    expect(pipeline.isMseActive()).toBe(true);
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
    expect(hlsPipeline.isMseActive()).toBe(false);
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

    expect(pipeline.mseAudioOptions()).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, active: false },
      { index: 1, name: 'Track 2', lang: 'l2', isDefault: false, active: true },
    ]);
    expect(pipeline.setMseAudioTrack(0)).toBe(true);
    expect(hls.audioTrack).toBe(0);
    expect(pipeline.setMseAudioTrack(9)).toBe(false);
    expect(pipeline.setMseSubtitleTrack(-1)).toBe(true);
    expect(hls.subtitleDisplay).toBe(false);
    expect(pipeline.setMseSubtitleTrack(1)).toBe(true);
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


describe('PlayerPipeline desktop DASH', () => {
  async function loadDash(
    url = 'http://host/a',
    contentType = 'application/dash+xml',
    extras: Record<string, string> | null = null,
  ) {
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(contentTypeResponse(contentType)));
    const opts = callbacks();
    const pipeline = new PlayerPipeline(opts);
    const video = videoElement();
    pipeline.setVideoElement(video);
    pipeline.load(url, extras);
    await settle();
    return { pipeline, video, opts };
  }

  it('routes a detected DASH content type through Shaka', async () => {
    const { pipeline, video } = await loadDash();
    const player = lastShakaPlayer();

    expect(player?.configure).toHaveBeenCalledWith({
      streaming: { bufferingGoal: CONFIG.PLAYER.BUFFER_LENGTH },
    });
    expect(player?.attach).toHaveBeenCalledWith(video);
    expect(player?.load).toHaveBeenCalledWith('http://host/a');
    expect(video.play).toHaveBeenCalledOnce();
    expect(pipeline.isMseActive()).toBe(true);
  });

  it('routes an .mpd URL through Shaka when the probe is inconclusive', async () => {
    const { pipeline } = await loadDash('http://host/a.mpd', 'application/octet-stream');

    expect(lastShakaPlayer()?.load).toHaveBeenCalledWith('http://host/a.mpd');
    expect(pipeline.isMseActive()).toBe(true);
  });

  it('configures Widevine and applies license request headers', async () => {
    const { pipeline } = await loadDash(
      'http://host/a.mpd',
      'application/dash+xml',
      {
        'inputstream.adaptive.license_type': 'com.widevine.alpha',
        'inputstream.adaptive.license_key':
          'http://host/license|authorization=Bearer%20token',
      },
    );
    const player = lastShakaPlayer();
    const request = { headers: {} as Record<string, string> };
    player?.requestFilters[0]?.(2, request);

    expect(player?.configure).toHaveBeenCalledWith({
      streaming: { bufferingGoal: CONFIG.PLAYER.BUFFER_LENGTH },
      drm: {
        preferredKeySystems: ['com.widevine.alpha'],
        servers: { 'com.widevine.alpha': 'http://host/license' },
      },
    });
    expect(request.headers).toEqual({ authorization: 'Bearer token' });
    expect(pipeline.drmLabel()).toBe('Widevine');
  });

  it('configures inline ClearKey keys and its OSD label', async () => {
    const kid = '00112233445566778899aabbccddeeff';
    const key = 'ffeeddccbbaa99887766554433221100';
    const { pipeline } = await loadDash('http://host/a.mpd', 'application/dash+xml', {
      'inputstream.adaptive.license_type': 'org.w3.clearkey',
      'inputstream.adaptive.license_key': `${kid}:${key}`,
    });
    expect(lastShakaPlayer()?.configure).toHaveBeenCalledWith({
      streaming: { bufferingGoal: CONFIG.PLAYER.BUFFER_LENGTH },
      drm: { preferredKeySystems: ['org.w3.clearkey'], servers: {}, clearKeys: { [kid]: key } },
    });
    expect(pipeline.drmLabel()).toBe('ClearKey');
  });

  it('applies ClearKey headers to license requests only', async () => {
    const { pipeline } = await loadDash('http://host/a.mpd', 'application/dash+xml', {
      'inputstream.adaptive.drm_legacy': 'org.w3.clearkey|https://host/license|x-token=v',
    });
    const player = lastShakaPlayer();
    const license = { headers: {} as Record<string, string> };
    const segment = { headers: {} as Record<string, string> };
    player?.requestFilters[0]?.(2, license);
    player?.requestFilters[0]?.(1, segment);
    expect(license.headers).toEqual({ 'x-token': 'v' });
    expect(segment.headers).toEqual({});
    expect(pipeline.drmLabel()).toBe('ClearKey');
    pipeline.destroy();
    expect(pipeline.drmLabel()).toBe('');
  });

  it('rejects malformed ClearKey configuration before creating a player', async () => {
    const { opts } = await loadDash('http://host/a.mpd', 'application/dash+xml', {
      'inputstream.adaptive.license_type': 'org.w3.clearkey',
      'inputstream.adaptive.license_key': 'invalid',
    });
    expect(lastShakaPlayer()).toBeUndefined();
    expect(opts.onError).toHaveBeenCalledOnce();
  });

  it('exposes DASH track controls', async () => {
    const { pipeline } = await loadDash();
    const player = lastShakaPlayer();

    expect(pipeline.mseAudioOptions()).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, active: false },
      { index: 1, name: '', lang: 'l2', isDefault: false, active: true },
    ]);
    expect(pipeline.setMseAudioTrack(0)).toBe(true);
    expect(player?.selectAudioTrack).toHaveBeenCalledWith(player?.audioTracks[0]);
    expect(pipeline.setMseAudioTrack(9)).toBe(false);

    expect(pipeline.mseSubtitleOptions()).toEqual([
      { index: 0, name: 'Track 1', lang: 'l1', isDefault: true, isForced: false, active: true },
      { index: 1, name: '', lang: 'l2', isDefault: false, isForced: true, active: false },
    ]);
    expect(pipeline.setMseSubtitleTrack(-1)).toBe(true);
    expect(player?.selectTextTrack).toHaveBeenCalledWith();
    expect(pipeline.mseSubtitleOptions().every(option => !option.active)).toBe(true);
    expect(pipeline.setMseSubtitleTrack(1)).toBe(true);
    expect(player?.selectTextTrack).toHaveBeenCalledWith(player?.textTracks[1]);
    expect(pipeline.setMseSubtitleTrack(9)).toBe(false);
  });

  it('reports the playing codecs to the OSD', async () => {
    const { pipeline } = await loadDash();

    expect(pipeline.streamInfo()).toEqual({
      videoCodec: 'hvc1.2.4.L120.90',
      audioCodec: 'ec-3',
      videoRange: 'PQ',
      frameRate: 24,
      audioChannels: '6',
      audioAtmos: false,
    });
  });

  it('reapplies track picks once Shaka has loaded the streams', async () => {
    const { opts } = await loadDash();

    expect(opts.onAudioTracksUpdated).toHaveBeenCalledOnce();
    expect(opts.onSubtitleTracksUpdated).toHaveBeenCalledOnce();
  });

  it.each(['adaptation', 'variantchanged'])('refreshes stream information on %s', async event => {
    const { pipeline, opts } = await loadDash();
    const player = lastShakaPlayer()!;
    player.variantTracks[0].frameRate = 60;
    player.variantTracks[0].hdr = 'HLG';

    player.emit(event);

    expect(opts.onAudioTracksUpdated).toHaveBeenCalledTimes(2);
    expect(pipeline.streamInfo()).toMatchObject({ frameRate: 60, videoRange: 'HLG' });

    pipeline.destroy();
    player.emit(event);
    expect(opts.onAudioTracksUpdated).toHaveBeenCalledTimes(2);
  });

  it('does not recurse when Shaka reports the applied subtitle visibility', async () => {
    const onSubtitleTracksUpdated = vi.fn();
    let pipeline: PlayerPipeline;
    onSubtitleTracksUpdated.mockImplementation(() => {
      pipeline.setMseSubtitleTrack(-1);
    });
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      contentTypeResponse('application/dash+xml'),
    ));
    pipeline = new PlayerPipeline(callbacks({ onSubtitleTracksUpdated }));
    pipeline.setVideoElement(videoElement());

    pipeline.load('http://host/a.mpd', null);
    await settle();

    const player = lastShakaPlayer();
    expect(onSubtitleTracksUpdated).toHaveBeenCalledTimes(2);
    expect(player?.selectTextTrack).toHaveBeenCalledOnce();
    expect(player?.textTracks.every(track => !track.active)).toBe(true);
  });

  it('lets Shaka handle recoverable errors and reports critical errors once', async () => {
    const { opts } = await loadDash();
    const player = lastShakaPlayer();

    player?.emit('error', { severity: 1, category: 1, code: 1001 });
    expect(opts.onError).not.toHaveBeenCalled();

    player?.emit('error', { severity: 2, category: 1, code: 1002 });
    player?.emit('error', { severity: 2, category: 1, code: 1003 });
    expect(opts.onError).toHaveBeenCalledOnce();
  });

  it('destroys the Shaka player when the pipeline tears down', async () => {
    const { pipeline } = await loadDash();
    const player = lastShakaPlayer();

    pipeline.destroy();
    await settle();

    expect(player?.destroy).toHaveBeenCalledOnce();
    expect(pipeline.isMseActive()).toBe(false);
  });

  it.each([false, true])('waits for old teardown before direct playback (explicit=%s)', async direct => {
    const { pipeline, video } = await loadDash();
    const oldPlayer = lastShakaPlayer()!;
    const teardown = deferred();
    oldPlayer.destroy.mockImplementation(() => teardown.promise.then(() => {
      video.removeAttribute('src');
    }));
    vi.mocked(fetch).mockClear().mockResolvedValue(contentTypeResponse('video/mp4'));

    pipeline.load('http://host/b.mp4', null, { direct });
    await settle();

    expect(oldPlayer.destroy).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.getAttribute('src')).toBeNull();

    teardown.resolve();
    await vi.waitFor(() => expect(video.src).toBe('http://host/b.mp4'));
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Shaka', 'application/dash+xml'],
    ['HLS', 'application/vnd.apple.mpegurl'],
    ['MPEG-TS', 'video/mp2t'],
  ])('waits for old teardown before attaching %s', async (kind, contentType) => {
    const { pipeline, video } = await loadDash();
    const oldPlayer = lastShakaPlayer()!;
    const teardown = deferred();
    oldPlayer.destroy.mockReturnValue(teardown.promise);
    vi.mocked(fetch).mockClear().mockResolvedValue(contentTypeResponse(contentType));

    pipeline.load('http://host/b', null);
    await settle();

    expect(FakeShakaPlayer.instances).toHaveLength(1);
    expect(FakeHls.instances).toHaveLength(0);
    expect(fakeMpegts.createPlayer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    teardown.resolve();
    await vi.waitFor(() => {
      if (kind === 'Shaka') {
        expect(FakeShakaPlayer.instances).toHaveLength(2);
        expect(lastShakaPlayer()?.attach).toHaveBeenCalledWith(video);
        expect(lastShakaPlayer()?.load).toHaveBeenCalledWith('http://host/b');
      } else if (kind === 'HLS') {
        expect(FakeHls.instances).toHaveLength(1);
        expect(FakeHls.instances[0].attachMedia).toHaveBeenCalledWith(video);
      } else {
        expect(fakeMpegts.createPlayer).toHaveBeenCalledOnce();
        expect(fakeMpegts.createPlayer.mock.results[0].value.attachMediaElement)
          .toHaveBeenCalledWith(video);
      }
    });
  });

  it('retains teardown across stop and starts only the newest queued tune', async () => {
    const { pipeline, video } = await loadDash();
    const oldPlayer = lastShakaPlayer()!;
    const teardown = deferred();
    oldPlayer.destroy.mockReturnValue(teardown.promise);
    const logs = vi.spyOn(console, 'log');

    pipeline.destroy();
    pipeline.load('http://host/b.mp4', null, { direct: true });
    pipeline.load('http://host/c.mp4', null, { direct: true });
    await settle();

    expect(video.play).toHaveBeenCalledOnce();
    teardown.resolve();
    await settle();

    expect(video.src).toBe('http://host/c.mp4');
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(oldPlayer.destroy).toHaveBeenCalledOnce();
    const text = logs.mock.calls.map(args => args.join(' ')).join('\n');
    expect(text).toContain('event=playback.mse.teardown.cancelled load=3 owner=(load=1)');
    expect(text).toContain('reason=superseded');
    expect(text).toContain('event=playback.mse.destroy.completed load=1');
    expect(text).toContain('event=playback.mse.teardown.resumed load=4 owner=(load=1)');
  });

  it.each(['stop', 'replace'])('cancels a queued tune on %s', async action => {
    const { pipeline, video, opts } = await loadDash();
    const teardown = deferred();
    lastShakaPlayer()!.destroy.mockReturnValue(teardown.promise);

    pipeline.load('http://host/b.mp4', null, { direct: true });
    if (action === 'stop') pipeline.destroy();
    else pipeline.setVideoElement(videoElement());
    teardown.resolve();
    await settle();

    expect(video.play).toHaveBeenCalledOnce();
    expect(video.getAttribute('src')).toBeNull();
    expect(opts.onError).not.toHaveBeenCalled();
  });

  it('waits for failed-load cleanup before starting channel fallback', async () => {
    const attach = deferred();
    FakeShakaPlayer.pendingAttach = attach.promise;
    const { pipeline, video, opts } = await loadDash();
    const oldPlayer = lastShakaPlayer()!;
    const teardown = deferred();
    oldPlayer.load.mockRejectedValue(new Error('Synthetic load failure'));
    oldPlayer.destroy.mockImplementation(() => teardown.promise.then(() => {
      video.removeAttribute('src');
    }));
    vi.mocked(opts.onError).mockImplementation(() => {
      pipeline.load('http://host/b.mp4', null, { direct: true });
    });

    attach.resolve();
    await vi.waitFor(() => expect(opts.onError).toHaveBeenCalledOnce());
    expect(oldPlayer.destroy).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();

    teardown.resolve();
    await vi.waitFor(() => expect(video.src).toBe('http://host/b.mp4'));
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('reports teardown failure only for the latest tune and requires a fresh video', async () => {
    const { pipeline, video, opts } = await loadDash();
    const teardown = deferred();
    lastShakaPlayer()!.destroy.mockReturnValue(teardown.promise);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

    pipeline.load('http://host/b.mp4', null, { direct: true });
    pipeline.load('http://host/c.mp4', null, { direct: true });
    teardown.reject(new Error('Synthetic teardown failure'));
    await settle();

    expect(opts.onError).toHaveBeenCalledOnce();
    const text = warnings.mock.calls.map(args => args.join(' ')).join('\n');
    expect(text).toContain('event=playback.mse.destroy.failed load=1 source=shaka');
    expect(text).toContain('event=playback.mse.teardown.blocked load=3 owner=(load=1)');
    expect(text).not.toContain('Synthetic teardown failure');
    expect(video.getAttribute('src')).toBeNull();
    expect(video.play).toHaveBeenCalledOnce();
    pipeline.load('http://host/d.mp4', null, { direct: true });
    await settle();
    expect(opts.onError).toHaveBeenCalledTimes(2);
    expect(video.play).toHaveBeenCalledOnce();

    const fresh = videoElement();
    pipeline.setVideoElement(fresh);
    pipeline.load('http://host/d.mp4', null, { direct: true });
    expect(fresh.src).toBe('http://host/d.mp4');
    expect(fresh.play).toHaveBeenCalledOnce();
  });

  it('does not load an old Shaka stream after a newer tune', async () => {
    let resolveAttach: (() => void) | undefined;
    FakeShakaPlayer.pendingAttach = new Promise(resolve => {
      resolveAttach = resolve;
    });
    installPreviewGlobals();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(contentTypeResponse('application/dash+xml'))
      .mockResolvedValueOnce(contentTypeResponse('video/mp4')));
    const pipeline = new PlayerPipeline(callbacks());
    const video = videoElement();
    pipeline.setVideoElement(video);

    pipeline.load('http://host/a.mpd', null);
    await settle();
    const oldPlayer = lastShakaPlayer();
    pipeline.load('http://host/b', null);
    await settle();
    resolveAttach?.();
    await settle();

    expect(oldPlayer?.destroy).toHaveBeenCalledOnce();
    expect(oldPlayer?.load).not.toHaveBeenCalled();
    expect(video.src).toBe('http://host/b');
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
