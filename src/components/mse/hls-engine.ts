import type { AudioOption, SubtitleOption } from '../../types';
import { hlsAudioOptions } from '../../utils/audio-tracks';
import { hlsSubtitleOptions } from '../../utils/subtitle-tracks';
import type { MseEngine, PipelineStreamInfo } from './engine';

type HlsInstance = InstanceType<typeof import('hls.js').default>;

export function createHlsEngine(hls: HlsInstance): MseEngine {
  return {
    audioOptions(): AudioOption[] {
      return hlsAudioOptions(hls.audioTracks || [], hls.audioTrack);
    },
    setAudioTrack(index: number): boolean {
      if (index < 0 || index >= (hls.audioTracks?.length || 0)) return false;
      hls.audioTrack = index;
      return true;
    },
    subtitleOptions(): SubtitleOption[] {
      return hlsSubtitleOptions(hls.subtitleTracks || [], hls.subtitleTrack);
    },
    setSubtitleTrack(index: number): boolean {
      hls.subtitleDisplay = index >= 0;
      if (index < (hls.subtitleTracks?.length || 0)) hls.subtitleTrack = index;
      return true;
    },
    streamInfo(): PipelineStreamInfo | null {
      const level = hls.loadLevelObj;
      return {
        videoCodec: level?.videoCodec ?? '',
        audioCodec: level?.audioCodec ?? '',
        videoRange: level?.videoRange ?? '',
        frameRate: level?.frameRate ?? 0,
        audioChannels: hls.audioTracks?.[hls.audioTrack]?.channels ?? '',
      };
    },
    destroy(): void {
      hls.destroy();
    },
  };
}
