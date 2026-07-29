// Theme registry — metadata only. The color values live in `css/themes.css`
// as `[data-theme="<id>"]` blocks (single source of truth); the Settings swatch
// grid reads them back through each tile's own `data-theme`.

export interface ThemeMeta {
  id: string;
  name: string;
  isLight: boolean;
}

export const DEFAULT_THEME = 'midnight';

// Display order in the picker.
export const THEMES: ThemeMeta[] = [
  { id: 'midnight', name: 'Midnight', isLight: false },
  { id: 'ember', name: 'Ember', isLight: false },
  { id: 'emerald', name: 'Emerald', isLight: false },
  { id: 'amethyst', name: 'Amethyst', isLight: false },
  { id: 'daylight', name: 'Daylight', isLight: true },
  { id: 'plum-night', name: 'Plum Night', isLight: false },
  { id: 'arctic', name: 'Arctic', isLight: false },
  { id: 'ocean-dark', name: 'Ocean Dark', isLight: false },
  { id: 'vintage-amber', name: 'Vintage Amber', isLight: false },
  { id: 'pastel-mocha', name: 'Pastel Mocha', isLight: false },
  { id: 'neon-night', name: 'Neon Night', isLight: false },
  { id: 'pastel-latte', name: 'Pastel Latte', isLight: true },
  { id: 'paper-light', name: 'Paper Light', isLight: true },
  { id: 'burgundy', name: 'Burgundy', isLight: false },
  { id: 'cobalt-slate', name: 'Cobalt Slate', isLight: false },
];

export function isValidTheme(id: string | null | undefined): id is string {
  return !!id && THEMES.some(t => t.id === id);
}

// Player overlay glass style (OSD / sidebar / menu). 'dark' = dark-glass on every
// theme (default, universally readable over video); 'frosted' = a light-glass
// variant. See css/player.css.
export type OverlayStyle = 'dark' | 'frosted';
export const DEFAULT_OVERLAY: OverlayStyle = 'dark';
export const OVERLAY_STYLES: { value: OverlayStyle; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'frosted', label: 'Frosted' },
];

export function isValidOverlayStyle(v: string | null | undefined): v is OverlayStyle {
  return v === 'dark' || v === 'frosted';
}

// App-wide text size, as a percentage id. The scale factors live in
// `css/main.css` as `[data-text-size="<id>"]` blocks driving `--font-scale`,
// which PostCSS multiplies into pixel `font-size` declarations at build time.
// 100 is the baseline and needs no block.
export const TEXT_SIZES = ['80', '90', '100', '110', '120', '130', '140', '150'] as const;
export type TextSize = typeof TEXT_SIZES[number];
export const DEFAULT_TEXT_SIZE: TextSize = '100';

export function isValidTextSize(v: string | null | undefined): v is TextSize {
  return TEXT_SIZES.indexOf(v as TextSize) !== -1;
}
