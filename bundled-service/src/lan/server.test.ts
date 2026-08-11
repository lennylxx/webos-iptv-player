/**
 * Tests for the shared LAN service HTTP routes. Each test gets its own
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
let setupUrl: string;
let setupToken: string;
let pairingCode: string;
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
  return fetch(`${baseUrl}/uploads?name=${encodeURIComponent(name)}&token=${setupToken}`, {
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
  const info = (await (await fetch(`${baseUrl}/info`)).json()) as {
    setupUrl: string;
    pairingCode: string;
  };
  const parsedSetupUrl = new URL(info.setupUrl);
  setupUrl = baseUrl + parsedSetupUrl.pathname + parsedSetupUrl.search;
  setupToken = parsedSetupUrl.searchParams.get('token')!;
  pairingCode = info.pairingCode;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f));
  const actions = (await (await fetch(`${baseUrl}/setup-actions`)).json()) as Array<{ id: number }>;
  for (const action of actions) {
    await fetch(`${baseUrl}/setup-actions/${action.id}`, { method: 'DELETE' });
  }
});

describe('GET /info', () => {
  it('returns the service ip/port and the setup page URL', async () => {
    const res = await fetch(`${baseUrl}/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as {
      ip: string;
      port: number;
      setupUrl: string;
      manualUrl: string;
      pairingCode: string;
    };
    expect(info.ip).toBeTruthy();
    expect(info.port).toBeGreaterThan(0);
    expect(info.setupUrl).toMatch(/^http:\/\/.+:\d+\/setup\?token=[a-f0-9]{12}$/);
    expect(info.manualUrl).toMatch(/^http:\/\/.+:\d+$/);
    expect(info.pairingCode).toMatch(/^\d{4}$/);
  });
});

describe('GET /setup', () => {
  it('serves the setup page HTML', async () => {
    const res = await fetch(setupUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/^<!DOCTYPE html>/);
    expect(body).toContain('Set up IPTV');
    expect(body).toContain('var MESSAGES = {');
    expect(body).toContain('title: "Set up IPTV"');
    expect(body).toContain('title: "设置 IPTV"');
    expect(body).toContain('data-message="setupSources"');
    expect(body).toContain('setupSources: "设置节目源"');
    expect(body).toContain('uploadM3uFiles: "上传 M3U 文件"');
    expect(body).toContain('success: "Successfully uploaded"');
    expect(body).toContain('navigator.languages');
    expect(body).toContain('navigator.language');
  });

  it('serves the pairing page without a setup token', async () => {
    const res = await fetch(`${baseUrl}/setup`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="pair-form"');
  });

  it('serves the same pairing page at the short root URL', async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="pair-form"');
  });

  it('does not serve the retired upload page route', async () => {
    const res = await fetch(`${baseUrl}/upload`);
    expect(res.status).toBe(404);
  });
});

describe('POST /pair', () => {
  function pair(code: string): Promise<Response> {
    return fetch(`${baseUrl}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  }

  it('exchanges the four-digit pairing code for the setup token', async () => {
    expect((await pair('99999')).status).toBe(401);
    const res = await pair(pairingCode);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: setupToken });
  });

  it('resets failures after an expired lockout', async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await pair('99999')).status).toBe(401);
      }
      expect((await pair('99999')).status).toBe(429);
      nowSpy.mockReturnValue(now + 60_001);
      expect((await pair('99999')).status).toBe(401);
      expect((await pair(pairingCode)).status).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('setup state', () => {
  const state = {
    playlists: [{ id: 'p1', name: 'Alpha', url: 'http://host/a.m3u' }],
    xtreamAccounts: [{
      id: 'x1',
      name: 'host',
      serverUrl: 'http://host',
      username: 'u1',
    }],
    uploadedPlaylists: [{ id: 'u1', uploadId: 'upload-1', enabled: false }],
    epgUrl: 'http://host/epg.xml',
    onlineSubtitles: {
      preferredLanguage: '',
      subdlConfigured: true,
      assrtConfigured: false,
      opensubtitlesConfigured: true,
      opensubtitlesApiKeyConfigured: true,
      opensubtitlesPasswordConfigured: true,
      opensubtitlesUsername: 'u2',
    },
  };

  it('accepts a loopback snapshot and returns it only with the setup token', async () => {
    const put = await fetch(`${baseUrl}/setup-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    expect(put.status).toBe(200);
    expect((await fetch(`${baseUrl}/setup-state`)).status).toBe(403);
    const get = await fetch(`${baseUrl}/setup-state?token=${setupToken}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(state);
  });

  it('strips credential fields from snapshots', async () => {
    const put = await fetch(`${baseUrl}/setup-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state,
        xtreamAccounts: [{ ...state.xtreamAccounts[0], password: 'p1' }],
        onlineSubtitles: {
          ...state.onlineSubtitles,
          subdlApiKey: 'k1',
          opensubtitlesPassword: 'p1',
        },
      }),
    });
    expect(put.status).toBe(200);
    const saved = await (await fetch(`${baseUrl}/setup-state?token=${setupToken}`)).json();
    expect(saved).not.toHaveProperty('xtreamAccounts.0.password');
    expect(saved).not.toHaveProperty('onlineSubtitles.subdlApiKey');
    expect(saved).not.toHaveProperty('onlineSubtitles.opensubtitlesPassword');
  });
});

describe('setup actions', () => {
  async function postAction(payload: unknown, url = setupUrl): Promise<Response> {
    const token = new URL(url).search;
    return fetch(`${baseUrl}/setup-actions${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('queues source additions and removal for the local TV client', async () => {
    expect((await postAction({
      type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u',
    })).status).toBe(201);
    expect((await postAction({
      type: 'xtream', serverUrl: 'http://host', username: 'u1', password: 'p1',
    })).status).toBe(201);
    expect((await postAction({
      type: 'epg', url: 'http://host/epg.xml',
    })).status).toBe(201);
    expect((await postAction({
      type: 'remove-source', sourceId: 'x1',
    })).status).toBe(201);
    expect((await postAction({
      type: 'set-source-enabled', sourceId: 'u1', enabled: false,
    })).status).toBe(201);
    expect((await postAction({
      type: 'online-subtitles',
      preferredLanguage: '',
      subdlApiKey: 'k1',
      opensubtitles: { apiKey: 'k2', username: 'u2', password: 'p2' },
    })).status).toBe(201);

    const actions = await (await fetch(`${baseUrl}/setup-actions`)).json();
    expect(actions).toEqual([
      { id: expect.any(Number), type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' },
      {
        id: expect.any(Number),
        type: 'xtream',
        serverUrl: 'http://host',
        username: 'u1',
        password: 'p1',
      },
      { id: expect.any(Number), type: 'epg', url: 'http://host/epg.xml' },
      { id: expect.any(Number), type: 'remove-source', sourceId: 'x1' },
      {
        id: expect.any(Number),
        type: 'set-source-enabled',
        sourceId: 'u1',
        enabled: false,
      },
      {
        id: expect.any(Number),
        type: 'online-subtitles',
        preferredLanguage: '',
        subdlApiKey: 'k1',
        opensubtitles: { apiKey: 'k2', username: 'u2', password: 'p2' },
      },
    ]);
  });

  it('rejects setup mutations without the QR token', async () => {
    const res = await fetch(`${baseUrl}/setup-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'epg', url: 'http://host/epg.xml' }),
    });
    expect(res.status).toBe(403);
    expect(await (await fetch(`${baseUrl}/setup-actions`)).json()).toEqual([]);
  });

  it('validates setup action fields and URL protocols', async () => {
    expect((await postAction({
      type: 'xtream', serverUrl: 'file:///tmp/a', username: 'u1', password: 'p1',
    })).status).toBe(400);
    expect((await postAction({
      type: 'playlist', name: 'Alpha', url: '',
    })).status).toBe(400);
    expect((await postAction({
      type: 'online-subtitles',
      preferredLanguage: 'invalid',
    })).status).toBe(400);
    expect((await postAction({
      type: 'online-subtitles',
      preferredLanguage: '',
      opensubtitles: {},
    })).status).toBe(400);
    expect((await postAction({
      type: 'set-source-enabled',
      sourceId: 'u1',
      enabled: 'false',
    })).status).toBe(400);
  });

  it('acknowledges and removes a consumed action', async () => {
    const created = await postAction({
      type: 'epg', url: 'http://host/epg.xml',
    });
    const { id } = (await created.json()) as { id: number };
    const token = new URL(setupUrl).search;
    expect(await (await fetch(`${baseUrl}/setup-actions/${id}${token}`)).json())
      .toEqual({ id, pending: true });
    const removed = await fetch(`${baseUrl}/setup-actions/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/setup-actions/${id}${token}`)).json())
      .toEqual({ id, pending: false });
    expect(await (await fetch(`${baseUrl}/setup-actions`)).json()).toEqual([]);
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
  it('rejects an upload without the setup token', async () => {
    const res = await fetch(`${baseUrl}/uploads?name=list.m3u`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: VALID_M3U,
    });
    expect(res.status).toBe(403);
    expect(fs.readdirSync(dataDir)).toHaveLength(0);
  });

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

  it('rejects encoded path traversal outside the upload directory', async () => {
    const outside = path.join(path.dirname(dataDir), 'outside.m3u');
    fs.writeFileSync(outside, VALID_M3U);
    try {
      const res = await fetch(`${baseUrl}/uploads/..%2Foutside.m3u`);
      expect(res.status).toBe(400);
      expect(fs.readFileSync(outside, 'utf-8')).toBe(VALID_M3U);
    } finally {
      fs.unlinkSync(outside);
    }
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

  it('rejects encoded path traversal without deleting external files', async () => {
    const outside = path.join(path.dirname(dataDir), 'outside.m3u');
    fs.writeFileSync(outside, VALID_M3U);
    try {
      const res = await fetch(`${baseUrl}/uploads/..%2Foutside`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.unlinkSync(outside);
    }
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
  // broadcasts to all Luna `serviceEvents` subscribers. Verify the server
  // fires it exactly when the upload set actually mutates.
  async function tokenFor(port: number): Promise<string> {
    const info = (await (await fetch(`http://127.0.0.1:${port}/info`)).json()) as {
      setupUrl: string;
    };
    return new URL(info.setupUrl).searchParams.get('token')!;
  }

  it('fires onChange after a successful POST /uploads', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    try {
      const token = await tokenFor(port);
      const res = await fetch(
        `http://127.0.0.1:${port}/uploads?name=on-change.m3u&token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: VALID_M3U,
        });

      expect(res.status).toBe(200);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('uploads-changed');
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
      fs.rmSync(localDir, { recursive: true, force: true });
    }
  });

  it('fires a setup change after an authenticated source submission', async () => {
    const onChange = vi.fn();
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-svc-cb-'));
    const { server: s } = await startServer(0, localDir, onChange);
    const port = (s.address() as { port: number }).port;
    const localBase = `http://127.0.0.1:${port}`;
    try {
      const info = (await (await fetch(`${localBase}/info`)).json()) as { setupUrl: string };
      const token = new URL(info.setupUrl).search;
      const res = await fetch(`${localBase}/setup-actions${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'epg', url: 'http://host/epg.xml' }),
      });
      expect(res.status).toBe(201);
      expect(onChange).toHaveBeenCalledWith('setup-changed');
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
      const token = await tokenFor(port);
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=bad.m3u&token=${token}`, {
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
      const token = await tokenFor(port);
      await fetch(`http://127.0.0.1:${port}/uploads?name=to-delete.m3u&token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: VALID_M3U,
      });
      expect(onChange).toHaveBeenCalledTimes(1);

      const del = await fetch(`http://127.0.0.1:${port}/uploads/to-delete`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith('uploads-changed');
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
      const token = await tokenFor(port);
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=no-cb.m3u&token=${token}`, {
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
      const token = await tokenFor(port);
      const res = await fetch(`http://127.0.0.1:${port}/uploads?name=throws.m3u&token=${token}`, {
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
