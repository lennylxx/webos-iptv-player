import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelCustomizationService } from '../services/channel-customization';
import type { Channel, ChannelOverride, EpgSource, ParsedEpg, Programme } from '../types';

const { guides, overrides } = vi.hoisted(() => ({
  guides: new Map<string, unknown>(),
  overrides: new Map<string, ChannelOverride>(),
}));

vi.mock('../services/idb-cache', () => ({
  getCachedEpg: vi.fn(async () => null),
  setCachedEpg: vi.fn(async () => true),
}));
vi.mock('../services/storage-service', () => ({
  StorageService: { getEpgRefreshIntervalMs: () => 6 * 60 * 60 * 1000 },
}));
vi.mock('../parsers/xmltv-loader', () => ({
  fetchAndParseXMLTV: vi.fn(async (url: string) => {
    const data = guides.get(url) as ParsedEpg;
    const kept = Object.values(data.programmes).reduce((n, list) => n + list.length, 0);
    return {
      data,
      stats: { channelsKept: 0, programmesSeen: kept, programmesMatched: kept, programmesKept: kept },
    };
  }),
}));
vi.mock('../services/channel-customization', () => ({
  ChannelCustomizationService: {
    overrideFor: vi.fn<typeof ChannelCustomizationService.overrideFor>(key => overrides.get(key) ?? null),
    epgChannelIds: () => Array.from(overrides.values()).map(o => o.epgChannelId).filter(Boolean),
    epgChannelIdsFor: () => Array.from(overrides.values()).map(o => o.epgChannelId).filter(Boolean),
  },
}));

import { EpgService } from '../services/epg-service';
import { getCachedEpg } from '../services/idb-cache';
import { cachedChannelsRequest } from '../components/search-cache-source';
import { channelKey } from '../utils/channel-identity';
import { guideChannelKey } from '../services/epg-channel-match';
import { buildSourceIndex } from './search-source-index';
import { matchGuideRuns } from './search-guide-match';
import { SearchCacheError } from './search-cache-reader';
import type { SearchGuideProgrammes } from './tasks';

function prog(title: string): Programme {
  return { start: new Date(0), stop: new Date(1), title, description: '', category: '', icon: '' };
}

function channel(id: string, name: string, playlistIds: string[], extra: Partial<Channel> = {}): Channel {
  return {
    id, name, logo: '', group: 'g', url: `http://host/${name}`, extras: null,
    playlistIds, catchup: '', catchupSource: '', catchupDays: 0, ...extra,
  };
}

const A = 'http://host/a.xml';
const B = 'http://host/b.xml';
const sources: EpgSource[] = [
  { url: A, playlistIds: ['p1'], kind: 'm3u' },
  { url: B, playlistIds: [], kind: 'manual' },
];

function setGuides(): void {
  guides.set(A, {
    channels: {
      a1: { name: 'Alpha', icon: '' },
      a2: { name: 'Bravo', icon: '', aliases: ['Bravo HD'] },
      a3: { name: 'Empty', icon: '' },
      a4: { name: 'Écho TV', icon: '' },
    },
    programmes: { a1: [prog('A1'), prog('A2')], a2: [prog('B1')], a3: [], a4: [prog('E1')] },
    tzOffsetMinutes: null,
  });
  guides.set(B, {
    channels: {
      b1: { name: 'Charlie', icon: '' },
      b2: { name: 'Delta', icon: '' },
      a1: { name: 'Other', icon: '' },
    },
    programmes: { b1: [prog('C1'), prog('C2'), prog('C3')], b2: [prog('D1')], a1: [prog('X')] },
    tzOffsetMinutes: null,
  });
}

// Every way a channel finds its guide: tvg id, name, alias, rename, a saved
// mapping, a source that does not apply, and a mapping with no programmes.
function playlist(): Channel[] {
  return [
    channel('a1', 'Unrelated', ['p1']),
    channel('', 'alpha', ['p2']),
    channel('', 'Bravo HD', ['p1']),
    channel('', 'My Charlie', ['p2'], { sourceName: 'Charlie' }),
    channel('', 'Echo', ['p1']),
    channel('a1', 'Unknown', ['p2']),
    channel('zz', 'Mapped', ['p1']),
    channel('', 'Delta', ['p1']),
    channel('', 'Empty mapped', ['p1']),
    channel('a3', 'Empty', ['p1']),
    channel('', 'ÉCHO TV', ['p1']),
  ];
}

async function load(channels: Channel[]): Promise<void> {
  EpgService.reset();
  setGuides();
  await EpgService.load(sources, channels);
}

function workerRuns(channels: Channel[], samples: SearchGuideProgrammes['samples'] = []) {
  const playlistRef = { store: 'playlist-cache', key: 'combined', timestamp: 10 } as const;
  const playlistIndex = buildSourceIndex(playlistRef, {
    key: 'combined', timestamp: 10, data: { channels: channels.map(c => ({ ...c, name: c.sourceName ?? c.name })) },
  });
  const selection = new Uint32Array(channels.map((_, i) => i));
  const cached = cachedChannelsRequest(channels, { record: playlistRef, length: channels.length, selection })!;
  const guideSources = EpgService.searchGuideSources()!;
  const indexes = guideSources.map(source => (source.record
    ? buildSourceIndex(source.record, { url: source.url, timestamp: source.record.timestamp, data: guides.get(source.url) })
    : null));
  return matchGuideRuns(
    { index: playlistIndex, request: cached },
    {
      sources: guideSources,
      mappings: channels.flatMap((c, i): Array<[number, string]> => {
        const id = overrides.get(channelKey(c))?.epgChannelId;
        return id ? [[i, id]] : [];
      }),
      samples,
    },
    indexes,
  );
}

describe('matchGuideRuns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    overrides.clear();
  });

  it('matches every channel to the guide channel the page shows', async () => {
    const channels = playlist();
    overrides.set(channelKey(channels[6]), { epgChannelId: guideChannelKey(B, 'b2') });
    overrides.set(channelKey(channels[8]), { epgChannelId: guideChannelKey(A, 'a3') });
    await load(channels);

    const runs = workerRuns(channels);
    const worker = new Map<number, [string, number]>();
    for (let run = 0; run < runs.runChannels.length; run++) {
      const url = runs.records[runs.runRecords[run]].key;
      worker.set(runs.runChannels[run], [guideChannelKey(url, runs.runIds[run]), runs.runCounts[run]]);
    }
    const page = channels.map(c => EpgService.searchMatchSample(c));
    channels.forEach((_, i) => {
      const [key, count] = page[i];
      expect(worker.get(i) ?? ['', 0], `channel ${String(i)}`).toEqual(count ? [key, count] : ['', 0]);
    });
    expect(page.map(([key]) => key)).toEqual([
      guideChannelKey(A, 'a1'),
      '',
      guideChannelKey(A, 'a2'),
      guideChannelKey(B, 'b1'),
      '',
      guideChannelKey(B, 'a1'),
      guideChannelKey(B, 'b2'),
      guideChannelKey(B, 'b2'),
      guideChannelKey(A, 'a3'),
      '',
      guideChannelKey(A, 'a4'),
    ]);
  });

  it('leaves the matching to the page when it shows a filtered copy of the cached guide', async () => {
    const channels = playlist();
    setGuides();
    const cachedA = guides.get(A) as ParsedEpg;
    vi.mocked(getCachedEpg).mockImplementation(async (url: string) => (url === A
      ? {
        // The cached guide lists a channel no playlist channel needs.
        data: {
          ...cachedA,
          channels: { ...cachedA.channels, gone: { name: 'Gone', icon: '' } },
          programmes: { ...cachedA.programmes, gone: [prog('G1')] },
        },
        timestamp: Date.now(),
      }
      : null) as never);
    try {
      EpgService.reset();
      await EpgService.load(sources, channels);
      expect(EpgService.searchGuideSources()).toBeNull();
    } finally {
      vi.mocked(getCachedEpg).mockImplementation(async () => null);
    }
    await load(channels);
    expect(EpgService.searchGuideSources()).not.toBeNull();
  });

  it('rejects the match when the page samples disagree', async () => {
    const channels = playlist();
    await load(channels);
    expect(() => workerRuns(channels, [[0, guideChannelKey(A, 'a1'), 2]])).not.toThrow();
    expect(() => workerRuns(channels, [[0, guideChannelKey(A, 'a2'), 1]])).toThrow(SearchCacheError);
    expect(() => workerRuns(channels, [[99, '', 0]])).toThrow(SearchCacheError);
  });
});
