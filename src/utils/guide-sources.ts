import type { EpgSource } from '../types';

// A guide a source advertised is dropped once every source that advertised
// it has its guide switched off; one shared with a source still on stays.
export function withoutGuideOff<T extends Pick<EpgSource, 'playlistIds'>>(
  sources: T[],
  off: string[],
): T[] {
  if (!off.length) return sources;
  return sources.filter(source => !source.playlistIds.length
    || source.playlistIds.some(id => off.indexOf(id) < 0));
}
