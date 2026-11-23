import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousLunaCall, registerAspectService, type AspectLunaMsg, type LunaCall, type LunaReply } from './service';

const APP_ID = 'com.example.app';
const SETTINGS = 'luna://com.webos.settingsservice/setSystemSettings';

function setup(call: LunaCall | null) {
  let handler: ((msg: AspectLunaMsg) => void) | null = null;
  registerAspectService({ register: (name, h) => { if (name === 'setAspectRatio') handler = h; } }, APP_ID, call);
  return (sender: string, payload: AspectLunaMsg['payload']) => {
    const respond = vi.fn();
    handler!({ respond, payload, sender });
    return respond;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setAspectRatio', () => {
  it('sets the app\'s own per-app aspect ratio', () => {
    const call = vi.fn<LunaCall>((_uri, _payload, done) => { done({ returnValue: true }); return () => {}; });
    const respond = setup(call)(APP_ID + ' 1234', { value: 'allDirZoom' });

    expect(call).toHaveBeenCalledWith(
      'luna://com.webos.settingsservice/setSystemSettings',
      { category: 'aspectRatio', app_id: APP_ID, settings: { arcPerApp: 'allDirZoom' } },
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith({ returnValue: true, value: 'allDirZoom' });
  });

  it('falls back after settings denial, pairs the crop inputs, and remembers the route', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = vi.fn<LunaCall>((uri, _payload, done) => {
      if (uri === SETTINGS) done({ returnValue: false, errorText: 'Access denied' });
      else if (uri.endsWith('/getStatus')) done({ returnValue: true, video: [{
        appId: APP_ID, context: 'media1', connected: true, width: 1280, height: 720,
      }] });
      else done({ returnValue: true });
      return () => {};
    });
    const send = setup(call);
    expect(send(APP_ID, { value: 'allDirZoom', mediaId: 'media1' }))
      .toHaveBeenCalledWith({ returnValue: true, value: 'allDirZoom', backend: 'videooutput' });
    expect(call.mock.calls[2][1]).toMatchObject({
      context: 'media1', originalInput: { x: 0, y: 0, width: 1280, height: 720 },
      sourceInput: { x: 160, y: 90, width: 960, height: 540 },
    });
    send(APP_ID, { value: '4x3', mediaId: 'media1' });
    expect(call.mock.calls.filter(([uri]) => uri.includes('settingsservice'))).toHaveLength(1);
    expect(call.mock.calls[4][1]).toMatchObject({
      displayOutput: { x: 240, y: 0, width: 1440, height: 1080 },
    });
    expect(warn.mock.calls.filter(args => args.join(' ').includes('event=player.aspect.fallback backend=videooutput reason=settings_denied')))
      .toHaveLength(1);
  });

  it('answers only the app and only an offered value', () => {
    const call = vi.fn<LunaCall>(() => () => {});
    const send = setup(call);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(send('com.example.other', { value: '16x9' }).mock.calls[0][0])
      .toMatchObject({ returnValue: false, errorCode: 'denied' });
    expect(send(APP_ID, { value: 'twinZoom' }).mock.calls[0][0])
      .toMatchObject({ returnValue: false, errorCode: 'bad_value' });
    expect(call).not.toHaveBeenCalled();
  });

  it('waits for the media after a refusal, but fails a write settingsservice merely could not do', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = vi.fn<LunaCall>((_uri, payload, done) => {
      const value = (payload.settings as { arcPerApp: string }).arcPerApp;
      done({ returnValue: false, errorText: value === '4x3' ? 'Internal error' : 'Access denied' });
      return () => {};
    });
    const send = setup(call);
    expect(send(APP_ID, { value: '4x3' }).mock.calls[0][0])
      .toMatchObject({ returnValue: false, errorCode: 'settings_failed' });
    expect(send(APP_ID, { value: '16x9' }).mock.calls[0][0])
      .toEqual({ returnValue: false, errorCode: 'video_pending', errorText: 'The video is not ready',
        backend: 'videooutput' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps trying settingsservice after a broken bus or a timeout', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replies: (LunaReply | null)[] = [{ returnValue: false, errorCode: 'bus_error', errorText: 'Access denied' }, null];
    const call = vi.fn<LunaCall>((_uri, _payload, done) => {
      const reply = replies.shift();
      if (reply) done(reply);
      return () => {};
    });
    const send = setup(call);
    expect(send(APP_ID, { value: '4x3', mediaId: 'm1' }).mock.calls[0][0]).toMatchObject({ errorCode: 'bus_error' });
    const timedOut = send(APP_ID, { value: '4x3', mediaId: 'm1' });
    vi.advanceTimersByTime(5000);
    expect(timedOut.mock.calls[0][0]).toEqual({ returnValue: false, errorCode: 'timeout',
      errorText: 'Aspect ratio request did not answer' });
    send(APP_ID, { value: '4x3', mediaId: 'm1' });
    expect(call.mock.calls.map(([uri]) => uri)).toEqual(Array(3).fill(SETTINGS));
  });

  it('touches only the app\'s own connected media', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = vi.fn<LunaCall>((uri, _payload, done) => {
      if (uri === SETTINGS) done({ returnValue: false, errorText: 'Access denied' });
      else if (uri.endsWith('/getStatus')) done({ returnValue: true, video: [
        { appId: 'com.example.other', context: 'm1', connected: true, width: 1920, height: 1080 },
        { appId: APP_ID, context: 'm0', connected: true, width: 1920, height: 1080 },
        { appId: APP_ID, context: 'm1', connected: false, width: 1920, height: 1080 },
      ] });
      else done({ returnValue: true });
      return () => {};
    });
    expect(setup(call)(APP_ID, { value: 'allDirZoom', mediaId: 'm1' }).mock.calls[0][0])
      .toMatchObject({ errorCode: 'video_pending', backend: 'videooutput' });
    expect(call.mock.calls.some(([uri]) => uri.endsWith('/setDisplayWindow'))).toBe(false);
  });

  it('reports a refused video window, and times out a videooutput step', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cancel = vi.fn();
    let hang = false;
    const call = vi.fn<LunaCall>((uri, _payload, done) => {
      if (uri === SETTINGS) done({ returnValue: false, errorText: 'Access denied' });
      else if (uri.endsWith('/getStatus')) {
        if (hang) return cancel;
        done({ returnValue: true, video: [{ appId: APP_ID, context: 'm1', connected: true, width: 1280, height: 720 }] });
      } else done({ returnValue: false, errorCode: 102, errorText: 'Not supported' });
      return () => {};
    });
    const send = setup(call);
    expect(send(APP_ID, { value: '4x3', mediaId: 'm1' }).mock.calls[0][0]).toEqual({
      returnValue: false, errorCode: 'video_failed', errorText: 'Not supported', backend: 'videooutput' });
    hang = true;
    const timedOut = send(APP_ID, { value: '4x3', mediaId: 'm1' });
    const next = send(APP_ID, { value: 'original', mediaId: 'm1' });
    vi.advanceTimersByTime(5000);
    expect(cancel).toHaveBeenCalled();
    expect(timedOut.mock.calls[0][0]).toMatchObject({ errorCode: 'timeout', backend: 'videooutput' });
    expect(next).not.toHaveBeenCalled();
    expect(call.mock.calls.filter(([uri]) => uri.endsWith('/getStatus'))).toHaveLength(3);
  });

  it('rejects a malformed media id or display', () => {
    const call = vi.fn<LunaCall>(() => () => {});
    const send = setup(call);
    expect(send(APP_ID, { value: '4x3', mediaId: 7 }).mock.calls[0][0]).toMatchObject({ errorCode: 'bad_display' });
    expect(send(APP_ID, { value: '4x3', display: { x: 1920, y: 0, width: 10, height: 10 } }).mock.calls[0][0])
      .toMatchObject({ errorCode: 'bad_display' });
    expect(call).not.toHaveBeenCalled();
  });

  it('reports a broken bus as bus_error, then writes on a fresh handle', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let handles = 0;
    class Handle {
      constructor() { handles++; }
      call() {
        if (handles === 1) throw new Error('Access denied: bus gone');
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) =>
            listener({ payload: () => '{"returnValue":true}' }),
          cancel: () => {},
        };
      }
    }
    const send = setup(anonymousLunaCall({ Handle }));
    expect(send(APP_ID, { value: '4x3' }).mock.calls[0][0])
      .toMatchObject({ returnValue: false, errorCode: 'bus_error' });
    expect(send(APP_ID, { value: '4x3' })).toHaveBeenCalledWith({ returnValue: true, value: '4x3' });
  });

  it('cancels a request settingsservice never answered, then sends the next', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending: { value: unknown; done: (reply: { returnValue: boolean }) => void; cancel: () => void }[] = [];
    const send = setup((_uri, payload, done) => {
      const cancel = vi.fn();
      pending.push({ value: (payload.settings as { arcPerApp: string }).arcPerApp, done, cancel });
      return cancel;
    });
    const first = send(APP_ID, { value: 'allDirZoom' });
    const second = send(APP_ID, { value: 'original' });
    expect(pending.map(p => p.value)).toEqual(['allDirZoom']);

    vi.advanceTimersByTime(5000);
    expect(pending[0].cancel).toHaveBeenCalled();
    expect(first.mock.calls[0][0]).toMatchObject({ returnValue: false, errorCode: 'timeout' });
    expect(pending.map(p => p.value)).toEqual(['allDirZoom', 'original']);

    pending[0].done({ returnValue: true });
    pending[1].done({ returnValue: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ returnValue: true, value: 'original' });
  });

  it('sends only the newest of the values waiting behind a write', () => {
    const pending: { value: unknown; done: (reply: { returnValue: boolean }) => void }[] = [];
    const send = setup((_uri, payload, done) => {
      pending.push({ value: (payload.settings as { arcPerApp: string }).arcPerApp, done });
      return () => {};
    });
    send(APP_ID, { value: '4x3' });
    const stale = send(APP_ID, { value: '16x9' });
    const newest = send(APP_ID, { value: 'allDirZoom' });
    expect(stale.mock.calls[0][0]).toMatchObject({ returnValue: false, errorCode: 'superseded' });

    pending[0].done({ returnValue: true });
    expect(pending.map(p => p.value)).toEqual(['4x3', 'allDirZoom']);
    pending[1].done({ returnValue: true });
    expect(newest).toHaveBeenCalledWith({ returnValue: true, value: 'allDirZoom' });
  });
});

describe('anonymousLunaCall', () => {
  it('reuses one anonymous handle and parses each reply', () => {
    const handles: string[] = [];
    const calls: [string, string][] = [];
    class Handle {
      constructor(name: string) { handles.push(name); }
      call(uri: string, payload: string) {
        calls.push([uri, payload]);
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) =>
            listener({ payload: () => '{"returnValue":true}' }),
          cancel: () => {},
        };
      }
    }
    const call = anonymousLunaCall({ Handle })!;
    const done = vi.fn();
    call('luna://a/b', { x: 1 }, done);
    expect(typeof call('luna://a/b', { x: 2 }, done)).toBe('function');

    expect(handles).toEqual(['']);
    expect(calls).toEqual([['luna://a/b', '{"x":1}'], ['luna://a/b', '{"x":2}']]);
    expect(done).toHaveBeenCalledWith({ returnValue: true });
  });

  it('builds a new handle after a call fails to set up', () => {
    const handles: number[] = [];
    let calls = 0;
    class Handle {
      constructor() { handles.push(handles.length); }
      call() {
        if (++calls === 1) throw new Error('bus gone');
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) =>
            listener({ payload: () => '{"returnValue":true}' }),
          cancel: () => {},
        };
      }
    }
    const call = anonymousLunaCall({ Handle })!;
    const done = vi.fn();
    call('luna://a/b', {}, done);
    call('luna://a/b', {}, done);

    expect(done.mock.calls).toEqual([
      [{ returnValue: false, errorCode: 'bus_error', errorText: 'bus gone' }],
      [{ returnValue: true }],
    ]);
    expect(handles).toHaveLength(2);
  });

  it('reports a malformed reply as bus_error and builds a new handle', () => {
    let handles = 0;
    const cancel = vi.fn();
    class Handle {
      constructor() { handles++; }
      call() {
        const body = handles === 1 ? 'not json' : '{"returnValue":true}';
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) =>
            listener({ payload: () => body }),
          cancel,
        };
      }
    }
    const call = anonymousLunaCall({ Handle })!;
    const done = vi.fn();
    call('luna://a/b', {}, done);
    expect(cancel).toHaveBeenCalledTimes(1);
    call('luna://a/b', {}, done);

    expect(done.mock.calls).toEqual([
      [{ returnValue: false, errorCode: 'bus_error', errorText: 'Invalid Luna response' }],
      [{ returnValue: true }],
    ]);
    expect(handles).toBe(2);
  });

  it.each(['null', '[]', '7', '"ok"'])('reports a non-object %s reply as bus_error without throwing', (body) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let handles = 0;
    const cancel = vi.fn();
    class Handle {
      constructor() { handles++; }
      call() {
        const payload = handles === 1 ? body : '{"returnValue":true}';
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) =>
            listener({ payload: () => payload }),
          cancel,
        };
      }
    }
    const send = setup(anonymousLunaCall({ Handle }));
    expect(send(APP_ID, { value: '4x3' }).mock.calls[0][0])
      .toEqual({ returnValue: false, errorCode: 'bus_error', errorText: 'Invalid Luna response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(send(APP_ID, { value: '4x3' })).toHaveBeenCalledWith({ returnValue: true, value: '4x3' });
    expect(handles).toBe(2);
  });

  it('builds a new handle after a request was canceled unanswered', () => {
    let handles = 0;
    const listeners: ((m: { payload(): string }) => void)[] = [];
    class Handle {
      readonly id = ++handles;
      call() {
        return {
          addListener: (_event: string, listener: (m: { payload(): string }) => void) => { listeners.push(listener); },
          cancel: () => {},
        };
      }
    }
    const call = anonymousLunaCall({ Handle })!;
    const done = vi.fn();
    call('luna://a/b', {}, done);
    listeners[0]({ payload: () => '{"returnValue":true}' });
    call('luna://a/b', {}, done)();
    expect(handles).toBe(1);

    call('luna://a/b', {}, done);
    expect(handles).toBe(2);
  });

  it('cancels a request whose listener cannot be attached', () => {
    const cancel = vi.fn();
    class Handle {
      call() {
        return { addListener: () => { throw new Error('no listener'); }, cancel };
      }
    }
    const done = vi.fn();
    anonymousLunaCall({ Handle })!('luna://a/b', {}, done);
    expect(cancel).toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({ returnValue: false, errorCode: 'bus_error', errorText: 'no listener' });
  });

  it('fails cleanly when no handle can be built', () => {
    class Handle {
      constructor() { throw new Error('no bus'); }
      call(): never { throw new Error('unreachable'); }
    }
    const done = vi.fn();
    anonymousLunaCall({ Handle })!('luna://a/b', {}, done);
    expect(done).toHaveBeenCalledWith({ returnValue: false, errorCode: 'bus_error', errorText: 'no bus' });
  });
});
