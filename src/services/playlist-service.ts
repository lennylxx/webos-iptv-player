import type { Channel, ChannelGroupId, EpgSource, PlaylistTab } from '../types';
import { parseM3U } from '../parsers/m3u-parser';
import { fetchPlaylistText } from '../utils/fetch-helper';
import {
  xtreamPlaylistUrl,
  xtreamEpgUrl,
  xtreamCatchupSource,
  xtreamCatchupFallbackSource,
  xtreamLiveStreamId,
  type XtreamCredentials,
} from '../utils/xtream-url';
import {
  channelKey,
  legacyChannelKey,
} from '../utils/channel';
import { rankChannels } from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';
import { ChannelCustomizationService, groupKeyOf } from './channel-customization';
import { createXtreamClient } from './xtream-client';

const log = createLogger('Playlist');

class PlaylistServiceImpl {
  /** Every parsed channel, hidden ones included. Edit mode reads this. */
  allChannels: Channel[] = [];
  /** Visible channels in effective (customized) order. Everything else reads this. */
  channels: Channel[] = [];
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
  private channelByKey = new Map<string, Channel>();
  private channelByLegacyKey = new Map<string, Channel | null>();
  private indexedChannels: Channel[] | null = null;
  private indexedChannelCount = -1;
  private includeHidden = false;

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale channels do not survive navigation back to the channel
   * list view.
   */
  reset(): void {
    this.allChannels = [];
    this.channels = [];
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
    this.channelByKey = new Map();
    this.channelByLegacyKey = new Map();
    this.indexedChannels = null;
    this.indexedChannelCount = -1;
  }

  async load(): Promise<Channel[]> {
    const cached = StorageService.getCachedPlaylist();
    if (cached) {
      this.allChannels = cached.channels;
      this.epgSources = cached.epgSources;
      log.info('Cache hit:', this.allChannels.length, 'channels,', this.epgSources.length, 'epg sources');
      this.applyCustomization();
      this.buildPlaylistTabs();
      StorageService.migrateFavoriteKeys(this.channels);
      return this.channels;
    }
    log.info('Cache miss — refreshing from network');
    return this.refresh();
  }

  async refresh(): Promise<Channel[]> {
    const done = log.time('refresh');
    const playlists = StorageService.getPlaylists();
    if (!playlists.length) {
      log.warn('No playlists configured');
      done();
      return [];
    }

    const allChannels: Channel[] = [];
    const byUrl = new Map<string, Channel>();
    const epgSources: EpgSource[] = [];
    let allPlaylistsLoaded = true;
    const addEpgSource = (url: string, playlistId: string, kind: EpgSource['kind']): void => {
      const existing = epgSources.find((source) => source.url === url);
      if (existing) {
        if (!existing.playlistIds.includes(playlistId)) existing.playlistIds.push(playlistId);
        return;
      }
      epgSources.push({ url, playlistIds: [playlistId], kind });
    };

    for (const pl of playlists) {
      // Tag channels by the playlist's stable id, not its name or position, so
      // two playlists sharing a name/URL stay distinct and deleting/reordering
      // one never re-points another's channels.
      const plKey = pl.id;
      // An xtream account derives get.php (playlist) and xmltv.php (EPG) from its
      // credentials; everything downstream is the existing M3U path.
      const fetchUrl = pl.source === 'xtream' && pl.xtream
        ? xtreamPlaylistUrl({ baseUrl: pl.url, ...pl.xtream })
        : pl.url;
      const plDone = log.time(`fetch '${pl.name || pl.url}'`);
      try {
        const text = await fetchPlaylistText(fetchUrl, 60000);
        log.info('Fetched', pl.name || pl.url, '|', text.length, 'bytes');
        const parsed = parseM3U(text, fetchUrl);
        if (pl.source === 'xtream' && pl.xtream) {
          await this.applyXtreamCatchup(parsed.channels, { baseUrl: pl.url, ...pl.xtream }, plKey);
        }
        if (parsed.issues.length) {
          log.warn('Playlist diagnostics:',
            parsed.issues.slice(0, 5).map(issue => `${issue.code}@${issue.line}`).join(', '));
        }
        log.info('Parsed', parsed.channels.length, 'channels,', parsed.groups.length, 'groups',
          parsed.epgUrl ? `| epg: ${parsed.epgUrl}` : '');
        let added = 0, dupes = 0;
        for (const ch of parsed.channels) {
          const existing = byUrl.get(ch.url);
          if (existing) {
            // Same stream in an earlier playlist: keep the one channel object
            // (so "All" stays de-duplicated), but record this playlist too so
            // its own tab still appears and shows the channel.
            if (!existing.playlistIds.includes(plKey)) existing.playlistIds.push(plKey);
            dupes++;
          } else {
            ch.playlistIds = [plKey];
            byUrl.set(ch.url, ch);
            allChannels.push(ch);
            added++;
          }
        }
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
      } catch (err) {
        allPlaylistsLoaded = false;
        log.error(`Failed to load playlist '${pl.name || pl.url}':`, err);
      }
      plDone();
    }

    this.allChannels = allChannels;
    this.epgSources = epgSources;
    // Cache the raw parse: customization is a view over it, so an edit re-sorts
    // memory instead of forcing a re-fetch.
    if (allPlaylistsLoaded) {
      StorageService.setCachedPlaylist(allChannels, epgSources);
    } else {
      log.warn('Skipping cache write because one or more playlists failed');
    }
    this.applyCustomization();
    this.buildPlaylistTabs();
    StorageService.migrateFavoriteKeys(this.channels);
    log.info('Refresh complete:', allChannels.length, 'total channels,', epgSources.length, 'epg sources');
    done();
    return this.channels;
  }

  private async applyXtreamCatchup(
    channels: Channel[],
    credentials: XtreamCredentials,
    accountId: string,
  ): Promise<void> {
    const client = createXtreamClient(credentials);
    const streams = await client.getLiveStreams();
    const archived = new Map(streams
      .filter(stream => stream.archive)
      .map(stream => [stream.streamId, stream]));
    if (!archived.size) return;

    const clock = await client.getServerClock();
    let enabled = 0;
    for (const channel of channels) {
      const streamId = xtreamLiveStreamId(channel.url);
      const stream = archived.get(streamId);
      if (!stream) continue;
      channel.catchupAccountId = accountId;
      channel.catchupStreamId = streamId;
      if (!channel.catchupSource) {
        channel.catchup = 'xtream';
        channel.catchupSource = xtreamCatchupSource(credentials, streamId);
        channel.catchupFallbackSource = xtreamCatchupFallbackSource(credentials, streamId);
        channel.catchupDays = stream.archiveDurationDays;
        enabled++;
      }
      if (clock?.timeZone) channel.catchupTimeZone = clock.timeZone;
      if (clock?.offsetMinutes != null) channel.catchupTimeOffsetMinutes = clock.offsetMinutes;
    }
    log.info('Enabled Xtream catch-up for', enabled, 'channels');
  }

  /**
   * Rebuild `channels` from `allChannels` through the user's customization:
   * hidden channels drop out, the rest take the custom order, and renames and
   * group assignments are applied to the channel objects. Cheap enough to re-run
   * after every edit — no network, no re-parse.
   */
  applyCustomization(): void {
    const includeHidden = this.includeHidden || StorageService.getShowHiddenChannels();
    this.channels = ChannelCustomizationService.applyTo(this.allChannels, includeHidden);
    this.buildDerivedIndexes();
  }

  /** Edit mode reveals hidden channels so they can be un-hidden again. */
  setIncludeHidden(include: boolean): void {
    if (this.includeHidden === include) return;
    this.includeHidden = include;
    this.applyCustomization();
  }

  private buildDerivedIndexes(): void {
    const groupSet = new Set<string>();
    const groupSetsByPlaylist = new Map<string, Set<string>>();
    this.indexMap = new Map();
    this.channelsByGroup = new Map();
    this.channelsByPlaylist = new Map();
    this.channelsByPlaylistGroup = new Map();
    this.groupKeyByDisplay = new Map();
    this.channelByKey = new Map();
    this.channelByLegacyKey = new Map();

    for (const key of ChannelCustomizationService.customGroups) {
      this.groupKeyByDisplay.set(ChannelCustomizationService.groupLabel(key), key);
    }

    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      this.channelByKey.set(channelKey(ch), ch);
      const legacyKey = legacyChannelKey(ch);
      this.channelByLegacyKey.set(
        legacyKey,
        this.channelByLegacyKey.has(legacyKey) ? null : ch,
      );
      if (ch.group) {
        groupSet.add(ch.group);
        if (!this.groupKeyByDisplay.has(ch.group)) {
          this.groupKeyByDisplay.set(ch.group, groupKeyOf(ch));
        }
        this.appendIndexed(this.channelsByGroup, ch.group, ch);
      }
      for (const playlistId of ch.playlistIds) {
        this.appendIndexed(this.channelsByPlaylist, playlistId, ch);
        if (!ch.group) continue;
        let byGroup = this.channelsByPlaylistGroup.get(playlistId);
        if (!byGroup) {
          byGroup = new Map();
          this.channelsByPlaylistGroup.set(playlistId, byGroup);
        }
        this.appendIndexed(byGroup, ch.group, ch);
        let playlistGroups = groupSetsByPlaylist.get(playlistId);
        if (!playlistGroups) {
          playlistGroups = new Set();
          groupSetsByPlaylist.set(playlistId, playlistGroups);
        }
        playlistGroups.add(ch.group);
      }
    }
    for (const key of ChannelCustomizationService.customGroups) {
      const label = ChannelCustomizationService.groupLabel(key);
      groupSet.add(label);
      this.groupKeyByDisplay.set(label, key);
    }
    this.groups = this.orderGroups(Array.from(groupSet));
    this.groupsByPlaylist = new Map();
    groupSetsByPlaylist.forEach((playlistGroups, playlistId) => {
      this.groupsByPlaylist.set(playlistId, this.orderGroups(Array.from(playlistGroups)));
    });
    this.indexedChannels = this.channels;
    this.indexedChannelCount = this.channels.length;
    this.groupsRevision++;
  }

  private appendIndexed(map: Map<string, Channel[]>, key: string, channel: Channel): void {
    const existing = map.get(key);
    if (existing) existing.push(channel);
    else map.set(key, [channel]);
  }

  private ensureDerivedIndexes(): void {
    if (this.indexedChannels !== this.channels || this.indexedChannelCount !== this.channels.length) {
      this.buildDerivedIndexes();
    }
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
    const configured = StorageService.getPlaylists() || [];
    this.playlistTabs = configured.map(pl => ({ id: pl.id, name: pl.name || pl.url }));
  }

  getByGroup(group: ChannelGroupId, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const all = playlist ? this.channelsByPlaylist.get(playlist) ?? [] : this.channels;
    if (group === 'builtin:all' || group === 'builtin:recently-watched') return all;
    if (group === 'builtin:favorites') {
      const favorites = StorageService.getFavorites()
        .map(key => this.channelByKey.get(key))
        .filter((channel): channel is Channel =>
          !!channel && (!playlist || channel.playlistIds.includes(playlist)));
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

  /** Relevance-ranked name/genre search, optionally scoped to one playlist. Empty query → []. */
  search(query: string, playlist?: string): Channel[] {
    this.ensureDerivedIndexes();
    const pool = playlist ? this.channelsByPlaylist.get(playlist) ?? [] : this.channels;
    return rankChannels(pool, query);
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

  resolveChannelKey(key: string): { channel: Channel; channelIndex: number } | null {
    const channel = this.channelByKey.get(key) ?? this.channelByLegacyKey.get(key);
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

  private indexOfUniqueKey(key: string): number {
    let match = -1;
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      if (channelKey(channel) !== key && legacyChannelKey(channel) !== key) continue;
      if (match >= 0) return -1;
      match = i;
    }
    return match;
  }

  resolveLastChannelIndex(stableKey: string, legacyIndex: number): number {
    if (!stableKey) return legacyIndex;
    return this.indexOfUniqueKey(stableKey);
  }
}

export const PlaylistService = new PlaylistServiceImpl();
