import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, routeLiveManifest, seedPlaylist, type Page } from './helpers';

// A large playlist shows its first channels while the rest still downloads,
// and the remote works on them from the start.

const HEAD_CHANNELS = 3000;
const TOTAL_CHANNELS = 6000;

function channelLines(from: number, to: number): string {
  let text = '';
  for (let i = from; i < to; i++) {
    text += `#EXTINF:-1 tvg-id="ch${i}" group-title="Group ${i % 7}",Channel ${i}\n`
      + `http://streams.example.com/ch${i}.m3u8\n`;
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
  close: () => Promise<void>;
}

// Sends the head of the playlist with the full Content-Length, then holds the
// tail until release().
async function serveHeldPlaylist(header = '#EXTM3U'): Promise<HeldPlaylist> {
  const head = Buffer.from(header + '\n' + channelLines(0, HEAD_CHANNELS));
  const tail = Buffer.from(channelLines(HEAD_CHANNELS, TOTAL_CHANNELS));
  let release!: () => void;
  const released = new Promise<void>(resolve => (release = resolve));
  const held: Array<() => void> = [];
  let silent = false;
  const server = http.createServer((_req, res) => {
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
    await expect(page.locator('#view-loading')).toBeHidden();
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
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
  try {
    await seedPlaylist(page, playlist.url);
    await page.goto('/');

    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(1);
    playlist.silenceNext();
    await page.locator('.tab-bar-item[data-section="settings"]').click();
    await page.locator('#refresh-data').click();
    await expect.poll(playlist.requests).toBe(2);
    await expect(page.locator('.tab-bar-progress.active')).toHaveCount(0);

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
