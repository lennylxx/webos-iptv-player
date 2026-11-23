import type { Action } from '../types';
import { html, raw, type Safe } from '../utils/dom';
import { morph } from '../utils/morph';
import { SpatialNav, isFocusMove } from '../navigation/spatial-nav';
import { Focus, Tier, type FocusScope } from '../navigation/focus-scope';
import { t } from '../i18n';
import { CONFIG } from '../config';
import { THEMES } from '../config/themes';
import {
  FONT_FAMILIES, FONT_IDS, FONT_NAMES, MAX_THEME_NAME, OVERLAY_OPACITIES, RADII,
  backgroundForMode, compileTheme, fromHsl, newCustomThemeId, normalizeHex, seedsFromBase, toHsl,
  type BaseVars, type CompiledTheme, type CustomTheme, type FontId, type ThemeSeeds,
} from '../config/custom-theme';
import { DRAFT_THEME_ID, readPresetVars, setDraftTheme } from '../services/theme-service';
import { ConfirmationPrompt } from './confirmation-prompt';
import { dropdown, toggleDropdown, closeDropdown, commitDropdownOption } from './dropdown';
import { toggleGroup } from './toggle-controls';
import { backKey } from './key-hints';
import { CHEVRON_RIGHT_ICON, WARNING_ICON } from './icons';
import { themePreviewMock } from './theme-preview';

export interface ThemeEditorOptions {
  // The theme to edit, or null to make a new one from `base`.
  theme: CustomTheme | null;
  base: string;
  defaultName: string;
  // False when the theme could not be stored; the editor then stays open.
  onSave: (theme: CustomTheme) => boolean;
  onClose: () => void;
}

type ColorSeed = 'accent' | 'background' | 'past' | 'live' | 'future';
type ToggleSeed = 'mode' | 'elevation' | 'highContrast' | 'focus' | 'glow' | 'radius' | 'weight'
  | 'overlayOpacity' | 'overlayBlur';

// The part of the preview each choice restyles; '' is the whole pane.
const FLASH_TARGET: Record<keyof ThemeSeeds, string> = {
  mode: '',
  background: '',
  elevation: '',
  highContrast: '.tsp-rows',
  accent: '.tsp-tabs',
  focus: '.tsp-tile.focus',
  glow: '.tsp-tile.focus',
  radius: '.tsp-tiles',
  font: '.tsp-rows',
  weight: '.tsp-rows',
  overlayOpacity: '.theme-editor-glass',
  overlayBlur: '.theme-editor-glass',
  past: '.theme-editor-epg .past',
  live: '.theme-editor-epg .live',
  future: '.theme-editor-epg .future',
};

const HUES = [0, 20, 35, 50, 90, 140, 170, 190, 210, 240, 275, 320];
const VIVID_NEUTRALS = ['#ffffff', '#c8ccd2', '#8d939c', '#525862', '#2a2e35', '#000000'];
const DARK_NEUTRALS = ['#000000', '#0a0a0f', '#121212', '#16181d', '#1c1c22', '#22252b'];
const LIGHT_NEUTRALS = ['#ffffff', '#f6f7f9', '#f1f1ef', '#eceef2', '#f5efe6', '#e9ecef'];

function hueRows(levels: number[], s: number): string[] {
  const out: string[] = [];
  for (const l of levels) for (const h of HUES) out.push(fromHsl({ h, s, l: l / 100 }));
  return out;
}

function palette(seed: ColorSeed, mode: ThemeSeeds['mode']): string[] {
  if (seed !== 'background') return hueRows([74, 62, 48], 0.78).concat(VIVID_NEUTRALS);
  return mode === 'light'
    ? hueRows([97, 93, 89], 0.4).concat(LIGHT_NEUTRALS)
    : hueRows([5, 9, 13], 0.35).concat(DARK_NEUTRALS);
}

const SEED_LABEL: Record<ColorSeed, () => string> = {
  accent: () => t('theme.accent'),
  background: () => t('theme.background'),
  past: () => t('epg.aired'),
  live: () => t('theme.guideNow'),
  future: () => t('epg.upcoming'),
};

const FONT_LABEL: Record<FontId, string> = {
  default: '',
  'lg-condensed': 'LG Smart UI Condensed',
  'museo-sans': 'Museo Sans',
  miso: 'Miso',
  serif: 'Tinos',
};

let availableFonts: FontId[] | null = null;

// The TV reports no font list, so a font counts as installed when text set in
// it measures differently from both generic fallbacks.
function installedFonts(): FontId[] {
  if (availableFonts) return availableFonts;
  const found: FontId[] = ['default'];
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx) {
    // Latin only: Museo Sans has no Cyrillic or CJK glyphs to measure.
    const sample = 'mmmmmmmmmmlli 0123456789 WQ';
    const width = (family: string) => {
      ctx.font = `72px ${family}`;
      return ctx.measureText(sample).width;
    };
    const mono = width('monospace');
    const serif = width('serif');
    for (const id of FONT_IDS) {
      if (id === 'default') continue;
      const present = FONT_NAMES[id].some(name =>
        width(`${name}, monospace`) !== mono || width(`${name}, serif`) !== serif);
      if (present) found.push(id);
    }
  }
  availableFonts = found;
  return found;
}

// morph() updates the value attribute, which stops showing once the user has
// typed; a field without the caret shows the rendered value again.
function syncFields(root: HTMLElement): void {
  const fields = root.querySelectorAll<HTMLInputElement>('input');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field !== document.activeElement && field.value !== field.defaultValue) field.value = field.defaultValue;
  }
}

function sameSeeds(a: ThemeSeeds, b: ThemeSeeds): boolean {
  return (Object.keys(a) as Array<keyof ThemeSeeds>).every(key => a[key] === b[key]);
}

const lightFaces: Partial<Record<FontId, boolean>> = {};

// Light text needs a light face: the engine never thins a font itself, so
// a font whose 300 measures like its 400 would show no change.
function hasLightFace(font: FontId): boolean {
  const known = lightFaces[font];
  if (known !== undefined) return known;
  const ctx = document.createElement('canvas').getContext('2d');
  let light = true;
  if (ctx) {
    const sample = 'mmmmmmmmmmlli 0123456789 WQ';
    const width = (weight: number) => {
      ctx.font = `${weight} 72px ${FONT_FAMILIES[font]}`;
      return ctx.measureText(sample).width;
    };
    light = width(300) !== width(400);
  }
  lightFaces[font] = light;
  return light;
}

let editorScope: FocusScope | null = null;
let pickerScope: FocusScope | null = null;

/** Full-screen custom theme editor over Settings. Edits recompile the theme
 *  and restyle only the preview pane; the app takes the theme once Settings
 *  saves it. */
export class ThemeEditor {
  private el: HTMLElement | null = null;
  private view: HTMLElement | null = null;
  private picker: HTMLElement | null = null;
  private nav: SpatialNav | null = null;
  private pickerNav: SpatialNav | null = null;
  private scope: FocusScope | null = null;
  private pickerScope: FocusScope | null = null;
  private options: ThemeEditorOptions | null = null;
  private name = '';
  private base = 'midnight';
  private baseVars = {} as BaseVars;
  private seeds = {} as ThemeSeeds;
  private compiled: CompiledTheme = { vars: {}, adjusted: [] };
  private dirty = false;
  private picking: ColorSeed | null = null;
  // A key is taking the caret out of a field, which commits or reverts itself.
  private leavingByKey = false;
  // The picker steps in HSL; holding it avoids hex round-trip drift.
  private hsl = { h: 0, s: 0, l: 0 };
  private readonly confirmation = new ConfirmationPrompt('prompt.theme_editor');

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  open(options: ThemeEditorOptions): void {
    this.options = options;
    const theme = options.theme;
    this.base = theme ? theme.base : options.base;
    this.baseVars = readPresetVars(this.base);
    this.seeds = theme ? { ...theme.seeds } : seedsFromBase(this.baseVars);
    this.name = theme ? theme.name : options.defaultName;
    this.dirty = false;
    this.picking = null;
    this.mount().classList.remove('hidden');
    this.picker!.classList.add('hidden');
    this.recompile();
    if (this.scope) Focus.push(this.scope);
    // The list is reused, so it starts again from the name and Save.
    const list = this.view!.querySelector<HTMLElement>('.theme-editor-list');
    if (list) list.scrollTop = 0;
    const first = this.view!.querySelector<HTMLElement>('[data-color-seed="accent"]');
    this.nav!.focus(first);
  }

  /** Closes without saving, for a view change behind the editor. */
  hide(): void {
    // Settings dismisses its prompts on every view change.
    if (!this.visible) return;
    this.confirmation.hide();
    this.closePicker(false);
    if (this.scope) Focus.pop(this.scope);
    this.el?.classList.add('hidden');
    this.options = null;
    setDraftTheme(null);
  }

  handleAction(action: Action): void {
    if (!this.visible || !this.nav) return;
    if (this.picking) {
      this.handlePickerAction(action);
      return;
    }
    if (isFocusMove(action) && this.nav.showConcealed()) return;
    const open = this.view!.querySelector<HTMLElement>('.dropdown.open');
    switch (action) {
      case 'back':
        if (open) closeDropdown(this.nav, open);
        else this.leave();
        return;
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.nav.move(action);
        return;
      case 'select':
        if (this.nav.focused) this.activate(this.nav.focused);
        return;
    }
  }

  private mount(): HTMLElement {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.className = 'theme-editor hidden';
    el.setAttribute('data-self-activate', '');
    const view = document.createElement('div');
    view.className = 'theme-editor-host';
    const picker = document.createElement('div');
    picker.className = 'theme-color-picker hidden';
    el.appendChild(view);
    el.appendChild(picker);
    document.body.appendChild(el);
    this.el = el;
    this.view = view;
    this.picker = picker;

    editorScope?.dispose();
    const scope = this.scope = editorScope = Focus.register({
      id: 'prompt.theme_editor_view',
      root: view,
      restrict: 'self-only',
      tier: Tier.prompt,
      onAction: (action) => this.handleAction(action),
      defaultKey: () => this.nav?.focused?.dataset.key ?? null,
    });
    pickerScope?.dispose();
    const colorScope = this.pickerScope = pickerScope = Focus.register({
      id: 'prompt.theme_color_picker',
      root: picker,
      restrict: 'self-only',
      tier: Tier.prompt,
      onAction: (action) => this.handleAction(action),
      defaultKey: () => this.pickerNav?.focused?.dataset.key ?? null,
    });
    this.nav = new SpatialNav(view, undefined, { scope });
    this.pickerNav = new SpatialNav(picker, undefined, { scope: colorScope });

    el.addEventListener('click', (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!target) return;
      if (picker.contains(target)) {
        this.pickerNav!.focus(target, 'pointer');
        this.activatePicker(target);
      } else if (!this.picking) {
        this.nav!.focus(target, 'pointer');
        this.activate(target);
      }
    });
    el.addEventListener('input', (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input.hasAttribute('data-theme-name')) {
        this.name = input.value;
        this.dirty = true;
      }
    });
    // A text field owns its keys while it has the caret: Enter and Back leave
    // it, and Up/Down leave it toward the next control.
    el.addEventListener('keydown', (event: KeyboardEvent) => {
      const input = event.target as HTMLInputElement;
      if (input.tagName !== 'INPUT') return;
      const back = event.key === 'Escape' || event.keyCode === CONFIG.KEYS.BACK;
      const up = event.key === 'ArrowUp' || event.keyCode === CONFIG.KEYS.UP;
      const down = event.key === 'ArrowDown' || event.keyCode === CONFIG.KEYS.DOWN;
      if (event.key !== 'Enter' && !back && !up && !down) return;
      event.preventDefault();
      event.stopPropagation();
      this.leavingByKey = true;
      input.blur();
      this.leavingByKey = false;
      if (input.hasAttribute('data-theme-hex')) this.commitHex(back ? null : input.value);
      if (up || down) (this.picking ? this.pickerNav : this.nav)!.move(up ? 'up' : 'down');
    });
    el.addEventListener('focusout', (event: FocusEvent) => {
      const input = event.target as HTMLInputElement;
      if (!this.leavingByKey && input.hasAttribute?.('data-theme-hex')) this.commitHex(input.value);
    });
    return el;
  }

  private recompile(): void {
    this.compiled = compileTheme(this.baseVars, this.seeds);
    setDraftTheme(this.compiled.vars);
    this.render();
    if (this.picking) this.renderPicker();
  }

  private setColor(seed: ColorSeed, hex: string): void {
    const patch: Partial<ThemeSeeds> = {};
    patch[seed] = hex;
    this.update(patch);
  }

  private update(patch: Partial<ThemeSeeds>): void {
    this.seeds = { ...this.seeds, ...patch };
    this.dirty = true;
    this.recompile();
    this.flash(Object.keys(patch) as Array<keyof ThemeSeeds>);
  }

  // Outline the part of the preview a change restyles, so the eye finds it.
  private flash(seeds: Array<keyof ThemeSeeds>): void {
    const preview = this.view?.querySelector<HTMLElement>('.theme-editor-preview');
    if (!preview) return;
    const selectors = seeds.map(seed => FLASH_TARGET[seed]);
    for (const selector of selectors) {
      const target = selector ? preview.querySelector<HTMLElement>(selector) : preview;
      if (!target) continue;
      target.classList.remove('theme-editor-flash');
      void target.offsetWidth; // restart the animation on a repeat change
      target.classList.add('theme-editor-flash');
    }
  }

  private render(): void {
    if (!this.view) return;
    const s = this.seeds;
    const fonts = installedFonts();
    const options = <T extends string | number | boolean>(pairs: Array<[T, string]>) =>
      pairs.map(([value, label]) => ({ value: String(value), label }));
    const row = (label: string, control: Safe) => html`
      <div class="theme-editor-row"><span class="theme-editor-label">${label}</span>${control}</div>`;
    const toggles = (seed: ToggleSeed, pairs: Array<[string | number | boolean, string]>) =>
      row(this.toggleLabel(seed), toggleGroup(`te-${seed}`, options(pairs), String(s[seed])));
    const color = (seed: ColorSeed) => html`
      <button class="theme-editor-row theme-editor-color" data-focusable
              data-key="te-color:${seed}" data-color-seed="${seed}">
        <span class="theme-editor-label">${SEED_LABEL[seed]()}</span>
        <span class="theme-editor-dot" style="background:${s[seed]}"></span>
        <span class="theme-editor-hex">${s[seed].toUpperCase()}</span>
        <span class="theme-editor-chevron">${raw(CHEVRON_RIGHT_ICON)}</span>
      </button>`;
    const group = (label: string) => html`<div class="theme-editor-group">${label}</div>`;
    const adjusted = this.compiled.adjusted;
    morph(this.view, html`
      <div class="theme-editor-view">
        <header class="theme-editor-header">
          <div class="theme-editor-heading">
            <h2>${this.options?.theme ? t('theme.editTitle') : t('theme.new')}</h2>
            <button class="btn btn-primary" data-focusable data-key="te-save" data-theme-save>${t('common.save')}</button>
          </div>
        </header>
        <div class="theme-editor-body">
          <div class="theme-editor-list" data-nav-container>
            ${row(t('settings.name'), html`
              <input type="text" class="settings-input theme-editor-name" data-focusable data-key="te-name"
                     data-theme-name maxlength="${MAX_THEME_NAME}" value="${this.name}">`)}
            ${row(t('theme.basedOn'), dropdown('te-base', THEMES.map(theme => ({ value: theme.id, label: theme.name })), this.base))}
            ${toggles('mode', [['dark', t('theme.modeDark')], ['light', t('theme.modeLight')]])}
            ${group(t('theme.groupColors'))}
            ${color('accent')}
            ${color('background')}
            ${toggles('elevation', [[0, t('theme.depthSubtle')], [1, t('theme.depthStandard')], [2, t('theme.depthStrong')]])}
            ${toggles('highContrast', [[false, t('theme.contrastStandard')], [true, t('theme.contrastHigh')]])}
            ${group(t('theme.groupFocus'))}
            ${toggles('focus', [['accent', t('theme.focusAccent')], ['contrast', t('theme.focusContrast')]])}
            ${toggles('glow', [[0, t('theme.glowNone')], [1, t('theme.glowSoft')], [2, t('theme.glowStrong')]])}
            ${group(t('theme.groupShape'))}
            ${toggles('radius', RADII.map(r => [r, String(r)] as [number, string]))}
            ${fonts.length > 1
              ? row(t('theme.font'), dropdown('te-font', fonts.map(id => ({
                value: id, label: id === 'default' ? t('theme.fontDefault') : FONT_LABEL[id],
              })), s.font))
              : ''}
            ${hasLightFace(s.font)
              ? toggles('weight', [['light', t('theme.weightLight')], ['regular', t('theme.weightRegular')]])
              : ''}
            ${group(t('theme.groupOverlay'))}
            ${toggles('overlayOpacity', OVERLAY_OPACITIES.map(o => [o, `${o}%`] as [number, string]))}
            ${toggles('overlayBlur', [[true, t('common.on')], [false, t('common.off')]])}
            ${group(t('theme.groupGuide'))}
            ${color('past')}
            ${color('live')}
            ${color('future')}
          </div>
          <div class="theme-editor-side">
            <div class="theme-editor-preview" data-theme="${DRAFT_THEME_ID}">
              ${themePreviewMock()}
              <div class="theme-editor-glass ${s.overlayBlur ? '' : 'no-blur'}" aria-hidden="true">
                <span>ch1</span><span>${t('settings.previewEpgNow')}</span>
              </div>
              <div class="theme-editor-epg" aria-hidden="true">
                <span class="past">${t('epg.aired')}</span>
                <span class="live"><i></i>${t('theme.guideNow')}</span>
                <span class="future">${t('epg.upcoming')}</span>
              </div>
            </div>
            ${adjusted.length ? html`
              <div class="theme-editor-status" data-theme-adjusted>${raw(WARNING_ICON)}<span>${t('theme.adjusted', {
                items: adjusted.map(seed => SEED_LABEL[seed]()).join(t('common.listSeparator')),
              })}</span></div>` : ''}
          </div>
        </div>
        <div class="edit-hints theme-editor-hints">
          <span class="edit-hint">${backKey()}<span>${t('common.cancel')}</span></span>
        </div>
      </div>
    `);
    syncFields(this.view);
  }

  private toggleLabel(seed: ToggleSeed): string {
    switch (seed) {
      case 'mode': return t('theme.mode');
      case 'elevation': return t('theme.depth');
      case 'highContrast': return t('theme.textContrast');
      case 'focus': return t('theme.focusColor');
      case 'glow': return t('theme.focusGlow');
      case 'radius': return t('theme.cornerRadius');
      case 'weight': return t('theme.fontWeight');
      case 'overlayOpacity': return t('theme.opacity');
      case 'overlayBlur': return t('theme.blur');
    }
  }

  private activate(el: HTMLElement): void {
    if (!this.nav) return;
    if (el.hasAttribute('data-theme-name')) {
      (el as HTMLInputElement).focus();
    } else if (el.hasAttribute('data-theme-save')) {
      this.save();
    } else if (el.hasAttribute('data-dropdown-trigger')) {
      toggleDropdown(this.view!, this.nav, el.closest<HTMLElement>('.dropdown'));
    } else if (el.classList.contains('dropdown-option')) {
      const dd = commitDropdownOption(el);
      const value = dd?.dataset.value ?? '';
      if (dd?.id === 'te-base') this.changeBase(value);
      else if (dd?.id === 'te-font') {
        // A font without a light face hides the weight row, so Light can't linger unseen.
        const font = value as FontId;
        this.update(hasLightFace(font) ? { font } : { font, weight: 'regular' });
      }
      const trigger = this.view!.querySelector<HTMLElement>(`#${dd?.id ?? ''} .dropdown-trigger`);
      if (trigger) this.nav.focus(trigger);
    } else if (el.classList.contains('toggle-option')) {
      const seed = el.parentElement?.id.replace(/^te-/, '') as ToggleSeed | undefined;
      if (seed) this.setToggle(seed, el.dataset.value ?? '');
    } else if (el.dataset.colorSeed) {
      this.openPicker(el.dataset.colorSeed as ColorSeed);
    }
  }

  private setToggle(seed: ToggleSeed, value: string): void {
    switch (seed) {
      case 'mode': {
        const mode = value === 'light' ? 'light' : 'dark';
        if (mode !== this.seeds.mode) this.update({ mode, background: backgroundForMode(this.seeds.background, mode) });
        return;
      }
      case 'elevation': this.update({ elevation: Number(value) as ThemeSeeds['elevation'] }); return;
      case 'highContrast': this.update({ highContrast: value === 'true' }); return;
      case 'focus': this.update({ focus: value === 'contrast' ? 'contrast' : 'accent' }); return;
      case 'glow': this.update({ glow: Number(value) as ThemeSeeds['glow'] }); return;
      case 'radius': this.update({ radius: Number(value) as ThemeSeeds['radius'] }); return;
      case 'weight': this.update({ weight: value === 'light' ? 'light' : 'regular' }); return;
      case 'overlayOpacity': this.update({ overlayOpacity: Number(value) as ThemeSeeds['overlayOpacity'] }); return;
      case 'overlayBlur': this.update({ overlayBlur: value === 'true' }); return;
    }
  }

  // A new base starts over from that preset's own colors; the name stays.
  // Choices made on top of the current base are confirmed away first.
  private changeBase(id: string): void {
    if (id === this.base) return;
    if (!sameSeeds(this.seeds, seedsFromBase(this.baseVars))) {
      this.confirmation.show({
        title: t('theme.discardTitle'),
        message: t('theme.discardMessage'),
        confirmLabel: t('theme.discard'),
        cancelLabel: t('common.cancel'),
        onConfirm: () => this.resetToBase(id),
        onCancel: () => this.render(),
      });
      return;
    }
    this.resetToBase(id);
  }

  private resetToBase(id: string): void {
    this.base = id;
    this.baseVars = readPresetVars(id);
    this.seeds = seedsFromBase(this.baseVars);
    this.dirty = true;
    this.recompile();
    this.flash(['background']);
  }

  private leave(): void {
    if (!this.dirty) {
      this.close();
      return;
    }
    this.confirmation.show({
      title: t('theme.discardTitle'),
      message: t('theme.discardMessage'),
      confirmLabel: t('theme.discard'),
      cancelLabel: t('common.cancel'),
      onConfirm: () => this.close(),
      onCancel: () => {},
    });
  }

  private close(): void {
    const options = this.options;
    this.hide();
    options?.onClose();
  }

  private save(): void {
    const options = this.options;
    if (!options) return;
    const name = this.name.trim().slice(0, MAX_THEME_NAME) || options.defaultName;
    const theme: CustomTheme = {
      id: options.theme?.id ?? newCustomThemeId(),
      name,
      base: this.base,
      seeds: { ...this.seeds },
      vars: this.compiled.vars,
    };
    if (!options.onSave(theme)) return;
    this.hide();
    options.onClose();
  }

  // ---- color picker ----

  private openPicker(seed: ColorSeed): void {
    this.picking = seed;
    this.hsl = toHsl(this.seeds[seed]);
    this.picker!.classList.remove('hidden');
    this.renderPicker();
    if (this.pickerScope) Focus.push(this.pickerScope);
    const current = this.picker!.querySelector<HTMLElement>('.theme-picker-cell.active')
      ?? this.picker!.querySelector<HTMLElement>('.theme-picker-cell');
    this.pickerNav!.focus(current);
  }

  private closePicker(refocus = true): void {
    const seed = this.picking;
    if (!seed) return;
    this.picking = null;
    this.picker!.classList.add('hidden');
    if (this.pickerScope) Focus.pop(this.pickerScope);
    if (refocus) this.nav!.focus(this.view!.querySelector<HTMLElement>(`[data-color-seed="${seed}"]`));
  }

  private handlePickerAction(action: Action): void {
    const nav = this.pickerNav!;
    if (isFocusMove(action) && nav.showConcealed()) return;
    switch (action) {
      case 'back':
        this.closePicker();
        return;
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        nav.move(action);
        return;
      case 'select':
        if (nav.focused) this.activatePicker(nav.focused);
        return;
    }
  }

  private activatePicker(el: HTMLElement): void {
    const seed = this.picking;
    if (!seed) return;
    if (el.dataset.color) {
      this.hsl = toHsl(el.dataset.color);
      this.setColor(seed, el.dataset.color);
    } else if (el.dataset.hsl) {
      const channel = el.dataset.hsl as 'h' | 's' | 'l';
      const delta = Number(el.dataset.delta);
      const next = { ...this.hsl };
      if (channel === 'h') next.h = (Math.round(next.h) + delta + 360) % 360;
      else next[channel] = Math.max(0, Math.min(1, Math.round(next[channel] * 100 + delta) / 100));
      this.hsl = next;
      this.setColor(seed, fromHsl(next));
    } else if (el.hasAttribute('data-theme-hex')) {
      (el as HTMLInputElement).focus();
    }
  }

  private commitHex(value: string | null): void {
    const seed = this.picking;
    if (!seed) return;
    const hex = value === null ? null : normalizeHex(value.charAt(0) === '#' ? value : `#${value}`);
    if (hex && hex !== this.seeds[seed]) {
      this.hsl = toHsl(hex);
      this.setColor(seed, hex);
    } else {
      this.renderPicker();
    }
  }

  private renderPicker(): void {
    const seed = this.picking;
    if (!seed || !this.picker) return;
    const value = this.seeds[seed];
    const cells = palette(seed, this.seeds.mode);
    const step = (channel: 'h' | 's' | 'l', label: string, shown: string, delta: number) => html`
      <div class="theme-picker-step">
        <span class="theme-picker-step-label">${label}</span>
        <div class="toggle-group">
          <button class="toggle-option" data-focusable data-key="hsl:${channel}:-" data-hsl="${channel}"
                  data-delta="${-delta}" aria-label="${label} -">&minus;</button>
          <span class="theme-picker-step-value">${shown}</span>
          <button class="toggle-option" data-focusable data-key="hsl:${channel}:+" data-hsl="${channel}"
                  data-delta="${delta}" aria-label="${label} +">+</button>
        </div>
      </div>`;
    morph(this.picker, html`
      <div class="confirmation-dialog theme-picker-dialog">
        <div class="confirmation-title">${SEED_LABEL[seed]()}</div>
        <div class="theme-picker-grid" data-nav-container>
          ${cells.map((cell, index) => html`
            <button class="theme-picker-cell ${cell === value ? 'active' : ''}" data-focusable
                    data-key="cell:${index}" data-color="${cell}" style="background:${cell}"
                    aria-label="${cell.toUpperCase()}"></button>`)}
        </div>
        <div class="theme-picker-fine" data-nav-container>
        ${step('h', t('theme.hue'), `${Math.round(this.hsl.h)}°`, 5)}
        ${step('s', t('theme.saturation'), `${Math.round(this.hsl.s * 100)}%`, 2)}
        ${step('l', t('theme.lightness'), `${Math.round(this.hsl.l * 100)}%`, 2)}
        <div class="theme-picker-hex">
          <span class="theme-picker-current" style="background:${value}"></span>
          <input type="text" class="settings-input" data-focusable data-key="hex" data-theme-hex
                 maxlength="7" value="${value.toUpperCase()}" aria-label="${t('theme.colorCode')}">
          <span class="theme-picker-hint">${t('theme.colorCodeHint')}</span>
        </div>
        </div>
      </div>
    `);
    syncFields(this.picker);
  }
}

