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
