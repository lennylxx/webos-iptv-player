import {
  test,
  expect,
  isChromium53,
  routePlaylist,
  seedPlaylist,
  type Page,
} from './helpers';

const DASH_URL = 'http://host/a.mpd';
const DASH_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Test",DASH Test',
  DASH_URL,
].join('\n');
const DASH_MPD = `<?xml version="1.0" encoding="utf-8"?>
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

async function installDashStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const roleScheme = 'urn:mpeg:dash:role:2011';
    const videoTrack = {
      index: 0,
      codec: 'video/mp4;codecs="avc1.4d401f"',
    };
    const audioTrack = {
      index: 0,
      lang: 'l1',
      labels: [{ text: 'Track 1' }],
      roles: [{ schemeIdUri: roleScheme, value: 'main' }],
      codec: 'audio/mp4;codecs="mp4a.40.2"',
      audioChannelConfiguration: [{ value: '2' }],
    };
    const textTrack = {
      index: 0,
      lang: 'l2',
      labels: [{ text: 'Track 2' }],
      roles: [],
    };
    const state = {
      initialized: null as null | { url: string; autoplay: boolean },
      settings: null as null | Record<string, unknown>,
      streamInitialized: false,
      currentAudio: audioTrack,
      textTrack: -1,
      destroyed: false,
    };
    const player = {
      initialize(video: HTMLVideoElement, url: string, autoplay: boolean): void {
        state.initialized = { url, autoplay };
        Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 720 });
      },
      updateSettings(settings: Record<string, unknown>): void {
        state.settings = settings;
      },
      on(event: string, listener: () => void): void {
        if (event === 'streamInitialized') {
          setTimeout(() => {
            state.streamInitialized = true;
            listener();
          }, 0);
        }
      },
      getTracksFor(type: string): object[] {
        if (type === 'video') return [videoTrack];
        if (type === 'audio') return [audioTrack];
        if (type === 'text') return [textTrack];
        return [];
      },
      getCurrentTrackFor(type: string): object | null {
        if (type === 'video') return videoTrack;
        if (type === 'audio') return state.currentAudio;
        return null;
      },
      getCurrentTextTrackIndex(): number {
        return state.textTrack;
      },
      setCurrentTrack(track: typeof audioTrack): void {
        state.currentAudio = track;
      },
      setTextTrack(index: number): void {
        state.textTrack = index;
      },
      destroy(): void {
        state.destroyed = true;
      },
    };
    const mediaPlayer = Object.assign(
      () => ({ create: () => player }),
      {
        events: {
          ERROR: 'error',
          FRAGMENT_LOADING_COMPLETED: 'fragmentLoadingCompleted',
          STREAM_INITIALIZED: 'streamInitialized',
        },
      },
    );
    Object.defineProperty(window, '__dashjs', {
      configurable: false,
      writable: false,
      value: { MediaPlayer: mediaPlayer },
    });
    Object.defineProperty(window, '__dashE2E', {
      configurable: false,
      writable: false,
      value: state,
    });
  });
}

test('routes an MPD through dash.js and renders its stream info', async ({ page }) => {
  await installDashStub(page);
  await routePlaylist(page, DASH_M3U);
  await page.route(DASH_URL, route => route.fulfill({
    status: 200,
    contentType: 'application/dash+xml',
    body: DASH_MPD,
  }));
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await page.waitForFunction(() =>
    (window as unknown as { __dashE2E?: { streamInitialized: boolean } })
      .__dashE2E?.streamInitialized === true);

  const state = await page.evaluate(() =>
    (window as unknown as {
      __dashE2E: {
        initialized: { url: string; autoplay: boolean } | null;
        settings: {
          streaming?: { buffer?: { bufferTimeDefault?: number } };
        } | null;
        textTrack: number;
      };
    }).__dashE2E);
  expect(state.initialized).toEqual({ url: DASH_URL, autoplay: true });
  expect(state.settings?.streaming?.buffer?.bufferTimeDefault).toBe(30);
  expect(state.textTrack).toBe(-1);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 405, bubbles: true })));
  const info = page.locator('#player-osd .osd-stream-info');
  await expect(info).toBeVisible();
  await expect(info).toContainText('720p');
  await expect(info).toContainText('H.264');
  await expect(info).toContainText('AAC');
  await expect(info).toContainText('Track 1');
});

test('loads the real dash.js engine in the desktop preview', async ({ page }) => {
  test.skip(isChromium53(), 'dash.js is a modern-browser desktop preview dependency');

  let manifestRequests = 0;
  await routePlaylist(page, DASH_M3U);
  await page.route(DASH_URL, route => {
    manifestRequests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/dash+xml',
      body: DASH_MPD,
    });
  });
  await seedPlaylist(page);
  await page.goto('/');
  await page.waitForFunction(() =>
    typeof (window as unknown as { __dashjs?: { MediaPlayer?: unknown } })
      .__dashjs?.MediaPlayer === 'function');
  await expect(page.locator('#view-channels')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();

  // PlayerPipeline fetches track metadata first; the real dash.js instance then
  // makes its own manifest request while initializing playback.
  await expect.poll(() => manifestRequests).toBeGreaterThanOrEqual(2);
});
