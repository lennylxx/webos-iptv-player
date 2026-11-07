import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LunaRequestOptions } from './luna';

const requests: Array<{ uri: string; options: LunaRequestOptions }> = [];
const cancels: Array<ReturnType<typeof vi.fn>> = [];

vi.mock('./luna', () => ({
  lunaRequest: (uri: string, options: LunaRequestOptions) => {
    requests.push({ uri, options });
    const handle = { cancel: vi.fn() };
    cancels.push(handle.cancel);
    return handle;
  },
}));

const {
  buildLoadParameters, findWindowId, foregroundAppInfo, hasLunaHeaders, isMissingMethod, loadMedia, lunaHeaderNames,
  LunaMediaError, mediaCommand, setDisplayWindow, tlsUnsafeHeaderNames, validWindowId, withoutHeaders,
} = await import('./luna-media');
const { CONFIG } = await import('../config');

beforeEach(() => {
  requests.length = 0;
  cancels.length = 0;
});

describe('Luna load parameters', () => {
  it('maps headers into transmission and omits the empty ones', () => {
    expect(buildLoadParameters('http://host/a.m3u8', 'HLS', 'app1', '_Window_Id_3', {
      Referer: 'http://host/',
      'User-Agent': '',
      Cookie: 'c=1',
      Authorization: 'Bearer t',
    })).toEqual({
      uri: 'http://host/a.m3u8',
      type: 'media',
      payload: {
        mediaTransportType: 'HLS',
        option: {
          appId: 'app1',
          windowId: '_Window_Id_3',
          transmission: {
            httpHeader: { referer: 'http://host/', cookies: 'c=1' },
            extraHttpHeader: { authorization: 'Bearer t' },
          },
        },
      },
    });
  });

  it('loads PlayReady DASH with the DRM client beside the media headers', () => {
    expect(buildLoadParameters('http://host/a.mpd', 'MPEG-DASH', 'app1', '_Window_Id_3',
      { Referer: 'http://host/' }, 'client-1').payload).toEqual({
      mediaTransportType: 'MPEG-DASH',
      option: {
        appId: 'app1',
        windowId: '_Window_Id_3',
        transmission: { httpHeader: { referer: 'http://host/' } },
        drm: { type: 'playready', clientId: 'client-1' },
      },
    });
  });

  it('omits transmission entirely without headers', () => {
    const params = buildLoadParameters('http://host/a.m3u8', 'HLS', 'app1', '_Window_Id_3', {});
    expect((params.payload as { option: unknown }).option)
      .toEqual({ appId: 'app1', windowId: '_Window_Id_3' });
  });

  it('only routes headers the page pipeline overwrites', () => {
    expect(hasLunaHeaders({ referrer: 'http://host/' })).toBe(true);
    expect(hasLunaHeaders({ Cookie: 'c=1' })).toBe(true);
    expect(hasLunaHeaders({ Authorization: 'Bearer t' })).toBe(true);
    expect(hasLunaHeaders({ Origin: 'http://host' })).toBe(true);
    expect(hasLunaHeaders({ 'X-Token': 't1' })).toBe(true);
    expect(hasLunaHeaders({ Referer: '' })).toBe(false);
  });

  it('keeps a User-Agent-only channel on the video element', () => {
    expect(hasLunaHeaders({ 'user-agent': 'ua1' })).toBe(false);
    expect(hasLunaHeaders({ 'User-Agent': 'ua1', Referer: 'http://host/' })).toBe(true);
  });

  it('withholds cookies and authorization from https only', () => {
    const headers = { Referer: 'r', Cookie: 'c', authorization: 'a' };
    expect(tlsUnsafeHeaderNames('https://host/a.m3u8', headers))
      .toEqual(['authorization', 'cookie']);
    expect(tlsUnsafeHeaderNames('http://host/a.m3u8', headers)).toEqual([]);
    expect(withoutHeaders(headers, ['authorization', 'cookie'])).toEqual({ Referer: 'r' });
  });

  it('logs header names but never provider-specific ones', () => {
    expect(lunaHeaderNames({
      Referer: 'r', 'User-Agent': 'u', Cookie: 'c', Origin: 'o', 'X-Secret-Name': 's',
    })).toBe('referer,ua,cookie,origin,other');
  });
});

describe('Luna window lookup', () => {
  const info = {
    returnValue: true,
    foregroundAppInfo: [
      { appId: 'other', mediaId: 'm1', windowId: '_Window_Id_1' },
      { appId: 'app1', mediaId: 'stale', windowId: '_Window_Id_2' },
      { appId: 'app1', mediaId: 'm1', windowId: '_Window_Id_9' },
    ],
  };

  it('picks our own element by mediaId', () => {
    expect(findWindowId(info, 'app1', 'm1')).toBe('_Window_Id_9');
  });

  it('accepts a connectionId match', () => {
    expect(findWindowId({ appId: 'app1', connectionId: 'm2', windowId: '_Window_Id_4' }, 'app1', 'm2'))
      .toBe('_Window_Id_4');
  });

  it('ignores stale, foreign, and malformed entries', () => {
    expect(findWindowId(info, 'app1', 'm3')).toBe('');
    expect(findWindowId({ appId: 'app1', mediaId: 'm1', windowId: 'Window_1' }, 'app1', 'm1')).toBe('');
    expect(validWindowId('_Window_Id_')).toBe(false);
    expect(validWindowId(`_Window_Id_${'1'.repeat(200)}`)).toBe(false);
    expect(validWindowId(7)).toBe(false);
  });
});

describe('Luna media calls', () => {
  it('rejects a load without a mediaId', async () => {
    const pending = loadMedia({ uri: 'http://host/a.m3u8' });
    requests[0].options.onSuccess?.({ returnValue: true });
    await expect(pending).rejects.toBeInstanceOf(LunaMediaError);
  });

  it('carries the failure errorCode', async () => {
    const pending = loadMedia({ uri: 'http://host/a.m3u8' });
    requests[0].options.onFailure?.({ returnValue: false, errorCode: 12 });
    await expect(pending).rejects.toMatchObject({ code: 12 });
  });

  it('counts a "No Error" failure reply as success', async () => {
    const unload = mediaCommand('unload', 'm1');
    const pause = mediaCommand('pause', 'm1');
    requests[0].options.onFailure?.({ returnValue: false, errorCode: 0, errorText: 'No Error' });
    requests[1].options.onFailure?.({ returnValue: false, errorText: 'No Error' });
    await expect(unload).resolves.toMatchObject({ errorCode: 0 });
    await expect(pause).resolves.toMatchObject({ errorText: 'No Error' });
  });

  it('keeps real failure replies as failures', async () => {
    const coded = mediaCommand('play', 'm1');
    const uncoded = mediaCommand('play', 'm1');
    requests[0].options.onFailure?.({ returnValue: false, errorCode: 5, errorText: 'No Error' });
    requests[1].options.onFailure?.({ returnValue: false, errorText: 'Bad state' });
    await expect(coded).rejects.toMatchObject({ code: 5 });
    await expect(uncoded).rejects.toMatchObject({ code: -1 });
  });

  it('tells a method the bus does not have from a transient failure', async () => {
    const replies = [
      { returnValue: false, errorCode: -1, errorText: 'Unknown method "getForegroundAppInfo" for category "/"' },
      { returnValue: false, errorCode: -1, errorText: 'Service does not exist: com.webos.media.' },
      { returnValue: false, errorCode: -1, errorText: 'Internal error' },
      { returnValue: false, errorCode: 5, errorText: 'Unknown method' },
    ];
    const errors = await Promise.all(replies.map((reply, index) => {
      const pending = foregroundAppInfo().catch((error: unknown) => error);
      requests[index].options.onFailure?.(reply);
      return pending;
    }));
    // A missing service is transient: at boot, or while uMediaServer restarts.
    expect(errors.map(isMissingMethod)).toEqual([true, false, false, false]);
    expect(isMissingMethod(new LunaMediaError('failed', -1, false, 'Method "getForegroundAppInfo" does not exist')))
      .toBe(true);
    expect(isMissingMethod(new LunaMediaError('timed out', -1, true, 'Unknown method'))).toBe(false);
  });

  it('positions the picture in app coordinates or full screen', () => {
    void setDisplayWindow('m1', { x: 10.4, y: 20.6, width: 640, height: 360 });
    void setDisplayWindow('m1', 'full');
    expect(requests.map(r => [r.uri, r.options.method, r.options.parameters])).toEqual([
      ['luna://com.webos.service.videooutput/display', 'setDisplayWindow', {
        context: 'm1', fullScreen: false,
        displayOutput: { x: 10, y: 21, width: 640, height: 360 },
      }],
      ['luna://com.webos.service.videooutput/display', 'setDisplayWindow', {
        context: 'm1', fullScreen: true,
      }],
    ]);
  });
});

describe('Luna calls', () => {
  it('rejects and cancels a call that never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = foregroundAppInfo();
      const outcome = pending.then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_CALL_TIMEOUT_MS);
      const error = await outcome;
      expect(error).toBeInstanceOf(LunaMediaError);
      expect((error as InstanceType<typeof LunaMediaError>).code).toBe(-1);
      expect(cancels[0]).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unloads a pipeline whose load answered after its timeout', async () => {
    vi.useFakeTimers();
    try {
      const outcome = loadMedia({ uri: 'http://host/a.m3u8' }).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.LUNA_MEDIA_CALL_TIMEOUT_MS);
      expect(await outcome).toBeInstanceOf(LunaMediaError);
      expect(cancels[0]).not.toHaveBeenCalled();
      requests[0].options.onSuccess?.({ returnValue: true, mediaId: 'lm9' });
      expect(requests[1].options).toMatchObject({ method: 'unload', parameters: { mediaId: 'lm9' } });
      expect(cancels[0]).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
