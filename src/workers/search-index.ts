import {
  prepareNameSearchItems,
  prepareSearchItem,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import type {
  SearchIndexRequest,
  SearchIndexResponse,
  SearchQueryRequest,
  SearchQueryResponse,
  SearchRankedIndices,
} from './tasks';

interface IndexedName {
  index: number;
  name: string;
}

export class SearchWorkerIndex {
  private sessionId: number | null = null;
  private channels: PreparedSearchItem<number>[] = [];
  private programmes: PreparedSearchItem<number>[] = [];
  private movies: PreparedNameSearchIndex<IndexedName> = { items: [], values: [] };
  private series: PreparedNameSearchIndex<IndexedName> = { items: [], values: [] };

  index(request: SearchIndexRequest): SearchIndexResponse {
    if (request.reset) {
      this.sessionId = request.sessionId;
      this.channels = [];
      this.programmes = [];
      this.movies = { items: [], values: [] };
      this.series = { items: [], values: [] };
    } else if (request.sessionId !== this.sessionId) {
      return { accepted: false };
    }

    if (request.channels) this.channels = prepareFields(request.channels);
    if (request.programmes) this.programmes = prepareFields(request.programmes);
    if (request.movies) this.movies = prepareNames(request.movies);
    if (request.series) this.series = prepareNames(request.series);
    return { accepted: true };
  }

  query(request: SearchQueryRequest): SearchQueryResponse | null {
    if (request.sessionId !== this.sessionId) return null;
    return {
      channels: rankedFields(this.channels, request.query, request.limit),
      programmes: rankedFields(this.programmes, request.query, request.limit),
      movies: request.includeCatalog
        ? rankedNames(this.movies, request.query, request.limit)
        : emptyResult(),
      series: request.includeCatalog
        ? rankedNames(this.series, request.query, request.limit)
        : emptyResult(),
    };
  }
}

function prepareFields(documents: string[][]): PreparedSearchItem<number>[] {
  return documents.map((fields, index) => prepareSearchItem(index, () => fields));
}

function prepareNames(names: string[]): PreparedNameSearchIndex<IndexedName> {
  return prepareNameSearchItems(names.map((name, index) => ({ index, name })));
}

function rankedFields(
  index: PreparedSearchItem<number>[],
  query: string,
  limit: number,
): SearchRankedIndices {
  const result = rankPreparedTopK(index, query, limit);
  return { indices: result.items, hasMore: result.hasMore };
}

function rankedNames(
  index: PreparedNameSearchIndex<IndexedName>,
  query: string,
  limit: number,
): SearchRankedIndices {
  const result = rankPreparedNamesTopK(index, query, limit);
  return {
    indices: result.items.map(item => item.index),
    hasMore: result.hasMore,
  };
}

function emptyResult(): SearchRankedIndices {
  return { indices: [], hasMore: false };
}
