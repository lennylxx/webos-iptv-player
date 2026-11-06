// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../config';
import { PlayReadyDrm } from './playready-drm';

describe('PlayReadyDrm', () => {
  const cancelSubscription = vi.fn();
  const request = vi.fn();
  // When set, unload answers wait here instead of arriving at once.
  let heldUnloads: Array<() => void> | null = null;
  // The service reuses a clientId it has not yet unloaded.
  let live = new Set<string>();
  let nextClient = 1;

  beforeEach(() => {
    cancelSubscription.mockReset();
    request.mockReset();
    heldUnloads = null;
    live = new Set();
    nextClient = 1;

    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private method = '';

      call(uri: string, payload: string): void {
        this.method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as Record<string, unknown>;
        request(uri, { method: this.method, parameters });
        if (this.method === 'load') {
          const clientId = live.size ? Array.from(live)[0] : `client-${nextClient++}`;
          live.add(clientId);
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            clientId,
          }));
        } else if (this.method === 'sendDrmMessage') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            resultCode: 0,
            msgId: 'msg-1',
          }));
        } else if (this.method === 'unload') {
          const answer = (): void => {
            live.delete(parameters.clientId as string);
            this.onservicecallback?.('{"returnValue":true}');
          };
          if (heldUnloads) heldUnloads.push(answer);
          else answer();
        }
      }

      cancel(): void {
        if (this.method === 'getRightsError') cancelSubscription();
        this.onservicecallback = null;
      }
    }

    Object.defineProperty(window, 'PalmServiceBridge', {
      configurable: true,
      value: FakePalmServiceBridge,
    });
  });

  it('loads, subscribes and configures post-acquisition before playback', async () => {
    const drm = new PlayReadyDrm();
    await expect(drm.prepare({
      type: 'playready',
      licenseUrl: 'http://host/license?a=1&b=2',
      customData: 'token<&',
      unsupportedOptions: [],
    }, vi.fn())).resolves.toBe('client-1');

    expect(request.mock.calls.map(call => call[1].method)).toEqual([
      'load',
      'getRightsError',
      'sendDrmMessage',
      'sendDrmMessage',
    ]);
    const messages = request.mock.calls
      .filter(call => call[1].method === 'sendDrmMessage')
      .map(call => call[1].parameters.msg as string);
    expect(messages[0]).toContain('http://host/license?a=1&amp;b=2');
    expect(messages[1]).toContain('token&lt;&amp;');
  });

  it('cancels the subscription and unloads the client', async () => {
    const drm = new PlayReadyDrm();
    await drm.prepare({
      type: 'playready',
      licenseUrl: '',
      customData: '',
      unsupportedOptions: [],
    }, vi.fn());

    drm.release();
    await vi.waitFor(() => {
      expect(request.mock.calls.some(call => call[1].method === 'unload')).toBe(true);
    });
    expect(cancelSubscription).toHaveBeenCalledOnce();
  });

  const config = {
    type: 'playready' as const,
    licenseUrl: '',
    customData: '',
    unsupportedOptions: [],
  };
  const methods = (): string[] => request.mock.calls.map(call => call[1].method as string);

  it('waits for a released client to unload before loading the next', async () => {
    const drm = new PlayReadyDrm();
    await expect(drm.prepare(config, vi.fn())).resolves.toBe('client-1');
    heldUnloads = [];
    drm.release();
    const next = drm.prepare(config, vi.fn());
    await Promise.resolve();
    expect(methods().slice(-1)).toEqual(['unload']);

    const answers = heldUnloads;
    heldUnloads = null;
    answers.forEach(answer => answer());
    await expect(next).resolves.toBe('client-2');
    expect(methods().filter(method => method === 'unload')).toHaveLength(1);
  });

  it('drops a prepare superseded while it waits on an unload', async () => {
    const drm = new PlayReadyDrm();
    await drm.prepare(config, vi.fn());
    heldUnloads = [];
    drm.release();
    const stale = drm.prepare(config, vi.fn());
    drm.release();
    const answers = heldUnloads;
    heldUnloads = null;
    answers.forEach(answer => answer());
    await expect(stale).resolves.toBeNull();
    expect(methods().filter(method => method === 'load')).toHaveLength(1);
  });

  it('loads anyway when an unload goes unanswered', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const drm = new PlayReadyDrm();
      await drm.prepare(config, vi.fn());
      heldUnloads = [];
      drm.release();
      const next = drm.prepare(config, vi.fn());
      await vi.advanceTimersByTimeAsync(CONFIG.PLAYER.PLAYREADY_UNLOAD_WAIT_MS - 1);
      expect(methods().filter(method => method === 'load')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toBe('client-1');
      expect(warn.mock.calls.some(args => args.includes('event=playback.dash.drm.unload.timeout')))
        .toBe(true);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
