// Runtime polyfills for APIs missing on webOS 4 (Chromium 53):
// - Object.entries / Object.values (Chrome 54): app and EPG object iteration.
// - String.prototype.padStart (Chrome 57): time, URL and settings formatting.
// - Intl.PluralRules (Chrome 63): localized plural selection in src/i18n.
// - ResizeObserver (Chrome 64): bundled assjs subtitle layout.
// - AbortController (Chrome 66): app fetch cancellation and timeouts.
// - Array.prototype.flatMap (Chrome 69): bundled assjs subtitle processing.
// - Object.fromEntries (Chrome 73): bundled assjs subtitle processing.
//
// Imported first in both src/app.ts and src/workers/app-worker.ts so they
// apply before any app or dependency code runs. Each install is guarded (only
// patches when the API is absent), so native implementations are never replaced.

type LegacyAbortListener = EventListenerOrEventListenerObject;

class LegacyAbortSignal {
  aborted = false;
  onabort: ((this: AbortSignal, ev: Event) => unknown) | null = null;
  private listeners: LegacyAbortListener[] = [];

  dispatchAbort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const event = new Event('abort');
    for (const listener of this.listeners.slice()) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
    this.listeners = [];
    if (this.onabort) this.onabort.call(this as unknown as AbortSignal, event);
  }

  addEventListener(
    type: string,
    callback: LegacyAbortListener | null,
  ): void {
    if (type === 'abort' && callback && this.listeners.indexOf(callback) === -1) {
      this.listeners.push(callback);
    }
  }

  removeEventListener(type: string, callback: LegacyAbortListener | null): void {
    if (type !== 'abort' || !callback) return;
    const index = this.listeners.indexOf(callback);
    if (index !== -1) this.listeners.splice(index, 1);
  }
}

class LegacyAbortController {
  readonly signal = new LegacyAbortSignal();

  abort(): void {
    this.signal.dispatchAbort();
  }
}

function abortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}

function installAbortController(): void {
  if (typeof AbortController !== 'undefined') return;
  const scope = self as unknown as {
    AbortController: typeof AbortController;
    fetch: typeof fetch;
  };
  const nativeFetch = scope.fetch;
  scope.AbortController = LegacyAbortController as unknown as typeof AbortController;
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (!signal) return nativeFetch(input, init);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      nativeFetch(input, init).then(
        response => {
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };
}

installAbortController();

function pluralLanguage(locale?: string | string[]): string {
  const selected = Array.isArray(locale) ? locale[0] : locale;
  return String(selected || 'en').toLowerCase().split(/[-_]/)[0];
}

export function selectPluralCategory(locale: string, value: number): Intl.LDMLPluralRule {
  const count = Math.abs(Number(value) || 0);
  const integer = Math.floor(count);
  const isInteger = count === integer;
  if (!isInteger || locale === 'zh') return 'other';

  if (locale === 'ru' || locale === 'uk') {
    const mod10 = integer % 10;
    const mod100 = integer % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
    return 'many';
  }

  if ((locale === 'fr' || locale === 'pt') && (integer === 0 || integer === 1)) {
    return 'one';
  }
  return integer === 1 ? 'one' : 'other';
}

// This is intentionally not a complete ECMA-402 implementation. It provides
// cardinal selection for the app's locales and integer UI counts; native
// Intl.PluralRules remains untouched wherever the platform supplies it. When
// adding a locale, add its cardinal rules and coverage in polyfills.test.ts.
class LegacyPluralRules {
  private readonly locale: string;

  constructor(locale?: string | string[]) {
    this.locale = pluralLanguage(locale);
  }

  select(value: number): Intl.LDMLPluralRule {
    return selectPluralCategory(this.locale, value);
  }

  resolvedOptions(): { locale: string; type: 'cardinal' } {
    return { locale: this.locale, type: 'cardinal' };
  }

  static supportedLocalesOf(locales: string | string[]): string[] {
    return Array.isArray(locales) ? locales.slice() : [locales];
  }
}

if (typeof Intl.PluralRules !== 'function') {
  (Intl as unknown as { PluralRules: typeof Intl.PluralRules }).PluralRules =
    LegacyPluralRules as unknown as typeof Intl.PluralRules;
}

class LegacyResizeObserver {
  private readonly elements: Element[] = [];
  private readonly notify = () => {
    this.callback([], this as unknown as ResizeObserver);
  };

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(element: Element): void {
    if (this.elements.indexOf(element) !== -1) return;
    this.elements.push(element);
    window.addEventListener('resize', this.notify);
    element.addEventListener('loadedmetadata', this.notify);
  }

  unobserve(element: Element): void {
    const index = this.elements.indexOf(element);
    if (index === -1) return;
    this.elements.splice(index, 1);
    element.removeEventListener('loadedmetadata', this.notify);
    if (this.elements.length === 0) window.removeEventListener('resize', this.notify);
  }

  disconnect(): void {
    for (const element of this.elements) {
      element.removeEventListener('loadedmetadata', this.notify);
    }
    this.elements.length = 0;
    window.removeEventListener('resize', this.notify);
  }
}

if (typeof ResizeObserver === 'undefined' && typeof window !== 'undefined') {
  (self as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    LegacyResizeObserver as unknown as typeof ResizeObserver;
}
export function flatMapPolyfill(
  this: unknown[],
  callback: (value: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
): unknown[] {
  if (this == null) throw new TypeError('flatMap called on null or undefined');
  if (typeof callback !== 'function') throw new TypeError(String(callback) + ' is not a function');
  const arr = Object(this);
  const len = arr.length >>> 0;
  const result: unknown[] = [];
  for (let i = 0; i < len; i++) {
    if (i in arr) {
      const mapped = callback.call(thisArg, arr[i], i, arr);
      if (Array.isArray(mapped)) {
        for (let j = 0; j < mapped.length; j++) {
          if (j in mapped) result.push(mapped[j]);
        }
      } else {
        result.push(mapped);
      }
    }
  }
  return result;
}

if (!(Array.prototype as any).flatMap) {
  (Array.prototype as unknown as { flatMap: typeof flatMapPolyfill }).flatMap = flatMapPolyfill;
}

export function padStartPolyfill(
  this: string,
  targetLength: number,
  padString = ' ',
): string {
  const value = String(this);
  const length = Math.max(0, Math.min(Number(targetLength) || 0, 0x1fffffff));
  if (value.length >= length || padString === '') return value;
  let padding = '';
  while (padding.length < length - value.length) padding += padString;
  return padding.slice(0, length - value.length) + value;
}

if (!(String.prototype as any).padStart) {
  (String.prototype as unknown as { padStart: typeof padStartPolyfill }).padStart =
    padStartPolyfill;
}

export function objectValuesPolyfill(object: object): unknown[] {
  return Object.keys(Object(object)).map(key => (object as Record<string, unknown>)[key]);
}

if (!(Object as any).values) {
  (Object as unknown as { values: typeof objectValuesPolyfill }).values = objectValuesPolyfill;
}

export function objectEntriesPolyfill(object: object): [string, unknown][] {
  return Object.keys(Object(object))
    .map(key => [key, (object as Record<string, unknown>)[key]]);
}

if (!(Object as any).entries) {
  (Object as unknown as { entries: typeof objectEntriesPolyfill }).entries =
    objectEntriesPolyfill;
}

export function fromEntriesPolyfill(
  entries: Iterable<readonly [PropertyKey, unknown]>,
): Record<PropertyKey, unknown> {
  if (entries == null) throw new TypeError('Object.fromEntries called on non-object');
  const obj: Record<PropertyKey, unknown> = {};
  for (const pair of entries) {
    obj[pair[0]] = pair[1];
  }
  return obj;
}

if (!(Object as any).fromEntries) {
  (Object as unknown as { fromEntries: typeof fromEntriesPolyfill }).fromEntries = fromEntriesPolyfill;
}
