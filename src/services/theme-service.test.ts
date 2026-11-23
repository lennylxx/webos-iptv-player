// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTheme, installCustomThemes, setDraftTheme } from './theme-service';

const theme = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Alpha',
  base: 'ember',
  seeds: { overlayBlur: true },
  vars: { '--accent': '#112233', '--accent-rgb': '17 34 51' },
  ...extra,
});

function store(themes: unknown[], selected: string): void {
  localStorage.setItem('iptv_custom_themes', JSON.stringify(themes));
  localStorage.setItem('iptv_theme', JSON.stringify(selected));
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute('data-overlay-blur');
});

describe('custom themes in the theme service', () => {
  it('writes one rule per stored theme and applies a stored custom id', () => {
    store([theme('custom-a1'), theme('custom-a2', { seeds: { overlayBlur: false } })], 'custom-a2');
    installCustomThemes();
    const css = document.getElementById('custom-theme-rules')!.textContent!;
    expect(css).toContain('[data-theme="custom-a1"][data-theme="custom-a1"]{--accent:#112233;');
    expect(css).toContain('[data-theme="custom-a2"]');
    applyTheme('custom-a2');
    expect(document.documentElement.dataset.theme).toBe('custom-a2');
    expect(document.documentElement.getAttribute('data-overlay-blur')).toBe('off');
    applyTheme('ember');
    expect(document.documentElement.hasAttribute('data-overlay-blur')).toBe(false);
  });

  it('falls back to the default theme for a custom id that no longer exists', () => {
    store([], 'custom-gone');
    applyTheme('custom-gone');
    expect(document.documentElement.dataset.theme).toBe('midnight');
  });

  it('scopes the draft to the editor preview and clears it', () => {
    setDraftTheme({ '--radius': '16px' });
    expect(document.getElementById('custom-theme-draft')!.textContent)
      .toBe('[data-theme="custom-draft"][data-theme="custom-draft"]{--radius:16px;}');
    setDraftTheme(null);
    expect(document.getElementById('custom-theme-draft')!.textContent).toBe('');
  });
});

describe('first-paint script', () => {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const run = () => new Function(script)();

  it('paints the custom theme that was last applied before the app loads', () => {
    store([theme('custom-a1')], 'custom-a1');
    applyTheme('custom-a1');
    document.head.innerHTML = '';
    delete document.documentElement.dataset.theme;
    run();
    expect(document.documentElement.dataset.theme).toBe('custom-a1');
    expect(document.getElementById('custom-theme-rules')!.textContent)
      .toBe('[data-theme="custom-a1"][data-theme="custom-a1"]{--accent:#112233;--accent-rgb:17 34 51;}');
  });

  it('refreshes the cached rule when the applied theme is edited or deleted', () => {
    store([theme('custom-a1')], 'custom-a1');
    applyTheme('custom-a1');
    store([theme('custom-a1', { vars: { '--accent': '#445566' } })], 'custom-a1');
    installCustomThemes();
    expect(JSON.parse(localStorage.getItem('iptv_theme_css')!)).toContain('--accent:#445566;');
    store([], 'ember');
    installCustomThemes();
    expect(JSON.parse(localStorage.getItem('iptv_theme_css')!)).toBe('');
  });

  it('leaves presets to the stylesheets', () => {
    store([theme('custom-a1')], 'custom-a1');
    applyTheme('custom-a1');
    store([theme('custom-a1')], 'ember');
    applyTheme('ember');
    document.head.innerHTML = '';
    run();
    expect(document.documentElement.dataset.theme).toBe('ember');
    expect(document.getElementById('custom-theme-rules')).toBeNull();
  });
});
