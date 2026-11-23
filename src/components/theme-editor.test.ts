// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThemeEditor } from './theme-editor';
import { Focus } from '../navigation/focus-scope';

// Text widths stand in for fonts: every listed font is installed, and only
// Tinos has no light face (its 300 measures like its 400).
beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const ctx = {
      font: '',
      measureText(this: { font: string }) {
        const lighter = this.font.indexOf('300 ') === 0 && this.font.indexOf('Tinos') < 0;
        return { width: this.font.length - (lighter ? 1 : 0) };
      },
    };
    return ctx as unknown as CanvasRenderingContext2D;
  });
});

describe('ThemeEditor font weight', () => {
  it('offers Light only for a font with a light face', () => {
    const editor = new ThemeEditor();
    editor.open({ theme: null, base: 'midnight', defaultName: 'Theme 1', onSave: () => true, onClose: () => {} });
    Focus.flush();
    expect(document.querySelector('#te-weight')).not.toBeNull();

    const option = document.querySelector<HTMLElement>('#te-font [data-dropdown-value="serif"]')!;
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector<HTMLElement>('#te-font')!.dataset.value).toBe('serif');
    expect(document.querySelector('#te-weight')).toBeNull();
    editor.hide();
  });

  it('drops Light when the chosen font has no light face', () => {
    const editor = new ThemeEditor();
    const onSave = vi.fn(() => true);
    editor.open({ theme: null, base: 'midnight', defaultName: 'Theme 1', onSave, onClose: () => {} });
    const click = (selector: string) => document.querySelector<HTMLElement>(selector)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click('#te-weight [data-value="light"]');
    click('#te-font [data-dropdown-value="serif"]');
    click('[data-theme-save]');
    const [saved] = onSave.mock.calls[0] as unknown as [{ seeds: { weight: string }; vars: Record<string, string> }];
    expect(saved.seeds.weight).toBe('regular');
    expect(saved.vars['--font-weight-text']).toBe('400');
  });

  it('outlines the part of the preview a change restyles', () => {
    const editor = new ThemeEditor();
    editor.open({ theme: null, base: 'midnight', defaultName: 'Theme 1', onSave: () => true, onClose: () => {} });
    const click = (selector: string) => document.querySelector<HTMLElement>(selector)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const flashing = () => Array.from(document.querySelectorAll('.theme-editor-preview .theme-editor-flash, .theme-editor-preview.theme-editor-flash'))
      .map(el => el.className.replace(' theme-editor-flash', ''));
    expect(flashing()).toEqual([]);
    click('#te-radius [data-value="16"]');
    expect(flashing()).toContain('tsp-tiles');
    click('#te-overlayBlur [data-value="false"]');
    expect(flashing()).toContain('theme-editor-glass no-blur');
    click('#te-mode [data-value="light"]');
    expect(flashing()).toContain('theme-editor-preview');
    editor.hide();
  });
});
