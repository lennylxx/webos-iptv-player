import type { AudioOption, SubtitleOption } from '../../types';
import type { QualityTier } from '../../utils/video-quality';

export interface PipelineStreamInfo {
  videoCodec: string;
  audioCodec: string;
  videoRange: string;
  frameRate: number;
  audioChannels: string;
  audioAtmos?: boolean;
}

// The desktop preview plays through an MSE library — hls.js or Shaka — which
// then owns the audio/text renditions. Both are reached through this one
// interface so the track code stays engine-agnostic.
export interface MseEngine {
  audioOptions(): AudioOption[];
  setAudioTrack(index: number): boolean;
  subtitleOptions(): SubtitleOption[];
  setSubtitleTrack(index: number): boolean;
  streamInfo(): PipelineStreamInfo | null;
  qualityTiers(): QualityTier[];
  destroy(): void | Promise<void>;
}
