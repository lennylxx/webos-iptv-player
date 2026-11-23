import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_VARS, FONT_FAMILIES, MAX_CUSTOM_THEMES, compileTheme, contrast, customThemeCss, ensureContrast,
  sanitizeCustomThemes, seedsFromBase, type BaseVars, type ThemeSeeds,
} from './custom-theme';
import { THEMES, isValidTheme } from './themes';

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const mainCss = strip(readFileSync(join(process.cwd(), 'css/main.css'), 'utf8'));
const themesCss = strip(readFileSync(join(process.cwd(), 'css/themes.css'), 'utf8'));

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// What getComputedStyle reports on an element carrying `data-theme="<id>"`.
function baseVars(id: string): BaseVars {
  const vars = decls(/:root\s*\{([^}]*)\}/.exec(mainCss)![1]);
  for (const m of themesCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].includes(`[data-theme="${id}"]`)) Object.assign(vars, decls(m[2]));
  }
  const resolve = (v: string): string => v.replace(/var\((--[\w-]+)\)/g, (_, n: string) => resolve(vars[n] ?? ''));
  const out = {} as BaseVars;
  for (const name of BASE_VARS) out[name] = resolve(vars[name] ?? '');
  return out;
}

const WHITE = '#ffffff';

function expectReadable(vars: Record<string, string>, seeds: ThemeSeeds, label: string, textOnly = false) {
  const ratio = (a: string, b: string) => contrast(vars[a], vars[b]);
  expect(ratio('--text-primary', '--bg-card'), `${label} text`).toBeGreaterThanOrEqual(seeds.highContrast ? 10 : 7);
  expect(ratio('--text-secondary', '--bg-tertiary'), `${label} secondary`).toBeGreaterThanOrEqual(seeds.highContrast ? 7 : 4.5);
  expect(ratio('--text-muted', '--bg-primary'), `${label} muted`).toBeGreaterThanOrEqual(seeds.highContrast ? 4.5 : 3);
  if (textOnly) return;
  expect(contrast(WHITE, vars['--accent-dim']), `${label} white on accent-dim`).toBeGreaterThanOrEqual(4.5);
  expect(ratio('--accent', '--bg-secondary'), `${label} accent`).toBeGreaterThanOrEqual(4.5);
  for (const name of ['--past', '--live', '--future']) {
    expect(ratio(name, '--bg-primary'), `${label} ${name}`).toBeGreaterThanOrEqual(3);
  }
}

describe('compileTheme', () => {
  it('reproduces every preset exactly when no seed changes', () => {
    for (const theme of THEMES) {
      const base = baseVars(theme.id);
      const { vars, adjusted } = compileTheme(base, seedsFromBase(base));
      expect(adjusted).toEqual([]);
      for (const name of ['--bg-primary', '--bg-card', '--text-primary', '--text-muted', '--accent', '--accent-dim', '--border']) {
        expect(vars[name], `${theme.id} ${name}`).toBe(base[name as keyof BaseVars].toLowerCase());
      }
      expect(vars['--focus-ring']).toBe(vars['--accent']);
      expect(vars['--radius']).toBe('8px');
      expect(vars['--font-weight-text']).toBe('400');
      expect(vars['--overlay-bg']).toBe('rgba(30, 30, 50, 0.75)');
      expect(vars['--overlay-frosted-bg']).toBe('rgba(244, 246, 249, 0.85)');
    }
  });

  it('keeps white text on a pale accent readable by darkening only the fill', () => {
    const base = baseVars('midnight');
    const seeds = { ...seedsFromBase(base), accent: '#fff3a0' };
    const { vars, adjusted } = compileTheme(base, seeds);
    expect(vars['--accent']).toBe('#fff3a0');
    expect(adjusted).toEqual([]);
    expect(contrast(WHITE, vars['--accent-dim'])).toBeGreaterThanOrEqual(4.5);
  });

  it('reports an accent it had to change for readability', () => {
    const base = baseVars('daylight');
    const { vars, adjusted } = compileTheme(base, { ...seedsFromBase(base), accent: '#fff3a0' });
    expect(adjusted).toEqual(['accent']);
    expect(contrast(vars['--accent'], vars['--bg-secondary'])).toBeGreaterThanOrEqual(4.5);
  });

  it('meets every readability floor for random seeds in both modes', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const hex = () => '#' + [0, 0, 0].map(() => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('');
    for (let i = 0; i < 300; i++) {
      const theme = THEMES[i % THEMES.length];
      const base = baseVars(theme.id);
      const mode = rand() < 0.5 ? 'light' : 'dark';
      const seeds: ThemeSeeds = {
        ...seedsFromBase(base),
        mode,
        accent: hex(),
        background: hex(),
        elevation: (i % 3) as 0 | 1 | 2,
        highContrast: rand() < 0.3,
        focus: rand() < 0.5 ? 'accent' : 'contrast',
        past: hex(), live: hex(), future: hex(),
      };
      const { vars } = compileTheme(base, seeds);
      expectReadable(vars, seeds, `${theme.id} #${i}`);
    }
  });

  it('raises text contrast on every preset without touching its surfaces', () => {
    for (const theme of THEMES) {
      const base = baseVars(theme.id);
      const seeds = { ...seedsFromBase(base), highContrast: true };
      const { vars } = compileTheme(base, seeds);
      expect(vars['--bg-card']).toBe(base['--bg-card'].toLowerCase());
      expectReadable(vars, seeds, theme.id, true);
    }
  });

  it('pairs every rgb triplet with the comma-separated form the build uses', () => {
    const base = baseVars('ember');
    const { vars } = compileTheme(base, { ...seedsFromBase(base), accent: '#336699', live: '#22aa44' });
    const triplets = Object.keys(vars).filter(name => /-rgb$/.test(name));
    expect(triplets).toEqual(expect.arrayContaining(['--accent-rgb', '--live-rgb', '--catalog-hero-scrim-rgb']));
    for (const name of triplets) {
      expect(vars[`${name}-legacy`]).toBe(vars[name].split(' ').join(', '));
    }
  });

  it('applies the focus, glow, shape, and overlay choices', () => {
    const base = baseVars('midnight');
    const { vars } = compileTheme(base, {
      ...seedsFromBase(base), focus: 'contrast', glow: 0, radius: 16, overlayOpacity: 100, font: 'serif', weight: 'light',
    });
    expect(vars['--font-weight-text']).toBe('300');
    expect(vars['--focus-ring']).toBe(vars['--text-primary']);
    expect(vars['--focus-glow']).toMatch(/, 0\)$/);
    expect(vars['--radius']).toBe('16px');
    expect(vars['--overlay-bg']).toBe('rgba(30, 30, 50, 1)');
    expect(vars['--overlay-frosted-bg']).toBe('rgba(244, 246, 249, 1)');
    expect(vars['--font-family']).toMatch(/^Tinos, 'Droid Serif', /);
    // Miso has its own entry, so the condensed face never quietly becomes it.
    expect(FONT_FAMILIES['lg-condensed']).not.toContain('Miso');
  });
});

describe('ensureContrast', () => {
  it('keeps the hue while moving away from the background', () => {
    const fixed = ensureContrast('#ffcc00', '#ffffff', 4.5);
    expect(contrast(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(fixed).not.toBe('#000000');
  });
});

describe('custom theme storage', () => {
  const valid = (n: number) => ({
    id: `custom-a${n}`, name: `Theme ${n}`, base: 'ember',
    seeds: { accent: '#112233' }, vars: { '--accent': '#112233' },
  });

  it('keeps at most three well-formed themes', () => {
    const themes = sanitizeCustomThemes([valid(1), valid(1), valid(2), valid(3), valid(4)], isValidTheme);
    expect(themes.map(t => t.id)).toEqual(['custom-a1', 'custom-a2', 'custom-a3']);
    expect(themes).toHaveLength(MAX_CUSTOM_THEMES);
    expect(themes[0].seeds.accent).toBe('#112233');
    expect(themes[0].seeds.radius).toBe(8);
  });

  it('reads a theme saved before the weight choice as regular', () => {
    const [theme] = sanitizeCustomThemes([valid(1)], isValidTheme);
    expect(theme.seeds.weight).toBe('regular');
  });

  it('drops values that could escape the rule', () => {
    const [theme] = sanitizeCustomThemes([{
      ...valid(1),
      id: 'custom-a1',
      base: 'not-a-theme',
      name: 'x'.repeat(80),
      seeds: { accent: 'red;}', radius: 99 },
      vars: { '--accent': '#fff}body{color:red', '--bg-card': 'url(http://host/a)', 'color': '#000', '--ok': '#000000' },
    }], isValidTheme);
    expect(theme.base).toBe('midnight');
    expect(theme.name).toHaveLength(32);
    expect(theme.seeds.accent).toBe('#00d4ff');
    expect(theme.seeds.radius).toBe(8);
    expect(theme.vars).toEqual({ '--ok': '#000000' });
    expect(sanitizeCustomThemes([{ ...valid(1), id: 'custom-"]' }], isValidTheme)).toEqual([]);
  });

  it('writes one rule that outranks the presets', () => {
    expect(customThemeCss('custom-a1', { '--accent': '#112233', '--bad': '}' }))
      .toBe('[data-theme="custom-a1"][data-theme="custom-a1"]{--accent:#112233;}');
    expect(customThemeCss('midnight', { '--accent': '#112233' })).toBe('');
  });
});
