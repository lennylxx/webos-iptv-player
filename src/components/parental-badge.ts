import type { Channel, ChannelGroupId, SeriesItem, VodItem } from '../types';
import { PlaylistService } from '../services/playlist-service';
import {
  ParentalControlService,
  catalogParentalRequest,
  liveParentalRequest,
  type ParentalLockState,
} from '../services/parental-control';
import { LOCK_ICON, UNLOCK_ICON } from './icons';

// Trusted markup for `raw()`: a lock on content that asks for the PIN, an open
// lock on the same content while an unlock session lasts.
export function lockBadge(state: ParentalLockState): string {
  if (!state) return '';
  return `<span class="lock-badge ${state === 'locked' ? 'is-locked' : 'is-unlocked'}">${
    state === 'locked' ? LOCK_ICON : UNLOCK_ICON}</span>`;
}

export function channelLockState(channel: Channel): ParentalLockState {
  if (!ParentalControlService.enabled) return null;
  return ParentalControlService.lockState(liveParentalRequest(channel));
}

export function channelLockBadge(channel: Channel): string {
  return lockBadge(channelLockState(channel));
}

// `playlist` narrows to one source; '' covers every playlist holding the group.
export function liveGroupLockBadge(group: ChannelGroupId, playlist: string): string {
  if (!ParentalControlService.enabled || group.indexOf('source:') !== 0) return '';
  const groupKey = PlaylistService.getGroupKeyForDisplay(group.slice('source:'.length));
  const playlistIds = playlist ? [playlist] : PlaylistService.getPlaylistIdsForGroup(group);
  return lockBadge(ParentalControlService.groupLockState(playlistIds.map(playlistId => ({
    kind: 'live-group' as const,
    playlistId,
    groupKey,
  }))));
}

export function vodLockBadge(item: VodItem): string {
  if (!ParentalControlService.enabled) return '';
  return lockBadge(ParentalControlService.lockState(
    catalogParentalRequest('vod', { ...item, id: item.streamId }),
  ));
}

export function seriesLockBadge(item: SeriesItem): string {
  if (!ParentalControlService.enabled) return '';
  return lockBadge(ParentalControlService.lockState(
    catalogParentalRequest('series', { ...item, id: item.seriesId }),
  ));
}

export function categoryLockBadge(
  kind: 'vod' | 'series',
  accountId: string,
  categoryId: string,
): string {
  return lockBadge(ParentalControlService.groupLockState([{
    kind: kind === 'vod' ? 'vod-category' : 'series-category',
    accountId,
    categoryId,
  }]));
}
