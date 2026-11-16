import { describe, expect, it, vi } from 'vitest';
import { appMethod, lunaFailure, onceResponder, type AppMsg } from './luna-reply';
import { createLogger } from './logger';

const APP = 'com.example.app';

function logger() {
  const target = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { target, log: createLogger('t1', target) };
}

function register(handler: (payload: { value?: unknown }, respond: (r: unknown) => void) => void) {
  const { target, log } = logger();
  let registered: ((msg: AppMsg<{ value?: unknown }>) => void) | null = null;
  appMethod<{ value?: unknown }>({
    register: (name, h) => { if (name === 'm1') registered = h; },
  }, APP, 'm1', log, handler);
  return { target, call: (msg: AppMsg<{ value?: unknown }>) => registered!(msg) };
}

describe('lunaFailure', () => {
  it('builds the failure reply, with extra fields when given', () => {
    expect(lunaFailure('bad_value', 'Text 1')).toEqual({ returnValue: false, errorCode: 'bad_value', errorText: 'Text 1' });
    expect(lunaFailure('http_403', 'Text 2', { status: 403 }))
      .toEqual({ returnValue: false, errorCode: 'http_403', errorText: 'Text 2', status: 403 });
  });
});

describe('onceResponder', () => {
  it('answers only once', () => {
    const respond = vi.fn();
    const reply = onceResponder({ respond }, 'm1', logger().log);
    reply({ returnValue: true });
    reply({ returnValue: false });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ returnValue: true });
  });

  it('logs a respond that throws instead of rethrowing', () => {
    const { target, log } = logger();
    const error = new Error('gone');
    const reply = onceResponder({ respond: () => { throw error; } }, 'm1', log);
    expect(() => reply({ returnValue: true })).not.toThrow();
    expect(target.error).toHaveBeenCalledWith('[t1]', 'm1 respond failed:', error);
  });
});

describe('appMethod', () => {
  it('denies another caller without running the handler', () => {
    const handler = vi.fn();
    const { target, call } = register(handler);
    const respond = vi.fn();
    call({ sender: 'com.example.other2 1234', respond, payload: { value: 1 } });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ returnValue: false, errorCode: 'denied', errorText: 'Caller is not allowed' });
    expect(target.warn).toHaveBeenCalledWith('[t1]', 'm1 outcome=denied sender="com.example.otherN NNNN" source=sender');
  });

  it('hands the app its payload, or an empty one, and a one-shot responder', () => {
    const seen: unknown[] = [];
    const { call } = register((payload, respond) => {
      seen.push(payload);
      respond({ returnValue: true });
      respond({ returnValue: false });
    });
    const respond = vi.fn();
    call({ sender: `${APP} 1234`, respond, payload: { value: 'v1' } });
    call({ sender: APP, respond });

    expect(seen).toEqual([{ value: 'v1' }, {}]);
    expect(respond.mock.calls).toEqual([[{ returnValue: true }], [{ returnValue: true }]]);
  });
});
