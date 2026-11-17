import { describe, expect, it } from 'vitest';
import {
  bpsOption,
  parseOverride,
  qualityRule,
  qualityTiers,
  serializeOverride,
  tierIndex,
  tiersInRange,
  type QualityTier,
} from './video-quality';
import type { StreamVariant } from './stream-info';

function variant(height: number, bandwidth: number, averageBandwidth = 0): StreamVariant {
  return {
    width: Math.round(height * 16 / 9), height, videoCodec: '', audioCodec: '',
    atmos: false, videoRange: '', frameRate: 0, bandwidth, averageBandwidth,
  };
}

// The ladder probed on a TV: AVERAGE-BANDWIDTH well below BANDWIDTH.
const LADDER = qualityTiers([
  variant(1080, 6000000, 4000000),
  variant(240, 600000, 400000),
  variant(720, 3000000, 2000000),
  variant(480, 1500000, 1000000),
]);

// Whether a bps range selects exactly the expected tiers when the TV ranks by
// either attribute.
function selected(bps: ReturnType<typeof bpsOption>, tiers: QualityTier[], by: 'bandwidth' | 'average'): number[] {
  return tiers
    .map((tier, index) => ({ index, value: by === 'bandwidth' ? tier.bandwidth : tier.averageBandwidth || tier.bandwidth }))
    .filter(({ value }) => (bps?.minimum === undefined || value >= bps.minimum)
      && (bps?.maximum === undefined || value <= bps.maximum))
    .map(({ index }) => index);
}

describe('qualityTiers', () => {
  it('drops an audio-only variant beside video ones, so Lowest still shows a picture', () => {
    const audio = { ...variant(0, 64000), width: 0, audioCodec: 'mp4a.40.2' };
    const tiers = qualityTiers([audio, variant(480, 1500000), variant(720, 3000000)]);
    expect(tiers.map(tier => tier.height)).toEqual([480, 720]);
    expect(selected(bpsOption(qualityRule('lowest', null), tiers), tiers, 'bandwidth')).toEqual([0]);
  });

  it('sorts by rate and drops variants without a bandwidth or with a repeated rate', () => {
    const tiers = qualityTiers([variant(720, 3000000), variant(0, 0), variant(480, 1500000), variant(720, 3000000)]);
    expect(tiers.map(tier => tier.height)).toEqual([480, 720]);
  });
});

describe('bpsOption', () => {
  it('leaves Auto to the TV and starts Highest above every variant', () => {
    expect(bpsOption(qualityRule('auto', null), LADDER)).toBeNull();
    expect(bpsOption(qualityRule('highest', null), [])).toEqual({ start: 1000000000 });
  });

  it('starts Highest on the known top tier under either start rule', () => {
    const bps = bpsOption(qualityRule('highest', null), LADDER);
    expect(bps).toEqual({ start: 4000000 });
    // webOS 25: the highest at or below start; webOS 4: the first at or above it.
    expect(LADDER.filter(tier => (tier.averageBandwidth || tier.bandwidth) <= bps!.start!).pop()?.height).toBe(1080);
    expect(LADDER.find(tier => tier.bandwidth >= bps!.start!)?.height).toBe(1080);
  });

  it('caps a resolution limit below the next tier under either bandwidth attribute', () => {
    const bps = bpsOption(qualityRule('max720', null), LADDER);
    expect(selected(bps, LADDER, 'bandwidth')).toEqual([0, 1, 2]);
    expect(selected(bps, LADDER, 'average')).toEqual([0, 1, 2]);
  });

  it('applies no cap when every tier fits, and pins the lowest when none does', () => {
    expect(bpsOption(qualityRule('max2160', null), LADDER)).toBeNull();
    const ladder = qualityTiers([variant(1080, 6000000), variant(2160, 16000000)]);
    expect(selected(bpsOption(qualityRule('max720', null), ladder), ladder, 'bandwidth')).toEqual([0]);
  });

  it('pins Lowest and a picked tier to exactly that tier', () => {
    for (const by of ['bandwidth', 'average'] as const) {
      expect(selected(bpsOption(qualityRule('lowest', null), LADDER), LADDER, by)).toEqual([0]);
      const pick = qualityRule('auto', { height: 480, bandwidth: 1500000 });
      expect(selected(bpsOption(pick, LADDER), LADDER, by)).toEqual([1]);
    }
  });

  it('keeps a pinned tier in range under either attribute when neighbors overlap', () => {
    const ladder = qualityTiers([variant(480, 2500000, 1000000), variant(720, 3000000, 2000000)]);
    const bps = bpsOption(qualityRule('lowest', null), ladder);
    expect(bps).toEqual({ maximum: 2500000 });
    expect(selected(bps, ladder, 'bandwidth')).toEqual([0]);
    expect(selected(bps, ladder, 'average')).toContain(0);
  });

  it('leaves a single-variant stream alone', () => {
    expect(bpsOption(qualityRule('lowest', null), qualityTiers([variant(720, 3000000)]))).toBeNull();
  });
});

describe('tierIndex', () => {
  it('finds a pick by bandwidth, then by height, then the highest tier below it', () => {
    expect(tierIndex(qualityRule('auto', { height: 720, bandwidth: 3000000 }), LADDER)).toBe(2);
    expect(tierIndex(qualityRule('auto', { height: 720, bandwidth: 2800000 }), LADDER)).toBe(2);
    expect(tierIndex(qualityRule('auto', { height: 900, bandwidth: 5000000 }), LADDER)).toBe(2);
    expect(tierIndex(qualityRule('auto', { height: 144, bandwidth: 100000 }), LADDER)).toBe(0);
  });
});

describe('tiersInRange', () => {
  it('lists the tiers a range keeps', () => {
    expect(tiersInRange(bpsOption(qualityRule('max1080', null), LADDER), LADDER)).toEqual([0, 1, 2, 3]);
    expect(tiersInRange(bpsOption(qualityRule('max720', null), LADDER), LADDER)).toEqual([0, 1, 2]);
  });
});

describe('override', () => {
  it('round-trips and rejects malformed values', () => {
    const pick = { height: 1080, bandwidth: 6000000 };
    expect(parseOverride(serializeOverride(pick))).toEqual(pick);
    expect(parseOverride('auto')).toBe('auto');
    expect(parseOverride('tier:1080:0')).toBeNull();
    expect(parseOverride(42)).toBeNull();
  });
});
