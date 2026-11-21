import {
  indexGuideChannelName,
  matchGuideChannel,
  splitEpgChannelKey,
  type GuideMatchLookup,
} from '../services/epg-channel-match';
import { SearchCacheError } from './search-cache-reader';
import {
  NAME_SEPARATOR,
  PLAYLIST_FIELD,
  sourceIndexValue,
  type SourceIndex,
} from './search-source-index';
import type {
  SearchCacheRecord,
  SearchCachedChannels,
  SearchCachedProgrammes,
  SearchGuideProgrammes,
} from './tasks';

/** The playlist index and selection the worker's channel documents came from. */
export interface CachedChannelSource {
  index: SourceIndex;
  request: SearchCachedChannels;
}

interface LoadedGuide {
  record: number;
  counts: Map<string, number>;
  channels: Set<string>;
  names: Map<string, string[]>;
}

function loadedGuide(index: SourceIndex, record: number): LoadedGuide {
  const { runIds, runCounts, channelIds, channelNames } = index;
  if (!runIds || !runCounts || !channelIds || !channelNames) throw new SearchCacheError('record_invalid');
  const counts = new Map<string, number>();
  for (let i = 0; i < runIds.length; i++) counts.set(runIds[i], runCounts[i]);
  const names = new Map<string, string[]>();
  for (let i = 0; i < channelIds.length; i++) {
    for (const name of channelNames[i].split(NAME_SEPARATOR)) indexGuideChannelName(names, name, channelIds[i]);
  }
  return { record, counts, channels: new Set(channelIds), names };
}

/**
 * Matches every cached channel to its guide channel as the page's EpgService
 * does and returns the programme runs in channel order. Throws when the
 * page's own sample matches disagree, so the page matches them itself.
 */
export function matchGuideRuns(
  channels: CachedChannelSource,
  request: SearchGuideProgrammes,
  guides: Array<SourceIndex | null>,
): SearchCachedProgrammes {
  if (guides.length !== request.sources.length) throw new SearchCacheError('runs_invalid');
  const records: SearchCacheRecord[] = [];
  const byUrl = new Map<string, LoadedGuide>();
  request.sources.forEach((source, i) => {
    const index = guides[i];
    if (!source.record || !index) return;
    byUrl.set(source.url, loadedGuide(index, records.length));
    records.push(source.record);
  });
  const at = (key: string): { guide: LoadedGuide; id: string } | null => {
    const split = splitEpgChannelKey(key);
    const guide = split && byUrl.get(split.url);
    return guide ? { guide, id: split.id } : null;
  };
  const lookup: GuideMatchLookup = {
    sources: () => request.sources,
    hasChannel: (key) => {
      const found = at(key);
      return !!found && found.guide.channels.has(found.id);
    },
    programmeCount: (key) => {
      const found = at(key);
      return found ? found.guide.counts.get(found.id) ?? 0 : 0;
    },
    idsByName: (url, name) => {
      const guide = byUrl.get(url);
      return guide ? guide.names.get(name) ?? [] : undefined;
    },
  };

  const { index, request: cached } = channels;
  const renamed = new Map<number, string[]>();
  for (let i = 0; i < cached.overrideIndices.length; i++) {
    renamed.set(cached.overrideIndices[i], cached.overrides[i]);
  }
  const mappings = new Map<number, string>(request.mappings);
  const sampled = new Map<number, [string, number]>();
  for (const [channel] of request.samples) sampled.set(channel, ['', 0]);

  const runChannels: number[] = [];
  const runRecords: number[] = [];
  const runIds: string[] = [];
  const runCounts: number[] = [];
  const selection = cached.selection;
  for (let i = 0; i < selection.length; i++) {
    const item = selection[i];
    if (item >= index.length) throw new SearchCacheError('selection_out_of_range');
    const document = renamed.get(i);
    const tvgId = sourceIndexValue(index, item, PLAYLIST_FIELD.tvgId);
    const playlistIds = sourceIndexValue(index, item, PLAYLIST_FIELD.playlistIds);
    // Matching compares lower-case names only.
    const name = document
      ? document[0]
      : sourceIndexValue(index, item, PLAYLIST_FIELD.lowerName) || sourceIndexValue(index, item, 0);
    const base = matchGuideChannel(
      {
        id: tvgId || undefined,
        name,
        sourceName: document ? document[2] || undefined : undefined,
        playlistIds: playlistIds ? playlistIds.split(NAME_SEPARATOR) : [],
      },
      mappings.get(i),
      lookup,
    );
    const found = base ? at(base) : null;
    if (!base || !found) continue;
    const count = found.guide.counts.get(found.id) ?? 0;
    if (sampled.has(i)) sampled.set(i, [base, count]);
    // A saved mapping may name a guide channel with no programmes.
    if (!count) continue;
    runChannels.push(i);
    runRecords.push(found.guide.record);
    runIds.push(found.id);
    runCounts.push(count);
  }
  for (const [channel, key, count] of request.samples) {
    const actual = sampled.get(channel);
    if (channel >= selection.length || !actual || actual[0] !== key || actual[1] !== count) {
      throw new SearchCacheError('sample_mismatch');
    }
  }
  return {
    records,
    runChannels: new Uint32Array(runChannels),
    runRecords: new Uint32Array(runRecords),
    runIds,
    runCounts: new Uint32Array(runCounts),
    samples: { indices: [], documents: [] },
  };
}

