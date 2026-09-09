import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanBundle } from './compat-gate.mjs';
import {
  SHAKA_COMPAT_ALLOWLIST,
  validateShakaBundle,
} from './shaka-compat-gate.mjs';

const vendorBundle = () =>
  readFileSync('node_modules/shaka-player/dist/shaka-player.dash.js', 'utf8');

describe('Shaka Chromium 53 compatibility gate', () => {
  it('accepts the pinned DASH bundle and its own guarded polyfills', () => {
    const bundle = vendorBundle();

    expect(() => validateShakaBundle(bundle)).not.toThrow();
    expect(bundle).toContain('Promise.prototype.finally');
    expect(bundle).toContain('String.prototype.trimStart');
    expect(scanBundle(bundle, { allowlist: SHAKA_COMPAT_ALLOWLIST })).toEqual([]);
  });

  it('fails when an unreviewed post-Chromium-53 API is added', () => {
    expect(() => validateShakaBundle(vendorBundle() + '\nPromise.any([]);'))
      .toThrow(/compatibility assumptions changed/);
  });

  it('rejects syntax that Chromium 53 cannot parse', () => {
    expect(() => validateShakaBundle(vendorBundle() + '\nconst modern = () => 1;'))
      .toThrow(/not valid ES5/);
  });

  it('rejects BigInt calls outside their availability guard', () => {
    const unguarded = vendorBundle().replace('"BigInt"in window&&', 'true&&');

    expect(() => validateShakaBundle(unguarded))
      .toThrow(/BigInt call is not controlled/);
  });
});
