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
    expect(resolveLocale('system', 'es-ES')).toBe('es');
    expect(resolveLocale('system', 'es-MX')).toBe('es');
    expect(resolveLocale('system', 'fr-FR')).toBe('fr');
    expect(resolveLocale('system', 'fr-CA')).toBe('fr');
    expect(resolveLocale('system', 'pt-BR')).toBe('pt-BR');
    expect(resolveLocale('system', 'pt-PT')).toBe('pt-BR');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('recognizes locale preferences from the registered message catalogs', () => {
    expect(isLocalePreference('system')).toBe(true);
    expect(isLocalePreference('en')).toBe(true);
    expect(isLocalePreference('es')).toBe(true);
    expect(isLocalePreference('fr')).toBe(true);
    expect(isLocalePreference('pt-BR')).toBe(true);
    expect(isLocalePreference('zh-CN')).toBe(true);
    expect(isLocalePreference('l1')).toBe(false);
  });

  it('exposes the default and Settings options from the locale registry', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(localeOptions()).toEqual([
      { value: 'en', label: 'English' },
      { value: 'es', label: 'Español' },
      { value: 'fr', label: 'Français' },
      { value: 'pt-BR', label: 'Português (Brasil)' },
      { value: 'zh-CN', label: '简体中文' },
    ]);
  });

  it('translates and interpolates Simplified Chinese messages', () => {
    setLocale('zh-CN');
    expect(t('channel.recentlyWatched')).toBe('最近观看');
    expect(t('channel.count', { count: 12 })).toBe('12 个频道');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('translates and interpolates Spanish messages', () => {
    setLocale('es');
    expect(t('channel.recentlyWatched')).toBe('Vistos recientemente');
    expect(t('channel.count', { count: 12 })).toBe('12 canales');
    expect(document.documentElement.lang).toBe('es');
  });

  it('translates and interpolates French messages', () => {
    setLocale('fr');
    expect(t('channel.recentlyWatched')).toBe('Vus récemment');
    expect(t('channel.count', { count: 12 })).toBe('12 chaînes');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('translates and interpolates Brazilian Portuguese messages', () => {
    setLocale('pt-BR');
    expect(t('channel.recentlyWatched')).toBe('Assistidos recentemente');
    expect(t('channel.count', { count: 12 })).toBe('12 canais');
    expect(document.documentElement.lang).toBe('pt-BR');
  });

  it('enables pseudo-localization without exposing another locale option', () => {
    window.history.pushState({}, '', '?pseudo=1');
    try {
      setLocale('en');
      expect(t('channel.count', { count: 12 })).toContain('12');
      expect(t('channel.count', { count: 12 })).toMatch(/^\[!! /);
      expect(document.documentElement.lang).toBe('en-XA');
      expect(localeOptions().map(option => option.value)).not.toContain('en-XA');
    } finally {
      window.history.pushState({}, '', '/');
      setLocale('en');
    }
  });

  it('has no empty translations or mismatched placeholders', () => {
    expect(validateTranslations()).toEqual([]);
  });
});
