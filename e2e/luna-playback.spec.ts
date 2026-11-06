import { test, expect, routePlaylist, seedPlaylist, seedPointer, type Page } from './helpers';

// A channel that declares HTTP headers plays on webOS through
// luna://com.webos.media/load, borrowing the placeholder <video>'s window.
// The fake bus below answers the way UMS does: a subscription gets
// `subscribed`, then the loadCompleted/sourceInfo/playing/currentTime events.

interface LunaCall {
  method: string;
  params: Record<string, unknown>;
}

interface LunaProbe {
  calls: LunaCall[];
  subscribed: string[]; // mediaIds with a live subscription
  cancelled: string[]; // mediaIds whose subscription the app cancelled
  unloaded: string[];
  positions: Record<string, number>; // last currentTime (ms) each pipeline reported
  pending: number;
}

interface MediaScript {
  durationMs: number;
  audio?: string[];
}

interface FakeUmsOptions {
  media: Record<string, MediaScript>;
  // Methods answered only on release(), so the app sees them in flight.
  hold?: string[];
}

const APP_ID = 'com.lennylxx.iptv';
const WINDOW_ID = '_Window_Id_3';
const START_MS = 10000;

async function installFakeUms(page: Page, options: FakeUmsOptions): Promise<void> {
  await page.addInitScript(({ options, appId, windowId, startMs }) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Web0S Chrome/53.0' });
    // Chromium cannot decode the placeholder or synthetic streams; their
    // trusted errors must not zap the channel. The app's own events pass.
    document.addEventListener('error', (event) => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);

    // webOS gives each loaded <video> a UMS mediaId; the placeholder's is the
    // one getForegroundAppInfo pairs with a window.
    const placeholderIds = new WeakMap<HTMLMediaElement, { src: string; id: string }>();
    let placeholderCount = 0;
    const placeholderId = function (this: HTMLMediaElement): string | undefined {
      const src = this.getAttribute('src') || '';
      if (src.indexOf('black.mp4') < 0) return undefined;
      let entry = placeholderIds.get(this);
      if (!entry || entry.src !== src) {
        entry = { src, id: `_ph${String(++placeholderCount)}` };
        placeholderIds.set(this, entry);
      }
      return entry.id;
    };
    Object.defineProperty(HTMLMediaElement.prototype, 'mediaId', { configurable: true, get: placeholderId });

    interface Media {
      uri: string;
      script: { durationMs: number; audio?: string[] };
      position: number;
      timer: ReturnType<typeof setInterval> | null;
      sub: FakePalmServiceBridge | null;
    }
    const probe: LunaProbe = { calls: [], subscribed: [], cancelled: [], unloaded: [], positions: {}, pending: 0 };
    const media = new Map<string, Media>();
    const pending: Array<() => void> = [];
    let loads = 0;

    const post = (item: Media, mediaId: string, event: Record<string, unknown>) => {
      setTimeout(() => item.sub?.respond({ ...event, mediaId, returnValue: true }), 0);
    };
    const report = (item: Media, mediaId: string) => {
      probe.positions[mediaId] = item.position;
      post(item, mediaId, { currentTime: { currentTime: item.position } });
    };
    const stopClock = (item: Media) => {
      if (item.timer !== null) clearInterval(item.timer);
      item.timer = null;
    };

    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private cancelled = false;
      private mediaId = '';

      respond(response: Record<string, unknown>): void {
        if (!this.cancelled) this.onservicecallback?.(JSON.stringify(response));
      }

      private answer(method: string, response: Record<string, unknown>): void {
        const send = () => setTimeout(() => this.respond(response), 0);
        if (options.hold && options.hold.indexOf(method) >= 0) {
          pending.push(send);
          probe.pending = pending.length;
        } else {
          send();
        }
      }

      call(uri: string, payload: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const params = JSON.parse(payload) as Record<string, unknown>;
        const mediaId = typeof params.mediaId === 'string' ? params.mediaId : '';
        const item = media.get(mediaId);
        const ok = { returnValue: true, mediaId };
        if (uri === 'luna://com.webos.service.videooutput/display/setDisplayWindow') {
          probe.calls.push({ method, params });
          this.answer(method, { returnValue: true });
          return;
        }
        if (uri.indexOf('luna://com.webos.media/') !== 0) {
          this.respond({ returnValue: false, errorCode: -1, errorText: 'Unmocked service' });
          return;
        }
        probe.calls.push({ method, params });
        if (method === 'getForegroundAppInfo') {
          const entries = Array.prototype.slice.call(document.querySelectorAll('video'))
            .map((video: HTMLVideoElement) => placeholderId.call(video))
            .filter((id): id is string => !!id)
            .map((id: string) => ({ appId, mediaId: id, windowId, playing: true, type: 'media' }));
          this.answer(method, { returnValue: true, foregroundAppInfo: entries });
        } else if (method === 'load') {
          const id = `lm-${String(++loads)}`;
          const script = options.media[String(params.uri)] ?? { durationMs: 0 };
          media.set(id, { uri: String(params.uri), script, position: startMs, timer: null, sub: null });
          this.answer(method, { returnValue: true, mediaId: id });
        } else if (method === 'subscribe' && item) {
          this.mediaId = mediaId;
          item.sub = this;
          probe.subscribed.push(mediaId);
          this.respond({ returnValue: true, subscribed: true, mediaId });
          // UMS opens every subscription with this non-error.
          post(item, mediaId, { error: { errorCode: 0, errorText: 'No Error' } });
          post(item, mediaId, { loadCompleted: true });
          const audio = item.script.audio ?? [];
          post(item, mediaId, {
            sourceInfo: {
              container: 'MPEG2TS',
              numPrograms: 1,
              programInfo: [{
                duration: item.script.durationMs,
                numAudioTracks: audio.length,
                audioTrackInfo: audio.map((language, index) => ({
                  language, codec: 'AAC', channels: 2, selected: index === 0,
                })),
                numVideoTracks: 1,
                videoTrackInfo: [{ width: 1920, height: 1080, codec: 'H264', frameRate: 25 }],
              }],
            },
          });
        } else if (method === 'play' && item) {
          this.answer(method, ok);
          if (item.timer === null) {
            post(item, mediaId, { playing: true });
            report(item, mediaId);
            item.timer = setInterval(() => {
              item.position += 1000;
              report(item, mediaId);
            }, 1000);
          }
        } else if (method === 'pause' && item) {
          stopClock(item);
          this.answer(method, ok);
          post(item, mediaId, { paused: true });
        } else if (method === 'seek' && item) {
          item.position = Number(params.position);
          this.answer(method, ok);
          post(item, mediaId, { seekDone: true });
          report(item, mediaId);
        } else if (method === 'selectTrack' && item) {
          this.answer(method, ok);
          post(item, mediaId, { trackSelected: { type: params.type, index: params.index } });
        } else if (method === 'unload' && item) {
          stopClock(item);
          media.delete(mediaId);
          probe.unloaded.push(mediaId);
          this.answer(method, ok);
        } else if ((method === 'setVolume' || method === 'setSubtitleEnable') && item) {
          this.answer(method, ok);
        } else {
          this.respond({ returnValue: false, errorCode: -1, errorText: `Unmocked ${method}` });
        }
      }

      cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        if (!this.mediaId) return;
        probe.cancelled.push(this.mediaId);
        probe.subscribed = probe.subscribed.filter(id => id !== this.mediaId);
        const item = media.get(this.mediaId);
        if (item && item.sub === this) item.sub = null;
      }
    }
    Object.defineProperty(window, 'PalmServiceBridge', { value: FakePalmServiceBridge });
    Object.defineProperty(window, '__lunaE2E', { value: probe });
    Object.defineProperty(window, '__lunaE2EControl', {
      value: {
        release: () => {
          for (const send of pending.splice(0)) send();
          probe.pending = 0;
        },
      },
    });
  }, { options, appId: APP_ID, windowId: WINDOW_ID, startMs: START_MS });
}

async function lunaProbe(page: Page): Promise<LunaProbe> {
  return page.evaluate(() => (window as unknown as { __lunaE2E: LunaProbe }).__lunaE2E);
}

function callsOf(probe: LunaProbe, method: string, mediaId?: string): LunaCall[] {
  return probe.calls.filter(call => call.method === method
    && (mediaId === undefined || call.params.mediaId === mediaId || call.params.context === mediaId));
}

async function pressKey(page: Page, keyCode: number): Promise<void> {
  await page.evaluate(code =>
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), keyCode);
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => value ? 'hidden' : 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

// Waits until the pipeline played and reported time, which is when the
// player has left its start-up state.
async function waitForPlaying(page: Page, mediaId: string): Promise<void> {
  await expect.poll(async () => {
    const probe = await lunaProbe(page);
    return callsOf(probe, 'play', mediaId).length > 0 && (probe.positions[mediaId] ?? 0) > 0;
  }).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    !(document.getElementById('video-player') as HTMLVideoElement).paused)).toBe(true);
}

async function startFirstChannel(page: Page, playlist: string): Promise<void> {
  await routePlaylist(page, playlist);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
}

const MEDIA_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';

async function routeStreams(page: Page, bodies: Record<string, { status?: number; type: string; body: string }>): Promise<string[]> {
  const seen: string[] = [];
  await page.route('http://host/**', route => {
    const url = route.request().url();
    seen.push(url);
    const hit = bodies[url];
    if (hit) return route.fulfill({ status: hit.status ?? 200, contentType: hit.type, body: hit.body });
    return route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: MEDIA_PLAYLIST });
  });
  return seen;
}

const HEADER_M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1",Alpha',
  '#EXTVLCOPT:http-referrer=http://host/r',
  '#EXTVLCOPT:http-user-agent=Agent 1',
  'http://host/a.m3u8',
  '#EXTINF:-1 tvg-id="ch2",Bravo',
  '#EXTHTTP:{"Cookie":"k=v","X-Token":"t1"}',
  'http://host/b.m3u8',
].join('\n');

test('a header channel plays through Luna and a channel switch releases its pipeline', async ({ page }) => {
  await installFakeUms(page, { media: {} });
  await routeStreams(page, {});
  await startFirstChannel(page, HEADER_M3U);
  await waitForPlaying(page, 'lm-1');

  let probe = await lunaProbe(page);
  expect(callsOf(probe, 'load')).toHaveLength(1);
  expect(callsOf(probe, 'load')[0].params).toEqual({
    uri: 'http://host/a.m3u8',
    type: 'media',
    payload: {
      mediaTransportType: 'HLS',
      option: {
        appId: APP_ID,
        windowId: WINDOW_ID,
        transmission: { httpHeader: { referer: 'http://host/r', userAgent: 'Agent 1' } },
      },
    },
  });
  expect(callsOf(probe, 'subscribe')[0].params).toEqual({ mediaId: 'lm-1', subscribe: true });
  expect(callsOf(probe, 'setDisplayWindow', 'lm-1')[0].params)
    .toEqual({ context: 'lm-1', fullScreen: true });
  // The page's <video> holds only the placeholder clip.
  expect(await page.locator('#video-player').getAttribute('src')).toContain('black.mp4');

  await pressKey(page, 405); // yellow: OSD
  const osd = page.locator('#player-osd');
  await expect(osd).toBeVisible();
  await expect(osd.locator('.osd-channel-name')).toHaveText('Alpha');
  await expect(osd.locator('.osd-message')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await waitForPlaying(page, 'lm-2');
  probe = await lunaProbe(page);
  expect(callsOf(probe, 'load')).toHaveLength(2);
  expect(callsOf(probe, 'load')[1].params).toMatchObject({
    uri: 'http://host/b.m3u8',
    payload: {
      option: {
        transmission: { httpHeader: { cookies: 'k=v' }, extraHttpHeader: { 'x-token': 't1' } },
      },
    },
  });
  expect(probe.cancelled).toEqual(['lm-1']);
  expect(probe.unloaded).toEqual(['lm-1']);
  expect(probe.subscribed).toEqual(['lm-2']);
  // Nothing addresses the released pipeline after its unload.
  const unloadAt = probe.calls.findIndex(call => call.method === 'unload');
  expect(probe.calls.slice(unloadAt + 1).filter(call =>
    call.params.mediaId === 'lm-1' || call.params.context === 'lm-1')).toEqual([]);
  await expect(osd.locator('.osd-channel-name')).toHaveText('Bravo');
  await expect(osd.locator('.osd-message')).toHaveCount(0);
});

test('Luna audio names come from the master and an audio pick switches the UMS track', async ({ page }) => {
  await installFakeUms(page, { media: { 'http://host/a.m3u8': { durationMs: 0, audio: ['l1', 'l2'] } } });
  await routeStreams(page, {
    'http://host/a.m3u8': {
      type: 'application/vnd.apple.mpegurl',
      body: [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 1",LANGUAGE="l1",DEFAULT=YES,URI="http://host/a1.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Track 2",LANGUAGE="l2",URI="http://host/a2.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track 3",LANGUAGE="l1",URI="http://host/s1.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",SUBTITLES="s"',
        'http://host/v.m3u8',
      ].join('\n'),
    },
  });
  await startFirstChannel(page, HEADER_M3U);
  await waitForPlaying(page, 'lm-1');

  await seedPointer(page);
  await page.keyboard.press('ArrowRight');
  const menu = page.locator('#player-menu');
  await expect(menu).toBeVisible();
  const audioRow = menu.locator('[data-menu-action="__audio_open__"]');
  await expect(audioRow.locator('.menu-item-value')).toHaveText('Track 1');
  await audioRow.click();
  await expect(menu.locator('[data-menu-action="__audio_track__"] .menu-track-label'))
    .toHaveText(['Track 1', 'Track 2']);
  await menu.locator('[data-menu-action="__audio_track__"][data-track-index="1"]').click();
  await expect.poll(async () => callsOf(await lunaProbe(page), 'selectTrack', 'lm-1').map(call => call.params))
    .toEqual([{ mediaId: 'lm-1', type: 'audio', index: 1 }]);
  await expect(audioRow.locator('.menu-item-value')).toHaveText('Track 2');

  // The WebVTT rendition is self-rendered, so the menu offers it.
  await menu.locator('[data-menu-action="__subs_open__"]').click();
  await expect(menu.locator('[data-menu-action="__subs_track__"] .menu-track-label'))
    .toContainText(['Off', 'Track 3']);
});
