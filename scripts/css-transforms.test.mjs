import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { QUIRK_CLASSES } from '../src/engine-quirks.ts';
import {
  convertLegacyColorSyntax,
  generateFlexGapFallback,
  generateScrollEndSpacers,
  linkedStylesheets,
  scaleFontSizes,
} from './css-transforms.mjs';

describe('generateFlexGapFallback', () => {
  it('generates main-axis margins for row and column flex containers', () => {
    const out = generateFlexGapFallback([`
      .row { display: flex; gap: 12px; }
      .column { display: flex; flex-direction: column; gap: 16px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .row > * + * { margin-left: 12px; }');
    expect(out).toContain('html.q-no-flex-gap .column > * + * { margin-top: 16px; }');
  });

  it('uses the directional gap for the flex main axis', () => {
    const out = generateFlexGapFallback([`
      .row { display: flex; row-gap: 8px; column-gap: 14px; }
      .column { display: flex; flex-direction: column; row-gap: 18px; column-gap: 10px; }
      .row-shorthand { display: flex; gap: 10px 24px; }
      .column-shorthand { display: flex; flex-direction: column; gap: 12px 20px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .row > * + * { margin-left: 14px; }');
    expect(out).toContain('html.q-no-flex-gap .column > * + * { margin-top: 18px; }');
    expect(out).toContain('html.q-no-flex-gap .row-shorthand > * + * { margin-left: 24px; }');
    expect(out).toContain('html.q-no-flex-gap .column-shorthand > * + * { margin-top: 12px; }');
  });

  it('expands grouped selectors and ignores grid and nested rules', () => {
    const out = generateFlexGapFallback([`
      .alpha, .bravo { display: flex; gap: 10px; }
      .grid { display: grid; gap: 20px; }
      @media (min-width: 1px) { .nested { display: flex; gap: 30px; } }
    `]);
    expect(out).toContain('html.q-no-flex-gap .alpha > * + *, html.q-no-flex-gap .bravo > * + * { margin-left: 10px; }');
    expect(out).not.toContain('.grid >');
    expect(out).not.toContain('.nested >');
  });

  it('resolves the flex context declared by another rule with the same selector', () => {
    const out = generateFlexGapFallback([`
      .badge { display: inline-flex; align-items: center; }
      .badge { gap: 5px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .badge > * + * { margin-left: 5px; }');
  });

  it('resolves the flex context from the selector it narrows', () => {
    const out = generateFlexGapFallback([`
      .row { display: flex; gap: 16px; }
      #host .row { gap: 12px; }
    `]);
    expect(out).toContain('#host .row > * + * { margin-left: 12px; }');
  });

  it('emits for a gap rule whose flex context comes from a companion class', () => {
    const out = generateFlexGapFallback([`
      .tabs { display: flex; gap: 4px; }
      .scoped-tabs { gap: 2px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .scoped-tabs > * + * { margin-left: 2px; }');
  });

  it('zeroes the other axis when a rule flips direction over a base container', () => {
    const out = generateFlexGapFallback([`
      .card { display: flex; flex-direction: column; gap: 16px; }
      .card-wide { flex-direction: row; gap: 24px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .card > * + * { margin-top: 16px; }');
    expect(out).toContain('html.q-no-flex-gap .card-wide > * + * { margin-left: 24px; margin-top: 0; }');
  });

  it('spaces a wrapping row on both axes, taking the last line\'s back', () => {
    const out = generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 10px 24px; margin: 0 0 30px; }
      .tags { display: flex; flex-wrap: wrap; }
      .tags.wide { gap: 12px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .chips { margin-bottom: 20px; }');
    expect(out).toContain('html.q-no-flex-gap .chips > * { margin-bottom: 10px; margin-right: 24px; }');
    expect(out).toContain('html.q-no-flex-gap .tags.wide { margin-bottom: -12px; }');
    expect(out).not.toContain('.chips > * + *');
  });

  it('resets a wrapping row whose gap a variant zeroes', () => {
    const out = generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chips.flush { gap: 0; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .chips.flush { margin-bottom: 0px; }');
    expect(out).toContain('html.q-no-flex-gap .chips.flush > * { margin-bottom: 0; margin-right: 0; }');
  });

  it('resets the axis a wrapping row variant zeroes and keeps the other', () => {
    const out = generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chips.tight { gap: 0 16px; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .chips.tight { margin-bottom: 0px; }');
    expect(out).toContain('html.q-no-flex-gap .chips.tight > * { margin-bottom: 0; margin-right: 16px; }');
  });

  it('refuses a variant that stops a wrapping row from wrapping', () => {
    expect(() => generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chips.one { flex-wrap: nowrap; gap: 8px; }
    `])).toThrow('.chips.one');
    expect(() => generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chips.stack { flex-direction: column; gap: 8px; }
    `])).toThrow('.chips.stack');
  });

  it('refuses a bottom margin a wrapping row\'s take-back would override', () => {
    expect(() => generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .panel .chips { margin-bottom: 40px; }
    `])).toThrow('.panel .chips');
    expect(() => generateFlexGapFallback([`
      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
      @media (max-width: 900px) { .chips { margin: 0 0 4px; } }
    `])).toThrow('.chips');
  });

  it('keeps a gap reset so it can override an inherited fallback margin', () => {
    const out = generateFlexGapFallback([`
      .action { display: flex; gap: 8px; }
      .action[data-variant="bare"] { gap: 0; }
    `]);
    expect(out).toContain('html.q-no-flex-gap .action[data-variant="bare"] > * + * { margin-left: 0; }');
  });

  it('keeps a single-row grid\'s margins off engines with grid gap', () => {
    const out = generateFlexGapFallback([`
      .controls { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; }
    `]);
    expect(out).toContain('@supports not (display: grid) {\n  html.q-no-flex-gap .controls > * + * { margin-left: 14px; }\n}');
    const root = postcss.parse(out);
    const unguarded = [];
    root.walkRules((rule) => {
      if (rule.parent.type === 'root' && rule.selector.includes('.controls')) unguarded.push(rule.selector);
    });
    expect(unguarded).toEqual([]);
  });

  it('excludes a grid container that declares display in a separate rule', () => {
    const out = generateFlexGapFallback([`
      .panel { display: grid; grid-template-columns: 1fr 1fr; }
      .panel { gap: 18px; }
    `]);
    expect(out).not.toContain('.panel >');
  });

  it('matches the checked-in css/legacy-webos-base.css', () => {
    const cssDir = new URL('../css/', import.meta.url);
    const generated = 'legacy-webos-base.css';
    const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const sources = linkedStylesheets(indexHtml, readdirSync(cssDir), generated)
      .map((file) => readFileSync(new URL(file, cssDir), 'utf8'));
    expect(readFileSync(new URL(generated, cssDir), 'utf8'))
      .toBe(generateFlexGapFallback(sources));
  });
});

describe('generateScrollEndSpacers', () => {
  it('rebuilds a row scroller\'s end padding past its gap, at zero outer size', () => {
    const { modern, legacy } = generateScrollEndSpacers([`
      .rail { display: flex; gap: 20px; overflow-x: auto; padding: 12px 12px 20px; }
    `]);
    expect(modern).toEqual([
      "html.q-scroll-end-padding .rail::after { content: ''; flex: 0 0 1px; width: 1px; height: 1px; margin-left: -9px; margin-right: -12px; }",
    ]);
    // No gap precedes the spacer where the gap is a sibling margin.
    expect(legacy).toEqual(['html.q-no-flex-gap .rail::after { margin-left: 11px; }']);
  });


  it('resolves declarations split across rules and non-px lengths', () => {
    const { modern, legacy } = generateScrollEndSpacers([`
      .tabs { display: flex; padding-right: var(--pad); }
      .tabs { overflow: auto hidden; }
    `]);
    expect(modern).toEqual([
      "html.q-scroll-end-padding .tabs::after { content: ''; flex: 0 0 1px; width: 1px; height: 1px; margin-left: calc(var(--pad) - 1px); margin-right: calc(0px - var(--pad)); }",
    ]);
    expect(legacy).toEqual([]);
  });

  it('skips containers that do not scroll on their main axis or have no end padding', () => {
    const { modern } = generateScrollEndSpacers([`
      .a { display: flex; overflow-y: auto; padding: 10px; }
      .column { display: flex; flex-direction: column; overflow-x: auto; overflow-y: auto; padding: 10px; }
      .b { display: flex; overflow-x: auto; padding: 10px 0; }
      .c { display: block; overflow-x: auto; padding: 10px; }
      .d { display: flex; overflow-x: hidden; padding: 10px; }
      .e { display: flex; flex-direction: row-reverse; overflow-x: auto; padding: 10px; }
      .f { display: flex; flex-wrap: wrap; overflow-x: auto; padding: 10px; }
      .g { display: flex; justify-content: space-between; overflow-x: auto; padding: 10px; }
      @media (min-width: 1px) { .h { display: flex; overflow-x: auto; padding: 10px; } }
    `]);
    expect(modern).toEqual([]);
  });

  it('recomputes the spacer for a compound variant of a scroller', () => {
    const { modern, legacy } = generateScrollEndSpacers([`
      .tabs { display: flex; gap: 4px; overflow-x: auto; padding: 8px 8px 0; }
      .tabs.wide { padding: 8px 12px 0; }
      .tabs.flush { padding: 0; }
      .tabs.tinted { color: red; }
      .wide .tab { padding: 30px; }
    `]);
    expect(modern).toEqual([
      "html.q-scroll-end-padding .tabs::after { content: ''; flex: 0 0 1px; width: 1px; height: 1px; margin-left: 3px; margin-right: -8px; }",
      "html.q-scroll-end-padding .tabs.wide::after { content: ''; flex: 0 0 1px; width: 1px; height: 1px; margin-left: 7px; margin-right: -12px; }",
      'html.q-scroll-end-padding .tabs.flush::after { content: none; }',
    ]);
    expect(legacy).toEqual([
      'html.q-no-flex-gap .tabs::after { margin-left: 7px; }',
      'html.q-no-flex-gap .tabs.wide::after { margin-left: 11px; }',
    ]);
  });

  it('refuses a scroller that already styles ::after', () => {
    expect(() => generateScrollEndSpacers([`
      .rail { display: flex; overflow-x: auto; padding: 10px; }
      .rail::after { content: '>'; }
    `])).toThrow(/\.rail.*::after/);
  });
});

describe('legacy stylesheets', () => {
  // A fallback that is not wrapped in an `@supports not (...)` guard or scoped
  // to a measured `html.q-*` engine quirk also lands on a modern TV, where it
  // double-applies on top of the real feature. e2e proves this in a browser;
  // here it fails without one.
  const QUIRK_SCOPED = /^html((?:\.q-[\w-]+)+)\s/;
  const KNOWN_QUIRKS = Object.values(QUIRK_CLASSES);
  const unknownQuirks = (selector) => {
    const match = QUIRK_SCOPED.exec(selector);
    return match ? match[1].slice(1).split('.').filter((name) => KNOWN_QUIRKS.indexOf(name) === -1) : [];
  };
  for (const file of ['legacy-webos-base.css', 'legacy-webos-overrides.css']) {
    it(`guards every rule in css/${file} with @supports or a quirk class`, () => {
      const css = readFileSync(new URL(`../css/${file}`, import.meta.url), 'utf8');
      const unguarded = [];
      postcss.parse(css).each((node) => {
        if (node.type === 'comment') return;
        if (node.type === 'rule'
            && node.selectors.every((selector) => QUIRK_SCOPED.test(selector)
              && !unknownQuirks(selector).length)) return;
        if (node.type === 'atrule' && node.name === 'supports' && node.params.startsWith('not ')) return;
        unguarded.push(node.type === 'rule' ? node.selector : `@${node.name} ${node.params}`);
      });
      expect(unguarded).toEqual([]);
    });
  }

  it('names only quirks src/engine-quirks.ts measures', () => {
    const unknown = [];
    for (const file of ['legacy-webos-base.css', 'legacy-webos-overrides.css']) {
      const css = readFileSync(new URL(`../css/${file}`, import.meta.url), 'utf8');
      postcss.parse(css).walkRules((rule) => {
        for (const selector of rule.selectors) unknown.push(...unknownQuirks(selector));
      });
    }
    expect(unknown).toEqual([]);
  });

  it('keys every flex gap fallback and scroll-end spacer to its quirk', () => {
    const css = readFileSync(new URL('../css/legacy-webos-base.css', import.meta.url), 'utf8');
    const misplaced = [];
    postcss.parse(css).walkRules((rule) => {
      // A spacer carries `content`; a rule without it only offsets one for
      // engines whose gap is a sibling margin.
      const spacer = rule.some((decl) => decl.prop === 'content');
      for (const selector of rule.selectors) {
        const quirk = spacer ? 'q-scroll-end-padding' : 'q-no-flex-gap';
        if (!new RegExp(`^html\\.[\\w.-]*\\b${quirk}\\b`).test(selector)) misplaced.push(selector);
      }
    });
    expect(misplaced).toEqual([]);
  });
});

describe('scaleFontSizes', () => {
  it('scales pixel font sizes while preserving other units', () => {
    const out = scaleFontSizes('.title { font-size: 24px; } .meta { font-size: 1.2rem; }');
    expect(out).toContain('font-size: calc(24px * var(--font-scale))');
    expect(out).toContain('font-size: 1.2rem');
  });

  it('does not scale video cue text', () => {
    const css = 'video::cue { font-size: 30px; }';
    expect(scaleFontSizes(css)).toBe(css);
  });
});

describe('convertLegacyColorSyntax', () => {
  it('adds a comma-separated companion next to a space-separated -rgb triplet', () => {
    const out = convertLegacyColorSyntax(`
      [data-theme="l1"] {
        --accent-rgb: 0 212 255;
        --accent-glow: rgb(var(--accent-rgb) / 0.3);
      }
    `);
    expect(out).toContain('--accent-rgb-legacy: 0, 212, 255;');
    expect(out).toContain('--accent-glow: rgba(var(--accent-rgb-legacy), 0.3);');
    // The rewritten value must be valid legacy rgba() — no bare space-list.
    expect(out).not.toMatch(/rgba\(var\(--accent-rgb\)/);
  });

  it('threads an alias declaration to the aliased companion', () => {
    const out = convertLegacyColorSyntax(`
      [data-theme="l1"] {
        --accent-rgb: 91 140 255;
        --catalog-focus-rgb: var(--accent-rgb);
      }
      .card { box-shadow: 0 0 0 6px rgb(var(--catalog-focus-rgb) / 0.25); }
    `);
    expect(out).toContain('--catalog-focus-rgb-legacy: var(--accent-rgb-legacy);');
    expect(out).toContain('box-shadow: 0 0 0 6px rgba(var(--catalog-focus-rgb-legacy), 0.25);');
  });

  it('rewrites every modern usage in a multi-stop value', () => {
    const out = convertLegacyColorSyntax(`
      [data-theme="l1"] { --catalog-hero-scrim-rgb: 10 10 15; }
      .hero {
        background:
          linear-gradient(90deg, rgb(var(--catalog-hero-scrim-rgb) / 0.95) 2%, rgb(var(--catalog-hero-scrim-rgb) / 0.5) 40%, transparent 72%);
      }
    `);
    const matches = [...out.matchAll(/rgba\(var\(--catalog-hero-scrim-rgb-legacy\), (0\.95|0\.5)\)/g)];
    expect(matches).toHaveLength(2);
  });

  it('leaves unrelated declarations untouched', () => {
    const css = '[data-theme="l1"] { --accent: #00d4ff; color: var(--accent); }';
    expect(convertLegacyColorSyntax(css)).toBe(css);
  });

  it('does not rewrite an already-legacy rgba() call', () => {
    const css = '.player-sidebar { background: rgba(20, 20, 35, 0.9); }';
    expect(convertLegacyColorSyntax(css)).toBe(css);
  });

  it('is idempotent (safe to run twice)', () => {
    const once = convertLegacyColorSyntax(`
      [data-theme="l1"] {
        --warning-rgb: 255 165 2;
      }
      .badge { filter: drop-shadow(0 0 4px rgb(var(--warning-rgb) / 0.5)); }
    `);
    expect(convertLegacyColorSyntax(once)).toBe(once);
  });

  it('produces only valid comma-separated rgba() calls for every rgb(var()) use in the app CSS', () => {
    const cssDir = new URL('../css/', import.meta.url);
    const merged = readdirSync(cssDir)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(new URL(file, cssDir), 'utf8'))
      .join('\n');
    const out = convertLegacyColorSyntax(merged);

    // Inspect declaration VALUES only (not doc comments, which may mention
    // the modern syntax as prose) for leftover modern syntax or an rgba()
    // call still wrapping a space-separated (non "-legacy") custom property.
    const values = [];
    postcss.parse(out).walkDecls((decl) => values.push(decl.value));
    for (const value of values) {
      expect(value).not.toMatch(/rgb\(\s*var\(--[\w-]+\)\s*\/\s*[^()]+\)/);
      expect(value).not.toMatch(/rgba\(var\(--[\w-]+(?<!-legacy)\),/);
    }
  });
});
