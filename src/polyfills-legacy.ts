// Runtime polyfills for APIs missing on webOS 4.x (Chromium 53), which predates
// the project's baseline of webOS 5 (Chromium 68). Companion to polyfills.ts;
// imported first in src/app.ts so these apply before any app or dependency code.
//
// Every install is guarded (only patches when the API is absent), so on webOS 5+
// this file is a no-op — nothing is overridden and there is zero behavior change
// on supported platforms. It only fills the 53 -> 68 gap on older TVs.
//
// Covered here (with the Chromium version each API first shipped in):
//   globalThis (71), Array/String.prototype.at (92), Promise.prototype.finally
//   (63), Promise.allSettled (76), Object.entries/values (54), String.prototype
//   .padStart/padEnd (57), Array.prototype.flat (69), Intl.PluralRules (63),
//   AbortController/AbortSignal (66), String.prototype.replaceAll (85).

/* globalThis (Chrome 71) — referenced directly throughout the app. Must be
   defined before anything else runs. */
(function () {
  if (typeof (globalThis as any) === 'object') return;
  try {
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, '__magic__', {
      get: function () { return this; },
      configurable: true,
    });
    // @ts-ignore
    __magic__.globalThis = __magic__;
    // @ts-ignore
    delete (Object.prototype as any).__magic__;
  } catch (e) {
    if (typeof window !== 'undefined') (window as any).globalThis = window;
  }
})();

/* Array.prototype.at (Chrome 92) */
if (!(Array.prototype as any).at) {
  Object.defineProperty(Array.prototype, 'at', {
    value: function (n: number) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    },
    writable: true, configurable: true,
  });
}

/* String.prototype.at (Chrome 92) */
if (!(String.prototype as any).at) {
  Object.defineProperty(String.prototype, 'at', {
    value: function (n: number) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      if (n < 0 || n >= this.length) return undefined;
      return this[n];
    },
    writable: true, configurable: true,
  });
}

/* Promise.prototype.finally (Chrome 63) */
if (typeof Promise !== 'undefined' && !(Promise.prototype as any).finally) {
  (Promise.prototype as any).finally = function (cb: () => void) {
    const P = (this.constructor as PromiseConstructor) || Promise;
    return this.then(
      (v: unknown) => P.resolve(cb()).then(() => v),
      (e: unknown) => P.resolve(cb()).then(() => { throw e; })
    );
  };
}

/* Promise.allSettled (Chrome 76) */
if (typeof Promise !== 'undefined' && !(Promise as any).allSettled) {
  (Promise as any).allSettled = function (promises: Iterable<unknown>) {
    return Promise.all(
      Array.from(promises).map((p) =>
        Promise.resolve(p).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason })
        )
      )
    );
  };
}

/* Object.entries (Chrome 54) — borderline; some 53 builds lack it */
if (!(Object as any).entries) {
  (Object as any).entries = function (obj: Record<string, unknown>) {
    return Object.keys(obj).map((k) => [k, obj[k]]);
  };
}

/* Object.values (Chrome 54) */
if (!(Object as any).values) {
  (Object as any).values = function (obj: Record<string, unknown>) {
    return Object.keys(obj).map((k) => obj[k]);
  };
}

/* String.prototype.padStart / padEnd (Chrome 57) */
if (!(String.prototype as any).padStart) {
  (String.prototype as any).padStart = function (targetLength: number, padString?: string) {
    targetLength = targetLength >> 0;
    padString = String(padString || ' ');
    if (this.length >= targetLength) return String(this);
    let pad = padString;
    while (pad.length < targetLength - this.length) pad += padString;
    return pad.slice(0, targetLength - this.length) + String(this);
  };
}
if (!(String.prototype as any).padEnd) {
  (String.prototype as any).padEnd = function (targetLength: number, padString?: string) {
    targetLength = targetLength >> 0;
    padString = String(padString || ' ');
    if (this.length >= targetLength) return String(this);
    let pad = padString;
    while (pad.length < targetLength - this.length) pad += padString;
    return String(this) + pad.slice(0, targetLength - this.length);
  };
}

/* Array.prototype.flat (Chrome 69) */
if (!(Array.prototype as any).flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    value: function (depth?: number) {
      const d = depth === undefined ? 1 : Math.trunc(depth) || 0;
      const flatten = (arr: unknown[], dep: number): unknown[] =>
        dep < 1 ? arr.slice() : arr.reduce((acc: unknown[], val) => {
          if (Array.isArray(val)) acc.push(...flatten(val, dep - 1));
          else acc.push(val);
          return acc;
        }, []);
      return flatten(this, d);
    },
    writable: true, configurable: true,
  });
}

export {};

/* Intl.PluralRules (Chrome 63) — used by i18n for pluralization. Missing on
   Chromium 53, where it throws when settings re-render. Implements cardinal
   rules for the app locales (en, ro, ru) with an "other" fallback. */
(function () {
  const Intl_: any = (typeof globalThis !== 'undefined' ? (globalThis as any) : (window as any)).Intl;
  if (!Intl_) return;
  if (typeof Intl_.PluralRules === 'function') return;

  function baseLang(locale: string): string {
    return String(locale || 'en').toLowerCase().split(/[-_]/)[0];
  }

  // Simplified cardinal rules, sufficient for the app's messages.
  function selectFor(lang: string, n: number): string {
    n = Math.abs(Number(n) || 0);
    const i = Math.floor(n);
    const v0 = n === i; // no fractional part
    switch (lang) {
      case 'ru':
      case 'uk':
      case 'be': {
        if (!v0) return 'other';
        const mod10 = i % 10, mod100 = i % 100;
        if (mod10 === 1 && mod100 !== 11) return 'one';
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
        return 'many';
      }
      case 'ro': {
        if (i === 1 && v0) return 'one';
        const mod100 = i % 100;
        if (n === 0 || (v0 && mod100 >= 1 && mod100 <= 19)) return 'few';
        return 'other';
      }
      case 'en':
      default:
        return (i === 1 && v0) ? 'one' : 'other';
    }
  }

  function PluralRules(this: any, locale?: string | string[]) {
    const loc = Array.isArray(locale) ? locale[0] : locale;
    this._lang = baseLang(loc || 'en');
  }
  PluralRules.prototype.select = function (n: number): string {
    return selectFor(this._lang, n);
  };
  PluralRules.prototype.resolvedOptions = function () {
    return { locale: this._lang, type: 'cardinal' };
  };
  PluralRules.supportedLocalesOf = function (locales: string | string[]) {
    return Array.isArray(locales) ? locales.slice() : [locales];
  };

  try { Intl_.PluralRules = PluralRules as any; } catch (e) { /* ignore */ }
})();

/* AbortController / AbortSignal (Chrome 66) — used for fetch timeouts. Missing
   on Chromium 53, where any fetch passing a signal throws (breaking playlist
   loading). Minimal polyfill providing the objects and the 'abort' event.
   Note: if Chromium 53's fetch ignores `signal`, the timeout won't actually
   abort the request — but the fetch no longer throws and proceeds. */
(function () {
  const g: any = (typeof globalThis !== 'undefined' ? (globalThis as any) : (window as any));
  if (typeof g.AbortController === 'function') return;

  function AbortSignal(this: any) {
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    this._listeners = [];
  }
  AbortSignal.prototype.addEventListener = function (type: string, cb: any) {
    if (type === 'abort') this._listeners.push(cb);
  };
  AbortSignal.prototype.removeEventListener = function (type: string, cb: any) {
    if (type !== 'abort') return;
    const i = this._listeners.indexOf(cb);
    if (i >= 0) this._listeners.splice(i, 1);
  };
  AbortSignal.prototype.dispatchEvent = function (ev: any) {
    if (ev && ev.type === 'abort') {
      if (typeof this.onabort === 'function') this.onabort(ev);
      this._listeners.slice().forEach((cb: any) => {
        try { cb.call(this, ev); } catch (e) { /* ignore */ }
      });
    }
    return true;
  };

  function AbortController(this: any) {
    this.signal = new (AbortSignal as any)();
  }
  AbortController.prototype.abort = function (reason?: any) {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason !== undefined ? reason : new Error('Aborted');
    const ev = { type: 'abort', target: this.signal };
    this.signal.dispatchEvent(ev);
  };

  try {
    g.AbortController = AbortController as any;
    if (typeof g.AbortSignal !== 'function') g.AbortSignal = AbortSignal as any;
  } catch (e) { /* ignore */ }
})();

/* String.prototype.replaceAll (Chrome 85) — used by the app code. */
if (!(String.prototype as any).replaceAll) {
  Object.defineProperty(String.prototype, 'replaceAll', {
    value: function (search: any, replacement: any) {
      if (Object.prototype.toString.call(search) === '[object RegExp]') {
        // Requires a global RegExp.
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    },
    writable: true, configurable: true,
  });
}
