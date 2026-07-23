import { describe, expect, it } from 'vitest';
import { t } from './index';

describe('i18n', () => {
  it('returns and interpolates English messages', () => {
    expect(t('channel.recentlyWatched')).toBe('Recently Watched');
    expect(t('channel.count', { count: 12 })).toBe('12 channels');
  });
});
