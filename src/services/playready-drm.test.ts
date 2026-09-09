// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayReadyDrm } from './playready-drm';

describe('PlayReadyDrm', () => {
  const cancelSubscription = vi.fn();
  const request = vi.fn();

  beforeEach(() => {
    cancelSubscription.mockReset();
    request.mockReset();

    class FakePalmServiceBridge {
      onservicecallback: ((message: string) => void) | null = null;
      private method = '';

      call(uri: string, payload: string): void {
        this.method = uri.slice(uri.lastIndexOf('/') + 1);
        const parameters = JSON.parse(payload) as Record<string, unknown>;
        request(uri, { method: this.method, parameters });
        if (this.method === 'load') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            clientId: 'client-1',
          }));
        } else if (this.method === 'sendDrmMessage') {
          this.onservicecallback?.(JSON.stringify({
            returnValue: true,
            resultCode: 0,
            msgId: 'msg-1',
          }));
        } else if (this.method === 'unload') {
          this.onservicecallback?.('{"returnValue":true}');
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
});
