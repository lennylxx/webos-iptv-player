import { describe, expect, it } from 'vitest';
import { SearchWorkerIndex } from './search-index';

describe('SearchWorkerIndex', () => {
  it('indexes and ranks every search collection', () => {
    const index = new SearchWorkerIndex();
    expect(index.index({
      sessionId: 1,
      reset: true,
      channels: [['XAlpha', 'News'], ['Alpha', 'Drama']],
      programmes: [['Evening Report', 'News'], ['Alpha Report', 'Drama']],
      movies: ['XAlpha Movie', 'Alpha Movie'],
      series: ['XAlpha Series', 'Alpha Series'],
    })).toEqual({ accepted: true });

    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 10,
      includeCatalog: true,
    })).toEqual({
      channels: { indices: [1, 0], hasMore: false },
      programmes: { indices: [1], hasMore: false },
      movies: { indices: [1, 0], hasMore: false },
      series: { indices: [1, 0], hasMore: false },
    });
  });

  it('rejects stale index updates and queries', () => {
    const index = new SearchWorkerIndex();
    index.index({ sessionId: 2, reset: true, channels: [['Alpha']] });

    expect(index.index({ sessionId: 1, channels: [['Bravo']] }))
      .toEqual({ accepted: false });
    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 10,
      includeCatalog: false,
    })).toBeNull();
    expect(index.query({
      sessionId: 2,
      query: 'alpha',
      limit: 10,
      includeCatalog: false,
    })?.channels.indices).toEqual([0]);
  });

  it('caps results and reports additional matches', () => {
    const index = new SearchWorkerIndex();
    index.index({
      sessionId: 1,
      reset: true,
      movies: ['Alpha 1', 'Alpha 2', 'Alpha 3'],
    });

    expect(index.query({
      sessionId: 1,
      query: 'alpha',
      limit: 2,
      includeCatalog: true,
    })?.movies).toEqual({ indices: [0, 1], hasMore: true });
  });
});
