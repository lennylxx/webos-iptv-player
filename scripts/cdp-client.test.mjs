import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CdpClient,
  normalizeDeviceConfigurationError,
  resolveCdpTarget,
  resolveCdpWebSocketUrl,
  resolveConfiguredDeviceIp,
  selectPageTarget,
} from './cdp-client.mjs';

const pages = [
  {
    id: 'page-a',
    type: 'page',
    title: 'Alpha',
    description: 'ch1',
    url: 'http://host/a',
    webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-a',
  },
  {
    id: 'page-b',
    type: 'page',
    title: 'Bravo',
    description: 'ch2',
    url: 'http://host/b',
    webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-b',
  },
];

class FakeWebSocket {
  static behavior = {};

  static instances = [];

  static reset() {
    this.behavior = {};
    this.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sentMessages = [];
    this.listeners = new Map();
    this.shouldFailOpen = null;
    FakeWebSocket.instances.push(this);
    FakeWebSocket.behavior.onConstruct?.(this);
    setTimeout(() => {
      if (this.shouldFailOpen) {
        this.emit('error', { message: this.shouldFailOpen });
        return;
      }
      this.readyState = 1;
      this.emit('open', { type: 'open' });
    }, 0);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sentMessages.push(message);
    FakeWebSocket.behavior.onSend?.(this, message);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { type: 'close' });
  }

  failOpen(message) {
    this.shouldFailOpen = message;
  }

  emitProtocolEvent(method, params) {
    this.emit('message', { data: JSON.stringify({ method, params }) });
  }

  respond(id, result) {
    this.emit('message', { data: JSON.stringify({ id, result }) });
  }

  reject(id, message) {
    this.emit('message', { data: JSON.stringify({ id, error: { message } }) });
  }

  emit(type, event) {
    const handler = this[`on${type}`];
    handler?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('resolveConfiguredDeviceIp', () => {
  const originalTVDevice = process.env.TV_DEVICE;

  beforeEach(() => {
    delete process.env.TV_DEVICE;
  });

  afterEach(() => {
    if (originalTVDevice === undefined) delete process.env.TV_DEVICE;
    else process.env.TV_DEVICE = originalTVDevice;
  });

  it('prefers an explicit device name', () => {
    const execFile = vi.fn(() => JSON.stringify([
      { name: 'tv-a', default: true, deviceinfo: { ip: '192.0.2.1' } },
      { name: 'tv-b', default: false, deviceinfo: { ip: '192.0.2.2' } },
    ]));

    expect(resolveConfiguredDeviceIp({ deviceName: 'tv-b', execFile })).toBe('192.0.2.2');
    expect(execFile).toHaveBeenCalledWith(
      'ares-setup-device',
      ['-F', '-j'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  });

  it('falls back to TV_DEVICE, then the configured default, then the first device', () => {
    const execFile = vi.fn(() => JSON.stringify([
      { name: 'tv-a', default: true, deviceinfo: { ip: '192.0.2.1' } },
      { name: 'tv-b', default: false, deviceinfo: { ip: '192.0.2.2' } },
    ]));

    process.env.TV_DEVICE = 'tv-b';
    expect(resolveConfiguredDeviceIp({ execFile })).toBe('192.0.2.2');

    delete process.env.TV_DEVICE;
    expect(resolveConfiguredDeviceIp({ execFile })).toBe('192.0.2.1');

    expect(resolveConfiguredDeviceIp({
      execFile: () => JSON.stringify([
        { name: 'tv-a', default: false, deviceinfo: { ip: '192.0.2.1' } },
        { name: 'tv-b', default: false, deviceinfo: { ip: '192.0.2.2' } },
      ]),
    })).toBe('192.0.2.1');
  });

  it('falls back from a missing explicit device name to TV_DEVICE and then default', () => {
    process.env.TV_DEVICE = 'tv-b';

    expect(resolveConfiguredDeviceIp({
      deviceName: 'missing',
      execFile: () => JSON.stringify([
        { name: 'tv-a', default: true, deviceinfo: { ip: '192.0.2.1' } },
        { name: 'tv-b', default: false, deviceinfo: { ip: '192.0.2.2' } },
      ]),
    })).toBe('192.0.2.2');

    delete process.env.TV_DEVICE;
    expect(resolveConfiguredDeviceIp({
      deviceName: 'missing',
      execFile: () => JSON.stringify([
        { name: 'tv-a', default: true, deviceinfo: { ip: '192.0.2.1' } },
        { name: 'tv-b', default: false, deviceinfo: { ip: '192.0.2.2' } },
      ]),
    })).toBe('192.0.2.1');
  });

  it('throws the shared error when device resolution fails', () => {
    expect(() => resolveConfiguredDeviceIp({ execFile: () => 'not-json' }))
      .toThrow(/TV device configuration failed.*ares-setup-device -F.*TV_DEVICE/);
  });

  it('normalizes injected device lookup failures with repair instructions', () => {
    expect(normalizeDeviceConfigurationError(new Error('missing device')))
      .toMatchObject({
        message: expect.stringMatching(/missing device.*ares-setup-device -F.*TV_DEVICE/),
      });
  });
});

describe('selectPageTarget', () => {
  it('prefers an exact match over substring matches', () => {
    expect(selectPageTarget(pages, 'Alpha').id).toBe('page-a');
  });

  it('rejects ambiguous substring matches', () => {
    expect(() => selectPageTarget(pages, 'http://host/')).toThrow(/ambiguous/i);
  });

  it('supports the legacy first-page fallback', () => {
    expect(selectPageTarget(pages, 'missing', { fallbackToFirst: true }).id)
      .toBe('page-a');
  });

  it('preserves the legacy tv app filter ordering and fields', () => {
    const legacyPages = [
      {
        id: 'page-a',
        type: 'page',
        title: 'Alpha',
        description: 'ch1',
        url: 'http://host/apps/com.example.alpha',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-a',
      },
      {
        id: 'page-b',
        type: 'page',
        title: 'Bravo',
        description: 'com.example.alpha',
        url: 'http://host/b',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-b',
      },
    ];

    expect(selectPageTarget(legacyPages, 'com.example.alpha', {
      targetSelection: 'legacy-tv-app',
    }).id).toBe('page-a');
    expect(selectPageTarget(legacyPages, 'page-b', {
      targetSelection: 'legacy-tv-app',
    }).id).toBe('page-a');
    expect(selectPageTarget(legacyPages, 'missing', {
      targetSelection: 'legacy-tv-app',
    }).id).toBe('page-a');
  });

  it('preserves legacy ambiguous app filter handling by taking the first match', () => {
    expect(selectPageTarget(pages, 'http://host/', {
      targetSelection: 'legacy-tv-app',
    }).id).toBe('page-a');
  });
});

describe('resolveCdpWebSocketUrl', () => {
  it('exposes the selected target alongside the rewritten websocket URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: 'page-a',
          type: 'page',
          title: 'Alpha',
          description: 'ch1',
          url: 'http://host/apps/com.example.alpha',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-a',
        },
        {
          id: 'page-b',
          type: 'page',
          title: 'Bravo',
          description: 'com.example.alpha',
          url: 'http://host/b',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-b',
        },
      ],
    }));

    await expect(resolveCdpTarget({
      host: '192.0.2.1',
      port: 9998,
      target: 'com.example.alpha',
      targetSelection: 'legacy-tv-app',
      fetchImpl,
    })).resolves.toEqual({
      target: {
        id: 'page-a',
        type: 'page',
        title: 'Alpha',
        description: 'ch1',
        url: 'http://host/apps/com.example.alpha',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-a',
      },
      wsUrl: 'ws://192.0.2.1:9222/devtools/page/page-a',
    });
  });

  it('rewrites a discovered loopback WebSocket host', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => pages,
    }));

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      target: 'Alpha',
      fetchImpl,
    })).resolves.toBe('ws://192.0.2.1:9222/devtools/page/page-a');
    expect(fetchImpl).toHaveBeenCalledWith('http://192.0.2.1:9998/json/list');
  });

  it('defaults discovery host and port when omitted', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => pages,
    }));

    await expect(resolveCdpWebSocketUrl({
      target: 'Alpha',
      fetchImpl,
    })).resolves.toBe('ws://127.0.0.1:9222/devtools/page/page-a');
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9222/json/list');
  });

  it('defaults the discovery port when host is provided', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => pages,
    }));

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      target: 'Alpha',
      fetchImpl,
    })).resolves.toBe('ws://192.0.2.1:9222/devtools/page/page-a');
    expect(fetchImpl).toHaveBeenCalledWith('http://192.0.2.1:9222/json/list');
  });

  it('supports the legacy first-page fallback during discovery', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => pages,
    }));

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      target: 'missing',
      fallbackToFirst: true,
      fetchImpl,
    })).resolves.toBe('ws://192.0.2.1:9222/devtools/page/page-a');
    expect(fetchImpl).toHaveBeenCalledWith('http://192.0.2.1:9998/json/list');
  });

  it('preserves the legacy tv app filter during discovery', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          id: 'page-a',
          type: 'page',
          title: 'Alpha',
          description: 'ch1',
          url: 'http://host/apps/com.example.alpha',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-a',
        },
        {
          id: 'page-b',
          type: 'page',
          title: 'Bravo',
          description: 'com.example.alpha',
          url: 'http://host/b',
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/page-b',
        },
      ],
    }));

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      target: 'com.example.alpha',
      targetSelection: 'legacy-tv-app',
      fetchImpl,
    })).resolves.toBe('ws://192.0.2.1:9222/devtools/page/page-a');
  });

  it('treats invalid discovery JSON as a discovery failure', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    }));

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      target: 'Alpha',
      fetchImpl,
    })).rejects.toThrow('CDP target discovery failed: invalid JSON');
  });

  it('reports precise discovery network failures with the endpoint and repair hint', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      });
    });

    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      fetchImpl,
    })).rejects.toThrow(
      /CDP discovery failed at http:\/\/192\.0\.2\.1:9998\/json\/list: connection refused.*Developer Mode/,
    );
  });

  it('reports when discovery succeeds but no app page is open', async () => {
    await expect(resolveCdpWebSocketUrl({
      host: '192.0.2.1',
      port: 9998,
      fetchImpl: async () => ({
        ok: true,
        json: async () => [],
      }),
    })).rejects.toThrow(/endpoint is reachable.*Open the app on the TV/);
  });

  it('accepts direct WebSocket URLs without discovery', async () => {
    await expect(resolveCdpWebSocketUrl({
      url: 'wss://192.0.2.1:9222/devtools/page/page-a',
    })).resolves.toBe('wss://192.0.2.1:9222/devtools/page/page-a');
  });
});

describe('CdpClient', () => {
  afterEach(() => {
    FakeWebSocket.reset();
  });

  it('correlates calls with their own responses and dispatches events', async () => {
    FakeWebSocket.behavior = {
      onSend(socket, message) {
        if (message.method === 'Runtime.enable') {
          setTimeout(() => socket.emitProtocolEvent('Runtime.consoleAPICalled', { line: 'Alpha' }), 0);
          setTimeout(() => socket.respond(message.id, { enabled: true }), 10);
        }
        if (message.method === 'Runtime.evaluate') {
          setTimeout(() => socket.respond(message.id, { value: 2 }), 0);
        }
      },
    };

    const client = await CdpClient.connect('ws://192.0.2.1:9222/devtools/page/page-a', {
      WebSocketImpl: FakeWebSocket,
    });
    const events = [];
    const settled = [];
    const unsubscribe = client.on('Runtime.consoleAPICalled', (params) => {
      events.push(params);
    });

    const first = client.call('Runtime.enable').then((result) => {
      settled.push('first');
      return result;
    });
    const second = client.call('Runtime.evaluate', { expression: '1 + 1' }).then((result) => {
      settled.push('second');
      return result;
    });

    await expect(second).resolves.toEqual({ value: 2 });
    await expect(first).resolves.toEqual({ enabled: true });
    expect(settled).toEqual(['second', 'first']);
    expect(events).toEqual([{ line: 'Alpha' }]);

    unsubscribe();
    FakeWebSocket.instances[0].emitProtocolEvent('Runtime.consoleAPICalled', { line: 'Bravo' });
    expect(events).toEqual([{ line: 'Alpha' }]);
    expect(FakeWebSocket.instances[0].sentMessages).toEqual([
      { id: 1, method: 'Runtime.enable', params: {} },
      { id: 2, method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
    ]);

    client.close();
    client.close();
  });

  it('rejects protocol errors with the originating method name', async () => {
    FakeWebSocket.behavior = {
      onSend(socket, message) {
        setTimeout(() => socket.reject(message.id, 'boom'), 0);
      },
    };

    const client = await CdpClient.connect('ws://192.0.2.1:9222/devtools/page/page-a', {
      WebSocketImpl: FakeWebSocket,
    });

    await expect(client.call('Page.enable')).rejects.toThrow('Page.enable: boom');
    client.close();
  });

  it('rejects pending calls when the socket closes', async () => {
    FakeWebSocket.behavior = {
      onSend() {},
    };

    const client = await CdpClient.connect('ws://192.0.2.1:9222/devtools/page/page-a', {
      WebSocketImpl: FakeWebSocket,
    });
    const pending = client.call('Network.enable');

    FakeWebSocket.instances[0].close();
    await expect(pending).rejects.toThrow('CDP connection closed');
    client.close();
  });

  it('rejects the connection when the socket errors before opening', async () => {
    FakeWebSocket.behavior = {
      onConstruct(socket) {
        socket.failOpen('open failed');
      },
    };

    await expect(CdpClient.connect('ws://192.0.2.1:9222/devtools/page/page-a', {
      WebSocketImpl: FakeWebSocket,
    })).rejects.toThrow('open failed');
  });

  it('includes the WebSocket endpoint when the browser provides no specific error', async () => {
    FakeWebSocket.behavior = {
      onConstruct(socket) {
        socket.failOpen('CDP connection failed');
      },
    };

    await expect(CdpClient.connect('ws://192.0.2.1:9222/devtools/page/page-a', {
      WebSocketImpl: FakeWebSocket,
    })).rejects.toThrow(
      /CDP WebSocket connection failed at ws:\/\/192\.0\.2\.1:9222\/devtools\/page\/page-a/,
    );
  });
});
