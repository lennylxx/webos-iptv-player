import { describe, expect, it } from 'vitest';
import { withoutGuideOff } from './guide-sources';

describe('withoutGuideOff', () => {
  const a = { url: 'http://host/a', playlistIds: ['p1'] };
  const shared = { url: 'http://host/b', playlistIds: ['p1', 'p2'] };
  const unscoped = { url: 'http://host/c', playlistIds: [] };

  it('keeps every guide while no source has it switched off', () => {
    const sources = [a, shared, unscoped];
    expect(withoutGuideOff(sources, [])).toBe(sources);
  });

  it('drops a guide only when every source that advertised it is off', () => {
    expect(withoutGuideOff([a, shared, unscoped], ['p1'])).toEqual([shared, unscoped]);
    expect(withoutGuideOff([a, shared, unscoped], ['p1', 'p2'])).toEqual([unscoped]);
  });
});
