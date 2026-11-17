import { formatNumber, t } from '../i18n';
import { capHeight, resolutionName, type QualityTier, type VideoQuality } from '../utils/video-quality';

export function videoQualityLabel(quality: VideoQuality): string {
  if (quality === 'auto') return t('player.qualityAuto');
  if (quality === 'highest') return t('player.qualityHighest');
  if (quality === 'lowest') return t('player.qualityLowest');
  return t('player.qualityUpTo', { resolution: resolutionName(capHeight(quality)) });
}

export function qualityTierLabel(tier: QualityTier): string {
  const bitrate = formatNumber(tier.bandwidth / 1000000, {
    maximumFractionDigits: tier.bandwidth < 10000000 ? 1 : 0,
  });
  const resolution = resolutionName(tier.height);
  return resolution
    ? t('player.qualityTier', { resolution, bitrate })
    : t('player.qualityBitrate', { bitrate });
}
