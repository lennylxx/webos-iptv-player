import { CONFIG } from '../config';
import type { CatchupInfo, CatchupProgressEntry, Channel } from '../types';
import { catchupNeedsId } from '../utils/catchup-url';
import { EpgService } from './epg-service';
import { PlaylistService } from './playlist-service';
import { StorageService } from './storage-service';
import { XtreamArchiveService } from './xtream-archive';

export type RecentlyWatchedItem =
  | {
      kind: 'live';
      channel: Channel;
      channelIndex: number;
      updatedAt: number;
    }
  | {
      kind: 'catchup';
      channel: Channel;
      channelIndex: number;
      progress: CatchupProgressEntry;
      updatedAt: number;
    };

function matchesPlaylist(channel: Channel, playlistId?: string): boolean {
  return !playlistId || channel.playlistIds.includes(playlistId);
}

interface CatchupIdLookup {
  id?: string;
  /** False while the guide cannot tell: not loaded, or cached without ids. */
  known: boolean;
}

// Progress saved before catch-up ids were kept takes the guide's, for the
// channels whose URL needs one.
function savedCatchupId(channel: Channel, progress: CatchupProgressEntry): CatchupIdLookup {
  if (progress.catchupId || !catchupNeedsId(channel)) return { id: progress.catchupId, known: true };
  const epgId = EpgService.findChannelId(channel);
  if (!epgId || !EpgService.catchupIdsKnown(channel)) return { known: false };
  const programme = EpgService.getProgrammeAtStart(epgId, progress.progStart);
  return programme ? { id: programme.catchupId, known: true } : { known: false };
}

function removeUnavailable(progress: CatchupProgressEntry): void {
  StorageService.clearCatchupProgress(progress.channelKey, progress.progStart);
}

export const RecentlyWatchedService = {
  getItems(playlistId?: string): RecentlyWatchedItem[] {
    const items: RecentlyWatchedItem[] = [];

    for (const entry of StorageService.getRecentlyWatchedLive()) {
      const resolved = PlaylistService.resolveChannelKey(entry.channelKey, undefined,
        channel => matchesPlaylist(channel, playlistId));
      if (!resolved || !matchesPlaylist(resolved.channel, playlistId)) continue;
      items.push({
        kind: 'live',
        ...resolved,
        updatedAt: entry.updatedAt,
      });
    }

    for (const stored of StorageService.getAllCatchupProgress()) {
      if (stored.completed || stored.position < CONFIG.CATCHUP.RESUME_MIN_SECS) continue;
      const resolved = PlaylistService.resolveChannelKey(stored.channelKey, undefined,
        channel => matchesPlaylist(channel, playlistId));
      if (!resolved || !matchesPlaylist(resolved.channel, playlistId)) continue;
      const lookup = savedCatchupId(resolved.channel, stored);
      // Kept until the guide can say whether the program has an id.
      if (!lookup.known) continue;
      if (!XtreamArchiveService.isAvailable(resolved.channel, stored.progStart, Date.now(), lookup.id)) {
        removeUnavailable(stored);
        continue;
      }
      items.push({
        kind: 'catchup',
        ...resolved,
        progress: stored,
        updatedAt: stored.updatedAt,
      });
    }

    return items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONFIG.RECENTLY_WATCHED.MAX_VISIBLE_ITEMS);
  },

  async catchupInfo(item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>): Promise<CatchupInfo | null> {
    await XtreamArchiveService.load(item.channel);
    const lookup = savedCatchupId(item.channel, item.progress);
    if (!lookup.known) return null;
    const catchupId = lookup.id;
    if (!XtreamArchiveService.isAvailable(item.channel, item.progress.progStart, Date.now(), catchupId)) {
      removeUnavailable(item.progress);
      return null;
    }
    return {
      start: Math.floor(item.progress.progStart / 1000),
      end: Math.floor(item.progress.progEnd / 1000),
      title: item.progress.title ?? '',
      description: item.progress.description ?? '',
      icon: item.progress.icon ?? '',
      epgSourceUrl: item.progress.epgSourceUrl,
      ...(catchupId ? { catchupId } : {}),
      resumeSecs: item.progress.position,
    };
  },
};
