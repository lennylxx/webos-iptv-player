import type { AudioOption, SubtitleOption } from '../../types';
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
    destroy(): void | Promise<void> {
      return player.destroy();
    },
  };
}
