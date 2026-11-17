import type { AudioOption, SubtitleOption } from '../../types';
import { qualityTiers, tierIndex, tierRate, type QualityRule, type QualityTier } from '../../utils/video-quality';
import type { MseEngine, PipelineStreamInfo } from './engine';

interface ShakaAudioTrack {
  active: boolean;
  channelsCount: number | null;
  codecs: string | null;
  label: string | null;
  language: string;
  primary: boolean;
}

interface ShakaTextTrack {
  active: boolean;
  forced: boolean;
  label: string | null;
  language: string;
  primary: boolean;
}

interface ShakaVariantTrack {
  active: boolean;
  bandwidth?: number;
  width?: number | null;
  height?: number | null;
  videoId?: number | null;
  audioId?: number | null;
  audioCodec: string | null;
  channelsCount: number | null;
  frameRate: number | null;
  hdr: string | null;
  videoCodec: string | null;
  spatialAudio?: boolean;
}

export interface ShakaPlayerLike {
  getAudioTracks(): ShakaAudioTrack[];
  getTextTracks(): ShakaTextTrack[];
  getVariantTracks(): ShakaVariantTrack[];
  selectAudioTrack(track: ShakaAudioTrack): void;
  selectTextTrack(track?: ShakaTextTrack | null): void;
  destroy(): void | Promise<void>;
}

interface ShakaVideo {
  tier: QualityTier;
  /** Every audio pairing's combined bandwidth, which Shaka's restrictions compare. */
  bandwidths: number[];
}

// Shaka lists one variant per video and audio pairing; a tier is a video, shown
// at its bandwidth with the playing audio.
function shakaVideos(player: ShakaPlayerLike): ShakaVideo[] {
  const tracks = player.getVariantTracks();
  const audioId = tracks.find(track => track.active)?.audioId;
  const videos = new Map<string, ShakaVideo>();
  for (const track of tracks) {
    const bandwidth = track.bandwidth || 0;
    const key = track.videoId !== null && track.videoId !== undefined
      ? `id:${track.videoId}` : `${track.height || 0}:${track.videoCodec || ''}:${bandwidth}`;
    let video = videos.get(key);
    if (!video) {
      video = {
        tier: { width: track.width || 0, height: track.height || 0, bandwidth, averageBandwidth: 0 },
        bandwidths: [],
      };
      videos.set(key, video);
    }
    video.bandwidths.push(bandwidth);
    if (track.audioId === audioId) video.tier.bandwidth = bandwidth;
  }
  return Array.from(videos.values());
}

export function shakaQualityTiers(player: ShakaPlayerLike): QualityTier[] {
  return qualityTiers(shakaVideos(player).map(video => ({ ...video.tier, videoCodec: 'video' })));
}

/** Shaka restrictions for a rule; null leaves its ABR alone. */
export function shakaRestrictions(player: ShakaPlayerLike, rule: QualityRule): Record<string, number> | null {
  const videos = shakaVideos(player);
  const tiers = qualityTiers(videos.map(video => ({ ...video.tier, videoCodec: 'video' })));
  if (tiers.length < 2) return null;
  // Shaka fails the stream when a restriction leaves no variant, so a cap
  // below every variant plays the lowest one, as the TV does.
  const lowest = rule.kind === 'lowest'
    || (rule.kind === 'max' && !tiers.some(tier => !tier.height || tier.height <= rule.height));
  if (rule.kind === 'max' && !lowest) {
    return tiers.some(tier => tier.height > rule.height) ? { maxHeight: rule.height } : null;
  }
  if (!lowest && rule.kind !== 'tier') return null;
  const tier = tiers[lowest ? 0 : tierIndex(rule, tiers)];
  const video = videos.find(candidate => tierRate(candidate.tier) === tierRate(tier));
  if (!video) return null;
  return {
    minBandwidth: Math.min(...video.bandwidths),
    maxBandwidth: Math.max(...video.bandwidths),
    ...(tier.height ? { minHeight: tier.height, maxHeight: tier.height } : {}),
  };
}

export function createShakaEngine(player: ShakaPlayerLike): MseEngine {
  return {
    audioOptions(): AudioOption[] {
      return player.getAudioTracks().map((track, index) => ({
        index,
        name: track.label || '',
        lang: track.language || '',
        isDefault: track.primary,
        active: track.active,
      }));
    },
    setAudioTrack(index: number): boolean {
      const tracks = player.getAudioTracks();
      if (index < 0 || index >= tracks.length) return false;
      if (!tracks[index].active) player.selectAudioTrack(tracks[index]);
      return true;
    },
    subtitleOptions(): SubtitleOption[] {
      return player.getTextTracks().map((track, index) => ({
        index,
        name: track.label || '',
        lang: track.language || '',
        isDefault: track.primary,
        isForced: track.forced,
        active: track.active,
      }));
    },
    setSubtitleTrack(index: number): boolean {
      const tracks = player.getTextTracks();
      if (index < 0) {
        if (tracks.some(track => track.active)) player.selectTextTrack();
        return true;
      }
      if (index >= tracks.length) return false;
      if (!tracks[index].active) player.selectTextTrack(tracks[index]);
      return true;
    },
    streamInfo(): PipelineStreamInfo | null {
      const active = player.getVariantTracks().find(track => track.active);
      if (!active) return null;
      return {
        videoCodec: active.videoCodec || '',
        audioCodec: active.audioCodec || '',
        videoRange: active.hdr || '',
        frameRate: active.frameRate || 0,
        audioChannels: active.channelsCount ? String(active.channelsCount) : '',
        audioAtmos: active.spatialAudio === true && active.audioCodec?.trim().toLowerCase().split('.')[0] === 'ec-3',
      };
    },
    qualityTiers(): QualityTier[] {
      return shakaQualityTiers(player);
    },
    destroy(): void | Promise<void> {
      return player.destroy();
    },
  };
}
