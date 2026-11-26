// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { openYoutubeTrailer, resetYoutubeStatusForTests, youtubeReady, YOUTUBE_APP_ID } from './youtube-trailer';

interface Call { method: string; parameters: Record<string, unknown> }

let calls: Call[];
let answer: (method: string) => Record<string, unknown>;

function installBridge(): void {
  class FakePalmServiceBridge {
    onservicecallback: ((message: string) => void) | null = null;
    call(uri: string, payload: string): void {
      const method = uri.slice(uri.lastIndexOf('/') + 1);
      calls.push({ method, parameters: JSON.parse(payload) as Record<string, unknown> });
      const response = answer(method);
      if (response.throws) throw new Error('bridge call failed');
      if (response.silent) return;
      setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
    }
    cancel(): void {}
  }
  Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: FakePalmServiceBridge });
}

// The bridge answers on one task and the callbacks run on the next.
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('YouTube trailers', () => {
  beforeEach(() => {
    calls = [];
    answer = () => ({ returnValue: true, exist: true });
    resetYoutubeStatusForTests();
  });

  afterEach(() => {
    delete (window as { PalmServiceBridge?: unknown }).PalmServiceBridge;
    vi.restoreAllMocks();
  });

  it('opens a browser tab off webOS', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(youtubeReady(vi.fn())).toBe(true);
    openYoutubeTrailer('abcDEF12_-z', vi.fn());
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abcDEF12_-z', '_blank');
  });

  it('asks the app manager once, then reports the answer', async () => {
    installBridge();
    const settled = vi.fn<() => void>();
    expect(youtubeReady(settled)).toBe(false);
    expect(youtubeReady(settled)).toBe(false);
    await settle();
    expect(calls).toEqual([{ method: 'getAppLoadStatus', parameters: { appId: YOUTUBE_APP_ID } }]);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(youtubeReady(settled)).toBe(true);
  });

  it('hides the trailer when YouTube is missing, and asks again once the app is shown', async () => {
    installBridge();
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    answer = () => ({ returnValue: true, exist: false });
    youtubeReady(vi.fn());
    await settle();
    expect(youtubeReady(vi.fn())).toBe(false);
    expect(info.mock.calls.flat().join(' ')).toContain('event=trailer.youtube');

    answer = () => ({ returnValue: true, exist: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const settled = vi.fn<() => void>();
    expect(youtubeReady(settled)).toBe(false);
    await settle();
    expect(settled).toHaveBeenCalled();
    expect(youtubeReady(vi.fn())).toBe(true);
  });

  it('keeps showing an installed YouTube after the app is shown again', async () => {
    installBridge();
    youtubeReady(vi.fn());
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(youtubeReady(vi.fn())).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('shows the trailer when the check fails, leaving a missing app to the launch', async () => {
    installBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = () => ({ returnValue: false, errorCode: -1, errorText: 'Denied method call' });
    const settled = vi.fn<() => void>();
    youtubeReady(settled);
    await settle();
    expect(settled).toHaveBeenCalled();
    expect(youtubeReady(vi.fn())).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toContain('event=trailer.youtube error=-1');
  });

  it('shows the trailer when the check fails at once, inside the render that asked', async () => {
    installBridge();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = () => ({ throws: true });
    const settled = vi.fn<() => void>();
    expect(youtubeReady(settled)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    await settle();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('shows the trailer when the check never answers', async () => {
    vi.useFakeTimers();
    try {
      installBridge();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      answer = () => ({ silent: true });
      const settled = vi.fn<() => void>();
      expect(youtubeReady(settled)).toBe(false);
      vi.advanceTimersByTime(CONFIG.XTREAM.YOUTUBE_CHECK_TIMEOUT_MS + 1);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(youtubeReady(vi.fn())).toBe(true);
      expect(warn.mock.calls.flat().join(' ')).toContain('event=trailer.youtube error=timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the trailer when an answer arrives after the timeout', () => {
    vi.useFakeTimers();
    try {
      let late: ((message: string) => void) | null = null;
      class SlowPalmServiceBridge {
        onservicecallback: ((message: string) => void) | null = null;
        call(): void { late = (message) => this.onservicecallback?.(message); }
        cancel(): void { this.onservicecallback = null; }
      }
      Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: SlowPalmServiceBridge });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      youtubeReady(vi.fn());
      vi.advanceTimersByTime(CONFIG.XTREAM.YOUTUBE_CHECK_TIMEOUT_MS + 1);
      expect(youtubeReady(vi.fn())).toBe(true);
      late!(JSON.stringify({ returnValue: true, exist: false }));
      vi.runAllTimers();
      expect(youtubeReady(vi.fn())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

    it('launches YouTube on the trailer', async () => {
    installBridge();
    const failed = vi.fn<() => void>();
    openYoutubeTrailer('abcDEF12_-z', failed);
    await settle();
    expect(calls).toEqual([{ method: 'launch', parameters: {
      id: YOUTUBE_APP_ID, params: { contentTarget: 'https://www.youtube.com/tv?v=abcDEF12_-z' },
    } }]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('reports a failed launch and stops offering YouTube when it is gone', async () => {
    installBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    youtubeReady(vi.fn());
    await settle();
    answer = () => ({ returnValue: false, errorCode: -101, errorText: 'The app was not found' });
    const failed = vi.fn<() => void>();
    openYoutubeTrailer('abcDEF12_-z', failed);
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('event=trailer.launch error=-101');
    expect(youtubeReady(vi.fn())).toBe(false);
  });
});
