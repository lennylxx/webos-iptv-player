import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LunaRequestHandle, LunaRequestOptions, LunaResponse } from './luna';
import { TvAspectRatio, isAspectRatio, tvAspectValue, type AspectDirtyFlag, type AspectPlayback } from './aspect-ratio';

type Request = { uri: string; options: LunaRequestOptions; cancel: ReturnType<typeof vi.fn>; settled?: boolean };

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

  it.each(['no_bus', 'bad_value', 'settings_failed', 'denied'])(
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
  it('lets a TV-setting write finish across a stall reload', async () => {
    const luna = fakeLuna();
    let dirty = true;
    const tv = new TvAspectRatio(luna.request, { get: () => dirty, set: (value) => { dirty = value; } });
    tv.enter('zoom');
    luna.fail(0, failed('denied'));
    tv.enter('16x9');
    expect(luna.requests).toHaveLength(1);
    const picked = tv.pick('auto');
    tv.reset();
    luna.succeed(1);
    await expect(picked).resolves.toBe('applied');
    expect(dirty).toBe(false);
    tv.enter('16x9');
    expect(luna.values()).toEqual(['allDirZoom', 'original', '16x9']);
  });
});

describe('TvAspectRatio on the videooutput route', () => {
  const video = { returnValue: true, backend: 'videooutput' };
  const notReady = { returnValue: false, errorCode: 'video_pending' as unknown as number, backend: 'videooutput' };
  const params = (luna: ReturnType<typeof fakeLuna>, index: number) => luna.requests[index].options.parameters;

  function setup(dirtyAtStart = false) {
    const luna = fakeLuna();
    let dirty = dirtyAtStart;
    const flag: AspectDirtyFlag = { get: () => dirty, set: (value) => { dirty = value; } };
    const state: { playback: AspectPlayback | null } = { playback: null };
    const tv = new TvAspectRatio(luna.request, flag, () => state.playback);
    const reply = (index: number, response: object) => {
      const options = luna.requests[index].options;
      if ((response as { returnValue: boolean }).returnValue) options.onSuccess?.(response as LunaResponse);
      else options.onFailure?.(response as LunaResponse);
    };
    return { luna, tv, state, reply, dirty: () => dirty };
  }
  const media = (mediaId: string, display: AspectPlayback['display'] = 'full'): AspectPlayback =>
    ({ mediaId, width: 1920, height: 1080, display });

  it('writes a remembered ratio once the new media is ready, without marking the TV setting', async () => {
    const { luna, tv, state, reply, dirty } = setup();
    tv.enter('zoom');
    expect(dirty()).toBe(true);
    reply(0, notReady);
    expect(dirty()).toBe(false);
    expect(tv.reapply()).toBe(false);

    state.playback = media('m1');
    expect(tv.reapply()).toBe(true);
    expect(params(luna, 1)).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
    expect(tv.reapply()).toBe(true);
    reply(1, video);
    expect(luna.requests).toHaveLength(2);

    state.playback = media('m1', { x: 10, y: 10, width: 640, height: 360 });
    tv.reapply();
    expect(params(luna, 2)).toMatchObject({ display: { x: 10, y: 10, width: 640, height: 360 } });
    await Promise.resolve();
    expect(dirty()).toBe(false);
  });

  it('leaves an Auto media alone, but restores one it cropped', () => {
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    void tv.pick('4x3');
    reply(0, video);

    tv.enter('auto');
    expect(params(luna, 1)).toEqual({ value: 'original', mediaId: 'm1', display: 'full' });
    reply(1, video);
    expect(tv.reapply()).toBe(false);

    state.playback = media('m2');
    tv.reset();
    tv.enter('auto');
    expect(tv.reapply()).toBe(false);
    tv.enter('16x9');
    expect(params(luna, 2)).toEqual({ value: '16x9', mediaId: 'm2', display: 'full' });
    expect(luna.requests).toHaveLength(3);
  });

  it('defers a pick on unready media, then retries a few times without spinning', async () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    const picked = tv.pick('zoom');
    reply(0, notReady);
    await expect(picked).resolves.toBe('deferred');

    state.playback = media('m1');
    tv.reapply();
    for (let i = 1; i <= 4; i++) {
      reply(i, notReady);
      vi.advanceTimersByTime(1000);
    }
    expect(luna.requests).toHaveLength(5);
    tv.reset();
    tv.reapply();
    expect(luna.requests).toHaveLength(6);
  });

  it('retries a failed window a bounded number of times, not on every relayout', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    void tv.pick('zoom');
    for (let i = 0; i < 10; i++) {
      const last = luna.requests.length - 1;
      if (!luna.requests[last].settled) reply(last, { returnValue: false, errorCode: 'video_failed', backend: 'videooutput' });
      luna.requests[last].settled = true;
      expect(tv.reapply()).toBe(true);
      vi.advanceTimersByTime(1000);
    }
    expect(luna.requests).toHaveLength(4);
    expect(warn.mock.calls.filter(args => args.join(' ').includes('reason=video_failed'))).toHaveLength(1);

    state.playback = media('m2');
    tv.reapply();
    expect(luna.requests).toHaveLength(5);
  });

  it('bounds the writes of a preview relayouting every second while the media stays unconnected', () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    tv.enter('4x3');
    reply(0, notReady);
    state.playback = media('m1', { x: 10, y: 10, width: 640, height: 360 });
    for (let i = 0; i < 10; i++) {
      tv.reapply();
      const last = luna.requests.length - 1;
      if (!luna.requests[last].settled) reply(last, notReady);
      luna.requests[last].settled = true;
      vi.advanceTimersByTime(1000);
    }
    expect(luna.requests).toHaveLength(1 + 1 + 3);
  });

  it('retries an automatic write the bus dropped until it lands', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { luna, tv, state, reply } = setup();
    tv.enter('zoom');
    reply(0, notReady);
    state.playback = media('m1');
    tv.reapply();
    reply(1, { returnValue: false, errorCode: 'bus_error', backend: 'videooutput' });
    tv.reapply();
    expect(luna.requests).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(params(luna, 2)).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
    reply(2, video);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(3);
    expect(tv.reapply()).toBe(true);
    expect(luna.requests).toHaveLength(3);
  });

  it('drops a retry once the load is reset or a newer write went out', () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    tv.enter('zoom');
    reply(0, notReady);
    state.playback = media('m1');
    tv.reapply();
    reply(1, notReady);
    tv.reset();
    state.playback = null;
    vi.advanceTimersByTime(1000);
    expect(luna.requests).toHaveLength(2);

    state.playback = media('m2');
    tv.reapply();
    reply(2, notReady);
    tv.enter('4x3');
    expect(params(luna, 3)).toMatchObject({ value: '4x3', mediaId: 'm2' });
    vi.advanceTimersByTime(1000);
    expect(luna.requests).toHaveLength(4);
  });

  it.each([
    ['lands', video],
    ['is deferred', notReady],
  ])('writes the current size once the first reply %s and names the route', (_, first) => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    state.playback = { mediaId: 'm1', width: 1280, height: 720, display: 'full' };
    void tv.pick('zoom');
    state.playback = media('m1');
    expect(tv.reapply()).toBe(false);
    reply(0, first);
    expect(luna.requests).toHaveLength(2);
    expect(params(luna, 1)).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
    reply(1, video);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(2);
  });

  it('writes nothing more when the first reply names the route for an unchanged media', () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    void tv.pick('zoom');
    reply(0, video);
    tv.reapply(true);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(1);
  });

  it('still retries a first deferred write for an unchanged media', () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    void tv.pick('zoom');
    reply(0, notReady);
    expect(luna.requests).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(params(luna, 1)).toEqual({ value: 'allDirZoom', mediaId: 'm1', display: 'full' });
  });

  it.each([
    ['lands', video],
    ['is deferred', notReady],
    ['fails', { returnValue: false, errorCode: 'video_failed', backend: 'videooutput' }],
  ])('crops the next load\'s media once the last load\'s reply %s and names the route', async (_, late) => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    const picked = tv.pick('zoom');
    tv.reset();
    state.playback = null;
    tv.enter('zoom');
    expect(luna.requests).toHaveLength(1);
    state.playback = media('m2');
    expect(tv.reapply(true)).toBe(false);

    reply(0, late);
    await expect(picked).resolves.toBe('superseded');
    expect(luna.requests).toHaveLength(2);
    expect(params(luna, 1)).toEqual({ value: 'allDirZoom', mediaId: 'm2', display: 'full' });
    tv.reapply(true);
    reply(1, video);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(2);
  });

  it('waits for the next load\'s media when the last load\'s reply names the route first', () => {
    vi.useFakeTimers();
    const { luna, tv, state, reply } = setup();
    state.playback = media('m1');
    void tv.pick('zoom');
    tv.reset();
    state.playback = null;
    reply(0, video);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(1);
    state.playback = media('m2');
    tv.reapply(true);
    expect(params(luna, 1)).toMatchObject({ mediaId: 'm2' });
  });

  function exhaustPending() {
    vi.useFakeTimers();
    const ctx = setup();
    const { luna, tv, state, reply } = ctx;
    tv.enter('4x3');
    reply(0, notReady);
    state.playback = media('m1');
    tv.reapply(true);
    tv.reapply(true);
    expect(luna.requests).toHaveLength(2);
    for (let i = 1; i <= 4; i++) {
      reply(i, notReady);
      vi.advanceTimersByTime(1000);
    }
    expect(luna.requests).toHaveLength(5);
    return ctx;
  }

  it('writes again once the media starts playing after its retries ran out', () => {
    const { luna, tv, reply } = exhaustPending();
    for (let i = 0; i < 10; i++) tv.reapply();
    expect(luna.requests).toHaveLength(5);

    tv.reapply(true);
    expect(params(luna, 5)).toEqual({ value: '4x3', mediaId: 'm1', display: 'full' });
    reply(5, video);
    tv.reapply(true);
    tv.reapply();
    expect(luna.requests).toHaveLength(6);
  });

  it('gives a menu pick its own retries after the load spent them', async () => {
    const { luna, tv, reply } = exhaustPending();
    const picked = tv.pick('4x3');
    reply(5, notReady);
    await expect(picked).resolves.toBe('deferred');
    for (let i = 6; i <= 8; i++) {
      vi.advanceTimersByTime(1000);
      expect(luna.requests).toHaveLength(i + 1);
      reply(i, notReady);
    }
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(9);
  });

  it.each([
    ['pending', notReady],
    ['failed', { returnValue: false, errorCode: 'video_failed', backend: 'videooutput' }],
  ])('keeps the next load\'s retries when the last load\'s write answers %s late', (_, late) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { luna, tv, state, reply } = setup();
    tv.enter('zoom');
    reply(0, notReady);
    state.playback = media('m1');
    tv.reapply(true);
    tv.reset();
    state.playback = null;
    reply(1, late);
    vi.advanceTimersByTime(5000);
    expect(luna.requests).toHaveLength(2);

    state.playback = media('m2');
    tv.reapply(true);
    for (let i = 2; i <= 5; i++) {
      expect(luna.requests).toHaveLength(i + 1);
      reply(i, notReady);
      vi.advanceTimersByTime(1000);
    }
    expect(luna.requests).toHaveLength(6);
  });

  it('reports a pick the last load\'s media answered as superseded', async () => {
    const { tv, state, reply } = setup();
    tv.enter('zoom');
    reply(0, notReady);
    state.playback = media('m1');
    const picked = tv.pick('4x3');
    tv.reset();
    state.playback = media('m2');
    reply(1, video);
    await expect(picked).resolves.toBe('superseded');
  });

  it('leaves new media to the player while settingsservice applies the ratio', () => {
    const { luna, tv, state } = setup();
    state.playback = media('m1');
    tv.enter('zoom');
    luna.succeed(0);
    state.playback = media('m2');
    expect(tv.reapply()).toBe(false);
    expect(luna.requests).toHaveLength(1);
  });
});
