// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { html } from './dom';
import { morph } from './morph';

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('morph — basics', () => {
  it('mounts new content when the parent is empty', () => {
    morph(root, html`<p>hello</p>`);
    expect(root.innerHTML).toBe('<p>hello</p>');
  });

  it('updates text without replacing the element node', () => {
    morph(root, html`<p>one</p>`);
    const p = root.querySelector('p')!;
    morph(root, html`<p>two</p>`);
    expect(root.querySelector('p')).toBe(p);
    expect(p.textContent).toBe('two');
  });

  it('preserves listeners on reused element nodes', () => {
    morph(root, html`<button>x</button>`);
    const btn = root.querySelector('button')!;
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);

    morph(root, html`<button>y</button>`);
    morph(root, html`<button>z</button>`);
    root.querySelector('button')!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(root.querySelector('button')).toBe(btn);
  });

  it('treats the template class attribute as authoritative (no implicit preservation)', () => {
    // Documents the chosen design: morph syncs the `class` attribute like any
    // other. Components that add classes imperatively (e.g. SpatialNav focus)
    // must re-apply them after morph.
    morph(root, html`<div></div>`);
    const div = root.querySelector('div')!;
    div.classList.add('imperative');
    morph(root, html`<div></div>`);
    expect(div.classList.contains('imperative')).toBe(false);
  });

  it('removes an imperatively-added class when the template later sets class authoritatively', () => {
    morph(root, html`<div></div>`);
    const div = root.querySelector('div')!;
    div.classList.add('focused');
    morph(root, html`<div class="other"></div>`);
    expect(div.className).toBe('other');
  });
});

describe('morph — attributes', () => {
  it('adds, changes, and removes attributes', () => {
    morph(root, html`<a href="/a" title="t">x</a>`);
    const a = root.querySelector('a')!;
    morph(root, html`<a href="/b" rel="next">x</a>`);
    expect(a.getAttribute('href')).toBe('/b');
    expect(a.getAttribute('rel')).toBe('next');
    expect(a.hasAttribute('title')).toBe(false);
  });

  it('handles many old attributes without skipping any during removal', () => {
    morph(root, html`<span a="1" b="2" c="3" d="4" e="5"></span>`);
    morph(root, html`<span></span>`);
    const span = root.querySelector('span')!;
    expect(span.attributes.length).toBe(0);
  });
});

describe('morph — text node whitespace', () => {
  it('does not misalign element matching when whitespace text nodes change', () => {
    morph(root, html`<ul><li>a</li><li>b</li></ul>`);
    const ul = root.querySelector('ul')!;
    const [li1, li2] = Array.from(ul.querySelectorAll('li'));
    // Different indentation/whitespace — same logical structure.
    morph(root, html`
      <ul>
        <li>a</li>
        <li>b</li>
      </ul>
    `);
    const after = Array.from(root.querySelectorAll('li'));
    expect(after[0]).toBe(li1);
    expect(after[1]).toBe(li2);
    expect(root.querySelector('ul')).toBe(ul);
  });
});

describe('morph — keyed reconciliation', () => {
  it('reuses nodes by data-key after reorder, preserving identity and listeners', () => {
    morph(root, html`
      <ul>
        <li data-key="a">A</li>
        <li data-key="b">B</li>
        <li data-key="c">C</li>
      </ul>
    `);
    const liA = root.querySelector('[data-key="a"]')! as HTMLLIElement;
    const liB = root.querySelector('[data-key="b"]')! as HTMLLIElement;
    const liC = root.querySelector('[data-key="c"]')! as HTMLLIElement;
    const onClickA = vi.fn();
    liA.addEventListener('click', onClickA);

    morph(root, html`
      <ul>
        <li data-key="c">C</li>
        <li data-key="a">A</li>
        <li data-key="b">B</li>
      </ul>
    `);

    const after = Array.from(root.querySelectorAll('li'));
    expect(after[0]).toBe(liC);
    expect(after[1]).toBe(liA);
    expect(after[2]).toBe(liB);
    liA.click();
    expect(onClickA).toHaveBeenCalledTimes(1);
  });

  it('adds new keyed nodes and removes missing ones', () => {
    morph(root, html`
      <ul>
        <li data-key="a">A</li>
        <li data-key="b">B</li>
      </ul>
    `);
    const liA = root.querySelector('[data-key="a"]')!;
    morph(root, html`
      <ul>
        <li data-key="a">A</li>
        <li data-key="c">C</li>
      </ul>
    `);
    expect(root.querySelector('[data-key="a"]')).toBe(liA);
    expect(root.querySelector('[data-key="b"]')).toBeNull();
    expect(root.querySelector('[data-key="c"]')!.textContent).toBe('C');
  });

  it('replaces a node when the tag changes for the same key', () => {
    morph(root, html`<div><span data-key="x">x</span></div>`);
    const oldSpan = root.querySelector('[data-key="x"]')!;
    morph(root, html`<div><a data-key="x">x</a></div>`);
    const newEl = root.querySelector('[data-key="x"]')!;
    expect(newEl).not.toBe(oldSpan);
    expect(newEl.tagName).toBe('A');
  });

  it('unkeyed fallback never consumes a keyed old node', () => {
    morph(root, html`
      <ul>
        <li data-key="keep">K</li>
        <li>plain</li>
      </ul>
    `);
    const keyedLi = root.querySelector('[data-key="keep"]')!;
    // New template: only an unkeyed <li> first, then the keyed one.
    morph(root, html`
      <ul>
        <li>plain</li>
        <li data-key="keep">K</li>
      </ul>
    `);
    expect(root.querySelector('[data-key="keep"]')).toBe(keyedLi);
    const lis = Array.from(root.querySelectorAll('li'));
    expect(lis[0].hasAttribute('data-key')).toBe(false);
    expect(lis[1]).toBe(keyedLi);
  });

  it('a new keyed node never consumes an unkeyed old node', () => {
    morph(root, html`<div><div class="spacer"></div></div>`);
    const spacer = root.querySelector('.spacer');

    morph(root, html`<div><div data-key="row">row</div></div>`);

    expect(root.querySelector('[data-key="row"]')).not.toBe(spacer);
  });
});

describe('morph — duplicate keys (defensive)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('warns when old siblings duplicate a key and still preserves both list items', () => {
    // Mount: inserted whole, no sibling comparison happens.
    morph(root, html`<ul><li data-key="x">1</li><li data-key="x">2</li></ul>`);
    warn.mockClear();
    // Second morph: now the old (duplicate-keyed) children get reconciled.
    morph(root, html`<ul><li data-key="x">A</li><li data-key="x">B</li></ul>`);
    expect(warn).toHaveBeenCalled();
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });

  it('warns when new siblings duplicate a key but still renders both items', () => {
    morph(root, html`<ul><li data-key="x">1</li><li data-key="x">2</li></ul>`);
    warn.mockClear();
    morph(root, html`<ul><li data-key="x">A</li><li data-key="x">B</li></ul>`);
    expect(warn).toHaveBeenCalled();
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('morph — state preservation', () => {
  it('preserves scrollTop on a reused scrollable element', () => {
    morph(root, html`<div style="height:50px;overflow:auto"><p style="height:500px"></p></div>`);
    const box = root.querySelector('div')! as HTMLDivElement;
    // jsdom does layout-less scroll; set scrollTop directly.
    Object.defineProperty(box, 'scrollTop', { value: 0, writable: true, configurable: true });
    box.scrollTop = 123;
    morph(root, html`<div style="height:50px;overflow:auto"><p style="height:500px">x</p></div>`);
    expect(root.querySelector('div')).toBe(box);
    expect(box.scrollTop).toBe(123);
  });
});

describe('morph — nested', () => {
  it('recurses into element children and patches grandchildren', () => {
    morph(root, html`<section><h1>old</h1><p>body 1</p></section>`);
    const section = root.querySelector('section')!;
    const h1 = section.querySelector('h1')!;
    const p = section.querySelector('p')!;
    morph(root, html`<section><h1>new</h1><p>body 2</p></section>`);
    expect(root.querySelector('section')).toBe(section);
    expect(section.querySelector('h1')).toBe(h1);
    expect(section.querySelector('p')).toBe(p);
    expect(h1.textContent).toBe('new');
    expect(p.textContent).toBe('body 2');
  });
});

describe('morph — unchanged-subtree fast path', () => {
  it('reuses a deeply-equal keyed subtree, keeping identity and listeners', () => {
    morph(root, html`<ul><li data-key="a"><span>A</span></li></ul>`);
    const span = root.querySelector('span')!;
    const onClick = vi.fn();
    span.addEventListener('click', onClick);

    morph(root, html`<ul><li data-key="a"><span>A</span></li></ul>`); // identical
    expect(root.querySelector('span')).toBe(span);
    root.querySelector('span')!.dispatchEvent(new MouseEvent('click'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still applies a change deep inside an otherwise-equal subtree', () => {
    morph(root, html`<ul><li data-key="a"><span>A</span></li></ul>`);
    const li = root.querySelector('li')!;
    morph(root, html`<ul><li data-key="a"><span>B</span></li></ul>`);
    expect(root.querySelector('li')).toBe(li);
    expect(root.querySelector('span')!.textContent).toBe('B');
  });

  it('still strips an imperative class when the template subtree is otherwise equal', () => {
    // The focus-restoration case: a row carries an imperative `.focused`, and
    // the next render produces an identical template — it must still be removed.
    morph(root, html`<ul><li data-key="a">A</li></ul>`);
    const li = root.querySelector('li')!;
    li.classList.add('focused');
    morph(root, html`<ul><li data-key="a">A</li></ul>`);
    expect(li.classList.contains('focused')).toBe(false);
    expect(root.querySelector('li')).toBe(li);
  });
});

describe('morph — data-morph-preserve', () => {
  it('reuses the node but leaves sub-component-owned children untouched', () => {
    morph(root, html`<div><span data-key="slot" data-morph-preserve></span></div>`);
    const slot = root.querySelector('span')!;
    // A sub-component renders its own DOM into the slot.
    slot.innerHTML = '<button>owned</button>';
    const owned = slot.querySelector('button')!;

    // The host re-renders with the same (empty) template slot.
    morph(root, html`<div><span data-key="slot" data-morph-preserve></span></div>`);

    expect(root.querySelector('span')).toBe(slot);          // same node reused
    expect(slot.querySelector('button')).toBe(owned);       // children preserved
    expect(slot.textContent).toBe('owned');
  });

  it('still syncs the preserved node\'s own attributes', () => {
    morph(root, html`<div><span data-key="slot" data-morph-preserve class="a"></span></div>`);
    const slot = root.querySelector('span')!;
    slot.innerHTML = '<i>x</i>';
    morph(root, html`<div><span data-key="slot" data-morph-preserve class="b"></span></div>`);
    expect(root.querySelector('span')).toBe(slot);
    expect(slot.getAttribute('class')).toBe('b');           // attribute synced
    expect(slot.querySelector('i')).not.toBeNull();         // children preserved
  });
});
