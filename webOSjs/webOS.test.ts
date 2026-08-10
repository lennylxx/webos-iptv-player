/**
 * Tests for the minimal webOS.js shim that wraps PalmServiceBridge.
 * The shim is a script-tag-loaded file (not an ES module), so we read it
 * as text and execute it inside a synthesized environment that captures
 * the bridge call so we can assert the final URL Luna receives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SHIM_PATH = join(__dirname, 'webOS.js');
const SHIM_SOURCE = readFileSync(SHIM_PATH, 'utf-8');

interface BridgeCall {
  url: string;
  body: string;
}

interface ShimGlobals {
  webOS: {
    service: {
      request: (uri: string, params: Record<string, unknown>) => unknown;
    };
    platformBack: () => void;
  };
  calls: BridgeCall[];
  callbacks: ((msg: string) => void)[];
}

/** Load the shim into an isolated synthesized window-like context. */
function loadShim(): ShimGlobals {
  const calls: BridgeCall[] = [];
  const callbacks: ((msg: string) => void)[] = [];

  class FakeBridge {
    onservicecallback: ((msg: string) => void) | null = null;
    call(url: string, body: string): void {
      calls.push({ url, body });
      if (this.onservicecallback) callbacks.push(this.onservicecallback);
    }
    cancel(): void { /* no-op for tests */ }
  }

  const fakeWindow: Record<string, unknown> = {
    PalmServiceBridge: FakeBridge,
    navigator: { userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV)' },
  };

  // The shim is an IIFE that ends with `})(window);` — it captures `window`
  // from its surrounding scope. We define `window` and `navigator` as
  // parameters of a Function wrapper so the IIFE binds to our fakes instead
  // of the real globals.
  new Function('window', 'navigator', SHIM_SOURCE)(fakeWindow, fakeWindow.navigator);

  return {
    webOS: fakeWindow.webOS as ShimGlobals['webOS'],
    calls,
    callbacks,
  };
}

describe('webOS.js shim — URL construction (regression for trailing slash)', () => {
  let env: ShimGlobals;

  beforeEach(() => {
    env = loadShim();
  });

  it('joins URI and method with a single slash', () => {
    env.webOS.service.request('luna://com.foo.bar', { method: 'start' });
    expect(env.calls[0].url).toBe('luna://com.foo.bar/start');
  });

  it('does NOT produce a double slash between the service name and method when the URI already ends in /', () => {
    // This exact pattern silently broke our LAN service: a trailing slash
    // produced luna://...//start, which Luna rejected as a malformed method.
    env.webOS.service.request('luna://com.foo.bar/', { method: 'start' });
    expect(env.calls[0].url).toBe('luna://com.foo.bar/start');
    // Only the scheme should contain '//' (luna://). The path after must not.
    expect(env.calls[0].url.replace('luna://', '')).not.toContain('//');
  });

  it('omits the slash when no method is given', () => {
    env.webOS.service.request('luna://com.foo.bar/status', {});
    expect(env.calls[0].url).toBe('luna://com.foo.bar/status');
  });

  it('serializes parameters as JSON in the body', () => {
    env.webOS.service.request('luna://com.foo.bar', { method: 'start', parameters: { x: 1, y: 'z' } });
    expect(env.calls[0].body).toBe('{"x":1,"y":"z"}');
  });

  it('adds subscribe:true to the body when subscribe is set', () => {
    env.webOS.service.request('luna://com.foo.bar', { method: 'tick', subscribe: true });
    expect(JSON.parse(env.calls[0].body)).toMatchObject({ subscribe: true });
  });
});

describe('webOS.js shim — callback dispatch', () => {
  let env: ShimGlobals;

  beforeEach(() => {
    env = loadShim();
  });

  it('routes a returnValue:true response to onSuccess', () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    env.webOS.service.request('luna://com.foo', { method: 'm', onSuccess, onFailure });
    env.callbacks[0](JSON.stringify({ returnValue: true, payload: 'ok' }));
    expect(onSuccess).toHaveBeenCalledWith({ returnValue: true, payload: 'ok' });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('routes a returnValue:false response to onFailure', () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    env.webOS.service.request('luna://com.foo', { method: 'm', onSuccess, onFailure });
    env.callbacks[0](JSON.stringify({ returnValue: false, errorText: 'nope' }));
    expect(onFailure).toHaveBeenCalledWith({ returnValue: false, errorText: 'nope' });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('routes a response with errorCode to onFailure', () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    env.webOS.service.request('luna://com.foo', { method: 'm', onSuccess, onFailure });
    env.callbacks[0](JSON.stringify({ errorCode: -1, errorText: 'denied' }));
    expect(onFailure).toHaveBeenCalledWith({ errorCode: -1, errorText: 'denied' });
  });
});
