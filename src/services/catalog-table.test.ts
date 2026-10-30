import { describe, expect, it } from 'vitest';
import type { SeriesItem, VodItem } from '../types';
import {
  CatalogColumnsBuilder,
  CatalogTable,
  emptyCatalogTable,
  isCatalogColumns,
  sameCatalogColumns,
} from './catalog-table';

const movieOne: VodItem = {
  accountId: 'a1', streamId: '10', name: 'Alpha', poster: 'http://host/p/1.jpg',
  rating: '7.5', categoryId: '1', containerExtension: 'mkv', addedAt: 1700000000000, year: 2021,
};
const movieTwo: VodItem = {
  accountId: 'a1', streamId: '20', name: 'Bravo, "B" [2]', poster: 'http://host/p/2.jpg',
  rating: '', categoryId: '2', containerExtension: 'mp4',
};

function vodColumns(items: VodItem[]) {
  const builder = new CatalogColumnsBuilder('vod', 'a1');
  for (const item of items) builder.add({ ...item, id: item.streamId });
  return builder.build();
}

describe('catalog table', () => {
  it('gives back every movie field it was built from, and nothing it was not', () => {
    const table = new CatalogTable<VodItem>(vodColumns([movieOne, movieTwo]));
    expect(table.length).toBe(2);
    expect(table.item(0)).toEqual(movieOne);
    expect(table.item(1)).toEqual(movieTwo);
    expect(table.item(2)).toBeUndefined();
    expect([table.idAt(1), table.nameAt(1), table.categoryIdAt(1)]).toEqual(['20', 'Bravo, "B" [2]', '2']);
  });

  it('keeps series rows without a container extension', () => {
    const show: SeriesItem = {
      accountId: 'a1', seriesId: 's1', name: 'Charlie', poster: '', rating: '8', categoryId: '3', year: 1999,
    };
    const builder = new CatalogColumnsBuilder('series', 'a1');
    builder.add({ ...show, id: show.seriesId });
    const columns = builder.build();
    expect(columns.extensions).toBeNull();
    expect(new CatalogTable<SeriesItem>(columns).item(0)).toEqual(show);
  });

  it('keeps the first row of a repeated id and skips rows without one', () => {
    const builder = new CatalogColumnsBuilder('vod', 'a1');
    builder.add({ ...movieOne, id: '10' });
    builder.add({ ...movieOne, id: '10', categoryId: '9' });
    builder.add({ ...movieTwo, id: '' });
    expect(builder.length).toBe(1);
    expect(new CatalogTable<VodItem>(builder.build()).item(0)?.categoryId).toBe('1');
  });

  it('stores each poster directory once', () => {
    const columns = vodColumns([movieOne, movieTwo, { ...movieTwo, streamId: '30', poster: '' }]);
    expect(columns.posterBases).toEqual(['http://host/p/', '']);
    expect(columns.posterRest.text).toBe('1.jpg2.jpg');
    expect(new CatalogTable<VodItem>(columns).item(2)?.poster).toBe('');
  });

  it('narrows to a selection and maps view rows onto stored rows', () => {
    const table = new CatalogTable<VodItem>(vodColumns([movieOne, movieTwo]));
    expect(table.select(null)).toBe(table);
    const visible = table.select(item => item.streamId === '20');
    expect(visible.length).toBe(1);
    expect(visible.rows()).toEqual(new Uint32Array([1]));
    expect(visible.rowOf(0)).toBe(1);
    expect(visible.item(0)).toEqual(movieTwo);
    expect(visible.select(() => true).item(0)).toEqual(movieTwo);
  });

  it('is empty without columns', () => {
    const empty = emptyCatalogTable<VodItem>();
    expect(empty.length).toBe(0);
    expect(empty.item(0)).toBeUndefined();
  });

  it('recognizes only intact columns of the expected kind', () => {
    const columns = vodColumns([movieOne, movieTwo]);
    expect(isCatalogColumns(columns, 'vod')).toBe(true);
    expect(isCatalogColumns(columns, 'series')).toBe(false);
    expect(isCatalogColumns([movieOne], 'vod')).toBe(false);
    expect(isCatalogColumns({ ...columns, format: 0 }, 'vod')).toBe(false);
    expect(isCatalogColumns({ ...columns, names: { text: 'x', ends: new Uint32Array([1, 2]) } }, 'vod')).toBe(false);
    expect(isCatalogColumns({ ...columns, years: [2021, 0] }, 'vod')).toBe(false);
  });

  it('compares catalogs by content, treating absent dates alike', () => {
    const left = vodColumns([movieOne, movieTwo]);
    expect(sameCatalogColumns(left, vodColumns([movieOne, movieTwo]))).toBe(true);
    expect(sameCatalogColumns(left, vodColumns([movieOne, { ...movieTwo, name: 'Bravo' }]))).toBe(false);
    expect(sameCatalogColumns(left, vodColumns([movieOne, { ...movieTwo, addedAt: 1 }]))).toBe(false);
    expect(sameCatalogColumns(left, vodColumns([movieOne]))).toBe(false);
  });
});
