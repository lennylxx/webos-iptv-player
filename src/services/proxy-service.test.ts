// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { closeStreamProxy, openStreamProxy, touchStreamProxy } from './proxy-service';

const TOKEN = 'a'.repeat(32);
const PROXIED = `http://127.0.0.1:1/p/${TOKEN}/http/host/a.m3u8`;

interface BridgeCall {
  uri: string;
  payload: Record<string, unknown>;
  reply: (response: Record<string, unknown>) => void;
}

function installBridge(): { calls: BridgeCall[] } {
  const calls: BridgeCall[] = [];
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
      // Nothing to cancel in the fake.
    }
  }
  Object.defineProperty(window, 'PalmServiceBridge', { configurable: true, value: FakePalmServiceBridge });
  return { calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'PalmServiceBridge');
});

describe('openStreamProxy over Luna', () => {
  it('opens a session with the URL and headers', async () => {
    const bridge = installBridge();
    const result = openStreamProxy('http://host/a.m3u8', { Referer: 'http://host/' });
    expect(bridge.calls[0].uri).toBe(`luna://${__SERVICE_ID__}/openProxy`);
    expect(bridge.calls[0].payload).toEqual({ url: 'http://host/a.m3u8', headers: { Referer: 'http://host/' } });
    bridge.calls[0].reply({ returnValue: true, url: PROXIED, token: TOKEN });
    await expect(result).resolves.toEqual({ ok: true, url: PROXIED, token: TOKEN });
  });

  it('rejects a reply whose URL is not a loopback proxy URL', async () => {
    const bridge = installBridge();
    const result = openStreamProxy('http://host/a.m3u8', {});
    bridge.calls[0].reply({ returnValue: true, url: 'http://host/a.m3u8', token: TOKEN });
    await expect(result).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('passes the service error code through, and a bus error as unavailable', async () => {
    const bridge = installBridge();
    const denied = openStreamProxy('http://host/a.m3u8', {});
    const bus = openStreamProxy('http://host/a.m3u8', {});
    bridge.calls[0].reply({ returnValue: false, errorCode: 'bad_url' });
    bridge.calls[1].reply({ returnValue: false, errorCode: -1 });
    await expect(denied).resolves.toEqual({ ok: false, reason: 'bad_url' });
    await expect(bus).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('times out, then closes a session that opens late', async () => {
    vi.useFakeTimers();
    const bridge = installBridge();
    const result = openStreamProxy('http://host/a.m3u8', {}, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
    bridge.calls[0].reply({ returnValue: true, url: PROXIED, token: TOKEN });
    expect(bridge.calls[1].uri).toBe(`luna://${__SERVICE_ID__}/closeProxy`);
    expect(bridge.calls[1].payload).toEqual({ token: TOKEN });
  });

  it('gives the first open the cold-start budget and later opens the usual one', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fresh = await import('./proxy-service');
    const bridge = installBridge();
    const first = fresh.openStreamProxy('http://host/a.m3u8', {});
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_OPEN_TIMEOUT);
    bridge.calls[0].reply({ returnValue: true, url: PROXIED, token: TOKEN });
    await expect(first).resolves.toMatchObject({ ok: true });
    const second = fresh.openStreamProxy('http://host/a.m3u8', {});
    await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PROXY_OPEN_TIMEOUT);
    await expect(second).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('touchStreamProxy', () => {
  it('reports the session status over Luna', async () => {
    const bridge = installBridge();
    const result = touchStreamProxy(TOKEN);
    expect(bridge.calls[0].uri).toBe(`luna://${__SERVICE_ID__}/touchProxy`);
    bridge.calls[0].reply({ returnValue: true, alive: true, lastStatus: 404, manifestStatus: 200,
      cookies: { domain: 2, 'a b': 1, cap: 'x' } });
    await expect(result).resolves.toEqual({ alive: true, lastStatus: 404, manifestStatus: 200,
      cookies: { domain: 2 } });
  });

  it('resolves null when the service cannot answer', async () => {
    const bridge = installBridge();
    const result = touchStreamProxy(TOKEN);
    bridge.calls[0].reply({ returnValue: false, errorCode: -1 });
    await expect(result).resolves.toBeNull();
  });
});

describe('closeStreamProxy', () => {
  it('reports the cookies the session did not keep', async () => {
    const bridge = installBridge();
    const result = closeStreamProxy(TOKEN);
    expect(bridge.calls[0].uri).toBe(`luna://${__SERVICE_ID__}/closeProxy`);
    bridge.calls[0].reply({ returnValue: true, closed: true, cookies: { https: 1, malformed: 3 } });
    await expect(result).resolves.toEqual({ https: 1, malformed: 3 });
  });

  it('resolves null when the service cannot answer', async () => {
    const bridge = installBridge();
    const result = closeStreamProxy(TOKEN);
    bridge.calls[0].reply({ returnValue: false, errorCode: -1 });
    await expect(result).resolves.toBeNull();
  });
});

describe('openStreamProxy in the desktop preview', () => {
  it('passes a control endpoint failure code through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ returnValue: false, errorCode: 'bad_url' }), { status: 400 })));
    await expect(openStreamProxy('ftp://host/a', {})).resolves.toEqual({ ok: false, reason: 'bad_url' });
  });
});
