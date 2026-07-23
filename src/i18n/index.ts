import { EN_MESSAGES, type MessageKey } from './en';
import { ES_MESSAGES } from './es';
import { ZH_CN_MESSAGES } from './zh-CN';

export type { MessageKey } from './en';
type Messages = Readonly<Record<MessageKey, string>>;
type Params = Record<string, string | number>;
type LocaleDefinition = {
  messages: Messages;
  displayName: string;
  systemExact: readonly string[];
  systemPrefixes: readonly string[];
};

const LOCALES = {
  en: {
    messages: EN_MESSAGES,
    displayName: 'English',
    systemExact: [],
    systemPrefixes: [],
  },
  es: {
    messages: ES_MESSAGES,
    displayName: 'Español',
    systemExact: [],
    systemPrefixes: ['es'],
  },
  'zh-CN': {
    messages: ZH_CN_MESSAGES,
    displayName: '简体中文',
    systemExact: ['zh'],
    systemPrefixes: ['zh-cn', 'zh-sg', 'zh-hans'],
  },
} as const satisfies Record<string, LocaleDefinition>;

export type SupportedLocale = keyof typeof LOCALES;
export type LocalePreference = 'system' | SupportedLocale;
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system'
    || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, value));
}

export function localeOptions(): { value: SupportedLocale; label: string }[] {
  return (Object.keys(LOCALES) as SupportedLocale[])
    .map(value => ({ value, label: LOCALES[value].displayName }));
}

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

export function resolveLocale(
  preference: LocalePreference,
  browserLanguage = typeof navigator === 'undefined' ? DEFAULT_LOCALE : navigator.language,
): SupportedLocale {
  if (preference !== 'system') return preference;
  const language = browserLanguage.toLowerCase();
  for (const locale of Object.keys(LOCALES) as SupportedLocale[]) {
    const definition = LOCALES[locale];
    if (definition.systemExact.some(value => language === value)
        || definition.systemPrefixes.some(prefix =>
          language === prefix || language.startsWith(`${prefix}-`))) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

export function setLocale(locale: SupportedLocale): void {
  currentLocale = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

export function initLocale(preference: LocalePreference): void {
  setLocale(resolveLocale(preference));
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function t(key: MessageKey, params?: Params): string {
  let message: string = LOCALES[currentLocale].messages[key];
  if (!params) return message;
  message = message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    params[name] === undefined ? token : String(params[name]));
  return message;
}

function placeholders(message: string): string[] {
  const names: string[] = [];
  const pattern = /\{([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) names.push(match[1]);
  return names.sort();
}

export function validateTranslations(): string[] {
  const errors: string[] = [];
  const keys = Object.keys(EN_MESSAGES) as MessageKey[];
  for (const locale of Object.keys(LOCALES) as SupportedLocale[]) {
    const messages = LOCALES[locale].messages;
    for (const key of keys) {
      const value = messages[key];
      if (!value || !value.trim()) {
        errors.push(`${locale}:${key} is empty`);
        continue;
      }
      const expected = placeholders(EN_MESSAGES[key]).join(',');
      const actual = placeholders(value).join(',');
      if (actual !== expected) {
        errors.push(`${locale}:${key} placeholders [${actual}] do not match [${expected}]`);
      }
    }
  }
  return errors;
}
