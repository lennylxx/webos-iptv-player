import { describe, it, expect } from 'vitest';
import type { Channel } from '../types';
import {
  channelExactStreamIdentity,
  channelHttpHeaders,
  channelKey,
  channelStreamIdentity,
  channelStreamKey,
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

  it('recomputes the key after the channel URL changes', () => {
    const channel = ch('http://host/a');
    const before = channelKey(channel);
    channel.url = 'http://host/b';
    expect(channelKey(channel)).toBe(channelKey(ch('http://host/b')));
    expect(channelKey(channel)).not.toBe(before);
    expect(legacyChannelKey(channel)).toBe(legacyChannelKey(ch('http://host/b')));
  });
});

describe('legacyChannelKey', () => {
  it('reproduces query-stripped persisted keys for migration', () => {
    expect(legacyChannelKey(ch('http://host/a?id=1')))
      .toBe(legacyChannelKey(ch('http://host/a?id=2')));
  });
});

describe('channelHttpHeaders', () => {
  it('merges cached extras under the declared headers', () => {
    expect(channelHttpHeaders({
      ...ch('http://host/a'),
      extras: { 'http-referrer': 'http://host/old', 'http-user-agent': 'ua1' },
      httpHeaders: { referer: 'http://host/new', Cookie: 'c=1' },
    })).toEqual({ 'User-Agent': 'ua1', referer: 'http://host/new', Cookie: 'c=1' });
  });

  it('is empty for a channel without headers', () => {
    expect(channelHttpHeaders(ch('http://host/a'))).toEqual({});
  });
});

describe('channelStreamIdentity', () => {
  const piped = (url: string, urlSuffix?: string): Channel => ({ ...ch(url), urlSuffix });

  it('survives a rotated token, header suffix included', () => {
    const before = piped('http://host/a?id=1&token=t1', 'User-Agent=ua1');
    const after = piped('http://host/a?token=t2&id=1', 'User-Agent=ua1');
    expect(channelStreamIdentity(after)).toBe(channelStreamIdentity(before));
    expect(channelStreamKey(after)).toBe(channelStreamKey(before));
    expect(channelExactStreamIdentity(after)).not.toBe(channelExactStreamIdentity(before));
  });

  it('still tells a header suffix or other query apart', () => {
    const base = piped('http://host/a?id=1&token=t1', 'User-Agent=ua1');
    expect(channelStreamIdentity(piped('http://host/a?id=1&token=t2')))
      .not.toBe(channelStreamIdentity(base));
    expect(channelStreamIdentity(piped('http://host/a?id=1&token=t2', 'User-Agent=ua2')))
      .not.toBe(channelStreamIdentity(base));
    expect(channelStreamIdentity(piped('http://host/a?id=2&token=t1', 'User-Agent=ua1')))
      .not.toBe(channelStreamIdentity(base));
  });

  it('survives a rotated token when the query itself holds a pipe', () => {
    const before = piped('http://host/a?ids=1|2&token=t1', 'User-Agent=ua1');
    const after = piped('http://host/a?ids=1|2&token=t2', 'User-Agent=ua1');
    expect(channelStreamIdentity(after)).toBe(channelStreamIdentity(before));
    expect(channelStreamIdentity(piped('http://host/a?ids=1|2&token=t2')))
      .toBe(channelStreamIdentity(piped('http://host/a?ids=1|2&token=t1')));
  });
});
