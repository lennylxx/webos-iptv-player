import { CONFIG } from '../config';
import type { CatchupInfo, CatchupProgressEntry, Channel } from '../types';
import { channelKey } from '../utils/channel';
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

function channelMap(): Map<string, { channel: Channel; channelIndex: number }> {
  const result = new Map<string, { channel: Channel; channelIndex: number }>();
  for (let i = 0; i < PlaylistService.channels.length; i++) {
    const channel = PlaylistService.channels[i];
    result.set(channelKey(channel), { channel, channelIndex: i });
  }
  return result;
}

function matchesPlaylist(channel: Channel, playlistId?: string): boolean {
  return !playlistId || channel.playlistIds.includes(playlistId);
}

function resolveLegacyProgress(
  progress: CatchupProgressEntry,
  channel: Channel,
): CatchupProgressEntry | null {
  if (progress.title !== undefined) return progress;
  const epgId = EpgService.findChannelId(channel);
  if (!epgId) return null;
  const programme = EpgService.programmes[epgId]?.find(
    item => item.start.getTime() === progress.progStart,
  );
  if (!programme) return null;
  return {
    ...progress,
    title: programme.title,
    description: programme.description,
    icon: programme.icon,
  };
}

function removeUnavailable(progress: CatchupProgressEntry): void {
  StorageService.clearCatchupProgress(progress.channelKey, progress.progStart);
}

export const RecentlyWatchedService = {
  getItems(playlistId?: string): RecentlyWatchedItem[] {
    const channels = channelMap();
    const items: RecentlyWatchedItem[] = [];

    for (const entry of StorageService.getRecentlyWatchedLive()) {
      const resolved = channels.get(entry.channelKey);
      if (!resolved || !matchesPlaylist(resolved.channel, playlistId)) continue;
      items.push({
        kind: 'live',
        ...resolved,
        updatedAt: entry.updatedAt,
      });
    }

    for (const stored of StorageService.getAllCatchupProgress()) {
      if (stored.completed || stored.position < CONFIG.CATCHUP.RESUME_MIN_SECS) continue;
      const resolved = channels.get(stored.channelKey);
      if (!resolved || !matchesPlaylist(resolved.channel, playlistId)) continue;
      if (!XtreamArchiveService.isAvailable(resolved.channel, stored.progStart)) {
        removeUnavailable(stored);
        continue;
      }
      const progress = resolveLegacyProgress(stored, resolved.channel);
      if (!progress) continue;
      items.push({
        kind: 'catchup',
        ...resolved,
        progress,
        updatedAt: progress.updatedAt,
      });
    }

    return items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONFIG.RECENTLY_WATCHED.MAX_VISIBLE_ITEMS);
  },

  async catchupInfo(item: Extract<RecentlyWatchedItem, { kind: 'catchup' }>): Promise<CatchupInfo | null> {
    await XtreamArchiveService.load(item.channel);
    if (!XtreamArchiveService.isAvailable(item.channel, item.progress.progStart)) {
      removeUnavailable(item.progress);
      return null;
    }
    return {
      start: Math.floor(item.progress.progStart / 1000),
      end: Math.floor(item.progress.progEnd / 1000),
      title: item.progress.title ?? '',
      description: item.progress.description ?? '',
      icon: item.progress.icon ?? '',
      resumeSecs: item.progress.position,
    };
  },
};
