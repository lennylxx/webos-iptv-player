// Shared with the app worker, so it must stay free of DOM and storage access.
//
// The cached playlist is a head record plus chunk records of a few thousand
// channels each. Reading one value deserializes all of it in a single task,
// so the chunks let a launch show the first channels while the rest load.

// The first chunk is small so a launch shows channels soon; the rest are
// larger, since every chunk read costs its own transaction and task.
export const PLAYLIST_FIRST_CHUNK_SIZE = 2000;
export const PLAYLIST_CHUNK_SIZE = 8000;

export interface PlaylistChunkInfo {
  chunkCount: number;
  channelCount: number;
}

// Zero-padded so the chunks sort in order within the key range.
export function playlistChunkKey(key: string, index: number): string {
  return `${key}#${String(1000000 + index).slice(1)}`;
}

export function playlistChunkRange(key: string): [string, string] {
  return [`${key}#`, `${key}#\uffff`];
}

export function isPlaylistChunkKey(key: unknown): boolean {
  return typeof key === 'string' && key.indexOf('#') >= 0;
}

export function playlistChunkInfo(data: unknown): PlaylistChunkInfo | null {
  if (!data || typeof data !== 'object') return null;
  const { chunkCount, channelCount } = data as Partial<PlaylistChunkInfo>;
  return typeof chunkCount === 'number' && typeof channelCount === 'number'
    ? { chunkCount, channelCount }
    : null;
}

/**
 * Splits a record whose `data.channels` holds the list into a head that
 * counts the chunks instead and the chunk records, which carry the head's
 * key path and timestamp so a reader can tell they belong together.
 */
export function splitPlaylistRecord(
  record: Record<string, unknown>,
  keyPath: string,
): { head: Record<string, unknown>; chunks: Array<Record<string, unknown>> } {
  const data = record.data as Record<string, unknown>;
  const channels = data.channels as unknown[];
  const key = String(record[keyPath]);
  const chunks: Array<Record<string, unknown>> = [];
  for (let start = 0; start < channels.length;) {
    const end = start + (chunks.length ? PLAYLIST_CHUNK_SIZE : PLAYLIST_FIRST_CHUNK_SIZE);
    chunks.push({
      [keyPath]: playlistChunkKey(key, chunks.length),
      timestamp: record.timestamp,
      channels: channels.slice(start, end),
    });
    start = end;
  }
  const headData: Record<string, unknown> = {};
  for (const field in data) if (field !== 'channels') headData[field] = data[field];
  headData.chunkCount = chunks.length;
  headData.channelCount = channels.length;
  return { head: { ...record, data: headData }, chunks };
}

/** A chunk's channels, or null when it is missing or from another write. */
export function playlistChunkChannels(chunk: unknown, timestamp: unknown): unknown[] | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const { channels, timestamp: chunkTimestamp } = chunk as Record<string, unknown>;
  return Array.isArray(channels) && chunkTimestamp === timestamp ? channels : null;
}

/** The head with its chunks' channels joined back into `data.channels`. */
export function joinPlaylistRecord(
  head: Record<string, unknown>,
  chunks: readonly unknown[],
): Record<string, unknown> | null {
  const info = playlistChunkInfo(head.data);
  if (!info || chunks.length !== info.chunkCount) return null;
  const channels: unknown[] = [];
  for (const chunk of chunks) {
    const part = playlistChunkChannels(chunk, head.timestamp);
    if (!part) return null;
    for (const channel of part) channels.push(channel);
  }
  if (channels.length !== info.channelCount) return null;
  return { ...head, data: { ...(head.data as Record<string, unknown>), channels } };
}

export interface PlaylistChunkWrite {
  store: string;
  value?: Record<string, unknown>;
  deleteRange?: [string, string];
}

/** The writes that replace a cached playlist and every chunk of the last one. */
export function chunkedPlaylistWrites(
  store: string,
  record: Record<string, unknown>,
  keyPath: string,
): PlaylistChunkWrite[] {
  const { head, chunks } = splitPlaylistRecord(record, keyPath);
  return [
    { store, deleteRange: playlistChunkRange(String(record[keyPath])) },
    { store, value: head },
    ...chunks.map(value => ({ store, value })),
  ];
}
