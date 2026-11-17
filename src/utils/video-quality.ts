import type { StreamVariant } from './stream-info';

// The Video quality setting. webOS takes it as mediaOption
// option.adaptiveStreaming.bps (start/minimum/maximum). webOS 25 starts on the
// highest variant at or below `start`, webOS 4 on the first at or above it; both
// keep adaptive switching inside [minimum, maximum] for the whole session and
// drop the range when maximum < minimum. maxWidth/maxHeight only size the
// decoder, so a resolution cap is a bitrate cap.
export const VIDEO_QUALITIES = ['auto', 'highest', 'max2160', 'max1080', 'max720', 'lowest'] as const;
export type VideoQuality = typeof VIDEO_QUALITIES[number];

export function isVideoQuality(value: unknown): value is VideoQuality {
  return (VIDEO_QUALITIES as readonly unknown[]).indexOf(value) !== -1;
}

const CAP_HEIGHT: Partial<Record<VideoQuality, number>> = { max2160: 2160, max1080: 1080, max720: 720 };

// Above any IPTV variant, and inside the 32-bit int the TV parses.
const HIGHEST_START_BPS = 1000000000;

export interface QualityTier {
  width: number;
  height: number;
  bandwidth: number;
  averageBandwidth: number;
}

export type QualityRule =
  | { kind: 'auto' }
  | { kind: 'highest' }
  | { kind: 'lowest' }
  | { kind: 'max'; height: number }
  | { kind: 'tier'; height: number; bandwidth: number };

export interface BpsOption {
  start?: number;
  minimum?: number;
  maximum?: number;
}

// A channel's own pick from the player menu; absent follows the setting.
export type QualityOverride = 'auto' | { height: number; bandwidth: number };

export function serializeOverride(override: QualityOverride): string {
  return override === 'auto' ? 'auto' : `tier:${override.height}:${override.bandwidth}`;
}

export function parseOverride(value: unknown): QualityOverride | null {
  if (value === 'auto') return 'auto';
  if (typeof value !== 'string') return null;
  const match = /^tier:(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const bandwidth = parseInt(match[2], 10);
  return bandwidth > 0 ? { height: parseInt(match[1], 10), bandwidth } : null;
}

export function qualityRule(setting: VideoQuality, override: QualityOverride | null): QualityRule {
  if (override === 'auto') return { kind: 'auto' };
  if (override) return { kind: 'tier', height: override.height, bandwidth: override.bandwidth };
  if (setting === 'highest' || setting === 'lowest' || setting === 'auto') return { kind: setting };
  return { kind: 'max', height: CAP_HEIGHT[setting] ?? 0 };
}

/**
 * Whether the rule needs the stream's variants before playback starts.
 * startRoundsUp: the TV starts on the first variant at or above `start`
 * (webOS 4), so Highest names the top tier instead of a start above them all.
 */
export function needsTiers(rule: QualityRule, startRoundsUp = false): boolean {
  return rule.kind === 'lowest' || rule.kind === 'max' || rule.kind === 'tier'
    || (startRoundsUp && rule.kind === 'highest');
}

// The rate the TV ranks variants by: AVERAGE-BANDWIDTH when the master has it.
export function tierRate(tier: QualityTier): number {
  return rate(tier);
}

function rate(tier: QualityTier): number {
  return tier.averageBandwidth || tier.bandwidth;
}

function low(tier: QualityTier): number {
  return Math.min(tier.bandwidth, rate(tier));
}

function high(tier: QualityTier): number {
  return Math.max(tier.bandwidth, rate(tier));
}

type TierSource = Pick<StreamVariant, 'width' | 'height' | 'bandwidth' | 'averageBandwidth'>
  & { videoCodec?: string };

function hasVideo(variant: TierSource): boolean {
  return variant.height > 0 || !!variant.videoCodec;
}

/** Video variants with a bandwidth, one per rate, lowest first. */
export function qualityTiers(variants: readonly TierSource[]): QualityTier[] {
  // An audio-only variant beside video ones would pin a black screen.
  const video = variants.some(hasVideo);
  const tiers: QualityTier[] = [];
  for (const variant of variants) {
    if (video && !hasVideo(variant)) continue;
    const tier: QualityTier = {
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth || 0,
      averageBandwidth: variant.averageBandwidth || 0,
    };
    if (rate(tier) <= 0 || tiers.some(other => rate(other) === rate(tier))) continue;
    tiers.push(tier);
  }
  return tiers.sort((a, b) => rate(a) - rate(b));
}

/** The tier a pinned pick resolves to in this stream, or -1. */
export function tierIndex(rule: QualityRule, tiers: readonly QualityTier[]): number {
  if (!tiers.length) return -1;
  if (rule.kind === 'lowest') return 0;
  if (rule.kind !== 'tier') return -1;
  const exact = tiers.findIndex(tier => tier.bandwidth === rule.bandwidth);
  if (exact >= 0) return exact;
  let best = -1;
  tiers.forEach((tier, index) => {
    if (tier.height !== rule.height) return;
    if (best < 0 || Math.abs(tier.bandwidth - rule.bandwidth) < Math.abs(tiers[best].bandwidth - rule.bandwidth)) {
      best = index;
    }
  });
  if (best >= 0) return best;
  for (let index = tiers.length - 1; index >= 0; index--) {
    if (tiers[index].height && tiers[index].height <= rule.height) return index;
  }
  return 0;
}

// Bounds that keep tier k whether the TV ranks by BANDWIDTH or by
// AVERAGE-BANDWIDTH (webOS 4's choice is unknown). When a neighbor's two
// rates overlap tier k's, it may come along rather than leave nothing.
function upper(tiers: readonly QualityTier[], k: number): number | undefined {
  return k >= tiers.length - 1 ? undefined : high(tiers[k]);
}

function lower(tiers: readonly QualityTier[], k: number): number | undefined {
  return k <= 0 ? undefined : low(tiers[k]);
}

function range(minimum: number | undefined, maximum: number | undefined): BpsOption | null {
  const option: BpsOption = {};
  if (minimum !== undefined) option.minimum = minimum;
  if (maximum !== undefined) option.maximum = maximum;
  return option.minimum === undefined && option.maximum === undefined ? null : option;
}

/** The mediaOption bps for a rule; null leaves the TV's own choice. */
export function bpsOption(rule: QualityRule, tiers: readonly QualityTier[]): BpsOption | null {
  if (rule.kind === 'auto') return null;
  // webOS 4 starts on the first variant at or above start, so a known top
  // tier is named rather than left to a start above every variant.
  if (rule.kind === 'highest') {
    return { start: tiers.length ? low(tiers[tiers.length - 1]) : HIGHEST_START_BPS };
  }
  if (tiers.length < 2) return null;
  if (rule.kind === 'max') {
    let k = -1;
    tiers.forEach((tier, index) => {
      if (!tier.height || tier.height <= rule.height) k = index;
    });
    if (k < 0) k = 0;
    return range(undefined, upper(tiers, k));
  }
  const k = tierIndex(rule, tiers);
  return range(lower(tiers, k), upper(tiers, k));
}

/** The tiers inside a bps range, as indices; every tier when there is none. */
export function tiersInRange(bps: BpsOption | null, tiers: readonly QualityTier[]): number[] {
  const indices: number[] = [];
  tiers.forEach((tier, index) => {
    const value = rate(tier);
    if (bps?.minimum !== undefined && value < bps.minimum) return;
    if (bps?.maximum !== undefined && value > bps.maximum) return;
    indices.push(index);
  });
  return indices;
}

/** "4K", "1080p"; '' when the variant declares no resolution. */
export function resolutionName(height: number): string {
  if (height >= 4320) return '8K';
  if (height >= 2160) return '4K';
  return height > 0 ? `${height}p` : '';
}

export function capHeight(quality: VideoQuality): number {
  return CAP_HEIGHT[quality] ?? 0;
}
