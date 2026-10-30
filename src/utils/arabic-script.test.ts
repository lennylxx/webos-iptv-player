import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageService } from '../services/storage-service';
import { hasArabicScript, hiddenAsArabic } from './arabic-script';

describe('arabic script', () => {
  afterEach(() => vi.restoreAllMocks());

  it('finds Arabic letters in any part of a name', () => {
    expect(hasArabicScript('قناة')).toBe(true);
    expect(hasArabicScript('Alpha - فيلم')).toBe(true);
    expect(hasArabicScript('\uFEFB')).toBe(true);
    expect(hasArabicScript('Alpha (2021)')).toBe(false);
    expect(hasArabicScript('AR | Bravo')).toBe(false);
    expect(hasArabicScript('Ünïcödé Ελληνικά Кириллица')).toBe(false);
    expect(hasArabicScript(undefined)).toBe(false);
  });

  it('hides only while the setting is on', () => {
    const setting = vi.spyOn(StorageService, 'getHideArabic').mockReturnValue(false);
    expect(hiddenAsArabic('قناة')).toBe(false);
    setting.mockReturnValue(true);
    expect(hiddenAsArabic('Alpha', 'قناة')).toBe(true);
    expect(hiddenAsArabic('Alpha', undefined)).toBe(false);
  });
});
