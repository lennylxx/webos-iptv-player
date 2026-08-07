import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storageMock, fetchWithTimeoutMock } = vi.hoisted(() => ({
  storageMock: {
    playlists: [] as Array<{ name: string; url: string; source?: 'upload' | 'url' }>,
    getPlaylists: vi.fn(),
    setPlaylists: vi.fn(),
    remove: vi.fn(),
  },
  fetchWithTimeoutMock: vi.fn(),
}));
storageMock.getPlaylists.mockImplementation(() => storageMock.playlists);
storageMock.setPlaylists.mockImplementation((next: typeof storageMock.playlists) => {
  storageMock.playlists = next;
});

vi.mock('../services/storage-service', () => ({ StorageService: storageMock }));
vi.mock('../utils/fetch-helper', () => ({ fetchWithTimeout: fetchWithTimeoutMock }));

import { UploadClient, uploadIdFromUrl, setServicePort } from './upload-client';

function jsonResponse(data: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

beforeEach(() => {
  storageMock.playlists = [];
  storageMock.getPlaylists.mockClear();
  storageMock.setPlaylists.mockClear();
  storageMock.remove.mockClear();
  fetchWithTimeoutMock.mockReset();
  // Simulate the Luna `start` response that the app applies before any
  // UploadClient call. Without this, base() returns null and all methods
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

describe('UploadClient when the service port is not yet known', () => {
  beforeEach(() => setServicePort(null));

  it('getInfo no-ops to null without calling fetch', async () => {
    expect(await UploadClient.getInfo()).toBeNull();
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
  it('is a no-op when the upload service is unreachable (does not delete existing uploads)', async () => {
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

describe('UploadClient.getInfo / list — non-2xx handling', () => {
  it('getInfo returns null on a 5xx response (rather than parsing garbage as ServiceInfo)', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    await expect(UploadClient.getInfo()).resolves.toBeNull();
  });

  it('list returns null on a 5xx response', async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500));
    await expect(UploadClient.list()).resolves.toBeNull();
  });
});
