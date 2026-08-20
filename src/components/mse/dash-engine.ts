import type { AudioOption, SubtitleOption } from '../../types';
import type { MseEngine, PipelineStreamInfo } from './engine';

// Minimal dash.js global surface consumed by the desktop preview adapter.
interface DashDescriptor {
  schemeIdUri?: string;
  value?: string;
}

interface DashTrack {
  index?: number | null;
  lang?: string | null;
  labels?: { text: string }[];
  roles?: DashDescriptor[] | null;
  codec?: string | null;
  audioChannelConfiguration?: DashDescriptor[] | null;
}

export interface DashPlayerLike {
  getTracksFor(type: string): DashTrack[];
  getCurrentTrackFor(type: string): DashTrack | null;
  getCurrentTextTrackIndex(): number;
  setCurrentTrack(track: DashTrack): void;
  setTextTrack(index: number): void;
  destroy(): void;
}

const ROLE_SCHEME = 'urn:mpeg:dash:role:2011';

function label(track: DashTrack): string {
  return track.labels?.[0]?.text || '';
}

// DASH marks the primary rendition with Role@value="main"; a forced subtitle
// uses the "forced-subtitle" role. Both arrive as DescriptorType objects.
function hasRole(track: DashTrack, role: string): boolean {
  return (track.roles || []).some(r =>
    r.value === role && (!r.schemeIdUri || r.schemeIdUri === ROLE_SCHEME));
}

function isSameTrack(a: DashTrack | null, b: DashTrack): boolean {
  if (!a) return false;
  if (a.index !== undefined && a.index !== null &&
      b.index !== undefined && b.index !== null) {
    return a.index === b.index;
  }
  return a === b;
}

// `video/mp4;codecs="hvc1.2.4.L120.90"` → `hvc1.2.4.L120.90`.
function codecName(track: DashTrack | null): string {
  const codec = track?.codec ?? '';
  return codec.match(/codecs="?([^"]+)"?/)?.[1] ?? codec;
}

export function createDashEngine(player: DashPlayerLike): MseEngine {
  return {
    audioOptions(): AudioOption[] {
      const current = player.getCurrentTrackFor('audio');
      return player.getTracksFor('audio').map((track, index) => ({
        index,
        name: label(track),
        lang: track.lang || '',
        isDefault: hasRole(track, 'main'),
        active: isSameTrack(current, track),
      }));
    },
    setAudioTrack(index: number): boolean {
      const tracks = player.getTracksFor('audio');
      if (index < 0 || index >= tracks.length) return false;
      player.setCurrentTrack(tracks[index]);
      return true;
    },
    subtitleOptions(): SubtitleOption[] {
      const active = player.getCurrentTextTrackIndex();
      return player.getTracksFor('text').map((track, index) => ({
        index,
        name: label(track),
        lang: track.lang || '',
        isDefault: hasRole(track, 'main'),
        isForced: hasRole(track, 'forced-subtitle'),
        active: index === active,
      }));
    },
    setSubtitleTrack(index: number): boolean {
      // dash.js takes -1 as "no subtitles".
      player.setTextTrack(index < 0 ? -1 : index);
      return true;
    },
    streamInfo(): PipelineStreamInfo | null {
      const audio = player.getCurrentTrackFor('audio');
      return {
        videoCodec: codecName(player.getCurrentTrackFor('video')),
        audioCodec: codecName(audio),
        // The OSD fills HDR and frame rate from the manifest variant matched to
        // the element's resolution.
        videoRange: '',
        frameRate: 0,
        audioChannels: audio?.audioChannelConfiguration?.[0]?.value ?? '',
      };
    },
    destroy(): void {
      player.destroy();
    },
  };
}
