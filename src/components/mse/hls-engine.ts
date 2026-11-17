import type { AudioOption, SubtitleOption } from '../../types';
import { hlsAudioOptions } from '../../utils/audio-tracks';
import { hlsSubtitleOptions } from '../../utils/subtitle-tracks';
import { qualityTiers, type BpsOption, type QualityTier } from '../../utils/video-quality';
import type { MseEngine, PipelineStreamInfo } from './engine';

type HlsInstance = InstanceType<typeof import('hls.js').default>;

type HlsLevel = HlsInstance['levels'][number];

// The declared rates: hls.js's averageBitrate drifts with the measured one
// when the master has no AVERAGE-BANDWIDTH.
function averageOf(level: HlsLevel): number {
  return Number(level.attrs?.['AVERAGE-BANDWIDTH']) || 0;
}

function rateOf(level: HlsLevel): number {
  return averageOf(level) || level.maxBitrate;
}

export function hlsQualityTiers(hls: HlsInstance): QualityTier[] {
  return qualityTiers((hls.levels || []).map(level => ({
    width: level.width,
    height: level.height,
    bandwidth: level.maxBitrate,
    averageBandwidth: averageOf(level),
    videoCodec: level.videoCodec,
  })));
}

// Before startLoad: hls.js keeps its levels sorted, height before bitrate.
export function applyHlsQuality(hls: HlsInstance, bps: BpsOption | null): void {
  const levels = hls.levels || [];
  if (!bps || !levels.length) return;
  if (bps.start !== undefined) {
    let top = 0;
    levels.forEach((level, index) => { if (rateOf(level) > rateOf(levels[top])) top = index; });
    hls.startLevel = top;
  }
  if (bps.minimum === undefined && bps.maximum === undefined) return;
  const allowed: number[] = [];
  levels.forEach((level, index) => {
    const rate = rateOf(level);
    if ((bps.minimum === undefined || rate >= bps.minimum)
      && (bps.maximum === undefined || rate <= bps.maximum)) allowed.push(index);
  });
  if (!allowed.length) return;
  // A pin is a manual level: hls.js sorts levels by height before bitrate, so
  // capping and a minimum bitrate could still let a level outside it in.
  if (bps.minimum !== undefined) {
    hls.startLevel = allowed[0];
    hls.loadLevel = allowed[0];
    return;
  }
  hls.autoLevelCapping = allowed[allowed.length - 1];
}

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
    qualityTiers(): QualityTier[] {
      return hlsQualityTiers(hls);
    },
    destroy(): void {
      hls.destroy();
    },
  };
}
