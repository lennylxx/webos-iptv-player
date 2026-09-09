// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadShaka, type ShakaNamespaceLike, type ShakaSchemePlugin } from './shaka-loader';

const scope = window as Window & { __shaka?: ShakaNamespaceLike; shaka?: ShakaNamespaceLike };
afterEach(() => {
  delete scope.__shaka;
  delete scope.shaka;
  document.querySelector('script[src="js/shaka-player.dash.js"]')?.remove();
});

async function setup(): Promise<{
  plugin: ShakaSchemePlugin;
  register: ReturnType<typeof vi.fn>;
}> {
  const register = vi.fn<(scheme: string, plugin: ShakaSchemePlugin, priority: number) => void>();
  scope.__shaka = {
    Player: class {},
    net: { NetworkingEngine: {
      RequestType: { LICENSE: 2 }, PluginPriority: { FALLBACK: 1 }, registerScheme: register,
    } },
    util: { Error: { Severity: { CRITICAL: 2 } } },
  };
  await loadShaka();
  return { plugin: register.mock.calls[0][1], register };
}

describe('Shaka inline JSON licenses', () => {
  it('loads the vendor script from the js directory', async () => {
    const pending = loadShaka();
    const script = document.querySelector<HTMLScriptElement>('script[src="js/shaka-player.dash.js"]');
    expect(script).not.toBeNull();
    const namespace: ShakaNamespaceLike = {
      Player: class {},
      util: { Error: { Severity: { CRITICAL: 2 } } },
    };
    scope.shaka = namespace;
    script!.dispatchEvent(new Event('load'));
    await expect(pending).resolves.toBe(namespace);
  });

  it('registers once at fallback priority and returns the original request with decoded bytes', async () => {
    const { plugin, register } = await setup();
    await loadShaka();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('data', plugin, 1);
    const request = { headers: {} };
    const json = '{"keys":[]}';
    const uri = 'data:application/json;base64,' + btoa(json);
    const operation = plugin(uri, request, 2);
    const result = await operation.promise;
    expect(String.fromCharCode(...new Uint8Array(result.data))).toBe(json);
    expect(result.originalRequest).toBe(request);
    expect(result.originalUri).toBe(uri);
    expect(result.headers).toEqual({ 'content-type': 'application/json' });
    await expect(operation.abort()).resolves.toBeUndefined();
  });

  it.each([
    ['data:application/json;base64,e30=', 0],
    ['data:text/plain;base64,e30=', 2],
    ['data:application/json;base64,!invalid!', 2],
  ])('rejects unsupported or malformed inline requests', async (uri, type) => {
    const { plugin } = await setup();
    await expect(plugin(String(uri), { headers: {} }, Number(type)).promise).rejects.toThrow();
  });
});
