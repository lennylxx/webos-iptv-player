// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  isLocalePreference,
  localeOptions,
  resolveLocale,
  setLocale,
  t,
  validateTranslations,
} from './index';

describe('i18n', () => {
  it('returns and interpolates English messages', () => {
    expect(t('channel.recentlyWatched')).toBe('Recently Watched');
    expect(t('channel.count', { count: 12 })).toBe('12 channels');
  });

  it('resolves supported Simplified Chinese system locales', () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-SG')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-TW')).toBe('en');
    expect(resolveLocale('system', 'zh-Hant-CN')).toBe('en');
    expect(resolveLocale('system', 'de-DE')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('recognizes locale preferences from the registered message catalogs', () => {
    expect(isLocalePreference('system')).toBe(true);
    expect(isLocalePreference('en')).toBe(true);
    expect(isLocalePreference('zh-CN')).toBe(true);
    expect(isLocalePreference('l1')).toBe(false);
  });

  it('exposes the default and Settings options from the locale registry', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(localeOptions()).toEqual([
      { value: 'en', label: 'English' },
      { value: 'zh-CN', label: '简体中文' },
    ]);
  });

  it('translates and interpolates Simplified Chinese messages', () => {
    setLocale('zh-CN');
    expect(t('channel.recentlyWatched')).toBe('最近观看');
    expect(t('channel.count', { count: 12 })).toBe('12 个频道');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('has no empty translations or mismatched placeholders', () => {
    expect(validateTranslations()).toEqual([]);
  });
});
