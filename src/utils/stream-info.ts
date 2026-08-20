import type { AudioTrackOption, SubtitleTrackOption } from '../types';
import { t } from '../i18n';

export type StreamVariant = {
  width: number; height: number; videoCodec: string; audioCodec: string;
  atmos: boolean; videoRange: string; frameRate: number;
};
export type ResolutionBadge = { label: string; tier: 'uhd' | 'fhd' | 'hd' | 'sd' };

// Container-header readout for VOD, produced by the media-probe parsers. Fields
// feed the existing helpers: `videoCodec`/`audioCodec` are fourCC keys for
// `codecName()`, `hdr` is a VIDEO-RANGE string for `hdrLabel()` ('PQ'/'HLG'/''),
// `fps` for `frameRateLabel()`. Any field may be zero/'' when the header omits it.
export interface MediaInfo {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  hdr: string;
}

// Height-based resolution tier. 0/falsy → null (resolution not known yet).
export function resolutionBadge(height: number): ResolutionBadge | null {
  if (!height) return null;
  if (height >= 2160) return { label: '4K', tier: 'uhd' };
  if (height >= 1080) return { label: '1080p', tier: 'fhd' };
  if (height >= 720) return { label: '720p', tier: 'hd' };
  return { label: 'SD', tier: 'sd' };
}

// HLS VIDEO-RANGE → badge text. PQ (SMPTE 2084, HDR10-class) shows "HDR"; HLG
// keeps its own name; SDR/unknown → '' (no badge). Caller omits empty.
export function hdrLabel(videoRange: string): string {
  const r = videoRange.trim().toUpperCase();
  if (r === 'PQ') return 'HDR';
  if (r === 'HLG') return 'HLG';
  return '';
}

// ITU-T H.273 (CICP) transfer-characteristics code → VIDEO-RANGE token for
// hdrLabel(). Shared by the MP4 (`colr`) and MKV (`Colour`) header parsers.
export function hdrFromTransfer(transfer: number): string {
  if (transfer === 16) return 'PQ'; // SMPTE ST 2084
  if (transfer === 18) return 'HLG'; // ARIB STD-B67
  return '';
}

// FRAME-RATE → whole-number label (59.94 → "60", 23.976 → "24"); 0 → '' (unknown).
export function frameRateLabel(fps: number): string {
  return fps > 0 ? String(Math.round(fps)) : '';
}

// Codec registry — single source of truth for both classify() (video/audio
// split when parsing a master playlist) and codecName() (OSD label). Add a
// codec in ONE place and both stay in sync. Keys are the lower-cased first
// dot-segment of a CODECS token (RFC 6381 / MP4RA sample-entry fourCCs), so
// 'avc1.640028' → 'avc1' and the hyphenated 'ec-3' → 'ec-3'.
const CODECS: Record<string, { kind: 'video' | 'audio'; name: string }> = {
  avc1: { kind: 'video', name: 'H.264' }, avc3: { kind: 'video', name: 'H.264' },
  hvc1: { kind: 'video', name: 'HEVC' }, hev1: { kind: 'video', name: 'HEVC' },
  hevc: { kind: 'video', name: 'HEVC' }, // hls.js' normalized alias, not a manifest fourCC — defensive
  dvh1: { kind: 'video', name: 'Dolby Vision' }, dvhe: { kind: 'video', name: 'Dolby Vision' },
  dvav: { kind: 'video', name: 'Dolby Vision' }, dva1: { kind: 'video', name: 'Dolby Vision' },
  dav1: { kind: 'video', name: 'Dolby Vision' }, dvc1: { kind: 'video', name: 'Dolby Vision' },
  vvc1: { kind: 'video', name: 'VVC' }, vvi1: { kind: 'video', name: 'VVC' },
  vp09: { kind: 'video', name: 'VP9' }, vp9: { kind: 'video', name: 'VP9' },
  vp08: { kind: 'video', name: 'VP8' }, vp8: { kind: 'video', name: 'VP8' },
  av01: { kind: 'video', name: 'AV1' }, mp4v: { kind: 'video', name: 'MPEG-4' },
  mp4a: { kind: 'audio', name: 'AAC' },
  'ac-3': { kind: 'audio', name: 'Dolby Digital' }, 'ec-3': { kind: 'audio', name: 'Dolby Digital+' },
  'ac-4': { kind: 'audio', name: 'Dolby AC-4' }, mlpa: { kind: 'audio', name: 'Dolby TrueHD' },
  opus: { kind: 'audio', name: 'Opus' }, mp3: { kind: 'audio', name: 'MP3' }, flac: { kind: 'audio', name: 'FLAC' },
  dtsc: { kind: 'audio', name: 'DTS' }, dtse: { kind: 'audio', name: 'DTS' },
};

const fourcc = (token: string): string => token.trim().toLowerCase().split('.')[0];

function classify(token: string): 'video' | 'audio' | null {
  return CODECS[fourcc(token)]?.kind ?? null;
}

// Parse master EXT-X-STREAM-INF lines into one variant each: RESOLUTION=WxH
// (0/0 when absent), the first video + first audio CODECS token (raw), VIDEO-RANGE,
// FRAME-RATE, and the Dolby Atmos flag. Atmos (Joint Object Coding) is signalled by
// CHANNELS="…/JOC" — almost always on the demuxed EXT-X-MEDIA audio rendition, which
// the variant only points at via AUDIO="group"; we also honour an inline CHANNELS.
export function parseVariants(manifest: string): StreamVariant[] {
  const lines = manifest.split(/\r?\n/);
  const atmosGroups = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/i.test(line)) continue;
    const grp = line.match(/GROUP-ID="([^"]*)"/i);
    const chan = line.match(/CHANNELS="([^"]*)"/i);
    if (grp && chan && /\bJOC\b/i.test(chan[1])) atmosGroups.add(grp[1]);
  }

  const variants: StreamVariant[] = [];
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const res = line.match(/RESOLUTION=(\d+)x(\d+)/i);
    const cod = line.match(/CODECS="([^"]*)"/i);
    const chan = line.match(/CHANNELS="([^"]*)"/i);
    const aud = line.match(/AUDIO="([^"]*)"/i);
    const fps = line.match(/FRAME-RATE=([\d.]+)/i);
    const range = line.match(/VIDEO-RANGE=([A-Za-z]+)/i);
    let videoCodec = '';
    let audioCodec = '';
    if (cod) {
      for (const tok of cod[1].split(',')) {
        const kind = classify(tok);
        if (kind === 'video' && !videoCodec) videoCodec = tok.trim();
        else if (kind === 'audio' && !audioCodec) audioCodec = tok.trim();
      }
    }
    variants.push({
      width: res ? parseInt(res[1], 10) : 0,
      height: res ? parseInt(res[2], 10) : 0,
      videoCodec,
      audioCodec,
      atmos: (chan ? /\bJOC\b/i.test(chan[1]) : false) || (aud ? atmosGroups.has(aud[1]) : false),
      videoRange: range ? range[1] : '',
      frameRate: fps ? parseFloat(fps[1]) : 0,
    });
  }
  return variants;
}

// Exact resolution match against the real videoWidth/Height. Unknown size → null.
export function pickVariant(variants: StreamVariant[], width: number, height: number): StreamVariant | null {
  if (!width || !height) return null;
  return variants.find(v => v.width === width && v.height === height) || null;
}

// Friendly name from a CODECS token; '' for empty/unknown (caller omits it).
export function codecName(codec: string): string {
  return CODECS[fourcc(codec)]?.name ?? '';
}

export function audioSummary(tracks: AudioTrackOption[]): string {
  if (!tracks.length) return '';
  // Audio has no "off" state — if no track is flagged active yet (the flag can
  // lag at tune-in), fall back to the first/default track, which is what plays.
  const active = tracks.find(t => t.active) ?? tracks[0];
  const label = active.label || t('player.audioTrack');
  return tracks.length > 1 ? `${label} (${tracks.length})` : label;
}

export function subtitleSummary(tracks: SubtitleTrackOption[]): string {
  if (!tracks.length) return '';
  const active = tracks.find(t => t.active);
  const base = active ? (active.label || t('settings.on')) : t('common.off');
  return tracks.length > 1 ? `${base} (${tracks.length})` : base;
}
