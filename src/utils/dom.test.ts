import { describe, it, expect } from 'vitest';
import { cssUrl, html, raw, Safe } from './dom';

describe('html escaping helper', () => {
  it('escapes HTML special characters in interpolated values', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const out = String(html`<div>${evil}</div>`);
    expect(out).toBe('<div>&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(out).not.toContain('<img');
  });

  it('escapes characters that break out of double-quoted attributes', () => {
    const evil = '" onload="alert(1)';
    const out = String(html`<img src="${evil}">`);
    expect(out).toBe('<img src="&quot; onload=&quot;alert(1)">');
  });

  it('does not escape values wrapped in raw()', () => {
    const out = String(html`<span>${raw('<b>ok</b>')}</span>`);
    expect(out).toBe('<span><b>ok</b></span>');
  });

  it('passes nested html results through without double-escaping', () => {
    const inner = html`<i>${'<x>'}</i>`;
    const out = String(html`<div>${inner}</div>`);
    expect(out).toBe('<div><i>&lt;x&gt;</i></div>');
  });

  it('escapes arrays element-wise and concatenates', () => {
    const items = ['<a>', '<b>'];
    const out = String(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`);
    expect(out).toBe('<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul>');
  });

  it('renders null and undefined as empty strings', () => {
    expect(String(html`<p>${null}${undefined}</p>`)).toBe('<p></p>');
  });

  it('returns a Safe instance', () => {
    expect(html`<p>x</p>`).toBeInstanceOf(Safe);
  });
});

describe('cssUrl', () => {
  it('percent-encodes everything that could end a CSS url() string', () => {
    expect(cssUrl(`http://host/a b"c'd(e)f\\g.jpg`)).toBe('http://host/a%20b%22c%27d%28e%29f%5Cg.jpg');
  });
});
