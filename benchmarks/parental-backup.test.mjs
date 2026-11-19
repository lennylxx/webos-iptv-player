// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupBenchmarkFixture,
  clearParentalConfig,
  installBenchmarkFixture,
  rebuildBenchmarkDatabase,
} from './benchmark-suite.mjs';

const fixture = {
  scale: 50,
  accountId: 'a1',
  epgUrl: 'http://host/epg',
  backupKey: 'backup',
};

function withStore(run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('iptv', 5);
    open.onupgradeneeded = () => open.result.createObjectStore('parental-control', { keyPath: 'key' });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('parental-control', 'readwrite');
      const request = run(tx.objectStore('parental-control'));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const readConfig = () => withStore(store => store.get('config'));
const readBackup = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('iptv');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('user-meta').objectStore('user-meta').get(fixture.backupKey);
    request.onsuccess = () => {
      open.result.close();
      resolve(request.result);
    };
  };
});
const writeConfig = value => withStore(store => store.put({ key: 'config', value }));

describe('TV benchmark parental backup', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    localStorage.clear();
    await rebuildBenchmarkDatabase();
    await withStore(store => store.count());
  });

  it('keeps the device PIN out of the run and restores it in a later cleanup', async () => {
    await writeConfig({ pin: 'p1' });
    await installBenchmarkFixture(fixture);
    expect(await readConfig()).toBeUndefined();

    // Interrupted while the benchmark PIN is set; a fresh process cleans up.
    await writeConfig({ pin: 'benchmark' });
    expect(await cleanupBenchmarkFixture(fixture)).toEqual({ restored: true });
    expect(await readConfig()).toEqual({ key: 'config', value: { pin: 'p1' } });
  });

  it('leaves no benchmark PIN on a device that had none', async () => {
    await installBenchmarkFixture(fixture);
    await writeConfig({ pin: 'benchmark' });
    await clearParentalConfig();
    expect(await readConfig()).toBeUndefined();
    await writeConfig({ pin: 'benchmark' });
    await cleanupBenchmarkFixture(fixture);
    expect(await readConfig()).toBeUndefined();
  });

  it('seeds a chunked playlist cache and restores the device chunks', async () => {
    const playlist = run => new Promise((resolve, reject) => {
      const open = indexedDB.open('iptv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('playlist-cache', 'readwrite');
        const request = run(tx.objectStore('playlist-cache'));
        tx.oncomplete = () => {
          open.result.close();
          resolve(request.result);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    // More chunks on the device than the fixture writes: none may linger.
    const device = [{ name: 'ch1', url: 'http://host/a' }];
    const deviceTail = [{ name: 'ch2', url: 'http://host/b' }];
    await playlist(store => store.put({ key: 'combined-v5#000000', timestamp: 1, channels: device }));
    await playlist(store => store.put({ key: 'combined-v5#000001', timestamp: 1, channels: deviceTail }));
    await playlist(store => store.put({
      key: 'combined-v5',
      timestamp: 1,
      data: { chunkCount: 2, channelCount: 2 },
    }));

    await installBenchmarkFixture(fixture);
    const head = await playlist(store => store.get('combined-v5'));
    expect(head.data).toMatchObject({ chunkCount: 1, channelCount: fixture.scale });
    expect(head.data.channels).toBeUndefined();
    const chunk = await playlist(store => store.get('combined-v5#000000'));
    expect(chunk.timestamp).toBe(head.timestamp);
    expect(chunk.channels).toHaveLength(fixture.scale);
    expect(chunk.channels[0].url).toBe('http://host/a');
    expect(await playlist(store => store.get('combined-v5#000001'))).toBeUndefined();

    await cleanupBenchmarkFixture(fixture);
    expect((await playlist(store => store.get('combined-v5'))).data.channelCount).toBe(2);
    expect(await playlist(store => store.get('combined-v5#000000')))
      .toEqual({ key: 'combined-v5#000000', timestamp: 1, channels: device });
    expect(await playlist(store => store.get('combined-v5#000001')))
      .toEqual({ key: 'combined-v5#000001', timestamp: 1, channels: deviceTail });
  });

  afterEach(() => vi.restoreAllMocks());

  it('never loses an app write that lands while the record is backed up', async () => {
    await writeConfig({ pin: 'p1' });
    const app = await new Promise((resolve) => {
      const open = indexedDB.open('iptv');
      open.onsuccess = () => resolve(open.result);
    });
    let competing = null;
    const get = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (key) {
      const request = get.call(this, key);
      if (this.name === 'parental-control' && !competing) {
        // The running app persists a change right after the harness reads.
        request.addEventListener('success', () => {
          const tx = app.transaction('parental-control', 'readwrite');
          tx.objectStore('parental-control').put({ key: 'config', value: { pin: 'p2' } });
          competing = new Promise((resolve) => { tx.oncomplete = resolve; });
        });
      }
      return request;
    });
    await installBenchmarkFixture(fixture);
    await competing;
    vi.restoreAllMocks();
    app.close();

    const live = (await readConfig())?.value;
    const saved = (await readBackup()).data.parentalConfig?.value;
    expect([live, saved]).toContainEqual({ pin: 'p2' });
  });

  it('refuses to overwrite a pending backup', async () => {
    await writeConfig({ pin: 'p1' });
    await installBenchmarkFixture(fixture);
    await expect(installBenchmarkFixture(fixture)).rejects.toThrow(/interrupted/);
    await cleanupBenchmarkFixture(fixture);
    expect(await readConfig()).toEqual({ key: 'config', value: { pin: 'p1' } });
  });

  it('keeps the device PIN when two installs race', async () => {
    await writeConfig({ pin: 'p1' });
    const results = await Promise.allSettled([
      installBenchmarkFixture(fixture),
      installBenchmarkFixture(fixture),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    await cleanupBenchmarkFixture(fixture);
    expect(await readConfig()).toEqual({ key: 'config', value: { pin: 'p1' } });
  });
});
