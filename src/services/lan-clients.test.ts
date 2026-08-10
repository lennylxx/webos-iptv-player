import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storageMock, fetchWithTimeoutMock } = vi.hoisted(() => ({
  storageMock: {
    playlists: [] as Array<{
      id?: string;
      name: string;
      url: string;
      source?: 'upload' | 'url' | 'xtream';
      count?: number;
      xtream?: { username: string; password: string; liveOutput?: 'auto' | 'ts' | 'm3u8' };
    }>,
    epgUrl: '',
    getPlaylists: vi.fn(),
    setPlaylists: vi.fn(),
    getEpgUrl: vi.fn(),
    setEpgUrl: vi.fn(),
    remove: vi.fn(),
  },
  fetchWithTimeoutMock: vi.fn(),
}));
storageMock.getPlaylists.mockImplementation(() => storageMock.playlists);
storageMock.setPlaylists.mockImplementation((next: typeof storageMock.playlists) => {
  storageMock.playlists = next;
  return true;
});
storageMock.getEpgUrl.mockImplementation(() => storageMock.epgUrl);
storageMock.setEpgUrl.mockImplementation((url: string) => {
  storageMock.epgUrl = url;
  return true;
});

vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../utils/fetch-helper', () => ({ fetchWithTimeout: fetchWithTimeoutMock }));

import { setServicePort } from './service-http';
import { SetupClient } from './setup-client';
import { UploadClient, uploadIdFromUrl } from './upload-client';

function jsonResponse(data: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => {
  storageMock.playlists = [];
  storageMock.epgUrl = '';
  storageMock.getPlaylists.mockClear();
  storageMock.setPlaylists.mockClear();
  storageMock.getEpgUrl.mockClear();
  storageMock.setEpgUrl.mockClear();
  storageMock.remove.mockClear();
  fetchWithTimeoutMock.mockReset();
  // Simulate the Luna `start` response that the app applies before any
  // LAN client call. Without this, serviceBase() returns null and all methods
  // no-op (which is the no-port path covered by its own describe block).
  setServicePort(8890);
});

describe('uploadIdFromUrl', () => {
  it('extracts the id from a standard upload URL', () => {
    expect(uploadIdFromUrl('http://127.0.0.1:8890/uploads/my-list.m3u')).toBe('my-list');
  });

  it('strips the .m3u extension and percent-decodes', () => {
    expect(uploadIdFromUrl('http://x/uploads/some%20list.m3u')).toBe('some list');
  });

  it('tolerates a URL without the .m3u suffix', () => {
    expect(uploadIdFromUrl('http://x/uploads/raw')).toBe('raw');
  });

  it('returns "" for URLs that do not match the /uploads/ pattern', () => {
    expect(uploadIdFromUrl('http://example.com/feeds/list.m3u')).toBe('');
    expect(uploadIdFromUrl('')).toBe('');
  });
});

describe('LAN clients when the service port is not yet known', () => {
  beforeEach(() => setServicePort(null));

  it('getInfo no-ops to null without calling fetch', async () => {
    expect(await SetupClient.getInfo()).toBeNull();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('list no-ops to null without calling fetch', async () => {
    expect(await UploadClient.list()).toBeNull();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('remove no-ops to false without calling fetch', async () => {
    expect(await UploadClient.remove('any-id')).toBe(false);
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it('reconcile no-ops without touching storage', async () => {
    storageMock.playlists = [
      { name: 'Old upload', url: 'http://127.0.0.1:8890/uploads/old.m3u', source: 'upload' },
    ];
    await UploadClient.reconcile();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(storageMock.setPlaylists).not.toHaveBeenCalled();
    expect(storageMock.remove).not.toHaveBeenCalled();
  });
});

describe('UploadClient.reconcile', () => {
  it('is a no-op when the LAN service is unreachable (does not delete existing uploads)', async () => {
    storageMock.playlists = [
      { name: 'Manual', url: 'http://m', source: 'url' },
      { name: 'Old upload', url: 'http://127.0.0.1:8890/uploads/old.m3u', source: 'upload' },
    ];
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).not.toHaveBeenCalled();
    expect(storageMock.remove).not.toHaveBeenCalled();
  });

  it('adds the uploaded list to storage, preserving manual entries', async () => {
    storageMock.playlists = [{ name: 'Manual', url: 'http://m', source: 'url' }];
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([
      { id: 'p1', name: 'Phone One', count: 5, createdAt: 1, url: 'http://127.0.0.1:8890/uploads/p1.m3u' },
    ]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { name: 'Manual', url: 'http://m', source: 'url' },
      { id: expect.any(String), name: 'Phone One', url: 'http://127.0.0.1:8890/uploads/p1.m3u', source: 'upload', count: 5 },
    ]);
  });

  it('removes uploaded entries that no longer exist on the service', async () => {
    storageMock.playlists = [
      { name: 'Manual', url: 'http://m', source: 'url' },
      { name: 'Stale', url: 'http://127.0.0.1:8890/uploads/stale.m3u', source: 'upload' },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { name: 'Manual', url: 'http://m', source: 'url' },
    ]);
  });

  it('skips writing storage when the uploaded list is already in sync', async () => {
    storageMock.playlists = [
      { name: 'Manual', url: 'http://m', source: 'url' },
      { name: 'P1', url: 'http://127.0.0.1:8890/uploads/p1.m3u', source: 'upload', count: 5 },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([
      { id: 'p1', name: 'P1', count: 5, createdAt: 1, url: 'http://127.0.0.1:8890/uploads/p1.m3u' },
    ]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).not.toHaveBeenCalled();
    expect(storageMock.remove).not.toHaveBeenCalled();
  });

  it('preserves the playlist id when the service port changes', async () => {
    storageMock.playlists = [
      { id: 'stable', name: 'P1', url: 'http://127.0.0.1:8890/uploads/p1.m3u',
        source: 'upload', count: 5 },
    ];
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([
      { id: 'p1', name: 'P1', count: 5, createdAt: 1,
        url: 'http://127.0.0.1:8891/uploads/p1.m3u' },
    ]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: 'stable', name: 'P1', url: 'http://127.0.0.1:8891/uploads/p1.m3u',
        source: 'upload', count: 5 },
    ]);
  });

  it('rewrites storage when only the channel count changed (re-upload of same name)', async () => {
    storageMock.playlists = [
      { name: 'P1', url: 'http://127.0.0.1:8890/uploads/p1.m3u', source: 'upload', count: 5 },
    ];
    // Same id/name/url but different channel count → user re-uploaded p1.m3u
    // with new contents. Storage must update so Settings shows the fresh count.
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([
      { id: 'p1', name: 'P1', count: 9, createdAt: 2, url: 'http://127.0.0.1:8890/uploads/p1.m3u' },
    ]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: expect.any(String), name: 'P1', url: 'http://127.0.0.1:8890/uploads/p1.m3u', source: 'upload', count: 9 },
    ]);
  });

  it('synthesizes a serve URL when the service item omits it', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([
      { id: 'no url', name: 'No URL', count: 1, createdAt: 1 },
    ]));

    await UploadClient.reconcile();

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: expect.any(String), name: 'No URL', url: 'http://127.0.0.1:8890/uploads/no%20url.m3u', source: 'upload', count: 1 },
    ]);
  });
});

describe('UploadClient.remove', () => {
  it('returns true when the server responds 200 (deleted)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ deleted: true, id: 'x' }, 200));
    await expect(UploadClient.remove('x')).resolves.toBe(true);
  });

  it('returns false when the server responds 404 (not deleted) — does not lie to the caller', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ deleted: false, id: 'missing' }, 404));
    await expect(UploadClient.remove('missing')).resolves.toBe(false);
  });

  it('returns false on network failure', async () => {
    fetchWithTimeoutMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(UploadClient.remove('x')).resolves.toBe(false);
  });
});

describe('SetupClient.applyPendingActions', () => {
  it('publishes a sanitized snapshot without Xtream passwords', async () => {
    storageMock.playlists = [
      { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u', source: 'url' },
      {
        id: 'x1',
        name: 'host',
        url: 'http://host',
        source: 'xtream',
        xtream: { username: 'u1', password: 'secret', liveOutput: 'ts' },
      },
      {
        id: 'u1',
        name: 'Uploaded',
        url: 'http://host/uploads/u1.m3u',
        source: 'upload',
      },
    ];
    storageMock.epgUrl = 'http://host/epg.xml';
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ updated: true }));

    await expect(SetupClient.publishState()).resolves.toBe(true);

    const request = fetchWithTimeoutMock.mock.calls[0];
    expect(request[0]).toBe('http://127.0.0.1:8890/setup-state');
    expect(JSON.parse(String(request[1].body))).toEqual({
      playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
      xtreamAccounts: [{
        id: 'x1',
        name: 'host',
        serverUrl: 'http://host',
        username: 'u1',
      }],
      epgUrl: 'http://host/epg.xml',
    });
  });

  it('adds phone-submitted playlist, Xtream, and EPG settings and acknowledges them', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse([
        { id: 1, type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' },
        {
          id: 2,
          type: 'xtream',
          serverUrl: 'http://host/',
          username: 'u1',
          password: 'p1',
        },
        { id: 3, type: 'epg', url: 'http://host/epg.xml' },
      ]))
      .mockResolvedValue(jsonResponse({ deleted: true }));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      {
        id: expect.any(String),
        name: 'Alpha',
        url: 'http://host/a.m3u',
        source: 'url',
      },
      {
        id: expect.any(String),
        name: 'host',
        url: 'http://host',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveOutput: 'ts' },
      },
    ]);
    expect(storageMock.setEpgUrl).toHaveBeenCalledWith('http://host/epg.xml');
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/1',
      { method: 'DELETE' },
      4000,
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/3',
      { method: 'DELETE' },
      4000,
    );
  });

  it('updates matching sources idempotently after an acknowledgement retry', async () => {
    storageMock.playlists = [
      { id: 'p1', name: 'Old', url: 'http://host/a.m3u', source: 'url' },
      {
        id: 'x1',
        name: 'host',
        url: 'http://host',
        source: 'xtream',
        xtream: { username: 'u1', password: 'old', liveOutput: 'm3u8' },
      },
    ];
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse([
        { id: 4, type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' },
        {
          id: 5,
          type: 'xtream',
          serverUrl: 'http://host',
          username: 'u1',
          password: 'new',
        },
      ]))
      .mockResolvedValue(jsonResponse({ deleted: true }));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u', source: 'url' },
      {
        id: 'x1',
        name: 'host',
        url: 'http://host',
        source: 'xtream',
        xtream: { username: 'u1', password: 'new', liveOutput: 'm3u8' },
      },
    ]);
  });

  it('removes an Xtream account and publishes the updated state', async () => {
    storageMock.playlists = [
      { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u', source: 'url' },
      {
        id: 'x1',
        name: 'host',
        url: 'http://host',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveOutput: 'ts' },
      },
    ];
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse([
        { id: 8, type: 'remove-source', sourceId: 'x1' },
      ]))
      .mockResolvedValue(jsonResponse({ updated: true }));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(storageMock.setPlaylists).toHaveBeenCalledWith([
      { id: 'p1', name: 'Alpha', url: 'http://host/a.m3u', source: 'url' },
    ]);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/8',
      { method: 'DELETE' },
      4000,
    );
  });

  it('acknowledges only actions whose storage write succeeded', async () => {
    storageMock.setPlaylists.mockReturnValueOnce(false);
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse([
        { id: 6, type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' },
        { id: 7, type: 'epg', url: 'http://host/epg.xml' },
      ]))
      .mockResolvedValue(jsonResponse({ deleted: true }));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(fetchWithTimeoutMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/6',
      { method: 'DELETE' },
      4000,
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/7',
      { method: 'DELETE' },
      4000,
    );
  });

  it('keeps persisted actions pending when state publication fails', async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(jsonResponse([
        { id: 9, type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(storageMock.setPlaylists).toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:8890/setup-actions/9',
      { method: 'DELETE' },
      4000,
    );
  });

  it('does nothing when there are no pending setup actions', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse([]));

    await expect(SetupClient.applyPendingActions()).resolves.toBe(false);

    expect(storageMock.setPlaylists).not.toHaveBeenCalled();
    expect(storageMock.setEpgUrl).not.toHaveBeenCalled();
  });
});

describe('LAN clients non-2xx handling', () => {
  it('getInfo returns null on a 5xx response (rather than parsing garbage as ServiceInfo)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    await expect(SetupClient.getInfo()).resolves.toBeNull();
  });

  it('list returns null on a 5xx response', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    await expect(UploadClient.list()).resolves.toBeNull();
  });
});
