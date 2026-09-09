import { describe, expect, it } from 'vitest';
import { parseDrmConfig } from './drm-config';

describe('parseDrmConfig', () => {
  const kid = '00112233445566778899aabbccddeeff';
  const key = 'ffeeddccbbaa99887766554433221100';
  const secondKid = '11223344556677889900aabbccddeeff';
  const secondKey = '00112233445566778899aabbccddeeff';
  const jwk = {
    keys: [{ kty: 'oct', kid: 'ABEiM0RVZneImaq7zN3u_w', k: '_-7dzLuqmYh3ZlVEMyIRAA' }],
    type: 'temporary',
  };

  it.each(['clearkey', 'org.w3.clearkey', 'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e'])(
    'accepts inline keys for %s',
    type => {
      expect(parseDrmConfig({
        'inputstream.adaptive.license_type': type,
        'inputstream.adaptive.license_key': `${kid.toUpperCase()}:${key},${secondKid}:${secondKey}`,
      })).toEqual({
        type: 'clearkey', licenseUrl: '', headers: {},
        clearKeys: { [kid]: key, [secondKid]: secondKey },
        unsupportedOptions: [],
      });
    },
  );

  it('reads Kodi 22 license.keyids and reports unsupported options by name only', () => {
    expect(parseDrmConfig({
      'inputstream.adaptive.drm': JSON.stringify({
        'org.w3.clearkey': {
          license: { keyids: { [kid]: key }, req_headers: { 'x-token': 'v' }, req_data: 'not-supported' },
          persistent_storage: true,
        },
      }),
    })).toEqual({
      type: 'clearkey', licenseUrl: '', headers: { 'x-token': 'v' },
      clearKeys: { [kid]: key },
      unsupportedOptions: ['persistent_storage', 'license.req_data'],
    });
  });

  it.each([
    { 'inputstream.adaptive.drm_legacy': 'org.w3.clearkey|https://host/license|x-token=a%26b' },
    {
      'inputstream.adaptive.license_type': 'clearkey',
      'inputstream.adaptive.license_key': 'https://host/license|x-token=a%26b',
    },
    {
      'inputstream.adaptive.drm': JSON.stringify({
        'org.w3.clearkey': { license: { server_url: 'https://host/license', req_headers: 'x-token=a%26b' } },
      }),
    },
  ])('accepts a ClearKey license endpoint with headers', extras => {
    expect(parseDrmConfig(extras)).toEqual({
      type: 'clearkey', licenseUrl: 'https://host/license', headers: { 'x-token': 'a&b' },
      clearKeys: {}, unsupportedOptions: [],
    });
  });

  it.each([
    JSON.stringify(jwk),
    'data:application/json;base64,' + btoa(JSON.stringify(jwk)),
    'data:application/json,' + encodeURIComponent(JSON.stringify(jwk)),
    'ABEiM0RVZneImaq7zN3u_w:_-7dzLuqmYh3ZlVEMyIRAA',
  ])('normalizes inline ClearKey input without fetching it', license => {
    expect(parseDrmConfig({
      'inputstream.adaptive.drm_legacy': `org.w3.clearkey|${license}`,
    })).toEqual({
      type: 'clearkey', licenseUrl: '', headers: {}, clearKeys: { [kid]: key },
      unsupportedOptions: [],
    });
  });

  it('allows a manifest-provided license without inventing keys', () => {
    expect(parseDrmConfig({ 'inputstream.adaptive.drm_legacy': 'org.w3.clearkey' })).toEqual({
      type: 'clearkey', licenseUrl: '', headers: {}, clearKeys: {}, unsupportedOptions: [],
    });
  });

  it.each([
    'not-a-license', `${kid}:abc`, `${kid}:${key},`,
    `${kid}:${key},${kid}:${secondKey}`, '{', '{}',
    '{"keys":[]}', '{"keys":[{"kty":"RSA"}]}',
    `data:text/plain,${key}`, 'data:application/json;base64,!',
    'javascript:alert(1)', 'file:///license',
    JSON.stringify({ [kid]: 12 }),
    JSON.stringify({ keys: jwk.keys, type: 'persistent-license' }),
  ])('rejects malformed ClearKey input without echoing key material', license => {
    expect(parseDrmConfig({
      'inputstream.adaptive.license_type': 'org.w3.clearkey',
      'inputstream.adaptive.license_key': license,
    })).toEqual({ type: 'unsupported', value: 'invalid ClearKey license configuration' });
  });

  it.each([
    null, 12, [],
    { license: null },
    { license: false },
    { license: { keyids: '' } },
    { license: { keyids: [] } },
    { license: { server_url: 12 } },
    { license: { req_headers: 12 } },
    { license: { req_headers: { 'x-token': 12 } } },
  ])('rejects malformed Kodi ClearKey fields instead of silently using manifest defaults', entry => {
    expect(parseDrmConfig({
      'inputstream.adaptive.drm': JSON.stringify({ 'org.w3.clearkey': entry }),
    })).toEqual({ type: 'unsupported', value: 'invalid ClearKey license configuration' });
  });

  it('reads Kodi 22 PlayReady JSON and reports unsupported native options', () => {
    expect(parseDrmConfig({
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
    expect(parseDrmConfig({
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
    expect(parseDrmConfig({
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
    expect(parseDrmConfig({
      'inputstream.adaptive.drm': '{',
    })).toEqual({
      type: 'unsupported',
      value: 'invalid inputstream.adaptive.drm',
    });
  });

  it('reports an unknown DRM system as unsupported', () => {
    expect(parseDrmConfig({
      'inputstream.adaptive.license_type': 'com.example.drm',
    })).toEqual({ type: 'unsupported', value: 'com.example.drm' });
  });

  it('reads Kodi 22 Widevine JSON and decodes license headers', () => {
    expect(parseDrmConfig({
      'inputstream.adaptive.drm': JSON.stringify({
        'com.widevine.alpha': {
          license: {
            server_url: 'http://host/license',
            req_headers: 'x-token=a%26b&x-name=Track+1',
          },
          optional_key_req_params: { custom_data: 'unsupported' },
        },
      }),
    })).toEqual({
      type: 'widevine',
      licenseUrl: 'http://host/license',
      headers: {
        'x-token': 'a&b',
        'x-name': 'Track 1',
      },
      unsupportedOptions: ['optional_key_req_params.custom_data'],
    });
  });

  it('reads legacy Widevine properties and their request headers', () => {
    expect(parseDrmConfig({
      'inputstream.adaptive.license_type': 'com.widevine.alpha',
      'inputstream.adaptive.license_key':
        'http://host/license|authorization=Bearer%20token|R{SSM}|',
    })).toEqual({
      type: 'widevine',
      licenseUrl: 'http://host/license',
      headers: { authorization: 'Bearer token' },
      unsupportedOptions: ['license request/response recipe'],
    });
  });
});
