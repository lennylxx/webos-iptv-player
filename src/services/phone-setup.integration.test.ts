// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import { startServer } from '../../bundled-service/src/lan/server';
import { StorageService } from './storage-service';
import { setServicePort } from './service-http';
import { SetupClient } from './setup-client';

let server: http.Server;
let baseUrl: string;
let setupToken: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-setup-test-'));
  const result = await startServer(0, dataDir);
  server = result.server;
  baseUrl = `http://127.0.0.1:${result.port}`;
  setServicePort(result.port);
  const info = (await (await fetch(`${baseUrl}/info`)).json()) as { setupUrl: string };
  setupToken = new URL(info.setupUrl).search;
});

afterAll(async () => {
  setServicePort(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  localStorage.clear();
  const actions = (await (await fetch(`${baseUrl}/setup-actions`)).json()) as Array<{ id: number }>;
  for (const action of actions) {
    await fetch(`${baseUrl}/setup-actions/${action.id}`, { method: 'DELETE' });
  }
});

async function submit(payload: unknown): Promise<void> {
  const response = await fetch(`${baseUrl}/setup-actions${setupToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(201);
}

describe('phone setup synchronization', () => {
  it('applies every phone source type to TV storage and acknowledges the actions', async () => {
    await submit({ type: 'playlist', name: 'Alpha', url: 'http://host/a.m3u' });
    await submit({
      type: 'xtream',
      serverUrl: 'http://host',
      username: 'u1',
      password: 'p1',
    });
    await submit({ type: 'epg', url: 'http://host/epg.xml' });
    await submit({
      type: 'online-subtitles',
      preferredLanguage: '',
      subdlApiKey: 'k1',
      opensubtitles: { apiKey: 'k2', username: 'u2', password: 'password-secret' },
    });

    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);

    expect(StorageService.getPlaylists()).toEqual([
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
        xtream: {
          username: 'u1',
          password: 'p1',
          liveOutput: 'ts',
        },
      },
    ]);
    expect(StorageService.getEpgUrl()).toBe('http://host/epg.xml');
    expect(StorageService.getOnlineSubtitleConfig()).toEqual({
      preferredLanguage: '',
      subdl: { apiKey: 'k1' },
      assrt: { apiKey: '' },
      opensubtitles: {
        apiKey: 'k2',
        username: 'u2',
        password: 'password-secret',
        token: '',
        tokenTs: 0,
      },
    });
    expect(await (await fetch(`${baseUrl}/setup-actions`)).json()).toEqual([]);

    const state = await (await fetch(`${baseUrl}/setup-state${setupToken}`)).json();
    expect(state).toEqual({
      playlists: [{
        id: expect.any(String),
        name: 'Alpha',
        url: 'http://host/a.m3u',
      }],
      xtreamAccounts: [{
        id: expect.any(String),
        name: 'host',
        serverUrl: 'http://host',
        username: 'u1',
      }],
      uploadedPlaylists: [],
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
    });
    expect((state as { xtreamAccounts: Array<Record<string, unknown>> })
      .xtreamAccounts[0]).not.toHaveProperty('password');
    expect(JSON.stringify(state)).not.toContain('password-secret');

    const xtreamId = StorageService.getPlaylists()
      .find(item => item.source === 'xtream')!.id;
    await submit({ type: 'remove-source', sourceId: xtreamId });
    await expect(SetupClient.applyPendingActions()).resolves.toBe(true);
    expect(StorageService.getPlaylists().map(item => item.source)).toEqual(['url']);
    expect(await (await fetch(`${baseUrl}/setup-state${setupToken}`)).json())
      .toMatchObject({ xtreamAccounts: [] });
  });
});
