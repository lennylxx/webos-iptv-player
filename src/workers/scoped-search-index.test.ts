import { describe, expect, it } from 'vitest';
import { ScopedSearchIndex } from './scoped-search-index';

describe('ScopedSearchIndex', () => {
  it('keeps field and name indexes isolated by owner', () => {
    const index = new ScopedSearchIndex();
    index.indexList({
      owner: 'sidebar',
      sessionId: 1,
      mode: 'fields',
      documents: [['XAlpha', 'News'], ['Alpha', 'Drama']],
    });
    index.indexList({
      owner: 'epg',
      sessionId: 2,
      mode: 'names',
      documents: [['XAlpha'], ['Alpha']],
    });

    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 1,
      query: 'alpha',
    })?.indices).toEqual([1, 0]);
    expect(index.queryList({
      owner: 'epg',
      sessionId: 2,
      query: 'alpha',
    })?.indices).toEqual([1, 0]);
    expect(index.queryList({
      owner: 'epg',
      sessionId: 1,
      query: 'alpha',
    })).toBeNull();
  });

  it('releases only the matching list session', () => {
    const index = new ScopedSearchIndex();
    index.indexList({
      owner: 'sidebar',
      sessionId: 2,
      mode: 'names',
      documents: [['Alpha']],
    });

    expect(index.releaseList({
      owner: 'sidebar',
      sessionId: 1,
    }).accepted).toBe(false);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 2,
      query: 'alpha',
    })).not.toBeNull();
    expect(index.releaseList({
      owner: 'sidebar',
      sessionId: 2,
    }).accepted).toBe(true);
    expect(index.queryList({
      owner: 'sidebar',
      sessionId: 2,
      query: 'alpha',
    })).toBeNull();
  });

  it('preserves EPG mapping source and selected ordering', () => {
    const index = new ScopedSearchIndex();
    index.indexMapping({
      owner: 'mapping',
      sessionId: 3,
      documents: [
        {
          id: 'a',
          channelId: 'a',
          name: 'Bravo',
          fields: ['a', 'Bravo'],
          sourceIndex: 0,
        },
        {
          id: 'b',
          channelId: 'b',
          name: 'Alpha',
          fields: ['b', 'Alpha'],
          sourceIndex: 1,
        },
      ],
    });

    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 3,
      query: '',
      selectedId: '',
    })?.indices).toEqual([0, 1]);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 3,
      query: 'alpha',
      selectedId: 'a',
    })?.indices).toEqual([0, 1]);
  });

  it('answers a mapping search nothing contains with similar names after the selected one', () => {
    const index = new ScopedSearchIndex();
    const doc = (id: string, name: string) => ({ id, channelId: id, name, fields: [id, name.toLowerCase()], sourceIndex: 0 });
    index.indexMapping({
      owner: 'mapping',
      sessionId: 5,
      documents: [doc('g1', 'Delta Sports'), doc('g2', 'Al-pha HD'), doc('g3', 'Al-pha Two')],
    });
    const query = (text: string, selectedId: string, similarLimit?: number) =>
      index.queryMapping({ owner: 'mapping', sessionId: 5, query: text, selectedId, similarLimit });

    expect(query('alpha', '')).toEqual({ indices: [] });
    expect(query('alpha', '', 5)).toEqual({ indices: [1, 2], similar: true });
    expect(query('alpha', 'g1', 5)).toEqual({ indices: [0, 1, 2], similar: true });
    expect(query('al-pha', 'g1', 5)).toEqual({ indices: [0, 1, 2] });
    expect(query('zzzz', '', 5)).toEqual({ indices: [], similar: false });

    expect(index.similarMapping({ owner: 'mapping', sessionId: 5, name: 'UK: AL-PHA hd', limit: 1 }))
      .toEqual({ indices: [1], sameName: true });
    expect(index.similarMapping({ owner: 'mapping', sessionId: 5, name: 'Alpha Three', limit: 5 })?.sameName).toBe(false);
    expect(index.similarMapping({ owner: 'mapping', sessionId: 6, name: 'Alpha', limit: 5 })).toBeNull();
  });

  it('releases only the matching mapping session', () => {
    const index = new ScopedSearchIndex();
    index.indexMapping({
      owner: 'mapping',
      sessionId: 4,
      documents: [],
    });

    expect(index.releaseMapping({
      owner: 'mapping',
      sessionId: 3,
    }).accepted).toBe(false);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 4,
      query: '',
      selectedId: '',
    })).not.toBeNull();
    expect(index.releaseMapping({
      owner: 'mapping',
      sessionId: 4,
    }).accepted).toBe(true);
    expect(index.queryMapping({
      owner: 'mapping',
      sessionId: 4,
      query: '',
      selectedId: '',
    })).toBeNull();
  });
});
