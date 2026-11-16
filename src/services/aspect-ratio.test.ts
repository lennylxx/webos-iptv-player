import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LunaRequestHandle, LunaRequestOptions, LunaResponse } from './luna';
import { TvAspectRatio, isAspectRatio, tvAspectValue, type AspectDirtyFlag } from './aspect-ratio';

type Request = { uri: string; options: LunaRequestOptions; cancel: ReturnType<typeof vi.fn> };

function fakeLuna() {
  const requests: Request[] = [];
  const request = vi.fn((uri: string, options: LunaRequestOptions = {}): LunaRequestHandle => {
    const cancel = vi.fn();
    requests.push({ uri, options, cancel });
    return { cancel };
  });
  const fail = (index: number, response: LunaResponse) => requests[index].options.onFailure?.(response);
  const succeed = (index: number) => requests[index].options.onSuccess?.({ returnValue: true });
  const values = () => requests.map(r => (r.options.parameters as { value: string }).value);
  return { request, requests, fail, succeed, values };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('aspect ratio values', () => {
  it('maps each mode to the TV per-app setting', () => {
    expect(tvAspectValue('auto')).toBe('original');
    expect(tvAspectValue('16x9')).toBe('16x9');
    expect(tvAspectValue('4x3')).toBe('4x3');
    expect(tvAspectValue('zoom')).toBe('allDirZoom');
  });

  it('accepts only the offered modes', () => {
    expect(isAspectRatio('zoom')).toBe(true);
    expect(isAspectRatio('allDirZoom')).toBe(false);
    expect(isAspectRatio(null)).toBe(false);
  });
});

describe('TvAspectRatio', () => {
  const failed = (code: string) => ({ returnValue: false, errorCode: code as unknown as number });

  it('asks the bundled service to set the TV value', () => {
    const luna = fakeLuna();
    new TvAspectRatio(luna.request).enter('zoom');

    expect(luna.requests).toHaveLength(1);
    expect(luna.requests[0].uri).toBe(`luna://${__SERVICE_ID__}`);
    expect(luna.requests[0].options.method).toBe('setAspectRatio');
    expect(luna.requests[0].options.parameters).toEqual({ value: 'allDirZoom' });
  });

  it('leaves the TV setting alone on entering an Auto channel it never changed', () => {
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);
    tv.enter('auto');
    tv.enter('auto');
    expect(luna.requests).toHaveLength(0);
  });

  it('writes a remembered ratio on a change, and restores original once', () => {
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);

    tv.enter('4x3');
    tv.enter('4x3');
    luna.succeed(0);
    tv.enter('auto');
    luna.succeed(1);
    tv.enter('auto');
    expect(luna.values()).toEqual(['4x3', 'original']);
  });

  it('undoes a ratio an earlier launch left on the TV', () => {
    const luna = fakeLuna();
    let dirty = true;
    const flag: AspectDirtyFlag = { get: () => dirty, set: (value) => { dirty = value; } };
    const tv = new TvAspectRatio(luna.request, flag);

    tv.enter('auto');
    expect(luna.values()).toEqual(['original']);
    luna.fail(0, failed('timeout'));
    expect(dirty).toBe(true);

    tv.enter('auto');
    luna.succeed(1);
    expect(dirty).toBe(false);
    tv.enter('auto');
    expect(luna.values()).toEqual(['original', 'original']);
  });

  it('marks the TV changed before a non-original write goes out', () => {
    let dirty = false;
    const flag: AspectDirtyFlag = { get: () => dirty, set: (value) => { dirty = value; } };
    const seenDirty: boolean[] = [];
    const request = vi.fn((_uri: string, _options?: LunaRequestOptions): LunaRequestHandle => {
      seenDirty.push(dirty);
      return { cancel: () => {} };
    });
    new TvAspectRatio(request, flag).enter('4x3');
    expect(seenDirty).toEqual([true]);
  });

  it('writes a menu pick even when it matches the last value written', async () => {
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);
    tv.enter('zoom');
    luna.succeed(0);

    const picked = tv.pick('zoom');
    expect(luna.values()).toEqual(['allDirZoom', 'allDirZoom']);
    luna.succeed(1);
    await expect(picked).resolves.toBe('applied');

    const auto = tv.pick('auto');
    expect(luna.values()).toEqual(['allDirZoom', 'allDirZoom', 'original']);
    luna.fail(2, failed('timeout'));
    await expect(auto).resolves.toBe('failed');
  });

  it('logs a failure once per reason but keeps retrying a transient one on later tune-ins', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);
    const events = () => warn.mock.calls.map(args => args.join(' '))
      .filter(text => text.includes('event=player.aspect_failed'));

    tv.enter('16x9');
    luna.fail(0, failed('timeout'));
    tv.enter('16x9');
    luna.fail(1, failed('timeout'));
    expect(luna.requests).toHaveLength(2);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toContain('reason=timeout mode=16x9');

    tv.enter('16x9');
    luna.fail(2, { returnValue: false, errorCode: -1, errorText: 'Service does not exist' });
    expect(events()).toHaveLength(2);
    expect(events()[1]).toContain('reason=unavailable');
    tv.enter('16x9');
    expect(luna.requests).toHaveLength(4);
  });

  it.each(['no_bus', 'bad_value', 'settings_denied', 'settings_failed', 'denied'])(
    'stops tune-in writes after a %s failure but keeps the flag and menu picks', async (reason) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const luna = fakeLuna();
      let dirty = true;
      const flag: AspectDirtyFlag = { get: () => dirty, set: (value) => { dirty = value; } };
      const tv = new TvAspectRatio(luna.request, flag);

      tv.enter('auto');
      luna.fail(0, failed(reason));
      tv.enter('auto');
      tv.enter('4x3');
      expect(luna.requests).toHaveLength(1);
      expect(dirty).toBe(true);

      const picked = tv.pick('zoom');
      expect(luna.values()).toEqual(['original', 'allDirZoom']);
      luna.succeed(1);
      await expect(picked).resolves.toBe('applied');
      tv.enter('4x3');
      expect(luna.values()).toEqual(['original', 'allDirZoom', '4x3']);
    });

  it('retries on the next tune-in after the service reports a broken bus', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);

    tv.enter('16x9');
    luna.fail(0, failed('bus_error'));
    tv.enter('16x9');
    expect(luna.values()).toEqual(['16x9', '16x9']);
  });

  it('applies a tune-in made while an unblocking pick was in flight', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);
    tv.enter('4x3');
    luna.fail(0, failed('settings_failed'));

    const picked = tv.pick('16x9');
    tv.enter('auto');
    expect(luna.values()).toEqual(['4x3', '16x9']);
    luna.succeed(1);
    await expect(picked).resolves.toBe('applied');
    expect(luna.values()).toEqual(['4x3', '16x9', 'original']);
  });

  it('writes nothing extra after an unblocking pick when no tune-in came between', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);
    tv.enter('4x3');
    luna.fail(0, failed('settings_failed'));
    tv.enter('auto');

    const picked = tv.pick('16x9');
    luna.succeed(1);
    await expect(picked).resolves.toBe('applied');
    expect(luna.values()).toEqual(['4x3', '16x9']);
  });

  it('keeps a stale failure from undoing or reporting over a newer request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);

    const first = tv.pick('zoom');
    tv.enter('4x3');
    luna.fail(0, failed('superseded'));
    await expect(first).resolves.toBe('superseded');
    tv.enter('4x3');
    expect(luna.requests).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up on a request the service never answers and retries the next tune-in', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);

    const picked = tv.pick('zoom');
    vi.advanceTimersByTime(6999);
    tv.enter('zoom');
    expect(luna.requests).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await expect(picked).resolves.toBe('failed');
    expect(luna.requests[0].cancel).toHaveBeenCalled();
    expect(warn.mock.calls[0].join(' ')).toContain('reason=timeout mode=zoom');

    tv.enter('zoom');
    expect(luna.values()).toEqual(['allDirZoom', 'allDirZoom']);
  });

  it('ignores a success that arrives after the app gave up', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let dirty = true;
    const flag: AspectDirtyFlag = { get: () => dirty, set: (value) => { dirty = value; } };
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request, flag);

    const picked = tv.pick('auto');
    vi.advanceTimersByTime(7000);
    await expect(picked).resolves.toBe('failed');
    luna.succeed(0);
    expect(dirty).toBe(true);

    tv.enter('auto');
    expect(luna.values()).toEqual(['original', 'original']);
  });

  it('clears the timeout once the service answers', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const luna = fakeLuna();
    const tv = new TvAspectRatio(luna.request);

    const applied = tv.pick('4x3');
    luna.succeed(0);
    const failed = tv.pick('16x9');
    luna.fail(1, { returnValue: false, errorCode: 'bus_error' as unknown as number });
    expect(vi.getTimerCount()).toBe(0);
    await expect(applied).resolves.toBe('applied');
    await expect(failed).resolves.toBe('failed');
    expect(luna.requests[0].cancel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
