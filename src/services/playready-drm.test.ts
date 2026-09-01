// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeDrmConfig, PlayReadyDrm } from './playready-drm';

describe('nativeDrmConfig', () => {
  it('reads Kodi 22 PlayReady JSON and reports unsupported native options', () => {
    expect(nativeDrmConfig({
      'inputstream.adaptive.drm': JSON.stringify({
        'com.widevine.alpha': {
          license: { server_url: 'http://host/widevine' },
        },
        'com.microsoft.playready': {
          license: {
            server_url: 'http://host/license',
            req_headers: 'x-token=v',
          },
          optional_key_req_params: {
            custom_data: 'a&b',
          },
          persistent_storage: true,
        },
      }),
    })).toEqual({
      type: 'playready',
      licenseUrl: 'http://host/license',
      customData: 'a&b',
      unsupportedOptions: ['persistent_storage', 'license.req_headers'],
    });
  });

  it('reads Kodi drm_legacy and reports license headers as unsupported', () => {
    expect(nativeDrmConfig({
      'inputstream.adaptive.drm_legacy':
        'com.microsoft.playready|http://host/license|x-token=v',
    })).toEqual({
      type: 'playready',
      licenseUrl: 'http://host/license',
      customData: '',
      unsupportedOptions: ['license headers'],
    });
  });

  it('keeps old properties without treating Kodi license_data as custom data', () => {
    expect(nativeDrmConfig({
      'inputstream.adaptive.license_type': 'com.microsoft.playready',
      'inputstream.adaptive.license_key': 'http://host/license|x-token=v|R{SSM}|',
      'inputstream.adaptive.license_data': 'a&b',
      'drm_custom_data': 'token',
    })).toEqual({
      type: 'playready',
      licenseUrl: 'http://host/license',
      customData: 'token',
      unsupportedOptions: [
        'license headers',
        'license request/response recipe',
        'license data/PSSH',
      ],
    });
  });

  it('reports invalid Kodi DRM JSON as unsupported', () => {
    expect(nativeDrmConfig({
      'inputstream.adaptive.drm': '{',
    })).toEqual({
      type: 'unsupported',
      value: 'invalid inputstream.adaptive.drm',
    });
  });

  it('reports non-PlayReady DRM as unsupported', () => {
    expect(nativeDrmConfig({
      'inputstream.adaptive.license_type': 'com.widevine.alpha',
    })).toEqual({ type: 'unsupported', value: 'com.widevine.alpha' });
  });
});

describe('PlayReadyDrm', () => {
  const cancel = vi.fn();
  const request = vi.fn();

  beforeEach(() => {
    cancel.mockReset();
    request.mockReset();
    request.mockImplementation((_uri: string, options: {
      method: string;
      parameters: Record<string, unknown>;
      onSuccess?: (response: Record<string, unknown>) => void;
    }) => {
      if (options.method === 'load') {
        options.onSuccess?.({ returnValue: true, clientId: 'client-1' });
      } else if (options.method === 'sendDrmMessage') {
        options.onSuccess?.({ returnValue: true, resultCode: 0, msgId: 'msg-1' });
      } else if (options.method === 'unload') {
        options.onSuccess?.({ returnValue: true });
      }
      return { cancel };
    });
    Object.defineProperty(window, 'webOS', {
      configurable: true,
      value: { service: { request } },
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
    expect(cancel).toHaveBeenCalledOnce();
  });
});
