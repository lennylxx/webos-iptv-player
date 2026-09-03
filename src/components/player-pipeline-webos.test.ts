// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerPipelineOptions } from './player-pipeline';

const cacheMocks = vi.hoisted(() => ({
  getCachedStreamMime: vi.fn(),
  setCachedStreamMime: vi.fn(),
}));

vi.mock('../services/idb-cache', () => cacheMocks);

function callbacks(): PlayerPipelineOptions {
  return {
    playbackLabel: token => `load=${String(token)}`,
    mediaState: () => '',
    isCatchup: () => false,
    onError: vi.fn(),
    onAudioTracksUpdated: vi.fn(),
    onSubtitleTracksUpdated: vi.fn(),
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
