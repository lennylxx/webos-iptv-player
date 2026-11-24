import { describe, expect, it } from 'vitest';
import { nameShape, nameSimilarity, rankSimilar, SAME_NAME, type NameShape } from './epg-guide-similarity';

function rank(fields: string[][], name: string, limit: number) {
  const shapes: NameShape[][] = fields.map(list => list.map(nameShape));
  return rankSimilar(shapes.length, index => shapes[index], name, limit);
}

describe('nameSimilarity', () => {
  it('sets aside quality tags, country prefixes, punctuation, and number words', () => {
    expect(nameSimilarity('Alpha One HD', 'alpha 1')).toBeGreaterThanOrEqual(SAME_NAME);
    expect(nameSimilarity('UK: Bravo', 'Bravo')).toBeGreaterThanOrEqual(SAME_NAME);
    expect(nameSimilarity('Charlie-News', 'charlie news')).toBeGreaterThanOrEqual(SAME_NAME);
  });

  it('keeps a brand prefix that is not a language or country code', () => {
    expect(nameSimilarity('QRZ: News', 'QRZ News')).toBeGreaterThan(nameSimilarity('QRZ: News', 'News'));
  });

  it('compares names in other scripts and one-letter names', () => {
    expect(nameSimilarity('甲乙台', '甲乙台 HD')).toBeGreaterThanOrEqual(SAME_NAME);
    expect(nameSimilarity('甲乙台', '丙丁台')).toBeLessThan(0.35);
    expect(nameSimilarity('Q', 'q')).toBeGreaterThanOrEqual(SAME_NAME);
    expect(nameSimilarity('Q', 'R')).toBe(0);
  });

  it('scores unrelated names low', () => {
    expect(nameSimilarity('Alpha', 'Delta Sports')).toBeLessThan(0.35);
  });
});

describe('rankSimilar', () => {
  it('ranks entries by their most alike field, best first, and drops unlike ones', () => {
    const ranked = rank([
      ['delta.sports', 'Delta Sports'],
      ['alpha.two', 'Alpha 2'],
      ['alpha.one', 'Alpha 1'],
      ['bravo', 'Bravo', 'Alpha One Plus'],
    ], 'Alpha One HD', 10);
    expect(ranked.map(item => item.index)).toEqual([2, 3, 1]);
    expect(ranked[0].score).toBeGreaterThanOrEqual(SAME_NAME);
    expect(rank([['alpha.one', 'Alpha 1'], ['alpha.two', 'Alpha 2']], 'Alpha One', 1)).toHaveLength(1);
  });

  it('finds nothing for a name of only tags', () => {
    expect(rank([['alpha']], 'HD', 5)).toEqual([]);
  });

  it('ranks a large guide quickly', () => {
    const shapes: NameShape[][] = [];
    for (let i = 0; i < 50000; i++) shapes.push([nameShape(`ch${i}.l1`), nameShape(`Channel ${i} Alpha`)]);
    const started = Date.now();
    rankSimilar(shapes.length, index => shapes[index], 'Channel 4242 Alpha HD', 50);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
