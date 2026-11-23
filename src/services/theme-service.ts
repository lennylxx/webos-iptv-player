import { DEFAULT_THEME, DEFAULT_OVERLAY, DEFAULT_TEXT_SIZE, isValidTheme, isValidOverlayStyle, isValidTextSize } from '../config/themes';
import { BASE_VARS, customThemeCss, isCustomThemeId, type BaseVars, type CustomTheme } from '../config/custom-theme';
import { StorageService } from './storage-service';

// Theme switching is a single attribute write on <html>; the CSS variable
// overrides live in css/themes.css keyed by `[data-theme="<id>"]`. A custom
// theme adds one rule of precompiled values (see src/config/custom-theme.ts),
// so CSS never needs color math the older engines lack.

const RULES_ID = 'custom-theme-rules';
// Bumped whenever the custom rules change, since an edited theme keeps its id.
let revision = 0;

export function themeRevision(): number {
  return revision;
}
const DRAFT_RULES_ID = 'custom-theme-draft';
export const DRAFT_THEME_ID = 'custom-draft';

function customTheme(id: string | null | undefined): CustomTheme | undefined {
  if (!isCustomThemeId(id)) return undefined;
  return StorageService.getCustomThemes().find(t => t.id === id);
}

export function isKnownTheme(id: string | null | undefined): id is string {
  return isValidTheme(id) || !!customTheme(id);
}

function setThemeAttr(id: string | null | undefined): void {
  const root = document.documentElement;
  const custom = customTheme(id);
  root.dataset.theme = custom || isValidTheme(id) ? id! : DEFAULT_THEME;
  if (custom && !custom.seeds.overlayBlur) root.setAttribute('data-overlay-blur', 'off');
  else root.removeAttribute('data-overlay-blur');
}

function styleElement(id: string): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  return style;
}

/** Writes one rule per stored custom theme (the root and the Settings swatches
 *  both resolve through it). Values are validated by `customThemeCss`. */
export function installCustomThemes(): void {
  revision++;
  styleElement(RULES_ID).textContent = StorageService.getCustomThemes()
    .map(theme => customThemeCss(theme.id, theme.vars)).join('\n');
  // An edited or deleted stored theme reaches the next launch's first paint.
  cacheThemeCss(StorageService.getTheme());
}

function cacheThemeCss(id: string): void {
  const custom = customTheme(id);
  const css = custom ? customThemeCss(custom.id, custom.vars) : '';
  if (css !== StorageService.getThemeCss()) StorageService.setThemeCss(css);
}

/** The editor's unsaved theme, scoped to elements marked `data-theme="custom-draft"`. */
export function setDraftTheme(vars: Record<string, string> | null): void {
  styleElement(DRAFT_RULES_ID).textContent = vars ? customThemeCss(DRAFT_THEME_ID, vars) : '';
}

/** A preset's own variables. Unset tokens inherit from the root, so the root
 *  itself switches to the preset for the read and back right after. */
export function readPresetVars(presetId: string): BaseVars {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  root.dataset.theme = isValidTheme(presetId) ? presetId : DEFAULT_THEME;
  const style = getComputedStyle(root);
  const vars = {} as BaseVars;
  for (const name of BASE_VARS) vars[name] = style.getPropertyValue(name).trim();
  if (previous === undefined) delete root.dataset.theme;
  else root.dataset.theme = previous;
  return vars;
}

/** Persisted theme applied to the document root. A custom theme's rule is
 *  cached so the next launch can paint it before the app loads. */
export function applyTheme(id: string): void {
  setThemeAttr(id);
  cacheThemeCss(id);
}

/** Temporary preview (no persistence) — used by the Settings picker while the
 *  D-pad moves across swatches. */
export function previewTheme(id: string): void {
  setThemeAttr(id);
}

/** Player overlay glass style → `data-overlay` on the document root; the light
 *  variants live in css/player.css. */
export function applyOverlayStyle(style: string): void {
  document.documentElement.dataset.overlay = isValidOverlayStyle(style) ? style : DEFAULT_OVERLAY;
}

/** App-wide text size → `data-text-size` on the document root; the
 *  `--font-scale` factors live in css/main.css. Doubles as the Settings live
 *  preview (nothing is persisted here). */
export function applyTextSize(size: string): void {
  document.documentElement.dataset.textSize = isValidTextSize(size) ? size : DEFAULT_TEXT_SIZE;
}

/** Re-assert the stored theme + overlay style on boot (belt-and-suspenders
 *  alongside the inline <head> script that beats the first paint). */
export function initTheme(): void {
  installCustomThemes();
  applyTheme(StorageService.getTheme());
  applyOverlayStyle(StorageService.getOverlayStyle());
  applyTextSize(StorageService.getTextSize());
}
