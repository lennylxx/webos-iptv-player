import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, routePlaylist, seedPlaylist, type Page, liveLoaded } from './helpers';
import { createStreamProxy, type StreamProxy } from '../bundled-service/src/proxy/server';
import { DEFAULT_STANDALONE_PROXY_PORT } from '../bundled-service/src/proxy/service';

// The desktop preview opens Local proxy sessions on the standalone service's
// fixed loopback port, so one worker owns it at a time.
test.describe.configure({ mode: 'serial' });

const REFERER = 'http://ref.example.com/';

interface Seen {
  path: string;
  referer: string | undefined;
}

let upstream: http.Server;
let proxy: StreamProxy;
let base = '';
const seen: Seen[] = [];
let refused = 0;

const BODIES: Record<string, { type: string; body: string }> = {
  '/hls/master.m3u8': {
    type: 'application/vnd.apple.mpegurl',
    body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nv1/index.m3u8\n',
  },
  '/hls/v1/index.m3u8': {
    type: 'application/vnd.apple.mpegurl',
    body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n'
      + '#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n',
  },
  '/dash/a.mpd': {
    type: 'application/dash+xml',
    body: `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT12S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="6000" startNumber="1"
                       initialization="init-$RepresentationID$.mp4" media="seg-$RepresentationID$-$Number$.m4s"/>
      <Representation id="v1" width="1280" height="720" codecs="avc1.4d401f" bandwidth="800000"/>
    </AdaptationSet>
  </Period>
</MPD>`,
  },
};

test.beforeAll(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium',
    'the proxy is a service feature; one project owns its fixed port');
  upstream = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    seen.push({ path, referer: req.headers.referer });
    if (req.headers.referer !== REFERER) {
      refused++;
      res.writeHead(403);
      res.end();
      return;
    }
    const known = BODIES[path];
    res.writeHead(200, { 'content-type': known ? known.type : 'video/mp2t' });
    res.end(known ? known.body : Buffer.alloc(188 * 4, 0x47));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  proxy = createStreamProxy({ port: DEFAULT_STANDALONE_PROXY_PORT, control: true, allowLoopback: true });
  await new Promise<void>((resolve, reject) =>
    proxy.listen(error => (error ? reject(error) : resolve())));
});

test.afterAll(async () => {
  proxy?.stop();
  await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
});

test.beforeEach(() => {
  seen.length = 0;
  refused = 0;
});

async function playThroughProxy(page: Page, streamPath: string): Promise<void> {
  await routePlaylist(page, [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ch1" group-title="Test",Channel 1',
    `#EXTVLCOPT:http-referrer=${REFERER}`,
    `${base}${streamPath}`,
  ].join('\n'));
  await seedPlaylist(page);
  await page.addInitScript(() => localStorage.setItem('iptv_header_playback', JSON.stringify('proxy')));
  await page.goto('/');
  await liveLoaded(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
}

test('plays a Referer-gated HLS stream through the standalone proxy', async ({ page }) => {
  const direct: string[] = [];
  page.on('request', request => {
    if (request.url().indexOf(base) === 0) direct.push(request.url());
  });

  await playThroughProxy(page, '/hls/master.m3u8');

  await expect.poll(() => seen.map(s => s.path)).toEqual(expect.arrayContaining([
    '/hls/master.m3u8', '/hls/v1/index.m3u8', '/hls/v1/seg0.ts',
  ]));
  expect(refused).toBe(0);
  expect(seen.every(s => s.referer === REFERER)).toBe(true);
  expect(direct).toEqual([]);
});

test('plays a Referer-gated clear DASH stream through the standalone proxy on Shaka', async ({ page }) => {
  await playThroughProxy(page, '/dash/a.mpd');

  await expect.poll(() => seen.map(s => s.path)).toEqual(expect.arrayContaining([
    '/dash/a.mpd', '/dash/init-v1.mp4',
  ]));
  expect(refused).toBe(0);
});
