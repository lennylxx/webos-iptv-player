import type { PlaylistEntry } from '../types';

/**
 * Stable, unique id for a configured playlist, assigned once at creation and
 * persisted. Random rather than positional so deleting/reordering a playlist
 * never changes another's id. Kept dependency-free (no StorageService) so it
 * works everywhere, including where that module is mocked in tests.
 */
export function genPlaylistId(): string {
  return 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function isSourceEnabled(source: Pick<PlaylistEntry, 'enabled'>): boolean {
  return source.enabled !== false;
}

// How far a playlist load has come, 0..1. A source of unknown size eases
// toward the end and never claims to be done.
export function playlistLoadFraction(progress: {
  sourceNumber: number;
  sourceCount: number;
  inputBytes: number;
  totalBytes?: number;
}, unknownScaleBytes: number): number {
  const { inputBytes, totalBytes } = progress;
  const source = totalBytes && inputBytes <= totalBytes
    ? inputBytes / totalBytes
    : Math.min(0.95, 1 - Math.exp(-inputBytes / unknownScaleBytes));
  const count = Math.max(1, progress.sourceCount);
  const done = Math.min(count, Math.max(1, progress.sourceNumber)) - 1;
  return Math.min(1, (done + source) / count);
}
