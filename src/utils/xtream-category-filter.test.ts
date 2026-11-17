import { describe, expect, it } from 'vitest';
import {
  createLiveCategoryMatcher,
  filterLiveStreams,
  createGroupNameMatcher,
  liveCategoryCounts,
  liveCategoryGroupFilter,
  newLiveCategoryIds,
  normalizeGroupName,
  normalizeLiveCategoryFilter,
} from './xtream-category-filter';

describe('normalizeLiveCategoryFilter', () => {
  it('accepts include and exclude filters, deduplicating ids', () => {
    expect(normalizeLiveCategoryFilter({ mode: 'include', ids: ['c1', 2, 'c1', ''] }))
      .toEqual({ mode: 'include', ids: ['c1', '2'] });
    expect(normalizeLiveCategoryFilter({ mode: 'exclude', ids: ['c2'] }))
      .toEqual({ mode: 'exclude', ids: ['c2'] });
  });

  it('treats invalid or empty values as no filter', () => {
    expect(normalizeLiveCategoryFilter(undefined)).toBeUndefined();
    expect(normalizeLiveCategoryFilter('c1')).toBeUndefined();
    expect(normalizeLiveCategoryFilter({ mode: 'other', ids: ['c1'] })).toBeUndefined();
    expect(normalizeLiveCategoryFilter({ mode: 'include', ids: [] })).toBeUndefined();
    expect(normalizeLiveCategoryFilter({ mode: 'exclude', ids: 'c1' })).toBeUndefined();
  });
});

describe('createLiveCategoryMatcher', () => {
  it('keeps everything without a filter', () => {
    expect(createLiveCategoryMatcher(undefined)([])).toBe(true);
  });

  it('keeps a stream in include mode when any of its categories is listed', () => {
    const keep = createLiveCategoryMatcher({ mode: 'include', ids: ['c1'] });
    expect(keep(['c2', 'c1'])).toBe(true);
    expect(keep(['c2'])).toBe(false);
    expect(keep([])).toBe(false);
  });

  it('drops a stream in exclude mode only when every category is listed', () => {
    const keep = createLiveCategoryMatcher({ mode: 'exclude', ids: ['c1', 'c2'] });
    expect(keep(['c1', 'c2'])).toBe(false);
    expect(keep(['c1', 'c3'])).toBe(true);
    expect(keep([])).toBe(true);
  });
});

describe('stream helpers', () => {
  const streams = [
    { name: 'ch1', categoryIds: ['c1'] },
    { name: 'ch2', categoryIds: ['c2', 'c1'] },
    { name: 'ch3', categoryIds: ['c3'] },
  ];

  it('filters streams and counts every category a stream belongs to', () => {
    expect(filterLiveStreams({ mode: 'include', ids: ['c1'] }, streams).map(s => s.name))
      .toEqual(['ch1', 'ch2']);
    expect(filterLiveStreams(undefined, streams)).toHaveLength(3);
    expect(liveCategoryCounts(streams)).toEqual({ c1: 2, c2: 1, c3: 1 });
  });
});

describe('newLiveCategoryIds', () => {
  const snapshot = { knownIds: ['c1', 'c2'], announcedIds: [], counts: {} };

  it('reports unseen, unselected categories in include mode', () => {
    expect(newLiveCategoryIds({ mode: 'include', ids: ['c1', 'c4'] }, snapshot, ['c1', 'c2', 'c3', 'c4', 'c3']))
      .toEqual(['c3']);
  });

  it('reports nothing without a snapshot, without a filter, or in exclude mode', () => {
    expect(newLiveCategoryIds({ mode: 'include', ids: ['c1'] }, null, ['c3'])).toEqual([]);
    expect(newLiveCategoryIds(undefined, snapshot, ['c3'])).toEqual([]);
    expect(newLiveCategoryIds({ mode: 'exclude', ids: ['c1'] }, snapshot, ['c3'])).toEqual([]);
  });
});

describe('group-name fallback', () => {
  const categories = [
    { id: 'c1', name: '  Alpha   News ' },
    { id: 'c2', name: 'Bravo' },
  ];

  it('normalizes names for matching', () => {
    expect(normalizeGroupName('  Alpha   NEWS ')).toBe('alpha news');
  });

  it('maps listed ids to group names and keeps groups by mode', () => {
    const include = liveCategoryGroupFilter({ mode: 'include', ids: ['c1'] }, categories)!;
    expect(include).toEqual({ mode: 'include', names: ['alpha news'] });
    expect(createGroupNameMatcher(include)('ALPHA NEWS')).toBe(true);
    expect(createGroupNameMatcher(include)('Bravo')).toBe(false);
    const exclude = liveCategoryGroupFilter({ mode: 'exclude', ids: ['c2'] }, categories)!;
    expect(createGroupNameMatcher(exclude)('bravo')).toBe(false);
    expect(createGroupNameMatcher(exclude)('Charlie')).toBe(true);
  });

  it('keeps nothing for an include filter whose ids all left the catalog', () => {
    const include = liveCategoryGroupFilter({ mode: 'include', ids: ['c9'] }, categories)!;
    expect(include).toEqual({ mode: 'include', names: [] });
    expect(createGroupNameMatcher(include)('Alpha news')).toBe(false);
  });

  it('matches group names without scanning the name list per channel', () => {
    const filter = liveCategoryGroupFilter({ mode: 'include', ids: ['c1'] }, categories)!;
    const keep = createGroupNameMatcher(filter);
    filter.names.indexOf = () => { throw new Error('linear scan'); };
    expect(keep('Alpha news')).toBe(true);
    expect(keep('Bravo')).toBe(false);
  });

  it('answers the same for repeated names and past its cache cap', () => {
    const groups: string[] = [];
    for (let i = 0; i < 6000; i++) groups.push((i % 3 ? ' Group ' : 'GROUP  ') + String(i % 5000));
    for (const mode of ['include', 'exclude'] as const) {
      const filter = { mode, names: ['group 1', 'group 4999', 'group 2500'] };
      const keep = createGroupNameMatcher(filter);
      for (let pass = 0; pass < 2; pass++) {
        for (const group of groups) {
          expect(keep(group)).toBe(filter.names.indexOf(normalizeGroupName(group)) >= 0 === (mode === 'include'));
        }
      }
    }
  });

  it('returns null when the category list is unavailable', () => {
    expect(liveCategoryGroupFilter({ mode: 'include', ids: ['c1'] }, [])).toBeNull();
  });
});
