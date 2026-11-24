import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistEntry, VodItem } from '../../types';

const { catalogMock } = vi.hoisted(() => ({
  catalogMock: {
    loadVodCategories: vi.fn(),
    loadSeriesCategories: vi.fn(),
    loadVodStreams: vi.fn(),
    loadSeries: vi.fn(),
  },
}));
vi.mock('../xtream-catalog', () => catalogMock);

import { ParentalControlService } from '../parental-control';
import { askCatalogCategories, askMovies } from './catalog-source';

const account: PlaylistEntry = {
  id: 'x1', name: 'X', url: 'http://host:8080', source: 'xtream', xtream: { username: 'u', password: 'p' },
};
const vod = (id: string, categoryId: string): VodItem => ({
  accountId: 'x1', streamId: id, name: `Movie ${id}`, poster: '', rating: '', categoryId, containerExtension: 'mp4',
});
const signal = new AbortController().signal;

describe('catalog-source', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never names a locked category, whatever the session', async () => {
    catalogMock.loadVodCategories.mockResolvedValue([{ id: '1', name: 'Cat A' }, { id: '2', name: 'Cat B' }]);
    catalogMock.loadSeriesCategories.mockResolvedValue([]);
    vi.spyOn(ParentalControlService, 'enabled', 'get').mockReturnValue(true);
    vi.spyOn(ParentalControlService, 'concealing', 'get').mockReturnValue(false);
    vi.spyOn(ParentalControlService, 'parentsLocked').mockImplementation(parents => (
      parents.some(parent => parent.kind !== 'live-group' && parent.categoryId === '2')
    ));
    expect((await askCatalogCategories(account, signal)).names).toEqual(['Cat A']);
  });

  it('filters the catalog Search holds without loading it again', async () => {
    const categories = { names: ['Cat A'], movies: new Map([['Cat A', ['1']]]), series: new Map() };
    const movies = await askMovies(account, categories, ['Cat A'], [vod('10', '1'), vod('11', '2')], signal);
    expect(movies.map(item => item.streamId)).toEqual(['10']);
    expect(catalogMock.loadVodStreams).not.toHaveBeenCalled();
  });

  it('keeps the other categories when one fails, loading a few at a time', async () => {
    let active = 0;
    let peak = 0;
    catalogMock.loadVodStreams.mockImplementation(async (_account: unknown, id: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      if (id === '2') throw new Error('Network');
      return [vod(`1${id}`, id)];
    });
    const categories = { names: ['Cat A'], movies: new Map([['Cat A', ['1', '2', '3', '4']]]), series: new Map() };
    const movies = await askMovies(account, categories, ['Cat A'], null, signal);
    expect(movies.map(item => item.streamId)).toEqual(['11', '13', '14']);
    expect(peak).toBe(2);
  });
});
