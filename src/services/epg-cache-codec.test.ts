import { describe, expect, it } from 'vitest';
import type { ParsedEpg, Programme } from '../types';
import { isPackedEpg, packEpg, unpackEpg, unpackEpgSliced } from './epg-cache-codec';

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
});
