import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { faultFetch } from '../test/fault-fetch';
import { LegacyAbortController } from '../test/legacy-fetch';
import type { Fault } from '../test/fault-plan';

const { storage } = vi.hoisted(() => ({
  storage: {
    getPlaylists: vi.fn(() => []),
    setPlaylists: vi.fn(() => true),
    getManualEpgSources: vi.fn(() => []),
    setManualEpgSources: vi.fn(() => true),
    getOnlineSubtitleConfig: vi.fn(() => ({
      preferredLanguage: '',
      subdl: { apiKey: '' },
      assrt: { apiKey: '' },
      opensubtitles: { apiKey: '', username: '', password: '' },
    })),
    setOnlineSubtitleConfig: vi.fn(() => true),
  },
}));
vi.mock('./storage-service', () => ({ StorageService: storage }));
vi.mock('./parental-control', () => ({ ParentalControlService: {} }));

import { SetupClient } from './setup-client';
import { setServicePort } from './service-http';

async function settle<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let result: T | 'pending' = 'pending';
  void promise.then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

const FAULTS: Array<[string, Fault]> = [
  ['is not running', { networkError: true }],
  ['never answers', { hang: true }],
  ['fails', { status: 500 }],
  ['stalls after its headers', { body: '[{"id":1}]', stallAfterBytes: 3 }],
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setServicePort(9000);
});

afterEach(() => {
  setServicePort(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  storage.setPlaylists.mockClear();
});

describe('SetupClient over an unreliable service', () => {
  it.each(FAULTS)('applies no phone changes when the service %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch(() => fault));

    expect(await settle(SetupClient.applyPendingActions(), 4000)).toBe(false);
    expect(storage.setPlaylists).not.toHaveBeenCalled();
  });

  it.each(FAULTS)('reports no setup info or published state when the service %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch(() => fault));

    expect(await settle(SetupClient.getInfo(), 4000)).toBeNull();
    expect(await settle(SetupClient.publishState(), 4000)).toBe(false);
  });

  it.each<[string, Fault]>([
    ['cuts the actions off', { body: '[{"id":1,"type":"playlist"}]', resetAfterBytes: 8 }],
    ['answers with something other than JSON', { body: '<html>error</html>' }],
    ['answers with something other than a list', { body: '{"id":1}' }],
  ])('applies no phone changes when the service %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch(() => fault));

    expect(await SetupClient.applyPendingActions()).toBe(false);
    expect(storage.setPlaylists).not.toHaveBeenCalled();
  });

  it('gives up on pending phone changes that stall on webOS 4', async () => {
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '[{"id":1}]', stallAfterBytes: 3 })));

    expect(await settle(SetupClient.applyPendingActions(), 4000)).toBe(false);
  });
});
