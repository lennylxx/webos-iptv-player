// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchManifestViaService } from './manifest-service';

interface BridgeCall {
  uri: string;
  payload: Record<string, unknown>;
  reply: (response: Record<string, unknown>) => void;
}

function installBridge(): { calls: BridgeCall[]; cancels: () => number } {
  const calls: BridgeCall[] = [];
  let cancels = 0;
  class FakePalmServiceBridge {
    onservicecallback: ((message: string) => void) | null = null;
    call(uri: string, payload: string): void {
      calls.push({
        uri,
        payload: JSON.parse(payload) as Record<string, unknown>,
        reply: response => this.onservicecallback?.(JSON.stringify(response)),
      });
    }
    cancel(): void {
      cancels++;
    }
  }
  Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: FakePalmServiceBridge });
  return { calls, cancels: () => cancels };
}

const OPTIONS = { maxBytes: 1024, timeoutMs: 5000, graceMs: 3000 };

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'PalmServiceBridge');
});

describe('fetchManifestViaService', () => {
  it('resolves to unavailable without a Luna bridge', async () => {
    await expect(fetchManifestViaService('http://host/a', {}, OPTIONS))
      .resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('asks the bundled service with the URL, headers, and limits, and returns its body', async () => {
    const bridge = installBridge();
    const result = fetchManifestViaService('http://host/a', { Referer: 'http://host/r' }, OPTIONS);
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0].uri).toBe(`luna://${__SERVICE_ID__}/fetchManifest`);
    expect(bridge.calls[0].payload).toEqual({
      url: 'http://host/a',
      headers: { Referer: 'http://host/r' },
      maxBytes: 1024,
      timeoutMs: 5000,
    });
    bridge.calls[0].reply({ returnValue: true, status: 200, url: 'http://host/b/a', text: '#EXTM3U\n' });
    await expect(result).resolves.toEqual({ ok: true, status: 200, url: 'http://host/b/a', text: '#EXTM3U\n' });
  });

  it('passes the service error code through as the reason', async () => {
    const bridge = installBridge();
    const result = fetchManifestViaService('http://host/a', {}, OPTIONS);
    bridge.calls[0].reply({ returnValue: false, errorCode: 'http_403', errorText: 'HTTP 403', status: 403 });
    await expect(result).resolves.toEqual({ ok: false, reason: 'http_403' });
  });

  it('reports a Luna bus error, such as a missing service, as unavailable', async () => {
    const bridge = installBridge();
    const result = fetchManifestViaService('http://host/a', {}, OPTIONS);
    bridge.calls[0].reply({ returnValue: false, errorCode: -1, errorText: 'Service does not exist' });
    await expect(result).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects a success without a body as invalid', async () => {
    const bridge = installBridge();
    const result = fetchManifestViaService('http://host/a', {}, OPTIONS);
    bridge.calls[0].reply({ returnValue: true, status: 200 });
    await expect(result).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('times out after the timeout plus the grace when the service never answers, and cancels the call', async () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    let settled = false;
    const result = fetchManifestViaService('http://host/a', {}, OPTIONS);
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(bridge.cancels()).toBe(1);
  });

  it('settles as aborted when the caller aborts, and cancels the call', async () => {
    const bridge = installBridge();
    const controller = new AbortController();
    const result = fetchManifestViaService('http://host/a', {}, { ...OPTIONS, signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(bridge.cancels()).toBe(1);
  });
});
