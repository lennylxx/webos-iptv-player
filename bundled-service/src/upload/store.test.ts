import { describe, expect, it } from 'vitest';
import { sanitizeId } from './store';

describe('sanitizeId', () => {
  it('slugs a file name and trims its leading and trailing dashes', () => {
    expect(sanitizeId('My List.m3u8')).toBe('my-list');
    expect(sanitizeId('--A  b!!--.m3u')).toBe('a-b');
    expect(sanitizeId('???')).toBe('playlist');
    expect(sanitizeId('-'.repeat(70) + 'x')).toBe('x');
    expect(sanitizeId('a'.repeat(59) + '-b')).toBe('a'.repeat(59) + '-');
  });

  it('trims a name with a long inner run of dashes in linear time', () => {
    const name = 'a' + '-'.repeat(80000) + 'b';
    const started = Date.now();
    expect(sanitizeId(name)).toBe('a' + '-'.repeat(59));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
