import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PLAYLIST_URL, test, expect, enterTab, routeLiveManifest, routePlaylist, seedPlaylist, type Page,
} from './helpers';

// A large playlist shows its first channels while the rest still downloads,
// and the remote works on them from the start.

const HEAD_CHANNELS = 3000;
const TOTAL_CHANNELS = 6000;

function channelLines(from: number, to: number, name = 'Channel'): string {
  let text = '';
  for (let i = from; i < to; i++) {
    text += `#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${i % 7}",${name} ${i}\n`
      + `http://streams.example.com/${name}${i}.m3u8\n`;
  }
  return text;
}

interface HeldPlaylist {
  url: string;
  /** Requests received so far. */
  requests: () => number;
  /** Sends the tail of one request, by arrival order. */
  releaseRequest: (index: number) => void;
  release: () => void;
  /** Later requests send nothing at all until released. */
  silenceNext: () => void;
  /** Cuts one request off mid-body, by arrival order. */
  failRequest: (index: number) => void;
  close: () => Promise<void>;
}

// Sends the head of the playlist with the full Content-Length, then holds the
// tail until release().
async function serveHeldPlaylist(header = '#EXTM3U', name = 'Channel'): Promise<HeldPlaylist> {
  const head = Buffer.from(header + '\n' + channelLines(0, HEAD_CHANNELS, name));
  const tail = Buffer.from(channelLines(HEAD_CHANNELS, TOTAL_CHANNELS, name));
  let release!: () => void;
  const released = new Promise<void>(resolve => (release = resolve));
  const held: Array<() => void> = [];
  const responses: http.ServerResponse[] = [];
  let silent = false;
  const server = http.createServer((_req, res) => {
    responses.push(res);
    if (silent) {
      held.push(() => {
        res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/x-mpegurl' });
        res.end(Buffer.concat([head, tail]));
      });
      return;
    }
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/x-mpegurl',
      'content-length': String(head.length + tail.length),
    });
    res.write(head);
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      res.end(tail);
    };
    held.push(send);
    void released.then(send);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/big.m3u`,
    requests: () => held.length,
    releaseRequest: index => held[index](),
    release,
    silenceNext: () => { silent = true; },
    failRequest: index => responses[index].destroy(),
    close: () => {
      release();
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function seedAutoPlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('iptv_auto_play', 'true');
    localStorage.setItem('iptv_last_channel', JSON.stringify({ index: 0 }));
  });
}

// The head of the playlist has arrived and shows in Live.
const headShown = (page: Page) =>
  expect(page.locator('.channel-main .channel-item').first()).toBeVisible();

const focusedKey = (page: Page) =>
  page.locator('.channel-main .channel-item.focused').getAttribute('data-key');

test('the arriving channel list takes keys and keeps its place over auto-play', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await routeLiveManifest(page);
    await seedAutoPlay(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await headShown(page);
    await expect(page.locator('.channel-main .channel-item.focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    const before = await focusedKey(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedKey(page)).not.toBe(before);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    const moved = await focusedKey(page);

    playlist.release();
    await expect(page.locator('.channel-count')).toContainText(/6\D?000/);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    // Auto-play would have taken the screen from the user who started browsing.
    await page.waitForTimeout(500);
    await expect(page.locator('#view-player')).toBeHidden();
    expect(await focusedKey(page)).toBe(moved);
  } finally {
    await playlist.close();
  }
});

test('an arriving channel list still auto-plays when nobody pressed a key', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await routeLiveManifest(page);
    await seedAutoPlay(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    playlist.release();
    await expect(page.locator('#view-player')).toBeVisible();
  } finally {
    await playlist.close();
  }
});

// A first launch loads the whole list and plays Channel 5, so auto-play has a
// saved last channel to resume. Later launches keep the stored playlists.
async function playChannelFive(page: Page, playlist: HeldPlaylist): Promise<void> {
  await routeLiveManifest(page);
  await page.addInitScript((url) => {
    if (localStorage.getItem('iptv_playlists')) return;
    localStorage.setItem('iptv_auto_play', 'true');
    localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url }]));
  }, playlist.url);
  await page.goto('/');
  await headShown(page);
  playlist.releaseRequest(0);
  await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Channel 5');
  await page.keyboard.press('Enter');
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
}

// A new playlist address misses the cache, so the next launch downloads it.
async function setPlaylists(page: Page, urls: string[]): Promise<void> {
  await page.evaluate((list) => {
    localStorage.setItem('iptv_playlists', JSON.stringify(
      list.map((url, i) => ({ name: `Source ${String(i + 1)}`, url }))));
  }, urls);
}

test('auto-play resumes the last channel as soon as it arrives', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await playChannelFive(page, playlist);
    await setPlaylists(page, [`${playlist.url}?v=2`]);
    await page.reload();
    await expect.poll(() => playlist.requests()).toBe(2);
    await expect(page.locator('#view-player')).toBeVisible();
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
    // It plays while the rest of the playlist is still on its way.
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    playlist.releaseRequest(1);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
  } finally {
    await playlist.close();
  }
});

test('auto-play resumes the last channel from the first cached chunk', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    // Holds the read of the cached playlist's second chunk until released.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('holdChunk')) return;
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      (window as unknown as { releaseChunk: () => void }).releaseChunk = release;
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
        const request = get.call(this, key);
        if (typeof key !== 'string' || !key.endsWith('#000001')) return request;
        const setter = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!.set!;
        Object.defineProperty(request, 'onsuccess', {
          configurable: true,
          set(listener: (event: Event) => void) {
            setter.call(request, (event: Event) => { void released.then(() => listener.call(request, event)); });
          },
        });
        return request;
      };
    });
    await playChannelFive(page, playlist);
    await expect.poll(() => page.evaluate(() => new Promise<number>((resolve) => {
      const open = indexedDB.open('iptv');
      open.onsuccess = () => {
        const keys = open.result.transaction('playlist-cache', 'readonly')
          .objectStore('playlist-cache').getAllKeys();
        keys.onsuccess = () => { resolve(keys.result.length); open.result.close(); };
      };
    })), { timeout: 10_000 }).toBeGreaterThan(1);
    await page.evaluate(() => sessionStorage.setItem('holdChunk', '1'));
    await page.reload();

    await expect(page.locator('#view-player')).toBeVisible();
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { releaseChunk: () => void }).releaseChunk());
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
    expect(playlist.requests()).toBe(1);
  } finally {
    await playlist.close();
  }
});

test('a list that starts over under an early auto-play marks nothing as playing', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  const next = await serveHeldPlaylist('#EXTM3U', 'Other');
  try {
    await playChannelFive(page, playlist);
    await setPlaylists(page, [`${playlist.url}?v=2`, next.url]);
    await page.reload();
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');

    playlist.failRequest(1);
    await expect.poll(() => next.requests()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.channel-main .channel-item').first()).toContainText('Other 0');
    // Channel 5 is gone; Other 5, now at its index, must not show as playing.
    await expect(page.locator('.channel-main .channel-item.playing')).toHaveCount(0);
  } finally {
    await playlist.close();
    await next.close();
  }
});

test('a reminder launch tunes its channel instead of an early auto-play', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await playChannelFive(page, playlist);
    await page.addInitScript(() => {
      const params = sessionStorage.getItem('launchParams');
      if (params) (window as unknown as { PalmSystem: object }).PalmSystem = { launchParams: params };
    });
    const reminderKey = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('iptv_last_channel')!) as { key: string }).key);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.osd-channel-name')).not.toHaveText('Channel 5');
    await setPlaylists(page, [`${playlist.url}?v=2`]);
    await page.evaluate((key) =>
      sessionStorage.setItem('launchParams', JSON.stringify({ reminderChannelKey: key })), reminderKey);
    // Only what the relaunched page tunes; the old one refreshes its stream until it goes.
    const tuned: string[] = [];
    let relaunched = false;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) relaunched = true; });
    page.on('request', (request) => {
      if (relaunched && request.url().endsWith('.m3u8')) tuned.push(request.url());
    });
    await page.reload();

    await expect.poll(() => playlist.requests()).toBe(2);
    await headShown(page);
    await page.waitForTimeout(500);
    await expect(page.locator('#view-player')).toBeHidden();
    playlist.releaseRequest(1);
    await expect(page.locator('.osd-channel-name')).toHaveText('Channel 5');
    // The last channel never started ahead of the reminder's.
    expect(tuned.length).toBeGreaterThan(0);
    expect(tuned.filter(url => !url.endsWith('/Channel5.m3u8'))).toEqual([]);
  } finally {
    await playlist.close();
  }
});

test('Parental Controls opened before the channels arrive lists their groups once they do', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    playlist.silenceNext();
    await routeLiveManifest(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await enterTab(page, 'settings');
    await page.locator('#manage-parental-controls').click();
    const prompt = page.locator('.parental-pin-prompt');
    await prompt.locator('.parental-pin-input').fill('1234');
    await prompt.locator('.parental-pin-input').fill('1234');
    await expect(page.locator('#view-parental-controls')).toBeVisible();
    await expect(page.locator('[data-parental-group]')).toHaveCount(0);

    await expect.poll(() => playlist.requests()).toBe(1);
    playlist.releaseRequest(0);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('[data-parental-group]').filter({ hasText: 'Group 3' })).toHaveCount(1);
  } finally {
    await playlist.close();
  }
});

test('a pointer click while the channels arrive also keeps auto-play away', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await routeLiveManifest(page);
    await seedAutoPlay(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await expect(page.locator('#view-settings')).toBeVisible();

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.locator('#view-player')).toBeHidden();
    await expect(page.locator('#view-settings')).toBeVisible();
  } finally {
    await playlist.close();
  }
});

test('a wheel scroll over the arriving channels also keeps auto-play away', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await routeLiveManifest(page);
    await seedAutoPlay(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await headShown(page);
    await page.locator('.channel-main .channel-item').nth(2).hover();
    await page.mouse.wheel(0, 600);

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.locator('#view-player')).toBeHidden();
  } finally {
    await playlist.close();
  }
});

test('a reload started while the channels arrive is not ended by the load it replaced', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);

    // The replaced load finishing must leave the reload's progress and list alone.
    playlist.releaseRequest(0);
    await page.waitForTimeout(1500);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await expect(page.locator('.channel-count')).not.toContainText(/6\D?000/);

    playlist.releaseRequest(1);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('.channel-count')).toContainText(/6\D?000/);
  } finally {
    await playlist.close();
  }
});

test('a reload that has not shown anything yet drops the progress of the load it replaced', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  const fill = page.locator('.tab-bar-progress-fill');
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(fill).not.toHaveAttribute('style', /scaleX\(0\)/);
    playlist.silenceNext();
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);
    // The reload's own progress starts over.
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await expect(fill).toHaveAttribute('style', /scaleX\(0\)/);

    playlist.releaseRequest(1);
    await expect(page.locator('.channel-count')).toContainText(/6\D?000/);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
  } finally {
    await playlist.close();
  }
});

test('settings saved while the channels arrive leave the background refresh for later', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#save-settings').click();
    await expect(page.locator('#view-channels')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(playlist.requests()).toBe(1);

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(playlist.requests()).toBe(1);
  } finally {
    await playlist.close();
  }
});

test('a Guide opened while the channels arrive shows the programs that load after them', async ({ page }) => {
  const playlist = await serveHeldPlaylist('#EXTM3U url-tvg="http://host/guide.xml"');
  try {
    await page.clock.setFixedTime(new Date('2024-03-09T12:00:00Z'));
    await page.route('**/guide.xml', route => route.fulfill({
      status: 200,
      contentType: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="ch0"><display-name>Channel 0</display-name></channel>
<programme channel="ch0" start="20240309110000 +0000" stop="20240309130000 +0000">
  <title>Alpha Program</title>
</programme>
</tv>`,
    }));
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await headShown(page);
    await page.evaluate(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 403, bubbles: true })));
    await expect(page.locator('#view-epg')).toBeVisible();

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('#epg-programmes')).toContainText('Alpha Program');
  } finally {
    await playlist.close();
  }
});

test('a player sidebar opened while the channels arrive lists them all once they have', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await routeLiveManifest(page);
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await headShown(page);
    await page.keyboard.press('Enter');
    await expect(page.locator('#view-player')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    const spacer = page.locator('#player-sidebar .sidebar-channel-spacer');
    await expect(spacer).toBeVisible();
    const height = () => spacer.evaluate(el => el.getBoundingClientRect().height);
    const partial = await height();

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect.poll(height).toBeGreaterThan(partial * 1.5);
  } finally {
    await playlist.close();
  }
});

test('Live shows at once and takes keys before any channel arrives', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    playlist.silenceNext();
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('#view-channels .empty-state')).toHaveText('Loading channels…');
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar-item[data-section="live"].focused')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#view-epg .epg-no-channels')).toHaveText('Loading channels…');

    // The arriving channels fill the Guide the user went to.
    await expect.poll(playlist.requests).toBe(1);
    playlist.releaseRequest(0);
    await expect(page.locator('#view-epg .epg-channel-item').first()).toBeVisible();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('#view-channels')).toBeHidden();
  } finally {
    await playlist.close();
  }
});

test('a playlist read from the cache focuses its first channel', async ({ page }) => {
  await routePlaylist(page);
  // Seed once: a new source id on reload would miss the cache.
  await page.addInitScript((url) => {
    if (!localStorage.getItem('iptv_playlists')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([{ name: 'Test', url }]));
    }
  }, PLAYLIST_URL);
  const cached = page.waitForEvent('console',
    msg => msg.text().includes('event=playlist.cache.write.completed'));
  await page.goto('/');
  await cached;

  // The relaunch reads the cache: a network load would fail.
  await page.unroute('**/playlist.m3u');
  await page.route('**/playlist.m3u', route => route.abort());
  await page.reload();
  await expect(page.locator('.channel-main .channel-item.focused')).toHaveCount(1);
});

test('a reload clears the old list while the new channels are on their way', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    playlist.release();
    await expect(page.locator('.channel-count')).toContainText(/6\D?000/);

    playlist.silenceNext();
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);
    await expect(page.locator('#view-channels .empty-state')).toHaveText('Loading channels…');
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
  } finally {
    await playlist.close();
  }
});

test('a source that fails partway takes its channels off the list at once', async ({ page }) => {
  const failing = await serveHeldPlaylist();
  const waiting = await serveHeldPlaylist();
  try {
    waiting.silenceNext();
    await page.addInitScript((urls) => {
      localStorage.setItem('iptv_playlists', JSON.stringify(
        urls.map((url, i) => ({ name: `Source ${String(i + 1)}`, url }))));
    }, [failing.url, waiting.url]);
    await page.goto('/');
    await headShown(page);
    // Past the batched redraw of the head, which would clear the rows anyway.
    await page.waitForTimeout(1500);

    failing.failRequest(0);
    await expect.poll(waiting.requests).toBe(1);
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
  } finally {
    await failing.close();
    await waiting.close();
  }
});

test('the source after a failed one shows its first channels at once and focuses them', async ({ page }) => {
  const failing = await serveHeldPlaylist();
  const next = await serveHeldPlaylist('#EXTM3U', 'Other');
  try {
    await page.addInitScript((urls) => {
      localStorage.setItem('iptv_playlists', JSON.stringify(
        urls.map((url, i) => ({ name: `Source ${String(i + 1)}`, url }))));
    }, [failing.url, next.url]);
    await page.goto('/');
    await headShown(page);
    await page.waitForTimeout(1500);

    failing.failRequest(0);
    const focused = page.locator('.channel-main .channel-item.focused .channel-name');
    await expect(focused).toHaveText('Other 0', { timeout: 3000 });
  } finally {
    await failing.close();
    await next.close();
  }
});

// The load throws outside a source's own recovery as its second source starts.
async function failSecondSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      if (args.includes('event=playlist.source.load.started') && args.includes('load=2')) {
        throw new Error('boom');
      }
      log(...args);
    };
  });
}

test('a failed load leaves someone browsing the arrived channels where they are', async ({ page }) => {
  const first = await serveHeldPlaylist();
  const second = await serveHeldPlaylist();
  try {
    await failSecondSource(page);
    await page.addInitScript((urls) => {
      localStorage.setItem('iptv_playlists', JSON.stringify(
        urls.map((url, i) => ({ name: `Source ${String(i + 1)}`, url }))));
    }, [first.url, second.url]);
    await page.goto('/');
    await headShown(page);
    await page.keyboard.press('ArrowDown');

    first.release();
    await expect(page.locator('.toast.visible')).toHaveText('Unable to load the playlist. Check the URL and try again.');
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('#view-settings')).toBeHidden();
  } finally {
    await first.close();
    await second.close();
  }
});

test('a failed load nobody browsed opens Settings', async ({ page }) => {
  const first = await serveHeldPlaylist();
  const second = await serveHeldPlaylist();
  try {
    await failSecondSource(page);
    await page.addInitScript((urls) => {
      localStorage.setItem('iptv_playlists', JSON.stringify(
        urls.map((url, i) => ({ name: `Source ${String(i + 1)}`, url }))));
    }, [first.url, second.url]);
    await page.goto('/');
    await headShown(page);

    first.release();
    await expect(page.locator('#view-settings')).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});

test('a load that has nothing to show yet says so without a count', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    playlist.silenceNext();
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('#view-channels .empty-state')).toHaveText('Loading channels…');
    await expect(page.locator('.channel-count')).toHaveText('');

    await expect.poll(playlist.requests).toBe(1);
    playlist.releaseRequest(0);
    await expect(page.locator('.channel-count')).toContainText(/6\D?000/);
  } finally {
    await playlist.close();
  }
});

test('the load progress ends only once Live lists every channel', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    await headShown(page);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    // Read the count in the same task that ends the progress.
    await page.evaluate(() => {
      const bar = document.querySelector('.tab-bar-progress')!;
      new MutationObserver((_records, observer) => {
        if (bar.classList.contains('active')) return;
        observer.disconnect();
        (window as unknown as { countAtEnd: string }).countAtEnd =
          document.querySelector('.channel-count')?.textContent ?? '';
      }).observe(bar, { attributes: true, attributeFilter: ['class'] });
    });

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { countAtEnd: string }).countAtEnd))
      .toMatch(/6\D?000/);
  } finally {
    await playlist.close();
  }
});

test('settings applied during a reload leave a due guide refresh for after it', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  let guideRequests = 0;
  try {
    await page.route('**/guide.xml', (route) => {
      guideRequests++;
      return route.abort();
    });
    await page.addInitScript(() => {
      localStorage.setItem('iptv_manual_epg_sources',
        JSON.stringify([{ url: 'http://host/guide.xml', playlistIds: [] }]));
    });
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect.poll(() => guideRequests).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const before = guideRequests;

    // The failed guide is due again, but not before the reload is done.
    playlist.silenceNext();
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#save-settings').click();
    await expect(page.locator('#view-channels')).toBeVisible();
    await page.waitForTimeout(1000);
    expect(guideRequests).toBe(before);
  } finally {
    await playlist.close();
  }
});

test('a Search opened during a reload keeps its loading hint past the load it replaced', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);

    await enterTab(page, 'search');
    await page.locator('.tab-bar-search-input').fill('Channel 5999');
    await expect(page.locator('.search-loading-more')).toBeVisible();

    playlist.releaseRequest(0);
    await page.waitForTimeout(1500);
    await expect(page.locator('.search-loading-more')).toBeVisible();
    await expect(page.locator('#view-search .search-view')).toHaveAttribute('data-search-partial', 'true');

    playlist.releaseRequest(1);
    await expect(page.locator('.search-results')).toContainText('Channel 5999');
    await expect(page.locator('.search-loading-more')).toHaveCount(0);
  } finally {
    await playlist.close();
  }
});

test('a Search opened while the channels arrive drops its loading hint when its source fails', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    await headShown(page);

    await enterTab(page, 'search');
    await page.locator('.tab-bar-search-input').fill('Channel 5999');
    await expect(page.locator('.search-loading-more')).toBeVisible();

    playlist.failRequest(0);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('.search-loading-more')).toHaveCount(0);
    await expect(page.locator('#view-search .search-view')).toHaveAttribute('data-search-partial', 'false');
  } finally {
    await playlist.close();
  }
});

test('a Search opened while the channels arrive finds the ones that came after it', async ({ page }) => {
  const playlist = await serveHeldPlaylist();
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');
    await headShown(page);

    await enterTab(page, 'search');
    await page.locator('.tab-bar-search-input').fill('Channel 5999');
    await expect(page.locator('#view-search')).toBeVisible();
    await expect(page.locator('.search-results')).not.toContainText('Channel 5999');
    // More channels are on their way, so the results say they are not final.
    await expect(page.locator('.search-results .search-channel-row, .search-results .search-channel-tile').first()).toBeVisible();
    await expect(page.locator('.search-loading-more')).toBeVisible();
    await expect(page.locator('#view-search .search-view')).toHaveAttribute('data-search-partial', 'true');

    playlist.release();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);
    await expect(page.locator('.search-results')).toContainText('Channel 5999');
    await expect(page.locator('.search-loading-more')).toHaveCount(0);
    await expect(page.locator('#view-search .search-view')).toHaveAttribute('data-search-partial', 'false');
  } finally {
    await playlist.close();
  }
});
