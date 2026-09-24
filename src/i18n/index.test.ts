// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  formatNumber,
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
    expect(t('app.loadingChannelsProgress', {
      processed: 1024,
      kept: 512,
    })).toBe('Loading channels… 1024 processed, 512 kept');
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

  it('pluralizes refresh-hour options in every locale', () => {
    setLocale('en');
    expect(tp('settings.refreshHours', 1)).toBe('1 hour');
    expect(tp('settings.refreshHours', 3)).toBe('3 hours');
    setLocale('de');
    expect(tp('settings.refreshHours', 1)).toBe('1 Stunde');
    expect(tp('settings.refreshHours', 3)).toBe('3 Stunden');
    setLocale('es');
    expect(tp('settings.refreshHours', 1)).toBe('1 hora');
    expect(tp('settings.refreshHours', 3)).toBe('3 horas');
    setLocale('fr');
    expect(tp('settings.refreshHours', 1)).toBe('1 heure');
    expect(tp('settings.refreshHours', 3)).toBe('3 heures');
    setLocale('it');
    expect(tp('settings.refreshHours', 1)).toBe('1 ora');
    expect(tp('settings.refreshHours', 3)).toBe('3 ore');
    setLocale('pt-BR');
    expect(tp('settings.refreshHours', 1)).toBe('1 hora');
    expect(tp('settings.refreshHours', 3)).toBe('3 horas');
    setLocale('ru');
    expect([
      tp('settings.refreshHours', 1),
      tp('settings.refreshHours', 3),
      tp('settings.refreshHours', 6),
      tp('settings.refreshHours', 12),
      tp('settings.refreshHours', 24),
    ]).toEqual(['1 час', '3 часа', '6 часов', '12 часов', '24 часа']);
    setLocale('uk');
    expect([
      tp('settings.refreshHours', 1),
      tp('settings.refreshHours', 3),
      tp('settings.refreshHours', 6),
      tp('settings.refreshHours', 12),
      tp('settings.refreshHours', 24),
    ]).toEqual(['1 година', '3 години', '6 годин', '12 годин', '24 години']);
    setLocale('zh-CN');
    expect(tp('settings.refreshHours', 1)).toBe('1 小时');
    expect(tp('settings.refreshHours', 3)).toBe('3 小时');
  });

  it('formats and pluralizes second durations by locale', () => {
    const duration = (seconds: number) => tp('settings.durationSeconds', seconds, {
      seconds: formatNumber(seconds, { maximumFractionDigits: 1 }),
    });

    setLocale('en');
    expect(duration(1)).toBe('1 second');
    expect(duration(1.2)).toBe('1.2 seconds');
    expect(duration(3)).toBe('3 seconds');

    setLocale('de');
    expect(duration(1)).toBe('1 Sekunde');
    expect(duration(1.2)).toBe('1,2 Sekunden');

    setLocale('ru');
    expect(duration(1)).toBe('1 секунда');
    expect(duration(2)).toBe('2 секунды');
    expect(duration(5)).toBe('5 секунд');
    expect(duration(1.2)).toBe('1,2 секунды');

    setLocale('uk');
    expect(duration(1)).toBe('1 секунда');
    expect(duration(2)).toBe('2 секунди');
    expect(duration(5)).toBe('5 секунд');
    expect(duration(1.2)).toBe('1,2 секунди');

    setLocale('zh-CN');
    expect(duration(1.2)).toBe('1.2 秒');
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

  it('localizes live preview settings and remaining minutes in every locale', () => {
    try {
      for (const { value } of localeOptions()) {
        setLocale(value);
        expect(t('settings.livePreview').length).toBeGreaterThan(0);
        expect(t('settings.livePreviewHint').length).toBeGreaterThan(0);
        for (const minutes of [0, 1, 2, 25]) {
          const remaining = t('preview.timeLeft', { minutes });
          expect(remaining).toContain(String(minutes));
          expect(remaining).not.toContain('{minutes}');
        }
      }
    } finally {
      setLocale(DEFAULT_LOCALE);
    }
    expect(t('preview.timeLeft', { minutes: 5 })).toBe('5 min left');
  });
});
