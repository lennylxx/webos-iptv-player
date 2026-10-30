import {
  cacheRecordTimestamp,
  CATALOG_STORE,
  EPG_STORE,
  PLAYLIST_STORE,
} from '../services/idb-schema';
import { isCatalogColumns, packedValue } from '../services/catalog-table';
import { foldSearchText } from '../utils/channel-search';
import { SearchCacheError, type CachedRecord } from './search-cache-reader';
import type { SearchCacheRecord, SearchIndexCandidate } from './tasks';

// Bump whenever the stored layout or the folding it holds changes.
export const SEARCH_INDEX_FORMAT = 1;

/**
 * The folded search text of one source cache record, in record order and
 * independent of customization or parental selection. Every value lives in
 * one string; `ends[item * fields + field]` is where that value ends.
 */
export interface SourceIndex {
  key: string;
  prefix: string;
  sourceStore: SearchCacheRecord['store'];
  sourceKey: string;
  sourceTimestamp: number;
  format: number;
  length: number;
  fields: number;
  text: string;
  ends: Uint32Array;
  /** EPG only: each channel id's programme count, in record order. */
  runIds?: string[];
  runCounts?: Uint32Array;
}

type Fields = Record<string, unknown>;

const FIELDS: Record<SearchCacheRecord['store'], number> = {
  [PLAYLIST_STORE]: 2,
  [EPG_STORE]: 3,
  [CATALOG_STORE]: 1,
};

export function sourceIndexPrefix(store: string, key: string): string {
  return `${store}|${key}|`;
}

export function sourceIndexKey(ref: SearchCacheRecord): string {
  return `${sourceIndexPrefix(ref.store, ref.key)}${String(ref.timestamp)}|v${String(SEARCH_INDEX_FORMAT)}`;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new SearchCacheError('record_invalid');
  return value;
}

function fieldsOf(item: unknown): Fields {
  if (!item || typeof item !== 'object') throw new SearchCacheError('record_invalid');
  return item as Fields;
}

function listOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SearchCacheError('record_invalid');
  return value;
}

export function buildSourceIndex(ref: SearchCacheRecord, raw: CachedRecord | null): SourceIndex {
  if (!raw) throw new SearchCacheError('record_missing');
  if (cacheRecordTimestamp(raw) !== ref.timestamp) throw new SearchCacheError('record_changed');
  const data: unknown = raw.data;
  const values: string[] = [];
  let length = 0;
  let runIds: string[] | undefined;
  let runCounts: number[] | undefined;
  if (ref.store === PLAYLIST_STORE) {
    const channels = listOf(data && (data as Fields).channels);
    for (const item of channels) {
      const channel = fieldsOf(item);
      values.push(
        foldSearchText(text(channel.sourceName ?? channel.name)),
        foldSearchText(text(channel.sourceGroup ?? channel.group)),
      );
    }
    length = channels.length;
  } else if (ref.store === EPG_STORE) {
    const programmes = fieldsOf(data && (data as Fields).programmes);
    runIds = [];
    runCounts = [];
    for (const id in programmes) {
      if (!Object.prototype.hasOwnProperty.call(programmes, id)) continue;
      const list = listOf(programmes[id]);
      for (const item of list) {
        const programme = fieldsOf(item);
        values.push(
          foldSearchText(text(programme.title)),
          foldSearchText(text(programme.category)),
          foldSearchText(text(programme.description)),
        );
      }
      runIds.push(id);
      runCounts.push(list.length);
      length += list.length;
    }
  } else if (isCatalogColumns(data, 'vod') || isCatalogColumns(data, 'series')) {
    for (let i = 0; i < data.length; i++) values.push(foldSearchText(packedValue(data.names, i)));
    length = data.length;
  } else {
    const items = listOf(data);
    for (const item of items) values.push(foldSearchText(text(fieldsOf(item).name)));
    length = items.length;
  }
  const ends = new Uint32Array(values.length);
  let end = 0;
  for (let i = 0; i < values.length; i++) {
    end += values[i].length;
    ends[i] = end;
  }
  const index: SourceIndex = {
    key: sourceIndexKey(ref),
    prefix: sourceIndexPrefix(ref.store, ref.key),
    sourceStore: ref.store,
    sourceKey: ref.key,
    sourceTimestamp: ref.timestamp,
    format: SEARCH_INDEX_FORMAT,
    length,
    fields: FIELDS[ref.store],
    text: values.join(''),
    ends,
  };
  if (runIds && runCounts) {
    index.runIds = runIds;
    index.runCounts = new Uint32Array(runCounts);
  }
  return index;
}

// A stored index for another record version, format, or of a broken shape
// is treated as absent, so the caller rebuilds it from the source record.
export function parseSourceIndex(ref: SearchCacheRecord, raw: CachedRecord | null): SourceIndex | null {
  if (!raw) return null;
  const index = raw as unknown as SourceIndex;
  const fields = FIELDS[ref.store];
  if (index.key !== sourceIndexKey(ref)
      || index.format !== SEARCH_INDEX_FORMAT
      || index.sourceStore !== ref.store
      || index.sourceKey !== ref.key
      || index.sourceTimestamp !== ref.timestamp
      || index.fields !== fields
      || typeof index.text !== 'string'
      || typeof index.length !== 'number'
      || !(index.ends instanceof Uint32Array)
      || index.ends.length !== index.length * fields
      || (index.ends.length ? index.ends[index.ends.length - 1] : 0) !== index.text.length) {
    return null;
  }
  if (ref.store === EPG_STORE) {
    const { runIds, runCounts } = index;
    if (!Array.isArray(runIds) || !(runCounts instanceof Uint32Array)
        || runIds.length !== runCounts.length) {
      return null;
    }
    let total = 0;
    for (let i = 0; i < runCounts.length; i++) total += runCounts[i];
    if (total !== index.length) return null;
  }
  return {
    key: index.key,
    prefix: sourceIndexPrefix(ref.store, ref.key),
    sourceStore: ref.store,
    sourceKey: ref.key,
    sourceTimestamp: ref.timestamp,
    format: SEARCH_INDEX_FORMAT,
    length: index.length,
    fields,
    text: index.text,
    ends: index.ends,
    ...(ref.store === EPG_STORE ? { runIds: index.runIds, runCounts: index.runCounts } : {}),
  };
}

export function sourceIndexValue(index: SourceIndex, item: number, field: number): string {
  const position = item * index.fields + field;
  return index.text.slice(position ? index.ends[position - 1] : 0, index.ends[position]);
}

export function sourceIndexRecord(index: SourceIndex): CachedRecord {
  const record: CachedRecord = {
    key: index.key,
    sourceStore: index.sourceStore,
    sourceKey: index.sourceKey,
    sourceTimestamp: index.sourceTimestamp,
    format: index.format,
    length: index.length,
    fields: index.fields,
    text: index.text,
    ends: index.ends,
  };
  if (index.runIds && index.runCounts) {
    record.runIds = index.runIds;
    record.runCounts = index.runCounts;
  }
  return record;
}

export function sourceIndexCandidate(index: SourceIndex): SearchIndexCandidate {
  let bytes = 256 + index.text.length * 2 + index.ends.byteLength;
  if (index.runIds && index.runCounts) {
    for (const id of index.runIds) bytes += id.length * 2 + 8;
    bytes += index.runCounts.byteLength;
  }
  return { key: index.key, prefix: index.prefix, bytes };
}
