// @vitest-environment jsdom
// jsdom, because the active probe is stringified and evaluated inside the
// TV's webview.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeProbeExpression,
  runNativePlaylistProbe,
  snapshotProbeExpression,
} from './tv-diag.mjs';

describe('active diagnostics probe', () => {
  // The probe is stringified and evaluated inside the TV's webview, so run it
  // the same way here: a real DOM, no bundler, no module scope.
  const runProbe = () => (0, eval)(activeProbeExpression);
  const runSnapshot = () => (0, eval)(snapshotProbeExpression);

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    window.fetch = () => Promise.reject(new Error('offline'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const appInfoResponse = {
    json: async () => ({ id: 'app.id', version: '1.0.0' }),
  };

  it('takes a local snapshot without fetching playlist endpoints', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      source: 'm3u',
      name: 'Alpha',
      url: 'http://host/playlist.m3u',
    }]));
    let fetches = 0;
    window.fetch = () => {
      fetches++;
      return Promise.reject(new Error('unexpected fetch'));
    };

    const probe = await runSnapshot();

    expect(fetches).toBe(0);
    expect(probe.playlists).toEqual([
      expect.objectContaining({
        source: 'm3u',
        name: 'Alpha',
        __url: 'http://host/playlist.m3u',
        webview: null,
      }),
    ]);
  });

  it('reports only rendered rows, leaving the catalog size to the load event', async () => {
    document.body.innerHTML = '<div class="channel-item"></div><div class="channel-item"></div>';

    const probe = await runProbe();

    expect(probe.state.channelsRendered).toBe(2);
    expect(probe.state).not.toHaveProperty('channels');
  });

  it('bounds playlist previews with an exact range and cancels ignored ranges', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      source: 'm3u',
      name: 'Alpha',
      url: 'http://host/playlist.m3u',
    }]));
    const cancel = vi.fn(async () => {});
    const fetches = [];
    window.fetch = async (url, init) => {
      fetches.push({ url: String(url), init });
      if (String(url) === 'appinfo.json') return appInfoResponse;
      return {
        status: 200,
        headers: {
          get: (name) => ({
            'content-type': 'audio/x-mpegurl',
            'content-length': '9000',
          })[name] || null,
        },
        body: {
          getReader: () => ({
            read: async () => ({
              done: false,
              value: new TextEncoder().encode(`#EXTM3U\n${'a'.repeat(4096)}`),
            }),
            cancel,
          }),
        },
      };
    };

    const probe = await runProbe();

    expect(fetches).toHaveLength(2);
    expect(fetches[1].init.headers).toEqual({ Range: 'bytes=0-2047' });
    expect(fetches[1].init.signal).toBeInstanceOf(AbortSignal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(probe.playlists[0].webview).toMatchObject({
      status: 200,
      contentType: 'audio/x-mpegurl',
      contentLength: '9000',
    });
    expect(probe.playlists[0].webview.bodyPreview).toHaveLength(2048);
  });

  it('aborts a timed-out playlist probe without retrying', async () => {
    vi.useFakeTimers();
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      source: 'm3u',
      name: 'Alpha',
      url: 'http://host/playlist.m3u',
    }]));
    let playlistFetches = 0;
    window.fetch = (url, init) => {
      if (String(url) === 'appinfo.json') return Promise.resolve(appInfoResponse);
      playlistFetches++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('probe timed out')));
      });
    };

    const pending = runProbe();
    await vi.advanceTimersByTimeAsync(5000);
    const probe = await pending;

    expect(playlistFetches).toBe(1);
    expect(probe.playlists[0].webview).toMatchObject({
      status: null,
      bodyPreview: '',
      error: 'Error: probe timed out',
    });
  });

  it('skips webview and native playlist probes for one-connection accounts', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      source: 'xtream',
      name: 'Alpha',
      url: 'http://host',
      xtream: { username: 'user1', password: 'pass1', liveOutput: 'auto' },
    }]));
    const urls = [];
    window.fetch = async (url) => {
      urls.push(String(url));
      if (String(url) === 'appinfo.json') return appInfoResponse;
      return {
        status: 200,
        json: async () => ({
          user_info: {
            auth: 1,
            max_connections: '1',
            allowed_output_formats: ['m3u8'],
          },
        }),
      };
    };

    const probe = await runProbe();
    const execFile = vi.fn();
    const native = runNativePlaylistProbe(probe.playlists[0], { execFile });

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('/player_api.php?');
    expect(urls.join(' ')).not.toContain('/get.php?');
    expect(probe.playlists[0].webview).toEqual({
      status: null,
      contentType: '',
      contentLength: '',
      bodyPreview: '',
      error: '',
      skipped: true,
      skipReason: 'xtream-max-connections-at-most-one',
    });
    expect(native).toMatchObject({
      skipped: true,
      skipReason: 'xtream-max-connections-at-most-one',
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(JSON.stringify({ webview: probe.playlists[0].webview, native }))
      .not.toContain('user1');
    expect(JSON.stringify({ webview: probe.playlists[0].webview, native }))
      .not.toContain('pass1');
  });

  it('captures each <source> type with its canPlayType verdict', async () => {
    document.body.innerHTML =
      '<video><source src="http://host/movie/u1/p1/7.mkv" type="video/x-matroska"></video>';
    const video = document.querySelector('video');
    video.canPlayType = (type) => (type === 'video/mp4' ? 'probably' : '');

    const probe = await runProbe();

    expect(probe.state.media.sources).toEqual([{
      src: 'http://host/movie/u1/p1/7.mkv',
      type: 'video/x-matroska',
      canPlayType: '',
    }]);
    expect(probe.state.codecSupport['video/mp4']).toBe('probably');
    expect(probe.state.codecSupport['video/x-matroska']).toBe('');
  });

  it('probes container support even with no <video> on the page', async () => {
    const probe = await runProbe();

    expect(probe.state.media).toBeNull();
    expect(Object.keys(probe.state.codecSupport)).toContain('video/x-matroska');
    expect(Object.keys(probe.state.codecSupport)).toContain('audio/mp4; codecs="ec-3"');
  });
});
