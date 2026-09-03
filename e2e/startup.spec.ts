import {
  test,
  expect,
  routePlaylist,
  seedPlaylist,
  SAMPLE_M3U,
  type Page,
} from './helpers';

interface StartupProbe {
  starts: number;
  loadingAtStart: boolean[];
  subscriptions: number;
  subscriptionCancellations: number;
  activities: Array<{ name: string; method: string; replace: boolean }>;
}

async function installStartupHarness(
  page: Page,
  options: { visibility?: DocumentVisibilityState; devMode?: boolean } = {},
): Promise<void> {
  await page.route('http://127.0.0.1:9999/setup-state', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"updated":true}' }));
  await page.addInitScript(({ initialVisibility, devMode }) => {
    type Cb = (resp: unknown) => void;
    type LunaParameters = {
      activity?: { name?: string; callback?: { method?: string } };
      replace?: boolean;
    };
    const probe: StartupProbe = {
      starts: 0,
      loadingAtStart: [],
      subscriptions: 0,
      subscriptionCancellations: 0,
      activities: [],
    };
    const pendingStarts: Cb[] = [];
    let visibility = initialVisibility;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });

    const win = window as unknown as {
      __startupProbe__?: StartupProbe;
      __releaseServiceStart__?: () => void;
      __showApp__?: () => void;
      __hideApp__?: () => void;
      PalmServiceBridge?: unknown;
    };
    win.__startupProbe__ = probe;
    win.__releaseServiceStart__ = () => {
      for (const callback of pendingStarts.splice(0)) {
        callback({ running: true, port: 9999 });
      }
    };
    win.__showApp__ = () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    win.__hideApp__ = () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    };
    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private subscription = false;
      private cancelled = false;

      private respond(response: unknown): void {
        setTimeout(() => {
          if (!this.cancelled) this.onservicecallback?.(JSON.stringify(response));
        }, 0);
      }

      call(uri: string, payload: string): void {
        const method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as LunaParameters;
        this.subscription = method === 'serviceEvents';
        if (method === 'start') {
          probe.starts++;
          const loading = document.querySelector<HTMLElement>('#view-loading');
          probe.loadingAtStart.push(loading !== null
            && loading.style.display !== 'none'
            && !loading.classList.contains('hidden'));
          pendingStarts.push((response) => this.respond(response));
        } else if (method === 'serviceEvents') {
          probe.subscriptions++;
          this.respond({ subscribed: true });
        } else if (method === 'getDevMode') {
          this.respond({ devmode: devMode });
        } else if (method === 'create') {
          const activity = parameters.activity;
          probe.activities.push({
            name: activity?.name ?? '',
            method: activity?.callback?.method ?? '',
            replace: parameters.replace === true,
          });
          this.respond({ returnValue: true });
        } else if (method !== 'stop') {
          this.respond({ returnValue: false, errorText: `unmocked method: ${method}` });
        }
      }

      cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        if (this.subscription) probe.subscriptionCancellations++;
      }
    }
    win.PalmServiceBridge = FakePalmServiceBridge;
  }, {
    initialVisibility: options.visibility ?? 'visible',
    devMode: options.devMode ?? false,
  });
}

async function releaseServiceStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __releaseServiceStart__: () => void })
      .__releaseServiceStart__();
  });
}

async function startupProbe(page: Page): Promise<StartupProbe> {
  return page.evaluate(() =>
    (window as unknown as { __startupProbe__: StartupProbe }).__startupProbe__);
}

test('channels render while service startup is pending without duplicate work', async ({ page }) => {
  let uploadLists = 0;
  await page.route('http://127.0.0.1:9999/uploads', (route) => {
    uploadLists++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page, { visibility: 'hidden' });

  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();
  expect(await startupProbe(page)).toMatchObject({
    starts: 1,
    loadingAtStart: [false],
    subscriptions: 0,
  });

  await page.evaluate(() => {
    (window as unknown as { __showApp__: () => void }).__showApp__();
  });
  expect(await startupProbe(page)).toMatchObject({ starts: 1, subscriptions: 0 });

  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(1);
  await expect.poll(() => uploadLists).toBe(1);
  await page.waitForTimeout(250);
  expect(await startupProbe(page)).toMatchObject({ starts: 1, subscriptions: 1 });
  expect(uploadLists).toBe(1);
});

test('service event subscription is replaced across background restarts', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await routePlaylist(page);
  await seedPlaylist(page);
  await installStartupHarness(page);

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).starts).toBe(1);
  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __hideApp__: () => void }).__hideApp__();
  });
  await expect.poll(async () =>
    (await startupProbe(page)).subscriptionCancellations).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __showApp__: () => void }).__showApp__();
  });
  await expect.poll(async () => (await startupProbe(page)).starts).toBe(2);
  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).subscriptions).toBe(2);
  expect(await startupProbe(page)).toMatchObject({
    subscriptionCancellations: 1,
  });
});

test('uploaded-only startup enters channels after background reconciliation', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 'ch1',
        name: 'Playlist 1',
        count: 2,
        createdAt: 1,
        url: 'http://127.0.0.1:9999/uploads/ch1.m3u',
      }]),
    }));
  await page.route('http://127.0.0.1:9999/uploads/ch1.m3u', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: SAMPLE_M3U,
    }));
  await installStartupHarness(page);

  await page.goto('/');
  await expect(page.locator('#view-settings')).toBeVisible();
  await releaseServiceStart(page);

  await expect(page.locator('#view-channels')).toBeVisible();
  await expect(page.locator('.channel-item')).toHaveCount(2);
});

test('dev-mode query replaces the reminder fallback activity', async ({ page }) => {
  await page.route('http://127.0.0.1:9999/uploads', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem('iptv_reminders', JSON.stringify([{
      channelKey: '8a9c7c8b',
      channelName: 'Alpha',
      title: 'Bravo',
      startMs: now + 60000,
      stopMs: now + 120000,
    }]));
  });
  await installStartupHarness(page, { devMode: true });

  await page.goto('/');
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(1);
  expect((await startupProbe(page)).activities[0].method)
    .toBe('luna://com.webos.notification/createToast');

  await releaseServiceStart(page);
  await expect.poll(async () => (await startupProbe(page)).activities.length).toBe(2);
  const [fallback, devAlert] = (await startupProbe(page)).activities;
  expect(devAlert.name).toBe(fallback.name);
  expect(fallback.replace).toBe(true);
  expect(devAlert.replace).toBe(true);
  expect(devAlert.method).toBe('luna://com.lennylxx.iptv.service/fireReminderAlert');
});
