import {
  UNCATEGORIZED_GROUP,
  type Channel,
  type ChannelGroupId,
  type EpgSource,
  type LastChannel,
  type ParsedPlaylist,
  type PlaylistTab,
} from '../types';
import { fetchAndParseM3U, stampCatchupClock } from '../parsers/m3u-loader';
import type { M3ULoadProgress } from '../parsers/m3u-loader';
import {
  xtreamPlaylistUrl,
  xtreamEpgUrl,
  xtreamCatchupSource,
  xtreamLiveUrl,
  resolveXtreamLiveOutput,
  type XtreamCredentials,
  type XtreamLiveOutput,
} from '../utils/xtream-url';
import {
  channelKey,
  channelExactStreamIdentity,
  channelExactStreamKey,
  channelStreamIdentity,
  channelStreamKey,
  legacyChannelKey,
} from '../utils/channel';
import { createXtreamLiveStreamIdResolver } from '../utils/xtream-live-match';
import {
  prepareSearchItem,
  rankPreparedTopK,
  type PreparedSearchItem,
  type RankedSearchResult,
} from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';
import { releaseHeldRecord } from './held-records';
import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import {
  createXtreamClient,
  type XtreamLiveCategory,
  type XtreamLiveStream,
} from './xtream-client';
import {
  cacheRecordRef,
  getCachedPlaylist,
  playlistCacheToken,
  scheduleCachedPlaylist,
  type CacheRecordRef,
} from './idb-cache';
import { isSourceEnabled } from '../utils/playlist';
import {
  filterLiveStreams,
  liveCategoryCounts,
  liveCategoryGroupFilter,
  newLiveCategoryIds,
  normalizeLiveCategoryFilter,
  type XtreamGroupNameFilter,
} from '../utils/xtream-category-filter';
import { liveParentalRequest, ParentalControlService } from './parental-control';
import type { XtreamCatchupCounts } from '../workers/tasks';

const log = createLogger('Playlist');

function logXtreamCatchup(counts: XtreamCatchupCounts): void {
  if (!counts.archived) return;
  log.info(
    'Xtream catch-up matching completed',
    'event=xtream.catchup.matched',
    `streams=${counts.streams}`,
    `archived=${counts.archived}`,
    `enabled=${counts.enabled}`,
    `unmatched=${counts.unmatched}`,
    `clock=${counts.clock}`,
    ...(counts.clockFailure ? [`clockFailure=${counts.clockFailure}`] : []),
  );
  if (counts.unmatched) {
    log.warn(
      'Xtream catch-up streams could not be matched',
      'event=xtream.catchup.unmatched',
      `channels=${counts.unmatched}`,
    );
  }
}

export interface PlaylistLoadProgress {
  sourceNumber: number;
  sourceCount: number;
  inputBytes: number;
  /** The source's size when its server reveals it. */
  totalBytes?: number;
  channelsProcessed: number;
  channelsKept: number;
}

export interface LiveCategoryNotice {
  playlistId: string;
  accountName: string;
  count: number;
}

interface PlaylistRefreshOptions {
  preserveOnFailure?: boolean;
  /** Shows channels as they arrive; called after each batch joins `channels`. */
  onChannels?: () => void;
}

export interface PlaylistLoadOptions {
  /** Shows channels as they arrive; called after each batch joins `channels`. */
  onChannels?: () => void;
}

function usableDirectSource(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

function xtreamLivePlaylist(
  credentials: XtreamCredentials,
  output: XtreamLiveOutput,
  categories: XtreamLiveCategory[],
  streams: XtreamLiveStream[],
): ParsedPlaylist {
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const channels: Channel[] = streams.map(stream => ({
    id: stream.epgChannelId || stream.streamId,
    name: stream.name || stream.streamId,
    logo: stream.icon,
    group: categoryNames.get(stream.categoryId) || UNCATEGORIZED_GROUP,
    url: usableDirectSource(stream.directSource)
      || xtreamLiveUrl(credentials, stream.streamId, output),
    extras: null,
    playlistIds: [],
    catchup: '',
    catchupSource: '',
    catchupDays: 0,
    catchupStreamId: stream.streamId,
  }));
  const groups = Array.from(new Set(channels.map(channel => channel.group)));
  return {
    channels,
    groups,
    epgUrl: '',
    epgUrls: [],
    headerAttributes: {},
    format: 'unknown',
    issues: [],
  };
}

export interface ChannelCacheSource {
  record: CacheRecordRef;
  length: number;
  selection: Uint32Array;
}

class PlaylistServiceImpl {
  /** Every parsed channel, hidden ones included. Edit mode reads this. */
  allChannels: Channel[] = [];
  /** Visible channels in effective (customized) order. Everything else reads this. */
  channels: Channel[] = [];
  // Customized channels before parental concealment; the EPG keeps covering
  // concealed channels so an unlock does not force a guide refetch.
  private unconcealedChannels: Channel[] = [];
  // Each `channels` entry's index in `allChannels`.
  private channelSourceIndices = new Uint32Array(0);
  groups: string[] = [];
  groupsRevision = 0;
  playlistTabs: PlaylistTab[] = [];
  epgSources: EpgSource[] = [];
  private indexMap = new Map<Channel, number>(); // channel -> global index, O(1) indexOf
  private channelsByGroup = new Map<string, Channel[]>();
  private channelsByPlaylist = new Map<string, Channel[]>();
  private channelsByPlaylistGroup = new Map<string, Map<string, Channel[]>>();
  private groupsByPlaylist = new Map<string, string[]>();
  private groupKeyByDisplay = new Map<string, string>();
  private derivedGroups = new Set<string>();
  private derivedPlaylistGroups = new Map<string, Set<string>>();
  // The playlist owning every indexed channel: undefined before the first
  // channel, null once a second playlist shows up.
  private derivedSole: string | null | undefined = undefined;
  private derivedGroupsSize = -1;
  // Channels sharing a key (one URL with other headers or DRM), in order.
  private channelsByKey: Map<string, Channel[]> | null = null;
  // Built on the first key miss; most boots never need it.
  private channelByLegacyKey: Map<string, Channel | null> | null = null;
  private channelSearchIndex: PreparedSearchItem<Channel>[] = [];
  private channelSearchByPlaylist = new Map<string, PreparedSearchItem<Channel>[]>();
  private indexedChannels: Channel[] | null = null;
  private indexedChannelCount = -1;
  private searchIndexedChannels: Channel[] | null = null;
  private searchIndexedChannelCount = -1;
  private includeHidden = false;
  private failedSourceIds = new Set<string>();
  private liveCategoryNotices: LiveCategoryNotice[] = [];
  private refreshTimestamp: number | null = null;
  // A load showing channels as they arrive; null once it ends.
  private progressive: { generation: number } | null = null;
  private progressiveGeneration = 0;
  // Only the latest load counts: one it replaced may run on until its
  // source times out, but no longer changes `channels`.
  private loadCount = 0;
  private latestLoadSettled = true;
  private loadedOnce = false;
  // A progressive load cleared the list and has not put a whole one back.
  private listPartial = false;

  /** True while a load is still adding channels to `channels`. */
  get loading(): boolean {
    return this.progressive !== null;
  }

  /** True once `channels` holds a whole playlist that no load is replacing. */
  get complete(): boolean {
    return this.loadedOnce && !this.listPartial && this.latestLoadSettled && !this.loading;
  }

  hasLiveCategoryNotices(): boolean {
    return this.currentLiveCategoryNotices().length > 0;
  }

  /** New-category notices from the latest load, each returned once. */
  takeLiveCategoryNotices(): LiveCategoryNotice[] {
    const notices = this.currentLiveCategoryNotices();
    this.liveCategoryNotices = [];
    return notices;
  }

  // A queued notice goes stale once its account is removed, disabled,
  // re-pointed, no longer hides new categories, or has been reviewed.
  private currentLiveCategoryNotices(): LiveCategoryNotice[] {
    if (!this.liveCategoryNotices.length) return [];
    const playlists = StorageService.getPlaylists();
    this.liveCategoryNotices = this.liveCategoryNotices.filter((notice) => {
      const pl = playlists.find(entry => entry.id === notice.playlistId);
      if (!pl || pl.source !== 'xtream' || !isSourceEnabled(pl)) return false;
      if (normalizeLiveCategoryFilter(pl.xtream?.liveCategories)?.mode !== 'include') return false;
      const snapshot = StorageService.getLiveCategorySnapshot(pl.id);
      return !!snapshot && snapshot.announcedIds.length > 0;
    });
    return this.liveCategoryNotices;
  }

  private recordLiveCategories(
    pl: { id: string; name: string; url: string },
    filter: ReturnType<typeof normalizeLiveCategoryFilter>,
    currentIds: readonly string[],
    nextCounts?: Record<string, number>,
  ): void {
    const previous = StorageService.getLiveCategorySnapshot(pl.id);
    // The name-match fallback knows the categories but not their channels.
    const counts = nextCounts ?? previous?.counts ?? {};
    // A missing snapshot (first load, or lost data) treats today's catalog as
    // known, so only categories added after this point are announced.
    const knownIds = previous ? previous.knownIds : currentIds.slice();
    const baseline = { knownIds, announcedIds: previous?.announcedIds ?? [], counts };
    const newIds = newLiveCategoryIds(filter, baseline, currentIds);
    const announced = new Set(baseline.announcedIds);
    const unannounced = newIds.filter(id => !announced.has(id));
    const next = {
      knownIds,
      announcedIds: baseline.announcedIds.concat(unannounced),
      counts,
    };
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      StorageService.setLiveCategorySnapshot(pl.id, next);
    }
    if (unannounced.length) {
      log.info(
        'Xtream Live categories added',
        'event=xtream.category_filter.new',
        `count=${String(unannounced.length)}`,
      );
      this.liveCategoryNotices.push({
        playlistId: pl.id,
        accountName: pl.name || pl.url,
        count: unannounced.length,
      });
    }
  }

  hasFailedSource(playlistIds: readonly string[]): boolean {
    return playlistIds.some(id => this.failedSourceIds.has(id));
  }

  get allSourcesDisabled(): boolean {
    const sources = StorageService.getPlaylists();
    return sources.length > 0 && !sources.some(isSourceEnabled);
  }

  getNextRefreshDelayMs(intervalMs: number): number {
    if (this.refreshTimestamp === null) return 0;
    return Math.max(0, this.refreshTimestamp + intervalMs - Date.now());
  }

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale channels do not survive navigation back to the channel
   * list view.
   */
  reset(): void {
    // No playlist is a whole list too: its reminders' channels are gone.
    this.loadedOnce = true;
    this.listPartial = false;
    this.failedSourceIds.clear();
    this.refreshTimestamp = null;
    this.progressive = null;
    this.allChannels = [];
    this.channels = [];
    this.unconcealedChannels = [];
    this.channelSourceIndices = new Uint32Array(0);
    this.groups = [];
    this.groupsRevision++;
    this.playlistTabs = [];
    this.epgSources = [];
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupsByPlaylist = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelsByKey = null;
    this.channelByLegacyKey = null;
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.indexedChannels = null;
    this.indexedChannelCount = -1;
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;
  }

  async load(
    onProgress?: (progress: PlaylistLoadProgress) => void,
    options: PlaylistLoadOptions = {},
  ): Promise<Channel[]> {
    const load = ++this.loadCount;
    this.latestLoadSettled = false;
    try {
      const channels = await this.loadChannels(onProgress, options);
      if (load === this.loadCount) this.loadedOnce = true;
      return channels;
    } finally {
      if (load === this.loadCount) this.latestLoadSettled = true;
    }
  }

  private async loadChannels(
    onProgress: ((progress: PlaylistLoadProgress) => void) | undefined,
    options: PlaylistLoadOptions,
  ): Promise<Channel[]> {
    const enabledSources = StorageService.getPlaylists().filter(isSourceEnabled);
    const enabledIds = new Set(enabledSources.map(source => source.id));
    if (!enabledIds.size) {
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      return [];
    }
    // Boot from an expired cache too; App schedules the overdue refresh in the
    // background instead of blocking startup on a full download.
    const cached = await getCachedPlaylist(null);
    if (cached) {
      // A progressive load still running must not add to the cached list.
      this.progressive = null;
      this.listPartial = false;
      this.failedSourceIds.clear();
      this.refreshTimestamp = cached.timestamp;
      // The source signature already rules out a disabled source; the ids
      // guard a hash collision and older records without them.
      const sourcesStillEnabled = !!cached.sourceIds
        && cached.sourceIds.every(id => enabledIds.has(id));
      const channelsNeedFiltering = !sourcesStillEnabled && cached.channels
        .some(channel => channel.playlistIds.some(id => !enabledIds.has(id)));
      this.allChannels = channelsNeedFiltering
        ? cached.channels
            .map(channel => ({
              ...channel,
              playlistIds: channel.playlistIds.filter(id => enabledIds.has(id)),
            }))
            .filter(channel => channel.playlistIds.length > 0)
        : cached.channels;
      const epgSourcesNeedFiltering = !sourcesStillEnabled && cached.epgSources
        .some(source => source.playlistIds.some(id => !enabledIds.has(id)));
      this.epgSources = epgSourcesNeedFiltering
        ? cached.epgSources
            .map(source => ({
              ...source,
              playlistIds: source.playlistIds.filter(id => enabledIds.has(id)),
            }))
            .filter(source => source.playlistIds.length > 0)
        : cached.epgSources;
      log.info('Cache hit:', this.allChannels.length, 'channels,', this.epgSources.length, 'epg sources');
      this.applyCustomization();
      this.buildPlaylistTabs();
      StorageService.migrateFavoriteKeys(this.channels);
      this.logLoadCompleted('cache', enabledIds.size, 0);
      return this.channels;
    }
    log.info('Cache miss — refreshing from network');
    return this.refresh(onProgress, { onChannels: options.onChannels });
  }

  async refresh(
    onProgress?: (progress: PlaylistLoadProgress) => void,
    options: PlaylistRefreshOptions = {},
  ): Promise<Channel[]> {
    // beginProgressive() runs before the first await, so it takes this number.
    const generation = options.onChannels && !options.preserveOnFailure
      ? this.progressiveGeneration + 1
      : -1;
    try {
      return await this.refreshSources(onProgress, options);
    } catch (err) {
      // Its progressive load ends here, or `loading` would stay true.
      if (this.progressive?.generation === generation) this.progressive = null;
      throw err;
    }
  }

  private async refreshSources(
    onProgress: ((progress: PlaylistLoadProgress) => void) | undefined,
    options: PlaylistRefreshOptions,
  ): Promise<Channel[]> {
    const done = log.time('refresh');
    const cacheToken = playlistCacheToken();
    const playlists = StorageService.getPlaylists().filter(isSourceEnabled);
    if (!playlists.length) {
      log.info('No playlist sources enabled');
      this.reset();
      this.logLoadCompleted('none', 0, 0);
      done();
      return [];
    }

    const progressive = options.onChannels && !options.preserveOnFailure
      ? this.beginProgressive()
      : null;
    // The list the load replaces is gone now.
    if (progressive) options.onChannels?.();
    let allChannels: Channel[] = [];
    let byUrl: Map<string, Channel> | null = null;
    const streamIndex = (): Map<string, Channel> => {
      if (!byUrl) {
        byUrl = new Map();
        for (const ch of allChannels) byUrl.set(channelExactStreamIdentity(ch), ch);
      }
      return byUrl;
    };
    const epgSources: EpgSource[] = [];
    let failedPlaylists = 0;
    let loadedSources = 0;
    const failedSourceIds = new Set<string>();
    let completedProcessed = 0;
    let completedKept = 0;
    const addEpgSource = (url: string, playlistId: string, kind: EpgSource['kind']): void => {
      const existing = epgSources.find((source) => source.url === url);
      if (existing) {
        if (!existing.playlistIds.includes(playlistId)) existing.playlistIds.push(playlistId);
        return;
      }
      epgSources.push({ url, playlistIds: [playlistId], kind });
    };

    for (let playlistIndex = 0; playlistIndex < playlists.length; playlistIndex++) {
      // A newer load took over: the rest of this one would be thrown away.
      if (progressive && this.progressive !== progressive) break;
      const pl = playlists[playlistIndex];
      const load = playlistIndex + 1;
      const source = pl.source === 'xtream' ? 'xtream' : 'm3u';
      const sourceStarted = Date.now();
      const sourceEpgStart = epgSources.length;
      let sourceProcessed = 0;
      let sourceKept = 0;
      log.info(
        'Playlist source load started',
        'event=playlist.source.load.started',
        `load=${String(load)}`,
        `source=${source}`,
      );
      // Tag channels by the playlist's stable id, not its name or position, so
      // two playlists sharing a name/URL stay distinct and deleting/reordering
      // one never re-points another's channels.
      const plKey = pl.id;
      // Use the Player API catalog to identify Live entries, but keep get.php as
      // the channel source so provider ordering, headers, URLs, and metadata survive.
      let fetchUrl = pl.url;
      let xtreamCredentials: XtreamCredentials | null = null;
      let xtreamOutput: XtreamLiveOutput = 'ts';
      let xtreamStreams: XtreamLiveStream[] | undefined;
      let xtreamReferences: XtreamLiveStream[] | undefined;
      let xtreamCatalogAvailable = false;
      let xtreamGroupFilter: XtreamGroupNameFilter | undefined;
      const categoryFilter = pl.source === 'xtream'
        ? normalizeLiveCategoryFilter(pl.xtream?.liveCategories)
        : undefined;
      if (pl.source === 'xtream' && pl.xtream) {
        const credentials = { baseUrl: pl.url, ...pl.xtream };
        xtreamCredentials = credentials;
        const client = createXtreamClient(credentials);
        let allowedOutputFormats: string[] = [];
        if (pl.xtream.liveOutput === 'auto') {
          allowedOutputFormats =
            (await client.getAccountInfo())?.allowedOutputFormats ?? [];
        }
        xtreamOutput = resolveXtreamLiveOutput(pl.xtream.liveOutput, allowedOutputFormats);
        const catalogStarted = Date.now();
        log.info(
          'Xtream Live catalog load started',
          'event=xtream.live_catalog.started',
          `load=${String(load)}`,
          'endpoint=get_live_streams',
        );
        const liveCatalog = await client.getLiveStreamsResult();
        xtreamCatalogAvailable = liveCatalog.available;
        xtreamStreams = liveCatalog.streams;
        log[liveCatalog.available ? 'info' : 'warn'](
          'Xtream Live catalog load completed',
          'event=xtream.live_catalog.completed',
          `load=${String(load)}`,
          `available=${liveCatalog.available ? '1' : '0'}`,
          `items=${String(liveCatalog.streams.length)}`,
          `elapsedMs=${String(Date.now() - catalogStarted)}`,
        );
        xtreamReferences = filterLiveStreams(categoryFilter, xtreamStreams);
        if (categoryFilter && liveCatalog.available) {
          log.info(
            'Xtream Live category filter applied',
            'event=xtream.category_filter.applied',
            `load=${String(load)}`,
            `mode=${categoryFilter.mode}`,
            `categories=${String(categoryFilter.ids.length)}`,
            `kept=${String(xtreamReferences.length)}`,
            `total=${String(xtreamStreams.length)}`,
          );
        } else if (categoryFilter) {
          const categories = await client.getLiveCategories();
          xtreamGroupFilter = liveCategoryGroupFilter(categoryFilter, categories) ?? undefined;
          log.warn(
            xtreamGroupFilter
              ? 'Xtream Live catalog unavailable; filtering by category name'
              : 'Xtream Live categories unavailable; loading unfiltered',
            xtreamGroupFilter
              ? 'event=xtream.category_filter.name_match'
              : 'event=xtream.category_filter.unavailable',
            `load=${String(load)}`,
          );
          if (xtreamGroupFilter) {
            this.recordLiveCategories(pl, categoryFilter, categories.map(category => category.id));
          }
        }
        if (liveCatalog.available) {
          const counts = liveCategoryCounts(xtreamStreams);
          this.recordLiveCategories(pl, categoryFilter, Object.keys(counts), counts);
        }
        fetchUrl = xtreamPlaylistUrl(
          credentials,
          xtreamOutput,
        );
      }
      const plDone = log.time(`fetch '${pl.name || pl.url}'`);
      // Channels the worker keeps to write the cache; any change here drops them.
      let workerChannels: Channel[] | null = null;
      let streamed = false;
      try {
        let parsed: ParsedPlaylist | null = null;
        let workerDuplicates: number | null = null;
        let workerCatchup: XtreamCatchupCounts | undefined;
        let playlistError: unknown;
        try {
          // Only the first source streams in; later ones merge when they finish.
          const onChannels = progressive && !allChannels.length
            ? (batch: Channel[]) => {
                if (!this.appendProgressive(progressive, batch)) return;
                streamed = true;
                options.onChannels?.();
              }
            : undefined;
          const loaded = await fetchAndParseM3U(
            fetchUrl,
            60000,
            xtreamCatalogAvailable ? xtreamReferences : undefined,
            xtreamCredentials?.baseUrl,
            (progress: M3ULoadProgress) => {
              sourceProcessed = Math.max(sourceProcessed, progress.channelsProcessed);
              sourceKept = Math.max(sourceKept, progress.channelsKept);
              onProgress?.({
                sourceNumber: load,
                sourceCount: playlists.length,
                inputBytes: progress.inputBytes,
                ...(progress.totalBytes ? { totalBytes: progress.totalBytes } : {}),
                channelsProcessed: completedProcessed + sourceProcessed,
                channelsKept: completedKept + sourceKept,
              });
            },
            xtreamGroupFilter,
            plKey,
            playlists.length === 1,
            xtreamCredentials && xtreamCatalogAvailable
              ? {
                  accountId: plKey,
                  credentials: xtreamCredentials,
                  output: xtreamOutput,
                  catalogStreams: xtreamStreams?.length ?? 0,
                  catalogArchived: xtreamStreams?.filter(stream => stream.archive).length ?? 0,
                }
              : undefined,
            onChannels,
          );
          parsed = loaded.data;
          workerChannels = parsed.channels;
          workerDuplicates = loaded.metrics.duplicates ?? null;
          workerCatchup = loaded.metrics.catchup;
        } catch (err) {
          playlistError = err;
          if (!xtreamCredentials) throw err;
          log.warn(
            'Xtream playlist failed; trying the Player API live catalog',
            'event=xtream.live_fallback.used',
            `load=${String(load)}`,
            'reason=request_failed',
          );
        }

        let fallbackStreams: XtreamLiveStream[] | undefined;
        if (xtreamCredentials && (!parsed || !parsed.channels.length)) {
          if (parsed) {
            log.warn(
              'Xtream playlist contained no channels; trying the Player API live catalog',
              'event=xtream.live_fallback.used',
              `load=${String(load)}`,
              'reason=no_channels',
            );
          }
          const client = createXtreamClient(xtreamCredentials);
          const categories = await client.getLiveCategories();
          const allStreams = xtreamCatalogAvailable
            ? xtreamStreams ?? []
            : await client.getLiveStreams();
          fallbackStreams = allStreams;
          const streams = filterLiveStreams(categoryFilter, allStreams);
          log.info(
            'Xtream Player API live catalog completed',
            'event=xtream.live_api.completed',
            `load=${String(load)}`,
            `categories=${String(categories.length)}`,
            `streams=${String(streams.length)}`,
          );
          if (streams.length) {
            workerDuplicates = null;
            workerCatchup = undefined;
            parsed = xtreamLivePlaylist(
              xtreamCredentials,
              xtreamOutput,
              categories,
              streams,
            );
          } else if (!parsed && playlistError) {
            throw playlistError;
          }
        }
        if (!parsed) throw new Error('Xtream source returned no playlist or live catalog');

        if (workerCatchup) {
          logXtreamCatchup(workerCatchup);
          const lateClock = workerCatchup.lateClock;
          if (lateClock) {
            // Rare: the panel clock missed the worker's stamping, so the page
            // adds the time zone and writes the cache itself.
            for (const channel of parsed.channels) {
              if (channel.catchupAccountId === plKey) stampCatchupClock(channel, lateClock);
            }
            releaseHeldRecord(parsed.channels);
          }
        } else if (xtreamCredentials) {
          const changed = await this.applyXtreamCatchup(
            parsed.channels,
            xtreamCredentials,
            plKey,
            xtreamOutput,
            fallbackStreams ?? xtreamStreams,
          );
          if (changed) releaseHeldRecord(parsed.channels);
        }
        if (parsed.issues.length) {
          log.warn('Playlist diagnostics:',
            parsed.issues.slice(0, 5).map(issue => `${issue.code}@${issue.line}`).join(', '));
        }
        log.info('Parsed', parsed.channels.length, 'channels,', parsed.groups.length, 'groups',
          parsed.epgUrl ? `| epg: ${parsed.epgUrl}` : '');
        // The worker already dropped this playlist's own copies.
        let added = 0, dupes = workerDuplicates ?? 0;
        // Merging de-duplicates by stream: the same location sent with other
        // headers or options is another channel. channelKey stays URL-only,
        // so a plain channel keeps its favorites and history. The location is
        // compared exactly: entries differing only by a token may come from
        // different accounts, and each must keep its own working token.
        if (workerDuplicates !== null && !allChannels.length) {
          allChannels = parsed.channels;
          added = parsed.channels.length;
        } else {
          // A merge changes the channels, so no worker copy matches them now.
          releaseHeldRecord(allChannels);
          releaseHeldRecord(parsed.channels);
          for (const ch of parsed.channels) {
            const identity = channelExactStreamIdentity(ch);
            const index = streamIndex();
            const existing = index.get(identity);
            if (existing) {
              // Same stream in an earlier playlist: keep the one channel object
              // (so "All" stays de-duplicated), but record this playlist too so
              // its own tab still appears and shows the channel.
              if (!existing.playlistIds.includes(plKey)) existing.playlistIds.push(plKey);
              dupes++;
            } else {
              ch.playlistIds = [plKey];
              index.set(identity, ch);
              allChannels.push(ch);
              added++;
            }
          }
        }
        loadedSources++;
        log.debug(`Added ${added} channels (${dupes} duplicates skipped)`);
        if (pl.source === 'xtream' && pl.xtream) {
          // The panel's own XMLTV endpoint; the get.php url-tvg (if any) is added below too.
          const epg = xtreamEpgUrl({ baseUrl: pl.url, ...pl.xtream });
          addEpgSource(epg, plKey, 'xtream');
        }
        for (const parsedEpgUrl of parsed.epgUrls) {
          // Resolve localhost/127.0.0.1 in embedded EPG URL to the playlist's host
          let epg = parsedEpgUrl;
          try {
            const epgParsed = new URL(epg);
            if (epgParsed.hostname === 'localhost' || epgParsed.hostname === '127.0.0.1') {
              const plParsed = new URL(pl.url);
              epgParsed.hostname = plParsed.hostname;
              epg = epgParsed.toString();
              log.info('Rewrote loopback EPG host to', epgParsed.hostname);
            }
          } catch (e) { log.warn('Could not parse EPG URL:', epg, e); }
          addEpgSource(epg, plKey, 'm3u');
        }
        log.info(
          'Playlist source load completed',
          'event=playlist.source.load.completed',
          `load=${String(load)}`,
          `source=${source}`,
          `channels=${String(parsed.channels.length + (workerDuplicates ?? 0))}`,
          `added=${String(added)}`,
          `duplicates=${String(dupes)}`,
          `epg=${String(epgSources.length - sourceEpgStart)}`,
          `elapsedMs=${String(Date.now() - sourceStarted)}`,
        );
      } catch (err) {
        releaseHeldRecord(workerChannels);
        // The next source streams in place of the failed one's partial list.
        if (progressive && streamed && this.progressive === progressive) {
          this.clearProgressive();
          options.onChannels?.();
        }
        failedPlaylists++;
        failedSourceIds.add(plKey);
        log.error(
          'Playlist source load failed',
          'event=playlist.source.load.failed',
          `load=${String(load)}`,
          `source=${source}`,
          'reason=request_failed',
          `elapsedMs=${String(Date.now() - sourceStarted)}`,
          err,
        );
        if (pl.source === 'xtream') {
          log.error(
            `Failed to load Xtream playlist '${pl.name || pl.url}'`,
            'event=xtream.playlist.load.failed',
            `load=${String(load)}`,
            err,
          );
        } else {
          log.error(`Failed to load playlist '${pl.name || pl.url}':`, err);
        }
      }
      completedProcessed += sourceProcessed;
      completedKept += sourceKept;
      plDone();
    }

    // reset(), a cache hit, or a newer load took over while this one ran.
    if (progressive && this.progressive !== progressive) {
      releaseHeldRecord(allChannels);
      done();
      return this.channels;
    }
    this.failedSourceIds = failedSourceIds;
    if (failedPlaylists && options.preserveOnFailure) {
      log.warn(
        'Keeping the current channel list because an automatic refresh was incomplete',
        'event=playlist.refresh.preserved',
        `failed=${String(failedPlaylists)}`,
      );
      releaseHeldRecord(allChannels);
      this.logLoadCompleted('network', playlists.length, failedPlaylists);
      done();
      return this.channels;
    }
    const refreshTimestamp = Date.now();
    // A later source merged into the shown channels changes their playlists.
    const adopted = progressive
      ? this.endProgressive(progressive, allChannels, loadedSources <= 1)
      : false;
    this.allChannels = allChannels;
    // A newer load still streaming keeps the list partial.
    if (!this.progressive) this.listPartial = false;
    this.epgSources = epgSources;
    // Customization preserves source names/groups on each channel, so cached
    // channels can be re-customized after an edit without another network load.
    if (!failedPlaylists) {
      this.refreshTimestamp = refreshTimestamp;
      scheduleCachedPlaylist(
        allChannels,
        epgSources,
        refreshTimestamp,
        StorageService.getPlaylistRefreshIntervalMs(),
        cacheToken,
        playlists.map(pl => pl.id),
      );
    } else {
      this.refreshTimestamp = null;
      releaseHeldRecord(allChannels);
      log.warn('Skipping cache write because one or more playlists failed');
    }
    if (!adopted) this.applyCustomization();
    this.buildPlaylistTabs();
    StorageService.migrateFavoriteKeys(this.channels);
    log.info('Refresh complete:', allChannels.length, 'total channels,', epgSources.length, 'epg sources');
    this.logLoadCompleted('network', playlists.length, failedPlaylists);
    done();
    return this.channels;
  }

  /**
   * One structured line per load so a diagnostics report can tie an empty
   * channel list to the sources that produced it — the rendered list is
   * virtualized, so its DOM row count says nothing about the catalog.
   */
  private logLoadCompleted(
    source: 'cache' | 'network' | 'none',
    sources: number,
    failed: number,
  ): void {
    const level = failed || (sources && !this.channels.length) ? 'warn' : 'info';
    log[level](
      'Playlist load completed',
      'event=playlist.load.completed',
      `source=${source}`,
      `channels=${this.channels.length}`,
      `all=${this.allChannels.length}`,
      `groups=${this.groups.length}`,
      `epg=${this.epgSources.length}`,
      `sources=${sources}`,
      `failed=${failed}`,
    );
  }

  private async applyXtreamCatchup(
    channels: Channel[],
    credentials: XtreamCredentials,
    accountId: string,
    output: XtreamLiveOutput,
    knownStreams?: XtreamLiveStream[],
  ): Promise<number> {
    const client = createXtreamClient(credentials);
    const streams = knownStreams ?? await client.getLiveStreams();
    const archived = new Map(streams
      .filter(stream => stream.archive)
      .map(stream => [stream.streamId, stream]));
    if (!archived.size) return 0;

    const clock = await client.getServerClock();
    const knownIds = new Set(streams.map(stream => stream.streamId));
    const resolveLiveStreamId = createXtreamLiveStreamIdResolver(
      streams,
      credentials.baseUrl,
    );
    let enabled = 0;
    let unmatched = 0;
    let changed = 0;
    for (const channel of channels) {
      const streamId = channel.catchupStreamId && knownIds.has(channel.catchupStreamId)
        ? channel.catchupStreamId
        : resolveLiveStreamId(channel.url);
      const stream = archived.get(streamId);
      if (!stream) {
        if (!streamId) unmatched++;
        continue;
      }
      changed++;
      channel.catchupStreamId = streamId;
      channel.catchupAccountId = accountId;
      if (!channel.catchupSource) {
        channel.catchup = 'xtream';
        channel.catchupSource = xtreamCatchupSource(credentials, streamId, output);
        channel.catchupDays = stream.archiveDurationDays;
        enabled++;
      }
      if (clock?.timeZone) channel.catchupTimeZone = clock.timeZone;
      if (clock?.offsetMinutes != null) channel.catchupTimeOffsetMinutes = clock.offsetMinutes;
    }
    logXtreamCatchup({
      streams: streams.length,
      archived: archived.size,
      enabled,
      unmatched,
      clock: clock ? 'ok' : 'missing',
    });
    return changed;
  }

  private beginProgressive(): { generation: number } {
    const progressive = { generation: ++this.progressiveGeneration };
    this.progressive = progressive;
    this.listPartial = true;
    this.clearProgressive();
    return progressive;
  }

  private clearProgressive(): void {
    this.allChannels = [];
    this.unconcealedChannels = [];
    this.channels = this.unconcealedChannels;
    this.channelSourceIndices = new Uint32Array(0);
    this.buildDerivedIndexes();
    this.buildPlaylistTabs();
  }

  // Customizes, conceals, and indexes one arriving batch in source order;
  // a custom channel order waits for the full list.
  private appendProgressive(progressive: { generation: number }, batch: Channel[]): boolean {
    if (this.progressive !== progressive || !batch.length) return false;
    const base = this.allChannels.length;
    for (const ch of batch) this.allChannels.push(ch);
    const batchIndices = new Uint32Array(batch.length);
    const visible = ChannelCustomizationService.applyTo(
      batch,
      this.includeHidden || StorageService.getShowHiddenChannels(),
      batchIndices,
      true,
    );
    const from = this.channels.length;
    let indices = this.channelSourceIndices;
    if (indices.buffer.byteLength < (from + visible.length) * 4) {
      const grown = new Uint32Array(Math.max(1024, (from + visible.length) * 2));
      grown.set(indices);
      indices = grown;
    } else {
      indices = new Uint32Array(indices.buffer, 0, indices.buffer.byteLength / 4);
    }
    let length = from;
    for (let i = 0; i < visible.length; i++) {
      const ch = visible[i];
      const concealed = ParentalControlService.concealing
        && ParentalControlService.isConcealed(liveParentalRequest(ch));
      // The first concealed channel splits the two lists.
      if (concealed && this.channels === this.unconcealedChannels) {
        this.channels = this.unconcealedChannels.slice();
      }
      if (this.channels !== this.unconcealedChannels) this.unconcealedChannels.push(ch);
      if (concealed) continue;
      this.channels.push(ch);
      indices[length++] = base + batchIndices[i];
    }
    this.channelSourceIndices = indices.subarray(0, length);
    if (this.channelsByKey) {
      for (let i = from; i < length; i++) {
        this.appendIndexed(this.channelsByKey, channelKey(this.channels[i]), this.channels[i]);
      }
    }
    this.channelByLegacyKey = null;
    this.indexDerived(from);
    this.publishDerivedIndexes();
    return true;
  }

  /**
   * Ends a progressive load. Returns true when the shown channels already
   * are `final` customized, so the full pass can be skipped; the lists get
   * new identities either way, so views caching by identity rebuild.
   */
  private endProgressive(
    progressive: { generation: number },
    final: Channel[],
    adoptable: boolean,
  ): boolean {
    if (this.progressive !== progressive) return false;
    this.progressive = null;
    const shown = this.allChannels;
    if (!adoptable || ChannelCustomizationService.hasCustomOrder
      || shown.length !== final.length) return false;
    for (let i = 0; i < final.length; i++) if (shown[i] !== final[i]) return false;
    const shared = this.channels === this.unconcealedChannels;
    this.unconcealedChannels = this.unconcealedChannels.slice();
    this.channels = shared ? this.unconcealedChannels : this.channels.slice();
    this.channelSourceIndices = this.channelSourceIndices.slice();
    if (this.derivedSole) this.channelsByPlaylist.set(this.derivedSole, this.channels);
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;
    this.indexedChannels = this.channels;
    this.indexedChannelCount = this.channels.length;
    this.groupsRevision++;
    return true;
  }

  /**
   * Rebuild `channels` from `allChannels` through the user's customization:
   * hidden channels drop out, the rest take the custom order, and renames and
   * group assignments are applied to the channel objects. Cheap enough to re-run
   * after every edit — no network, no re-parse.
   */
  applyCustomization(): void {
    const includeHidden = this.includeHidden || StorageService.getShowHiddenChannels();
    const sourceIndices = new Uint32Array(this.allChannels.length);
    this.unconcealedChannels = ChannelCustomizationService.applyTo(
      this.allChannels,
      includeHidden,
      sourceIndices,
    );
    if (ParentalControlService.concealing) {
      const visible: Channel[] = [];
      for (let i = 0; i < this.unconcealedChannels.length; i++) {
        const channel = this.unconcealedChannels[i];
        if (ParentalControlService.isConcealed(liveParentalRequest(channel))) continue;
        // Compacts in place: the write index never passes the read index.
        sourceIndices[visible.length] = sourceIndices[i];
        visible.push(channel);
      }
      this.channels = visible;
    } else {
      this.channels = this.unconcealedChannels;
    }
    this.channelSourceIndices = sourceIndices.subarray(0, this.channels.length);
    this.buildDerivedIndexes();
  }

  /**
   * The playlist-cache record `allChannels` came from, with each visible
   * channel's index in it — or null when memory no longer matches a record.
   */
  getChannelCacheSource(): ChannelCacheSource | null {
    const record = cacheRecordRef(this.allChannels);
    if (!record || this.channelSourceIndices.length !== this.channels.length) return null;
    return {
      record,
      length: this.allChannels.length,
      selection: this.channelSourceIndices,
    };
  }

  /**
   * The channels the EPG is fetched and retained for. Edit mode and the
   * "show hidden" setting both widen `channels`, and a widened selection
   * forces an EPG refetch — so the guide follows the visible selection alone
   * and stays stable across those two toggles.
   */
  getEpgEligibleChannels(): Channel[] {
    if (!this.includeHidden && !StorageService.getShowHiddenChannels()) {
      return this.unconcealedChannels;
    }
    return ChannelCustomizationService.applyTo(this.allChannels, false);
  }

  // Parental "hide" mode drops locked channels from `channels`; stored data
  // keyed to them (reminders, custom order) must still resolve.
  getUnconcealedChannels(): Channel[] {
    return this.unconcealedChannels;
  }

  /** Edit mode reveals hidden channels so they can be un-hidden again. */
  setIncludeHidden(include: boolean): void {
    if (this.includeHidden === include) return;
    this.includeHidden = include;
    this.applyCustomization();
  }

  private buildDerivedIndexes(): void {
    this.resetDerivedIndexes();
    this.indexDerived(0);
    this.publishDerivedIndexes();
  }

  private resetDerivedIndexes(): void {
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupKeyByDisplay = new Map();
    this.derivedGroups = new Set();
    this.derivedPlaylistGroups = new Map();
    this.derivedSole = undefined;
    this.derivedGroupsSize = -1;
    this.channelsByKey = null;
    this.channelByLegacyKey = null;
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    this.searchIndexedChannels = null;
    this.searchIndexedChannelCount = -1;
    for (const key of ChannelCustomizationService.customGroups) {
      this.groupKeyByDisplay.set(ChannelCustomizationService.groupLabel(key), key);
    }
  }

  // Indexes `channels` from `from` on; a progressive load calls it per batch.
  private indexDerived(from: number): void {
    for (let i = from; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      if (ch.group) {
        this.derivedGroups.add(ch.group);
        if (!this.groupKeyByDisplay.has(ch.group)) {
          this.groupKeyByDisplay.set(ch.group, groupKeyOf(ch));
        }
        this.appendIndexed(this.channelsByGroup, ch.group, ch);
      }
      // Assume one playlist owns every channel, as it usually does, and index
      // per playlist only from the first channel that proves otherwise.
      if (this.derivedSole === undefined) {
        this.derivedSole = ch.playlistIds.length === 1 ? ch.playlistIds[0] : null;
        if (this.derivedSole !== null) continue;
      } else if (this.derivedSole !== null) {
        if (ch.playlistIds.length === 1 && ch.playlistIds[0] === this.derivedSole) continue;
        this.splitSolePlaylist(i);
      }
      this.indexByPlaylist(ch);
    }
    if (this.derivedSole && this.channels.length) {
      // One playlist owns every channel: its indexes are the global ones.
      this.channelsByPlaylist.set(this.derivedSole, this.channels);
      this.channelsByPlaylistGroup.set(this.derivedSole, this.channelsByGroup);
      this.derivedPlaylistGroups.set(this.derivedSole, this.derivedGroups);
    }
  }

  private splitSolePlaylist(at: number): void {
    const sole = this.derivedSole;
    this.derivedSole = null;
    if (sole) {
      this.channelsByPlaylist.delete(sole);
      this.channelsByPlaylistGroup.delete(sole);
      this.derivedPlaylistGroups.delete(sole);
    }
    for (let j = 0; j < at; j++) this.indexByPlaylist(this.channels[j]);
  }

  private indexByPlaylist(ch: Channel): void {
    for (const playlistId of ch.playlistIds) {
      this.appendIndexed(this.channelsByPlaylist, playlistId, ch);
      if (!ch.group) continue;
      let byGroup = this.channelsByPlaylistGroup.get(playlistId);
      if (!byGroup) {
        byGroup = new Map();
        this.channelsByPlaylistGroup.set(playlistId, byGroup);
      }
      this.appendIndexed(byGroup, ch.group, ch);
      let playlistGroups = this.derivedPlaylistGroups.get(playlistId);
      if (!playlistGroups) {
        playlistGroups = new Set();
        this.derivedPlaylistGroups.set(playlistId, playlistGroups);
      }
      playlistGroups.add(ch.group);
    }
  }

  private publishDerivedIndexes(): void {
    let size = this.derivedGroups.size;
    this.derivedPlaylistGroups.forEach(groups => { size += groups.size; });
    // Sorting thousands of groups per batch of a progressive load adds up;
    // the order only changes when a group appears.
    if (size !== this.derivedGroupsSize) {
      this.derivedGroupsSize = size;
      const names = Array.from(this.derivedGroups);
      for (const key of ChannelCustomizationService.customGroups) {
        const label = ChannelCustomizationService.groupLabel(key);
        if (!this.derivedGroups.has(label)) names.push(label);
        this.groupKeyByDisplay.set(label, key);
      }
      this.groups = this.orderGroups(names);
      this.groupsByPlaylist = new Map();
      this.derivedPlaylistGroups.forEach((playlistGroups, playlistId) => {
        this.groupsByPlaylist.set(playlistId, this.orderGroups(Array.from(playlistGroups)));
      });
    }
    this.indexedChannels = this.channels;
    this.indexedChannelCount = this.channels.length;
    this.groupsRevision++;
  }

  private keyIndex(): Map<string, Channel[]> {
    if (this.channelsByKey) return this.channelsByKey;
    const index = new Map<string, Channel[]>();
    for (const ch of this.channels) this.appendIndexed(index, channelKey(ch), ch);
    this.channelsByKey = index;
    return index;
  }

  private legacyKeyIndex(): Map<string, Channel | null> {
    if (this.channelByLegacyKey) return this.channelByLegacyKey;
    const index = new Map<string, Channel | null>();
    for (const ch of this.channels) {
      // A legacy key is ambiguous only across different streams, not across
      // entries that share one channelKey.
      const legacyKey = legacyChannelKey(ch);
      const legacy = index.get(legacyKey);
      if (legacy === undefined) index.set(legacyKey, ch);
      else if (legacy && channelKey(legacy) !== channelKey(ch)) index.set(legacyKey, null);
    }
    this.channelByLegacyKey = index;
    return index;
  }

  private appendIndexed<T>(map: Map<string, T[]>, key: string, channel: T): void {
    const existing = map.get(key);
    if (existing) existing.push(channel);
    else map.set(key, [channel]);
  }

  private ensureDerivedIndexes(): void {
    if (this.indexedChannels !== this.channels || this.indexedChannelCount !== this.channels.length) {
      this.buildDerivedIndexes();
    }
  }

  private ensureLocalSearchIndexes(): void {
    this.ensureDerivedIndexes();
    if (this.searchIndexedChannels === this.channels
        && this.searchIndexedChannelCount === this.channels.length) return;
    this.channelSearchIndex = [];
    this.channelSearchByPlaylist = new Map();
    for (const channel of this.channels) {
      const searchItem = prepareSearchItem(
        channel,
        item => [item.name, item.group, item.sourceName ?? ''],
      );
      this.channelSearchIndex.push(searchItem);
      for (const playlistId of channel.playlistIds) {
        this.appendIndexed(this.channelSearchByPlaylist, playlistId, searchItem);
      }
    }
    this.searchIndexedChannels = this.channels;
    this.searchIndexedChannelCount = this.channels.length;
  }

  /** Sort display group names into the custom group order (keyed by group key). */
  private orderGroups(displayNames: string[]): string[] {
    return displayNames
      .map((name, index) => ({
        name,
        rank: ChannelCustomizationService.groupRank(
          this.groupKeyByDisplay.get(name) ?? name,
          index,
        ),
        index,
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.name);
  }

  private buildPlaylistTabs(): void {
    // One tab per configured playlist, in config order, keyed by its stable id —
    // including a playlist that loaded zero channels (empty/unreachable feed), so
    // it stays visible. Derived from the registry, not the cached channels, so a
    // stale/desynced channel cache can never blank out the tab bar.
    const configured = StorageService.getPlaylists().filter(isSourceEnabled);
    this.playlistTabs = configured.map(pl => ({ id: pl.id, name: pl.name || pl.url }));
  }

  getByGroup(group: ChannelGroupId, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const all = playlist ? this.channelsByPlaylist.get(playlist) ?? [] : this.channels;
    if (group === 'builtin:all' || group === 'builtin:recently-watched') return all;
    if (group === 'builtin:favorites') {
      const favorites = StorageService.getFavorites()
        .map(key => this.keyIndex().get(key)
          ?.find(channel => !playlist || channel.playlistIds.includes(playlist)))
        .filter((channel): channel is Channel => !!channel);
      favorites.sort((a, b) => this.indexOf(a) - this.indexOf(b));
      return favorites;
    }
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup) ?? []
      : this.channelsByGroup.get(sourceGroup) ?? [];
  }

  getGroupCount(group: ChannelGroupId, playlist?: string): number {
    this.ensureDerivedIndexes();
    if (group === 'builtin:all' || group === 'builtin:recently-watched') {
      return playlist ? this.channelsByPlaylist.get(playlist)?.length ?? 0 : this.channels.length;
    }
    if (group === 'builtin:favorites') return this.getByGroup(group, playlist).length;
    const sourceGroup = group.slice('source:'.length);
    return playlist
      ? this.channelsByPlaylistGroup.get(playlist)?.get(sourceGroup)?.length ?? 0
      : this.channelsByGroup.get(sourceGroup)?.length ?? 0;
  }

  searchLocalRanked(
    query: string,
    limit: number,
    playlist?: string,
  ): RankedSearchResult<Channel> {
    if (!query.trim()) return { items: [], hasMore: false };
    this.ensureLocalSearchIndexes();
    const index = playlist
      ? this.channelSearchByPlaylist.get(playlist) ?? []
      : this.channelSearchIndex;
    return rankPreparedTopK(index, query, limit);
  }

  getPlaylistIdsForGroup(group: ChannelGroupId): string[] {
    this.ensureDerivedIndexes();
    const sourceGroup = group.slice('source:'.length);
    const ids: string[] = [];
    this.channelsByPlaylistGroup.forEach((groups, playlistId) => {
      if (groups.has(sourceGroup)) ids.push(playlistId);
    });
    return ids;
  }

  getGroupsForPlaylist(playlist?: string): string[] {
    this.ensureDerivedIndexes();
    return (playlist ? this.groupsByPlaylist.get(playlist) ?? [] : this.groups).slice();
  }

  getGroupKeyForDisplay(display: string): string {
    this.ensureDerivedIndexes();
    return this.groupKeyByDisplay.get(display) ?? display;
  }

  getByIndex(index: number): Channel | null {
    return this.channels[index] ?? null;
  }

  indexOf(channel: Channel): number {
    return this.indexMap.get(channel) ?? -1;
  }

  /** `exactStream` (a channelExactStreamIdentity) picks the entry among
   *  copies that differ only by a token, such as one channel on two accounts;
   *  `stream` (a channelStreamIdentity) picks the entry among channels
   *  sharing the key, such as one URL with and without headers; otherwise the
   *  first entry `prefer` accepts, else the first entry. */
  resolveChannelKey(
    key: string,
    stream?: string,
    prefer?: (channel: Channel) => boolean,
    exactStream?: string,
  ): { channel: Channel; channelIndex: number } | null {
    this.ensureDerivedIndexes();
    const shared = this.keyIndex().get(key) ?? [];
    const same = stream
      ? shared.filter(channel => channelStreamIdentity(channel) === stream)
      : [];
    const exact = exactStream
      ? same.filter(channel => channelExactStreamIdentity(channel) === exactStream)
      : [];
    const pick = (list: Channel[]) => (prefer && list.find(prefer)) || list[0];
    const channel = pick(exact) ?? pick(same) ?? pick(shared)
      ?? this.legacyKeyIndex().get(key);
    if (!channel) return null;
    const channelIndex = this.indexOf(channel);
    return channelIndex < 0 ? null : { channel, channelIndex };
  }

  /** Index of the channel carrying this per-stream key, or -1. Used to re-resolve
   *  the playing channel after a customization changes the ordering. */
  indexOfKey(key: string): number {
    if (!key) return -1;
    for (let i = 0; i < this.channels.length; i++) {
      if (channelKey(this.channels[i]) === key) return i;
    }
    return -1;
  }

  /** The saved stream (a channelStreamKey) picks its entry among channels
   *  sharing the key, and the saved exact stream (a channelExactStreamKey),
   *  else the saved index, picks among copies that differ only by a token;
   *  without a stream the first entry plays. A legacy key shared by
   *  different streams stays ambiguous. */
  resolveLastChannelIndex(last: LastChannel | null): number {
    const legacyIndex = last ? last.index : 0;
    const stableKey = last?.key ?? '';
    const streamKey = last?.stream ?? '';
    const exactKey = last?.exact ?? '';
    if (!stableKey) return legacyIndex;
    const matches = (channel: Channel | undefined) => !!channel
      && channelKey(channel) === stableKey
      && (!streamKey || channelStreamKey(channel) === streamKey);
    let first = -1;
    let stream = -1;
    let legacy = -1;
    let legacyKey = '';
    let legacyAmbiguous = false;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      const key = channelKey(channel);
      if (key === stableKey) {
        if (matches(channel)) {
          if (exactKey && channelExactStreamKey(channel) === exactKey) return i;
          if (stream < 0) stream = i;
        }
        if (first < 0) first = i;
      } else if (legacyChannelKey(channel) === stableKey) {
        if (legacy < 0) {
          legacy = i;
          legacyKey = key;
        } else if (key !== legacyKey) {
          legacyAmbiguous = true;
        }
      }
    }
    if (stream >= 0) {
      // Token rotated on every copy: the saved index still tells them apart.
      return streamKey && matches(this.channels[legacyIndex]) ? legacyIndex : stream;
    }
    if (first >= 0) return first;
    return legacyAmbiguous ? -1 : legacy;
  }
}

export const PlaylistService = new PlaylistServiceImpl();
