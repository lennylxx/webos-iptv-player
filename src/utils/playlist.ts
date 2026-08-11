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
