import { test, expect, isChromium53, routePlaylist, seedPlaylist } from './helpers';
import { POLYFILLED_APIS } from '../scripts/polyfilled-apis.mjs';

// The webOS 4 fallbacks are only correct if they are *inert* on a modern TV
// (webOS 6/22/23/24/25). A leaked fallback is not a no-op: it double-applies —
// an unguarded `:focus` ring once stacked a second glow inside the modern
// `:focus-within` ring. The legacy suite proves the fallbacks work on the old
// engine; this one proves they stay out of the way on the new one.

async function nativeApis(page: import('@playwright/test').Page, paths: string[]) {
  return page.evaluate((names) => {
    const result: Record<string, string> = {};
    for (const name of names) {
      const value = name.split('.').reduce<unknown>(
        (owner, key) => (owner as Record<string, unknown> | undefined)?.[key],
        window as unknown,
      );
      if (typeof value !== 'function') result[name] = 'missing';
      else result[name] = /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(value))
        ? 'native'
        : 'polyfill';
    }
    return result;
  }, paths);
}

test('a modern engine keeps every polyfilled API native', async ({ page }) => {
  test.skip(isChromium53(), 'the simulation deliberately removes these');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const apis = await nativeApis(page, POLYFILLED_APIS);
  for (const name of POLYFILLED_APIS) expect(apis[name], name).toBe('native');
});

test('the simulated engine really falls back to the polyfills', async ({ page }) => {
  test.skip(!isChromium53(), 'only the simulation removes the natives');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const apis = await nativeApis(page, POLYFILLED_APIS);
  // Not merely present — present *and* ours, which is what a webOS 4 TV gets.
  for (const name of POLYFILLED_APIS) expect(apis[name], name).toBe('polyfill');

  // Discovery, the other direction: scan the built-in surface for anything
  // non-native and require it to be a listed entry. This is what keeps
  // POLYFILLED_APIS honest — a polyfill added anywhere, including the esbuild
  // banner that src/polyfills.ts never mentions, shows up here.
  const discovered = await page.evaluate(() => {
    const owners: [string, object][] = [
      ['Object', Object], ['Array.prototype', Array.prototype],
      ['String.prototype', String.prototype], ['Number.prototype', Number.prototype],
      ['Element.prototype', Element.prototype], ['Node.prototype', Node.prototype],
      ['Document.prototype', Document.prototype],
      ['DocumentFragment.prototype', DocumentFragment.prototype],
      ['Intl', Intl], ['Promise', Promise], ['Promise.prototype', Promise.prototype],
      ['JSON', JSON], ['Math', Math], ['Reflect', Reflect],
      ['window', window],
    ];
    const isNative = (fn: unknown) => /\{\s*\[native code\]\s*\}/
      .test(Function.prototype.toString.call(fn));
    const found: string[] = [];
    for (const [name, owner] of owners) {
      for (const key of Object.getOwnPropertyNames(owner)) {
        // The preview harness parks its own globals on window.
        if (key.indexOf('__') === 0) continue;
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        if (!isNative(descriptor.value)) found.push(`${name}.${key}`);
      }
    }
    return found;
  });

  expect(discovered.slice().sort()).toEqual(POLYFILLED_APIS.slice().sort());
});

test('a modern engine activates none of the legacy CSS fallbacks', async ({ page }) => {
  test.skip(isChromium53(), 'the simulation rewrites these blocks away');
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const guards = await page.evaluate(() => {
    const legacy = [...document.styleSheets]
      .filter((sheet) => /legacy-webos-/.test(sheet.href || ''));
    const conditions: { condition: string; active: boolean }[] = [];
    let unguarded = 0;
    for (const sheet of legacy) {
      for (const rule of [...(sheet.cssRules || [])]) {
        if (rule instanceof CSSSupportsRule) {
          conditions.push({ condition: rule.conditionText, active: CSS.supports(rule.conditionText) });
        } else if (!(rule instanceof CSSMediaRule) && rule.constructor.name !== 'CSSComment') {
          unguarded++;
        }
      }
    }
    return { sheets: legacy.length, conditions, unguarded };
  });

  // Both legacy stylesheets must be loaded, or the test would pass vacuously.
  expect(guards.sheets).toBe(2);
  expect(guards.conditions.length).toBeGreaterThan(0);
  expect(guards.unguarded, 'legacy rules outside an @supports guard').toBe(0);
  for (const guard of guards.conditions) expect(guard.active, guard.condition).toBe(false);
});

// addInitScript reaches page realms only, so the worker is degraded by a
// prelude the preview server prepends to its bundle instead. Worker code is
// the M3U/XMLTV parser and the search index — the least forgiving input in the
// app — so a gap here would be silent false confidence.
test('the simulation reaches the worker realm too', async ({ page }) => {
  await routePlaylist(page);
  await seedPlaylist(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  const worker = await page.waitForEvent('worker');
  const surface = await worker.evaluate(() => ({
    // Post-53 and deliberately not polyfilled: shows the prelude ran.
    flat: typeof (Array.prototype as unknown as { flat?: unknown }).flat,
    // Post-53 and polyfilled: shows src/polyfills.ts loads inside the worker.
    flatMap: typeof (Array.prototype as unknown as { flatMap?: unknown }).flatMap,
  }));

  expect(surface.flat).toBe(isChromium53() ? 'undefined' : 'function');
  expect(surface.flatMap).toBe('function');
});
