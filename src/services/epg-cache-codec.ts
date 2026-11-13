import type { EpgChannel, ParsedEpg, Programme } from '../types';

// A cached guide as one structured clone takes seconds to read on a TV, all
// in one task. Packed as JSON text blocks, the read copies strings only and
// the blocks then parse a few at a time between other work.
export const PACKED_EPG_FORMAT = 'epg-packed-1';

// Small enough that one block decodes well inside a frame on a TV.
const CHANNELS_PER_BLOCK = 500;
const PROGRAMMES_PER_BLOCK = 500;
const PROGRAMME_FIELDS = 6;
const META_KEYS = ['channelCatalogComplete', 'sourceName', 'tzOffsetMinutes'] as const;

type EpgMeta = Pick<ParsedEpg, typeof META_KEYS[number]>;

export interface PackedEpg {
  format: typeof PACKED_EPG_FORMAT;
  meta: EpgMeta;
  // [id, name, icon, aliases | null, ...]
  channels: string[];
  // [id, [start, stop, title, description, category, icon, ...], ...]
  programmes: string[];
}

export function isPackedEpg(value: unknown): value is PackedEpg {
  return !!value && typeof value === 'object'
    && (value as { format?: unknown }).format === PACKED_EPG_FORMAT;
}

export function packEpg(data: ParsedEpg): PackedEpg {
  const meta: EpgMeta = {};
  for (const key of META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      (meta as Record<string, unknown>)[key] = data[key];
    }
  }
  const channels: string[] = [];
  let block: unknown[] = [];
  let count = 0;
  for (const id in data.channels) {
    const channel = data.channels[id];
    block.push(id, channel.name, channel.icon, channel.aliases ?? null);
    if (++count === CHANNELS_PER_BLOCK) {
      channels.push(JSON.stringify(block));
      block = [];
      count = 0;
    }
  }
  if (count) channels.push(JSON.stringify(block));
  const programmes: string[] = [];
  block = [];
  count = 0;
  for (const id in data.programmes) {
    const list = data.programmes[id];
    const flat: unknown[] = [];
    for (const programme of list) {
      flat.push(
        programme.start.getTime(),
        programme.stop.getTime(),
        programme.title,
        programme.description,
        programme.category,
        programme.icon,
      );
    }
    block.push(id, flat);
    count += list.length;
    if (count >= PROGRAMMES_PER_BLOCK) {
      programmes.push(JSON.stringify(block));
      block = [];
      count = 0;
    }
  }
  if (block.length) programmes.push(JSON.stringify(block));
  return { format: PACKED_EPG_FORMAT, meta, channels, programmes };
}

function decodeChannels(text: string, into: Record<string, EpgChannel>): void {
  const block = JSON.parse(text) as unknown[];
  for (let i = 0; i < block.length; i += 4) {
    const aliases = block[i + 3] as string[] | null;
    const channel: EpgChannel = { name: block[i + 1] as string, icon: block[i + 2] as string };
    if (aliases) channel.aliases = aliases;
    into[block[i] as string] = channel;
  }
}

function decodeProgrammes(text: string, into: Record<string, Programme[]>): void {
  const block = JSON.parse(text) as unknown[];
  for (let i = 0; i < block.length; i += 2) {
    const flat = block[i + 1] as unknown[];
    const list: Programme[] = [];
    for (let j = 0; j < flat.length; j += PROGRAMME_FIELDS) {
      list.push({
        start: new Date(flat[j] as number),
        stop: new Date(flat[j + 1] as number),
        title: flat[j + 2] as string,
        description: flat[j + 3] as string,
        category: flat[j + 4] as string,
        icon: flat[j + 5] as string,
      });
    }
    into[block[i] as string] = list;
  }
}

function decodeTasks(packed: PackedEpg, data: ParsedEpg): Array<() => void> {
  return [
    ...packed.channels.map(text => () => decodeChannels(text, data.channels)),
    ...packed.programmes.map(text => () => decodeProgrammes(text, data.programmes)),
  ];
}

function emptyGuide(packed: PackedEpg): ParsedEpg {
  return { channels: {}, programmes: {}, ...packed.meta };
}

export function unpackEpg(packed: PackedEpg): ParsedEpg {
  const data = emptyGuide(packed);
  for (const task of decodeTasks(packed, data)) task();
  return data;
}

/** Decodes block by block, calling `pause` whenever a slice runs past `sliceMs`. */
export async function unpackEpgSliced(
  packed: PackedEpg,
  pause: () => Promise<void>,
  sliceMs: number,
  now: () => number = () => performance.now(),
): Promise<ParsedEpg> {
  const data = emptyGuide(packed);
  let sliceStart = now();
  for (const task of decodeTasks(packed, data)) {
    if (now() - sliceStart >= sliceMs) {
      await pause();
      sliceStart = now();
    }
    task();
  }
  return data;
}

export interface EpgFilterLists {
  ids: string[];
  names: string[];
  key?: string;
}

// A filter holds a name per playlist channel, hundreds of thousands of short
// strings that made reading the guide's record one long task. One string
// reads fast, and a launch that trusts the cache by its key never parses it.
export interface PackedEpgFilter {
  lists: string;
  key?: string;
}

export function packEpgFilter(filter: EpgFilterLists): PackedEpgFilter {
  return {
    lists: JSON.stringify([filter.ids, filter.names]),
    ...(filter.key !== undefined ? { key: filter.key } : {}),
  };
}

/** The stored filter, its lists parsed on first use; older records stored them as arrays. */
export function unpackEpgFilter(stored: unknown): EpgFilterLists | null | undefined {
  if (stored === null || stored === undefined) return stored;
  const value = stored as Partial<PackedEpgFilter> & Partial<EpgFilterLists>;
  if (typeof value.lists !== 'string') return value as EpgFilterLists;
  const text = value.lists;
  let parsed: [string[], string[]] | null = null;
  const lists = (): [string[], string[]] => (parsed ??= JSON.parse(text) as [string[], string[]]);
  return {
    get ids() { return lists()[0]; },
    get names() { return lists()[1]; },
    ...(value.key !== undefined ? { key: value.key } : {}),
  };
}
