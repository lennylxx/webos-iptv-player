/**
 * Tests for the upload service HTTP routes. Each test gets its own
 * tempdir and a server bound to a random port.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import { startServer } from './server';

let server: http.Server;
let baseUrl: string;
let dataDir: string;

const VALID_M3U = [
  '#EXTM3U url-tvg="http://epg.example.com/guide.xml"',
  '#EXTINF:-1 tvg-id="chan1" group-title="News",Channel One',
  'http://streams.example.com/one.m3u8',
  '#EXTINF:-1 tvg-id="chan2" group-title="News",Channel Two',
  'http://streams.example.com/two.m3u8',
  '#EXTINF:-1 tvg-id="chan3" group-title="Movies",Channel Three',
  'http://streams.example.com/three.m3u8',
].join('\n');

async function postUpload(name: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body,
  });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-test-'));
  const result = await startServer(0, dataDir);
  server = result.server;
  baseUrl = `http://127.0.0.1:${result.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f));
});

describe('GET /info', () => {
  it('returns the service ip/port and the upload page URL', async () => {
    const res = await fetch(`${baseUrl}/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as { ip: string; port: number; uploadUrl: string };
    expect(info.ip).toBeTruthy();
    expect(info.port).toBeGreaterThan(0);
    expect(info.uploadUrl).toMatch(/^http:\/\/.+:\d+\/upload$/);
  });
});

describe('GET /upload', () => {
  it('serves the upload page HTML', async () => {
    const res = await fetch(`${baseUrl}/upload`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/^<!DOCTYPE html>/);
    expect(body).toContain('Upload M3U Playlist');
    expect(body).toContain('var MESSAGES = {');
    expect(body).toContain('title: "Upload M3U Playlist"');
    expect(body).toContain('success: "Successfully uploaded"');
    expect(body).not.toContain('navigator.language');
  });
});

describe('GET /uploads (empty)', () => {
  it('returns an empty JSON array when no uploads exist', async () => {
    const res = await fetch(`${baseUrl}/uploads`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('POST /uploads', () => {
  it('saves a valid M3U and returns metadata + counted channels', async () => {
    const res = await postUpload('my-list.m3u', VALID_M3U);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { id: string; name: string; count: number };
    expect(meta.id).toBe('my-list');
    expect(meta.name).toBe('my-list');
    expect(meta.count).toBe(3);
    expect(fs.existsSync(path.join(dataDir, 'my-list.m3u'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'my-list.json'))).toBe(true);
  });

  it('rejects content that is not an M3U with HTTP 400', async () => {
    const res = await postUpload('garbage.m3u', 'plain text, no EXTM3U or EXTINF here');
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toMatch(/M3U/i);
    expect(fs.readdirSync(dataDir)).toHaveLength(0);
  });

  it('re-uploading with the same name overwrites the previous file', async () => {
    await postUpload('list.m3u', VALID_M3U);
    const shorter = '#EXTM3U\n#EXTINF:-1,Only\nhttp://x/y.m3u8';
    const res = await postUpload('list.m3u', shorter);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { count: number };
    expect(meta.count).toBe(1);
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.m3u'))).toEqual(['list.m3u']);
  });

  it('sanitizes filenames containing spaces and uppercase characters', async () => {
    const res = await postUpload('My Phone List.m3u', VALID_M3U);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { id: string; name: string };
    expect(meta.id).toBe('my-phone-list');
    expect(meta.name).toBe('My Phone List');
  });

  it('keeps path-traversal attempts confined to DATA_DIR (id is slugified)', async () => {
    const res = await postUpload('../../etc/evil.m3u', VALID_M3U);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { id: string };
    expect(meta.id).not.toContain('/');
    const files = fs.readdirSync(dataDir);
    expect(files.every((f) => path.resolve(dataDir, f).startsWith(dataDir))).toBe(true);
    expect(fs.existsSync('/etc/evil.m3u')).toBe(false);
  });
});

describe('GET /uploads (populated)', () => {
  it('lists every saved upload with a serve-back URL', async () => {
    await postUpload('one.m3u', VALID_M3U);
    await postUpload('two.m3u', '#EXTM3U\n#EXTINF:-1,A\nhttp://x/a.m3u8');
    const res = await fetch(`${baseUrl}/uploads`);
    const items = (await res.json()) as Array<{ id: string; url: string; count: number }>;
    expect(items.map((i) => i.id).sort()).toEqual(['one', 'two']);
    for (const it of items) {
      expect(it.url).toMatch(new RegExp(`^${baseUrl}/uploads/${it.id}\\.m3u$`));
    }
  });
});

describe('GET /uploads/:id.m3u', () => {
  it('serves the original M3U bytes with the audio/mpegurl content type', async () => {
    await postUpload('mine.m3u', VALID_M3U);
    const res = await fetch(`${baseUrl}/uploads/mine.m3u`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/audio\/mpegurl/);
    expect(await res.text()).toBe(VALID_M3U);
  });

  it('returns 404 when the upload does not exist', async () => {
    const res = await fetch(`${baseUrl}/uploads/missing.m3u`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /uploads/:id', () => {
  it('removes both the .m3u and .json files', async () => {
    await postUpload('gone.m3u', VALID_M3U);
    expect(fs.existsSync(path.join(dataDir, 'gone.m3u'))).toBe(true);
    const res = await fetch(`${baseUrl}/uploads/gone`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, id: 'gone' });
    expect(fs.existsSync(path.join(dataDir, 'gone.m3u'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'gone.json'))).toBe(false);
  });

  it('returns 404 for an id that has no upload', async () => {
    const res = await fetch(`${baseUrl}/uploads/does-not-exist`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ deleted: false, id: 'does-not-exist' });
  });
});

describe('unknown routes', () => {
  it('returns 404 with a hint for any unknown path', async () => {
    const res = await fetch(`${baseUrl}/no-such-path`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Not found');
  });
});

describe('startServer onChange callback (Luna push fan-out source)', () => {
  // The webOS entry (index.ts) passes a callback into startServer that
  // broadcasts to all Luna `uploadEvents` subscribers. Verify the server
  // fires it exactly when the upload set actually mutates.

  it('fires onChange after a successful POST /uploads', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=on-change.m3u`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: VALID_M3U,
      });
      expect(res.status).toBe(200);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('does NOT fire onChange when POST /uploads is rejected as invalid M3U', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=bad.m3u`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'no m3u header here',
      });
      expect(res.status).toBe(400);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('fires onChange after a successful DELETE /uploads/:id (file existed)', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      // First a POST to create something to delete (fires onChange once).
      await fetch(`http://127.0.0.1:${port}/uploads?name=to-delete.m3u`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: VALID_M3U,
      });
      expect(onChange).toHaveBeenCalledTimes(1);

      const del = await fetch(`http://127.0.0.1:${port}/uploads/to-delete`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('does NOT fire onChange when DELETE targets a missing id (404, nothing changed)', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      const del = await fetch(`http://127.0.0.1:${port}/uploads/does-not-exist`, { method: 'DELETE' });
      expect(del.status).toBe(404);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('startServer works without an onChange callback (callback is optional)', async () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=no-cb.m3u`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: VALID_M3U,
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('a throwing onChange does not break the response (POST still returns 200)', async () => {
    const onChange = vi.fn(() => { throw new Error('boom'); });
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=throws.m3u`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: VALID_M3U,
      });
      expect(res.status).toBe(200);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });
});
