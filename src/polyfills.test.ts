import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  flatMapPolyfill,
  fromEntriesPolyfill,
  objectEntriesPolyfill,
  objectValuesPolyfill,
  padStartPolyfill,
  selectPluralCategory,
} from './polyfills';

describe('flatMapPolyfill', () => {
  it('maps and flattens one level', () => {
    const out = flatMapPolyfill.call([1, 2, 3], (x) => [x, (x as number) * 2]);
    expect(out).toEqual([1, 2, 2, 4, 3, 6]);
  });

  it('keeps non-array return values as single elements', () => {
    const out = flatMapPolyfill.call([1, 2], (x) => x);
    expect(out).toEqual([1, 2]);
  });

  it('flattens only one level (nested arrays are preserved)', () => {
    const out = flatMapPolyfill.call([1], () => [[9]]);
    expect(out).toEqual([[9]]);
  });

  it('skips holes in a sparse mapped array (matches native FlattenIntoArray)', () => {
    const sparse: number[] = [];
    sparse[0] = 5;
    sparse[2] = 9; // index 1 is a hole
    const out = flatMapPolyfill.call([1], () => sparse);
    expect(out).toEqual([5, 9]);
  });

  it('passes index and array to the callback', () => {
    const seen: number[] = [];
    flatMapPolyfill.call(['a', 'b'], (_v, i) => {
      seen.push(i as number);
      return [];
    });
    expect(seen).toEqual([0, 1]);
  });

  it('honours thisArg', () => {
    const ctx = { mult: 10 };
    const out = flatMapPolyfill.call(
      [1, 2],
      function (this: typeof ctx, x) {
        return [(x as number) * this.mult];
      },
      ctx,
    );
    expect(out).toEqual([10, 20]);
  });
});

describe('fromEntriesPolyfill', () => {
  it('builds an object from an array of key/value pairs', () => {
    const out = fromEntriesPolyfill([
      ['a', 1],
      ['b', 2],
    ]);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it('accepts any iterable of pairs (e.g. a Map)', () => {
    const out = fromEntriesPolyfill(
      new Map<string, number>([
        ['x', 9],
        ['y', 8],
      ]),
    );
    expect(out).toEqual({ x: 9, y: 8 });
  });

  it('lets a later duplicate key win', () => {
    const out = fromEntriesPolyfill([
      ['k', 1],
      ['k', 2],
    ]);
    expect(out).toEqual({ k: 2 });
  });
});

describe('padStartPolyfill', () => {
  it('pads strings without truncating existing content', () => {
    expect(padStartPolyfill.call('7', 3, '0')).toBe('007');
    expect(padStartPolyfill.call('long', 2, '0')).toBe('long');
  });
});

describe('objectValuesPolyfill / objectEntriesPolyfill', () => {
  it('return enumerable own values and entries, skipping inherited ones', () => {
    const value = Object.create({ inherited: 0 }) as Record<string, number>;
    value.alpha = 1;
    value.bravo = 2;
    expect(objectValuesPolyfill(value)).toEqual([1, 2]);
    expect(objectEntriesPolyfill(value)).toEqual([['alpha', 1], ['bravo', 2]]);
  });
});

describe('Intl.PluralRules polyfill', () => {
  it('selects cardinal forms used by every app locale', () => {
    expect(selectPluralCategory('en', 1)).toBe('one');
    expect(selectPluralCategory('de', 2)).toBe('other');
    expect(selectPluralCategory('fr', 0)).toBe('one');
    expect(selectPluralCategory('pt', 0)).toBe('one');
    expect(selectPluralCategory('ru', 1)).toBe('one');
    expect(selectPluralCategory('ru', 2)).toBe('few');
    expect(selectPluralCategory('ru', 5)).toBe('many');
    expect(selectPluralCategory('uk', 22)).toBe('few');
    expect(selectPluralCategory('zh', 1)).toBe('other');
  });

  it('installs only when the native implementation is unavailable', async () => {
    const legacyIntl = Object.create(Intl) as typeof Intl;
    Object.defineProperty(legacyIntl, 'PluralRules', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal('Intl', legacyIntl);
    vi.resetModules();
    try {
      await import('./polyfills');
      expect(new Intl.PluralRules('ru').select(22)).toBe('few');
      expect(new Intl.PluralRules('zh-CN').select(1)).toBe('other');
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

// The consolidated src/polyfills.ts installs its own AbortController (with a
// fetch-cancellation wrapper) only when the platform has none at all. An
// import ordering bug once let a weaker, wrapper-less AbortController shim
// install first and win — this guards the guarded-install + fetch-wrapping
// behavior directly, independent of import order.
describe('installAbortController (fetch cancellation polyfill)', () => {
  // Production only runs this module in a browser/worker scope, where `self`
  // always exists; stub it here too so the install path can run under Node.
  function stubMissingAbortController(): void {
    vi.stubGlobal('self', globalThis);
    vi.stubGlobal('AbortController', undefined);
  }

  // The un-stubbed module is already cached (from the static imports above),
  // so each test needs its own fresh module instance to observe the stubs.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('installs a working AbortController when the platform has none', async () => {
    stubMissingAbortController();
    await import('./polyfills');
    expect(typeof globalThis.AbortController).toBe('function');
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('rejects an in-flight fetch with an AbortError once the signal aborts', async () => {
    stubMissingAbortController();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await import('./polyfills');

    const controller = new AbortController();
    const pending = fetch('http://host/a', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately when fetch is called with an already-aborted signal', async () => {
    stubMissingAbortController();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await import('./polyfills');

    const controller = new AbortController();
    controller.abort();
    await expect(fetch('http://host/a', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves normally when the signal never aborts', async () => {
    stubMissingAbortController();
    const response = { ok: true } as Response;
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await import('./polyfills');

    const controller = new AbortController();
    await expect(fetch('http://host/a', { signal: controller.signal })).resolves.toBe(response);
  });

  it('leaves the native AbortController untouched when the platform already has one', async () => {
    const native = globalThis.AbortController;
    await import('./polyfills');
    expect(globalThis.AbortController).toBe(native);
  });
});
