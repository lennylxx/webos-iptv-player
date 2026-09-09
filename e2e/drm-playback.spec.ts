import { test, expect, routePlaylist, seedPlaylist, type Page } from './helpers';
import { DASH_URL, DASH_M3U, DASH_MPD, installShakaStub, startDash, expectDrmPills } from './shaka-fixture';

async function captureDiagnostics(page: Page) {
  const { assembleDiagnosticReport, formatDiagnosticSummary } = await import('../scripts/tv-diag.mjs');
  const { normalizeCdpLogEvent } = await import('../scripts/cdp-logs.mjs');
  const logs: ReturnType<typeof normalizeCdpLogEvent>[] = [];
  const client = await page.context().newCDPSession(page);
  client.on('Runtime.consoleAPICalled', params => {
    logs.push(normalizeCdpLogEvent('Runtime.consoleAPICalled', params));
  });
  await client.send('Runtime.enable');
  return {
    report: () => assembleDiagnosticReport({
      capturedAt: new Date().toISOString(),
      full: false,
      app: {},
      environment: {},
      probe: { playlists: [] },
      native: [],
      logs,
      networkEvents: [],
    }),
    summary: formatDiagnosticSummary,
    close: () => client.detach(),
  };
}

const KID = '00112233445566778899aabbccddeeff';
const license = {
  keys: [{ kty: 'oct', kid: 'ABEiM0RVZneImaq7zN3u_w', k: '_-7dzLuqmYh3ZlVEMyIRAA' }],
  type: 'temporary',
};

for (const mode of ['inline keys', 'HTTP license']) {
  test(`real Shaka ClearKey: usable browser EME key via ${mode} (no media files)`, async ({ page }) => {
    const licenseRequests: { kids: string[]; header: string | undefined }[] = [];
    await page.route('http://host/license', route => {
      licenseRequests.push({
        kids: (route.request().postDataJSON() as { kids: string[] }).kids,
        header: route.request().headers()['x-token'],
      });
      return route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(license),
      });
    });
    await startDash(page, DASH_M3U);
    await page.waitForFunction(() => typeof (window as unknown as {
      __shaka?: { Player?: unknown };
    }).__shaka?.Player === 'function');
    await page.keyboard.press('Escape');
    await expect(page.locator('#view-channels')).toBeVisible();

    const state = await page.evaluate(async ({ mode, license }) => {
      interface LicenseRequest {
        uris: string[];
        method: string;
        body: ArrayBuffer;
        headers: Record<string, string>;
        allowCrossSiteCredentials: boolean;
        retryParameters: {
          maxAttempts: number; baseDelay: number; backoffFactor: number; fuzzFactor: number;
          timeout: number; stallTimeout: number; connectionTimeout: number;
        };
      }
      const shaka = (window as unknown as {
        __shaka: {
          Player: new () => {
            getNetworkingEngine(): {
              request(type: number, request: LicenseRequest): { promise: Promise<{ data: ArrayBuffer }> };
            } | null;
            destroy(): Promise<void>;
          };
          net: { NetworkingEngine: { RequestType: { LICENSE: number } } };
        };
      }).__shaka;
      const player = new shaka.Player();
      let session: MediaKeySession | null = null;
      const statuses: Array<{ kid: string; status: MediaKeyStatus }> = [];
      let messageType = '';
      let requestKids: string[] = [];
      function waitForSessionEvent(session: MediaKeySession, type: string): Promise<Event> {
        return new Promise((resolve, reject) => {
          const onEvent = (event: Event): void => {
            clearTimeout(timer);
            session.removeEventListener(type, onEvent);
            resolve(event);
          };
          const timer = setTimeout(() => {
            session.removeEventListener(type, onEvent);
            reject(new Error(`ClearKey session did not emit ${type}`));
          }, 5000);
          session.addEventListener(type, onEvent);
        });
      }
      try {
        const access = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
          initDataTypes: ['keyids'], sessionTypes: ['temporary'],
          videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42c00a"' }],
        }]);
        const keys = await access.createMediaKeys();
        session = keys.createSession('temporary');
        const [event] = await Promise.all([
          waitForSessionEvent(session, 'message'),
          session.generateRequest('keyids', new TextEncoder().encode(JSON.stringify({
            kids: [license.keys[0].kid], type: 'temporary',
          }))),
        ]);
        const message = event as MediaKeyMessageEvent;
        messageType = message.messageType;
        requestKids = (JSON.parse(new TextDecoder().decode(message.message)) as { kids: string[] }).kids;
        const networking = player.getNetworkingEngine();
        if (!networking) throw new Error('Real Shaka networking engine is unavailable');
        const response = await networking.request(shaka.net.NetworkingEngine.RequestType.LICENSE, {
          uris: [mode === 'inline keys'
            ? 'data:application/json;base64,' + btoa(JSON.stringify(license))
            : 'http://host/license'],
          method: 'POST', body: message.message, headers: mode === 'HTTP license' ? { 'x-token': 'v' } : {},
          allowCrossSiteCredentials: false,
          retryParameters: {
            maxAttempts: 1, baseDelay: 0, backoffFactor: 1, fuzzFactor: 0,
            timeout: 5000, stallTimeout: 5000, connectionTimeout: 5000,
          },
        }).promise;
        await Promise.all([
          waitForSessionEvent(session, 'keystatuseschange'), session.update(response.data),
        ]);
        session.keyStatuses.forEach((status, kid) => {
          const bytes = ArrayBuffer.isView(kid)
            ? new Uint8Array(kid.buffer, kid.byteOffset, kid.byteLength)
            : new Uint8Array(kid);
          let hex = '';
          for (const byte of bytes) hex += ('0' + byte.toString(16)).slice(-2);
          statuses.push({ kid: hex, status });
        });
      } finally {
        try {
          if (session) {
            await session.close();
            await session.closed;
          }
        } finally {
          await player.destroy();
        }
      }
      return { messageType, requestKids, statuses, closed: true };
    }, { mode, license });
    expect(state).toEqual({
      messageType: 'license-request', requestKids: [license.keys[0].kid],
      statuses: [{ kid: KID, status: 'usable' }], closed: true,
    });
    if (mode === 'HTTP license') {
      expect(licenseRequests).toEqual([{ kids: [license.keys[0].kid], header: 'v' }]);
    } else {
      expect(licenseRequests).toEqual([]);
    }
    await expect(page.locator('#view-channels')).toBeVisible();
  });
}

const WIDEVINE_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Test",DASH Test',
  '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
  '#KODIPROP:inputstream.adaptive.license_key='
    + 'http://host/license|authorization=Bearer%20token',
  DASH_URL,
].join('\n');

for (const drm of [
  { label: 'Widevine', keySystem: 'com.widevine.alpha', scheme: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' },
  { label: 'ClearKey', keySystem: 'org.w3.clearkey', scheme: 'e2719d58-a985-b3c9-781a-b030af78d30e' },
]) {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1" group-title="Test",DASH Test',
    `#KODIPROP:inputstream.adaptive.drm_legacy=${drm.keySystem}|http://host/license|x-token=v`,
    DASH_URL,
  ].join('\n');
  for (const webOS of [false, true]) {
    const platform = webOS ? 'webOS route' : 'desktop route';
    test(`${drm.label}: license headers, all stream-info pills and teardown (${platform})`, async ({ page }) => {
      await installShakaStub(page, { webOS, licenseNetwork: true });
      const licenses: string[] = [];
      await page.route('http://host/license', route => {
        licenses.push(route.request().headers()['x-token']);
        return route.fulfill({ status: 200, body: 'synthetic-license' });
      });
      await startDash(page, playlist, DASH_MPD.replace('<Period>',
        `<Period><ContentProtection schemeIdUri="urn:uuid:${drm.scheme}"/>`));
      await expectDrmPills(page, drm.label);
      const state = await page.evaluate(() => (window as unknown as {
        __shakaE2E: { settings: { drm: unknown }; manifestHeaders: Record<string, string> };
      }).__shakaE2E);
      expect(state.settings.drm).toEqual({
        preferredKeySystems: [drm.keySystem], servers: { [drm.keySystem]: 'http://host/license' },
      });
      expect(state.manifestHeaders).toEqual({});
      expect(licenses).toEqual(['v']);
      await expect(page.locator('#video-player source')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('#view-channels')).toBeVisible();
      await page.waitForFunction(() => (window as unknown as {
        __shakaE2E: { destroyed: boolean };
      }).__shakaE2E.destroyed);
    });
  }

  test(`${drm.label}: rejected license advances to a clear channel without stale DRM`, async ({ page }) => {
    const diagnostics = await captureDiagnostics(page);
    await installShakaStub(page, { webOS: true, licenseNetwork: true, delayedDestroy: true });
    let licenses = 0;
    await page.route('http://host/license', route => {
      licenses++;
      return route.fulfill({ status: 403, body: 'denied' });
    });
    await startDash(page, playlist + '\n#EXTINF:-1 tvg-id="ch2",Track 2\nhttp://host/b.mpd');
    await expect(page.locator('#player-osd .osd-channel-name')).toHaveText('Track 2');
    await expect(page.locator('#video-player source')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as {
      __shakaE2E: { destroyStarted: boolean; destroyed: boolean };
    }).__shakaE2E)).toMatchObject({ destroyStarted: true, destroyed: false });
    await page.evaluate(() => (window as unknown as {
      __shakaE2EControl: { finishDestroy(): void };
    }).__shakaE2EControl.finishDestroy());
    // The clear channel uses the native source, never the failed DRM library.
    await expect(page.locator('#video-player source')).toHaveAttribute('src', 'http://host/b.mpd');
    expect(licenses).toBe(1);
    const destroyed = await page.evaluate(() => (window as unknown as {
      __shakaE2E: { destroyedCount: number };
    }).__shakaE2E.destroyedCount);
    expect(destroyed).toBe(1);
    await expect.poll(() => diagnostics.report().diagnostics.some(event =>
      event.code === 'playback.mse.teardown.resumed')).toBe(true);
    const report = diagnostics.report();
    const timeline = report.diagnostics;
    const started = timeline.find(event => event.code === 'playback.mse.destroy.started')!;
    const completed = timeline.find(event => event.code === 'playback.mse.destroy.completed')!;
    const waiting = timeline.find(event => event.code === 'playback.mse.teardown.wait')!;
    const resumed = timeline.find(event => event.code === 'playback.mse.teardown.resumed')!;
    expect(started.session).not.toBeNull();
    expect(completed).toMatchObject({ session: started.session, load: started.load, source: 'shaka' });
    expect(completed.text).toMatch(/\belapsedMs=\d+/);
    expect(waiting.text).toContain(`owner=(session=${started.session} load=${started.load})`);
    expect(resumed).toMatchObject({ session: waiting.session, load: waiting.load });
    expect(waiting.load).toBeGreaterThan(started.load!);
    expect(timeline.indexOf(completed)).toBeLessThan(timeline.indexOf(resumed));
    expect(diagnostics.summary(report)).toContain('playback.mse.teardown.resumed');
    await diagnostics.close();
  });

  test(`${drm.label}: stale load completion cannot reopen a stopped player`, async ({ page }) => {
    await installShakaStub(page, { delayedLoad: true });
    await startDash(page, playlist);
    await page.waitForFunction(() => (window as unknown as {
      __shakaE2E: { loadedUrl: string };
    }).__shakaE2E.loadedUrl.length > 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as unknown as {
      __shakaE2EControl: { finishLoad(): void };
    }).__shakaE2EControl.finishLoad());
    await page.waitForFunction(() => (window as unknown as {
      __shakaE2E: { loadSettled: boolean };
    }).__shakaE2E.loadSettled);
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('#view-player')).not.toBeVisible();
  });

  test(`${drm.label}: critical errors are handled once without exposing license data`, async ({ page }) => {
    await installShakaStub(page);
    const messages: string[] = [];
    page.on('console', message => messages.push(message.text()));
    await startDash(page, playlist);
    await expectDrmPills(page, drm.label);
    await page.evaluate(() => {
      const control = (window as unknown as { __shakaE2EControl: { error(severity: number): void } }).__shakaE2EControl;
      control.error(1);
      control.error(2);
      control.error(2);
    });
    await expect.poll(() => messages.filter(message => message.includes('event=playback.video.error')).length).toBe(1);
    expect(messages.join('\n')).not.toContain('synthetic-private-license-data');
    await page.keyboard.press('Escape');
  });

  test(`${drm.label}: late DRM readiness and same-size ABR changes refresh pills`, async ({ page }) => {
    const diagnostics = await captureDiagnostics(page);
    await installShakaStub(page, { delayedLoad: true });
    await startDash(page, playlist);
    await page.waitForFunction(() => (window as unknown as {
      __shakaE2E: { loadedUrl: string };
    }).__shakaE2E.loadedUrl.length > 0);
    await page.evaluate(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
    const pills = page.locator('#player-osd .osd-stream-info');
    await expect(pills).not.toContainText(drm.label);
    await page.evaluate(() => (window as unknown as {
      __shakaE2EControl: { finishLoad(): void };
    }).__shakaE2EControl.finishLoad());
    await expect(pills).toContainText(drm.label);
    await page.evaluate(() => (window as unknown as {
      __shakaE2EControl: { changeVariant(fields: object): void };
    }).__shakaE2EControl.changeVariant({
      videoCodec: 'dvh1.05.06', audioCodec: 'ec-3', spatialAudio: true, frameRate: 59.94,
    }));
    for (const label of ['720p', 'Dolby Vision', 'Dolby Digital+ Atmos', '60fps']) {
      await expect(pills).toContainText(label);
    }
    await page.evaluate(() => (window as unknown as {
      __shakaE2EControl: { changeVariant(fields: object): void };
    }).__shakaE2EControl.changeVariant({ spatialAudio: false, hdr: 'HLG' }));
    await expect(pills).not.toContainText('Atmos');
    await expect(pills).toContainText('HLG');
    await expect(pills).not.toContainText('HDR10+');
    await expect.poll(() => diagnostics.report().diagnostics.filter(event =>
      event.code === 'playback.dash.variant.changed').length).toBe(2);
    const report = diagnostics.report();
    const adaptations = report.diagnostics.filter(event => event.code === 'playback.dash.variant.changed');
    expect(adaptations.every(event => event.reason === 'adaptation' && event.load !== null)).toBe(true);
    expect(adaptations[0].text).toContain('width=1280 height=720');
    expect(adaptations[0].text).toContain('frameRate=59.94');
    expect(adaptations[0].text).toContain('audioAtmos=true');
    expect(adaptations[1].text).toContain('videoRange=HLG');
    expect(adaptations[1].text).toContain('audioAtmos=false');
    expect(diagnostics.summary(report)).toContain('reason=adaptation');
    expect(report.diagnostics.map(event => event.code)).toEqual(expect.arrayContaining([
      'playback.dash.init.started', 'playback.dash.load.started', 'playback.dash.load.completed',
    ]));
    await diagnostics.close();
  });
}

test('ClearKey: malformed inline keys fail before constructing Shaka or native playback', async ({ page }) => {
  await installShakaStub(page, { webOS: true });
  await startDash(page, DASH_M3U.replace(DASH_URL,
    '#KODIPROP:inputstream.adaptive.drm_legacy=org.w3.clearkey|bad:key\n' + DASH_URL));
  await expect(page.locator('#player-osd')).toContainText('error', { ignoreCase: true });
  expect(await page.evaluate(() => (window as unknown as {
    __shakaE2E: { created: number };
  }).__shakaE2E.created)).toBe(0);
  await expect(page.locator('#video-player source')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('ClearKey: Kodi JSON keys override manifest DRM and drive the webOS Shaka path', async ({ page }) => {
  await installShakaStub(page, { webOS: true });
  const keys = { '00112233445566778899aabbccddeeff': 'ffeeddccbbaa99887766554433221100' };
  const playlist = DASH_M3U.replace(DASH_URL,
    '#KODIPROP:inputstream.adaptive.drm=' + JSON.stringify({
      'org.w3.clearkey': { license: { keyids: keys } },
    }) + '\n' + DASH_URL);
  await startDash(page, playlist, DASH_MPD.replace('<Period>',
    '<Period><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>'));
  await expectDrmPills(page, 'ClearKey');
  const config = await page.evaluate(() => (window as unknown as {
    __shakaE2E: { settings: { drm: unknown } };
  }).__shakaE2E.settings.drm);
  expect(config).toEqual({ preferredKeySystems: ['org.w3.clearkey'], servers: {}, clearKeys: keys });
  await expect(page.locator('#video-player source')).toHaveCount(0);
});

test('configures Widevine and forwards license headers to Shaka', async ({ page }) => {
  await installShakaStub(page);
  await routePlaylist(page, WIDEVINE_M3U);
  await page.route(DASH_URL, route => route.fulfill({
    status: 200,
    contentType: 'application/dash+xml',
    body: DASH_MPD,
  }));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    (window as unknown as { __shakaE2E?: { loadedUrl: string } })
      .__shakaE2E?.loadedUrl === 'http://host/a.mpd');

  const state = await page.evaluate(() =>
    (window as unknown as {
      __shakaE2E: {
        settings: {
          drm?: {
            preferredKeySystems?: string[];
            servers?: Record<string, string>;
          };
        } | null;
        licenseHeaders: Record<string, string>;
      };
    }).__shakaE2E);
  expect(state.settings?.drm).toEqual({
    preferredKeySystems: ['com.widevine.alpha'],
    servers: { 'com.widevine.alpha': 'http://host/license' },
  });
  expect(state.licenseHeaders).toEqual({ authorization: 'Bearer token' });

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  await expect(page.locator('#player-osd .osd-stream-info')).toContainText('Widevine');
});

interface PlayReadyProbe {
  calls: Array<{ method: string; parameters: Record<string, unknown>; source: string | null }>;
  cancelledRights: number;
  pending: number;
}

async function installPlayReadyLuna(
  page: Page,
  options: { hold?: 'load' | 'sendDrmMessage'; failLoad?: boolean; failMessage?: number } = {},
): Promise<void> {
  await page.addInitScript(options => {
    const probe: PlayReadyProbe = { calls: [], cancelledRights: 0, pending: 0 };
    const pending: Array<() => void> = [];
    let rights: FakePalmServiceBridge | null = null;
    let messageCount = 0;
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private subscription = false;
      private cancelled = false;

      respond(response: Record<string, unknown>): void {
        if (!this.cancelled) this.onservicecallback?.(JSON.stringify(response));
      }

      call(uri: string, payload: string): void {
        if (uri.indexOf('luna://com.webos.service.drm/') !== 0) {
          this.respond({ returnValue: false, errorCode: -1, errorText: 'Unmocked non-DRM service' });
          return;
        }
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as Record<string, unknown>;
        probe.calls.push({
          method, parameters, source: document.querySelector('#video-player source')?.getAttribute('src') ?? null,
        });
        let response: Record<string, unknown>;
        if (method === 'load') {
          response = options.failLoad
            ? { returnValue: false, errorCode: -1, errorText: 'Synthetic load failure' }
            : { returnValue: true, clientId: 'client-1' };
        } else if (method === 'getRightsError') {
          this.subscription = true;
          rights = this;
          response = { returnValue: true, subscribed: true };
        } else if (method === 'sendDrmMessage') {
          messageCount++;
          response = {
            returnValue: true, resultCode: options.failMessage === messageCount ? 1 : 0,
            msgId: `msg-${messageCount}`,
          };
        } else if (method === 'unload') {
          response = { returnValue: true };
        } else {
          response = { returnValue: false, errorCode: -1, errorText: 'Unmocked DRM method' };
        }
        if (options.hold === method) {
          pending.push(() => this.respond(response));
          probe.pending = pending.length;
        } else {
          this.respond(response);
        }
      }

      cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        if (this.subscription) probe.cancelledRights++;
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', { value: FakePalmServiceBridge });
    Object.defineProperty(window, '__playReadyE2E', { value: probe });
    Object.defineProperty(window, '__playReadyE2EControl', {
      value: {
        finish: () => {
          const respond = pending.shift();
          probe.pending = pending.length;
          respond?.();
        },
        rights: (contentId: string) => rights?.respond({
          returnValue: true, contentId, errorState: 1, rightIssueUrl: 'http://host/private-rights',
        }),
      },
    });
  }, options);
}

async function playReadyProbe(page: Page): Promise<PlayReadyProbe> {
  return page.evaluate(() => (window as unknown as { __playReadyE2E: PlayReadyProbe }).__playReadyE2E);
}

async function finishPlayReadyRequest(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as {
    __playReadyE2EControl: { finish(): void };
  }).__playReadyE2EControl.finish());
}

test.describe('PlayReady native webOS contract (no browser decryption)', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1",Track 1',
    '#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready',
    '#KODIPROP:inputstream.adaptive.license_key=http://host/license?a=1&b=2',
    DASH_URL,
  ].join('\n');
  const customPlaylist = playlist.replace(DASH_URL,
    '#KODIPROP:drm_custom_data=<token a="b">&value</token>\n' + DASH_URL);
  const mpd = DASH_MPD.replace('<Period>',
    '<Period><ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>');
  const protectedType = 'video/mp4;mediaOption=' + encodeURIComponent(JSON.stringify({
    mediaTransportType: 'MPEG-DASH',
    option: { drm: { type: 'playready', clientId: 'client-1' } },
  }));

  test.beforeEach(async ({ page }) => {
    await installShakaStub(page, { webOS: true });
  });

  test.afterEach(async ({ page }) => {
    expect(await page.evaluate(() => (window as unknown as {
      __shakaE2E: { created: number };
    }).__shakaE2E.created)).toBe(0);
  });

  for (const customData of [false, true]) {
    test(`configures DRM before native source attachment${customData ? ' with custom data' : ''} and unloads on Back`,
      async ({ page }) => {
        await installPlayReadyLuna(page, { hold: 'sendDrmMessage' });
        await startDash(page, customData ? customPlaylist : playlist, mpd);
        await expect.poll(async () => (await playReadyProbe(page)).pending).toBe(1);
        const first = await playReadyProbe(page);
        expect(first.calls.map(call => call.method)).toEqual(['load', 'getRightsError', 'sendDrmMessage']);
        expect(first.calls.every(call => call.source === null)).toBe(true);
        expect(first.calls[0].parameters).toEqual({ drmType: 'playready', appId: 'com.lennylxx.iptv' });
        expect(first.calls[1].parameters).toEqual({ clientId: 'client-1', subscribe: true });
        expect(first.calls[2].parameters).toMatchObject({
          clientId: 'client-1', msgType: 'application/vnd.ms-playready.initiator+xml',
          drmSystemId: 'urn:dvb:casystemid:19219',
        });
        expect(first.calls[2].parameters.msg).toContain('<LA_URL>http://host/license?a=1&amp;b=2</LA_URL>');
        await expect(page.locator('#video-player source')).toHaveCount(0);
        await page.evaluate(() =>
          document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
        await expect(page.locator('#player-osd')).not.toContainText('PlayReady');
        await finishPlayReadyRequest(page);
        if (customData) {
          await expect.poll(async () => (await playReadyProbe(page)).pending).toBe(1);
          const second = (await playReadyProbe(page)).calls[3];
          expect(second.method).toBe('sendDrmMessage');
          expect(second.source).toBeNull();
          expect(second.parameters).toMatchObject({
            clientId: 'client-1', msgType: 'application/vnd.ms-playready.initiator+xml',
            drmSystemId: 'urn:dvb:casystemid:19219',
          });
          expect(second.parameters.msg).toContain(
            '<CustomData>&lt;token a=&quot;b&quot;&gt;&amp;value&lt;/token&gt;</CustomData>');
          await expect(page.locator('#video-player source')).toHaveCount(0);
          await finishPlayReadyRequest(page);
        }
        await expect(page.locator('#video-player source')).toHaveAttribute('src', DASH_URL);
        await expect(page.locator('#video-player source')).toHaveAttribute('type', protectedType);
        await page.evaluate(() =>
          document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
        await expect(page.locator('#player-osd .osd-stream-info')).toContainText('PlayReady');
        await page.keyboard.press('Escape');
        await expect(page.locator('#view-channels')).toBeVisible();
        await expect.poll(async () => (await playReadyProbe(page)).cancelledRights).toBe(1);
        expect((await playReadyProbe(page)).calls.filter(call => call.method === 'unload')
          .map(call => call.parameters)).toEqual([{ clientId: 'client-1' }]);
        await expect(page.locator('#video-player source')).toHaveCount(0);
      });
  }

  for (const phase of ['load', 'license message', 'custom-data message'] as const) {
    test(`cleans up a rejected ${phase} without attaching a source`, async ({ page }) => {
      await installPlayReadyLuna(page, {
        failLoad: phase === 'load',
        failMessage: phase === 'license message' ? 1 : phase === 'custom-data message' ? 2 : undefined,
      });
      await startDash(page, customPlaylist, mpd);
      await expect(page.locator('#player-osd')).toContainText('error', { ignoreCase: true });
      const probe = await playReadyProbe(page);
      const methods = phase === 'load' ? ['load'] : [
        'load', 'getRightsError', 'sendDrmMessage',
        ...(phase === 'custom-data message' ? ['sendDrmMessage'] : []), 'unload',
      ];
      expect(probe.calls.map(call => call.method)).toEqual(methods);
      expect(probe.calls.every(call => call.source === null)).toBe(true);
      expect(probe.cancelledRights).toBe(phase === 'load' ? 0 : 1);
      await expect(page.locator('#video-player source')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('#view-channels')).toBeVisible();
      expect((await playReadyProbe(page)).calls.map(call => call.method)).toEqual(methods);
    });
  }

  for (const contentId of ['msg-1', 'msg-2']) {
    test(`correlates rights errors with ${contentId} and clears DRM on channel fallback`, async ({ page }) => {
      await installPlayReadyLuna(page);
      const errors: string[] = [];
      page.on('console', message => {
        if (message.text().includes('event=playback.video.error')) errors.push(message.text());
      });
      await startDash(page, customPlaylist + '\n#EXTINF:-1 tvg-id="ch2",Track 2\nhttp://host/b.mpd');
      await expect(page.locator('#video-player source')).toHaveAttribute('type', protectedType);
      await page.evaluate(() => (window as unknown as {
        __playReadyE2EControl: { rights(contentId: string): void };
      }).__playReadyE2EControl.rights('unrelated-msg'));
      await expect(page.locator('#video-player source')).toHaveAttribute('src', DASH_URL);
      expect(errors).toEqual([]);
      await page.evaluate(contentId => (window as unknown as {
        __playReadyE2EControl: { rights(contentId: string): void };
      }).__playReadyE2EControl.rights(contentId), contentId);
      await expect(page.locator('#player-osd')).toContainText('error', { ignoreCase: true });
      await expect(page.locator('#video-player source')).toHaveAttribute('src', 'http://host/b.mpd');
      expect(errors).toHaveLength(1);
      expect((await playReadyProbe(page)).cancelledRights).toBe(1);
      expect((await playReadyProbe(page)).calls.filter(call => call.method === 'unload')
        .map(call => call.parameters)).toEqual([{ clientId: 'client-1' }]);
      await expect(page.locator('#video-player source')).toHaveAttribute('type',
        'video/mp4;mediaOption=' + encodeURIComponent(JSON.stringify({ mediaTransportType: 'MPEG-DASH' })));
      await page.evaluate(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
      await expect(page.locator('#player-osd')).not.toContainText('PlayReady');
      await page.keyboard.press('Escape');
    });
  }

  for (const hold of ['load', 'sendDrmMessage'] as const) {
    test(`Back cancels pending ${hold} and a late response cannot restart playback`, async ({ page }) => {
      await installPlayReadyLuna(page, { hold });
      await startDash(page, customPlaylist, mpd);
      await expect.poll(async () => (await playReadyProbe(page)).pending).toBe(1);
      await expect(page.locator('#video-player source')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('#view-channels')).toBeVisible();
      await finishPlayReadyRequest(page);
      await expect.poll(async () => (await playReadyProbe(page)).calls
        .filter(call => call.method === 'unload').length).toBe(1);
      const probe = await playReadyProbe(page);
      expect(probe.calls.map(call => call.method)).toEqual(hold === 'load'
        ? ['load', 'unload'] : ['load', 'getRightsError', 'sendDrmMessage', 'unload']);
      expect(probe.calls.every(call => call.source === null)).toBe(true);
      expect(probe.calls[probe.calls.length - 1].parameters).toEqual({ clientId: 'client-1' });
      expect(probe.cancelledRights).toBe(hold === 'load' ? 0 : 1);
      await expect(page.locator('#view-player')).not.toBeVisible();
      await expect(page.locator('#video-player source')).toHaveCount(0);
    });
  }
});
