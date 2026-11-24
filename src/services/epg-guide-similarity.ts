import { LANGUAGE_CODES } from './subtitle-search/title-cleanup';

// Ranks guide channels by how alike their names are to a playlist channel's,
// for the EPG mapping picker when no name contains the search, and as the
// candidates an AI model picks from. The mapping-search worker runs it; the
// page only when the worker fails.

/** A name reduced to what identifies the channel: its words, and those words run together. */
export interface NameShape {
  compact: string;
  tokens: string[];
}

export interface Scored {
  index: number;
  score: number;
}

// Tags providers add that say nothing about which channel it is.
const NOISE = [
  'hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h264', 'h265', '1080p', '1080', '720p', '720', '50fps', '60fps',
  'backup', 'raw', 'vip', 'tv', 'channel', 'live',
];
const CODES = LANGUAGE_CODES.map(code => code.toLowerCase()).join('|');
// A country or language tag ahead of the name: "uk:", "|us|", "[de]". Only
// known codes count, so a brand such as "abc: news" keeps its first word.
const LEADING_TAG = new RegExp(`^\\s*(?:[|[(]\\s*(?:${CODES})\\s*[|\\])]|(?:${CODES})\\s*[:|]\\s)\\s*`);
const NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};
const SEPARATORS = /[\s\-_.:|,;!?'"()[\]{}/\\]+/;
export const MIN_SIMILARITY = 0.35;
// Alike enough to count as the same name: tags, case, and spelling aside.
export const SAME_NAME = 0.999;

export function nameShape(text: string): NameShape {
  const lower = text.toLowerCase().replace(LEADING_TAG, '');
  const tokens = lower.split(SEPARATORS)
    .map(token => NUMBERS[token] || token)
    .filter(token => token && NOISE.indexOf(token) < 0);
  return { compact: tokens.join(''), tokens };
}

function pairAt(text: string, i: number): number {
  return text.charCodeAt(i) * 65536 + text.charCodeAt(i + 1);
}

/** A name to compare many others against; its letter pairs are counted once. */
export class SimilarityTarget {
  private readonly shape: NameShape;
  private readonly pairs = new Map<number, number>();
  private readonly pairCount: number;
  // Reused per comparison, so scoring a large guide allocates nothing.
  private readonly used = new Map<number, number>();

  constructor(name: string) {
    this.shape = nameShape(name);
    const compact = this.shape.compact;
    for (let i = 0; i < compact.length - 1; i++) {
      const pair = pairAt(compact, i);
      this.pairs.set(pair, (this.pairs.get(pair) || 0) + 1);
    }
    this.pairCount = Math.max(0, compact.length - 1);
  }

  get empty(): boolean {
    return !this.shape.compact;
  }

  /** 0 to 1: letter-pair overlap, then shared words. */
  score(other: NameShape): number {
    return 0.6 * this.pairOverlap(other.compact) + 0.4 * this.wordOverlap(other.tokens);
  }

  private pairOverlap(compact: string): number {
    const mine = this.shape.compact;
    // A one-letter name has no pairs; it matches only itself.
    if (this.pairCount === 0 || compact.length < 2) return mine && mine === compact ? 1 : 0;
    this.used.clear();
    let shared = 0;
    for (let i = 0; i < compact.length - 1; i++) {
      const pair = pairAt(compact, i);
      const have = this.pairs.get(pair) || 0;
      const taken = this.used.get(pair) || 0;
      if (taken < have) {
        shared++;
        this.used.set(pair, taken + 1);
      }
    }
    return (2 * shared) / (this.pairCount + compact.length - 1);
  }

  private wordOverlap(tokens: string[]): number {
    const mine = this.shape.tokens;
    if (!mine.length || !tokens.length) return 0;
    let shared = 0;
    for (const token of mine) if (tokens.indexOf(token) >= 0) shared++;
    return shared / (mine.length + tokens.length - shared);
  }
}

/** 0 to 1: how alike two channel names are once tags and spelling are set aside. */
export function nameSimilarity(a: string, b: string): number {
  return new SimilarityTarget(a).score(nameShape(b));
}

/**
 * The entries whose fields are most alike `name`, best first, as indices with
 * their best score; none below the floor. `shapesOf` gives each entry's field
 * shapes, which callers keep between calls.
 */
export function rankSimilar(
  count: number,
  shapesOf: (index: number) => NameShape[],
  name: string,
  limit: number,
  skip?: (index: number) => boolean,
): Scored[] {
  const target = new SimilarityTarget(name);
  if (target.empty || limit <= 0) return [];
  const best: Scored[] = [];
  for (let index = 0; index < count; index++) {
    if (skip?.(index)) continue;
    let score = 0;
    for (const shape of shapesOf(index)) score = Math.max(score, target.score(shape));
    if (score < MIN_SIMILARITY) continue;
    // Keep only the top `limit`, sorted, so a large guide never sorts in full.
    if (best.length === limit && score <= best[best.length - 1].score) continue;
    let at = best.length;
    while (at > 0 && best[at - 1].score < score) at--;
    best.splice(at, 0, { index, score });
    if (best.length > limit) best.pop();
  }
  return best;
}
