// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEngineQuirks, measureEngineQuirks } from './engine-quirks';

// jsdom has no layout, so stub the two measurements the probes read.
function stubLayout({ scrollWidth, gap }: { scrollWidth: number; gap: number }): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    const parent = this.parentElement;
    const index = parent ? Array.prototype.indexOf.call(parent.children, this) : 0;
    return index * (10 + gap);
  });
}

describe('engine quirks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.className = '';
  });

  it('reports no quirks where end padding scrolls and flex gap applies', () => {
    stubLayout({ scrollWidth: 30, gap: 10 });
    expect(measureEngineQuirks(document)).toEqual({ scrollEndPadding: false, noFlexGap: false });
  });

  it('reports the legacy engine quirks', () => {
    stubLayout({ scrollWidth: 20, gap: 0 });
    expect(measureEngineQuirks(document)).toEqual({ scrollEndPadding: true, noFlexGap: true });
  });

  it('tolerates sub-pixel rounding either side of each probe', () => {
    stubLayout({ scrollWidth: 29, gap: 9 });
    expect(measureEngineQuirks(document)).toEqual({ scrollEndPadding: false, noFlexGap: false });
    vi.restoreAllMocks();
    stubLayout({ scrollWidth: 21, gap: 1 });
    expect(measureEngineQuirks(document)).toEqual({ scrollEndPadding: true, noFlexGap: true });
  });

  it('leaves no probe behind', () => {
    stubLayout({ scrollWidth: 30, gap: 10 });
    const before = document.body.innerHTML;
    measureEngineQuirks(document);
    expect(document.body.innerHTML).toBe(before);
  });

  it('publishes each quirk as a q-* class on the root', () => {
    const root = document.documentElement;
    root.classList.add('keep');
    applyEngineQuirks({ scrollEndPadding: true, noFlexGap: false }, root);
    expect(root.classList.contains('q-scroll-end-padding')).toBe(true);
    expect(root.classList.contains('q-no-flex-gap')).toBe(false);
    applyEngineQuirks({ scrollEndPadding: false, noFlexGap: true }, root);
    expect(root.className.split(' ').sort()).toEqual(['keep', 'q-no-flex-gap']);
  });

  it('logs the measured quirks for tv.sh diag', () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    applyEngineQuirks({ scrollEndPadding: true, noFlexGap: false }, document.documentElement);
    expect(logs.mock.calls.map((args) => args.join(' '))).toEqual([
      '[Quirks] Engine quirks measured event=engine.quirks.measured scrollEndPadding=1 noFlexGap=0',
    ]);
  });
});
