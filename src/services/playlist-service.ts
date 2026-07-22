import type { Channel, EpgSource, PlaylistTab } from '../types';
import { parseM3U } from '../parsers/m3u-parser';
import { fetchText } from '../utils/fetch-helper';
import { xtreamPlaylistUrl, xtreamEpgUrl } from '../utils/xtream-url';
import { channelKey } from '../utils/channel';
import { rankChannels } from '../utils/channel-search';
import { createLogger } from '../utils/logger';
import { StorageService } from './storage-service';

const log = createLogger('Playlist');

class PlaylistServiceImpl {
  channels: Channel[] = [];
  groups: string[] = [];
  playlistTabs: PlaylistTab[] = [];
  epgSources: EpgSource[] = [];
  private indexMap = new Map<Channel, number>(); // channel -> global index, O(1) indexOf

  /**
   * Clear all in-memory state. Called when the user removes every configured
   * playlist so stale channels do not survive navigation back to the channel
   * list view.
   */
  reset(): void {
    this.channels = [];
    this.groups = [];
    this.playlistTabs = [];
    this.epgSources = [];
    this.indexMap = new Map();
  }

  async load(): Promise<Channel[]> {
    const cached = StorageService.getCachedPlaylist();
    if (cached) {
      this.channels = cached.channels;
      this.epgSources = cached.epgSources;
      log.info('Cache hit:', this.channels.length, 'channels,', this.epgSources.length, 'epg sources');
      this.buildGroups();
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
        log.error(`Failed to load playlist '${pl.name || pl.url}':`, err);
      }
      plDone();
    }

    this.channels = allChannels;
    this.epgSources = epgSources;
    this.buildGroups();
    this.buildPlaylistTabs();
    StorageService.migrateFavoriteKeys(this.channels);
    StorageService.setCachedPlaylist(allChannels, epgSources);
    log.info('Refresh complete:', allChannels.length, 'total channels,', epgSources.length, 'epg sources');
    done();
    return allChannels;
  }

  private buildGroups(): void {
    const groupSet = new Set<string>();
    this.indexMap = new Map();
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      this.indexMap.set(ch, i);
      if (ch.group) groupSet.add(ch.group);
    }
    this.groups = Array.from(groupSet);
  }

  private buildPlaylistTabs(): void {
    // One tab per configured playlist, in config order, keyed by its stable id —
    // including a playlist that loaded zero channels (empty/unreachable feed), so
    // it stays visible. Derived from the registry, not the cached channels, so a
    // stale/desynced channel cache can never blank out the tab bar.
    const configured = StorageService.getPlaylists() || [];
    this.playlistTabs = configured.map(pl => ({ id: pl.id, name: pl.name || pl.url }));
  }

  getByGroup(group: string, playlist?: string): Channel[] {
    let filtered = this.channels;
    if (playlist) {
      filtered = filtered.filter(ch => ch.playlistIds.includes(playlist));
    }
    if (!group || group === 'All') return filtered;
    if (group === 'Favorites') {
      const favs = StorageService.getFavorites();
      return filtered.filter(ch => favs.includes(channelKey(ch)));
    }
    return filtered.filter(ch => ch.group === group);
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
    return Array.from(groupSet);
  }

  getByIndex(index: number): Channel | null {
    return this.channels[index] ?? null;
  }

  indexOf(channel: Channel): number {
    return this.indexMap.get(channel) ?? -1;
  }
}

export const PlaylistService = new PlaylistServiceImpl();
