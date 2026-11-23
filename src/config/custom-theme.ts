// Custom themes: a few user-chosen seeds compiled into the full set of theme
// variables. Compiling runs once per edit or save, never per frame; the
// result is plain hex and rgba() strings, so nothing needs color math in CSS.
// A seed group the user left at its base preset's value keeps that preset's
// exact colors, so a fresh copy looks the same as its base.

export const MAX_CUSTOM_THEMES = 3;
export const CUSTOM_THEME_PREFIX = 'custom-';

export type ThemeMode = 'dark' | 'light';
export type Elevation = 0 | 1 | 2;
export type FocusColor = 'accent' | 'contrast';
export type GlowLevel = 0 | 1 | 2;
export const RADII = [0, 4, 8, 12, 16] as const;
export type Radius = typeof RADII[number];
export const OVERLAY_OPACITIES = [60, 75, 90, 100] as const;
export type OverlayOpacity = typeof OVERLAY_OPACITIES[number];
export const FONT_IDS = ['default', 'lg-condensed', 'museo-sans', 'miso', 'serif'] as const;
export type FontId = typeof FONT_IDS[number];
export type FontWeight = 'light' | 'regular';

export interface ThemeSeeds {
  mode: ThemeMode;
  accent: string;
  background: string;
  elevation: Elevation;
  highContrast: boolean;
  focus: FocusColor;
  glow: GlowLevel;
  radius: Radius;
  font: FontId;
  weight: FontWeight;
  overlayOpacity: OverlayOpacity;
  overlayBlur: boolean;
  past: string;
  live: string;
  future: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  base: string;
  seeds: ThemeSeeds;
  vars: Record<string, string>;
}

// Seeds the editor reports when readability forced a different value.
export type AdjustableSeed = 'background' | 'accent' | 'past' | 'live' | 'future';

export interface CompiledTheme {
  vars: Record<string, string>;
  adjusted: AdjustableSeed[];
}

const DEFAULT_STACK = "-apple-system, 'LG Smart UI', 'Helvetica Neue', Arial, sans-serif";

// Fonts that ship on webOS TVs (named as Enact's themes load them); the
// editor offers only those the TV renders. Scripts a face lacks fall back to
// the default stack. Older TVs may name the condensed face "Cond".
export const FONT_NAMES: Record<FontId, string[]> = {
  default: [],
  'lg-condensed': ["'LG Smart UI Condensed'", "'LG Smart UI Cond'"],
  'museo-sans': ["'Museo Sans'"],
  miso: ['Miso'],
  serif: ['Tinos', "'Droid Serif'"],
};

export const FONT_FAMILIES: Record<FontId, string> = {
  default: DEFAULT_STACK,
  'lg-condensed': `${FONT_NAMES['lg-condensed'].join(', ')}, ${DEFAULT_STACK}`,
  'museo-sans': `${FONT_NAMES['museo-sans'].join(', ')}, ${DEFAULT_STACK}`,
  miso: `${FONT_NAMES.miso.join(', ')}, ${DEFAULT_STACK}`,
  serif: `${FONT_NAMES.serif.join(', ')}, ${DEFAULT_STACK}`,
};

// The base-preset variables the compiler reads (computed on a probe element).
export const BASE_VARS = [
  '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-card',
  '--text-primary', '--text-secondary', '--text-muted', '--scrollbar-thumb',
  '--accent', '--accent-dim', '--danger', '--success', '--warning', '--border',
  '--catalog-surface', '--catalog-control', '--catalog-focus', '--catalog-hero-scrim-rgb',
  '--catalog-sort-selected-bg', '--catalog-stack', '--catalog-stack-near-opacity',
  '--catalog-stack-far-opacity', '--past', '--live', '--future',
] as const;
export type BaseVars = Record<typeof BASE_VARS[number], string>;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const VAR_NAME_RE = /^--[a-z0-9-]+$/;
// Compiled values are hex, rgba(), numbers, px, and quoted font names only.
const VAR_VALUE_RE = /^[#0-9a-zA-Z ,.%()'-]{1,120}$/;

// ---- color math ----

interface Hsl { h: number; s: number; l: number }

export function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (HEX_RE.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (rgb) return toHex([+rgb[1], +rgb[2], +rgb[3]]);
  return null;
}

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return '#' + rgb.map(c => {
    const v = Math.max(0, Math.min(255, Math.round(c))).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

export function toHsl(hex: string): Hsl {
  const [r, g, b] = rgbOf(hex).map(c => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function fromHsl({ h, s, l }: Hsl): string {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  s = clamp(s);
  l = clamp(l);
  const hue = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return toHex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return toHex([channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255]);
}

export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(c => c / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Move `fg` away from `bg` in lightness, keeping its hue, until it reaches
// `ratio`. Falls back to the extreme (black or white) if nothing in between
// passes.
export function ensureContrast(fg: string, bg: string, ratio: number): string {
  if (contrast(fg, bg) >= ratio) return fg;
  const hsl = toHsl(fg);
  const lighter = luminance(bg) < 0.18;
  for (let step = 1; step <= 100; step++) {
    const l = hsl.l + (lighter ? step : -step) / 100;
    if (l < 0 || l > 1) break;
    const candidate = fromHsl({ h: hsl.h, s: hsl.s, l });
    if (contrast(candidate, bg) >= ratio) return candidate;
  }
  return lighter ? '#ffffff' : '#000000';
}

function mix(a: string, b: string, weight: number): string {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return toHex(x.map((c, i) => c * (1 - weight) + y[i] * weight));
}

const rgbTriplet = (hex: string) => rgbOf(hex).join(' ');
const rgba = (hex: string, alpha: number) => `rgba(${rgbOf(hex).join(', ')}, ${alpha})`;

// ---- seeds ----

export function isLightBackground(hex: string): boolean {
  return luminance(hex) > 0.4;
}

export function seedsFromBase(base: BaseVars): ThemeSeeds {
  const background = normalizeHex(base['--bg-primary']) ?? '#0a0a0f';
  return {
    mode: isLightBackground(background) ? 'light' : 'dark',
    accent: normalizeHex(base['--accent']) ?? '#00d4ff',
    background,
    elevation: 1,
    highContrast: false,
    focus: 'accent',
    glow: 1,
    radius: 8,
    font: 'default',
    weight: 'regular',
    overlayOpacity: 75,
    overlayBlur: true,
    past: normalizeHex(base['--past']) ?? '#5fc99a',
    live: normalizeHex(base['--live']) ?? '#5fc99a',
    future: normalizeHex(base['--future']) ?? '#8c9cf0',
  };
}

// A background for `mode` that keeps the current hue, used when the mode flips.
export function backgroundForMode(current: string, mode: ThemeMode): string {
  const { h, s } = toHsl(current);
  return mode === 'light'
    ? fromHsl({ h, s: Math.min(s, 0.3), l: 0.965 })
    : fromHsl({ h, s: Math.min(s, 0.3), l: 0.05 });
}

// ---- compile ----

// Text can only clear its floors on a background dark or light enough for its mode.
const DARK_MAX_L = 0.16;
const LIGHT_MIN_L = 0.88;

export function clampBackground(hex: string, mode: ThemeMode): string {
  const hsl = toHsl(hex);
  if (mode === 'dark' && hsl.l > DARK_MAX_L) return fromHsl({ ...hsl, l: DARK_MAX_L });
  if (mode === 'light' && hsl.l < LIGHT_MIN_L) return fromHsl({ ...hsl, l: LIGHT_MIN_L });
  return hex;
}

const DARK_STEPS = [0.025, 0.045, 0.07];
const LIGHT_STEPS = [0.02, 0.035, 0.055];

function deriveSurfaces(seeds: ThemeSeeds): Record<string, string> {
  const bg = toHsl(seeds.background);
  const light = seeds.mode === 'light';
  const d = (light ? LIGHT_STEPS : DARK_STEPS)[seeds.elevation];
  const at = (offset: number) => fromHsl({ h: bg.h, s: bg.s, l: bg.l + offset });
  const primary = seeds.background;
  // Panels stay dark (or light) enough for the text floors, however saturated.
  const floor = seeds.highContrast ? 12 : 8.5;
  const panel = (hex: string) => ensureContrast(hex, light ? '#000000' : '#ffffff', light ? floor + 2 : floor);
  const secondary = panel(at(light ? -d : d));
  const tertiary = panel(at(light ? -2 * d : 2 * d));
  const card = panel(light ? fromHsl({ h: bg.h, s: bg.s, l: bg.l + (1 - bg.l) * 0.8 }) : at(2.4 * d));
  const border = at(light ? -1.8 * d : 3.2 * d);
  return {
    '--bg-primary': primary,
    '--bg-secondary': secondary,
    '--bg-tertiary': tertiary,
    '--bg-card': card,
    '--border': border,
  };
}

function deriveText(seeds: ThemeSeeds, s: Record<string, string>): Record<string, string> {
  const { h } = toHsl(seeds.background);
  const light = seeds.mode === 'light';
  const sat = Math.min(toHsl(seeds.background).s, 0.12);
  const tone = (l: number) => fromHsl({ h, s: sat, l });
  const high = seeds.highContrast;
  // Each text level clears its ratio on the surface it most often sits on.
  const primary = ensureContrast(tone(light ? 0.14 : 0.92), s['--bg-card'], high ? 10 : 7);
  const secondary = ensureContrast(tone(light ? 0.33 : 0.68), s['--bg-tertiary'], high ? 7 : 4.5);
  const muted = ensureContrast(tone(light ? 0.52 : 0.48), s['--bg-primary'], high ? 4.5 : 3);
  return { '--text-primary': primary, '--text-secondary': secondary, '--text-muted': muted };
}

function pick(base: BaseVars, name: typeof BASE_VARS[number], fallback: string): string {
  return normalizeHex(base[name]) ?? fallback;
}

export function compileTheme(base: BaseVars, chosen: ThemeSeeds): CompiledTheme {
  const baseSeeds = seedsFromBase(base);
  const adjusted: AdjustableSeed[] = [];
  const background = chosen.background === baseSeeds.background && chosen.mode === baseSeeds.mode
    ? chosen.background : clampBackground(chosen.background, chosen.mode);
  if (background !== chosen.background) adjusted.push('background');
  const seeds = { ...chosen, background };
  const vars: Record<string, string> = {};
  const surfacesChanged = seeds.mode !== baseSeeds.mode
    || chosen.background !== baseSeeds.background
    || seeds.elevation !== baseSeeds.elevation;
  const light = seeds.mode === 'light';

  const surfaces = surfacesChanged ? deriveSurfaces(seeds) : {
    '--bg-primary': pick(base, '--bg-primary', seeds.background),
    '--bg-secondary': pick(base, '--bg-secondary', seeds.background),
    '--bg-tertiary': pick(base, '--bg-tertiary', seeds.background),
    '--bg-card': pick(base, '--bg-card', seeds.background),
    '--border': pick(base, '--border', seeds.background),
  };
  Object.assign(vars, surfaces);

  const text = surfacesChanged || seeds.highContrast ? deriveText(seeds, surfaces) : {
    '--text-primary': pick(base, '--text-primary', '#e8e8e8'),
    '--text-secondary': pick(base, '--text-secondary', '#a0a0b0'),
    '--text-muted': pick(base, '--text-muted', '#666680'),
  };
  Object.assign(vars, text);
  vars['--scrollbar-thumb'] = surfacesChanged
    ? (light ? mix(text['--text-muted'], surfaces['--bg-primary'], 0.4) : text['--text-muted'])
    : pick(base, '--scrollbar-thumb', text['--text-muted']);

  // Accent: readable as text on the panels, and white text on its dim fill.
  const accentChanged = seeds.accent !== baseSeeds.accent;
  let accent = seeds.accent;
  let accentDim = pick(base, '--accent-dim', '#007e9e');
  if (accentChanged || surfacesChanged) {
    accent = ensureContrast(seeds.accent, surfaces['--bg-secondary'], 4.5);
    if (accent !== seeds.accent) adjusted.push('accent');
    accentDim = ensureContrast(
      fromHsl({ ...toHsl(accent), l: toHsl(accent).l * (light ? 0.9 : 0.75) }), '#ffffff', 4.5);
  }
  vars['--accent'] = accent;
  vars['--accent-dim'] = accentDim;
  vars['--accent-rgb'] = rgbTriplet(accent);
  vars['--accent-glow'] = rgba(accent, 0.3);

  for (const name of ['--danger', '--success', '--warning'] as const) {
    const value = pick(base, name, '#ff4757');
    vars[name] = surfacesChanged ? ensureContrast(value, surfaces['--bg-card'], 3) : value;
  }
  vars['--danger-rgb'] = rgbTriplet(vars['--danger']);
  vars['--warning-rgb'] = rgbTriplet(vars['--warning']);

  const keepCatalog = !surfacesChanged && !accentChanged;
  vars['--catalog-surface'] = keepCatalog ? pick(base, '--catalog-surface', surfaces['--bg-card']) : surfaces['--bg-card'];
  vars['--catalog-control'] = keepCatalog ? pick(base, '--catalog-control', surfaces['--bg-tertiary']) : surfaces['--bg-tertiary'];
  vars['--catalog-focus'] = keepCatalog ? pick(base, '--catalog-focus', accent) : accent;
  vars['--catalog-focus-rgb'] = rgbTriplet(vars['--catalog-focus']);
  vars['--catalog-sort-selected-bg'] = keepCatalog ? pick(base, '--catalog-sort-selected-bg', accentDim) : accentDim;
  vars['--catalog-hero-scrim-rgb'] = surfacesChanged
    ? rgbTriplet(surfaces['--bg-primary'])
    : (base['--catalog-hero-scrim-rgb'] || rgbTriplet(surfaces['--bg-primary'])).trim();
  if (surfacesChanged) {
    vars['--catalog-stack'] = light ? text['--text-secondary'] : text['--text-muted'];
    vars['--catalog-stack-near-opacity'] = light ? '0.45' : '0.7';
    vars['--catalog-stack-far-opacity'] = light ? '0.22' : '0.4';
  } else {
    vars['--catalog-stack'] = pick(base, '--catalog-stack', text['--text-muted']);
    vars['--catalog-stack-near-opacity'] = (base['--catalog-stack-near-opacity'] || '0.7').trim();
    vars['--catalog-stack-far-opacity'] = (base['--catalog-stack-far-opacity'] || '0.4').trim();
  }

  const focus = seeds.focus === 'contrast' ? text['--text-primary'] : accent;
  vars['--focus-ring'] = focus;
  vars['--focus-glow'] = rgba(focus, [0, 0.3, 0.55][seeds.glow]);

  for (const name of ['past', 'live', 'future'] as const) {
    const chosen = seeds[name];
    const changed = chosen !== baseSeeds[name];
    const value = changed || surfacesChanged ? ensureContrast(chosen, surfaces['--bg-primary'], 3) : chosen;
    if (value !== chosen && changed) adjusted.push(name);
    vars[`--${name}`] = value;
    vars[`--${name}-rgb`] = rgbTriplet(value);
  }

  vars['--radius'] = `${seeds.radius}px`;
  vars['--font-family'] = FONT_FAMILIES[seeds.font];
  vars['--font-weight-text'] = seeds.weight === 'light' ? '300' : '400';
  const alpha = seeds.overlayOpacity / 100;
  vars['--overlay-bg'] = `rgba(30, 30, 50, ${alpha})`;
  vars['--overlay-frosted-bg'] = `rgba(244, 246, 249, ${Math.min(1, Math.round((alpha + 0.1) * 100) / 100)})`;

  // The build rewrites `rgb(var(--x-rgb) / a)` to `rgba(var(--x-rgb-legacy), a)`,
  // so every triplet needs its comma-separated companion.
  for (const name of Object.keys(vars)) {
    if (/-rgb$/.test(name)) vars[`${name}-legacy`] = vars[name].split(/\s+/).join(', ');
  }
  return { vars, adjusted };
}

// ---- validation and CSS ----

export function isCustomThemeId(id: string | null | undefined): boolean {
  return !!id && /^custom-[a-z0-9]{1,16}$/.test(id);
}

export function newCustomThemeId(): string {
  let suffix = '';
  while (suffix.length < 8) suffix += Math.random().toString(36).slice(2);
  return CUSTOM_THEME_PREFIX + suffix.slice(0, 8);
}

export const MAX_THEME_NAME = 32;

const oneOf = <T>(values: readonly T[], v: unknown, fallback: T): T =>
  values.indexOf(v as T) !== -1 ? v as T : fallback;

function sanitizeSeeds(raw: unknown, fallback: ThemeSeeds): ThemeSeeds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ThemeSeeds, unknown>>;
  const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : d);
  return {
    mode: oneOf(['dark', 'light'] as const, r.mode, fallback.mode),
    accent: hex(r.accent, fallback.accent),
    background: hex(r.background, fallback.background),
    elevation: oneOf([0, 1, 2] as const, r.elevation, fallback.elevation),
    highContrast: typeof r.highContrast === 'boolean' ? r.highContrast : fallback.highContrast,
    focus: oneOf(['accent', 'contrast'] as const, r.focus, fallback.focus),
    glow: oneOf([0, 1, 2] as const, r.glow, fallback.glow),
    radius: oneOf(RADII, r.radius, fallback.radius),
    font: oneOf(FONT_IDS, r.font, fallback.font),
    weight: oneOf(['light', 'regular'] as const, r.weight, fallback.weight),
    overlayOpacity: oneOf(OVERLAY_OPACITIES, r.overlayOpacity, fallback.overlayOpacity),
    overlayBlur: typeof r.overlayBlur === 'boolean' ? r.overlayBlur : fallback.overlayBlur,
    past: hex(r.past, fallback.past),
    live: hex(r.live, fallback.live),
    future: hex(r.future, fallback.future),
  };
}

export function sanitizeVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  const source = raw as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (VAR_NAME_RE.test(name) && typeof value === 'string' && VAR_VALUE_RE.test(value)) out[name] = value;
  }
  return out;
}

const FALLBACK_SEEDS: ThemeSeeds = {
  mode: 'dark', accent: '#00d4ff', background: '#0a0a0f', elevation: 1, highContrast: false,
  focus: 'accent', glow: 1, radius: 8, font: 'default', weight: 'regular', overlayOpacity: 75, overlayBlur: true,
  past: '#5fc99a', live: '#5fc99a', future: '#8c9cf0',
};

// Stored themes are untrusted input: keep only well-formed fields.
export function sanitizeCustomThemes(raw: unknown, isPreset: (id: string) => boolean): CustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTheme[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_THEMES) break;
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !isCustomThemeId(t.id) || out.some(o => o.id === t.id)) continue;
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, MAX_THEME_NAME) : '';
    const base = typeof t.base === 'string' && isPreset(t.base) ? t.base : 'midnight';
    out.push({ id: t.id, name, base, seeds: sanitizeSeeds(t.seeds, FALLBACK_SEEDS), vars: sanitizeVars(t.vars) });
  }
  return out;
}

// One rule per theme. The doubled attribute outranks both the preset blocks
// and the shared `[data-theme]` focus rule wherever the style sits.
export function customThemeCss(id: string, vars: Record<string, string>): string {
  if (!isCustomThemeId(id)) return '';
  const body = Object.keys(sanitizeVars(vars)).map(name => `${name}:${vars[name]};`).join('');
  return `[data-theme="${id}"][data-theme="${id}"]{${body}}`;
}
