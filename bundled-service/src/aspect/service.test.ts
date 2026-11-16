import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousLunaCall, registerAspectService, type AspectLunaMsg, type LunaCall } from './service';

const APP_ID = 'com.example.app';

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

  it('names a settingsservice refusal', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const respond = setup((_uri, _payload, done) => {
      done({ returnValue: false, errorText: 'Access denied' });
      return () => {};
    })(APP_ID, { value: '4x3' });
    expect(respond.mock.calls[0][0]).toMatchObject({ returnValue: false, errorCode: 'settings_denied' });
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
