// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertM3USearchBenchmark,
  waitForPlaylistLoaded,
  waitForStartupSettled,
} from './benchmark-suite.mjs';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('waitForPlaylistLoaded', () => {
  const showRow = () => {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="view-channels"><div class="channel-main"><div class="channel-item"></div></div></div>');
  };

  it('waits for the tab bar progress to end after the first row shows', async () => {
    showRow();
    document.body.insertAdjacentHTML('beforeend', '<div class="tab-bar-progress active"></div>');
    let loaded = false;
    const waiting = waitForPlaylistLoaded({ timeoutMs: 2000 }).then(() => { loaded = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(loaded).toBe(false);
    document.querySelector('.tab-bar-progress').classList.remove('active');
    await waiting;
    expect(loaded).toBe(true);
  });

  it('resolves at the first row for a build without a progress bar', async () => {
    showRow();
    await expect(waitForPlaylistLoaded({ timeoutMs: 200 })).resolves.toBeUndefined();
  });

  it('does not count a hidden Live view as loaded', async () => {
    showRow();
    document.getElementById('view-channels').classList.add('hidden');
    await expect(waitForPlaylistLoaded({ timeoutMs: 100 })).rejects.toThrow('Timed out');
  });
});

describe('waitForStartupSettled', () => {
  it('waits out a long task that starts after it begins and reports it', async () => {
    const pending = [];
    vi.stubGlobal('PerformanceObserver', class {
      observe() {}
      disconnect() {}
      takeRecords() { return pending.splice(0); }
    });
    const settling = waitForStartupSettled({ quietMs: 150, timeoutMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    const at = performance.now();
    pending.push({ startTime: at, duration: 120 });
    const report = await settling;
    expect(performance.now()).toBeGreaterThanOrEqual(at + 120 + 150);
    expect(report.maxLongTaskMs).toBe(120);
    expect(report.longTaskTotalMs).toBe(120);
    vi.unstubAllGlobals();
  });
});

describe('assertM3USearchBenchmark', () => {
  const report = warm => ({
    indexBuild: { workerStarted: true, built: 2 },
    indexBuildWarm: { workerStarted: true, ...warm },
    renderedPrograms: 5,
    renderedCatalogSections: 0,
    sparseSearch: { channels: 1, programs: 1 },
  });

  it('only warns on the TV when a warm open rebuilt an unstored index', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rebuilt = report({ built: 1, storedIndexes: 1 });
    expect(() => assertM3USearchBenchmark(rebuilt)).toThrow('M3U warm Search open built 1 of 1');
    expect(() => assertM3USearchBenchmark(rebuilt, { tvQuirks: true })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('built 1 of 1 stored indexes'));
    expect(() => assertM3USearchBenchmark(
      report({ workerStarted: false, built: 0, storedIndexes: 1 }),
      { tvQuirks: true },
    )).toThrow('warm Search open');
  });
});
