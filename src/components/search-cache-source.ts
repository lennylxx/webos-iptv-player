import type { Channel, SeriesItem, VodItem } from '../types';
import type { CatalogTable } from '../services/catalog-table';
import { cacheRecordRef } from '../services/idb-cache';
import type { ChannelCacheSource } from '../services/playlist-service';
import type { ProgrammeCacheOrigin } from '../services/epg-service';
import type {
  SearchCacheRecord,
  SearchCachedChannels,
  SearchCachedNames,
  SearchCachedProgrammes,
  SearchDocumentSamples,
} from '../workers/tasks';

// Builds the compact selections that let the app worker read Search documents
// from IndexedDB instead of receiving every string through postMessage.

const SAMPLE_COUNT = 8;

export function channelDocument(channel: Channel): string[] {
  return [channel.name, channel.group, channel.sourceName ?? ''];
}

export function sampleDocuments(
  count: number,
  documentAt: (index: number) => string[],
): SearchDocumentSamples {
  const indices: number[] = [];
  const documents: string[][] = [];
  if (count <= 0) return { indices, documents };
  const step = count <= SAMPLE_COUNT ? 1 : (count - 1) / (SAMPLE_COUNT - 1);
  for (let i = 0; i < Math.min(count, SAMPLE_COUNT); i++) {
    const index = Math.round(i * step);
    indices.push(index);
    documents.push(documentAt(index));
  }
  return { indices, documents };
}

export function cachedChannelsRequest(
  channels: Channel[],
  source: ChannelCacheSource | null,
): SearchCachedChannels | null {
  if (!source || source.selection.length !== channels.length) return null;
  const overrideIndices: number[] = [];
  const overrides: string[][] = [];
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    if (channel.sourceName === undefined && channel.sourceGroup === undefined) continue;
    overrideIndices.push(i);
    overrides.push(channelDocument(channel));
  }
  return {
    record: source.record,
    length: source.length,
    selection: source.selection,
    overrideIndices,
    overrides,
    samples: sampleDocuments(channels.length, index => channelDocument(channels[index])),
  };
}

/** The visible rows of a catalog; without concealment the table is kept whole. */
export function selectCatalogItems<T extends VodItem | SeriesItem>(
  table: CatalogTable<T>,
  concealing: boolean,
  concealed: (item: T) => boolean,
): CatalogTable<T> {
  return table.select(concealing ? (item: T) => !concealed(item) : null);
}

export function cachedNamesRequest(table: CatalogTable<VodItem | SeriesItem>): SearchCachedNames | null {
  const columns = table.columns;
  const record = columns ? cacheRecordRef(columns) : null;
  if (!columns || !record || record.store !== 'catalog-cache') return null;
  return {
    record,
    length: columns.length,
    selection: table.rows(),
    samples: sampleDocuments(table.length, index => [table.nameAt(index)]),
  };
}

/** One channel's programme list per run, in program-index order. */
export class ProgrammeRuns {
  private readonly records: SearchCacheRecord[] = [];
  private readonly recordIndex = new Map<string, number>();
  private readonly channels: number[] = [];
  private readonly recordIndices: number[] = [];
  private readonly ids: string[] = [];
  private readonly counts: number[] = [];
  private complete = true;

  add(channelIndex: number, cached: ProgrammeCacheOrigin | null, count: number): void {
    if (!this.complete) return;
    if (!cached) {
      this.complete = false;
      return;
    }
    let record = this.recordIndex.get(cached.url);
    if (record === undefined) {
      record = this.records.length;
      this.records.push({ store: 'epg-cache', key: cached.url, timestamp: cached.timestamp });
      this.recordIndex.set(cached.url, record);
    } else if (this.records[record].timestamp !== cached.timestamp) {
      this.complete = false;
      return;
    }
    this.channels.push(channelIndex);
    this.recordIndices.push(record);
    this.ids.push(cached.id);
    this.counts.push(count);
  }

  request(samples: SearchDocumentSamples): SearchCachedProgrammes | null {
    if (!this.complete) return null;
    return {
      records: this.records,
      runChannels: new Uint32Array(this.channels),
      runRecords: new Uint32Array(this.recordIndices),
      runIds: this.ids,
      runCounts: new Uint32Array(this.counts),
      samples,
    };
  }
}
