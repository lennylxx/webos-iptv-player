// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  isLocalePreference,
  localeOptions,
  resolveLocale,
  setLocale,
  t,
  tp,
  validateTranslations,
} from './index';

describe('i18n', () => {
  it('returns and interpolates English messages', () => {
    expect(t('channel.recentlyWatched')).toBe('Recently Watched');
    expect(tp('channel.count', 12)).toBe('12 channels');
  });

  it('resolves supported Simplified Chinese system locales', () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-SG')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('system', 'zh-TW')).toBe('en');
    expect(resolveLocale('system', 'zh-Hant-CN')).toBe('en');
    expect(resolveLocale('system', 'de-DE')).toBe('de');
    expect(resolveLocale('system', 'de-AT')).toBe('de');
    expect(resolveLocale('system', 'es-ES')).toBe('es');
    expect(resolveLocale('system', 'es-MX')).toBe('es');
    expect(resolveLocale('system', 'fr-FR')).toBe('fr');
    expect(resolveLocale('system', 'fr-CA')).toBe('fr');
    expect(resolveLocale('system', 'it-IT')).toBe('it');
    expect(resolveLocale('system', 'it-CH')).toBe('it');
    expect(resolveLocale('system', 'pt-BR')).toBe('pt-BR');
    expect(resolveLocale('system', 'pt-PT')).toBe('pt-BR');
    expect(resolveLocale('system', 'ru-RU')).toBe('ru');
    expect(resolveLocale('system', 'ru-KZ')).toBe('ru');
    expect(resolveLocale('system', 'uk-UA')).toBe('uk');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });

  it('recognizes locale preferences from the registered message catalogs', () => {
    expect(isLocalePreference('system')).toBe(true);
    expect(isLocalePreference('en')).toBe(true);
    expect(isLocalePreference('de')).toBe(true);
    expect(isLocalePreference('es')).toBe(true);
    expect(isLocalePreference('fr')).toBe(true);
    expect(isLocalePreference('it')).toBe(true);
    expect(isLocalePreference('pt-BR')).toBe(true);
    expect(isLocalePreference('ru')).toBe(true);
    expect(isLocalePreference('uk')).toBe(true);
    expect(isLocalePreference('zh-CN')).toBe(true);
    expect(isLocalePreference('l1')).toBe(false);
  });

  it('exposes the default and Settings options from the locale registry', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(localeOptions()).toEqual([
      { value: 'en', label: 'English' },
      { value: 'de', label: 'Deutsch' },
      { value: 'es', label: 'Español' },
      { value: 'fr', label: 'Français' },
      { value: 'it', label: 'Italiano' },
      { value: 'pt-BR', label: 'Português (Brasil)' },
      { value: 'ru', label: 'Русский' },
      { value: 'uk', label: 'Українська' },
      { value: 'zh-CN', label: '简体中文' },
    ]);
  });

  it('translates and interpolates Simplified Chinese messages', () => {
    setLocale('zh-CN');
    expect(t('channel.recentlyWatched')).toBe('最近观看');
    expect(tp('channel.count', 12)).toBe('12 个频道');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('translates and interpolates German messages', () => {
    setLocale('de');
    expect(t('channel.recentlyWatched')).toBe('Zuletzt angesehen');
    expect(tp('channel.count', 12)).toBe('12 Sender');
    expect(document.documentElement.lang).toBe('de');
  });

  it('translates and interpolates Spanish messages', () => {
    setLocale('es');
    expect(t('channel.recentlyWatched')).toBe('Vistos recientemente');
    expect(tp('channel.count', 12)).toBe('12 canales');
    expect(document.documentElement.lang).toBe('es');
  });

  it('translates and interpolates French messages', () => {
    setLocale('fr');
    expect(t('channel.recentlyWatched')).toBe('Vus récemment');
    expect(tp('channel.count', 12)).toBe('12 chaînes');
    expect(document.documentElement.lang).toBe('fr');
  });

  it('translates and interpolates Brazilian Portuguese messages', () => {
    setLocale('pt-BR');
    expect(t('channel.recentlyWatched')).toBe('Assistidos recentemente');
    expect(tp('channel.count', 12)).toBe('12 canais');
    expect(document.documentElement.lang).toBe('pt-BR');
  });

  it('translates and interpolates Italian messages', () => {
    setLocale('it');
    expect(t('channel.recentlyWatched')).toBe('Visti di recente');
    expect(tp('channel.count', 12)).toBe('12 canali');
    expect(document.documentElement.lang).toBe('it');
  });

  it('translates and interpolates Russian messages', () => {
    setLocale('ru');
    expect(t('channel.recentlyWatched')).toBe('Недавно просмотренные');
    expect(tp('channel.count', 1)).toBe('1 канал');
    expect(tp('channel.count', 2)).toBe('2 канала');
    expect(tp('channel.count', 5)).toBe('5 каналов');
    expect(tp('channel.count', 11)).toBe('11 каналов');
    expect(tp('channel.count', 21)).toBe('21 канал');
    expect(tp('channel.count', 22)).toBe('22 канала');
    expect(tp('app.channelsLoaded', 22)).toBe('Загружено 22 канала');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('translates and pluralizes Ukrainian messages', () => {
    setLocale('uk');
    expect(t('channel.recentlyWatched')).toBe('Нещодавно переглянуті');
    expect(tp('channel.count', 1)).toBe('1 канал');
    expect(tp('channel.count', 2)).toBe('2 канали');
    expect(tp('channel.count', 5)).toBe('5 каналів');
    expect(tp('channel.count', 21)).toBe('21 канал');
    expect(document.documentElement.lang).toBe('uk');
  });

  it('enables pseudo-localization without exposing another locale option', () => {
    window.history.pushState({}, '', '?pseudo=1');
    try {
      setLocale('en');
      expect(tp('channel.count', 12)).toContain('12');
      expect(tp('channel.count', 12)).toMatch(/^\[!! /);
      expect(tp('channel.count', 12)).toMatch(/^\[!! /);
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
