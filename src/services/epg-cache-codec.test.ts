import { describe, expect, it, vi } from 'vitest';
import type { ParsedEpg, Programme } from '../types';
import {
  isPackedEpg,
  packEpg,
  packEpgFilter,
  unpackEpg,
  unpackEpgFilter,
  unpackEpgSliced,
} from './epg-cache-codec';

function programme(start: number, title: string): Programme {
  return {
    start: new Date(start),
    stop: new Date(start + 3_600_000),
    title,
    description: `${title} description`,
    category: 'c1',
    icon: '',
  };
}

function guide(channelCount: number, perChannel: number): ParsedEpg {
  const data: ParsedEpg = { channels: {}, programmes: {} };
  for (let c = 0; c < channelCount; c++) {
    data.channels[`ch${String(c)}`] = { name: `Channel ${String(c)}`, icon: '' };
    data.programmes[`ch${String(c)}`] = Array.from({ length: perChannel }, (_, p) =>
      programme(1_700_000_000_000 + p * 3_600_000, `Show ${String(c)}-${String(p)}`));
  }
  return data;
}

describe('epg cache codec', () => {
  it('round-trips channels, aliases, programmes, and the optional fields that are set', () => {
    const data: ParsedEpg = {
      channels: {
        ch1: { name: 'Alpha', icon: 'http://host/a.png', aliases: ['Alpha HD'] },
        ch2: { name: 'Bravo', icon: '' },
      },
      programmes: {
        ch1: [programme(1_700_000_000_000, 'Show 1'), programme(1_700_003_600_000, 'Show 2')],
        ch2: [],
      },
      channelCatalogComplete: true,
      tzOffsetMinutes: null,
    };
    const restored = unpackEpg(packEpg(data));
    expect(restored).toEqual(data);
    expect(restored.programmes.ch1[0].start).toBeInstanceOf(Date);
    expect('aliases' in restored.channels.ch2).toBe(false);
    // An absent offset field and a null one mean different things to the restore.
    expect('tzOffsetMinutes' in restored).toBe(true);
    expect('sourceName' in restored).toBe(false);
    expect('tzOffsetMinutes' in unpackEpg(packEpg({ channels: {}, programmes: {} }))).toBe(false);
  });

  it('splits a large guide into blocks and tells packed data from a parsed guide', () => {
    const data = guide(3000, 3);
    const packed = packEpg(data);
    expect(packed.channels.length).toBeGreaterThan(1);
    expect(packed.programmes.length).toBeGreaterThan(1);
    expect(isPackedEpg(packed)).toBe(true);
    expect(isPackedEpg(data)).toBe(false);
    expect(unpackEpg(packed)).toEqual(data);
  });

  it('keeps each block small enough to decode in a short task', () => {
    const packed = packEpg(guide(3000, 3));
    for (const text of packed.channels) {
      expect((JSON.parse(text) as unknown[]).length / 4).toBeLessThanOrEqual(500);
    }
    for (const text of packed.programmes) {
      const block = JSON.parse(text) as unknown[];
      let programmes = 0;
      for (let i = 1; i < block.length; i += 2) programmes += (block[i] as unknown[]).length / 6;
      // A channel's list stays whole, so a block may run past by one channel's list.
      expect(programmes).toBeLessThan(500 + 3);
    }
  });

  it('pauses between blocks once a slice runs out, and decodes the same guide', async () => {
    const data = guide(3000, 3);
    const packed = packEpg(data);
    let clock = 0;
    let pauses = 0;
    // Every block costs one tick, so a two-tick slice pauses every other block.
    const restored = await unpackEpgSliced(packed, async () => { pauses++; }, 2, () => clock++);
    expect(restored).toEqual(data);
    const blocks = packed.channels.length + packed.programmes.length;
    expect(pauses).toBeGreaterThanOrEqual(Math.floor(blocks / 2) - 1);
  });

  it('parses a packed filter\'s lists only once they are read', () => {
    const packed = packEpgFilter({ ids: ['ch1'], names: ['alpha'], key: 'k1' });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const filter = unpackEpgFilter(packed)!;
      expect(filter.key).toBe('k1');
      expect(parse).not.toHaveBeenCalled();
      expect(filter.ids).toEqual(['ch1']);
      expect(filter.names).toEqual(['alpha']);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
    expect(unpackEpgFilter(null)).toBeNull();
    expect(unpackEpgFilter(undefined)).toBeUndefined();
  });
});
