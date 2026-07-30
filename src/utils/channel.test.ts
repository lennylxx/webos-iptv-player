import { describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import { channelCustomizationKey, channelKey, channelStreamKey } from './channel';

const ch = (url: string): Channel => ({
  id: '', name: '', logo: '', group: '', url, extras: null,
  playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0,
});

describe('channelCustomizationKey', () => {
  it('distinguishes streams whose identity is in the query string', () => {
    expect(channelCustomizationKey(ch('http://host/stream?id=1')))
      .not.toBe(channelCustomizationKey(ch('http://host/stream?id=2')));
  });

  it('ignores fragments', () => {
    expect(channelCustomizationKey(ch('http://host/a?id=1#frag')))
      .toBe(channelCustomizationKey(ch('http://host/a?id=1')));
  });

  it('uses the exact stream identity', () => {
    expect(channelCustomizationKey(ch('http://host/a?id=1')))
      .toBe(channelStreamKey(ch('http://host/a?id=1')));
  });

  it('survives rotating authentication parameters', () => {
    expect(channelCustomizationKey(ch('http://host/a?id=1&token=A&expires=1')))
      .toBe(channelCustomizationKey(ch('http://host/a?id=1&token=B&expires=2')));
  });
});

describe('channelKey', () => {
  it('is deterministic for the same URL', () => {
    expect(channelKey(ch('http://host/a'))).toBe(channelKey(ch('http://host/a')));
  });

  it('ignores rotating authentication parameters', () => {
    const a = channelKey(ch('http://host/a?token=AAA&e=1'));
    const b = channelKey(ch('http://host/a?token=BBB&e=2'));
    expect(a).toBe(b);
  });

  it('leaves existing query-stripped persisted keys unchanged', () => {
    expect(channelKey(ch('http://host/a?id=1')))
      .toBe(channelKey(ch('http://host/a?id=2')));
  });

  it('ignores the fragment', () => {
    expect(channelKey(ch('http://host/a#frag'))).toBe(channelKey(ch('http://host/a')));
  });

  it('distinguishes different stream paths (e.g. HD vs SD variants)', () => {
    expect(channelKey(ch('http://host/hd'))).not.toBe(channelKey(ch('http://host/sd')));
  });

  it('returns a fixed-length 8-char hex string', () => {
    expect(channelKey(ch('http://host/a'))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles an empty URL without throwing', () => {
    expect(channelKey(ch(''))).toMatch(/^[0-9a-f]{8}$/);
  });
});
