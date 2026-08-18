import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  convertLegacyColorSyntax,
  generateFlexGapFallback,
  linkedStylesheets,
  scaleFontSizes,
} from './css-transforms.mjs';

describe('generateFlexGapFallback', () => {
  it('generates main-axis margins for row and column flex containers', () => {
    const out = generateFlexGapFallback([`
      .row { display: flex; gap: 12px; }
      .column { display: flex; flex-direction: column; gap: 16px; }
    `]);
    expect(out).toContain('.row > * + * { margin-left: 12px; }');
    expect(out).toContain('.column > * + * { margin-top: 16px; }');
  });

  it('uses the directional gap for the flex main axis', () => {
    const out = generateFlexGapFallback([`
      .row { display: flex; row-gap: 8px; column-gap: 14px; }
      .column { display: flex; flex-direction: column; row-gap: 18px; column-gap: 10px; }
      .row-shorthand { display: flex; gap: 10px 24px; }
      .column-shorthand { display: flex; flex-direction: column; gap: 12px 20px; }
    `]);
    expect(out).toContain('.row > * + * { margin-left: 14px; }');
    expect(out).toContain('.column > * + * { margin-top: 18px; }');
    expect(out).toContain('.row-shorthand > * + * { margin-left: 24px; }');
    expect(out).toContain('.column-shorthand > * + * { margin-top: 12px; }');
  });

  it('expands grouped selectors and ignores grid and nested rules', () => {
    const out = generateFlexGapFallback([`
      .alpha, .bravo { display: flex; gap: 10px; }
      .grid { display: grid; gap: 20px; }
      @media (min-width: 1px) { .nested { display: flex; gap: 30px; } }
    `]);
    expect(out).toContain('.alpha > * + *, .bravo > * + * { margin-left: 10px; }');
    expect(out).not.toContain('.grid >');
    expect(out).not.toContain('.nested >');
  });

  it('resolves the flex context declared by another rule with the same selector', () => {
    const out = generateFlexGapFallback([`
      .badge { display: inline-flex; align-items: center; }
      .badge { gap: 5px; }
    `]);
    expect(out).toContain('.badge > * + * { margin-left: 5px; }');
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
    expect(out).toContain('.scoped-tabs > * + * { margin-left: 2px; }');
  });

  it('zeroes the other axis when a rule flips direction over a base container', () => {
    const out = generateFlexGapFallback([`
      .card { display: flex; flex-direction: column; gap: 16px; }
      .card-wide { flex-direction: row; gap: 24px; }
    `]);
    expect(out).toContain('.card > * + * { margin-top: 16px; }');
    expect(out).toContain('.card-wide > * + * { margin-left: 24px; margin-top: 0; }');
  });

  it('keeps a gap reset so it can override an inherited fallback margin', () => {
    const out = generateFlexGapFallback([`
      .action { display: flex; gap: 8px; }
      .action[data-variant="bare"] { gap: 0; }
    `]);
    expect(out).toContain('.action[data-variant="bare"] > * + * { margin-left: 0; }');
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

describe('legacy stylesheets', () => {
  // A fallback that is not wrapped in an `@supports not (...)` guard also lands
  // on a modern TV, where it double-applies on top of the real feature. e2e
  // proves this in a browser; here it fails without one.
  for (const file of ['legacy-webos-base.css', 'legacy-webos-overrides.css']) {
    it(`wraps every rule in css/${file} in an @supports guard`, () => {
      const css = readFileSync(new URL(`../css/${file}`, import.meta.url), 'utf8');
      const unguarded = [];
      postcss.parse(css).each((node) => {
        if (node.type === 'comment') return;
        if (node.type === 'atrule' && node.name === 'supports' && node.params.startsWith('not ')) return;
        unguarded.push(node.type === 'rule' ? node.selector : `@${node.name} ${node.params}`);
      });
      expect(unguarded).toEqual([]);
    });
  }
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
