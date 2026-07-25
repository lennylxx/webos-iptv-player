import {
  EN_MESSAGES,
  type MessageCatalog,
  type MessageKey,
  type PluralCategory,
  type PluralMessage,
  type PluralMessageKey,
  type TextMessageKey,
} from './en';
import { DE_MESSAGES } from './de';
import { ES_MESSAGES } from './es';
import { FR_MESSAGES } from './fr';
import { IT_MESSAGES } from './it';
import { PT_BR_MESSAGES } from './pt-BR';
import { pseudoLocalize } from './pseudo';
import { RU_MESSAGES } from './ru';
import { ZH_CN_MESSAGES } from './zh-CN';

export type { MessageKey, PluralMessageKey, TextMessageKey } from './en';
type Messages = Readonly<MessageCatalog>;
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
  de: {
    messages: DE_MESSAGES,
    displayName: 'Deutsch',
    systemExact: [],
    systemPrefixes: ['de'],
  },
  es: {
    messages: ES_MESSAGES,
    displayName: 'Español',
    systemExact: [],
    systemPrefixes: ['es'],
  },
  fr: {
    messages: FR_MESSAGES,
    displayName: 'Français',
    systemExact: [],
    systemPrefixes: ['fr'],
  },
  it: {
    messages: IT_MESSAGES,
    displayName: 'Italiano',
    systemExact: [],
    systemPrefixes: ['it'],
  },
  'pt-BR': {
    messages: PT_BR_MESSAGES,
    displayName: 'Português (Brasil)',
    systemExact: [],
    systemPrefixes: ['pt'],
  },
  ru: {
    messages: RU_MESSAGES,
    displayName: 'Русский',
    systemExact: [],
    systemPrefixes: ['ru'],
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

function pseudoLocaleRequested(): boolean {
  return typeof location !== 'undefined' && /(?:^|[?&])pseudo=1(?:&|$)/.test(location.search);
}

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
  if (typeof document !== 'undefined') {
    document.documentElement.lang =
      __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested() ? 'en-XA' : locale;
  }
}

export function initLocale(preference: LocalePreference): void {
  setLocale(resolveLocale(preference));
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function t(key: TextMessageKey, params?: Params): string {
  let message = LOCALES[currentLocale].messages[key] as string;
  if (__ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested()) {
    message = pseudoLocalize(EN_MESSAGES[key]);
  }
  if (!params) return message;
  return interpolate(message, params);
}

export function tp(key: PluralMessageKey, count: number, params?: Params): string {
  const pseudo = __ENABLE_PSEUDO_LOCALE__ && pseudoLocaleRequested();
  const locale = pseudo ? DEFAULT_LOCALE : currentLocale;
  const forms = LOCALES[locale].messages[key] as PluralMessage;
  const category = new Intl.PluralRules(locale).select(count);
  const message = forms[category] ?? forms.other;
  return interpolate(pseudo ? pseudoLocalize(message) : message, { ...params, count });
}

function interpolate(message: string, params: Params): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) =>
    params[name] === undefined ? token : String(params[name]));
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
    const definition: LocaleDefinition = LOCALES[locale];
    const messages = definition.messages;
    for (const key of keys) {
      const source = EN_MESSAGES[key];
      const value = messages[key];
      if (typeof source === 'string') {
        const message = value as string;
        if (!message.trim()) {
          errors.push(`${locale}:${key} is empty`);
          continue;
        }
        const expected = placeholders(source).join(',');
        const actual = placeholders(message).join(',');
        if (actual !== expected) {
          errors.push(`${locale}:${key} placeholders [${actual}] do not match [${expected}]`);
        }
      } else {
        const forms = value as PluralMessage;
        const expected = placeholders(source.other).join(',');
        for (const category of Object.keys(forms) as PluralCategory[]) {
          const message = forms[category];
          if (!message) continue;
          if (!message.trim()) errors.push(`${locale}:${key}:${category} is empty`);
          const actual = placeholders(message).join(',');
          if (actual !== expected) {
            errors.push(`${locale}:${key}:${category} placeholders [${actual}] do not match [${expected}]`);
          }
        }
      }
    }
  }
  return errors;
}
