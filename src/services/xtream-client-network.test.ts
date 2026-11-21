import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { faultFetch } from '../test/fault-fetch';
import { LegacyAbortController } from '../test/legacy-fetch';
import type { Fault } from '../test/fault-plan';
import { createXtreamClient } from './xtream-client';

// The client over the real download stack, with the panel's failures played by
// faultFetch: what each failure becomes, and that none leaves a caller waiting.

const creds = { baseUrl: 'http://host:8080', username: 'u1', password: 'p1' };
const ACCOUNT = 'http://host:8080/player_api.php?username=u1&password=p1';
const LIVE = `${ACCOUNT}&action=get_live_streams`;

let warn: MockInstance<typeof console.warn>;

function failureCodes(): string[] {
  return warn.mock.calls
    .map(args => args.join(' '))
    .filter(line => line.includes('event=xtream.request.failed'))
    .map(line => /code=(\w+)/.exec(line)?.[1] ?? '');
}

async function settle<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let result: T | 'pending' = 'pending';
  void promise.then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('XtreamClient over a failing panel', () => {
  it.each([401, 403, 503])('gives no account info for a %i', async (status) => {
    vi.stubGlobal('fetch', faultFetch({ [ACCOUNT]: { status, body: 'denied' } }));

    expect(await createXtreamClient(creds).getAccountInfo()).toBeNull();
    expect(failureCodes()).toEqual(['request_failed']);
  });

  it('gives no account info when the panel cannot be reached', async () => {
    vi.stubGlobal('fetch', faultFetch({ [ACCOUNT]: { networkError: true } }));

    expect(await createXtreamClient(creds).getAccountInfo()).toBeNull();
    expect(failureCodes()).toEqual(['request_failed']);
  });

  it.each<[string, Fault]>([
    ['never answers', { hang: true }],
    ['stalls after its headers', { body: '{"user_info":{"auth":1}}', stallAfterBytes: 5 }],
  ])('gives up on an account check whose panel %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch({ [ACCOUNT]: fault }));

    expect(await settle(createXtreamClient(creds).getAccountInfo(), 15_000)).toBeNull();
    expect(failureCodes()).toEqual(['timeout']);
  });

  it('gives up on an account check that stalls after its headers on webOS 4', async () => {
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch({ [ACCOUNT]: { body: '{"user_info":{"auth":1}}', stallAfterBytes: 5 } }));

    expect(await settle(createXtreamClient(creds).getAccountInfo(), 15_000)).toBeNull();
    expect(failureCodes()).toEqual(['timeout']);
  });

  it.each<[string, Fault, string]>([
    ['a 503', { status: 503 }, 'request_failed'],
    ['a connection cut partway', { body: '[{"stream_id":1,"name":"Alpha"}]', resetAfterBytes: 10 }, 'request_failed'],
    ['a list cut short', { body: '[{"stream_id":1,"na' }, 'invalid_json'],
    ['no answer', { hang: true }, 'timeout'],
  ])('reports the Live catalog unavailable after %s', async (_name, fault, code) => {
    vi.stubGlobal('fetch', faultFetch({ [LIVE]: fault }));

    expect(await settle(createXtreamClient(creds).getLiveStreamsResult(), 30_000))
      .toEqual({ available: false, streams: [] });
    expect(failureCodes()).toEqual([code]);
  });

  it('loads a Live catalog once the panel answers after a slow start', async () => {
    vi.stubGlobal('fetch', faultFetch({ [LIVE]: { delayMs: 5000, body: '[{"stream_id":1,"name":"Alpha"}]' } }));

    const result = await settle(createXtreamClient(creds).getLiveStreamsResult(), 6000);

    expect(result).toMatchObject({ available: true, streams: [{ streamId: '1', name: 'Alpha' }] });
  });
});
