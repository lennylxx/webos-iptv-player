import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistEntry } from '../types';
import { faultFetch } from '../test/fault-fetch';
import { LegacyAbortController } from '../test/legacy-fetch';
import type { Fault } from '../test/fault-plan';

const { storage } = vi.hoisted(() => ({
  storage: { getPlaylists: vi.fn<() => PlaylistEntry[]>(() => []), setPlaylists: vi.fn(() => true) },
}));
vi.mock('./storage-service', () => ({ StorageService: storage }));

import { UploadClient } from './upload-client';
import { serviceBase, setServicePort } from './service-http';

const uploaded: PlaylistEntry = {
  id: 'p1', name: 'Upload', url: 'http://host/uploads/u1.m3u', source: 'upload', count: 2, revision: 1,
};

async function settle<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  let result: T | 'pending' = 'pending';
  void promise.then(value => { result = value; });
  await vi.advanceTimersByTimeAsync(ms);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setServicePort(9000);
  storage.getPlaylists.mockReturnValue([uploaded]);
});

afterEach(() => {
  setServicePort(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  storage.setPlaylists.mockClear();
});

describe('UploadClient over an unreliable service', () => {
  it.each<[string, Fault]>([
    ['is not running', { networkError: true }],
    ['never answers', { hang: true }],
    ['fails', { status: 500 }],
    ['stalls after its headers', { body: '[{"id":"u1"}]', stallAfterBytes: 3 }],
  ])('keeps the uploaded playlists when the service %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch(() => fault));

    expect(await settle(UploadClient.list(), 4000)).toBeNull();
    await settle(UploadClient.reconcile(), 4000);

    expect(storage.setPlaylists).not.toHaveBeenCalled();
  });

  it.each<[string, Fault]>([
    ['cuts the list off', { body: '[{"id":"u1","name":"A"}]', resetAfterBytes: 8 }],
    ['answers with something other than JSON', { body: '<html>error</html>' }],
  ])('keeps the uploaded playlists when the service %s', async (_name, fault) => {
    vi.stubGlobal('fetch', faultFetch(() => fault));

    expect(await UploadClient.list()).toBeNull();
    await UploadClient.reconcile();

    expect(storage.setPlaylists).not.toHaveBeenCalled();
  });

  it('lists uploads after a service that stalls on webOS 4 times out', async () => {
    vi.stubGlobal('AbortController', LegacyAbortController);
    vi.stubGlobal('fetch', faultFetch(() => ({ body: '[{"id":"u1"}]', stallAfterBytes: 3 })));

    expect(await settle(UploadClient.list(), 4000)).toBeNull();
  });

  it('reports a delete the service did not confirm', async () => {
    vi.stubGlobal('fetch', faultFetch({ [`${serviceBase()}/uploads/u1`]: [{ status: 503 }, { hang: true }, { status: 204 }] }));

    expect(await UploadClient.remove('u1')).toBe(false);
    expect(await settle(UploadClient.remove('u1'), 4000)).toBe(false);
    expect(await UploadClient.remove('u1')).toBe(true);
  });
});
