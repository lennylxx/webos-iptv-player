import type { Channel, ChannelGroupId, EpgSource, PlaylistTab } from '../types';
import { parseM3U } from '../parsers/m3u-parser';
import { fetchText } from '../utils/fetch-helper';
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
  playlistTabs: PlaylistTab[] = [];
  epgSources: EpgSource[] = [];
  private indexMap = new Map<Channel, number>(); // channel -> global index, O(1) indexOf
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
    this.playlistTabs = [];
    this.epgSources = [];
    this.indexMap = new Map();
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
        const text = await fetchText(fetchUrl, 60000);
        log.info('Fetched', pl.name || pl.url, '|', text.length, 'bytes');
        const parsed = parseM3U(text, fetchUrl);
        if (pl.source === 'xtream' && pl.xtream) {
          await this.applyXtreamCatchup(parsed.channels, { baseUrl: pl.url, ...pl.xtream }, plKey);
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
        if (parsed.epgUrl) {
          // Resolve localhost/127.0.0.1 in embedded EPG URL to the playlist's host
          let epg = parsed.epgUrl;
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
    this.buildGroups();
  }

  /** Edit mode reveals hidden channels so they can be un-hidden again. */
  setIncludeHidden(include: boolean): void {
    if (this.includeHidden === include) return;
    this.includeHidden = include;
    this.applyCustomization();
  }

  private buildGroups(): void {
    const groupSet = new Set<string>();
    this.indexMap = new Map();
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      if (ch.group) groupSet.add(ch.group);
    }
    for (const key of ChannelCustomizationService.customGroups) {
      groupSet.add(ChannelCustomizationService.groupLabel(key));
    }
    this.groups = this.orderGroups(Array.from(groupSet));
  }

  /** Sort display group names into the custom group order (keyed by group key). */
  private orderGroups(displayNames: string[]): string[] {
    const keyOf = new Map<string, string>();
    for (const key of ChannelCustomizationService.customGroups) {
      keyOf.set(ChannelCustomizationService.groupLabel(key), key);
    }
    for (const ch of this.channels) {
      if (ch.group && !keyOf.has(ch.group)) keyOf.set(ch.group, groupKeyOf(ch));
    }
    return displayNames
      .map((name, index) => ({
        name,
        rank: ChannelCustomizationService.groupRank(keyOf.get(name) ?? name, index),
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
    let filtered = this.channels;
    if (playlist) {
      filtered = filtered.filter(ch => ch.playlistIds.includes(playlist));
    }
    if (group === 'builtin:all' || group === 'builtin:recently-watched') return filtered;
    if (group === 'builtin:favorites') {
      const favs = StorageService.getFavorites();
      return filtered.filter(ch => favs.includes(channelKey(ch)));
    }
    const sourceGroup = group.slice('source:'.length);
    return filtered.filter(ch => ch.group === sourceGroup);
  }

  /** Relevance-ranked name/genre search, optionally scoped to one playlist. Empty query → []. */
  search(query: string, playlist?: string): Channel[] {
    const pool = playlist ? this.channels.filter(ch => ch.playlistIds.includes(playlist)) : this.channels;
    return rankChannels(pool, query);
  }

  getGroupsForPlaylist(playlist?: string): string[] {
    const channels = playlist
      ? this.channels.filter(ch => ch.playlistIds.includes(playlist))
      : this.channels;
    const groupSet = new Set<string>();
    for (const ch of channels) {
      if (ch.group) groupSet.add(ch.group);
    }
    if (!playlist) {
      for (const key of ChannelCustomizationService.customGroups) {
        groupSet.add(ChannelCustomizationService.groupLabel(key));
      }
    }
    return this.orderGroups(Array.from(groupSet));
  }

  getByIndex(index: number): Channel | null {
    return this.channels[index] ?? null;
  }

  indexOf(channel: Channel): number {
    return this.indexMap.get(channel) ?? -1;
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
