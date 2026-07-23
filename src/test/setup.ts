import { beforeEach } from 'vitest';
import { DEFAULT_LOCALE, setLocale } from '../i18n';

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
});
