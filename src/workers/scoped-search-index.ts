import {
  prepareNameSearchItems,
  prepareSearchItem,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import type {
  ListSearchIndexRequest,
  ListSearchQueryRequest,
  MappingSearchDocument,
  MappingSearchIndexRequest,
  MappingSearchQueryRequest,
  ScopedSearchReleaseRequest,
  SearchIndexResponse,
  SearchRankedIndices,
} from './tasks';

interface IndexedName {
  index: number;
  name: string;
}

type ListIndex =
  | { mode: 'fields'; index: PreparedSearchItem<number>[] }
  | { mode: 'names'; index: PreparedNameSearchIndex<IndexedName> };

interface ListState {
  sessionId: number;
  index: ListIndex;
}

interface PreparedMappingDocument extends MappingSearchDocument {
  normalizedFields: string[];
}

interface MappingState {
  sessionId: number;
  documents: PreparedMappingDocument[];
}

export class ScopedSearchIndex {
  private lists = new Map<string, ListState>();
  private mappings = new Map<string, MappingState>();

  indexList(request: ListSearchIndexRequest): SearchIndexResponse {
    const index: ListIndex = request.mode === 'fields'
      ? {
          mode: 'fields',
          index: request.documents.map((fields, itemIndex) =>
            prepareSearchItem(itemIndex, () => fields)),
        }
      : {
          mode: 'names',
          index: prepareNameSearchItems(request.documents.map((fields, itemIndex) => ({
            index: itemIndex,
            name: fields[0] ?? '',
          }))),
        };
    this.lists.set(request.owner, { sessionId: request.sessionId, index });
    return { accepted: true };
  }

  queryList(request: ListSearchQueryRequest): SearchRankedIndices | null {
    const state = this.lists.get(request.owner);
    if (!state || state.sessionId !== request.sessionId) return null;
    if (state.index.mode === 'fields') {
      const result = rankPreparedTopK(
        state.index.index,
        request.query,
        state.index.index.length,
      );
      return { indices: result.items, hasMore: result.hasMore };
    }
    const result = rankPreparedNamesTopK(
      state.index.index,
      request.query,
      state.index.index.items.length,
    );
    return {
      indices: result.items.map(item => item.index),
      hasMore: result.hasMore,
    };
  }

  releaseList(request: ScopedSearchReleaseRequest): SearchIndexResponse {
    const state = this.lists.get(request.owner);
    if (!state || state.sessionId !== request.sessionId) {
      return { accepted: false };
    }
    this.lists.delete(request.owner);
    return { accepted: true };
  }

  indexMapping(request: MappingSearchIndexRequest): SearchIndexResponse {
    this.mappings.set(request.owner, {
      sessionId: request.sessionId,
      documents: request.documents.map(document => ({
        ...document,
        normalizedFields: document.fields.map(field => field.toLowerCase()),
      })),
    });
    return { accepted: true };
  }

  queryMapping(request: MappingSearchQueryRequest): SearchRankedIndices | null {
    const state = this.mappings.get(request.owner);
    if (!state || state.sessionId !== request.sessionId) return null;
    const normalized = request.query.trim().toLowerCase();
    const scored: Array<{ index: number; score: number }> = [];
    for (let index = 0; index < state.documents.length; index++) {
      const document = state.documents[index];
      const selected = document.id === request.selectedId;
      let exact = false;
      let prefix = false;
      let position = -1;
      if (normalized) {
        for (const field of document.normalizedFields) {
          const next = field.indexOf(normalized);
          if (next < 0) continue;
          if (position < 0 || next < position) position = next;
          if (next === 0) prefix = true;
          if (field === normalized) exact = true;
        }
        if (position < 0 && !selected) continue;
      }
      scored.push({
        index,
        score: selected
          ? -1
          : normalized
            ? (exact ? 0 : prefix ? 100 : 200) + Math.max(0, position)
              + document.sourceIndex * 1000
            : document.sourceIndex * 1000,
      });
    }
    scored.sort((a, b) => {
      const left = state.documents[a.index];
      const right = state.documents[b.index];
      return a.score - b.score || left.name.localeCompare(right.name)
        || left.channelId.localeCompare(right.channelId);
    });
    return {
      indices: scored.map(item => item.index),
      hasMore: false,
    };
  }

  releaseMapping(request: ScopedSearchReleaseRequest): SearchIndexResponse {
    const state = this.mappings.get(request.owner);
    if (!state || state.sessionId !== request.sessionId) {
      return { accepted: false };
    }
    this.mappings.delete(request.owner);
    return { accepted: true };
  }
}
