import { describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import {
  channelKey,
  legacyChannelKey,
} from './channel';

const ch = (url: string): Channel => ({
  id: '', name: '', logo: '', group: '', url, extras: null,
  playlistIds: [], catchup: '', catchupSource: '', catchupDays: 0,
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

  it('keeps query channel identity while ignoring provider credentials', () => {
    expect(channelKey(ch('http://host/a?stid=1&mac=A&key=A')))
      .toBe(channelKey(ch('http://host/a?stid=1&mac=B&key=B')));
    expect(channelKey(ch('http://host/a?stid=1&mac=A&key=A')))
      .not.toBe(channelKey(ch('http://host/a?stid=2&mac=A&key=A')));
  });

  it('distinguishes streams whose identity is in the query string', () => {
    expect(channelKey(ch('http://host/a?id=1')))
      .not.toBe(channelKey(ch('http://host/a?id=2')));
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

describe('legacyChannelKey', () => {
  it('reproduces query-stripped persisted keys for migration', () => {
    expect(legacyChannelKey(ch('http://host/a?id=1')))
      .toBe(legacyChannelKey(ch('http://host/a?id=2')));
  });
});
