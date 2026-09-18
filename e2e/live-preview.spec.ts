import {
  test,
  expect,
  enterTab,
  LIVE_MANIFEST,
  routeLiveManifest,
  routePlaylist,
  type Page,
} from './helpers';
import { THEMES, TEXT_SIZES } from '../src/config/themes';

const CHANNELS = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="ch1" group-title="Group 1",ch1',
  'http://host/ch1.m3u8',
  '#EXTINF:-1 tvg-id="ch2" group-title="Group 1",ch2',
  'http://host/ch2.m3u8',
].join('\n');
const EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  ${[11, 13, 14, 15, 16].map((hour, index) =>
    `<programme channel="ch1" start="20260915${hour}0000 +0000"
      stop="20260915${index === 0 ? 13 : hour + 1}0000 +0000">
      <title>Program ${index + 1}</title></programme>`).join('')}
</tv>`;
const LONG_TITLE = 'Program 1: A long journey across quiet valleys and distant hills';
const LAYOUT_EPG = `<tv>
  <channel id="ch1"><display-name>ch1</display-name></channel>
  <programme channel="ch1" start="20260915231500 +0000" stop="20260916001500 +0000">
    <title>${LONG_TITLE}</title></programme>
  ${[0, 1, 2, 3].map(hour =>
    `<programme channel="ch1" start="202609160${hour}1500 +0000" stop="202609160${hour + 1}1500 +0000">
      <title>Program ${hour + 2}: A long exploration of winding paths beyond the distant hills and valleys</title>
    </programme>`).join('')}
</tv>`;
const PANEL = '#view-channels #live-preview';
const ROW = '#channel-browser .channel-main .channel-item';
const FAVORITE = `${PANEL} [data-preview-action="favorite"]`;
const MUTE = `${PANEL} [data-preview-action="mute"]`;
const FULLSCREEN = `${PANEL} [data-preview-action="fullscreen"]`;

interface MediaProbe {
  video: HTMLMediaElement | null;
  loads: number;
  pauses: number;
  plays: number;
}
type ProbeWindow = Window & { previewProbe: MediaProbe };

test.use({ timezoneId: 'UTC' });

async function setup(
  page: Page,
  options: { enabled?: boolean; stub?: boolean; epg?: boolean | string; now?: string } = {},
): Promise<void> {
  await page.clock.setFixedTime(new Date(options.now || '2026-09-15T12:00:00Z'));
  await routePlaylist(page, CHANNELS);
  await routeLiveManifest(page);
  await page.route('http://host/guide.xml', route => route.fulfill({
    contentType: 'application/xml',
    body: typeof options.epg === 'string' ? options.epg : options.epg ? EPG : '<tv></tv>',
  }));
  await page.addInitScript(({ enabled, stub }) => {
    if (!sessionStorage.getItem('preview-seeded')) {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { id: 'p1', name: 'P1', url: 'http://host/playlist.m3u' },
      ]));
      localStorage.setItem('iptv_epg_url', JSON.stringify('http://host/guide.xml'));
      localStorage.setItem('iptv_tz_mode', JSON.stringify('device'));
      if (enabled !== undefined) localStorage.setItem('iptv_live_preview', JSON.stringify(enabled));
      sessionStorage.setItem('preview-seeded', 'true');
    }
    const probe: MediaProbe = { video: null, loads: 0, pauses: 0, plays: 0 };
    (window as unknown as ProbeWindow).previewProbe = probe;
    const proto = HTMLMediaElement.prototype;
    const nativeLoad = proto.load;
    const nativePause = proto.pause;
    const nativePlay = proto.play;
    let paused = true;
    proto.load = function () {
      probe.video = probe.video || this;
      probe.loads++;
      if (!stub) nativeLoad.call(this);
    };
    proto.pause = function () {
      probe.pauses++;
      paused = true;
      if (!stub) nativePause.call(this);
    };
    proto.play = function () {
      probe.plays++;
      if (!stub) return nativePlay.call(this);
      paused = false;
      Promise.resolve().then(() => {
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('playing'));
      });
      return Promise.resolve();
    };
    if (!stub) return;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true, value: 'Web0S Chrome/53.0',
    });
    Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(proto, 'paused', { configurable: true, get: () => paused });
    // Native Chromium cannot decode the synthetic HLS source; keep its DOM/source real.
    document.addEventListener('error', event => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) event.stopImmediatePropagation();
    }, true);
  }, { enabled: options.enabled, stub: options.stub !== false });
  await page.goto('/');
  await expect(page.locator(ROW)).toHaveCount(2);
}

async function selectFirst(page: Page): Promise<void> {
  await page.locator(ROW).first().click();
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator('#view-player')).toBeHidden();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#video-player')!;
    const probe = (window as unknown as ProbeWindow).previewProbe;
    if (!probe.video) probe.video = video;
    return {
      sameNode: probe.video === video,
      src: video.getAttribute('src'),
      source: video.querySelector('source')?.getAttribute('src') || '',
      loads: probe.loads,
      pauses: probe.pauses,
      plays: probe.plays,
      muted: video.muted,
      currentTime: video.currentTime,
    };
  });
}

async function expectPreviewGeometry(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const slot = document.querySelector('.live-preview-slot')!.getBoundingClientRect();
    const video = document.querySelector('#video-player')!.getBoundingClientRect();
    return Math.max(
      Math.abs(video.x - slot.x), Math.abs(video.y - slot.y),
      Math.abs(video.width - slot.width), Math.abs(video.height - slot.height),
    );
  })).toBeLessThan(3);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('#channel-browser .channel-main .channel-item')!
      .getBoundingClientRect();
    const slot = document.querySelector('.live-preview-slot')!.getBoundingClientRect();
    return { rowRight: row.right, left: slot.left, width: slot.width, height: slot.height };
  });
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.left);
  expect(geometry.width).toBeGreaterThan(200);
  expect(Math.abs(geometry.width / geometry.height - 16 / 9)).toBeLessThan(0.05);
  const controlsInside = await page.locator(`${PANEL} .live-preview-button`).evaluateAll(buttons => {
    return buttons.every(button => {
      const slot = button.closest('.live-preview-slot')!.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return box.left >= slot.left && box.right <= slot.right
        && box.top >= slot.top && box.bottom <= slot.bottom;
    });
  });
  expect(controlsInside).toBe(true);
}

async function stop(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 413, bubbles: true }),
  ));
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

test('default Off retains full-screen playback and stop-on-Back', async ({ page }) => {
  await setup(page);
  await expect(page.locator(PANEL)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('iptv_live_preview'))).toBeNull();
  await page.locator(ROW).first().click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  expect((await snapshot(page)).pauses).toBeGreaterThan(0);
});

test('Settings saves On across reload and Cancel discards Off', async ({ page }) => {
  await setup(page);
  await enterTab(page, 'settings');
  const toggle = '#view-settings #live-preview-setting';
  await page.locator('[data-settings-target="playback"]').click();
  await expect(page.locator('#live-preview')).toHaveCount(1);
  await expect(page.locator(`${toggle} .active`)).toHaveAttribute('data-value', 'off');
  await page.locator(`${toggle} [data-value="on"]`).click();
  expect(await page.evaluate(() => localStorage.getItem('iptv_live_preview'))).toBeNull();
  await page.locator('#save-settings').click();
  expect(await page.evaluate(() => localStorage.getItem('iptv_live_preview'))).toBe('true');
  await page.reload();
  await expect(page.locator(ROW)).toHaveCount(2);
  await selectFirst(page);
  await enterTab(page, 'settings');
  await page.locator('[data-settings-target="playback"]').click();
  await page.locator(`${toggle} [data-value="off"]`).click();
  await page.locator('#cancel-settings').click();
  expect(await page.evaluate(() => localStorage.getItem('iptv_live_preview'))).toBe('true');
  await selectFirst(page);
});

test('row clicks tune preview and retain mute across channel changes', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  const first = await snapshot(page);
  await page.locator(MUTE).click();
  await expect(page.locator(MUTE)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(ROW).nth(1).click();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator('#view-player')).toBeHidden();
  await expect(page.locator(MUTE)).toHaveAttribute('aria-pressed', 'true');
  const second = await snapshot(page);
  expect(second.sameNode).toBe(true);
  expect(second.source).toBe('http://host/ch2.m3u8');
  expect(second.loads - first.loads).toBe(1);
  expect(second.muted).toBe(true);
});

test('selecting the current preview channel again opens full screen', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);

  await page.locator(ROW).first().click();

  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('a second remote OK on the previewed channel opens full screen', async ({ page }) => {
  await setup(page, { enabled: true });

  await page.keyboard.press('Enter');
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator('#view-player')).toBeHidden();

  await page.keyboard.press('Enter');
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('late manifest results from an old selection cannot replace the active preview', async ({ page }) => {
  const epg = `<tv>
    <channel id="ch1"><display-name>ch1</display-name></channel>
    <channel id="ch2"><display-name>ch2</display-name></channel>
    <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
      <title>Program A</title></programme>
    <programme channel="ch2" start="20260915110000 +0000" stop="20260915130000 +0000">
      <title>Program B</title></programme>
  </tv>`;
  await setup(page, { enabled: true, epg });

  let releaseCh1!: () => Promise<void>;
  let releaseCh2!: () => Promise<void>;
  await page.route('http://host/ch1.m3u8', route => new Promise<void>(resolve => {
    releaseCh1 = async () => {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: LIVE_MANIFEST,
      });
      resolve();
    };
  }));
  await page.route('http://host/ch2.m3u8', route => new Promise<void>(resolve => {
    releaseCh2 = async () => {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: LIVE_MANIFEST,
      });
      resolve();
    };
  }));

  const ch1Response = page.waitForResponse('http://host/ch1.m3u8');
  await page.locator(ROW).first().click();
  await expect.poll(() => typeof releaseCh1).toBe('function');
  const ch2Response = page.waitForResponse('http://host/ch2.m3u8');
  await page.locator(ROW).nth(1).click();
  await expect.poll(() => typeof releaseCh2).toBe('function');

  await releaseCh2();
  await ch2Response;
  await releaseCh1();
  await ch1Response;

  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program B');
  await expect(page.locator('#video-player source')).toHaveAttribute('src', 'http://host/ch2.m3u8');
});

test('Back stops the active preview from the list and preview controls', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await expect(page.locator('[data-preview-list-close] .key-back svg')).toBeVisible();
  await expect(page.locator('[data-preview-list-close]')).toContainText('Close');
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);

  await selectFirst(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(MUTE)).toHaveClass(/focused/);
  await expect(page.locator('[data-preview-list-close]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
});

test('mute preserves a cross-day date group and its following program', async ({ page }) => {
  await setup(page, { enabled: true, epg: LAYOUT_EPG, now: '2026-09-15T23:30:00Z' });
  await selectFirst(page);
  const separator = page.locator(`${PANEL} .live-preview-day-separator`);
  const rows = page.locator(`${PANEL} .live-preview-program`);
  const visibleRows = page.locator(`${PANEL} .live-preview-program:visible`);
  await expect(separator).toContainText('09/16');
  await expect(rows).toHaveCount(4);
  await expect(visibleRows).toHaveCount(3);
  await expect(visibleRows.last()).toContainText('Program 4');
  await expect(visibleRows.last()).toHaveClass(/last-visible/);

  await page.locator(MUTE).click();

  await expect(page.locator(MUTE)).toHaveAttribute('aria-pressed', 'true');
  await expect(separator).toBeVisible();
  await expect(separator).toContainText('09/16');
  await expect(rows).toHaveCount(4);
  await expect(visibleRows).toHaveCount(3);
  await expect(visibleRows.last()).toContainText('Program 4');
  await expect(visibleRows.last()).toHaveClass(/last-visible/);
});

test('committed numeric channel entry opens full screen directly', async ({ page }) => {
  await setup(page, { enabled: true });
  await page.keyboard.press('2');
  await expect(page.locator('.number-entry')).not.toHaveClass(/visible/);
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#video-player source')).toHaveAttribute(
    'src',
    'http://host/ch2.m3u8',
  );
});

test('D-pad enters controls and returns to the selected row without stopping', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(MUTE)).toHaveClass(/focused/);
  await expect(page.locator(`${PANEL} .live-preview-legend`)).toContainText('Mute');
  await expect(page.locator('[data-preview-list-open]')).toBeVisible();
  await expect(page.locator('[data-preview-list-controls]')).toBeVisible();
  await expect(page.locator('[data-preview-list-close]')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(FULLSCREEN)).toHaveClass(/focused/);
  await page.locator(FAVORITE).hover();
  await expect(page.locator(FAVORITE)).toHaveClass(/focused/);
  await expect(page.locator(`${PANEL} .live-preview-legend`)).toHaveCount(0);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator(FAVORITE)).toHaveClass(/focused/);
  await expect(page.locator(FAVORITE)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(page.locator(FAVORITE)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(FULLSCREEN)).toHaveClass(/focused/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(MUTE)).toHaveClass(/focused/);
  const before = await snapshot(page);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch1');
  await expect(page.locator('[data-preview-list-open]')).toBeVisible();
  await expect(page.locator('[data-preview-list-controls]')).toBeVisible();
  await expect(page.locator('[data-preview-list-close]')).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(`${ROW}.focused`)).toContainText('ch1');
});

test('entering channel edit mode closes the active preview', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 405, bubbles: true }),
  ));
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  await expect(page.locator('.channel-view')).toHaveClass(/editing/);
  await expect(page.locator('.preview-list-hints')).toHaveCount(0);
});

test('entering favorite management closes the active preview', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.evaluate(() => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: 404, bubbles: true }),
  ));
  await page.locator('[data-group="builtin:favorites"]').click();
  await page.locator('[data-favorite-manage]').click();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  await expect(page.locator('.favorite-hints')).toBeVisible();
  await expect(page.locator('.preview-list-hints')).toHaveCount(0);
});

test('preview controls stay transparent until focused and reuse focus tokens', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.mouse.move(0, 0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(MUTE)).toHaveClass(/focused/);
  await expect.poll(() => page.locator(MUTE).evaluate(element =>
    getComputedStyle(element).backgroundColor,
  )).not.toBe('rgba(0, 0, 0, 0)');
  await expect.poll(() => page.locator(MUTE).evaluate(element => {
    const probe = document.createElement('span');
    probe.style.border = '1px solid var(--focus-ring)';
    document.body.appendChild(probe);
    const settled = getComputedStyle(element).borderColor
      === getComputedStyle(probe).borderColor;
    probe.remove();
    return settled;
  })).toBe(true);
  const styles = async () => page.locator(PANEL).evaluate(panel => {
    const root = getComputedStyle(document.documentElement);
    const focusProbe = document.createElement('span');
    focusProbe.style.border = '1px solid var(--focus-ring)';
    document.body.appendChild(focusProbe);
    const focusRing = getComputedStyle(focusProbe).borderColor;
    focusProbe.remove();
    const controls = getComputedStyle(panel.querySelector('.live-preview-controls')!);
    const badge = getComputedStyle(panel.querySelector('.live-preview-badge')!);
    const buttonElement = panel.querySelector('.live-preview-button.focused')!;
    const button = getComputedStyle(buttonElement);
    const idleButton = getComputedStyle(
      panel.querySelector('.live-preview-button:not(.focused)')!,
    );
    const icon = getComputedStyle(buttonElement.querySelector('svg')!);
    return {
      controlsBackground: controls.backgroundColor,
      buttonBackground: button.backgroundColor,
      buttonBorder: button.borderColor,
      focusRing,
      idleButtonBackground: idleButton.backgroundColor,
      badgeRadius: badge.borderRadius,
      buttonRadius: button.borderRadius,
      appRadius: root.getPropertyValue('--radius').trim(),
      iconFilter: icon.filter,
    };
  });
  const dark = await styles();
  expect(dark.controlsBackground).toBe('rgba(0, 0, 0, 0)');
  expect(dark.buttonBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(dark.idleButtonBackground).toBe('rgba(0, 0, 0, 0)');
  expect(dark.buttonBackground).not.toBe(dark.idleButtonBackground);
  expect(dark.buttonBorder).toBe(dark.focusRing);
  expect(parseFloat(dark.badgeRadius)).toBeGreaterThan(parseFloat(dark.buttonRadius));
  expect(dark.buttonRadius).toBe(dark.appRadius);
  expect(dark.iconFilter).not.toBe('none');

  await page.evaluate(() => { document.documentElement.dataset.overlay = 'frosted'; });
  const frosted = await styles();
  expect(frosted.controlsBackground).toBe('rgba(0, 0, 0, 0)');
  expect(frosted.buttonBackground).toBe(dark.buttonBackground);
  expect(frosted.idleButtonBackground).toBe(dark.idleButtonBackground);
});

test('expand restores audio while preserving video identity, source, time and loading counters', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.locator(MUTE).click();
  await expectPreviewGeometry(page);
  await page.locator('#video-player').evaluate(video => {
    let position = 37;
    Object.defineProperty(video, 'currentTime', {
      configurable: true, get: () => position, set: (value: number) => { position = value; },
    });
  });
  const before = await snapshot(page);
  expect(before.muted).toBe(true);
  await page.locator(FULLSCREEN).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await expect.poll(() => page.locator('#video-player').evaluate(
    video => video.getBoundingClientRect().width,
  )).toBe(1920);
  const expanded = await snapshot(page);
  expect(expanded).toEqual({ ...before, muted: false });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#player-sidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player-sidebar')).toBeHidden();
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await snapshot(page)).toEqual(expanded);
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(expanded);

  await page.locator('.live-preview-slot').click({ position: { x: 30, y: 80 } });
  await expect(page.locator('#view-player')).toBeVisible();
  expect(await snapshot(page)).toEqual(expanded);
});

test('selecting the active Live tab keeps an existing preview session', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  const before = await snapshot(page);
  await enterTab(page, 'live');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(before);
});

test('real desktop MSE attachment survives expand and minimize without reload', async ({ page }) => {
  await setup(page, { enabled: true, stub: false });
  await selectFirst(page);
  await expect.poll(() => page.locator('#video-player').getAttribute('src')).toMatch(/^blob:/);
  await expect.poll(async () => (await snapshot(page)).plays).toBeGreaterThan(0);
  const before = await snapshot(page);
  await page.locator(FULLSCREEN).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(before);
});

test('complete future rows fit every theme and text scale without touching the footer', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, { enabled: true, epg: LAYOUT_EPG, now: '2026-09-15T23:30:00Z' });
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText(LONG_TITLE);
  await expect(page.locator(`${PANEL} .live-preview-time-range`))
    .toHaveText('23:15–00:15');
  await expect(page.locator(`${PANEL} .live-preview-day-separator`)).toContainText('09/16');
  await expect(page.locator(`${PANEL} .live-preview-program time`).first())
    .toHaveText('00:15–01:15');
  const sizes = TEXT_SIZES.filter(size => Number(size) >= 100);
  for (const theme of THEMES) {
    for (const size of sizes) {
      await test.step(`${theme.id} at ${size}%`, async () => {
        // ThemeService applies these same root attributes; clicking mute rerenders and refits the panel.
        await page.evaluate(({ themeId, textSize }) => {
          document.documentElement.dataset.theme = themeId;
          document.documentElement.dataset.textSize = textSize;
        }, { themeId: theme.id, textSize: size });
        await page.locator(MUTE).click();
        await expectPreviewGeometry(page);
        const layout = await page.locator(PANEL).evaluate(panel => {
          const details = panel.querySelector('.live-preview-details')!.getBoundingClientRect();
          const title = panel.querySelector('.live-preview-title')!;
          const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
          const rows = Array.from(panel.querySelectorAll<HTMLElement>('.live-preview-program'))
            .filter(row => row.getBoundingClientRect().height > 0);
          return {
            titleLines: title.getBoundingClientRect().height / lineHeight,
            count: rows.length,
            rows: rows.map(row => {
              const box = row.getBoundingClientRect();
              return {
                insideDetails: box.top >= details.top && box.bottom <= details.bottom + 0.5,
                top: box.top,
                completeHeight: box.height,
                children: Array.from(row.children).map(child => {
                  const content = child.getBoundingClientRect();
                  return { top: content.top, bottom: content.bottom };
                }),
              };
            }),
          };
        });
        expect(layout.titleLines).toBeGreaterThanOrEqual(1.9);
        expect(layout.titleLines).toBeLessThanOrEqual(2.1);
        expect(layout.count).toBeLessThanOrEqual(3);
        if (size === '100') expect(layout.count).toBeGreaterThan(0);
        for (const row of layout.rows) {
          expect(row.insideDetails).toBe(true);
          expect(row.completeHeight).toBeGreaterThanOrEqual(68);
          expect(
            row.children.every(child =>
              child.top >= row.top - 0.5
              && child.bottom <= row.top + row.completeHeight + 0.5),
            JSON.stringify(row),
          ).toBe(true);
        }
      });
    }
  }
});

test('keeps long cross-midnight EPG aligned at default and large text sizes', async ({ page }) => {
  await setup(page, {
    enabled: true,
    epg: LAYOUT_EPG,
    now: '2026-09-15T23:30:00Z',
  });
  await expect(page.locator(ROW).first()).toContainText(LONG_TITLE);
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-message`)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expectPreviewGeometry(page);

  await page.evaluate(() => { document.documentElement.dataset.textSize = '150'; });
  await page.locator(MUTE).click();
  await page.mouse.move(0, 0);
  await expectPreviewGeometry(page);
  await expect.poll(() => page.locator('#video-player').evaluate((video: HTMLVideoElement) =>
    getComputedStyle(video).zIndex,
  )).toBe('1');
});

test('waiting or a failed manifest retains the preview slot and channel identity', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  const before = await page.locator('.live-preview-slot').boundingBox();
  await page.locator('#video-player').evaluate(video => video.dispatchEvent(new Event('waiting')));
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await page.locator('.live-preview-slot').boundingBox()).toEqual(before);
  await page.route('http://host/ch2.m3u8', route => route.fulfill({ status: 503, body: '' }));
  await page.locator(ROW).nth(1).click();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch2');
  await expectPreviewGeometry(page);
  expect(await page.locator('.live-preview-slot').boundingBox()).toEqual(before);
});

test('EPG shows current program, up to four future rows, and favorite action', async ({ page }) => {
  await setup(page, { enabled: true, epg: true });
  await expect(page.locator(ROW).first()).toContainText('Program 1');
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
  await expect(page.locator(`${PANEL} .live-preview-time-range`)).toHaveText('11:00–13:00');
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(4);
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveText([
    /13:00–14:00.*Program 2/s,
    /14:00–15:00.*Program 3/s,
    /15:00–16:00.*Program 4/s,
    /16:00–17:00.*Program 5/s,
  ]);
  await expect(page.locator(`${PANEL} .live-preview-remaining`)).toHaveText('60 min left');
  await expect(page.locator(`${PANEL} .live-preview-badge`)).toContainText('LIVE');
  await expect(page.locator(FAVORITE)).toHaveAttribute('aria-pressed', 'false');
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const slot = box('.live-preview-slot');
    const badge = box('.live-preview-badge');
    const favorite = box('.live-preview-favorite');
    const channel = box('.live-preview-channel');
    return {
      badgeLeft: badge.left - slot.left, badgeTop: badge.top - slot.top,
      favoriteAbove: favorite.bottom <= slot.top, headerGap: favorite.left - channel.right,
    };
  });
  expect(geometry.badgeLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.badgeLeft).toBeLessThan(60);
  expect(geometry.badgeTop).toBeGreaterThanOrEqual(0);
  expect(geometry.badgeTop).toBeLessThan(60);
  expect(geometry.favoriteAbove).toBe(true);
  expect(geometry.headerGap).toBeGreaterThanOrEqual(0);
  await page.locator(ROW).nth(1).click();
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveCount(0);
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(0);
});

test('Stop removes preview and section returns do not restart it', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.keyboard.press('ArrowRight');
  await stop(page);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(`${ROW}.focused`)).toHaveCount(1);
  await selectFirst(page);
  await enterTab(page, 'epg');
  await expect(page.locator('#view-epg')).toBeVisible();
  const stopped = await snapshot(page);
  expect(stopped.source).toBe('');
  await enterTab(page, 'live');
  await expect(page.locator(PANEL)).toBeHidden();
  expect(await snapshot(page)).toMatchObject({
    sameNode: true, source: '', src: null, plays: stopped.plays,
  });
  await selectFirst(page);
  await enterTab(page, 'settings');
  await page.locator('#cancel-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('a current program without a following schedule has one concise empty state', async ({ page }) => {
  await setup(page, {
    enabled: true,
    epg: `<tv><channel id="ch1"><display-name>ch1</display-name></channel>
      <programme channel="ch1" start="20260915110000 +0000" stop="20260915130000 +0000">
        <title>Program 1</title></programme></tv>`,
  });
  await expect(page.locator(ROW).first()).toContainText('Program 1');
  await selectFirst(page);
  await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
  await expect(page.locator(`${PANEL} .live-preview-program`)).toHaveCount(0);
  await expect(page.locator(`${PANEL} .live-preview-empty`)).toHaveText('No upcoming programs');
  await expectPreviewGeometry(page);
});

test('background resume restores preview presentation and mute through the normal lifecycle', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await page.locator(MUTE).click();
  await setHidden(page, true);
  await setHidden(page, false);
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(`${PANEL} .live-preview-channel`)).toHaveText('ch1');
  await expect(page.locator(MUTE)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#view-player')).toBeHidden();
  await expectPreviewGeometry(page);
  expect((await snapshot(page)).source).toBe('http://host/ch1.m3u8');
});

test('a preference disabled while backgrounded prevents preview playback resuming', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await setHidden(page, true);
  await page.evaluate(() => localStorage.setItem('iptv_live_preview', 'false'));
  const suspended = await snapshot(page);
  await setHidden(page, false);
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  expect(await snapshot(page)).toMatchObject({ source: '', src: null, plays: suspended.plays });
});

test('disabling the playing source in Settings leaves no preview or stale controls', async ({ page }) => {
  await setup(page, { enabled: true });
  await selectFirst(page);
  await enterTab(page, 'settings');
  await page.locator('#playlist-entries .source-toggle').click();
  await page.locator('#save-settings').click();
  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator(PANEL)).toBeHidden();
  await expect(page.locator(ROW)).toHaveCount(0);
  await expect(page.locator('#view-channels')).not.toHaveClass(/has-live-preview/);
  await expect(page.locator(`${PANEL} .focused`)).toHaveCount(0);
  expect((await snapshot(page)).source).toBe('');
});

test.describe('display timezone', () => {
  test.use({ timezoneId: 'Etc/GMT-2' });

  test('future times follow device or feed time without changing current EPG', async ({ page }) => {
    await setup(page, { enabled: true, epg: true });
    await expect(page.locator(ROW).first()).toContainText('Program 1');
    await selectFirst(page);
    await expect(page.locator(`${PANEL} .live-preview-program time`).first())
      .toHaveText('15:00–16:00');
    await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
    await expectPreviewGeometry(page);

    await enterTab(page, 'settings');
    await page.locator('#tz-mode [data-value="feed"]').click();
    await page.locator('#save-settings').click();
    await selectFirst(page);
    await expect(page.locator(`${PANEL} .live-preview-program time`).first())
      .toHaveText('13:00–14:00');
    await expect(page.locator(`${PANEL} .live-preview-title`)).toHaveText('Program 1');
    await expect(page.locator(`${PANEL} .live-preview-remaining`)).toHaveText('60 min left');
    await expectPreviewGeometry(page);
  });
});

test('reduced motion preserves geometry and continuity', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page, { enabled: true });
  await selectFirst(page);
  await expectPreviewGeometry(page);
  const before = await snapshot(page);
  await page.locator(FULLSCREEN).click();
  await expect(page.locator('#view-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeVisible();
  await expectPreviewGeometry(page);
  expect(await snapshot(page)).toEqual(before);
});
