import { expect, routePlaylist, seedPlaylist, type Page } from './helpers';

export const DASH_URL = 'http://host/a.mpd';

export const DASH_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Test",DASH Test',
  DASH_URL,
].join('\n');

export const DASH_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT12S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" width="1280" height="720"
                      codecs="avc1.4d401f" bandwidth="800000"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="l1">
      <Label>Track 1</Label>
      <Representation id="a1" codecs="mp4a.40.2" bandwidth="96000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

export async function installShakaStub(
  page: Page,
  options: {
    webOS?: boolean; licenseNetwork?: boolean; delayedLoad?: boolean; delayedDestroy?: boolean;
  } = {},
): Promise<void> {
  await page.addInitScript(options => {
    if (options.webOS) {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Web0S Chrome/53.0' });
    }
    const audioTrack = {
      active: true,
      channelsCount: 2,
      codecs: 'mp4a.40.2',
      label: 'Track 1',
      language: 'l1',
      primary: true,
    };
    const textTrack = {
      active: true,
      forced: false,
      label: 'Track 2',
      language: 'l2',
      primary: false,
    };
    const variantTrack = {
      active: true,
      audioCodec: 'mp4a.40.2',
      channelsCount: 2,
      frameRate: 25,
      hdr: 'PQ',
      videoCodec: 'avc1.4d401f',
      spatialAudio: false,
    };
    const state = {
      attached: false,
      loadedUrl: '',
      settings: null as null | Record<string, unknown>,
      currentAudio: audioTrack,
      currentText: textTrack as typeof textTrack | null,
      destroyed: false,
      destroyStarted: false,
      licenseHeaders: {} as Record<string, string>,
      manifestHeaders: {} as Record<string, string>,
      created: 0,
      destroyedCount: 0,
      loadSettled: false,
    };
    let current: Player | null = null;
    let releaseLoad: (() => void) | null = null;
    let releaseDestroy: (() => void) | null = null;
    class Player {
      private video: HTMLVideoElement | null = null;
      private requestFilters: Array<(type: number, request: { headers: Record<string, string> }) => void> = [];
      private listeners = new Map<string, (event: Event) => void>();

      constructor() {
        current = this;
        state.created++;
        state.destroyed = false;
        state.destroyStarted = false;
        state.loadSettled = false;
      }

      attach(video: HTMLVideoElement): Promise<void> {
        this.video = video;
        state.attached = true;
        Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 720 });
        return Promise.resolve();
      }

      configure(settings: Record<string, unknown>): boolean {
        state.settings = settings;
        return true;
      }

      async load(url: string): Promise<void> {
        state.loadedUrl = url;
        const request = { headers: {} as Record<string, string> };
        const manifest = { headers: {} as Record<string, string> };
        for (const filter of this.requestFilters) {
          filter(2, request);
          filter(0, manifest);
        }
        state.licenseHeaders = request.headers;
        state.manifestHeaders = manifest.headers;
        const drm = state.settings?.drm as { servers?: Record<string, string> } | undefined;
        const servers = drm?.servers || {};
        const server = servers[Object.keys(servers)[0]];
        if (options.licenseNetwork && server) {
          const response = await fetch(server, { method: 'POST', headers: request.headers, body: 'synthetic-challenge' });
          if (!response.ok) throw new Error('Synthetic license rejection');
        }
        if (options.delayedLoad) await new Promise<void>(resolve => { releaseLoad = resolve; });
        state.loadSettled = true;
      }

      addEventListener(type: string, listener: (event: Event) => void): void {
        this.listeners.set(type, listener);
      }

      emitError(severity: number): void {
        this.listeners.get('error')?.(new CustomEvent('error', {
          detail: { severity, category: 6, code: 6008, data: ['synthetic-private-license-data'] },
        }));
      }

      adapt(): void {
        this.listeners.get('adaptation')?.(new Event('adaptation'));
      }

      getAudioTracks(): object[] {
        return [audioTrack];
      }

      getNetworkingEngine(): {
        registerRequestFilter: (
          filter: (type: number, request: { headers: Record<string, string> }) => void,
        ) => void;
      } {
        return {
          registerRequestFilter: filter => this.requestFilters.push(filter),
        };
      }

      getTextTracks(): object[] {
        return [textTrack];
      }

      getVariantTracks(): object[] {
        return [variantTrack];
      }

      selectAudioTrack(track: typeof audioTrack): void {
        state.currentAudio = track;
      }

      selectTextTrack(track?: typeof textTrack | null): void {
        state.currentText = track ?? null;
        textTrack.active = track === textTrack;
      }

      async destroy(): Promise<void> {
        state.destroyStarted = true;
        if (options.delayedDestroy) await new Promise<void>(resolve => { releaseDestroy = resolve; });
        if (this.video) {
          this.video.removeAttribute('src');
          while (this.video.firstChild) this.video.removeChild(this.video.firstChild);
          this.video.load();
        }
        state.destroyed = true;
        state.destroyedCount++;
      }
    }
    Object.defineProperty(window, '__shaka', {
      configurable: false,
      writable: false,
      value: {
        Player,
        net: { NetworkingEngine: { RequestType: { LICENSE: 2 } } },
        util: { Error: { Severity: { CRITICAL: 2, RECOVERABLE: 1 } } },
      },
    });
    Object.defineProperty(window, '__shakaE2E', {
      configurable: false,
      writable: false,
      value: state,
    });
    Object.defineProperty(window, '__shakaE2EControl', {
      value: {
        error: (severity: number) => current?.emitError(severity),
        finishLoad: () => releaseLoad?.(),
        finishDestroy: () => releaseDestroy?.(),
        changeVariant: (fields: Partial<typeof variantTrack>) => {
          Object.assign(variantTrack, fields);
          current?.adapt();
        },
      },
    });
  }, options);
}

export async function startDash(page: Page, playlist: string, manifest = DASH_MPD): Promise<void> {
  await routePlaylist(page, playlist);
  await page.route('http://host/*.mpd', route => route.fulfill({
    status: 200, contentType: 'application/dash+xml', body: manifest,
  }));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
}

export async function expectDrmPills(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => (window as unknown as {
    __shakaE2E: { loadSettled: boolean };
  }).__shakaE2E.loadSettled);
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  const pills = page.locator('#player-osd .osd-stream-info');
  for (const value of ['720p', 'HDR', '25', 'H.264', 'AAC', 'Audio Track: Track 1', 'Subtitles: Off', label]) {
    await expect(pills).toContainText(value);
  }
}
