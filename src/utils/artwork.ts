import { isWebOSBefore6 } from './platform';

const TMDB_SIZE = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)(?:original|w\d+)\//;

// TMDB serves every size from one path. A compact backdrop is 1280px wide:
// webOS 4 and 5 always get it, as a 4K original would cost about 33 MB of
// decoded memory; newer TVs get the original unless asked for compact.
export function backdropUrl(url: string, compact = isWebOSBefore6()): string {
  return url.replace(TMDB_SIZE, `$1${compact ? 'w1280' : 'original'}/`);
}
